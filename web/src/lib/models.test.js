/**
 * 本地偏好过期自净（2026-08-20 随「本地 Qwen 摘牌」加）。
 * 这条逻辑管的是一个具体事故：模型下架后，浏览器里存着的旧偏好会被原样发给服务端，
 * 校验不过 → 400 unknown model，用户不知道该怎么办。
 */
import { describe, it, expect } from 'vitest';
import { isModelPrefStale, renamedModelPref, FALLBACK_MODELS, DEFAULT_MODEL_ID } from './models.js';

const SERVER = [{ id: 'claude-sonnet-5-5[1m]' }, { id: 'claude-opus-5-5[1m]' }, { id: 'gemini-3.7-flash' }];

describe('isModelPrefStale', () => {
  it('偏好指向已下架的模型 → 过期', () => {
    expect(isModelPrefStale('qwen3.8-27b', SERVER)).toBe(true);
  });
  it('偏好还在清单里（含带闸门的）→ 不过期', () => {
    expect(isModelPrefStale('claude-sonnet-5-5[1m]', SERVER)).toBe(false);
    expect(isModelPrefStale('gemini-3.7-flash', SERVER)).toBe(false);
  });
  it('偏好指向 locked 的订阅行（公开注册号）→ 过期，自净成默认', () => {
    expect(isModelPrefStale('claude-sonnet-5-5[1m]', [{ id: 'minimax-m3' }, { id: 'claude-sonnet-5-5[1m]', locked: true }])).toBe(true);
  });
  it('⚠️ 拿不到服务端清单时一律当"没过期" —— 拿兜底清单判会把带闸门的模型误伤', () => {
    for (const opts of [null, undefined, []]) {
      expect(isModelPrefStale('gemini-3.7-flash', opts)).toBe(false);
    }
    // 兜底清单里没有带闸门的模型，所以它绝不能被当判据传进来
    expect(FALLBACK_MODELS.some(o => o.id === 'gemini-3.7-flash')).toBe(false);
  });
  it('没有偏好 → 不过期（交给 options[0] 兜）', () => {
    expect(isModelPrefStale(null, SERVER)).toBe(false);
    expect(isModelPrefStale('', SERVER)).toBe(false);
  });
  it('行改过名（Claude 5 → 5.5）：旧偏好跟到新行；新行锁着 / 不是改名 / 表成环 / 没清单 → null（照过期处理）', () => {
    const RENAMES = { 'claude-sonnet-5[1m]': 'claude-sonnet-5-5[1m]', a: 'b', b: 'claude-opus-5-5[1m]', x: 'y', y: 'x' };
    expect(isModelPrefStale('claude-sonnet-5[1m]', SERVER)).toBe(true);
    expect(renamedModelPref('claude-sonnet-5[1m]', RENAMES, SERVER)).toBe('claude-sonnet-5-5[1m]');
    expect(renamedModelPref('a', RENAMES, SERVER)).toBe('claude-opus-5-5[1m]');   // 多跳
    expect(renamedModelPref('claude-sonnet-5[1m]', RENAMES, [{ id: 'claude-sonnet-5-5[1m]', locked: true }])).toBeNull();
    expect(renamedModelPref('qwen3.8-27b', RENAMES, SERVER)).toBeNull();
    expect(renamedModelPref('x', RENAMES, SERVER)).toBeNull();
    expect(renamedModelPref('claude-sonnet-5[1m]', null, SERVER)).toBeNull();
    expect(renamedModelPref('claude-sonnet-5[1m]', RENAMES, null)).toBeNull();
  });
  it('默认模型永远在兜底清单里（不然自净会把人踢到一个不存在的值）', () => {
    expect(FALLBACK_MODELS.some(o => o.id === DEFAULT_MODEL_ID)).toBe(true);
  });
});
