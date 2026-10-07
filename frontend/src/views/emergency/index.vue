<template>
  <section class="page" data-module="emergency">
    <header class="page-head">
      <div>
        <h2>应急演练管理</h2>
        <p class="page-desc">初始化按演练编号稳定生成、存量按计划日期迁移；评估结论仅组织人员可落，处置结论回写待办，收尾自检逐条给缘由。</p>
      </div>
      <div class="page-actions">
        <label class="role-switch">
          当前岗位
          <select :value="store.role" @change="onRoleChange(($event.target as HTMLSelectElement).value)">
            <option v-for="item in store.roles" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="exportRows">导出应急演练清单</button>
      </div>
    </header>

    <p class="pipeline-banner" :class="{ ok: metrics.todoConsistent, bad: !metrics.todoConsistent }">
      数据集版本 {{ metrics.seedVersion }} · 指纹 {{ metrics.seedHash }}（本地与线上落库须一致）
      <span v-if="metrics.todoConsistent">；已评估台账 {{ metrics.evaluated }} 条 = 待办清单 {{ metrics.todoCount }} 条，两边一致</span>
      <span v-else>；已评估台账 {{ metrics.evaluated }} 条 ≠ 待办清单 {{ metrics.todoCount }} 条，条数对不上！</span>
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="{ warn: item.warn }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>版本</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] === undefined ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td>v{{ row.v ?? 1 }}</td>
          <td class="row-actions">
            <template v-if="canEvaluate">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <button
                v-if="row.status === '待补评估'"
                class="link"
                type="button"
                @click="openSupplement(row)"
              >
                补录结论
              </button>
            </template>
            <span v-else class="readonly-hint">只读（仅{{ evaluatorRole }}可操作）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无应急演练记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="issues.length" class="issue-panel">
      <h3>收尾自检（{{ issues.length }} 条，与上方看板“自检问题数”同源）</h3>
      <table class="data-table">
        <thead>
          <tr><th>问题类型</th><th>演练编号</th><th>环节</th><th>缘由</th></tr>
        </thead>
        <tbody>
          <tr v-for="(issue, idx) in issues" :key="idx">
            <td>{{ issueTypeLabel(issue.code) }}</td>
            <td>{{ issue.演练编号 }}</td>
            <td>{{ issue.环节 }}</td>
            <td>{{ issue.缘由 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="staged.length" class="issue-panel">
      <h3>存量迁移缺失项（{{ staged.length }} 笔，整笔暂存待人工确认，未进正式台账）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>演练编号</th><th>演练场景</th><th>参与班组</th><th>参演人数</th>
            <th>计划日期</th><th>组织人员</th><th>缺失字段</th><th>人工处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in staged" :key="String(item.id)">
            <td><input v-model="stagedEdits[item.id].演练编号" class="inline-input" /></td>
            <td>{{ item.演练场景 }}</td>
            <td><input v-model="stagedEdits[item.id].参与班组" class="inline-input" /></td>
            <td><input v-model.number="stagedEdits[item.id].参演人数" class="inline-input small" type="number" min="0" /></td>
            <td><input v-model="stagedEdits[item.id].计划日期" class="inline-input" type="date" /></td>
            <td>{{ item.组织人员 }}</td>
            <td>{{ item.缺失字段.join('、') || '（已补齐）' }}</td>
            <td class="row-actions">
              <button v-if="canEvaluate" class="link" type="button" @click="confirmStaged(item)">确认落库</button>
              <button v-if="canEvaluate" class="link danger" type="button" @click="dropStaged(item)">放弃该笔</button>
              <span v-else class="readonly-hint">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="issue-panel">
      <h3>待办清单入口（评估处置结论回写，共 {{ todos.length }} 条，待处置 {{ todoPending }} 条）</h3>
      <table class="data-table">
        <thead>
          <tr><th>关联演练</th><th>待办事项</th><th>处置结论</th><th>计划日期</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="String(todo.id)">
            <td>{{ todo.关联编号 }}</td>
            <td>{{ todo.待办事项 }}</td>
            <td>{{ todo.处置结论 }}</td>
            <td>{{ todo.计划日期 }}</td>
            <td>{{ todo.状态 }}</td>
            <td class="row-actions">
              <button
                v-if="todo.状态 === '待处置' && canEvaluate"
                class="link"
                type="button"
                @click="closeTodo(todo)"
              >
                闭环
              </button>
              <span v-else-if="todo.状态 === '待处置'" class="readonly-hint">只读</span>
            </td>
          </tr>
          <tr v-if="!todos.length">
            <td colspan="6" class="empty-state">暂无待办</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="evaluate.open" class="modal-mask" @click.self="evaluate.open = false">
      <form class="modal-card" @submit.prevent="submitEvaluate">
        <h3>提交评估结论 · {{ evaluate.code }}（{{ evaluate.mode === 'supplement' ? '补录往期结论' : '演练评估' }}）</h3>
        <p class="modal-hint">
          岗位：{{ store.role }}；记录版本 v{{ evaluate.version }}。
          同一时刻并发提交时只有先到的入账，后到的将按版本冲突整笔回退。
        </p>
        <textarea v-model="evaluate.conclusion" rows="4" placeholder="请填写评估结论（组织人员填写后落档，结论不可覆盖）"></textarea>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认提交</button>
          <button class="btn ghost" type="button" @click="evaluate.open = false">取消</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条应急演练记录（正式台账）；判重字段：{{ dedupField }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  bootstrapEmergency,
  downloadEntries,
  emergencyCloseTodo,
  emergencyConfirmStaged,
  emergencyDiscardStaged,
  emergencyIssues,
  emergencyMetrics,
  emergencyStaged,
  emergencySupplement,
  emergencyTodos,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { IssueRow, Role, StagedLegacyRow, TodoRow } from '@/data/emergency/constants'
import { DEDUP_FIELD, EVALUATOR_ROLE } from '@/data/emergency/constants'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()
const meta = moduleMeta('emergency')
const columns = ['演练编号', '演练场景', '参与班组', '参演人数', '计划日期', '演练时长', '评估结论', '组织人员']
const dedupField = DEDUP_FIELD
const evaluatorRole = EVALUATOR_ROLE
const statuses = ['待组织', '演练中', '已评估', '待补评估', '已取消']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['演练编号', '演练场景', '参与班组']

const issues = ref<IssueRow[]>([])
const staged = ref<StagedLegacyRow[]>([])
const todos = ref<TodoRow[]>([])
const metrics = ref(emergencyMetrics())

const stagedEdits = reactive<Record<number, Record<string, string | number>>>({})

const evaluate = reactive({
  open: false,
  mode: 'evaluate' as 'evaluate' | 'supplement',
  id: 0,
  code: '',
  version: 1,
  conclusion: '',
})

const canEvaluate = computed(() => store.canEvaluate)
const todoPending = computed(() => todos.value.filter((item) => item.状态 === '待处置').length)

const stats = computed(() => [
  { label: '待组织演练', value: metrics.value.pendingOrganize, warn: false },
  { label: '已评估演练', value: metrics.value.evaluated, warn: false },
  { label: '本月演练次数', value: metrics.value.monthCount, warn: false },
  { label: '待补评估（往期）', value: metrics.value.legacyGap, warn: metrics.value.legacyGap > 0 },
  { label: '待办清单条数', value: metrics.value.todoCount, warn: !metrics.value.todoConsistent },
  { label: '自检问题数', value: metrics.value.issueCount, warn: metrics.value.issueCount > 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: metrics.value.byStatus[status] ?? 0,
  })),
)

function issueTypeLabel(code: IssueRow['code']): string {
  if (code === 'duplicate-code') {
    return '演练编号撞车'
  }
  if (code === 'crew-short') {
    return '参与班组缺人'
  }
  return '结论与状态顶牛'
}

function actionsFor(row: EntryRow): string[] {
  if (row.status === '待组织') {
    return ['组织演练', '取消演练']
  }
  if (row.status === '演练中') {
    return ['提交评估', '取消演练']
  }
  return []
}

function onRoleChange(role: string) {
  store.setRole(role as Role)
  errorMessage.value = role === EVALUATOR_ROLE ? '' : '已切换到只读岗位：评估提交等写操作将被整笔驳回'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '提交评估') {
    evaluate.mode = 'evaluate'
    evaluate.id = Number(row.id)
    evaluate.code = String(row.演练编号)
    evaluate.version = Number(row.v ?? 1)
    evaluate.conclusion = ''
    evaluate.open = true
    return
  }
  const result = applyAction(meta.key, Number(row.id), action, store.role)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshAll()
}

function openSupplement(row: EntryRow) {
  evaluate.mode = 'supplement'
  evaluate.id = Number(row.id)
  evaluate.code = String(row.演练编号)
  evaluate.version = Number(row.v ?? 1)
  evaluate.conclusion = ''
  evaluate.open = true
}

function submitEvaluate() {
  if (evaluate.mode === 'supplement') {
    const result = emergencySupplement(evaluate.id, store.role, evaluate.conclusion, evaluate.version)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
  } else {
    const result = applyAction(meta.key, evaluate.id, '提交评估', store.role, {
      conclusion: evaluate.conclusion,
      expectedVersion: evaluate.version,
    })
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
  }
  evaluate.open = false
  errorMessage.value = ''
  refreshAll()
}

function confirmStaged(item: StagedLegacyRow) {
  const patch = stagedEdits[item.id] ?? {}
  const result = emergencyConfirmStaged(Number(item.id), store.role, patch)
  errorMessage.value = result.ok ? '' : result.message
  refreshAll()
}

function dropStaged(item: StagedLegacyRow) {
  const result = emergencyDiscardStaged(Number(item.id), store.role)
  errorMessage.value = result.ok ? '' : result.message
  refreshAll()
}

function closeTodo(todo: TodoRow) {
  const result = emergencyCloseTodo(Number(todo.id), store.role)
  errorMessage.value = result.ok ? '' : result.message
  refreshAll()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '应急演练列表读取失败'
  }
}

