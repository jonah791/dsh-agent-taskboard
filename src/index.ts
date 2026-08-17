/**
 * dsh-agent-taskboard：任务板插件。
 *
 * 主人/任何 agent 可发布任务（异步队列，JSON 持久化）；宿主 agent
 * （爱丽丝）空闲时自主领取并完成——发布只发 wakeup=false 排队通知，
 * 不打断会话。决策归爱丽丝：插件只提供原语（看板/通知/状态流转）。
 *
 * 工具：taskboard_post / taskboard_list / taskboard_claim /
 * taskboard_complete / taskboard_cancel / taskboard_update / taskboard_status
 * @module dsh-agent-taskboard
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TaskboardRemoteService } from './remote.ts'

export const name = 'agent-taskboard'
export const inject = ['tools', 'agents'] as const

export interface Config {
  /** 任务板文件路径（JSON）。 */
  boardFile: string
  /** 宿主主会话 id（通知与默认领取者）。 */
  mainSessionId: string
  /** 发布新任务时是否给主会话发排队通知。 */
  notifyOnPost: boolean
}
export const Config = z.object({
  boardFile: z.string().default('C:/Users/tr/Documents/alice/.taskboard/tasks.json'),
  mainSessionId: z.string(),
  notifyOnPost: z.boolean().default(true),
})

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'cancelled'
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
}

interface Board {
  tasks: Task[]
}

function loadBoard(path: string): Board {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Board
  } catch {
    return { tasks: [] }
  }
}

