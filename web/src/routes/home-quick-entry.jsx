/**
 * QuickEntry —— 首页板子上那本便签：一句话（或者一张图）开工。
 *
 * 2026-08-17 从 Home.jsx 拆出来（行数棘轮）。上一次拆走的是样式表
 * （home-styles.js）—— 这一次拆走的是整个"开工"入口：它自己有输入、附件托盘、
 * 模型选择、建项目和上传三步串联，跟首页剩下那些**只是把数据摆出来**的卡片
 * 不是一个量级的东西。
 *
 * 皮全在 home-styles.js 的 .ndd-pad 那一段，这里只有行为。
 */
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { measureCaret } from '../lib/textarea-caret.js';
import { Plus } from 'lucide-react';
import ComposerTray from '../components/chat/ComposerTray.jsx';
import ModelPicker from '../components/chat/ModelPicker.jsx';
import { isImeEnter } from '../lib/helpers.js';
import { useMedia, COARSE } from '../lib/use-media.js';
import { Clip } from '../components/PaperBits.jsx';
import { useProjectStore } from '../stores/projectStore.js';
import { useGlobalStore } from '../stores/globalStore.js';
import { Assets } from '../lib/api.js';
import { t } from '../lib/i18n.js';


/**
 * 随机问候语池。mount 时挑一条；按时间段（早/午/晚）+ 通用各占一半。
 * 写得轻松点，不要"AI 助手"那种正经话。整页是手写的语气，不放 emoji。
 */
const GREETINGS_GENERIC = [
  '今天想做点什么？',
  '嗨，想做个什么东西？',
  '说一句，我帮你画出来',
  '灵感来了？敲下来试试',
  '随便聊聊，看能做出什么',
  '把脑子里那张图描述一下',
  '今天想折腾点什么？',
];
const GREETINGS_MORNING = ['早，今天先做哪个？', '早上好，想做什么？'];
const GREETINGS_AFTERNOON = ['下午想做点什么？', '午后小憩，做点什么？'];
const GREETINGS_EVENING = ['晚上有想做的吗？说说看', '深夜灵感最值钱，敲下来'];

function pickGreeting() {
  const h = new Date().getHours();
  let pool = GREETINGS_GENERIC;
  if (h >= 6 && h < 11) pool = pool.concat(GREETINGS_MORNING);
  else if (h >= 13 && h < 18) pool = pool.concat(GREETINGS_AFTERNOON);
  else if (h >= 21 || h < 4) pool = pool.concat(GREETINGS_EVENING);
  // ⭐ 在取用处包 t()，不在上面的数组定义处：模块级 const 只求值一次，
  // 在定义处包会把 import 那一刻的语言烤死，之后切语言不再变。
  return t(pool[Math.floor(Math.random() * pool.length)]);
}

/**
 * 输入框 placeholder 例子池——给用户一个具体的起点示例，比"agent 自己判断…"
 * 那种过程描述更直观。mount 时随机挑一条。
 */
const PLACEHOLDER_EXAMPLES = [
  '比如：给我的新歌做一个歌词视觉页',
  '比如：春节活动海报，暖色调',
  '比如：作品集主页，安静一点的',
  '比如：同人本的宣传图，暗色系',
  '比如：一篇长文的阅读页，衬线字',
  '比如：把这半年做的东西整理成一份 deck',
  '想画个什么？说说看',
  '把脑子里的画面写下来…',
];

/** 演出模式的例子池 —— 设计那些例子在这挡里全是错的方向 */
const PLACEHOLDER_EXAMPLES_RP = [
  '比如：一座雨夜的侦探事务所，我是委托人',
  '比如：把这张角色卡演起来',
  '比如：三人小队的星际商船日常',
  '想演个什么故事？说说看',
  '描述一下开场：地点、人物、气氛…',
];

