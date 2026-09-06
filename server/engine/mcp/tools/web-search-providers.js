/**
 * mcp/tools/web-search-providers.js —— web_search 的供应商层：四家适配器 + 按语言选家 + 一次搜索的执行。
 *
 * 09-07 从 web-search.js 拆出来，因为这一段要被**两处**调用：
 *   - 工具本体（本机有 key 时直接搜）
 *   - hosted relay 的 POST /api/relay/tools/web_search（桌面版没有 key，网关用站主的 key 替它搜，按账号计次）
 * 工具本体只剩"选路（本机 / relay）→ 下参考图 → 排版"。
 *
 * key 配置（.env，至少配一个）：NODESIGN_BAIDU_QIANFAN_KEY / NODESIGN_TAVILY_KEY / NODESIGN_EXA_KEY / NODESIGN_ZHIPU_KEY
 */

export const PROVIDERS = {
  tavily: { keyEnv: 'NODESIGN_TAVILY_KEY' },
  exa:    { keyEnv: 'NODESIGN_EXA_KEY' },
  baidu:  { keyEnv: 'NODESIGN_BAIDU_QIANFAN_KEY' },
  zhipu:  { keyEnv: 'NODESIGN_ZHIPU_KEY' },
};

const PRIORITY_CJK = ['baidu', 'tavily', 'exa', 'zhipu'];
const PRIORITY_NON_CJK = ['tavily', 'exa', 'baidu', 'zhipu'];

export function looksChinese(text) {
  // U+4E00-U+9FFF Unified CJK
  return /[一-鿿]/.test(text || '');
}

export function getKey(providerId) {
  const env = PROVIDERS[providerId]?.keyEnv;
  return env ? (process.env[env] || '') : '';
}

export function autoSelectProvider(query) {
  const order = looksChinese(query) ? PRIORITY_CJK : PRIORITY_NON_CJK;
  for (const id of order) if (getKey(id)) return id;
  return null;
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── adapters ──

async function searchTavily(query, key, n, { includeImages = false } = {}) {
  const body = {
    query,
    search_depth: includeImages ? 'advanced' : 'basic',
    topic: 'general',
    max_results: n,
    include_answer: false,
    include_raw_content: false,
  };
  if (includeImages) {
    body.include_images = true;
    body.include_image_descriptions = true;
    body.include_favicon = true;
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError('tavily', res.status, await res.text());
  const raw = await res.json();
  const hits = (raw.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    source: domainOf(r.url || ''),
    publishedAt: r.published_date || '',
  }));
  const images = includeImages
    ? (raw.images || [])
        .filter(i => i?.url)
        .map(i => ({
          url: i.url,
          description: i.description || '',
          title: i.title || '',
        }))
    : [];
  return { hits, images };
}

async function searchExa(query, key, n, { includeImages = false } = {}) {
  // Exa 顶层是 camelCase（numResults / maxCharacters / imageLinks），
  // 旧字段 num_results 仍兼容，新功能用官方约定的 camelCase。
  const contents = {
    highlights: { maxCharacters: 4000 },
  };
  if (includeImages) {
    contents.extras = { imageLinks: Math.max(3, n) };
  }
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: n,
      contents,
    }),
  });
  if (!res.ok) throw new ProviderError('exa', res.status, await res.text());
  const raw = await res.json();
  const hits = (raw.results || []).map(r => {
    const highlights = r.highlights || [];
    return {
      title: r.title || '',
      url: r.url || '',
      snippet: highlights[0] || r.text || '',
      source: domainOf(r.url || ''),
      publishedAt: r.publishedDate || '',
    };
  });
  // images: results[].image（页面代表图）+ results[].extras.imageLinks（页面内抽图），dedupe by url
  const images = [];
  if (includeImages) {
    const seen = new Set();
    for (const r of (raw.results || [])) {
      const parentTitle = r.title || '';
      // 1) 页面代表图（每条最多 1 张）
      if (r.image && !seen.has(r.image)) {
        seen.add(r.image);
        images.push({ url: r.image, description: parentTitle, title: parentTitle });
      }
      // 2) 页面内抽到的图片链接（无描述，用 parent title 兜底）
      const links = r.extras?.imageLinks || [];
      for (const link of links) {
        if (!link || seen.has(link)) continue;
        seen.add(link);
        images.push({ url: link, description: parentTitle, title: parentTitle });
      }
    }
  }
  return { hits, images };
}

