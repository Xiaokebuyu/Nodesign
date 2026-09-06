import { describe, it, expect } from 'vitest';
import { updateCheckMessage } from './update-message.js';

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
