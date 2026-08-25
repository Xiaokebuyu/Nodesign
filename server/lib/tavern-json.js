/**
 * tavern-json —— 酒馆（SillyTavern）导出 JSON 的解析与摘要（2026-08-15）
 *
 * 起因是一份真文件：`Izumi 0814.json`，464KB、210 条提示词，而**启用的只有 56 条**
 * （合计约 9.8k 字符）。agent 拿 Read 去读它 = 十几万 token 进上下文换来一堆停用
 * 的备选条目 —— 这不是"贵一点"，是把上下文烧光还看不清结构。所以搬酒馆的东西
 * 进来必须先过这一层：**先给结构摘要，再按需取正文**。
 *
 * 认三种形态（酒馆导出的 JSON 就这几类）：
 *   preset   Chat Completion 预设 —— `prompts[]` + `prompt_order[]`。管的是
 *            "每次请求怎么拼上下文 + 采样参数"，跟我们的 编排.yaml 同类。
 *            条目里那些 0 字的是 **marker**（角色描述/性格/场景/Chat History…），
 *            运行时由酒馆填真内容，搬过来一律丢掉 —— 我们由 编排.yaml 自己管。
 *   card     角色卡 V2（`spec: chara_card_v2`）或 V1。人设、开场白、示例对话，
 *            可能内嵌世界书（character_book）。
 *   lorebook 世界书单独导出 —— `entries`，每条带 keys（触发词）与 constant（常驻）。
 *
 * 只读不写：转成 编排.yaml 和设定文件是 agent 的活，它得按题材决定怎么分组、
 * 哪些不要（破甲话术在我们这条通路上没意义）。
 */

/** 摘要里每条正文最多带多少字的引子 */
const PEEK = 60;

export function detectKind(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (Array.isArray(doc.prompts) && Array.isArray(doc.prompt_order)) return 'preset';
  if (doc.spec === 'chara_card_v2' || doc.spec === 'chara_card_v3') return 'card';
  if (doc.data && typeof doc.data === 'object' && typeof doc.data.first_mes === 'string') return 'card';
  if (typeof doc.first_mes === 'string' && typeof doc.description === 'string') return 'card';
  if (doc.entries && typeof doc.entries === 'object') return 'lorebook';
  return null;
}

const 引 = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, PEEK);
const 字 = (s) => String(s || '').length;

/** 预设：启用的条目按 order 顺序排开，停用的只报个数 */
export function digestPreset(doc) {
  const byId = new Map((doc.prompts || []).map(p => [p.identifier, p]));
  const order = (doc.prompt_order?.[0]?.order) || [];
  const 启用 = [];
  const 停用 = [];
  for (const o of order) {
    const p = byId.get(o.identifier);
    if (!p) continue;
    const 条 = {
      id: p.identifier,
      名字: p.name || p.identifier,
      角色: p.role || 'system',
      字数: 字(p.content),
      占位: p.marker === true,                       // 运行时由酒馆填（角色卡/历史）
      分隔: p.marker !== true && 字(p.content) === 0,  // 纯分节标题（"可选功能开始"这种）
      深度: p.injection_position === 1 ? (p.injection_depth ?? 0) : null,
      引子: 引(p.content),
    };
    (o.enabled ? 启用 : 停用).push(条);
  }
  const 实条 = 启用.filter(e => e.字数 > 0);
  return {
    形态: 'preset',
    参数: {
      temperature: doc.temperature, top_p: doc.top_p, top_k: doc.top_k,
      frequency_penalty: doc.frequency_penalty, presence_penalty: doc.presence_penalty,
      最大上下文: doc.openai_max_context, 最大输出: doc.openai_max_tokens,
      reasoning_effort: doc.reasoning_effort, squash_system_messages: doc.squash_system_messages,
    },
    启用, 停用,
    合计字数: 实条.reduce((n, e) => n + e.字数, 0),
    占位条目: 启用.filter(e => e.占位).map(e => e.名字),
    分隔条目: 启用.filter(e => e.分隔).map(e => e.名字),
  };
}

/** 角色卡：字段清单 + 内嵌世界书条目表 */
export function digestCard(doc) {
  const d = doc.data && typeof doc.data === 'object' ? doc.data : doc;
  const 字段 = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'system_prompt', 'post_history_instructions', 'creator_notes']
    .map(k => ({ 字段: k, 字数: 字(d[k]), 引子: 引(d[k]) }))
    .filter(x => x.字数 > 0);
  const book = d.character_book || doc.character_book || null;
  return {
    形态: 'card',
    名字: d.name || '(无名)',
    字段,
    开场白备选: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.length : 0,
    世界书: book ? digestLorebook(book).条目 : [],
  };
}

