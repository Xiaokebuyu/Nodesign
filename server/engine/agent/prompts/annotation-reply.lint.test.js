// 标注的回应规则只有一种说法（09-18）。
// 09-17 板书树定「用户标注了哪条板书就改写哪条」，只改了写板那一段；「板书三种动作」「回复跟着入口走」
// 「版式纪律」三段和标注消息里的提示还写着「reply_to 接在下面」，同一件事两种相反的说法，agent 两头各做一半。
// 这里钉住：提示词里讲标注的句子不许再叫它 reply_to；标注消息的提示（replyHint）对 agent 自己的板书也不许。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const prelude = fs.readFileSync(new URL('./nodesign-prelude.md', import.meta.url), 'utf8');
// 按句切：中文句号、分号和换行
const sentences = prelude.split(/[。；\n]/);

describe('标注的回应规则', () => {
  it('⛔ 提示词里讲标注的句子不叫 agent 用 reply_to 接在下面', () => {
    const bad = sentences.filter((s) => /标注/.test(s) && /reply_to/.test(s));
    expect(bad).toEqual([]);
  });

  it('改写规则在：板书三种动作、写板那段都说改写', () => {
    expect(prelude).toContain('用户标注了你的哪条板书，就改写那条');
    expect(prelude).toContain('**改写那条板书本身**');
  });

  it('⛔ 标注消息给 agent 自己板书的提示不是 reply_to', async () => {
    const { replyHint } = await import('../../../../web/src/lib/annotation-message.js');
    expect(replyHint({ chalk: true, by: 'agent', path: 'notes/板书/a.md' })).not.toContain('reply_to');
  });
});
