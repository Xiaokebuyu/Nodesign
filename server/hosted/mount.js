/**
 * server/hosted/mount.js —— hosted 外环挂到 express app 上的**唯一**接缝。
 *
 * index.js 只在 !platform.isLocal 时动态 import 这一个文件（server/scripts/check-client-boundary.mjs
 * 的 SEAMS 名单里就它一条）。hosted 里再加什么路由，都从这里往上挂，别再去 index.js 开新口子。
 *
 * 分早晚两段是因为挂载顺序有讲究：
 *   - early：在 express.json **之前**。relay 要原始 body（逐字节转发），全局 JSON 解析器会把流吃掉。
 *     它自己认设备令牌，不依赖 cookie 登录墙。
 *   - late：在 authGuard **之后**。管理台要 req.user。
 */

import { mountRelay } from './relay/router.js';

export function mountHostedEarly(app) {
  // 外审没有 OPENAI_API_KEY 就整道跳过（fail-open）—— 那条告警 lib/moderation.js 加载时已经喊过，这里不重复。
  mountRelay(app, '/api/relay');
}

export async function mountHostedLate(app) {
  const { default: adminRouter } = await import('./admin.js');
  const { default: devicesRouter } = await import('./devices-api.js');
  app.use('/api/admin', adminRouter);
  app.use('/api/me/devices', devicesRouter);   // 跟内核的 /api/me 各管各的前缀，先后无所谓
}
