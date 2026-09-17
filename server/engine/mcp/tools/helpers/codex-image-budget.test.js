// 生图提示词上限与时间预算（09-17）：上限 3500 → 8000；预算随长度放宽，三道外层仍错开
import { describe, it, expect } from 'vitest';
import { codexImageBudgetMs, relayProduceBudgetMs, relayLegBudgetMs, CODEX_IMAGE_TIMEOUT_MS } from './codex-imagegen.js';

describe('codexImageBudgetMs', () => {
  it('原来的长度内保持原预算（300 / 330 / 360 秒）', () => {
    const p = '字'.repeat(3500);
    expect(codexImageBudgetMs(p)).toBe(CODEX_IMAGE_TIMEOUT_MS);
    expect(relayProduceBudgetMs(p)).toBe(CODEX_IMAGE_TIMEOUT_MS + 30_000);
    expect(relayLegBudgetMs(p)).toBe(CODEX_IMAGE_TIMEOUT_MS + 60_000);
    expect(codexImageBudgetMs(undefined)).toBe(CODEX_IMAGE_TIMEOUT_MS);
  });
  it('长提示词按字数放宽（按码点数，不按 UTF-16）；三道仍然错开', () => {
    const p = '字'.repeat(8000);
    expect(codexImageBudgetMs(p)).toBe(360_000);
    expect(codexImageBudgetMs('😀'.repeat(8000))).toBe(360_000);
    expect(codexImageBudgetMs('字'.repeat(10001))).toBe(420_030);
    expect(relayProduceBudgetMs(p)).toBeGreaterThan(codexImageBudgetMs(p));
    expect(relayLegBudgetMs(p)).toBeGreaterThan(relayProduceBudgetMs(p));
  });
});

describe('generate_image 的提示词上限', () => {
  it('prompt 与 prompts[] 都收到 8000，8001 拒绝', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../generate-image.js', import.meta.url), 'utf8');
    expect(src).toMatch(/prompt: z\s*\.string\(\)\s*\.min\(4\)\s*\.max\(8000\)/);
    expect(src).toContain('.array(z.string().min(4).max(8000))');
    expect(src).not.toMatch(/max\(3500\)/);
  });
});

describe('调用点都用预算函数，不再写死秒数', () => {
  it('produce / relay / 桌面腿', async () => {
    const fs = await import('node:fs');
    const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(read('../image-produce.js')).toContain('timeoutMs: codexImageBudgetMs(prompt)');
    expect(read('../relay-tools.js')).toContain('relayLegBudgetMs(payload?.prompt)');
    expect(read('../../../../hosted/relay/tools.js')).toContain('AbortSignal.timeout(relayProduceBudgetMs(prompt))');
  });
});
