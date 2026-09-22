# 语义文档：dsh-agent-taskboard（任务板 · 异步任务队列）

> 版本 v0.2 · 2026-09-22 · 作者：爱丽丝 · 状态：**implemented**（26 条验收已实测 17 / 待验收 9 ⇒ 未达 `verified`）
> 开发方式：语义文档优先（本份是 2026-09-14 可维护性工程的**补课**文档）
> 实现落点：`self-plugins/dsh-agent-taskboard/src/`（工具面 `index.ts` · 状态机 `statemachine.ts` · 严格读写 `board.ts` · 归档回查 `archive.ts` · 远程服务 `remote.ts` · 轮转 `retention.ts` · 定时 `schedule.ts` · Fabric 入口 `fabric.ts` · 客户端 `client/index.ts`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-taskboard（任务板 / 异步任务队列 + 协调界面） |
| 主副本路径 | `self-plugins/dsh-agent-taskboard/docs/semantic.md`（本文件） |
| 实现落点 | `src/index.ts`（**10 个工具** + 通知 + 终态轮转接线）、`src/statemachine.ts`（状态机 v2：五态 / 流转白名单 / blocked 三件套 / 停滞判据，纯函数）、`src/board.ts`（读路径**单一真源**：严格读 vs 只读面宽松读）、`src/archive.ts`（终态归档回查）、`src/remote.ts`（Typert Remote 服务 `taskboardRemote`，namespace `taskboard`）、`src/retention.ts`（轮转纯函数）、`src/schedule.ts`（时间提醒）、`src/client/index.ts`（client 插件：`$mount` remote） |
| 版本 | 0.2.0（git head `7f6979f`） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` 的 `insert` 块：行 id `agent-taskboard`、name `dsh-agent-taskboard`、config `boardFile: E:/alice/.taskboard/tasks.json`、`notifyOnPost: false`。⚠ **按行 id 定位、不要按行号**（行号随 patch 变更漂移）；⚠ `mainSessionId` 自 **I18** 起**降级为兜底**——claim 的缺省 assignee 是**调用者会话**，写死的会话 id 会腐化（§5.14 锚点教训） |
| 状态 | **implemented**（实现落点齐全、26 条验收 17 条已实测；未达 `verified`——`pending≠0`） |
| 测试 | `tests/{statemachine,board,archive,schedule,retention}.test.mjs` |

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

### 4.4 时间提醒与定时任务（2026-09-20 新增能力 · 主人指令）

> 一句话：**给任务加上时间维度**——到点提醒、可重复；**仍然不自动执行任何任务**（调度只送达信号）。

| 字段 | 形状 | 语义 |
|---|---|---|
| `remindAt` | ISO 8601 字符串 | 一次性提醒时刻（首次时刻；与 `repeatMinutes` 组合时为「首次 + 周期」） |
| `repeatMinutes` | 正整数 | 周期（分钟）。触发后 `nextAt` 前进到**严格大于 now** 的下一时刻 ⇒ **错过 N 轮只触发一次**（不堆积补发） |
| `nextAt` | ISO 8601 | **下次触发时刻**（运行态字段，插件维护；无 `repeatMinutes` 时恒等于 `remindAt`） |
| `lastFiredAt` / `fireCount` | ISO / 整数 | 触发留痕：防重复触发 + 可审计 |
| `wake` | 布尔 | 该提醒是否**唤醒**会话（缺省取 `config.remindWakeup`） |
| `notifySession` | 会话 id | **触发者绑定**：设定提醒的会话（`exec.agent.session.id`）——投递首选目标 |

| 工具 | 参数 | 语义 |
|---|---|---|
| `taskboard_post`（扩展） | `+ remindAt? / repeatMinutes? / wake?` | 发布时即带提醒 |
| `taskboard_remind`（新） | `taskId? · action: set\|clear\|list · at? · repeatMinutes? · wake?` | 设/挪/清提醒；`list` 列出全部待触发（按 `nextAt` 升序） |

**时间输入形态**（`src/schedule.ts parseWhen`，纯函数）：ISO 8601 · 相对偏移 `+30m`/`+2h`/`+1d`/`+90s` · 当日 `HH:MM`（已过则顺延次日）· `YYYY-MM-DD HH:MM`（本地时区）。**非法输入抛错**——不静默取 now（否则「以为设了提醒，实际立刻触发」）。

**触发面（双路 · §5.10 预防性存活）**
1. **周期扫**：`setInterval(guarded('sweep', () => sweepOnce(deps)), config.sweepSeconds × 1000)` + `.unref()`；`ctx.effect` 里 `clearInterval` 清理。
2. **启动即扫**：`apply` 内立即跑一次——补上「进程不在时错过的窗口」。

**投递语义（§5.18 触发者绑定）**：首选 `notifySession`（设定者会话）→ 不可达时**回退广播 live agents**，两条路径都在痕迹里记 `deliver-via: bound|broadcast`；**成败皆留痕**。

**不变量**

- **I7 不自动执行 `[MUST]`**：调度**只送达提醒**，绝不替 agent 领取/执行/完成任何任务——本插件的根边界不因新增调度而松动（「框架给原语，不给剧本」）。
- **I8 一次触发一次通知 `[MUST]`**：同一 `nextAt` 至多投递一次（判据 `lastFiredAt ≥ nextAt` ⇒ 不再触发）；重复投递视为缺陷。
- **I9 重复任务不堆积 `[MUST]`**：`repeatMinutes` 任务触发后 `nextAt` 前进到严格大于 now 的下一时刻——错过 N 轮只触发一次，不补偿堆积。
- **I10 调度失败可见 `[MUST]`**：扫/投递的每次异常都落 `taskboard-trace.jsonl`；`sweep` 回调**必须**包 `guarded()`（逃逸异常 = 宿主死因，§5.24）。

### 4.5 任务状态机 v2 与「状态更新不可静默出错」（2026-09-22 · 主人「改进任务板和工作流，重点围绕任务的状态更新和管理」）

> 一句话：**让状态说实话**——`claimed` 不再同时表示「我在做」「我在等外部」「我卡住了」。

**改版动机（全部为 2026-09-22 实测读数，不是推测）**

| 观测 | 值 | 暴露的缺陷 |
|---|---|---|
| 两条 `claimed` 停滞 | `t-3b11f500` 5.3 天 / `t-d426e3f4` 5.6 天，期间无任何痕迹 | **R2 停滞不可测**：插件从不写 `updatedAt`（只有 `createdAt`/`claimedAt`/`doneAt`） |
| 两条 `claimed` 语义相反 | 一为「等外部首单」（我动不了），一为「判据失效待换判据」（我该动） | **R1 缺 `blocked` 态**：`claimed` 一词装两种相反处境 |
| `taskboard_list status=done` | 恒 `0` 项 | **R4 终态不可回查**：`TERMINAL_RETAIN_DAYS=0` 即时归档，而**没有任何工具读归档**（`index.ts` 旧注释「可用 taskboard 工具回查」当时是**假话**） |
| `assignee` | 两条均 = `session-5a785c96-…`（**腐化锚点**，非运行中会话） | **R7 谁在做不可信**：`claim` 无条件写 `config.mainSessionId` |
| `loadBoard` 读失败 | 静默返回 `{tasks:[]}`，随后 `saveBoard` 整写 | **R8 静默数据销毁**：坏文件在场时一次 `post` 会把整块板覆盖成 1 条 |
| 双实现漂移 | 面板 `dsh-panel/panels/taskboard.ts` **写** `updatedAt`、缺省 assignee `'alice'`；插件**不写** `updatedAt`、缺省 assignee = `mainSessionId` | **R9 一块板两套语义**（见 U7） |

**状态机（v2 · 五态）**

```
pending ──claim──▶ claimed ──block──▶ blocked
   │                  │  ◀──unblock──┘
   │                  ├──complete──▶ done
   └──cancel──────────┴──cancel────▶ cancelled
