<div align="center">

<img src="https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/logo.png" width="72" height="72" alt="NoDesign">

# NoDesign

**One canvas, shared with your agent**

Outputs, materials, and reasoning live on a single canvas.<br>
You point, organize, and edit on it; the agent builds, reviews, and explains on it. Every output is a standard file.

[![release](https://img.shields.io/github/v/release/Xiaokebuyu/Nodesign?label=release&color=2d2418)](https://github.com/Xiaokebuyu/Nodesign/releases/latest)
[![npm downloads](https://img.shields.io/npm/dw/%40xiaobuyu%2Fnodesign?color=2d2418&cacheSeconds=3600)](https://www.npmjs.com/package/@xiaobuyu/nodesign)
[![license](https://img.shields.io/github/license/Xiaokebuyu/Nodesign?color=2d2418)](https://github.com/Xiaokebuyu/Nodesign/blob/main/LICENSE)

[Website](https://nodesign.xiaobuyu.trade/welcome/) · [Web app](https://nodesign.xiaobuyu.trade/login) · [Download for Windows](https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe) · [Examples](#examples) · [Roadmap](#open-platform-planned) · [FAQ](#faq) · [简体中文](https://github.com/Xiaokebuyu/Nodesign/blob/main/README.md)

</div>

<br>

![The NoDesign workspace: outputs, board notes, and relationship lines on the canvas, with the agent session panel on the right](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/hero.webp)

> [!NOTE]
> The NoDesign interface is primarily in Chinese. An English localization is available in Settings but currently covers only part of the interface. The language of generated outputs follows your request, independent of this setting.

## Quick start

| Windows desktop app | Web app | Command line |
|---|---|---|
| [Download installer](https://dl.xiaobuyu.trade/desktop/NoDesign-Setup.exe) | [nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade/login) | `npx @xiaobuyu/nodesign` |
| Recommended for regular use. Updates automatically. Sign in with a NoDesign account to use hosted models, or bring your own API key (BYOK). | No installation required. Free models with a daily quota. Some features that depend on the local environment are not available. | Requires Node.js 22.16 or later. Suited to Linux, macOS, and self-hosted setups. |

NoDesign charges no subscription fee and adds no markup to model usage. The desktop app and command-line version keep all project files and configuration on your machine.

## The canvas: a shared workspace for you and the agent

In a chat-based tool, you and the agent share a single text channel: you translate what you see into words, and the agent puts what it makes back into the conversation. NoDesign replaces that channel with a canvas that both of you can read and write.

### What the canvas does for you: the whole project, and part of every instruction

- **See**: Outputs, materials, board notes, and relationships sit together on one canvas instead of being buried in a chat history.
- **Point**: The selected object, the region you mark, and your current view are sent with each message, so "this part" never needs to be described in words.
- **Organize**: Drag items, group them into folders, and draw labeled links such as source, annotation, next step, comparison, and derived from. Organizing the canvas tells the agent how your materials relate.
- **Edit**: Double-click text to edit it in place; your edits and marked regions go to the agent together.

![The user links the website to the Riverbank packaging image as a source, marks the subscription section, and asks to add "this packaging image"; the agent finds the image through the link and makes the change](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/canvas-user.gif)

### What the canvas does for the agent: a desktop, eyes, and a blackboard

- **Desktop**: The agent works directly on the canvas, creating outputs, placing them next to related items, grouping them, and opening them side by side. It describes placement by relationship; the system computes the exact position.
- **Eyes**: The agent reads the current state of the canvas, including what you have moved or changed, and captures outputs at different widths to review its own results.
- **Blackboard**: The agent breaks down problems, lays out plans, and compares options on the canvas. Board notes are saved as files; when you edit them, the agent follows the edited version.
- **Visible progress**: While the agent works, the output being written, the tools in use, and completion status appear on the canvas in real time.

![The agent outlines an 8-slide deck on the board; the user deletes one slide and adds a line on the board; the agent builds a 7-slide deck from the edited outline, places it next to the outline, and links the two](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/canvas-agent.gif)

### What the canvas does between you: shared context and project memory

- You and the agent read and write the same canvas. Every change you make is visible to the agent in its next turn, and every output the agent produces stays on the canvas, where it can be reviewed, edited, and rolled back.
- Relationship lines record where material came from and what was derived from what: which image is used on which website, which document a deck was based on. The agent follows these links when working across outputs, so project context never needs to be restated.
- Project decisions, style guidelines, and preferences carry over between sessions; a successful workflow can be saved as a Skill and published to the Skill marketplace.

![In a new session, a single request to turn the brand book's brewing parameters into a final slide; the agent locates the brand book and the deck through the canvas and edits across outputs](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/canvas-memory.gif)

### More capabilities

- **Automated review**: Before delivery, the agent captures desktop, tablet, and mobile screenshots and checks console errors, computed styles, and font loading. If several rounds fall short, it can invoke a read-only reviewer subagent to audit each page.
- **Built-in browser**: The agent visits and captures web pages, analyzes layout, color, typography, and scroll effects, and saves useful material to the project. When running locally, the browser keeps its signed-in state and hands control to you for CAPTCHAs or sign-in confirmations.
- **Confirm before building**: When a request is missing key details such as format or style, the agent asks first and builds after you confirm, which avoids full rework.
- **Standard file delivery**: Websites export as ZIP archives, decks as PDF and PPTX, and documents as `.docx`; with Cloudflare configured, websites can be published to the web.

## Supported outputs

| Output | File format | Capabilities |
|---|---|---|
| Websites: portfolios, landing pages, small apps | Folder containing `index.html` | Desktop, tablet, and mobile previews; full-site ZIP export; publishing via Cloudflare Pages |
| Slide decks, long-form images, posters | `.html` | Fixed-canvas pages at 16:9, 9:16, 4:3, and more; export to HTML, PDF, and PPTX |
| Word documents | `.docx` | Standard OOXML output; page previews and pagination; original file download |
| Images | Common image formats | Image generation, background removal, and asset processing |
| Video | Common video formats | Import, preview, and transcoding |

![Four kinds of output from the Mistridge Coffee project: a brand website on desktop and mobile, an 8-slide launch deck, a 9-page Word brand book, and product images with transparent backgrounds](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/outputs-en.webp)

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

## Open platform (planned)

The goal is to make the canvas the coordination layer between you, multiple agents, and multiple systems: tasks, files, and progress from each system appear as cards on one canvas; agents operate those systems through CLIs, MCP, and the browser; you review, compare, and decide in one place.

![Planned architecture: CLI agents, MCP services, and online platforms converge on the canvas, where the user reviews and decides](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/open-canvas-en.webp)

Available today: the local version includes an MCP server that lets agents such as Claude Code and Codex read NoDesign's runtime status (health, projects, processes, turns, and logs).

Planned:

- **Command-line tools**: The agent starts and tracks background jobs on external platforms through their CLIs, such as submitting a Kaggle notebook run, with job status and output shown live on the canvas.
- **Working alongside you in the browser**: While you edit an online page such as a Kaggle notebook, you can ask the agent to review the current code, locate the problem, and edit the page's form fields and code cells directly.
- **MCP services**: Connect creative software such as Blender and document platforms such as Feishu Docs and Notion, so their scenes, documents, and data can be referenced and edited as objects on the canvas.
- **Open canvas tools**: CLI agents such as Claude Code and Codex can write outputs and progress to the canvas and share it with NoDesign's own agent.
- **Centralized decisions**: Outputs from different platforms can be compared, annotated, and approved side by side on one canvas, without switching between systems.

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
| Boards and relationship lines | Available; interactions are being refined |
| Skill marketplace | Available; requires a NoDesign account |
| Canvas conversations and branching | In development |
| External agent and platform integrations | Planned; see Open platform |
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
