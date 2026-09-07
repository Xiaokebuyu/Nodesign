/**
 * server/lib/ssrf-guard.js — 出网地址闸（2026-08-18）
 *
 * ## 为什么要有这一层，以及为什么它必须在工具的实现体里
 *
 * agent 能自由指定 URL 的地方（截外部站、驱动浏览器）就是一台 SSRF 机器：它跑在
 * 服务端的网络命名空间里，够得到我们自己的 API、exp 实例、本机各种监听端口、
 * 云元数据地址。
 *
 * ⛔ **沙盒帮不上忙**：MCP 工具的 handler 全在 server 主进程里，而生产
 * `NODESIGN_SANDBOX` 根本没开；即便开了，bwrap 和 `permissions.deny` 管的是 SDK 的
 * Read/Write/Edit/Bash，**管不到 HTTP 路由和 MCP handler 的实现体**。所以这道闸
 * 只能长在工具自己的代码里 —— 好处是 agent 关不掉它（它连沙盒都不碰）。
 *
 * ## 三条判据（缺一条都能被绕过）
 *
 * 1. **按解析出来的 IP 判，不按主机名判。** 词法检查挡得住 `127.0.0.1` 字面量，
 *    挡不住一个 DNS 解析到 127.0.0.1 的公网域名。
 *    （`screenshot-url.js:30-49` 就是纯词法的那一档，这个模块是来替换它的。）
 * 2. **每一个请求都要过，不只是第一个。** 302 的下一跳、iframe、`<img>`、fetch/XHR
 *    的子资源各自都是请求。只查首个 URL 等于只锁前门。
 *    ⛔ **实测推翻过一个想当然的做法**：playwright 的 `context.route('**\/*')`
 *    **不拦跳转的下一跳** —— 本机 302 到 `https://example.com/`，浏览器实际到达了
 *    （`page.url()` 就是它），而 route 只被调用了一次（第一跳）。照那个做法，
 *    `https://evil/` → `http://127.0.0.1:4001/` 会直接穿过去。
 *    改用 **CDP `Fetch.requestPaused`**，实测它拦得到：导航的跳转目标、
 *    **子资源的跳转目标**（`<img>` 302 到元数据）、以及全部子资源。
 *    附带好处：响应体不绕道 node（route.fetch 那条路要代理全部流量，1 vCPU 付不起）。
 * 3. ⭐ **本机自有 IP 也要禁。** 我们的 API 监听的是 `*:4001`（绑所有网卡，`ss` 实查），
 *    所以只禁 `127.0.0.1` 挡不住"绕本机的 LAN/公网 IP 打自己"。
 *
 * ## 已知残余风险（诚实标注）
 *
 * **DNS 重绑定是缓解不是根除。** 我们在 route 层解析一次，playwright 真连的时候
 * 会再解析一次，两次之间存在 TOCTOU 窗口。第二道防线是连上之后看 CDP 报的
 * `remoteIPAddress`，但那已经是"数据可能开始返回"之后的补救。要根除得自己解析→
 * pin 住 IP→带 Host 头连，playwright 的 route 模型做不干净。
 */

import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import { isRegisteredLoopback } from '../engine/process/registry.js';

/** IPv4 段（CIDR），含各类保留段 —— 不只私网，元数据和 CGNAT 也在里面 */
const V4_BLOCKS = [
  ['0.0.0.0', 8],          // 本网络
  ['10.0.0.0', 8],         // RFC1918
  ['100.64.0.0', 10],      // CGNAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local，含 GCP/AWS 元数据 169.254.169.254
  ['172.16.0.0', 12],      // RFC1918
  ['192.0.0.0', 24],       // IETF 协议分配
  ['192.0.2.0', 24],       // TEST-NET-1
  ['192.88.99.0', 24],     // 6to4 relay（已弃用）
  ['192.168.0.0', 16],     // RFC1918
  ['198.18.0.0', 15],      // 基准测试
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // 组播
  ['240.0.0.0', 4],        // 保留（含 255.255.255.255）
];

/** IPv6 前缀（小写、去零压缩前的字面前缀匹配即可覆盖） */
const V6_PREFIXES = ['::1', '::', 'fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', 'ff'];

const v4ToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (Number(o) & 255), 0) >>> 0;

function v4Blocked(ip) {
  const n = v4ToInt(ip);
  for (const [base, bits] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if ((n & mask) === (v4ToInt(base) & mask)) return true;
  }
  return false;
}

