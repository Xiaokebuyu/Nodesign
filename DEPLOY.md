# NoDesign 生产部署 SOP

> v0.1.0-mvp 内部测试版部署手册。按节顺序执行；每节末尾有"验证点"。
> 已知约束：单实例、in-memory state（重启丢活跃 session）、SDK binary 偶发错由
> uncaughtException 守护捕获不会拉下 server。

---

## 1. 环境准备

| 项 | 要求 | 检查命令 |
|---|---|---|
| 操作系统 | Linux（Ubuntu 22.04 / Debian 12 推荐） | `uname -a` |
| Node.js | 20.x 或 22.x（25.x 也跑过但非长期支持）| `node -v` |
| npm | 跟 Node 一起来 | `npm -v` |
| pm2 | 已装（多用户分别独立 daemon）| `pm2 --version` |
| nginx | 1.18+ | `nginx -v` |
| git | 任意现代版 | `git --version` |
| **bubblewrap** | SDK sandbox OS 级隔离用（必装！）| `which bwrap` |
| **socat** | SDK sandbox 网络 proxy 用（必装！）| `which socat` |
| 端口 | 4001（内网）/ 80 / 443（公网经 nginx）| `lsof -i :4001` |

```bash
# 一次装齐 sandbox 依赖（不装 nodesign 起来后调 SDK 会报
# "Sandbox required but unavailable: bubblewrap (bwrap) not installed"）
sudo apt update
sudo apt install -y bubblewrap socat
```

**防火墙**：
- 公网开 80 + 443（nginx）
- **不要**直接对外暴露 4001（nodesign 应该只在 localhost 监听 + nginx 反代）

**用户权限**：
- ⚠️ **不能用 root 跑 nodesign**——SDK 拒 root + `--dangerously-skip-permissions` 组合
- 创建独立 service 用户：`sudo useradd -r -m -s /bin/bash -d /home/nodesign nodesign`
- 项目放 `/home/nodesign/Nodesign`，pm2 daemon 也在该用户下跑（多 user 隔离）

---

## 1.5. macOS 字体（PDF/PPT 字体跟 Mac preview 对齐 — 内部用）

**为什么必装**：agent 写的 css 通常是 `font-family: 'Playfair', serif` /
`'Inter', system-ui, sans-serif` 这种 generic fallback。Mac 浏览器看到 generic
`serif` 命中 Songti SC（系统宋体），`system-ui` 命中 PingFang SC——所以 preview
看着对。Linux server 端 Chromium 默认 generic 命中 Liberation Serif / DejaVu Sans
（都是 latin only），CJK 字符进一步 fallback 到 Noto Sans 之类——跟 preview 完全
不一样。

装上 macOS 字体 + fontconfig alias 后，Linux server 的 generic family 也命中
PingFang/Songti，PDF/PPT 跟 preview 1:1。

**⚠️ 法律边界**：苹果字体（PingFang / Songti / SF Pro）是 Apple 商业授权字体，
**仅限内部用**。这套配置只让 server 端渲染 PDF/PPT 时本地用，不内联到 baked HTML
里外传给最终用户（baked HTML 仍用 Google Fonts inline 的 Noto SC/Serif SC）。
不能用于商业化对外产品/SaaS 公开提供给非内部用户的场景。

### 步骤

**A. 在 Mac 上拷字体（在你本地 Mac 跑）**

```bash
# 列出可用字体
ls /System/Library/Fonts/ | grep -iE "pingfang|songti|stheiti|helvetica"

# scp 上传到 server（替换 user@server）
scp /System/Library/Fonts/PingFang.ttc \
    /System/Library/Fonts/Songti.ttc \
    "/System/Library/Fonts/STHeiti Light.ttc" \
    "/System/Library/Fonts/STHeiti Medium.ttc" \
    /System/Library/Fonts/Helvetica.ttc \
    user@server:~/macos-fonts/
```

**B. SF Pro / SF Mono（可选但推荐）**

