/**
 * dsh-agent-taskboard：任务板插件。
 *
 * 主人/任何 agent 可发布任务（异步队列，JSON 持久化）；宿主 agent
 * （爱丽丝）空闲时自主领取并完成——发布只发 wakeup=false 排队通知，
 * 不打断会话。决策归爱丽丝：插件只提供原语（看板/通知/状态流转）。
 *
 * 工具：taskboard_post / taskboard_list / taskboard_claim / taskboard_complete /
 * taskboard_block / taskboard_cancel / taskboard_update / taskboard_remind /
 * taskboard_archive / taskboard_status
 *
 * 状态机 v2（2026-09-22 · 主人「改进任务板和工作流，重点围绕任务的状态更新和管理」）：
 * 五态 `pending/claimed/blocked/done/cancelled`，流转走**白名单**（`src/statemachine.ts`）；
 * `blocked` 必带 `blockedReason`/`nextAction`/`reviewAt`；`updatedAt` 每次变更刷新；
 * 停滞项与待复查阻塞项在 `taskboard_status` 里浮出。语义正本 `docs/semantic.md` §4.5（I11–I18）。
 * @module dsh-agent-taskboard
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs'
// 终态轮转（2026-09-13 主人：「任务板中完成的，你怎么不删啊」）——见 src/retention.ts 头部事故注释
import { splitTerminalForArchive } from './retention.ts'
// 时间提醒与定时任务（2026-09-20 主人指令）——纯逻辑层，语义见 docs/semantic.md §4.4 / 不变量 I7–I10
import { parseWhen, scheduledAt, sweepOnce, errText } from './schedule.ts'
import type { SchedulableTask, SweepBoard } from './schedule.ts'
// 状态机 v2（2026-09-22 主人「改进任务板和工作流，重点围绕任务的状态更新和管理」）：
// 流转白名单 / 停滞判据 / blocked 三件套——语义正本 docs/semantic.md §4.5 · I11–I18
import { assertBlockedFields, assertTransition, completionMemoryText, dueReviews, isTaskStatus, lastTouchMs, staleOf } from './statemachine.ts'
import type { TaskStatus } from './statemachine.ts'
// 终态归档回查（I16）：兑现「可用 taskboard 工具回查」那句曾经的假话
import { filterArchiveTasks, readArchiveDir } from './archive.ts'
import { missingCardText, renderCardText } from './cardview.ts'
// 板面读写的单一真源（I11）：读路径可退化、写路径绝不可以
import { readBoardStrict } from './board.ts'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TaskboardRemoteService } from './remote.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-taskboard': { kind: 'dsh-agent-taskboard' }
  }
}

export const name = 'agent-taskboard'
// memoryApi：可选回流服务（dsh-agent-memory 提供；任务完成摘要回流主记忆库）
export const inject = ['tools', 'agents', 'memoryApi'] as const

export interface Config {
  /** 任务板文件路径（JSON）。 */
  boardFile: string
  /** 宿主主会话 id（通知与默认领取者）。 */
  mainSessionId: string
  /** 发布新任务时是否给主会话发排队通知。 */
  notifyOnPost: boolean
  /** 提醒扫描周期（秒，≥5）；启动时另有一次立即扫（补离线窗口，§5.10 双路）。 */
  sweepSeconds: number
  /**
   * 任务提醒是否**唤醒**会话（缺省 true）。
   * ⚠ 唤醒 = 启动一次模型 turn = **真花钱**（2026-09-20 主人「钱包紧张」语境下这是显式旋钮，不是隐含行为）。
   * 置 false = 提醒照常落消息，只是不主动唤醒（等下一次交互时看到）。
   */
  remindWakeup: boolean
  /**
   * 停滞阈值（天，I15）：非终态任务超过这么多天没有 `updatedAt` 活动 ⇒ 进 `taskboard_status.stale`。
   * 缺省 3——取值理由：本板的任务多数是「天级」节奏，3 天足以区分「在做」与「烂尾」。
   */
  staleDays: number
}
export const Config = z.object({
  boardFile: z.string().default(process.env.DSH_HOME ? process.env.DSH_HOME + '/.taskboard/tasks.json' : 'E:/alice/.taskboard/tasks.json'),
  mainSessionId: z.string(),
  notifyOnPost: z.boolean().default(true),
  sweepSeconds: z.number().default(60),
  remindWakeup: z.boolean().default(true),
  staleDays: z.number().default(3),
})

/** 状态机 v2 的类型真源在 `src/statemachine.ts`——本文件只转发，避免同一枚举两处定义后漂移。 */
export type { TaskStatus }
export type TaskType = 'short' | 'long'

