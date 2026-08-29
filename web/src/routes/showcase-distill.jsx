import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_KAI, FONT_MONO, FONT_SANS, alpha } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
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
 */
export default function DistillPanel() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const hydrate = useProjectStore(s => s.hydrate);
  const [hoverId, setHoverId] = useState(null);

  // 直开 /gallery 时 store 是空的（Home 没跑过）；hydrate 自己幂等，重复调无害
  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate({ kind: 'project' }).catch(() => { /* 这一区不因为拉不到列表报错 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  // 右边缘那道渐隐 = 「右边还有」。项目最多的那位有 33 个，一屏只露得出 5 个，
  // 不给这个信号的话另外 28 个等于不存在（截断成的干净直边看着就像列表到头了）。
  // 只在真的还能往右滚时挂：项目少到不需要滚的时候挂一道渐变，看着像渲染坏了。
  const railRef = useRef(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, projects]);

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
      <h2 style={{
        fontFamily: FONT_KAI, fontSize: FONT_SIZE.h2, fontWeight: 700,
        color: COLOR.text, margin: `0 0 ${GAP.sm}px`,
      }}>{t('把做过的东西留成方法')}</h2>

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
        // 横滚而不是截断成「最近 8 个」：项目最多的那位有 33 个，截断了他就得
        // 先回首页找、再回来 —— 而这一区的全部意义就是省掉那一趟。
        <div style={{ position: 'relative' }}>
        <div
          ref={railRef}
          onScroll={measure}
          style={{
            display: 'flex', gap: GAP.md,
            overflowX: 'auto', overflowY: 'hidden',
            paddingBottom: GAP.md,
            scrollbarWidth: 'thin',
          }}
        >
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => start(p)}
              onMouseEnter={() => setHoverId(p.id)}
              onMouseLeave={() => setHoverId(null)}
              title={t('让 agent 回头读一遍「{name}」，把方法整理成 skill', { name: p.name })}
              style={{
                flexShrink: 0, maxWidth: 240,
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: GAP.xs,
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
        {/* ⚠️ pointerEvents:none 不是可选项：铺在滚动区上面的东西默认吃指针，
            少这一行右边那几十像素就点不动了（08-29 稿纸的版心框刚栽过一次）。 */}
        {more && (
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: GAP.md, width: 48,
            background: `linear-gradient(90deg, ${alpha(COLOR.bgCard, 0)} 0%, ${COLOR.bgCard} 85%)`,
            pointerEvents: 'none',
          }} />
        )}
        </div>
      )}
    </section>
  );
}

const quietStyle = {
  padding: `${GAP.lg}px 0`,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
};
