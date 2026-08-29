/**
 * 场景三「一场角色扮演从设定到开演」（2026-08-17）。
 *
 * 第三条能力线：世界与人设 → 编排 → 演出页 → 开演。动线**又换了一种**：
 * 第一套横着走一排再折左下、第二套走完上排整个甩到左下角，这套是**顺时针绕
 * 一圈** —— 从左上往下、沿底边横过去、再从中间抬上来，最后甩到登记卡。三套
 * 要是都从左上往右下扫，轮播就只是"换了字"。
 *
 * ⑤ 那张演出页是**画出来的不是拍出来的**（跟第一套的线框、第二套的分镜格同类）：
 * 每套至少留一张 CSS 画的，纸上的东西全是照片会腻，而且这三样恰好各自代表产品
 * 的一个中间态 —— 线框、分镜、对话。
 *
 * ⚠️ 选择器不加场景前缀（理由见 deck.jsx 顶上）；左上角标题区和右侧登记卡是
 * 跨场景不变的锚，不能占。
 */
import { Ring, Clip } from '../../PaperBits.jsx';
import artFigure from '../../../assets/login-wall/rp-portrait.webp';
import artStreet from '../../../assets/login-wall/rp-street.webp';
import dAgain from '../../../assets/login-wall/doodles/again.webp';
import dThisOne from '../../../assets/login-wall/doodles/thisone.webp';
import dAlmost from '../../../assets/login-wall/doodles/almost.webp';
import dQuestion from '../../../assets/login-wall/doodles/question.webp';

/** 这套用新出的三个 + 一个老的（「先放着」不绑任何作品，哪面墙都成立） */
const DOODLES = [
  { src: dQuestion, left: '35.5%', top: '4%',   w: 74,  rot: 5 },   // 先放着
  { src: dAlmost,   left: '17.5%', top: '30%',  w: 118, rot: -4 },  // 差一点
  { src: dThisOne,  left: '48.5%', top: '82%',  w: 96,  rot: 3 },   // 就这个
  { src: dAgain,    left: '29.5%', top: '33%',  w: 104, rot: -6 },  // 再来一遍
];

