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
// 数据目录同理（09-17）：只设 DB_PATH 的时候，静态 import 就把 workspace.js 的
// PROJECTS_DATA_ROOT 冻结成**仓库里的 server/projects-data** —— market-routes.test.js 在那里
// 留下过一个带 .git 和参考图的孤儿项目目录。在生产 checkout 里跑就是往生产数据目录里写。
// ⛔ 无条件赋值：写成 `||` 的话外层 env 一带就白设（那正是 market-routes.test.js 自己那行的病）。
process.env.PROJECTS_DATA_DIR = join(tmpdir(), `nodesign-test-${run}-${process.env.VITEST_POOL_ID || '0'}-projects`);

// 存在性闸的测试口子（09-17，问题库 iss_mtjex6wv_5xhn）：生产里没有项目行的 pid 一律当已删除（projects/project-gone.js），
// 而大批服务端测试直接拿假 pid 调 ensureProjectWorkspace / patchBoard、不建项目行。这里放行「无行」，
// 已软删除的行照拦；专测这道闸的用例自己把它关掉。生产进程不设这个变量。
process.env.NODESIGN_ROWLESS_PROJECTS = 'allow';
