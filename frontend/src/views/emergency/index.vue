<template>
  <section class="page" data-module="emergency">
    <header class="page-head">
      <div>
        <h2>应急演练管理</h2>
        <p class="page-desc">
          样例按演练编号确定性生成，存量按巡检日期迁移；只有组织人员能落评估结论，
          结论同时回写处置待办，自检条数与本页、概览同源。
        </p>
      </div>
      <div class="page-actions">
        <label class="role-pick">
          当前岗位
          <select :value="store.role" @change="onRoleChange">
            <option v-for="role in store.roles" :key="role" :value="role">{{ role }}</option>
          </select>
        </label>
        <button class="btn ghost" type="button" @click="rebuild">重新初始化（幂等）</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">演练总数</span>
        <strong class="stat-value">{{ stats.total }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待组织 / 演练中</span>
        <strong class="stat-value">{{ stats.byStatus['待组织'] }} / {{ stats.byStatus['演练中'] }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已评估（有结论）</span>
        <strong class="stat-value">{{ stats.evaluated }}（{{ stats.concluded }}）</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">处置待办（另一入口）</span>
        <strong class="stat-value">{{ stats.todos }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">自检问题</span>
        <strong class="stat-value" :class="{ 'warn-num': stats.findings > 0 }">{{ stats.findings }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">缺项待确认</span>
        <strong class="stat-value">{{ stats.pendings }}</strong>
      </article>
    </div>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span v-if="tab.badge !== null" class="tab-badge">{{ tab.badge }}</span>
      </button>
    </nav>

    <p v-if="message" class="page-message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</p>

    <!-- 演练台账 -->
    <div v-show="activeTab === 'drills'">
      <form class="filter-bar" @submit.prevent>
        <label class="filter-item">
          <span>演练编号 / 场景</span>
          <input v-model="keyword" placeholder="按演练编号或场景检索" />
        </label>
        <label class="filter-item">
          <span>状态</span>
          <select v-model="statusFilter">
            <option value="">全部</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>演练编号</th>
            <th>演练场景</th>
            <th>参与班组</th>
            <th>计划日期（存量=巡检日期）</th>
            <th>时长(分)</th>
            <th>组织人员</th>
            <th>评估结论</th>
            <th>来源</th>
            <th>当前状态</th>
            <th>操作（{{ store.role }}）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredDrills" :key="`${row.code}-${row.id}`">
            <td>{{ row.code }}</td>
            <td>{{ row.scene }}</td>
            <td>{{ row.crew.join('、') || '—' }}</td>
            <td>{{ row.plannedDate }}</td>
            <td>{{ row.durationMinutes }}</td>
            <td>{{ row.organizer || '—' }}</td>
            <td class="conclusion-cell">{{ row.conclusion || '—' }}</td>
            <td>{{ row.source === 'sample' ? '样例' : '存量迁移' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-if="row.status === '待组织'"
                class="link"
                type="button"
                @click="advance(row, '组织演练')"
              >组织演练</button>
              <button
                v-if="row.status === '演练中'"
                class="link"
                type="button"
                @click="openEvaluate(row)"
              >提交评估</button>
              <button
                v-if="row.status === '待组织' || row.status === '演练中'"
                class="link danger"
                type="button"
                @click="advance(row, '取消演练')"
              >取消演练</button>
              <span v-if="row.status === '已评估' || row.status === '已取消'" class="muted-text">只读</span>
            </td>
          </tr>
          <tr v-if="!filteredDrills.length">
            <td :colspan="10" class="empty-state">没有符合条件的演练记录</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>台账共 {{ filteredDrills.length }} 条（全量 {{ stats.total }} 条）</span>
        <span>待组织 {{ stats.byStatus['待组织'] }} · 演练中 {{ stats.byStatus['演练中'] }} · 已评估 {{ stats.byStatus['已评估'] }} · 已取消 {{ stats.byStatus['已取消'] }}</span>
      </footer>
    </div>

    <!-- 处置待办（另一个入口） -->
    <div v-show="activeTab === 'todos'">
      <table class="data-table">
        <thead>
          <tr><th>序号</th><th>演练编号</th><th>处置结论（回写自评估结论）</th><th>组织人员</th><th>回写时间</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.id">
            <td>{{ todo.id }}</td>
            <td>{{ todo.drillCode }}</td>
            <td>{{ todo.summary }}</td>
            <td>{{ todo.organizer }}</td>
            <td>{{ formatTime(todo.createdAt) }}</td>
            <td>{{ todo.status }}</td>
          </tr>
          <tr v-if="!todos.length">
            <td :colspan="6" class="empty-state">暂无处置待办</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>待办 {{ stats.todos }} 条，已评估有结论演练 {{ stats.concluded }} 条（两边必须相等）</span>
        <span v-if="stats.todos === stats.concluded" class="ok-text">条数一致 ✓</span>
      </footer>
    </div>

    <!-- 缺项待确认 -->
    <div v-show="activeTab === 'pendings'">
      <table class="data-table">
        <thead>
          <tr><th>旧编号</th><th>巡检日期</th><th>缺失项</th><th>缘由</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in pendings" :key="item.id">
            <td>{{ item.legacyCode }}</td>
            <td>{{ item.inspectDate || '—' }}</td>
            <td>{{ item.missingFields.join('、') }}</td>
            <td>{{ item.reason }}</td>
          </tr>
          <tr v-if="!pendings.length">
            <td :colspan="4" class="empty-state">没有待人工确认的缺失项</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>缺失项 {{ stats.pendings }} 条，逐条列出等人工确认，初始化不臆造</span>
      </footer>
    </div>

    <!-- 收尾自检 -->
    <div v-show="activeTab === 'checks'">
      <table class="data-table">
        <thead>
          <tr><th>类别</th><th>演练编号</th><th>缘由</th></tr>
        </thead>
        <tbody>
          <tr v-for="(finding, idx) in findings" :key="`${finding.kind}-${finding.drillCode}-${idx}`">
            <td><span class="finding-tag" :class="findingClass(finding.kind)">{{ finding.kind }}</span></td>
            <td>{{ finding.drillCode }}</td>
            <td>{{ finding.reason }}</td>
          </tr>
          <tr v-if="!findings.length">
            <td :colspan="3" class="empty-state">自检通过，没有撞车、缺人或结论顶牛记录</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>核对出 {{ findings.length }} 条，与上方「自检问题」卡片、运营概览为同一个数</span>
        <span v-if="!reconciliation.length" class="ok-text">待办对账通过 ✓</span>
      </footer>
      <ul v-if="reconciliation.length" class="reconcile-list">
        <li v-for="(text, idx) in reconciliation" :key="idx" class="error-text">{{ text }}</li>
      </ul>
    </div>

    <!-- 提交评估对话框 -->
    <div v-if="evaluating" class="modal-mask" @click.self="closeEvaluate">
      <form class="modal" @submit.prevent="confirmEvaluate">
        <h3>提交评估结论 · {{ evaluating.code }}</h3>
        <p class="muted-text">
          演练：{{ evaluating.scene }}　班组：{{ evaluating.crew.join('、') || '—' }}<br />
          提交岗位：{{ store.role }}（只有组织人员可提交，其他人提交会被驳回）
        </p>
        <textarea v-model="draftConclusion" rows="4" placeholder="请填写评估结论"></textarea>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="closeEvaluate">取消</button>
          <button class="btn primary" type="submit">提交并回写处置待办</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { useEmergency } from '@/api/emergency-service'
import { useSessionStore } from '@/stores/session'
import type { DrillRecord, FindingKind } from '@/domain/emergency/types'

const store = useSessionStore()
const {
  drills,
  todos,
  pendings,
  findings,
  stats,
  reconciliation,
  evaluate,
  advance: advanceDrillAction,
  resetAndRebootstrap,
} = useEmergency()

const statuses = ['待组织', '演练中', '已评估', '已取消']
const activeTab = ref<'drills' | 'todos' | 'pendings' | 'checks'>('drills')
const keyword = ref('')
const statusFilter = ref('')
const message = ref('')
const messageOk = ref(false)
const evaluating = ref<DrillRecord | null>(null)
const draftConclusion = ref('')

const tabs = computed(() => [
  { key: 'drills' as const, label: '演练台账', badge: null },
  { key: 'todos' as const, label: '处置待办', badge: stats.value.todos },
  { key: 'pendings' as const, label: '缺项确认', badge: stats.value.pendings },
  { key: 'checks' as const, label: '收尾自检', badge: stats.value.findings },
])

const filteredDrills = computed(() => {
  const kw = keyword.value.trim()
  return drills.value.filter((row) => {
    if (statusFilter.value && row.status !== statusFilter.value) return false
    if (!kw) return true
    return row.code.includes(kw) || row.scene.includes(kw) || row.organizer.includes(kw)
  })
})

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function onRoleChange(event: Event) {
  store.setRole((event.target as HTMLSelectElement).value as typeof store.role)
}

function advance(row: DrillRecord, action: '组织演练' | '取消演练') {
  const result = advanceDrillAction({
    code: row.code,
    action,
    operator: store.operatorProfile,
    expectedVersion: row.version,
  })
  notify(result.ok, result.message)
}

function openEvaluate(row: DrillRecord) {
  evaluating.value = row
  draftConclusion.value = ''
}

function closeEvaluate() {
  evaluating.value = null
}

function confirmEvaluate() {
  if (!evaluating.value) return
  const result = evaluate({
    code: evaluating.value.code,
    conclusion: draftConclusion.value,
    operator: store.operatorProfile,
    expectedVersion: evaluating.value.version,
  })
  notify(result.ok, result.message)
  if (result.ok) closeEvaluate()
}

function rebuild() {
  resetAndRebootstrap()
  notify(true, '已重新执行初始化：样例按编号补齐、存量按巡检日期续迁移，已有演练记录与结论未改动')
}

function findingClass(kind: FindingKind): string {
  if (kind === '演练编号撞车') return 'tag-collision'
  if (kind === '参与班组缺人') return 'tag-crew'
  return 'tag-conflict'
}

function formatTime(value: string): string {
  if (!value) return '—'
  return value.replace('T', ' ').replace(/\+.*$/, '')
}
</script>

<style scoped>
.page-actions { display: flex; gap: 10px; align-items: center; }
.role-pick { font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 2px; }
.role-pick select { padding: 4px 8px; }
.warn-num { color: #b42318; }
.muted-text { color: var(--muted); font-size: 12px; }
.tab-bar { display: flex; gap: 6px; margin: 8px 0 12px; }
.tab-btn { border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 8px 14px; cursor: pointer; font-size: 13px; }
.tab-btn.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.tab-badge { display: inline-block; margin-left: 6px; background: rgba(0, 0, 0, 0.08); border-radius: 999px; padding: 0 8px; font-size: 12px; }
.tab-btn.active .tab-badge { background: rgba(255, 255, 255, 0.25); }
.page-message { font-size: 13px; }
.ok-text { color: #067647; }
.conclusion-cell { max-width: 260px; }
.danger { color: #b42318; }
.finding-tag { border-radius: 4px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
.tag-collision { background: #fef3c7; color: #92400e; }
.tag-crew { background: #fee4e2; color: #b42318; }
.tag-conflict { background: #e0e7ff; color: #3730a3; }
.reconcile-list { margin: 8px 0; padding-left: 18px; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: center; justify-content: center; z-index: 20; }
.modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: 520px; }
.modal h3 { margin: 0 0 8px; }
.modal textarea { width: 100%; margin-top: 10px; padding: 8px; font: inherit; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
