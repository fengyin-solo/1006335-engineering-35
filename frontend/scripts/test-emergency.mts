/**
 * 应急演练链路自检测试（不引入测试框架：node 直接跑，构建链零额外依赖）。
 * 覆盖：确定性生成、初始化幂等、中断续跑、结论保护、岗位把关、乐观锁并发、
 * 迁移口径（巡检日期/缺失挂起/回补/判重）、自检条数同源、概览看板条数一致。
 */
import assert from 'node:assert/strict'

import {
  assertInvariants,
  advanceStatus,
  bootstrap,
  createEmptyState,
  runChecks,
  selectCounts,
  submitConclusion,
  todoMismatches,
} from '../src/domain/emergency/engine'
import { buildSeedBundle, fnv1a } from '../src/domain/emergency/generator'
import { CUTOVER_DATE, LEGACY_BACKFILL_CONCLUSION } from '../src/domain/emergency/policy'
import type { EmergencyState, Operator } from '../src/domain/emergency/types'

const NOW = '2026-10-07T09:00:00+08:00'
const ORGANIZER: Operator = { name: '周建国', role: '组织人员' }
const CREW: Operator = { name: '李大力', role: '参演班组' }
const VIEWER: Operator = { name: '王观摩', role: '观摩人员' }

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const seed = buildSeedBundle()

console.log('1. 确定性生成（按演练编号稳定，重建逐字节一致）')
test('FNV-1a 哈希稳定', () => {
  assert.equal(fnv1a('EMER-0001'), fnv1a('EMER-0001'))
  assert.notEqual(fnv1a('EMER-0001'), fnv1a('EMER-0002'))
})
test('两次构建的种子完全相等', () => {
  assert.deepEqual(buildSeedBundle(), buildSeedBundle())
})
test('演练时长与计划日期由编号决定且为合理值', () => {
  const a = buildSeedBundle().samples[0]
  const b = buildSeedBundle().samples[0]
  assert.equal(a.plannedDate, b.plannedDate)
  assert.equal(a.durationMinutes, b.durationMinutes)
  assert.match(a.plannedDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(a.durationMinutes >= 30 && a.durationMinutes <= 180)
})

console.log('2. 初始化幂等：反复执行不改已有记录、不冲掉评估结论')
test('bootstrap(null) 后再 bootstrap(state) 结果深相等', () => {
  const first = bootstrap(null, seed, { now: NOW })
  const second = bootstrap(first, seed, { now: NOW })
  assert.deepEqual(second, first)
})
test('已评估演练的结论在第二次初始化后原样保留', () => {
  const first = bootstrap(null, seed, { now: NOW })
  const evaluated = first.drills.filter((d) => d.status === '已评估')
  assert.ok(evaluated.length > 0)
  const before = new Map(evaluated.map((d) => [d.code, d.conclusion]))
  const second = bootstrap(first, seed, { now: NOW })
  for (const [code, conclusion] of before) {
    const drill = second.drills.find((d) => d.code === code)
    assert.equal(drill?.conclusion, conclusion)
  }
})
test('手工改过的演练记录不会被初始化覆盖（字段以在库为准）', () => {
  const first = bootstrap(null, seed, { now: NOW })
  const target = first.drills.find((d) => d.code === 'EMER-0001')
  assert.ok(target)
  target.scene = '人工修改过的场景名'
  const second = bootstrap(first, seed, { now: NOW })
  assert.equal(
    second.drills.find((d) => d.code === 'EMER-0001')?.scene,
    '人工修改过的场景名',
  )
})

console.log('3. 中断续跑：跑到一半中断，接着跑完与一次跑成结果一致')

function runCrashing(crashCode: string): EmergencyState {
  let latest: EmergencyState = createEmptyState()
  try {
    bootstrap(null, seed, {
      now: NOW,
      crashBeforeLegacyCode: crashCode,
      onCommit: (snapshot) => {
        latest = snapshot
      },
    })
    throw new Error('本用例期望 bootstrap 中断抛错')
  } catch (error) {
    assert.match((error as Error).message, /模拟中断/)
  }
  return latest
}

test('crashBeforeLegacyCode 抛错后已写迁移账的行被保留在最后快照里', () => {
  const partial = runCrashing('OLD-2025-001')
  assert.ok(!partial.bootstrapDone)
  assert.ok(partial.ledger.length > 0)
  assert.ok(!partial.drills.some((d) => d.code === 'OLD-2025-001'))
  // 更早的行已经落账
  assert.ok(partial.drills.some((d) => d.code === 'OLD-2023-001'))
})
test('续跑结果与不中断一次跑成深相等', () => {
  const full = bootstrap(null, seed, { now: NOW })
  const partial = runCrashing('OLD-2025-001')
  const resumed = bootstrap(partial, seed, { now: NOW })
  assert.deepEqual(resumed, full)
})
test('第二次初始化再次中断时，已提交快照本身保持稳定（幂等）', () => {
  const full = bootstrap(null, seed, { now: NOW })
  const snapshot1 = runCrashing('OLD-2025-001')
  const snapshot2 = runCrashing('OLD-2025-001')
  assert.deepEqual(snapshot1, snapshot2)
  assert.ok(snapshot1.ledger.length <= full.ledger.length)
})
test('迁移账行级去重：同一编号不同巡检日期各有各的账', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const june = state.ledger.find((e) => e.legacyCode === 'OLD-2023-002' && e.inspectDate === '2023-06-22')
  const sept = state.ledger.find((e) => e.legacyCode === 'OLD-2023-002' && e.outcome === 'duplicate-skipped')
  assert.ok(june && june.outcome === 'backfilled', '巡检日期更早的一条应迁入（缺失结论按回补）')
  assert.ok(sept, '后来重复的一条应判重跳过')
})

