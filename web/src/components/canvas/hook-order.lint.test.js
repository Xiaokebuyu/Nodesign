/**
 * 把 `_hook-order-check.mjs` 接进部署闸门（2026-08-30）。
 *
 * 那个检查 2026-08-14 就写好了，专治这个仓库栽过五次的 TDZ 白屏。但它一直是
 * **一个要人手动去跑的脚本** —— 全仓没有任何地方调用它。于是 08-30 又栽了第六次
 * （拆 useObjectClick 时把 setAnnotate 当入参传进去，而它 200 行之后才声明），
 * 而当时我确实跑了它、它也确实 PASS —— 因为它当时只查依赖数组、查不到 hook 入参。
 *
 * 两件事一起补：判据扩到 hook 入参（在那个脚本里），以及**让它自己跑起来**（这儿）。
 * 同仓规矩：这仓库没有 CI，vitest 就是闸门；一条没人跑的检查等于注释。
 *
 * ⚠️ 这里只做一件事 —— 起子进程跑那个脚本，看退出码。判据全在脚本里，
 *    别在这儿再抄一份（一个事实两份算法的老账）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('hook 依赖/入参顺序', () => {
  it('组件体里的 hook 不许用到还没声明的东西（TDZ 白屏）', () => {
    const r = spawnSync(process.execPath, [path.join(HERE, '_hook-order-check.mjs')], { encoding: 'utf8' });
    // 脚本自己会把每一处指到 文件:行号，原样透出来，别在这儿重新组织措辞
    expect(`${r.stdout}${r.stderr}`.trim()).toContain('PASS');
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });
});
