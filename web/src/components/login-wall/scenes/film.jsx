/**
 * 场景二「一支短片从一句话到上映」（2026-08-17）。
 *
 * 跟场景一（一件网页从一句话到上线）讲的是同一个产品的另一条能力线：
 * 分镜 → 资产 → 渲染 → 成片 → 上映。红线的走法**故意跟第一套不一样** ——
 * 第一套是左上起、横着走一排再折到左下；这套是横着走完上排之后**整个甩到
 * 左下角**，成片那张最大、压在左下，视线从大图往右滑到卷宗，再抬到登记卡。
 * 两套要是走同一条动线，换场就只是"换了字"，不是换了一面墙。
 *
 * ⚠️ 场景类名各用各的字头（这套是 `.m*` / `.t-*`），选择器**不加**场景前缀，
 * 理由见 deck.jsx 顶上那段（加了会顶翻 `.paper.z2` 的阴影，逐像素闸门抓到过）。
 *
 * ⚠️ 两块地不能占：左上角标题区（x 52~560, y 44~180）和右侧登记卡
 * （x 1065~1440, y 152~560）—— 它们是跨场景不变的锚，住在 AuthGate 的壳里。
 */
import { PAPER, P } from '../../../lib/paper.js';
import { Ring, Clip } from '../../PaperBits.jsx';
import artStill from '../../../assets/login-wall/film-still.webp';
import artSheet from '../../../assets/login-wall/film-sheet.webp';
import artCut from '../../../assets/login-wall/film-cut.webp';
import artDesk from '../../../assets/login-wall/ink-desk.webp';
import dTangle from '../../../assets/login-wall/doodles/tangle.webp';
import dReject from '../../../assets/login-wall/doodles/reject.webp';
import dThumb from '../../../assets/login-wall/doodles/thumb.webp';
import dClock from '../../../assets/login-wall/doodles/clock.webp';

/**
 * 涂鸦复用第一套那批 —— 它们每一个都是**一句通用的话**（这版不行 / 这版过 /
 * 突然通了 / 周五前），不绑定任何一件作品，换场景照样成立。位置得重排：
 * 涂鸦的语义完整性优先于位置，被纸盖掉一半的「这版不行」就不成立了。
 */
const DOODLES = [
  { src: dClock,    left: '30.5%', top: '3.5%',  w: 62,  rot: -5 },  // 周五前
  { src: dThumb,    left: '2.2%',  top: '42%',   w: 84,  rot: 6 },   // 这版过
  { src: dReject,   left: '29.5%', top: '80%',   w: 132, rot: 3 },   // 这版不行
  { src: dTangle,   left: '46.5%', top: '77%',   w: 112, rot: -3 },  // 突然通了
];

