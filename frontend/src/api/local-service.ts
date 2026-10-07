import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, invalidateCache } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  EMERGENCY_KEY,
  EMERGENCY_STATUS,
  EVALUATOR_ROLE,
} from '@/data/emergency/constants'
import {
  closeEmergencyTodo,
  confirmStagedLegacy,
  discardStagedLegacy,
  emergencyMetrics,
  emergencySelfCheck,
  listEmergencyTodos,
  listStaged,
  resetEmergencyPipeline,
  runEmergencyPipeline,
  submitEvaluation,
  supplementEvaluation,
  transitionEmergency,
} from '@/data/emergency/pipeline'
export type { EmergencyMetrics } from '@/data/emergency/pipeline'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  role = '',
  payload: { conclusion?: string; expectedVersion?: number } = {},
): ActionResult {
  // 应急演练不走通用状态流转：岗位把关、乐观锁并发、待办回写都在链路里。
  if (key === EMERGENCY_KEY) {
    return runEmergencyAction(id, action, role, payload)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runEmergencyAction(
  id: number,
  action: string,
  role: string,
  payload: { conclusion?: string; expectedVersion?: number },
): ActionResult {
  if (action === '提交评估') {
    if (role !== EVALUATOR_ROLE) {
      return {
        ok: false,
        message: `越权提交被驳回：只有${EVALUATOR_ROLE}能落评估结论，当前岗位为「${role}」（只读）`,
      }
    }
    return submitEvaluation({
      id,
      role,
      conclusion: payload.conclusion ?? '',
      expectedVersion: Number(payload.expectedVersion ?? 1),
    })
  }
  // 组织演练、取消演练属于台账变更，同样只开放给组织人员，其余岗位只读。
  if (role !== EVALUATOR_ROLE) {
    return {
      ok: false,
      message: `越权操作被驳回：应急演练台账变更仅${EVALUATOR_ROLE}可执行，当前岗位为「${role}」（只读）`,
    }
  }
  const target =
    action === '组织演练'
      ? EMERGENCY_STATUS.running
      : action === '取消演练'
        ? EMERGENCY_STATUS.cancelled
        : ''
  if (!target) {
    return { ok: false, message: `应急演练没有登记「${action}」这个动作` }
  }
  return transitionEmergency(id, target)
}

export function resetModule(key: string): PageResult {
  if (key === EMERGENCY_KEY) {
    resetEmergencyPipeline()
    invalidateCache()
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

// ---------------------------------------------------------------------------
// 应急演练链路对外 API
// ---------------------------------------------------------------------------

export function bootstrapEmergency() {
  const summary = runEmergencyPipeline()
  invalidateCache()
  return summary
}

export function emergencyOverview() {
  return emergencyMetrics()
}

export { emergencyMetrics }

export function emergencyIssues() {
  return emergencySelfCheck()
}

export function emergencyStaged() {
  return listStaged(EMERGENCY_KEY)
}

export function emergencyTodos() {
  return listEmergencyTodos()
}

export function emergencyCloseTodo(id: number, role: string): ActionResult {
  const result = closeEmergencyTodo(id, role)
  return result
}

export function emergencyConfirmStaged(
  id: number,
  role: string,
  patch: Record<string, string | number>,
): ActionResult {
  const result = confirmStagedLegacy(id, role, patch)
  if (result.ok) {
    invalidateCache()
  }
  return result
}

export function emergencyDiscardStaged(id: number, role: string): ActionResult {
  const result = discardStagedLegacy(id, role)
  if (result.ok) {
    invalidateCache()
  }
  return result
}

export function emergencySupplement(
  id: number,
  role: string,
  conclusion: string,
  expectedVersion: number,
): ActionResult {
  const result = supplementEvaluation({ id, role, conclusion, expectedVersion })
  if (result.ok) {
    invalidateCache()
  }
  return result
}

export function emergencyRecordVersion(row: EntryRow): number {
  return Number(row.v ?? 1)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  // 应急演练链路绕过内存缓存直接落库，读概览前先失效一次，
  // 保证概览与演练页看板永远来自同一份落库数据，不会出现两个数。
  invalidateCache()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
