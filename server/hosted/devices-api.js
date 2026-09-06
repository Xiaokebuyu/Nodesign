/**
 * server/hosted/devices-api.js —— 网页版给自己签发 / 查看 / 吊销设备令牌（/api/me/devices）。
 *
 * 走 cookie 登录墙（挂在 authGuard 之后，req.user 已在）。令牌明文只在 POST 的响应里出现一次，
 * 之后只能看到 id / 标签 / 上次使用时间；丢了就吊销再签一枚。
 *
 * 桌面版 / npx 版拿到令牌后填进设置页「NoDesign 服务 → 设备令牌」（runtime/local-env.js），
 * 之后它的推理请求就带着这枚令牌走 /api/relay（hosted/relay/router.js）。
 */

import express from 'express';
import { mintDevice, listDevices, getDevice, revokeDevice } from './relay/devices.js';

const MAX_DEVICES = 10;
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ devices: listDevices(req.user.id).map(pub) });
});

router.post('/', (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
  const active = listDevices(req.user.id).filter((d) => !d.revoked);
  if (active.length >= MAX_DEVICES) return res.status(409).json({ error: `最多 ${MAX_DEVICES} 台在用的设备，先吊销一台`, code: 'TOO_MANY_DEVICES' });
  const { device, token } = mintDevice({ userId: req.user.id, label: label || null });
  res.status(201).json({ device: pub(device), token });
});

router.delete('/:id', (req, res) => {
  const d = getDevice(req.params.id);
  // 不是自己的当不存在：别告诉人家这个 id 存在
  if (!d || d.user_id !== req.user.id) return res.status(404).json({ error: '没有这台设备', code: 'NOT_FOUND' });
  revokeDevice(d.id);
  res.json({ ok: true });
});

function pub(d) {
  return { id: d.id, label: d.label, revoked: !!d.revoked, createdAt: d.created_at, lastSeenAt: d.last_seen_at };
}

export default router;
