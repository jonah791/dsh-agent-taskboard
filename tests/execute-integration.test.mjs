/**
 * execute 层集成测试（t-a8e889a6）
 *
 * 为什么要它：本包 `tests/` 原有 6 个文件**全是纯模块测试**，而工具面的全部行为住在
 * `src/index.ts` 的 execute 闭包里 —— 那里**零自动回归**。这正是 t-4ffcbc0f
 *（同状态 `update` 静默吞掉 blocked 三件套、却返回「任务已更新」）能拖 1.6 天才暴露的原因：
 * 缺陷在 execute 分支里，单测够不着；当时只靠现场端到端验收抓住。
 *
 * 纪律（沿用本仓既有判据）：
 *  - mock **只到 ctx 边界**（plugin / agents / effect / tools.register），board 走**真实文件 I/O**
 *  - 断言**产物字段**（回读盘上的 board 文件），**绝不断言「返回 ok」**——那正是缺陷的伪装
 *  - 「必须检出」的断言一律配**对照组**（该沉默的必须沉默）
 *
 * ⚠ `execute` 是 **async**：调用必须 `await`，否则拿到的是 Promise（初版即栽在这里——
 *   `id` 解构出 undefined，后续按 id 查找自然全空）。
 *
 * 运行：`node --test tests/execute-integration.test.mjs`（先 `npm run build`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** 工具执行上下文：`callerSessionId` / `assigneeFor` 读的是 `exec.agent.session.id` */
const EXEC = { agent: { session: { id: 's-int-main' } } }

/**
 * 起一个隔离的 board：真实 `apply` + 真实文件 I/O，mock 只在 ctx 边界。
 * 周期扫在实现里已 `unref()`，不会阻止测试进程退出。
 */
function bootBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-exec-int-'))
  const boardFile = join(dir, 'tasks.json')
  const tools = new Map()
  const ctx = {
    plugin: () => {},
    agents: { get: () => undefined, list: () => [] }, // 通知路径降级为空集（本测试不覆盖通知）
    effect: () => {},
    tools: { register: (def) => { tools.set(def.name, def) } },
  }
  apply(ctx, { boardFile, mainSessionId: 's-int-main', notifyOnPost: false })
  return {
    boardFile,
    tools,
    /** execute 是 async —— 必须 await，否则拿到 Promise */
    call: (name, args) => tools.get(name).execute(args, EXEC),
    /** ★ 判据取值处：读**盘上的 board 文件**，不是读返回值 */
    taskFrom: (id) => JSON.parse(readFileSync(boardFile, 'utf8')).tasks.find((t) => t.id === id),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('集成 t-4ffcbc0f：同状态 blocked 更新必须落盘（断言产物字段，而非「返回 ok」）', async () => {
  const b = bootBoard()
  try {
    const { id } = await b.call('taskboard_post', { title: '集成夹具', type: 'short', priority: 'normal' })
    assert.match(id, /^t-[0-9a-f]{8}$/, 'post 返回的 id 形状')
    await b.call('taskboard_claim', { taskId: id })
    await b.call('taskboard_block', { taskId: id, reason: 'R1', nextAction: 'N1', reviewAt: '+2h' })

    const t1 = b.taskFrom(id)
    assert.equal(t1.status, 'blocked')
    assert.equal(t1.blockedReason, 'R1', '首次流转必须写入三件套')
    assert.equal(t1.nextAction, 'N1')

    // ★ 被测路径：任务**已经是 blocked** 时再传全新三件套。
    //   旧实现在 `next === task.status` 分支里什么都不做，却返回「任务已更新」。
    await b.call('taskboard_update', { taskId: id, status: 'blocked', blockedReason: 'R2', nextAction: 'N2', reviewAt: '+5h' })

    const t2 = b.taskFrom(id)
    assert.equal(t2.blockedReason, 'R2', '同状态更新必须写入 blockedReason（t-4ffcbc0f）')
    assert.equal(t2.nextAction, 'N2', '同状态更新必须写入 nextAction')
    assert.notEqual(t2.reviewAt, t1.reviewAt, 'reviewAt 必须前进')
  } finally { b.cleanup() }
})

test('集成 对照组：同状态但**不传**三件套 ⇒ 产物字段必须保持不变（该沉默的必须沉默）', async () => {
  const b = bootBoard()
  try {
    const { id } = await b.call('taskboard_post', { title: '对照夹具' })
    await b.call('taskboard_claim', { taskId: id })
    await b.call('taskboard_block', { taskId: id, reason: 'R', nextAction: 'N', reviewAt: '+2h' })
    const before = b.taskFrom(id)

    await b.call('taskboard_update', { taskId: id, status: 'blocked' })

    const after = b.taskFrom(id)
    assert.deepEqual(
      { r: after.blockedReason, n: after.nextAction, v: after.reviewAt },
      { r: before.blockedReason, n: before.nextAction, v: before.reviewAt },
      '不传三件套时不得清空或改写既有值（修复不得变成「无条件覆盖」）',
    )
  } finally { b.cleanup() }
})

test('集成：非法流转必须抛错且**不落盘**（白名单在 execute 层同样生效）', async () => {
  const b = bootBoard()
  try {
    const { id } = await b.call('taskboard_post', { title: '白名单夹具' }) // pending，未 claim
    await assert.rejects(
      () => b.call('taskboard_update', { taskId: id, status: 'done' }),
      /非法状态流转|claimed/,
    )
    assert.equal(b.taskFrom(id).status, 'pending', '抛错后盘上状态不得被改动')
  } finally { b.cleanup() }
})
