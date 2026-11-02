/**
 * atomic-write.ts — 任务板的**唯一合法写入路径**。
 *
 * 为什么需要它：三处写入点原本各自 `writeFileSync(path, JSON.stringify(...))` 直接覆盖目标文件。
 * 写到一半断电 / 进程被杀 ⇒ 板上留下半个 JSON；下次 `JSON.parse` 抛错，**整块板不可读**。
 *
 * 修法：写同目录 tmp → rename。同分区的 `rename` 是原子的——
 * 读方要么看到旧文件、要么看到新文件，**不会看到中间态**。
 *
 * ⚠ 为什么**不用 fsync**（原方案写过、被审核否掉，这里记下结论）：
 *   - 进程被杀**不会丢页缓存**：`SIGKILL` 之后内核仍会把已写数据落盘。
 *     所以「写到 tmp 后 rename 前 SIGKILL」这个测试证明的是 **rename 的原子性**，
 *     不是 **fsync 的持久性**（后者需要掉电或内核崩溃才能验）。留一个测不到自己主张的调用，
 *     将来读的人会以为持久性被保证了。
 *   - 本仓已有 8 个插件用同一模式且都不带 fsync（`dsh-life-core/src/state.ts`、
 *     `dsh-agent-self-rewrite/src/store.ts`、`dsh-engagement/src/store.ts`、`dsh-longhorizon/src/store.ts`、
 *     `manor/src/hold-store.ts` 等）。只给 taskboard 加更强的保证，需要一个能说清的理由，而我没有。
 *   - 真需要断电级持久性时，该有**掉电测试**与目录 fsync，而不是一句注释。那时再单独评估。
 *
 * ⚠ 它**治不了**「两个实例同时写」：各自原子替换的后果是**后写者整块覆盖前写者**（丢更新）。
 *   那不是撕裂写，原子写帮不上。本机是单实例，故不为此引入锁；若将来多实例并发写，
 *   要的是租约或版本号，不是这里。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** 落盘的缩进（与原三处写入点保持一致：2 空格，人可读可 diff）。 */
const INDENT = 2

/**
 * 写文件尾部追加的 fsync 开关。
 *
 * **恒为 false**，且这是刻意的：见文件头注。保留这个常量是为了让「有人想打开它」时
 * 有一个显式位置，而不是把 `fsyncSync` 悄悄散回各个调用点。
 */
const USE_FSYNC = false

/**
 * 原子写入一个 JSON 文件。
 *
 * 步骤：确保父目录存在 → 写 `<path>.tmp-<pid>-<now>` → (可选) fsync → rename 覆盖目标。
 * 任一步失败都会清掉 tmp 并**把异常抛出去**——静默兜底会让调用方以为写成功了。
 *
 * @param path 目标文件绝对路径
 * @param value 要序列化的值（`JSON.stringify(value, null, 2)`）
 * @throws 序列化失败 / 临时文件打不开 / rename 失败
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })

  // tmp 名带 pid 与时刻：同进程并发写不会撞名，崩溃遗留的 tmp 也能看出是哪个进程的
  const tmp = path + '.tmp-' + String(process.pid) + '-' + String(Date.now())
  const text = JSON.stringify(value, null, INDENT)

  let fd: number | undefined
  try {
    fd = openSync(tmp, 'w')
    writeSync(fd, text, null, 'utf8')
    if (USE_FSYNC) fsyncSync(fd)
  } catch (err) {
    try { if (fd !== undefined) closeSync(fd) } catch { /* 关不掉不影响报错 */ }
    try { unlinkSync(tmp) } catch { /* tmp 可能压根没建出来 */ }
    throw err
  }

  try {
    closeSync(fd)
  } catch {
    // 关不掉仍可尝试 rename；但**不能吞掉后续可能的失败**
  }

  try {
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* 同上 */ }
    throw err
  }
}
