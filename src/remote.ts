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
// 与工具面**同源**的状态机（I12/I14/I17）：白名单流转 + 完成摘要文本形状
import { assertTransition, completionMemoryText } from './statemachine.ts'
// 板面读写单一真源（I11）——不再在本文件里重写一份宽松读
import { readBoardLenient, readBoardStrict } from './board.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-taskboard': { kind: 'dsh-agent-taskboard' }
  }
}

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

  /**
   * 读板面（**严格**，I11 同源纪律）——实现见 `src/board.ts`（单一真源）。
   *
   * 旧实现 `catch { return [] }` 与随后的 `save()` 组合 = **静默数据销毁**：
   * 文件损坏时读到空数组，一次 GUI 操作就把整块板覆盖成一条。
   * 写路径必须用严格读：读失败即拒绝这次写。
   */
  private load(): Task[] {
    return readBoardStrict<Task>(this.cfg.boardFile, (p) => readFileSync(p, 'utf8'))
  }

  /** 读路径降级封装：只读面（列表/计数）坏数据时退化为空，不抛给 UI。 */
  private loadForRead(): Task[] {
    return readBoardLenient<Task>(this.cfg.boardFile, (p) => readFileSync(p, 'utf8'))
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
          agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-agent-taskboard' } }), 'next-turn', false)
        }
      } else if (this.cfg.mainSessionId) {
        // 无 list 接口时回退单会话
        const agent = (this.ctx as any).agents?.get?.(this.cfg.mainSessionId as SessionId) as Agent | undefined
        agent?.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-agent-taskboard' } }), 'next-turn', false)
      }
    } catch { /* 通知失败静默 */ }
  }

  private publicTask(t: Task) {
    // JSON round-trip：剔除 undefined 字段（gateway 边界校验拒绝 undefined 值）
    return JSON.parse(JSON.stringify({
      id: t.id, title: t.title, description: t.description, type: t.type ?? 'short', priority: t.priority,
      tags: t.tags, status: t.status, assignee: t.assignee,
      createdAt: t.createdAt, claimedAt: t.claimedAt, doneAt: t.doneAt, summary: t.summary,
      // 状态机 v2：GUI 也要看得见「多久没动」与阻塞承诺，否则界面上「claimed 5 天」和「5 分钟」一样
      updatedAt: t.updatedAt, blockedReason: t.blockedReason, nextAction: t.nextAction, reviewAt: t.reviewAt,
    }))
  }

  /** 完成摘要回流记忆库（I17：与工具面共用 `completionMemoryText` 的文本形状）。失败静默。 */
  private rememberCompletion(task: Task, summary: string): void {
    try {
      const api = (this.ctx as unknown as { memoryApi?: { remember(input: { text: string; kind?: string; tags?: string[]; key?: string }): Promise<unknown> } }).memoryApi
      if (api === undefined || !task.title) return
      const text = completionMemoryText(task, summary)
      void api.remember({ text, kind: task.type === 'long' ? 'episodic' : 'knowledge', tags: ['任务板', task.id], key: 'task-' + task.id }).catch(() => { /* 回流失败静默 */ })
    } catch { /* 回流失败不阻塞任务完成 */ }
  }

  /** 全量列表（按创建时间倒序）。 */
  @Remote('list')
  list(): { tasks: ReturnType<TaskboardRemoteService['publicTask']>[] } {
    return { tasks: this.loadForRead().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((t) => this.publicTask(t)) }
  }

  /** 看板计数（含 `blocked`——GUI 不显示阻塞态就等于把它藏起来了）。 */
  @Remote('status')
  status(): { counts: Record<string, number> } {
    const counts: Record<string, number> = { pending: 0, claimed: 0, blocked: 0, done: 0, cancelled: 0 }
    for (const t of this.loadForRead()) counts[t.status] = (counts[t.status] ?? 0) + 1
    return { counts }
  }

  /**
   * 状态流转 + 发布（claim/complete/cancel/reopen/post/delete 统一入口，由 UI 调用）。
   *
   * 与工具面**同源**（I12/I14/I17）：
   *  · 流转经 `assertTransition` **白名单**校验——旧实现能把终态直接改成 `pending`（静默复活）；
   *  · 每次变更刷新 `updatedAt`——否则界面上的「多久没动」永远算不出来；
   *  · `complete` 也回流记忆库（与工具面共用 `completionMemoryText` 的文本形状）。
   * 读板面用**严格** `load()`：读失败即拒绝这次写，杜绝「读到空板 → 覆盖整板」。
   */
  @Remote('mutate')
  mutate(req: { taskId?: string; action: 'claim' | 'complete' | 'cancel' | 'reopen' | 'delete' | 'post'; title?: string; description?: string; type?: string; priority?: string; summary?: string; assignee?: string; reason?: string }): { ok: boolean; error?: string; task?: ReturnType<TaskboardRemoteService['publicTask']> } {
    let tasks: Task[]
    try {
      tasks = this.load()
    } catch (e) {
      return { ok: false, error: 'board-unreadable：' + (e instanceof Error ? e.message : String(e)) }
    }
    const nowIso = new Date().toISOString()
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
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      tasks.push(task)
      this.save(tasks)
      this.notifyPost(task)
      return { ok: true, task: this.publicTask(task) }
    }
    const task = tasks.find((t) => t.id === req.taskId)
    if (!task) return { ok: false, error: 'task-not-found' }
    const from = task.status
    let completed: string | undefined
    try {
      switch (req.action) {
        case 'delete': {
          const at = tasks.indexOf(task)
          if (at >= 0) tasks.splice(at, 1)
          this.save(tasks)
          return { ok: true, task: this.publicTask(task) }
        }
        case 'claim': {
          if (from !== 'pending') return { ok: false, error: 'not-pending' }
          assertTransition(from, 'claimed')
          task.status = 'claimed'
          task.assignee = req.assignee ?? 'alice'
          task.claimedAt = nowIso
          break
        }
        case 'complete': {
          if (from !== 'claimed') return { ok: false, error: 'not-claimed' }
          assertTransition(from, 'done')
          task.status = 'done'
          task.summary = req.summary ?? ''
          task.doneAt = nowIso
          completed = task.summary
          break
        }
        case 'cancel': {
          if (from === 'done' || from === 'cancelled') return { ok: false, error: 'terminal' }
          assertTransition(from, 'cancelled')
          task.status = 'cancelled'
          task.summary = req.summary ?? ''
          break
        }
        case 'reopen': {
          if (from !== 'done' && from !== 'cancelled') return { ok: false, error: 'not-terminal' }
          // 终态重开必须带 reason（I12）：缺 reason 时 assertTransition 抛错，原样回给 UI
          assertTransition(from, 'pending', { reason: req.reason })
          task.status = 'pending'
          task.claimedAt = undefined
          task.doneAt = undefined
          task.summary = undefined
          break
        }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    task.updatedAt = nowIso
    this.save(tasks)
    if (completed !== undefined) this.rememberCompletion(task, completed)
    return { ok: true, task: this.publicTask(task) }
  }
}
