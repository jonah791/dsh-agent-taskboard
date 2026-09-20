/**
 * schedule.test.mjs — 时间提醒与定时任务的**离线判据**（跑 lib 产物，与运行时同源）。
 *
 * 覆盖 semantic.md 的 A10–A15 + 不变量 I7–I10：
 *   A10 时间解析四形态 + 非法输入抛错 · A11 到点触发一次不重复（I8）· A12 重复任务不堆积（I9）
 *   A13 终态不触发 · A14 扫路径必包 guarded（§5.24 源码级契约）· A15 启动/离线窗口由 sweepOnce 补上
 * 全部零网络、零磁盘（IO 一律注入假实现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWhen, isDue, advanceNext, collectDue, scheduledAt, sweepOnce, reminderText } from '../lib/schedule.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const T0 = Date.parse('2026-09-20T12:00:00.000Z')

// ───────────────────────── A10 时间解析 ─────────────────────────

test('A10 parseWhen：ISO 8601', () => {
  assert.equal(parseWhen('2026-09-20T13:30:00.000Z', T0), Date.parse('2026-09-20T13:30:00.000Z'))
})

test('A10 parseWhen：相对偏移（s/m/h/d）', () => {
  assert.equal(parseWhen('+30m', T0), T0 + 30 * 60_000)
  assert.equal(parseWhen('+2h', T0), T0 + 2 * 3_600_000)
  assert.equal(parseWhen('+1d', T0), T0 + 86_400_000)
  assert.equal(parseWhen('+90s', T0), T0 + 90_000)
  assert.equal(parseWhen('  +15m  ', T0), T0 + 15 * 60_000, '两侧空白应被容忍')
})

test('A10 parseWhen：HH:MM —— 未过取当日、已过顺延次日', () => {
  const local = new Date(T0)
  const future = new Date(T0); future.setHours(23, 30, 0, 0)
  const past = new Date(T0); past.setHours(0, 1, 0, 0)
  // 若本机时区使 23:30 仍晚于 now，则应等于当日 23:30；否则顺延次日 23:30
  const got = parseWhen('23:30', T0)
  const sameDay = new Date(T0); sameDay.setHours(23, 30, 0, 0)
  assert.equal(got, sameDay.getTime() > T0 ? sameDay.getTime() : sameDay.getTime() + 86_400_000)
  const gotPast = parseWhen('00:01', T0)
  assert.equal(gotPast, past.getTime() + 86_400_000, '已过的时刻必须顺延到次日（不落到过去）')
  assert.ok(gotPast > T0)
  assert.ok(Number.isFinite(local.getTime()) && Number.isFinite(future.getTime()))
})

test('A10 parseWhen：YYYY-MM-DD HH:MM（本地时区）', () => {
  const got = parseWhen('2026-12-31 23:59', T0)
  const want = new Date(2026, 11, 31, 23, 59, 0, 0).getTime()
  assert.equal(got, want)
})

test('A10 parseWhen：非法输入**抛错**（绝不静默取 now）', () => {
  for (const bad of ['', '   ', 'nonsense', '+-5m', '+0m', '25:00', '12:99', '2026-13-99 99:99x', '+5y']) {
    assert.throws(() => parseWhen(bad, T0), /时间不能为空|必须为正整数|非法时刻|无法识别|非法日期时间|非法 ISO/, `应拒绝：${JSON.stringify(bad)}`)
  }
})

// ───────────────────────── A11/A12/A13 触发裁决 ─────────────────────────

test('A11 到点触发一次：lastFiredAt >= nextAt 后不再触发（I8）', () => {
  const t = { id: 't-1', title: 'A', status: 'pending', nextAt: new Date(T0 - 60_000).toISOString() }
  assert.equal(isDue(t, T0), true, '已过点且未触发 ⇒ 该触发')
  const fired = { ...t, lastFiredAt: t.nextAt }
  assert.equal(isDue(fired, T0), false, '同一 nextAt 已触发过 ⇒ 不再触发')
  const firedLater = { ...t, lastFiredAt: new Date(T0 + 1000).toISOString() }
  assert.equal(isDue(firedLater, T0), false, 'lastFiredAt 晚于 nextAt 同样压制')
})

test('A11 未到点不触发', () => {
  assert.equal(isDue({ id: 't', title: 'A', status: 'pending', nextAt: new Date(T0 + 60_000).toISOString() }, T0), false)
  assert.equal(isDue({ id: 't', title: 'A', status: 'pending' }, T0), false, '无提醒字段 ⇒ 永不触发')
})

test('A13 终态任务不再触发', () => {
  const at = new Date(T0 - 60_000).toISOString()
  assert.equal(isDue({ id: 't', title: 'A', status: 'done', nextAt: at }, T0), false)
  assert.equal(isDue({ id: 't', title: 'A', status: 'cancelled', nextAt: at }, T0), false)
  assert.equal(collectDue([{ id: 't', title: 'A', status: 'done', nextAt: at }], T0).length, 0)
})

test('A12 重复任务不堆积：错过 N 轮只前进一次（I9）', () => {
  const from = T0 - 5 * 10 * 60_000 // 5 轮（每 10 分钟）之前的时刻
  const next = advanceNext(from, 10, T0)
  assert.ok(next !== null && next > T0, 'nextAt 必须严格晚于 now')
  const step = 10 * 60_000
  assert.equal((next - from) % step, 0, '必须落在原周期格点上')
  assert.ok(next - T0 <= step, '只前进到下一次（不补偿堆积）')
  // 一次性任务：无下一次
  assert.equal(advanceNext(from, undefined, T0), null)
  assert.equal(advanceNext(from, 0, T0), null)
  assert.equal(advanceNext(from, -5, T0), null)
})

test('collectDue：按应触发时刻升序（先到点先提醒）', () => {
  const mk = (id, ms) => ({ id, title: id, status: 'pending', nextAt: new Date(ms).toISOString() })
  const due = collectDue([mk('late', T0 - 1000), mk('early', T0 - 60_000), mk('future', T0 + 60_000)], T0)
  assert.deepEqual(due.map((t) => t.id), ['early', 'late'])
})

test('scheduledAt：优先 nextAt，退化到 remindAt；坏值 → null', () => {
  assert.equal(scheduledAt({ id: 'a', title: 'a', status: 'pending', remindAt: new Date(T0).toISOString() }), T0)
  assert.equal(scheduledAt({ id: 'a', title: 'a', status: 'pending', remindAt: 'x', nextAt: new Date(T0).toISOString() }), T0)
  assert.equal(scheduledAt({ id: 'a', title: 'a', status: 'pending', nextAt: 'not-a-date' }), null)
})

// ───────────────────────── A15 sweepOnce（含 I8/I9 落盘与失败不吞）─────────────────────────

function board(tasks) { return { tasks } }

test('A15 sweepOnce：到点 → 投递一次 + 写回 lastFiredAt/fireCount + 一次性不动 nextAt', () => {
  const b = board([{ id: 't-1', title: '一次性', status: 'pending', nextAt: new Date(T0 - 1000).toISOString() }])
  const delivered = []
  const traces = []
  let saved = 0
  const r = sweepOnce({
    nowMs: T0,
    load: () => b,
    save: () => { saved += 1 },
    deliver: (t, text) => { delivered.push([t.id, text]); return 'bound' },
    trace: (e, f) => traces.push([e, f]),
  })
  assert.deepEqual({ due: r.due, fired: r.fired, failed: r.failed }, { due: 1, fired: 1, failed: 0 })
  assert.equal(delivered.length, 1)
  assert.ok(delivered[0][1].includes('一次性'), '提醒文案应含任务标题')
  assert.ok(delivered[0][1].includes('不代做'), '文案必须说明「插件不代做」（I7 语义可见）')
  assert.equal(b.tasks[0].fireCount, 1)
  assert.equal(b.tasks[0].lastFiredAt, new Date(T0).toISOString())
  assert.equal(b.tasks[0].nextAt, new Date(T0 - 1000).toISOString(), '一次性任务 nextAt 不变（由 lastFiredAt 压制重触发）')
  assert.equal(saved, 1, '只在真有触发时落盘一次')
  assert.ok(traces.some(([e]) => e === 'deliver'), '投递必须留痕')
})

test('A15 sweepOnce：幂等——同一轮重复扫不重复投递（I8）', () => {
  const b = board([{ id: 't-1', title: 'x', status: 'pending', nextAt: new Date(T0 - 1000).toISOString() }])
  let n = 0
  const deps = { nowMs: T0, load: () => b, save: () => {}, deliver: () => { n += 1; return 'bound' }, trace: () => {} }
  sweepOnce(deps)
  sweepOnce(deps)
  assert.equal(n, 1, '第二次扫必须不发（否则就是重复提醒缺陷）')
})

test('A12/A15 sweepOnce：周期任务触发后 nextAt 前进到未来（不堆积）', () => {
  const at = new Date(T0 - 3 * 60 * 60_000).toISOString() // 3 小时前
  const b = board([{ id: 't-1', title: '每 30 分钟', status: 'claimed', nextAt: at, repeatMinutes: 30 }])
  const r = sweepOnce({ nowMs: T0, load: () => b, save: () => {}, deliver: () => 'broadcast', trace: () => {} })
  assert.equal(r.fired, 1)
  const next = Date.parse(b.tasks[0].nextAt)
  assert.ok(next > T0, 'nextAt 必须已前进到未来')
  assert.ok(next - T0 <= 30 * 60_000, '只前进一格，不补偿 6 轮')
  assert.equal(r.failed, 0)
})

test('A15 sweepOnce：投递失败**不改状态**（下轮重试）+ 留痕（不静默吞）', () => {
  const before = new Date(T0 - 1000).toISOString()
  const b = board([{ id: 't-1', title: 'x', status: 'pending', nextAt: before }])
  const traces = []
  const r = sweepOnce({ nowMs: T0, load: () => b, save: () => { throw new Error('不该落盘') }, deliver: () => 'failed', trace: (e) => traces.push(e) })
  assert.equal(r.failed, 1)
  assert.equal(r.fired, 0)
  assert.equal(b.tasks[0].lastFiredAt, undefined, '失败不得标记为已提醒')
  assert.equal(b.tasks[0].nextAt, before, '失败不得挪动 nextAt')
  assert.ok(traces.includes('deliver-error'), '失败必须留痕')
  // 下一轮（投递恢复）应重试成功
  const r2 = sweepOnce({ nowMs: T0 + 1000, load: () => b, save: () => {}, deliver: () => 'bound', trace: () => {} })
  assert.equal(r2.fired, 1, '重试必须能成功')
})

test('sweepOnce：无可触发项时零 IO（不落盘、不投递）', () => {
  const b = board([{ id: 't-1', title: 'x', status: 'pending', nextAt: new Date(T0 + 60_000).toISOString() }])
  let saved = 0, delivered = 0
  const r = sweepOnce({ nowMs: T0, load: () => b, save: () => { saved += 1 }, deliver: () => { delivered += 1; return 'bound' }, trace: () => {} })
  assert.deepEqual({ due: r.due, fired: r.fired }, { due: 0, fired: 0 })
  assert.equal(saved, 0)
  assert.equal(delivered, 0)
})

test('sweepOnce：坏板（tasks 非数组）不崩', () => {
  const r = sweepOnce({ nowMs: T0, load: () => ({}), save: () => {}, deliver: () => 'bound', trace: () => {} })
  assert.equal(r.due, 0)
})

test('reminderText：周期任务带「下次」时间；一次性不带', () => {
  const one = reminderText({ id: 't', title: 'T', status: 'pending', priority: 'high' }, T0, undefined)
  assert.ok(one.includes('高') === false && one.includes('high'))
  const rep = reminderText({ id: 't', title: 'T', status: 'pending' }, T0, 15)
  assert.ok(rep.includes('周期 15 分钟'))
  assert.ok(rep.includes('下次'))
})

// ───────────────────────── A14 源码级契约（§5.24 回归）─────────────────────────

test('A14 唯一触发执行点在 guarded 内 + 定时器回调走它（源码级契约）', () => {
  const src = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8')
  assert.match(src, /guarded\('sweep'/, '扫必须包 guarded（逃逸异常曾杀死宿主 web）')
  const lines = src.split('\n')
  const timerLine = lines.find((l) => l.includes('setInterval('))
  assert.ok(timerLine !== undefined, '应存在周期扫定时器')
  assert.ok(timerLine.includes('doSweep'), '定时器回调必须走 doSweep（唯一执行点），不得内联逻辑')
  assert.ok(/ctx\.effect\(/.test(src), '定时器必须有清理（ctx.effect）')
  assert.ok(/unref/.test(src), '定时器应 unref（不阻止进程退出）')
})

test('A14 调度层不含「自动执行任务」的接线（I7 根边界）', () => {
  // ⚠ 先剔注释再判：注释里**提到**敏感词不算违规（2026-09-20 同型假阳性踩过两次——Clustly 扫描器 + 本测试）
  const sched = readFileSync(join(REPO, 'src', 'schedule.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  for (const forbidden of ['child_process', 'execSync', 'spawnSync', 'taskboard_complete', 'apply(']) {
    assert.equal(sched.includes(forbidden), false, `纯逻辑层不得出现 ${forbidden}（只算谁到点，不代做任务）`)
  }
})
