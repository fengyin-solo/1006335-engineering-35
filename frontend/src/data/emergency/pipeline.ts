/**
 * 应急演练管理主链路：
 *   初始化播种（幂等、可续跑） → 存量迁移（按计划日期、判重、缺失暂存、历史口径回补）
 *   → 评估提交（岗位把关 + 乐观锁并发 + 处置结论回写待办） → 自检（编号撞车/班组缺人/状态顶牛）
 *
 * 所有写操作都按行打检查点：跑到一半中断，重跑时从下一条接着做；已落库的记录不再改动。
 */
import {
  CUTOVER_DATE,
  DEDUP_FIELD,
  EMERGENCY_KEY,
  EMERGENCY_STATUS,
  EVALUATOR_ROLE,
  LEGACY_GAP_CONCLUSION,
  MIN_CREW_SIZE,
  type EmergencyRow,
  type IssueRow,
  type PipelineLedger,
  type StagedLegacyRow,
  type TodoRow,
} from './constants'
import {
  LEGACY_BATCH_ID,
  LEGACY_EMERGENCY_ROWS,
  SEED_VERSION,
  emergencySeedHash,
  generateEmergencySeed,
} from './generator'
import { readJSON, writeJSON } from '@/data/kv'
import type { EntryRow } from '@/data/types'

const ENTRIES_KEY = 'urban-utility-tunnel:entries'
const LEDGER_KEY = 'urban-utility-tunnel:pipeline-ledger'
const STAGED_KEY = 'urban-utility-tunnel:staged-legacy'
const TODO_KEY = 'urban-utility-tunnel:emergency-todos'

const CLOSED_STATUSES = [EMERGENCY_STATUS.evaluated, EMERGENCY_STATUS.cancelled]
/** 早期脚手架的占位演示数据：不是真实台账，首次跑链路时清掉一次。 */
const DEMO_PLACEHOLDER = '应急演练管理样例'

export type PipelineSummary = {
  seedVersion: string
  seedHash: string
  purgedDemo: number
  seeded: number
  migrated: number
  skippedDuplicate: number
  staged: number
  todos: number
  alreadyUpToDate: boolean
}

function emptyLedger(): PipelineLedger {
  return {
    seedVersion: SEED_VERSION,
    seedHash: emergencySeedHash(),
    migrations: {},
    seededCodes: [],
    resolvedStagedIds: [],
  }
}

function loadLedger(): PipelineLedger {
  return { ...emptyLedger(), ...readJSON<Partial<PipelineLedger>>(LEDGER_KEY, {}) }
}

function loadEntries(): Record<string, EntryRow[]> {
  return readJSON<Record<string, EntryRow[]>>(ENTRIES_KEY, {})
}

function loadEmergency(): EmergencyRow[] {
  return (loadEntries()[EMERGENCY_KEY] ?? []) as EmergencyRow[]
}

function saveEmergency(rows: EmergencyRow[]): void {
  const all = loadEntries()
  writeJSON(ENTRIES_KEY, { ...all, [EMERGENCY_KEY]: rows })
}

function loadStaged(): Record<string, StagedLegacyRow[]> {
  return readJSON<Record<string, StagedLegacyRow[]>>(STAGED_KEY, {})
}

function saveStaged(all: Record<string, StagedLegacyRow[]>): void {
  writeJSON(STAGED_KEY, all)
}

function loadTodos(): TodoRow[] {
  return readJSON<TodoRow[]>(TODO_KEY, [])
}