async function searchBaidu(query, key, n, { includeImages = false } = {}) {
  // Baidu Qianfan content 字段硬上限 72 字符
  const truncated = query.length > 72 ? query.slice(0, 72) : query;
  const body = {
    messages: [{ role: 'user', content: truncated }],
  };
  if (includeImages) {
    // 默认 image.top_k=0；必须显式声明才返图。同时保留 web 模态拿 hits。
    body.search_source = 'baidu_search_v2';
    body.resource_type_filter = [
      { type: 'web', top_k: n },
      { type: 'image', top_k: Math.min(30, Math.max(n, 10)) },
    ];
  }
  const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError('baidu', res.status, await res.text());
  const raw = await res.json();
  let results = raw.search_results || raw.results || [];
  if (!Array.isArray(results) || results.length === 0) {
    results = raw.references || [];
  }
  // 把 web 与 image 两类拆开：image 模态是 type==='image'
  const webRefs = results.filter(r => (r?.type || 'web') !== 'image');
  const imageRefs = results.filter(r => r?.type === 'image');

  const hits = webRefs.slice(0, n).map(r => ({
    title: r.title || '',
    url: r.url || r.link || '',
    snippet: r.content || r.abstract || r.segment_text || '',
    source: r.source || domainOf(r.url || r.link || ''),
    publishedAt: r.publish_time || '',
  }));

  const images = [];
  if (includeImages) {
    const seen = new Set();
    // 1) 图片模态条目
    for (const r of imageRefs) {
      const u = r.image?.url || r.url;
      if (!u || seen.has(u)) continue;
      seen.add(u);
      images.push({
        url: u,
        description: r.title || '',
        title: r.title || '',
      });
    }
    // 2) 网页条目里夹带的相关图（web_extensions.images）
    for (const r of webRefs) {
      const arr = r.web_extensions?.images || [];
      for (const img of arr) {
        const u = img?.url;
        if (!u || seen.has(u)) continue;
        seen.add(u);
        images.push({
          url: u,
          description: r.title || '',
          title: r.title || '',
        });
      }
    }
  }
  return { hits, images };
}

async function searchZhipu(query, key, n) {
  // 用 dedicated tools/web_search endpoint（比 chat completions 路径更直接）
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/tools/web_search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      search_engine: 'search_pro',
      search_query: query,
      count: n,
    }),
  });
  if (!res.ok) throw new ProviderError('zhipu', res.status, await res.text());
  const raw = await res.json();
  const hits = (raw.search_result || []).slice(0, n).map(r => ({
    title: r.title || '',
    url: r.link || r.url || '',
    snippet: r.content || '',
    source: r.media || domainOf(r.link || r.url || ''),
    publishedAt: '',
  }));
  return { hits, images: [] };
}

const ADAPTERS = {
  tavily: searchTavily,
  exa: searchExa,
  baidu: searchBaidu,
  zhipu: searchZhipu,
};

export class ProviderError extends Error {
  constructor(provider, code, body) {
    super(`[${provider}] HTTP ${code}: ${String(body || '').slice(0, 300)}`);
    this.provider = provider;
    this.code = code;
  }
}

/** 本机配了任何一家的 key（有 key 才能在本机搜） */
export function hasAnySearchKey() {
  return Object.keys(PROVIDERS).some((id) => !!getKey(id));
}

/**
 * 选家。include_images 时 zhipu 不在候选（它不出图）；点名的家没 key 就换配了的顶上（结果 > 供应商身份）。
 * @returns {{ providerId: string, providerNote: string } | { error: string }}
 */
export function pickSearchProvider({ query, provider = 'auto', includeImages = false }) {
  const order = (looksChinese(query) ? PRIORITY_CJK : PRIORITY_NON_CJK).filter((id) => !includeImages || id !== 'zhipu');
  const firstConfigured = order.find((id) => getKey(id)) || null;
  if (includeImages && provider === 'zhipu') {
    return { error: 'web_search failed: provider "zhipu" does not support image search. Use tavily / exa / baidu, or omit provider for auto-routing.' };
  }
  if (provider === 'auto') {
    if (firstConfigured) return { providerId: firstConfigured, providerNote: '' };
    return { error: includeImages
      ? `web_search failed (include_images=true): no image-capable provider configured. Set at least one of ${['tavily', 'exa', 'baidu'].map((id) => PROVIDERS[id].keyEnv).join(' / ')}`
      : `web_search failed: no provider configured. Set at least one of ${Object.values(PROVIDERS).map((p) => p.keyEnv).join(' / ')} in NoDesign .env.` };
  }
  if (getKey(provider)) return { providerId: provider, providerNote: '' };
  if (!firstConfigured) return { error: `web_search failed: ${PROVIDERS[provider]?.keyEnv || provider} not set, and no other${includeImages ? ' image-capable' : ''} provider configured.` };
  return { providerId: firstConfigured, providerNote: `（provider "${provider}" 没配 key，已换用 ${firstConfigured}）` };
}

/**
 * 一次搜索：选家 + 调适配器。返回 hits / images 原始数据（不下图、不排版），两处调用方各自处理。
 * 供应商 HTTP 错误抛 ProviderError（调用方按 code 提示 401/429）。
 * @returns {Promise<{ providerId, providerNote, hits: object[], images: object[] } | { error: string }>}
 */
export async function runWebSearch({ query, provider = 'auto', count = 5, includeImages = false }) {
  const pick = pickSearchProvider({ query, provider, includeImages });
  if (pick.error) return pick;
  const adapter = ADAPTERS[pick.providerId];
  const result = await adapter(query, getKey(pick.providerId), count, pick.providerId === 'zhipu' ? undefined : { includeImages });
  return { providerId: pick.providerId, providerNote: pick.providerNote, hits: result.hits || [], images: result.images || [] };
}
