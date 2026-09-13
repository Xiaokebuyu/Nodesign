/**
 * server/hosted/auth/client-ip.js — 请求来源 IP（登录限频、验证码限频、审计共用一份判据）
 *
 * ⛔ 不看 X-Forwarded-For：它的第一跳是客户端自报的（CF / nginx 都是追加不是覆盖），
 * 随机填一个就绕过注册限流和登录锁（08-21 fable 评审）。可信顺序：CF 的 cf-connecting-ip
 * → nginx 写的 X-Real-IP（$remote_addr，是对端不是自报）→ socket。
 * 生产 nginx 对这两个头都是覆盖写（proxy_set_header），客户端自带的进不来。
 */
export function clientIp(req) {
  const cf = req?.headers?.['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const real = req?.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return req?.socket?.remoteAddress || 'unknown';
}
