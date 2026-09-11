// 每个 worker 一个测试库（09-11）。
//
// 原来 vitest.server.config.js 只给了一个 DB_PATH，所有并行 worker 开同一个 SQLite 文件：
// Linux 上靠 WAL + 5 秒忙等撑住了，Windows 上（强制文件锁，或 Node < 22.16 时 timeout 选项不生效）
// 外部审计跑出一片 `database is locked`，外加互相看得见对方写的行。
// setupFiles 在每个测试文件 import 之前跑，store.js 是模块加载时读 DB_PATH 的，所以这里设得上。
// 测试文件自己在顶上改 DB_PATH 的照样生效（它们在这之后跑）。
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = process.env.ND_TEST_RUN_ID || String(process.ppid);
process.env.DB_PATH = join(tmpdir(), `nodesign-test-${run}-${process.env.VITEST_POOL_ID || '0'}.db`);
