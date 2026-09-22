// 任务板状态机 v2 —— 判据来源 docs/semantic.md §4.5（I11–I18）
// 纪律：每条断言都要能**判假**；凡「必须检出」的断言都配**对照组**（该沉默的必须沉默），
// 否则「恒报」和「恒不报」都能骗过测试（§5.9·2 判据必须有分辨力）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  assertBlockedFields,
  assertTransition,
  canTransition,
  completionMemoryText,
  dueReviews,
  isTaskStatus,
  isTerminal,
  lastTouchMs,
  needsReason,
  staleOf,
} from '../lib/statemachine.js'

const NOW = Date.parse('2026-09-22T14:00:00Z')
const isoAgo = (days) => new Date(NOW - days * 86_400_000).toISOString()

test('I12 白名单：非法流转必须抛错（含尸体样本 + 放行对照组）', () => {
  // 尸体样本（旧实现真发生过）：终态被静默改回 pending；pending 直接跳 done
  assert.throws(() => assertTransition('done', 'claimed'), /非法状态流转/)
  assert.throws(() => assertTransition('cancelled', 'done'), /非法状态流转/)
  assert.throws(() => assertTransition('pending', 'done'), /非法状态流转/)
  assert.throws(() => assertTransition('pending', 'blocked'), /非法状态流转/)
  assert.throws(() => assertTransition('blocked', 'done'), /非法状态流转/)
  // 对照组：白名单内的每一条都必须放行——若实现是「全拒」，上面的断言同样会全绿
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.doesNotThrow(() => assertTransition(from, to, { reason: '测试重开' }), `${from} → ${to} 应放行`)
    }
  }
})

test('I12 终态重开必须带 reason（不允许静默复活）', () => {
  assert.throws(() => assertTransition('done', 'pending'), /必须带 reason/)
  assert.throws(() => assertTransition('done', 'pending', { reason: '   ' }), /必须带 reason/)
  assert.doesNotThrow(() => assertTransition('done', 'pending', { reason: '误判，重开' }))
  // 非终态流转不需要 reason（否则会误伤正常路径）
  assert.doesNotThrow(() => assertTransition('pending', 'claimed'))
})

test('I13 blocked 三件套：缺一即拒，齐了放行', () => {
  const full = { blockedReason: '等外部首单', nextAction: '查一次平台后台', reviewAt: '2026-09-23T10:00:00Z' }
  assert.doesNotThrow(() => assertBlockedFields(full))
  for (const key of ['blockedReason', 'nextAction', 'reviewAt']) {
    const partial = { ...full, [key]: '' }
    assert.throws(() => assertBlockedFields(partial), /必须带齐承诺字段/, `缺 ${key} 应拒绝`)
  }
  assert.throws(() => assertBlockedFields({}), /必须带齐承诺字段/)
})

test('I15 停滞判据：超期必须检出，未超期必须沉默（含终态排除）', () => {
  const tasks = [
    { id: 'stale-claimed', title: '停了 5 天', status: 'claimed', updatedAt: isoAgo(5) },
    { id: 'fresh-claimed', title: '刚动过', status: 'claimed', updatedAt: new Date(NOW - 3600_000).toISOString() },
    { id: 'stale-pending', title: '待办放烂了', status: 'pending', updatedAt: isoAgo(9) },
    { id: 'legacy-no-updated', title: '旧数据无 updatedAt', status: 'claimed', claimedAt: isoAgo(7) },
    { id: 'done-old', title: '终态不算停滞', status: 'done', updatedAt: isoAgo(30) },
    { id: 'cancelled-old', title: '终态不算停滞', status: 'cancelled', updatedAt: isoAgo(30) },
  ]
  const stale = staleOf(tasks, { nowMs: NOW, staleDays: 3 })
  const ids = stale.map((s) => s.id)
  assert.deepEqual(ids, ['stale-pending', 'legacy-no-updated', 'stale-claimed'], '按停滞天数降序，且只含超期非终态项')
  assert.equal(stale.find((s) => s.id === 'stale-claimed').idleDays, 5)
  // 对照组：必须有「沉默」的证据
  assert.ok(!ids.includes('fresh-claimed'), '刚动过的不能报')
  assert.ok(!ids.includes('done-old'), '终态不能报')
  assert.ok(!ids.includes('cancelled-old'), '终态不能报')
})

