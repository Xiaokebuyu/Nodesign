<div align="center">

<img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/logo.png" width="72" height="72" alt="NoDesign">

# NoDesign

**面向创作者的 Agent 工作台**

描述需求，Agent 在无限画布上完成网站、演示稿、Word 文档、图像与视频的制作。<br>
在预览上圈选即可修改，产物以标准文件交付。

[![release](https://img.shields.io/github/v/release/Xiaokebuyu/Nodesign?label=release&color=2d2418)](https://github.com/Xiaokebuyu/Nodesign/releases/latest)
[![npm downloads](https://img.shields.io/npm/dw/%40xiaobuyu%2Fnodesign?color=2d2418&cacheSeconds=3600)](https://www.npmjs.com/package/@xiaobuyu/nodesign)
[![license](https://img.shields.io/github/license/Xiaokebuyu/Nodesign?color=2d2418)](https://github.com/Xiaokebuyu/Nodesign/blob/main/LICENSE)

[官网](https://nodesign.xiaobuyu.trade/welcome/) · [网页版](https://nodesign.xiaobuyu.trade/login) · [下载 Windows 版](https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe) · [案例](#案例) · [常见问题](#常见问题) · [English](https://github.com/Xiaokebuyu/Nodesign/blob/main/README.en.md)

</div>

<br>

![NoDesign 工作区：网站预览、板书步骤清单与 Agent 会话栏](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/hero.webp)

## 快速开始

| Windows 桌面版 | 网页版 | 命令行 |
|---|---|---|
| [下载安装包](https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe) | [nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade/login) | `npx @xiaobuyu/nodesign` |
| 推荐长期使用。支持自动更新，可登录 NoDesign 账号使用平台模型，或配置自有密钥（BYOK）。 | 无需安装，注册后即可使用。提供免费模型与每日额度，部分依赖本机环境的功能暂未开放。 | 需要 Node.js 22.16 及以上版本，适用于 Linux、macOS 与自部署场景。 |

NoDesign 不收取订阅费，也不对模型调用加价。桌面版与命令行版本的项目文件和配置均保存在本机。

## 概述

NoDesign 将需求、制作、检查与修改整合在同一块无限画布中。Agent 根据需求规划步骤、调用工具并生成产物，每件产物以独立对象的形式保留在画布上。

修改时，在预览上圈选目标区域并输入要求。当前视野、选中对象及其组件信息会随消息一并提交，Agent 据此定位需要修改的内容，更新对应文件，并在画布上完成检查。

![在画布上圈选区域，Agent 获取目标上下文后修改对应文件](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-roundtrip.gif)

## 核心能力

### 自动检查

Agent 在交付前检查产物：获取桌面、平板与手机三种宽度的页面截图，读取浏览器控制台错误、最终渲染样式与字体加载状态，并提取滚动动效的关键帧。发现问题后，Agent 继续修改。多轮修改仍未达到预期时，Agent 可调用只读评审子代理，从独立视角逐页复核。

![网站在桌面、平板与手机宽度下的预览](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-viewport.gif)

### 画布与文件同步

画布上的文件卡片对应工作区中的真实文件，文件夹卡片对应真实目录。打开、重命名、归类与移动操作会同步至工作区。产物以标准格式保存，可以下载、使用其他软件编辑，并在修改后交由 Agent 继续处理。

![打开文件夹、将卡片移入文件夹、在两件产物之间建立关系](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-desktop.gif)

### 可视化的推理过程

Agent 可以在画布上绘制草图、书写板书，并建立内容之间的关系，用于说明计划和拆解问题。板书以文件形式保存在 `notes/板书/` 目录，节点、连线与文字均支持手动调整，Agent 在后续工作中使用调整后的内容。

![《雷雨》人物关系分析：人物分组、关系线与生成的肖像](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-blackboard.gif)

### 跨产物协作

网站、演示稿、文档、图像、视频与参考资料可以置于同一块画布，由同一个 Agent 连续处理。例如，将调研结果整理为 Word 文档，再据此生成演示稿、宣传长图与配套网站，其间无需重复说明项目背景。

![基于画布上的现有素材制作路线总览海报](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo.gif)

### 内置浏览器

Agent 可以使用内置浏览器访问网页并截图，分析页面的布局、配色、字体与滚动动效，并将所需素材保存至项目。本地运行时，浏览器可保留登录状态；遇到验证码或登录确认时，Agent 会暂停并请求用户接管。

### 记忆与 Skill

项目决策、风格规范与用户偏好保存在工作区中，支持查看和修改，并在新会话中继续生效。完成的工作流程可以沉淀为 Skill，在后续的同类需求中复用。Skill 可以发布到 Skill 市场，也可以安装其他用户分享的 Skill。

## 支持的产物

| 产物 | 文件格式 | 能力 |
|---|---|---|
| 网站：作品集、落地页、小型应用 | 含 `index.html` 的文件夹 | 桌面、平板与手机宽度预览；整站 ZIP 导出；配置 Cloudflare 后发布至公网 |
| 演示稿、长图、海报 | `.html` | 16:9、9:16、4:3 等固定画幅分页；导出 HTML、PDF、PPTX |
| Word 文档 | `.docx` | 生成标准 OOXML 文档；页面预览与翻页；下载原始文件 |
| 图像 | 常见图像格式 | 图像生成、背景移除与素材处理 |
| 视频 | 常见视频格式 | 导入、预览与转码 |

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-image.gif" alt="生成图像并移除背景，得到透明 PNG"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-docx.gif" alt="生成 Word 文档并在画布上检查排版"></td>
</tr>
<tr>
<td align="center">图像生成与背景移除</td>
<td align="center">Word 文档生成与排版检查</td>
</tr>
</table>

## 案例

以下网站均使用 NoDesign 制作，并通过公开链接发布。

<a href="https://jet-engine-lab.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/jet-engine-lab.webp" alt="喷气发动机 3D 互动教具"></a>

**[喷气发动机 3D 互动教具](https://jet-engine-lab.share.xiaobuyu.trade)**：以程序化几何构建的涡扇发动机模型，支持旋转缩放、启动与油门控制、爆炸拆解、剖切透视和气流可视化，并按站位显示压比、温度、速度与能量变化。

<table>
<tr>
<td width="33%" valign="top"><a href="https://third-pole.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/third-pole.webp" alt="深入第三极"></a><br><b><a href="https://third-pole.share.xiaobuyu.trade">深入第三极</a></b><br>藏地三十日旅行长篇图文网站</td>
<td width="33%" valign="top"><a href="https://chenxi.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/chenxi.webp" alt="晨曦 CHENXI"></a><br><b><a href="https://chenxi.share.xiaobuyu.trade">晨曦 CHENXI</a></b><br>护肤主题刊物及其产品线</td>
<td width="33%" valign="top"><a href="https://soutaiseiriron.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/soutaiseiriron.webp" alt="相対性理論 · 纸上手账"></a><br><b><a href="https://soutaiseiriron.share.xiaobuyu.trade">相対性理論 · 纸上手账</a></b><br>乐队非官方粉丝网站</td>
</tr>
<tr>
<td valign="top"><a href="https://rin.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/rin.webp" alt="凛 · 角色拆解"></a><br><b><a href="https://rin.share.xiaobuyu.trade">凛 · 角色拆解</a></b><br>短片《Shelter》主角的角色分析，批注兼作视图切换</td>
<td valign="top"><a href="https://225ad5.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/225ad5.webp" alt="某日猜想"></a><br><b><a href="https://225ad5.share.xiaobuyu.trade">某日猜想</a></b><br>分章节互动解谜故事</td>
<td valign="top"><a href="https://spica-mix.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/spica-mix.webp" alt="SPiCa -paid vacation mix-"></a><br><b><a href="https://spica-mix.share.xiaobuyu.trade">SPiCa -paid vacation mix-</a></b><br>单曲鉴赏页</td>
</tr>
</table>

此外还包括与“深入第三极”配套的 15 页西藏旅行演示稿、一套像素风格的服务器宣传页，以及一份经过六轮修订的正式简历（`.docx`）。

## 模型与服务商

### NoDesign 账号

桌面版与命令行版本登录 NoDesign 账号后，即可使用平台提供的 GLM、DeepSeek 等模型。平台每日提供免费额度，无需自备 API Key。

### 自有密钥（BYOK）

在设置页“模型 → 使用自己的 API Key”中选择服务商预设并填写密钥。

| 类别 | 服务商 |
|---|---|
| 国内服务商 | DeepSeek、智谱（Z.ai）、阿里百炼（通义）、Moonshot（Kimi）、硅基流动 |
| 海外服务商 | Anthropic（Claude）、OpenAI、OpenRouter、OpenCode Zen / Go |
| 本机模型 | Ollama、LM Studio |
| 其他 | Anthropic 格式中转服务、兼容 OpenAI API 格式的任意服务 |

使用自有密钥时，请求由本机直接发送至服务商，不经过 NoDesign 服务器；费用由服务商结算，不计入平台额度。使用本机模型时，模型推理在本机完成。

每个模型配置均提供“体检”功能，用于验证文本对话、流式输出、工具调用、图像理解与 Token 计数五项能力。

## 常见问题

<details>
<summary><b>NoDesign 是否收费？</b></summary>
<br>

NoDesign 为开源软件，不收取订阅费，也不对模型调用加价。网页版与登录账号的桌面版使用平台提供的免费模型，每日有额度限制。使用自有密钥时，费用由模型服务商按用量结算。

</details>

<details>
<summary><b>中国大陆网络能否直接使用？</b></summary>
<br>

可以。网页版、安装包下载与桌面版自动更新均通过中国大陆可直接访问的线路提供，不依赖 GitHub。使用自有密钥时，DeepSeek、智谱、通义、Kimi、硅基流动等国内服务商可直接连接；Claude、OpenAI 等海外服务需要网络能够访问对应地址。

</details>

<details>
<summary><b>安装时出现“Windows 已保护你的电脑”提示，如何处理？</b></summary>
<br>

安装包目前未进行代码签名，Windows SmartScreen 会提示“未知发布者”。点击“更多信息”，再选择“仍要运行”即可继续安装。

</details>

<details>
<summary><b>是否提供 macOS 版本？</b></summary>
<br>

目前暂未提供 macOS 桌面版。macOS 用户可以通过 `npx @xiaobuyu/nodesign` 运行命令行版本；该平台尚未完成真机验证，如遇问题请通过 Issues 反馈。

</details>

<details>
<summary><b>数据存储在哪里？</b></summary>
<br>

桌面版与命令行版本的数据保存在用户目录下的 `.nodesign` 文件夹（Windows 为 `C:\Users\<用户名>\.nodesign`），服务仅监听 `127.0.0.1`。网页版的项目数据存储于服务端，并按用户隔离。

</details>

<details>
<summary><b>各版本之间有何区别？</b></summary>
<br>

| | 桌面版 / 命令行 | 网页版 |
|---|---|---|
| 模型 | 登录 NoDesign 账号使用平台模型，或配置自有密钥 | 免费模型，每日额度 |
| 数据 | 保存在本机 `.nodesign/`，服务仅监听 `127.0.0.1` | 服务端存储，按用户隔离 |
| 账号 | 使用自有密钥时无需账号 | 公开注册 |
| 功能 | 完整功能；截图、Word、背景移除、图像生成等按本机环境自动检测；网站发布需配置 Cloudflare Pages | 支持截图、搜索与图像生成；网站发布暂未开放 |
| 费用 | 不收取订阅费与分成；自有密钥由服务商计费 | 免费 |

</details>

## 安全与隐私

每个项目使用独立的工作区目录。本地数据默认保存在 `.nodesign/`，服务仅监听 `127.0.0.1`。

在受支持的平台上，可以启用系统级命令沙盒：Linux 使用 bubblewrap，macOS 使用 sandbox-exec；Windows 暂不提供系统级命令沙盒。此外可以启用自动权限检查，对文件上传、外部请求等敏感操作进行额外判断。

本地版本默认不启用命令沙盒与自动权限检查，请根据使用场景自行开启。在 Windows 上，建议仅打开可信的项目；当 Agent 计划修改工作区以外的文件、安装软件、上传本地内容或执行其他可能影响系统环境的操作时，请先确认其计划。

## 项目状态

NoDesign 于 2026 年 4 月启动，目前处于公开测试阶段，版本迭代频繁。截至 2026 年 9 月，项目包含 60 个专用工具、2,400 余项自动化测试，累计提交 1,200 余次，注册用户 140 余位。

| 功能 | 状态 |
|---|---|
| 画布与项目管理 | 公开测试 |
| 网站生成、预览与发布 | 稳定 |
| 演示稿生成与导出 | 稳定 |
| Word 文档 | 可用；预览分页可能与 Microsoft Word 存在差异 |
| 图像与视频工具 | 可用；具体能力取决于本机依赖与服务配置 |
| 板书与关系图 | 可用；交互持续完善中 |
| Skill 市场 | 可用；需要登录 NoDesign 账号 |
| 画布对话与思考分支 | 开发中 |
| 互动演出模式 | 实验性功能，尚未完整开放 |

| 平台 | 状态 |
|---|---|
| Windows | 桌面版已发布，支持自动更新 |
| Linux | 命令行版本可用 |
| macOS | 暂无桌面版；命令行版本尚未完成真机验证 |
| 移动端 | 网页版支持浏览与对话，编辑操作建议在电脑上完成 |

## 反馈

问题与建议请提交至 [GitHub Issues](https://github.com/Xiaokebuyu/Nodesign/issues)。提交问题时，请附上日志文件（设置 → 关于 → 日志）。

## 开发者

<details>
<summary><b>配置</b></summary>
<br>

启动后点击右上角齿轮进入设置页。

- **本机能力**：启动时自动检测 git、Chromium、LibreOffice、poppler、ffmpeg、rembg，以及图像生成、搜索与发布能力。缺少依赖时，设置页会给出安装方法，对应工具显示为不可用。
- **其他设置**：搜索服务、图像生成通道、Cloudflare Pages 发布、命令沙盒、自动权限检查。

配置文件位于：

```text
~/.nodesign/.env          # 密钥
~/.nodesign/config.json   # 模型插槽及其他配置
```

</details>

<details>
<summary><b>技术架构</b></summary>
<br>

- **前端**：React + Vite。无限画布的相机、命中检测、关系排布与产物能力系统为自研实现，几何计算、命中判定、导出格式等核心逻辑配有单元测试。
- **服务端**：Node.js ESM。Agent 会话以项目工作区为执行目录，通过 60 个进程内工具操作文件、浏览器与各类产物。
- **会话同步**：服务端维护会话状态，支持流式输出、断线恢复与多标签页同步。
- **模型兼容**：原生支持 Claude，并通过格式转换接入兼容 OpenAI API 的模型服务。无法匹配上游时直接返回错误，避免请求被发送至错误的服务。
- **产物系统**：网站、演示稿与 Word 文档通过统一的注册机制接入预览、导出与发布流程。
- **桌面版**：基于 Electron，内置完整的本地服务端；安装包与更新通过镜像分发。

</details>

<details>
<summary><b>本地开发</b></summary>
<br>

```bash
npm install && cd web && npm install && cd ..
npm run dev                 # 服务端，读取 .env
cd web && npm run dev       # 前端
npm test                    # 服务端与前端测试
```

完整运行需要配置模型接入及部分本机工具依赖，设置页会列出缺少的依赖与安装方法。

项目以 Vitest 测试套件作为发布前检查，覆盖前后端契约、模块边界、权限能力表与关键界面文案。部分约束以静态测试固化，例如前后端能力表逐项对账、权限判断必须经由能力表、界面文案措辞检查与源文件行数上限。

前端通过 `web/scripts/deploy.sh` 部署（新增分片、保留旧分片、原子替换 `index.html`）；服务端改动需要重启进程。

</details>

## 许可证

本项目基于 [AGPL-3.0](https://github.com/Xiaokebuyu/Nodesign/blob/main/LICENSE) 许可证发布。允许使用、修改与自行部署；以网络服务形式向他人提供时，须以相同许可证公开修改后的源代码。
