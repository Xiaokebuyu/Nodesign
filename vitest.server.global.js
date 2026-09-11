// 收尾：删掉这次跑出来的每个 worker 的测试库（见 vitest.server.setup.js）。
// 不删的话每跑一次在 tmp 里多几份库 + -wal/-shm，这台机器的 tmp 垃圾本来就长得快。
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  // worker 里拿不到主进程的 pid 以外的东西当"这一次运行"的标记，于是由这里定、经 env 传下去
  process.env.ND_TEST_RUN_ID = String(process.pid);
  return () => {
    const prefix = `nodesign-test-${process.pid}-`;
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith(prefix)) rmSync(join(tmpdir(), f), { force: true });
    }
  };
}
