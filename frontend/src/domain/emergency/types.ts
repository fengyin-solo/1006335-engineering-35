/**
 * 应急演练领域类型：初始化脚本（Node）与浏览器运行时共用同一份定义，
 * 不依赖 Vue、localStorage 或任何浏览器 API，保证同一条链路两边算出的东西一致。
 */

/** 岗位：只有「组织人员」能落评估结论，其余岗位只读。 */
export type Role = '组织人员' | '参演班组' | '观摩人员'

export type Operator = {
  name: string
  role: Role
}

/** 演练状态机：待组织 -> 演练中 -> 已评估；任意阶段可取消。 */
export type DrillStatus = '待组织' | '演练中' | '已评估' | '已取消'

export type DrillRecord = {
  /** 稳定主键：按演练编号的序号生成，重建、迁移、换环境都不变。 */
  id: number
  /** 业务判重键，全库唯一；自检发现重复就按这个字段报。 */
  code: string
  scene: string
  /** 参与班组，多个班组用「、」连接；空数组表示缺人。 */
  crew: string[]
  /** 计划日期，ISO yyyy-mm-dd。往期数据按巡检日期整体搬到这里。 */
  plannedDate: string
  /** 演练时长（分钟），与计划日期同属硬约束，样例按编号稳定生成。 */
  durationMinutes: number
  /** 评估结论；未评估为空串，已评估后不可被初始化/迁移覆盖。 */
  conclusion: string
  /** 落结论的人（组织人员）。 */
  organizer: string
  status: DrillStatus
  /** 来源：样例 / 存量迁移。 */
  source: 'sample' | 'legacy'
  /** 存量行原巡检日期（迁移留痕）。 */
  legacyInspectDate?: string
  /** 存量行原编号（迁移留痕，便于人工对账）。 */
  legacyCode?: string
  /** 乐观锁：同一时刻两笔并发提交，只认先到的那笔。 */
  version: number
  createdAt: string
  updatedAt: string
}

/** 待办清单条目：每落一条评估结论就在另一个入口回写一条，一一对应。 */
export type DrillTodo = {
  id: number
  drillCode: string
  /** 处置结论：与演练评估结论逐字一致。 */
  summary: string
  organizer: string
  createdAt: string
  status: '待办' | '已闭环'
}

/** 缺项待人工确认：迁移时不完整、不武断落库的存量行逐条挂这里。 */
export type PendingConfirm = {
  id: number
  legacyCode: string
  inspectDate: string
  missingFields: string[]
  reason: string
  raw: Record<string, unknown>
  createdAt: string
}

export type FindingKind = '演练编号撞车' | '参与班组缺人' | '评估结论与状态顶牛'

export type Finding = {
  kind: FindingKind
  drillCode: string
  reason: string
}

/** 迁移账：记录每一条存量行的去向，反复执行初始化时据此跳过，中断后据此续跑。 */
export type MigrationLedgerEntry = {
  /** 行级键：演练编号|巡检日期。同一编号不同日期的重复登记各有各的账，续跑不会串。 */
  rowKey: string
  legacyCode: string
  inspectDate: string
  outcome:
    | 'imported'
    | 'backfilled'
    | 'kept-original'
    | 'duplicate-skipped'
    | 'collision-skipped'
    | 'incomplete-pending'
  drillCode?: string
  reason: string
  processedAt: string
}

export type EmergencyState = {
  /** 持久化结构版本号：口径切换时靠它识别旧库。 */
  schemaVersion: number
  /** 种子修订号：样例/存量口径变更时递增。 */
  seedRevision: number
  drills: DrillRecord[]
  todos: DrillTodo[]
  pendings: PendingConfirm[]
  ledger: MigrationLedgerEntry[]
  /** bootstrap 断点：样例与存量都落账后才置 true，中断重跑会接着做。 */
  bootstrapDone: boolean
  bootstrappedAt: string
  /** 自检保留项：迁移时被挡住的撞车行（库里无该行，但问题要一直能在自检页看到缘由）。 */
  collisionFindings: Finding[]
}

export type SeedBundle = {
  seedRevision: number
  schemaVersion: number
  generatedAt: string
  samples: DrillRecord[]
  legacy: LegacyRow[]
}

/** 存量台账的原始行（字段名沿用旧系统，巡检日期迁移成计划日期；刻意允许缺失以演练待确认流程）。 */
export type LegacyRow = {
  legacyCode: string
  inspectDate?: string
  scene?: string
  crew?: string
  durationMinutes?: number
  conclusion?: string
  organizer?: string
  rawStatus?: string
}

export type BootstrapOptions = {
  now: string
  /** 测试钩子：在落某一条存量之前抛错，模拟跑到一半中断。 */
  crashBeforeLegacyCode?: string
  /**
   * 每处理完一条存量（已落迁移账）就回调一次当前快照，仓库层在回调里持久化。
   * 这就是「跑到一半中断也能接着跑」的事务边界：已提交的行不回滚。
   */
  onCommit?: (snapshot: EmergencyState) => void
}

export type SubmitConclusionInput = {
  code: string
  conclusion: string
  operator: Operator
  /** 页面读到的 version：后到的提交拿旧 version 过来会被整笔回退。 */
  expectedVersion: number
  now: string
}

export type AdvanceInput = {
  code: string
  /** 组织演练 / 取消演练。 */
  action: '组织演练' | '取消演练'
  operator: Operator
  expectedVersion: number
  now: string
}

export type CommitResult =
  | { ok: true; state: EmergencyState; message: string }
  | { ok: false; state: EmergencyState; message: string }

export type Counts = {
  total: number
  byStatus: Record<DrillStatus, number>
  /** 状态为已评估的演练（可能缺结论，缺的那条自检会挑出来）。 */
  evaluated: number
  /** 已评估且有结论：与另一入口的处置待办逐条对应，两边条数必须一致。 */
  concluded: number
  pending: number
  todos: number
  findings: number
  pendings: number
}
