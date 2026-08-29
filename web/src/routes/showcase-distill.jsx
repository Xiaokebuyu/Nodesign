import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_KAI, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useMedia, NARROW } from '../lib/use-media.js';
import { timeAgo } from '../lib/helpers.js';
import { t } from '../lib/i18n.js';
import { MODE_LABEL } from './home-sheets.js';
import { distillPrompt } from './showcase-distill-prompt.js';

/**
 * 橱窗页上的「回头提炼」区（2026-08-29）
 *
 * 这一页 15 天被打开 62 次，全站只有 2 条数据 —— 缺的从来不是入口的显眼程度，
 * 是那个环闭不上：产生一条橱窗数据的动作发生在**会话里**（跟 agent 说一句
 * 「把这套风格留下来」），而说明这件事的字写在**橱窗页**上。看到字的人不在
 * 会话里，在会话里的人看不到字。
 *
 * 所以这个区做两件事，缺一不可：
 *   ① 把「这东西是怎么来的」写在人真的会看到的地方（不只在空状态里写）
 *   ② 给一条现在就能走的路：点一个做过的项目 → 在那个项目里起新会话，
 *      第一句话已经替他写好（showcase-distill-prompt.js）
 *
 * ②走的是 QuickEntry 同一套物理：navigate 到 /work 并在 location.state 里捎
 * initialMessage，ProjectWorkspace 那个 useEffect 单点负责发首条 turn。没有新链路。
 * 落 /work（不带 sid）= 起新会话，这正是要的：提炼不该污染原来那场，而且
 * crystallize_skill 写出来的 skill 本来也只在新会话里生效。
 *
 * ## 版面：一页 3 行 × N 列，左右翻
 *
 * 第一版是一行横滚，右边缘挂渐隐提示「还有」。真机上不成立：33 个项目一屏
 * 只露 5 个，剩下 28 个要一路推着走，而且推到哪儿了没有任何刻度。换成分页
 * 网格 —— 一屏就把一页看完，翻页是**离散**动作，知道自己在第几页。
 *
 * 翻页用 scroll-snap 而不是 transform 动画：触屏滑动、键盘、滚轮横推全都免费
 * 跟着走，桌面再补一对箭头。自己写 transform 就得把这些一个个重新实现一遍。
 */

/** 3 行是定的（用户拍的板），列数按版面宽度让：手机 2 列，平板 3 列，桌面 5 列 */
const ROWS = 3;
const MID = '(max-width: 1024px)';

