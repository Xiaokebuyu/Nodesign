import imgSite from '../../../assets/login-wall/mr-site.webp';
import imgDeck from '../../../assets/login-wall/mr-deck.webp';
import { wallRun } from '../wall-date.js';

/**
 * 第一套：雾岭咖啡的新品发布（09-12 印刷风改版，跟官网首屏那张画布是同一个项目）。
 *
 * ①一句话 → ②结构写在板上 → ③Agent 在做 → ④站点 → ⑤用户圈一下改 → ⑥演示稿发布。
 * 每一步是一个 .paper（纸 + 编号 + 图注一起钉上去）；⑤没有自己的纸，是画在④上的红笔。
 * 坐标是 1500x800 设计稿里的 px：标题占到 y≈200，登记卡占 x≥1050，这两块地别碰。
 */
export default {
  id: 'coffee',
  css: `
.sc-coffee .s1 { left: 60px; top: 252px; width: 232px; }
.sc-coffee .s2 { left: 362px; top: 246px; width: 232px; }
.sc-coffee .s3 { left: 660px; top: 238px; width: 310px; }
.sc-coffee .s4 { left: 100px; top: 500px; width: 340px; }
.sc-coffee .s5 { left: 0; top: 0; width: 1500px; height: 800px; pointer-events: none; }
.sc-coffee .s6 { left: 700px; top: 500px; width: 320px; }
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
          <p>给雾岭咖啡做一份新品发布：品牌手册、官网，再加一份发布演示。</p>
          <div className="when">周二 22:10</div>
        </div>
        <span className="no">1</span>
        <div className="cap">一句话开始</div>
      </div>

      <div className="paper s2 chalk">
        <div className="t">发布演示 · 8 页结构</div>
        <ol>
          <li><b>01</b>封面</li><li><b>02</b>一座山，三块地</li><li><b>03</b>我们怎么做</li>
          <li><b>04</b>三款豆各一页</li><li><b>07</b>订阅与上市</li><li><b>08</b>冲煮参数</li>
        </ol>
        <span className="no" style={{ left: -34, top: -4 }}>2</span>
        <div className="cap">先写在板上，你可以直接改</div>
      </div>

      <div className="paper s3">
        <div className="sheet term"><i className="pin" />
          <div className="h">AGENT 在做</div>
          <div className="l"><i>✓</i>build_docx <span>品牌手册 · 9 页</span></div>
          <div className="l"><i>✓</i>generate_image <span>包装 × 3</span></div>
          <div className="l"><i>✓</i>Write <span>mistridge-site/index.html</span></div>
          <div className="l"><i>✓</i>screenshot_canvas <span>1440 / 390</span></div>
          <div className="run">{wallRun(0, '11')} · 已经跑了 11 分 04 秒</div>
        </div>
        <span className="no">3</span>
        <div className="cap">过程实时显示在画布上</div>
      </div>

      <div className="paper s4">
        <div className="sheet"><i className="pin" />
          <div className="bar"><i className="dot" /><span className="name">mistridge-site</span><span className="st">站点</span></div>
          <img className="shot" src={imgSite} alt="" style={{ aspectRatio: '16/10', objectFit: 'cover', objectPosition: 'top' }} />
        </div>
        <span className="no">4</span>
        <div className="cap">产物以标准文件交付</div>
      </div>

      <div className="paper s5">
        <svg className="circle" viewBox="0 0 1500 800" aria-hidden="true">
          <path d="M124 566 C 190 540 400 544 424 574 C 440 598 344 618 244 616 C 156 614 118 600 120 580 C 122 568 136 562 158 560" />
          <path d="M426 606 C 444 640 458 664 470 684" />
        </svg>
        <span className="no" style={{ left: 440, top: 676 }}>5</span>
        <div className="pen-note" style={{ left: 478, top: 690 }}>
          这里配上江岸那张包装图
          <div className="cap">在画布上圈选，直接修改</div>
        </div>
      </div>

      <div className="paper s6">
        <div className="sheet"><i className="pin r" />
          <div className="bar"><i className="dot" /><span className="name">mistridge-launch</span><span className="st">8 页 · 16:9</span></div>
          <img className="shot" src={imgDeck} alt="" style={{ aspectRatio: '16/9', objectFit: 'cover' }} />
        </div>
        <span className="stamp" style={{ right: 10, top: 42 }}>已发布</span>
        <span className="no">6</span>
        <div className="cap">周四 01:50 上线</div>
      </div>
    </>
  ),
};