function saveTodos(todos: TodoRow[]): void {
  writeJSON(TODO_KEY, todos)
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function isClosed(status: string): boolean {
  return CLOSED_STATUSES.includes(status as (typeof CLOSED_STATUSES)[number])
}

function toEmergencyRow(input: {
  id: number
  演练编号: string
  演练场景: string
  参与班组: string
  参演人数: number
  计划日期: string
  演练时长: number
  评估结论: string
  组织人员: string
  演练状态: string
}): EmergencyRow {
  const status = input.演练状态 || EMERGENCY_STATUS.pending
  return {
    id: input.id,
    status,
    pending: !isClosed(status) && status !== EMERGENCY_STATUS.legacyGap,
    abnormal: false,
    v: 1,
    演练编号: input.演练编号,
    演练场景: input.演练场景,
    参与班组: input.参与班组,
    参演人数: Number(input.参演人数) || 0,
    计划日期: input.计划日期,
    演练时长: Number(input.演练时长) || 0,
    评估结论: input.评估结论 ?? '',
    组织人员: input.组织人员,
    演练状态: status,
  }
}

/**
 * 给需要闭环的演练 upsert 一条待办（按台账行 id 幂等，反复执行始终一条）。
 * 注意幂等键用行 id 而非演练编号：同批次编号撞车的两笔是两行记录，
 * 必须各有一条待办（撞车本身由自检挑出，不能在待办侧被静默合并）。
 * 已评估 → 整改落实待办；待补评估（往期缺口）→ 补录结论待办。
 * 处置结论回写的待办清单与台账条数始终一一对应；补录结论时原地更新同一条。
 */
function upsertTodoForRow(todos: TodoRow[], row: EmergencyRow): { created: boolean } {
  const bizKey = `emergency:id:${row.id}`
  const index = todos.findIndex((item) => item.bizKey === bizKey)
  const isGap = row.status === EMERGENCY_STATUS.legacyGap
  const base: TodoRow = {
    id: index >= 0 ? todos[index].id : todos.length ? Math.max(...todos.map((item) => item.id)) + 1 : 1,
    bizKey,
    来源: '应急演练管理',
    关联编号: row.演练编号,
    待办事项: isGap
      ? `补录「${row.演练场景}」往期缺失的评估结论`
      : `落实「${row.演练场景}」评估整改事项`,
    处置结论: isGap ? '待补评估结论（历史口径回补，人工补录后更新）' : row.评估结论,
    计划日期: row.计划日期,
    状态: '待处置',
    创建时间: CUTOVER_DATE,
  }
  if (index >= 0) {
    todos[index] = base
    return { created: false }
  }
  todos.push(base)
  return { created: true }
}

/** 已评估演练补整改待办（兼容旧调用点）。 */
function ensureTodo(todos: TodoRow[], row: EmergencyRow): TodoRow | null {
  const { created } = upsertTodoForRow(todos, row)
  return created ? todos[todos.length - 1] : null
}

/**
 * 存量迁移通用策略（巡检等往期模块沿用同一套，判重字段各自声明）：
 * 1. 按日期字段升序整体搬入；缺日期的排到最后，必然走缺失暂存；
 * 2. 自然键判重：同批次重复 → 保留两笔交自检；跨批次与正式台账撞键 → 跳过不覆盖；
 * 3. 必填字段缺失 → 整笔进暂存，逐条列缘由，人工确认后才允许落库；
 * 4. 每条处理完即写检查点，中断后重跑只补剩余条目。
 */
export type LegacyMigrationConfig<T extends Record<string, string | number>> = {
  moduleKey: string
  batchId: string
  dateField: string
  naturalKeyField: string
  requiredFields: string[]
  rows: T[]
}

export function listStaged(moduleKey: string): StagedLegacyRow[] {
  return loadStaged()[moduleKey] ?? []
}

/**
 * 跑一个模块的存量迁移批次。应急演练的历史口径回补在钩子中完成；
 * 巡检等模块传入同样的配置即可复用排序/判重/暂存/续跑逻辑。
 *
 * 检查点按批次内的行序号记录，因此同批次内演练编号撞车的多笔都会照常处理、
 * 全部保留下来交给自检；中断重跑时只补未处理序号。
 */
export function runLegacyMigration<T extends Record<string, string | number>>(
  config: LegacyMigrationConfig<T>,
  hooks: {
    materialize: (input: T, assignedId: number) => EntryRow
    onLive?: (row: EntryRow) => void
  },
): { migrated: number; staged: number; skippedDuplicate: number } {
  const ledger = loadLedger()
  const batch = ledger.migrations[config.batchId] ?? {
    done: false,
    processedIndexes: [] as number[],
  }
  const processedIndexes = new Set(batch.processedIndexes)

  const sorted = [...config.rows].sort((a, b) => {
    const da = String(a[config.dateField] ?? '')
    const db = String(b[config.dateField] ?? '')
    if (!da) {
      return 1
    }
    if (!db) {
      return -1
    }
    return da < db ? -1 : da > db ? 1 : 0
  })

  let migrated = 0
  let stagedCount = 0
  let skippedDuplicate = 0

  const checkpoint = (sortedIndex: number) => {
    batch.processedIndexes.push(sortedIndex)
    ledger.migrations[config.batchId] = batch
    writeJSON(LEDGER_KEY, ledger)
  }

  sorted.forEach((input, sortedIndex) => {
    if (processedIndexes.has(sortedIndex)) {
      return
    }

    const code = String(input[config.naturalKeyField] ?? '').trim()
    const missing = config.requiredFields.filter((field) => {
      const value = input[field]
      return value === undefined || String(value).trim() === ''
    })

    const stagedAll = loadStaged()
    const stagedRows = stagedAll[config.moduleKey] ?? []

    if (!code || missing.length > 0) {
      // 字段缺失：整笔暂存，不自动落库，逐条列出缺失项等人工确认。
      const allEntries = loadEntries()
      const assignedId = nextId([
        ...(allEntries[config.moduleKey] ?? []),
        ...stagedRows,
      ])
      const staged: StagedLegacyRow = {
        ...(hooks.materialize(input, assignedId) as unknown as EmergencyRow),
        缺失字段: !code ? [config.naturalKeyField, ...missing] : missing,
        迁移批次: config.batchId,
      }
      stagedAll[config.moduleKey] = [...stagedRows, staged]
      saveStaged(stagedAll)
      checkpoint(sortedIndex)
      stagedCount += 1
      return
    }

    // 同批次里更早的同键行：第一笔照常落库，第二笔同样落库（撞车保留交自检）。
    const earlierSibling = sorted
      .slice(0, sortedIndex)
      .some((item) => String(item[config.naturalKeyField] ?? '').trim() === code)

    const allEntries = loadEntries()
    const live = (allEntries[config.moduleKey] ?? []) as EntryRow[]
    const liveHasKey = live.some((row) => String(row[config.naturalKeyField] ?? '') === code)
    // 跨批次撞键（正式台账已有且源数据里没有更早同键行）才跳过，绝不覆盖已有记录。
    if (liveHasKey && !earlierSibling) {
      checkpoint(sortedIndex)
      skippedDuplicate += 1
      return
    }

    const assignedId = nextId([...live, ...stagedRows])
    const row = hooks.materialize(input, assignedId)
    allEntries[config.moduleKey] = [...live, row]
    writeJSON(ENTRIES_KEY, allEntries)
    hooks.onLive?.(row)
    checkpoint(sortedIndex)
    migrated += 1
  })

  batch.done = true
  ledger.migrations[config.batchId] = batch
  writeJSON(LEDGER_KEY, ledger)
  return { migrated, staged: stagedCount, skippedDuplicate }
}

/**
 * 应急演练完整链路入口：初始化脚本。
 * 反复执行结果一致——已有的演练记录一条不改，只补缺、迁存量、记账本。
 */
export function runEmergencyPipeline(): PipelineSummary {
  const ledger0 = loadLedger()
  let purgedDemo = 0
  let seeded = 0

  // 1) 清掉脚手架占位演示数据（只清一次，真实记录绝不动）。
  if (!ledger0.migrations['demo-purge']?.done) {
    const rows = loadEmergency()
    const kept = rows.filter(
      (row) =>
        !String(row.演练场景 ?? '').startsWith(DEMO_PLACEHOLDER) &&
        !String(row.组织人员 ?? '').startsWith(DEMO_PLACEHOLDER),
    )
    purgedDemo = rows.length - kept.length
    if (purgedDemo > 0) {
      saveEmergency(kept)
    }
    const ledger = loadLedger()
    ledger.migrations['demo-purge'] = { done: true, processedIndexes: [] }
    writeJSON(LEDGER_KEY, ledger)
  }

  // 2) 规范示例按演练编号补齐：本地与线上同一份数据集，同编号已存在就跳过。
  for (const sample of generateEmergencySeed()) {
    const rows = loadEmergency()
    if (rows.some((row) => String(row.演练编号) === sample.演练编号)) {
      continue
    }
    const ledger = loadLedger()
    if (ledger.seededCodes.includes(sample.演练编号)) {
      continue
    }
    const assigned = { ...sample, id: nextId(rows) }
    saveEmergency([...rows, assigned])
    // 已评估样例同步回写待办，保证“已评估条数 = 待办条数”从首次落库起就成立。
    if (assigned.status === EMERGENCY_STATUS.evaluated) {
      const todos = loadTodos()
      if (ensureTodo(todos, assigned)) {
        saveTodos(todos)
      }
    }
    const fresh = loadLedger()
    fresh.seededCodes.push(sample.演练编号)
    writeJSON(LEDGER_KEY, fresh)
    seeded += 1
  }

  // 3) 存量台账按计划日期整体搬入（切换日前口径：没结论的回补“待补评估”）。
  const result = runLegacyMigration(
    {
      moduleKey: EMERGENCY_KEY,
      batchId: LEGACY_BATCH_ID,
      dateField: '计划日期',
      naturalKeyField: DEDUP_FIELD,
      requiredFields: ['演练编号', '演练场景', '参与班组', '计划日期', '组织人员'],
      rows: LEGACY_EMERGENCY_ROWS,
    },
    {
      materialize: (input, assignedId) => {
        const noConclusion = !String(input.评估结论 ?? '').trim()
        // 历史回补口径：切换日前“已举办（演练中/已评估）却没留下结论”的，
        // 回补为“待补评估”占位并列入自检；从未组织（待组织）的不属于结论缺口，原样搬入。
        const heldWithoutConclusion = (
          [EMERGENCY_STATUS.running, EMERGENCY_STATUS.evaluated] as string[]
        ).includes(input.演练状态)
        const backfill =
          noConclusion &&
          String(input.计划日期) < CUTOVER_DATE &&
          heldWithoutConclusion
        return toEmergencyRow({
          ...input,
          id: assignedId,
          演练状态: backfill ? EMERGENCY_STATUS.legacyGap : input.演练状态,
          评估结论: backfill ? LEGACY_GAP_CONCLUSION : input.评估结论,
        })
      },
      onLive: (row) => {
        // 沿用原结论的老演练、回补待补评估的老演练都回写一条待办，保证两边条数恒等。
        if (
          row.status === EMERGENCY_STATUS.evaluated ||
          row.status === EMERGENCY_STATUS.legacyGap
        ) {
          const todos = loadTodos()
          upsertTodoForRow(todos, row as EmergencyRow)
          saveTodos(todos)
        }
      },
    },
  )

  return {
    seedVersion: SEED_VERSION,
    seedHash: emergencySeedHash(),
    purgedDemo,
    seeded,
    migrated: result.migrated,
    skippedDuplicate: result.skippedDuplicate,
    staged: result.staged,
    todos: loadTodos().length,
    alreadyUpToDate:
      purgedDemo === 0 && seeded === 0 && result.migrated === 0 && result.staged === 0,
  }
}

// ---------------------------------------------------------------------------
// 评估提交：岗位把关 + 乐观锁并发 + 处置结论回写待办
// ---------------------------------------------------------------------------

export type SubmitEvaluationInput = {
  id: number
  role: string
  conclusion: string
  expectedVersion: number
}

export type SubmitEvaluationResult = {
  ok: boolean
  message: string
  version?: number
}

export function submitEvaluation(input: SubmitEvaluationInput): SubmitEvaluationResult {
  if (input.role !== EVALUATOR_ROLE) {
    // 越权提交：整笔驳回，不写任何数据。
    return {
      ok: false,
      message: `越权提交被驳回：只有${EVALUATOR_ROLE}能落评估结论，当前岗位为「${input.role}」（只读）`,
    }
  }
  const conclusion = input.conclusion.trim()
  if (!conclusion) {
    return { ok: false, message: '评估结论不能为空，本笔提交已驳回' }
  }

  const rows = loadEmergency()
  const index = rows.findIndex((row) => Number(row.id) === Number(input.id))
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${input.id} 的演练记录` }
  }
  const row = rows[index]

  // 乐观锁必须最先判：同一时刻两笔并发提交读到的业务状态完全相同，
  // 只有版本号能区分先后——先到入账推进版本，后到整笔回退。
  if (Number(row.v) !== Number(input.expectedVersion)) {
    return {
      ok: false,
      message: '演练记录已被先到的提交更新（版本号变化），后到的提交整笔回退，请刷新后重试',
    }
  }

  if (row.status !== EMERGENCY_STATUS.running) {
    return { ok: false, message: `演练当前状态为「${row.status}」，只有「演练中」的演练允许提交评估` }
  }
  if (String(row.评估结论 ?? '').trim()) {
    // 已评估结论不允许被二次提交冲掉。
    return { ok: false, message: '该演练已有评估结论，不得覆盖，本笔提交已驳回' }
  }

  const updated: EmergencyRow = {
    ...row,
    status: EMERGENCY_STATUS.evaluated,
    pending: false,
    评估结论: conclusion,
    演练状态: EMERGENCY_STATUS.evaluated,
    v: Number(row.v) + 1,
  }
  const nextRows = [...rows]
  nextRows[index] = updated

  // 演练台账与待办清单必须同进同退：先暂存旧值，待办写失败就回滚台账。
  const previousRows = rows
  const previousTodos = loadTodos()
  try {
    saveEmergency(nextRows)
    const todos = loadTodos()
    upsertTodoForRow(todos, updated)
    saveTodos(todos)
  } catch (error) {
    saveEmergency(previousRows)
    saveTodos(previousTodos)
    return { ok: false, message: `提交失败已整笔回退：${error instanceof Error ? error.message : '未知错误'}` }
  }

  return {
    ok: true,
    message: `评估结论已入账，处置结论已回写待办清单（当前版本 v${updated.v}）`,
    version: updated.v,
  }
}

/** 往期回补的“待补评估”记录由组织人员补录真实结论，补录后同样回写待办。 */
export function supplementEvaluation(input: SubmitEvaluationInput): SubmitEvaluationResult {
  if (input.role !== EVALUATOR_ROLE) {
    return {
      ok: false,
      message: `越权提交被驳回：只有${EVALUATOR_ROLE}能补录评估结论，当前岗位为「${input.role}」（只读）`,
    }
  }
  const conclusion = input.conclusion.trim()
  if (!conclusion) {
    return { ok: false, message: '评估结论不能为空，本笔补录已驳回' }
  }
  const rows = loadEmergency()
  const index = rows.findIndex((row) => Number(row.id) === Number(input.id))
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${input.id} 的演练记录` }
  }
  const row = rows[index]
  if (row.status !== EMERGENCY_STATUS.legacyGap) {
    return { ok: false, message: '该演练不是待补评估的往期记录，无需补录' }
  }
  if (Number(row.v) !== Number(input.expectedVersion)) {
    return { ok: false, message: '演练记录已被更新（版本号变化），请刷新后重试' }
  }
  const updated: EmergencyRow = {
    ...row,
    status: EMERGENCY_STATUS.evaluated,
    pending: false,
    评估结论: conclusion,
    演练状态: EMERGENCY_STATUS.evaluated,
    v: Number(row.v) + 1,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  const previousRows = rows
  const previousTodos = loadTodos()
  try {
    saveEmergency(nextRows)
    const todos = loadTodos()
    // 往期补录：原“补录结论”待办原地更新为整改待办，条数不增不减。
    upsertTodoForRow(todos, updated)
    saveTodos(todos)
  } catch (error) {
    saveEmergency(previousRows)
    saveTodos(previousTodos)
    return { ok: false, message: `补录失败已整笔回退：${error instanceof Error ? error.message : '未知错误'}` }
  }
  return { ok: true, message: `往期结论已补录并更新待办清单（当前版本 v${updated.v}）`, version: updated.v }
}

