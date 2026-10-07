/**
 * 应急演练页面服务：页面只通过这里读写，岗位把关、乐观锁、自检、待办回写
 * 全部落在领域引擎里。所有条数都来自 counts() 同一出口，页面不许自己数。
 */
import { computed, ref } from 'vue'

import {
  advanceDrill,
  checkFindings,
  counts,
  emergencyState,
  findDrill,
  listDrills,
  listPendings,
  listTodos,
  rebootstrap,
  reconciliationMessages,
  submitDrillConclusion,
} from '@/domain/emergency/store'
import type { CommitResult, DrillRecord, DrillTodo, Finding, Operator, PendingConfirm, Counts } from '@/domain/emergency/types'

// 单一可变数据源：任何提交成功后整体替换，computed 随之刷新，概览与看板同源。
const version = ref(0)

function bump(): void {
  version.value += 1
}

export function useEmergency() {
  const drills = computed<DrillRecord[]>(() => {
    void version.value
    return listDrills()
  })
  const todos = computed<DrillTodo[]>(() => {
    void version.value
    return listTodos()
  })
  const pendings = computed<PendingConfirm[]>(() => {
    void version.value
    return listPendings()
  })
  const findings = computed<Finding[]>(() => {
    void version.value
    return checkFindings()
  })
  const stats = computed<Counts>(() => {
    void version.value
    return counts()
  })
  const reconciliation = computed<string[]>(() => {
    void version.value
    return reconciliationMessages()
  })

  function drill(code: string): DrillRecord | undefined {
    void version.value
    return findDrill(code)
  }

  function evaluate(input: {
    code: string
    conclusion: string
    operator: Operator
    expectedVersion: number
  }): CommitResult {
    const result = submitDrillConclusion(input)
    bump()
    return result
  }

  function advance(input: {
    code: string
    action: '组织演练' | '取消演练'
    operator: Operator
    expectedVersion: number
  }): CommitResult {
    const result = advanceDrill(input)
    bump()
    return result
  }

  function resetAndRebootstrap() {
    rebootstrap()
    bump()
  }

  // 供概览页取数：同一个 state，同一份 selectCounts。
  function snapshot() {
    void version.value
    return emergencyState()
  }

  return {
    drills,
    todos,
    pendings,
    findings,
    stats,
    reconciliation,
    drill,
    evaluate,
    advance,
    resetAndRebootstrap,
    snapshot,
  }
}
