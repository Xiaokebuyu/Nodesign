// server 侧测试配置（2026-08-14 可维护性行动 D 刀：服务端从 0 测试起步）。
// 跑法：`npm run test:server`（node 环境，不进 web 的 happy-dom 配置）。
import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  test: {
    include: ['server/**/*.test.js', 'bin/**/*.test.js'],
    environment: 'node',
    // ⭐ 测试必须有自己的库。engine/runs/store.js 的 DB_PATH 默认指
    // server/db/nodesign.db —— 那是**生产库**。而测试会真的走到写库路径
    // （failure.test.js 触发 recordIssue），于是每跑一次测试就往用户的问题库
    // 里写两条脏数据；2026-08-17 一天跑了 57 次才被发现。
    // ⚠️ 不能写 ':memory:' —— store.js 对 env 值做 resolve()，会被当成路径字面量。
    env: { DB_PATH: join(tmpdir(), 'nodesign-test.db') },
  },
});
