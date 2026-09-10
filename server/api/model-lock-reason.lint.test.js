/**
 * 拒绝的话必须是真话（2026-09-10 的 lint）。
 *
 * 病史：「模型选不了」原来只有一个原因（Pro 档），于是三个端点各自把那句话**写死**在 403 里。
 * 09-10 起原因变成三种（Pro 档 / 站主停用 / 钟点关门），写死的那句对后两种就是**假话** ——
 * 用户看到"仅限 Pro 档"，跑去升级，然后发现还是不能用。
 *
 * 判据不写在注释里（注释拦不住下一个人，见 feedback-contract-needs-a-lint）：
 * 凡是回 MODEL_LOCKED 的地方，都得从 modelLockFor 拿那一行、用它的 lockReason。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.dirname(fileURLToPath(import.meta.url));
/** 会拒绝"这个模型你现在不能用"的端点。加了新的拒绝点就往这里加一行 */
const GATES = ['turn.js', 'sessions.js', 'turn-model-switch.js'];

describe('MODEL_LOCKED 的话从行上取', () => {
  it('三个拒绝点都走 modelLockFor + lockReason，没有人再手写"仅限 Pro 档"当唯一理由', () => {
    for (const file of GATES) {
      const src = fs.readFileSync(path.join(API, file), 'utf8');
      expect(src, `${file}: 回 MODEL_LOCKED 的端点要 import modelLockFor`).toMatch(/modelLockFor/);
      expect(src, `${file}: 拒绝的话要用 lockReason`).toMatch(/lockReason/);
      expect(src, `${file}: 别再用 isModelLockedFor（它只回真假，拿不到理由）`).not.toMatch(/isModelLockedFor/);
    }
  });

  it('确实还有人在回 MODEL_LOCKED —— 否则上一条测的是一个不存在的东西', () => {
    const hits = GATES.filter((f) => fs.readFileSync(path.join(API, f), 'utf8').includes('MODEL_LOCKED'));
    expect(hits).toEqual(GATES);
  });
});
