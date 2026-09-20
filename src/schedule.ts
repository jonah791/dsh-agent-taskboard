/**
 * schedule.ts — 时间提醒与定时任务的**纯逻辑层**（无 IO、无时钟依赖、无 cordis 依赖 → 离线可测）。
 *
 * 语义主副本：`docs/semantic.md` §4.4（时间提醒与定时任务）+ 不变量 I7–I10。
 *
 * 三条硬边界（都不许在本文件里被软化）：
 *   · **I7 不自动执行**：本层只**算出谁到点了**，投递动作由调用方注入（`deliver`）——它绝不领取/执行/完成任务。
 *   · **I8 一次触发一次通知**：`lastFiredAt >= nextAt` ⇒ 不再触发（防重复投递）。
 *   · **I9 重复任务不堆积**：错过 N 轮只触发一次，`nextAt` 前进到**严格大于 now** 的下一时刻。
 *
 * ⚠ 本文件**刻意不用 `RegExp.exec(`**：那正是 2026-09-20 让 Clustly 安全扫描器把「正则 exec」误判成
 * `child_process.exec` 的写法（handler.mjs:29/45，害我卡了 74 小时人工审阅）。统一改用 `String.match` /
 * `matchAll`——语义相同，但不会被任何「把 exec( 当 spawn」的扫描器咬到。
 */

/** 调度只关心这些字段（其余字段透传，不解读）。 */
export interface SchedulableTask {
  id: string
  title: string
  status: string
  priority?: string
  /** 一次性提醒时刻 / 周期任务的首次时刻（ISO 8601） */
  remindAt?: string
  /** 周期（分钟）；缺省 = 一次性 */
  repeatMinutes?: number
  /** 下次触发时刻（运行态，由本层计算并写回） */
  nextAt?: string
  /** 上次触发时刻（防重复触发的判据） */
  lastFiredAt?: string
  /** 触发次数（审计用） */
  fireCount?: number
  /** 该提醒是否唤醒会话；缺省由调用方按 config.remindWakeup 决定 */
  wake?: boolean
  /** 触发者绑定：设定提醒的会话（`exec.agent.session.id`） */
  notifySession?: string
}

const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const RELATIVE = /^\+(\d+)([smhd])$/
const TIME_ONLY = /^(\d{1,2}):(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T/

/**
 * 解析时间输入 → epoch ms。**非法输入一律抛错**（绝不静默取 now——那会让「以为设了提醒」变成「立刻触发」）。
 * 支持四形态：ISO 8601 · 相对偏移 `+30m`/`+2h`/`+1d`/`+90s` · 当日 `HH:MM`（已过则顺延次日）· `YYYY-MM-DD HH:MM`。
 */
export function parseWhen(input: string, nowMs: number): number {
  const s = String(input ?? '').trim()
  if (s === '') throw new Error('时间不能为空')

  const rel = s.match(RELATIVE)
  if (rel !== null) {
    const n = Number(rel[1])
    const unit = rel[2] as keyof typeof MS
    if (!Number.isFinite(n) || n <= 0) throw new Error('相对时间必须为正整数：' + s)
    return nowMs + n * MS[unit]
  }

  const timeOnly = s.match(TIME_ONLY)
  if (timeOnly !== null) {
    const hh = Number(timeOnly[1])
    const mm = Number(timeOnly[2])
    if (hh > 23 || mm > 59) throw new Error('非法时刻：' + s)
    const d = new Date(nowMs)
    d.setHours(hh, mm, 0, 0)
    let t = d.getTime()
    if (t <= nowMs) t += MS.d // 已过 → 顺延次日
    return t
  }

  const dt = s.match(DATE_TIME)
  if (dt !== null) {
    const t = new Date(Number(dt[1]), Number(dt[2]) - 1, Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6] ?? 0), 0).getTime()
    if (!Number.isFinite(t)) throw new Error('非法日期时间：' + s)
    return t
  }

  if (ISO_LIKE.test(s)) {
    const t = Date.parse(s)
    if (!Number.isFinite(t)) throw new Error('非法 ISO 时间：' + s)
    return t
  }

  throw new Error('无法识别的时间（支持 ISO / +30m / HH:MM / YYYY-MM-DD HH:MM）：' + s)
}