console.log('4. 存量迁移口径')
test('往期数据按巡检日期整体搬入计划日期并留痕', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const drill = state.drills.find((d) => d.code === 'OLD-2023-001')
  assert.ok(drill)
  assert.equal(drill.plannedDate, drill.legacyInspectDate)
  assert.equal(drill.plannedDate, '2023-04-18')
  assert.equal(drill.source, 'legacy')
})
test('老数据沿用原有结论', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const drill = state.drills.find((d) => d.code === 'OLD-2023-001')
  assert.equal(drill?.conclusion, '旧台账结论：处置得当，资料归档')
})
test('切换日前缺失结论按统一旧口径回补', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const drill = state.drills.find((d) => d.code === 'OLD-2023-002')
  assert.ok(drill)
  assert.equal(drill.conclusion, LEGACY_BACKFILL_CONCLUSION)
  assert.ok('2023-06-22' < CUTOVER_DATE)
  assert.equal(state.ledger.find((e) => e.legacyCode === 'OLD-2023-002' && e.outcome === 'backfilled')?.legacyCode, 'OLD-2023-002')
})
test('切换日当天及以后缺失结论不回补，留给自检', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const drill = state.drills.find((d) => d.code === 'OLD-2026-004')
  assert.ok(drill)
  assert.equal(drill.conclusion, '')
  assert.equal(drill.status, '已评估')
})
test('缺失项逐条挂待确认，不臆造', () => {
  const state = bootstrap(null, seed, { now: NOW })
  assert.equal(state.pendings.length, 3)
  const noScene = state.pendings.find((p) => p.legacyCode === 'OLD-2024-001')
  assert.ok(noScene?.missingFields.includes('演练场景'))
  const noDate = state.pendings.find((p) => p.legacyCode === 'OLD-2024-003')
  assert.ok(noDate?.missingFields.includes('巡检日期'))
})
test('判重字段是演练编号：撞样例编号的存量行整笔不迁移，样例结论不动', () => {
  const state = bootstrap(null, seed, { now: NOW })
  assert.equal(state.drills.filter((d) => d.code === 'EMER-0003').length, 1)
  const sample = state.drills.find((d) => d.code === 'EMER-0003')
  assert.notEqual(sample?.conclusion, '试图覆盖样例结论，必须被挡住')
  assert.equal(sample?.source, 'sample')
})

console.log('5. 岗位把关：只有组织人员能落结论，其他人只读')
test('参演班组提交结论被整笔驳回，状态与待办都不变', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '演练中')
  assert.ok(target)
  const todosBefore = state.todos.length
  const result = submitConclusion(state, {
    code: target.code,
    conclusion: '越权结论',
    operator: CREW,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /越权/)
  assert.equal(result.state, state, '驳回时返回原 state 引用，未产生任何写入')
  assert.equal(result.state.todos.length, todosBefore)
})
test('观摩人员同样只读，组织/取消也驳回', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '待组织')
  assert.ok(target)
  const result = advanceStatus(state, {
    code: target.code,
    action: '组织演练',
    operator: VIEWER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /越权/)
})
test('组织人员正常提交成功并回写一条待办', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '演练中')!
  const todosBefore = state.todos.length
  const result = submitConclusion(state, {
    code: target.code,
    conclusion: '正式评估结论：合格',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.state.todos.length, todosBefore + 1)
  assert.equal(result.state.drills.find((d) => d.code === target.code)?.status, '已评估')
})

