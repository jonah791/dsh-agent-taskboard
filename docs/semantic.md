# 语义文档：dsh-agent-taskboard（任务板 · 异步任务队列）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（本份是 2026-09-14 可维护性工程的**补课**文档）
> 实现落点：`self-plugins/dsh-agent-taskboard/src/index.ts`（+ 服务层 `src/remote.ts`、纯函数 `src/retention.ts`、客户端 `src/client/index.ts`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-taskboard（任务板 / 异步任务队列 + 协调界面） |
| 主副本路径 | `self-plugins/dsh-agent-taskboard/docs/semantic.md`（本文件） |
| 实现落点 | `src/index.ts`（工具面 + 通知 + 终态轮转接线）、`src/remote.ts`（Typert Remote 服务 `taskboardRemote`，namespace `taskboard`）、`src/retention.ts`（轮转纯函数）、`src/client/index.ts`（client 插件：`$mount` remote） |
| 版本 | 0.1.1（git head `d6bf990`） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` **行 69–75** `insert` 块：行 id `agent-taskboard`（:70）、name `dsh-agent-taskboard`（:71）、config `boardFile: E:/alice/.taskboard/tasks.json`（:73）、`mainSessionId: session-5a785c96-d682-4290-9641-ca8213abba8f`（:74）、`notifyOnPost: false`（:75） |
| 状态 | **draft** |
| 测试 | `tests/retention.test.mjs`（轮转纯函数） |

## 1 · 定位与反定位

**定位**：一块**跨主体共享的任务板**——主人或任何 agent 可发布任务（JSON 持久化），宿主 agent（爱丽丝）空闲时
自主领取并完成。它是**协调界面**（AGENTS.md §5.14 rule 4：并行实例靠它协调「谁在做什么」）：
状态流转 + 看板计数 + 终态轮转归档 + 完成摘要回流记忆库。

**反定位（本文不管什么）**：
- **不替 agent 做决策**：发布只发 `wakeup=false` 的**排队通知**（不打断会话），领取/完成时机归 agent 自主（自主性铁律）
- **不是调度器**：没有优先级排序执行、没有定时触发、没有依赖图——只有状态机与可见性
- **不是记忆库**：完成摘要只是**回流**一条记忆（经 `memoryApi`），任务本身不是知识
- **不是 GUI 的唯一入口**：client 侧 `$mount` 仍注册 typert remote，但 GUI 槽位（会话头「任务板」按钮）已于 2026-09-13 撤除，界面迁到面板宿主 `dsh-panel` 的 `panels/taskboard.ts`

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 任务（Task） | `{id,title,description,type,priority,tags,status,assignee?,createdAt,claimedAt?,doneAt?,summary?}` |
| 板面（Board） | `{tasks: Task[]}`——`.taskboard/tasks.json` 的全部内容 |
| 终态（terminal） | `done` / `cancelled`。**不是**「完结」，而是「已可从板面移出」 |
| 轮转（rotate） | 终态超保留期 → 追加归档到 `archive/terminal-<date>.json` 并从板面移除（**归档而非删除**） |
| 保留期 | `TERMINAL_RETAIN_DAYS`（`src/index.ts:69`），当前值 **0 = 完成/取消即归档**（主人 2026-09-13 定调） |
| 回流 | 任务完成时经 `ctx.memoryApi.remember` 写一条记忆（key `task-<id>`） |
| 广播通知 | 发布时对所有 live agent 发 `next-turn` + `wakeup=false` 的消息（排队不打断） |
| remote | client UI 的数据通道：`namespace='taskboard'` → `/api/taskboard/*` |

## 3 · 概念模型

```
主人/agent ──taskboard_post──▶ loadBoard → rotateTerminal → push(Task) → saveBoard
                                    │                                  └─▶ notify(): 所有 live agent
                                    │                                        agent.send(msg,'next-turn', wakeup=false)
爱丽丝 ──taskboard_list/status──▶ loadBoard（读时自动轮转）
       ──taskboard_claim──────▶ pending → claimed（assignee=参数 ?? mainSessionId, claimedAt）
       ──taskboard_complete───▶ claimed → done（summary, doneAt）→ memoryApi.remember(key=task-<id>)
       ──taskboard_cancel─────▶ 任意未终结 → cancelled（reason 存 summary）
       ──taskboard_update─────▶ 改字段 / 状态流转（自动补时间戳）
GUI（面板宿主）──/api/taskboard/{list,status,mutate}──▶ TaskboardRemoteService ──▶ 同一 tasks.json
```

不变量（invariants）：
1. **I1 未终结任务永不被归档**：`splitTerminalForArchive`（`retention.ts:53`）只对 `done`/`cancelled` 分类——`pending`/`claimed` 恒进 `keep`（可测量：喂含 pending 的样本，断言 keep 含它）。
2. **I2 时间戳缺失的终态保守保留**：`timestampOf` 返回 0 → `keep`（宁留不误归档，`retention.ts:67`）。
3. **I3 轮转幂等且不产空归档**：`archived.length === 0` 时直接返回原 board，不写盘（`index.ts:81`）。
4. **I4 归档失败不丢数据**：写盘抛错 → `catch { return board }`（板面保持原样，`index.ts:98`）。
5. **I5 状态机单向可判**：`claim` 仅 `pending` 可领；`complete` 仅 `claimed` 可完成；`cancel` 对终态报错（工具层抛 `Error`，remote 层返回错误码）——可测量：对 `done` 任务再 `claim` 必失败。
6. **I6 看板计数自洽**：`counts` 四键之和 == `tasks.length`（`index.ts:321`）。

## 4 · 契约

### 4.1 数据结构 / 文件 / 服务

| 名称 | 路径 / 形状 | 写入 / 读取语义 |
|------|------------|----------------|
| 板面 | `E:/alice/.taskboard/tasks.json`（`boardFile`） | 整文件覆盖写（`saveBoard`，`index.ts:111`；`mkdir -p` 父目录）；读时先轮转（`loadBoard`，`index.ts:103`）；**读失败/坏 JSON → 返回空板 `{tasks:[]}`**（不抛） |
| 归档 | `<boardDir>/archive/terminal-<YYYY-MM-DD>.json`：`{archivedAt, note, tasks:[...]}` | 当日文件**追加**（读旧文件合并再整写，`index.ts:90`） |
| 记忆回流 | `memoryApi.remember({text, kind, tags:['任务板', id], key:'task-<id>'})` | `long` → `episodic`，否则 `knowledge`；失败静默（`index.ts:247-255`） |
| Remote 服务 | 服务名 `taskboardRemote`，namespace `taskboard` | client 经 `ctx.remote.$mount(TYPERT_REMOTE)` 注册 |

### 4.2 裁决（纯函数优先）

`splitTerminalForArchive(tasks, {nowMs, retainDays}) → {keep, archived}`（`src/retention.ts:53`）：

| 输入状态 | 裁决 | 理由 | 语义依据 |
|---------|------|------|---------|
| `status ∉ {done,cancelled}` | `keep` | 未终结永不动 | I1 |
| 终态，时间戳缺失（`updatedAt`/`createdAt` 解析失败） | `keep` | 宁留不误归档 | I2 |
| 终态，`at > cutoff`（保留期内） | `keep` | 回看窗口 | README 头注释 |
| 终态，`at ≤ cutoff` | `archived` | 超期移出板面 | 主人 2026-09-13「完成的怎么不删」 |

`TaskboardRemoteService.mutate` 的错误码表（`src/remote.ts:88-146`）：`title-required`（post 无标题）、`task-not-found`、`not-pending`（claim）、`not-claimed`（complete）、`terminal`（cancel 终态）、`not-terminal`（reopen 非终态）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:69-75`（行 id `agent-taskboard`） | web 启动 |
| inject 声明 | `src/index.ts:27` `inject = ['tools','agents','memoryApi']` | **激活门**：`memoryApi` 由 `dsh-agent-memory` 提供，缺失则本插件不激活 |
| Remote 服务挂载 | `src/index.ts:117 ctx.plugin(TaskboardRemoteService, {...})` | apply |
| `taskboard_post` | `src/index.ts:157 ctx.tools.register(defineTool(...))` | 工具面 |
| `taskboard_list` | `src/index.ts:188` | 同上 |
| `taskboard_claim` | `src/index.ts:207` | 同上 |
| `taskboard_complete` | `src/index.ts:229`（内含 `memoryApi.remember` 回流 `:247`） | 同上 |
| `taskboard_cancel` | `src/index.ts:261` | 同上 |
| `taskboard_update` | `src/index.ts:282` | 同上 |
| `taskboard_status` | `src/index.ts:314` | 同上 |
| 跨会话广播通知 | `src/index.ts:125 notify()` ← `:182`（post） | 发布任务时 |
| Remote 方法 | `src/remote.ts:74 @Remote('list')`、`:80 @Remote('status')`、`:88 @Remote('mutate')`；`notifyPost` `:47` | client/GUI 调用 |
| client 插件 | `src/client/index.ts:16 inject=['slots','remote']`、`:22 ctx.plugin({name:'taskboard-ui'...})`（GUI 槽位于 2026-09-13 撤除，`$mount` 保留） | 浏览器侧加载 |
| 落盘产物 | `.taskboard/tasks.json`、`.taskboard/archive/terminal-<date>.json` | — |
| 消费方 | 爱丽丝与全部并行实例（协调界面）；面板宿主 `dsh-panel`（`panels/taskboard.ts`）；`memoryApi`（接收回流） | — |
| 测试 | `tests/retention.test.mjs`（I1–I3 的离线判据） | `pnpm test` |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`taskboard_post` 任何人可调（无鉴权）——板上内容**不可信输入**，只是文本（不执行、不解析为指令）。
- **不越界清单**：不执行任务（无调度/无子进程）；不删任务（`cancel` 是状态流转；`delete` 只在 client remote 的 `mutate` 里可用，工具面无删除参数）；不写会话事件以外的通道（通知走 `agent.send`，属正常会话事件，Model-visible ⟺ logged 满足）。
- **失败面**：
  - 读失败/坏 JSON → 空板（**放行 + 静默**）：代价是「看不见历史」，但不阻塞任何写入；⚠ 这是宽容策略，误删文件不会被察觉——见 U2。
  - 写失败（磁盘满/权限） → `writeFileSync` 抛错向上冒泡到工具层（**响亮失败**）；轮转路径例外：归档写失败回退「不轮转」（I4）。
  - 通知失败 → `catch {}` 静默（`index.ts:153`）：**已知缺口**——通知是协作信号，静默失败意味着「发了但没人知道」。当前接受该代价（任务本身已在板上可见）。
  - 回流失败 → 静默（`index.ts:253/255`）：任务完成不回滚。

## 6 · 与既有机制的关系

| 机制 | 关系与顺序约束 |
|------|--------------|
| AGENTS.md §5.14（并行实例协调） | 任务板是**协调界面**：任务可能被另一实例领走（看 `assignee`）；完成结论应写进任务描述 |
| §5.6（分身生命周期） | 分身任务的派发/回收记录走任务板；完成摘要回流记忆（`task-<id>`） |
| §5.8（记忆检索纪律） | 完成 → `memoryApi.remember` 是「经验回流」的一环；`key=task-<id>` 保证幂等覆盖 |
| 2026-09-13 终态轮转（主人定调） | `TERMINAL_RETAIN_DAYS=0`：完成即归档；归档文件是**回查真源**（板面只留在办） |
| dsh-panel | GUI 入口收敛为面板宿主一页（`panels/taskboard.ts`）；本插件的 client 侧只保留 `$mount` |
| dsh-agent-memory | `inject` 依赖：本插件因 `memoryApi` 声明而**受其激活门约束**（服务缺失 → 不激活） |
| web profile 组合 | `mainSessionId` 是**锚点**（值 `session-5a785c96-…`），通知兜底与默认 assignee 用它；锚点腐化时通知仍能覆盖 live 列表（`notify()` 遍历 `ctx.agents.list()`） |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令/文件/日志行） | 状态 |
|---|-----------|------------------------|------|
| A1 | 运行中的 web 加载的是当前构建 | `lib/index.js` mtime 2026-09-13 16:05:24 **早于** web 进程启动（PID 7080，2026-09-14 10:05:47） | ✓ 已实测 |
| A2 | 板面文件存在且无终态常驻 | `ConvertFrom-Json .taskboard/tasks.json` → total=12、claimed=7、pending=5、**done/cancelled=0** | ✓ 已实测（2026-09-14 10:23） |
| A3 | 轮转真的产出归档 | `Get-ChildItem .taskboard/archive` → `terminal-2026-09-13.json`(74481B)、`terminal-2026-09-14.json`(1701B) | ✓ 已实测 |
| A4 | 轮转不误归档未终结/无时间戳项 | `node --test tests/retention.test.mjs` | 待验收（未在本轮执行） |
| A5 | 七个工具均已注册且可答 | 调 `taskboard_status` → `counts` 四键之和 == `tasks` 长度 | 待验收 |
| A6 | 状态机拒绝非法流转 | 对 `done` 任务调 `taskboard_claim` → 抛「任务状态为 done，不可领取」 | 待验收 |
| A7 | 完成回流记忆（key 幂等） | `recall key=task-<id>` 命中 / 重复完成覆盖而非追加 | 待验收 |
| A8 | 发布广播 `wakeup=false`（不打断运行中会话） | 会话事件流中 `taskboard_post` 后无新 turn 被强启 | 待验收 |
| A9 | GUI 槽位已撤、面板入口可用 | `src/client/index.ts:26-29` 注释即现状；浏览器打开面板宿主「任务板」页 | 待验收（需浏览器验收） |

## 8 · 与实现的关系

- **主实现**：`src/index.ts`（工具面 + 通知 + 轮转接线）。**服务层**：`src/remote.ts`（GUI 数据通道）。**纯函数层**：`src/retention.ts`。
- **同语义副本（I1）**：无。GUI 页面 `self-plugins/dsh-panel/panels/taskboard.ts` 是本板面的**视图**，不是第二份语义（其语义主副本在 `dsh-panel/docs/semantic.md`）。
- **未实现 / 未验证部分（显式标注）**：
  1. **无并发写保护**：`loadBoard → 改 → saveBoard` 之间无文件锁（并行实例同时改会丢更新）——未验证的**已知风险**，见 U1。
  2. 通知静默失败（§5 失败面）无存活证据（无 `notifiedCount` 落盘）。
  3. `notifyOnPost` 在 profile 中为 `false` → **实际生产不广播**（工具返回值仍报「任务已发布」）；语义上「发布即通知」与线上配置不一致，以配置为准。
- **生效判据**（改了代码后怎么证明真的生效）：
  1. **产物 vs 进程**：`self-plugins/dsh-agent-taskboard/lib/index.js` mtime 必须早于 web 进程启动时间（当前 09-13 16:05:24 < 09-14 10:05:47 ✓ live）。
  2. **落盘物证**：调一次 `taskboard_status` 后 `ls .taskboard/tasks.json` 的 mtime 应前进（读时轮转也会写盘）；归档目录出现新 `terminal-<今天>.json`。
  3. **工具可答**：`taskboard_status` / `taskboard_list` 出现在工具面并可返回 `counts`。
- **回退**：
  - 组合面：`plugin_stop dsh-agent-taskboard`（或 `plugin_unmount`）——写 patch `disabled: true` + 预检 + 哨兵重启；停用后工具面消失，**数据面不动**（其他实例仍可读 tasks.json）。
  - 代码面：`git revert <commit>`（head `d6bf990`）+ `pnpm build`；若只需撤终态轮转 → 把 `TERMINAL_RETAIN_DAYS`（`src/index.ts:69`）改回大于 0 并重建。
  - 数据面：归档文件**可逆**——把 `archive/terminal-<date>.json` 的 `tasks` 并回 `tasks.json` 即恢复板面；恢复前建议 `checkpoint_create`。
  - 兜底：`checkpoint_create` 存档（含 storages，不含 `.taskboard`）——板面数据的独立备份需手工 `copy tasks.json`。

## 9 · 实践修订记录

**2026-09-14 补课：本插件此前无语义文档（可维护性工程）**

- 语义**被确认**：
  - 「终态轮转 = 归档而非删除」在实现中成立（`index.ts:90` 合并写 + `:98` 失败回退），与主人 2026-09-13 定调一致。
  - 读路径自动轮转（`loadBoard` → `rotateTerminal`）是最初事故（板面 26 条含 18 条 done 常驻）的**根因修复点**。
- 语义**被补充**（本文首次写清的部分）：
  - **`inject` 含 `memoryApi` = 激活门**：`dsh-agent-memory` 不在组合时本插件**不激活**（工具面直接消失）——这是「插件怎么突然没了」的第一排查项。
  - **`notifyOnPost` 线上为 `false`**：广播通知在当前 profile 是**关闭**的（工具描述仍写「发布后发排队通知」）——文档与描述以本文件为准。
  - Client 侧 GUI 槽位已撤（2026-09-13），`$mount`/typert remote 保留——此前 README 未记录该撤除。
- 语义**被修正**：无（未发现文档与实现冲突；此前无文档）。
- 教训（同时回写技能 `semantic-doc-first`）：**「配置值」是语义的一部分**——`notifyOnPost=false`、`mainSessionId` 锚点这类值不写进文档，读者就会按「默认行为」理解线上行为。补课文档必须核对**profile 里的实际 config**，不能只读源码默认值。

## 10 · 未决问题

- **U1 并发写保护**：`loadBoard/saveBoard` 无锁，两个并行实例同时 `claim` 同一任务会丢更新（§5.14 并行是常态工况）。倾向：写前 `statSync` 比对 mtime + 冲突重试，或改用追加式日志 + 折叠视图。需要主人裁决是否值得工程投入。
- **U2 读失败静默返回空板**：与「坏数据一律放行 + 落 issue」的纪律不符——建议加 `console/logger.warn` + 计数落盘（现存 `tasks.json` 被误删时目前**完全无声**）。
- **U3 `mainSessionId` 锚点腐化**：值为 `session-5a785c96-…`（09-13 的会话），而通知主路径已改为遍历 live agents；是否把锚点从「默认 assignee」职责中也去掉（改为「当前发起者」）？
- **U4 与 `dsh-agent-teams` 的职责边界**：分身派发记录是否必须写进任务板（当前是约定非机制）？
