#!/usr/bin/env node
/**
 * server/scripts/check-client-boundary.mjs — 客户端 / 服务端边界闸
 *
 * 桌面版和 npm 版把服务端代码装到用户自己机器上。有两类东西不能跟着走：
 * 登录墙 / 注册 / 凭据 / 管理台（用户读得到），以及任何"判决式"的闸（用户改得掉）。
 * 它们住在 server/hosted/，这个脚本保证它们留在那儿。
 *
 * ## 两条检查
 *
 * 1. **方向**：内核（server/ 下除 server/hosted/）不许 import server/hosted/ 里的东西。
 *    hosted 往内核里引可以，反过来不行。单向规则机器判得准，而"记得别引"靠不住。
 *    内核要用 hosted 的东西时，正确做法是 hosted 自己往上挂（中间件 / 注入），不是内核去拿。
 *
 * 2. **分发**：npm 包产物里不许出现 server/hosted/。
 *    ⚠️ 这条**量真实产物**，不读 package.json 的 files 黑名单。实测过：`main` 字段会无视
 *    黑名单把它指向的文件强行打进包（desktop/main.js 就是这么漏出去的）。黑名单说了不算，
 *    产物说了算。
 *
 * 用法：
 *   node server/scripts/check-client-boundary.mjs           # 只查方向（快，进 npm test）
 *   node server/scripts/check-client-boundary.mjs --pack    # 加查分发（进 prepublishOnly）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = path.join(repoRoot, 'server');
const hostedRoot = path.join(serverRoot, 'hosted');

/** 不走的目录：依赖、用户数据、构建产物、实验场 */
const SKIP_DIRS = new Set([
  'node_modules', 'projects-data', 'runs', 'db', '.cache', 'skills', 'ops',
  '.venv-rembg', 'lab', 'ssrf-lab',
  // scripts/ 是站主的运维脚本（发邀请码 / 重置密码 / 量尺），package.json 的 files 和 electron-builder 的 files
  // 都不带它 —— 它本来就站在线的 hosted 那一侧，引 hosted 是应该的
  'scripts',
]);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** 静态 import / re-export（from '...'）与动态 import('...') 分开抓：两者后果不同 */
const STATIC_RE = /\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * 唯一允许的接缝：组合根按 profile 决定要不要加载 hosted。
 *
 * 必须是**动态** import。静态 import 在解析阶段就要求文件存在，而客户端的包里
 * 没有 server/hosted/，那样客户端会直接起不来。动态 import 写在 `if (!isLocal)`
 * 里面，本地版永远不执行，文件不在也无所谓。
 *
 * 这张表要短。每加一条都是在这道闸上开一个口子，加之前先想清楚能不能让 hosted
 * 自己往上挂。
 */
const SEAMS = new Set([
  'server/index.js\u0000./hosted/mount.js',
]);

function checkDirection() {
  const bad = [];
  for (const file of walk(serverRoot)) {
    if (file.startsWith(hostedRoot + path.sep)) continue;   // hosted 自己内部随便引
    const rel = path.relative(repoRoot, file);
    const src = fs.readFileSync(file, 'utf8');
    for (const [re, kind] of [[STATIC_RE, 'static'], [DYNAMIC_RE, 'dynamic']]) {
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;                // 裸包名不是本仓文件
        const resolved = path.resolve(path.dirname(file), spec);
        if (resolved !== hostedRoot && !resolved.startsWith(hostedRoot + path.sep)) continue;
        const line = src.slice(0, m.index).split('\n').length;
        if (kind === 'dynamic' && SEAMS.has(`${rel}\u0000${spec}`)) continue;   // 指名放行的接缝
        const why = kind === 'static'
          ? '静态 import：客户端包里没有这个文件，会崩在解析阶段'
          : '动态 import 但不在 SEAMS 名单里';
        bad.push(`${rel}:${line}  →  ${spec}   （${why}）`);
      }
    }
  }
  return bad;
}

function checkDistribution() {
  // --ignore-scripts：不触发 prepack（那会跑一次 vite build），也避免递归
  const raw = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const files = JSON.parse(raw)[0].files.map((f) => f.path);
  return files.filter((f) => f.startsWith('server/hosted/'));
}

let failed = false;

const direction = checkDirection();
if (direction.length) {
  failed = true;
  console.error('❌ 内核 import 了 server/hosted/（方向必须是 hosted → 内核，不能反过来）：');
  for (const b of direction) console.error(`   ${b}`);
  console.error('   改法：让 hosted 自己把东西挂上去（中间件 / 注入），不要让内核去拿。');
} else {
  console.log('✅ 方向：内核没有 import server/hosted/');
}

if (process.argv.includes('--pack')) {
  const leaked = checkDistribution();
  if (leaked.length) {
    failed = true;
    console.error('❌ npm 包产物里出现了 server/hosted/：');
    for (const f of leaked) console.error(`   ${f}`);
    console.error('   注意：package.json 的 files 黑名单挡不住 main 字段指向的文件。');
  } else {
    console.log('✅ 分发：npm 包产物里没有 server/hosted/');
  }
}

process.exit(failed ? 1 : 0);
