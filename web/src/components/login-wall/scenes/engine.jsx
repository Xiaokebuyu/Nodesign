import imgEngine from '../../../assets/login-wall/je-engine.webp';
import imgSite from '../../../assets/login-wall/je-site.webp';
import { wallRun } from '../wall-date.js';

/**
 * 第三套：喷气发动机实验台（真实项目，官网案例页有它：程序化几何的涡扇发动机，能转、能拆、
 * 分站位读压比与温度，React + three.js）。放在这里是为了让门外的人看到：不止网页和演示稿。
 *
 * ①一句话 → ②五个站位写在板上 → ③Agent 在做 → ④能转能拆的 3D → ⑤用户圈一下加标注 → ⑥上线。
 */
export default {
  id: 'engine',
  css: `
.sc-engine .s1 { left: 60px; top: 252px; width: 232px; }
.sc-engine .s2 { left: 362px; top: 246px; width: 232px; }
.sc-engine .s3 { left: 660px; top: 238px; width: 310px; }
.sc-engine .s4 { left: 100px; top: 500px; width: 340px; }
.sc-engine .s5 { left: 0; top: 0; width: 1500px; height: 800px; pointer-events: none; }
.sc-engine .s6 { left: 700px; top: 500px; width: 320px; }
`,
  render: () => (
    <>
      <svg className="ndw-thread" viewBox="0 0 1500 800" aria-hidden="true">
        <path d="M294 326 C 318 318 336 310 358 306" />
        <path d="M596 286 C 616 280 636 276 656 274" />
        <path d="M722 448 C 660 500 460 484 330 498" />
        <path d="M668 712 C 684 690 692 672 702 654" />
      </svg>

      <div className="paper s1">
        <div className="sheet sticky note"><i className="pin r" />
          <div className="who">我说</div>
          <p>做一个能拆开看的涡扇发动机，给机械课用，学生自己转着看。</p>
          <div className="when">周一 09:15</div>
        </div>
        <span className="no">1</span>
        <div className="cap">一句话开始</div>
      </div>

      <div className="paper s2 chalk">
        <div className="t">结构 · 五个站位</div>
        <ol>
          <li><b>01</b>进气与风扇</li><li><b>02</b>压气机</li><li><b>03</b>燃烧室</li>
          <li><b>04</b>涡轮</li><li><b>05</b>尾喷管</li>
        </ol>
        <span className="no" style={{ left: -34, top: -4 }}>2</span>
        <div className="cap">先写在板上，你可以直接改</div>
      </div>

      <div className="paper s3">
        <div className="sheet term"><i className="pin" />
          <div className="h">AGENT 在做</div>
          <div className="l"><i>✓</i>Write <span>engine/scene.js · three.js</span></div>
          <div className="l"><i>✓</i>程序化几何 <span>叶片 × 38</span></div>
          <div className="l"><i>✓</i>screenshot_canvas <span>转 90° 再看一遍</span></div>
          <div className="l"><i>✓</i>trace_motion <span>拆解动画 2.4 秒</span></div>
          <div className="run">{wallRun(0, '15')} · 已经跑了 42 分钟</div>
        </div>
        <span className="no">3</span>
        <div className="cap">过程实时显示在画布上</div>
      </div>

      <div className="paper s4">
        <div className="sheet"><i className="pin" />
          <div className="bar"><i className="dot" /><span className="name">jet-engine-lab</span><span className="st">WebGL</span></div>
          <img className="shot" src={imgEngine} alt="" style={{ aspectRatio: '16/10', objectFit: 'cover' }} />
        </div>
        <span className="no">4</span>
        <div className="cap">能转、能拆的 3D</div>
      </div>

      <div className="paper s5">
        <svg className="circle" viewBox="0 0 1500 800" aria-hidden="true">
          <path d="M150 588 C 210 560 380 566 404 604 C 424 640 344 676 262 676 C 184 676 142 654 140 628 C 138 610 150 598 172 590" />
          <path d="M404 646 C 430 668 452 684 468 694" />
        </svg>
        <span className="no" style={{ left: 440, top: 680 }}>5</span>
        <div className="pen-note" style={{ left: 478, top: 694 }}>
          每一段标上压比和温度
          <div className="cap">在画布上圈选，直接修改</div>
        </div>
      </div>

      <div className="paper s6">
        <div className="sheet"><i className="pin r" />
          <div className="bar"><i className="dot" /><span className="name">喷气发动机实验台</span><span className="st">站点</span></div>
          <img className="shot" src={imgSite} alt="" style={{ aspectRatio: '16/10', objectFit: 'cover' }} />
        </div>
        <span className="stamp" style={{ right: 10, top: 42 }}>已上线</span>
        <span className="no">6</span>
        <div className="cap">课上拿去就能用</div>
      </div>
    </>
  ),
};