function saveBoard(path: string, board: Board): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(board, null, 2), 'utf8')
}

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(TaskboardRemoteService, {
    boardFile: config.boardFile,
    mainSessionId: config.mainSessionId,
    notifyOnPost: config.notifyOnPost,
  })
  const boardPath = config.boardFile

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
            source: { kind: 'plugin', plugin: 'dsh-agent-taskboard' },
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
            source: { kind: 'plugin', plugin: 'dsh-agent-taskboard' },
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
    description: '发布任务到任务板（异步队列）：主人或任何 agent 可调用；发布后发排队通知（不打断会话），宿主空闲时自主领取。',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题' },
      description: { type: 'string', description: '任务详情' },
      type: { type: 'string', enum: ['short', 'long'], description: '任务类型：short=短期任务 / long=长期任务' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '优先级' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已发布：' + v.id + '（' + v.status + '）' }] },
    async execute(args: { title: string; description?: string; type?: string; priority?: string; tags?: string[] }) {
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
      }
      board.tasks.push(task)
      saveBoard(boardPath, board)
      notify('【任务板】新任务：' + task.title + '（' + task.id + '，优先级 ' + task.priority + '）——空闲时自主领取处理。')
      return { id: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_list ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_list',
    description: '列出任务板任务（可按状态过滤；缺省全部）。',
    parameters: {
      status: { type: 'string', enum: ['pending', 'claimed', 'done', 'cancelled'], description: '状态过滤' },
      limit: { type: 'integer', description: '条数上限' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { tasks: { type: 'json', required: true }, total: { type: 'integer', required: true } } }, render: (_a, v) => { const tasks = (v.tasks ?? []) as { status: string; priority: string; title: string; id: string; summary?: string }[]; const lines = ['【任务板】共 ' + v.total + ' 项']; for (const t of tasks) { const mark = t.status === 'done' ? '✅' : t.status === 'cancelled' ? '✖' : t.status === 'claimed' ? '🔨' : '⬜'; lines.push(mark + ' [' + t.priority + '] ' + t.title + ' (' + t.id + ') — ' + t.status + (t.summary ? '：' + t.summary : '')); } return [{ type: 'text', text: lines.join(String.fromCharCode(10)) }] } },
    async execute(args: { status?: string; limit?: number }) {
      const board = loadBoard(boardPath)
      let tasks = board.tasks
      if (args.status) tasks = tasks.filter((t) => t.status === args.status)
      tasks = tasks.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      if (args.limit) tasks = tasks.slice(0, args.limit)
      return { tasks: JSON.parse(JSON.stringify(tasks)), total: tasks.length }
    },
  }))

  // ---------- taskboard_claim ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_claim',
    description: '领取任务：pending → claimed（默认领取者为主会话；可指定 assignee）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      assignee: { type: 'string', description: '领取者（缺省主会话）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true }, assignee: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '已领取：' + v.taskId + ' → ' + v.assignee }] },
    async execute(args: { taskId: string; assignee?: string }) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (task.status !== 'pending') throw new Error('任务状态为 ' + task.status + '，不可领取')
      task.status = 'claimed'
      task.assignee = args.assignee ?? config.mainSessionId
      task.claimedAt = new Date().toISOString()
      saveBoard(boardPath, board)
      return { taskId: task.id, status: task.status, assignee: task.assignee }
    },
  }))

  // ---------- taskboard_complete ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_complete',
    description: '完成任务：claimed → done，附完成摘要。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      summary: { type: 'string', description: '完成摘要' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已完成：' + v.taskId }] },
    async execute(args: { taskId: string; summary?: string }) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (task.status !== 'claimed') throw new Error('任务状态为 ' + task.status + '，仅 claimed 可完成')
      task.status = 'done'
      task.summary = args.summary ?? ''
      task.doneAt = new Date().toISOString()
      saveBoard(boardPath, board)
      return { taskId: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_cancel ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_cancel',
    description: '取消任务：任意未完成状态 → cancelled（附原因）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      reason: { type: 'string', description: '取消原因' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已取消：' + v.taskId }] },
    async execute(args: { taskId: string; reason?: string }) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (task.status === 'done' || task.status === 'cancelled') throw new Error('任务已终结（' + task.status + '）')
      task.status = 'cancelled'
      task.summary = args.reason ?? ''
      saveBoard(boardPath, board)
      return { taskId: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_update ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_update',
    description: '更新任务（标题/描述/优先级/标签/状态流转；状态流转自动维护时间戳）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      title: { type: 'string', description: '新标题' },
      description: { type: 'string', description: '新描述' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '新优先级' },
      tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
      status: { type: 'string', enum: ['pending', 'claimed', 'done', 'cancelled'], description: '新状态' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, status: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '任务已更新：' + v.taskId + ' → ' + v.status }] },
    async execute(args: { taskId: string; title?: string; description?: string; priority?: string; tags?: string[]; status?: string }) {
      const board = loadBoard(boardPath)
      const task = board.tasks.find((t) => t.id === args.taskId)
      if (!task) throw new Error('任务不存在：' + args.taskId)
      if (args.title !== undefined) task.title = args.title
      if (args.description !== undefined) task.description = args.description
      if (args.priority !== undefined) task.priority = args.priority as Task['priority']
      if (args.tags !== undefined) task.tags = args.tags
      if (args.status !== undefined) {
        const next = args.status as TaskStatus
        task.status = next
        if (next === 'claimed') { task.claimedAt = new Date().toISOString(); task.assignee = task.assignee ?? config.mainSessionId }
        if (next === 'done') task.doneAt = new Date().toISOString()
      }
      saveBoard(boardPath, board)
      return { taskId: task.id, status: task.status }
    },
  }))

  // ---------- taskboard_status ----------
  ctx.tools.register(defineTool({
    name: 'taskboard_status',
    description: '任务板看板概览（各状态计数 + 进行中任务）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { counts: { type: 'json', required: true }, active: { type: 'json', required: true } } }, render: (_a, v) => { const cc = (v.counts ?? {}) as Record<string, number>; return [{ type: 'text', text: '【任务板】待办 ' + (cc.pending ?? 0) + ' | 进行中 ' + (cc.claimed ?? 0) + ' | 完成 ' + (cc.done ?? 0) + ' | 取消 ' + (cc.cancelled ?? 0) }] } },
    async execute() {
      const board = loadBoard(boardPath)
      const counts: Record<string, number> = { pending: 0, claimed: 0, done: 0, cancelled: 0 }
      for (const t of board.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
      const active = board.tasks.filter((t) => t.status === 'pending' || t.status === 'claimed')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      return { counts, active: JSON.parse(JSON.stringify(active)) }
    },
  }))
}