console.log('6. 并发：同一时刻两笔提交，先到入账，后到整笔回退')
test('后到提交携带旧 version 被整笔回退，结论与待办只落一次', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '演练中')!
  const first = submitConclusion(state, {
    code: target.code,
    conclusion: '先到的结论',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(first.ok, true)
  // 第二笔与第一笔同一时刻进来、都基于页面旧数据（旧 version）；先到的已入账，
  // 后到的再拿旧 version 提交到「更新后的库」，必须整笔回退。
  const second = submitConclusion(first.state, {
    code: target.code,
    conclusion: '后到的结论',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(second.ok, false)
  assert.match(second.message, /并发冲突/)
  assert.equal(second.state, first.state, '回退时返回最新库状态引用，没有写入')
  const todos = first.state.todos.filter((t) => t.drillCode === target.code)
  assert.equal(todos.length, 1)
  assert.equal(todos[0].summary, '先到的结论')
})
test('状态流转并发同样按 version 判先后', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '待组织')!
  const first = advanceStatus(state, {
    code: target.code,
    action: '组织演练',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(first.ok, true)
  const second = advanceStatus(first.state, {
    code: target.code,
    action: '取消演练',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(second.ok, false)
  assert.match(second.message, /并发冲突/)
})
test('已有评估结论不可被重复提交冲掉', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '已评估' && d.conclusion)!
  const result = submitConclusion(state, {
    code: target.code,
    conclusion: '试图覆盖',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /已有评估结论|原结论保持不变/)
  assert.equal(state.drills.find((d) => d.code === target.code)?.conclusion, target.conclusion)
})

console.log('7. 收尾自检：三类问题逐条缘由，核对条数与页面同源')
test('自检发现 5 条：撞车 2、缺人 1、顶牛 2', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const findings = runChecks(state)
  const counts = selectCounts(state)
  assert.equal(findings.length, 5)
  assert.equal(counts.findings, findings.length, '计数必须取自同一函数')
  assert.equal(findings.filter((f) => f.kind === '演练编号撞车').length, 2)
  assert.equal(findings.filter((f) => f.kind === '参与班组缺人').length, 1)
  assert.equal(findings.filter((f) => f.kind === '评估结论与状态顶牛').length, 2)
  for (const f of findings) {
    assert.ok(f.reason.length > 10 && f.drillCode, '每条都要有编号与缘由')
  }
})
test('运行期手工写进库里的重复编号也能被自检挑出', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const dup = { ...state.drills[0], id: 9999 }
  state.drills.push(dup)
  const findings = runChecks(state)
  assert.ok(findings.some((f) => f.kind === '演练编号撞车' && f.drillCode === dup.code))
})

console.log('8. 处置结论回写另一入口待办，两边条数一致')
test('初始化后已评估有结论条数 == 待办条数，逐条内容一致', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const counts = selectCounts(state)
  assert.equal(counts.concluded, counts.todos)
  assert.deepEqual(todoMismatches(state), [])
  assert.deepEqual(assertInvariants(state), [])
})
test('每次提交结论与待办同一事务，回退时两边都不落', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const target = state.drills.find((d) => d.status === '演练中')!
  const before = state.todos.length
  const rejected = submitConclusion(state, {
    code: target.code,
    conclusion: '',
    operator: ORGANIZER,
    expectedVersion: target.version,
    now: NOW,
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.state.todos.length, before)
})

console.log('9. 概览与看板：只允许一个数')
test('所有页面可展示的数字都从 selectCounts 取，多处读取一致', () => {
  const state = bootstrap(null, seed, { now: NOW })
  const c1 = selectCounts(state)
  const c2 = selectCounts(state)
  assert.deepEqual(c1, c2)
  const findings = runChecks(state)
  assert.equal(c1.findings, findings.length)
  assert.equal(c1.total, state.drills.length)
  assert.equal(
    c1.byStatus['待组织'] + c1.byStatus['演练中'] + c1.byStatus['已评估'] + c1.byStatus['已取消'],
    c1.total,
  )
  assert.equal(c1.pending, c1.byStatus['待组织'] + c1.byStatus['演练中'])
})

console.log(`\n全部通过：${passed} 组用例`)
