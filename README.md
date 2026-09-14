<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 任务板——异步任务队列：主人或任何 agent 发布任务（JSON 持久化），宿主 agent 空闲时自主领取并完成；发布只发 wakeup=false 排队通知（不打断会话），终态自动轮转归档
  inject: host='tools','agents','memoryApi' / client='slots','remote'
  tools: taskboard_post, taskboard_list, taskboard_claim, taskboard_complete, taskboard_cancel, taskboard_update, taskboard_status（另有 client 侧 remote 挂载与 `taskboard-ui` 动态插件，当前不注册 GUI 槽位）
  runtime: host + client
  envDeps: 无强依赖（纯逻辑 + 标准 Node）；`boardFile` 默认依赖 `DSH_HOME`——**部署应显式配置**，不要依赖源码里的硬编码回退
  boundary: 只提供原语，**领取/完成时机由 agent 自主判断**（插件不自动执行任何任务）；板文件是 read-modify-write，**无文件锁**——多实例并行写时后写者覆盖先写者（需靠协调纪律）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6 / dsh-client-runtime / dsh-client-ui-conversation
-->
# dsh-agent-taskboard

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-taskboard"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-7%20passed-brightgreen" alt="tests">
</p>

**一句话**：一块**异步任务板**——主人或任何 agent 把任务写上去（不打断当前会话），宿主 agent 在自己空闲时自主领取、完成、写摘要。

**为什么值得用**：跨会话协作需要一个**共享写入面**——「这件事我记下了，但不需要现在打断你」和「这件事我记下了，你得停下手里的活立刻做」是两种完全不同的语义。本插件只实现前者：发布只发 `wakeup=false` 的**排队通知**，不打断任何会话；领取与完成的时机**由 agent 自己判断**（框架给原语，不给剧本）。板面还会自动把终态任务轮转归档——**协调界面的信噪比就是它的价值**，一条 `done` 挂了三个月只会让看板越来越难读。

## 能力（7 个工具）

| 工具 | 用途（描述取自源码，逐字） |
|------|--------------------------|
| `taskboard_post` | 发布任务到任务板（异步队列）：主人或任何 agent 可调用；发布后发排队通知（不打断会话），宿主空闲时自主领取。参数：`title`（必需）、`description`、`type`（`short`/`long`）、`priority`（`low`/`normal`/`high`）、`tags` |
| `taskboard_list` | 列出任务板任务（可按状态过滤；缺省全部） |
| `taskboard_claim` | 领取任务：`pending` → `claimed`（默认领取者为主会话；可指定 `assignee`） |
| `taskboard_complete` | 完成任务：`claimed` → `done`，附完成摘要（`summary`） |
| `taskboard_cancel` | 取消任务：任意未完成状态 → `cancelled`（附原因） |
| `taskboard_update` | 更新任务（标题/描述/优先级/标签/状态流转；状态流转自动维护时间戳） |
| `taskboard_status` | 任务板看板概览（各状态计数 + 进行中任务） |

状态机：`pending` → `claimed` → `done`，任一未完成状态 → `cancelled`。流转时自动写时间戳（`claimedAt` / `doneAt`）；`claim` 未指定 `assignee` 时用 `mainSessionId`。

**client 侧**：`./client` 导出会 `$mount` 一个 typert remote 并注册 `taskboard-ui` 动态插件（`inject: ['slots','remote','remote.taskboard']`）。**当前不再注册任何 GUI 槽位**——任务板界面已迁为面板宿主里的一页；`$mount` 与 remote 保留（宿主侧工具不受影响），要恢复会话头入口需在 `src/client/index.ts` 重新 register。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-taskboard": "link:<工作区>/self-plugins/dsh-agent-taskboard"
```

**2) 构建**：

```bash
cd self-plugins/dsh-agent-taskboard && npm install && npm run build && npm test
```

**3) 挂组合**（web profile；**`mainSessionId` 无默认值，必须显式配置**）：

```yaml
- id: agent-taskboard
  name: dsh-agent-taskboard
  config:
    boardFile: <绝对路径>/tasks.json     # 强烈建议显式配（见「配置」节）
    mainSessionId: session-<id>          # 领取任务的默认 assignee
    notifyOnPost: true
