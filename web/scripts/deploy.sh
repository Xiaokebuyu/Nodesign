#!/usr/bin/env bash
# 构建 + 无缝换入口（2026-08-03）
#
# 为什么不能直接 `npm run build`：
#   nginx 直接托管 web/dist，而 vite build 的第一件事是**清空 dist**。于是每次
#   构建都有几秒钟站点是半残的（index.html 没了、分片没了），任何人这时候刷新
#   都会白屏或报错。
#
#   更麻烦的是第二件事：分片名带内容指纹，清空等于**删掉上一版的分片**。已经开着
#   页面的人手里那份 index.js 记的是旧分片名，等他点进站点窗口触发懒加载
#   （DeckWindow / SiteWindow），那个文件已经不存在了 —— 报
#   "Failed to fetch dynamically imported module"，而且浏览器会记住这次失败不再重试。
#
# 做法：构建到旁边的 dist-build，然后
#   1. 新分片**加**进 dist/assets，旧的一个不删 —— 老页面继续能取到自己的分片
#   2. index.html 最后换，且用同分区 mv（原子替换，没有"文件写了一半"的瞬间）
#   3. 顺手清掉 KEEP_DAYS 天没被任何一次部署碰过的分片
#
# 前端还有第二道保险：main.jsx 里监听分片加载失败 → 自动刷一次（只刷一次）。
set -euo pipefail

cd "$(dirname "$0")/.."          # web/
KEEP_DAYS="${KEEP_DAYS:-7}"
BUILD_DIR="dist-build"
LIVE_DIR="dist"

echo "==> 构建到 $BUILD_DIR"
# nice：这台是 1 vCPU 生产机，构建/测试吃满核会让线上会话首字延迟几十秒（08-21 实测 69s）
nice -n 15 npx vite build --outDir "$BUILD_DIR" --emptyOutDir

if [ ! -f "$BUILD_DIR/index.html" ]; then
  echo "!! 构建没产出 index.html，中止（线上保持原样）" >&2
  exit 1
fi

mkdir -p "$LIVE_DIR/assets"

echo "==> 新分片加进 $LIVE_DIR/assets（旧的保留）"
cp -a "$BUILD_DIR/assets/." "$LIVE_DIR/assets/"

# assets 和 index.html 之外的静态文件（favicon、robots 之类）直接覆盖
find "$BUILD_DIR" -maxdepth 1 -mindepth 1 ! -name assets ! -name index.html \
  -exec cp -a {} "$LIVE_DIR/" \;

echo "==> 换入口（同分区 mv，原子）"
cp "$BUILD_DIR/index.html" "$LIVE_DIR/.index.html.new"
mv -f "$LIVE_DIR/.index.html.new" "$LIVE_DIR/index.html"

echo "==> 清理 ${KEEP_DAYS} 天没被碰过的旧分片"
# 每次部署 cp -a 会把仍在用的分片 mtime 刷新到本次构建时间，所以"老"= 真的没人引用了
PRUNED=$(find "$LIVE_DIR/assets" -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)

echo "==> 完成：分片 $(find "$LIVE_DIR/assets" -type f | wc -l) 个，清理 $PRUNED 个"

# ── 服务端新鲜度闸门 ────────────────────────────────────────────────────
#
# **node 不热重载。** 改了服务端不重启，就是拿旧代码验新功能 —— 而且一点
# 报错都没有：前端是新的、接口行为是旧的，表现成"我明明改了怎么没生效"。
# 这个项目 2026-08-07 一天中过两次，2026-08-13 又中一次（放开产物搬家那条
# 改完只 deploy 没 restart，用户硬刷新照样不 OK）。
#
# 判据：`server/` 里最新的文件比正在监听的那个进程还新 = 它跑的是旧代码。
# 只提醒不自动重启 —— 重启会打断正在跑的 agent 会话，那得由人决定。
PORT="${ND_PORT:-}"
if [ -z "$PORT" ]; then
  case "$(pwd)" in
    *Nodesign-canvas*) PORT=4002 ;;
    *Nodesign-exp*)    PORT=4002 ;;
    *)                 PORT=4001 ;;
  esac
fi
SRV_PID=$(ss -lptnH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -n "$SRV_PID" ]; then
  PROC_EPOCH=$(date -d "$(ps -o lstart= -p "$SRV_PID")" +%s 2>/dev/null || echo 0)
  # ⚠️ `|| true` 不是保险起见，是这道闸 2026-08-31 之前**一直是死的**：
  # `find … | sort -rn | head -1` 里 head 取完一行就关管道 → sort 吃 SIGPIPE 退 141 →
  # `set -euo pipefail` 把整个脚本静默掐掉在这一行。表现是部署跑完一切正常、
  # 「服务端有改动比进程还新」一个字不印 —— 而它正是用来防「改了服务端忘了 restart」
  # 的那道闸。⭐ 它还跟文件数量有关（少几个文件时 sort 一次写完就不触发），
  # 所以能装死很久：这仓库为「node 不热重载」中过至少三次，每次都以为是自己忘了。
  NEWEST=$(find ../server -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.md' \) \
    -not -path '*/node_modules/*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 || true)
  NEWEST_EPOCH=${NEWEST%% *}
  NEWEST_FILE=${NEWEST#* }
  if [ -n "$NEWEST_EPOCH" ] && [ "${NEWEST_EPOCH%.*}" -gt "$PROC_EPOCH" ]; then
    echo ""
    echo "⚠️  服务端有改动比进程还新，:$PORT 上跑的是旧代码"
    echo "    最新改动：$NEWEST_FILE"
    echo "    node 不热重载 —— 要生效得： pm2 restart <应用名>"
    echo ""
  fi
fi
