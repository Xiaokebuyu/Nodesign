import { useEffect, useRef, useState } from 'react';
import { Presentation, Globe, Map as MapIcon, FileText, Compass, Drama } from 'lucide-react';
import { COLOR, GAP, FONT_SIZE, FONT_SANS, FONT_MONO } from '../../../lib/theme.js';
import { PAPER } from '../../../lib/paper.js';
import { SITE_VIEWPORTS, DECK_EMBED_W } from '../../../lib/board-geometry.js';
import { ARTIFACT_HEADER_H, ARTIFACT_PREVIEW_H, HERO_SCALE } from '../../../lib/board-kinds.js';
import { versionOfFile, versionOfSitePage } from '../../../lib/file-versions.js';
import { formatClock } from '../../../lib/helpers.js';
import { Assets, Stage } from '../../../lib/api.js';
import { joinRel } from '../../../lib/paths.js';
import { freezeWin, thawWin } from '../../../lib/frame-freeze.js';
import LiveFrame from '../LiveFrame.jsx';

/**
 * ArtifactCard —— deck / 站点 / 世界共用的那张卡（2026-08-13）
 *
 * ## 在这之前
 *
 * 三种产物各有"收起条"和"展开成内嵌渲染"两态，**六个分支在 BoardCanvas 里抄了
 * 六遍**（约 180 行）。逐行比过，骨架完全一样，真正不同的只有四格：图标、
 * 副标题文案、内容区、按钮文案。抄六遍的代价已经在账上：站点的 ✏️ 提示文案
 * 两态不一致、展开态高度在形态表和 JSX 里各写一遍、站点和世界都用 `Globe`
 * 图标（画布上一眼分不出这张卡是站点还是世界）。
 *
 * ## 现在
 *
 * 只有一种样子：**一条小顶栏 + 下面一块实时预览**，双击开那扇窗。
 *
 * 形状取的正是老"展开态"，因为那本来就是这东西该有的样子 —— 中间试过一版
 * 200×200 的方卡（缩略图在上、名字在下），用户看完的评价是丑：200 宽的缩略图
 * 既看不清版式也看不清字，那张卡既不是图标也不是预览，卡在中间。
 *
 * 取消**两态**换来的不只是少一半代码 —— 卡片尺寸变成恒定的。一个会自己变大
 * 两倍半的卡片是所有防遮盖/落点逻辑的噪声源，而"收起来省地方"这件事等
 * 文件夹那一层来做（收进文件夹，而不是把卡片捏小）。
 *
 * ## 预览为什么是 LiveFrame 而不是服务端截图
 *
 * 服务端截图（`server/lib/cover.js`）更省浏览器，但它**串行**、冷启 ~8s，
 * 而且要等 agent 写完才有新图。画布是"agent 干活时用户在看"的地方，预览
 * 跟着文件版本走才对。代价是每张卡一个 iframe，所以有下面两道闸。
 *
 * ⚠️ **两道限流缺一不可**（否则二十份产物的桌面会把风扇吹起来）：
 *   1. 进视口才挂（IntersectionObserver，预加载 240px）
 *   2. 镜头拉太远就不挂（`scale < 0.35` 时预览什么都看不清，纯浪费）
 */

/** 失败占位共用的那张"纸"（内容各家自定，见 ServedImagePreview） */
const fallbackBox = (box) => ({
  width: box.w, height: box.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: PAPER.paper, color: COLOR.sub, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs,
  textAlign: 'center', padding: GAP.md, boxSizing: 'border-box', lineHeight: 1.7,
});

/**
 * docx / browse 共用的预览：**服务端出的一张图** + 失败占位。
 *
 * deck / site 是 iframe 活页面那半（LiveFrame）；这半是"图 + 兜底"——
 * 两张卡原来逐行抄同一段（lazy / onError / objectFit 全一样），只差 URL 和
 * 占位内容。失败换占位而不是裂图：别把浏览器的错误图标端给用户。
 */
