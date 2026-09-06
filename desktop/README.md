# 桌面版（Windows）

把本地分发版装进一个 Electron 壳：用户双击图标就能用，不用先装 Node、不用开终端。

跑的还是同一份服务端。`desktop/main.js` 和 `bin/nodesign.js` 是同一件事的两个外壳，
共用 `bin/supervisor.js`（挑端口、拉起 `server/index.js`、退出码 75 自动重启、等 health），
区别只在起来之后拿那个 URL 干什么：命令行版开系统浏览器，桌面版加载进窗口。

数据目录跟 `npx` 版共用同一个 `~/.nodesign`。同一个人今天用命令行、明天装桌面版，
项目和产物是同一份。

## 开发

```
npm install
npm run desktop:deps       # 必跑一次，见下
npm run build:web
npm run desktop:dev        # electron desktop/main.js
```

`desktop:deps`（`electron-builder install-app-deps`）把原生模块按 Electron 的 ABI 重编。
不跑它的话，服务端子进程一加载 `better-sqlite3` 就报
`NODE_MODULE_VERSION ... was compiled against a different Node.js version`。
原因是 `npm install` 按系统 node 的 ABI 编，而子进程跑的是 Electron 可执行文件的
node 模式（`ELECTRON_RUN_AS_NODE=1`）。换过 Electron 版本之后要再跑一次。

## 打包

```
npm run desktop:pack       # 只解包到 dist-desktop/，起得快，用来验行为
npm run desktop:dist       # 出 NSIS 安装包
```

**必须在 Windows 上跑**（或者 GitHub Actions 的 `windows-latest`）。三个产物得是真的
win32 二进制：SDK 的 `claude.exe`（平台包 `@anthropic-ai/claude-agent-sdk-win32-x64`）、
`better-sqlite3` 的 win32 预编译、`sharp` 的 `@img/sharp-win32-x64`。在 Linux 上让 npm
装另一个平台的包要一路 `--os/--cpu` 覆盖，装出来还没法跑起来验。在 Windows 上这些是
默认行为，不用任何特殊处理。

`better-sqlite3` 还有一层：它不是 N-API，ABI 锁在运行时版本上。服务端子进程跑的是
Electron 可执行文件的 node 模式（`ELECTRON_RUN_AS_NODE=1`），所以它必须按 Electron 的
ABI 编译，不是按系统 node 的。`electron-builder.yml` 里的 `npmRebuild: true` 负责这件事。
`sharp` 是 N-API，不受影响。

## 发布与更新

打包在 GitHub Actions 上做（`.github/workflows/desktop.yml`，`windows-latest`），产物直接进
GitHub Releases。发一版：

```
# 方式一：Actions 页面 → "desktop" → Run workflow
# 方式二：
git tag desktop-v0.0.10 && git push origin desktop-v0.0.10
```

跑完 Releases 里多一份**草稿** `v<package.json 的 version>`，里面是
`NoDesign-Setup-<v>.exe`、`.blockmap`、`latest.yml`。草稿只有仓库成员看得到 —— 自己先下来试；
试过了点 **Publish release**，装了旧版的用户端才会看到这次更新（`electron-updater` 读的是
GitHub Releases 的 `latest.yml`，仓库公开所以不用 token）。Actions 的 artifact 里也留了一份。

有 blockmap 对得上就下差分，对不上（比如跨了 Electron 大版本）自动退回下整包。
**完整包更新和差分更新不是两套配置，是同一套的两条路径。**

客户端启动时查一次，之后每 6 小时查一次，下完弹一次提示，用户点"立即重启更新"就装上；
不点的话下次退出应用时自动装。

装更新之前主进程会先把服务端子进程停干净（`sup.stop()`）。sqlite 还开着的时候换文件，
轻则更新失败重则库损坏。

## 还没做的

- **随包组件**。`electron-builder.yml` 的 `extraResources` 现在是空的。要装进安装包的：
  chromium（约 150MB）、LibreOffice（约 350MB）、ffmpeg、poppler、rembg 的 Python 环境
  加 u2net 模型（约 250MB）。做法是打包前用一个脚本抓进 `desktop/components/`，装机后解到
  应用目录，再让 `server/runtime/capabilities.js` 的探测认得那个目录
  （`whichBinary` 已经支持 `extraDirs`，加一个安装目录进去即可，不用改探测逻辑）。
  LibreOffice 是 MPL 2.0，随包分发允许，但要带上许可文件。
- **图标只是占位**。`desktop/build/icon.png` 和 `desktop/assets/tray.png` 是站点 favicon 那个
  深底 N 字（sharp 渲的），能用，想换就换掉这两个文件。
- **代码签名**。`electron-builder.yml` 里的 `certificateFile` 留空。没有证书的话，
  安装包首次运行会被 SmartScreen 拦一道"未知发布者"，用户要点两次才能装。
- **钥匙来源（客户端半）**。首启选"用服务器提供的 API"还是"自己带钥匙"。服务器那半
  （`server/hosted/relay/`，见下）已经在了；客户端还没有人把 SDK 的 base URL 指过去。
  要做的是在 `server/runtime/local-env.js` 的 `ENV_KEYS` 那张白名单表上加第三种来源
  （站点地址 + 设备令牌），然后 session-loop 在起 query 前 `POST /api/relay/sessions`，
  finally 里 `DELETE`；`ANTHROPIC_BASE_URL=<站点>/api/relay/__nd/<sid>`、
  `ANTHROPIC_AUTH_TOKEN=<设备令牌>`。设备令牌的签发界面（用户登录站点后铸一枚）也还没有。

## relay（服务器那半，已在）

hosted 起动时挂在 `/api/relay`（`server/hosted/mount.js`），本地版不挂。一发推理请求的路：

    设备令牌 → 用户          server/hosted/relay/devices.js（Bearer ndk_…）
    sid → 会话登记           sessions.js（起 query 前 POST /sessions {sid, appModel}）
    判决                      gates.js（档位 / 额度 / 外审，按**登记的** appModel，不按 body.model）
    转发                      订阅腿 subscription-leg.js（站主 OAuth）｜API 腿 = lib/model-ingress.handleRequest
    记账                      usage.js（每一发上游响应一笔；上游自报的钱优先，否则表价 priceTokens）

已知缺口：
- **订阅腿一次没打过真 Anthropic**。头的处理（换 Bearer、补 oauth beta）是按 SDK 的行为写的，
  没验过；token 过期不会自己刷新（refreshToken 在同一个文件里，先没做），日志会提示站主 `claude login`。
- **订阅用量记 0**。订阅行没有 prices，账本记 token 不记钱；pro 档走 relay 的订阅用量不进日额度。
- **API 腿的外审默认是关的**：`auth/tier.js` 三档的 `moderationDefaultApi` 都是 `'off'`（08-30 拍板的
  两栏口径），除非在管理台给用户钉 `moderation_level_api`。relay 不改这条纪律，只是照着执行。