export default function DistillPanel() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const hydrate = useProjectStore(s => s.hydrate);
  const [hoverId, setHoverId] = useState(null);

  const narrow = useMedia(NARROW);
  const mid = useMedia(MID);
  const cols = narrow ? 2 : mid ? 3 : 5;
  const perPage = cols * ROWS;

  // 直开 /gallery 时 store 是空的（Home 没跑过）；hydrate 自己幂等，重复调无害
  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate({ kind: 'project' }).catch(() => { /* 这一区不因为拉不到列表报错 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  const pages = [];
  for (let i = 0; i < projects.length; i += perPage) pages.push(projects.slice(i, i + perPage));

  const railRef = useRef(null);
  const [page, setPage] = useState(0);

  // 当前第几页从 scrollLeft 反算，不自己记账 —— 触屏滑动、滚轮横推、键盘都能
  // 改变滚动位置，记账的那份状态迟早跟真实位置对不上。
  const onScroll = useCallback(() => {
    const el = railRef.current;
    if (!el || !el.clientWidth) return;
    setPage(Math.round(el.scrollLeft / el.clientWidth));
  }, []);

  // 列数变了（转屏 / 拖窗）页数跟着变，停在越界的那页就是一片空白
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const last = Math.max(0, pages.length - 1);
    if (page > last) {
      el.scrollLeft = last * el.clientWidth;
      setPage(last);
    } else {
      // 列数变化后同一页的像素位置也变了，重新对齐到页边界
      el.scrollLeft = page * el.clientWidth;
    }
  }, [cols, pages.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const go = (dir) => {
    const el = railRef.current;
    if (!el) return;
    const next = Math.min(Math.max(page + dir, 0), pages.length - 1);
    el.scrollTo({ left: next * el.clientWidth, behavior: 'smooth' });
    setPage(next);
  };

  const start = (project) => {
    navigate(`/projects/${project.id}/work`, {
      state: { initialMessage: distillPrompt(project.mode) },
    });
  };

  return (
    <section style={{
      marginBottom: GAP.page,
      padding: `${GAP.xl}px ${GAP.xl}px ${GAP.lg}px`,
      background: COLOR.bgCard,
      border: `1px solid ${COLOR.border}`,
      borderRadius: RADIUS.xxl,
    }}>
      {/* 翻页控件在宽屏跟标题同行（不占额外高度）；窄屏挪到网格下面 ——
          393 上它会把标题挤成「把做过的东西留成方 / 法」两行，而且手机翻页
          主要靠滑，箭头是补充，放下面反而是拇指够得着的位置。 */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: GAP.lg, marginBottom: GAP.sm,
      }}>
        <h2 style={{
          fontFamily: FONT_KAI, fontSize: FONT_SIZE.h2, fontWeight: 700,
          color: COLOR.text, margin: 0,
        }}>{t('把做过的东西留成方法')}</h2>

        {!narrow && pages.length > 1 && (
          <Pager page={page} total={pages.length} onGo={go} />
        )}
      </div>

      <p style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
        lineHeight: 1.7, margin: `0 0 ${GAP.lg}px`, maxWidth: 680,
      }}>
        {t('做完一件满意的东西，随时可以在那个项目里说一句「把这套风格留下来」。')}
        <br />
        {t('也可以现在就挑一个做过的项目，让它回头读一遍，把里面的取值和判断整理成一个 skill：')}
      </p>

      {!hydrated && hydrating ? (
        <div style={quietStyle}>{t('正在打开…')}</div>
      ) : projects.length === 0 ? (
        <div style={quietStyle}>
          {t('还没有做过的项目。')}{' '}
          <Link to="/" style={{ color: COLOR.text2, textDecoration: 'underline' }}>
            {t('先去做一件')}
          </Link>
        </div>
      ) : (
        <div
          ref={railRef}
          onScroll={onScroll}
          style={{
            display: 'flex',
            overflowX: 'auto', overflowY: 'hidden',
            scrollSnapType: 'x mandatory',
            // 滚动条藏掉：这里的刻度是右上角那个「2 / 3」，再来一条横条是两套刻度
            scrollbarWidth: 'none',
          }}
        >
          {pages.map((items, i) => (
            <div
              key={i}
              style={{
                flex: '0 0 100%',
                scrollSnapAlign: 'start',
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                // 显式 3 行：最后一页不满时行位仍在，翻过去容器高度不会往上跳
                gridTemplateRows: `repeat(${ROWS}, minmax(52px, auto))`,
                gap: GAP.md,
                alignContent: 'start',
              }}
            >
              {items.map(p => (
                <button
                  key={p.id}
                  onClick={() => start(p)}
                  onMouseEnter={() => setHoverId(p.id)}
                  onMouseLeave={() => setHoverId(null)}
                  title={t('让 agent 回头读一遍「{name}」，把方法整理成 skill', { name: p.name })}
                  style={{
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'flex-start', justifyContent: 'center', gap: GAP.xs,
                    minWidth: 0,
                    padding: `${GAP.md}px ${GAP.lg}px`,
                    background: COLOR.bgWhite,
                    border: `1px solid ${hoverId === p.id ? COLOR.borderHv : COLOR.border}`,
                    borderRadius: RADIUS.lg,
                    cursor: 'pointer', textAlign: 'left',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <span style={{
                    fontFamily: FONT_MONO, fontSize: FONT_SIZE.base, color: COLOR.text,
                    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{p.name}</span>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: GAP.sm,
                    fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                  }}>
                    {t(MODE_LABEL[p.mode] || MODE_LABEL.design)}
                    <span>{timeAgo(p.updatedAt)}</span>
                    <ArrowRight size={11} style={{ opacity: hoverId === p.id ? 1 : 0, transition: 'opacity 0.15s' }} />
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {narrow && pages.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: GAP.md }}>
          <Pager page={page} total={pages.length} onGo={go} />
        </div>
      )}
    </section>
  );
}

function Pager({ page, total, onGo }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, flexShrink: 0 }}>
      <PageBtn dir={-1} disabled={page === 0} onClick={() => onGo(-1)} />
      <span style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
        minWidth: 34, textAlign: 'center',
      }}>{page + 1} / {total}</span>
      <PageBtn dir={1} disabled={page >= total - 1} onClick={() => onGo(1)} />
    </div>
  );
}

function PageBtn({ dir, disabled, onClick }) {
  const Icon = dir < 0 ? ChevronLeft : ChevronRight;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={dir < 0 ? t('上一页') : t('下一页')}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26,
        background: 'transparent',
        border: `1px solid ${disabled ? COLOR.borderLt : COLOR.border}`,
        borderRadius: RADIUS.lg,
        color: disabled ? COLOR.dim : COLOR.text4,
        cursor: disabled ? 'default' : 'pointer',
      }}
    ><Icon size={14} /></button>
  );
}

const quietStyle = {
  padding: `${GAP.lg}px 0`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
};
