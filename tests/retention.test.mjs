// 任务板终态轮转 —— 含现场尸体样本（2026-09-13「任务板中完成的你怎么不删啊」）
import test from 'node:test'
import assert from 'node:assert/strict'
import { isTerminal, splitTerminalForArchive } from '../lib/retention.js'

const NOW = Date.parse('2026-09-13T15:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

test('尸体样本：18 条 done + 5 pending + 3 claimed → 只归档超期 done，未终结一个不动', () => {
  const tasks = [
    ...Array.from({ length: 18 }, (_, i) => ({ id: `d${i}`, status: 'done', updatedAt: daysAgo(1 + (i % 5)) })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, status: 'pending', createdAt: daysAgo(9) })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, status: 'claimed', createdAt: daysAgo(9) })),
  ]
  // 边界语义：**恰好等于保留期截止点**（updatedAt == now - retainDays）也算超期 → 归档。
  // 1+(i%5) ∈ {1,2,3,4,5}，其中 3、4、5 落在截止点及更早 → i%5 ∈ {2,3,4} → 18 条中 10 条
  const { keep, archived } = splitTerminalForArchive(tasks, { nowMs: NOW, retainDays: 3 })
  assert.equal(archived.length, 10)
  assert.equal(keep.length, 16)
  assert.ok(archived.every(t => t.status === 'done'))
  assert.ok(keep.filter(t => t.status === 'pending').length === 5)
  assert.ok(keep.filter(t => t.status === 'claimed').length === 3)
})

test('保留期内（retainDays 内）的终态**不动**', () => {
  const { keep, archived } = splitTerminalForArchive(
    [{ id: 'a', status: 'done', updatedAt: daysAgo(1) }], { nowMs: NOW, retainDays: 3 })
  assert.equal(archived.length, 0)
  assert.equal(keep.length, 1)
})

test('未终结任务永不归档（哪怕很老）', () => {
  const { keep, archived } = splitTerminalForArchive(
    [{ id: 'p', status: 'pending', createdAt: daysAgo(300) },
      { id: 'c', status: 'claimed', updatedAt: daysAgo(300) }], { nowMs: NOW })
  assert.equal(archived.length, 0)
  assert.equal(keep.length, 2)
})

test('时间戳缺失的终态任务保守保留（宁留不误归档）', () => {
  const { keep, archived } = splitTerminalForArchive(
    [{ id: 'x', status: 'done' }, { id: 'y', status: 'done', updatedAt: 'not-a-date' }], { nowMs: NOW })
  assert.equal(archived.length, 0)
  assert.equal(keep.length, 2)
})

test('cancelled 与 done 同属终态；isTerminal 判据一致', () => {
  assert.equal(isTerminal({ id: 'a', status: 'cancelled' }), true)
  assert.equal(isTerminal({ id: 'b', status: 'claimed' }), false)
  const { archived } = splitTerminalForArchive(
    [{ id: 'c', status: 'cancelled', updatedAt: daysAgo(10) }], { nowMs: NOW })
  assert.equal(archived.length, 1)
})

test('边界样本：恰好等于截止点 → 归档；比截止点新 1ms → 保留', () => {
  const atCutoff = new Date(NOW - 3 * 86_400_000).toISOString()
  const oneMsNewer = new Date(NOW - 3 * 86_400_000 + 1).toISOString()
  const r = splitTerminalForArchive(
    [{ id: 'edge', status: 'done', updatedAt: atCutoff },
      { id: 'fresh', status: 'done', updatedAt: oneMsNewer }],
    { nowMs: NOW, retainDays: 3 })
  assert.deepEqual(r.archived.map(t => t.id), ['edge'])
  assert.deepEqual(r.keep.map(t => t.id), ['fresh'])
})

test('幂等：对已轮转的结果再跑一次，归档集为空（不会重复归档）', () => {
  const first = splitTerminalForArchive(
    [{ id: 'a', status: 'done', updatedAt: daysAgo(9) }, { id: 'b', status: 'pending' }], { nowMs: NOW })
  assert.equal(first.archived.length, 1)
  assert.equal(first.keep.length, 1)
  const second = splitTerminalForArchive(first.keep, { nowMs: NOW })
  assert.equal(second.archived.length, 0)
  assert.equal(second.keep.length, 1)
})