function refreshAll() {
  bootstrapEmergency()
  metrics.value = emergencyMetrics()
  issues.value = emergencyIssues()
  staged.value = emergencyStaged()
  todos.value = emergencyTodos()
  for (const item of staged.value) {
    if (!stagedEdits[item.id]) {
      stagedEdits[item.id] = {
        演练编号: item.演练编号,
        参与班组: item.参与班组,
        参演人数: item.参演人数,
        计划日期: item.计划日期,
      }
    }
  }
  reload()
}

onMounted(refreshAll)
</script>

<style scoped>
.role-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.role-switch select {
  padding: 4px 8px;
}
.pipeline-banner {
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
  background: #f0f7ff;
  border: 1px solid #c7def7;
}
.pipeline-banner.bad {
  background: #fff1f0;
  border-color: #ffa39e;
}
.issue-panel {
  margin-top: 20px;
}
.issue-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.readonly-hint {
  color: #999;
  font-size: 12px;
}
.inline-input {
  width: 110px;
  padding: 2px 6px;
}
.inline-input.small {
  width: 70px;
}
.danger {
  color: #cf1322;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-card {
  width: 480px;
  background: #fff;
  border-radius: 6px;
  padding: 20px;
}
.modal-card h3 {
  margin: 0 0 8px;
}
.modal-hint {
  font-size: 12px;
  color: #666;
  margin: 0 0 10px;
}
.modal-card textarea {
  width: 100%;
  padding: 8px;
  resize: vertical;
}
.modal-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.stat-card.warn .stat-value {
  color: #cf1322;
}
</style>
