import { describe, it, expect } from 'vitest';
import { Assets, Browse } from './api.js';

// 09-08：Assets.preview 被当成 Browse.preview 调，首个前端错误上报抓到的就是它。调用点与定义要在同一个对象上
describe('浏览器缩略图现拍', () => {
  it('Assets.preview 是函数；Browse 上没有同名的（别再挂错对象）', () => {
    expect(typeof Assets.preview).toBe('function');
    expect(Browse.preview).toBeUndefined();
  });
});