export interface Task {
  id: string
  title: string
  description: string
  type: TaskType
  priority: 'low' | 'normal' | 'high'
  tags: string[]
  status: TaskStatus
  assignee?: string
  createdAt: string
  claimedAt?: string
  doneAt?: string
  summary?: string
  /** 最后活动时刻（v2 起每次变更必刷新，I14）——停滞判据（I15）的唯一依赖项。 */
  updatedAt?: string
  /** 阻塞原因（`blocked` 必带，I13）。 */
  blockedReason?: string
  /** 下次要做什么（`blocked` 必带，I13）。 */
  nextAction?: string
  /** 下次复查时刻（`blocked` 必带，I13；到点进 `taskboard_status` 的待复查段）。 */
  reviewAt?: string
  // ---- 时间提醒与定时任务（2026-09-20 · 语义见 docs/semantic.md §4.4）----
  /** 提醒时刻（一次性 / 周期任务的首次时刻，ISO 8601） */
  remindAt?: string
  /** 周期（分钟）；缺省 = 一次性 */
  repeatMinutes?: number
  /** 下次触发时刻（插件维护；`repeatMinutes` 为空时恒等于 `remindAt`） */
  nextAt?: string
  /** 上次触发时刻（防重复触发的判据，I8） */
  lastFiredAt?: string
  /** 触发次数（审计） */
  fireCount?: number
  /** 该提醒是否唤醒会话（缺省取 config.remindWakeup） */
  wake?: boolean
  /** 触发者绑定：设定提醒的会话（`exec.agent.session.id`） */
  notifySession?: string
}

interface Board {
  tasks: Task[]
}

/**
 * 终态在板面保留天数：**0 = 完成/取消即归档**（主人 2026-09-13 定调「任务板中完成的，你怎么不删啊」）。
 * 归档不丢信息——摘要仍在 `archive/terminal-<date>.json`，且完成调用当场返回完整摘要。
 */
const TERMINAL_RETAIN_DAYS = 0

/**
 * 终态轮转：超期 done/cancelled 归档到 `<boardDir>/archive/terminal-<date>.json` 并从板面移除。
 * 幂等（无可归档项时不写盘）；归档失败时**原样返回**（宁可不轮转，也不丢数据）。
 */
function rotateTerminal(path: string, board: Board): Board {
  if (!Array.isArray(board.tasks) || board.tasks.length === 0) return board
  const { keep, archived } = splitTerminalForArchive(board.tasks, {
    nowMs: Date.now(),
    retainDays: TERMINAL_RETAIN_DAYS,
  })
  if (archived.length === 0) return board
  try {
    const dir = dirname(path) + '/archive'
    mkdirSync(dir, { recursive: true })
    const file = dir + '/terminal-' + new Date().toISOString().slice(0, 10) + '.json'
    let prev: { tasks?: unknown[] } = { tasks: [] }
    try {
      prev = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: unknown[] }
    } catch { /* 当日首建 */ }
    writeFileSync(file, JSON.stringify({
      archivedAt: new Date().toISOString(),
      note: '任务板终态归档（' + TERMINAL_RETAIN_DAYS + ' 天保留期外）；可用 taskboard 工具回查，恢复=手工并回 tasks.json',
      tasks: [...(prev.tasks ?? []), ...archived],
    }, null, 2), 'utf8')
    const next: Board = { ...board, tasks: keep as Task[] }
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch {
    return board
  }
}

/**
 * 读板面（I11 `[MUST]`）——严格读 + 读时轮转。
 * 失败语义与理由集中在 `src/board.ts`（**单一真源**，可单测）；本处只负责接上轮转。
 * @throws Error 解析失败 / IO 错误 / 顶层形状异常
 */
function loadBoard(path: string): Board {
  return rotateTerminal(path, { tasks: readBoardStrict<Task>(path, (p) => readFileSync(p, 'utf8')) })
}

function saveBoard(path: string, board: Board): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(board, null, 2), 'utf8')
}

/**
 * 从工具执行上下文取调用者会话 id（`exec.agent` 是**权威来源**；缺失/形状异常一律降级为 undefined，不抛）。
 * 语义：§5.18 触发者绑定——「谁设的提醒，就提醒谁」，不用「当前活跃会话」这类代理量。
 */
