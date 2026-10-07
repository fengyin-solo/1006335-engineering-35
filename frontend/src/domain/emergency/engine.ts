/**
 * 应急演练领域引擎：纯函数 + 显式 state 出入参，不碰 localStorage。
 * 浏览器仓库层和 Node 初始化/测试脚本调的是同一套逻辑。
 */
import {
  CUTOVER_DATE,
  GENERATED_AT,
  KNOWN_CREWS,
  LEGACY_BACKFILL_CONCLUSION,
  SCHEMA_VERSION,
  SEED_REVISION,
  TERMINAL_STATUSES,
  canWrite,
  legacyMissingFields,
  mapLegacyStatus,
} from './policy'
import type {
  AdvanceInput,
  BootstrapOptions,
  CommitResult,
  Counts,
  DrillRecord,
  DrillStatus,
  DrillTodo,
  EmergencyState,
  Finding,
  FindingKind,
  LegacyRow,
  PendingConfirm,
  SeedBundle,
  SubmitConclusionInput,
} from './types'

export function createEmptyState(): EmergencyState {
  return {
    schemaVersion: SCHEMA_VERSION,
    seedRevision: SEED_REVISION,
    drills: [],
    todos: [],
    pendings: [],
    ledger: [],
    bootstrapDone: false,
    bootstrappedAt: '',
    collisionFindings: [],
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function splitCrews(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[、,，\/]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function nextDrillId(drills: DrillRecord[]): number {
  return drills.reduce((max, row) => Math.max(max, row.id), 8000) + 1
}

function nextTodoId(todos: DrillTodo[]): number {
  return todos.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

function nextPendingId(pendings: PendingConfirm[]): number {
  return pendings.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

/** 行级迁移键：演练编号|巡检日期。缺日期的行补 `#序号` 占位，保证各有各的账。 */
function rowKeyOf(row: LegacyRow, index: number): string {
  const date = String(row.inspectDate ?? '').trim()
  return `${row.legacyCode}|${date || `#missing-${index}`}`
}

function ledgerHas(ledger: EmergencyState['ledger'], rowKey: string): boolean {
  return ledger.some((entry) => entry.rowKey === rowKey)
}

/** 每落一条迁移账就提交一次快照：中断时已提交的行已经在仓库里，续跑从断点继续。 */
function commitRow(state: EmergencyState, options: BootstrapOptions): void {
  options.onCommit?.(clone(state))
}

/**
 * 撞车发现从迁移账重建：无论首次迁移还是中断后续跑/重复初始化，
 * duplicate-skipped（存量内部重复）与 collision-skipped（与在库撞号）都要逐条带缘由出现。
 */
function collisionFindingsFromLedger(state: EmergencyState): Finding[] {
  const findings: Finding[] = []
  for (const entry of state.ledger) {
    if (entry.outcome === 'duplicate-skipped') {
      findings.push({
        kind: '演练编号撞车',
        drillCode: entry.legacyCode,
        reason: `存量行 ${entry.legacyCode}（巡检日期 ${entry.inspectDate || '缺失'}）与更早的存量行演练编号撞车，按演练编号判重，保留巡检日期最早的一条，本行整笔不迁移`,
      })
    } else if (entry.outcome === 'collision-skipped') {
      findings.push({
        kind: '演练编号撞车',
        drillCode: entry.legacyCode,
        reason: `存量行 ${entry.legacyCode}（巡检日期 ${entry.inspectDate || '缺失'}）与在库演练编号撞车，判重字段为演练编号；在库记录及其评估结论保持不动，存量行整笔不迁移`,
      })
    }
  }
  return findings
}

/**
 * 存量迁移：按巡检日期从早到晚整体搬入。
 * 判重字段：演练编号（code）。同编号在存量里重复出现 -> 保留巡检日期最早的一条，
 * 后来的记 duplicate-skipped；与样例/在库演练撞号 -> collision-skipped，绝不覆盖已有结论。
 * 撞车/重复行只记迁移账，自检时由 collisionFindingsFromLedger 逐条还原缘由。
 */
function migrateLegacy(
  state: EmergencyState,
  legacy: LegacyRow[],
  options: BootstrapOptions,
): void {
  const ordered = [...legacy].sort((a, b) => {
    const da = String(a.inspectDate ?? '')
    const db = String(b.inspectDate ?? '')
    if (!da && !db) return a.legacyCode.localeCompare(b.legacyCode)
    if (!da) return 1
    if (!db) return -1
    return da < db ? -1 : da > db ? 1 : a.legacyCode.localeCompare(b.legacyCode)
  })

  // 重建「已迁入演练编号」集合：续跑时已经入库的存量编号仍然算占位，
  // 这样同编号的后来行依旧被判重跳过。
  const seenLegacyCodes = new Set<string>(
    state.drills.filter((drill) => drill.source === 'legacy').map((drill) => drill.code),
  )

  for (const [index, row] of ordered.entries()) {
    const rowKey = rowKeyOf(row, index)
    if (ledgerHas(state.ledger, rowKey)) {
      // 迁移账里已有这一行的去向：续跑/重复初始化时整行跳过，结果不变。
      seenLegacyCodes.add(row.legacyCode)
      continue
    }

    // 测试钩子：模拟跑到这一条之前中断。已写迁移账的行不受影响，可接着跑。
    if (options.crashBeforeLegacyCode === row.legacyCode) {
      throw new Error(`模拟中断：存量行 ${row.legacyCode} 尚未处理`)
    }

    const missing = legacyMissingFields(row)
    if (missing.length > 0) {
      if (!state.pendings.some((item) => item.legacyCode === row.legacyCode && item.inspectDate === String(row.inspectDate ?? ''))) {
        state.pendings.push({
          id: nextPendingId(state.pendings),
          legacyCode: row.legacyCode,
          inspectDate: String(row.inspectDate ?? ''),
          missingFields: missing,
          reason: `必填项缺失（${missing.join('、')}），迁移不臆造，挂起等人工确认`,
          raw: clone(row),
          createdAt: options.now,
        })
      }
      state.ledger.push({
        rowKey,
        legacyCode: row.legacyCode,
        inspectDate: String(row.inspectDate ?? ''),
        outcome: 'incomplete-pending',
        reason: `缺失 ${missing.join('、')}，已挂待确认`,
        processedAt: options.now,
      })
      seenLegacyCodes.add(row.legacyCode)
      commitRow(state, options)
      continue
    }

    // 能走到这里说明必填项齐全：巡检日期是非空字符串。
    const inspectDate = row.inspectDate as string

    // 存量内部判重：演练编号相同，保留巡检日期最早的（排序保证先到的先落库）。
    if (seenLegacyCodes.has(row.legacyCode)) {
      state.ledger.push({
        rowKey,
        legacyCode: row.legacyCode,
        inspectDate,
        outcome: 'duplicate-skipped',
        reason: '同一演练编号在存量台账里重复登记，保留巡检日期最早的一条',
        processedAt: options.now,
      })
      commitRow(state, options)
      continue
    }

    // 跨源判重：与样例/在库演练编号撞车 -> 整行跳过，已有结论原封不动。
    const collided = state.drills.some((drill) => drill.code === row.legacyCode)
    if (collided) {
      seenLegacyCodes.add(row.legacyCode)
      state.ledger.push({
        rowKey,
        legacyCode: row.legacyCode,
        inspectDate,
        outcome: 'collision-skipped',
        reason: '演练编号与在库演练撞车，保留在库记录及其评估结论，存量行不迁移',
        processedAt: options.now,
      })
      commitRow(state, options)
      continue
    }

    const status = mapLegacyStatus(row.rawStatus)
    const mappedStatus: DrillStatus = status ?? '待组织'
    const originalConclusion = String(row.conclusion ?? '').trim()
    let conclusion = originalConclusion
    let outcome: 'imported' | 'backfilled' | 'kept-original' = 'imported'

    if (mappedStatus === '已评估') {
      if (originalConclusion) {
        outcome = 'kept-original' // 老数据沿用原有结论
      } else if (inspectDate < CUTOVER_DATE) {
        conclusion = LEGACY_BACKFILL_CONCLUSION // 早年缺失：切换日前按旧口径回补
        outcome = 'backfilled'
      }
      // 切换日（含）之后无结论：不回补，留给自检挑「顶牛」
    }

    const drill: DrillRecord = {
      id: nextDrillId(state.drills),
      code: row.legacyCode,
      scene: String(row.scene ?? ''),
      crew: splitCrews(row.crew),
      plannedDate: inspectDate, // 往期数据按巡检日期整体搬入计划日期
      durationMinutes: Number(row.durationMinutes ?? 0),
      conclusion,
      organizer: String(row.organizer ?? ''),
      status: mappedStatus,
      source: 'legacy',
      legacyInspectDate: inspectDate,
      legacyCode: row.legacyCode,
      version: 1,
      createdAt: options.now,
      updatedAt: options.now,
    }
    state.drills.push(drill)
    seenLegacyCodes.add(row.legacyCode)
    state.ledger.push({
      rowKey,
      legacyCode: row.legacyCode,
      inspectDate,
      outcome,
      drillCode: row.legacyCode,
      reason:
        outcome === 'backfilled'
          ? `巡检日期早于切换日 ${CUTOVER_DATE} 且无原始结论，按旧口径回补`
          : outcome === 'kept-original'
            ? '沿用旧台账原有评估结论'
            : '按巡检日期整体迁入',
      processedAt: options.now,
    })
    commitRow(state, options)
  }
}

/**
 * 初始化一条链：样例按演练编号补齐 -> 存量按巡检日期迁移 -> 为已评估演练对齐待办。
 * 幂等：已存在的演练编号原样保留（尤其已评估结论），只补缺；可续跑：每处理一条
 * 存量就写迁移账，中断后重跑从断点继续。整个过程产出的是全新 state，调用方一次性落库。
 */
export function bootstrap(prev: EmergencyState | null, seed: SeedBundle, options: BootstrapOptions): EmergencyState {
  const state: EmergencyState = prev
    ? clone(prev)
    : createEmptyState()

  state.schemaVersion = SCHEMA_VERSION
  state.seedRevision = SEED_REVISION

  // 1) 样例：只补库里缺的演练编号，字段一律以在库为准，绝不重算、不覆盖。
  for (const sample of seed.samples) {
    if (!state.drills.some((drill) => drill.code === sample.code)) {
      state.drills.push(clone(sample))
    }
  }

  // 2) 存量迁移（断点由迁移账保证）。撞车/重复发现统一从迁移账重建，
  //    已经只在迁移账里留痕的行也不会丢，自检页每次都能逐条列出缘由。
  migrateLegacy(state, seed.legacy, options)
  state.collisionFindings = collisionFindingsFromLedger(state)

  // 3) 待办对齐：每条已评估演练在另一入口恰好有一条待办，已存在不重复回写。
  for (const drill of state.drills) {
    if (drill.status === '已评估' && drill.conclusion.trim() !== '') {
      if (!state.todos.some((todo) => todo.drillCode === drill.code)) {
        state.todos.push({
          id: nextTodoId(state.todos),
          drillCode: drill.code,
          summary: drill.conclusion,
          organizer: drill.organizer,
          createdAt: drill.updatedAt || GENERATED_AT,
          status: '待办',
        })
      }
    }
  }

  state.bootstrapDone = true
  state.bootstrappedAt = options.now
  return state
}

function fail(state: EmergencyState, message: string): CommitResult {
  return { ok: false, state, message }
}

/**
 * 提交评估结论——按岗位把关：
 * 只有组织人员能落结论，参演/观摩只读，越权整笔驳回；
 * 乐观锁 version：同一时刻两笔并发提交，后到的拿旧 version -> 整笔回退；
 * 已评估记录重复提交一律驳回，已有结论不被冲掉。
 * 落结论同时向待办清单回写一条，两边同一事务，要么都成要么都退。
 */
export function submitConclusion(prev: EmergencyState, input: SubmitConclusionInput): CommitResult {
  if (!canWrite(input.operator.role)) {
    return fail(prev, `越权提交被驳回：岗位「${input.operator.role}」对评估结论只读，只有组织人员能落结论`)
  }
  const conclusion = input.conclusion.trim()
  if (!conclusion) {
    return fail(prev, '评估结论不能为空')
  }
  const state = clone(prev)
  const drill = state.drills.find((item) => item.code === input.code)
  if (!drill) {
    return fail(prev, `没有找到演练编号 ${input.code}`)
  }
  if (drill.version !== input.expectedVersion) {
    return fail(
      prev,
      `并发冲突：演练 ${input.code} 已被先到的提交更新，本笔整笔回退，请刷新后重试`,
    )
  }
  if (drill.status === '已评估') {
    return fail(prev, `演练 ${input.code} 已有评估结论，重复提交被驳回，原结论保持不变`)
  }
  if (drill.status === '已取消') {
    return fail(prev, `演练 ${input.code} 已取消，不能再落评估结论`)
  }
  if (drill.status === '待组织') {
    return fail(prev, `演练 ${input.code} 尚待组织，请先执行「组织演练」再提交评估`)
  }

  drill.status = '已评估'
  drill.conclusion = conclusion
  drill.organizer = input.operator.name
  drill.version += 1
  drill.updatedAt = input.now

  state.todos.push({
    id: nextTodoId(state.todos),
    drillCode: drill.code,
    summary: conclusion,
    organizer: input.operator.name,
    createdAt: input.now,
    status: '待办',
  })

  return { ok: true, state, message: `演练 ${drill.code} 评估结论已提交，并已回写处置待办` }
}

/** 组织演练 / 取消演练：同样按岗位把关并走乐观锁。 */
export function advanceStatus(prev: EmergencyState, input: AdvanceInput): CommitResult {
  if (!canWrite(input.operator.role)) {
    return fail(prev, `越权操作被驳回：岗位「${input.operator.role}」只读，只有组织人员能执行「${input.action}」`)
  }
  const state = clone(prev)
  const drill = state.drills.find((item) => item.code === input.code)
  if (!drill) {
    return fail(prev, `没有找到演练编号 ${input.code}`)
  }
  if (drill.version !== input.expectedVersion) {
    return fail(prev, `并发冲突：演练 ${input.code} 已被先到的提交更新，本笔整笔回退，请刷新后重试`)
  }
  if (TERMINAL_STATUSES.includes(drill.status)) {
    return fail(prev, `演练 ${input.code} 当前为「${drill.status}」，不能再执行「${input.action}」`)
  }

  if (input.action === '组织演练') {
    if (drill.status !== '待组织') {
      return fail(prev, `演练 ${input.code} 已在演练中，不用重复组织`)
    }
    drill.status = '演练中'
  } else {
    drill.status = '已取消'
  }
  drill.version += 1
  drill.updatedAt = input.now
  return { ok: true, state, message: `演练 ${drill.code} 已${input.action}，当前状态「${drill.status}」` }
}

/** 自检：演练编号撞车 / 参与班组缺人 / 评估结论与演练状态顶牛。同一份结果供页面与测试核对条数。 */
export function runChecks(state: EmergencyState): Finding[] {
  // 迁移阶段挡住的撞车/重复行（库里没有对应行，从 state.collisionFindings 取）。
  const findings: Finding[] = [...state.collisionFindings]

  // 1) 演练编号撞车（运行期被手工写进库里的重复编号，仍要能挑出来）
  const codeCount = new Map<string, number>()
  for (const drill of state.drills) {
    codeCount.set(drill.code, (codeCount.get(drill.code) ?? 0) + 1)
  }
  for (const drill of state.drills) {
    if ((codeCount.get(drill.code) ?? 0) > 1) {
      findings.push({
        kind: '演练编号撞车',
        drillCode: drill.code,
        reason: `演练编号 ${drill.code} 在台账中出现 ${codeCount.get(drill.code)} 次，判重字段（演练编号）必须唯一`,
      })
    }
  }

  // 2) 参与班组缺人：没有班组，或填的班组不在花名册
  for (const drill of state.drills) {
    if (drill.crew.length === 0) {
      findings.push({
        kind: '参与班组缺人',
        drillCode: drill.code,
        reason: `演练 ${drill.code} 没有任何参与班组，无法组织`,
      })
      continue
    }
    const unknown = drill.crew.filter((name) => !KNOWN_CREWS.includes(name))
    if (unknown.length > 0) {
      findings.push({
        kind: '参与班组缺人',
        drillCode: drill.code,
        reason: `演练 ${drill.code} 的班组「${unknown.join('、')}」不在班组花名册内，按缺人处理`,
      })
    }
  }

  // 3) 评估结论与演练状态互相顶牛
  for (const drill of state.drills) {
    const hasConclusion = drill.conclusion.trim() !== ''
    if (drill.status === '已评估' && !hasConclusion) {
      findings.push({
        kind: '评估结论与状态顶牛',
        drillCode: drill.code,
        reason: `演练 ${drill.code} 状态是「已评估」却没有评估结论（切换日后缺失不回补，需人工补结论）`,
      })
    }
    if (drill.status !== '已评估' && hasConclusion) {
      findings.push({
        kind: '评估结论与状态顶牛',
        drillCode: drill.code,
        reason: `演练 ${drill.code} 状态是「${drill.status}」却带着评估结论，结论与状态互相顶牛`,
      })
    }
  }

  const order: Record<FindingKind, number> = {
    演练编号撞车: 0,
    参与班组缺人: 1,
    评估结论与状态顶牛: 2,
  }
  findings.sort((a, b) =>
    a.drillCode === b.drillCode
      ? order[a.kind] - order[b.kind]
      : a.drillCode.localeCompare(b.drillCode),
  )
  return findings
}

/** 待办回写对账：已评估且有结论的演练，与另一入口待办逐条对应。 */
export function todoMismatches(state: EmergencyState): string[] {
  const mismatches: string[] = []
  for (const drill of state.drills) {
    if (drill.status !== '已评估' || drill.conclusion.trim() === '') continue
    const todos = state.todos.filter((todo) => todo.drillCode === drill.code)
    if (todos.length !== 1) {
      mismatches.push(`演练 ${drill.code} 已评估，但待办清单里对应 ${todos.length} 条，应为 1 条`)
      continue
    }
    if (todos[0].summary !== drill.conclusion) {
      mismatches.push(`演练 ${drill.code} 的待办处置结论与评估结论不一致`)
    }
  }
  for (const todo of state.todos) {
    const drill = state.drills.find((item) => item.code === todo.drillCode)
    if (!drill || drill.status !== '已评估') {
      mismatches.push(`待办 ${todo.drillCode} 找不到对应的「已评估」演练`)
    }
  }
  return mismatches
}

/**
 * 统一计数：概览、看板、自检页只能取这里的数，不允许各算各的出现两个数。
 */
export function selectCounts(state: EmergencyState): Counts {
  const byStatus = { 待组织: 0, 演练中: 0, 已评估: 0, 已取消: 0 } as Record<DrillStatus, number>
  for (const drill of state.drills) {
    byStatus[drill.status] += 1
  }
  const evaluated = byStatus['已评估']
  const concluded = state.drills.filter(
    (drill) => drill.status === '已评估' && drill.conclusion.trim() !== '',
  ).length
  return {
    total: state.drills.length,
    byStatus,
    evaluated,
    concluded,
    pending: byStatus['待组织'] + byStatus['演练中'],
    todos: state.todos.length,
    findings: runChecks(state).length,
    pendings: state.pendings.length,
  }
}

/**
 * 条数一致性不变量：
 * 已评估且有结论的演练条数 == 另一入口处置待办条数（每条处置结论恰好回写一条）；
 * 自检条数 == runChecks 结果条数（由 selectCounts.findings 同源保证）。
 */
export function assertInvariants(state: EmergencyState): string[] {
  const problems: string[] = []
  const counts = selectCounts(state)
  if (counts.concluded !== counts.todos) {
    problems.push(`已评估有结论的演练 ${counts.concluded} 条，但处置待办 ${counts.todos} 条，两边条数必须一致`)
  }
  for (const message of todoMismatches(state)) {
    problems.push(message)
  }
  return problems
}
