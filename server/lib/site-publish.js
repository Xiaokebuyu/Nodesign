/**
 * server/lib/site-publish.js — 站点发布核心（2026-08-02）
 *
 * HTTP 路由（api/publish.js）和 agent 的 MCP 工具（publish_site）共用这一套：
 * 闸门（试用号 403 / 每人 2 个）、staging、wrangler deploy、custom domain、记账。
 * agent 走的是**项目 owner** 的额度与权限 —— 谁的项目算谁的，不看是谁触发。
 *
 * # custom domain（<slug>.share.xiaobuyu.trade 这一层）
 * 配置驱动，两个 env 都在才启用，缺一个就退回 <cf_project>.pages.dev：
 *   NODESIGN_PUBLISH_DOMAIN   如 share.xiaobuyu.trade（发布域后缀）
 *   CLOUDFLARE_API_TOKEN      scope：Account.Pages:Edit + Zone.DNS:Edit + Zone:Read
 * 探针实测（2026-08-02）：Pages 给四级域名单独排证书（certificate_authority:
 * google），Universal SSL 只盖一级泛域这件事由 Pages custom domain 流程自己解决；
 * wrangler 的 OAuth 挂 domain 够用但建 DNS 记录 403 —— 所以要独立 token。
 * 域名步骤失败不拉倒整次发布：deploy 已成功就返 pages.dev 地址 + warning。
 */

import { promises as fs } from 'fs';
import path from 'path';
import { makeServerTmpDir } from './server-tmp.js';
import { can, DENIAL } from '../auth/tier.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSharedDir } from '../projects/workspace.js';
import { taskManifest } from './kinds/index.js';
import { walkTaskFiles, loadIgnore } from './task-scan.js';
import { resolveBinary } from '../runtime/capabilities.js';
import { bundleOutsideMedia } from './outside-media.js';
import {
  getPublished, upsertPublished, removePublished,
  countPublishedByUser, cfProjectNameFor, getByCustomDomain, slugify,
} from './publish-store.js';

const execFileAsync = promisify(execFile);
const DEPLOY_TIMEOUT_MS = 180_000;

export function publishLimit() {
  const v = Number(process.env.NODESIGN_USER_PUBLISH_LIMIT);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}

