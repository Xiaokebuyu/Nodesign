import imgDeck from '../../../assets/login-wall/tp-deck.webp';
import imgSite from '../../../assets/login-wall/tp-site.webp';
import { wallRun } from '../wall-date.js';

/**
 * 第二套：深入第三极（真实项目，官网案例页有它：藏南藏北三十日路线的旅行手册站）。
 *
 * 它是从一句「帮我做个西藏攻略的 ppt」开始的，演示做完之后用户说改成能一直往下翻的手册站 ——
 * 正好是「先出一版、圈一下改方向」的样子（⑤ 那句红字 ≤10 个字，长了会压到通往⑥的红线）：①一句话 → ②路线写在板上 → ③Agent 在做 →
 * ④第一版演示 → ⑤用户圈一下改 → ⑥手册站上线。
 */
export default {
  id: 'tibet',
  css: `
.sc-tibet .s1 { left: 60px; top: 252px; width: 232px; }
.sc-tibet .s2 { left: 362px; top: 246px; width: 232px; }
.sc-tibet .s3 { left: 660px; top: 238px; width: 310px; }
.sc-tibet .s4 { left: 100px; top: 504px; width: 340px; }
.sc-tibet .s5 { left: 0; top: 0; width: 1500px; height: 800px; pointer-events: none; }
.sc-tibet .s6 { left: 700px; top: 500px; width: 320px; }
`,
  render: () => (
    <>
      <svg className="ndw-thread" viewBox="0 0 1500 800" aria-hidden="true">
        <path d="M294 326 C 318 318 336 310 358 306" />
        <path d="M596 286 C 616 280 636 276 656 274" />
        <path d="M722 448 C 660 500 460 488 330 502" />
        <path d="M668 712 C 684 690 692 672 702 654" />
      </svg>

      <div className="paper s1">
        <div className="sheet sticky note"><i className="pin r" />
          <div className="who">我说</div>
          <p>帮我做个西藏攻略的 ppt，藏南加藏北，要能看出每天走到多高。</p>
          <div className="when">周五 20:40</div>
        </div>
        <span className="no">1</span>
        <div className="cap">一句话开始</div>
      </div>

      <div className="paper s2 chalk">
        <div className="t">路线 · 30 日</div>
        <ol>
          <li><b>01</b>拉萨，先适应海拔</li><li><b>04</b>纳木错</li><li><b>09</b>冈仁波齐</li>
          <li><b>15</b>珠峰大本营</li><li><b>22</b>羌塘无人区</li><li><b>30</b>返程</li>
        </ol>
        <span className="no" style={{ left: -34, top: -4 }}>2</span>
        <div className="cap">先写在板上，你可以直接改</div>
      </div>

      <div className="paper s3">
        <div className="sheet term"><i className="pin" />
          <div className="h">AGENT 在做</div>
          <div className="l"><i>✓</i>web_search <span>路线与海拔</span></div>
          <div className="l"><i>✓</i>generate_image <span>配图 × 12</span></div>
          <div className="l"><i>✓</i>Write <span>third-pole/deck.html</span></div>
          <div className="l"><i>✓</i>screenshot_canvas <span>15 页逐页检查</span></div>
          <div className="run">{wallRun(1, '07')} · 已经跑了 18 分 30 秒</div>
        </div>
        <span className="no">3</span>
        <div className="cap">过程实时显示在画布上</div>
      </div>

      <div className="paper s4">
        <div className="sheet"><i className="pin" />
          <div className="bar"><i className="dot" /><span className="name">深入第三极 · 演示</span><span className="st">15 页</span></div>
          <img className="shot" src={imgDeck} alt="" style={{ aspectRatio: '16/9', objectFit: 'cover' }} />
        </div>
        <span className="no">4</span>
        <div className="cap">先出一版演示</div>
      </div>

      <div className="paper s5">
        <svg className="circle" viewBox="0 0 1500 800" aria-hidden="true">
          <path d="M112 650 C 170 626 330 628 346 656 C 360 682 290 700 214 700 C 150 700 112 690 110 672 C 108 660 120 652 140 648" />
          <path d="M348 690 C 390 702 430 704 468 704" />
        </svg>
        <span className="no" style={{ left: 440, top: 680 }}>5</span>
        <div className="pen-note" style={{ left: 478, top: 694 }}>
          改成往下翻的手册站
          <div className="cap">在画布上圈选，直接修改</div>
        </div>
      </div>

      <div className="paper s6">
        <div className="sheet"><i className="pin r" />
          <div className="bar"><i className="dot" /><span className="name">third-pole</span><span className="st">站点</span></div>
          <img className="shot" src={imgSite} alt="" style={{ aspectRatio: '16/10', objectFit: 'cover' }} />
        </div>
        <span className="stamp" style={{ right: 10, top: 42 }}>已上线</span>
        <span className="no">6</span>
        <div className="cap">演示的内容并进了站点</div>
      </div>
    </>
  ),
};
