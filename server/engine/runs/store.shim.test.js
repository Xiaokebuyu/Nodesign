/** store.js 那层薄壳抹平的两处口径：undefined → NULL、transaction 的回滚。别的差异两边一致，不在这里重复测。 */
import { describe, it, expect } from 'vitest';
import db from './store.js';

db.exec('CREATE TABLE IF NOT EXISTS shim_probe (id INTEGER PRIMARY KEY, a, b)');

describe('node:sqlite 薄壳', () => {
  it('位置参数里的 undefined 当 NULL 绑（better-sqlite3 的老口径，调用点到处依赖）', () => {
    const r = db.prepare('INSERT INTO shim_probe (a, b) VALUES (?, ?)').run('x', undefined);
    const row = db.prepare('SELECT a, b FROM shim_probe WHERE id = ?').get(r.lastInsertRowid);
    expect(row).toEqual({ a: 'x', b: null });
  });
  it('具名参数对象里的 undefined 也当 NULL', () => {
    const r = db.prepare('INSERT INTO shim_probe (a, b) VALUES (@a, @b)').run({ a: 'y', b: undefined });
    expect(db.prepare('SELECT b FROM shim_probe WHERE id = ?').get(r.lastInsertRowid).b).toBeNull();
  });
  it('布尔照旧抛（两边都抛，别替调用方藏 bug）', () => {
    expect(() => db.prepare('INSERT INTO shim_probe (a) VALUES (?)').run(true)).toThrow();
  });
  it('transaction：中途抛错整体回滚；成功整体提交并返回值', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM shim_probe').get().n;
    const bad = db.transaction(() => { db.prepare('INSERT INTO shim_probe (a) VALUES (?)').run('t1'); throw new Error('boom'); });
    expect(bad).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM shim_probe').get().n).toBe(before);
    const good = db.transaction((v) => { db.prepare('INSERT INTO shim_probe (a) VALUES (?)').run(v); return v + '!'; });
    expect(good('t2')).toBe('t2!');
    expect(db.prepare('SELECT COUNT(*) AS n FROM shim_probe').get().n).toBe(before + 1);
  });
  it('WAL 与外键开着；忙等待 5 秒', () => {
    expect(db.raw.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(db.raw.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
  });
});
