/**
 * 应急演练：确定性示例数据 + 存量台账快照。
 *
 * 同一份代码在任何环境（本地重建 / 线上落库 / CI 自检）生成的内容逐字节一致：
 * 所有取值都是演练编号的纯函数，不依赖随机数、当前时间或执行环境。
 * 配套内容指纹 SEED_HASH 用来核对“本地与线上落库的那份数据一致”。
 */
import {
  CUTOVER_DATE,
  EMERGENCY_STATUS,
  type EmergencyRow,
} from './constants'

/** 初始化脚本版本：示例口径调整时才升版。 */
export const SEED_VERSION = '2026.10.06-emergency-v1'

/** FNV-1a 32 位：确定性哈希，生成取值与内容指纹都用它。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function pick<T>(items: readonly T[], seedText: string): T {
  return items[fnv1a(seedText) % items.length]
}

const SCENES = [
  '电缆舱火灾疏散演练',
  '有毒气体泄漏应急演练',
  '给水管道爆管涌水演练',
  '双路断电应急照明演练',
  '有限空间人员救援演练',
  '汛期防汛排涝演练',
  '结构坍塌抢险演练',
  '非法入侵安防联动演练',
] as const

const CREWS = ['抢险一班', '抢险二班', '机电保障班', '消防联动班', '应急指挥班'] as const
const ORGANIZERS = ['赵明轩', '孙启明', '周雅琴', '陈立峰', '林晓彤'] as const
const EVALUATED_CONCLUSIONS = [
  '演练达到预期，响应流程顺畅，物资到位及时',
  '演练基本达标，人员疏散用时偏长，需组织复测',
  '演练达标，个别岗位通讯设备故障，已列入更换计划',
  '演练未达预期，气体检测响应超时，须重练并复盘',
] as const

/** 新口径演练从切换日后第 8 天起，每隔 7 天一场。 */
const SEED_BASE_DATE = new Date('2026-10-14T00:00:00Z')
const SEED_COUNT = 10

function isoDate(offsetDays: number): string {
  const d = new Date(SEED_BASE_DATE.getTime() + offsetDays * 86400000)
  return d.toISOString().slice(0, 10)
}

/**
 * 按演练编号稳定生成一条规范样例。
 * 编号固定为 EMER-0001..EMER-0010，任何环境跑出来都是同一批。
 */
export function generateEmergencyRow(seq: number): EmergencyRow {
  const code = `EMER-${String(seq).padStart(4, '0')}`
  const statusOrder = [
    EMERGENCY_STATUS.pending,
    EMERGENCY_STATUS.running,
    EMERGENCY_STATUS.evaluated,
    EMERGENCY_STATUS.evaluated,
    EMERGENCY_STATUS.evaluated,
    EMERGENCY_STATUS.cancelled,
    EMERGENCY_STATUS.pending,
    EMERGENCY_STATUS.running,
    EMERGENCY_STATUS.evaluated,
    EMERGENCY_STATUS.evaluated,
  ]
  const status = statusOrder[(seq - 1) % statusOrder.length]
  const scene = pick(SCENES, `${code}:scene`)
  const crew = pick(CREWS, `${code}:crew`)
  const organizer = pick(ORGANIZERS, `${code}:organizer`)
  const duration = 60 + (fnv1a(`${code}:duration`) % 7) * 15
  const crewSize = 4 + (fnv1a(`${code}:size`) % 9)
  const planDate = isoDate((seq - 1) * 7)
  const evaluated = status === EMERGENCY_STATUS.evaluated
  const conclusion = evaluated ? pick(EVALUATED_CONCLUSIONS, `${code}:conclusion`) : ''
  const closed = evaluated || status === EMERGENCY_STATUS.cancelled
  return {
    id: seq,
    status,
    pending: !closed,
    abnormal: false,
    v: 1,
    演练编号: code,
    演练场景: scene,
    参与班组: crew,
    参演人数: crewSize,
    计划日期: planDate,
    演练时长: duration,
    评估结论: conclusion,
    组织人员: organizer,
    演练状态: status,
  }
}

/** 稳定序列化：键排序，保证指纹只取决于数据内容。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** 规范示例数据集：任何环境都从这里生成，不允许各环境另写一份。 */
export function generateEmergencySeed(): EmergencyRow[] {
  return Array.from({ length: SEED_COUNT }, (_, i) => generateEmergencyRow(i + 1))
}

