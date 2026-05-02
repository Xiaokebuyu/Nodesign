import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Sparkles, Wrench, MoreHorizontal, Copy, Trash2, Edit2, ArrowUp } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import CreateProjectModal from '../components/project/CreateProjectModal.jsx';
import { COLOR, GAP, FONT_SIZE, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Sessions, Turn, Canvas } from '../lib/api.js';
import { timeAgo } from '../lib/helpers.js';

/**
 * Home 页 — 入口流程重构
 *
 * 两条通道：
 *   1. 闪聊（QuickEntry）— 大输入框 + 一句话进入 Workspace（隐式建 kind=quick 项目 + Turn.send）
 *   2. 标准项目（CreateProjectModal）— 顶栏「+ 新建项目」 → Modal → Hub
 *
 * 三块内容（从上到下）：
 *   [QuickEntry]            ← 闪聊入口
 *   [最近闪聊 list]          ← kind=quick 的项目下的最近 sessions（Sessions.recent）
 *   [我的项目 grid]          ← kind=project 的项目（hydrate({ kind:'project' })）
 *                              卡片封面 = iframe(最新 session canvas.html)
 */
export default function Home() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const hydrated = useProjectStore(s => s.hydrated);
  const hydrating = useProjectStore(s => s.hydrating);
  const error = useProjectStore(s => s.error);
  const hydrate = useProjectStore(s => s.hydrate);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!hydrated && !hydrating) {
      hydrate({ kind: 'project' }).catch(() => { /* error 由 store 记录 */ });
    }
  }, [hydrated, hydrating, hydrate]);

  const openCreate = () => setCreateOpen(true);

  return (
    <AppShell
      actions={
        <>
          <Link to="/skills" style={iconBtnStyle}><Wrench size={14} /> Skill</Link>
          <button style={primaryBtnStyle} onClick={openCreate}>
            <Plus size={14} /> 新建项目
          </button>
        </>
      }
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>

        {/* 闪聊入口 */}
        <section style={{ marginBottom: GAP.xxl }}>
          <QuickEntry />
        </section>

        {/* 最近闪聊（无内容时不显示）*/}
        <RecentQuickSection />

        {/* 我的项目 */}
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.lg }}>
            <h2 style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, fontWeight: 600,
              color: COLOR.text, letterSpacing: '-0.01em', margin: 0,
            }}>我的项目</h2>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub }}>
              {projects.length} 个项目
            </span>
          </div>

          {!hydrated && hydrating ? (
            <LoadingState />
          ) : error ? (
            <ErrorState message={error} onRetry={() => hydrate({ kind: 'project' }).catch(() => {})} />
          ) : projects.length === 0 ? (
            <EmptyState onCreate={openCreate} />
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: GAP.lg,
            }}>
              {projects.map(p => <ProjectCard key={p.id} project={p} />)}
            </div>
          )}
        </section>
      </div>

      <CreateProjectModal
        show={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(proj) => {
          // 强制落 Hub（不再分支）—— 让 Hub 成为持久能力的家
          navigate(`/projects/${proj.id}`);
        }}
      />
    </AppShell>
  );
}

// ── QuickEntry ── Home 顶部大输入框（闪聊入口）

/**
 * 随机问候语池。mount 时挑一条；按时间段（早/午/晚）+ 通用各占一半。
 * 写得轻松点，不要"AI 助手"那种正经话。
 */
const GREETINGS_GENERIC = [
  '今天想做点什么？',
  '嗨，需要个 deck 吗？',
  '说一句，我帮你画出来',
  '灵感来了？敲下来试试',
  '随便聊聊，看能做出什么',
  '把脑子里那张图描述一下',
  '今天的设计任务是？',
];
const GREETINGS_MORNING = ['早，今天先做哪个？', '早上好 ☕ 想做什么？'];
const GREETINGS_AFTERNOON = ['下午想啃哪块？', '午后小憩，做点什么？'];
const GREETINGS_EVENING = ['晚上还有任务？说说看', '深夜灵感最值钱，敲下来'];

