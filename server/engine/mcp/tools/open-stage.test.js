/**
 * open_stage 的入参口径（09-07 两条问题库条目改的）。
 *
 *   1. chips 的档数原来钉死 8（描述里没写），有人要填 10 档公会阶级，被打回、丢了两档
 *      （问题库 iss_mtqlytis_xwg2）→ 上限拿掉。
 *   2. 成就 / 触发器的 id 原来只收 ASCII，而同一个系统里的状态键收中文
 *      （exp 库两条 open_stage 校验失败都是中文 id）→ 改成跟状态键同一条 KEY_RE。
 *
 * 测的是 schema 本身：这两条错在校验层，handler 根本没被调用过。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { makeOpenStageTool } from './open-stage.js';
import { KEY_RE } from '../../../lib/state-table.js';

const schema = z.object(makeOpenStageTool({ projectId: 'p1' }).inputSchema);
const base = {
  title: '四方世界',
  table: '这是一份足够长的设定：'.repeat(12),
  cast: [{ name: '柜台小姐' }],
};
const parse = (extra) => schema.safeParse({ ...base, ...extra });

describe('vitals 的 chips 档数', () => {
  it('十档公会阶级收得下（白瓷到白金，正是被打回的那一发）', () => {
    const options = ['白瓷', '黑曜', '铜', '铁', '钢', '蓝宝', '翠玉', '银', '金', '白金'];
    const r = parse({ vitals: [{ key: '公会阶级', as: 'chips', options }] });
    expect(r.success).toBe(true);
    expect(r.data.vitals[0].options).toHaveLength(10);
  });

  it('单档的字数上限还在（拿掉的是档数，不是每档的长度）', () => {
    const r = parse({ vitals: [{ key: '公会阶级', as: 'chips', options: ['х'.repeat(21)] }] });
    expect(r.success).toBe(false);
  });
});

describe('成就 / 触发器的 id', () => {
  it('中文 id 收得下，跟状态键同一条口径', () => {
    const r = parse({
      achievements: [{ id: '初次见面', title: '初次见面', when: '好感 >= 10' }],
      triggers: [{ id: '进熟稔期', when: '好感 >= 60', note: '按卡上的分阶段人设走' }],
    });
    expect(r.success).toBe(true);
  });

  it('英文 id 照旧收（改的是放宽，不是换一套）', () => {
    expect(parse({ achievements: [{ id: 'first-meet', title: '初次见面', when: '好感 >= 10' }] }).success).toBe(true);
  });

  // 攻一下：放宽不等于不校验，随手放个值测出来的绿是假绿
  it.each([['-开头', '-不行'], ['空的', ''], ['带空格', 'a b'], ['带斜杠', 'a/b'], ['超长', '长'.repeat(41)]])(
    '仍然拒绝：%s',
    (_label, id) => {
      expect(parse({ achievements: [{ id, title: 'x', when: '好感 >= 10' }] }).success).toBe(false);
      expect(KEY_RE.test(id)).toBe(false);
    },
  );
});
