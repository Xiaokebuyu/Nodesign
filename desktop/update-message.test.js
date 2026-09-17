import { describe, it, expect } from 'vitest';
import { updateCheckMessage, isSuspendError } from './update-message.js';

describe('updateCheckMessage', () => {
  it('有更新：说版本号和在后台下', () => {
    expect(updateCheckMessage({ isUpdateAvailable: true, updateInfo: { version: '0.1.3' } }, '0.1.2')).toMatch(/0\.1\.3.*后台下载/);
  });
  it('本机比已发布的新（草稿包）：不能静默，要说清为什么没更新', () => {
    const m = updateCheckMessage({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }, '0.1.2');
    expect(m).toContain('0.1.2'); expect(m).toContain('0.1.0'); expect(m).toContain('草稿');
  });
  it('相等 / 没拿到结果：已是最新', () => {
    expect(updateCheckMessage({ isUpdateAvailable: false, updateInfo: { version: '0.1.2' } }, '0.1.2')).toBe('已经是最新版本（0.1.2）。');
    expect(updateCheckMessage(null, '0.1.2')).toBe('已经是最新版本（0.1.2）。');
  });
});

describe('isSuspendError', () => {
  it('认系统休眠打断的请求（Error 与字符串两种形状）', () => {
    expect(isSuspendError(new Error('net::ERR_NETWORK_IO_SUSPENDED'))).toBe(true);
    expect(isSuspendError('Error: net::ERR_NETWORK_IO_SUSPENDED\n    at SimpleURLLoaderWrapper')).toBe(true);
  });
  it('真正的网络故障不算', () => {
    expect(isSuspendError(new Error('net::ERR_CONNECTION_RESET'))).toBe(false);
    expect(isSuspendError(undefined)).toBe(false);
  });
});
