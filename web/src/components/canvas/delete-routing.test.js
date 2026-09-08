/**
 * delete-routing.test.js —— 右键菜单的门 vs 删除分发器的分支，必须覆盖同一批形态。
 *
 * ## 为什么有这个文件
 *
 * 「点了删除什么都没发生」这一族 bug 到 2026-09-08 已经是**第三代**：
 *
 *   一代（08-13）native 物件没有 `name`，走文件那条路静默失败
 *   二代        浏览器卡两样都不是，走进 `removeNote(pid, undefined)` 静默 404
 *   三代（09-08）图片 / 散文件 / 站点 / word / deck / video —— 菜单的门是
 *               `isFileBacked(obj) || obj.native`，分发器却用一个 `else` 把它们
 *               全兜到便签路由（要求 .md 且只在 assets/notes/ 里找），一律 400，
 *               再被 `catch` 吞成一句 console.warn
 *
 * 三代的共同点：**每次都改了门没改分发器，而且三代都没有测试**。前两代的教训
 * 只写在注释里 —— 注释拦不住第四代，这个文件才拦得住。
 *
 * ## 判据
 *
 * 拿形态表里**每一种** `backing === 'file'` 的形态跑一遍分发器，断言它落到的路由
 * 是真的能删掉它的那条。菜单以后再放宽（多给一种形态删除按钮），这里会当场红。
 */
import { describe, it, expect } from 'vitest';
import { deleteRouteFor } from './useBoardOpen.js';
import { isFileBacked } from '../../lib/board-kinds.js';

/** 服务端 lib/task-scan.js 的 RESERVED_DIRS —— 通用删除路由碰不了这些顶层目录 */
const RESERVED = new Set(['assets', 'exports', 'notes', 'node_modules', 'agent-memory']);

/** 形态表里所有 backing:'file' 的形态（少一种这里就该补一种） */
const FILE_KINDS = ['file', 'image', 'note', 'deck', 'docx', 'site', 'video', 'pdf'];

describe('删除分发（三代 bug 的守卫）', () => {
  it('画布原生物件走 board.json 那条，不碰文件路由', () => {
    expect(deleteRouteFor({ native: true, id: 'scribble:abc' }, 'abc')).toBe('native');
  });

  it('板书和任务便利贴各走各的专用路由', () => {
    expect(deleteRouteFor({ chalk: true, name: 'x.md' }, 'notes/板书/x.md')).toBe('chalk');
    expect(deleteRouteFor({ noteTask: 'T1', name: 'x.md' }, 'tasks/T1/notes/x.md')).toBe('taskNote');
  });

  it('⭐ 便签必须走便签路由 —— 它住在 RESERVED_DIRS 里，通用路由删不了', () => {
    for (const rel of ['notes/想法.md', 'assets/notes/想法.md']) {
      expect(deleteRouteFor({ type: 'note', name: '想法.md' }, rel), rel).toBe('note');
      // ⚠️ 连 type 都不是 note 的也得认出来（sizeOf 里就有 type='file' 的 .md）
      expect(deleteRouteFor({ type: 'file', name: '想法.md' }, rel), `${rel}（type=file）`).toBe('note');
    }
  });

  it('⭐ 反过来：type=note 但不住在 notes/ 下的，**不能**走便签路由', () => {
    // 这条是写测试时发现的：分发器里加一句 `|| o.type === 'note'` 看着无害，
    // 其实是换个姿势重犯同一个错 —— 便签路由只在 assets/notes/ 里找文件，
    // 一张落在 `稿件/想法.md` 的便签卡会 404。服务端按路径找，前端就得按路径分。
    for (const rel of ['稿件/想法.md', 'tasks/T1/想法.md']) {
      expect(deleteRouteFor({ type: 'note', name: '想法.md' }, rel), rel).toBe('entry');
    }
  });

  it('⭐⭐ 每一种文件形态都得落到一条**能删掉它**的路由（三代 bug 就死在这）', () => {
    const wrong = [];
    for (const type of FILE_KINDS) {
      expect(isFileBacked({ type }), `${type} 不是 backing:'file'，FILE_KINDS 该更新了`).toBe(true);
      // 典型落点：任务文件夹里 agent 产出的东西
      const rel = `稿件/${type === 'note' ? '想法.md' : `作品.${type}`}`;
      const route = deleteRouteFor({ type, id: `${type}:${rel}`, name: rel.split('/').pop() }, rel);
      // 只有真住在 notes/ 下的才该走 note；其余一律得走通用路由
      const expected = 'entry';
      if (route !== expected) wrong.push(`${type}（${rel}）→ ${route}，应该是 ${expected}`);
    }
    expect(wrong, `这些形态被送去了删不掉它们的路由：\n${wrong.join('\n')}\n`).toEqual([]);
  });

  it('通用路由拿到的路径，顶层目录不能是保留目录（否则服务端 400）', () => {
    for (const rel of ['稿件/图.png', 'tasks/T1/封面.png', '作品/站点/index.html']) {
      expect(deleteRouteFor({ type: 'image', name: 'x' }, rel)).toBe('entry');
      expect(RESERVED.has(rel.split('/')[0]), `${rel} 的顶层目录是保留目录`).toBe(false);
    }
  });
});
