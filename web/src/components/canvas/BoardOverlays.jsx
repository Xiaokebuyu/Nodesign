/**
 * BoardOverlays —— 画布阅读器与浮层族（2026-08-14 可维护性行动 B5，从
 * BoardCanvas 原样抽出）。
 *
 * 三张浮层 + 进阅读器的路由表：
 *   makeBoardReaders       形态表 reader → 三种阅读器（memory / file / note）
 *   ProjectPanelOverlay    项目区四张卡（记忆 / 指引 / 品牌 / 文件）
 *   MarkdownViewerOverlay  markdown 阅读（便签全文 / 记忆 / 品牌）+ 任务贴就地编辑
 *   ImageDetailOverlay     图片详情（原图 / PROMPT 元数据 / 加入上下文）
 *
 * 浮层开关的 state（viewer / detail / projectPanel）留在 BoardCanvas —— ESC
 * 处理和打开入口（双击 / 卡片按钮 / 菜单）都在那边。这里只管"开着的时候长什么样"。
 *
 * 编辑草稿（原 viewerEdit）下沉成 MarkdownViewerOverlay 的本地 state：浮层
 * 关闭即卸载即弃稿。原实现草稿挂在 BoardCanvas 上，ESC 关闭那条路不清它 ——
 * 下次打开任意便签会直接跳进带陈稿的编辑态（潜伏边，抽出时一并收掉）。
 */
import { useState } from 'react';
import MarkdownMath from '../ui/MarkdownMath.jsx';
import JsonInk from './cards/JsonInk.jsx';
import { Plus, ExternalLink, X, BookOpen, PencilLine } from 'lucide-react';
import { Assets, Instruction } from '../../lib/api.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_MONO, FONT_SANS, CANVAS, MODAL } from '../../lib/theme.js';
import { POP_IN } from '../../lib/board-geometry.js';
import { readerOf } from '../../lib/board-kinds.js';
import InstructionsCard from '../project/InstructionsCard.jsx';
import FilesCard from '../project/FilesCard.jsx';

/**
 * 进阅读器。走哪条路由由形态表的 `reader` 决定（board-kinds.js），
 * 这里只实现三种阅读器本身。返回 openViewer 给调用方挂双击 / 按钮。
 */
/**
 * 板书标题里的署名。`by` 有三类：'user'（用户自己）、'agent'（主控）、
 * 常驻角色的 slug（`rp-*`）。roleNames 是派生的展示名表（跟 /board 一起来的），
 * 查不到就退回 slug —— 宁可显示 rp-moli，也不要把角色写的字说成 agent 写的。
 */
function chalkAuthor(by, roleNames) {
  if (by === 'user') return '你写的';
  if (!by || by === 'agent') return 'agent 写的';
  return `${roleNames?.[by] || by} 写的`;
}

