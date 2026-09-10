/**
 * server/engine/agent/model-renames.js — 行改过名的历史（2026-09-10 从 model-table.js 拆出，那边到行数上限了）
 *
 * 单独一个文件是对的：这张表跟"现在有哪些行"是两件事 —— 它记的是**过去的名字**，
 * 只在读存量（会话文件、偏好、前端记的选择）时用得上，而且会一直长下去。
 */

/**
 * 改过名的行：**旧 id → 现在的 id**（2026-09-10 建）。
 *
 * 行的 id 不只是代码里的名字，它被**存在别处**：每个会话的 session-config.json、本地偏好的
 * defaultModel / hiddenModels、前端记的选择、以及用量账。所以改 id 是一件有存量的事 ——
 * 在这里留一条，读到旧名的地方（model-context.js 的 canonicalModelId / rowOf）就自动认现在这行，
 * 不用去翻那些存下来的文件。
 *
 * 规矩：
 *  - 只表达「同一行换了个名字」。**别拿它当"这行没了，用那行顶"** —— 那是 standby 的事，
 *    语义完全不同（换线是运行时降级，改名是同一个东西换称呼）。
 *  - 旧名**永远留着**，别当垃圾清理：清掉就等于让那些存量重新变成孤儿，而且是静默的。
 *  - 可以多跳（a→b→c 自动跟到底）；成环当没改过（表写坏了不该拖垮请求）。
 *  - **活着的行优先**：如果哪天有一行（比如用户自己配的插槽）就叫这个旧名，那它说了算，
 *    不翻译 —— 用户配的东西不该被我们的历史包袱顶掉。
 *  - ⛔ 历史用量账**不改写**：那是"当时用的是什么"的记录，按当时的名字留着才对。
 */
export const RENAMED_MODELS = Object.freeze({
  // 09-10：DeepSeek 官方换了目录，我们那行的 id 里还带着预览名的到期日（09-08 接的时候就这么写的）
  'deepseek-v4.1-flash-expires-on-0910': 'deepseek-flash',
});

/**
 * 顺着改名表跟到底。纯函数（表可以传进来）—— 多跳和成环这两条要能单独测，
 * 而它们恰恰是这张表长大之后才会出事的地方。
 * @param {string} id
 * @param {Record<string,string>} [renames]
 * @returns {string} 跟到底的名字；成环或没改过 → 原样
 */
export function followRename(id, renames = RENAMED_MODELS) {
  if (typeof id !== 'string' || !id) return id;
  const seen = new Set([id]);
  let cur = id;
  while (renames[cur]) {
    const next = renames[cur];
    if (seen.has(next)) return id;   // 成环 = 表写坏了，当没改过（别拖垮请求）
    seen.add(next);
    cur = next;
  }
  return cur;
}
