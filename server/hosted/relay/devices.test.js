import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import db from '../../engine/runs/store.js';
import { updateUser } from '../../auth/users-store.js';
import {
  mintDevice, verifyDeviceToken, revokeDevice, listDevices, getDevice, tokenFromRequest,
} from './devices.js';

/** 直接插用户：createUser 要走密码哈希与用户名校验，这里测的不是那些 */
function makeUser({ disabled = 0 } = {}) {
  const id = 'u_' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users (id, username, password_hash, role, disabled) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, 'x', 'user', disabled);
  return id;
}

let userId;
beforeAll(() => { userId = makeUser(); });

describe('设备令牌', () => {
  it('签发后能校验回同一个人', () => {
    const { device, token } = mintDevice({ userId, label: '笔记本' });
    const got = verifyDeviceToken(token);
    expect(got).not.toBeNull();
    expect(got.user.id).toBe(userId);
    expect(got.device.id).toBe(device.id);
  });

  it('明文只在签发时出现，库里存的不是它', () => {
    const { device, token } = mintDevice({ userId });
    const row = getDevice(device.id);
    const secret = token.slice(token.indexOf('.') + 1);
    expect(row.secret_hash).not.toBe(secret);
    expect(row.secret_hash).toBe(crypto.createHash('sha256').update(secret).digest('hex'));
    // 整条令牌也不该出现在任何一列里
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('密钥错 / 设备不存在 / 形状不对，一律 null 且不区分原因', () => {
    const { device } = mintDevice({ userId });
    expect(verifyDeviceToken(`ndk_${device.id}.wrong-secret`)).toBeNull();
    expect(verifyDeviceToken('ndk_deadbeef.whatever')).toBeNull();
    for (const bad of ['', 'ndk_', 'ndk_abc', 'abc.def', 'Bearer x', null, undefined, 42, {}]) {
      expect(verifyDeviceToken(bad)).toBeNull();
    }
  });

  it('吊销一台不影响同一个人的另一台', () => {
    const a = mintDevice({ userId, label: 'A' });
    const b = mintDevice({ userId, label: 'B' });
    expect(revokeDevice(a.device.id)).toBe(true);
    expect(verifyDeviceToken(a.token)).toBeNull();
    expect(verifyDeviceToken(b.token)?.device.id).toBe(b.device.id);
  });

  it('吊销是软删：行还在，查得到什么时候被踢的', () => {
    const { device } = mintDevice({ userId, label: '软删' });
    revokeDevice(device.id);
    expect(getDevice(device.id)).not.toBeNull();
    expect(getDevice(device.id).revoked).toBe(1);
    expect(listDevices(userId).some((d) => d.id === device.id)).toBe(true);
  });

  it('账号停用后，这台设备的令牌立刻失效（不用逐台吊销）', () => {
    const u = makeUser();
    const { token } = mintDevice({ userId: u });
    expect(verifyDeviceToken(token)).not.toBeNull();
    // 走真实封号路径：moderation.js 的连坐停用调的就是 updateUser，它会失效用户缓存。
    // ⚠️ 别在这里写裸 SQL —— 那样绕过缓存失效，测的是现实里不存在的分支。
    updateUser(u, { disabled: true });
    expect(verifyDeviceToken(token)).toBeNull();
  });

  it('绕过 updateUser 直接改库，最迟 60 秒才生效（users-store 的用户缓存，已知取舍）', () => {
    const u = makeUser();
    const { token } = mintDevice({ userId: u });
    expect(verifyDeviceToken(token)).not.toBeNull();   // 这一发把该用户读进缓存
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u);
    // 缓存还在，所以令牌暂时仍然有效。任何"停用"都必须走 updateUser，
    // 直接写库的运维脚本会留下最长 60 秒的窗口。
    expect(verifyDeviceToken(token)).not.toBeNull();
  });

  it('令牌不落在别人名下：另一个人的令牌校验出来不是我', () => {
    const other = makeUser();
    const { token } = mintDevice({ userId: other });
    expect(verifyDeviceToken(token).user.id).toBe(other);
    expect(verifyDeviceToken(token).user.id).not.toBe(userId);
  });

  it('校验成功会更新 last_seen_at', () => {
    const { device, token } = mintDevice({ userId });
    expect(getDevice(device.id).last_seen_at).toBeNull();
    verifyDeviceToken(token);
    expect(getDevice(device.id).last_seen_at).not.toBeNull();
  });

  it('tokenFromRequest 认 Bearer 与 x-api-key，都没有则 null', () => {
    expect(tokenFromRequest({ headers: { authorization: 'Bearer ndk_a.b' } })).toBe('ndk_a.b');
    expect(tokenFromRequest({ headers: { authorization: 'bearer ndk_a.b' } })).toBe('ndk_a.b');
    expect(tokenFromRequest({ headers: { 'x-api-key': 'ndk_a.b' } })).toBe('ndk_a.b');
    expect(tokenFromRequest({ headers: {} })).toBeNull();
    expect(tokenFromRequest({})).toBeNull();
  });
});
