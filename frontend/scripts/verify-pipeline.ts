/**
 * 应急演练链路自检（Node 环境，CI / 构建部署共用）。
 *
 * 用内存 KV 模拟全新浏览器落库，逐条验证：
 *   1. 确定性播种：两次重建数据集逐字节一致、指纹稳定；
 *   2. 幂等：反复初始化不改动已有演练（评估结论不被冲掉）；
 *   3. 可续跑：分批落库后重跑，能从断点继续；
 *   4. 存量迁移：按计划日期升序、判重跳过、缺失整笔暂存、历史口径回补；
 *   5. 岗位把关：非组织人员提交被整笔驳回；
 *   6. 并发：同一时刻两笔提交，先到入账，后到整笔回退；
 *   7. 待办回写：已评估条数与待办条数恒等；
 *   8. 自检：编号撞车/班组缺人/状态顶牛逐条有缘由；
 *   9. 概览与看板：同一函数、同一个数；
 *  10. 补录：组织人员补录往期结论后状态变已评估并回写待办。
 */
import { readJSON, useFreshMemoryBackend } from '../src/data/kv'
import {
  EMERGENCY_KEY,
  EMERGENCY_STATUS,
  EVALUATOR_ROLE,
  LEGACY_GAP_CONCLUSION,
  type EmergencyRow,
} from '../src/data/emergency/constants'
import {
  SEED_VERSION,
  emergencySeedHash,
  generateEmergencySeed,
} from '../src/data/emergency/generator'
import {
  emergencyMetrics,
  emergencySelfCheck,
  listEmergencyTodos,
  listStaged,
  resetEmergencyPipeline,
  runEmergencyPipeline,
  runLegacyMigration,
  submitEvaluation,
  supplementEvaluation,
} from '../src/data/emergency/pipeline'

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
  } else {
    failures += 1
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function entries(): { emergency: EmergencyRow[] } {
  return readJSON<{ emergency: EmergencyRow[] }>('urban-utility-tunnel:entries', { emergency: [] })
}

console.log('1) 确定性播种')
const a = generateEmergencySeed()
const b = generateEmergencySeed()
const hashA = emergencySeedHash(a)
check('两次生成逐字节一致', JSON.stringify(a) === JSON.stringify(b))
check('数据集共 10 条规范样例', a.length === 10, `实际 ${a.length}`)
check('编号稳定 EMER-0001..0010', a[0].演练编号 === 'EMER-0001' && a[9].演练编号 === 'EMER-0010')
check('内容指纹稳定为 8 位十六进制', /^[0-9a-f]{8}$/.test(hashA), hashA)
check('计划日期与演练时长对得上（周二场，时长15的倍数）', a.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.计划日期) && r.演练时长 % 15 === 0))
check('已评估样例必有结论，未评估样例必无结论',
  a.every((r) => (r.status === EMERGENCY_STATUS.evaluated) === Boolean(r.评估结论)))

console.log('2) 全新环境跑初始化链路')
useFreshMemoryBackend()
const summary1 = runEmergencyPipeline()
const rows1 = entries().emergency
check('播种 10 条', summary1.seeded === 10, `seeded=${summary1.seeded}`)
// 存量：8 条中 2 条字段缺失暂存；2024-031 同批次撞车保留两笔（无跨批次跳过）
check('存量迁移 6 条进正式台账', summary1.migrated === 6, `migrated=${summary1.migrated}`)
check('缺失项 2 笔整笔暂存', summary1.staged === 2, `staged=${summary1.staged}`)
check('正式台账共 16 条', rows1.length === 16, `实际 ${rows1.length}`)
const legacyLive = rows1.filter((r) => r.演练编号.startsWith('EMER-20'))
check('存量按计划日期升序搬入',
  legacyLive.every((r, i) => i === 0 || legacyLive[i - 1].计划日期 <= r.计划日期))
const gapRows = rows1.filter((r) => r.status === EMERGENCY_STATUS.legacyGap)
check('无结论但已举办的往期演练回补“待补评估”（2025-007、2025-019）',
  gapRows.length === 2 &&
  gapRows.every((r) => r.评估结论 === LEGACY_GAP_CONCLUSION) &&
  gapRows.some((r) => r.演练编号 === 'EMER-2025-007') &&
  gapRows.some((r) => r.演练编号 === 'EMER-2025-019'),
  `待补评估 ${gapRows.length} 条`)
check('从未组织的 2026-005 不算结论缺口，保持待组织原样搬入',
  rows1.some((r) => r.演练编号 === 'EMER-2026-005' && r.status === EMERGENCY_STATUS.pending && r.评估结论 === ''))
check('有结论的老数据沿用原结论（2026-002 顶牛原样保留交自检）',
  rows1.some((r) => r.演练编号 === 'EMER-2026-002' && r.评估结论.includes('防汛物资')))
