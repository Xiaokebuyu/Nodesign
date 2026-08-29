import { useState, useRef, useEffect, useCallback } from 'react';
import { Check, Loader2, Lock } from 'lucide-react';
import { COLOR, GAP, RADIUS, SHADOW, FONT_SANS, FONT_MONO, FONT_SIZE } from '../../lib/theme.js';
import { useGlobalStore } from '../../stores/globalStore.js';
import { Sessions, Me } from '../../lib/api.js';
import { FALLBACK_MODELS, isModelPrefStale } from '../../lib/models.js';
import ModelMark from '../ui/ModelMark.jsx';

/**
 * 模型选择 —— Composer 工具栏里的小 picker。
 *
 * **真相在服务端**（2026-07-30 重做）。原来这里只认 localStorage 里的偏好，
 * 而模型的实际值住在会话的 session-config.json：换台机器 / 清了缓存打开一个跑着
 * Opus 的会话，按钮写着 Sonnet，用户按 Sonnet 的心态发消息、烧的是 Opus 额度。
 * 更糟的是选「默认」根本不做任何事 —— 它只是"不发 model 字段"，服务端于是保持
 * 原样，会话一旦切到 Opus 就再也回不到 Sonnet。
 *
 * 现在分两种处境：
 *   - **会话已存在**：GET /sessions/:sid/model 拿生效值和可选清单，选中即
 *     PUT 回去（服务端写配置 + 让空闲的 query 重启）。localStorage 不参与。
 *   - **还没有会话**（首页快速开始 / 项目 Hub）：没有可写的对象，仍用
 *     localStorage 偏好，随第一条消息的 body.model 带过去建会话。
 *
 * 可选清单**两种处境都问服务端**（model-context.js 的 `selectableModelsFor`）——
 * 前端硬编码 model id 写错一个字，spoofing 和真实容量两张表都查不到，两处都只会
 * 静默降级。2026-08-19 补上没会话那半条（`GET /api/me/models`）：在那之前没会话时
 * 直接吃 `FALLBACK_MODELS` 常量，**带闸门的模型（本地 Qwen）在首页永远不出现**，
 * 会话里能选、首页选不了。硬编码那份从此只是接口也挂了时的最后一道兜底。
 *
 * ## 「默认」那一档 2026-08-17 撤了
 *
 * 用户拍板：清单里只留 Sonnet 5 和 Opus 5 两项。「默认」原来的作用是**清掉会话
 * 覆盖、回到 NODESIGN_MODEL**，但它在界面上表达的是第三种模型，而实际上跑的仍是
 * 那两个之一 —— 一个选项，两层含义。撤掉之后勾永远打在**真正在跑的那个**上。
 *
 * 代价说清楚：会话一旦选过就没有"退回跟随全局默认"的入口了。两个选项的清单里
 * 这不是损失（想要哪个直接点哪个），但**如果以后清单变长、或者 NODESIGN_MODEL
 * 要当成一个能被跟随的档位**，这一档得连同它的语义一起加回来，别只加个按钮。
 */

/** 重档模型（按钮画成实心的那一档）—— 判 id 不判位置，清单换序不会跟着错 */
const isHeavy = (id) => /opus/i.test(String(id || ''));

function shortLabel(id, options) {
  if (!id) return '';
  const hit = options.find(o => o.id === id);
  if (hit) return hit.label;
  if (/opus/i.test(id)) return 'Opus';
  if (/sonnet/i.test(id)) return 'Sonnet';
  if (/haiku/i.test(id)) return 'Haiku';
  return id;
}

