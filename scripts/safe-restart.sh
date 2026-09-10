#!/usr/bin/env bash
# scripts/safe-restart.sh —— 等在飞回合跑完再重启（2026-09-10）
#
# 为什么要有这个脚本：`node -e "…console.log('在飞回合:', n)" && pm2 restart nodesign`
# 这一行 09-10 掐掉了一个真人的回合（run_mtvmj4si_oaz0 死成 cancelled: aborted_tools）。
# 它**把 1 打印在了屏幕上**，然后照样重启 —— node 不管打印什么，退出码都是 0，`&&` 当然放行。
# 同一条病这个仓库犯到第三次了（grep 的退出码、idle 脚本的退出码，都是"判据打印了却没接到退出码"）。
#
# ⭐ 规矩写进代码而不是注释：**打印出来的数字不是闸，退出码才是闸**。
#    下面这段探针有回合在飞就 `process.exit(9)`，所以 `&&` 拦得住它。
#
# 用法： bash scripts/safe-restart.sh [pm2 应用名]     默认 nodesign
#        WAIT_MAX=600 bash scripts/safe-restart.sh     最多等多久（秒，默认 600）
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-nodesign}"
WAIT_MAX="${WAIT_MAX:-600}"
STEP=10

# 在飞 = runs 表里 status='running'。⚠️ 用户按停的回合不落终态，会留下孤儿 running 行
# （见 [[nodesign-chat-composer-fixes]]），所以只认最近 30 分钟内开始的那些。
probe() {
  node --env-file=.env -e "
    import('node:sqlite').then(({ DatabaseSync }) => {
      const d = new DatabaseSync(process.env.DB_PATH || 'server/db/nodesign.db', { readOnly: true });
      const n = d.prepare(\"SELECT COUNT(*) c FROM runs WHERE status='running' AND started_at > datetime('now','-30 minutes')\").get().c;
      console.log('在飞回合:', n);
      process.exit(n === 0 ? 0 : 9);      // ⛔ 这一行就是闸
    }).catch((e) => { console.error('探针自己坏了：', e.message); process.exit(2); });
  "
}

waited=0
until probe; do
  code=$?
  [ "$code" = 9 ] || { echo "!! 探针异常退出（$code），不敢重启"; exit "$code"; }
  [ "$waited" -lt "$WAIT_MAX" ] || { echo "!! 等了 ${WAIT_MAX}s 还有回合在飞，放弃（要硬来自己 pm2 restart $APP）"; exit 1; }
  sleep "$STEP"; waited=$((waited + STEP))
  echo "   …已等 ${waited}s"
done

echo "==> 没有在飞回合，重启 $APP"
pm2 restart "$APP" --update-env