const staged = listStaged(EMERGENCY_KEY)
check('暂存记录逐条带缺失字段缘由',
  staged.length === 2 && staged.every((s) => s.缺失字段.length > 0))
check('缺计划日期的 2026-006 被暂存',
  staged.some((s) => s.演练编号 === 'EMER-2026-006' && s.缺失字段.includes('计划日期')))
check('缺参与班组的 2025-012 被暂存',
  staged.some((s) => s.演练编号 === 'EMER-2025-012' && s.缺失字段.includes('参与班组')))

console.log('3) 幂等：反复执行初始化')
const rowsSnapshot = JSON.stringify(entries().emergency)
const summary2 = runEmergencyPipeline()
const summary3 = runEmergencyPipeline()
check('第二次执行不再播种/迁移', summary2.seeded === 0 && summary2.migrated === 0 && summary2.staged === 0)
check('第三次执行同样为空操作', summary3.seeded === 0 && summary3.migrated === 0 && summary3.staged === 0)
check('已有演练记录一条未改', JSON.stringify(entries().emergency) === rowsSnapshot)

console.log('4) 已有评估结论不被冲掉 + 待办随迁移回写')
const closableCount = () =>
  entries().emergency.filter(
    (r) => r.status === EMERGENCY_STATUS.evaluated || r.status === EMERGENCY_STATUS.legacyGap,
  ).length
const closableBefore = closableCount()
runEmergencyPipeline()
const closableAfter = closableCount()
check('重跑后已评估/待补评估条数不变', closableBefore === closableAfter, `${closableBefore} vs ${closableAfter}`)
const todos1 = listEmergencyTodos()
check('待闭环台账条数 = 待办条数', todos1.length === closableAfter, `${todos1.length} vs ${closableAfter}`)

console.log('5) 可续跑：模拟中断（逐条打检查点，断点重跑补齐）')
useFreshMemoryBackend()
// 先只播种（迁移账本不存在），模拟“播种完成、存量迁移未开始”的中断点
runEmergencyPipeline()
type ResumeRow = { 演练编号: string; 计划日期: string }
const resumeRows: ResumeRow[] = [
  { 演练编号: 'RX-1', 计划日期: '2025-01-01' },
  { 演练编号: 'RX-2', 计划日期: '2025-02-01' },
  { 演练编号: 'RX-3', 计划日期: '2025-03-01' },
]
const resumeConfig = {
  moduleKey: EMERGENCY_KEY,
  batchId: 'resume-test',
  dateField: '计划日期',
  naturalKeyField: '演练编号',
  requiredFields: ['演练编号'],
  rows: resumeRows,
}
const materializeResume = (input: ResumeRow, id: number): EmergencyRow => ({
  id, status: '待组织', pending: true, abnormal: false, v: 1,
  演练编号: input.演练编号,
  演练场景: '续跑演练', 参与班组: '抢险一班', 参演人数: 6,
  计划日期: input.计划日期,
  演练时长: 60, 评估结论: '', 组织人员: '赵明轩', 演练状态: '待组织',
})
const partial = runLegacyMigration(resumeConfig, { materialize: materializeResume })
check('可续跑批次搬入 3 条', partial.migrated === 3, `migrated=${partial.migrated}`)
const again = runLegacyMigration(resumeConfig, { materialize: materializeResume })
check('重跑同一批次全部跳过（从检查点续跑，不重复落库）', again.migrated === 0 && again.staged === 0)

console.log('6) 岗位把关：只有组织人员能落结论')
useFreshMemoryBackend()
runEmergencyPipeline()
const running = entries().emergency.find((r) => r.status === EMERGENCY_STATUS.running && r.评估结论 === '')!
const rejected = submitEvaluation({
  id: running.id, role: '参演人员', conclusion: '越权结论', expectedVersion: Number(running.v),
})
check('非组织人员提交被驳回', !rejected.ok && rejected.message.includes('越权'))
const rejected2 = submitEvaluation({
  id: running.id, role: '只读访客', conclusion: '越权结论', expectedVersion: Number(running.v),
})
check('只读访客提交被驳回', !rejected2.ok)
check('被驳回后台账与待办都没变',
  entries().emergency.find((r) => r.id === running.id)!.评估结论 === '' &&
  listEmergencyTodos().every((t) => t.关联编号 !== running.演练编号))

