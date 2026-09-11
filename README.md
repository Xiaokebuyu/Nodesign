[简体中文](https://github.com/Xiaokebuyu/Nodesign/blob/main/README.zh-CN.md) | **English**

# NoDesign

> **See something wrong? Circle it. Generating, reviewing, responding and revising all happen on the same infinite canvas.**

[![npm version](https://img.shields.io/npm/v/%40xiaobuyu%2Fnodesign)](https://www.npmjs.com/package/@xiaobuyu/nodesign)
[![npm downloads](https://img.shields.io/npm/dw/%40xiaobuyu%2Fnodesign)](https://www.npmjs.com/package/@xiaobuyu/nodesign)
[![license](https://img.shields.io/npm/l/%40xiaobuyu%2Fnodesign)](https://github.com/Xiaokebuyu/Nodesign/blob/main/LICENSE)

NoDesign is an Agent-native workspace for making things, built on real files.

Tell the Agent what you want and it creates websites, slide decks, Word documents, images and video right on the canvas. You review the result without leaving that canvas. When something is off, circle it, comment on it, or start a conversation next to the artifact itself.

Your current view, what you have selected, and the components behind it all travel with your message. The Agent knows what you mean by "this", edits the real file behind it, and comes back to the canvas so you can look again.

```text
Ask  →  Agent builds  →  You review on the canvas  →  Circle and comment
     →  Agent edits the real files  →  Agent checks its own work  →  Continue in place
```

![Circle a region on the canvas; the Agent picks up the target context and edits it directly](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-roundtrip.gif)

NoDesign is not a canvas that AI output gets placed on. It is a canvas that holds the entire loop: generate, review, respond, revise.

## Try it now

### Local

Requires Node.js 22.16 or newer:

```bash
npx @xiaobuyu/nodesign
```

Then configure at least one way to reach a model:

- A Claude subscription, or an Anthropic API key
- OpenAI, DeepSeek, Zhipu, Qwen, OpenRouter
- Ollama, or any other service that speaks the OpenAI API format

NoDesign charges no subscription of its own and takes no cut of model usage.

Your project files and configuration stay on your machine. With a cloud model, the context needed for the task goes to the provider you configured. With a local model such as Ollama, nothing has to leave your computer.

### Hosted

If you would rather not install anything, the hosted build covers the basics:

[https://nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade)

It runs on free models with a daily allowance. Features that depend on the local machine are not enabled there.

## Why the whole loop can stay on one canvas

### Circle what's wrong

Often the problem is not that the model cannot make the change. It is that it does not know which "this" you mean.

In NoDesign you can:

- Double-click to edit text in place;
- Circle a region and leave a comment on it;
- Drag things around and organize the canvas;
- Draw relations between pieces of content: reference, annotation, follow-up;
- Summon the Agent right beside the artifact you are looking at.

Your viewport, the selected target, what sits near it, and the components involved are all gathered into the context for the next turn.

So instead of taking a screenshot and explaining:

> The blue block on the right of the second screen is in the wrong place.

You circle it and say:

> Too cramped here.

That is enough.

When the Agent is done, the result comes back to the same canvas. Keep reviewing, ask a follow-up, or start the next revision, without cycling between a chat box, a preview window, an editor and a file manager.

### The Agent can check its own work

Generating is only half of it. The Agent can go back and inspect what it made.

For a site, it can:

- Take screenshots at desktop, tablet and phone widths;
- Read browser console errors;
- Inspect the final computed styles;
- Verify that fonts actually loaded;
- Sample scroll effects and key animation frames;
- Keep revising based on what it found.

![A site previewed at desktop, tablet and phone widths](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-viewport.gif)

If several rounds of edits still miss, the Agent can bring in a read-only reviewer subagent to go through the pages with fresh eyes. The reviewer only reports defects; it cannot edit files.

### Everything on the canvas is a real file

The canvas is not where files go to be displayed.

A file card on the canvas is a real file on disk, and a folder card is a real directory. Opening, renaming, sorting and moving cards writes through to the project workspace.

![Opening a folder, dragging a card into it, drawing a relation between two cards](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-desktop.gif)

The sites, decks, Word documents, images and video the Agent makes are never locked inside a NoDesign format. You can:

- Keep reviewing and annotating them on the canvas;
- Download the original files;
- Open them in other software and keep working;
- Edit them yourself and hand them back to the Agent;
- Publish the project or deliver it to someone else.

The canvas is a desk that connects files, context and the Agent, not a container that shows generated results.

### Different kinds of output, one continuous thread

Sites, decks, documents, images, video and reference material can sit on the same canvas and be handled by the same Agent, one after another.

For example:

1. Have the Agent research a topic;
2. Turn the findings into a Word document;
3. Build a deck from that document;
4. Pull a tall promo image out of the deck;
5. Make a companion site from the same material;
6. Circle what you do not like and have it fixed in place.

The Agent knows where these files live in the project and can keep drawing on them across formats, so you never have to re-explain the project every time the output type changes.

![An end to end NoDesign session](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo.gif)

### The Agent can find and study references itself

The Agent has its own browser. Hand it a URL, or let it go looking.

It can:

- Browse and screenshot pages;
- Analyze layout, color and typography;
- Read how a page divides up its content;
- Inspect scroll-triggered animation and interaction;
- Pull useful screenshots and assets into the current project;
- Build sites, decks or other artifacts from what it found.

In the local build the browser keeps its login state. When it hits a captcha, a login confirmation or anything else that needs a human, it pauses and asks you to take over, then picks the task back up.

### Thinking can stay on the canvas too

The Agent does not only put finished artifacts on the canvas. It can lay out its thinking there as well.

It sketches, writes on the board, draws connections between related pieces, explains its plan, or breaks a hard problem into parts you can talk through.

![Mapping out the characters of *Thunderstorm*: roles, portraits and relation lines](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-blackboard.gif)

Board writing is itself a real file, stored under `notes/板书/` in the project. Sketch nodes, connectors and board text can all be adjusted by hand, and the Agent picks up your edits from there.

![Double-click something the Agent wrote on the board and edit it in place](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-chalk.gif)

Project decisions, style notes and personal preferences do not have to live buried in chat history. They can stay in the workspace as visible, editable content, and can be distilled into reusable Skills.

> In progress: moving more brainstorming and conversation branches onto the canvas, so you can pick up from any stage or node to ask, extend or compare, instead of scrolling back through one ever-growing thread.

## What you can make with it

### Three typical sessions

- **A portfolio or landing page**  
  Drop reference images and copy onto the canvas and tell the Agent the style you want. It builds the page, then checks it at desktop, tablet and phone widths. Circle whatever is off, keep revising, and publish once configured.

- **A slide deck**  
  Put photos, text and a reference style on the canvas and the Agent produces paginated slides. Review each page, edit the text, circle and comment, then export to PDF or PPTX.

- **A cross-media project**  
  Keep the site, images, video, deck and documents on one canvas, handled by one Agent. Each output can draw on material, research and style context the others already established.

### Supported artifact types

| Artifact | Format | What works today |
|---|---|---|
| Decks, tall images, posters | `.html` | Paginated at 16:9, 9:16, 4:3 and other ratios; exports to HTML, PDF, PPTX |
| Portfolios, landing pages, small apps | A folder with `index.html` | Desktop, tablet and phone preview; whole-site ZIP export; publishing once Cloudflare is configured |
| Word documents | `.docx` | Real OOXML, not HTML with the extension changed; page-image preview, paging, original download |
| Images | Common image formats | Generation, background removal, asset handling |
| Video | Common video formats | Import, preview, transcoding |

![Generate an image from one sentence, then remove the background for a transparent PNG](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-image.gif)

![The Agent produces a Word document and inspects the layout on the canvas](https://raw.githubusercontent.com/Xiaokebuyu/Nodesign/main/docs/demo-docx.gif)

### Things actually built with it

Every site below was made in NoDesign and is live right now. They are all in Chinese, though the first one needs no reading.

| Site | What it is |
|---|---|
| [Jet Engine Lab](https://jet-engine-lab.share.xiaobuyu.trade) | An interactive 3D turbofan. Procedurally built geometry you can rotate, throttle up, blow apart, cut away and watch airflow through, with pressure, temperature and velocity readouts at each station |
| [Into the Third Pole](https://third-pole.share.xiaobuyu.trade) | A thirty-day private expedition through Tibet, told as a long-form travel site |
| [CHENXI](https://chenxi.share.xiaobuyu.trade) | An editorial skincare publication, and the product line that grew out of it |
| [Sōtaiseiriron](https://soutaiseiriron.share.xiaobuyu.trade) | A paper-notebook style unofficial fan site for the Japanese band |
| [Rin, a character study](https://rin.share.xiaobuyu.trade) | Notes on the lead of the short film *Shelter*, where every annotation is also a switch |
| [Conjecture on a Certain Day](https://225ad5.share.xiaobuyu.trade) | A chaptered interactive story, one summer afternoon, one puzzle |
| [SPiCa, paid vacation mix](https://spica-mix.share.xiaobuyu.trade) | A listening page for a single remix |

Not websites, but made the same way: a 15-page Tibet travel deck that pairs with the site above, a pixel-art promo page for a game server, and a formal resume `.docx` that went through six rounds of revision.

## Local vs hosted

| | Local `npx @xiaobuyu/nodesign` | Hosted [nodesign.xiaobuyu.trade](https://nodesign.xiaobuyu.trade) |
|---|---|---|
| Models | Your own Claude subscription, API key, or any OpenAI-format service | Free models with a daily allowance |
| Data | Kept in `~/.nodesign/`; the server listens on `127.0.0.1` only | Stored on the server, isolated per user |
| Account | None needed, open it and go | Open registration |
| Features | Everything; screenshots, Word, background removal and image generation are detected from your machine; site publishing needs Cloudflare Pages configured | Screenshots, search and image generation are on; site publishing and subscription models are not open to the public |
| Cost | No subscription, no markup; you pay your model provider directly | Free |

The local build is the main way to use NoDesign. The hosted one exists so you can try the basics without installing anything.

## Configuration

Open the settings page from the gear icon in the top right.

### Models

Two kinds of entry:

- **Claude, official**: paste an Anthropic API key, or run `nodesign login` to sign in with a Claude subscription;
- **Custom endpoints**: pick a provider preset such as DeepSeek, OpenAI, Zhipu, Qwen, OpenRouter or Ollama, then fill in the base URL and key.

Every model entry has a connection test that actually exercises:

- Plain completion;
- Streaming;
- Tool calls;
- Image understanding;
- Token counting.

With nothing configured, the model picker stays empty rather than pretending.

### Machine capabilities

Detected at startup:

- git
- Chromium
- LibreOffice
- poppler
- ffmpeg
- rembg
- Image generation
- Search
- Publishing

When something is missing, the settings page tells you how to install it, and the tools that depend on it are shown as unavailable instead of failing later.

### Everything else

You can also configure:

- The search provider;
- The image generation channel;
- Cloudflare Pages publishing;
- The command sandbox;
- Automatic permission checks.

Configuration lives in:

```text
~/.nodesign/.env
~/.nodesign/config.json
```

`.env` holds keys, `config.json` holds model slots and the rest. Both can be edited directly.

## Security and privacy

Each project gets its own workspace directory. Local data is kept in `~/.nodesign/` by default, and the server listens on `127.0.0.1` only.

On supported platforms you can turn on an OS-level command sandbox:

- Linux: bubblewrap
- macOS: sandbox-exec
- Windows: no OS-level command sandbox at the moment

You can also turn on automatic permission checks, which add a second judgment before file uploads, outbound requests and other sensitive operations.

The local build ships with the command sandbox and the automatic permission checks off. Turn them on in settings according to how you use it.

On Windows in particular, open only projects you trust, and confirm the Agent's plan before it:

- Edits files outside the workspace;
- Installs software or dependencies;
- Uploads local content;
- Does anything else that could affect your system.

## Project status

A personal project, started at the end of April 2026 and still moving quickly.

Where it stands:

- Local release: `0.0.7`
- In-process tools: 54
- Automated tests: 1,037
- Early users: 50

The core has been in steady use during the private beta. Interaction details, platform coverage and some edge capabilities are still being worked on.

The interface is in Chinese only for now, and so are the screenshots above. An English interface does not exist yet. The Agent's own prompts are in Chinese as well. Nothing in them fixes which language it answers in.

### Features

| Capability | Current state |
|---|---|
| Canvas and project management | Running as the main build of the private beta |
| Site generation, preview and publishing | Stable |
| Deck generation and export | Stable |
| Word documents | Usable; preview pagination can drift from Microsoft Word |
| Image and video tools | Usable; depends on local dependencies and service configuration |
| Spatial board writing and relation graphs | Usable; interaction still being refined |
| On-canvas conversation and thought branches | In development |
| Interactive performance mode | Experimental, not fully in the public build |

### Platforms

| Platform | State |
|---|---|
| Linux | Running in production |
| Windows | Verified by real installation and use |
| macOS | Code path exists, not yet verified on real hardware |
| Mobile | Fine for browsing and chatting; organizing and editing want a desktop |

## Architecture

- **Frontend**  
  React + Vite. The infinite canvas camera, hit testing, relation layout and the artifact capability system are written from scratch; `web/src/lib` holds 46 standalone modules, with unit tests covering the core logic for geometry, hit testing and export formats.

- **Backend**  
  Node.js ESM. An Agent session runs with the project workspace as its working directory, working through 54 in-process tools that operate on files, the browser and the different artifact types.

- **Session sync**  
  The server owns session state, supporting streaming output, reconnection and multi-tab sync.

- **Model compatibility**  
  Claude is native; OpenAI-format services are reached through a conversion layer. When a request cannot be mapped to the upstream, it fails with an error rather than being sent to the wrong model.

- **Artifact system**  
  Sites, decks and Word documents plug into preview, export and publishing through one registry. A new artifact type joins those flows through the same entry point.

## Development

```bash
npm install && cd web && npm install && cd ..
npm run dev                 # server, reads .env
cd web && npm run dev       # frontend
npm test                    # server tests + web tests
```

> Running the whole thing needs a model configured (Claude subscription or API key) and some local tool dependencies. The settings page lists what is missing and how to install it.

The Vitest suite is the gate before shipping: 1,037 cases across server and web, covering the client/server contracts, module boundaries, the permission capability table and key user-facing copy. Some constraints are pinned by static tests rather than left to comments and habit. For example:

- The duplicated client and server capability tables are reconciled entry by entry
- Permission decisions must go through the capability table
- Wording checks on user-visible copy
- A line-count ratchet on source files

The frontend deploys with `web/scripts/deploy.sh` (new chunks added, old chunks kept, `index.html` swapped atomically). Server changes need a process restart.

## License

AGPL-3.0. Use it, modify it, run your own. If you offer it as a service, your modifications have to be open too.