/**
 * IPv6 字面量 → 16 字节。**认不出就返 null，调用方要 fail closed。**
 *
 * ⚠️ 为什么不再靠字符串前缀 + 几个正则：那套只认它见过的写法。审查实测三种写法
 * 从第二道闸下直接走过去：
 *   `0:0:0:0:0:0:0:1`（::1 的展开形）、`::7f00:1`（IPv4-compatible 的十六进制形）、
 *   `0177.0.0.1`（八进制的 127.0.0.1）。
 * 第一道闸（checkUrl）因为走 WHATWG URL 规范化不受影响，但第二道闸拿的是
 * CDP 的 `remoteIPAddress`，判据自己得会规范化。**先规范化再判，别列写法。**
 */
function v6Bytes(ip) {
  if (!net.isIPv6(ip)) return null;
  let head = ip, tail = '';
  const dbl = ip.indexOf('::');
  if (dbl !== -1) { head = ip.slice(0, dbl); tail = ip.slice(dbl + 2); }
  const toGroups = (part) => {
    if (!part) return [];
    const gs = part.split(':');
    const out = [];
    for (const g of gs) {
      if (g.includes('.')) {                 // 尾部内嵌的点分四段
        const o = g.split('.').map(Number);
        if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const h = toGroups(head), t = toGroups(tail);
  if (h === null || t === null) return null;
  const fill = 8 - h.length - t.length;
  if (dbl === -1 ? fill !== 0 : fill < 0) return null;
  const groups = [...h, ...new Array(dbl === -1 ? 0 : fill).fill(0), ...t];
  if (groups.length !== 8) return null;
  const b = [];
  for (const g of groups) b.push((g >> 8) & 255, g & 255);
  return b;
}

/** 严格十进制点分四段（不接受前导零/十六进制/少于四段 —— 那些交给 fail closed） */
function strictV4(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  for (const o of p) {
    if (!/^(0|[1-9]\d{0,2})$/.test(o) || Number(o) > 255) return null;
  }
  return ip;
}

/** IPv4-mapped / NAT64 / IPv4-compatible 要**拆开按 v4 判**，否则直接绕过 */
function unwrapV6(ip) {
  const b = v6Bytes(ip);
  if (!b) {
    // NAT64 的 well-known 前缀写法（64:ff9b::a.b.c.d 已被 v6Bytes 覆盖，
    // 这里只兜住 net.isIPv6 认不出的怪写法 → 交给调用方 fail closed）
    return null;
  }
  const zeros12 = b.slice(0, 12).every(x => x === 0);
  const mapped = b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff;
  // 64:ff9b::/96 是 NAT64
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b
    && b.slice(4, 12).every(x => x === 0);
  // ⭐ zeros12 覆盖 `::a.b.c.d` 和 `::7f00:1`（IPv4-compatible，废弃但可路由到 v4）
  if (mapped || nat64 || (zeros12 && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1))) {
    return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }
  return null;
}

/**
 * 本机的地址集合。
 *
 * ⛔ **只枚举网卡是不够的**（2026-08-18 审查攻出来的）：云上是 1:1 NAT，
 * 实例的**公网 IP 根本不在任何网卡上**。实测这台机器网卡只有
 * `127.0.0.1 / ::1 / 10.128.0.12 / fe80::…`，而它的公网 IP 是 35.209.189.19 ——
 * `blockReason` 对它返回 null（放行），发夹 `curl https://<公网IP>:8443/` 真的 200。
 * 也就是说「本机自有 IP 也要禁」那条判据在原来的实现下**形同没有**，
 * 而给它写的那条单元测试是同义反复（枚举 ownAddresses 再断言它们被禁，
 * 结构上不可能失败）。
 *
 * 所以三个来源并起来：
 *   ① 网卡（拿到 loopback 和内网地址）
 *   ② 云元数据里的外部 IP（**我们自己进程去读**，不是让浏览器去读 —— 那个地址
 *      对浏览器是禁的）。取不到就算了，别的环境没这个端点。
 *   ③ `ND_PUBLIC_IP` 环境变量兜底（自建机器、多 IP、或者元数据端点关掉的情况）
 *
 * ⚠️ ② 是**异步**的，所以 `primeOwnAddresses()` 要在启动时调一次；没调也不会崩，
 * 只是少了那一条（同步路径永远拿得到 ① 和 ③）。
 */
/**
 * 网卡枚举**不能永久 memo**：DHCP 续租换地址、加一张网卡、docker0 起来都会变，
 * 而这个进程一跑几周（`enp0s0` 的 `valid_lft` 是几万秒）。缓存久了就是
 * "闸按一份过期的地图判"。30 秒足够摊掉每个子资源都枚举一次的开销。
 * ⚠️ `primed` 单独存：云 NAT 的公网 IP 不在任何网卡上，重新枚举会把它冲掉。
 */
const OWN_TTL_MS = 30_000;
let ownCache = null;
let ownCacheAt = 0;
const primed = new Set();
function baseOwn() {
  const set = new Set(primed);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) set.add(String(a.address).toLowerCase().replace(/%.*$/, ''));
  }
  for (const extra of String(process.env.ND_PUBLIC_IP || '').split(',')) {
    const v = extra.trim().toLowerCase();
    if (v) set.add(v);
  }
  return set;
}
export function ownAddresses() {
  if (!ownCache || Date.now() - ownCacheAt > OWN_TTL_MS) {
    ownCache = baseOwn();
    ownCacheAt = Date.now();
  }
  return ownCache;
}

