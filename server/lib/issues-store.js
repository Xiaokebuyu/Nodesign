/**
 * server/lib/issues-store.js — harness 问题库（2026-07-30）
 *
 * 两层写同一张表：
 *
 *   auto  —— PostToolUseFailure 钩子自动记的每次工具失败。**不依赖 agent 的自觉**，
 *            抓得到"某个工具这周失败 40 次但从来没人提过"这种。agent 太会兜底了，
 *            工具坏了它换个姿势就过去了，表面上活儿还是干完的。
 *   agent —— report_friction 工具主动报的摩擦：为什么绕路、期望的接口长什么样。
 *            这是 auto 层拿不到的那半句 —— "screenshot 超时 12 次"指不出修法，
 *            "我只想要首屏但只能 fullPage 再自己裁"才指得出。
 *
 * 为什么是 SQLite 不是 issue 目录：要看的是"哪个问题最频繁"，那是聚合查询；
 * 散文件每次都得自己数。同一类问题按 (source, tool_name, signature) 累加 count，
 * 不是堆一万条重复记录。
 */

import crypto from 'node:crypto';
import db from '../engine/runs/store.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,          -- 'auto' | 'agent'
    tool_name    TEXT,
    signature    TEXT NOT NULL,          -- 归一化指纹，聚合键
    summary      TEXT NOT NULL,
    detail       TEXT,
    expectation  TEXT,                   -- agent 期望的解决方案（自述层才有）
    project_id   TEXT,
    session_id   TEXT,
    run_id       TEXT,
    user_id      TEXT,
    count        INTEGER NOT NULL DEFAULT 1,
    status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'ack' | 'ignored' | 'closed'
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_key ON issues(source, tool_name, signature);
  CREATE INDEX IF NOT EXISTS idx_issues_count ON issues(status, count DESC);
`);

// kind 轴（2026-08-02，上报工具扩容）：bug=行为错了 / friction=能用但绕路 /
// idea=改进想法（没坏也值得说）。老行回填：auto 全是工具失败事件 → bug；
// agent 存量按原语义 → friction。回填只在加列那一次跑，之后 kind 归写入方管。
{
  const cols = new Set(db.prepare('PRAGMA table_info(issues)').all().map(c => c.name));
  if (!cols.has('kind')) {
    db.exec("ALTER TABLE issues ADD COLUMN kind TEXT NOT NULL DEFAULT 'friction'");
    db.exec("UPDATE issues SET kind = 'bug' WHERE source = 'auto'");
    console.log('[issues] kind column added (auto 存量回填为 bug)');
  }
  // last_detail（09-17）：同签名再出现时只加计数的话，detail 永远停在第一次。
  // 「Exit code 144」那条 08-17 建行时还没记命令，之后 9 次的命令一条都没留下；
  // 桌面上报的版本号 / 设备名写在 detail 头里，后来是哪台机哪个版本也查不到。
  if (!cols.has('last_detail')) db.exec('ALTER TABLE issues ADD COLUMN last_detail TEXT');
}

/**
 * 错误指纹：把可变部分抹掉，留下问题的"类"。
 * 不归一化的话同一个毛病会因为路径/行号/时间戳不同散成几十条，聚合就没意义了。
 */
export function signatureOf(text) {
  const norm = String(text || '')
    // 字符类里不能有空格：不然一个孤立的 "/" 会贪婪吞掉后面一整串词（08-24 案，
    // artifact_find 输出里的 "→ https://…" 之后的文字被不定长吃掉，指纹漂移不聚合）
    .replace(/[/~][\w.\-/@一-鿿]+/g, '<path>')    // 路径
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')      // id / hash
    .replace(/\d+/g, 'N')                          // 行号、字节数、耗时
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function newId() {
  return `iss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 记一条（同类累加）。任何调用点都必须 fail-soft —— 记录问题这件事本身不能变成
 * 新的故障源，所以这里吞掉一切异常。
 * @returns {{ id: string, count: number } | null}
 */
const KINDS = new Set(['bug', 'friction', 'idea']);

