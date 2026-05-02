# NoDesign 生产部署 SOP

> v0.1.0-mvp 内部测试版部署手册。按节顺序执行；每节末尾有"验证点"。
> 已知约束：单实例、in-memory state（重启丢活跃 session）、SDK binary 偶发错由
> uncaughtException 守护捕获不会拉下 server。

---

## 1. 环境准备

| 项 | 要求 | 检查命令 |
|---|---|---|
| 操作系统 | Linux（Ubuntu 22.04 / Debian 12 推荐） | `uname -a` |
| Node.js | 20.x 或 22.x（25.x 也跑过但非长期支持） | `node -v` |
| npm | 跟 Node 一起来 | `npm -v` |
| pm2 | 已装（用户已用 pm2 管别项目） | `pm2 --version` |
| nginx | 1.18+ | `nginx -v` |
| git | 任意现代版 | `git --version` |
| 端口 | 4001（内网）/ 80 / 443（公网经 nginx）| `lsof -i :4001` |

**防火墙**：
- 公网开 80 + 443（nginx）
- **不要**直接对外暴露 4001（nodesign 应该只在 localhost 监听 + nginx 反代）

---

## 2. 拉代码 + 装依赖

```bash
# 切到合适目录（跟你其他 pm2 项目同级）
cd /opt/nodesign     # 路径自己定，下面 pm2 cwd 跟着改

# 首次拉（之后用 git pull / git fetch + checkout tag）
git clone https://github.com/Xiaokebuyu/Nodesign.git .
git checkout v0.1.0-mvp     # 锁到内部测试基线

# 顶层依赖（server 端）
npm install --production

# 前端依赖（用于 build 静态产物）
cd web && npm install && cd ..

# Playwright chromium（screenshot_canvas / PDF / PPTX 都要它）
npx playwright install chromium

# Linux 系统库（playwright chromium 跑无头需要这些 .so）
npx playwright install-deps chromium
# 如果上面这条因 sudo 提示，跑：
# sudo npx playwright install-deps chromium
```

**验证点**：
- `ls node_modules/.bin/playwright` 文件存在
- `npx playwright --version` 能输出版本号

---

## 3. 配置 .env

```bash
cp .env.example .env
# 用编辑器打开，按下表填入真实值
nano .env  # 或 vim
chmod 600 .env  # 限只 owner 读写，防误暴露
```

**必填字段**：

| 字段 | 含义 | 默认值 |
|---|---|---|
| `NODESIGN_GATEWAY_URL` | LLM 网关 URL（Anthropic 协议兼容端点）| `https://tokendance.space/gateway` |
| `NODESIGN_GATEWAY_KEY` | 网关 API key（敏感，不要入仓） | （空，必填）|
| `INTERNAL_API_TOKEN` | 服务间调用 token | （空）|

**可选 / 推荐配置**：

| 字段 | 含义 | 默认 | 推荐 |
|---|---|---|---|
| `NODESIGN_MODEL` | 主 agent 用的 model | `kimi-k2.6` | 跟默认 |
| `PORT` | server 监听端口 | `4001` | 跟默认；冲突时改 |
| `NODESIGN_MAX_TURNS` | streamInput query 全局 turn 上限 | `50` | `50-80`（复杂 deck）|
| `NODESIGN_MAX_BUDGET_USD` | 单 query 预算 | `5` | `5-10`（看模型 / 用户）|
| `ENGINE_MAX_CONCURRENT_LLM` | 并发 LLM 调上限 | `5` | 跟默认 |
| `ENGINE_MAX_QUEUE_DEPTH` | 队列深度 | `3` | 跟默认 |
| `PROJECTS_DATA_DIR` | 用户产物目录 | `./server/projects-data` | 持久化路径（见 § 8）|
| `DB_PATH` | SQLite 文件路径 | `./server/db/nodesign.db` | 持久化路径（见 § 8）|
| `NODESIGN_ALLOW_SYMLINK_FALLBACK` | 不支持 symlink 时降级 warn | （不设）| **不要设**，除非真遇到 symlink 失败错 |

**Fallback 配置**（gateway 挂时直连官方）：

