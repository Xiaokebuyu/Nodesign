import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 端口 5174 避开 dev/ 的 5173；Nodesign/server 后续起在 4001
//
// API 端口可用 NODESIGN_API_PORT 覆盖（2026-08-07 加）。原因：这台机器上
// 4001 是 pm2 跑的**线上主仓**进程 —— 在 worktree 里开 dev 前端时，/api 会被
// 代理到线上后端，于是**分支上的服务端改动一个字都没生效**，而且不报错
// （老服务端把不认识的字段静默丢掉）。端到端验证必须能指向自己的后端。
const API_PORT = process.env.NODESIGN_API_PORT || '4001';

export default defineConfig({
  plugins: [react()],
  test: {
    // 界面语言钉 zh-CN —— 理由见 src/test-setup.js（jsdom 报 en-US，会让断言
    // 中文文案的老测试在包 t() 之后集体变红）
    setupFiles: ['./src/test-setup.js'],
  },
  server: {
    port: 5174,
    host: true,
    strictPort: false,
    // dev 时把 /api 和 /ws 都代理到后端 :4001
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
      // ★ /ws/projects/:pid 是 WebSocket 升级路径，必须单独 entry +
      // target 用 ws:// 协议 + ws: true。挂在 /api 下的 ws:true 只覆盖 /api/*，
      // 不覆盖根路径下的 /ws —— 之前漏了这个，导致前端 WS 永远连不上后端，
      // agent 事件流到 EventBus 但前端收不到，看起来"agent 调用没接通"。
      '/ws': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
