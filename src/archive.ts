/**
 * archive.ts — 任务板终态归档的**读取层**（把「完成了什么」变回可查）。
 *
 * 背景（2026-09-22 实测）：`TERMINAL_RETAIN_DAYS = 0` ⇒ 完成即归档出板，
 * 于是 `taskboard_list {status:'done'}` **恒为空**；而归档文件躺在
 * `<boardDir>/archive/terminal-<YYYY-MM-DD>.json`（当时已有 9 个、今日 23KB），
 * **没有任何工具能读回**——`index.ts` 旧注释「可用 taskboard 工具回查」是假话。
 * 本模块就是那句假话的兑现。语义正本：`docs/semantic.md` §4.5 · I16。
 *
 * 分层：解析（`parseArchiveFile`）与聚合（`collectArchiveTasks`）是**纯函数**；
 * 只有 `readArchiveDir` 碰文件系统——纯层可离线测，这是本插件的一贯纪律。
 * @module dsh-agent-taskboard/archive
 */

/** 归档文件里的一条任务（保留原字段，外加来源文件名）。 */
export interface ArchiveTask {
  id: string
  title: string
  status: string
  priority?: string
  type?: string
  summary?: string
  createdAt?: string
  claimedAt?: string
  doneAt?: string
  updatedAt?: string
  /** 该条来自哪个归档文件（回查证据）。 */
  archivedFile: string
}

/** 归档文件的一个条目（清点用）。 */
export interface ArchiveFileInfo {
  file: string
  archivedAt: string
  count: number
}

/** 解析结果（坏文件不抛，转为可上报的错误——清点要能列出「哪些文件坏了」）。 */
export type ParseResult = { ok: true; tasks: ArchiveTask[]; archivedAt: string } | { ok: false; error: string }

/**
 * 解析一个归档文件的原文（纯函数）。
 * @param name - 文件名（作为 `archivedFile` 证据）
 * @param raw - 文件原文
 */
export function parseArchiveFile(name: string, raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, error: '顶层不是对象' }
  const obj = parsed as { archivedAt?: unknown; tasks?: unknown }
  if (!Array.isArray(obj.tasks)) return { ok: false, error: 'tasks 不是数组' }
  const tasks: ArchiveTask[] = []
  for (const item of obj.tasks) {
    if (item === null || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    if (typeof t.id !== 'string' || t.id === '') continue
    const entry: ArchiveTask = {
      id: t.id,
      title: typeof t.title === 'string' ? t.title : '',
      status: typeof t.status === 'string' ? t.status : 'unknown',
      archivedFile: name,
    }
    for (const key of ['priority', 'type', 'summary', 'createdAt', 'claimedAt', 'doneAt', 'updatedAt'] as const) {
      const v = t[key]
      if (typeof v === 'string') entry[key] = v
    }
    tasks.push(entry)
  }
  return { ok: true, tasks, archivedAt: typeof obj.archivedAt === 'string' ? obj.archivedAt : '' }
}

/** 归档任务的过滤条件。 */
export interface ArchiveFilter {
  /** 精确匹配任务 id。 */
  id?: string
  /** 大小写不敏感的子串（匹配标题或摘要）。 */
  keyword?: string
  /** 只看该终态。 */
  status?: string
  /** 返回上限（缺省 20）。 */
  limit?: number
}

/**
 * 过滤归档任务（纯函数）：先按条件筛，再按终态时刻倒序，最后截断。
 * @param tasks - 已聚合的归档任务
 * @param filter - 过滤条件
 */
export function filterArchiveTasks(tasks: readonly ArchiveTask[], filter: ArchiveFilter = {}): ArchiveTask[] {
  const keyword = (filter.keyword ?? '').trim().toLowerCase()
  const selected = tasks.filter((t) => {
    if (filter.id !== undefined && filter.id !== '' && t.id !== filter.id) return false
    if (filter.status !== undefined && filter.status !== '' && t.status !== filter.status) return false
    if (keyword !== '') {
      const hay = (t.title + ' ' + (t.summary ?? '')).toLowerCase()
      if (!hay.includes(keyword)) return false
    }
    return true
  })
  const at = (t: ArchiveTask): number => {
    for (const raw of [t.doneAt, t.updatedAt, t.createdAt]) {
      if (typeof raw === 'string' && raw !== '') {
        const ms = Date.parse(raw)
        if (Number.isFinite(ms)) return ms
      }
    }
    return 0
  }
  return selected.sort((a, b) => at(b) - at(a)).slice(0, filter.limit ?? 20)
}

/** 清点结果：按 id 去重后的全量任务 + 文件清单 + 坏文件。 */
export interface ArchiveInventory {
  files: ArchiveFileInfo[]
  tasks: ArchiveTask[]
  /** 解析失败的归档文件（名字 + 原因）——不静默跳过。 */
  corrupt: { file: string; error: string }[]
}

/**
 * 聚合一目录下的归档文件（纯函数：喂名字与原文，不碰磁盘）。
 *
 * 去重纪律：同一 id 可能出现在多个文件里（当日文件是「读旧 + 追加」合并写），
 * 保留 **`archivedFile` 名字最大**（即最近一日）的那条——文件名的日期段可字典序比较。
 * @param inputs - `{name, raw}` 列表
 */
export function collectArchiveTasks(inputs: readonly { name: string; raw: string }[]): ArchiveInventory {
  const files: ArchiveFileInfo[] = []
  const corrupt: { file: string; error: string }[] = []
  const byId = new Map<string, ArchiveTask>()
  for (const { name, raw } of inputs) {
    const parsed = parseArchiveFile(name, raw)
    if (!parsed.ok) {
      corrupt.push({ file: name, error: parsed.error })
      continue
    }
    files.push({ file: name, archivedAt: parsed.archivedAt, count: parsed.tasks.length })
    for (const task of parsed.tasks) {
      const prev = byId.get(task.id)
      if (prev === undefined || task.archivedFile > prev.archivedFile) byId.set(task.id, task)
    }
  }
  files.sort((a, b) => (a.file < b.file ? 1 : -1))
  return { files, tasks: [...byId.values()], corrupt }
}

/** 单文件大小上限（防误读巨型文件把上下文打爆）。 */
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024

/**
 * 读归档目录（唯一碰 IO 的函数）。目录不存在 ⇒ 空清单（首次使用是正常状态）。
 * @param dir - `<boardDir>/archive`
 * @param readFile - 注入的文件读取（缺省 `node:fs`；测试可替身）
 * @param listDir - 注入的目录列举（缺省 `node:fs`）
 * @throws Error 目录存在但无法列举时抛错（不静默返回空——否则「看不见归档」会被读成「没有归档」）
 */
export function readArchiveDir(
  dir: string,
  readFile: (p: string) => string,
  listDir: (p: string) => string[],
): ArchiveInventory {
  let names: string[]
  try {
    names = listDir(dir)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { files: [], tasks: [], corrupt: [] }
    throw new Error('归档目录无法列举（' + dir + '）：' + (e instanceof Error ? e.message : String(e)))
  }
  const targets = names.filter((n) => n.startsWith('terminal-') && n.endsWith('.json')).sort()
  const inputs: { name: string; raw: string }[] = []
  for (const name of targets) {
    try {
      const raw = readFile(dir + '/' + name)
      if (raw.length > MAX_ARCHIVE_BYTES) {
        inputs.push({ name, raw: '' })
        continue
      }
      inputs.push({ name, raw })
    } catch {
      inputs.push({ name, raw: '' })
    }
  }
  return collectArchiveTasks(inputs)
}