function pickGreeting() {
  const h = new Date().getHours();
  let pool = GREETINGS_GENERIC;
  if (h >= 6 && h < 11) pool = pool.concat(GREETINGS_MORNING);
  else if (h >= 13 && h < 18) pool = pool.concat(GREETINGS_AFTERNOON);
  else if (h >= 21 || h < 4) pool = pool.concat(GREETINGS_EVENING);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 输入框 placeholder 例子池——给用户一个具体的起点示例，比"agent 自己判断…"
 * 那种过程描述更直观。mount 时随机挑一条。
 */
const PLACEHOLDER_EXAMPLES = [
  '比如：给团队做一份 Q3 总结 deck',
  '比如：春节活动海报，暖色调',
  '比如：产品发布会主视觉',
  '比如：招聘海报，技术岗',
  '比如：会议邀请函，简洁风',
  '比如：年终复盘 deck，给老板看',
  '想画个什么？说说看',
  '把脑子里的画面写下来…',
];

function pickPlaceholder() {
  return PLACEHOLDER_EXAMPLES[Math.floor(Math.random() * PLACEHOLDER_EXAMPLES.length)];
}

function QuickEntry() {
  const navigate = useNavigate();
  const createProject = useProjectStore(s => s.createProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [greeting] = useState(pickGreeting);  // mount 时挑一次，刷新换一个
  const [placeholder] = useState(pickPlaceholder);
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  }, [text]);

  const submit = async () => {
    const v = text.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    try {
      // 1. 创建闪聊项目（kind=quick）—— 项目名取首句前 30 字
      const projName = v.slice(0, 30) + (v.length > 30 ? '…' : '');
      const proj = await createProject({
        name: projName || '未命名对话',
        kind: 'quick',
      });
      // 2. 触发首跑（agent 后台跑，Workspace WS 看流）
      try {
        await Turn.send({ pid: proj.id, chat: v, attachments: [] });
      } catch (err) {
        showToast(`首跑触发失败：${err.message}（项目已创建，可在工作台重发）`, 'error');
      }
      // 3. 跳 Workspace（无 sid，新会话）。Workspace 接到首跑事件后会 navigate
      //    replace 到 /sessions/<sid>，让 URL 反映真实 sid。
      navigate(`/projects/${proj.id}/work`, { state: { initialMessage: v } });
    } catch (err) {
      showToast(`创建失败：${err.message}`, 'error');
      setSubmitting(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = !text.trim();

  return (
    <div>
      <h1 style={{
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.h1, fontWeight: 600,
        color: COLOR.text, letterSpacing: '-0.01em',
        margin: `0 0 ${GAP.lg}px 0`,
        textAlign: 'center',
      }}>{greeting}</h1>
      <div style={{
      background: '#fff',
      border: `1px solid ${COLOR.borderMd}`,
      borderRadius: 16,
      padding: `${GAP.lg}px ${GAP.lg}px ${GAP.md}px`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      transition: 'border-color 0.15s, box-shadow 0.15s',
    }}>
      <textarea
        ref={ref}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        rows={1}
        disabled={submitting}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          resize: 'none',
          fontFamily: FONT_SANS,
          fontSize: FONT_SIZE.lg,
          lineHeight: 1.55,
          color: COLOR.text,
          padding: `${GAP.sm}px 0 ${GAP.md}px`,
          maxHeight: 280,
          minHeight: 32,
          overflow: 'auto',
          boxSizing: 'border-box',
          opacity: submitting ? 0.5 : 1,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
        <button
          title="附加资料（在工作台内上传）"
          disabled
          style={{
            width: 28, height: 28, borderRadius: 14,
            background: 'transparent',
            border: `1px solid ${COLOR.borderLt}`,
            color: COLOR.sub,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'not-allowed',
            opacity: 0.6,
          }}
        >
          <Plus size={14} />
        </button>
        <span style={{ flex: 1 }} />
        <button
          onClick={submit}
          disabled={empty || submitting}
          title={submitting ? '创建中…' : '发送（Enter）'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
            padding: `${GAP.xs + 1}px ${GAP.md + 2}px`,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
            color: COLOR.btnText,
            background: empty ? COLOR.dim : COLOR.btn,
            border: `1px solid ${empty ? COLOR.dim : COLOR.btn}`,
            borderRadius: 10,
            cursor: empty ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s',
            opacity: submitting ? 0.6 : 1,
          }}
          onMouseEnter={e => { if (!empty && !submitting) e.currentTarget.style.background = COLOR.btnHover; }}
          onMouseLeave={e => { if (!empty && !submitting) e.currentTarget.style.background = COLOR.btn; }}
        >
          {submitting ? '创建中…' : '发送'}
          <ArrowUp size={13} strokeWidth={2.25} />
        </button>
      </div>
    </div>
    </div>
  );
}

// ── RecentQuickSection ── Home 中间一段：最近闪聊 list

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

  const handleDelete = async (s) => {
    const title = s.customTitle || s.summary || s.firstPrompt || s.projectName || '未命名对话';
    if (!window.confirm(`删除对话「${title}」？此操作不可撤销。`)) return;
    try {
      await Sessions.remove(s.projectId, s.sessionId);
      setSessions(prev => prev.filter(x => x.sessionId !== s.sessionId));
      showToast('已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  if (!loaded || sessions.length === 0) return null;

  return (
    <section style={{ marginBottom: GAP.xxl }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.md }}>
        <h2 style={{
          fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600,
          color: COLOR.text2, letterSpacing: '-0.01em', margin: 0,
        }}>最近对话</h2>
        <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
          没归到项目里的临时对话
        </span>
      </div>
      <div style={{
        background: '#fff',
        border: `1px solid ${COLOR.borderLt}`,
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        {sessions.map((s, i) => (
          <RecentQuickRow
            key={`${s.projectId}/${s.sessionId}`}
            session={s}
            isFirst={i === 0}
            onDelete={() => handleDelete(s)}
          />
        ))}
      </div>
    </section>
  );
}

function RecentQuickRow({ session: s, isFirst, onDelete }) {
  const [hover, setHover] = useState(false);
  const handleDeleteClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    onDelete?.();
  };
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: 'relative' }}
    >
      <Link
        to={`/projects/${s.projectId}/sessions/${s.sessionId}`}
        style={{
          display: 'flex', alignItems: 'center', gap: GAP.md,
          padding: `${GAP.md}px ${GAP.lg}px`,
          borderTop: isFirst ? 'none' : `1px solid ${COLOR.borderLt}`,
          textDecoration: 'none',
          background: hover ? 'rgba(0,0,0,0.018)' : 'transparent',
          transition: 'background 0.15s',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
            color: COLOR.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            marginBottom: 2,
          }}>
            {s.customTitle || s.summary || s.firstPrompt || s.projectName || '未命名对话'}
          </div>
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            最后消息 {s.lastModified ? timeAgo(new Date(s.lastModified).toISOString()) : ''}
          </div>
        </div>
        <span style={{
          color: COLOR.dim, fontSize: 12,
          opacity: hover ? 0 : 1,
          transition: 'opacity 0.15s',
          width: 28, textAlign: 'right',
        }}>›</span>
      </Link>
      {hover && (
        <button
          onClick={handleDeleteClick}
          title="删除对话"
          style={{
            position: 'absolute',
            top: '50%', right: GAP.md,
            transform: 'translateY(-50%)',
            width: 26, height: 26, borderRadius: 4,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 2,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = COLOR.error; e.currentTarget.style.borderColor = COLOR.error; }}
          onMouseLeave={e => { e.currentTarget.style.color = COLOR.text2; e.currentTarget.style.borderColor = COLOR.borderMd; }}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

// ── ProjectCard ── 网格卡片（封面 = iframe 最新 canvas.html）

function ProjectCard({ project }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [latestSid, setLatestSid] = useState(null);
  const navigate = useNavigate();
  const updateProject = useProjectStore(s => s.updateProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const duplicateProject = useProjectStore(s => s.duplicateProject);
  const showToast = useGlobalStore(s => s.showToast);

  // mount: 拉最新 session sid 用于 iframe 封面
  useEffect(() => {
    let cancelled = false;
    Sessions.list(project.id, { limit: 1 })
      .then(({ sessions = [] }) => {
        if (!cancelled && sessions.length > 0) setLatestSid(sessions[0].sessionId);
      })
      .catch(() => { /* ignore — 拉不到就用占位 */ });
    return () => { cancelled = true; };
  }, [project.id]);

  const dot = project.status === 'running' ? COLOR.warn : project.status === 'failed' ? COLOR.error : COLOR.success;

  const handleRename = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    const next = window.prompt('重命名为：', project.name);
    if (!next || !next.trim() || next === project.name) return;
    try {
      await updateProject(project.id, { name: next.trim() });
      showToast(`已重命名为「${next.trim()}」`, 'success');
    } catch (err) {
      showToast(`重命名失败：${err.message}`, 'error');
    }
  };
  const handleDuplicate = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    try {
      const copy = await duplicateProject(project.id);
      if (copy) showToast(`已复制为「${copy.name}」`, 'success');
    } catch (err) {
      showToast(`复制失败：${err.message}`, 'error');
    }
  };
  const handleDelete = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setMenuOpen(false);
    if (!window.confirm(`删除「${project.name}」？此操作不可撤销。`)) return;
    try {
      await deleteProject(project.id);
      showToast('项目已删除', 'info');
    } catch (err) {
      showToast(`删除失败：${err.message}`, 'error');
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMenuOpen(false); }}
      style={{ position: 'relative' }}
    >
      <Link to={`/projects/${project.id}`} style={{
        display: 'block',
        padding: GAP.lg,
        background: '#fff',
        border: `1px solid ${COLOR.border}`,
        borderRadius: 12,
        boxShadow: hover ? '0 6px 18px rgba(0,0,0,0.08)' : '0 1px 3px rgba(0,0,0,0.03)',
        borderColor: hover ? COLOR.borderMd : COLOR.border,
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'all 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
      }}>
        {/* Thumbnail：有最新 session 用 iframe 渲染 canvas.html，否则占位 */}
        <ThumbnailBox project={project} latestSid={latestSid} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: GAP.sm }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 500, color: COLOR.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {project.name}
          </div>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, flexShrink: 0, marginLeft: GAP.md }} />
        </div>
        {project.description && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.text2,
            lineHeight: 1.5,
            marginBottom: GAP.sm,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {project.description}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{project.skill}</span>
          <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>{timeAgo(project.updatedAt)}</span>
        </div>
      </Link>

      {/* Hover 时显示 ⋯ */}
      {hover && (
        <button
          onMouseDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(v => !v); }}
          style={{
            position: 'absolute', top: 8, right: 8,
            width: 28, height: 28, borderRadius: 6,
            background: 'rgba(255,255,255,0.95)',
            border: `1px solid ${COLOR.borderMd}`,
            color: COLOR.text2,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
            zIndex: 2,
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}

      {menuOpen && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute', top: 40, right: 8,
            minWidth: 140,
            background: '#fff',
            border: `1px solid ${COLOR.borderMd}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
            padding: 4,
            zIndex: 5,
          }}>
          <MenuItem icon={<Edit2 size={12} />} label="重命名" onClick={handleRename} />
          <MenuItem icon={<Copy size={12} />} label="复制" onClick={handleDuplicate} />
          <MenuItem icon={<Trash2 size={12} />} label="删除" onClick={handleDelete} danger />
        </div>
      )}
    </div>
  );
}

/**
 * 缩略图：iframe 加载最新 session canvas.html
 *
 * 自适应：容器 aspect-ratio 1280:800（与设计稿一致），ResizeObserver 监听
 * 卡片宽度，scale = width / 1280 实时刷新——网格列数变（2/3/4 列响应式）时
 * 缩略图依然等比缩进容器，不会变扁或被裁。
 *
 * - sandbox="allow-same-origin"：禁脚本只渲染静态 DOM（性能 + 安全）
 * - pointerEvents:none：iframe 不截走点击，整张卡片仍是 Link
 * - loading="lazy"：视口外不加载
 */
const DESIGN_W = 1280;
const DESIGN_H = 800;

function ThumbnailBox({ project, latestSid }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(0.22);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const recalc = () => {
      const w = el.offsetWidth;
      if (w > 0) setScale(w / DESIGN_W);
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wrap = {
    width: '100%',
    aspectRatio: `${DESIGN_W} / ${DESIGN_H}`,
    borderRadius: 8,
    marginBottom: GAP.lg,
    overflow: 'hidden',
    background: COLOR.bgCard,
    position: 'relative',
  };

  if (!latestSid) {
    return (
      <div ref={ref} style={{
        ...wrap,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.dim,
      }}>
        {project.summary || '新项目'}
      </div>
    );
  }

  return (
    <div ref={ref} style={wrap}>
      <iframe
        src={Canvas.artifactUrl(project.id, latestSid)}
        sandbox="allow-same-origin"
        loading="lazy"
        title={`${project.name} 预览`}
        style={{
          width: DESIGN_W,
          height: DESIGN_H,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
          background: '#fff',
        }}
      />
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'center', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md + 2}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm,
        color: danger ? COLOR.error : COLOR.text2,
        background: 'transparent',
        borderRadius: 4,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? 'rgba(184,58,42,0.08)' : 'rgba(0,0,0,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon} {label}
    </button>
  );
}

function LoadingState() {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.page}px`,
      textAlign: 'center',
      fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub,
    }}>
      加载项目中…
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div style={{
      padding: `${GAP.page}px ${GAP.page}px`,
      textAlign: 'center',
      background: '#fff',
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: 12,
    }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.h2, color: COLOR.error, marginBottom: GAP.sm }}>
        加载失败
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.sub, marginBottom: GAP.xl }}>
        {message || '后端可能没启动。检查 server 是否在 :4001 上跑。'}
      </div>
      <button onClick={onRetry} style={{
        padding: `${GAP.md}px ${GAP.xxl}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
        color: '#fff', background: COLOR.btn,
        border: `1px solid ${COLOR.btn}`,
        borderRadius: 8,
      }}>
        重试
      </button>
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{
      padding: `${GAP.page * 1.2}px ${GAP.page}px`,
      textAlign: 'center',
      background: '#fff',
      border: `1px dashed ${COLOR.borderMd}`,
      borderRadius: 12,
    }}>
      <Sparkles size={32} color={COLOR.dim} style={{ marginBottom: GAP.md }} />
      <div style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, color: COLOR.text2, marginBottom: GAP.sm }}>
        还没有标准项目
      </div>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub, marginBottom: GAP.lg, lineHeight: 1.6 }}>
        想长期保持设计风格 → 点「+ 新建项目」<br />
        只是临时聊一下 → 用上方的输入框
      </div>
      <button onClick={onCreate} style={{
        padding: `${GAP.md}px ${GAP.xxl}px`,
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
        color: '#fff', background: COLOR.btn,
        border: `1px solid ${COLOR.btn}`,
        borderRadius: 8,
      }}>
        + 新建项目
      </button>
    </div>
  );
}

const iconBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
  padding: `${GAP.sm}px ${GAP.lg}px`,
  borderRadius: 8,
  background: 'transparent',
};

const primaryBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
  color: COLOR.btnText, background: COLOR.btn,
  padding: `${GAP.sm + 1}px ${GAP.xl}px`,
  border: `1px solid ${COLOR.btn}`,
  borderRadius: 8,
};
