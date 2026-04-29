import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 端口 5174 避开 dev/ 的 5173；Nodesign/server 后续起在 4001
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    // 开发时把 /api 代理到后端（P3 之后启用）
    proxy: {
      '/api': {
        target: 'http://localhost:4001',
        changeOrigin: true,
        ws: true, // 转发 WebSocket
      },
    },
  },
});