/** 示例数据集内容指纹（FNV-1a 十六进制），本地/线上落库后可核对一致。 */
export function emergencySeedHash(rows: EmergencyRow[] = generateEmergencySeed()): string {
  return fnv1a(`${SEED_VERSION}:${stableStringify(rows)}`).toString(16).padStart(8, '0')
}

/**
 * 存量台账快照（切换日 2026-10-06 之前的老数据）。
 * 故意保留真实台账里的历史毛病，用来验证迁移与自检链路：
 * - 031 编号在两场不同演练上撞车（同年重复登记）；
 * - 2025-007 参演人数为 0；
 * - 2025-012 缺参与班组、2026-006 缺计划日期（字段缺失 → 暂存待人工确认）；
 * - 2026-002 已有评估结论但状态仍停在“演练中”（结论与状态顶牛）；
 * - 2025-019、2026-005 没留下评估结论（按历史口径回补“待补评估”）。
 * 迁移整体按计划日期升序搬入。
 */
export type LegacyImportRow = {
  演练编号: string
  演练场景: string
  参与班组: string
  参演人数: number
  计划日期: string
  演练时长: number
  评估结论: string
  组织人员: string
  演练状态: string
}

export const LEGACY_EMERGENCY_ROWS: LegacyImportRow[] = [
  {
    演练编号: 'EMER-2024-031',
    演练场景: '电缆舱火灾联合演练',
    参与班组: '抢险一班',
    参演人数: 6,
    计划日期: '2024-06-18',
    演练时长: 90,
    评估结论: '演练达到预期，全员疏散用时8分钟',
    组织人员: '赵明轩',
    演练状态: EMERGENCY_STATUS.evaluated,
  },
  {
    演练编号: 'EMER-2024-031',
    演练场景: '汛期防汛排涝演练',
    参与班组: '抢险二班',
    参演人数: 5,
    计划日期: '2024-07-02',
    演练时长: 85,
    评估结论: '演练达标，抽排能力满足预案要求',
    组织人员: '孙启明',
    演练状态: EMERGENCY_STATUS.evaluated,
  },
  {
    演练编号: 'EMER-2025-007',
    演练场景: '有毒气体泄漏应急演练',
    参与班组: '机电保障班',
    参演人数: 0,
    计划日期: '2025-09-16',
    演练时长: 70,
    评估结论: '',
    组织人员: '周雅琴',
    演练状态: EMERGENCY_STATUS.running,
  },
  {
    演练编号: 'EMER-2025-012',
    演练场景: '给水管道爆管涌水演练',
    参与班组: '',
    参演人数: 0,
    计划日期: '2025-10-08',
    演练时长: 65,
    评估结论: '演练基本达标，阀门关断用时偏长',
    组织人员: '陈立峰',
    演练状态: EMERGENCY_STATUS.evaluated,
  },
  {
    演练编号: 'EMER-2025-019',
    演练场景: '有限空间人员救援演练',
    参与班组: '抢险一班',
    参演人数: 7,
    计划日期: '2025-11-05',
    演练时长: 120,
    评估结论: '',
    组织人员: '林晓彤',
    演练状态: EMERGENCY_STATUS.evaluated,
  },
  {
    演练编号: 'EMER-2026-002',
    演练场景: '汛期防汛排涝演练',
    参与班组: '消防联动班',
    参演人数: 8,
    计划日期: '2026-03-21',
    演练时长: 75,
    评估结论: '演练达标，防汛物资到位及时',
    组织人员: '赵明轩',
    演练状态: EMERGENCY_STATUS.running,
  },
  {
    演练编号: 'EMER-2026-005',
    演练场景: '双路断电应急照明演练',
    参与班组: '抢险二班',
    参演人数: 4,
    计划日期: '2026-05-13',
    演练时长: 60,
    评估结论: '',
    组织人员: '孙启明',
    演练状态: EMERGENCY_STATUS.pending,
  },
  {
    演练编号: 'EMER-2026-006',
    演练场景: '结构坍塌抢险演练',
    参与班组: '应急指挥班',
    参演人数: 9,
    计划日期: '',
    演练时长: 80,
    评估结论: '',
    组织人员: '周雅琴',
    演练状态: EMERGENCY_STATUS.running,
  },
]

export const LEGACY_BATCH_ID = `legacy-pre-${CUTOVER_DATE}`
