#!/usr/bin/env bash
# 把 GitHub Release `components-win64` 的资产同步到站点的镜像目录（站主在服务器上跑；组件工作流重跑之后再跑一次）。
#
#   用法：server/scripts/sync-components-mirror.sh [目标目录]   默认 /var/www/nodesign-dl/components-win64
#
# nginx 要给 /dl/ 一个 location（只需一次）：
#   location /dl/ { alias /var/www/nodesign-dl/; autoindex off; add_header Cache-Control "public, max-age=3600"; }
# 桌面版下载前会对官方（GitHub）和这个镜像各测 512KB 吞吐，官方通就用官方，不通或太慢就用这里
# （server/runtime/components.js pickSource；镜像地址在清单的 mirrors 字段和 DEFAULT_MIRRORS）。
set -euo pipefail
TAG="${COMPONENTS_TAG:-components-win64}"
DEST="${1:-/var/www/nodesign-dl/$TAG}"
mkdir -p "$DEST"
echo "==> $TAG → $DEST"
gh release download "$TAG" --repo Xiaokebuyu/Nodesign --dir "$DEST" --clobber
# 清单自检：镜像里的文件 sha 要跟清单一致（下载半截的文件会让客户端校验失败）
node - "$DEST" <<'JS'
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
echo "==> 完成"
