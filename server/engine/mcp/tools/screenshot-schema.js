/**
 * screenshot_canvas 的描述与入参 schema（09-17 从 screenshot.js 拆出 —— 行数棘轮；纯数据 + 参数组合合同，
 * 跟截图逻辑零耦合。write-on-board-schema.js 同一个做法）。
 *
 * 09-17 新增三个参数：probe / shot（问题库 iss_mtvtvqs2_0ad4）、saveTo（iss_mt9n6bm2_nthg）。
 * 它们跟形态、胶片条的组合规则收在 argConflict，一处判定，不静默忽略。
 */
import { z } from 'zod';
import { CANVAS_PATH_DESC } from '../../../lib/artifact-target.js';
import { LIVE_PARAM_DESC } from './helpers/acquire-page.js';
import { PROBE_MAX_CHARS } from './helpers/shot-probe.js';

export const SCREENSHOT_CANVAS_DESCRIPTION = `Take a screenshot of the artifact you are working on — a site page (any
.html inside a site folder; the folder's artifact root is whatever holds its
index.html — hand-written pages or a build output dir), a deck (.html), or a
.docx (rendered to page images) — and return it as an image. Use this to
visually inspect what you wrote: spacing, contrast, hierarchy, layout, alignment.

The tool detects the artifact kind from the path. Each call is a FRESH load
(reproducible). To look at a page in its current interactive state (menus open,
game mid-play) use live:true against the artifact session (artifact_open).

DECK — default viewport = the deck-aspect declared on canvas wrap (16:9 → 1920×1080,
9:16 → 1080×1920, 16:10 → 1920×1200, 4:3 → 1440×1080). Target one page with pageIndex.

SITE — there is no fixed aspect. Default viewport is desktop 1440×900 and the whole
page is captured (fullPage). Use the device param to check a breakpoint: desktop=1440,
tablet=834, mobile=390. **Checking mobile means rendering AT 390px wide**, not shrinking
a desktop shot — that is the only way to see whether your media queries actually fire.
pageIndex does not apply to sites; pass path to screenshot a specific page file.

WORD (.docx) — rendered to page images (pages param). saveTo writes those page
images into a workspace folder so you can hand them over (deliver_files).

**Targeting (cheapest → most expensive)**:
- pageIndex: capture only section[data-page="N"] — **prefer this for per-page checks** (~30-50KB image)
- selector: capture only the first element matching this CSS selector
- (default, no targeting): capture viewport only (~30-50KB)
- fullPage=true: capture full scrollable page — **N× more expensive for N-page deck**
  (~150-300KB for 9 pages). Only use for true deck-wide overview; otherwise prefer
  pageIndex loop or dispatch the vision-checker subagent (subagent context is
  isolated, your main context stays small).

Targeted captures (selector / pageIndex) override fullPage.

Returns: image content block (you see it directly via vision) plus a text caption
with size info AND page diagnostics: console errors/warnings and failed resource
loads (CDN scripts, fonts, images). "console clean, all requests OK" means your
CDN libs actually loaded — no more guessing whether GSAP/Lenis are alive.

beforeShot: the screenshot environment never scrolls, so scroll-linked animations
(ScrollTrigger, IntersectionObserver reveals) leave elements at opacity:0 and they
vanish from the shot. Pass beforeShot:"scrollToBottom" to scroll through the whole
page and back to top first — every scroll trigger fires, then the shot is taken.
Or pass a JS snippet (async/await OK) to click/hover/setup any state before capture.
Do NOT delete entrance animations just to make screenshots work — use beforeShot.

Slow-booting pages (3D scenes, heavy asset loads): pass waitFor:"window.__yourReadyFlag"
to poll until the app is ready (own 15s budget), keep beforeShot for the setup itself
(10s budget). The caption reports how long each phase took.

Console output: the caption carries warnings/errors by default; pass console:'all'
to also read your own console.log output from the page (grouped, capped).

PROBE — READ NUMBERS INSTEAD OF PHOTOGRAPHING THEM. probe evaluates JS in the page
after waitFor / beforeShot / scrollTo+settle, right before the capture, and returns
the value as JSON text in the caption: scroll positions, element sizes, app or game
state, what an API returned, localStorage. Add shot:false to get only the text (plus
the failed-request / console-error summary) — no image (about 1k tokens each) left
in your context. Do not write numbers into the DOM to screenshot them.
Example: probe:"({ top: document.querySelector('.beats').scrollTop, h: document.querySelector('.beats').scrollHeight })", shot:false

FILMSTRIP — the eye for ANIMATION. A single still cannot show easing, overshoot,
hard cuts between tweens, or "the whole move played off-screen". Pass
frames (2-30 ms offsets within a 30s window, e.g. [0,120,240,400,700]) + trigger:"window.game.reload()" (JS that
starts the move) and you get ONE contact sheet: the same viewport at each of those
moments, timestamped. One image = one motion curve — judge attack, overshoot,
settle and cuts directly. click:"#start" performs a REAL trusted click instead
(needed for pointer lock / AudioContext / anything gated on a user gesture);
combine both if the move needs click-then-call. scrollBy:<px> drives REAL wheel
scrolling spread over the recording (the way to record scroll-driven motion: reveals,
parallax, snap, sticky), and an ELEMENT PROBE lists which elements moved / faded /
scaled during the recording, by how much and when (fixed layers, parallax and
entrances are told apart). The caption also reports frame
health (fps / p95 / worst frame — catches per-frame decay bugs and jank) and an
audio event log (every media.play() / bufferSource.start() with its timestamp —
you cannot hear, but you CAN see when sound was attempted). Pass saveVideo:true
to also encode the full recording as a .webm under exports/motion/ — you cannot
watch it, but deliver_files hands it to the user for final judgement.
For NUMERIC motion data (exact positions/rotations per frame, overshoot %, settle
time, hard-cut detection) use the trace_motion tool instead — ToolSearch it.

Use this tool when:
- You finished writing or editing a page / deck and want to verify it looks right
- The user asks "what does it look like" or "show me the result"
- You suspect a layout bug and want to see the rendered output
- You want a closeup of one specific page or element (use pageIndex / selector)

Do NOT use this tool when:
- the file doesn't exist yet (write it first)
- You haven't actually changed the design since the last screenshot`;