export function recordIssue({
  source, toolName, summary, detail, expectation,
  projectId, sessionId, runId, userId, signature, kind,
}) {
  try {
    if (!summary) return null;
    const k = KINDS.has(kind) ? kind : (source === 'auto' ? 'bug' : 'friction');
    const sig = signature || signatureOf(`${toolName || ''}|${detail || summary}`);
    const key = { source, toolName: toolName || null, sig };
    const existing = db.prepare(
      'SELECT id, count FROM issues WHERE source = ? AND tool_name IS ? AND signature = ?',
    ).get(key.source, key.toolName, key.sig);

    if (existing) {
      // detail 保留第一次，最近一次的进 last_detail（桌面上报的设备 / 版本头也在里面）；user_id 仍记第一次
      const d = detail ? String(detail).slice(0, 4000) : null;
      db.prepare(`UPDATE issues
                  SET count = count + 1, last_seen = datetime('now'),
                      project_id = COALESCE(?, project_id),
                      session_id = COALESCE(?, session_id),
                      run_id = COALESCE(?, run_id),
                      detail = COALESCE(detail, ?),
                      last_detail = COALESCE(?, last_detail),
                      status = CASE WHEN status = 'closed' THEN 'open' ELSE status END
                  WHERE id = ?`)
        .run(projectId ?? null, sessionId ?? null, runId ?? null, d, d, existing.id);
      return { id: existing.id, count: existing.count + 1 };
    }

    const id = newId();
    db.prepare(`INSERT INTO issues
        (id, source, kind, tool_name, signature, summary, detail, expectation,
         project_id, session_id, run_id, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, source, k, key.toolName, key.sig,
        String(summary).slice(0, 300),
        detail ? String(detail).slice(0, 4000) : null,
        expectation ? String(expectation).slice(0, 2000) : null,
        projectId ?? null, sessionId ?? null, runId ?? null, userId ?? null);
    return { id, count: 1 };
  } catch (err) {
    console.warn('[issues] record failed:', err.message);
    return null;
  }
}

function rowToIssue(r) {
  if (!r) return null;
  return {
    id: r.id,
    source: r.source,
    kind: r.kind || 'friction',
    toolName: r.tool_name,
    signature: r.signature,
    summary: r.summary,
    detail: r.detail,
    lastDetail: r.last_detail && r.last_detail !== r.detail ? r.last_detail : null,
    expectation: r.expectation,
    projectId: r.project_id,
    sessionId: r.session_id,
    runId: r.run_id,
    userId: r.user_id,
    count: r.count,
    status: r.status,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

/**
 * 默认按次数降序 —— 一眼看到最该修的那个。
 * status/source 传 'all' 或空 = 不过滤：这两个字段直接当 SQL 值用过一次，
 * `status:'all'` 匹配不到任何行却返空数组，读起来像"库里是干净的"（体检脚本
 * 就这么漏过一条残留）。宁可在这里认掉这个词，不让空结果继续说谎。
 */
export function listIssues({ status, source, kind, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (source && source !== 'all') { where.push('source = ?'); args.push(source); }
  if (kind && kind !== 'all') { where.push('kind = ?'); args.push(kind); }
  const sql = `SELECT * FROM issues${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY count DESC, last_seen DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(rowToIssue);
}

const STATUSES = new Set(['open', 'ack', 'ignored', 'closed']);

export function setIssueStatus(id, status) {
  if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  const info = db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, id);
  return info.changes > 0 ? rowToIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(id)) : null;
}

export function removeIssue(id) {
  return db.prepare('DELETE FROM issues WHERE id = ?').run(id).changes > 0;
}

/** 顶栏/概览用：open 状态下按工具聚合的次数 */
export function issueStats() {
  const rows = db.prepare(
    `SELECT tool_name, source, SUM(count) AS total, COUNT(*) AS kinds
     FROM issues WHERE status = 'open' GROUP BY tool_name, source ORDER BY total DESC`,
  ).all();
  return rows.map(r => ({ toolName: r.tool_name, source: r.source, total: r.total, kinds: r.kinds }));
}
