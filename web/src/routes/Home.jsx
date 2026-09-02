import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Wrench, LayoutTemplate, MoreHorizontal, Copy, Trash2, Edit2 } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { TOP_ACTION_STYLE as iconBtnStyle } from '../components/layout/TopBar.jsx';
import QuickEntry from './home-quick-entry.jsx';
import { GAP } from '../lib/theme.js';
import { CSS } from './home-styles.js';
import { Underline } from '../components/PaperBits.jsx';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Sessions, Assets, Projects } from '../lib/api.js';
import { timeAgo } from '../lib/helpers.js';
import { useMedia, NARROW } from '../lib/use-media.js';
import { useHoverReveal } from '../lib/use-hover-reveal.js';
import dHand from '../assets/login-wall/doodles/hand.webp';
import LanguageSwitcher from '../components/ui/LanguageSwitcher.jsx';
import { t, getLocale } from '../lib/i18n.js';
import { sheetClassOf } from './home-sheets.js';
import { DayToggle } from './home-light.jsx';
import { Desk } from './desk.jsx';

/**
 * Home 页 —— 进门之后的那面板子（2026-08-03 改版）
 *
 * 跟登录墙同一套物料（lib/paper.js）：楷体、纸、颗粒、一个光向的三档影子、
 * 图钉和长尾夹。**同一块板**（连织纹和旧钉眼都照搬）—— 门外那面墙讲的是别人
 * 做完的一件事，进门之后同一块板上钉的是你自己的东西。
 *
 * 但不套墙那套构图规则：墙是 1500x800 的固定设计稿，内容写死所以能讲一个从①
 * 到⑥的故事；这里是真实数据，条数不定、要滚动、每张卡都能点。同风格不等于同
 * 版式，能共用的是材质，不是坐标。
 *
 * 两块内容：
 *   [便签本]   一句话开工。红边线 + 横线周期跟 line-height 对死，字真写在线上。
 *   [项目卡]   钉在板上的纸，封面是贴上去的印样，钉子在纸外面（纸被拿起来的
 *              时候钉子不动）。最近动过的那张挂「接着做」小签 —— 回访第一动作。
 *
 * 卡片那行元信息以前印的是 skill_id（全站同一个值），换成真读磁盘的产物清单
 * （GET /api/projects/stats）；拿不到就只留时间，不编。
 */

/** 纸的倾角按 id 定死：每次渲染都一样，不会因为 re-render 抖一下 */
function tilt(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `${((h % 220) - 110) / 100}deg`;
}

/** 形态的中文说法沿用产品里已有的叫法：deck 保持英文（用户自己就这么说） */
const KIND_WORD = { deck: ['份', 'deck'], site: ['个', '站点'] };
/** 英文侧：[单数, 复数]。中文的量词在这边没有对应物，对应物是复数变化 */
const KIND_WORD_EN = { deck: ['deck', 'decks'], site: ['site', 'sites'] };

/** 「这个项目里躺着什么」。stats 还没回来时返回 null —— 宁可空着也不填假话 */
function inventory(st) {
  if (!st) return null;
  const parts = Object.entries(st.kinds || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      // 中文靠量词（3 份 deck / 2 个站点），英文靠复数（3 decks / 2 sites）——
      // 这是两套语法不是两个词，所以各走各的表，不进词表（词表的 key 必须是
      // 字面量，这里的短语是拼出来的，lint 验不了）。
      if (getLocale() !== 'zh-CN') {
        const [one, many] = KIND_WORD_EN[k] || [k, `${k}s`];
        return `${n} ${n === 1 ? one : many}`;
      }
      const [unit, word] = KIND_WORD[k] || ['个', k];
      return `${n} ${unit}${word}`;
    });
  // 板书也算"这里躺着什么"：演出项目常常一件产物都没有，整个故事都在板书里，
  // 那种卡以前一律写着"还没出东西"
  if (st.chalk?.count) {
    const n = st.chalk.count;
    parts.push(getLocale() !== 'zh-CN'
      ? `${n} ${n === 1 ? 'note' : 'notes'}`
      : t('板书 {n} 条', { n, count: n }));
  }
  if (parts.length) return parts.join(' · ');
  return st.tasks ? t('{n} 件开了头', { n: st.tasks, count: st.tasks }) : t('还没出东西');
}


