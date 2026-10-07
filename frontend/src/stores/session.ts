import { defineStore } from 'pinia'

import type { Operator, Role } from '@/domain/emergency/types'

const ROLES: Role[] = ['组织人员', '参演班组', '观摩人员']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '周建国' as string,
    /** 当前岗位：只有「组织人员」能落应急演练评估结论，其余只读。 */
    role: '组织人员' as Role,
    roles: ROLES,
    shiftLabel: '白班 08:00-20:00',
    scope: '城市地下综合管廊运行维护管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    canEvaluate: (state) => state.role === '组织人员',
    operatorProfile(state): Operator {
      return { name: state.operator || '未署名', role: state.role }
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: Role) {
      this.role = role
    },
    setOperator(name: string) {
      this.operator = name
    },
  },
})
