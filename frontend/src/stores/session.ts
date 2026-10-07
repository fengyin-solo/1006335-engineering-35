import { defineStore } from 'pinia'

import { EVALUATOR_ROLE, ROLES, type Role } from '@/data/emergency/constants'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
    role: EVALUATOR_ROLE as Role,
    roles: ROLES as readonly Role[],
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    /** 只有组织人员能落评估结论、变更演练台账、确认暂存与闭环待办。 */
    canEvaluate: (state) => state.role === EVALUATOR_ROLE,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
    },
  },
})
