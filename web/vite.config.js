import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 端口 5174 避开 dev/ 的 5173；Nodesign/server 后续起在 4001
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    // dev 时把 /api 和 /ws 都代理到后端 :4001
    proxy: {
      '/api': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
      // ★ /ws/projects/:pid 是 WebSocket 升级路径，必须单独 entry +
      // target 用 ws:// 协议 + ws: true。挂在 /api 下的 ws:true 只覆盖 /api/*，
      // 不覆盖根路径下的 /ws —— 之前漏了这个，导致前端 WS 永远连不上后端，
      // agent 事件流到 EventBus 但前端收不到，看起来"agent 调用没接通"。
      '/ws': {
        target: 'ws://localhost:4001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
