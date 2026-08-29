/**
 * 场景一「一件作品从一句话到上线」——2026-08-03 定稿、过线的那面墙。
 *
 * ⚠️ 这份是从 AuthGate.jsx **逐字搬过来**的（2026-08-17 拆场景），CSS 和 JSX
 * 一个字符没动。验收判据就是拿它跟拆之前的截图逐像素 diff 要求 0 —— 这条守门法
 * 是换肤那次立的，别省。
 *
 * ## 为什么选择器**不加**场景前缀
 *
 * 第一版给每条规则加了 `.sc-deck` 作用域，结果三张纸的阴影当场变了：`.b1/.b5/
 * .s-trace` 都是 `z2` 且自带 box-shadow，加前缀把它们从 (0,2,0) 顶到 (0,3,0)，
 * 跟共用的 `.ndw .paper.z2` 打平之后靠源码顺序反超，赢家换人。逐像素闸门当场
 * 报了 42016 个差异点 —— 肉眼在两张图之间是看不出这个的。
 *
 * 不加前缀的前提是：**同一时刻只有一套场景挂在 DOM 上**（轮播是先摘干净再钉
 * 下一套，不交叉淡入）。所以场景之间的类名不会打架。⚠️ 哪天真要做两套同时在
 * 场的效果（交叉淡入之类），这条前提就没了，那时候要动的是共用 CSS 的特异度，
 * 不是往场景选择器上加前缀。
 *
 * 类名还是各用各的（这套用 `.b1~.b6` / `.s-*`，别的场景换个字头），纯粹是为了
 * 出问题时一眼看出是谁的规则。
 *
 * 读法：① 一句话 → ② 骨架 → ③ 它自己动手 → ④ 出来的东西 → ⑤ 我说改 → ⑥ 上线，
 * 一条红线串起来，最后一箭指向登记卡「轮到你了」。侧料（这周做完的/下一件/
 * 用量小票/描图纸/纸飞机/工作台草稿）不上线索，只供密度。
 *
 * 加新场景照这个形状写一份即可 —— 壳（板面、标题、登记卡）不用管，
 * 场景只负责「纸摆在哪、上面写什么、线怎么走」。
 */
import { Ring, Clip } from '../../PaperBits.jsx';
import artNight from '../../../assets/login-wall/ink-night.webp';
import artDesk from '../../../assets/login-wall/ink-desk.webp';
import artPortrait from '../../../assets/login-wall/ink-portrait.webp';
import artPlane from '../../../assets/login-wall/ink-plane.webp';
import dTangle from '../../../assets/login-wall/doodles/tangle.webp';
import dReject from '../../../assets/login-wall/doodles/reject.webp';
import dBulb from '../../../assets/login-wall/doodles/bulb.webp';
import dThumb from '../../../assets/login-wall/doodles/thumb.webp';
import dQuestion from '../../../assets/login-wall/doodles/question.webp';
import dClock from '../../../assets/login-wall/doodles/clock.webp';

/**
 * 板子上的随手涂鸦。**字是和画一起生成的**，不是 CSS 排上去的 ——
 * 用户要的是「写的话都不工整，但看起来很有条理很舒服」，字体排不出那个手感。
 * 每一个都是一句话不是一个物件；尺寸跨度 46~185（四倍）。
 */
const DOODLES = [
  { src: dBulb,     left: '0.3%',  top: '25%',   w: 46,  rot: -7 },  // 有了
  { src: dClock,    left: '46.7%', top: '21.5%', w: 68,  rot: 6 },   // 周五前
  { src: dQuestion, left: '48.5%', top: '43%',   w: 78,  rot: 4 },   // 先放着
  { src: dThumb,    left: '48.3%', top: '76%',   w: 96,  rot: -8 },  // 这版过
  { src: dTangle,   left: '83.3%', top: '72.5%', w: 150, rot: -4 },  // 突然通了
  { src: dReject,   left: '1%',    top: '45%',   w: 185, rot: -3 },  // 这版不行
];