test('I15 阈值边界：恰好等于阈值不报（> 才算超期）', () => {
  const at = [{ id: 'edge', title: '恰好 3 天', status: 'claimed', updatedAt: isoAgo(3) }]
  assert.equal(staleOf(at, { nowMs: NOW, staleDays: 3 }).length, 0)
  const over = [{ id: 'edge', title: '3.1 天', status: 'claimed', updatedAt: isoAgo(3.1) }]
  assert.equal(staleOf(over, { nowMs: NOW, staleDays: 3 }).length, 1)
})

test('lastTouchMs 回退链：updatedAt → claimedAt → createdAt，全无则 0', () => {
  assert.equal(lastTouchMs({ updatedAt: isoAgo(1), claimedAt: isoAgo(5), createdAt: isoAgo(9) }), NOW - 86_400_000)
  assert.equal(lastTouchMs({ claimedAt: isoAgo(5), createdAt: isoAgo(9) }), NOW - 5 * 86_400_000)
  assert.equal(lastTouchMs({ createdAt: isoAgo(9) }), NOW - 9 * 86_400_000)
  assert.equal(lastTouchMs({}), 0)
  assert.equal(lastTouchMs({ updatedAt: '不是时间' }), 0, '不可解析的时间不得被当成 0 天前')
})

test('I13 待复查：到点的 blocked 必须浮出，未到点必须有对照', () => {
  const tasks = [
    { id: 'due', title: '该看了', status: 'blocked', reviewAt: new Date(NOW - 3600_000).toISOString(), nextAction: '查后台' },
    { id: 'not-due', title: '还没到', status: 'blocked', reviewAt: new Date(NOW + 7200_000).toISOString(), nextAction: '等两天' },
    { id: 'no-review', title: '没设复查时刻', status: 'blocked' },
    { id: 'claimed-past', title: '非阻塞态', status: 'claimed', reviewAt: new Date(NOW - 3600_000).toISOString() },
  ]
  const due = dueReviews(tasks, NOW)
  assert.deepEqual(due.map((t) => t.id), ['due'])
})

test('I12 释放路径：claimed → pending 必须允许（认领不是不可撤销的）', () => {
  // 缺口来源：初版白名单没有这条边 ⇒「认领错了」没有出路，只能挂着 claimed 装活。
  // 没有释放路径的状态机必然制造失真，所以这条边本身就是一条判据。
  assert.ok(canTransition('claimed', 'pending'))
  assert.doesNotThrow(() => assertTransition('claimed', 'pending'))
  assert.equal(needsReason('claimed', 'pending'), false, '释放不需要 reason（终态重开才需要）')
  assert.equal(needsReason('done', 'pending'), true)
})

test('状态枚举与终态判定自洽', () => {
  assert.deepEqual([...TASK_STATUSES], ['pending', 'claimed', 'blocked', 'done', 'cancelled'])
  assert.deepEqual([...TERMINAL_STATUSES], ['done', 'cancelled'])
  assert.ok(isTerminal('done') && isTerminal('cancelled'))
  assert.ok(!isTerminal('blocked'), 'blocked 不是终态——它是要回来的')
  assert.ok(isTaskStatus('blocked') && !isTaskStatus('nonsense'))
  assert.ok(canTransition('claimed', 'blocked'))
  assert.equal(canTransition('blocked', 'blocked'), false, '同状态不算一条流转')
  assert.equal(TRANSITIONS.claimed.includes('blocked'), true)
})

test('I17 完成摘要文本：三条完成路径共用的形状', () => {
  const text = completionMemoryText({ id: 't-abc12345', title: '示例任务', type: 'long', priority: 'high' }, '做完了，判据是 X')
  assert.match(text, /^## 任务完成：示例任务/)
  assert.match(text, /做完了，判据是 X/)
  assert.match(text, /t-abc12345/)
  assert.match(text, /long \/ high/)
  // 空摘要不得留下空段（旧实现在摘要为空时会多一个空行段落）
  const bare = completionMemoryText({ id: 't-x', title: '无摘要' }, '   ')
  assert.ok(!bare.includes('\n\n\n'), '空摘要不应产生连续空行')
})