export const SCREENSHOT_CANVAS_SCHEMA = {
  viewport: z
    .object({
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(240).max(2160),
    })
    .optional()
    .describe('Browser viewport size; defaults to the deck-aspect declared on canvas wrap (16:9=1920×1080, 9:16=1080×1920, 16:10=1920×1200, 4:3=1440×1080)'),
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture full scrollable page instead of just viewport (default false — N× more expensive for N-page deck). Ignored if selector or pageIndex is given.'),
  selector: z
    .string()
    .optional()
    .describe('If given, capture only the first element matching this CSS selector (overrides fullPage). Works on continuously-animating elements too (WebGL canvas etc.) — the capture crops the element box, it does not wait for the element to stop repainting. Plain CSS only — no playwright syntax (:has-text, >>, nth=), ASCII quotes not HTML entities (&quot; breaks the parse)'),
  detail: z
    .enum(['normal', 'high'])
    .optional()
    .describe("Raster detail. 'normal' (default) renders at 0.6x pixels — ~45% cheaper in context, enough for layout/spacing/palette checks. 'high' = full resolution, use only when you must read small text. For .docx: 100 dpi vs 150 dpi page images (also what saveTo writes)."),
  pageIndex: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('DECK ONLY. If given, capture only section[data-page="N"] (overrides fullPage)'),
  device: z
    .enum(['desktop', 'tablet', 'mobile'])
    .optional()
    .describe('SITE ONLY. Render at a real device width to check responsive behaviour: desktop=1440, tablet=834, mobile=390. Ignored for decks.'),
  waitFor: z
    .string()
    .optional()
    .describe("JS expression polled every 100ms until truthy BEFORE beforeShot runs (own 15s budget). Use for slow-booting pages: waitFor:\"window.__game\" waits for the app to be ready, then beforeShot only does the setup. Timeout doesn't block the shot — the caption tells you the condition never became truthy."),
  beforeShot: z
    .string()
    .optional()
    .describe("Run before capture: 'scrollToBottom' scrolls through the page and back (fires all scroll-linked animations — ScrollTrigger / IntersectionObserver reveals), or pass a JS snippet evaluated in page context (await supported, 10s timeout). Don't burn this budget waiting for boot — pair with waitFor. Errors don't block the shot, they're reported in the caption. Its return value is discarded — use probe to read values. Do not reload or navigate inside it (location.reload / location.href =): the capture then fails. To shoot a stored setting (language, theme), switch it through the page's own control instead."),
  scrollTo: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Scroll the REAL viewport here, then capture one viewport-sized frame. Accepts a pixel number, a percentage string ('50%', '100%'), or a CSS selector to scroll into view. Use this — not fullPage — to check anything scroll-driven: reveal animations, scroll-snap landing points, parallax offsets, sticky headers. fullPage cannot show these because it expands the viewport to the whole document instead of scrolling (innerHeight never changes, so scroll handlers never fire the way they do for the user). Implies fullPage=false."),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Extra wait after scrolling before the shot (0-10000 ms, default 350; larger values run as 10000) — long CSS transitions may need more.'),
  console: z
    .enum(['warn', 'all'])
    .optional()
    .describe("Console capture level for the caption. Default 'warn' returns only warnings/errors (the count of filtered log lines is reported). Pass 'all' to also get console.log/info/debug output — the only way to read your own debug logging from the page."),
  probe: z
    .string()
    .min(1)
    .optional()
    .describe(`DECK / SITE. JS evaluated in the page right before the capture (after waitFor / beforeShot / scrollTo+settle); its value comes back as JSON text in the caption. An expression ("document.title", "({ y: scrollY, h: document.body.scrollHeight })", "await fetch('data.json').then(r => r.json())") or statements ending in return ("const el = document.querySelector('.list'); return el.scrollHeight - el.clientHeight"). await supported, 10s timeout. Values JSON cannot hold come back tagged: "[undefined]", "[Function name]", "[Circular]", "[Element div#id.cls]", "[TypeError: msg]", BigInt as "12n"; output capped at ${PROBE_MAX_CHARS} chars (truncation is marked). A throwing probe reports the error and does not block the shot. With frames it runs once the recording has ended. Not for .docx.`),
  shot: z
    .boolean()
    .optional()
    .describe('Default true. false = text only, no image: runs waitFor / beforeShot / scrollTo / probe and returns the probe result plus page diagnostics (failed requests, console errors). Needs probe (or saveTo for a .docx: save the page images without viewing them). Not with frames. Inside artifact_batch also pass screenshotAfter:false, or the batch appends a session screenshot.'),
  frames: z
    .array(z.number().min(0).max(30000))
    .min(1)
    .max(30)
    .optional()
    .describe('FILMSTRIP mode: capture the viewport at these millisecond offsets (t=0 is the moment click/trigger fires) and return ONE timestamped contact sheet. 2-30 offsets. The sheet has a FIXED pixel budget (~2.3MP, ≈3-3.7k tokens whatever the count), so more cells = smaller cells: 6-10 to read detail, 12-16 for a whole choreography, 20-30 only for long sequences where rhythm matters more than detail (crop with selector/pageIndex or zoom afterwards). Place them where the motion lives (dense during the move, one late frame to confirm settle). Include 0 to see the starting pose. With selector/pageIndex the cells are cropped to that element (it must be inside the viewport).'),
  trigger: z
    .string()
    .optional()
    .describe('FILMSTRIP: JS snippet that STARTS the motion, evaluated in page context at t=0 (await OK). E.g. "window.game.startReload()" or dispatching a keydown. Runs after waitFor/beforeShot. Omit to record whatever is already animating.'),
  click: z
    .string()
    .optional()
    .describe('FILMSTRIP: CSS selector to REAL-click at t=0 (trusted user gesture — required for pointer lock, AudioContext, autoplay). Fires before trigger if both are given.'),
  saveVideo: z
    .boolean()
    .optional()
    .describe('FILMSTRIP: also encode the full recording as .webm under exports/motion/ (real timing preserved, jank and all). You cannot watch it — use deliver_files to hand it to the user.'),
  scrollBy: z.number().min(-8000).max(8000).optional()
    .describe('FILMSTRIP: pixels of REAL wheel scrolling dispatched over the recording window (positive = down; -8000 to 8000, values outside run at the nearest limit). Use this for scroll-driven motion (reveal / parallax / snap / sticky) — it is what a visitor does; trigger/click are for JS-started moves. Can combine with trigger/click.'),
  elements: z.boolean().optional()
    .describe('FILMSTRIP: run the element probe (default true): per-frame position/opacity/scale of the elements likely to move, reported as who moved, how much, when. Set false to save a little CPU.'),
  pages: z
    .string()
    .optional()
    .describe('WORD (.docx) ONLY. Which pages to render: "3", "2-5", or "all". Defaults to the first 2 pages; max 6 per call. Ignored for decks and sites.'),
  saveTo: z
    .string()
    .min(1)
    .optional()
    .describe('WORD (.docx) ONLY. Workspace-relative folder (e.g. "交付/简历页图") to also write the rendered page images into, as PNG named <document>-第N页.png; the result lists every saved path and any file it overwrote. The folder is created if missing. Not accepted: absolute paths, "..", folders starting with "." (.claude / .nd / .git), reserved folders (assets / exports / notes / node_modules). The files show up on the canvas inside that folder; deliver_files with the folder hands them to the user as one zip. Add shot:false to save without viewing the images.'),
  path: z
    .string()
    .optional()
    .describe(CANVAS_PATH_DESC),
  live: z.boolean().optional().describe(LIVE_PARAM_DESC),
};

/**
 * 参数组合合同：返回拒绝文字或 null。
 * @param {'docx'|'page'} kind   docx = 渲页图那条管线；page = deck / 站点（playwright）
 */
export function argConflict(kind, { probe, shot, saveTo, frames }) {
  const film = Array.isArray(frames) && frames.length > 0;
  if (kind === 'docx') {
    if (probe) return 'probe does not apply to .docx: a Word document has no page scripts to evaluate. Look at the page images, or read the token source JSON.';
    if (shot === false && !saveTo) return 'shot:false needs saveTo for a .docx (save the page images without viewing them); without it the call would return nothing.';
    return null;
  }
  if (saveTo) return 'saveTo only applies to .docx page images; screenshots of decks and sites are not written to disk.';
  if (shot === false && film) return 'shot:false cannot be combined with frames: a filmstrip is an image. For motion as numbers use trace_motion.';
  if (shot === false && !probe) return 'shot:false needs probe: without it the call would return no image and nothing to read. Pass probe:"<expression>" or drop shot:false.';
  return null;
}
