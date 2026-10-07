<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。应急演练看板与应急演练管理页共用同一份计数，不允许出现两个数。</p>
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
    </div>

    <h3 class="block-title">应急演练看板（与「应急演练管理」同源同数）</h3>
    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">演练总数</span>
        <strong class="stat-value">{{ emergencyStats.total }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待组织</span>
        <strong class="stat-value">{{ emergencyStats.byStatus['待组织'] }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">演练中</span>
        <strong class="stat-value">{{ emergencyStats.byStatus['演练中'] }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已评估</span>
        <strong class="stat-value">{{ emergencyStats.evaluated }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已取消</span>
        <strong class="stat-value">{{ emergencyStats.byStatus['已取消'] }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">处置待办（=有结论评估）</span>
        <strong class="stat-value">{{ emergencyStats.todos }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">自检问题</span>
        <strong class="stat-value" :class="{ 'warn-num': emergencyStats.findings > 0 }">{{ emergencyStats.findings }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">缺项待确认</span>
        <strong class="stat-value">{{ emergencyStats.pendings }}</strong>
      </article>
    </div>
    <p class="consistency" :class="reconciliation.length ? 'error-text' : 'ok-text'">
      <template v-if="!reconciliation.length">
        条数核对一致：处置待办 {{ emergencyStats.todos }} = 已评估有结论 {{ emergencyStats.concluded }}；自检 {{ emergencyStats.findings }} 条与应急演练管理页为同一函数计数。
      </template>
      <template v-else>
        <span v-for="(text, idx) in reconciliation" :key="idx">{{ text }}　</span>
      </template>
    </p>

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
      <span>其它模块数据保存在本机浏览器里；应急演练数据走独立的可重建链路（确定性种子 + 迁移账）</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { useEmergency } from '@/api/emergency-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])

const { stats: emergencyStats, reconciliation } = useEmergency()

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
}

onMounted(refresh)
</script>

<style scoped>
.block-title { margin: 18px 0 8px; font-size: 15px; }
.warn-num { color: #b42318; }
.ok-text { color: #067647; }
.error-text { color: #b42318; }
.consistency { font-size: 13px; margin: 0 0 14px; }
</style>