/**
 * 把云元数据里的外部 IP 也加进来。启动时调一次（失败静默 —— 不是所有环境都有）。
 * @returns {Promise<string|null>} 加进来的那个 IP
 */
export async function primeOwnAddresses({ timeoutMs = 1500 } = {}) {
  const set = ownAddresses();
  const url = 'http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip';
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const ip = (await res.text()).trim().toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      primed.add(ip);   // 存进不会被重新枚举冲掉的那一份
      set.add(ip);
      console.log(`[ssrf-guard] 本机公网 IP ${ip} 已加入禁止集（云 NAT 下它不在任何网卡上）`);
      return ip;
    }
  } catch { /* 没这个端点 / 超时：正常 */ }
  return null;
}

/**
 * 这个 IP 该不该禁。
 * @returns {string|null} 禁的理由；null = 放行
 */
export function blockReason(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return 'empty address';
  const ip = rawIp.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');

  if (ownAddresses().has(ip)) {
    return `${ip} is this machine's own address (our API listens on *:PORT — reaching it via any local NIC is the same as reaching localhost)`;
  }
  if (ip.includes('.') && !ip.includes(':')) {
    // ⭐ **严格十进制才放过判定**。`0177.0.0.1` 是八进制的 127.0.0.1，
    // 老的 `\d+\.\d+\.\d+\.\d+` 正则会把它当合法四段、按 `177` 去算 → 放行。
    const v4 = strictV4(ip);
    if (!v4) return `${rawIp} is not a canonical IPv4 address (leading zeros / hex forms are refused rather than guessed)`;
    return v4Blocked(v4) ? `${ip} is a private/reserved IPv4 address` : null;
  }
  if (ip.includes(':')) {
    const v4 = unwrapV6(ip);
    if (v4) {
      if (ownAddresses().has(v4)) return `${ip} maps to this machine's own address`;
      return v4Blocked(v4) ? `${ip} maps to private IPv4 ${v4}` : null;
    }
    // 规范化成 8 组再判，别拿字面量比前缀 —— `0:0:0:0:0:0:0:1` 就是 `::1`
    const b = v6Bytes(ip);
    if (!b) return `${rawIp} is not a canonical IPv6 address`;
    const canon = [];
    for (let i = 0; i < 16; i += 2) canon.push(((b[i] << 8) | b[i + 1]).toString(16));
    const loopback = b.slice(0, 15).every(x => x === 0) && b[15] === 1;
    const unspecified = b.every(x => x === 0);
    if (loopback || unspecified) return `${ip} is the IPv6 loopback/unspecified address`;
    if (ownAddresses().has(canon.join(':').replace(/(^|:)(0:)+/, '::').replace(/::+/, '::'))) {
      return `${ip} is this machine's own address`;
    }
    const first = b[0];
    // fc00::/7 唯一本地、fe80::/10 链路本地、ff00::/8 组播
    if ((first & 0xfe) === 0xfc) return `${ip} is a unique-local IPv6 address (fc00::/7)`;
    if (first === 0xfe && (b[1] & 0xc0) === 0x80) return `${ip} is a link-local IPv6 address (fe80::/10)`;
    if (first === 0xff) return `${ip} is an IPv6 multicast address`;
    return null;
  }
  return `${rawIp} is not an IP address`;   // 调用方该先解析
}

/** 只允许这两个 scheme 发起网络请求；data:/blob: 不出网所以另算 */
const NET_SCHEMES = new Set(['http:', 'https:']);
const OFFLINE_SCHEMES = new Set(['data:', 'blob:', 'about:']);
/**
 * Chromium 内置 PDF viewer（component extension，id 硬编码在 Chromium 源里）。
 * 它渲染 PDF 时会加载自己的静态资源（pdf_embedder.css 等）——不出网、出不了扩展
 * 包目录，跟 file:// 不是一个量级。不放行的话浏览器里所有 PDF 都渲染不出来
 * （08-24 案）。⚠️ 只放这个 id：别的 chrome-extension:// 照旧拒 + 记账，
 * 将来谁 --load-extension 也不会自动继承放行。
 */
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