/** 世界书：每条的触发词、常驻与否、字数 */
export function digestLorebook(doc) {
  const raw = doc.entries;
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  const 条目 = list.map((e, i) => ({
    id: String(e.uid ?? e.id ?? i),
    名字: e.comment || e.name || (Array.isArray(e.key) ? e.key.join('/') : '') || `条目${i + 1}`,
    触发: Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []),
    常驻: !!(e.constant),
    停用: e.enabled === false || e.disable === true,
    字数: 字(e.content),
    引子: 引(e.content),
  }));
  return { 形态: 'lorebook', 条目 };
}

export function digest(doc) {
  const kind = detectKind(doc);
  if (kind === 'preset') return digestPreset(doc);
  if (kind === 'card') return digestCard(doc);
  if (kind === 'lorebook') return digestLorebook(doc);
  return null;
}

/**
 * 按名字/id 取正文。名字支持部分匹配（酒馆的条目名带 emoji，让 agent 原样抄
 * 一串 emoji 当参数是给自己找麻烦）。
 * @returns {{名字: string, 角色?: string, 正文: string}[]}
 */
export function fetchEntries(doc, 选) {
  const want = (选 || []).map(s => String(s).trim()).filter(Boolean);
  if (!want.length) return [];
  const kind = detectKind(doc);
  let 池 = [];
  if (kind === 'preset') {
    池 = (doc.prompts || []).map(p => ({ id: p.identifier, 名字: p.name || p.identifier, 角色: p.role || 'system', 正文: String(p.content || '') }));
  } else if (kind === 'lorebook' || (kind === 'card' && (doc.data?.character_book || doc.character_book))) {
    const book = kind === 'lorebook' ? doc : (doc.data?.character_book || doc.character_book);
    const list = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
    池 = list.map((e, i) => ({
      id: String(e.uid ?? e.id ?? i),
      名字: e.comment || e.name || (Array.isArray(e.key) ? e.key.join('/') : `条目${i + 1}`),
      正文: String(e.content || ''),
    }));
  }
  if (kind === 'card') {
    const d = doc.data && typeof doc.data === 'object' ? doc.data : doc;
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
      'system_prompt', 'post_history_instructions']) {
      if (d[k]) 池.push({ id: k, 名字: k, 正文: String(d[k]) });
    }
    if (Array.isArray(d.alternate_greetings)) {
      d.alternate_greetings.forEach((g, i) => 池.push({ id: `alt_greeting_${i}`, 名字: `alternate_greetings[${i}]`, 正文: String(g || '') }));
    }
  }
  const 出 = [];
  const 见 = new Set();
  for (const w of want) {
    const hit = 池.find(x => x.id === w) || 池.find(x => x.名字 === w) || 池.find(x => x.名字.includes(w));
    if (hit && !见.has(hit.id)) { 见.add(hit.id); 出.push(hit); }
  }
  return 出;
}

/**
 * PNG 角色卡（2026-08-25，四方世界卡案：iss 上报「不是合法 JSON：�PNG」）。
 * 酒馆的卡就是一张 PNG，角色数据 base64 后塞在 tEXt 块里：V3 用键 `ccv3`，
 * V2 用键 `chara`。两个都在时 ccv3 赢（V3 是超集）。不是卡的普通 PNG 返回 null。
 */
export function extractCardFromPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;   // \x89PNG
  let off = 8;
  const found = {};
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'tEXt' && len > 0 && off + 8 + len <= buf.length) {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = data.toString('latin1', 0, nul);
        if (key === 'ccv3' || key === 'chara') found[key] = data.subarray(nul + 1).toString('latin1');
      }
    }
    off += 12 + len;
    if (type === 'IEND') break;
  }
  const payload = found.ccv3 || found.chara;
  if (!payload) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); } catch { return null; }
}

/**
 * 世界书条目全量（带正文）——给 export_book 机械搬运用。判断归 agent（常驻挑选、
 * 引擎条目丢弃），搬运归机器（375 条 61.8 万字符不该流经上下文）。
 */
export function listBookEntries(doc) {
  const kind = detectKind(doc);
  const book = kind === 'lorebook' ? doc : (doc?.data?.character_book || doc?.character_book);
  if (!book) return [];
  const list = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
  return list.map((e, i) => ({
    id: String(e.uid ?? e.id ?? i),
    名字: e.comment || e.name || (Array.isArray(e.key) ? e.key.join('/') : '') || `条目${i + 1}`,
    触发: Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []),
    常驻: !!(e.constant),
    停用: e.enabled === false || e.disable === true,
    正文: String(e.content || ''),
  }));
}