export default {
  id: 'film',
  css: `
/* ① 一句话 */
.ndw .m1 { left: 4%; top: 30%; width: 11.5%; padding: 13px 13px 15px;
  background-color: var(--sticky);
  background-image: linear-gradient(180deg, rgba(43,33,23,0.05) 0 9px, transparent 9px), var(--grain);
  font: 13px var(--kai); line-height: 1.72; color: var(--ink-2);
  box-shadow: -1px 3px 5px rgba(93,74,44,0.16), -3px 8px 14px rgba(93,74,44,0.16); }
.ndw .m1 .who { display: block; margin-bottom: 5px; font: 10px var(--kai); color: var(--pencil); letter-spacing: 0.16em; }

/* ② 分镜表：方格纸上六个小格，这套的「骨架」比第一套那张大一号 */
.ndw .m2 { left: 17.5%; top: 27%; width: 17%; padding: 12px 12px 10px;
  background-image: var(--grain),
    repeating-linear-gradient(0deg, ${P('gridLine',0.11)} 0 1px, transparent 1px 13px),
    repeating-linear-gradient(90deg, ${P('gridLine',0.11)} 0 1px, transparent 1px 13px); }
.ndw .m2 .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.ndw .m2 .sh { position: relative; height: 40px; border: 1.4px solid var(--ink-2); opacity: 0.8; }
/* 每格里两三笔：地平线 + 一个人 + 一盏灯，够读出"这是六个不同的镜头"就行 */
.ndw .m2 .sh i { position: absolute; background: rgba(43,33,23,0.34); }
.ndw .m2 .sh u { position: absolute; border: 1px solid rgba(43,33,23,0.42); text-decoration: none; }
.ndw .m2 .sh b { position: absolute; right: 2px; bottom: 0; font: 7px var(--code); font-weight: 400;
  color: var(--pencil); }
.ndw .m2 .cap { margin-top: 8px; font: 11.5px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .m2 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ③ 资产库：先把人定死，不然每一镜长得都不一样。
   ⚠️ 这张必须**矮**：④→⑤ 那条红线要从它下面横着扫过去，纸一高，线就从
   说明文字上划过去（第一版就是这样，截图一看就见）。所以设定图按**三视图
   横构图**出（宽 3:1 那种），别用竖构图人像。 */
.ndw .m3 { left: 35.5%; top: 23%; width: 14.5%; padding: 8px 8px 6px; }
.ndw .m3 img { width: 100%; display: block; }
.ndw .m3 .h { padding-top: 6px; font: 700 12px var(--kai); }
.ndw .m3 .b { margin-top: 2px; font: 10.5px var(--kai); line-height: 1.6; color: var(--ink-2); }

/* ④ 渲染日志 */
.ndw .m4 { left: 50.5%; top: 30%; width: 15.5%; padding: 11px 13px 12px; border-radius: 3px;
  background: linear-gradient(180deg, ${PAPER.termA}, ${PAPER.termB});
  box-shadow: 0 4px 11px rgba(43,33,23,0.34), 0 1px 2px rgba(43,33,23,0.2);
  font: 10px var(--code); color: ${PAPER.termInk}; line-height: 2.05; }
.ndw .m4 .t { font: 600 9px var(--code); letter-spacing: 0.16em; color: ${PAPER.termLabel};
  border-bottom: 1px solid ${P('termHair',0.16)}; padding-bottom: 6px; margin-bottom: 7px; }
.ndw .m4 .ok { color: ${PAPER.termOk}; }
.ndw .m4 .dim { color: ${PAPER.termDim}; }
.ndw .m4 .tail { margin-top: 7px; font-size: 9px; color: ${PAPER.termDim}; }
.ndw .m4 .cur { display: inline-block; width: 6px; height: 11px; background: ${PAPER.termInk};
  vertical-align: -1px; opacity: 0.75; }

/* ⑤ 成片：这套最大最亮的一张，压在左下 */
.ndw .m5 { left: 6%; top: 57%; width: 22%; padding: 9px 9px 7px; }
.ndw .m5 img { width: 100%; display: block; }
.ndw .m5 .cap { padding-top: 7px; padding-right: 20px; font: 12px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .m5 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ⑥ 上映 */
.ndw .m6 { left: 31.5%; top: 62%; width: 15%; padding: 13px 15px 14px 22px;
  background-color: var(--kraft); background-image: var(--grain); }
.ndw .m6 .tab { position: absolute; top: -13px; left: 16px; background: var(--kraft); padding: 2px 13px;
  font: 11.5px var(--kai); color: var(--ink-2); border-radius: 4px 4px 0 0; }
.ndw .m6 .t { font: 700 14.5px var(--kai); padding-right: 74px; }
.ndw .m6 .d { margin-top: 3px; font: 11.5px var(--kai); line-height: 1.65; color: var(--ink-2); }
.ndw .m6 .r { margin-top: 9px; padding-top: 7px; border-top: 1px solid ${P('ink2',0.3)};
  font: 9.5px var(--kai); letter-spacing: 0.06em; color: ${P('ink2',0.8)};
  display: flex; justify-content: space-between; }
.ndw .m6 .live { position: absolute; right: 13px; top: 14px; padding: 3px 9px; border: 1.5px solid var(--red);
  border-radius: 2px; font: 11px var(--kai); color: var(--red); letter-spacing: 0.16em;
  text-indent: 0.16em; transform: rotate(-4deg); opacity: 0.82; }

/* ── 侧料 ── */

/* 废镜头：打叉的一帧，钉在成片和卷宗中间那道缝上 */
.ndw .t-cut { left: 48.5%; top: 65%; width: 8.5%; padding: 7px 7px 5px; }
.ndw .t-cut img { width: 100%; display: block; filter: grayscale(0.7) brightness(0.94); }
.ndw .t-cut .x { position: absolute; inset: 7px 7px 22px; z-index: 5; }
.ndw .t-cut .x path { stroke: var(--red); stroke-width: 2.4; fill: none; opacity: 0.72; stroke-linecap: round; }
.ndw .t-cut .cap { padding-top: 5px; font: 10.5px var(--kai); color: var(--pencil); text-align: center; }

/* 用量小票：这套按镜头算钱 */
.ndw .t-receipt { left: 59%; top: 62%; width: 5.4%; padding: 10px 9px 14px;
  font: 8.5px var(--code); color: var(--ink-2); line-height: 2; letter-spacing: 0.03em;
  clip-path: polygon(0 0, 100% 0, 100% 96%, 90% 100%, 80% 96%, 70% 100%, 60% 96%, 50% 100%, 40% 96%, 30% 100%, 20% 96%, 10% 100%, 0 100%); }
.ndw .t-receipt .h { font: 700 8.5px var(--kai); color: var(--ink);
  border-bottom: 1px dashed var(--hair); padding-bottom: 3px; margin-bottom: 4px; }

/* 时间轴：描图纸压在分镜上，量哪一拍不对 */
.ndw .t-beat { left: 65.5%; top: 74%; width: 10.5%; padding: 12px 12px 14px;
  background-color: ${P('trace',0.72)}; background-image: var(--grain);
  box-shadow: 0 2px 6px rgba(93,74,44,0.14);
  font: 11.5px var(--kai); line-height: 1.68; color: ${P('traceInk',0.78)}; }

/* 这周做完的：同一个人的墙，这张清单跨场景都在，只是内容跟着走 */
.ndw .t-legal { left: 55.5%; top: 4.5%; width: 12.5%; padding: 15px 14px 16px;
  background-color: var(--legal);
  background-image: var(--grain), repeating-linear-gradient(0deg, transparent 0 25px, ${P('red',0.15)} 25px 26px);
  clip-path: polygon(0 5px, 4% 0, 8% 5px, 12% 0, 16% 5px, 20% 0, 24% 5px, 28% 0, 32% 5px, 36% 0, 40% 5px, 44% 0, 48% 5px, 52% 0, 56% 5px, 60% 0, 64% 5px, 68% 0, 72% 5px, 76% 0, 80% 5px, 84% 0, 88% 5px, 92% 0, 96% 5px, 100% 0, 100% 100%, 0 100%); }
.ndw .t-legal .h { font: 700 14px var(--kai); margin-bottom: 6px; }
.ndw .t-legal li { list-style: none; font: 13px var(--kai); line-height: 25px; color: var(--ink-2); }
.ndw .t-legal li i { font-style: normal; color: var(--red); margin-right: 5px; }

/* 下一支 */
.ndw .t-next { right: 4.5%; top: 2.4%; width: 19.5%; padding: 13px 14px 14px;
  background-image: var(--grain),
    repeating-linear-gradient(180deg, transparent 0 25px, ${P('gridLine',0.13)} 25px 26px); }
.ndw .t-next .h { font: 700 13px var(--kai); border-bottom: 1.5px solid ${P('red',0.35)}; padding-bottom: 5px; }
.ndw .t-next .b { margin-top: 7px; font: 12.5px var(--kai); line-height: 1.8; color: var(--ink-2); }

/* 工作台草稿：老位置那张，换成竖屏试排 */
.ndw .t-desk { left: 78%; top: 74%; width: 12%; padding: 8px 8px 6px; }
.ndw .t-desk img { width: 100%; display: block; mix-blend-mode: multiply; }
.ndw .t-desk .cap { padding-top: 5px; font: 11px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .t-desk .cap b { font: 9px var(--code); color: var(--pencil); font-weight: 400; }
`,
  render: () => (
    <>
      {/* 板上的字：进度记在墙上，纸只记事 */}
      <div className="wall blk" style={{ left: '36.5%', top: '5.5%', transform: 'rotate(-0.5deg)' }}>
        <span className="t">八月第二周</span>
        <svg className="rule" viewBox="0 0 104 7" preserveAspectRatio="none" aria-hidden="true">
          <path d="M1 4 Q 26 2, 52 4.2 T 103 3" fill="none"
            stroke={P('sketch', 0.55)} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        刚做完 <span className="n">夜班者</span><br />
        39 个镜头<br />
        这一支花了 <span className="n">¥19.6</span>
      </div>
      <span className="wall lbl" style={{ left: '55.4%', top: '1%', fontSize: 16, transform: 'rotate(-1.2deg)' }}>墙上别的</span>
      {/* 断行写死：交给自动折行会把「片子」「周六」这种词拆开（真跑截图上一眼可见） */}
      <div className="wall lbl" style={{ left: '18%', top: '47.5%', fontSize: 11, lineHeight: 2, transform: 'rotate(-1deg)' }}>
        ① 到 ⑥ 是同一支片子<br />周六下午开的头
      </div>

      {DOODLES.map((d, i) => (
        <img key={i} className="doodle" src={d.src} alt=""
          style={{ left: d.left, top: d.top, width: d.w, transform: `rotate(${d.rot}deg)` }} />
      ))}

      {/* ① 一句话 */}
      <div className="paper m1 z2 sway" style={{ '--rot': '2.1deg' }}>
        <span className="no"><Ring />①</span>
        <span className="pin r" />
        <span className="who">我说</span>做一支外卖员的夜班短片，丧一点，不要台词
        <span className="when">周六 14:20</span>
      </div>

      {/* ② 分镜表：后面垫着上一版 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '18%', top: '28.2%', width: '16.7%', height: 150, '--rot': '-2.4deg' }} />
      <div className="paper m2 z0 crease sway" style={{ '--rot': '-0.9deg' }}>
        <span className="no"><Ring />②</span>
        <Clip cx="24%" />
        <div className="grid">
          {/* 六格：地平线 + 一个人 + 一盏灯，位置各不相同 = 六个镜头 */}
          <span className="sh"><i style={{ left: '8%', bottom: '30%', width: '84%', height: 1 }} />
            <u style={{ left: '22%', bottom: '30%', width: 5, height: 12 }} /><b>01</b></span>
          <span className="sh"><i style={{ left: '8%', bottom: '46%', width: '84%', height: 1 }} />
            <u style={{ left: '58%', bottom: '46%', width: 7, height: 16 }} /><b>04</b></span>
          <span className="sh"><i style={{ left: '8%', bottom: '22%', width: '84%', height: 1 }} />
            <u style={{ left: '40%', bottom: '22%', width: 11, height: 22 }} /><b>09</b></span>
          <span className="sh"><i style={{ left: '8%', bottom: '52%', width: '84%', height: 1 }} />
            <u style={{ left: '14%', bottom: '52%', width: 6, height: 10 }} /><b>17</b></span>
          <span className="sh"><i style={{ left: '8%', bottom: '34%', width: '84%', height: 1 }} />
            <u style={{ left: '66%', bottom: '34%', width: 9, height: 18 }} /><b>26</b></span>
          <span className="sh"><i style={{ left: '8%', bottom: '40%', width: '84%', height: 1 }} />
            <u style={{ left: '34%', bottom: '40%', width: 14, height: 9 }} /><b>39</b></span>
        </div>
        <div className="cap"><span>它先排了分镜</span><b>FIG. 03</b></div>
        <span className="bow" />
      </div>

      {/* ③ 资产库 */}
      <div className="paper m3 z2 dog sway" style={{ '--rot': '1.7deg' }}>
        <span className="no"><Ring />③</span>
        <Clip cx="22%" />
        <img src={artSheet} alt="站内做出来的主角三视图设定" />
        <div className="h">先把人定下来</div>
        <div className="b">不然每一镜长得都不一样</div>
      </div>

      {/* ④ 它自己动手 */}
      <div className="paper m4 sway" style={{ '--rot': '-1.2deg' }}>
        <span className="no"><Ring />④</span>
        <span className="pin" />
        <div className="t">它自己动手</div>
        <span className="ok">✓</span> paint_still <span className="dim">设定 3 张</span><br />
        <span className="ok">✓</span> roll_film <span className="dim">波 1 · 04:12</span><br />
        <span className="ok">✓</span> roll_film <span className="dim">波 2 · 03:58</span><br />
        <span className="dim">&gt;</span> 拼装 EDL <span className="cur" />
        <div className="tail">已经跑了 1 小时 47 分</div>
      </div>

      {/* ⑤ 成片 */}
      <div className="paper m5 z2 dog sway" style={{ '--rot': '1.3deg' }}>
        <span className="no"><Ring />⑤</span>
        <span className="pin" />
        <img src={artStill} alt="站内做出来的《夜班者》成片一帧" />
        <div className="cap"><span>成片一帧 · 03:41</span><b>夜班者.mp4</b></div>
        <span className="bow" />
      </div>

      {/* ⑥ 上映 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '31.9%', top: '62.7%', width: '14.7%', height: 104, '--rot': '2.1deg' }} />
      <div className="paper m6 wrinkle sway" style={{ '--rot': '-1.1deg' }}>
        <span className="no"><Ring />⑥</span>
        <span className="tab">项目 · 卷宗</span>
        <span className="holes" />
        <div className="t">夜班者</div>
        <div className="d">39 个镜头拼完，导出 1080p</div>
        <div className="r"><span>FIG. 04</span><span>周日 02:10</span></div>
        <span className="live">已上映</span>
        <span className="bow" />
      </div>

      {/* 侧料 */}
      <div className="paper t-cut z0 sway" style={{ '--rot': '-2.3deg' }}>
        <span className="pin r" />
        <img src={artCut} alt="" />
        <svg className="x" viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true">
          <path d="M 8 8 L 92 62" /><path d="M 92 9 L 9 61" />
        </svg>
        <div className="cap">这条慢一拍</div>
      </div>

      <div className="paper t-receipt sway" style={{ '--rot': '2.4deg' }}>
        <span className="pin" />
        <div className="h">用量小票</div>
        RUN 0809-24<br />39镜×50步<br />¥19.60<br />* * *
      </div>

      <div className="paper t-beat z2 sway" style={{ '--rot': '1.8deg' }}>
        <Clip cx="34%" />
        第 12 和 13 之间<br />少半拍，补一格
      </div>

      <div className="paper pstack" aria-hidden="true"
        style={{ left: '55.9%', top: '5.2%', width: '12.2%', height: 148, '--rot': '2.2deg' }} />
      <div className="paper t-legal z0 sway" style={{ '--rot': '-1.3deg' }}>
        <span className="staple" style={{ '--cx': '18px' }} />
        <span className="staple" style={{ '--cx': 'calc(100% - 32px)' }} />
        <div className="h">这周做完的</div>
        <li><i>✓</i>夜班者</li>
        <li><i>✓</i>好巧</li>
        <li><i>✓</i>SPiCa 歌词页</li>
        <li>竖屏版</li>
        <span className="bow" />
      </div>

      <div className="paper t-next z0 dog sway" style={{ '--rot': '0.9deg' }}>
        <span className="pin" />
        <div className="h">下一支</div>
        <div className="b">同一个人，白天那一版。看看两条剪在一起会怎么样。</div>
      </div>

      <div className="paper t-desk z0 crease-h sway" style={{ '--rot': '-1.6deg' }}>
        <Clip cx="62%" />
        <img src={artDesk} alt="" />
        <div className="cap"><span>工作台 · 竖屏试排</span><b>DESK-002</b></div>
      </div>

      {/* 线索线：横着走完上排，整个甩到左下角，再抬回登记卡 */}
      <svg className="ndw-thread" viewBox="0 0 1500 800" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 236 286 C 246 282, 254 279, 262 276 M 249 272 l 15 4 l -11 11" />
        <path d="M 522 262 C 532 256, 542 251, 553 247 M 540 243 l 15 4 l -11 11" />
        <path d="M 727 274 C 736 278, 744 282, 752 287 M 739 283 l 15 5 l -3 -16" />
        <path d="M 860 386 C 790 470, 560 452, 322 452 M 342 444 l -20 9 l 18 11" />
        <path d="M 424 596 C 438 590, 450 586, 462 582 M 448 578 l 15 4 l -11 11" />
        <path className="soft" d="M 700 566 C 800 508, 930 462, 1040 428 M 1024 424 l 17 4 l -9 14" />
      </svg>
      <span className="hand" style={{ left: '20.5%', top: '54%', fontSize: 17, transform: 'rotate(-4deg)' }}>渲完了</span>
      <span className="hand" style={{ left: '61.5%', top: '52%', fontSize: 23, transform: 'rotate(-3deg)' }}>轮到你了</span>
      <span className="hand p" style={{ left: '4.6%', top: '26.6%', fontSize: 11.5, transform: 'rotate(-2deg)' }}>一句话开始 ↓</span>
    </>
  ),
};
