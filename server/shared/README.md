# server/shared/

从小合（[dev/server/bot/](../../../dev/server/bot/)）抠出来的**真正通用、跟工单业务无关**的基建文件。

## 文件清单

| 文件 | 来源 | 改动 |
|---|---|---|
| `anthropic-client.js` | `dev/server/bot/anthropic-client.js` | env 名 `MINIMAX_*` → `KIMI_*`；baseURL 默认值切 Moonshot；timeout 600s（长任务） |
| `agent-loop.js` | `dev/server/bot/agent-loop.js` | 仅改 env 名 `BOT_TOOL_TIMEOUT_MS` → `ENGINE_TOOL_TIMEOUT_MS`，默认 30s → 60s；其余照搬 |
| `concurrency.js` | `dev/server/bot/concurrency.js` | 注释从"飞书 user open_id"泛化为"key"；env 名加 `ENGINE_` 前缀；`enqueueMessage` 改 `enqueueTask` |
| `time.js` | `dev/server/utils/time.js` | 零改动 |

## 不该往这里加东西的判断

- 业务（工单 / 钩子 / 飞书卡片）→ 不该来
- 跟 dev/ 共演化的核心抽象 → 暂时直接复制；如果开始反复同步两边，就提到 monorepo `shared/` 包

## 待验证（动工前必做）

- [ ] `cache_control: { type: 'ephemeral' }` 在 Kimi Anthropic 兼容端点是否生效
- [ ] `anthropic-beta: interleaved-thinking-2025-05-14` header 是否被 Kimi 接受
- [ ] 流式 `tool_use` + `input_json_delta` 行为一致性

写一个 `server/_probe-kimi.js`（30 行 JS）跑一遍。`npm run probe:kimi`。