export default function Home() {
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const error = useProjectStore(s => s.error);
  const hydrate = useProjectStore(s => s.hydrate);
  // 空状态示例 chip → 预填顶部输入框（不直接发 turn：让用户看到内容、可改可删）
  const [prefill, setPrefill] = useState(null);   // { text, ts }
  // 产物清单：读磁盘，跟列表分开拉；拿不到就是 null，卡片那行留空不编
  const [stats, setStats] = useState(null);
  const [summary, setSummary] = useState(null);   // { published, usedToday }

  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate({ kind: 'project' }).catch(() => { /* error 由 store 记录 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  useEffect(() => {
    let dead = false;
    Projects.stats()
      .then(({ stats: s, summary: sum }) => {
        if (dead) return;
        setStats(s || {});
        setSummary(sum || null);
      })
      .catch(() => { /* 首页不因为一行元信息报错 */ });
    return () => { dead = true; };
  }, []);

  const narrow = useMedia(NARROW);

  return (
    <AppShell
      actions={
        <>
          {/* 窄屏只留图标（2026-08-21）：动作 + 头像 + 字标在 393 的屏上排不下，
              带字的话会被挤成两行。
              2026-08-29 「新建项目」从这里撤走 —— 开工的入口是下面那本便签，
              不是顶栏的按钮。留在这的两个都是"去别处看"，不是"在这开工"。 */}
          <Link to="/gallery" title={t('橱窗')} style={iconBtnStyle}>
            <LayoutTemplate size={14} />{narrow ? null : ` ${t('橱窗')}`}
          </Link>
          <Link to="/skills" title="Skill" style={iconBtnStyle}>
            <Wrench size={14} />{narrow ? null : ' Skill'}
          </Link>
          {/* 光线：跟着时间 / 白天 / 夜晚。窄屏只留图标 —— 它是个一眼能认的
              太阳月亮，不需要字。 */}
          <DayToggle style={iconBtnStyle} compact={narrow} />
          {/* 窄屏不挂：上面那条注释已经说了 393 的屏排不下，语言不是高频动作。
              窄屏用户要换语言走登录墙那个（门外那枚常在）。 */}
          {!narrow && <LanguageSwitcher />}
        </>
      }
    >
      {/* 台面和照在它上面的光都在 <Desk> 里（08-30 搬出去跟橱窗 / Skill 页共用）。
          首页把自己那一整份样式传进去 —— DESK_CSS 已经拼在 CSS 里面，只注入一份。 */}
      <Desk css={CSS}>

          <div className="ndd-top">
            <div className="ndd-side">
              <BoardNote projects={projects} summary={summary} />
            </div>
            <div className="ndd-mid">
              <QuickEntry prefill={prefill} />
            </div>
            <div className="ndd-side r">
              {/* 涂鸦要跟旁边那句话说同一件事。原来挂的是 tangle（「突然通了」）——
                  那画的是想通了**之后**那一刻，而这句话说的正好相反：不用先想清楚。
                  换成 hand（「先给它一句话」）：一只手递出一张写了字的纸，
                  跟这个输入框要的动作是同一个，也跟左边那本便签是同一套物料。 */}
              <img className="doodle" src={dHand} alt="" />
              <p className="aside">{t('想到什么先写下来。')}<br />{t('不用先想清楚，')}<br />{t('它会问你缺的那部分。')}</p>
            </div>
          </div>

          <RecentQuickSection />

          <div className="ndd-head">
            <h2>{t('我的项目')}<Underline w={1.6} color="var(--desk-ink)" /></h2>
            <span className="n">{projects.length} 个项目</span>
          </div>

          {!hydrated && hydrating ? (
            <div className="ndd-quiet">{t('正在打开…')}</div>
          ) : error ? (
            <ErrorState message={error} onRetry={() => hydrate({ kind: 'project' }).catch(() => {})} />
          ) : projects.length === 0 ? (
            <EmptyState
              onPick={(text) => {
                setPrefill({ text, ts: Date.now() });
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          ) : (
            <div className="ndd-grid">
              {projects.map((p, i) => (
                <ProjectCard key={p.id} project={p} stat={stats?.[p.id]} newest={i === 0} />
              ))}
            </div>
          )}
      </Desk>
    </AppShell>
  );
}

// ── BoardNote ── 记在板子上的账（不是纸，是直接写在板面上的字）

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 1~31 的汉字写法。楷体里汉字数字比阿拉伯数字顺眼，跟登录墙上的写法一致 */
function cnNum(n) {
  if (n <= 10) return CN[n];
  if (n < 20) return `十${n % 10 ? CN[n % 10] : ''}`;
  return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}`;
}

/**
 * 「手上 3 件」这类账目行。数字要带样式（`.n`），而中英**词序不同**
 * （「手上 3 件」↔「3 projects in hand」），所以不能拆成"前缀 + 数字 + 后缀"三段写死。
 * 办法是让整句话进词表、留一个 `{n}` 占位符，渲染时按占位符切开，数字塞回中间。
 *
 * 复数走 params.count：英文的 project / projects 靠它选，中文不受影响。
 */
function Counted({ pattern, n }) {
  const [before = '', after = ''] = t(pattern, { count: typeof n === 'number' ? n : undefined }).split('{n}');
  return <span className="l">{before}<span className="n">{n}</span>{after}</span>;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * 板上的账：全是真数，没有一个是摆设。
 * summary 还没回来就只写前两条（本地就能算的），不留空行也不填占位。
 */
function BoardNote({ projects, summary }) {
  const now = new Date();
  const touched = projects.filter((p) => {
    const ts = Date.parse(p.updatedAt);
    return Number.isFinite(ts) && now.getTime() - ts < WEEK_MS;
  }).length;

  // 日期：中文用汉字数字（楷体里比阿拉伯数字顺眼，跟登录墙一致），
  // 英文没有这个传统，走 Intl 的月名 + 日。这是**数字格式**不是字符串，翻不了。
  const dateLabel = getLocale() === 'zh-CN'
    ? `${cnNum(now.getMonth() + 1)}月${cnNum(now.getDate())}日`
    : now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  return (
    <div className="ndd-note">
      <span className="t">{dateLabel}</span>
      <svg className="rule" viewBox="0 0 104 7" preserveAspectRatio="none" aria-hidden="true">
        {/* ⚠️ 走 style 不走 stroke 属性：var() 在 SVG 呈现属性上不保证解析，
            在 CSS 属性里才稳。夜里这支笔要跟着整族翻成粉笔。 */}
        <path d="M1 4 Q 26 2, 52 4.2 T 103 3" fill="none"
          style={{ stroke: 'var(--sketch-rule)' }} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <Counted pattern="手上 {n} 件" n={projects.length} />
      <Counted pattern="这周动过 {n} 件" n={touched} />
      {summary && (
        <>
          <Counted pattern="已上线 {n} 件" n={summary.published} />
          <Counted pattern="今天花了 {n}" n={`$${(summary.usedToday || 0).toFixed(2)}`} />
        </>
      )}
    </div>
  );
}


// ── RecentQuickSection ── 老式闪聊会话（2026-07-28 前建的），没有就整块不出现

function RecentQuickSection() {
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Sessions.recent({ limit: 5, kind: 'quick' })
      .then(({ sessions: list = [] }) => {
        if (!cancelled) {
          setSessions(list);
          setLoaded(true);
        }
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);

  const handleDelete = async (s) => {
    const title = s.customTitle || s.summary || s.firstPrompt || s.projectName || t('未命名对话');
    if (!(await confirm({
      title: t('删除对话'),
      message: t('删除对话「{title}」？此操作不可撤销。', { title }),
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await Sessions.remove(s.projectId, s.sessionId);
      setSessions(prev => prev.filter(x => x.sessionId !== s.sessionId));
      showToast(t('已删除'), 'info');
    } catch (err) {
      showToast(t('删除失败：{err}', { err: err.message }), 'error');
    }
  };

  if (!loaded || sessions.length === 0) return null;

  return (
    <>
      <div className="ndd-head">
        <h2>{t('最近对话')}<Underline w={1.6} color="var(--desk-ink)" /></h2>
      </div>
      <div className="ndd-rows">
        {sessions.map((s, i) => (
          <RecentQuickRow
            key={`${s.projectId}/${s.sessionId}`}
            session={s}
            isFirst={i === 0}
            onDelete={() => handleDelete(s)}
          />
        ))}
      </div>
    </>
  );
}

function RecentQuickRow({ session: s, isFirst, onDelete }) {
  const { revealed, hoverProps } = useHoverReveal();
  const handleDeleteClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    onDelete?.();
  };
  return (
    <div {...hoverProps} style={{ position: 'relative' }}>
      <Link
        to={`/projects/${s.projectId}/sessions/${s.sessionId}`}
        className={isFirst ? '' : 'sep'}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">
            {s.customTitle || s.summary || s.firstPrompt || s.projectName || t('未命名对话')}
          </div>
          <div className="w">
            最后消息 {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}
          </div>
        </div>
        <span style={{ color: 'var(--pencil)', fontSize: 15, width: 26, textAlign: 'right',
          opacity: revealed ? 0 : 1, transition: 'opacity 0.15s' }}>›</span>
      </Link>
      {revealed && (
        <button className="del" onClick={handleDeleteClick} title={t('删除对话')}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

// ── ProjectCard ── 钉在板上的一张纸

function ProjectCard({ project, stat, newest }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 鼠标移开时顺手把菜单关掉（触屏上 hoverProps 是空的，菜单靠点别处关）
  const { revealed, hoverProps } = useHoverReveal({ onLeave: () => setMenuOpen(false) });
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);
  const prompt = useGlobalStore(s => s.prompt);

  const handleRename = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    const next = await prompt({
      title: t('重命名项目'),
      initialValue: project.name,
      placeholder: t('项目名'),
      validate: (v) => v.trim() ? null : t('不能为空'),
    });
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(t('已重命名为「{name}」', { name: next.trim() }), 'success');
    } catch (err) {
      showToast(t('重命名失败：{err}', { err: err.message }), 'error');
    }
  };
  const handleDuplicate = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) showToast(t('已复制为「{name}」', { name: copy.name }), 'success');
    } catch (err) {
      showToast(t('复制失败：{err}', { err: err.message }), 'error');
    }
  };
  const handleDelete = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    if (!(await confirm({
      title: t('删除项目'),
      message: t('删除「{name}」？此操作不可撤销。', { name: project.name }),
      confirmLabel: '删除',
      danger: true,
    }))) return;
    try {
      await deleteProject(project.id);
      showToast(t('项目已删除'), 'info');
    } catch (err) {
      showToast(t('删除失败：{err}', { err: err.message }), 'error');
    }
  };

  const inv = inventory(stat);

  return (
    <div
      // 卡片就是那个项目的那张纸：演出项目是稿纸（米黄 + 红格线），设计是横格本。
      // 跟输入栏读同一份配方，所以桌上摆的和手里写的是同一个世界的纸。
      className={`ndd-card ${sheetClassOf(project.mode)}${newest ? ' top' : ''}`}
      {...hoverProps}
    >
      <Link to={`/projects/${project.id}/work`} style={{ '--rot': tilt(project.id) }}>
        <ThumbnailBox project={project} stat={stat} />
        <div className="t">{project.name}</div>
        <div className="m">
          <span>{inv || ''}</span>
          <span>{timeAgo(project.updatedAt)}</span>
        </div>
      </Link>
      <span className={`pin${newest ? ' r' : ''}`} />
      {newest && <span className="last">{t('接着做')}</span>}

      {revealed && (
        <button
          className="more"
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}

      {menuOpen && (
        <div className="ndd-menu" onMouseDown={e => e.stopPropagation()}>
          <button onClick={handleRename}><Edit2 size={12} /> {t('重命名')}</button>
          <button onClick={handleDuplicate}><Copy size={12} /> {t('复制')}</button>
          <button className="danger" onClick={handleDelete}><Trash2 size={12} /> {t('删除')}</button>
        </div>
      )}
    </div>
  );
}

/**
 * 缩略图：服务端截的封面图（GET /api/projects/:pid/cover）
 *
 * 两版演进（2026-07-30）：
 *   老版 iframe 挂 sessions/<sid>/canvas.html —— 形态注册表落地后产物搬进
 *   tasks/<任务>/，这条路只剩后端占位页，封面于是常年一片灰。
 *   改成 iframe 指向真实产物后又撞第二个坎：sandbox 不给 allow-scripts（一屏
 *   十几张卡不能各跑一遍动画/3D），凡是靠 JS 出画面的产物照样白板。
 *   最终落在服务端截图：脚本在 chromium 里真跑一次，浏览器只收一张 JPEG。
 *
 * 画幅：出图比例由产物形态决定（deck 是画幅本身，site 是 1440×900 首屏），
 * 前端不预设——onLoad 读 naturalWidth/Height 拿真实比例再定容器，加载前用
 * 16:10 占位。204（没产物 / 截图环境不可用）走空白纸。
 */
const DEFAULT_RATIO = 16 / 10;

function ThumbnailBox({ project, stat }) {
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [project.id]);

  if (failed) {
    // 没封面**不等于**这张纸上没东西：板书不是产物，进不了截图管线（见 lib/cover.js
    // 的输入是 artifacts）。演出项目往往一件产物都没有，整个故事都写在板书上 ——
    // 那就别贴印样了，直接把最近一条板书的开头写在这张卡的空白纸上。
    const chalk = stat?.chalk?.text;
    return (
      <div className={`ndd-shot empty${chalk ? ' chalk' : ''}`}
        style={{ aspectRatio: String(DEFAULT_RATIO) }}>
        {chalk ? <p>{chalk}</p> : null}
      </div>
    );
  }

  return (
    <div className="ndd-shot" style={{ aspectRatio: String(ratio) }}>
      <img
        src={Assets.coverUrl(project.id)}
        alt={t('{name} 预览', { name: project.name })}
        loading="lazy"
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          // 空响应（204）在部分浏览器也会触发 load，宽高为 0 → 当没封面
          if (!w || !h) setFailed(true);
          // 比例钳在 [1.6, 2]：竖版封面（word 的 A4 页、9:16 deck）原样放行的话，
          // 一张卡能长到别的卡两倍高 —— 网格整行被它撑开，且 hover 的
          // transform/box-shadow 过渡每帧要重绘的面积翻倍，页面肉眼可见地变卡
          // （2026-08-19 A/B 实测：钳到 1:1 慢帧率回到基线；08-21 用户在生产又报
          // 同病，量得 1:1 卡仍比 16:10 卡高 42%（367 vs 258px）—— 下限提到
          // 默认画幅 1.6，竖版卡和别的卡同高同面积，残余归零）。
          // object-fit: cover + object-position: top 本来就在裁，这里只是把裁的
          // 程度限住 —— 竖版封面显示顶部一条（文档首页开头、deck 首屏上沿）。
          else setRatio(Math.min(2, Math.max(DEFAULT_RATIO, w / h)));
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="ndd-sheet">
      <span className="pin" />
      <div className="h" style={{ color: 'var(--red)' }}>{t('项目没加载出来')}</div>
      <div className="d">{message || t('后端可能没启动。检查 server 是否在 :4001 上跑。')}</div>
      <button className="retry" onClick={onRetry}>{t('再 试')}</button>
    </div>
  );
}

/**
 * 空状态（新号第一眼）：光说「还没有项目」新人不知道这东西能做什么。
 * 给几个可点的示例 prompt —— 点了只预填顶部输入框（可改可删），不直接开跑。
 */
const EMPTY_EXAMPLES = [
  '给我喜欢的歌做一个歌词视觉页',
  '做一个收集我笔下角色设定的档案站',
  '春节活动海报，暖色调',
  '把这半年做的东西整理成一份介绍 deck',
];

function EmptyState({ onPick }) {
  return (
    <div className="ndd-sheet">
      <span className="pin" />
      <div className="h">{t('还没有作品')}</div>
      <div className="d">{t('在上面写一句话就能开工。')}<br />{t('没想好的话，点一个试试：')}</div>
      <div className="chips">
        {EMPTY_EXAMPLES.map((text) => (
          <button key={text} onClick={() => onPick?.(text)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

// 顶栏按钮：顶栏是全站共用的外壳，沿用它自己那套 token，不跟着这一页换纸