/** 应急演练普通状态流转（组织/取消）：每次流转推进乐观锁版本。 */
export function transitionEmergency(id: number, target: string): { ok: boolean; message: string } {
  const rows = loadEmergency()
  const index = rows.findIndex((row) => Number(row.id) === Number(id))
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的演练记录` }
  }
  const row = rows[index]
  if (row.status === target) {
    return { ok: false, message: `演练已经是「${target}」，不用重复操作` }
  }
  const updated: EmergencyRow = {
    ...row,
    status: target,
    pending: !isClosed(target),
    abnormal: target === EMERGENCY_STATUS.cancelled,
    演练状态: target,
    v: Number(row.v) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveEmergency(next)
  return { ok: true, message: `演练状态已更新为「${target}」（当前版本 v${updated.v}）` }
}

// ---------------------------------------------------------------------------
// 暂存缺失项：人工确认后落库（仅组织人员），或放弃该笔
// ---------------------------------------------------------------------------

export function confirmStagedLegacy(
  stagedId: number,
  role: string,
  patch: Partial<Record<string, string | number>>,
): { ok: boolean; message: string } {
  if (role !== EVALUATOR_ROLE) {
    return { ok: false, message: `越权操作被驳回：只有${EVALUATOR_ROLE}能确认暂存记录，当前岗位为「${role}」` }
  }
  const stagedAll = loadStaged()
  const stagedRows = stagedAll[EMERGENCY_KEY] ?? []
  const index = stagedRows.findIndex((row) => Number(row.id) === Number(stagedId))
  if (index < 0) {
    return { ok: false, message: '暂存记录不存在或已处理' }
  }
  const staged = stagedRows[index]
  const merged: Record<string, string | number | boolean | string[]> = {
    ...staged,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined && value !== ''),
    ),
  }
  const stillMissing = ['演练编号', '演练场景', '参与班组', '计划日期', '组织人员'].filter(
    (field) => !String(merged[field] ?? '').trim(),
  )
  if (stillMissing.length) {
    return { ok: false, message: `仍有缺失项未补齐：${stillMissing.join('、')}` }
  }
  const rows = loadEmergency()
  const code = String(merged.演练编号)
  if (rows.some((row) => String(row.演练编号) === code)) {
    return { ok: false, message: `演练编号 ${code} 已在正式台账中存在，不能重复确认` }
  }
  const liveRow = toEmergencyRow({
    id: nextId(rows),
    演练编号: code,
    演练场景: String(merged.演练场景),
    参与班组: String(merged.参与班组),
    参演人数: Number(merged.参演人数) || 0,
    计划日期: String(merged.计划日期),
    演练时长: Number(merged.演练时长) || 0,
    评估结论: String(merged.评估结论 ?? ''),
    组织人员: String(merged.组织人员),
    演练状态: String(merged.演练状态 ?? merged.status ?? ''),
  })
  saveEmergency([...rows, liveRow])
  stagedAll[EMERGENCY_KEY] = stagedRows.filter((row) => Number(row.id) !== Number(stagedId))
  saveStaged(stagedAll)
  const ledger = loadLedger()
  ledger.resolvedStagedIds.push(Number(stagedId))
  writeJSON(LEDGER_KEY, ledger)
  return { ok: true, message: `演练 ${code} 已确认落入正式台账` }
}

export function discardStagedLegacy(stagedId: number, role: string): { ok: boolean; message: string } {
  if (role !== EVALUATOR_ROLE) {
    return { ok: false, message: `越权操作被驳回：只有${EVALUATOR_ROLE}能放弃暂存记录，当前岗位为「${role}」` }
  }
  const stagedAll = loadStaged()
  const stagedRows = stagedAll[EMERGENCY_KEY] ?? []
  const target = stagedRows.find((row) => Number(row.id) === Number(stagedId))
  if (!target) {
    return { ok: false, message: '暂存记录不存在或已处理' }
  }
  stagedAll[EMERGENCY_KEY] = stagedRows.filter((row) => Number(row.id) !== Number(stagedId))
  saveStaged(stagedAll)
  const ledger = loadLedger()
  ledger.resolvedStagedIds.push(Number(stagedId))
  writeJSON(LEDGER_KEY, ledger)
  return { ok: true, message: `演练 ${target.演练编号 || '(无编号)'} 的暂存记录已放弃` }
}

// ---------------------------------------------------------------------------
// 自检：演练编号撞车 / 参与班组缺人 / 评估结论与演练状态顶牛
// ---------------------------------------------------------------------------

function crewIssue(row: Pick<EmergencyRow, '参与班组' | '参演人数'>): boolean {
  return !String(row.参与班组 ?? '').trim() || Number(row.参演人数) < MIN_CREW_SIZE
}

function conflictIssue(row: EmergencyRow): string | null {
  const status = String(row.status)
  const hasConclusion = String(row.评估结论 ?? '').trim().length > 0
  if (status === EMERGENCY_STATUS.evaluated && !hasConclusion) {
    return '演练状态为「已评估」，但评估结论为空'
  }
  if (hasConclusion && status !== EMERGENCY_STATUS.evaluated) {
    return `已有评估结论，但演练状态仍为「${status}」，结论与状态互相顶牛`
  }
  if (status === EMERGENCY_STATUS.running && !hasConclusion && String(row.计划日期) < CUTOVER_DATE) {
    return '往期演练停留在「演练中」且无评估结论，超过切换日仍未闭环'
  }
  if (status === EMERGENCY_STATUS.legacyGap) {
    return '往期演练未留存评估结论（历史口径回补为待补评估），需人工补录真实结论后闭环'
  }
  return null
}

export function emergencySelfCheck(): IssueRow[] {
  const issues: IssueRow[] = []
  const live = loadEmergency()

  const codeCount = new Map<string, number>()
  for (const row of live) {
    const code = String(row.演练编号 ?? '')
    codeCount.set(code, (codeCount.get(code) ?? 0) + 1)
  }

  for (const row of live) {
    const code = String(row.演练编号 ?? '(无编号)')
    if ((codeCount.get(String(row.演练编号)) ?? 0) > 1) {
      issues.push({
        code: 'duplicate-code',
        演练编号: code,
        环节: '正式台账',
        缘由: `演练编号 ${code} 在正式台账中出现 ${codeCount.get(String(row.演练编号))} 次，违反“按演练编号判重”口径`,
      })
    }
    if (crewIssue(row)) {
      const reasons: string[] = []
      if (!String(row.参与班组 ?? '').trim()) {
        reasons.push('参与班组为空')
      }
      if (Number(row.参演人数) < MIN_CREW_SIZE) {
        reasons.push(`参演人数 ${Number(row.参演人数) || 0} 人，少于最低 ${MIN_CREW_SIZE} 人`)
      }
      issues.push({
        code: 'crew-short',
        演练编号: code,
        环节: '正式台账',
        缘由: `参与班组缺人：${reasons.join('；')}`,
      })
    }
    const conflict = conflictIssue(row)
    if (conflict) {
      issues.push({ code: 'status-conflict', 演练编号: code, 环节: '正式台账', 缘由: conflict })
    }
  }

  for (const row of listStaged(EMERGENCY_KEY)) {
    const code = String(row.演练编号 ?? '(无编号)')
    if (crewIssue(row)) {
      const reasons: string[] = []
      if (!String(row.参与班组 ?? '').trim()) {
        reasons.push('参与班组为空')
      }
      if (Number(row.参演人数) < MIN_CREW_SIZE) {
        reasons.push(`参演人数 ${Number(row.参演人数) || 0} 人，少于最低 ${MIN_CREW_SIZE} 人`)
      }
      issues.push({
        code: 'crew-short',
        演练编号: code,
        环节: '待确认暂存',
        缘由: `参与班组缺人：${reasons.join('；')}`,
      })
    }
    issues.push({
      code: 'status-conflict',
      演练编号: code,
      环节: '待确认暂存',
      缘由: `必填字段缺失，已整笔暂存待人工确认：${row.缺失字段.join('、')}`,
    })
  }

  return issues
}

// ---------------------------------------------------------------------------
// 概览/看板/待办：同一份存储、同一套计数，不允许两个入口出现两个数
// ---------------------------------------------------------------------------

export function listEmergencyTodos(): TodoRow[] {
  return loadTodos()
}

export function closeEmergencyTodo(todoId: number, role: string): { ok: boolean; message: string } {
  if (role !== EVALUATOR_ROLE) {
    return { ok: false, message: `越权操作被驳回：只有${EVALUATOR_ROLE}能闭环待办，当前岗位为「${role}」` }
  }
  const todos = loadTodos()
  const index = todos.findIndex((item) => Number(item.id) === Number(todoId))
  if (index < 0) {
    return { ok: false, message: '待办不存在' }
  }
  todos[index] = { ...todos[index], 状态: '已闭环' }
  saveTodos(todos)
  return { ok: true, message: '待办已闭环' }
}

export type EmergencyMetrics = {
  total: number
  byStatus: Record<string, number>
  pendingOrganize: number
  evaluated: number
  legacyGap: number
  monthCount: number
  issueCount: number
  issueByCode: Record<IssueRow['code'], number>
  stagedCount: number
  todoCount: number
  todoPending: number
  /** 已评估台账条数与待办条数必须一致。 */
  todoConsistent: boolean
  seedVersion: string
  seedHash: string
}

export function emergencyMetrics(): EmergencyMetrics {
  const rows = loadEmergency()
  const todos = loadTodos()
  const issues = emergencySelfCheck()
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const byStatus: Record<string, number> = {}
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  }
  const evaluated = rows.filter((row) => row.status === EMERGENCY_STATUS.evaluated).length
  const legacyGapCount = byStatus[EMERGENCY_STATUS.legacyGap] ?? 0
  /** 需要待办闭环的演练：已评估 + 往期待补评估，两边按这个口径对齐条数。 */
  const closable = evaluated + legacyGapCount
  const issueByCode = { 'duplicate-code': 0, 'crew-short': 0, 'status-conflict': 0 } as Record<
    IssueRow['code'],
    number
  >
  for (const issue of issues) {
    issueByCode[issue.code] += 1
  }
  return {
    total: rows.length,
    byStatus,
    pendingOrganize: byStatus[EMERGENCY_STATUS.pending] ?? 0,
    evaluated,
    legacyGap: legacyGapCount,
    monthCount: rows.filter((row) => String(row.计划日期).startsWith(month)).length,
    issueCount: issues.length,
    issueByCode,
    stagedCount: listStaged(EMERGENCY_KEY).length,
    todoCount: todos.length,
    todoPending: todos.filter((item) => item.状态 === '待处置').length,
    todoConsistent: todos.length === closable,
    seedVersion: SEED_VERSION,
    seedHash: emergencySeedHash(),
  }
}

/** 应急演练模块整链重置：清掉本模块全部落库数据后重跑（回到可复现的初始状态）。 */
export function resetEmergencyPipeline(): PipelineSummary {
  writeJSON(ENTRIES_KEY, { ...loadEntries(), [EMERGENCY_KEY]: [] })
  writeJSON(STAGED_KEY, { ...loadStaged(), [EMERGENCY_KEY]: [] })
  writeJSON(TODO_KEY, [])
  const ledger = loadLedger()
  delete ledger.migrations[LEGACY_BATCH_ID]
  delete ledger.migrations['demo-purge']
  ledger.seededCodes = []
  ledger.resolvedStagedIds = []
  writeJSON(LEDGER_KEY, ledger)
  return runEmergencyPipeline()
}

export { CUTOVER_DATE, DEDUP_FIELD, EVALUATOR_ROLE, MIN_CREW_SIZE }
