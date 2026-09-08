/**
 * ModelStickers —— 输入框上方那排「模型贴纸」（2026-09-08）。
 *
 * 一枚贴纸 = 身份标 + 模型名 + **状态色点** + 站主的印象短语。
 *
 * ## 两种话，分得很清
 *
 * · **色点是机器说的**：服务端每条上游一本环形账（`lib/ingress/upstream-health.js`），
 *   最近 50 发的成败。正常 / 降级 / 不可用 / 无数据。
 * · **短语是人说的**（`engine/agent/model-notes.js`）。没写就不显示 —— 留白是对的，
 *   硬凑一句"性能均衡"比没有更糟。
 *
 * ⛔ **半小时没请求显示「无数据」而不是绿点。** 这是整件事最容易做错的地方：
 * 全绿的历史 + 一发没跑，显示绿点就是在骗人去挑一条可能已经死了的线。
 * 判据在服务端，这里只负责把"不知道"画成看得见的灰点 + 三个字，不留白蒙混。
 *
 * ## 为什么不能点着切模型
 *
 * 切模型有一整套东西要跟着走：缓存失效的代价估算、站内确认弹窗、会话级 pin。
 * 那些都在 `ModelPicker` 里。这排贴纸再开一条切换路径，等于同一件事两个入口两套语义 ——
 * 而且它俩很可能慢慢长歪。**贴纸只负责"告诉你现在各条线什么状况"**，切换还是走下面那颗按钮。
 *
 * ## ⚠️ 色点是「上游」的健康度，不是「厂商」的
 *
 * 几行共用一条上游就会一起亮一起灭。而 merge 那条线上 `vendors` 是"第一个可用的赢"、
 * 后备静默，同一条上游这一发可能是 zai 服务的、下一发就是 particle —— 我们这边看不出来
 * （唯一判据是响应头 `x-merge-vendor`）。所以别把色点读成"某家厂商挂了"。
 */
import { useEffect, useState } from 'react';
import { Me } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { PAPER } from '../../lib/paper.js';
import { FONT_SIZE, FONT_SANS } from '../../lib/theme.js';
import ModelMark from '../ui/ModelMark.jsx';

/** 30 秒拉一次。⚠️ 别调快：这条接口每次都要遍历所有上游算比例，而这排东西不是实时仪表 */
const POLL_MS = 30_000;

/**
 * 四种状态的画法。
 * ⭐ 颜色之外**还有文字**：色点单靠颜色区分对色觉障碍不成立，而这排东西正是要传达状态的。
 */
const STATES = {
  ok: { dot: '#5A8F5A', label: () => t('正常') },
  degraded: { dot: '#C8912F', label: () => t('降级') },
  down: { dot: '#B5502E', label: () => t('不可用') },
  nodata: { dot: PAPER.pencil, label: () => t('无数据') },
};

/** 「最近一次是多久以前」—— 无数据那档要说清是"多久没动静"，不然用户不知道该不该等 */
function agoText(at) {
  if (!at) return '';
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return t('刚刚');
  if (min < 60) return t('{n} 分钟前', { n: min });
  return t('{n} 小时前', { n: Math.round(min / 60) });
}

function Sticker({ opt }) {
  // 没有 health 字段 = 这条线不由环形账衡量（订阅线的 claude-*）：只画名字和印象，不画色点也不写「无数据」
  const measured = !!opt.health;
  const st = STATES[opt.health?.state] || STATES.nodata;
  const state = opt.health?.state || 'nodata';
  const ago = agoText(opt.health?.lastAt);
  // 悬停时把机器那半边的细节摊开：多少发、最近一次失败是什么、首字节中位耗时
  const detail = !measured ? [t('不由状态账衡量')] : [
    `${st.label()}`,
    state === 'nodata'
      ? (ago ? t('最近一次请求：{ago}', { ago }) : t('还没有请求记录'))
      : t('最近 {n} 发', { n: opt.health?.samples ?? 0 }),
    opt.health?.lastReason ? t('最近一次失败：{why}', { why: opt.health.lastReason }) : '',
    opt.health?.medianMs ? t('首字节中位 {s} 秒', { s: (opt.health.medianMs / 1000).toFixed(1) }) : '',
  ];
  const detailText = detail.filter(Boolean).join(' · ');

  return (
    <span
      title={`${opt.label}——${detailText}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 8px', borderRadius: 999, flexShrink: 0,
        border: `1px solid ${PAPER.pencil}55`,
        background: `${PAPER.paper}CC`,
        fontSize: FONT_SIZE.xs, fontFamily: FONT_SANS,
        color: measured && state === 'nodata' ? PAPER.ink2 : PAPER.ink,
        // 不可用那档整枚压暗一点：它是唯一一个"别选我"的状态
        opacity: state === 'down' ? 0.72 : 1,
      }}
    >
      <ModelMark brand={opt.brand} size={11} pencil={false} />
      <span style={{ whiteSpace: 'nowrap' }}>{opt.label}</span>
      {measured && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: st.dot, flexShrink: 0 }} />}
      {/* ⭐ 色点旁边一定要有字：只靠颜色分状态对色觉障碍不成立 */}
      {measured && <span style={{ color: PAPER.ink2, whiteSpace: 'nowrap' }}>{st.label()}</span>}
      {opt.note && (
        <span style={{ color: PAPER.ink2, whiteSpace: 'nowrap', borderLeft: `1px solid ${PAPER.pencil}55`, paddingLeft: 6 }}>
          {opt.note}
        </span>
      )}
    </span>
  );
}

export default function ModelStickers() {
  const [options, setOptions] = useState(null);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const pull = () => {
      Me.models()
        .then((r) => { if (alive) setOptions(r?.options || []); })
        .catch(() => { /* 拉不到就不显示这排 —— 状态栏自己出错时最不该做的就是乱报状态 */ });
    };
    pull();
    timer = setInterval(pull, POLL_MS);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, []);

  // 还没拉到、或一条都没有 → 不占位（空的一条横杠比没有更碍事）
  const shown = (options || []).filter((o) => !o.hidden && !o.locked);
  if (!shown.length) return null;

  return (
    <div
      style={{
        display: 'flex', gap: 6, alignItems: 'center',
        padding: '0 2px 6px', overflowX: 'auto', overflowY: 'hidden',
        scrollbarWidth: 'none', msOverflowStyle: 'none',
      }}
    >
      {shown.map((o) => <Sticker key={o.id} opt={o} />)}
    </div>
  );
}
