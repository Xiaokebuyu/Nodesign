/**
 * ecosystem.config.js — pm2 进程配置
 *
 * 用法（部署到生产服务器）：
 *   pm2 start ecosystem.config.js                启动
 *   pm2 logs nodesign                            看 log
 *   pm2 restart nodesign                         强制重启
 *   pm2 reload nodesign                          热重载（0-downtime）
 *   pm2 save                                     保存当前进程列表，系统重启自动拉
 *   pm2 startup                                  让 pm2 跟系统一起启动（首次配置一次即可）
 *
 * 配套 .env 由 server/index.js 通过 node --env-file-if-exists=.env 加载，
 * 不在这里重复声明（避免敏感值入仓）。
 *
 * 详见 DEPLOY.md § 5.
 */

module.exports = {
  apps: [
    {
      name: 'nodesign',
      script: 'server/index.js',
      cwd: __dirname,
      // streamInput 模式下 activeQuerySessions / activeRuns 是 in-memory Map，
      // 不能跨进程，instances 必须保持 1。多实例需要 Redis pub/sub（P1 待做）
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // 生产不 watch（开发用 npm run dev）
      watch: false,
      // 内存超 1G 自动重启 —— playwright headless chromium 偶发膨胀时兜底
      max_memory_restart: '1G',
      // node 跑 server/index.js 时载 .env（npm start 已经 --env-file-if-exists=.env）
      // pm2 直接 script 启动时需要在 node_args 里加上
      node_args: '--env-file-if-exists=.env',
      env: {
        NODE_ENV: 'production',
      },
      // log 落 logs/ 目录（已加 .gitignore，不入仓）
      error_file: 'logs/nodesign-error.log',
      out_file: 'logs/nodesign-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // SIGTERM 后给 graceful shutdown 5s（server/index.js 已有 SIGTERM handler）
      kill_timeout: 5000,
      // 启动失败 (init crash) 重试间隔 4s × 最多 10 次 = 40s 内救活
      restart_delay: 4000,
      max_restarts: 10,
    },
  ],
};
