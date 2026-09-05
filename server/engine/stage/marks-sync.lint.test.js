import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * display/marks.js 是 web/src/components/ui/ModelMark.jsx 那份身份标的拷贝（显示器是纯 JS 进不了 JSX）。
 * 两份是两个真相源，这条闸钉着：每条 path 一字不差、brand 一个不少。改标先改 ModelMark.jsx 再同步过来。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const web = fs.readFileSync(path.join(REPO, 'web/src/components/ui/ModelMark.jsx'), 'utf8') + fs.readFileSync(path.join(REPO, 'web/src/components/ui/claude-mark.js'), 'utf8');
const disp = fs.readFileSync(path.join(HERE, 'display/marks.js'), 'utf8');

describe('显示器的身份标跟 ModelMark.jsx 对得上', () => {
  it('每条 path 都在显示器那份里', () => {
    const paths = [...web.matchAll(/const (\w+(?:_PATH|_FRAME|_BLOCK)) = '([^']+)';/g)].map(m => m[2]);
    expect(paths.length).toBeGreaterThan(6);
    for (const d of paths) expect(disp.includes(d), d.slice(0, 40)).toBe(true);
  });
  it('brand 一个不少', () => {
    const brands = [...web.matchAll(/^\s{2}(\w+):\s+\{ paths/gm)].map(m => m[1]);
    expect(brands.length).toBeGreaterThan(6);
    for (const b of brands) expect(disp.includes(`"${b}":`), b).toBe(true);
  });
});
