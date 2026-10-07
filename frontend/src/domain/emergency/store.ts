/**
 * 应急演练浏览器仓库：领域引擎 + localStorage 持久化。
 * 读的 seed.json 就是构建脚本 generate 落盘、verify 校验过的同一份文件，
 * 本地与线上加载到的样例/存量数据同源一致。
 */
import {
  advanceStatus,
  bootstrap,
  createEmptyState,
  runChecks,
  selectCounts,
  submitConclusion,
  todoMismatches,
  assertInvariants,
} from './engine'
import seedFileRaw from './seed.json'
import type {
  AdvanceInput,
  CommitResult,
  Counts,
  DrillRecord,
  DrillTodo,
  EmergencyState,
  Finding,
  Operator,
  PendingConfirm,
  SeedBundle,
} from './types'

const seedFile = seedFileRaw as unknown as {
  meta: { schemaVersion: number; seedRevision: number }
  bundle: SeedBundle
}

const STORAGE_KEY = 'urban-utility-tunnel:emergency:v2'
const SCHEMA_VERSION = seedFile.meta.schemaVersion
const SEED_REVISION = seedFile.meta.seedRevision

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function bundle(): SeedBundle {
  return clone(seedFile.bundle)
}

function nowIso(): string {
  // 只用于运行期操作时间，不影响确定性种子（种子里的时间是固定常量）。
  return new Date().toISOString()
}

function isUsableState(value: unknown): value is EmergencyState {
  if (!value || typeof value !== 'object') return false
  const state = value as EmergencyState
  return (
    state.schemaVersion === SCHEMA_VERSION &&
    state.seedRevision === SEED_REVISION &&
    Array.isArray(state.drills) &&
    Array.isArray(state.todos) &&
    Array.isArray(state.pendings) &&
    Array.isArray(state.ledger)
  )
}

/**
 * 应用启动时引导一次：旧库/空库都走 bootstrap，按演练编号补样例、按巡检日期续迁移。
 * 幂等且可续跑，每次打开页面执行都不会改动已有演练记录、不会冲掉评估结论。
 */
export function ensureBootstrapped(): EmergencyState {
  const persisted = readPersisted()
  if (persisted && persisted.bootstrapDone) {
    // 再跑一遍只做补缺与迁移账对齐（完全幂等），然后落盘。
    const state = bootstrap(persisted, bundle(), { now: persisted.bootstrappedAt || nowIso() })
    writePersisted(state)
    return state
  }
  const state = bootstrap(persisted, bundle(), {
    now: nowIso(),
    onCommit: (snapshot) => writePersisted(snapshot), // 每条存量一个落盘事务
  })
  writePersisted(state)
  return state
}

function readPersisted(): EmergencyState | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isUsableState(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function writePersisted(state: EmergencyState): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

let cache: EmergencyState | null = null

function current(): EmergencyState {
  if (!cache) {
    cache = ensureBootstrapped()
  }
  return cache
}

function commit(result: CommitResult): CommitResult {
  if (result.ok) {
    cache = result.state
    writePersisted(cache)
  }
  return result
}

export function emergencyState(): EmergencyState {
  return current()
}

export function listDrills(): DrillRecord[] {
  return current().drills
}

export function listTodos(): DrillTodo[] {
  return current().todos
}

export function listPendings(): PendingConfirm[] {
  return current().pendings
}

export function findDrill(code: string): DrillRecord | undefined {
  return current().drills.find((drill) => drill.code === code)
}

export function checkFindings(): Finding[] {
  return runChecks(current())
}

export function counts(): Counts {
  return selectCounts(current())
}

export function reconciliationMessages(): string[] {
  return [...assertInvariants(current())]
}

export function todoReconciliation(): string[] {
  return todoMismatches(current())
}

export function submitDrillConclusion(input: {
  code: string
  conclusion: string
  operator: Operator
  expectedVersion: number
}): CommitResult {
  return commit(
    submitConclusion(current(), {
      ...input,
      now: nowIso(),
    }),
  )
}

export function advanceDrill(input: {
  code: string
  action: AdvanceInput['action']
  operator: Operator
  expectedVersion: number
}): CommitResult {
  return commit(
    advanceStatus(current(), {
      ...input,
      now: nowIso(),
    }),
  )
}

/** 重置回「重新初始化」状态：清持久化后再引导。仅供调试入口调用。 */
export function rebootstrap(): EmergencyState {
  cache = null
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  return ensureBootstrapped()
}

export function emergencyStorageKey(): string {
  return STORAGE_KEY
}

/** 测试用：清掉内存缓存，模拟重新打开页面后从 localStorage 冷启动。 */
export function __resetMemoryCacheForTest(): void {
  cache = null
}

export { createEmptyState }