function ServedImagePreview({ src, box, initialFailed = false, fallback }) {
  const [failed, setFailed] = useState(initialFailed);
  if (failed) return fallback;
  return (
    <img
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
      style={{
        width: box.w, height: box.h,
        objectFit: 'cover', objectPosition: 'top center',
        border: 0, display: 'block', background: '#fff',
        pointerEvents: 'none',
      }}
    />
  );
}

/** 三张脸：图标 / 一行小字 / 预览内容。骨架之外的差异**只有这三样**。 */
export const ARTIFACT_FACES = {
  deck: {
    icon: Presentation,
    tip: '双击打开这份幻灯',
    summary: (o) => {
      const t = formatClock(o.mtime);
      return t ? `幻灯 · ${t}` : '幻灯';
    },
    /** 16:9 设计稿按 1920 宽等比缩：640/1920 恰好落成 360 高，不裁不留边 */
    Preview: ({ o, projectId, fileVersions, box, frameRef, onActive }) => (
      <LiveFrame
        title={`deck-${o.id}`}
        frameRef={frameRef}
        onActive={onActive}
        src={`${Assets.artifactFileUrl(projectId, o.deckFile)}?v=${versionOfFile(fileVersions, o.deckFile)}`}
        style={{
          width: 1920, height: 1080, border: 0,
          transform: `scale(${box.w / 1920})`, transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
      />
    ),
  },

  site: {
    icon: Globe,
    tip: '双击打开这个站点',
    summary: (o) => (o.single ? '单页' : `站点 · ${o.pages?.length || 1} 个页面`),
    /**
     * 站点按真实设备宽渲染再等比缩，取顶部一屏。**不套 1920×1080 固定画框** ——
     * 站点高度不定，套死比例只会把长页裁掉一半还显示成"设计稿"。
     */
    /** 滚轮策略（2026-08-14）：站点是长页，预览态的滚动条以前形同虚设 ——
     *  iframe pointerEvents:none，滚轮全被相机吃掉。现在滚轮转发进 iframe。 */
    wheel: 'iframe',
    Preview: ({ o, projectId, fileVersions, box, frameRef, onActive }) => {
      const deviceW = SITE_VIEWPORTS[0].w;
      const scale = box.w / deviceW;
      // 根站的 base 合法地是空串（扁平化后站点长在工作区根上），硬拼 `/` 会造出
      // `/index.html` 这种前导斜杠路径 —— 服务端按绝对路径判越界直接 403
      const base = o.base || o.task;
      const entry = o.entry || 'index.html';
      return (
        <LiveFrame
          title={`site-${o.id}`}
          frameRef={frameRef}
          onActive={onActive}
          src={`${Assets.artifactFileUrl(projectId, joinRel(base, entry))}?v=${versionOfSitePage(fileVersions, base, entry)}`}
          style={{
            width: deviceW, height: Math.round(box.h / scale), border: 0,
            transform: `scale(${scale})`, transformOrigin: '0 0',
            pointerEvents: 'none',
          }}
        />
      );
    },
  },

  /**
   * word 文档（2026-08-17）—— 前两种是 iframe 里跑活页面，这一种是**一张图**。
   *
   * 服务端把第一页渲成图（一次渲整份、按源 mtime 缓存，见 lib/docx-pages.js）。
   * 没有 iframe 也就没有滚轮转发这回事：卡片上只看第一页，翻页是窗里的事。
   *
   * ⚠️ 冷启第一次要等两秒左右（LibreOffice 真跑），所以 `loading="lazy"` +
   * 卡片进视口才挂 —— 一屏十张文档卡同时冷渲会把 1 vCPU 堵死。
   */
  docx: {
    icon: FileText,
    tip: '双击打开这份文档',
    summary: (o) => {
      // word 文件夹：一张卡装着几份（多版本），报个数比报"可改源重建"更有用
      if (o.members?.length > 1) return `文档 · ${o.members.length} 份 · 窗里切换`;
      return o.sourceFile ? '文档 · 可改源重建' : '文档 · 外来文件';
    },
    // ⚠️ 必然会 404 的一种正常态：kinds/docx.js 在 agent 刚写完 token 源、
    // 还没 build 的窗口期就报一份 pending 产物 —— 那几秒里失败占位顶上
    Preview: ({ o, projectId, fileVersions, box }) => (
      <ServedImagePreview
        box={box}
        src={Assets.docxPageUrl(projectId, o.deckFile, 1, {
          w: Math.round(box.w * 2),                     // 2x 出图，缩略图不糊
          v: versionOfFile(fileVersions, o.deckFile),
        })}
        fallback={(
          <div style={fallbackBox(box)}>
            还没构建出来
            <br />
            （改完 token 源要 build 一次）
          </div>
        )}
      />
    ),
  },

  /**
   * agent 的浏览器（2026-08-18）—— **上次看到的样子**，一张服务端存的帧。
   *
   * 为什么不是活画面：实测每 fps 约 3.1pp 单核、满帧 40%，而这台机器只有 1 个核。
   * 桌面上摆着一张永远在推流的卡等于把核送出去。活画面在窗里（双击进去）。
   *
   * 那张帧只在**本来就截了图**的时候产生（agent 的视口截图 / 用户正看着画布时
   * preview 端点现截一张），所以卡上的画面可能落后于 agent 当前在看的页面 ——
   * 顶栏那行小字写的是"上次看到"，不是"实时"，别让人误判。
   */
  browse: {
    // ⚠️ 不能用 Globe —— 站点卡已经是 Globe 了，画布上一眼分不出哪张是"我的站"
    // 哪张是"agent 在外面逛"。图标互不相同这条有测试钉着（正是它逮住了我）。
    icon: Compass,
    tip: '双击进这个浏览器（能看，也能自己接手操作）',
    summary: (o) => {
      const t = formatClock(o.at);
      // 装了多少要写在卡上 —— 工具卡的一半价值是"它替我攒了什么"，
      // 不写的话那些东西只有点进去才知道存在
      const n = o.sites?.length || 0;
      const got = n ? ` · 采过 ${n} 个站` : '';
      // 只有采集、没有访问记录的老项目：别写"已休息 · <站名> · <时间>"那种
      // 假装它刚逛过的话，直接说它装着什么
      if (!o.url) return `采集${got}`;
      return `${o.live ? '在跑' : '已休息'} · ${o.host}${t ? ` · ${t}` : ''}${got}`;
    },
    Preview: ({ o, projectId, box }) => (
      <ServedImagePreview
        box={box}
        initialFailed={!o.hasPreview}
        // ⚠️ 地址里带上 `at`：预览是 no-store 的，但 React 不会因为同一个 src
        // 重新拉 —— agent 翻了页、`at` 变了，这里才换图
        src={Assets.browsePreviewUrl(projectId, o.at)}
        fallback={(
          <div style={{ ...fallbackBox(box), flexDirection: 'column', gap: GAP.sm }}>
            <Compass size={18} style={{ opacity: 0.4 }} />
            <span style={{ fontFamily: FONT_MONO, color: COLOR.text2 }}>{o.host}</span>
            <span>还没有画面 —— 双击进去看</span>
          </div>
        )}
      />
    ),
  },

  /**
   * 演出（RP 显示器，2026-09-05）—— 卡上装的是**跟窗里同一个页面**（服务端 /stage/view，
   * `?embed=1` 只是少了输入框）。它自己订着 SSE，台上写一拍卡面就跟一拍，不靠 ?v= 换代。
   *
   * 按 960 宽渲染再等比缩进 640 的框：显示器 860 以下会折成手机版式（在场者躺成一条），
   * 卡上想看到的是桌面那个样子。字缩到 11px 左右仍能辨认是哪一拍。
   */
  stage: {
    icon: Drama,
    tip: '双击进显示器 —— 在那里对台上说话',
    summary: (o) => {
      const s = o.stage || {};
      const who = (s.cast || []).map(c => c.name).slice(0, 3).join(' / ');
      return `演出 · ${s.beats || 0} 拍${who ? ` · ${who}` : ''}`;
    },
    wheel: 'iframe',
    Preview: ({ o, projectId, box, frameRef, onActive }) => {
      const W = 960;
      const scale = box.w / W;
      return (
        <LiveFrame
          title={`stage-${o.id}`}
          frameRef={frameRef}
          onActive={onActive}
          src={Stage.viewUrl(projectId, { embed: true })}
          style={{
            width: W, height: Math.round(box.h / scale), border: 0,
            transform: `scale(${scale})`, transformOrigin: '0 0',
            pointerEvents: 'none',
          }}
        />
      );
    },
  },

};

/**
 * 进视口才为真。**离开视口会变回 false** —— 这是故意的：留着就没有限流了。
 * rootMargin 给足预加载，正常滚动/平移察觉不到卡片是"刚挂上"的。
 */
export function useInViewport(ref) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return undefined; }
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) setInView(e.isIntersecting); },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/** 镜头比这个还远时预览什么都看不清，挂 iframe 是纯浪费 */
const PREVIEW_MIN_SCALE = 0.35;