function pickPlaceholder(mode) {
  const pool = mode === 'rp' ? PLACEHOLDER_EXAMPLES_RP : PLACEHOLDER_EXAMPLES;
  return t(pool[Math.floor(Math.random() * pool.length)]);
}

/**
 * 两种纸：类名 = home-styles.js 里那组配方（底色/格线/版心/底下压着什么纸）。
 * 真输入框和"正在被揭掉的那张"挂同一个类，所以纸长什么样只有一份定义。
 */
const SHEET_CLS = { design: 'nd-sheet-design', rp: 'nd-sheet-rp' };
/** 页签上的字。⚠️ 别在这儿包 t()：模块级 const 只求值一次，会把语言烤死 */
const MODE_LABEL = { design: '设计', rp: '演出' };

/** 首页的模式偏好只是个本地便利：读不到就落 design，绝不因此报错 */
const MODE_LS_KEY = 'nd-home-mode';
function readModePref() {
  try {
    const v = localStorage.getItem(MODE_LS_KEY);
    return v === 'rp' ? 'rp' : 'design';
  } catch { return 'design'; }
}

/** 红光标的高度。跟 home-styles.js 里 `.ndd-pad .caret` 的 height 是同一个数
 *  （判"插入点滚出视野了没有"要用它）—— 两边对不上由 home-pad.lint.test.js 拦。 */
const CARET_H = 20;

