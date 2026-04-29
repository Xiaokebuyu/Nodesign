# server/api/ — HTTP API 入口

Nodesign 对外的公网 / 内网 HTTP 接口层。

## 计划路由（待实现）

```
POST   /engine/runs                  启动一个 skill run
       body: { skill, brief, style_reference?, tools?, options? }
       → 201 { run_id, status, stream_url }

GET    /engine/runs/:id              查 run 状态
GET    /engine/runs/:id/stream       SSE 实时进度（text/thinking/tool_call/screenshot/done）
GET    /engine/runs/:id/artifacts    列产物
GET    /engine/runs/:id/artifacts/:filename   下载/打开（deck.html 直接可看）
POST   /engine/runs/:id/cancel       取消

POST   /style/extract                上传素材 → 提 style tokens
       body: multipart (file) | { url }
       → { task_id }
GET    /style/tasks/:id              提取结果

POST   /edit/sessions                启动 edit 会话（绑定一个 deck）
POST   /edit/sessions/:id/messages   发指令
GET    /edit/sessions/:id/stream     SSE
```

## 鉴权（待组长确认）

7 个待对齐问题里有"已有平台具体指什么" → 决定鉴权方式：
- 平台 SSO：复用平台的 token / cookie
- 自建：JWT + bcrypt
- 内部测试期：仅 `INTERNAL_API_TOKEN` Bearer

外部 API 必加：rate limit、CORS、CSRF（如有 cookie 鉴权）。

## 调用方

- **Web 前端**（[Nodesign/web/](../../web/)，待建）—— 主入口
- **小合**（[dev/server/bot/](../../../dev/server/bot/)）—— 内部 fn call，复用 `INTERNAL_API_TOKEN`
- **第三方 / CLI**（远期）

## 框架选择

Express 5（与 dev/ 一致，复用度高）。如果未来 SSE 量大可换 Fastify。