function callerSessionId(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 渲染用的「多久没动」后缀（I15 的**可见面**）。
 *
 * 停滞不能只在 `taskboard_status` 里报——列表面板天天看，状态标签旁边就得带着年龄，
 * 否则「claimed 5 天」和「claimed 5 分钟」在视觉上仍然一模一样。
 * 判据复用 `statemachine.lastTouchMs`（**单一真源**，不在这里重写回退链）。
 * @param task - 任务的时间字段
 * @returns 如 ` · 5.3天未动`；无可用时间戳时返回空串
 */
function ageSuffix(task: { updatedAt?: string; claimedAt?: string; createdAt?: string }): string {
  const ms = lastTouchMs(task)
  if (ms === 0) return ''
  const days = (Date.now() - ms) / 86400000
  if (days < 0) return ''
  if (days < 1) return ' · 今日有动'
  return ' · ' + (Math.round(days * 10) / 10) + '天未动'
}

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(TaskboardRemoteService, {
    boardFile: config.boardFile,
    mainSessionId: config.mainSessionId,
    notifyOnPost: config.notifyOnPost,
  })
  const boardPath = config.boardFile

  // ── 阶段痕迹（§5.22 可维护性：机制必须自证；一行一事件，可 tail/grep）──
  const tracePath = join(dirname(boardPath), 'taskboard-trace.jsonl')
  const trace = (event: string, fields: Record<string, unknown> = {}): boolean => {
    try {
      mkdirSync(dirname(tracePath), { recursive: true })
      appendFileSync(tracePath, JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', 'utf8')
      return true
    } catch {
      return false // 观测绝不反噬主流程
    }
  }

  /** 兜底包装（§5.24：逃逸异常曾杀死宿主 web）——捕获后**留痕**（不静默）。 */
  const guarded = <T,>(stage: string, fn: () => T): T | undefined => {
    try {
      return fn()
    } catch (e) {
      trace(stage + '-error', { message: errText(e) })
      return undefined
    }
  }

  /**
   * 状态变更的**唯一入口**（I12 白名单 + I14 `updatedAt` 刷新 + 留痕）。
   *
   * 为什么收成一个函数：此前 `taskboard_complete` 与 `taskboard_update{status:'done'}` 是两条路，
   * 产出不同结果（前者写摘要 + 回流记忆，后者两样都没有）——**状态更新的正确性必须由机制保证，
   * 不能靠「记得走哪条路」保证**（§5.10：默认行为由布线决定，不由意志决定）。
   */
  const changeStatus = (task: Task, to: TaskStatus, opts: { reason?: string; by?: string } = {}): void => {
    const from = task.status
    if (from === to) return
    assertTransition(from, to, { reason: opts.reason })
    task.status = to
    task.updatedAt = new Date().toISOString()
    if (to === 'claimed' && task.claimedAt === undefined) task.claimedAt = task.updatedAt
    if (to === 'done') task.doneAt = task.updatedAt
    // 离开 blocked 即清掉三件套（它们描述的是**那一次**阻塞，不是任务属性）
    if (to !== 'blocked') {
      delete task.blockedReason
      delete task.nextAction
      delete task.reviewAt
    }
    trace('status-change', { taskId: task.id, from, to, by: opts.by ?? null, reason: opts.reason ?? null })
  }

  /**
   * 完成摘要回流主记忆库（I17：两条完成路径共用同一实现）。
   * 失败静默——任务完成已是落盘事实，不因回流失败回滚（保留原语义）。
   */
  const rememberCompletion = (task: Task, summary: string): void => {
    try {
      const api = (ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[]; key?: string }): Promise<unknown> } }).memoryApi
      if (api === undefined || !task.title) return
      const text = completionMemoryText(task, summary)
      void api.remember({ text, kind: task.type === 'long' ? 'episodic' : 'knowledge', tags: ['任务板', task.id], key: 'task-' + task.id }).catch(() => { /* 回流失败静默 */ })
    } catch { /* 回流失败不阻塞任务完成 */ }
  }

  /**
   * assignee 判定（I18）：**调用者会话优先**（§5.18 触发者绑定同源），`mainSessionId` 只在调用者不可得时兜底。
   * 来源随返回值给出，调用方必须落 trace——「谁在做」的兜底路径要可审计。
   */
  const assigneeFor = (exec: unknown): { assignee: string; source: 'caller' | 'anchor' } => {
    const caller = callerSessionId(exec)
    return caller !== undefined
      ? { assignee: caller, source: 'caller' }
      : { assignee: config.mainSessionId, source: 'anchor' }
  }

  /**
   * 提醒投递（§5.18 触发者绑定）：
   *   ① `notifySession`（设定者会话）可达 → `bound`
   *   ② 否则遍历 live agents 广播 → `broadcast`
   *   ③ 两路皆败 → `failed`（由 sweepOnce 记 `deliver-error` 并**保留状态**，下轮重试）
   * ⚠ 不用 `ctx.agents.get(sessionId)` 作唯一路径：ID 形状不匹配会让消息静默丢失（本生态实测过）。
   */
  const deliverReminder = (task: SchedulableTask, text: string): 'bound' | 'broadcast' | 'failed' => {
    const make = () => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-agent-taskboard' },
    })
    const wake = task.wake ?? config.remindWakeup
    const seen = new Set<string>()

    let bound = false
    const target = task.notifySession
    if (target !== undefined && target !== '') {
      try {
        const agent = ctx.agents.get(target as SessionId)
        if (agent !== undefined && agent !== null) {
          agent.send(make(), 'next-turn', wake)
          bound = true
          seen.add(target)
        }
      } catch (e) {
        trace('deliver-bound-error', { taskId: task.id, target, message: errText(e) })
      }
    }
    if (bound) return 'bound' // 绑定通道成功即不再广播（防重复提醒）

    let broadcast = false
    try {
      for (const agent of ctx.agents.list() as unknown as Agent[]) {
        const sid = (agent as { id?: string; session?: { id?: string } }).id ?? (agent as { session?: { id?: string } }).session?.id
        if (sid === undefined || seen.has(sid)) continue
        seen.add(sid)
        agent.send(make(), 'next-turn', wake)
        broadcast = true
      }
    } catch (e) {
      trace('deliver-broadcast-error', { taskId: task.id, message: errText(e) })
    }
    return broadcast ? 'broadcast' : 'failed'
  }

  /** 扫一轮（触发执行点；逻辑全在纯函数层 `schedule.ts`，此处只注入 IO）。 */
  const doSweep = (): void => {
    guarded('sweep', () => {
      const r = sweepOnce({
        nowMs: Date.now(),
        load: () => loadBoard(boardPath) as unknown as SweepBoard,
        save: (b) => saveBoard(boardPath, b as unknown as Board),
        deliver: deliverReminder,
        trace,
      })
      if (r.due > 0) trace('sweep', { due: r.due, fired: r.fired, failed: r.failed })
      return r
    })
  }

  // ── 触发面双路（§5.10 预防性存活）──
  // ① 启动即扫：补上「进程不在时错过的窗口」（不靠「刚好在线」）
  doSweep()
  // ② 周期扫：guarded 包回调 + unref（不阻止进程退出）+ ctx.effect 清理
  const sweepTimer = setInterval(() => { doSweep() }, Math.max(5, config.sweepSeconds) * 1000)
  ;(sweepTimer as unknown as { unref?: () => void }).unref?.()
  ctx.effect(() => () => { clearInterval(sweepTimer) })

  /** 跨会话广播：发布任务 → 所有 live agents（会话）都收到排队通知；mainSessionId 兜底。 */
  const notify = (text: string) => {
    if (!config.notifyOnPost) return
    try {
      const seen = new Set<string>()
      for (const agent of ctx.agents.list() as unknown as Agent[]) {
        const sid = (agent as any).id ?? (agent as any).session?.id
        if (!sid || seen.has(sid)) continue
        seen.add(sid)
        agent.send(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'dsh-agent-taskboard' },
          }),
          'next-turn',
          false, // wakeup=false：排队不打断
        )
      }
      // 兜底：mainSessionId 不在 live 列表时也发
      if (!seen.has(config.mainSessionId)) {
        ctx.agents.get(config.mainSessionId as SessionId)?.send(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'dsh-agent-taskboard' },
          }),
          'next-turn',
          false,
        )
      }
    } catch { /* 通知失败静默 */ }
  }

  // ---------- taskboard_post ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_post',
    description: '发布任务到任务板（异步队列）：主人或任何 agent 可调用；发布后发排队通知（不打断会话），宿主空闲时自主领取。可带时间提醒（到点只送达提醒，不代做任务）。',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题' },
      description: { type: 'string', description: '任务详情' },
      type: { type: 'string', enum: ['short', 'long'], description: '任务类型：short=短期任务 / long=长期任务' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '优先级' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      remindAt: { type: 'string', description: '提醒时刻：ISO / +30m / +2h / HH:MM / YYYY-MM-DD HH:MM（缺省不设提醒）' },
      repeatMinutes: { type: 'integer', description: '重复周期（分钟）；给了则每周期提醒一次（错过只补一次，不堆积）' },
      wake: { type: 'boolean', description: '该提醒是否唤醒会话（缺省取 config.remindWakeup）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已发布：' + v.id + '（' + v.status + '）' }] },
    async execute(args: { title: string; description?: string; type?: string; priority?: string; tags?: string[]; remindAt?: string; repeatMinutes?: number; wake?: boolean }, exec: unknown) {
      const board = loadBoard(boardPath)
      const task: Task = {
        id: 't-' + randomUUID().slice(0, 8),
        title: args.title,
        description: args.description ?? '',
        type: (args.type === 'short' || args.type === 'long' ? args.type : 'short') as Task['type'],
        priority: (args.priority as Task['priority']) ?? 'normal',
        tags: args.tags ?? [],
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      let remindNote = ''
      if (args.remindAt !== undefined && args.remindAt !== '') {
        const atMs = parseWhen(args.remindAt, Date.now()) // 非法输入**抛错**（不静默取 now）
        if (args.repeatMinutes !== undefined && (!Number.isFinite(args.repeatMinutes) || args.repeatMinutes <= 0)) {
          throw new Error('repeatMinutes 必须为正整数（分钟）')
        }
        task.remindAt = new Date(atMs).toISOString()
        task.nextAt = task.remindAt
        if (args.repeatMinutes !== undefined) task.repeatMinutes = args.repeatMinutes
        if (args.wake !== undefined) task.wake = args.wake
        const caller = callerSessionId(exec)
        if (caller !== undefined) task.notifySession = caller // 触发者绑定
        remindNote = '｜提醒 ' + task.remindAt + (task.repeatMinutes !== undefined ? '（每 ' + task.repeatMinutes + ' 分钟）' : '')
      }
      board.tasks.push(task)
      saveBoard(boardPath, board)
      trace('post', { taskId: task.id, priority: task.priority, remindAt: task.remindAt ?? null })
      notify('【任务板】新任务：' + task.title + '（' + task.id + '，优先级 ' + task.priority + remindNote + '）——空闲时自主领取处理。')
      return { id: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_remind（时间提醒 / 定时任务）----------
  ctx.tools.register(defineTool({
    name: 'taskboard_remind',
    description: '给任务设/挪/清时间提醒，或列出全部待触发提醒。到点只投递提醒，**不代做任务**（做不做由 agent 判断）。',
    parameters: {
      taskId: { type: 'string', description: '任务 id（action=list 时可省）' },
      action: { type: 'string', enum: ['set', 'clear', 'list'], description: 'set=设/挪（缺省）· clear=清除 · list=列出待触发' },
      at: { type: 'string', description: 'set 必需：ISO / +30m / +2h / HH:MM / YYYY-MM-DD HH:MM' },
      repeatMinutes: { type: 'integer', description: 'set 可选：重复周期（分钟）' },
      wake: { type: 'boolean', description: 'set 可选：该提醒是否唤醒会话' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, note: { type: 'string', required: true }, reminders: { type: 'json' } } }, render: (_a, v) => [{ type: 'text', text: v.note + (((v.reminders ?? []) as unknown[]).length > 0 ? String.fromCharCode(10) + ((v.reminders ?? []) as { id: string; title: string; nextAt: string; repeatMinutes?: number | null }[]).map((r) => '⏰ ' + r.title + ' (' + r.id + ') → ' + r.nextAt + (r.repeatMinutes != null ? '（每 ' + r.repeatMinutes + ' 分钟）' : '')).join(String.fromCharCode(10)) : '') }] },
    async execute(args: { taskId?: string; action?: string; at?: string; repeatMinutes?: number; wake?: boolean }, exec: unknown) {
      const action = args.action ?? 'set'
      const board = loadBoard(boardPath)

      if (action === 'list') {
        const reminders = board.tasks
          .filter((t) => (t.nextAt ?? t.remindAt) !== undefined && t.status !== 'done' && t.status !== 'cancelled')
          .slice()
          .sort((a, b) => (scheduledAt(a as SchedulableTask) ?? 0) - (scheduledAt(b as SchedulableTask) ?? 0))
          .map((t) => ({ id: t.id, title: t.title, status: t.status, nextAt: t.nextAt ?? t.remindAt ?? '', repeatMinutes: t.repeatMinutes ?? null, lastFiredAt: t.lastFiredAt ?? null, fireCount: t.fireCount ?? 0 }))
        return { ok: true, note: '【任务板】待触发提醒 ' + reminders.length + ' 条', reminders }
      }

      const taskId = args.taskId
      if (taskId === undefined || taskId === '') throw new Error('taskId 必填（action=list 除外）')
      const task = board.tasks.find((t) => t.id === taskId)
      if (task === undefined) throw new Error('任务不存在：' + taskId)

      if (action === 'clear') {
        delete task.remindAt
        delete task.nextAt
        delete task.repeatMinutes
        delete task.wake
        // 保留 lastFiredAt / fireCount 作为**历史留痕**（清提醒 ≠ 抹掉「它曾提醒过」）
        saveBoard(boardPath, board)
        trace('remind-clear', { taskId: task.id })
        return { ok: true, note: '已清除提醒：' + task.id }
      }

      if (args.at === undefined || args.at === '') throw new Error('action=set 需要 at（ISO / +30m / HH:MM / YYYY-MM-DD HH:MM）')
      if (args.repeatMinutes !== undefined && (!Number.isFinite(args.repeatMinutes) || args.repeatMinutes <= 0)) {
        throw new Error('repeatMinutes 必须为正整数（分钟）')
      }
      const atMs = parseWhen(args.at, Date.now())
      task.remindAt = new Date(atMs).toISOString()
      task.nextAt = task.remindAt
      if (args.repeatMinutes !== undefined) task.repeatMinutes = args.repeatMinutes
      else delete task.repeatMinutes
      if (args.wake !== undefined) task.wake = args.wake
      const caller = callerSessionId(exec)
      if (caller !== undefined) task.notifySession = caller // 触发者绑定（谁设的提醒就提醒谁）
      delete task.lastFiredAt // 重设时刻 = 新一轮（否则旧的 lastFiredAt 会压住新 nextAt）
      saveBoard(boardPath, board)
      trace('remind-set', { taskId: task.id, nextAt: task.nextAt, repeatMinutes: task.repeatMinutes ?? null, notifySession: task.notifySession ?? null })
      return { ok: true, note: '已设提醒：' + task.id + ' → ' + task.nextAt + (task.repeatMinutes !== undefined ? '（每 ' + task.repeatMinutes + ' 分钟）' : ''), reminders: [{ id: task.id, title: task.title, nextAt: task.nextAt, repeatMinutes: task.repeatMinutes ?? null }] }
    },
  }))

  // ---------- taskboard_list ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_list',
    description: '列出任务板任务（可按状态过滤；缺省全部）。⚠ 终态（done/cancelled）完成即归档出板——查它们请用 taskboard_archive。',
    parameters: {
      status: { type: 'string', enum: ['pending', 'claimed', 'blocked', 'done', 'cancelled'], description: '状态过滤' },
      limit: { type: 'integer', description: '条数上限' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { tasks: { type: 'json', required: true }, total: { type: 'integer', required: true }, hint: { type: 'string' } } }, render: (_a, v) => { const tasks = (v.tasks ?? []) as { status: string; priority: string; title: string; id: string; summary?: string; updatedAt?: string; claimedAt?: string; createdAt?: string }[]; const lines = ['【任务板】共 ' + v.total + ' 项']; for (const t of tasks) { const mark = t.status === 'done' ? '✅' : t.status === 'cancelled' ? '✖' : t.status === 'blocked' ? '⛔' : t.status === 'claimed' ? '🔨' : '⬜'; lines.push(mark + ' [' + t.priority + '] ' + t.title + ' (' + t.id + ') — ' + t.status + ageSuffix(t) + (t.summary ? '：' + t.summary : '')); } if (typeof v.hint === 'string' && v.hint !== '') lines.push(v.hint); return [{ type: 'text', text: lines.join(String.fromCharCode(10)) }] } },
    async execute(args: { status?: string; limit?: number }) {
      const board = loadBoard(boardPath)
      let tasks = board.tasks
      if (args.status) tasks = tasks.filter((t) => t.status === args.status)
      tasks = tasks.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      if (args.limit) tasks = tasks.slice(0, args.limit)
      // I16：终态查询为空时**必须**指明「空 ≠ 没完成过」，否则调用者会把归档读成不存在
      if ((args.status === 'done' || args.status === 'cancelled') && tasks.length === 0) {
        return {
          tasks: JSON.parse(JSON.stringify(tasks)),
          total: 0,
          hint: '（终态任务完成即归档出板——本次为空**不代表从未完成过**，回查用 taskboard_archive）',
        }
      }
      return { tasks: JSON.parse(JSON.stringify(tasks)), total: tasks.length }
    },
  }))

  // ---------- taskboard_show（新增 · 2026-09-22）：卡片正文必须能**读回** ----------
  // 缺口（t-7238ff6a）：此前只有写没有读——正文只能写不能读，而 taskboard_update 的
  // description 是**整体替换** ⇒ 一次自以为「补充说明」的更新会把原始判据抹掉且无痕迹。
  // 与我今天修的 I11 同族：**缺失/宽容的读，处在带写回的链路上 = 删除**。
  ctx.tools.register(defineTool({
    name: 'taskboard_show',
    description: '读回一张任务的**全文**（标题/正文/状态/优先级/标签/负责人/各时间戳/阻塞三件套）。写之前先读：taskboard_update 的 description 是**整体替换**，不先读回就改会把原始判据整段覆盖。终态任务完成即出板——回查用 taskboard_archive。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id（如 t-1a2b3c4d）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          card: { type: 'json' },
          text: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: String(v.text ?? '') }],
    },
    async execute(args: { id: string }) {
      const board = loadBoard(boardPath)
      const t = board.tasks.find((x) => x.id === args.id)
      if (t === undefined) {
        return { found: false, id: args.id, text: missingCardText(args.id) }
      }
      // 渲染是**纯函数单源**（`cardview.ts`，有逐字符全等的离线测例）——
      // 工具面只做 IO，不再自己拼字符串（拼在这里就测不到，而它恰恰是「读回一致性」的判据本体）。
      return { found: true, id: t.id, card: JSON.parse(JSON.stringify(t)), text: renderCardText(t, ageSuffix(t)) }
    },
  }))

  // ---------- taskboard_claim ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_claim',
    description: '领取任务：pending → claimed。缺省负责人 = **调用者会话**（I18）；可显式指定 assignee。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      assignee: { type: 'string', description: '领取者（缺省调用者会话；不再写腐化锚点）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true }, assignee: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '已领取：' + v.taskId + ' → ' + v.assignee }] },
    async execute(args: { taskId: string; assignee?: string }, exec: unknown) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (task.status !== 'pending') throw new Error('任务状态为 ' + task.status + '，不可领取（仅 pending 可领取）')
      const picked = args.assignee !== undefined && args.assignee !== ''
        ? { assignee: args.assignee, source: 'explicit' as const }
        : assigneeFor(exec)
      changeStatus(task, 'claimed', { by: picked.assignee })
      task.assignee = picked.assignee
      saveBoard(boardPath, board)
      trace('claim', { taskId: task.id, assignee: picked.assignee, 'assignee-source': picked.source })
      return { taskId: task.id, status: task.status, assignee: picked.assignee }
    },
  }))

  // ---------- taskboard_complete ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_complete',
    description: '完成任务：claimed → done，附完成摘要（摘要回流记忆库）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      summary: { type: 'string', description: '完成摘要（回流进记忆库）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已完成：' + v.taskId }] },
    async execute(args: { taskId: string; summary?: string }, exec: unknown) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (task.status !== 'claimed') throw new Error('任务状态为 ' + task.status + '，仅 claimed 可完成')
      changeStatus(task, 'done', { by: callerSessionId(exec) })
      const summary = args.summary ?? ''
      task.summary = summary
      saveBoard(boardPath, board)
      // 完成摘要回流主记忆库（2026-09-06）；与 update 的 done 路径共用同一实现（I17）
      rememberCompletion(task, summary)
      return { taskId: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_cancel ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_cancel',
    description: '取消任务：任意非终态 → cancelled（附原因）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      reason: { type: 'string', description: '取消原因' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已取消：' + v.taskId }] },
    async execute(args: { taskId: string; reason?: string }, exec: unknown) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (task.status === 'done' || task.status === 'cancelled') throw new Error('任务已终结（' + task.status + '）')
      changeStatus(task, 'cancelled', { by: callerSessionId(exec), reason: args.reason })
      task.summary = args.reason ?? ''
      saveBoard(boardPath, board)
      return { taskId: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_block（新增 · blocked 态：把「我动不了」和「我在做」分开）----------
  ctx.tools.register(defineTool({
    name: 'taskboard_block',
    description: '把任务标为阻塞：claimed → blocked。**必须**带齐 reason（卡在哪）/ nextAction（下次做什么）/ reviewAt（何时再看）——「卡住了」必须说清，否则状态会说谎（I13）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      reason: { type: 'string', required: true, description: '卡在哪（如：等外部首单 / 判据失效待换）' },
      nextAction: { type: 'string', required: true, description: '下次要做什么' },
      reviewAt: { type: 'string', required: true, description: '何时再看：ISO / +2h / +1d / HH:MM / YYYY-MM-DD HH:MM' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true }, nextAction: { type: 'string', required: true }, reviewAt: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '已标记阻塞：' + v.taskId + ' → 待复查 ' + v.reviewAt + '｜下次：' + v.nextAction }] },
    async execute(args: { taskId: string; reason: string; nextAction: string; reviewAt: string }, exec: unknown) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      // 顺序有意：先解析时刻（非法输入抛错，不静默取 now），再校验三件套齐全（I13）
      const atMs = parseWhen(args.reviewAt, Date.now())
      assertBlockedFields({ blockedReason: args.reason, nextAction: args.nextAction, reviewAt: args.reviewAt })
      if (task.status !== 'claimed') throw new Error('任务状态为 ' + task.status + '，仅 claimed 可标阻塞（先 claim 再 block）')
      changeStatus(task, 'blocked', { by: callerSessionId(exec), reason: args.reason })
      const nextAction = args.nextAction
      const reviewAt = new Date(atMs).toISOString()
      task.blockedReason = args.reason
      task.nextAction = nextAction
      task.reviewAt = reviewAt
      saveBoard(boardPath, board)
      return { taskId: task.id, status: task.status, nextAction, reviewAt }
    },
  }))

  // ---------- taskboard_update ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_update',
    description: '更新任务（标题/描述/优先级/标签/状态流转）。状态流转走**白名单校验**（I12）：未列出的流转会抛错；重开终态必须带 reason。status=blocked 时必须带齐 blockedReason/nextAction/reviewAt。⚠ **description 是整体替换**（不是追加）——改之前请先用 taskboard_show 读回原文，否则会把原始判据整段覆盖且无痕迹；只想补充请把原文一并带上。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      title: { type: 'string', description: '新标题' },
      description: { type: 'string', description: '新描述' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '新优先级' },
      tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
      status: { type: 'string', enum: ['pending', 'claimed', 'blocked', 'done', 'cancelled'], description: '新状态（走白名单；done 与 taskboard_complete 同语义）' },
      reason: { type: 'string', description: '流转说明（**重开终态必填**；cancel/blocked 建议填，进 trace）' },
      blockedReason: { type: 'string', description: 'status=blocked 必填：卡在哪' },
      nextAction: { type: 'string', description: 'status=blocked 必填：下次做什么' },
      reviewAt: { type: 'string', description: 'status=blocked 必填：何时再看' },
      summary: { type: 'string', description: 'status=done/cancelled 时的摘要/原因' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已更新：' + v.taskId + ' → ' + v.status }] },
    async execute(args: { taskId: string; title?: string; description?: string; priority?: string; tags?: string[]; status?: string; reason?: string; blockedReason?: string; nextAction?: string; reviewAt?: string; summary?: string }, exec: unknown) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      const by = callerSessionId(exec)

      // ① 内容字段：变更即算一次活动（I14）——否则「改了描述」仍会被停滞判据算作没动
      let contentChanged = false
      if (args.title !== undefined) { task.title = args.title; contentChanged = true }
      if (args.description !== undefined) { task.description = args.description; contentChanged = true }
      if (args.priority !== undefined) { task.priority = args.priority as Task['priority']; contentChanged = true }
      if (args.tags !== undefined) { task.tags = args.tags; contentChanged = true }

      // ② 状态流转：唯一入口 changeStatus（白名单 + updatedAt + 留痕）
      let completed: { summary: string } | undefined
      if (args.status !== undefined) {
        if (!isTaskStatus(args.status)) throw new Error('未知状态：' + args.status + '（允许：pending / claimed / blocked / done / cancelled）')
        const next = args.status
        if (next === task.status) {
          // 同状态：不报错（幂等），但也不假装发生了流转
        } else if (next === 'blocked') {
          const atMs = parseWhen(args.reviewAt ?? '', Date.now())
          assertBlockedFields({ blockedReason: args.blockedReason, nextAction: args.nextAction, reviewAt: args.reviewAt })
          changeStatus(task, 'blocked', { by, reason: args.reason })
          task.blockedReason = args.blockedReason as string
          task.nextAction = args.nextAction as string
          task.reviewAt = new Date(atMs).toISOString()
        } else {
          changeStatus(task, next, { by, reason: args.reason })
          if (next === 'claimed' && task.assignee === undefined) task.assignee = assigneeFor(exec).assignee
          if (next === 'done' || next === 'cancelled') {
            const summary = args.summary ?? ''
            task.summary = summary
            if (next === 'done') completed = { summary }
          }
        }
      }
      if (contentChanged && args.status === undefined) task.updatedAt = new Date().toISOString()

      saveBoard(boardPath, board)
      // ③ I17：done 路径与 taskboard_complete 共用同一实现（摘要 + 记忆回流），不允许两条路产出不同结果
      if (completed !== undefined) rememberCompletion(task, completed.summary)
      return { taskId: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_archive（新增 · I16：终态回查，兑现旧注释里那句假话）----------
  ctx.tools.register(defineTool({
    name: 'taskboard_archive',
    description: '回查终态归档：done/cancelled 完成任务即出板，归档在 <boardDir>/archive/terminal-*.json。可按 id / 关键词 / 终态过滤，也可 files=true 只清点归档文件。',
    parameters: {
      id: { type: 'string', description: '精确任务 id' },
      keyword: { type: 'string', description: '标题或摘要的子串（大小写不敏感）' },
      status: { type: 'string', enum: ['done', 'cancelled'], description: '只看该终态' },
      limit: { type: 'integer', description: '返回条数上限（缺省 20）' },
      files: { type: 'boolean', description: 'true=只列归档文件清单（不列任务）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { files: { type: 'json', required: true }, total: { type: 'integer', required: true }, filesOnly: { type: 'boolean', required: true }, tasks: { type: 'json', required: true }, corrupt: { type: 'json', required: true } } }, render: (_a, v) => { const files = (v.files ?? []) as { file: string; count: number }[]; const tasks = (v.tasks ?? []) as { id: string; title: string; status: string; doneAt?: string }[]; const corrupt = (v.corrupt ?? []) as { file: string; error: string }[]; const lines = ['【任务板·归档】文件 ' + files.length + ' 个 / 任务 ' + v.total + ' 条' + (v.filesOnly === true ? '（仅清点）' : '')]; for (const f of files) lines.push('  · ' + f.file + ' — ' + f.count + ' 条'); for (const t of tasks) lines.push('  ' + (t.status === 'cancelled' ? '✖' : '✅') + ' ' + t.title + ' (' + t.id + ')' + (t.doneAt ? ' — ' + t.doneAt : '')); for (const c of corrupt) lines.push('  ⚠ 坏归档 ' + c.file + '：' + c.error); return [{ type: 'text', text: lines.join(String.fromCharCode(10)) }] } },
    async execute(args: { id?: string; keyword?: string; status?: string; limit?: number; files?: boolean }) {
      const dir = dirname(boardPath) + '/archive'
      const inv = readArchiveDir(dir, (p) => readFileSync(p, 'utf8'), (p) => readdirSync(p))
      const filesOnly = args.files === true
      const picked = filesOnly
        ? []
        : filterArchiveTasks(inv.tasks, { id: args.id, keyword: args.keyword, status: args.status, limit: args.limit })
      return {
        files: JSON.parse(JSON.stringify(inv.files)),
        total: inv.tasks.length,
        filesOnly,
        tasks: JSON.parse(JSON.stringify(picked)),
        corrupt: JSON.parse(JSON.stringify(inv.corrupt)),
      }
    },
  }))

  // ---------- taskboard_status ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_status',
    description: '任务板看板概览：各状态计数 + 进行中任务 + **停滞项**（I15，超 staleDays 无活动）+ **待复查阻塞项**（blocked 且 reviewAt 已到）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { counts: { type: 'json', required: true }, active: { type: 'json', required: true }, stale: { type: 'json', required: true }, due: { type: 'json', required: true } } }, render: (_a, v) => { const cc = (v.counts ?? {}) as Record<string, number>; const stale = (v.stale ?? []) as { id: string; title: string; idleDays: number }[]; const due = (v.due ?? []) as { id: string; title: string; reviewAt: string }[]; const lines = ['【任务板】待办 ' + (cc.pending ?? 0) + ' | 进行中 ' + (cc.claimed ?? 0) + ' | 阻塞 ' + (cc.blocked ?? 0) + ' | 完成 ' + (cc.done ?? 0) + ' | 取消 ' + (cc.cancelled ?? 0)]; if (stale.length > 0) { lines.push('⏳ 停滞 ' + stale.length + ' 项（超阈值无活动）：'); for (const s of stale) lines.push('  · ' + s.title + ' (' + s.id + ') — ' + s.idleDays + ' 天未动'); } if (due.length > 0) { lines.push('⛔ 待复查 ' + due.length + ' 项（承诺的复查时刻已到）：'); for (const d of due) lines.push('  · ' + d.title + ' (' + d.id + ') — 约定 ' + d.reviewAt); } return [{ type: 'text', text: lines.join(String.fromCharCode(10)) }] } },
    async execute() {
      const board = loadBoard(boardPath)
      const counts: Record<string, number> = { pending: 0, claimed: 0, blocked: 0, done: 0, cancelled: 0 }
      for (const t of board.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
      const active = board.tasks.filter((t) => t.status === 'pending' || t.status === 'claimed' || t.status === 'blocked')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      // I15：停滞可见——「claimed 5 天」和「claimed 5 分钟」不该长得一样
      const stale = staleOf(board.tasks, { nowMs: Date.now(), staleDays: config.staleDays })
      // I13：blocked 自带「何时再看」的承诺，到点必须浮出来
      const due = dueReviews(board.tasks, Date.now()).map((t) => ({
        id: t.id,
        title: t.title,
        reviewAt: t.reviewAt as string,
        nextAction: t.nextAction ?? '',
      }))
      return {
        counts,
        active: JSON.parse(JSON.stringify(active)),
        stale: JSON.parse(JSON.stringify(stale)),
        due: JSON.parse(JSON.stringify(due)),
      }
    },
  }))
}
