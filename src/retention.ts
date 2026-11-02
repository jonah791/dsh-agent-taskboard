/**
 * 任务板终态轮转 —— 纯函数，可离线尸体测试。
 *
 * 事故（2026-09-13 主人：「而且任务板中完成的，你怎么不删啊」）：
 *   `.taskboard/tasks.json` 累积到 26 条，其中 **18 条 done 常驻**——`loadBoard`/`saveBoard` 没有任何
 *   终态处理，板面越长越难读，任务板作为「协调界面」的信噪比持续下降（AGENTS.md §5.14 rule 4：
 *   任务板是协调界面）。
 *
 * 纪律：
 *   1. 终态（done/cancelled）保留 `retainDays` 天供回看，超期**归档而非删除**（写 archive 文件，可回查）；
 *   2. 未终结任务（pending/claimed）**永不动**；
 *   3. 轮转幂等：同一输入重复执行结果一致，且不产生空归档文件。
 *
 * @module retention
 */

export interface RetentionTask {
  id: string
  status: string
  updatedAt?: string
  createdAt?: string
}

export interface RetentionOptions {
  nowMs: number
  retainDays?: number
}

export interface RetentionResult<T> {
  /** 留在板面上的任务（未终结 + 保留期内的终态） */
  keep: T[]
  /** 应归档的终态任务 */
  archived: T[]
}

const TERMINAL = new Set(['done', 'cancelled'])

function timestampOf(task: { updatedAt?: string; createdAt?: string }): number {
  const raw = task.updatedAt ?? task.createdAt
  if (typeof raw !== 'string' || raw.length === 0) return 0
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : 0
}

export function isTerminal(task: { status: string }): boolean {
  return TERMINAL.has(String(task.status))
}

/**
 * 把超期终态任务与在板任务分开。时间戳缺失的终态任务**保守保留**（宁留不误归档）。
 * 泛型化以兼容调用方自有的 Task 形状（无需索引签名）。
 */
export function splitTerminalForArchive<T extends RetentionTask>(
  tasks: readonly T[],
  options: RetentionOptions,
): RetentionResult<T> {
  const retainDays = options.retainDays ?? 3
  const cutoff = options.nowMs - retainDays * 86_400_000
  const keep: T[] = []
  const archived: T[] = []
  for (const task of tasks) {
    if (!isTerminal(task)) {
      keep.push(task)
      continue
    }
    const at = timestampOf(task)
    if (at === 0 || at > cutoff) keep.push(task)
    else archived.push(task)
  }
  return { keep, archived }
}

/**
 * 把新归档的条目**幂等**并入既有归档列表（按 `id` 去重）。
 *
 * 事故（2026-11-01）：轮转是**两步写**——先写归档文件、再写板面。若在两步之间被杀，
 * 板面里仍然留着已归档的终态任务；下次轮转会**把它们再归档一遍**。
 * 原来的 `[...prev, ...archived]` 直接拼接没有去重，于是归档文件里长出重复 id
 * （同一条任务在归档里出现两次，回查时看起来像两件事）。
 *
 * 修法的选择：**不引入事务**（那要求「两步都不发生」），而是让拼接**幂等**（「发生了也不出错」）。
 * 按 id 去重便宜得多，且不引入新的状态载体——事务治的是「不会发生」，去重治的是「发生了也没关系」，
 * 对这个场景后者足够。
 *
 * 顺序语义：`prev` 在前、`incoming` 中未出现过的在后。**不做重排**——
 * 归档是按写入顺序累积的历史，重排会让「第几次轮转进来的」这条信息消失。
 */
export function mergeArchived<T extends { id: string }>(
  prev: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(prev.map((t) => t.id))
  return [...prev, ...incoming.filter((t) => !seen.has(t.id))]
}
