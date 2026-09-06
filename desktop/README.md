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
npm run build:web
npm run desktop:dev        # electron desktop/main.js；服务端子进程用 PATH 里的 node（NODESIGN_NODE 可指定）
```

服务端子进程**不用 Electron 的 node 模式**，用一份真的 node：打包后是安装包里带的
`resources/node/node.exe`，开发态是 PATH 里的 node（要 ≥ 22.13，`node:sqlite`）。

## 打包

```
npm run desktop:pack       # 只解包到 dist-desktop/，起得快，用来验行为
npm run desktop:dist       # 出 NSIS 安装包
```

**必须在 Windows 上跑**（或者 GitHub Actions 的 `windows-latest`）。两个产物得是真的
win32 二进制：SDK 的 `claude.exe`（平台包 `@anthropic-ai/claude-agent-sdk-win32-x64`）和
`sharp` 的 `@img/sharp-win32-x64`。在 Linux 上让 npm
装另一个平台的包要一路 `--os/--cpu` 覆盖，装出来还没法跑起来验。在 Windows 上这些是
默认行为，不用任何特殊处理。

数据库是 Node 自带的 `node:sqlite`（09-06 从 better-sqlite3 换过来的），仓库里不再有需要按运行时
编译的原生模块；`sharp` 是 N-API 按平台分包，也不用编。安装包里带的 node.exe 是工作流在
`windows-latest` 上抓的 Node 24，`npmRebuild: false`，Electron 只当窗口壳。

## 发布与更新

打包在 GitHub Actions 上做（`.github/workflows/desktop.yml`，`windows-latest`），产物直接进
GitHub Releases。发一版：

```
# 方式一：Actions 页面 → "desktop" → Run workflow
# 方式二：
git tag desktop-v0.0.10 && git push origin desktop-v0.0.10
```

⚠️ **每次发版先涨版本号**（`npm version patch --no-git-tag-version`，提交）。electron-updater 只认比自己大的版本，
同一个版本号重打的包用户端当没更新；草稿也不算发布 —— 站主试过点 **Publish release** 才推给用户。
之后用户端起动时和每 6 小时查一次，下完弹一次提示，差分能对上就只下变化的部分。

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

- **组件**：按需下载，不进安装包（站主 09-06 定的）。清单在 GitHub Release `components-win64` 的
  `manifest.json`，由 `.github/workflows/components.yml` 生成（git / ffmpeg / poppler 拿上游现成 zip，
  LibreOffice 走 `msiexec /a` 抽文件，rembg 是嵌入式 Python + rembg[cpu] + 两个模型；chromium 交给
  playwright 自己装）。首启引导页（`/setup`）和设置 → 组件都走 `server/runtime/components.js`。
  ⏸ 六个组件在 Windows 上一个都没真跑过（本机只验了下载 / 校验 / 解压 / 目录形状）；换版本改工作流 env 再跑一次。
- **图标只是占位**。`desktop/build/icon.png` 和 `desktop/assets/tray.png` 是站点 favicon 那个
  深底 N 字（sharp 渲的），能用，想换就换掉这两个文件。
- **在 Windows 上一次都没跑过**。CI 打出来的包（Releases 草稿 v0.0.10，231MB）本机拆开看过：
  `resources/node/node.exe`、`resources/app/{server,web/dist,bin,desktop}`、SDK 的 claude.exe 都在，hosted/ 和测试没带；但双击装、起服务端、开窗口这三步没验过。
- **站点那半要先部署**。桌面版默认走 relay，而 relay 在这条分支的 hosted 代码里，线上还没有。
  没部署之前桌面版能用的只有 BYOK（设置页填 Claude API Key 或自定义插槽）。想对着 exp 试，
  设置页「站点地址」填 exp 的地址。
- **relay 只转推理**。生图和搜索走站主服务那两条（任务式请求）没做，桌面版这两样现在只能 BYOK。
- **设置页的「用量」要站点那半也部署了才有站点账本那条**（GET /api/relay/usage/daily）。
- **代码签名**。`electron-builder.yml` 里的 `certificateFile` 留空。没有证书的话，
  安装包首次运行会被 SmartScreen 拦一道"未知发布者"，用户要点两次才能装。

## 登录

首启是一道登录门（AuthGate 在 local 档位下的桌面模式）：账号密码交给本地服务端
`POST /api/local/relay/login`，它去站点 `POST /api/relay/login` 换一枚设备令牌写进
`<数据目录>/.env`，之后这台机器就走站点的模型和额度。门旁一行小字"我自己带钥匙"可以跳过
（记在浏览器 localStorage），设置页「NoDesign 服务」里随时能登录 / 退出登录（退出会吊销那枚令牌）。
站点「桌面版设备」页也能手动签令牌粘进去，或者吊销某台机器。

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
