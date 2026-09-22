/**
 * board.ts — 任务板文件读写的**单一真源**（I11 `[MUST]`）。
 *
 * 事故（2026-09-22 取证）：工具面与 GUI 面各写了一份 `load`，两份都是
 * `catch { return [] }`。这个「宽容」与随后的 `save()` 组合起来是**静默数据销毁**：
 * 文件损坏时读到空板 → 一次 `post`/`claim` 就把整块板覆盖成「只有刚写的那一条」。
 * 而板面同时装着主人发布的任务与我领取的活。
 *
 * 纪律：**读路径可以退化，写路径绝不可以**。所以这里只提供严格读；
 * 只读面（列表/计数）要用宽松版就显式调用 `readBoardLenient` —— 让「降级」是一个**选择**，
 * 不是一个默认（旧实现的错就在于把降级写成了唯一路径）。
 *
 * 为什么要单独一层：这段逻辑原本在 `index.ts` 与 `remote.ts` 各一份（同一件事两种写法），
 * 且因为藏在 `apply()` 闭包里**无法被单测触达**——最高危的修复反而没有判据。
 * @module dsh-agent-taskboard/board
 */

/** `readFile` 的注入形状（默认实现传 `node:fs` 的 `readFileSync`，测试可传替身）。 */
export type ReadFile = (path: string) => string

/** 取错误文本（ENOENT 之类的 code 也带上，便于一次判对）。 */
function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code !== undefined ? code + ': ' + e.message : e.message
  }
  return String(e)
}

/**
 * 严格读板面（I11）：**文件不存在**（ENOENT，首次使用是正常状态）⇒ 空数组；其余一律抛错。
 * @param path - 板面文件路径
 * @param readFile - 文件读取（注入）
 * @throws Error 解析失败 / IO 错误 / 顶层形状异常（消息含路径与原因）
 */
export function readBoardStrict<T>(path: string, readFile: ReadFile): T[] {
  let raw: string
  try {
    raw = readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('任务板读取失败（' + path + '）：' + errText(e))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error('任务板解析失败（' + path + '）——拒绝以空板继续（否则下一次写入会覆盖整板）：' + errText(e))
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    throw new Error('任务板结构异常（' + path + '）：顶层缺少 tasks 数组——拒绝以空板继续')
  }
  return (parsed as { tasks: T[] }).tasks
}

/**
 * 宽松读（**只读面专用**）：任何失败都退化为空数组。
 * ⚠ 只允许用在「不写盘」的路径上（列表/计数）；写路径必须用 `readBoardStrict`，
 * 否则退化的空板会被写回去，等于把整块板删空。
 * @param path - 板面文件路径
 * @param readFile - 文件读取（注入）
 */
export function readBoardLenient<T>(path: string, readFile: ReadFile): T[] {
  try {
    return readBoardStrict<T>(path, readFile)
  } catch {
    return []
  }
}