/**
 * 活预览的定格延时（08-24 站点卡性能案）：首屏/入场动画跑完这么久之后把
 * iframe 的 rAF 链冻住（见 lib/frame-freeze.js）—— three.js 站点在卡片里
 * 60fps 跑真身，一张卡就能拖垮主画布。悬停解冻、移开再冻（短延时）。
 */
const FREEZE_AFTER_MS = 2500;
const REFREEZE_AFTER_MS = 900;

export default function ArtifactCard({
  o, projectId, fileVersions, scale = 1,
  /** 就地改名：名字位换成输入框（与文件夹卡同一套交互） */
  renaming = false, onRenameCommit, onRenameCancel,
  /** 产物窗开着（08-24）：底下的卡立刻定格 —— 不然窗里窗外是双实例全速跑 */
  previewPaused = false,
}) {
  const face = ARTIFACT_FACES[o.type];
  const boxRef = useRef(null);
  const frameRef = useRef(null);
  const inView = useInViewport(boxRef);

  // ── 定格（deck/site 这两张活 iframe 脸才有 contentWindow；图脸上全是 no-op）──
  const settleTimer = useRef(null);
  const armFreeze = (delay) => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => { freezeWin(frameRef.current?.contentWindow); }, delay);
  };
  // LiveFrame 前台文档就绪（首载 + 版本换代提升）：新窗是热的，跑一会儿再冻。
  // 窗开着时（paused）只给首帧留个短窗口 —— 反正被盖着，没人在看动画
  const handleFrameActive = () => armFreeze(previewPaused ? 800 : FREEZE_AFTER_MS);
  useEffect(() => () => clearTimeout(settleTimer.current), []);
  useEffect(() => {
    if (previewPaused) {
      clearTimeout(settleTimer.current);
      freezeWin(frameRef.current?.contentWindow);
    }
    // 窗关了不自动解冻 —— 定格是常态，想看动的悬停上去
  }, [previewPaused]);

  /**
   * 预览态的滚轮（2026-08-14）：以前这块的滚动条形同虚设 —— 相机在祖先节点上
   * 原生监听 wheel 且无条件 preventDefault，卡内滚动的默认行为被整个吃掉。
   * 修法只能也用**原生监听**：DOM 冒泡先到后代，这里 stopPropagation 就拦住了
   * 相机（React 合成事件走根委托，拦不到人家的原生监听）。
   *   - Ctrl/⌘+滚轮放行：那是缩放手势，属于相机
   *   - site：转发进 iframe（同源，contentWindow.scrollBy）
   *   - deck：16:9 整幅在框里，没有可滚的，不拦（滚轮照旧平移画布）
   */
  const wheelMode = face?.wheel && inView && scale >= PREVIEW_MIN_SCALE ? face.wheel : null;
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !wheelMode) return undefined;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
      e.preventDefault();
      if (wheelMode === 'iframe') {
        try { frameRef.current?.contentWindow?.scrollBy(0, e.deltaY); } catch { /* 跨源不滚 */ }
      } else {
        el.scrollTop += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wheelMode]);

  if (!face) return null;

  // 主角档：画框跟 sizeOf 同一套算法（board-kinds.js），命中区和视觉必须一致
  const hs = o.tier === 'hero' ? HERO_SCALE : 1;
  const box = { w: Math.round(DECK_EMBED_W * hs), h: Math.round(ARTIFACT_PREVIEW_H[o.type] * hs) };
  const Icon = face.icon;
  const live = inView && scale >= PREVIEW_MIN_SCALE;

  return (
    <div title={face.tip} style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 顶栏：这是什么 + 叫什么 + 一行小字。没有按钮 —— 整张卡就是"打开"。 */}
      <div style={{
        height: ARTIFACT_HEADER_H, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `0 ${GAP.sm}px`,
        borderBottom: `1px solid ${COLOR.borderLt}`,
      }}>
        <Icon size={12} color={COLOR.sub} style={{ flexShrink: 0 }} />
        {renaming ? (
          <input
            data-board-action
            autoFocus
            defaultValue={o.title}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              // 拦住：画布上 Esc 是"回上一层"、单键是换工具，不拦就变成打字换工具
              e.stopPropagation();
              if (e.key === 'Enter') onRenameCommit?.(e.currentTarget.value);
              if (e.key === 'Escape') onRenameCancel?.();
            }}
            onBlur={(e) => onRenameCommit?.(e.currentTarget.value)}
            style={{
              flex: 1, minWidth: 0, border: `1px solid ${COLOR.text}`,
              borderRadius: 2, padding: '0 4px', outline: 'none',
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600,
              color: COLOR.text, background: COLOR.bgWhite,
            }}
          />
        ) : (
          <span style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, fontWeight: 600, color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
          }}>{o.title}</span>
        )}
        <span style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.xxs, color: COLOR.sub,
          whiteSpace: 'nowrap', flexShrink: 0,
        }}>{face.summary(o)}</span>
      </div>

      {/* 预览 = 贴在纸上的印样：自带一层薄影和一道内描边（跟首页项目卡同一套） */}
      <div
        ref={boxRef}
        {...(face.scrollable && live
          ? { 'data-board-action': true, onPointerDown: (e) => e.stopPropagation() }
          : null)}
        // 悬停解冻 / 移开再冻：定格是常态，凑近看它才动
        onPointerEnter={() => { clearTimeout(settleTimer.current); thawWin(frameRef.current?.contentWindow); }}
        onPointerLeave={() => armFreeze(REFREEZE_AFTER_MS)}
        style={{
          width: box.w, height: box.h, position: 'relative',
          overflowX: 'hidden', overflowY: face.scrollable && live ? 'auto' : 'hidden',
          background: COLOR.bgWhite,
          boxShadow: 'inset 0 0 0 1px rgba(43,33,23,0.06)',
        }}
      >
        {live
          ? <face.Preview o={o} projectId={projectId} fileVersions={fileVersions} box={box} frameRef={frameRef} onActive={handleFrameActive} />
          : (
            /* 没挂预览时不留一块空白 —— 空白看着像"这件东西坏了"。
               给一张空白横线纸加形态图标（同首页那张 .ndd-shot.empty），
               明确它只是还没显影。 */
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backgroundColor: PAPER.paper,
              backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 21px, rgba(43,33,23,0.05) 21px 22px)',
            }}>
              <Icon size={26} color={PAPER.pencil} />
            </div>
          )}
      </div>
    </div>
  );
}
