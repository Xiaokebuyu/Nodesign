/**
 * api/assets/entries.js —— 删掉画布上的一件东西（文件）或一整个文件夹。
 *
 * 09-08 从 `api/assets.js` 拆出来：加了 `DELETE /:pid/entries/*` 之后那个文件
 * 涨到 958 行、超了它自己 896 的冻结上限。按仓库纪律「胖了就拆，别抬上限」，
 * 就近拆进已有的 `assets/` 子目录（跟 `notes.js` 同一个 mount 范式）。
 *
 * 两条路由放一起，是因为它们**共用同一套闸**（越界 / 保留目录 / `.` 打头）——
 * 而这套闸此前在三处各写各的，`/folders` 那份还漏了一道。合到 `guardRel` 一处，
 * 以后再加删除入口直接调它，别再抄第四遍。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { patchBoard, readBoard, pruneDanglingBindings } from '../../projects/board-store.js';
import { RESERVED_DIRS } from '../../lib/task-scan.js';
import { commitWorkspace } from '../../projects/workspace.js';
import { dropStage } from '../../engine/stage/manager.js';

/** 入参路径归一：反斜杠转正斜杠、去掉首尾多余的斜杠 */
function normRel(raw) {
  const s = Array.isArray(raw) ? raw.join('/') : (raw || '');
  return String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * 删除类操作共用的三道闸。
 *
 * ⚠️ 第三道（`.` 打头的顶层目录）原来只有 `/rename` 和 `POST /folders` 查了，
 * `DELETE /folders` **漏了** —— 于是 `DELETE /folders/.git` 能一路走到 `fs.rm`。
 * 抄守卫要抄正确性不是抄形状，所以这里合成一份，三个调用点共用。
 *
 * @returns {string|null} 出错原因；`null` = 放行
 */
function guardRel(rel, root) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return 'path escapes workspace';
  const seg0 = rel.split('/')[0];
  if (RESERVED_DIRS.has(seg0) || seg0.startsWith('.')) return 'reserved directory';
  return null;
}

export function mountEntryRoutes({ router, guardProject, getSharedDir }) {
  /**
   * DELETE /:pid/entries/*subPath —— 删掉画布上一件**文件形态**的东西（09-08 新增）。
   *
   * ## 为什么补这条
   *
   * 在这之前，服务端**根本没有「按路径删任意产物文件」的入口**：能删的只有便签
   * （notes / task-notes / chalk，各自一条按文件名的路由）、整个文件夹、以及用户
   * 上传的素材。而画布右键菜单的「删除」对**所有** `isFileBacked` 的卡都给 ——
   * 图片 / 散文件 / 站点 / word / deck / video 全在内。
   *
   * 于是前端只能把它们全塞进 `Assets.removeNote`，那条要求 `.md` 结尾且只在
   * `assets/notes/` 里找：删一张 `封面.png` 得到 400，而前端 `catch` 里只有一句
   * `console.warn`。**用户看到的就是「点了删除什么都没发生」**（09-08 站主实报）。
   *
   * 三件一起才算修好：这条路由 + `useBoardOpen.js` 的分发器 + 失败弹 toast。
   * 补路由不补分发器等于没修；补了分发器不弹 toast 等于下次再哑一遍。
   *
   * ⚠️ 只删**文件**。目录走 `/folders/*` —— 那条要停演出进程、要剪整棵子树，
   * 语义不一样，合并只会让两边都变复杂。
   */
  router.delete('/:pid/entries/*subPath', async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const rel = normRel(req.params.subPath);
      if (!rel) return res.status(400).json({ error: 'entry path required' });

      const root = getSharedDir(req.params.pid);
      const bad = guardRel(rel, root);
      if (bad) return res.status(400).json({ error: bad });

      const abs = path.resolve(root, rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st) return res.status(404).json({ error: 'entry not found' });
      if (st.isDirectory()) return res.status(400).json({ error: '这是个文件夹，走 /folders' });

      await fs.rm(abs, { force: true });

      // board.json 跟着剪 —— 跟 /folders 同一条纪律：删除必须是一个动作，不能
      // 指望前端补第二刀（不剪就是「磁盘上没了、画布上还在」的僵尸卡）。
      const board = await readBoard(req.params.pid);
      const patch = { objects: {} };
      for (const id of Object.keys(board?.objects || {})) {
        const p = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
        if (p === rel) patch.objects[id] = null;
      }
      if (Object.keys(patch.objects).length) await patchBoard(req.params.pid, patch);
      await pruneDanglingBindings(req.params.pid).catch(() => { /* 关系线剪不掉不该挡住删除 */ });

      res.json({ ok: true, removed: rel, objects: Object.keys(patch.objects).length });
      commitWorkspace(req.params.pid, null, `delete: ${rel}`, { author: 'user' })
        .catch(err => console.warn('[git] delete commit failed:', err.message));
    } catch (err) { next(err); }
  });

  /**
   * DELETE /:pid/folders/*subPath —— 删整个文件夹（连同里面的一切）。
   *
   * 保留目录一概不许删：`.claude` 里是项目指引和记忆，`.nd` 是各次对话的暗档案，
   * `.git` 是历史 —— 都不是「用户的文件夹」。
   */
  router.delete('/:pid/folders/*subPath', async (req, res, next) => {
    try {
      if (!guardProject(req, res)) return;
      const rel = normRel(req.params.subPath);
      if (!rel) return res.status(400).json({ error: 'folder path required' });

      const root = getSharedDir(req.params.pid);
      const bad = guardRel(rel, root);
      if (bad) return res.status(400).json({ error: bad === 'path escapes workspace' ? 'invalid path' : bad });

      const dir = path.resolve(root, rel);
      const st = await fs.stat(dir).catch(() => null);
      if (!st?.isDirectory()) return res.status(404).json({ error: 'folder not found' });

      // 是个正在演的故事就先停进程、摘运行时（09-06）：不然文件夹没了它还活着，
      // 下一句话把 场景/ 重新长出来
      try {
        if (await dropStage(req.params.pid, rel, 'folder-deleted')) {
          console.log(`[assets] ${req.params.pid}/${rel} 删除：演出进程已停`);
        }
      } catch { /* 不是故事 */ }
      await fs.rm(dir, { recursive: true, force: true });

      // board.json 跟着剪：这个文件夹自己的那行，以及住在它里面的全部物件。
      // 不剪的话磁盘上没了、画布上还在，就是 2026-07-30 那批「删不掉的僵尸
      // 文件夹」的来源 —— 删除必须是一个动作，不能指望前端补第二刀。
      const board = await readBoard(req.params.pid);
      const patch = { zones: { [rel]: null }, objects: {} };
      const under = `${rel}/`;
      for (const id of Object.keys(board?.objects || {})) {
        const p = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
        if (p === rel || p.startsWith(under)) patch.objects[id] = null;
      }
      for (const zid of Object.keys(board?.zones || {})) {
        if (zid.startsWith(under)) patch.zones[zid] = null;      // 嵌套在里面的子文件夹
      }
      await patchBoard(req.params.pid, patch);

      res.json({ ok: true, removed: rel, objects: Object.keys(patch.objects).length });
    } catch (err) { next(err); }
  });
}