export function makeBoardReaders({ projectId, setViewer, roleNames = {} }) {
  const READERS = {
    // 普通 .md 产物（世界.md / 正文章节 / agent 写的任何 markdown）。
    // 2026-08-03 之前这类文件只有「打开」= window.open 原始 URL，浏览器给一坨
    // 纯文本 —— 41KB 的正文点开满屏 `**` 和 `##`。阅读器本来就是现成的，
    // 缺的只是这条路由。frontmatter 不剥：便签的 `---` 头是会话元数据该藏，
    // 普通 md 的 frontmatter 是内容的一部分，替用户删掉是自作主张。
    async file(o) {
      const title = o.name || o.title || 'markdown';
      // 可编辑的两类（08-24 记忆体系改版）：记忆/*.md（服务端保 frontmatter，
      // MEMORY.md 是索引不给编）和根 CLAUDE.md（项目档案，走 Instruction API）。
      // editKind 是保存分支的判据 —— 别再让"能不能编辑"寄生在"是不是便签"上。
      const p = String(o.path || '');
      const editKind = (p.startsWith('记忆/') && !p.includes('/', 3) && o.name !== 'MEMORY.md') ? 'memory'
        : (p === 'CLAUDE.md') ? 'instruction' : null;
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        const raw = await res.text();
        if (editKind === 'memory') {
          // frontmatter（SDK 的 name/description/metadata 头）藏起来只给正文；
          // 保存时服务端以磁盘上的头为准（memory-notes PUT 的保头逻辑）
          const head = /^---\n[\s\S]{0,1200}?\n---\n?/.exec(raw)?.[0] || '';
          setViewer({ title, content: raw.slice(head.length), head, editKind, editName: o.name });
        } else {
          setViewer({ title, content: raw, editKind, editName: o.name });
        }
      } catch {
        setViewer({ title, content: o.preview || '(读不出来)' });
      }
    },

    /**
     * json 显示器（2026-08-29 占位契约刀 B，站主点名「给 json 一个预览器和显示器」）。
     * 卡面预览走服务端裁剪过的结构（lib/json-preview.js），这里是**完整**内容 ——
     * 所以不裁，原样交给 JsonInk 画树（parse 不动它自己退回等宽原样）。
     */
    async json(o) {
      const title = o.name || o.title || 'json';
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        setViewer({ title, content: await res.text(), viewKind: 'json' });
      } catch {
        setViewer({ title, content: o.preview || '(读不出来)', viewKind: 'json' });
      }
    },

    async note(o) {
      const title = o.chalk ? `板书 · ${chalkAuthor(o.chalk.by, roleNames)}` : (o.noteTask ? o.name.replace(/\.md$/i, '') : '便签');
      try {
        const res = await fetch(Assets.artifactFileUrl(projectId, o.path));
        const raw = await res.text();
        // 任务便利贴/板书带 note 引用 → 浮层出"编辑"按钮（共享头脑风暴：用户改完
        // agent 下轮从注入清单看到文件、自己 Read 到新内容）。
        // head = frontmatter 原样留着（板书的 nd:chalk/anchor/reply_to 都在里面，保存时要拼回去）
        const head = /^---\n[\s\S]{0,800}?\n---\n?/.exec(raw)?.[0] || '';
        setViewer({ title, content: raw.slice(head.length), head, note: o.noteTask ? o : null, editKind: o.noteTask ? (o.noteTask && o.chalk ? 'chalk' : 'tasknote') : null });
      } catch { setViewer({ title, content: o.text || '', head: '', note: o.noteTask ? o : null, editKind: o.noteTask ? (o.chalk ? 'chalk' : 'tasknote') : null }); }
    },
  };

  return async (o) => {
    const reader = readerOf(o);
    if (reader) await READERS[reader](o);
  };
}

/** 项目区浮层：直接用原 Hub 的四张卡（编辑 / 上传 / 删除全套照旧） */
export function ProjectPanelOverlay({ projectId, panel, onClose, reload }) {
  return (
    <Overlay onClose={onClose}>
      <div style={{
        width: 'min(560px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
        background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
      }}>
        {panel === 'guide' && <InstructionsCard projectId={projectId} />}
        {panel === 'files' && <FilesCard projectId={projectId} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: GAP.md }}>
          <button onClick={() => { onClose(); reload(); }} style={toolBtn}>关闭</button>
        </div>
      </div>
    </Overlay>
  );
}

/** markdown 阅读浮层（便签全文 / 记忆 / 品牌）；任务便利贴可直接编辑（共享头脑风暴） */
export function MarkdownViewerOverlay({ projectId, viewer, onClose, onSaved }) {
  const [draft, setDraft] = useState(null);   // null = 阅读态；string = 编辑中的草稿
  return (
    <Overlay onClose={onClose}>
      <div style={{
        background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
        width: 'min(720px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'auto',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: GAP.sm, flexShrink: 0 }}>
          <BookOpen size={14} color={COLOR.sub} />
          <span style={{ marginLeft: GAP.sm, fontFamily: FONT_SANS, fontWeight: 600, fontSize: FONT_SIZE.md, color: COLOR.text }}>{viewer.title}</span>
          {viewer.editKind && draft === null && (
            <button title="编辑" onClick={() => setDraft(viewer.content)} style={{ ...toolBtn, marginLeft: 'auto' }}>
              <PencilLine size={12} />
            </button>
          )}
          {viewer.editKind && draft !== null && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: GAP.xs }}>
              <button onClick={async () => {
                try {
                  // 保存按 editKind 分流（08-24 起四类）。历史坑见 git blame：
                  // putTaskNote 三参签名 + noteTask 恒 null 两个 bug 互相掩护过。
                  // 板书/记忆的 frontmatter 由服务端保住（PUT 的保头逻辑），前端拼不拼都安全
                  const o = viewer.note;
                  if (viewer.editKind === 'chalk') await Assets.putChalk(projectId, o.name, `${viewer.head || ''}${draft}`);
                  else if (viewer.editKind === 'tasknote') await Assets.putTaskNote(projectId, o.name, draft);
                  else if (viewer.editKind === 'memory') await Assets.putMemoryNote(projectId, viewer.editName, draft);
                  else if (viewer.editKind === 'instruction') await Instruction.write(projectId, draft);
                  onSaved(draft);
                  setDraft(null);
                } catch (err) { console.warn('[board] save failed:', err.message); }
              }} style={toolBtn}>保存</button>
              <button onClick={() => setDraft(null)} style={toolBtn}>取消</button>
            </div>
          )}
          <button onClick={onClose}
            style={{ ...toolBtn, ...(viewer.editKind ? { marginLeft: GAP.xs } : { marginLeft: 'auto' }) }}><X size={12} /></button>
        </div>
        {draft === null ? (
          viewer.viewKind === 'json' ? (
            /* json 显示器（08-29 刀 B）：完整内容画成可折叠键值树。把 json 丢给
               MarkdownMath 的下场是一整块灰代码 —— 结构一点都看不见。 */
            <JsonInk text={viewer.content} fontSize={FONT_SIZE.sm} openDepth={3} />
          ) : (
            <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7 }}>
              <MarkdownMath>{viewer.content}</MarkdownMath>
            </div>
          )
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            style={{
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text, lineHeight: 1.7,
              minHeight: 320, resize: 'vertical', width: '100%', boxSizing: 'border-box',
              border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.lg, padding: GAP.md,
              background: CANVAS.note, outline: 'none',
            }}
          />
        )}
      </div>
    </Overlay>
  );
}