```env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

loop.js 优先读 `NODESIGN_GATEWAY_*`，未设时 fallback 到 `ANTHROPIC_*`。两套都填则用 gateway。

**安全说明**：`.env` 已在 `.gitignore`（见 § 8 持久化），永远不要 `git add .env`。

**验证点**：
```bash
node -e "require('dotenv').config(); console.log('GATEWAY=', process.env.NODESIGN_GATEWAY_URL)"
# 期望输出你填的 URL；如果输出 undefined 检查 .env 路径
```

---

## 4. 前端 build

```bash
cd web
npm run build
# 输出 web/dist/index.html + assets
ls -la dist/
cd ..
```

**验证点**：
- `web/dist/index.html` 存在（约 1KB）
- `web/dist/assets/*.js` 和 `*.css` 存在（按 hash 命名）

build 时间 30-60s 取决于服务器性能。

---

## 5. pm2 启动

```bash
# 检查 ecosystem.config.js 的 cwd（默认 __dirname 即仓库根）
cat ecosystem.config.js | grep cwd

# 启动
pm2 start ecosystem.config.js

# 看启动 log（应该看到 "[server] listening on :4001"）
pm2 logs nodesign --lines 30 --nostream

# 让 pm2 跟系统一起启动（首次配置一次）
pm2 startup
# 跟着提示跑显示的命令（通常一行 sudo env PATH=... pm2 startup ...）

# 保存当前进程列表
pm2 save
```

**关键 pm2 命令速查**：

| 操作 | 命令 |
|---|---|
| 看实时 log | `pm2 logs nodesign` |
| 看最近 N 行 | `pm2 logs nodesign --lines 100 --nostream` |
| 看 CPU / mem 实时 | `pm2 monit` |
| 强制重启 | `pm2 restart nodesign` |
| 0-downtime reload | `pm2 reload nodesign` |
| 停止 | `pm2 stop nodesign` |
| 删除（不再开机自启） | `pm2 delete nodesign && pm2 save` |

**验证点**：
```bash
pm2 list
# 期望看到 nodesign 状态 online，CPU/mem 有数

curl -s http://localhost:4001/api/health
# 期望: {"ok":true,"service":"nodesign","version":"0.1.0",...}
```

---

## 6. nginx 配置

把下面 server block 加到 `/etc/nginx/sites-available/nodesign`，然后软链到 `sites-enabled`：

```nginx
server {
    listen 80;
    server_name nodesign.your-domain.com;
    # 可选：HTTP → HTTPS 强制跳转
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name nodesign.your-domain.com;

    # SSL 证书（用 Let's Encrypt certbot 申请最简单）
    ssl_certificate /etc/letsencrypt/live/nodesign.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nodesign.your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 前端静态文件
    root /opt/nodesign/web/dist;
    index index.html;

    # 上传 / inline image 大小限制（用户传图给 agent vision 看）
    client_max_body_size 50M;

    # API 反代 → nodesign server
    location /api/ {
        proxy_pass http://localhost:4001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # agent turn 可能跑 1-3 分钟，timeout 调长
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
    }

    # WebSocket 反代（关键，没这个前端 WS 永远连不上）
    location /ws/ {
        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # WS 长连接，大幅延长 timeout
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # SPA fallback：所有 / 路径都返 index.html 让 React Router 接管
    location / {
        try_files $uri $uri/ /index.html;
    }

    # gzip（前端 JS/CSS 压缩传输）
    gzip on;
    gzip_types text/plain text/css application/javascript application/json;
    gzip_min_length 1024;
}
```

启用 + reload：

```bash
sudo ln -s /etc/nginx/sites-available/nodesign /etc/nginx/sites-enabled/
sudo nginx -t  # 语法检查
sudo systemctl reload nginx
```

**验证点**：
```bash
# 域名 DNS 已经指向服务器 IP 的话：
curl -I https://nodesign.your-domain.com/api/health
# 期望 HTTP 200 + JSON 响应

# 本机直查 nginx 反代是否通
curl -I http://localhost/api/health -H "Host: nodesign.your-domain.com"
```

---

## 7. 端到端验证

浏览器访问 `https://nodesign.your-domain.com`：

1. **Hub 页正常显示** — 能看到项目列表 / "新建项目"按钮
2. **新建项目** — 起一个 test 项目
3. **发条 chat**（如"帮我做个简单的 3 页 deck 介绍 React"）
4. **观察现象**：
   - chat 区出现 user message
   - 看到 agent thinking → tool calls → assistant text 流式显示
   - canvas 区中部出现 deck（agent 写完 canvas.html 后）
   - 不应该看到 ⚠️ 红色 toast / "运行失败"
5. **检查 WS 状态**：浏览器 DevTools Network → WS — 应该有 `/ws/projects/<pid>` 连接，状态 101
6. **试 export**：右上角 export 菜单 → PDF / PPTX 下载

**如果第 4 步 agent 没 thinking 就停**：可能是 .env 配错了 gateway，看 `pm2 logs nodesign` 找 `ANTHROPIC_BASE_URL` 相关错。

---

## 8. Persistent Volume（关键）

下面两个目录**必须挂卷或备份**，否则重启服务器 / 重新 deploy 用户数据全丢：

| 目录 | 内容 | 大小估算 |
|---|---|---|
| `server/projects-data/` | 用户产物：canvas.html / spec.json / .git history / agent-memory / assets | 每 project 约 10-100MB（含 git）|
| `server/db/` | SQLite DB（runs / projects 元数据）| 几 MB（量大切 PostgreSQL）|

**简单 backup 方案**（pm2 之外用 cron）：

```bash
# /etc/cron.d/nodesign-backup
0 3 * * * root tar czf /backup/nodesign-$(date +\%Y\%m\%d).tar.gz -C /opt/nodesign server/projects-data server/db && find /backup -name "nodesign-*.tar.gz" -mtime +30 -delete
# 每天 3 点打包前一天数据，保留 30 天
```

更稳的方案（rsync 到远端 / S3）按团队基础设施需求加，本 SOP 不展开。

**验证点**：
- `du -sh server/projects-data server/db` 看大小（首次部署应该几 KB）
- 试用一个 project 后再看一次（应该有 MB 级增长）

---

## 9. 监控 / 日志

### pm2 内置

```bash
pm2 logs nodesign --lines 100              # 看历史
pm2 logs nodesign                          # 实时跟（Ctrl+C 退）
pm2 monit                                  # 进程列表 + CPU/mem 图
pm2 prettylist                             # 详细 process info
```

log 文件位置（`ecosystem.config.js` 配的）：
- `logs/nodesign-out.log` — stdout（含 `[server] listening`、`[engine/runs] ...`）
- `logs/nodesign-error.log` — stderr（含 SDK binary 错、playwright 错、`[server] uncaughtException` 等）

### 关键 log 行（健康指标）

启动正常：
```
[engine/runs] SQLite ready at /opt/nodesign/server/db/nodesign.db
[server] listening on :4001
[server] health: http://localhost:4001/api/health
```

Agent 跑通：
```
[run run_xxx] getContextUsage ok — totalTokens=...
```

异常关注：
- `[server] uncaughtException:` — 有兜底但说明出过未预期错，看 stack
- `[binary-fixup-proxy]` 后跟 4xx — gateway 拒了某请求，可能 key / model name 错
- `[active-runs] query.interrupt failed` — 用户取消时 SDK 卡住，已 fallback close 但说明不优雅
- 长时间没新 log — 看 `pm2 list` 进程是否 still online

### 升级到 Sentry / Datadog

留 P1。当前 pm2 + tail 够 MVP 内部测试用。

---

## 10. 故障排查（常见症状）

### 4001 被占

```
Error: listen EADDRINUSE: address already in use :::4001
```

诊断：
```bash
lsof -i :4001
# 找到占用进程的 PID，决定 kill 还是改 PORT
```

如果不是另一个 nodesign（比如 dev 残留 / QQ 等莫名占用），改 .env：
```env
PORT=4002
```
然后 nginx config 也改 `proxy_pass http://localhost:4002;`，reload nginx + pm2 restart。

### WS 连不上（前端 chip 显示"正在重连服务器…"）

最常见 nginx 没配 WS upgrade。检查：
```bash
sudo nginx -T | grep -A 3 "location /ws"
# 必须含 proxy_set_header Upgrade $http_upgrade;
# 和    proxy_set_header Connection "upgrade";
```

### sandbox 写盘失败 / 软链失败

看 pm2 log 找：
```
[workspace] symlink failed for <name> ...
```

如果生产服务器是 Linux + 普通文件系统，不应该出现。出现说明：
1. `PROJECTS_DATA_DIR` 指到了不支持 symlink 的位置（如部分 docker volume / NFS 挂载）
2. 或文件系统权限问题

临时解决：`.env` 加 `NODESIGN_ALLOW_SYMLINK_FALLBACK=1` 降级 warn 模式（agent 写 memory 会丢，不推荐），或者换文件系统位置。

### agent 跑不动 / 返回错误

看 pm2 log 找：
- `Error: 401 ... unauthorized` — gateway key 错
- `Error: 模型不存在: xxx` — `NODESIGN_MODEL` 设错（gateway 不支持这个 model）
- `Session ID ... is already in use` — session-loop 已自动 resume，但偶发 SDK 状态混乱可重启 pm2

### playwright 报 chromium not found

```bash
cd /opt/nodesign
npx playwright install chromium
sudo npx playwright install-deps chromium
pm2 restart nodesign
```

### server 反复 crash 重启

```bash
pm2 logs nodesign --lines 200 --err
```

找最后的 stack。已经加了 `process.on('uncaughtException')` 守护，正常 SDK 错不会让进程死。如果真死多半是：
- OOM（内存爆 — playwright chromium 偶发膨胀，`max_memory_restart: '1G'` 兜底）
- 启动配置错（DB 文件不可写、.env 路径错等）

---

## 升级（拉新版本）

```bash
cd /opt/nodesign
git fetch --tags
git checkout v0.1.x-mvp     # 切到新 tag
npm install --production
cd web && npm install && npm run build && cd ..
pm2 reload nodesign         # 0-downtime 热重载
pm2 logs nodesign --lines 30
```

数据库 schema 变更**自动 migrate**（[store.js:43](server/engine/runs/store.js#L43) `ALTER TABLE` 幂等），但**升级前最好备份**：
```bash
tar czf /backup/nodesign-pre-upgrade-$(date +%Y%m%d).tar.gz -C /opt/nodesign server/projects-data server/db
```

回滚：
```bash
git checkout v0.1.0-mvp     # 或上一个稳定 tag
npm install --production
cd web && npm install && npm run build && cd ..
pm2 reload nodesign
```

---

## 已知限制（部署前要让测试用户知道）

- **单实例**：streamInput 模式下 active state 在内存，不能多 pm2 instance（plan 阶段）
- **无横向扩展**：5-10 并发用户上限，到瓶颈要 Redis pub/sub 改造（P1）
- **重启丢活跃 session**：用户在 agent 跑时 `pm2 restart` 会让 query 死，用户要重发 chat
- **SDK binary 偶发错**：已加 process uncaughtException 兜底不会拉下 server，但用户偶尔看到 ⚠️ toast，**刷新页面 / 重发即可**
- **Memory / brand 路径**：必须用 `./.claude/agent-memory/` 软链路径，软链失败时**写到错位置不会自动修复**（pm2 log 会有 throw，restart 后软链会重建）

---

## 需要后续做的

- [ ] HTTPS 证书自动续签（certbot-auto.timer）
- [ ] backup 自动化（cron + 远端同步）
- [ ] 监控告警（health endpoint 5min 失败 → 告警）
- [ ] 日志聚合（pm2 log 单机，多机时换 ELK / Loki）
- [ ] 多实例横向扩展（in-memory state → Redis）
- [ ] Sentry / Datadog 接入
- [ ] CI/CD（GitHub Actions 自动 build + 推 deploy 服务器）

这些不在 v0.1.0-mvp 范围内，先稳定 MVP 再往上叠。

---

> 部署遇到本文档没覆盖的问题，看 [HANDOVER.md](HANDOVER.md) 或翻 commit history。pm2 log + 浏览器 DevTools Network 是最常用的诊断双件套。
