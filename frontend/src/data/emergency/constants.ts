/**
 * 应急演练管理：链路常量与类型。
 *
 * 这条链路（初始化脚本 / 存量迁移 / 评估提交 / 待办回写 / 自检）全部围绕这里的口径运行，
 * 页面与本地服务不得另写一套判断。
 */

export const EMERGENCY_KEY = 'emergency'

/** 状态机：与 data/modules.ts 中 emergency 模块保持一致。 */
export const EMERGENCY_STATUS = {
  /** 已排期、尚未组织 */
  pending: '待组织',
  /** 演练进行中，还没落评估结论 */
  running: '演练中',
  /** 演练完成且评估结论已落档 */
  evaluated: '已评估',
  /** 演练取消，不需要评估结论 */
  cancelled: '已取消',
  /** 切换日之前的往期演练，当年没留评估结论，回补为“待人工补评估” */
  legacyGap: '待补评估',
} as const

/**
 * 回补口径切换日。
 * - 计划日期 < CUTOVER_DATE 的为「往期数据」：有结论的沿用原结论，没结论的按历史口径
 *   回补为「待补评估」，不替演练编造成效，列入缺失项等人工确认。
 * - 计划日期 >= CUTOVER_DATE 的为「新口径」：已评估必须有真实结论，不再做兜底回补，
 *   “结论 vs 状态顶牛”一律由自检挑出。
 */
export const CUTOVER_DATE = '2026-10-06'

/** 往期缺失结论的统一占位结论：明确标注“待补”，绝不冒充正式评估。 */
export const LEGACY_GAP_CONCLUSION = '往期演练未留存评估结论（切换日前历史口径，待人工补评估）'

/**
 * 判重口径（迁移与初始化共用，写在这里以便审计）：
 * 以业务自然键「演练编号」判重。
 * - 同一批次内演练编号重复 => 不静默丢弃，保留并由自检报「演练编号撞车」；
 * - 跨批次（存量台账 vs 规范样例）演练编号相同 => 存量台账优先，规范样例跳过，不覆盖。
 * id 只是存储行号，绝不参与判重。
 */
export const DEDUP_FIELD = '演练编号' as const

/** 参与班组的最少参演人数（低于此数判“参与班组缺人”）。 */
export const MIN_CREW_SIZE = 2

/** 岗位：只有组织人员能落评估结论，其余岗位只读，越权提交整笔驳回。 */
export const ROLES = ['组织人员', '参演人员', '只读访客'] as const
export type Role = (typeof ROLES)[number]
export const EVALUATOR_ROLE: Role = '组织人员'

/** 一条规范的应急演练记录（v 是乐观锁版本号，用于并发提交先到先得）。 */
export type EmergencyRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  v: number
  演练编号: string
  演练场景: string
  参与班组: string
  参演人数: number
  计划日期: string
  演练时长: number
  评估结论: string
  组织人员: string
  演练状态: string
  [field: string]: string | number | boolean
}

/** 迁移阶段标记：区分正式台账与暂存待人工确认项。 */
export type EmergencyStage = 'live' | 'staged'

/** 缺失项暂存记录：字段缺失的存量行整笔暂存，逐条列给人工确认，不自动落库。 */
export type StagedLegacyRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  v: number
  演练编号: string
  演练场景: string
  参与班组: string
  参演人数: number
  计划日期: string
  演练时长: number
  评估结论: string
  组织人员: string
  演练状态: string
  /** 缺失的字段名 */
  缺失字段: string[]
  /** 迁移批次（脚本版本），可重入 */
  迁移批次: string
}

/** 待办：评估处置结论回写到待办清单入口，与演练页共用同一份存储、同一套计数。 */
export type TodoRow = {
  id: number
  /** 业务幂等键：`emergency:id:<台账行id>`，每行待办与台账行一一对应（编号撞车不合并） */
  bizKey: string
  来源: string
  关联编号: string
  待办事项: string
  处置结论: string
  计划日期: string
  状态: '待处置' | '已闭环'
  创建时间: string
}

/** 自检问题：页面条数与自检结果共用这一份。 */
export type IssueRow = {
  code: 'duplicate-code' | 'crew-short' | 'status-conflict'
  演练编号: string
  环节: '正式台账' | '待确认暂存'
  缘由: string
}

/** 初始化 / 迁移账本：逐行记进度，中断后接着跑；已完成的行不再改动。 */
export type PipelineLedger = {
  /** 初始化脚本版本：示例数据集按此版本稳定生成 */
  seedVersion: string
  /** 规范示例数据集内容指纹：本地与线上落库必须一致 */
  seedHash: string
  /**
   * 存量迁移批次是否已执行。
   * 检查点按「批次内排序后的行序号」记录，而不是按演练编号：
   * 同批次内演练编号撞车的两笔都要保留下来交给自检，不能被检查点吞掉。
   */
  migrations: Record<string, { done: boolean; processedIndexes: number[] }>
  /** 已播种的演练编号：重复执行初始化时跳过，绝不动已有记录 */
  seededCodes: string[]
  /** 已人工确认进正式台账 / 已丢弃的暂存编号 */
  resolvedStagedIds: number[]
}