export default {
  id: 'deck',
  css: `
/* ① 一句话 */
.ndw .b1 { left: 3.5%; top: 31%; width: 11%; padding: 13px 13px 15px;
  background-color: var(--sticky);
  background-image: linear-gradient(180deg, rgba(43,33,23,0.05) 0 9px, transparent 9px), var(--grain);
  font: 13px var(--kai); line-height: 1.72; color: var(--ink-2);
  box-shadow: -1px 3px 5px rgba(93,74,44,0.16), -3px 8px 14px rgba(93,74,44,0.16); }
.ndw .who { display: block; margin-bottom: 5px; font: 10px var(--kai); color: var(--pencil); letter-spacing: 0.16em; }

/* ② 骨架 */
.ndw .b2 { left: 17%; top: 34.5%; width: 13%; padding: 13px 13px 11px;
  background-image: var(--grain),
    repeating-linear-gradient(0deg, rgba(74,107,143,0.11) 0 1px, transparent 1px 13px),
    repeating-linear-gradient(90deg, rgba(74,107,143,0.11) 0 1px, transparent 1px 13px); }
.ndw .b2 .wf { border: 1.5px solid var(--ink-2); height: 78px; position: relative; opacity: 0.82; }
.ndw .b2 .wf i { position: absolute; border: 1px solid var(--ink-2); }
.ndw .b2 .wf b { position: absolute; left: 8%; top: 42%; right: 46%; height: 4px; background: rgba(43,33,23,0.3); }
.ndw .b2 .cap { margin-top: 8px; font: 11.5px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .b2 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ③ 终端墨版 */
.ndw .b3 { left: 33%; top: 31.5%; width: 15%; padding: 11px 13px 12px; border-radius: 3px;
  background: linear-gradient(180deg, #2b2318, #241d14);
  box-shadow: 0 4px 11px rgba(43,33,23,0.34), 0 1px 2px rgba(43,33,23,0.2);
  font: 10px var(--code); color: #E4DCC8; line-height: 2.05; }
.ndw .b3 .t { font: 600 9px var(--code); letter-spacing: 0.16em; color: #9b917c;
  border-bottom: 1px solid rgba(228,220,200,0.16); padding-bottom: 6px; margin-bottom: 7px; }
.ndw .b3 .ok { color: #9DBF9A; }
.ndw .b3 .dim { color: #8A8069; }
.ndw .b3 .tail { margin-top: 7px; font-size: 9px; color: #8A8069; }
.ndw .b3 .cur { display: inline-block; width: 6px; height: 11px; background: #E4DCC8;
  vertical-align: -1px; opacity: 0.75; }

/* ④ 成品 */
.ndw .b4 { left: 5%; top: 60%; width: 19.5%; padding: 9px 9px 7px; }
.ndw .b4 img { width: 100%; display: block; }
.ndw .b4 .cap { padding-top: 7px; padding-right: 20px; font: 12px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .b4 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ⑤ 批注 */
.ndw .b5 { left: 27%; top: 63%; width: 10.5%; padding: 12px 12px 14px;
  background-color: var(--sticky);
  background-image: linear-gradient(180deg, rgba(43,33,23,0.05) 0 8px, transparent 8px), var(--grain);
  font: 12.5px var(--kai); line-height: 1.7; color: var(--red);
  box-shadow: -1px 3px 5px rgba(93,74,44,0.16), -3px 8px 14px rgba(93,74,44,0.16); }

/* ⑥ 上线 */
.ndw .b6 { left: 39.5%; top: 61%; width: 15.5%; padding: 13px 15px 14px 22px;
  background-color: var(--kraft); background-image: var(--grain); }
.ndw .b6 .tab { position: absolute; top: -13px; left: 16px; background: var(--kraft); padding: 2px 13px;
  font: 11.5px var(--kai); color: var(--ink-2); border-radius: 4px 4px 0 0; }
.ndw .b6 .t { font: 700 14.5px var(--kai); padding-right: 74px; }
.ndw .b6 .d { margin-top: 3px; font: 11.5px var(--kai); line-height: 1.65; color: var(--ink-2); }
.ndw .b6 .r { margin-top: 9px; padding-top: 7px; border-top: 1px solid rgba(95,81,66,0.3);
  font: 9.5px var(--kai); letter-spacing: 0.06em; color: rgba(95,81,66,0.8);
  display: flex; justify-content: space-between; }
.ndw .b6 .live { position: absolute; right: 13px; top: 14px; padding: 3px 9px; border: 1.5px solid var(--red);
  border-radius: 2px; font: 11px var(--kai); color: var(--red); letter-spacing: 0.16em;
  text-indent: 0.16em; transform: rotate(-4deg); opacity: 0.82; }

/* 侧料 */
.ndw .s-legal { left: 56.5%; top: 5%; width: 12.5%; padding: 15px 14px 16px;
  background-color: var(--legal);
  background-image: var(--grain), repeating-linear-gradient(0deg, transparent 0 25px, rgba(168,54,43,0.15) 25px 26px);
  clip-path: polygon(0 5px, 4% 0, 8% 5px, 12% 0, 16% 5px, 20% 0, 24% 5px, 28% 0, 32% 5px, 36% 0, 40% 5px, 44% 0, 48% 5px, 52% 0, 56% 5px, 60% 0, 64% 5px, 68% 0, 72% 5px, 76% 0, 80% 5px, 84% 0, 88% 5px, 92% 0, 96% 5px, 100% 0, 100% 100%, 0 100%); }
.ndw .s-legal .h { font: 700 14px var(--kai); margin-bottom: 6px; }
.ndw .s-legal li { list-style: none; font: 13px var(--kai); line-height: 25px; color: var(--ink-2); }
.ndw .s-legal li i { font-style: normal; color: var(--red); margin-right: 5px; }

.ndw .s-index { left: 57.5%; top: 27%; width: 12.5%; padding: 13px 14px 16px;
  background-image: var(--grain),
    repeating-linear-gradient(180deg, transparent 0 25px, rgba(74,107,143,0.13) 25px 26px); }
.ndw .s-index .h { font: 700 13px var(--kai); border-bottom: 1.5px solid rgba(168,54,43,0.35); padding-bottom: 5px; }
.ndw .s-index .b { margin-top: 7px; font: 12.5px var(--kai); line-height: 1.8; color: var(--ink-2); }

.ndw .s-strip { left: 57.5%; top: 39%; width: 10%; padding: 17px 12px 10px;
  background-color: #E9D8BB; background-image: var(--grain);
  font: 12px var(--kai); color: var(--ink-2); text-align: center;
  clip-path: polygon(3% 0, 97% 0, 100% 24%, 96% 47%, 100% 72%, 97% 100%, 3% 100%, 0 76%, 4% 50%, 0 26%); }

.ndw .s-receipt { left: 40%; top: 76%; width: 5.4%; padding: 10px 9px 14px;
  font: 8.5px var(--code); color: var(--ink-2); line-height: 2; letter-spacing: 0.03em;
  clip-path: polygon(0 0, 100% 0, 100% 96%, 90% 100%, 80% 96%, 70% 100%, 60% 96%, 50% 100%, 40% 96%, 30% 100%, 20% 96%, 10% 100%, 0 100%); }
.ndw .s-receipt .h { font: 700 8.5px var(--kai); color: var(--ink);
  border-bottom: 1px dashed var(--hair); padding-bottom: 3px; margin-bottom: 4px; }

.ndw .s-old { left: 58.5%; top: 73%; width: 8%; padding: 7px 7px 5px; }
.ndw .s-old img { width: 100%; display: block; }
.ndw .s-old .cap { padding-top: 5px; font: 10.5px var(--kai); color: var(--pencil); text-align: center; }

/* 钉在登记卡正上方：回答访客的下一个问题「进去之后我说什么」 */
.ndw .s-hint { right: 4.5%; top: 2.4%; width: 19.5%; padding: 10px 12px 11px; }
.ndw .s-hint .h { font: 10px var(--kai); letter-spacing: 0.14em; color: var(--pencil);
  border-bottom: 1px solid rgba(43,33,23,0.14); padding-bottom: 5px; }
.ndw .s-hint li { list-style: none; margin-top: 4px; font: 11px var(--kai);
  line-height: 1.5; color: var(--ink-2); display: flex; gap: 6px; }
.ndw .s-hint li i { font-style: normal; color: var(--red); opacity: 0.7; }

.ndw .s-trace { left: 64%; top: 76.5%; width: 8.5%; padding: 13px 12px 15px;
  background-color: rgba(243,241,230,0.72); background-image: var(--grain);
  box-shadow: 0 2px 6px rgba(93,74,44,0.14);
  font: 11.5px var(--kai); line-height: 1.68; color: rgba(60,50,38,0.78); }

.ndw .s-plane { left: 74%; top: 78%; width: 8%; padding: 7px 7px 5px; }
.ndw .s-plane img { width: 100%; display: block; mix-blend-mode: multiply; }
.ndw .s-plane .cap { padding-top: 4px; font: 11px var(--kai); color: var(--pencil); text-align: center; }

.ndw .s-desk { left: 33%; top: 4%; width: 12%; padding: 8px 8px 6px; }
.ndw .s-desk img { width: 100%; display: block; mix-blend-mode: multiply; }
.ndw .s-desk .cap { padding-top: 5px; font: 11px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .s-desk .cap b { font: 9px var(--code); color: var(--pencil); font-weight: 400; }

/* ===== 登记卡：线索的终点 ===== */
`,
  render: () => (
    <>
      {/* 板上的字：进度记在墙上，纸只记事 */}
      <div className="wall blk" style={{ left: '46.5%', top: '6%', transform: 'rotate(-0.6deg)' }}>
        <span className="t">八月第一周</span>
        <svg className="rule" viewBox="0 0 104 7" preserveAspectRatio="none" aria-hidden="true">
          <path d="M1 4 Q 26 2, 52 4.2 T 103 3" fill="none"
            stroke="rgba(122,111,92,0.55)" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        在做 <span className="n">演示 deck</span><br />
        已上线 <span className="n">3 件</span><br />
        这个月花了 <span className="n">$4.10</span>
      </div>
      <span className="wall lbl" style={{ left: '56.4%', top: '1.4%', fontSize: 16, transform: 'rotate(-1.4deg)' }}>墙上别的</span>
      <div className="wall lbl" style={{ left: '48.5%', top: '33%', width: 104, fontSize: 11, lineHeight: 2, transform: 'rotate(-1.2deg)' }}>
        ① 到 ⑥ 是同一件东西，周二晚开的头，周四凌晨上线
      </div>

      {DOODLES.map((d, i) => (
        <img key={i} className="doodle" src={d.src} alt=""
          style={{ left: d.left, top: d.top, width: d.w, transform: `rotate(${d.rot}deg)` }} />
      ))}

      {/* ① 一句话 */}
      <div className="paper b1 z2 sway" style={{ '--rot': '-1.8deg' }}>
        <span className="no"><Ring />①</span>
        <span className="pin r" />
        <span className="who">我说</span>给这首歌做个歌词页，安静一点，星空的感觉
        <span className="when">周二 22:10</span>
      </div>

      {/* ② 骨架：后面还垫着前一版 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '17.5%', top: '35.7%', width: '12.7%', height: 130, '--rot': '2.9deg' }} />
      <div className="paper b2 z0 crease sway" style={{ '--rot': '1deg' }}>
        <span className="no"><Ring />②</span>
        <Clip cx="20%" />
        <div className="wf">
          <i style={{ left: '7%', top: '10%', width: '38%', height: '24%' }} />
          <i style={{ right: '7%', top: '10%', width: '36%', height: '62%' }} />
          <b />
          <i style={{ left: '7%', bottom: '12%', width: '52%', height: '20%' }} />
        </div>
        <div className="cap"><span>它先给了个骨架</span><b>FIG. 01</b></div>
        <span className="bow" />
      </div>

      {/* ③ 它自己动手 */}
      <div className="paper b3 sway" style={{ '--rot': '-0.8deg' }}>
        <span className="no"><Ring />③</span>
        <span className="pin" />
        <div className="t">它自己动手</div>
        <span className="ok">✓</span> generate_image <span className="dim">夜空底</span><br />
        <span className="ok">✓</span> remove_background <span className="dim">2.1s</span><br />
        <span className="ok">✓</span> write_page <span className="dim">lyrics.html</span><br />
        <span className="dim">&gt;</span> screenshot_canvas <span className="cur" />
        <div className="tail">已经跑了 11 分 04 秒</div>
      </div>

      {/* ④ 成品 */}
      <div className="paper b4 z2 dog sway" style={{ '--rot': '-1.4deg' }}>
        <span className="no"><Ring />④</span>
        <span className="pin" />
        <img src={artNight} alt="站内做出来的 SPiCa 歌词页样张" />
        <div className="cap"><span>出来的东西 · 22:26</span><b>lyrics.html</b></div>
        <span className="bow" />
      </div>

      {/* ⑤ 批注 */}
      <div className="paper b5 z2 sway" style={{ '--rot': '2.2deg' }}>
        <span className="no"><Ring />⑤</span>
        <span className="pin r" />
        <span className="who">我说</span>字体再收一号，留白多一点
        <span className="when">周三 09:40</span>
      </div>

      {/* ⑥ 上线：卷宗里不止一页 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '39.9%', top: '61.7%', width: '15.2%', height: 106, '--rot': '-1.7deg' }} />
      <div className="paper b6 wrinkle sway" style={{ '--rot': '0.7deg' }}>
        <span className="no"><Ring />⑥</span>
        <span className="tab">项目 · 卷宗</span>
        <span className="holes" />
        <div className="t">SPiCa 歌词页</div>
        <div className="d">改完第二版，凌晨两点推上去的</div>
        <div className="r"><span>FIG. 02</span><span>周四 01:50</span></div>
        <span className="live">已上线</span>
        <span className="bow" />
      </div>

      {/* 侧料 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '56.9%', top: '5.7%', width: '12.2%', height: 152, '--rot': '-1.6deg' }} />
      <div className="paper s-legal z0 sway" style={{ '--rot': '0.9deg' }}>
        <span className="staple" style={{ '--cx': '18px' }} />
        <span className="staple" style={{ '--cx': 'calc(100% - 32px)' }} />
        <div className="h">这周做完的</div>
        <li><i>✓</i>SPiCa 歌词页</li>
        <li><i>✓</i>角色档案站</li>
        <li><i>✓</i>同人资料站</li>
        <li>演示 deck，周五前</li>
        <span className="bow" />
      </div>

      <div className="paper s-index z0 dog sway" style={{ '--rot': '-1.1deg' }}>
        <span className="pin" />
        <div className="h">下一件</div>
        <div className="b">歌词页要不要做一版竖屏？手机上翻着看。</div>
      </div>

      <div className="paper s-strip sway" style={{ '--rot': '-1.5deg' }}>
        <span className="pin r" />上个月那批还挂着
      </div>

      <div className="paper s-receipt sway" style={{ '--rot': '1.9deg' }}>
        <span className="pin" />
        <div className="h">用量小票</div>
        RUN 0802-17<br />48,212 tok<br />$0.026<br />* * *
      </div>

      <div className="paper s-old dog sway" style={{ '--rot': '1.6deg' }}>
        <span className="pin" />
        <img src={artPortrait} alt="站内做出来的角色档案站样张" />
        <div className="cap">角色档案站</div>
      </div>

      <div className="paper s-trace z2 sway" style={{ '--rot': '-2deg' }}>
        <Clip cx="30%" />
        描图纸压一版<br />字往下挪两格
      </div>

      <div className="paper s-plane sway" style={{ '--rot': '1.3deg' }}>
        <span className="pin" />
        <img src={artPlane} alt="" />
        <div className="cap">还没起飞</div>
      </div>

      <div className="paper s-desk z0 crease-h sway" style={{ '--rot': '1.2deg' }}>
        <Clip cx="66%" />
        <img src={artDesk} alt="" />
        <div className="cap"><span>工作台 · 版式草稿</span><b>DESK-001</b></div>
      </div>

      <div className="paper s-hint z0 sway" style={{ '--rot': '0.8deg' }}>
        <span className="staple" style={{ '--cx': '16px' }} />
        <span className="staple" style={{ '--cx': 'calc(100% - 30px)' }} />
        <div className="h">别人进门先说的</div>
        <li><i>“</i>给我的新歌做个歌词视觉页</li>
        <li><i>“</i>把这半年做的整理成一份 deck</li>
        <li><i>“</i>做个收集角色设定的档案站</li>
      </div>

      {/* 线索线：① 到 ⑥ 一条红线，最后把笔递给你 */}
      <svg className="ndw-thread" viewBox="0 0 1500 800" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 208 300 C 226 306, 238 312, 250 320 M 236 314 l 16 7 l -6 -15" />
        <path d="M 448 322 C 462 314, 476 306, 492 300 M 478 302 l 16 -3 l -10 13" />
        <path d="M 588 400 C 540 470, 380 454, 232 466 M 250 458 l -19 9 l 17 11" />
        <path d="M 372 556 C 386 550, 396 546, 408 542 M 394 538 l 15 4 l -11 11" />
        <path d="M 570 550 C 578 542, 586 536, 596 532 M 583 528 l 15 4 l -11 11" />
        <path className="soft" d="M 842 528 C 916 476, 972 448, 1040 424 M 1024 420 l 17 4 l -9 14" />
      </svg>
      <span className="hand" style={{ left: '15.2%', top: '55.4%', fontSize: 17, transform: 'rotate(-5deg)' }}>出图了</span>
      <span className="hand" style={{ left: '62.4%', top: '49.5%', fontSize: 23, transform: 'rotate(-3.5deg)' }}>轮到你了</span>
      <span className="hand p" style={{ left: '4.2%', top: '27.6%', fontSize: 11.5, transform: 'rotate(-2.5deg)' }}>一句话开始 ↓</span>
    </>
  ),
};
