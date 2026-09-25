#!/usr/bin/env bash
# 把 GitHub Release `components-win64` 的资产同步到 R2 镜像（桶 nodesign-desktop 的 components-win64/，
# 公网地址 https://dl.xiaobuyu.trade/components-win64/）。组件工作流重跑之后跑一次。
#
#   用法：R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… server/scripts/sync-components-mirror.sh
#
# 为什么是 R2 不是站点目录（2026-09-25）：站点在 Cloudflare 后面，服务器发给 Cloudflare 的流量按 CDN Interconnect
# 计费（账单名 Carrier Peering，$0.08/GiB，没有 200 GiB 免费档），组件包一个月能吃掉几十 GiB；R2 出站免费。
# 老客户端内置的站点地址 /dl/components-win64/ 由 nginx 302 到 R2，所以不用跟着发桌面版。
# 桌面版下载前会对官方（GitHub）和镜像各测 512KB 吞吐，官方通就用官方，不通或太慢就用镜像
# （server/runtime/components-fetch.js pickSource；镜像地址在清单的 mirrors 字段和 DEFAULT_MIRRORS）。
set -euo pipefail
TAG="${COMPONENTS_TAG:-components-win64}"
BUCKET="${R2_BUCKET:-nodesign-desktop}"
: "${R2_ACCOUNT_ID:?要 R2_ACCOUNT_ID}" "${R2_ACCESS_KEY_ID:?要 R2_ACCESS_KEY_ID}" "${R2_SECRET_ACCESS_KEY:?要 R2_SECRET_ACCESS_KEY}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "==> $TAG → $WORK"
gh release download "$TAG" --repo Xiaokebuyu/Nodesign --dir "$WORK" --clobber
# 清单自检：文件 sha 要跟清单一致（下载半截的文件会让客户端校验失败），不一致就不传
node - "$WORK" <<'JS'
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const dest = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
let bad = 0;
for (const [id, c] of Object.entries(m.components)) {
  if (!c.url) continue;
  const f = path.join(dest, c.url.split('/').pop());
  if (!fs.existsSync(f)) { console.log(`✗ ${id}: 没有 ${f}`); bad++; continue; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  console.log(`${sha === c.sha256 ? '✓' : '✗'} ${id} ${(fs.statSync(f).size / 1048576).toFixed(0)}MB`);
  if (sha !== c.sha256) bad++;
}
process.exit(bad ? 1 : 0);
JS
# 新版 aws cli 默认加 CRC 校验尾，R2 不认
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
EP="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
# 先传 zip，清单最后换，免得清单指向还没传完的包
for f in "$WORK"/*.zip; do
  aws s3 cp "$f" "s3://$BUCKET/$TAG/$(basename "$f")" --endpoint-url "$EP" --content-type application/zip --only-show-errors
  echo "↑ $(basename "$f")"
done
aws s3 cp "$WORK/manifest.json" "s3://$BUCKET/$TAG/manifest.json" --endpoint-url "$EP" --content-type application/json --only-show-errors
echo "==> 完成：https://dl.xiaobuyu.trade/$TAG/manifest.json"