export default function QuickEntry({ prefill }) {
  const navigate = useNavigate();
  const createProject = useProjectStore(s => s.createProject);
  const showToast = useGlobalStore(s => s.showToast);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [greeting] = useState(pickGreeting);  // mount 时挑一次，刷新换一个
  // 项目模式（2026-08-27）：design=设计 / rp=演出。这颗开关决定**接下来建出的项目**
  // 是哪种（服务端 projects.mode），不是页面状态 —— 切换记进 localStorage 当默认。
  const [mode, setMode] = useState(readModePref);
  const [placeholder, setPlaceholder] = useState(() => pickPlaceholder(readModePref()));
  /**
   * 正在被揭掉的那张纸（2026-08-28）。输入栏是一叠纸，切换 = 从最外层揭掉一张：
   * 把当前这张的样子原地复制一份浮上去翻飞出去，底下露出来的已经是新的那张。
   * 连正文一起复制 —— 不带的话切换那一刻正文先消失、动画完了新 placeholder 才
   * 出现，比不做动画还糟。h 是切换那一刻量到的 textarea 真高（纸的高度是内容
   * 撑的，复制品没有 textarea，量不出来就只能猜）。
   */
  const [peel, setPeel] = useState(null);   // { id, from, h, text, ph, foot }
  const peelSeq = useRef(0);
  const footRef = useRef(null);        // 真的那排家什（托盘 + + / 模型 / 提示 / 开工）
  const peelFootRef = useRef(null);    // 复制品里放克隆的坑
  /**
   * 把工具栏整块克隆一份给复制品（2026-08-28）。
   *
   * 模型选择器、开工按钮这些跟正文一样是**写在这张纸上**的，纸被扯走它们得一起掉。
   * 克隆而不是照抄一份 JSX：照抄的那份迟早跟真的分叉（改了工具栏忘了改复制品，
   * 平时看不出来，一按切换才露馅），而且 ModelPicker 是个有状态的组件，
   * 再挂一个实例等于多一份订阅。
   *
   * ⛔ id 一律去掉：克隆里带同名 id 会跟原件抢 SVG 的 url(#…) 引用（渐变/遮罩），
   * 谁赢看文档顺序，那是一种改一下 DOM 位置就会变的错。克隆纯装饰，不需要 id。
   * ⛔ 焦点也要摘干净：aria-hidden 挡得住读屏，挡不住 Tab —— 克隆里那几个按钮
   * 在这半秒里是能被 Tab 焦点走进去的。
   */
  const cloneFoot = () => {
    const el = footRef.current;
    if (!el) return null;
    const c = el.cloneNode(true);
    c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    c.querySelectorAll('button, input, a, select, textarea, [tabindex]')
      .forEach((n) => { n.setAttribute('tabindex', '-1'); n.setAttribute('aria-hidden', 'true'); });
    return c;
  };
  const pickMode = (m) => {
    if (m === mode) return;
    setPeel({
      id: ++peelSeq.current, from: mode,
      h: ref.current?.offsetHeight || 116, text, ph: placeholder, foot: cloneFoot(),
    });
    setMode(m);
    setPlaceholder(pickPlaceholder(m));
    try { localStorage.setItem(MODE_LS_KEY, m); } catch { /* 存不上就每次手选 */ }
  };
  // 克隆是真 DOM 节点，React 渲染不出来 —— 渲染完手工塞进复制品里那个坑
  useLayoutEffect(() => {
    const host = peelFootRef.current;
    if (host && peel?.foot) host.replaceChildren(peel.foot);
  }, [peel]);
  const coarse = useMedia(COARSE);
  // 暂存附件（QuickEntry 阶段还没 project，只能存 File 对象，submit 时再 createProject + 上传）
  // chip 形态：path/error 都 undefined → ComposerTray 显示 "上传中…"（实际是"待上传"，hover 看 title）
  const [attachments, setAttachments] = useState([]);
  // [{ id, type:'asset', name, size, mime, _file: File }]
  const ref = useRef(null);

  /**
   * 自制光标（2026-08-17）。
   *
   * 原生 caret 是 1px 的线，落在这张米色纸上找不着 —— 08-15 加空框红光标时就是
   * 为这个，但当时只管了**空框**：一敲字就交回原生 caret，用户报的
   * 「一输入内容光标就不显示」说的正是那半截。现在打字时也画同一根 2px 红线，
   * 位置由 `measureCaret` 用镜像层量出来。
   *
   * ⚠️ 中文输入法**组字期间**把原生 caret 放回来（`composing`）：那几百毫秒里
   * value 和 selectionStart 都在跳，自己画只会抖；而且 IME 的候选框本来就跟着
   * 原生 caret 走，抢过来反而错位。
   */
  const [caretAt, setCaretAt] = useState({ x: 0, y: 0, off: false });
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const syncCaret = useCallback(() => {
    const ta = ref.current;
    if (!ta) return;
    const { x, y } = measureCaret(ta);
    // 插入点滚出视野时**不画**。这一层没有裁剪（也不能加 overflow:hidden —— 那会让
    // .lines 变成滚动容器，浏览器有机会把整个输入框顶上去），红线画出去就是飘在
    // 底下那排工具按钮上。粘一段长文再往回滚，一滚就能看见。（2026-08-21）
    // clientHeight 为 0 = 还没排版（首帧 / 测试环境），这时候一律当"在视野里"，
    // 否则空框那根邀请用的红线会在第一帧就被判出局
    const h = ta.clientHeight;
    const off = h > 0 && (y < 0 || y + CARET_H > h);
    setCaretAt(c => (c.x === x && c.y === y && c.off === off ? c : { x, y, off }));
  }, []);
  // 文字变了要在 DOM 更新之后量（useLayoutEffect），不然量到的是上一帧
  useLayoutEffect(() => { syncCaret(); }, [text, syncCaret]);
  /**
   * 插入点变化的兜底同步（2026-08-21）。
   *
   * React 的 `onSelect` 有一处漏发：**点在已有选区里面**的时候。Chrome 是在 mouseup
   * 的默认动作里才把选区折叠成插入点，而 React 恰好在 mouseup 的处理器里读选区 ——
   * 读到的还是旧的那一片，跟上次一样于是不发事件。结果红线停在原地：用户点了空行，
   * 却看不见光标（如果旧位置还滚出了视野，那就是一根都没有）。
   * 实测三条路径都栽在这儿：拖选后点选区内 / Ctrl+A 后点 / 三击选行后点。
   *
   * `selectionchange` 是折叠**之后**才发的，补得上。onSelect 照旧留着当跨浏览器的
   * 底线（Firefox 的 selectionchange 未必送到 document），两边调的是同一个幂等函数。
   */
  useEffect(() => {
    if (!focused) return undefined;
    const onSel = () => { if (document.activeElement === ref.current) syncCaret(); };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [focused, syncCaret]);
  // 视口宽度变了 → 折行位置变了 → 光标跟着变。框自己会变宽（width:100%），
  // 所以盯的是框不是 window
  useEffect(() => {
    const ta = ref.current;
    if (!ta || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => syncCaret());
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncCaret]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // 上限取 29 的整数倍（10 行），不然长文本撑到顶时最后一格会被切掉半条线
    el.style.height = Math.min(el.scrollHeight, 290) + 'px';
  }, [text]);

  // 空状态示例 chip 点击 → 填入并聚焦（ts 变化允许重复点同一条）
  useEffect(() => {
    if (!prefill?.text) return;
    setText(prefill.text);
    ref.current?.focus();
  }, [prefill]);

  const handlePickFile = (file) => {
    const tempId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setAttachments(arr => [...arr, {
      id: tempId, type: 'asset',
      name: file.name, size: file.size, mime: file.type,
      _file: file,  // 暂存 File 等 submit 时统一上传
      // 图片给托盘出缩略图；移除 / submit 跳走时 revoke
      previewUrl: (file.type || '').startsWith('image/')
        ? URL.createObjectURL(file) : undefined,
    }]);
  };
  const handleRemoveAtt = (id) => setAttachments(arr => {
    const it = arr.find(a => a.id === id);
    if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
    return arr.filter(a => a.id !== id);
  });

  const submit = async () => {
    const v = text.trim();
    // 只传附件不打字也能开工（2026-08-17，issue #1 第 8 条）
    if ((!v && attachments.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      // 1. 直接建**真项目**（2026-07-28：首页不再有"闪聊"这个二等公民）。
      //    名字先用用户这句话垫着，标 autoNamed —— 第一轮跑完服务端会用 SDK helper
      //    写的会话摘要正名一次，用户之后随时可以在项目里「⋯ → 重命名」改。
      //    一个字没写时拿第一个附件的名字垫，比"新项目"认得出来。
      const seed = v || attachments[0]?.name || '';
      const projName = seed.slice(0, 24) + (seed.length > 24 ? '…' : '');
      const proj = await createProject({
        name: projName || t('新项目'),
        mode,
        autoNamed: true,
      });
      // 2. 上传暂存的附件到新 project（单文件失败不阻塞其他，让用户看到 toast 自决）
      const ready = [];
      for (const a of attachments) {
        if (!a._file) continue;
        try {
          const { asset } = await Assets.upload(proj.id, a._file);
          ready.push({ type: 'asset', path: asset.path, name: asset.name, size: asset.size, mime: asset.mime });
        } catch (err) {
          showToast(t('{name} 上传失败：{err}', { name: a.name, err: err.message }), 'error');
        }
      }
      // 3. 跳 Workspace 把首条消息 + attachments 塞 location.state；ProjectWorkspace 的
      //    initialMessage useEffect（mount 后 250ms 等 WS 上线）单点负责发首条 turn。
      //    旧实现这里也调 Turn.send 预发一条 → 后端 isNewSession=true 起 session A，
      //    Workspace 上线后又发一条 → 起 session B，导致每次闪聊创 2 个 session。
      // 附件已消费（上传完/失败都算），objectURL 在跳走前回收 —— SPA 跳转
      // 不卸载页面，不收会一直挂到刷新
      attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      // 一个字没写、附件又全传失败：项目已经建出来了，照旧进去，但得说一声
      // 为什么进去之后什么都没发生
      if (!v && ready.length === 0) {
        showToast(t('附件都没传上去，进项目后可以重新上传再说'), 'error');
      }
      navigate(`/projects/${proj.id}/work`, {
        state: { initialMessage: v, attachments: ready },
      });
    } catch (err) {
      showToast(t('创建失败：{err}', { err: err.message }), 'error');
      setSubmitting(false);
    }
  };

  /**
   * 手指设备上**回车就是换行**（2026-08-21）。
   * 手机软键盘没有 Shift，回车一律被判成"发送"，于是在手机上根本写不出第二段；
   * 而这张纸恰恰是让人把想法多写几句的地方。发送交给「开工」——它一直在那儿。
   * 判据用 (pointer: coarse) 不是屏幕宽度：平板是宽屏但一样没有 Shift+Enter。
   */
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isImeEnter(e)) return;
      if (coarse) return;
      e.preventDefault();
      submit();
    }
  };

  const empty = !text.trim() && attachments.length === 0;

  return (
    <>
      <div className="ndd-greet">{greeting}</div>
      {/* 一叠纸（2026-08-28）。页签是**这一叠**的东西，不是最上面那张纸的东西 ——
          所以它跟纸是兄弟、DOM 上排在纸前面 = 层叠上被纸压住，露在纸上沿外面的
          那一截才是能看见的部分。选中那张的签跟纸同色，接口处自然连成一体；没选的
          那张是牛皮色，实实在在被纸压着。两片签因此**从头到尾不动一个像素**。 */}
      <div className={`ndd-stack ${SHEET_CLS[mode]}`}>
        <div className="nd-tabs" role="radiogroup" aria-label={t('项目模式')}>
          <button
            type="button" role="radio" aria-checked={mode === 'design'}
            className={mode === 'design' ? 'on' : undefined}
            onClick={() => pickMode('design')} disabled={submitting}
            title={t('设计：做网页、海报、文档这一类东西')}
          >{t(MODE_LABEL.design)}</button>
          <button
            type="button" role="radio" aria-checked={mode === 'rp'}
            className={mode === 'rp' ? 'on' : undefined}
            onClick={() => pickMode('rp')} disabled={submitting}
            title={t('演出：常驻角色在画布上演故事')}
          >{t(MODE_LABEL.rp)}</button>
        </div>
        {/* 点纸上任何空白都算点进输入框 —— 左边那条页边、上下留白、横线下面那片
            都是纸的一部分，点了没反应会让人以为"这纸不能写" */}
        <div
          className="ndd-pad"
          onMouseDown={(e) => {
            if (e.target.closest('button, textarea, input, a')) return;
            e.preventDefault();
            const ta = ref.current;
            if (!ta) return;
            ta.focus();
            // 从纸面进来时把插入点滚回视野（2026-08-21）。focus() 本身不管滚动，而长文里
            // 插入点很可能停在看不见的地方 —— 那就是"点了纸却没有光标"，用户会以为这纸点不动。
            const h = ta.clientHeight;
            if (!h) return;
            const { y } = measureCaret(ta);
            if (y < 0) ta.scrollTop += y;
            else if (y + CARET_H > h) ta.scrollTop += y + CARET_H - h;
          }}
        >
          <Clip cx="14%" />
          {/* 横线跟 textarea 严丝合缝地同高，见 .ndd-pad .lines 的注释 */}
          <div className="lines">
            {/* 那根红竖线：空框时蹲在起笔位当邀请，打字时跟着插入点走。
                原生 caret 全程让位（见 .ndd-pad textarea 的 caret-color），只有
                输入法组字那几百毫秒交还回去。
                placeholder 前面的 en space 是给它腾的位，第一个字落下来不横跳。
                不聚焦又有字时不画 —— 那时候没人在编辑，一根闪的线是噪音。
                插入点滚出视野时也不画（caretAt.off），否则红线会飘到框外面去。 */}
            {!composing && (!text || focused) && !caretAt.off && (
              <span className="caret" aria-hidden="true"
                style={{ transform: `translate(${caretAt.x}px, ${caretAt.y}px)` }} />
            )}
            <textarea
              ref={ref}
              className={composing ? 'composing' : undefined}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKey}
              // 光标移动（方向键 / 点到中间 / 拖选）走 onSelect，它比 keyup 全
              onSelect={syncCaret}
              onScroll={syncCaret}
              onFocus={() => { setFocused(true); syncCaret(); }}
              onBlur={() => setFocused(false)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => { setComposing(false); syncCaret(); }}
              placeholder={`\u2002${placeholder}`}
              rows={1}
              disabled={submitting}
              style={{ opacity: submitting ? 0.5 : 1 }}
            />
          </div>
          {/* 托盘 + 工具栏收进一个盒子：它们跟正文一样是**写在这张纸上**的东西，
              纸被扯走时要一起掉下去。复制品直接克隆这个节点（见 cloneFoot），
              不照抄一份 JSX —— 照抄的那份迟早跟真的分叉。 */}
          <div className="foot" ref={footRef}>
          <ComposerTray items={attachments} onRemove={handleRemoveAtt} />
          <div className="bar">
            <button
              className="att"
              title={t('上传附件（图片 / PDF / HTML / 等）')}
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
            >
              <Plus size={14} />
            </button>
            {/* 模型选择（2026-08-17，issue #1 第 7 条）：以前只长在会话里的 composer 上，
                首页这一步反而没有 —— 而首页恰恰是**唯一**能决定新会话用哪个模型的地方
                （进了会话之后模型的真相在服务端，这颗按钮改的是本地偏好）。
                往下开：这张纸贴着页顶，往上开会顶出视口。 */}
            <ModelPicker className="model" menuPlacement="down" disabled={submitting} />
            {/* 手指设备上这句是错的（没有 Shift+Enter，回车也不发送），不如不说 */}
            {!coarse && <span className="tip">{t('Enter 发送 · Shift + Enter 换行')}</span>}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.pptx,.docx,.html,.htm,.png,.jpg,.jpeg,.svg,.webp,.md,.txt,.json"
              onChange={(e) => {
                Array.from(e.target.files || []).forEach(handlePickFile);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
            <span style={{ flex: 1 }} />
            <button
              className="go"
              onClick={submit}
              disabled={empty || submitting}
              title={submitting ? t('创建中…') : t('发送（Enter）')}
            >
              {submitting ? t('开 工 中') : t('开 工')}
            </button>
          </div>
          </div>
          {/* 被揭掉的那张：整张纸的复制品（自带一份旧配方，所以不用重写任何皮），
              翻飞出去后 animationend 自己收掉。
              签跟纸是一体的，所以复制品里带**自己那一片**签，跟着纸一起被扯下去；
              另一片占位但不显形（visibility:hidden），让底下真的那片透上来 ——
              槽位不变、露出来的是下一张同类纸的签。
              盖不住回形针和工具栏（两者 z 都比它高）：针别的是整叠，
              +/模型/开工 是这一叠的家什，纸是从它们底下抽走的。 */}
          {peel && (
            <div
              key={peel.id}
              className={`ndd-pad ${SHEET_CLS[peel.from]} ndd-peel`}
              aria-hidden="true"
              onAnimationEnd={() => setPeel((cur) => (cur && cur.id === peel.id ? null : cur))}
            >
              <div className="nd-tabs">
                <span className={peel.from === 'design' ? 'on' : undefined}>{t(MODE_LABEL.design)}</span>
                <span className={peel.from === 'rp' ? 'on' : undefined}>{t(MODE_LABEL.rp)}</span>
              </div>
              <div className="lines" style={{ height: peel.h }}>
                {peel.text || <span className="ph">{`\u2002${peel.ph}`}</span>}
              </div>
              {/* 工具栏的克隆落这儿（useLayoutEffect 里 replaceChildren 塞进来） */}
              <div ref={peelFootRef} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
