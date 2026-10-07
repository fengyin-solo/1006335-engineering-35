<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
      <article class="stat-card" :class="{ warn: emergency.issueCount > 0 }">
        <span class="stat-label">演练自检问题（与演练页同源）</span>
        <strong class="stat-value">{{ emergency.issueCount }}</strong>
      </article>
      <article class="stat-card" :class="{ warn: !emergency.todoConsistent }">
        <span class="stat-label">演练评估待办（已评估/待办）</span>
        <strong class="stat-value">{{ emergency.evaluated }}/{{ emergency.todoCount }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { bootstrapEmergency, emergencyOverview, loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'
import type { EmergencyMetrics } from '@/data/emergency/pipeline'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const emergency = ref<EmergencyMetrics>(emergencyOverview())

function refresh() {
  // 先跑幂等初始化链路，再从同一份落库数据取数：概览和演练看板永远一个数。
  bootstrapEmergency()
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  emergency.value = emergencyOverview()
}

onMounted(refresh)
</script>

<style scoped>
.stat-card.warn .stat-value {
  color: #cf1322;
}
</style>
