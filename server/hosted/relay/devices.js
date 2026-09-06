/**
 * server/hosted/relay/devices.js — 设备令牌（桌面版拿它访问服务器的 relay）
 *
 * ## 为什么不复用 auth/session.js 的那套 token
 *
 * 那套是**浏览器会话**：无服务端存储、30 天自动过期、靠 cookie 传、重启不掉登录态。
 * 它的撤销手段只有停用整个账号。桌面版不一样：令牌落在用户硬盘上、跟着一台具体的
 * 机器、要能单独吊销（换电脑了 / 令牌泄露了 / 只想踢掉某一台），所以它必须**有存储**。
 * 两者形状相反，共用一份会把两边都拧歪。
 *
 * ## 令牌形状
 *
 *   ndk_<deviceId>.<secret>
 *
 * deviceId 明文在前，用来直接查行，不用扫全表。secret 只在签发那一刻出现一次，
 * 库里只留 sha256。丢了就重新签一个，我们没有办法"找回"，这是故意的。
 *
 * ⚠️ 比对用 timingSafeEqual。普通 === 的耗时随前缀匹配长度变化，够一个有耐心的人
 * 一个字节一个字节把 secret 试出来。
 *
 * ## 它证明的是"哪台机器"，不是"能干什么"
 *
 * 校验只回答两件事：这个令牌属于谁、这台设备还有效吗。能不能用某个模型、额度够不够、
 * 内容过不过审，全在 relay 的闸链里判，不在这里。把授权塞进认证是两件事混一起，
 * 加一档权限就要动认证代码。
 */

import crypto from 'node:crypto';
import db from '../../engine/runs/store.js';
import { getUserById } from '../../auth/users-store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS relay_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT,
    secret_hash TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_relay_devices_user ON relay_devices(user_id);
`);

const PREFIX = 'ndk_';
/** 每人同时在用的设备上限（网页签发与桌面登录两条路共用这一个数） */
export const MAX_DEVICES = 10;
/** last_seen_at 的写入节流：每请求写一次库太热，5 分钟内不重复写 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 签发一台设备的令牌。**明文只在这里出现一次**，调用方负责交给用户，不要落日志。
 * @returns {{ device: object, token: string }}
 */
export function mintDevice({ userId, label = null }) {
  if (!userId) throw new Error('mintDevice: userId 必填');
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO relay_devices (id, user_id, label, secret_hash) VALUES (?, ?, ?, ?)')
    .run(id, userId, label, sha256(secret));
  return { device: getDevice(id), token: `${PREFIX}${id}.${secret}` };
}

export function getDevice(id) {
  return db.prepare('SELECT * FROM relay_devices WHERE id = ?').get(id) || null;
}

export function listDevices(userId) {
  return db.prepare('SELECT id, user_id, label, revoked, created_at, last_seen_at FROM relay_devices WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

/** 吊销一台设备。软删：留着行，翻记录能看到这台机器什么时候被踢的 */
export function revokeDevice(id) {
  return db.prepare('UPDATE relay_devices SET revoked = 1 WHERE id = ?').run(id).changes > 0;
}

/**
 * 校验令牌。任何一步不对都返回 null，**不区分原因** —— 对着调用方区分
 * "设备不存在"和"密钥不对"，等于告诉试探的人他猜对了一半。
 *
 * @returns {{ device: object, user: object } | null}
 */
export function verifyDeviceToken(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const dot = token.indexOf('.', PREFIX.length);
  if (dot < 0) return null;
  const id = token.slice(PREFIX.length, dot);
  const secret = token.slice(dot + 1);
  if (!id || !secret) return null;

  const device = getDevice(id);
  if (!device || device.revoked) return null;

  const want = Buffer.from(device.secret_hash, 'utf8');
  const got = Buffer.from(sha256(secret), 'utf8');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;

  // 账号停用了，这台设备的令牌立刻失效 —— 停用是账号级判决，不该要求逐台吊销
  const user = getUserById(device.user_id);
  if (!user || user.disabled) return null;

  touch(device);
  return { device, user };
}

function touch(device) {
  const last = device.last_seen_at ? Date.parse(device.last_seen_at + 'Z') : 0;
  if (Number.isFinite(last) && Date.now() - last < TOUCH_INTERVAL_MS) return;
  db.prepare("UPDATE relay_devices SET last_seen_at = datetime('now') WHERE id = ?").run(device.id);
}

/** 从请求头取令牌。SDK 把 ANTHROPIC_AUTH_TOKEN 发在 Authorization: Bearer，x-api-key 也认 */
export function tokenFromRequest(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const key = req.headers?.['x-api-key'];
  return typeof key === 'string' && key ? key.trim() : null;
}