export default {
  id: 'rp',
  css: `
/* ① 一句话 */
.ndw .r1 { left: 3.5%; top: 26%; width: 11.5%; padding: 13px 13px 15px;
  background-color: var(--sticky);
  background-image: linear-gradient(180deg, rgba(43,33,23,0.05) 0 9px, transparent 9px), var(--grain);
  font: 13px var(--kai); line-height: 1.72; color: var(--ink-2);
  box-shadow: -1px 3px 5px rgba(93,74,44,0.16), -3px 8px 14px rgba(93,74,44,0.16); }
.ndw .r1 .who { display: block; margin-bottom: 5px; font: 10px var(--kai); color: var(--pencil); letter-spacing: 0.16em; }

/* ② 人设卡：立绘 + 三行档案，索引卡的蓝线 */
.ndw .r2 { left: 3.5%; top: 45%; width: 13%; padding: 9px 9px 7px; }
.ndw .r2 img { width: 100%; display: block; }
.ndw .r2 .n { padding-top: 7px; font: 700 13px var(--kai); }
.ndw .r2 .f { margin-top: 3px; font: 10.5px var(--kai); line-height: 1.75; color: var(--ink-2);
  border-top: 1px solid rgba(74,107,143,0.28); padding-top: 4px; }
.ndw .r2 .f span { color: var(--pencil); margin-right: 5px; }

/* ③ 编排：方格纸上的三区。**触发住在最下面**，这是结构性的，不是排版偏好 */
.ndw .r3 { left: 20%; top: 60%; width: 15%; padding: 12px 12px 11px;
  background-image: var(--grain),
    repeating-linear-gradient(0deg, rgba(74,107,143,0.11) 0 1px, transparent 1px 13px),
    repeating-linear-gradient(90deg, rgba(74,107,143,0.11) 0 1px, transparent 1px 13px); }
.ndw .r3 .band { border: 1.3px solid var(--ink-2); opacity: 0.85; padding: 4px 7px;
  font: 10.5px var(--kai); color: var(--ink-2); display: flex; justify-content: space-between;
  align-items: baseline; }
.ndw .r3 .band + .band { margin-top: 5px; }
.ndw .r3 .band b { font: 8.5px var(--code); font-weight: 400; color: var(--pencil); }
.ndw .r3 .band.hot { border-color: var(--red); color: var(--red); }
.ndw .r3 .cap { margin-top: 9px; font: 11.5px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .r3 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ④ 它自己动手 */
.ndw .r4 { left: 38%; top: 57%; width: 15.5%; padding: 11px 13px 12px; border-radius: 3px;
  background: linear-gradient(180deg, #2b2318, #241d14);
  box-shadow: 0 4px 11px rgba(43,33,23,0.34), 0 1px 2px rgba(43,33,23,0.2);
  font: 10px var(--code); color: #E4DCC8; line-height: 2.05; }
.ndw .r4 .t { font: 600 9px var(--code); letter-spacing: 0.16em; color: #9b917c;
  border-bottom: 1px solid rgba(228,220,200,0.16); padding-bottom: 6px; margin-bottom: 7px; }
.ndw .r4 .ok { color: #9DBF9A; }
.ndw .r4 .dim { color: #8A8069; }
.ndw .r4 .tail { margin-top: 7px; font-size: 9px; color: #8A8069; }
.ndw .r4 .cur { display: inline-block; width: 6px; height: 11px; background: #E4DCC8;
  vertical-align: -1px; opacity: 0.75; }

/* ⑤ 演出页第一次开口：纸上印出来的一页，不是照片 */
.ndw .r5 { left: 40%; top: 21.5%; width: 17%; padding: 10px 11px 11px; }
.ndw .r5 .bar { display: flex; align-items: center; gap: 5px; padding-bottom: 7px;
  border-bottom: 1px solid rgba(43,33,23,0.13); }
.ndw .r5 .bar i { width: 6px; height: 6px; border-radius: 50%; background: rgba(43,33,23,0.22); }
.ndw .r5 .bar span { margin-left: auto; font: 9px var(--code); color: var(--pencil); }
.ndw .r5 .line { margin-top: 8px; display: flex; gap: 7px; }
.ndw .r5 .line em { flex-shrink: 0; font-style: normal; font: 10px var(--kai);
  color: var(--pencil); letter-spacing: 0.1em; padding-top: 1px; }
.ndw .r5 .line p { font: 12px var(--kai); line-height: 1.65; color: var(--ink-2); }
.ndw .r5 .line.me p { color: rgba(60,50,38,0.72); }
.ndw .r5 .box { margin-top: 10px; padding: 5px 8px; border: 1px solid rgba(43,33,23,0.16);
  border-radius: 2px; font: 11px var(--kai); color: var(--pencil); display: flex; }
.ndw .r5 .box i { display: inline-block; width: 1.5px; height: 12px; background: var(--ink-2);
  margin-left: 2px; opacity: 0.6; }
.ndw .r5 .cap { padding-top: 8px; font: 12px var(--kai); color: var(--ink-2);
  display: flex; justify-content: space-between; align-items: baseline; }
.ndw .r5 .cap b { font: 9.5px var(--code); color: var(--pencil); font-weight: 400; }

/* ⑥ 开演 */
.ndw .r6 { left: 54%; top: 62%; width: 14%; padding: 13px 15px 14px 22px;
  background-color: var(--kraft); background-image: var(--grain); }
.ndw .r6 .tab { position: absolute; top: -13px; left: 16px; background: var(--kraft); padding: 2px 13px;
  font: 11.5px var(--kai); color: var(--ink-2); border-radius: 4px 4px 0 0; }
.ndw .r6 .t { font: 700 14.5px var(--kai); padding-right: 74px; }
.ndw .r6 .d { margin-top: 3px; font: 11.5px var(--kai); line-height: 1.65; color: var(--ink-2); }
.ndw .r6 .r { margin-top: 9px; padding-top: 7px; border-top: 1px solid rgba(95,81,66,0.3);
  font: 9.5px var(--kai); letter-spacing: 0.06em; color: rgba(95,81,66,0.8);
  display: flex; justify-content: space-between; }
.ndw .r6 .live { position: absolute; right: 13px; top: 14px; padding: 3px 9px; border: 1.5px solid var(--red);
  border-radius: 2px; font: 11px var(--kai); color: var(--red); letter-spacing: 0.16em;
  text-indent: 0.16em; transform: rotate(-4deg); opacity: 0.82; }

/* ── 侧料 ── */

/* 世界的样子：一张街景，钉在右下 */
.ndw .p-street { left: 70.5%; top: 70%; width: 13.5%; padding: 8px 8px 6px; }
.ndw .p-street img { width: 100%; display: block; }
.ndw .p-street .cap { padding-top: 5px; font: 10.5px var(--kai); color: var(--pencil); text-align: center; }

/* 这周做完的 */
.ndw .p-legal { left: 56%; top: 4%; width: 12.5%; padding: 15px 14px 16px;
  background-color: var(--legal);
  background-image: var(--grain), repeating-linear-gradient(0deg, transparent 0 25px, rgba(168,54,43,0.15) 25px 26px);
  clip-path: polygon(0 5px, 4% 0, 8% 5px, 12% 0, 16% 5px, 20% 0, 24% 5px, 28% 0, 32% 5px, 36% 0, 40% 5px, 44% 0, 48% 5px, 52% 0, 56% 5px, 60% 0, 64% 5px, 68% 0, 72% 5px, 76% 0, 80% 5px, 84% 0, 88% 5px, 92% 0, 96% 5px, 100% 0, 100% 100%, 0 100%); }
.ndw .p-legal .h { font: 700 14px var(--kai); margin-bottom: 6px; }
.ndw .p-legal li { list-style: none; font: 13px var(--kai); line-height: 25px; color: var(--ink-2); }
.ndw .p-legal li i { font-style: normal; color: var(--red); margin-right: 5px; }

/* 一句台词：描图纸压一版 */
.ndw .p-line { left: 86%; top: 72%; width: 11%; padding: 12px 12px 14px;
  background-color: rgba(243,241,230,0.72); background-image: var(--grain);
  box-shadow: 0 2px 6px rgba(93,74,44,0.14);
  font: 11.5px var(--kai); line-height: 1.68; color: rgba(60,50,38,0.78); }

/* 用量小票 */
.ndw .p-receipt { left: 30%; top: 84%; width: 5.4%; padding: 10px 9px 14px;
  font: 8.5px var(--code); color: var(--ink-2); line-height: 2; letter-spacing: 0.03em;
  clip-path: polygon(0 0, 100% 0, 100% 96%, 90% 100%, 80% 96%, 70% 100%, 60% 96%, 50% 100%, 40% 96%, 30% 100%, 20% 96%, 10% 100%, 0 100%); }
.ndw .p-receipt .h { font: 700 8.5px var(--kai); color: var(--ink);
  border-bottom: 1px dashed var(--hair); padding-bottom: 3px; margin-bottom: 4px; }

/* 下一场 */
.ndw .p-next { right: 4.5%; top: 2.4%; width: 19.5%; padding: 13px 14px 14px;
  background-image: var(--grain),
    repeating-linear-gradient(180deg, transparent 0 25px, rgba(74,107,143,0.13) 25px 26px); }
.ndw .p-next .h { font: 700 13px var(--kai); border-bottom: 1.5px solid rgba(168,54,43,0.35); padding-bottom: 5px; }
.ndw .p-next .b { margin-top: 7px; font: 12.5px var(--kai); line-height: 1.8; color: var(--ink-2); }
`,
  render: () => (
    <>
      <div className="wall blk" style={{ left: '41%', top: '2%', transform: 'rotate(-0.7deg)' }}>
        <span className="t">八月第三周</span>
        <svg className="rule" viewBox="0 0 104 7" preserveAspectRatio="none" aria-hidden="true">
          <path d="M1 4 Q 26 2, 52 4.2 T 103 3" fill="none"
            stroke="rgba(122,111,92,0.55)" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        在做 <span className="n">时停之城</span><br />
        写了 <span className="n">4 个角色</span><br />
        这一场花了 <span className="n">$0.31</span>
      </div>
      <span className="wall lbl" style={{ left: '55.9%', top: '0.6%', fontSize: 16, transform: 'rotate(-1.3deg)' }}>墙上别的</span>
      <div className="wall lbl" style={{ left: '19.5%', top: '87%', fontSize: 11, lineHeight: 2, transform: 'rotate(-1deg)' }}>
        ① 到 ⑥ 绕一圈<br />周日下午一次做完
      </div>

      {DOODLES.map((d, i) => (
        <img key={i} className="doodle" src={d.src} alt=""
          style={{ left: d.left, top: d.top, width: d.w, transform: `rotate(${d.rot}deg)` }} />
      ))}

      {/* ① 一句话 */}
      <div className="paper r1 z2 sway" style={{ '--rot': '-2.2deg' }}>
        <span className="no"><Ring />①</span>
        <span className="pin r" />
        <span className="who">我说</span>我想跟一个住在停住了的城市里的人说话
        <span className="when">周日 13:05</span>
      </div>

      {/* ② 人设卡 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '4%', top: '46%', width: '12.7%', height: 232, '--rot': '2.6deg' }} />
      <div className="paper r2 z2 dog sway" style={{ '--rot': '1.4deg' }}>
        <span className="no"><Ring />②</span>
        <Clip cx="26%" />
        <img src={artFigure} alt="站内做出来的角色立绘" />
        <div className="n">修表铺的女儿</div>
        <div className="f"><span>怕</span>钟停了没人发现</div>
        <div className="f"><span>藏</span>父亲留下的那块表</div>
      </div>

      {/* ③ 编排 */}
      <div className="paper r3 z0 crease sway" style={{ '--rot': '-1.1deg' }}>
        <span className="no"><Ring />③</span>
        <span className="pin" />
        <div className="band"><span>世界与她是谁</span><b>常驻</b></div>
        <div className="band"><span>发生过什么</span><b>滚动</b></div>
        <div className="band hot"><span>这一句怎么接</span><b>只在末尾</b></div>
        <div className="cap"><span>它把上下文排好了</span><b>FIG. 05</b></div>
        <span className="bow" />
      </div>

      {/* ④ 它自己动手 */}
      <div className="paper r4 sway" style={{ '--rot': '0.9deg' }}>
        <span className="no"><Ring />④</span>
        <span className="pin" />
        <div className="t">它自己动手</div>
        <span className="ok">✓</span> write_file <span className="dim">编排.yaml</span><br />
        <span className="ok">✓</span> write_page <span className="dim">演出页</span><br />
        <span className="ok">✓</span> 隐私闸 <span className="dim">台词不回设计会话</span><br />
        <span className="dim">&gt;</span> 试演一句 <span className="cur" />
        <div className="tail">已经跑了 6 分 12 秒</div>
      </div>

      {/* ⑤ 演出页第一次开口 */}
      <div className="paper r5 z2 sway" style={{ '--rot': '1.8deg' }}>
        <span className="no"><Ring />⑤</span>
        <span className="pin" />
        <div className="bar"><i /><span>演出页</span></div>
        <div className="line"><em>她</em><p>钟停在三点十七分。你是第一个走进来还看表的人。</p></div>
        <div className="line me"><em>我</em><p>外面也停了吗</p></div>
        <div className="box">说点什么<i /></div>
        <div className="cap"><span>第一次开口 · 13:24</span><b>index.html</b></div>
        <span className="bow" />
      </div>

      {/* ⑥ 开演 */}
      <div className="paper pstack" aria-hidden="true"
        style={{ left: '54.4%', top: '62.7%', width: '13.7%', height: 100, '--rot': '-2deg' }} />
      <div className="paper r6 wrinkle sway" style={{ '--rot': '1.2deg' }}>
        <span className="no"><Ring />⑥</span>
        <span className="tab">项目 · 卷宗</span>
        <span className="holes" />
        <div className="t">时停之城</div>
        <div className="d">4 个角色，一扇门进去就能演</div>
        <div className="r"><span>FIG. 06</span><span>周日 15:40</span></div>
        <span className="live">已开演</span>
        <span className="bow" />
      </div>

      {/* 侧料 */}
      <div className="paper p-street z0 dog sway" style={{ '--rot': '-1.7deg' }}>
        <span className="pin" />
        <img src={artStreet} alt="站内做出来的世界样张" />
        <div className="cap">城里什么都停着</div>
      </div>

      <div className="paper pstack" aria-hidden="true"
        style={{ left: '56.4%', top: '4.7%', width: '12.2%', height: 146, '--rot': '-1.8deg' }} />
      <div className="paper p-legal z0 sway" style={{ '--rot': '1.1deg' }}>
        <span className="staple" style={{ '--cx': '18px' }} />
        <span className="staple" style={{ '--cx': 'calc(100% - 32px)' }} />
        <div className="h">这周做完的</div>
        <li><i>✓</i>时停之城</li>
        <li><i>✓</i>夜班者竖屏版</li>
        <li><i>✓</i>好巧</li>
        <li>再写两个角色</li>
        <span className="bow" />
      </div>

      <div className="paper p-line z2 sway" style={{ '--rot': '2.3deg' }}>
        <Clip cx="32%" />
        「你也停下来了」<br />这句留着，第二幕用
      </div>

      <div className="paper p-receipt sway" style={{ '--rot': '-2.4deg' }}>
        <span className="pin" />
        <div className="h">用量小票</div>
        RUN 0817-06<br />19 轮台词<br />$0.31<br />* * *
      </div>

      <div className="paper p-next z0 dog sway" style={{ '--rot': '-0.8deg' }}>
        <span className="pin" />
        <div className="h">下一场</div>
        <div className="b">让修表铺那扇门通到别的城。同一个人，走出去会变成谁。</div>
      </div>

      {/* 线索线：顺时针绕一圈 —— 左上往下、沿底边横过去、从中间抬上来、甩向登记卡 */}
      <svg className="ndw-thread" viewBox="0 0 1500 800" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 116 316 C 118 328, 120 340, 122 352 M 114 340 l 8 16 l 10 -14" />
        <path d="M 254 546 C 268 552, 282 558, 296 564 M 282 566 l 15 1 l -8 -13" />
        <path d="M 530 540 C 546 534, 558 530, 570 526 M 556 522 l 15 4 l -11 11" />
        <path d="M 640 452 C 638 414, 636 382, 634 350 M 626 368 l 8 -18 l 10 17" />
        <path d="M 862 320 C 880 372, 872 428, 850 486 M 856 468 l -6 20 l -14 -13" />
        <path className="soft" d="M 1022 542 C 1040 512, 1050 490, 1056 470 M 1044 476 l 13 -10 l 3 17" />
      </svg>
      <span className="hand" style={{ left: '4.8%', top: '41.5%', fontSize: 16, transform: 'rotate(-4deg)' }}>先画她</span>
      <span className="hand" style={{ left: '61%', top: '48%', fontSize: 23, transform: 'rotate(-3deg)' }}>轮到你了</span>
      <span className="hand p" style={{ left: '4%', top: '22.6%', fontSize: 11.5, transform: 'rotate(-2.5deg)' }}>一句话开始 ↓</span>
    </>
  ),
};
