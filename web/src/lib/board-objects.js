/**
 * lib/board-objects.js — `/artifacts` 载荷 → 画布物件（2026-08-17 从 BoardCanvas 拆出）
 *
 * 纯数据变换，没有 React。拆出来的直接原因是行数棘轮拦住了往 BoardCanvas 加
 * 东西（加 word 形态那次），但它本来就该在这儿：画布上"有哪些卡"是一条独立的
 * 派生规则，跟渲染、相机、拖拽没有关系，而且它是**唯一**构造产物卡 id 的地方
 * —— 那个 id 同时是导出的寻址地址（服务端 export-collect.parseCardId 反解它）。
 */

import { cardIdOf } from './board-kinds.js';

/**
 * @param {{tasks?:Array, artifacts?:Array, layout?:object, browse?:object|null}} src
 * @returns {Array} 画布物件
 */
export function deriveBoardObjects({ tasks = [], artifacts = [], layout = {}, browse = null }) {
    const out = [];
    // 浏览器卡（2026-08-18）：`/artifacts` 给 `browse` 才有，也就是"这个项目
    // 逛过站"。它的真相在服务端的 `.browser/state.json`，所以**浏览器实例被空闲
    // 回收之后卡还在**，双击它把浏览器起回上次那一页（这就是"随时能进"）。
    //
    // id 固定 `'browse'`：一个项目一只浏览器（registry 按 projectId 键），
    // 不需要也不该有第二张。不带斜杠 → `zoneOfObjectId` 返回 null → 住桌面根上，
    // 跟顶层产物平级。
    // 判据跟服务端一致：有访问记录**或者**采到过东西（`browseCard` 头注释里
    // 有为什么是两者之一）。只看 url 的话"采过但没有访问记录"的项目会没有卡。
    if (browse?.url || browse?.sites?.length) {
      out.push({ id: 'browse', type: 'browse', ...browse, title: browse.title || browse.host });
    }
    // 画布原生物件先进来（它们不依赖任何数据源，只依赖 layout 本身）
    for (const [id, l] of Object.entries(layout)) {
      if (!l?.kind) continue;
      out.push({
        id, type: l.kind, data: l.data, native: true, zoneField: l.zone,
        // 黑板字段（2026-08-23）：分组标签 + 草稿位。产物卡的同名字段住 pos 上
        // （pos 就是 layout 条目本身），原生物件在这里抬到顶层，两边读法见 BoardObject
        ...(l.tag ? { tag: l.tag } : {}),
        ...(l.staging ? { staging: true } : {}),
      });
    }
    // 项目级文档（记忆 / 品牌）不再当画布物件 —— 2026-07-28 起由桌面顶带
    // 顶栏「⋯」里的四件套之一（2026-08-07 从画布顶带搬过去），跟指引、文件一起构成"项目区"。
    //
    // 会话不再产生画布物件（2026-08-08）：以前每个会话自带一张 deck 卡，那是
    // 「一个会话一份产出」时代的形状。现在产出是文件、会话是对话线程，桌面上
    // 该有的是文件，不是对话。对话在左栏和聊天栏里。
    //
    // 产物卡（多产物平权 2026-07-29）：tasks[].artifacts 一条一卡，没有主/试作等级。
    // 站点子页和样式表仍不各自上墙（用户要的是"我那个网站"，不是
    // index/about/style 三张互不相干的卡）。
    //
    // **id = kind 前缀 + 工作区相对路径**（2026-08-08）：
    //   deck   `deck:主稿.html`、`deck:鉴赏页/初稿/主稿.html`
    //   站点   `site:伊蕾娜手账研究站`；单页 `site:鉴赏页/_drafts/试作.html`
    //   文件夹 就是路径本身，`鉴赏页/初稿`
    //
    // 画布上的身份和磁盘上的位置是**同一个字符串**。代价是"移动 = 换身份"，
    // 所以改名必须是一等公民：拖拽走 renameBoardPaths（不是删+插，否则挂在
    // 卡上的批注会被端点清理连坐删掉），agent 背着画布 mv 的由 git 改名检测
    // 对账（board-store 的 reconcileBoardRenames），迟到的防抖写入由转发表
    // 接住。这三条缺一个，症状都是"摆好的版面偶尔自己回到默认位置"。
    for (const t of tasks) {
      for (const a of (t.artifacts || [])) {
        if (a.kind === 'site') {
          out.push({
            id: cardIdOf(t.id, a),
            type: 'site',
            single: !!a.single,
            task: t.id,
            base: a.base || a.root || t.id,
            entry: a.entry || 'index.html',
            pages: a.pages || [],
            root: a.root || '',
            srcRoot: a.srcRoot || '',
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        } else if (a.kind === 'stage') {
          // 演出（2026-09-05）：卡即 stage/ 文件夹，卡面要的只有标题 / 在场者 / 拍数 / 皮肤
          out.push({
            id: cardIdOf(t.id, a),
            type: 'stage',
            task: t.id,
            root: a.root || '',
            stage: a.stage || null,
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        } else {
          // ⚠️ type 跟着形态走，别写死 'deck' —— 写死的话新形态（word）的卡会
          // 顶着 deck 的身份进画布：拿 deck 的脸去渲、双击开 deck 的窗、
          // 按 deck 导出。跟 cardIdOf 里那处是同一个病。
          out.push({
            id: cardIdOf(t.id, a),
            type: a.kind || 'deck',
            task: t.id,
            deckFile: a.file,
            // word 有没有 token 源，决定「能不能看源码 / 能不能改源重建」
            sourceFile: a.sourceFile || null,
            // word 文件夹：root = 认领的文件夹（舞台寻址收敛用），members =
            // 版本清单（窗里的导航切换）。单份 .docx 两个都空着
            root: a.root || '',
            members: a.members || null,
            exports: a.exports,
            title: a.title || t.title,
            mtime: t.mtime,
          });
        }
      }
    }
    for (const a of artifacts) {
      const sid = a.sessionId || a.meta?.sessionId || null;
      // noteTask：共享便利贴标记（notes/*.md，agent 和用户共用的头脑风暴层，
      // 走 task-notes 路由可编辑可删）；null = 项目级灵感便签（assets/notes/，
      // 走 notes 路由）。⚠️ 判据曾是 `startsWith('tasks/')` —— 扁平化后便利贴
      // 住 notes/，恒 null：编辑按钮消失、删除打到 assets/notes 的错端点
      // 静默 404（2026-08-14 扁平残留普查抓到）。
      if (a.kind === 'note') {
        out.push({
          id: a.path, type: 'note', sid,
          // 老数据里的便利贴还住在 tasks/ 下，这条兼容判据是 legacy-shape lint
          // 头注释里点名允许的那一个（标记必须写在**同一行**，它查的是同位行）
          noteTask: a.path.startsWith('notes/') || a.path.startsWith('tasks/'),   // legacy-ok
          ...a,
          // 板书（2026-08-23）：frontmatter nd: chalk 的便签 —— 同一形态，另一张脸（裸 md 文字）
          ...(a.chalk ? { chalk: a.chalk } : {}),
        });
      }
      else if (a.isImage) out.push({ id: a.path, type: 'image', sid, ...a });
      else if (a.isVideo) out.push({ id: a.path, type: 'video', sid, ...a });
      else out.push({ id: a.path, type: 'file', sid, ...a });
    }
    return out;}