Apple 公开发布过 SF Pro，从 [developer.apple.com/fonts/](https://developer.apple.com/fonts/)
下载 SF-Pro-Mac.dmg / SF-Mono-Mac.dmg，挂载后里面是 .otf 文件。同样 scp 到 server。

**C. 在 server 上跑 install 脚本**

```bash
# 默认从 ~/macos-fonts/ 读字体；如放别处用 MACOS_FONT_SRC=... 环境变量
sudo bash /opt/nodesign/server/ops/install-macos-fonts.sh

# 或显式指定源
sudo MACOS_FONT_SRC=/tmp/fonts bash server/ops/install-macos-fonts.sh
```

脚本会：
1. 拷字体到 `/usr/share/fonts/macos/`
2. 拷 `server/ops/macos-fonts.conf` 到 `/etc/fonts/conf.d/99-macos.conf`
3. `fc-cache -fv` 刷缓存
4. 跑 `fc-match` 验证 generic 命中正确字体

**D. 重启 NoDesign let Chromium 重新读 fontconfig**

```bash
pm2 restart nodesign
```

### 验证点

```bash
# 1. fontconfig 命中检查
fc-match serif        # 应该是 Songti SC 或 STSong
fc-match sans-serif   # 应该是 PingFang SC
fc-match "PingFang SC"  # 应该返回 PingFang.ttc

# 2. 跑一份新中文 deck 导 PDF + PPT，跟 Mac preview 对比字体应一致
#    如果不一致，看 fc-match 是不是命中了苹果字体；不命中说明字体没装到位
```

### 卸载（如果出问题要回退）

```bash
sudo rm /etc/fonts/conf.d/99-macos.conf
sudo rm -rf /usr/share/fonts/macos
sudo fc-cache -fv
pm2 restart nodesign
```

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

# rembg python venv（mcp__nodesign__remove_background 工具用，
# server 端 spawn python subprocess 抠图出 RGBA PNG）
cd server
python3 -m venv .venv-rembg
.venv-rembg/bin/python3 -m pip install --upgrade pip
.venv-rembg/bin/python3 -m pip install rembg onnxruntime
cd ..

# server 启动时会自动 spawn server/services/rembg-service.py 常驻进程
# （server/services/rembg-launcher.js 在 index.js 里 wire 进 lifecycle hook），
# 默认预热 fast (isnet-general-use, 170MB) + balanced (birefnet-general-lite, 214MB)
# 两档；best (birefnet-general, 880MB) 按需懒加载（agent 第一次调 quality:'best'
# 触发下载 + load）。模型缓存到 ~/.u2net/，跨 server 重启复用。
#
# 不需要手动 warm——server 起来就 ready。下面这条只是首次部署"先下载 onnx 模型
# 文件减少首位用户等待"的可选 warm（也能作为安装验证）：
server/.venv-rembg/bin/python3 << 'PYEOF'
from rembg import new_session
import warnings; warnings.filterwarnings('ignore')
for m in ['birefnet-general-lite', 'isnet-general-use']:
    new_session(m)
    print(f'  ✓ {m}')
print('rembg ready (balanced + fast model files cached)')
PYEOF
# 想连 best 档也预下载（额外 ~3-5min 880MB）：
# server/.venv-rembg/bin/python3 -c "from rembg import new_session; new_session('birefnet-general'); print('best cached')"
```

**验证点**：
- `ls node_modules/.bin/playwright` 文件存在
- `npx playwright --version` 能输出版本号
- `server/.venv-rembg/bin/python3 -m rembg --help` 不报错
- `ls -lah ~/.u2net/` 显示 birefnet-general-lite.onnx (~214MB) + isnet-general-use.onnx (~170MB) 两档模型文件已下载
- server 启动后看 stdout 有 `[rembg-service] spawned PID ...` + `[rembg-service]   ✓ <model> ready`（每个 preload model 一行）+ `[rembg-service] listening on /tmp/nodesign-rembg.sock`
- `curl --unix-socket /tmp/nodesign-rembg.sock http://localhost/health` 应返 `{"ok":true,"loaded_models":[...]}`

**rembg 跨平台备注**：
- Linux 服务器跟 Mac dev 步骤完全一致，pip 自动选合适 wheel（manylinux x86_64 / arm64 都有）
- 模型缓存默认 `~/.u2net/`（service 用户家），想统一到 `/var/cache/u2net` 等共享位置：env `U2NET_HOME=/var/cache/u2net` 即可（Linux service 多用户共享时省盘）
- 若服务器内存紧张：u2net.onnx 推理峰值 ~250MB resident，pm2 `max_memory_restart` 留够
- 卸载：`rm -rf server/.venv-rembg ~/.u2net`

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
# 检查 ecosystem.config.cjs 的 cwd（默认 __dirname 即仓库根）
cat ecosystem.config.cjs | grep cwd

# 启动
pm2 start ecosystem.config.cjs

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
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name nodesign.your-domain.com;
    # HTTP 强制跳转 HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name nodesign.your-domain.com;

    # SSL 证书（用 Let's Encrypt certbot 申请最简单）
    ssl_certificate /etc/letsencrypt/live/nodesign.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nodesign.your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_prefer_server_ciphers off;
    server_tokens off;

    # 基础安全响应头（按需）
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # 前端静态文件
    root /opt/nodesign/web/dist;
    index index.html;

    # 上传 / inline image 大小限制（用户传图给 agent vision 看）
    client_max_body_size 50M;

    # 缓存静态资源（可选）
    location ~* \.(?:css|js|mjs|gif|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|eot)$ {
        expires 30d;
        access_log off;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    # API 反代 → nodesign server
    location /api/ {
        proxy_pass http://127.0.0.1:4001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # agent turn 可能跑 1-3 分钟，timeout 调长
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # WebSocket 反代（关键，没这个前端 WS 永远连不上）
    location /ws/ {
        proxy_pass http://127.0.0.1:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WS 长连接，大幅延长 timeout
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_connect_timeout 60s;
    }

    # 根路径分流（2026-09-09 官网）：没有登录 cookie 的访客去官网 /welcome/（web/public/welcome/，
    # 纯静态随前端一起部署），带 cookie 的直接进应用。cookie 过期的会走到 SPA，AuthGate 再送去 /welcome/。
    # exact match 优先于下面的 location /，所以这里的头要重写一遍。
    location = / {
        if ($cookie_nd_auth = "") { return 302 /welcome/; }
        try_files /index.html =404;
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    }

    # SPA fallback：所有 / 路径都返 index.html 让 React Router 接管
    location / {
        try_files $uri $uri/ /index.html;
    }

    # gzip（前端 JS/CSS 压缩传输）
    gzip on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_types
        text/plain
        text/css
        application/javascript
        application/json;
    gzip_vary on;
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

log 文件位置（`ecosystem.config.cjs` 配的）：
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

### "Sandbox required but unavailable: bubblewrap (bwrap) not installed"

```bash
sudo apt install -y bubblewrap socat
sudo -u nodesign env HOME=/home/nodesign pm2 restart nodesign
```

### "--dangerously-skip-permissions cannot be used with root/sudo privileges"

SDK 拒 root + skip-permissions 组合。**必须**用 non-root service 用户跑（见 § 1
环境准备 / § 5 pm2 启动）。如果误把 nodesign 起在 root pm2 daemon 下：

```bash
# root shell
pm2 delete nodesign
pm2 save
sudo cp -r /root/NO_DESIGN_DEV /home/nodesign/Nodesign  # 或者 chown 原位置
sudo chown -R nodesign:nodesign /home/nodesign/Nodesign
sudo -iu nodesign
cd ~/Nodesign && pm2 start ecosystem.config.cjs && pm2 save
```

### "Claude Code native binary not found at .../linux-x64-musl/claude"

Ubuntu/Debian GLIBC 系统 SDK 的 platform detection **误判成 musl**。修法：

```bash
# 项目根目录
npm install --no-save @anthropic-ai/claude-agent-sdk-linux-x64

# 软链 musl 路径 → GLIBC binary
rm -f node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude
ln -sf ../claude-agent-sdk-linux-x64/claude \
       node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude

# 验证
node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude --version
# 期望: 2.x.x (Claude Code)

sudo -u nodesign env HOME=/home/nodesign pm2 restart nodesign
```

### "ERR_MODULE_NOT_FOUND: Cannot find package '@anthropic-ai/claude-agent-sdk'"

`npm install --omit=dev` 跳了 SDK（之前 SDK 误放在 devDependencies，现已挪到
dependencies 但旧 node_modules 缓存可能仍漏）：

```bash
rm -rf node_modules
npm install --omit=dev --include=optional
```

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

---

## dev 实例搭建（推荐：让 Linux 成为 source of truth）

为什么需要：Mac 跟 Linux 在 path / sandbox / OAuth 行为上有非平凡差异（见下节"跨平台决策档案"）。
**最优开发体验** = Mac 上跑 Cursor + SSH Remote 接到 Linux dev 实例上 = 真 Linux 内核 + Mac 工具链。

### 在生产服务器上加一个 dev 用户（零成本）

```bash
# 1. root 登录服务器，建 dev 账号
sudo useradd -m -s /bin/bash nodesign-dev
sudo usermod -aG sudo nodesign-dev   # 可选；装依赖时方便
sudo passwd nodesign-dev             # 设密码 / 或者 ssh-copy-id 推 key

# 2. 切到 dev 用户，clone 代码（独立工作树，跟生产 nodesign 用户隔离）
sudo -iu nodesign-dev
cd ~ && git clone https://github.com/Xiaokebuyu/Nodesign.git
cd Nodesign && npm install
cd web && npm install && cd ..
npx playwright install chromium

# 3. 配 dev .env（端口换 4002 避开生产 4001）
cp .env.example .env
# 编辑：PORT=4002，其他 NODESIGN_GATEWAY_URL / KEY 跟生产一致或独立

# 4. 起 dev server（手动启，不用 pm2，方便看 log）
npm run dev
# 或者也 pm2 跑：pm2 start ecosystem.config.cjs --only nodesign-dev
```

### Cursor / VS Code Remote 接进来

```bash
# Mac 上 Cursor 装 "Remote - SSH" 扩展（VS Code 同），然后：
# Cmd+Shift+P → Remote-SSH: Connect to Host → 输入 nodesign-dev@<server-ip>
# 接进去后 File → Open → /home/nodesign-dev/Nodesign
```

之后写代码体验跟本地完全一样（Cursor 的 AI 也跨 SSH work），但**所有运行 / 测试都在真 Linux 上**。

### 端口分隔（生产 vs dev）

| 实例 | 端口 | pm2 进程名 | 数据目录 |
|---|---|---|---|
| 生产 | 4001 | `nodesign` | `/home/nodesign/Nodesign/` |
| dev  | 4002 | `nodesign-dev` | `/home/nodesign-dev/Nodesign/` |

nginx 不反代 4002（dev 走 ssh 端口转发：`ssh -L 4002:localhost:4002 ...`），生产用户看不到 dev。

---

## 跨平台决策档案（2026-05 落档）

NoDesign 部署到 Linux 时踩过 3 类坑，沉淀成 [`server/runtime/platform.js`](server/runtime/platform.js) 单一决策来源：

### 坑 1：CLAUDE_CONFIG_DIR 设计假设

- **现象**：原架构 per-session 隔离 `.claude/`，Linux 上 SDK list/fork/delete 找不到 jsonl
- **根因**：SDK 假设 `CLAUDE_CONFIG_DIR` 全局 + per-cwd encoded subdir，per-session 跟设计哲学冲突
- **修复**：`platform.claudeConfigDir = $HOME/.claude`（或 `NODESIGN_CONFIG_DIR` 覆盖）

### 坑 2：bwrap 不解析 symlink

- **现象**：sandbox 启动失败 / agent Glob/Read 看不到 `assets/` `agent-memory/`
- **根因**：bwrap bind-mount 模型对目录型 symlink 不友好；Mac sandbox-exec 没此问题
- **修复**：
  - 软链拓扑重构（`.claude/` 文件型 / session root 目录型，全用绝对路径）
  - sandbox 默认关：`platform.sandboxEnabled = false`，`NODESIGN_SANDBOX=on` 可强制开

### 坑 3：WebFetch preflight 假设 OAuth

- **现象**：`DomainCheckFailedError "blocking claude.ai"`，gateway key 模式 100% 复现
- **根因**：SDK 内置 `nV7()` preflight 调 Anthropic 域名分类 API，需要 `~/.claude` 残留 OAuth token；gateway key 模式 + non-root user 没 token
- **修复**：`platform.skipWebFetchPreflight = true`（SDK 官方 enterprise 开关）

### 启动诊断

server/index.js 启动时调 `platform.dump()` 打 OS / HOME / claudeConfigDir / sandbox / preflight 配置。Linux 排查问题第一步：`pm2 logs nodesign | grep '\[platform\]'`。

### env 开关速查

| env | 默认 | 何时改 |
|---|---|---|
| `NODESIGN_CONFIG_DIR` | `$HOME/.claude` | 容器化 / 多实例共享卷 |
| `NODESIGN_SANDBOX` | (off) | 设 `on` 强制开 sandbox 验证（仅 SDK 修 symlink 后）|
| `NODESIGN_ALLOW_SYMLINK_FALLBACK` | (off) | Windows / 不支持 symlink 的 docker volume 强制降级 warn |
