import { useState, useEffect, useCallback, useRef } from 'react';
import { Wrench, Plus, Upload, Trash2, BookOpen, Box, ChevronDown, ChevronRight } from 'lucide-react';
import AppShell from '../components/layout/AppShell.jsx';
import { paperCard } from '../lib/paper.js';
import { COLOR, GAP, RADIUS, FONT_SIZE, FONT_KAI, FONT_MONO, FONT_SANS } from '../lib/theme.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Plugins, Skills } from '../lib/api.js';

/**
 * SkillList — 用户级 plugin 管理面板（跨 project 全局）
 *
 * 数据：
 *   - GET /api/skills        列内置 + 用户级 plugin（不传 projectId）
 *   - POST/DELETE /api/plugins/...   上传 / 卸载
 *
 * Project 级 plugin 不在这页 — 走 project 内的 SystemTab。
 *
 * 上传流程：选 zip → POST /api/plugins/install → 成功 toast / 409 弹覆盖确认
 * 卸载流程：点垃圾桶 → 二次确认 → DELETE → 刷新
 * 内置 plugin (scope='builtin') 只展示不能卸载
 */

const SCOPE_LABEL = {
  builtin: '内置',
  user: '我的',
};
const SCOPE_COLOR = {
  builtin: COLOR.success,
  user: '#7A6B3A',
};

