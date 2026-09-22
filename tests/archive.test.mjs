// 任务板终态归档读取层 —— 判据来源 docs/semantic.md §4.5 · I16
// 背景：TERMINAL_RETAIN_DAYS=0 ⇒ 完成即出板，而此前没有任何工具能读回归档
// （索引里 9 个 terminal-*.json 全部只写不读）。本测试把「读得回来」变成可判假的断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectArchiveTasks, filterArchiveTasks, parseArchiveFile, readArchiveDir } from '../lib/archive.js'

const fileOf = (day, tasks) => ({
  name: `terminal-2026-09-${day}.json`,
  raw: JSON.stringify({ archivedAt: `2026-09-${day}T00:00:00Z`, tasks }),
})

test('parseArchiveFile：正常文件可解析并带上来源文件名', () => {
  const r = parseArchiveFile('terminal-2026-09-22.json', JSON.stringify({
    archivedAt: '2026-09-22T00:00:00Z',
    tasks: [{ id: 't-a', title: '甲', status: 'done', doneAt: '2026-09-22T01:00:00Z', summary: '做完了' }],
  }))
  assert.equal(r.ok, true)
  assert.equal(r.tasks.length, 1)
  assert.equal(r.tasks[0].id, 't-a')
  assert.equal(r.tasks[0].archivedFile, 'terminal-2026-09-22.json')
  assert.equal(r.tasks[0].summary, '做完了')
})

test('parseArchiveFile：坏文件转成可上报错误（不抛、不静默跳过）', () => {
  const bad = parseArchiveFile('terminal-x.json', '{ 这不是 JSON')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /解析失败/)
  const noTasks = parseArchiveFile('terminal-y.json', JSON.stringify({ archivedAt: 'x' }))
  assert.equal(noTasks.ok, false)
  assert.match(noTasks.error, /tasks 不是数组/)
  // 无 id 的条目要跳过（不能凭空 id 混进结果）
  const partial = parseArchiveFile('terminal-z.json', JSON.stringify({ tasks: [{ title: '无 id' }, { id: 't-ok', title: '有 id' }] }))
  assert.equal(partial.ok, true)
  assert.deepEqual(partial.tasks.map((t) => t.id), ['t-ok'])
})

test('collectArchiveTasks：同一 id 跨文件去重时保留最近一日 + 坏文件不静默', () => {
  const inv = collectArchiveTasks([
    fileOf('20', [{ id: 't-dup', title: '旧版本', status: 'done' }]),
    fileOf('22', [{ id: 't-dup', title: '新版本', status: 'done' }]),
    { name: 'terminal-2026-09-21.json', raw: '坏了' },
  ])
  assert.equal(inv.tasks.length, 1, '同一 id 只留一条')
  assert.equal(inv.tasks[0].title, '新版本', '保留文件名字典序更大的（= 更近的一日）')
  assert.equal(inv.corrupt.length, 1)
  assert.equal(inv.corrupt[0].file, 'terminal-2026-09-21.json')
  // 文件清单按名字倒序（最近在前）
  assert.deepEqual(inv.files.map((f) => f.file), ['terminal-2026-09-22.json', 'terminal-2026-09-20.json'])
})

test('filterArchiveTasks：id / 关键词 / 终态 三路过滤 + 倒序 + 截断', () => {
  const tasks = [
    { id: 't-1', title: '面板改造', status: 'done', doneAt: '2026-09-20T00:00:00Z', archivedFile: 'a' },
    { id: 't-2', title: 'D3 误报治理', status: 'done', doneAt: '2026-09-22T00:00:00Z', archivedFile: 'a' },
    { id: 't-3', title: '废弃的想法', status: 'cancelled', doneAt: '2026-09-21T00:00:00Z', archivedFile: 'a' },
  ]
  assert.deepEqual(filterArchiveTasks(tasks, { id: 't-2' }).map((t) => t.id), ['t-2'])
  assert.deepEqual(filterArchiveTasks(tasks, { status: 'cancelled' }).map((t) => t.id), ['t-3'])
  assert.deepEqual(filterArchiveTasks(tasks, { keyword: 'd3' }).map((t) => t.id), ['t-2'], '关键词大小写不敏感')
  assert.deepEqual(filterArchiveTasks(tasks, {}).map((t) => t.id), ['t-2', 't-3', 't-1'], '按终态时刻倒序')
  assert.equal(filterArchiveTasks(tasks, { limit: 2 }).length, 2)
  assert.equal(filterArchiveTasks(tasks, { keyword: '不存在的词' }).length, 0)
  // 关键词也命中摘要
  assert.equal(filterArchiveTasks([{ id: 't-4', title: '无关', status: 'done', summary: '内含关键字', archivedFile: 'a' }], { keyword: '关键字' }).length, 1)
})

test('readArchiveDir：目录不存在算空（首次使用），坏文件进 corrupt，IO 异常必须抛', () => {
  const listed = ['terminal-2026-09-22.json', 'terminal-2026-09-21.json', 'README.md']
  const raw = {
    'terminal-2026-09-22.json': JSON.stringify({ archivedAt: 'x', tasks: [{ id: 't-a', title: '甲', status: 'done' }] }),
    'terminal-2026-09-21.json': 'Not JSON at all',
  }
  const inv = readArchiveDir('/fake/archive', (p) => raw[p.split('/').pop()], () => listed)
  assert.equal(inv.tasks.length, 1, '非 terminal-*.json 的文件不读')
  assert.equal(inv.corrupt.length, 1)
  // ENOENT → 空清单（首次使用是正常状态）
  const empty = readArchiveDir('/fake/archive', () => '', () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e })
  assert.deepEqual(empty, { files: [], tasks: [], corrupt: [] })
  // 其他 IO 错误必须抛（「看不见归档」不能被读成「没有归档」）
  assert.throws(() => readArchiveDir('/fake/archive', () => '', () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }), /无法列举/)
})