```

| 状态 | 含义（**互斥**，这是本版的核心） | 必带字段 |
|---|---|---|
| `pending` | 未被认领，等有人接手 | — |
| `claimed` | **我正在做**（近期有活动） | `assignee` / `claimedAt` / `updatedAt` |
| `blocked` | **我动不了，在等一个具体的东西** | `blockedReason` / `nextAction` / `reviewAt` / `updatedAt` |
| `done` / `cancelled` | 终态（出板归档） | `doneAt`（done）/ `summary` |

**流转白名单（`src/statemachine.ts`，纯函数）** `[MUST]`——**未列出的流转一律抛错**，不静默改状态：

| from | 允许的 to |
|---|---|
| `pending` | `claimed` · `cancelled` |
| `claimed` | `pending`（**释放**：认领后发现不该我做——2026-09-22 dogfooding 补的缺口）· `blocked` · `done` · `cancelled` |
| `blocked` | `claimed` · `cancelled` |
| `done` / `cancelled` | `pending`（**重开**：必须带 reason）——终态不可被任何路径**静默**复活；本行原写「（无）」，2026-09-22 与实现对齐 |

**「下次动作」的显式承诺**：`blocked` 必带 `nextAction`（下次做什么）+ `reviewAt`（何时再看一眼）。二者与既有提醒面（`remindAt`/`nextAt`）打通：`reviewAt` 到点进 `taskboard_status` 的「待复查」段。
⇒ 我先前手工给两条停滞任务设 `repeatMinutes:1440` 提醒，本质是**缺这个字段的 workaround**——机制该自带的东西不该由手工纪律补。

**不变量**

- **I11 读失败必须响亮 `[MUST]`**：`loadBoard` 仅在**文件不存在**（ENOENT）时返回空板；**解析失败 / IO 错误一律抛错**。理由：静默空板 + 后续 `saveBoard` = **整板被覆盖**。可测量：喂坏 JSON → 断言抛错，且 `tasks.json` 字节数与 mtime **均不变**。
- **I12 未列出的流转必拒 `[MUST]`**：可测量：`pending→done`、`blocked→done`、`done→claimed` 均抛错；`done→pending` **无 reason 抛错**、带 reason 放行；`claimed→pending`（释放）放行。
- **I13 `blocked` 必带承诺 `[MUST]`**：缺 `blockedReason` / `nextAction` / `reviewAt` 任一 ⇒ 抛错（「卡住了」必须说清：卡在哪、下次做什么、何时再看）。
- **I14 每次状态变更刷新 `updatedAt` `[MUST]`**：`post`/`claim`/`block`/`unblock`/`complete`/`cancel`/`update` 七条路径全部刷新——I15 的停滞判据依赖它。
- **I15 停滞可见 `[MUST]`**：非终态且 `now - updatedAt > STALE_DAYS`（缺省 3 天）⇒ 进 `taskboard_status.stale`（含停滞天数）。可测量：喂 `updatedAt` 4 天前的 `claimed` 样本 → 必须出现在 `stale`；喂刚更新的样本 → **必须不在**（对照组，防「恒报」）。
- **I16 终态可回查 `[MUST]`**：`taskboard_archive` 能列出/读取 `archive/terminal-*.json`（按日期、按 id）；且 `taskboard_list` 在终态查询无结果时**必须在消息里指明「终态已归档，用 taskboard_archive 回查」**——不再让调用者把「空结果」读成「没有完成的任务」。
- **I17 完成路径唯一 `[MUST]`**：`taskboard_complete` 与 `taskboard_update{status:'done'}` 走**同一个内部完成函数**（`doneAt` + `summary` + 记忆回流），不允许两条路径产出不同结果。
- **I18 `assignee` 取调用者 `[MUST]`**：缺省 assignee = **调用者会话 id**（`exec.agent.session.id`，与 §5.18 触发者绑定同源）；`mainSessionId` 仅在调用者不可得时兜底，且**该兜底必须可被审计**（trace 记 `assignee-source: caller|anchor`）。



## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`taskboard_post` 任何人可调（无鉴权）——板上内容**不可信输入**，只是文本（不执行、不解析为指令）。
- **不越界清单**：不执行任务（**2026-09-20 起有调度，但调度只送达提醒**——不领取、不执行、不完成任何任务；仍无子进程）；不删任务（`cancel` 是状态流转；`delete` 只在 client remote 的 `mutate` 里可用，工具面无删除参数）；不写会话事件以外的通道（通知走 `agent.send`，属正常会话事件，Model-visible ⟺ logged 满足）。
- **失败面**：
  - 读失败/坏 JSON → 空板（**放行 + 静默**）：代价是「看不见历史」，但不阻塞任何写入；⚠ 这是宽容策略，误删文件不会被察觉——见 U2。
  - 写失败（磁盘满/权限） → `writeFileSync` 抛错向上冒泡到工具层（**响亮失败**）；轮转路径例外：归档写失败回退「不轮转」（I4）。
  - 通知失败 → `catch {}` 静默（`index.ts:153`）：**已知缺口**——通知是协作信号，静默失败意味着「发了但没人知道」。当前接受该代价（任务本身已在板上可见）。⚠ 新增的**提醒投递不走这条静默路径**（见下条）。
  - 回流失败 → 静默（`index.ts:253/255`）：任务完成不回滚。
  - **调度扫失败** → `guarded('sweep')` 捕获 + 落 `taskboard-trace.jsonl` 一行（**不静默**，I10/§5.24）；扫本身不阻塞任何工具调用。
  - **提醒投递失败** → 首选 `notifySession` 不可达即**回退广播 live agents**；两路都失败才记 `deliver-error`（**留痕不静默**——提醒是我的时间承诺，静默丢失比多发一条更糟）。
  - **时间输入非法** → `parseWhen` **抛错**（响亮失败）；绝不静默取 now（否则「以为设了提醒，实际立刻触发」）。


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
| §5.10（预防性存活） | 触发面**双路**：周期扫 + **启动即扫**——进程不在时错过的窗口由启动扫补上（治未乱，不靠「刚好在线」） |
| §5.12（提醒防静默失效） | 触发状态**落盘**（`nextAt`/`lastFiredAt`）而非只在内存 timer；投递前**重验判重**（`lastFiredAt ≥ nextAt` 则不发）；触发留痕可外部观察 |
| §5.18（触发者绑定） | 提醒首选投给**设定者会话**（`notifySession` ← `exec.agent`），`mainSessionId` 只作兜底；**不用「当前活跃会话」当代理量** |
| §5.24（异常隔离） | 扫回调包 `guarded()`；并有源码级契约测试断言 `setInterval` 回调必经 `guarded(`（逃逸异常曾杀过宿主 web） |
| 先例（同生态） | `dsh-agent-reflection`（`setInterval` + `unref` + `ctx.effect` 清理）、`dsh-agent-cluster`（`guarded()` 包回调 + 契约测试）——本插件的调度沿用同一形态 |

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
| A10 | 时间输入四形态都能解析，非法输入抛错 | `node --test tests/schedule.test.mjs`：ISO / `+30m` / `HH:MM`（已过顺延次日）/ `YYYY-MM-DD HH:MM` 各断言；`"nonsense"` 必抛 | **已实测**（2026-09-20 · 27/27 全绿） |
| A11 | 到点触发一次且**不重复** | 单测：`nextAt` 已过 + `lastFiredAt` 为空 → 命中；再跑一次（`lastFiredAt` 已写）→ 不命中（I8） | **已实测** |
| A12 | 重复任务**不堆积**（错过 N 轮只触发一次） | 单测：`nextAt` 是 5 轮前、`repeatMinutes=10` → `advanceNext` 返回严格 > now 的下一次（I9） | **已实测** |
| A13 | 终态任务不再触发 | 单测：`status=done`/`cancelled` 且 `nextAt` 已过 → 不计入 due | **已实测** |
| A14 | 扫执行点在 `guarded()` 内 + 定时器回调走它（源码级契约） | 单测：扫 `src/index.ts`，断言 `guarded('sweep'` 存在、`setInterval(` 回调为 `doSweep`、有 `ctx.effect` 清理与 `unref`；另断言纯逻辑层无 `child_process` 等（I7） | **已实测** |
| A15 | 冷路径：投递失败不吞（状态不动 + 下轮重试）、坏板不崩、无到点项零 IO | 单测：`sweepOnce` 三个退化样本（`deliver:'failed'` / `load:{}` / 未来时刻） | **已实测** |
| A16 | 线上真调：设提醒 → 到点真投递**且消息落进会话** | 2026-09-20 15:12 实测：`taskboard_post {remindAt:'+1m'}` → 15:13:50 痕迹 `deliver … via=bound` + `sweep due=1 fired=1 failed=0`；板面 `lastFiredAt`/`fireCount=1`/`notifySession=session-005ddf46-…`（**本会话**，触发者绑定生效）；**且提醒消息确实出现在会话里**（`【任务板·提醒】自检：…——到点了，是否处理由我判断（插件不代做）`）⇒ 投递链路 Model-visible ⟺ logged 成立 | **已实测**（重启生效后线上，含消息落地） |
| A17 | 痕迹可答「断在哪一段」 | `.taskboard/taskboard-trace.jsonl` 三行实录：`post`（含 remindAt）/ `deliver`（含 `via`/`fireCount`）/ `sweep`（含 `due/fired/failed`）；失败面另有 `deliver-error`/`sweep-error`/`save-error` | **已实测** |
| A18 | **读失败必须响亮**（I11）：坏板面不得被读成空板（否则下次写入覆盖整板） | `node --test tests/board.test.mjs`：坏 JSON / 顶层非对象 / 缺 `tasks` 数组 各断言抛错且消息含「拒绝以空板继续」；ENOENT → 空板；EACCES → 抛错；对照组正常板面读得回 | **已实测**（2026-09-22 · 6/6） |
| A19 | **非法流转必拒**（I12）：未列出的流转抛错；终态重开必须带 reason | `node --test tests/statemachine.test.mjs`：`done→claimed` / `pending→done` / `blocked→done` 抛错；`done→pending` 无 reason 抛错；**白名单内每一条放行**（防「全拒」伪装成合格） | **已实测**（2026-09-22） |
| A20 | **blocked 三件套齐全**（I13）：缺 `blockedReason`/`nextAction`/`reviewAt` 任一即拒 | 单测：三字段各缺一次断言抛错；齐了放行 | **已实测**（2026-09-22） |
| A21 | **每次状态变更刷新 `updatedAt`**（I14） | 线上真调后读板面：`updatedAt` 前进；纯内容更新（改描述）同样刷新 | **待线上验收**（重启后真调） |
| A22 | **停滞可见**（I15）：超阈值必报、未超阈值必沉默、终态必排除 | 单测：5 天前样本必现 + 1 小时前样本必不现 + `done`/`cancelled` 必不现（**三组对照**）；真数据：现存 11 条中**精确命中 2 条 claimed**（5.7 / 5.3 天），9 条 pending **零误报** | **已实测**（2026-09-22 · 单测 + 真板面） |
| A23 | **终态可回查**（I16）：归档能列能读；空结果必须指明方向 | 单测 `tests/archive.test.mjs`（解析/跨文件去重/三路过滤/坏文件/ENOENT）；真数据：9 个归档文件、**62 条**去重终态、坏文件 0，最近 5 条 = 2026-09-22 结案的 5 项 | **已实测**（2026-09-22） |
| A24 | **完成路径唯一**（I17）：工具面两条路 + GUI 面共用同一文本形状 | 单测：`completionMemoryText` 空摘要不留空段；源码级：三条路径均引用同一函数（无第二份文本拼接） | **已实测**（2026-09-22） |
| A25 | **`assignee` 取调用者**（I18）：缺省写调用者会话，锚点仅兜底且留痕 | 线上真调 `taskboard_claim` 后读板面 `assignee` = 当前会话 id；trace 含 `assignee-source` | **待线上验收**（重启后真调） |
| A26 | **状态变更留痕**（审计面）：每次流转落 `status-change` | 线上真调后 `grep status-change .taskboard/taskboard-trace.jsonl` 见 `from`/`to`/`by`/`reason` | **待线上验收**（重启后真调） |

## 8 · 与实现的关系

- **主实现**：`src/index.ts`（工具面 + 通知 + 轮转接线）。**服务层**：`src/remote.ts`（GUI 数据通道）。**纯函数层**：`src/retention.ts`（终态轮转）、`src/schedule.ts`（时间提醒）、`src/statemachine.ts`（状态机 v2：白名单/停滞/blocked 校验）、`src/archive.ts`（归档回查）、`src/board.ts`（板面读写单一真源）。
- **同语义副本（I1）**：无。GUI 页面 `self-plugins/dsh-panel/panels/taskboard.ts` 是本板面的**视图**，不是第二份语义（其语义主副本在 `dsh-panel/docs/semantic.md`）。
- **未实现 / 未验证部分（显式标注）**：
  1. **无并发写保护**：`loadBoard → 改 → saveBoard` 之间无文件锁（并行实例同时改会丢更新）——未验证的**已知风险**，见 U1。
  2. 通知静默失败（§5 失败面）无存活证据（无 `notifiedCount` 落盘）。
  3. `notifyOnPost` 在 profile 中为 `false` → **实际生产不广播**（工具返回值仍报「任务已发布」）；语义上「发布即通知」与线上配置不一致，以配置为准。
- **生效判据**（改了代码后怎么证明真的生效）：
  1. **产物 vs 进程**：`lib/*.js` 的 mtime 必须早于 web 进程启动时间——判据用 `plugin_boot_status` **现读**（本行原先写死了 09-13/09-14 两个历史值，写死一次就过期一次；这正是 §5.9·6「读数必须自带范围标注」在文档里的应用）。
  1b. **新工具可答**：`taskboard_block` / `taskboard_archive` 出现在工具面上（它们只在本版之后才存在 ⇒ 见到即证明新构建已加载）。
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

**2026-09-20 新增：时间提醒与定时任务（主人指令「给任务板插件添加到时间提醒机制和定时任务功能」）**

- 语义**被补充（新能力面）**：任务新增时间维度（`remindAt` / `repeatMinutes` / `nextAt` / `lastFiredAt` / `fireCount` / `wake` / `notifySession`），新增工具 `taskboard_remind`，`taskboard_post` 扩参；触发面**双路**（周期扫 + 启动即扫）；新增 `taskboard-trace.jsonl` 阶段痕迹。**先写文档后写码**（§5.20）——本次是文档先行的正面案例。
- 语义**被修正（边界表述，重要）**：§5「不越界清单」原文写「不执行任务（**无调度**/无子进程）」——新增调度后该表述**不再为真**，改为「**有调度，但调度只送达提醒**（不领取/不执行/不完成）」。**教训：「无 X」型断言会随能力增长静默腐化**——加能力时必须全文回扫「无/不」类句子。
- 设计取舍（三条，都为了不越过根边界）：
  1. **只提醒、不执行**（I7）：主人要的是「定时任务」，但**自动执行任务**会让插件从「原语」变成「剧本」——违背本插件定位与 §2.1（框架给原语，不给剧本）。故定调：**到点送信号，做不做由 agent 判断**。
  2. **错过只补一次**（I9）：周期任务错过 N 轮不补偿堆积——提醒的价值在「此刻该注意」，不在补账；堆积会制造噪音（信噪比是任务板的生命线）。
  3. **投递留痕不回退到静默**（§5 失败面）：既有 `notify()` 的 `catch {}` 是已知缺口；新的提醒投递**明确不走那条路**（先 bound 后 broadcast，两路皆失败才 `deliver-error`）。
- 语义**被补充（与纪律的同源关系）**：§6 新增四行，把 §5.10/§5.12/§5.18/§5.24 与本能力的对应点写明（不是装饰：每条都对应一个具体的实现约束与一条验收）。

**2026-09-22 补回丢失的节标题 + 状态诚实化（任务 t-df4642e5 · D4 归零）**

- 语义**被修正（结构性缺陷）**：`semantic_check` 报 D4「缺第 5 节」——**查证后真因不是内容缺失，而是标题行丢失**：§5 的三块内容（能力边界 / 不越界清单 / 失败面）一直在正文里，缺的是 `## 5 · 边界与信任` 这一行标题，行号直接从 I10 跳到 `## 6 · 既有机制的关系`。补回标题后 D4 归零。
  ⇒ **教训（与同日 `dsh-dream-tavern` 的 D4 假报互为补集）**：D4 的判据是**标题存在性**，不是内容存在性。两种误读都要防——
  ① 「措辞差一字」⇒ **假报**（`与实现关系` vs `与实现的关系`）；
  ② 「内容在、标题丢」⇒ **真报但诊断误导**（报「缺一节」，实际缺一行）。
  读 D4 的正确姿势：**先 grep 标题、再看内容**——不要凭报错文字直接下「补内容」的任务单（本任务的原描述就写成了「补缺失的第 5 节」，是误读）。
- 语义**被修正（声明 vs 事实）**：状态由 `draft` 改为 `implemented`——实现落点齐全、17 条验收 11 条已实测。**未标 `verified`**：`pending=6 ≠ 0`（§5.20 规则 4 硬判据）。声明状态应与现算状态一致，否则是「声明≠事实」的慢性病。

**2026-09-22 状态机 v2：从「状态会说谎」到「状态更新不可静默出错」（主人「改进任务板和工作流，重点围绕任务的状态更新和管理」）**

- **触发证据（先取证再动手）**：两条 `claimed` 在板上已停滞 **5.3 / 5.6 天**而机制一声不响，且二者含义**恰好相反**——一条「等外部首单」（我动不了），一条「判据失效待换」（我该动）。⇒ 真因**不是**「我忘了更新状态」，而是**状态模型缺态 + 停滞不可测**；所以修的是布线，不是更努力地记住（§5.10：默认行为由布线决定，不由意志决定）。
- 语义**被补充（新契约面 §4.5）**：五态状态机（新增 `blocked`）、流转白名单、`blocked` 三件套承诺、`updatedAt` 纪律、停滞判据、归档回查工具；新增不变量 **I11–I18** 与验收 **A18–A26**。
- 语义**被修正（两处「宽容」其实是数据销毁）**：工具面 `loadBoard` 与 GUI 面 `remote.load` **各自**都写 `catch { return [] }`，而调用方紧接着 `save(…)` ⇒ 文件一旦损坏，一次操作就把**整块板**覆盖成一条。改为 `src/board.ts` 单一真源（读路径可退化、写路径绝不可以）。**教训：「宽容的读」处在带写回的链路上时，等价于删除。**
- 语义**被修正（同一件事三种写法）**：完成路径原本一条写摘要 + 回流记忆、另一条两样都没有，GUI 面还有第三套（可静默复活终态）。现统一到 `changeStatus` + `completionMemoryText`。**教训：状态更新的正确性必须由机制保证，不能靠「记得走哪条路」。**
- 语义**被补充（工具面）**：新增 `taskboard_block`、`taskboard_archive`；`taskboard_status` 增 `stale` 与 `due` 两段；`taskboard_list` 在终态查询为空时给出归档指引（原先调用者会把「空」读成「没完成过」）。
- **未收口的部分如实标注**：面板 `dsh-panel/panels/taskboard.ts` 是第三套实现（U7）；client 枚举与 schema 未同步（U8）；`staleDays` 全局单值（U9）。
- 教训（待回写技能）：**「状态字段只有一个当前值」的模型一定会失真**——缺的从来不是纪律，而是「最后活动时刻」与「下次动作承诺」这两个字段。
- **dogfooding 当场发现自己的设计漏洞（上线 1 小时后）**：为验证 I18 领取了一条新任务，想退回时发现白名单**没有 `claimed → pending`**——「认领错了」没有出路，只能挂着 `claimed` 装活或谎报 `blocked`。⇒ 补上**释放**边（不需 reason；终态重开才需要）。**教训：状态机的**出边**必须覆盖真实处境的每一种收场**；只有「向前」没有「撤回」的白名单，会亲手制造它想消灭的那种失真。**这条缺口是被「上线后立刻拿真任务走一遍」抓到的，不是被单测抓到的**——判据能测出「非法流转被拒」，测不出「合法处境没有对应流转」。

## 10 · 未决问题

- **U1 并发写保护**：`loadBoard/saveBoard` 无锁，两个并行实例同时 `claim` 同一任务会丢更新（§5.14 并行是常态工况）。倾向：写前 `statSync` 比对 mtime + 冲突重试，或改用追加式日志 + 折叠视图。需要主人裁决是否值得工程投入。
- **U2 读失败静默返回空板** —— ✅ **已解决（2026-09-22 · I11）**：抽 `src/board.ts` 作单一真源，**读路径可退化、写路径绝不可以**；严格读的失败理由里写明「拒绝以空板继续」。判据 A18（含尸体样本）。
- **U3 `mainSessionId` 锚点腐化** —— ✅ **已解决（2026-09-22 · I18）**：`claim` 缺省 assignee 改为**调用者会话**（`exec.agent.session.id`），锚点仅兜底且 `assignee-source` 入 trace。判据 A25。
- **U4 与 `dsh-agent-teams` 的职责边界**：分身派发记录是否必须写进任务板（当前是约定非机制）？
- **U5 提醒的「唤醒」语义要主人拍板（2026-09-20 新增）**：`wake=true` 会**启动一次模型 turn**（真花钱）。当前默认 `remindWakeup=true`（主人明确要「时间提醒」，不唤醒的提醒等于没提醒），且**每个任务可单独设 `wake`**。若预算优先，可把 profile 里的 `remindWakeup` 改 `false`（提醒照常落消息，只是不主动唤醒）——**取舍归主人**。
- **U6 提醒与 life-core 感知圈的职责重叠（2026-09-20 新增）**：两者都能「到点叫醒我」。当前分工：任务板的提醒**绑任务**（有 `taskId`、有交付面），life-core 管**存在性节律**（感知圈/睡眠）。倾向：保持分工、不互相实现；若将来合并，必须保留「任务提醒」这一语义（否则任务的时间承诺失去归属）。
- **U7 状态机仍有三处实现（2026-09-22 新增 · 本轮只收口了两处）**：工具面 `src/index.ts`、GUI 面 `src/remote.ts`、面板 `dsh-panel/panels/taskboard.ts` 各自维护流转。本轮把前两者的**白名单与 `updatedAt` 纪律**统一到 `src/statemachine.ts`，但**面板是第三份**——跨插件导入被生态闸门禁止，正解是让面板调 `/api/taskboard/mutate` 而不是自己重实现。另：面板缺省 `assignee` 是字面量 `'alice'`（本插件是调用者会话）、面板计数与展示未含 `blocked`。**需要主人裁决是否值得工程投入**。
- **U8 GUI/客户端枚举未同步（2026-09-22 新增 · 有意为之）**：`src/client/TaskboardAction.tsx` 的 `STATUS_META` 仍只有四态（`blocked` 会落到 `pending` 的样式），`src/client/remote.ts` 的 zod schema 会**剥掉** `updatedAt`/`blockedReason`/`nextAction`/`reviewAt` 新字段。鉴于 §1 已记载「GUI 槽位 2026-09-13 撤除」，本轮**有意不改死界面**；若 GUI 复活，必须一并补枚举与 schema。**未验证**（本轮未在界面上实际打开确认槽位确实不存在，仅依据 §1 的既有记载）。
- **U9 停滞阈值是全局常量（2026-09-22 新增）**：`staleDays` 缺省 3 天、按 config 全局生效。但任务节奏差异大（长期任务 vs 当天活），一个阈值必然对某一类偏松或偏紧。倾向：先按全局跑一段，等出现「误报/漏报」的真实样本再考虑按 `type` 分档——**不为想象的需求加旋钮**。