/** 图片详情浮层 */
export function ImageDetailOverlay({ projectId, detail, onClose, onAdd }) {
  return (
    <Overlay onClose={onClose}>
      <div style={{
        background: COLOR.bg, borderRadius: RADIUS.xxl, padding: GAP.lg,
        maxWidth: 'min(920px, 100%)', maxHeight: '100%', minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: GAP.md,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text }}>{detail.name}</span>
          <button onClick={onClose} style={{ ...toolBtn, marginLeft: 'auto' }}><X size={12} /></button>
        </div>
        {/* 图占中间的伸缩位：文件名和底部动作条永远留在画面里，图自己缩着看 */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img
            src={Assets.artifactFileUrl(projectId, detail.path)} alt={detail.name}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: RADIUS.lg, border: `1px solid ${COLOR.borderLt}` }}
          />
        </div>
        {detail.meta?.prompt && (
          <div style={{
            padding: GAP.md, borderRadius: RADIUS.lg, background: COLOR.bgCard, border: `1px solid ${COLOR.borderLt}`,
            fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            flexShrink: 0, maxHeight: 150, overflow: 'auto',
          }}>
            <div style={{ letterSpacing: '0.06em', marginBottom: GAP.xs, color: COLOR.text }}>PROMPT</div>
            {detail.meta.prompt}
            <div style={{ marginTop: GAP.xs }}>
              {detail.meta.aspectRatio} · {detail.meta.model || detail.meta.provider}
              {detail.meta.referenceImageCount > 0 && ` · ${detail.meta.referenceImageCount} 张参考图`}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: GAP.sm, justifyContent: 'flex-end' }}>
          <a href={Assets.artifactFileUrl(projectId, detail.path)} target="_blank" rel="noreferrer" style={{ ...toolBtn, textDecoration: 'none' }}>
            <ExternalLink size={12} /> 原图
          </a>
          <button onClick={onAdd} style={{ ...toolBtn, background: COLOR.text, color: COLOR.bg }}>
            <Plus size={12} /> 加入上下文
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * 画布内浮层（2026-07-28：层级归位）
 *
 * 原来是 position:fixed 铺满整个视口 —— 看图 / 读便签会把左栏对话和顶栏一起
 * 压暗，跟"编辑窗只在画布内最大化"（DeckWindow）的桌面语义打架。改成 absolute
 * 贴在 BoardCanvas 根上：只压暗桌面这一格。
 *
 * zIndex 走 MODAL 档（600）：阅读是专注型动作，要压过产物/文件夹窗（500）和
 * 工具栏（510）。⛔ 08-24 前这里是写死的 110 —— 那是压在"DeckWindow(120)
 * 之下"的老账，08-07 窗层抬到 500 后没人 rebase，于是文件夹窗里双击 .md
 * 阅读器整个躲在窗后面，看起来"双击没反应"。层级要引用档位常量别写裸数。
 */
function Overlay({ children, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: MODAL.zIndex, background: 'rgba(0,0,0,0.42)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: GAP.page,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        /* 高度给定值（不是 max-）：里层卡片的 maxHeight:100% 才有参照，能真被压缩 */
        style={{
          animation: POP_IN, height: '100%', width: '100%', minHeight: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}
      >{children}</div>
    </div>
  );
}

const toolBtn = {
  display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
  border: `1px solid ${COLOR.borderLt}`, borderRadius: RADIUS.md,
  background: COLOR.bgCard, color: COLOR.text, cursor: 'pointer',
  padding: `${GAP.xs}px ${GAP.sm + 2}px`,
  fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs,
};
