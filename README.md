<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 
  inject: 'tools','agents'
  tools: taskboard_*
  runtime: host + client
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-taskboard — 任务板插件

DSH（DeepSeek Harness）插件：异步任务队列——主人或任何 agent 可发布任务（JSON 持久化），宿主 agent 空闲时自主领取并完成。

## 功能特性

- **异步队列**：发布只发 wakeup=false 排队通知，不打断会话
- **状态流转**：pending → claimed → done / cancelled（时间戳自动维护）
- **看板概览**：各状态计数 + 进行中任务
- **决策归爱丽丝**：插件只提供原语，领取/完成时机由 agent 自主判断

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-taskboard.git
cd dsh-agent-taskboard
pnpm install
pnpm build
```

## 使用

| 工具 | 说明 |
|------|------|
| `taskboard_post` | 发布任务（short/long、优先级、标签） |
| `taskboard_list` | 任务列表（状态过滤） |
| `taskboard_claim` | 领取任务 |
| `taskboard_complete` | 完成任务（附摘要） |
| `taskboard_cancel` | 取消任务 |
| `taskboard_update` | 更新任务 |
| `taskboard_status` | 看板概览 |

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
