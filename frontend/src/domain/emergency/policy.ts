/**
 * 应急演练链路的固定口径：版本、切换日、班组花名册、旧状态映射、
 * 判重字段、回补文案全部集中在这里，Node 脚本与浏览器共用，不许在别处各写一份。
 */
import type { DrillStatus, LegacyRow, Role } from './types'

export const SCHEMA_VERSION = 2
/** 样例或迁移口径调整时递增；旧库里的 revision 对不上时按新口径重放（只补缺，不覆盖结论）。 */
export const SEED_REVISION = 1

/**
 * 新口径切换之日：
 * - 计划日期（存量按巡检日期）早于这一天的存量演练，没留下结论的，按「历史回补」口径补结论；
 * - 这一天及以后的演练没有结论，不做回补，自检会挑出来顶牛。
 * 老数据沿用原有结论，一律不覆盖。
 */
export const CUTOVER_DATE = '2026-10-06'

/** 生成产物的固定时间戳：样例不随生成机器、生成时刻变化，保证本地与线上逐字节一致。 */
export const GENERATED_AT = '2026-10-06T08:00:00+08:00'

/** 早年没留下评估结论时的统一回补口径（仅用于切换日前的存量演练）。 */
export const LEGACY_BACKFILL_CONCLUSION = '历史演练（切换日前）原始结论缺失，按旧口径回补：演练流程完整，视同评审合格，备查'

/**
 * 参与班组花名册：演练必须至少有 1 个花名册内的班组，否则按「参与班组缺人」挑出来。
 * 判空与花名册校验是同一条规则，页面和初始化脚本用同一个函数。
 */
export const KNOWN_CREWS = [
  '综合机电甲班',
  '综合机电乙班',
  '消防抢险班',
  '通风排水班',
  '安保疏散班',
  '应急通讯班',
]

export const ORGANIZERS = ['周建国', '孙立群', '郑海峰', '许文婷']

export const SCENES = [
  '综合舱电力电缆起火应急处置',
  '燃气舱可燃气体泄漏疏散',
  '雨水倒灌抽排与人员撤离',
  '结构变形超限封舱演练',
  '通风机组故障应急送风',
  '有害气体超标人员搜救',
  '进廊作业人员失联搜救',
  '极端暴雨廊体封堵演练',
]

export const EVALUATION_CONCLUSIONS = [
  '响应及时、处置流程符合预案，评估通过',
  '协同基本顺畅，个别班组到位偏慢，评估通过并限期整改',
  '物资调用存在脱节，评估有条件通过，下月复演',
]

/** 终态：到了这两个状态的记录不允许再被状态动作推进。 */
export const TERMINAL_STATUSES: DrillStatus[] = ['已评估', '已取消']

/** 旧台账状态 -> 新状态机。映射不上的存量行进待确认，不猜。 */
export function mapLegacyStatus(rawStatus: string | undefined): DrillStatus | null {
  switch ((rawStatus ?? '').trim()) {
    case '已完成':
    case '已评估':
    case '完成':
      return '已评估'
    case '演练中':
    case '进行中':
      return '演练中'
    case '待组织':
    case '计划':
      return '待组织'
    case '已取消':
    case '取消':
      return '已取消'
    default:
      return null
  }
}

/** 岗位把关：只有组织人员能落评估结论、组织/取消演练，其他岗位只读。 */
export function canWrite(role: Role): boolean {
  return role === '组织人员'
}

/** 存量行必填项（巡检日期是迁移排序与切换日判定的依据，缺了不能搬）。 */
export function legacyMissingFields(row: LegacyRow): string[] {
  const missing: string[] = []
  if (!String(row.legacyCode ?? '').trim()) missing.push('演练编号')
  if (!String(row.inspectDate ?? '').trim()) missing.push('巡检日期')
  if (!String(row.scene ?? '').trim()) missing.push('演练场景')
  return missing
}
