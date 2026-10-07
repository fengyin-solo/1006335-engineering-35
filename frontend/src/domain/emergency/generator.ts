/**
 * 确定性样例生成器：同样例编号 -> 同样例内容。
 * 不读环境变量、不读系统时间、不用 Math.random，所有字段都由演练编号的
 * FNV-1a 哈希取模得到。本地重建与线上构建执行同一份代码，产物逐字节一致。
 */
import {
  CUTOVER_DATE,
  EVALUATION_CONCLUSIONS,
  GENERATED_AT,
  KNOWN_CREWS,
  ORGANIZERS,
  SCHEMA_VERSION,
  SCENES,
  SEED_REVISION,
} from './policy'
import type { DrillRecord, LegacyRow, SeedBundle } from './types'

/** 32 位 FNV-1a：纯函数字符串哈希，同输入永远同输出。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // 32 位无符号乘法
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function pick<T>(items: T[], seed: number, salt: string): T {
  return items[fnv1a(`${salt}:${seed}`) % items.length]
}

function pad4(n: number): string {
  return String(n).padStart(4, '0')
}

/**
 * 样例计划日期：编号顺序落在 2024-01 至 2026-09 的固定日期网格上，
 * 演练时长与计划日期都由编号决定，重建不会对不上。
 */
function plannedDateFor(seq: number): string {
  const year = 2024 + Math.floor((seq - 1) / 5)
  const month = ((seq - 1) * 2) % 12 + 1
  const day = 5 + ((seq - 1) * 7) % 20
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function statusFor(seq: number, date: string): DrillRecord['status'] {
  // 未来计划（2026-09 之后）一律待组织；历史样例按编号稳定落到各状态。
  if (date >= '2026-09-01') return seq % 2 === 0 ? '演练中' : '待组织'
  const bucket = seq % 4
  if (bucket === 0) return '已取消'
  return '已评估'
}

export function buildSample(seq: number): DrillRecord {
  const code = `EMER-${pad4(seq)}`
  const hash = fnv1a(code)
  const plannedDate = plannedDateFor(seq)
  const status = statusFor(seq, plannedDate)
  // 参与班组：哈希决定 1~2 个花名册内班组
  const firstCrew = KNOWN_CREWS[hash % KNOWN_CREWS.length]
  const secondCrew = KNOWN_CREWS[(hash >>> 4) % KNOWN_CREWS.length]
  const crew = secondCrew === firstCrew ? [firstCrew] : [firstCrew, secondCrew]
  const durationMinutes = 45 + (hash % 8) * 15 // 45~150 分钟，15 分钟一档

  const evaluated = status === '已评估'
  return {
    id: seq,
    code,
    scene: pick(SCENES, seq, 'scene'),
    crew,
    plannedDate,
    durationMinutes,
    conclusion: evaluated ? pick(EVALUATION_CONCLUSIONS, seq, 'conclusion') : '',
    organizer: evaluated ? pick(ORGANIZERS, seq, 'organizer') : pick(ORGANIZERS, seq, 'organizer'),
    status,
    source: 'sample',
    version: 1,
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
  }
}

export function buildSamples(count = 12): DrillRecord[] {
  return Array.from({ length: count }, (_, i) => buildSample(i + 1))
}

/**
 * 存量台账示例行：字段名沿用旧系统，刻意覆盖各种迁移情形
 * （撞车、缺人、缺字段、结论顶牛、切换日前后）。每行都带旧编号便于人工对账。
 */
export function buildLegacyRows(): LegacyRow[] {
  return [
    {
      legacyCode: 'OLD-2023-001',
      inspectDate: '2023-04-18',
      scene: '燃气舱泄漏拉动演练',
      crew: '消防抢险班、通风排水班',
      durationMinutes: 90,
      conclusion: '旧台账结论：处置得当，资料归档',
      organizer: '周建国',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2023-002',
      inspectDate: '2023-06-22',
      scene: '雨水倒灌抽排演练',
      crew: '综合机电甲班',
      durationMinutes: 75,
      // 早年演练，没留下结论 -> 切换日前，按旧口径回补
      organizer: '孙立群',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2023-002', // 与上一行演练编号相同（旧系统重复登记），迁移保留巡检日期最早的
      inspectDate: '2023-09-01',
      scene: '雨水倒灌抽排演练（重复登记）',
      crew: '综合机电甲班',
      durationMinutes: 80,
      conclusion: '重复登记行，迁移应跳过',
      organizer: '孙立群',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2024-001',
      inspectDate: '2024-03-15',
      // 演练场景缺失 -> 必填项缺失，挂待确认
      crew: '应急通讯班',
      durationMinutes: 60,
      organizer: '郑海峰',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2024-002',
      inspectDate: '2024-05-20',
      scene: '进廊作业失联搜救',
      crew: '', // 参与班组缺人 -> 自检挑出来
      durationMinutes: 120,
      organizer: '许文婷',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2024-003',
      // 巡检日期缺失 -> 必填项缺失，不猜日期，挂待确认
      scene: '结构变形封舱演练',
      crew: '综合机电乙班',
      durationMinutes: 95,
      organizer: '周建国',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2025-001',
      inspectDate: '2025-02-11',
      scene: '极端暴雨廊体封堵',
      crew: '综合机电甲班、安保疏散班',
      durationMinutes: 105,
      // 无结论、切换日前 -> 回补
      organizer: '郑海峰',
      rawStatus: '完成',
    },
    {
      legacyCode: 'OLD-2025-002',
      inspectDate: '2025-08-09',
      scene: '电缆起火处置',
      crew: '消防抢险班',
      durationMinutes: 50,
      conclusion: '旧台账结论：问题较多需复演', // 有旧结论 -> 沿用，但与已评估状态的语义不自相矛盾，保留原文
      organizer: '孙立群',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2026-001',
      inspectDate: '', // 又一条缺巡检日期的
      scene: '有害气体搜救演练',
      crew: '通风排水班',
      durationMinutes: 65,
      organizer: '许文婷',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2026-002',
      inspectDate: '2026-01-17',
      scene: '通风故障应急送风',
      crew: '综合机电乙班',
      durationMinutes: 85,
      conclusion: '旧台账结论：合格',
      organizer: '周建国',
      rawStatus: '演练中', // 状态演练中却带着结论 -> 顶牛（老数据沿用原结论，只挑不改）
    },
    {
      legacyCode: 'EMER-0003', // 与样例演练编号撞车：跳过，且不许冲掉样例已有结论
      inspectDate: '2026-02-03',
      scene: '编号撞车的存量行',
      crew: '安保疏散班',
      durationMinutes: 40,
      conclusion: '试图覆盖样例结论，必须被挡住',
      organizer: '孙立群',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2026-003',
      inspectDate: '2026-05-30',
      scene: '汛期综合联动演练',
      crew: '综合机电甲班、消防抢险班、应急通讯班',
      durationMinutes: 135,
      // 切换日前、无结论 -> 回补
      organizer: '郑海峰',
      rawStatus: '已完成',
    },
    {
      legacyCode: 'OLD-2026-004',
      inspectDate: CUTOVER_DATE, // 切换日当天：新口径从这一天起算，无结论不回补，自检顶牛
      scene: '切换后首次拉动演练',
      crew: '综合机电乙班、通风排水班',
      durationMinutes: 70,
      organizer: '许文婷',
      rawStatus: '已完成',
    },
  ]
}

export function buildSeedBundle(): SeedBundle {
  return {
    seedRevision: SEED_REVISION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: GENERATED_AT,
    samples: buildSamples(),
    legacy: buildLegacyRows(),
  }
}