console.log('7) 并发：同一时刻两笔提交，先到入账、后到整笔回退')
const ok = submitEvaluation({
  id: running.id, role: EVALUATOR_ROLE, conclusion: '先到的正式结论', expectedVersion: Number(running.v),
})
check('先到提交入账', ok.ok)
const stale = submitEvaluation({
  id: running.id, role: EVALUATOR_ROLE, conclusion: '后到的结论', expectedVersion: Number(running.v),
})
check('后到提交按版本冲突整笔回退', !stale.ok && stale.message.includes('整笔回退'))
const winner = entries().emergency.find((r) => r.id === running.id)!
check('台账保留先到结论、版本号推进',
  winner.评估结论 === '先到的正式结论' && Number(winner.v) === Number(running.v) + 1)
check('只产生一条待办（后到未产生副作用）',
  listEmergencyTodos().filter((t) => t.关联编号 === running.演练编号).length === 1)
const overwrite = submitEvaluation({
  id: running.id, role: EVALUATOR_ROLE, conclusion: '试图覆盖', expectedVersion: Number(winner.v),
})
check('已评估结论不可二次覆盖', !overwrite.ok)

console.log('8) 处置结论回写待办，两边条数一致')
const m1 = emergencyMetrics()
check('待闭环条数（已评估+待补评估）= 待办条数（指标口径）',
  m1.evaluated + m1.legacyGap === m1.todoCount,
  `${m1.evaluated}+${m1.legacyGap} vs ${m1.todoCount}`)
check('每条待办都带处置结论或明确的待补标记',
  listEmergencyTodos().every((t) => t.处置结论 && t.待办事项))

console.log('9) 自检：撞车/缺人/顶牛逐条缘由，条数与指标一致')
const issues = emergencySelfCheck()
const m2 = emergencyMetrics()
check('自检条数与看板 issueCount 一致', issues.length === m2.issueCount, `${issues.length} vs ${m2.issueCount}`)
check('检出演练编号撞车（EMER-2024-031 两笔）',
  issues.filter((i) => i.code === 'duplicate-code').length === 2)
check('检出参与班组缺人（2025-007 0人 + 暂存两笔）',
  issues.some((i) => i.code === 'crew-short' && i.演练编号 === 'EMER-2025-007'))
check('检出结论与状态顶牛（2026-002 有结论却演练中）',
  issues.some((i) => i.code === 'status-conflict' && i.演练编号 === 'EMER-2026-002'))
check('每条问题都写了缘由', issues.every((i) => i.缘由.length > 5))
check('暂存缺失项也进自检（环节=待确认暂存）',
  issues.some((i) => i.环节 === '待确认暂存' && i.缘由.includes('必填字段缺失')))

console.log('10) 概览与看板同源')
const m3 = emergencyMetrics()
check('看板总数 = 正式台账实际条数', m3.total === entries().emergency.length)
check('状态分布求和 = 总数',
  Object.values(m3.byStatus).reduce((s, n) => s + n, 0) === m3.total)
check('待办一致性标志为真', m3.todoConsistent)
check('指纹与版本随指标暴露', m3.seedHash === hashA && m3.seedVersion === SEED_VERSION)

console.log('11) 往期补录：组织人员补结论，新口径从切换日起算')
const gap = entries().emergency.find((r) => r.status === EMERGENCY_STATUS.legacyGap)!
const badRole = supplementEvaluation({ id: gap.id, role: '参演人员', conclusion: 'x', expectedVersion: Number(gap.v) })
check('非组织人员补录被驳回', !badRole.ok)
const sup = supplementEvaluation({
  id: gap.id, role: EVALUATOR_ROLE, conclusion: '补录：复盘后确认达标', expectedVersion: Number(gap.v),
})
check('组织人员补录成功', sup.ok)
const gap2 = entries().emergency.find((r) => r.id === gap.id)!
check('补录后状态变已评估、占位结论被替换',
  gap2.status === EMERGENCY_STATUS.evaluated && gap2.评估结论 === '补录：复盘后确认达标')
const m4 = emergencyMetrics()
check('补录后待闭环与待办仍相等', m4.evaluated + m4.legacyGap === m4.todoCount,
  `${m4.evaluated}+${m4.legacyGap} vs ${m4.todoCount}`)
check('补录后待办原地更新为正式整改结论（条数未增加）',
  listEmergencyTodos().filter((t) => t.关联编号 === gap.演练编号).length === 1 &&
  listEmergencyTodos().some((t) => t.关联编号 === gap.演练编号 && t.处置结论 === '补录：复盘后确认达标'))

console.log('12) 整链重置回到可复现初始状态')
const reset = resetEmergencyPipeline()
check('重置后重新播种 10 条', reset.seeded === 10)
check('重置后存量重新迁移 6 条', reset.migrated === 6)
check('重置后待办与已评估相等', emergencyMetrics().todoConsistent)

if (failures > 0) {
  console.error(`\n链路自检失败：${failures} 项未通过`)
  process.exit(1)
}
console.log('\n全部链路自检通过 ✅')
