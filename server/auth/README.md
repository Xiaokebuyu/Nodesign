# server/auth/ — 鉴权（内核半）

2026-09-13 auth-v2 起的形态。设计方案：`~/claude-report-file/0913-auth/登录体系升级-设计方案.md`。

## 分工

| 位置 | 管什么 | 进不进桌面包 |
|---|---|---|
| `server/auth/`（这里） | 解析请求身份（`session.requestAuth`）、登录墙开关、用户表读侧、`/api/auth/status`、`authGuard`、内部凭证 | 进 |
| `server/hosted/auth/` | 会话表、验证码、发信、密码底线、审计、邮箱注册 / 验证码登录 / 找回密码、账号与安全接口 | 不进 |
| `server/hosted/auth-routes.js` | 密码登录、老的用户名注册、两层爆破锁（`checkPassword`，relay 的桌面登录也用） | 不进 |

内核不许 import hosted（`server/scripts/check-client-boundary.mjs`）。hosted 起动时调 `installSessionBackend()`
把会话解析函数注入内核；本地分发版没有这一步，登录墙钉死关闭，请求者恒为 `LOCAL_OWNER`。

## 身份从哪来（`requestAuth` 的顺序）

1. 登录墙关闭 → `LOCAL_OWNER`
2. `nd_internal` cookie → 进程内短期凭证（感知工具的无头浏览器，`internal-credentials.js`）
3. 装了后端 → 服务端会话（`__Host-nd_auth` / http 下 `nd_auth`，值 `s1.<id>.<secret>`）；过渡期兼认旧 v2 token 并静默换发
4. 没装后端（脚本、单测）→ 只认旧 v2 token

## 吊销

- 单条会话：`revokeSession`（退出登录、账号页删一条）
- 全部 / 除当前外：`revokeUserSessions`（改密码、找回密码、「退出其他设备」、停用）。同时写 `users.sessions_valid_after`
  （旧 v2 token 按签发时间判）、清内部凭证、断开 WebSocket（`ws/auth-sockets.js`）
- 桌面设备令牌另算：`hosted/relay/devices.js` 的 `revokeUserDevices`
