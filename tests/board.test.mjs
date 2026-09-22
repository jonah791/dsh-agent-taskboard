// 板面读写单一真源 —— 判据来源 docs/semantic.md §4.5 · I11（读失败必须响亮）
//
// 为什么这组测试值得存在：旧实现两份 `load` 都写 `catch { return [] }`，
// 而调用方紧接着 `save(tasks)` —— 文件损坏时读到空板，一次操作就把**整块板**
// 覆盖成「只有刚写的那一条」。这是本轮最高危的缺陷，必须有可判假的判据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readBoardLenient, readBoardStrict } from '../lib/board.js'

const raw = (tasks) => () => JSON.stringify({ tasks })

test('I11 尸体样本：坏 JSON 必须抛错，且理由里写明「拒绝以空板继续」', () => {
  assert.throws(() => readBoardStrict('/b.json', () => '{ 这不是 JSON'), /解析失败/)
  assert.throws(() => readBoardStrict('/b.json', () => 'nope'), /拒绝以空板继续/)
})

test('I11 形状异常必须抛错（顶层非对象 / 缺 tasks 数组）', () => {
  assert.throws(() => readBoardStrict('/b.json', () => 'null'), /结构异常/)
  assert.throws(() => readBoardStrict('/b.json', () => '"就是个字符串"'), /结构异常/)
  assert.throws(() => readBoardStrict('/b.json', () => '{}'), /结构异常/)
  assert.throws(() => readBoardStrict('/b.json', () => '{"tasks":{}}'), /结构异常/, 'tasks 是对象而非数组也要拒')
})

test('I11 ENOENT 算正常（首次使用）→ 空板；其他 IO 错误必须抛', () => {
  const enoent = () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e }
  assert.deepEqual(readBoardStrict('/b.json', enoent), [])
  const eacces = () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e }
  assert.throws(() => readBoardStrict('/b.json', eacces), /任务板读取失败/)
})

test('对照组：正常板面必须读得回来（「全抛」也能骗过上面的断言）', () => {
  assert.deepEqual(readBoardStrict('/b.json', raw([{ id: 't-1', status: 'claimed' }])), [{ id: 't-1', status: 'claimed' }])
  assert.deepEqual(readBoardStrict('/b.json', raw([])), [], '空板是合法板面')
})

test('宽松读仅限只读面：坏数据 → 空数组；好数据不降级', () => {
  assert.deepEqual(readBoardLenient('/b.json', () => '坏'), [])
  assert.deepEqual(readBoardLenient('/b.json', () => { const e = new Error('x'); e.code = 'EACCES'; throw e }), [])
  assert.deepEqual(readBoardLenient('/b.json', raw([{ id: 't-9' }])), [{ id: 't-9' }], '好数据不得被降级成空')
})
