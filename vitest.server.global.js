// 收尾两件事（见 vitest.server.setup.js）：
//   1. 删掉这次跑出来的每个 worker 的测试库与数据目录。不删的话每跑一次在 tmp 里多几份
//      库 + -wal/-shm + 一个项目目录，这台机器的 tmp 垃圾本来就长得快。
//   2. ⭐ 查一遍**有没有东西漏进仓库的默认路径**（09-17）。这三处默认路径已经栽过三次：
//      08-17/08-18 往问题库写脏数据，09-17 又逮到两条（profile.test.js 的子进程删掉 VITEST
//      后落回 server/db/nodesign.db；market-routes.test.js 静态 import 冻结了 projects-data）。
//      在生产 checkout 里跑就是写生产库和生产数据目录，注释拦不住第四次，所以这里立一把尺子：
//      跑前记一遍，跑完再记一遍，多出来的当场红。
import { readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
/** 仓库里几处「跑测试绝不该被写到」的默认路径 */
const GUARDED = ['server/db/nodesign.db', 'server/projects-data', 'server/runs', 'server/.cache', 'server/market-data'];

const stamp = () => GUARDED.map((rel) => {
  const p = resolve(REPO, rel);
  if (!existsSync(p)) return `${rel}:-`;
  const st = statSync(p);
  return `${rel}:${st.isDirectory() ? `dir/${readdirSync(p).length}` : `file/${st.size}`}@${Math.round(st.mtimeMs)}`;
}).join('\n');

export default function setup() {
  // worker 里拿不到主进程的 pid 以外的东西当"这一次运行"的标记，于是由这里定、经 env 传下去
  process.env.ND_TEST_RUN_ID = String(process.pid);
  const before = stamp();
  return () => {
    const prefix = `nodesign-test-${process.pid}-`;
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith(prefix)) rmSync(join(tmpdir(), f), { recursive: true, force: true });
    }
    const after = stamp();
    if (after !== before) {
      const rows = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
      // ⛔ 只 throw 的话 vitest 会打印 `error during close` 但**退出码仍是 0**（09-17 实测），
      // 那就是「判据打印了却没接到退出码」的老坑。退出码自己置，报文照旧打。
      process.exitCode = 1;
      console.error(`测试往仓库的默认路径写了东西（说明有测试没吃到 setup 里的 DB_PATH / PROJECTS_DATA_DIR）：\n  ${rows.join('\n  ')}\n`
        + '  查法：单跑候选文件，跑前后对 git status --short --ignored 做差；\n'
        + '  两种已知绕过：子进程 env 删掉 VITEST（store.js 的闸不成立）、测试文件用静态 import（env 设得比模块求值晚）。');
    }
  };
}
