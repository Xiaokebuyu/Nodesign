# auth-v2 上线清单（第一批：服务端地基；第二批：Google / GitHub 登录）

设计方案：`~/claude-report-file/0913-auth/登录体系升级-设计方案.md`。本清单只管部署动作。

## 1. 环境变量（服务器 `.env`，值不进仓库、不进对话）

| 键 | 生产 | exp（8443） |
|---|---|---|
| `NODESIGN_SESSION_COOKIE` | 不设（默认 `nd_auth`） | `nd_auth_exp`（同主机不同端口，不换名两边登录互相覆盖） |
| `NODESIGN_SES_ACCESS_KEY_ID` / `NODESIGN_SES_SECRET_ACCESS_KEY` | 栈 `nodesign-ses` 的 SenderUser 在控制台生成的访问密钥 | 同一把即可 |
| `NODESIGN_MAIL_PROVIDER` | 不设（钥匙齐了自动 ses） | 不设 |
| `NODESIGN_TURNSTILE_SITE_KEY` / `NODESIGN_TURNSTILE_SECRET_KEY` | Cloudflare 控制台建的 Invisible 组件 | 同一个组件（域名一致） |
| `NODESIGN_LEGACY_TOKEN_UNTIL` | **站主定**：旧登录状态在 https 下认到什么时候（ISO 时间）。不设 = 上线即全员重新登录一次 | 不设 |
| `NODESIGN_COOKIE_PARENT_DOMAIN` | `xiaobuyu.trade`（换发 / 退出时连父域那份旧 cookie 一起清） | 同 |

⚠️ `NODESIGN_LEGACY_TOKEN_UNTIL` 的取舍：过渡期内，能发布站点的账号（pro 档）可以从 `*.share` 子域往旧 cookie 名里投自己的旧登录状态，
让没登录的访客被登进攻击者的账号（fable 09-13 代码评审，只能缩短窗口不能消除）。反过来，不给过渡期时，150 个没绑邮箱的老用户里
忘了密码的人就再也登不回来。建议：给 14 天，同时上线「绑定邮箱」提示条，让老用户在还登着的时候把邮箱绑上。

### 第二批新增（Google / GitHub）

| 键 | 生产 | exp（8443） |
|---|---|---|
| `NODESIGN_PUBLIC_ORIGIN` | `https://nodesign.xiaobuyu.trade` | `https://nodesign.xiaobuyu.trade:8443` |
| `NODESIGN_GOOGLE_CLIENT_ID` / `NODESIGN_GOOGLE_CLIENT_SECRET` | Google Cloud Console 的 Web 客户端 | 同一个客户端 |
| `NODESIGN_GITHUB_CLIENT_ID` / `NODESIGN_GITHUB_CLIENT_SECRET` | GitHub OAuth App | 同一个 App |

在服务商那边登记的回调地址（一字不差）：

- Google「已获授权的重定向 URI」：`https://nodesign.xiaobuyu.trade/api/auth/oauth/google/callback`，exp 另加 `https://nodesign.xiaobuyu.trade:8443/api/auth/oauth/google/callback`（Google 是否接受带端口的地址未确认，登记不上就只做生产）
- GitHub「Authorization callback URL」：`https://nodesign.xiaobuyu.trade/api/auth/oauth/github/callback`；exp 的地址加在同一个 App 的其他回调地址里
- Google 同意屏幕：应用名 NoDesign、授权域名 `xiaobuyu.trade`、scope 只要 `openid` `email` `profile`；隐私政策与服务条款页在第三批上线后再提交品牌验证

## 2. nginx：首页分流认新 cookie 名

`/etc/nginx/sites-enabled/nodesign` 现在是 `if ($cookie_nd_auth = "") { return 302 /welcome/; }`。
新会话在 https 下叫 `__Host-nd_auth`，nginx 的 `$cookie_` 变量名不能带连字符，改用 `map`（放在文件顶部 server 块之外，
sites-enabled 被 include 在 http 上下文里）：

```nginx
map $http_cookie $nd_has_session {
    default 0;
    "~(^|;\s*)(__Host-)?nd_auth=[^;]" 1;
}
```

`location = /` 里改成：

```nginx
if ($nd_has_session = 0) { return 302 /welcome/; }
```

⛔ 备份文件别放 `sites-enabled/`（会被 include，duplicate 报错）。改完 `sudo nginx -t` 再 reload。
**必须和服务端同时上线**：服务端先上、nginx 没改，已登录用户访问根路径会被送去官网。

## 3. 上线后行为变化（给公告用）

- 设了过渡期：网页用户不需要重新登录，旧登录状态第一次访问时自动换成新会话，到期后没换过的需要重新登录。
- 没设过渡期：所有网页用户重新登录一次。
- 登录框接受邮箱或用户名；「账号或密码错误」统一提示。
- 桌面版不受影响（0.1.42 及以前用账号密码换设备令牌的接口不变）。

## 4. 验证

```bash
node --env-file=.env server/scripts/turnstile-report.mjs          # 测量数据
aws sesv2 get-email-identity --region ap-northeast-1 --email-identity nodesign.xiaobuyu.trade   # SES 身份验证状态
sqlite3 server/db/nodesign.db "select type, count(*) from auth_events group by type"            # 审计
```
