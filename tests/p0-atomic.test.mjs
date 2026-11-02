/**
 * p0-atomic.test.mjs — 写入原子化的**判据层**离线验收。
 *
 * 对应改进方案 §2.4 的三条判据：
 *   P0-1 正常写入无 `.tmp-*` 残留、内容完整
 *   P0-2 **三处**写入点都走同一个函数（治「只改两处、漏 remote.ts:59」那个病）
 *   P0-3 归档幂等去重（治「两步写之间被杀 ⇒ 归档长出重复 id」）
 *
 * 每条都带**尸体样本**：喂一个已知坏的输入，证明该拦的会被拦。
 * 「恒为真的判据不是判据」——P0-3d（全重复不增长）就是那条最容易写成恒真的判据的反面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from '../lib/atomic-write.js'
import { mergeArchived } from '../lib/retention.js'

/** 建一个独立临时目录（每个用例一个，互不干扰）。 */
function freshDir() {
  return mkdtempSync(join(tmpdir(), 'tb-atomic-'))
}

// ————————————————— P0-1 正常路径 —————————————————

test('P0-1 正常写入：内容完整，且**不留下 .tmp-* 残留**', () => {
  const dir = freshDir()
  const p = join(dir, 'tasks.json')
  const value = { tasks: [{ id: 't-1', title: '甲' }, { id: 't-2', title: '乙' }] }
  writeJsonAtomic(p, value)

  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), value)
  // 这一条是原方案「判据 1」的内容，保留它；但真正的新意在下一条与 P0-2/P0-3
  assert.deepEqual(readdirSync(dir), ['tasks.json'], '写入后不得留下 tmp 文件')
})

test('P0-1b 覆盖写入：旧内容被**整体替换**，不是追加（尸体样本：两次不同长度）', () => {
  const dir = freshDir()
  const p = join(dir, 'tasks.json')
  writeJsonAtomic(p, { tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
  writeJsonAtomic(p, { tasks: [{ id: 'z' }] })

  const got = JSON.parse(readFileSync(p, 'utf8'))
  assert.deepEqual(got, { tasks: [{ id: 'z' }] }, '不得残留上一版的内容')
  assert.deepEqual(readdirSync(dir), ['tasks.json'])
})

test('P0-1c 父目录不存在时自动创建（三处调用点原来各自 mkdir，现在收进一个地方）', () => {
  const dir = freshDir()
  const p = join(dir, 'deep', 'nested', 'tasks.json')
  writeJsonAtomic(p, { tasks: [] })
  assert.equal(existsSync(p), true)
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { tasks: [] })
})

test('P0-1d 连续写 20 次不积 tmp（防「tmp 名撞车」与「异常路径漏清」）', () => {
  const dir = freshDir()
  const p = join(dir, 'tasks.json')
  for (let i = 0; i < 20; i++) writeJsonAtomic(p, { tasks: [{ id: 'x' + String(i) }] })
  assert.deepEqual(readdirSync(dir), ['tasks.json'])
})

// ————————————————— P0-2 覆盖面（治「只改两处」） —————————————————

test('★ P0-2 index.ts 与 remote.ts 里**不得再有裸 writeFileSync**', () => {
  // 这条判据是本轮最有价值的一条：原方案只改了两处，漏了 remote.ts:59（界面侧 mutate）。
  // 判据必须落在「所有写入点」，否则下次新增写入点也不会被发现。
  for (const file of ['index.ts', 'remote.ts']) {
    const src = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
    const hits = src.match(/writeFileSync\s*\(/g) ?? []
    assert.equal(
      hits.length, 0,
      file + ' 里还有 ' + String(hits.length) + ' 处裸 writeFileSync——写入必须走 atomic-write.ts',
    )
  }
})

test('★ P0-2b 三处写入点确实调用了 writeJsonAtomic（不是删了就算）', () => {
  const idx = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const rem = readFileSync(new URL('../src/remote.ts', import.meta.url), 'utf8')
  // index.ts 两处：rotateTerminal 的归档 + 板面；saveBoard 一处
  const idxCalls = (idx.match(/writeJsonAtomic\s*\(/g) ?? []).length
  assert.ok(idxCalls >= 3, 'index.ts 里至少 3 次调用（归档 / 板面 / saveBoard），实际 ' + String(idxCalls))
  assert.ok(/writeJsonAtomic\s*\(/.test(rem), 'remote.ts 的 save 必须走原子写')
})

test('P0-2c atomic-write.ts 自己不做 fsync（结论有记录，不靠注释糊弄）', () => {
  const src = readFileSync(new URL('../src/atomic-write.ts', import.meta.url), 'utf8')
  // USE_FSYNC 恒为 false；若有人把它改成 true，这条会提醒他先去看头注里的理由
  assert.match(src, /const USE_FSYNC = false/, 'fsync 开关必须是 false——理由见该文件头注')
})

// ————————————————— P0-3 归档幂等去重 —————————————————

test('★ P0-3 尸体样本：prev 与 incoming 有交集 ⇒ 交集不重复出现', () => {
  // 这就是「两步写之间被杀」之后的真实形状：归档里已有 t-2，板面里 t-2 还留着，
  // 于是下一次轮转把 t-2 又算进 incoming 一遍。原实现 [...prev, ...incoming] 会让它出现两次。
  const prev = [{ id: 't-1' }, { id: 't-2' }]
  const incoming = [{ id: 't-2' }, { id: 't-3' }]
  const merged = mergeArchived(prev, incoming)
  assert.deepEqual(merged.map((t) => t.id), ['t-1', 't-2', 't-3'])
})

test('P0-3b 无交集时顺序保持（prev 在前，incoming 保序——归档是历史，不重排）', () => {
  const merged = mergeArchived([{ id: 'a' }], [{ id: 'b' }, { id: 'c' }])
  assert.deepEqual(merged.map((t) => t.id), ['a', 'b', 'c'])
})

test('P0-3c 空 prev ⇒ 结果就是 incoming（当日首建）', () => {
  const merged = mergeArchived([], [{ id: 'x' }, { id: 'y' }])
  assert.deepEqual(merged.map((t) => t.id), ['x', 'y'])
})

test('★ P0-3d 全重复 ⇒ 长度不增长（反例：证明去重真的在去，不是碰巧）', () => {
  const prev = [{ id: 'a' }, { id: 'b' }]
  const merged = mergeArchived(prev, [{ id: 'a' }, { id: 'b' }])
  assert.equal(merged.length, 2, '全重复时不许增长——否则每次轮转都让归档变胖')
  assert.deepEqual(merged.map((t) => t.id), ['a', 'b'])
})

test('P0-3e 不修改入参（纯函数：两个数组都不得被就地改）', () => {
  const prev = [{ id: 'a' }]
  const incoming = [{ id: 'a' }, { id: 'b' }]
  mergeArchived(prev, incoming)
  assert.deepEqual(prev.map((t) => t.id), ['a'])
  assert.deepEqual(incoming.map((t) => t.id), ['a', 'b'])
})

test('P0-3f 保留任务对象的其余字段（不是只搬 id）', () => {
  const merged = mergeArchived([], [{ id: 'a', title: '甲', status: 'done' }])
  assert.deepEqual(merged, [{ id: 'a', title: '甲', status: 'done' }])
})
