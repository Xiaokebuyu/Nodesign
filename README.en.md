<div align="center">

<img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/logo.png" width="72" height="72" alt="NoDesign">

# NoDesign

**An agent workspace for creators**

Describe what you need, and an agent builds websites, slide decks, Word documents, images, and video on an infinite canvas.<br>
Select any area of a preview to request a change. Every output is delivered as a standard file.

[![release](https://img.shields.io/github/v/release/Xiaokebuyu/Nodesign?label=release&color=2d2418)](https://github.com/Xiaokebuyu/Nodesign/releases/latest)
[![npm downloads](https://img.shields.io/npm/dw/%40xiaobuyu%2Fnodesign?color=2d2418&cacheSeconds=3600)](https://www.npmjs.com/package/@xiaobuyu/nodesign)
[![license](https://img.shields.io/github/license/Xiaokebuyu/Nodesign?color=2d2418)](https://github.com/Xiaokebuyu/Nodesign/blob/main/LICENSE)

[Website](https://nodesign.xiaobuyu.trade/welcome/) · [Web app](https://nodesign.xiaobuyu.trade/login) · [Download for Windows](https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe) · [Examples](#examples) · [FAQ](#faq) · [简体中文](https://github.com/Xiaokebuyu/Nodesign/blob/main/README.md)

</div>

<br>

![The NoDesign workspace: a website preview, a step checklist on the board, and the agent session panel](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/hero.webp)

> [!NOTE]
> The NoDesign interface is primarily in Chinese. An English localization is available in Settings but currently covers only part of the interface. The language of generated outputs follows your request, independent of this setting.

## Quick start

| Windows desktop app | Web app | Command line |
|---|---|---|
| [Download installer](https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe) | [nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade/login) | `npx @xiaobuyu/nodesign` |
| Recommended for regular use. Updates automatically. Sign in with a NoDesign account to use hosted models, or bring your own API key (BYOK). | No installation required. Free models with a daily quota. Some features that depend on the local environment are not available. | Requires Node.js 22.16 or later. Suited to Linux, macOS, and self-hosted setups. |

NoDesign charges no subscription fee and adds no markup to model usage. The desktop app and command-line version keep all project files and configuration on your machine.

## Overview

NoDesign brings requirements, production, review, and revision into a single infinite canvas. The agent plans the steps, calls tools, and produces outputs, each of which stays on the canvas as an independent object.

To revise an output, select an area of its preview and describe the change. Your current view, the selected object, and its component details are sent with the message, so the agent can locate what needs to change, update the underlying file, and verify the result on the canvas.

![Selecting an area on the canvas; the agent receives the target context and edits the file](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-roundtrip.gif)

## Capabilities

### Automated review

The agent reviews its work before delivery. It captures pages at desktop, tablet, and mobile widths, reads browser console errors, computed styles, and font loading status, and extracts key frames from scroll-driven animations. When it finds a problem, it continues revising. If several rounds of revision fall short, the agent can invoke a read-only reviewer subagent to audit each page independently.

![A website previewed at desktop, tablet, and mobile widths](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-viewport.gif)

### Canvas and file sync

File cards on the canvas correspond to real files in the workspace, and folder cards correspond to real directories. Opening, renaming, organizing, and moving items is reflected in the workspace. Outputs are saved in standard formats, so they can be downloaded, edited in other software, and handed back to the agent for further work.

![Opening a folder, moving a card into it, and linking two outputs](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-desktop.gif)

### Visible reasoning

The agent can sketch, write on a board, and draw relationships between items on the canvas to explain its plan or break down a problem. Board notes are saved as files under `notes/板书/`. Nodes, connections, and text can all be edited by hand, and the agent works from the edited version.

![An analysis of the characters in the play Thunderstorm: groupings, relationship lines, and generated portraits](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-blackboard.gif)

### Cross-output workflows

Websites, slide decks, documents, images, video, and reference material can share one canvas and be handled by the same agent in sequence. For example, research findings can become a Word document, which then becomes a slide deck, a long-form promotional image, and a companion website, without restating the project context at each step.

![Creating a route overview poster from existing material on the canvas](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo.gif)

### Built-in browser

The agent can use a built-in browser to visit and capture web pages, analyze layout, color, typography, and scroll effects, and save useful material to the project. When running locally, the browser can keep its signed-in state. If it encounters a CAPTCHA or a sign-in confirmation, the agent pauses and asks you to take over.

### Memory and Skills

Project decisions, style guidelines, and personal preferences are stored in the workspace, where they can be viewed and edited, and they carry over to new sessions. A completed workflow can be saved as a Skill and reused for similar requests. Skills can be published to the Skill marketplace, and Skills shared by other users can be installed.

## Supported outputs

| Output | File format | Capabilities |
|---|---|---|
| Websites: portfolios, landing pages, small apps | Folder containing `index.html` | Desktop, tablet, and mobile previews; full-site ZIP export; publishing via Cloudflare Pages |
| Slide decks, long-form images, posters | `.html` | Fixed-canvas pages at 16:9, 9:16, 4:3, and more; export to HTML, PDF, and PPTX |
| Word documents | `.docx` | Standard OOXML output; page previews and pagination; original file download |
| Images | Common image formats | Image generation, background removal, and asset processing |
| Video | Common video formats | Import, preview, and transcoding |

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-image.gif" alt="Generating an image and removing its background to produce a transparent PNG"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-docx.gif" alt="Generating a Word document and reviewing its layout on the canvas"></td>
</tr>
<tr>
<td align="center">Image generation and background removal</td>
<td align="center">Word document generation and layout review</td>
</tr>
</table>

## Examples

The following websites were built with NoDesign and are publicly available. Their content is in Chinese.

<a href="https://jet-engine-lab.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/jet-engine-lab.webp" alt="Jet Engine Lab"></a>

**[Jet Engine Lab](https://jet-engine-lab.share.xiaobuyu.trade)**: An interactive 3D turbofan built from procedural geometry. It supports rotation and zoom, engine start and throttle control, exploded and cutaway views, and airflow visualization, with pressure, temperature, velocity, and energy readouts at each station.

<table>
<tr>
<td width="33%" valign="top"><a href="https://third-pole.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/third-pole.webp" alt="Into the Third Pole"></a><br><b><a href="https://third-pole.share.xiaobuyu.trade">Into the Third Pole</a></b><br>A long-form travel site documenting thirty days in Tibet</td>
<td width="33%" valign="top"><a href="https://chenxi.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/chenxi.webp" alt="CHENXI"></a><br><b><a href="https://chenxi.share.xiaobuyu.trade">CHENXI</a></b><br>An editorial skincare publication and its product line</td>
<td width="33%" valign="top"><a href="https://soutaiseiriron.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/soutaiseiriron.webp" alt="Sōtaiseiriron"></a><br><b><a href="https://soutaiseiriron.share.xiaobuyu.trade">Sōtaiseiriron</a></b><br>An unofficial fan site for the Japanese band</td>
</tr>
<tr>
<td valign="top"><a href="https://rin.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/rin.webp" alt="Rin, a character study"></a><br><b><a href="https://rin.share.xiaobuyu.trade">Rin, a character study</a></b><br>A character analysis of the lead in the short film <i>Shelter</i>, with annotations that switch views</td>
<td valign="top"><a href="https://225ad5.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/225ad5.webp" alt="Conjecture on a Certain Day"></a><br><b><a href="https://225ad5.share.xiaobuyu.trade">Conjecture on a Certain Day</a></b><br>A chaptered interactive puzzle story</td>
<td valign="top"><a href="https://spica-mix.share.xiaobuyu.trade"><img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/cases/spica-mix.webp" alt="SPiCa -paid vacation mix-"></a><br><b><a href="https://spica-mix.share.xiaobuyu.trade">SPiCa -paid vacation mix-</a></b><br>A listening page for a single</td>
</tr>
</table>

Other work produced in NoDesign includes a 15-page Tibet travel deck that accompanies *Into the Third Pole*, a pixel-art promotional page for a game server, and a formal résumé (`.docx`) refined over six rounds of revision.

## Models and providers

### NoDesign account

After signing in with a NoDesign account, the desktop app and command-line version can use hosted models such as GLM and DeepSeek. A free daily quota is included, and no API key is required.

### Bring your own key (BYOK)

In Settings, open Models (模型) and choose Use your own API key (使用自己的 API Key). Select a provider preset and enter your key.

| Category | Providers |
|---|---|
| Providers in China | DeepSeek, Zhipu (Z.ai), Alibaba Cloud Model Studio (Qwen), Moonshot (Kimi), SiliconFlow |
| International providers | Anthropic (Claude), OpenAI, OpenRouter, OpenCode Zen / Go |
| Local models | Ollama, LM Studio |
| Other | Anthropic-compatible relays, any OpenAI-compatible API |

With your own key, requests go directly from your machine to the provider and do not pass through NoDesign servers. The provider bills you directly, and usage does not count toward the hosted quota. With a local model, inference runs entirely on your machine.

Each model configuration includes a health check that verifies five capabilities: text completion, streaming, tool use, image understanding, and token counting.

## FAQ

<details>
<summary><b>Is NoDesign free?</b></summary>
<br>

NoDesign is open source. It charges no subscription fee and adds no markup to model usage. The web app, and the desktop app when signed in, use hosted free models with a daily quota. With your own API key, the model provider bills you for usage.

</details>

<details>
<summary><b>Windows shows "Windows protected your PC" during installation. What should I do?</b></summary>
<br>

The installer is not yet code-signed, so Windows SmartScreen reports an unknown publisher. Select "More info", then "Run anyway" to continue.

</details>

<details>
<summary><b>Is there a macOS version?</b></summary>
<br>

A macOS desktop app is not available yet. On macOS, you can run the command-line version with `npx @xiaobuyu/nodesign`. It has not yet been verified on physical Mac hardware; please report any problems through Issues.

</details>

<details>
<summary><b>Where is my data stored?</b></summary>
<br>

The desktop app and command-line version store data in the `.nodesign` folder in your home directory (`C:\Users\<username>\.nodesign` on Windows), and the local service listens only on `127.0.0.1`. Projects in the web app are stored on the server and isolated per user.

</details>

<details>
<summary><b>How do the editions differ?</b></summary>
<br>

| | Desktop app / command line | Web app |
|---|---|---|
| Models | Hosted models with a NoDesign account, or your own API key | Free models with a daily quota |
| Data | Stored locally in `.nodesign/`; service listens only on `127.0.0.1` | Stored on the server, isolated per user |
| Account | Not required when using your own key | Open registration |
| Features | Full feature set; screenshots, Word, background removal, image generation, and more are detected from the local environment; website publishing requires Cloudflare Pages | Screenshots, search, and image generation; website publishing not yet available |
| Cost | No subscription or markup; your provider bills your own key | Free |

</details>

## Security and privacy

Each project uses its own workspace directory. Local data is stored in `.nodesign/` by default, and the service listens only on `127.0.0.1`.

On supported platforms, you can enable an OS-level command sandbox: bubblewrap on Linux and sandbox-exec on macOS. An OS-level sandbox is not available on Windows. You can also enable automatic permission checks, which apply additional review to file uploads, outbound requests, and other sensitive operations.

The command sandbox and automatic permission checks are off by default in local versions; enable them according to your needs. On Windows, open only projects you trust, and review the agent's plan before it modifies files outside the workspace, installs software, uploads local content, or performs other operations that could affect your system.

## Project status

NoDesign started in April 2026 and is in public beta, with frequent releases. As of September 2026, the project includes 60 purpose-built tools and more than 2,400 automated tests, with over 1,200 commits and more than 140 registered users.

| Feature | Status |
|---|---|
| Canvas and project management | Public beta |
| Website generation, preview, and publishing | Stable |
| Slide deck generation and export | Stable |
| Word documents | Available; pagination may differ from Microsoft Word |
| Image and video tools | Available; capabilities depend on local dependencies and service configuration |
| Boards and relationship diagrams | Available; interactions are being refined |
| Skill marketplace | Available; requires a NoDesign account |
| Canvas conversations and branching | In development |
| Interactive performance mode | Experimental; not yet fully available |

| Platform | Status |
|---|---|
| Windows | Desktop app released, with automatic updates |
| Linux | Command-line version available |
| macOS | No desktop app yet; command-line version not yet verified on hardware |
| Mobile | Web app supports browsing and chat; editing is best done on a computer |

## Feedback

Please submit bugs and suggestions through [GitHub Issues](https://github.com/Xiaokebuyu/Nodesign/issues). When reporting a problem, attach the log file from Settings → About → Log (设置 → 关于 → 日志).

## For developers

<details>
<summary><b>Configuration</b></summary>
<br>

After launch, click the gear icon in the top-right corner to open Settings.

- **Local capabilities**: On startup, NoDesign detects git, Chromium, LibreOffice, poppler, ffmpeg, and rembg, along with image generation, search, and publishing capabilities. When a dependency is missing, Settings shows how to install it, and the related tools are marked unavailable.
- **Other settings**: Search service, image generation channel, Cloudflare Pages publishing, command sandbox, and automatic permission checks.

Configuration files:

```text
~/.nodesign/.env          # API keys
~/.nodesign/config.json   # Model slots and other settings
```

</details>

<details>
<summary><b>Architecture</b></summary>
<br>

- **Frontend**: React and Vite. The infinite canvas camera, hit testing, relationship layout, and output capability system are built in-house, with unit tests covering core logic such as geometry, hit testing, and export formats.
- **Server**: Node.js ESM. Agent sessions run with the project workspace as the working directory and operate on files, the browser, and outputs through 60 in-process tools.
- **Session sync**: The server maintains session state and supports streaming, reconnection recovery, and synchronization across browser tabs.
- **Model compatibility**: Claude is supported natively, and OpenAI-compatible model services are supported through format translation. When no matching upstream is found, the request fails with an error instead of being sent to the wrong service.
- **Output system**: Websites, slide decks, and Word documents plug into preview, export, and publishing through a single registration mechanism.
- **Desktop app**: Built on Electron with the full local server bundled; installers and updates are distributed through a mirror.

</details>

<details>
<summary><b>Local development</b></summary>
<br>

```bash
npm install && cd web && npm install && cd ..
npm run dev                 # server, reads .env
cd web && npm run dev       # frontend
npm test                    # server and frontend tests
```

A full run requires a configured model and some local tool dependencies; Settings lists what is missing and how to install it.

The Vitest suite serves as the pre-release check, covering frontend and server contracts, module boundaries, the permission capability table, and key interface copy. Some constraints are enforced by static tests, such as item-by-item reconciliation of the frontend and server capability tables, routing all permission checks through the capability table, wording checks on interface copy, and a source file line limit.

The frontend is deployed with `web/scripts/deploy.sh` (new chunks are added, old chunks are kept, and `index.html` is replaced atomically). Server changes require a process restart.

</details>

## License

Released under the [AGPL-3.0](https://github.com/Xiaokebuyu/Nodesign/blob/main/LICENSE) license. You may use, modify, and self-host NoDesign. If you provide it to others as a network service, you must release your modified source code under the same license.
