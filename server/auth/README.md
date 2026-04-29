# server/auth/ — 鉴权（占位）

⚠️ **暂不实现**。组长说"账号/鉴权/部署 复用已有平台基础设施"——但**"已有平台"具体指什么尚未确认**（[HANDOVER.md](../../HANDOVER.md) §五 Q1）。

## 三种可能形态

| 形态 | 对接方式 | 复杂度 |
|---|---|---|
| **A. 平台 SSO**（最可能） | 接平台的 OAuth/OIDC，验 platform issued token | 看平台文档 |
| **B. 自建** | JWT + bcrypt，复用 [dev/server/middleware/auth.js](../../../dev/server/middleware/auth.js) 模式 | 中 |
| **C. 内部测试期** | 单一 `INTERNAL_API_TOKEN` Bearer，绕过用户系统 | 极低（MVP 用） |

## 决策点

跟组长对齐前先用 **C**——MVP 阶段只对内部测试者开放，避免锁错鉴权架构后期重构。

对齐到具体平台后再写 `auth/middleware.js` + `auth/session.js`。