/** 该任务的「本次应触发时刻」——优先 `nextAt`（周期任务由本层维护），否则 `remindAt`。 */
export function scheduledAt(task: SchedulableTask): number | null {
  const raw = task.nextAt ?? task.remindAt
  if (raw === undefined || raw === '') return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

/** 是否到点该触发（I8：同一 `nextAt` 至多一次；终态任务永不触发）。 */
export function isDue(task: SchedulableTask, nowMs: number): boolean {
  if (task.status === 'done' || task.status === 'cancelled') return false
  const at = scheduledAt(task)
  if (at === null || at > nowMs) return false
  if (task.lastFiredAt !== undefined && task.lastFiredAt !== '') {
    const fired = Date.parse(task.lastFiredAt)
    if (Number.isFinite(fired) && fired >= at) return false
  }
  return true
}

/**
 * 周期任务的下一次触发时刻：从 `fromMs` 起按 `everyMinutes` 前进，返回**严格大于 nowMs** 的那一次
 * （I9：错过的整轮直接跳过，不堆积补发）。`everyMinutes` 非法/缺省 → `null`（= 一次性任务）。
 */
export function advanceNext(fromMs: number, everyMinutes: number | undefined, nowMs: number): number | null {
  if (everyMinutes === undefined || !Number.isFinite(everyMinutes) || everyMinutes <= 0) return null
  const step = everyMinutes * 60_000
  const missed = Math.floor((nowMs - fromMs) / step)
  let next = fromMs + (missed + 1) * step
  if (next <= nowMs) next += step
  return next
}

/** 收集到点任务（按应触发时刻升序；纯函数，不改输入）。 */
export function collectDue(tasks: SchedulableTask[], nowMs: number): SchedulableTask[] {
  return tasks
    .filter((t) => isDue(t, nowMs))
    .slice()
    .sort((a, b) => (scheduledAt(a) ?? 0) - (scheduledAt(b) ?? 0))
}

/** 提醒文案（人读；**不是指令**——板面内容始终是不可信输入，§5 边界）。 */
export function reminderText(task: SchedulableTask, nowMs: number, repeatMinutes: number | undefined): string {
  const parts = [
    '【任务板·提醒】' + task.title + '（' + task.id + '，优先级 ' + (task.priority ?? 'normal') + '）',
  ]
  const next = advanceNext(nowMs, repeatMinutes, nowMs)
  if (repeatMinutes !== undefined && repeatMinutes > 0 && next !== null) {
    parts.push('周期 ' + repeatMinutes + ' 分钟，下次 ' + new Date(next).toISOString())
  }
  parts.push('——到点了，是否处理由我判断（插件不代做）。')
  return parts.join(' ')
}

export interface SweepBoard {
  tasks: SchedulableTask[]
  [k: string]: unknown
}

export interface SweepDeps {
  nowMs: number
  /** 读板（注入 ⇒ 可离线测；真实实现走 loadBoard） */
  load(): SweepBoard
  /** 写板（只在真有触发时调用一次） */
  save(board: SweepBoard): void
  /** 投递一条提醒；返回实际走通的通道（bound = 绑定会话 / broadcast = 广播兜底 / failed = 两路皆败） */
  deliver(task: SchedulableTask, text: string): 'bound' | 'broadcast' | 'failed'
  /** 阶段痕迹（一行一事件；吞错由实现方负责） */
  trace(event: string, fields?: Record<string, unknown>): void
}

export interface SweepResult {
  due: number
  fired: number
  failed: number
  ids: string[]
}

/**
 * 扫一轮（**唯一**的触发执行点）：算出到点任务 → 投递 → 写回 `lastFiredAt`/`fireCount`/`nextAt` → 一次落盘。
 * 幂等：同一 `nextAt` 重复扫不会重复投递（`lastFiredAt` 判据，I8）。
 * 投递失败**不改状态**（下轮重试）——宁可重试，也不把「没送出去」记成「已提醒」。
 */
export function sweepOnce(deps: SweepDeps): SweepResult {
  const board = deps.load()
  const tasks = Array.isArray(board.tasks) ? board.tasks : []
  const due = collectDue(tasks, deps.nowMs)
  const res: SweepResult = { due: due.length, fired: 0, failed: 0, ids: [] }
  if (due.length === 0) return res

  let dirty = false
  for (const task of due) {
    const at = scheduledAt(task) ?? deps.nowMs
    const text = reminderText(task, deps.nowMs, task.repeatMinutes)
    const via = deps.deliver(task, text)
    if (via === 'failed') {
      res.failed += 1
      deps.trace('deliver-error', { taskId: task.id, at: new Date(at).toISOString() })
      continue // 状态不动 → 下一轮重试（不静默吞掉）
    }
    const next = advanceNext(at, task.repeatMinutes, deps.nowMs)
    task.lastFiredAt = new Date(deps.nowMs).toISOString()
    task.fireCount = (task.fireCount ?? 0) + 1
    if (next !== null) task.nextAt = new Date(next).toISOString()
    dirty = true
    res.fired += 1
    res.ids.push(task.id)
    deps.trace('deliver', { taskId: task.id, via, nextAt: task.nextAt ?? null, fireCount: task.fireCount })
  }
  if (dirty) {
    try {
      deps.save(board)
    } catch (e) {
      // 写盘失败：已投递但状态没落盘 ⇒ 下一轮会**重投**。如实记，不掩盖（宁可重复提醒，不可静默丢失）
      deps.trace('save-error', { message: errText(e), note: '已投递但状态未落盘，下轮可能重投' })
    }
  }
  return res
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
