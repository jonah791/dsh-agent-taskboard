/**
 * statemachine.ts — 任务状态机 v2 的**纯函数层**（无 IO / 无 ctx / 无副作用）。
 *
 * 语义正本：`docs/semantic.md` §4.5（状态机五态 / 流转白名单 / I11–I18）。
 * 为什么单独抽一层：状态判定与停滞判定必须**可离线测**，且必须只有一个真源——
 * 此前 `claimed` 同时表示「我在做」「我在等外部」「我卡住了」，状态因此会说谎
 * （2026-09-22 实测：两条 claimed 停滞 5.3 / 5.6 天而机制一声不响）。
 *
 * @module dsh-agent-taskboard/statemachine
 */

/** 任务状态（v2 五态）。`blocked` = 「我动不了，在等一个具体的东西」。 */
export type TaskStatus = 'pending' | 'claimed' | 'blocked' | 'done' | 'cancelled'

/** 全部状态的枚举序（工具参数 enum、计数初始化的单一真源）。 */
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'claimed', 'blocked', 'done', 'cancelled']

/** 终态：出板归档，不可复活（I12）。 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'cancelled']

/**
 * 流转白名单（I12 `[MUST]`）——**未列出的一律拒绝**。
 *
 * 终态的出边只有一条：`→ pending`（重开）。它不是自由流转，而是**必须带 reason 的显式动作**——
 * 见 `assertTransition` 的第三参。这样既保住 GUI 的「重开」能力，又不允许任何路径**静默**复活终态
 * （静默复活会让归档与板面同时存在同一 id 的两个版本）。
 */
// 2026-09-22 dogfooding 补的缺口：初版白名单只给了 `claimed → blocked/done/cancelled`，
// 于是「认领错了 / 我其实不打算做」**没有出路**——人只能挂着 claimed 装活，或谎报 blocked。
// **没有释放路径的状态机必然制造失真**，所以 `claimed → pending` 是一条必需边。
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['pending', 'blocked', 'done', 'cancelled'],
  blocked: ['claimed', 'cancelled'],
  done: ['pending'],
  cancelled: ['pending'],
}

/** 需要 reason 才允许的流转（终态重开），判据在 `assertTransition`。 */
export function needsReason(from: TaskStatus, to: TaskStatus): boolean {
  return isTerminal(from) && to === 'pending'
}

/** 停滞判据的缺省阈值（天）。 */
export const STALE_DAYS_DEFAULT = 3

/** 状态是否为终态。 */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status as TaskStatus)
}

/** 是否为已知状态（用于外部输入的 fail-loud 校验）。 */
export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus)
}

/** 该流转是否被白名单允许。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * 断言流转合法，否则抛错（I12）。
 * @param from - 当前状态
 * @param to - 目标状态
 * @param opts - `reason`：终态重开（`done|cancelled → pending`）时必须非空
 * @throws Error 流转不在白名单内，或终态重开缺 reason（消息含允许集合，便于一次改对）
 */
export function assertTransition(from: TaskStatus, to: TaskStatus, opts?: { reason?: string }): void {
  if (from === to) return
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from] ?? []
    throw new Error(
      '非法状态流转：' + from + ' → ' + to +
      '（' + from + ' 允许：' + (allowed.length > 0 ? allowed.join(' / ') : '无') + '）',
    )
  }
  if (needsReason(from, to) && (opts?.reason ?? '').trim() === '') {
    throw new Error('重开终态任务必须带 reason（' + from + ' → ' + to + '）——不允许静默复活')
  }
}

/** `blocked` 的必填承诺字段（I13）。 */
export interface BlockInput {
  blockedReason?: string
  nextAction?: string
  reviewAt?: string
}

/**
 * 断言 `blocked` 的三件套齐全（I13 `[MUST]`）。
 * 「卡住了」必须说清：卡在哪 / 下次做什么 / 何时再看——缺一即拒。
 * @param input - 待校验字段
 * @throws Error 缺任一项
 */
export function assertBlockedFields(input: BlockInput): void {
  const missing: string[] = []
  if ((input.blockedReason ?? '').trim() === '') missing.push('blockedReason（卡在哪）')
  if ((input.nextAction ?? '').trim() === '') missing.push('nextAction（下次做什么）')
  if ((input.reviewAt ?? '').trim() === '') missing.push('reviewAt（何时再看）')
  if (missing.length > 0) {
    throw new Error('blocked 必须带齐承诺字段，缺：' + missing.join('、'))
  }
}

