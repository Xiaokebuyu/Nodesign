/**
 * 站主的开关跟着改名走（10-11，Claude 5 → 5.5）。记录按 model_id 存：行换了名字不跟的话，
 * 被停用的行会悄悄回到「没记录 = 启用」。
 */
import { describe, it, expect } from 'vitest';
import { carrySwitchesAcrossRenames, setModelEnabled, setModelHours, isModelDisabled, hoursOverrideOf } from './model-switches.js';

describe('carrySwitchesAcrossRenames', () => {
  it('旧 id 的停用与关门时段抄到现名（多跳跟到底）；现名已有记录的不覆盖；没动过的行不产生记录；可重复跑', () => {
    const renames = { 'sw-old-a': 'sw-mid-a', 'sw-mid-a': 'sw-new-a', 'sw-old-b': 'sw-new-b', 'sw-old-c': 'sw-new-c' };
    setModelEnabled('sw-old-a', false, { note: '停用', updatedBy: 't' });
    setModelHours('sw-old-a', { tz: 'UTC', windows: ['01:00-04:00'], why: 'x' }, { updatedBy: 't' });
    setModelEnabled('sw-old-b', false, { updatedBy: 't' });
    setModelEnabled('sw-new-b', true, { updatedBy: 't' });   // 站主对新名另做过决定
    expect(isModelDisabled('sw-new-a')).toBe(false);          // 对照：迁之前新名是「没记录 = 启用」

    expect(carrySwitchesAcrossRenames(renames)).toBe(1);      // 只有 sw-old-a → sw-new-a 这一条：sw-mid-a / sw-old-c 没记录，sw-new-b 已有记录不覆盖
    expect(isModelDisabled('sw-new-a')).toBe(true);
    expect(hoursOverrideOf('sw-new-a')).toMatchObject({ windows: ['01:00-04:00'] });
    expect(isModelDisabled('sw-old-a')).toBe(true);           // 旧记录留着
    expect(isModelDisabled('sw-new-b')).toBe(false);          // 不覆盖
    expect(isModelDisabled('sw-new-c')).toBe(false);          // 旧名没记录 → 新名也没有
    expect(carrySwitchesAcrossRenames(renames)).toBe(0);      // 再跑一次什么都不做
  });
});
