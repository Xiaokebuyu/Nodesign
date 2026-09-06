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
npm run desktop:dev        # electron desktop/main.js
```

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

## 更新

`electron-updater`，更新源在 `electron-builder.yml` 的 `publish`（generic provider，
一个静态文件地址就够，放 R2 或 Pages 都行）。

有 blockmap 对得上就下差分，对不上（比如跨了 Electron 大版本）自动退回下整包。
**完整包更新和差分更新不是两套配置，是同一套的两条路径。**

发布一版 = 跑 `desktop:dist`，把 `dist-desktop/` 里的 `latest.yml`、`.exe`、`.blockmap`
一起传到那个地址。客户端启动时查一次，之后每 6 小时查一次，下完弹一次提示，
用户点"立即重启更新"就装上；不点的话下次退出应用时自动装。

装更新之前主进程会先把服务端子进程停干净（`sup.stop()`）。sqlite 还开着的时候换文件，
轻则更新失败重则库损坏。

## 还没做的

- **随包组件**。`electron-builder.yml` 的 `extraResources` 现在是空的。要装进安装包的：
  chromium（约 150MB）、LibreOffice（约 350MB）、ffmpeg、poppler、rembg 的 Python 环境
  加 u2net 模型（约 250MB）。做法是打包前用一个脚本抓进 `desktop/components/`，装机后解到
  应用目录，再让 `server/runtime/capabilities.js` 的探测认得那个目录
  （`whichBinary` 已经支持 `extraDirs`，加一个安装目录进去即可，不用改探测逻辑）。
  LibreOffice 是 MPL 2.0，随包分发允许，但要带上许可文件。
- **图标**。`desktop/build/icon.ico` 还没有，`desktop/assets/tray.png` 也没有
  （没有时托盘会用一个空图标，不崩但不好看）。
- **代码签名**。`electron-builder.yml` 里的 `certificateFile` 留空。没有证书的话，
  安装包首次运行会被 SmartScreen 拦一道"未知发布者"，用户要点两次才能装。
- **更新地址**。`publish.url` 现在是 `https://REPLACE-ME.example.com/desktop/`。
- **钥匙来源**。首启选"用服务器提供的 API"还是"自己带钥匙"，以及 relay 端点本身。
  见网关那条线。
