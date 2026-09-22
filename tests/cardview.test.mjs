// 任务卡片文本呈现 —— 判据来源任务板 t-7238ff6a（「卡片正文必须能读回」）
//
// 纪律：这个函数存在的唯一理由是「**读回的和存进去一致**」。所以最强的断言是
// **逐字符全等**（不是 includes）——includes 会放过「前后被加料」的实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { missingCardText, renderCardText } from '../lib/cardview.js'

const base = {
  id: 't-1a2b3c4d',
  title: '示例卡',
  status: 'pending',
  priority: 'normal',
}

test('全字段卡：逐字符全等（中文 + 多行正文 + 空行都要原样）', () => {
  const body = '## 判据\n第一行\n\n第三行：中文与 ASCII 混排 abc-123\n末尾不留空行'
  const got = renderCardText(
    {
      ...base,
      status: 'blocked',
      priority: 'high',
      tags: ['任务板', '工具面'],
      assignee: 'session-abc',
      blockedReason: '等外部首单',
      nextAction: '复查列表',
      reviewAt: '2026-09-24T10:00:00.000Z',
      remindAt: '2026-09-23T10:00:00.000Z',
      summary: '已建立联系',
      description: body,
    },
    ' · 2 天未动',
  )
  const want = [
    '【t-1a2b3c4d】示例卡',
    '状态 blocked · 优先级 high · 2 天未动',
    '标签 任务板 工具面',
    '负责人 session-abc',
    '⛔ 卡在 等外部首单',
    '下次动作 复查列表',
    '复查 2026-09-24T10:00:00.000Z',
    '提醒 2026-09-23T10:00:00.000Z',
    '摘要 已建立联系',
    '',
    '── 正文 ──',
    body,
  ].join(String.fromCharCode(10))
  assert.equal(got, want)
  assert.ok(got.includes(body), '正文必须是原文片段（逐字符）')
})

test('最小卡：只有必填字段时也给完整骨架（正文缺失 → 显式写「（无正文）」）', () => {
  const got = renderCardText({ ...base }, '')
  assert.equal(
    got,
    ['【t-1a2b3c4d】示例卡', '状态 pending · 优先级 normal', '标签 （无）', '', '── 正文 ──', '（无正文）'].join(String.fromCharCode(10)),
  )
})

test('空串与 undefined 一律**不出行**（空值行比缺行更误导：读者会以为被清空了）', () => {
  const got = renderCardText({ ...base, assignee: '', blockedReason: undefined, reviewAt: '', summary: '' }, '')
  assert.equal(got.includes('负责人'), false)
  assert.equal(got.includes('⛔'), false)
  assert.equal(got.includes('复查'), false)
  assert.equal(got.includes('摘要'), false)
  // 对照组：给了值就一定要出现（否则「一律不显示」也能让上面四条全绿）
  const withAll = renderCardText({ ...base, assignee: 'a', blockedReason: 'b', reviewAt: 'c', summary: 'd', nextAction: 'e', remindAt: 'f' }, '')
  for (const frag of ['负责人 a', '⛔ 卡在 b', '复查 c', '摘要 d', '下次动作 e', '提醒 f']) {
    assert.ok(withAll.includes(frag), '对照组应包含：' + frag)
  }
})

test('正文不截断、不 trim：超长与首尾空白都必须原样', () => {
  const body = '  前导空白\n' + 'x'.repeat(4000) + '\n尾随空白  '
  const got = renderCardText({ ...base, description: body }, '')
  assert.ok(got.endsWith(body), '结尾必须是正文原文（含尾随空白）')
  assert.equal(got.includes('…'), false, '不许出现截断省略号')
})

test('tags 为空数组 → 显式「（无）」而不是空标签行', () => {
  assert.ok(renderCardText({ ...base, tags: [] }, '').includes('标签 （无）'))
  assert.ok(renderCardText({ ...base, tags: undefined }, '').includes('标签 （无）'))
})

test('卡不在板上：提示必须指向归档（否则「不在板」会被读成「从未存在」）', () => {
  const m = missingCardText('t-deadbeef')
  assert.ok(m.includes('t-deadbeef'))
  assert.ok(m.includes('taskboard_archive'))
  assert.ok(m.includes('归档'))
})