```

**4) 30 秒验证**：

```text
① taskboard_status
   → 期望：`【任务板】待办 N | 进行中 N | 完成 N | 取消 N`
② taskboard_post { title: "readme 验证任务", type: "short" }
   → 期望：返回新任务 id；其他 live 会话收到一条排队通知（wakeup=false，不打断）
③ taskboard_complete { taskId: <id>, summary: "验证完成" }
   → 期望：状态 → done
④ taskboard_status
   → 期望：完成计数 +1（下次读取板文件时该终态任务已被归档移除）
```

## 配置

（键名与 `src/index.ts` 的 `Config` schema 一致；默认值取自源码）

| 项 | 默认 | 说明 |
|----|------|------|
| `boardFile` | `$DSH_HOME/.taskboard/tasks.json` | 板文件路径。**注意**：源码在 `DSH_HOME` 未设时回退到一个硬编码本地路径——**部署请显式配置**，别依赖这个回退 |
| `mainSessionId` | **无默认（必填）** | 主会话 id：领取任务的默认 `assignee`，也是排队通知的兜底收件人 |
| `notifyOnPost` | `true` | 发布新任务时是否发排队通知（`wakeup=false`） |

> 归档保留期是**源码常量**而非配置项：`TERMINAL_RETAIN_DAYS = 0`——终态任务在下一次读取板文件时即被轮转归档。

## 落盘与自证（出问题时先看这里）

本插件**不写 `*-trace.jsonl` 阶段轨迹**；它的持久产物就是**板文件 + 归档**：

| 文件 | 谁写 | 内容 |
|------|------|------|
| `<boardDir>/tasks.json` | 本插件（每次写操作整体覆盖） | 板面：`{ tasks: Task[] }`。每条含 `id` / `title` / `description` / `type` / `priority` / `tags` / `status` / `assignee` / `createdAt` / `claimedAt` / `doneAt` / `summary` |
| `<boardDir>/archive/terminal-<date>.json` | 本插件（终态轮转时） | 归档：`{ archivedAt, note, tasks[] }`——超期终态任务**归档而非删除**，可回查，恢复 = 手工并回 `tasks.json` |

**一条命令答五问**：

```bash
node -e "const fs=require('fs');const d=(process.env.DSH_HOME||'.dsh')+'/.taskboard';const b=JSON.parse(fs.readFileSync(d+'/tasks.json','utf8'));console.log('n='+b.tasks.length);console.log(b.tasks.map(t=>[t.status,t.priority,t.id,t.title,t.assignee||'-',t.claimedAt||t.createdAt].join(' | ')).join('\n'));try{console.log('archive:',fs.readdirSync(d+'/archive').join(','))}catch(e){console.log('archive: 无')}"
# ① 跑的是哪个构建 → 取不到（板文件无 build 自报）；用「生效判据」节的 plugin_boot_status / lib mtime 判
# ② 谁发起        → task.assignee（claim 时缺省 = mainSessionId）+ createdAt/claimedAt 时间戳（谁在何时领的）
# ③ 断在哪一段   → 状态分布即断点：post 后 pending 仍在但没人 claim = 排队通知没送到或无人空闲（不是故障，是设计）；claimed 长期不 done = **领了没收口**（常见真问题）
# ④ 结果质量     → task.summary（完成摘要）+ archive 文件是否在长（归档机制在工作）
# ⑤ 耗时与预算   → createdAt → claimedAt → doneAt 三点时间戳，可算排队时延与执行时长
```

> **写操作的副作用要知道**：每次保存都**整体覆盖** `tasks.json`，且终态轮转在**读取时**触发（`loadBoard` 里做归档）。因此「读完板文件」这个动作本身可能改变磁盘内容——这既是它自动保持整洁的原因，也是**并发写入会互相覆盖**的原因（见「设计要点」）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. 行为级（最直接）：`taskboard_status` 能返回计数（工具在工具面上），且 `taskboard_post` 之后 `<boardDir>/tasks.json` 的 mtime 前进 ⇒ 工具面与持久化都在工作；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回的 `liveNow` 含本插件 ⇒ 进程在跑它；
3. 构建级：`lib/index.js` 的 mtime **早于** web 进程启动时间 ⇒ 当前进程加载的是这个产物。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。本插件也没有 `hasUnverifiedBuilds()` 类兜底，构建完必须重启 web 才生效。**client 侧另有构建产物**（`lib/client.js`），它要靠 Web 端重新构建/刷新页面才更新。

**回退**（三档）：

- 源码级：`git -C self-plugins/dsh-agent-taskboard revert <commit>` → `npm run build` → `npm test` → 预检 → 重启；
- 组合级：给 profile 里 `agent-taskboard` 行加 `disabled: true`（或把 `notifyOnPost` 置 `false` 只静音通知）→ 重启；
- 运行期：**板文件即数据，回退插件不会删它**。要清板面就直接编辑 `tasks.json`（保留结构 `{ "tasks": [] }`）；归档文件可随时归档/删除（删除只影响回查）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，需先 npm run build）
```