export function validTaskName(name) {
  // `.` 是工作区根上那个站的 key（扁平化后最常见的一种），单独放行；
  // 其余仍然是单层目录名。
  if (name === '.') return true;
  return typeof name === 'string' && name.length > 0
    && !name.includes('/') && !name.includes('..') && !name.startsWith('.');
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** wrangler 跟着服务进程的 node 走（nvm 全局包和 node 同目录），pm2 的 PATH 不可靠 */
function wranglerBin() {
  // 启动探测（runtime/capabilities.js 'publish'）找到的优先（PATH 或 node 同目录）；没探到仍按老规矩猜 node 同目录
  return resolveBinary('publish', path.join(path.dirname(process.execPath), 'wrangler'));
}

async function runWrangler(args) {
  return execFileAsync(wranglerBin(), args, {
    timeout: DEPLOY_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
}

/**
 * 找要发布的目录站点产物（单页试作不可发布）。
 *
 * `key` 扁平化之后是**站点的产物根**：`.` = 工作区根上那个站，`v2` 之类 =
 * 子目录站。发布记录表里的存量数据存的还是旧任务名，那些记录仍然能下线
 * （unpublish 走存下来的 host，不需要重新寻址），但重发布会认不出来 ——
 * 这是可接受的：重发布本来就要用户在界面上点一下当前那个站。
 *
 * root 消歧（main 39ca348 合入，语义照搬）：多个平行站点时不猜。
 *   - 显式传 root（'.' 表示工作区根）→ 精确匹配，匹配不上 400 并列出现有的
 *   - 没传 root：key 匹配 || 只有一个站兜底（旧发布记录兼容）|| 409 列候选
 */
async function resolveSiteRoot(pid, key, root) {
  const workspaceRoot = getSharedDir(pid);
  try { await fs.access(workspaceRoot); } catch { return null; }
  const manifest = await taskManifest(workspaceRoot);
  const sites = (manifest?.artifacts || []).filter(a => a.kind === 'site' && !a.single);
  if (!sites.length) return null;
  const label = (a) => a.root || '.';
  let inst;
  if (typeof root === 'string' && root !== '') {
    const want = root === '.' ? '' : root.replace(/\/+$/, '');
    inst = sites.find(a => (a.root || '') === want);
    if (!inst) {
      throw fail(400, `没有 root 为「${root}」的站点，现有：${sites.map(label).join('、')}`);
    }
  } else {
    const wanted = key === '.' || key === '' || key == null ? '' : String(key).replace(/\/+$/, '');
    inst = sites.find(a => (a.root || '') === wanted)
      || (sites.length === 1 ? sites[0] : null);
    if (!inst) {
      throw fail(409, `工作区里有 ${sites.length} 个平行站点：${sites.map(label).join('、')}`
        + ' —— 用 root 参数指定要发布哪个（工作区根传 "."），不能替你猜');
    }
  }
  return {
    taskDir: workspaceRoot,
    root: inst.root || '',
    rootAbs: inst.root ? path.join(workspaceRoot, inst.root) : workspaceRoot,
  };
}

/** staging：与整站 zip 同语义（产物根 + .ndignore + assets 副本 + 相对路径改写） */
async function stageSite(pid, { taskDir, root, rootAbs }) {
  const stage = await makeServerTmpDir('nd-publish-');
  const ignore = await loadIgnore(taskDir);
  const files = await walkTaskFiles(rootAbs, { maxDepth: 6, ignore, ignoreBase: taskDir });
  let staged = 0;
  const outside = new Map();   // 树外素材（09-18：拖出 assets/ 的生成图）→ 包内落点
  for (const f of files) {
    if (!root && f.rel === 'canvas.html') continue;          // 根站排 deck 保留名
    if (f.rel === '.nd-project.json') continue;
    const dest = path.join(stage, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (/\.(html?|css)$/i.test(f.rel)) {
      const depth = f.rel.split('/').length - 1;
      const up = '../'.repeat(depth);
      const b = bundleOutsideMedia(await fs.readFile(f.abs, 'utf8'), {
        ext: path.extname(f.rel).slice(1).toLowerCase(), pageRel: root ? `${root}/${f.rel}` : f.rel, siteRoot: root, root: taskDir,
      });
      for (const x of b.files) outside.set(x.wsRel, x.bundleRel);
      await fs.writeFile(dest, b.text.replace(/(["'(])(?:\.\.\/)+assets\//g, `$1${up}assets/`));
    } else {
      await fs.copyFile(f.abs, dest);
    }
    staged += 1;
  }
  if (!staged) throw fail(400, '站点没有可发布的文件');
  for (const [wsRel, bundleRel] of outside) {
    const dest = path.join(stage, ...bundleRel.split('/'));
    try { await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(taskDir, ...wsRel.split('/')), dest); } catch { /* 中途被删：页面里本来就会裂 */ }
  }
  // 入口：Pages 认 index.html；没有的话把第一个 html 报出来（也是"发了什么"的一部分）
  const entry = files.some(f => f.rel === 'index.html')
    ? 'index.html'
    : (files.find(f => /\.html?$/i.test(f.rel))?.rel || null);
  const assetsDir = path.join(getSharedDir(pid), 'assets');
  try {
    await fs.cp(assetsDir, path.join(stage, 'assets'), { recursive: true, force: true });
  } catch { /* 没有素材目录就不带 */ }
  // 兜底 404（2026-08-07）：Pages 没有 404.html 时按 SPA 处理，任意路径都回退
  // index.html 返 200 —— 断链和发错站点完全隐形（agent 报障的另一半病根）。
  // NoDesign 的站点是静态多页，不需要 SPA 回退；站点自带 404.html 则不动。
  try {
    await fs.access(path.join(stage, '404.html'));
  } catch {
    await fs.writeFile(path.join(stage, '404.html'),
      '<!doctype html><meta charset="utf-8"><title>404</title>'
      + '<style>body{font-family:system-ui;display:flex;min-height:100vh;margin:0;'
      + 'align-items:center;justify-content:center;color:#5F5142;background:#F5F0E4}</style>'
      + '<p>404 · 这个地址下没有页面</p>');
  }
  return { dir: stage, count: staged, entry };
}

// ── Cloudflare API（custom domain 专用；deploy 本身走 wrangler）──

function domainConfig() {
  const suffix = process.env.NODESIGN_PUBLISH_DOMAIN;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!suffix || !token) return null;
  return {
    suffix,
    token,
    accountId: process.env.NODESIGN_CF_ACCOUNT_ID || 'd49a09c02b1c8f62936fb1db7417b7ca',
    apex: suffix.split('.').slice(-2).join('.'),
  };
}

async function cfApi(cfg, method, urlPath, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const msg = (data.errors || []).map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { cfErrors: data.errors });
  }
  return data.result;
}

let zoneIdCache = null;
async function zoneId(cfg) {
  if (zoneIdCache) return zoneIdCache;
  const zones = await cfApi(cfg, 'GET', `/zones?name=${cfg.apex}`);
  zoneIdCache = zones?.[0]?.id || null;
  if (!zoneIdCache) throw new Error(`zone ${cfg.apex} not found`);
  return zoneIdCache;
}

// 域名 slug 与 Pages 项目名 slug 用**同一份** slugify（publish-store.js）——
// 这两处以前是两份正则、两个截断长度（32 / 24），典型的一件事两份实现。
function hostSlug(name) {
  return slugify(name, 32);
}

/** 用户/agent 自选的域名 slug：小写字母开头、只含小写字母数字连字符、3-32 位 */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * 给已 deploy 的站点挂 <host>.<suffix>：Pages custom domain + 代理 CNAME。
 * host 首选任务名 slug（中文任务名 slug 化常剩空串，退回 hash）；被别的站占了
 * 就带 hash 后缀。幂等：published 记录里已有 custom_domain 就只补挂不换名。
 */
async function ensureCustomDomain({ pid, storeKey, cfProject, existingDomain, slug: wantSlug }) {
  const cfg = domainConfig();
  if (!cfg) return null;
  const hash = cfProject.slice(-6);
  let host;
  if (wantSlug) {
    // 显式点名的域名：撞车就明确报错让人换，**不静默加后缀** —— 用户说"发成 rin"
    // 结果拿到 rin-a1b2c3 是最难受的那种"成功"
    const bare = `${wantSlug}.${cfg.suffix}`;
    const taken = getByCustomDomain(bare);
    if (taken && !(taken.projectId === pid && taken.task === storeKey)) {
      throw fail(409, `域名 ${bare} 已经被别的站点占了，换一个 slug`);
    }
    host = bare;
  } else if (existingDomain) {
    host = existingDomain;
  } else {
    const slug = hostSlug(storeKey === '.' ? '' : storeKey);
    const bare = slug ? `${slug}.${cfg.suffix}` : `${hash}.${cfg.suffix}`;
    const taken = getByCustomDomain(bare);
    host = (taken && !(taken.projectId === pid && taken.task === storeKey))
      ? `${slug ? `${slug}-` : ''}${hash}.${cfg.suffix}`
      : bare;
  }

  // ① Pages 项目挂域名（已挂过会报错 —— 幂等吞掉）
  try {
    await cfApi(cfg, 'POST', `/accounts/${cfg.accountId}/pages/projects/${cfProject}/domains`, { name: host });
  } catch (err) {
    if (!/already|exists|8000015/i.test(err.message)) throw err;
  }
  // ② 代理 CNAME → <cfProject>.pages.dev（已存在同名记录就不重建）
  const zid = await zoneId(cfg);
  const existing = await cfApi(cfg, 'GET', `/zones/${zid}/dns_records?type=CNAME&name=${host}`);
  if (!existing?.length) {
    await cfApi(cfg, 'POST', `/zones/${zid}/dns_records`, {
      type: 'CNAME', name: host, content: `${cfProject}.pages.dev`, proxied: true,
      comment: 'nodesign publish',
    });
  }

  // ③ 换域名：先挂新的、确认挂上了，**再摘旧的**（2026-08-18）。
  // 只挂不摘的话旧域名会变成孤儿 —— CF 上还挂着、DNS 记录还在、还能访问，
  // 而我们的账上已经不认它了。次序不能反：先摘旧的万一新的挂失败，站就没入口了。
  if (existingDomain && existingDomain !== host) {
    try {
      await cfApi(cfg, 'DELETE',
        `/accounts/${cfg.accountId}/pages/projects/${cfProject}/domains/${existingDomain}`);
    } catch (err) {
      if (!/not found|does not exist/i.test(err.message)) throw err;
    }
    try {
      await removeCustomDomainDns({ customDomain: existingDomain });
    } catch (err) {
      console.warn('[publish] 旧域名 DNS 没清干净（新域名已生效）:', err.message);
    }
  }
  return host;
}

/**
 * 等证书就位（2026-08-18）。
 *
 * 四级域名（`x.share.example.com`）Pages 会单独排一张证书，签发之前浏览器和
 * playwright 拿到的是 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` —— 发布完立刻自检
 * 必然撞上，问题库里两个不同 agent 各撞了一次，而以前这里连响应都不看
 * （`await cfApi(...)` 返回值整个丢掉），只能靠文案里写死一句"等一两分钟"。
 *
 * 2026-08-18 实测形状（真跑 chenxi.share.xiaobuyu.trade 抓的）：
 *   { status: 'initializing' → 'pending' → 'active',
 *     validation_data: { status: 'initializing' → 'pending' → 'active', method: 'http' },
 *     verification_data: { status: 'pending' → 'active' },
 *     certificate_authority: 'google' }
 * 全程约 **2.5 分钟**（所以预算给 150s，不是拍脑袋的 45s）。重新发布沿用旧域名时
 * 第一次查就是 active，不会白等。
 * ⚠️ 判据只认 active：认不出的形状一律当"没就绪"，绝不把"我看不懂"说成"已就绪"。
 *
 * @returns {Promise<boolean>} true = 确认可访问；false = 超时/形状不认识
 */
async function waitForCertificate(cfg, cfProject, host, { budgetMs = 150_000, everyMs = 10_000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let loggedShape = false;
  while (Date.now() < deadline) {
    try {
      const info = await cfApi(cfg, 'GET',
        `/accounts/${cfg.accountId}/pages/projects/${cfProject}/domains/${host}`);
      if (!loggedShape) {
        loggedShape = true;
        console.log('[publish] domain status shape:', JSON.stringify(info)?.slice(0, 400));
      }
      const status = String(info?.status || info?.certificate_authority_status || '').toLowerCase();
      const vs = String(info?.validation_data?.status || '').toLowerCase();
      if (status === 'active' && (!vs || vs === 'active' || vs === 'success')) return true;
    } catch { /* 查不到就当还没好，继续等 */ }
    await new Promise(r => setTimeout(r, everyMs));
  }
  return false;
}

/** 从 Pages 项目上摘域名。**必须在删项目之前**：挂着 custom domain 的项目
 * CF 拒删（code 8000028，2026-08-02 实测踩的）。 */
async function detachCustomDomain(site) {
  const cfg = domainConfig();
  if (!cfg || !site.customDomain) return;
  try {
    await cfApi(cfg, 'DELETE',
      `/accounts/${cfg.accountId}/pages/projects/${site.cfProject}/domains/${site.customDomain}`);
  } catch (err) {
    if (!/not found|does not exist/i.test(err.message)) throw err;
  }
}

async function removeCustomDomainDns(site) {
  const cfg = domainConfig();
  if (!cfg || !site.customDomain) return;
  const zid = await zoneId(cfg);
  const records = await cfApi(cfg, 'GET', `/zones/${zid}/dns_records?type=CNAME&name=${site.customDomain}`);
  for (const r of records || []) {
    await cfApi(cfg, 'DELETE', `/zones/${zid}/dns_records/${r.id}`);
  }
}

// ── 主流程 ──

// 同一站点同时只允许一个 deploy 在飞（双击/双开/agent 与人撞车防抖）
const inFlight = new Set();

/**
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.task
 * @param {string} [p.root]  多站点任务点名要发哪个（'.' = 任务根）；单站点可省
 * @param {object} p.user  额度与权限按这个用户算（HTTP = 请求者，MCP = 项目 owner）
 * @returns {{ site, warning: string|null }}
 */
export async function publishSite({ projectId, task, root, slug, user }) {
  if (!validTaskName(task)) throw fail(400, 'invalid task');
  if (slug != null && slug !== '' && !SLUG_RE.test(String(slug))) {
    throw fail(400, `slug 只能是小写字母开头的 3-32 位小写字母/数字/连字符，收到的是「${slug}」`);
  }
  // 档位闸（auth/tier.js）：basic 档（公开注册）不开发布；无主（user 为空）fail-closed。
  // 08-21 前这里猜的是 lifetimeCostLimitUsd（试用码），开放注册号那字段是 null 被放行了。
  if (!can(user, 'publishSite')) throw fail(403, DENIAL.publishSite);

  // ⭐ 2026-08-18 身份收敛：**先寻址，再定 key**。
  // 以前 key 直接用调用方传的 `task`，而 task 在扁平化之后既不参与寻址、也没有
  // 任何校验 —— 于是 agent 把项目 ID 填进去也一路绿灯，落库落出一行
  // task='proj_xxx' 的记录，域名跟着变成 proj-xxx.share.…，而界面按站点根去查
  // 又查不到这一行（显示"未上线"，再点一次就会造出第二个 CF 项目 + 第二个域名）。
  // 收敛之后 key 只有一个来源：**站点的产物根**。task 降级成寻址提示。
  const resolved = await resolveSiteRoot(projectId, task, root);
  if (!resolved) throw fail(400, '这个项目里没有可发布的目录站点');
  const storeKey = resolved.root || '.';

  // slug 撞车要**在部署之前**查出来。ensureCustomDomain 里那道检查跑在 deploy
  // 之后，报错时用户已经白等了一整次 wrangler 部署（59s 起）。那道留着当兜底，
  // 这道负责早失败。
  if (slug) {
    const cfg = domainConfig();
    if (cfg) {
      const want = `${slug}.${cfg.suffix}`;
      const taken = getByCustomDomain(want);
      if (taken && !(taken.projectId === projectId && taken.task === storeKey)) {
        throw fail(409, `域名 ${want} 已经被别的站点占了，换一个 slug`);
      }
    }
  }

  const existing = getPublished(projectId, storeKey);
  if (!existing && user?.role !== 'admin') {
    const used = countPublishedByUser(user?.id);
    if (used >= publishLimit()) {
      throw fail(403, `你已发布 ${used} 个站点（上限 ${publishLimit()}），先下线一个再发`);
    }
  }

  const key = `${projectId}/${storeKey}`;
  if (inFlight.has(key)) throw fail(409, '这个站点正在发布中，稍等');
  inFlight.add(key);
  let stage = null;
  try {
    const staged = await stageSite(projectId, resolved);
    stage = staged.dir;
    const name = existing?.cfProject || cfProjectNameFor(projectId, storeKey);
    try {
      await runWrangler(['pages', 'project', 'create', name, '--production-branch', 'main']);
    } catch (err) {
      const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      if (!/already exists|8000007/i.test(msg)) throw err;
    }
    await runWrangler(['pages', 'deploy', stage, '--project-name', name, '--branch', 'main', '--commit-dirty=true']);

    let customDomain = existing?.customDomain || null;
    let warning = null;
    let certReady = null;
    try {
      customDomain = await ensureCustomDomain({
        pid: projectId, storeKey, cfProject: name, existingDomain: customDomain, slug,
      });
      if (customDomain) {
        const cfg = domainConfig();
        certReady = cfg ? await waitForCertificate(cfg, name, customDomain) : null;
      }
    } catch (err) {
      if (err.status === 409) throw err;      // slug 撞车是调用方要处理的，不能吞
      console.warn('[publish] custom domain failed (deploy 本身成功):', err.message);
      warning = '专属域名没挂上，先用 pages.dev 地址；重新发布会再试';
    }
    const site = upsertPublished({
      projectId, task: storeKey, userId: user?.id ?? null,
      cfProject: name,
      url: customDomain ? `https://${customDomain}` : `https://${name}.pages.dev`,
      customDomain,
    });
    // root / 文件数 / 入口以前都算出来就丢了 —— agent 拿不到"我到底发了哪个站"，
    // 只能 curl 反推（问题库 iss_msc44jfb_bqh6 第 3 条诉求）
    return {
      site, warning, certReady,
      root: storeKey, files: staged.count, entry: staged.entry,
    };
  } finally {
    inFlight.delete(key);
    if (stage) fs.rm(stage, { recursive: true, force: true }).catch(() => { /* 临时目录清理失败不致命 */ });
  }
}

/**
 * 按 key 找已发布记录。**下线路径不重新寻址** —— 站点文件可能已经被删了，
 * 但线上那份还挂着，必须还能摘掉。所以先直查，查不到再试寻址出来的 key
 * （收敛前落的老记录、或者 agent 传了个别名）。
 */
export async function lookupPublished(projectId, key) {
  const direct = getPublished(projectId, key);
  if (direct) return direct;
  try {
    const resolved = await resolveSiteRoot(projectId, key, undefined);
    if (resolved) return getPublished(projectId, resolved.root || '.');
  } catch { /* 寻址不出来就是没有 */ }
  return null;
}

/** @returns {boolean} false = 本来就没发布 */
export async function unpublishSite({ projectId, task }) {
  if (!validTaskName(task)) throw fail(400, 'invalid task');
  const site = await lookupPublished(projectId, task);
  if (!site) return false;
  await detachCustomDomain(site);           // 摘域名必须先于删项目（8000028）
  try {
    await runWrangler(['pages', 'project', 'delete', site.cfProject, '--yes']);
  } catch (err) {
    const msg = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    if (!/not found|does not exist|8000007/i.test(msg)) throw err;
  }
  try {
    await removeCustomDomainDns(site);
  } catch (err) {
    console.warn('[publish] DNS 清理失败（Pages 项目已删，入口已死）:', err.message);
  }
  removePublished(projectId, site.task);   // 按记录里的 key 删，不按调用方传的
  return true;
}