const stripParen = (s) => String(s || '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
const headOf = (s) => stripParen(String(s || '').split('·')[0]);

/**
 * 窄地方用的短名（2026-08-29 用户提：「超长模型名很影响排版」）。
 *
 * 模型行的 label 是给下拉看的，写全了路线和卖点
 * （`GLM-5.3-Flash · 官方直连（限时免费）` 有 24 个字），而按钮上只需要够认出是谁。
 * 规则：**取第一段、去掉尾部括号**。
 *
 * ⚠️ 但有两行的第一段是一样的（官方直连 / Merge 网关 都是 GLM-5.3-Flash），
 * 一刀切会让按钮对两条不同的线说同一句话 —— 那是把排版问题换成了一句谎。
 * 所以只在**第一段确实唯一**时才砍到一段，撞名了就留两段（仍然去掉括号）。
 * 下拉里永远是全名，选的时候信息不少。
 */
export function __compactLabel(full, options) {
  return compactLabel(full, options);
}

function compactLabel(full, options) {
  const head = headOf(full);
  if (!head) return full;
  const clash = (options || []).filter(o => headOf(o.label) === head).length > 1;
  if (!clash) return head;
  return String(full).split('·').map(stripParen).filter(Boolean).slice(0, 2).join(' · ');
}

/**
 * 换模型的隐性代价：**提示词缓存是按模型绑定的**，换一个就等于整段上下文缓存作废。
 * 下一轮那些 token 不再按 $0.30/M 的缓存命中价读，而是按 $3/M 的 input 重读一遍，
 * 外加 $6.00/M 再写一次缓存 —— 同样一轮对话，切换前后 token 数几乎没变，钱差三十倍。
 *
 * 这是用量口径从 token 换成金额之后才看得见的东西，所以以前没法提醒。
 * 估算按 sonnet 标准价（$3/M input + $6.00/M 1 小时缓存写 = $9/M）：opus 更贵，
 * 报低不报高 —— 提醒的作用是让人知道"这一下不便宜"，不是给报价。
 */
const COLD_START_USD_PER_TOKEN = 9 / 1_000_000;
/** 低于这个上下文就不提醒：新会话切模型几乎免费，弹窗只会变成噪音 */
const WARN_FROM_TOKENS = 30_000;

export default function ModelPicker({
  disabled = false, projectId = null, sessionId = null, contextTokens = 0,
  /** 换皮用：首页那张纸上的这颗按钮要跟着纸走（见 home-styles.js 的 .model） */
  className,
  /** 下拉往上开还是往下开。首页的纸底下没地方，仍旧往上开 */
  menuPlacement = 'up',
  /** 地方窄：按钮上只印短名（下拉里仍是全名）。由调用方判，见 compactLabel 头上 */
  compact = false,
}) {
  const modelPref = useGlobalStore(s => s.modelPref);
  const setModelPref = useGlobalStore(s => s.setModelPref);
  const showToast = useGlobalStore(s => s.showToast);
  const confirmDialog = useGlobalStore(s => s.confirm);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // 服务端口径：{ model, override, default, options }。没有会话时为 null
  const [remote, setRemote] = useState(null);
  const ref = useRef(null);

  const hasSession = !!(projectId && sessionId);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onClick); window.removeEventListener('keydown', onKey); };
  }, [open]);

  /**
   * 会话变了就重新问一次服务端。切走时先清掉，免得把上一场的模型显示成这一场的。
   *
   * 没有会话时问 `/api/me/models` —— 只拿清单，**不带 model 字段**：那种处境下
   * 选中值由本地偏好决定（下面 `effective` 的 `hasSession` 分支靠的就是这一点，
   * 这里回一个 model 反而会让按钮显示服务端的默认而不是用户选过的那个）。
   */
  useEffect(() => {
    let alive = true;
    setRemote(null);
    const p = hasSession ? Sessions.model(projectId, sessionId) : Me.models();
    p.then((r) => { if (alive) setRemote(r); })
      .catch(() => { /* 拿不到就退回硬编码兜底清单 + 本地偏好显示 */ });
    return () => { alive = false; };
  }, [hasSession, projectId, sessionId]);

  // 服务端**答了**就信它（空清单也是答案：本地版没配钥匙时就是空）；只有没答上来（还在等 / 接口挂了）才吃兜底常量
  const options = remote ? (remote.options || []) : FALLBACK_MODELS;
  const none = !!remote && options.length === 0;
  const isLocalProfile = useGlobalStore(s => s.authProfile) === 'local';

  /**
   * 本地偏好过期自净（2026-08-20 随「本地 Qwen 摘牌」加）。
   *
   * 光在这里改显示不够 —— **开新会话时 ProjectWorkspace 是直接从 store 读
   * `modelPref` 发出去的**，picker 只是个显示层。所以发现过期要把 store 里那个值
   * 修回来，否则用户点"新会话"拿到的是 400 `unknown model`。判据见 isModelPrefStale
   * （只认服务端真清单，拿兜底清单判会误伤带闸门的模型）。
   */
  useEffect(() => {
    if (hasSession) return;
    if (isModelPrefStale(modelPref, remote?.options)) setModelPref(remote.default || remote.options.find(o => !o.locked)?.id || remote.options[0].id);
  }, [hasSession, remote, modelPref, setModelPref]);
  /**
   * 现在跑的是哪个。两条路都保证是个具体模型：有会话看服务端（`remote.model`
   * 已经把覆盖和全局默认算完），没会话看本地偏好（store 里没选过就是
   * `DEFAULT_MODEL_ID`，不再是 null）。
   *
   * 所以按钮上写的就是这条消息真会用的那个 —— 没会话时前端把它明写进
   * `body.model`，不靠服务端的 `NODESIGN_MODEL` 兜。后面那个 `||` 只是安全网
   * （remote 回了个空 model 之类），不是设计里的一条路。
   */
  const effective = (hasSession ? remote?.model : modelPref) || options[0]?.id || null;

  const select = useCallback(async (id) => {
    setOpen(false);
    // 看得见选不了的订阅行（08-21 公开注册号）：弹框说清楚是更高档位，不发请求。
    // 口径（08-21 深夜）：pro 不对外分发，留着锁行只是让人知道有更高档，文案不给任何"去哪里拿资格"的路径
    const lockedOpt = options.find(o => o.id === id && o.locked);
    if (lockedOpt) {
      await confirmDialog({
        title: '这个模型仅限 Pro 档',
        message: `${lockedOpt.label} 跑在站主的 Claude 订阅上，属于 Pro 档，暂未对外开放。当前档位可用的模型都在列表里，不带锁的随便选。`,
        confirmLabel: '知道了', cancelLabel: '关闭',
      });
      return;
    }
    if (!hasSession) { setModelPref(id); return; }
    // 点的就是正在跑的那个 → 什么也不做。别拿"覆盖字段是不是空"当判据：override
    // 为 null 时写一次会让 changed=true，服务端顺手把空闲的 query 关掉重开，
    // 而模型压根没变 —— 用户只是点了一下确认。
    if (id === effective) return;
    // 大上下文切模型要重新过一遍缓存，先把代价说清楚再让他按
    if (contextTokens >= WARN_FROM_TOKENS) {
      const est = contextTokens * COLD_START_USD_PER_TOKEN;
      const okToSwitch = window.confirm(
        `切换模型会让这个会话的缓存失效。\n\n`
        + `当前上下文 ${(contextTokens / 1000).toFixed(0)}k tokens，下一轮要重新读一遍，`
        + `大约多花 $${est.toFixed(2)}（之后恢复正常）。\n\n`
        + `对话和画布都不会丢。要切吗？`,
      );
      if (!okToSwitch) return;
    }
    const prev = remote;
    setSaving(true);
    // 乐观更新：点完立刻变，失败再退回去
    setRemote(r => ({ ...(r || {}), override: id, model: id || r?.default || null }));
    try {
      const r = await Sessions.setModel(projectId, sessionId, id);
      setRemote(r);
      // 本地偏好跟着走：下次在别处新建会话时用同一个选择
      setModelPref(id);
    } catch (err) {
      setRemote(prev);
      showToast(`切模型失败：${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [hasSession, effective, remote, projectId, sessionId, setModelPref, showToast, contextTokens, options, confirmDialog]);

  const full = none ? '未配置模型' : shortLabel(effective, options);
  // compact = 调用方说"这儿地方窄"。⭐ 由调用方判而不是这儿读视口：真正约束它的是
  // **它待的那个容器**（平板上视口 810 但聊天卡只有 380），今晚刚在工具栏折行上栽过同一条
  const label = compact && !none ? compactLabel(full, options) : full;
  const busy = disabled || saving;
  /**
   * 实心 = 现在跑在重档上。
   *
   * 撤掉「默认」之前，实心表达的是"你手动选过"—— 那个区别用户看不见也用不上。
   * 换成"这一档烧得快"之后按钮才在说一件有用的事：Opus 一眼认得出来。
   */
  const heavy = isHeavy(effective);
  /** 这一档出自谁家。清单里查不到（本地偏好指向已下架模型之类）就不画标，不猜 */
  const brand = options.find((o) => o.id === effective)?.brand;
  // 转发给画布精灵：它跟这颗按钮说的必须是同一个模型，而它离得太远、也不该自己再问一遍接口
  const setSessionBrand = useGlobalStore(s => s.setSessionBrand);
  useEffect(() => { if (brand) setSessionBrand(brand); }, [brand, setSessionBrand]);

  return (
    <div ref={ref} className={className} style={{ position: 'relative' }}>
      <style>{'@keyframes nd-model-spin { to { transform: rotate(360deg); } }'}</style>
      <button
        onClick={() => !busy && setOpen(v => !v)}
        disabled={busy}
        title={
          disabled ? '这一轮跑完再切（切换从下一条消息生效）'
            : none ? '还没有可用的模型'
            : hasSession
              ? `这个会话跑在 ${effective}。切换从下一条消息生效，对话不丢`
              : `新会话将用 ${label}`
        }
        style={{
          display: 'inline-flex', alignItems: 'center', gap: GAP.xs,
          padding: `${GAP.xs}px ${GAP.sm}px`,
          fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, fontWeight: 500,
          color: heavy ? COLOR.btnText : COLOR.text2,
          background: heavy ? COLOR.btn : 'transparent',
          border: `1px solid ${heavy ? COLOR.btn : COLOR.borderMd}`,
          borderRadius: RADIUS.md,
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.5 : 1,
          transition: 'all 0.15s',
        }}
      >
        {/* 图标是**这个模型出自谁家**的标（ui/ModelMark.jsx），不是通用 CPU 图标：接了
            Claude 以外的模型之后，跑 DeepSeek 的会话画星芒就是张冠李戴。brand 由服务端
            随清单下发，前端不按 id 猜。实心态底色是墨块，品牌色压不住，那一档跟着文字走。 */}
        {saving
          ? <Loader2 size={11} style={{ animation: 'nd-model-spin 0.9s linear infinite' }} />
          : <ModelMark brand={brand} size={12} color={heavy ? COLOR.btnText : undefined} />}
        {label}
      </button>

      {open && (
        <div style={{
          position: 'absolute', left: 0,
          ...(menuPlacement === 'down'
            ? { top: 'calc(100% + 6px)' }
            : { bottom: 'calc(100% + 6px)' }),
          minWidth: 240,
          background: COLOR.bgWhite,
          borderRadius: 2,
          boxShadow: SHADOW.pop,
          padding: GAP.xs,
          zIndex: 60,
        }}>
          {none && (
            <div style={{ padding: `${GAP.sm}px ${GAP.md}px`, fontFamily: FONT_SANS, fontSize: FONT_SIZE.sm, color: COLOR.text3, lineHeight: 1.6 }}>
              还没有可用的模型。
              {isLocalProfile
                ? <>到 <a href="/settings" style={{ color: COLOR.text, textDecoration: 'underline' }}>设置</a> 填 API Key（或在终端 <span style={{ fontFamily: FONT_MONO }}>claude login</span>），要接别家接口就配一个模型插槽。</>
                : '请联系站主。'}
            </div>
          )}
          {options.map((o) => (
            <Option
              key={o.id}
              active={effective === o.id}
              label={o.label}
              desc={o.locked ? `${o.lockReason || '仅限 Pro 档'} · ${o.desc}` : o.desc}
              locked={!!o.locked}
              onClick={() => select(o.id)}
            />
          ))}
          <div style={{
            padding: `${GAP.xs}px ${GAP.md}px ${GAP.xs}px`, borderTop: `1px solid ${COLOR.borderLt}`,
            marginTop: GAP.xxs, fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub,
          }}>
            {hasSession
              ? (contextTokens >= WARN_FROM_TOKENS
                ? `从下一条消息生效，对话与画布不丢。当前上下文 ${(contextTokens / 1000).toFixed(0)}k，换模型要重读一遍缓存，额外花约 $${(contextTokens * COLD_START_USD_PER_TOKEN).toFixed(2)}`
                : '从下一条消息生效，对话与画布不丢')
              : '这条只影响接下来新建的会话'}
          </div>
        </div>
      )}
    </div>
  );
}

function Option({ active, label, desc, locked = false, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex', alignItems: 'flex-start', gap: GAP.sm,
        padding: `${GAP.sm}px ${GAP.md}px`,
        background: 'transparent', border: 'none', borderRadius: RADIUS.sm,
        cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(43,33,23,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ width: 13, flexShrink: 0, marginTop: GAP.xxs }}>
        {active && <Check size={12} color={COLOR.text} />}
        {!active && locked && <Lock size={11} color={COLOR.sub} />}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontFamily: FONT_MONO, fontSize: FONT_SIZE.sm, fontWeight: 500, color: locked ? COLOR.sub : COLOR.text }}>
          {label}
        </span>
        <span style={{ display: 'block', fontFamily: FONT_SANS, fontSize: FONT_SIZE.xs, color: COLOR.sub, marginTop: 1 }}>
          {desc}
        </span>
      </span>
    </button>
  );
}