**7 例离线测试全部通过**（`# pass 7 / # fail 0`）：

| 文件 | 覆盖 |
|------|------|
| `tests/retention.test.mjs` | 终态轮转纯函数 `splitTerminalForArchive`：终态（`done`/`cancelled`）超保留期 → 归档；**未终结（`pending`/`claimed`）永不动**；轮转**幂等**（同输入重复执行结果一致，且不产生空归档文件）；时间戳缺失/异常的退化输入 |

**覆盖范围的诚实说明**：当前**只有终态轮转**这一层有单测——7 个工具的 `execute` 路径（读写板文件、状态流转、通知投递）**没有离线单测**，回归靠实际使用观察。这是本仓库已知的测试缺口，不是「已覆盖」。

**无网络依赖、无真实外部服务依赖**：唯一测试文件是纯函数测试，不碰磁盘、不发通知。

## 设计要点

- **发布 ≠ 命令执行**：`taskboard_post` 只写板面并投递 `wakeup=false` 的排队通知——**不打断任何会话**。这是「异步队列」与「立即指令」的分界；需要立刻做，就不该走任务板。
- **决策归 agent**：插件不自动领取、不自动完成、不自动分配。领取时机与完成时机是 agent 的判断（框架给原语，不给剧本）。
- **终态必须轮转**（2026-09-13 事故）：板面曾累积到 26 条、其中 18 条 `done` 常驻——没有任何终态处理，板子越长越难读。修法是**归档而非删除**（写 `archive/terminal-<date>.json`，可回查），未终结任务永不动，且轮转幂等（不产生空归档文件）。**信噪比是任务板作为协调界面的生命线。**
- **`mainSessionId` 是身份锚点**：它只在**新鲜有效**时才有意义，且必须是 `session-*` 用户会话（子代理裸 uuid 不可投递）。写入配置前先确认它是当前在用的会话 id。
- **并发写入未加锁（必须知道的边界）**：板文件是 read-modify-write（读 → 改 → 整体覆盖），**没有文件锁**。同一块板被多个实例同时写时，**后写者覆盖先写者**。因此跨实例协作时必须遵守「写入前先看别人做过什么」（查 `git log` / 事件日志 / 板面现读），而不是假设只有自己在写。**现读，不用历史快照。**
- **归档不丢信息**：完成调用当场返回完整摘要，归档文件保留全量任务对象——所以「从板面移除」不等于「信息消失」。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `delegated-backfill-orchestration` / `dsh-plugin-development` / `plugin-maintainability` | 委派式批量任务的分派/验收/收口、插件开发与组合契约、可维护性五问 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