export default function SkillList() {
  const showToast = useGlobalStore(s => s.showToast);
  const confirm = useGlobalStore(s => s.confirm);

  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { plugins: list } = await Skills.list();
      setPlugins(list || []);
    } catch (err) {
      showToast(`加载 plugin 列表失败：${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = useCallback(async (file, force = false) => {
    if (!file) return;
    setUploading(true);
    try {
      const result = await Plugins.installUser(file, { force });
      const name = result?.installed?.name;
      showToast(`已装 plugin \`${name}\`（新会话生效）`, 'success');
      if (result?.warnings?.length) {
        showToast(`警告：${result.warnings.join('；')}`, 'warn');
      }
      await refresh();
    } catch (err) {
      if (err.status === 409 && err.body?.existing) {
        const ok = await confirm({
          title: '覆盖已装 plugin？',
          message: `已装 \`${err.body.existing.name}@${err.body.existing.version}\`，将覆盖为 \`${err.body.incoming.name}@${err.body.incoming.version}\`。`,
          confirmLabel: '覆盖',
          cancelLabel: '取消',
          danger: true,
        });
        if (ok) {
          await handleUpload(file, true);
        }
        return;
      }
      const detail = err.body?.errors?.length ? `：${err.body.errors.join('；')}` : '';
      showToast(`安装失败${detail || `：${err.message}`}`, 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [refresh, showToast, confirm]);

  const handleUninstall = useCallback(async (name) => {
    const ok = await confirm({
      title: '卸载 plugin？',
      message: `从你的 skill 库里移除 \`${name}\`。文件会被删除，新会话不再加载。`,
      confirmLabel: '卸载',
      cancelLabel: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await Plugins.removeUser(name);
      showToast(`已卸载 \`${name}\``, 'success');
      await refresh();
    } catch (err) {
      showToast(`卸载失败：${err.message}`, 'error');
    }
  }, [refresh, showToast, confirm]);

  return (
    <AppShell
      breadcrumb={[{ label: 'Skill' }]}
      actions={
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.zip,application/zip,text/markdown,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
              padding: `${GAP.sm + 1}px ${GAP.xl}px`,
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, fontWeight: 500,
              color: COLOR.btnText, background: COLOR.btn,
              border: `1px solid ${COLOR.btn}`,
              borderRadius: RADIUS.lg,
              cursor: uploading ? 'not-allowed' : 'pointer',
              opacity: uploading ? 0.6 : 1,
            }}
          >
            <Upload size={14} /> {uploading ? '安装中…' : '上传 skill / plugin'}
          </button>
        </>
      }
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${GAP.page}px ${GAP.page}px` }}>
        <div style={{ marginBottom: GAP.xl }}>
          <h1 style={{
            fontFamily: FONT_KAI, fontSize: FONT_SIZE.h1, fontWeight: 700,
            color: COLOR.text, marginBottom: GAP.sm,
          }}>我的 Skill</h1>
          <p style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, color: COLOR.text2,
            lineHeight: 1.6, margin: 0,
          }}>
            {/* 2026-08-29：原文写的是「内置的两份管 deck 和站点」，内置早就不止两份了
                （现在还有 word 和演出）。不再写死数字 —— 下面那张表本来就把每份都列着，
                这行字重复一遍只会再过时一次。 */}
            skill 是一套做事的方法论，agent 开工前会读。内置的那几份卸不掉；
            你自己的（做完一件东西让 agent 固化下来、或者别人发你的文件）装在这里，所有项目通用。
            只想给某一个项目用的，在那个项目的 System 面板里装。
          </p>
        </div>

        {loading && plugins.length === 0 ? (
          <div style={{
            padding: GAP.xl,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            textAlign: 'center',
          }}>加载中…</div>
        ) : plugins.length === 0 ? (
          <div style={{
            padding: GAP.xl,
            border: `1px dashed ${COLOR.borderMd}`,
            borderRadius: RADIUS.lg,
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
            textAlign: 'center',
          }}>暂无 plugin。点右上「上传 plugin zip」装一个。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.md }}>
            {plugins.map(p => (
              <PluginRow
                key={p.path || p.name}
                plugin={p}
                onUninstall={p.scope === 'builtin' ? null : () => handleUninstall(p.name)}
              />
            ))}
          </div>
        )}

        <div style={{
          marginTop: GAP.page,
          padding: `${GAP.lg}px ${GAP.xl}px`,
          background: COLOR.bgCard,
          border: `1px dashed ${COLOR.borderMd}`,
          borderRadius: RADIUS.xxl,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.sub,
          lineHeight: 1.6,
        }}>
          ⓘ <strong style={{ color: COLOR.text2 }}>上传格式</strong>（三种皆可，host 自动包装）：
          <ul style={{ margin: `${GAP.xs}px 0`, paddingLeft: GAP.xl, lineHeight: 1.7 }}>
            <li>
              <strong>单个 .md 文件</strong>（最简）：含 YAML frontmatter
              <code style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, margin: `0 ${GAP.xs}px` }}>name</code>的 SKILL.md
            </li>
            <li>
              <strong>Skill zip</strong>：zip 内有
              <code style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, margin: `0 ${GAP.xs}px` }}>SKILL.md</code>
              + 可选附件（patterns/references/ 等）
            </li>
            <li>
              <strong>完整 plugin zip</strong>：含
              <code style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, margin: `0 ${GAP.xs}px` }}>.claude-plugin/plugin.json</code>
              + <code style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, margin: `0 ${GAP.xs}px` }}>skills/&lt;id&gt;/SKILL.md</code>
              （SDK 原生 plugin convention）
            </li>
          </ul>
          单 .md / skill zip 自动包装时 plugin name = frontmatter.name。
          大小 ≤ 8MB / entries ≤ 200。新会话生效（v1 不支持 hot-reload）。
        </div>
      </div>
    </AppShell>
  );
}

function PluginRow({ plugin, onUninstall }) {
  const [expanded, setExpanded] = useState(false);
  const scopeLabel = SCOPE_LABEL[plugin.scope] || plugin.scope;
  const scopeColor = SCOPE_COLOR[plugin.scope] || COLOR.sub;
  const skillCount = plugin.skills?.length || 0;

  return (
    <div style={{
      ...paperCard(),
      overflow: 'hidden',
    }}>
      <div
        onClick={() => skillCount > 0 && setExpanded(e => !e)}
        style={{
          padding: `${GAP.lg}px ${GAP.xl}px`,
          display: 'flex', alignItems: 'center', gap: GAP.lg,
          cursor: skillCount > 0 ? 'pointer' : 'default',
        }}
      >
        <div style={{
          width: 40, height: 40, borderRadius: RADIUS.lg,
          background: COLOR.bgCard,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Box size={16} color={COLOR.text4} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.md, marginBottom: GAP.xxs }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.lg, fontWeight: 600, color: COLOR.text }}>
              {plugin.name}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
              {plugin.version}
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: scopeColor,
              padding: '1px 7px',
              background: 'rgba(43,33,23,0.04)',
              borderRadius: RADIUS.pill,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: RADIUS.xs, background: scopeColor }} />
              {scopeLabel}
            </span>
            <span style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
              {skillCount} skill
            </span>
          </div>
          {plugin.description && (
            <div style={{
              fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text2,
              lineHeight: 1.5,
            }}>{plugin.description}</div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.sm, flexShrink: 0 }}>
          {onUninstall ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUninstall(); }}
              title="卸载"
              style={{
                background: 'transparent', border: 'none',
                color: COLOR.sub, cursor: 'pointer',
                padding: GAP.xs,
              }}
            >
              <Trash2 size={14} />
            </button>
          ) : (
            <span
              title="内置不可卸载"
              style={{
                fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub,
                opacity: 0.5, padding: `0 ${GAP.xs}px`,
              }}
            >🔒</span>
          )}
          {skillCount > 0 && (
            expanded ? <ChevronDown size={14} color={COLOR.sub} /> : <ChevronRight size={14} color={COLOR.sub} />
          )}
        </div>
      </div>

      {expanded && skillCount > 0 && (
        <div style={{
          borderTop: `1px solid ${COLOR.borderLt}`,
          background: 'rgba(43,33,23,0.02)',
          padding: `${GAP.md}px ${GAP.xl}px`,
          display: 'flex', flexDirection: 'column', gap: GAP.sm,
        }}>
          {plugin.skills.map(s => (
            <SkillSubrow key={s.id} skill={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillSubrow({ skill }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
      padding: `${GAP.xs + 1}px ${GAP.md}px`,
      background: COLOR.bgWhite,
      borderRadius: RADIUS.md,
    }}>
      <BookOpen size={12} color={COLOR.text4} style={{ marginTop: 3, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: GAP.sm }}>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, color: COLOR.text2 }}>
            {skill.name}
          </span>
          <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
            {skill.version}
          </span>
          {skill.id !== skill.name && (
            <span style={{ fontFamily: FONT_MONO, fontSize: FONT_SIZE.xs, color: COLOR.sub }}>
              · id: {skill.id}
            </span>
          )}
        </div>
        {skill.description && (
          <div style={{
            fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
            lineHeight: 1.5, marginTop: GAP.xxs,
          }}>{skill.description}</div>
        )}
      </div>
    </div>
  );
}