/**
 * 完成摘要回流记忆库的**文本形状**（I17 的单一真源）。
 *
 * 为什么放在这里：完成后回流记忆有**三条**入口（工具面 `taskboard_complete`、
 * 工具面 `taskboard_update{status:'done'}`、GUI 面 `remote.mutate{complete}`）。
 * 文本形状若各写一份，同一件事在记忆库里就会有两种长相——那正是本轮要治的漂移。
 * @param task - 任务（取 id/title/type/priority）
 * @param summary - 完成摘要
 */
export function completionMemoryText(
  task: { id: string; title: string; type?: string; priority?: string },
  summary: string,
): string {
  return '## 任务完成：' + task.title + '\n\n' +
    (summary.trim() ? summary.trim() + '\n\n' : '') +
    '（任务 ' + task.id + '，' + (task.type ?? 'short') + ' / ' + (task.priority ?? 'normal') + '）'
}

/** 带时间戳的最小形状（`lastTouchMs` 只需要这三个字段——签名收窄，渲染层才复用得上）。 */
export interface TimeStamped {
  updatedAt?: string
  claimedAt?: string
  createdAt?: string
}

/** 停滞判定的最小输入形状。 */
export interface StaleCandidate extends TimeStamped {
  id: string
  title: string
  status: string
  reviewAt?: string
  nextAction?: string
}

/** 停滞项（进 `taskboard_status.stale`）。 */
export interface StaleItem {
  id: string
  title: string
  status: string
  /** 最后一次可观测的活动时刻（ISO）。 */
  lastTouchAt: string
  /** 停滞天数（保留一位小数）。 */
  idleDays: number
  nextAction?: string
  reviewAt?: string
}

/**
 * 取「最后一次活动时刻」。
 *
 * 回退链 `updatedAt → claimedAt → createdAt`：`updatedAt` 是 v2 起每次变更都刷新的字段（I14）；
 * 旧数据没有它，用 `claimedAt`/`createdAt` 近似——**近似方向是保守的**（会把老任务判得更久没动），
 * 这正是停滞检测想要的方向：宁可早提醒，不要装作它在动。
 * @param task - 任务形状
 * @returns epoch ms；三个字段都不可解析时返回 0
 */
export function lastTouchMs(task: TimeStamped): number {
  for (const raw of [task.updatedAt, task.claimedAt, task.createdAt]) {
    if (typeof raw === 'string' && raw !== '') {
      const ms = Date.parse(raw)
      if (Number.isFinite(ms)) return ms
    }
  }
  return 0
}

/**
 * 列出停滞任务（I15 `[MUST]`）：非终态 且 `now - lastTouch > staleDays`。
 * @param tasks - 板面任务
 * @param opts - `nowMs` 与可选 `staleDays`（缺省 `STALE_DAYS_DEFAULT`）
 * @returns 停滞项，按停滞天数降序
 */
export function staleOf(tasks: readonly StaleCandidate[], opts: { nowMs: number; staleDays?: number }): StaleItem[] {
  const staleDays = opts.staleDays ?? STALE_DAYS_DEFAULT
  const out: StaleItem[] = []
  for (const t of tasks) {
    if (isTerminal(t.status)) continue
    const ms = lastTouchMs(t)
    if (ms === 0) continue
    const idleDays = (opts.nowMs - ms) / 86400000
    if (idleDays <= staleDays) continue
    const item: StaleItem = {
      id: t.id,
      title: t.title,
      status: t.status,
      lastTouchAt: new Date(ms).toISOString(),
      idleDays: Math.round(idleDays * 10) / 10,
    }
    if (typeof t.nextAction === 'string' && t.nextAction !== '') item.nextAction = t.nextAction
    if (typeof t.reviewAt === 'string' && t.reviewAt !== '') item.reviewAt = t.reviewAt
    out.push(item)
  }
  return out.sort((a, b) => b.idleDays - a.idleDays)
}

/**
 * 列出到期待复查的阻塞项（`blocked` 且 `reviewAt ≤ now`）。
 * 语义：`blocked` 不是一个可以躺着不动的状态——它自带「何时再看」的承诺。
 * @param tasks - 板面任务
 * @param nowMs - 当前时刻
 */
export function dueReviews<T extends StaleCandidate>(tasks: readonly T[], nowMs: number): T[] {
  return tasks
    .filter((t) => t.status === 'blocked' && typeof t.reviewAt === 'string' && t.reviewAt !== '')
    .filter((t) => {
      const ms = Date.parse(t.reviewAt as string)
      return Number.isFinite(ms) && ms <= nowMs
    })
    .sort((a, b) => Date.parse(a.reviewAt as string) - Date.parse(b.reviewAt as string))
}