/**
 * 一个 URL 能不能让浏览器去。**解析 DNS 后逐个 IP 判**。
 * @returns {Promise<{ok: true, ips: string[]} | {ok: false, reason: string}>}
 */
/**
 * 主机名 → 判定结果的短期缓存。**只缓 DENY，不缓 ALLOW。**
 *
 * 一个页面几十个子资源，每个都查一次 DNS 在 1 vCPU 上不划算。但缓存方向不对称：
 *
 * ⛔ 原来两种都缓，注释写的是「TTL 内认一次结果，**缩小**了两次解析之间答案变了
 *    的窗口」。这句话只在「先 DENY 后翻成公网」时成立。反方向 ——
 *    **先拿一个公网名骗到 ALLOW，再把解析翻向 127.0.0.1** —— 缓存把窗口从
 *    「两次 DNS 之间」**放大成保证的 30 秒**：这道闸在 30 秒里根本不查 DNS。
 *    审查时确定性复现过。
 * ⭐ 缓 DENY 没有这个方向问题：最坏是把一个刚变干净的主机多拦 30 秒。
 *    拦错了的代价是"看不到一个参考站"，放错了的代价是内网。
 *
 * 真正的强制点在 `lib/browse-proxy.js`：它**每个请求**重解析并连**验过的那个 IP**
 * （不给系统第二次解析的机会），所以常驻浏览器那条路对重绑定是免疫的。这里的
 * checkUrl 是预筛 + `screenshot_url` 用（后者也已经走同一个代理）。
 */
const HOST_TTL_MS = 30_000;
const hostCache = new Map();   // host → { at, verdict }

export async function checkUrl(raw, { timeoutMs = 4000 } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: `not a valid URL: ${raw}` }; }

  if (OFFLINE_SCHEMES.has(u.protocol)) return { ok: true, ips: [] };   // 不出网
  if (String(raw).startsWith(PDF_VIEWER_ORIGIN)) return { ok: true, ips: [] };  // 内置 PDF viewer 自身资源，不出网
  if (!NET_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `scheme ${u.protocol} is not allowed (only http/https; file:// would read local files)` };
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 进程卡（2026-09-07 桌面端·缝三）：agent 自己起的 dev server 就在本机，端口在登记表里的
  // loopback 放行。只认 localhost / 127.0.0.1 / ::1 三个写法 + 登记表里在跑的端口；
  // 别的本机地址（内网 IP、公网 IP 打自己）照旧拒 —— 这条口子只开给自己起的进程。
  if (u.port && isRegisteredLoopback(host, u.port)) return { ok: true, ips: ['127.0.0.1'] };
  // 字面量 IP 不用解析（也别交给 DNS —— 有些解析器会对畸形量做意外的事）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    const why = blockReason(host);
    return why ? { ok: false, reason: why } : { ok: true, ips: [host] };
  }
  // `.local` 是 mDNS，只可能指向局域网
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, reason: `${host} resolves inside the local network` };
  }

  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.verdict;

  let addrs;
  try {
    addrs = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), timeoutMs)),
    ]);
  } catch (err) {
    // kind:'dns' 给上层分文案用：解析失败不是策略拦截，别让调用方把这两种拒
    // 混着说（agent 上报时曾据「硬边界」措辞推出一整套错误的排障理论）
    return { ok: false, reason: `cannot resolve ${host}: ${err.message}`, kind: 'dns' };
  }
  if (!addrs.length) return { ok: false, reason: `${host} resolved to nothing`, kind: 'dns' };

  // ⭐ **任一**地址落在禁止段就整个拒。多 A 记录里混一条 127.0.0.1 是标准的
  // DNS-rebinding 起手式，"挑一个能用的"等于自己把门打开。
  let verdict = { ok: true, ips: addrs.map(a => a.address) };
  for (const a of addrs) {
    const why = blockReason(a.address);
    if (why) { verdict = { ok: false, reason: `${host} → ${why}` }; break; }
  }
  if (!verdict.ok) {   // 只缓 DENY，见上面
    hostCache.set(host, { at: Date.now(), verdict });
    if (hostCache.size > 500) hostCache.delete(hostCache.keys().next().value);
  }
  return verdict;
}

