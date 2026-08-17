/**
 * Taskboard Remote Service：client UI 的数据通道（Typert Gateway 导出）。
 * @module dsh-agent-taskboard/remote
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Task } from './index.ts'

export interface TaskboardRemoteConfig {
  boardFile: string
  /** 宿主主会话 id（新任务提醒目标）。 */
  mainSessionId?: string
  /** UI 发布新任务时是否给主会话发排队通知（wakeup=false，不打断）。 */
  notifyOnPost?: boolean
}

/** Client UI 可调用的任务板 Remote：只读列表 + 状态流转。 */
export class TaskboardRemoteService extends TypertRemoteService {
  static inject = []
  constructor(ctx: Context, private readonly cfg: TaskboardRemoteConfig) {
    // namespace 必须与 client descriptor 一致（'taskboard'），否则 /api/taskboard/* 404
    super(ctx, 'taskboardRemote', { namespace: 'taskboard' })
  }

  private load(): Task[] {
    try {
      const raw = readFileSync(this.cfg.boardFile, 'utf8')
      const board = JSON.parse(raw) as { tasks: Task[] }
      return board.tasks ?? []
    } catch {
      return []
    }
  }

  private save(tasks: Task[]): void {
    mkdirSync(dirname(this.cfg.boardFile), { recursive: true })
    writeFileSync(this.cfg.boardFile, JSON.stringify({ tasks }, null, 2), 'utf8')
  }

  /** UI 发布新任务 → 跨会话广播排队通知（wakeup=false：不打断，任何会话空闲时自主领取）。 */
  private notifyPost(task: Task): void {
    if (!this.cfg.notifyOnPost) return
    try {
      const text = '【任务板】新任务：' + task.title + '（' + task.id + '，' + (task.type === 'long' ? '长期' : '短期') + '，优先级 ' + task.priority + '）——空闲时自主领取处理。'
      const agents = (this.ctx as any).agents?.list?.() as Agent[] | undefined
      if (Array.isArray(agents)) {
        for (const agent of agents) {
          agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-taskboard' } }), 'next-turn', false)
        }
      } else if (this.cfg.mainSessionId) {
        // 无 list 接口时回退单会话
        const agent = (this.ctx as any).agents?.get?.(this.cfg.mainSessionId as SessionId) as Agent | undefined
        agent?.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-taskboard' } }), 'next-turn', false)
      }
    } catch { /* 通知失败静默 */ }
  }

  private publicTask(t: Task) {
    // JSON round-trip：剔除 undefined 字段（gateway 边界校验拒绝 undefined 值）
    return JSON.parse(JSON.stringify({
      id: t.id, title: t.title, description: t.description, type: t.type ?? 'short', priority: t.priority,
      tags: t.tags, status: t.status, assignee: t.assignee,
      createdAt: t.createdAt, claimedAt: t.claimedAt, doneAt: t.doneAt, summary: t.summary,
    }))
  }

  /** 全量列表（按创建时间倒序）。 */
  @Remote('list')
  list(): { tasks: ReturnType<TaskboardRemoteService['publicTask']>[] } {
    return { tasks: this.load().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((t) => this.publicTask(t)) }
  }

  /** 看板计数。 */
  @Remote('status')
  status(): { counts: Record<string, number> } {
    const counts: Record<string, number> = { pending: 0, claimed: 0, done: 0, cancelled: 0 }
    for (const t of this.load()) counts[t.status] = (counts[t.status] ?? 0) + 1
    return { counts }
  }

  /** 状态流转 + 发布（claim/complete/cancel/reopen/post 统一入口，由 UI 调用）。 */
  @Remote('mutate')
  mutate(req: { taskId?: string; action: 'claim' | 'complete' | 'cancel' | 'reopen' | 'delete' | 'post'; title?: string; description?: string; type?: string; priority?: string; summary?: string; assignee?: string }): { ok: boolean; error?: string; task?: ReturnType<TaskboardRemoteService['publicTask']> } {
    const tasks = this.load()
    if (req.action === 'post') {
      const title = (req.title ?? '').trim()
      if (!title) return { ok: false, error: 'title-required' }
      const task: Task = {
        id: 't-' + randomUUID().slice(0, 8),
        title,
        description: req.description ?? '',
        type: (req.type === 'short' || req.type === 'long' ? req.type : 'short') as Task['type'],
        priority: ((req.priority ?? 'normal') as Task['priority']),
        tags: [],
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      tasks.push(task)
      this.save(tasks)
      this.notifyPost(task)
      return { ok: true, task: this.publicTask(task) }
    }
    const task = tasks.find((t) => t.id === req.taskId)
    if (!task) return { ok: false, error: 'task-not-found' }
    switch (req.action) {
      case 'delete': {
        const at = tasks.indexOf(task)
        if (at >= 0) tasks.splice(at, 1)
        this.save(tasks)
        return { ok: true, task: this.publicTask(task) }
      }
      case 'claim':
        if (task.status !== 'pending') return { ok: false, error: 'not-pending' }
        task.status = 'claimed'
        task.assignee = req.assignee ?? 'alice'
        task.claimedAt = new Date().toISOString()
        break
      case 'complete':
        if (task.status !== 'claimed') return { ok: false, error: 'not-claimed' }
        task.status = 'done'
        task.summary = req.summary ?? ''
        task.doneAt = new Date().toISOString()
        break
      case 'cancel':
        if (task.status === 'done' || task.status === 'cancelled') return { ok: false, error: 'terminal' }
        task.status = 'cancelled'
        task.summary = req.summary ?? ''
        break
      case 'reopen':
        if (task.status === 'done' || task.status === 'cancelled') {
          task.status = 'pending'
          task.claimedAt = undefined
          task.doneAt = undefined
          task.summary = undefined
        } else return { ok: false, error: 'not-terminal' }
        break
    }
    this.save(tasks)
    return { ok: true, task: this.publicTask(task) }
  }
}
