<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>评估处置待办清单</h2>
        <p class="page-desc">
          应急演练的评估处置结论回写到本入口。条数与演练页“待办清单条数”同源同数：
          共 {{ todos.length }} 条，其中待处置 {{ pending }} 条；
          正式台账已评估 {{ metrics.evaluated }} 条，{{ consistent ? '两边一致' : '两边不一致！' }}
        </p>
      </div>
      <div class="page-actions">
        <label class="role-switch">
          当前岗位
          <select :value="store.role" @change="store.setRole(($event.target as HTMLSelectElement).value as Role)">
            <option v-for="item in store.roles" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card" :class="{ warn: !consistent }">
        <span class="stat-label">待办总条数（与演练页一致）</span>
        <strong class="stat-value">{{ todos.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待处置</span>
        <strong class="stat-value">{{ pending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已闭环</span>
        <strong class="stat-value">{{ closed }}</strong>
      </article>
      <article class="stat-card" :class="{ warn: !consistent }">
        <span class="stat-label">台账已评估条数</span>
        <strong class="stat-value">{{ metrics.evaluated }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr><th>来源</th><th>关联演练编号</th><th>待办事项</th><th>处置结论</th><th>计划日期</th><th>状态</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="String(todo.id)">
          <td>{{ todo.来源 }}</td>
          <td>{{ todo.关联编号 }}</td>
          <td>{{ todo.待办事项 }}</td>
          <td>{{ todo.处置结论 }}</td>
          <td>{{ todo.计划日期 }}</td>
          <td>{{ todo.状态 }}</td>
          <td class="row-actions">
            <button
              v-if="todo.状态 === '待处置' && store.canEvaluate"
              class="link"
              type="button"
              @click="close(todo)"
            >
              闭环
            </button>
            <span v-else-if="todo.状态 === '待处置'" class="readonly-hint">只读（仅组织人员）</span>
          </td>
        </tr>
        <tr v-if="!todos.length">
          <td colspan="7" class="empty-state">暂无待办</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  bootstrapEmergency,
  emergencyCloseTodo,
  emergencyMetrics,
  emergencyTodos,
} from '@/api/local-service'
import type { EmergencyMetrics } from '@/data/emergency/pipeline'
import type { Role, TodoRow } from '@/data/emergency/constants'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const todos = ref<TodoRow[]>([])
const metrics = ref<EmergencyMetrics>(emergencyMetrics())
const errorMessage = ref('')

const pending = computed(() => todos.value.filter((item) => item.状态 === '待处置').length)
const closed = computed(() => todos.value.length - pending.value)
const consistent = computed(() => metrics.value.todoConsistent)

function close(todo: TodoRow) {
  const result = emergencyCloseTodo(Number(todo.id), store.role)
  errorMessage.value = result.ok ? '' : result.message
  bootstrapEmergency()
  todos.value = emergencyTodos()
  metrics.value = emergencyMetrics()
}

onMounted(() => {
  bootstrapEmergency()
  todos.value = emergencyTodos()
  metrics.value = emergencyMetrics()
})
</script>

<style scoped>
.role-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.readonly-hint {
  color: #999;
  font-size: 12px;
}
.stat-card.warn .stat-value {
  color: #cf1322;
}
</style>