/**
 * 把闸装到一个 playwright BrowserContext 上。两道防线：
 *
 * ① **CDP `Fetch.requestPaused`** —— 每个请求（含每个跳转下一跳、iframe、子资源）
 *    在**发出之前**被暂停，按解析出的 IP 判，不过就 `Fetch.failRequest`。
 *    为什么不是 playwright 的 `context.route`：实测它看不到跳转的下一跳（见文件头）。
 * ② CDP `Network.responseReceived` 的 `remoteIPAddress` —— 真连上之后再看一眼对端，
 *    挡第一道之后被重绑定掉的那种。**这是补救不是预防**：走到这里数据可能已经在返回。
 *
 * ⚠️⚠️ **`armPage` 必须 await 完才能让那个页面导航。**
 * 第一版把装闸挂在 `context.on('page')` 里 fire-and-forget，结果**攻出一个初始化
 * 竞态**：`newPage()` 之后立刻 goto，`Fetch.enable` 还没握手完，第一次导航整个
 * 穿过第一道闸 —— 实测直接到达了 `169.254.169.254`，闸零记账（救回来的是第二道，
 * 而那时数据已经在返回了）。所以现在装闸是**调用方必须显式 await 的动作**。
 * 我们自己造页面，所以这条能保证；**没经过 armPage 的页面（比如 target=_blank
 * 弹窗）一律立刻关掉** —— 一个没装闸的页面就是一个洞，宁可功能少一点。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {(ev: {url: string, reason: string, stage: string}) => void} [onBlocked]
 * @returns {Promise<{ blocked: Array, armPage: (page) => Promise<void> }>}
 */
export async function attachSsrfGuard(context, onBlocked, { proxied = false } = {}) {
  const blocked = [];
  const armed = new WeakSet();
  const note = (url, reason, stage) => {
    const rec = { url: String(url).slice(0, 300), reason, stage };
    blocked.push(rec);
    if (blocked.length > 200) blocked.shift();
    try { onBlocked?.(rec); } catch { /* 记账不能变成新故障源 */ }
  };

  async function armPage(page) {
    if (armed.has(page)) return;
    const cdp = await context.newCDPSession(page);   // 抛错就让调用方知道（别静默假装装上了）

    cdp.on('Fetch.requestPaused', async (ev) => {
      // ⚠️ **每条路径都必须落到 continueRequest 或 failRequest 上**。handler 里抛错
      // 会让这个请求**永远暂停**，浏览器一直等 —— 症状跟"网站很慢"一模一样，
      // 真跑时撞过一次 30 秒超时。
      const id = ev.requestId;
      const url = ev.request?.url || '(unknown)';
      try {
        const verdict = await checkUrl(url);
        if (verdict.ok) return await cdp.send('Fetch.continueRequest', { requestId: id });
        note(url, verdict.reason, 'request');
        return await cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'AccessDenied' });
      } catch (err) {
        if (/closed|Target|detached|Session/i.test(err?.message || '')) return;   // 正常竞态
        // 判不出来就**拒**（fail-closed）：安全闸不能因为自己出错而放行
        note(url, `guard error, denied by default: ${err?.message || err}`, 'request');
        try { await cdp.send('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }); } catch { /* */ }
      }
    });

    // 第二道只在**没有代理**的通道上有意义。
    // ⚠️ 真跑抓到的：挂了 browse-proxy 之后每个响应的 `remoteIPAddress` 都是代理
    // 自己（127.0.0.1），于是这道兜底把**每个页面**都掐掉了。而它本来防的是
    // 「请求阶段判过之后 DNS 被翻掉」—— 代理会自己解析并**连那个验过的 IP**（pin），
    // 重绑定在那条路上结构性不可能，所以这道检查在代理下是纯冗余。
    if (!proxied) {
      cdp.on('Network.responseReceived', (ev) => {
        const ip = ev?.response?.remoteIPAddress;
        if (!ip) return;
        const why = blockReason(ip);
        if (!why) return;
        note(ev.response.url, `connected to ${why}`, 'connected');
        page.close().catch(() => {});   // 已经连上了，能做的只有立刻掐掉
      });
    }

    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    armed.add(page);
  }

  // 没经过 armPage 的页面（弹窗）立刻关掉。给 armPage 一个微任务的机会先登记，
  // 免得把我们自己刚造的页面误杀。
  context.on('page', (p) => {
    setTimeout(() => {
      if (armed.has(p) || p.isClosed()) return;
      note(p.url() || '(popup)', 'popup was not armed with the network guard — closed', 'popup');
      p.close().catch(() => {});
    }, 250);
  });

  for (const p of context.pages()) await armPage(p);
  return { blocked, armPage };
}
