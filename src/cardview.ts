/**
 * 任务卡片的**文本呈现**（纯函数）——把「读回一张卡」的渲染从工具面抽出来。
 *
 * 为什么单独一层（2026-09-22 · t-7238ff6a）：任务板此前**只有写没有读**——卡片正文只能写、
 * 不能读，而 `taskboard_update` 的 `description` 是**整体替换** ⇒ 不先读回就改，会把原始判据
 * 整段覆盖且无痕迹。这与同日修的 I11 同族：**缺失/宽容的读，处在带写回的链路上 = 删除**。
 *
 * 补上读回之后，这段渲染必须**可离线证伪**（中文 / 多行 / 缺字段 / 长正文 / 空正文），
 * 所以逻辑放这里，工具面只做 IO（与 `ops-logic` 同一分层纪律）。
 *
 * 边界：`ageText`（新鲜度后缀）由**调用方注入**——它依赖当前时间，注入后本函数保持
 * 无时间、可复现（同 `pickActiveSessionId` / `findInFlightSubagents` 的注入口径）。
 */

/** 渲染所需的最小字段集（结构化类型，不 import 插件内部 Task ⇒ 可独立测试）。 */
export interface CardView {
  id: string
  title: string
  status: string
  priority: string
  tags?: string[]
  assignee?: string
  description?: string
  summary?: string
  blockedReason?: string
  nextAction?: string
  reviewAt?: string
  remindAt?: string
}

const NL = String.fromCharCode(10)

/**
 * 「有值才显示」——空串与 undefined 一律**不显示该行**。
 * 为什么不显示空值：一行「负责人 」比没有这一行更糟（读者会以为负责人在别处被清空了）。
 */
const present = (v: string | undefined): v is string => v !== undefined && v !== ''

/**
 * 渲染一张卡的全文。
 *
 * **正文逐字符原样输出**：不 trim、不截断、不转义——它就是判据本体，任何「美化」都会让
 * 「读回的和存进去的不一致」，而那正是这个函数存在的理由。
 */
export function renderCardText(t: CardView, ageText: string): string {
  const lines: string[] = [
    '【' + t.id + '】' + t.title,
    '状态 ' + t.status + ' · 优先级 ' + t.priority + ageText,
    '标签 ' + ((t.tags ?? []).join(' ') || '（无）'),
  ]
  if (present(t.assignee)) lines.push('负责人 ' + t.assignee)
  if (present(t.blockedReason)) lines.push('⛔ 卡在 ' + t.blockedReason)
  if (present(t.nextAction)) lines.push('下次动作 ' + t.nextAction)
  if (present(t.reviewAt)) lines.push('复查 ' + t.reviewAt)
  if (present(t.remindAt)) lines.push('提醒 ' + t.remindAt)
  if (present(t.summary)) lines.push('摘要 ' + t.summary)
  lines.push('', '── 正文 ──', present(t.description) ? t.description : '（无正文）')
  return lines.join(NL)
}

/** 卡不在板上时的说明（**必须指出终态已归档**，否则调用者会把「不在板」读成「从未存在」）。 */
export function missingCardText(id: string): string {
  return '任务板里没有 ' + id + '（终态任务完成即归档出板——回查用 taskboard_archive）'
}
