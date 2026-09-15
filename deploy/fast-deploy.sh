#!/usr/bin/env bash
# ============================================================================
# 快速部署：本地构建 + docker cp 灌入（轻量测试机首选，零服务器下载）
#
# 背景：阿里云轻量机带宽峰值极小，服务器上 docker compose build 会触发
# pnpm 全量拉包、两次把整机打到用户态饿死（758ec46 事故）。本脚本改为：
#   1. 本地构建 shared / server / web 产物
#   2. rsync 产物与源码到服务器（排除 data/.git/node_modules 等）
#   3. docker cp 灌进运行中容器的 /out，docker restart 生效
# 全程零下载，数分钟完成。
#
# 注意：cp 内容跨 docker restart 存活，但 compose up -d 重建容器后会丢失，
# 回退为镜像内容。因此：
#   - 日常代码变更 -> 本脚本即可
#   - 依赖变更（pnpm-lock.yaml）或要固化进镜像时 -> 服务器跑一次
#     `cd deploy/docker && docker compose build && up -d`
#     （Dockerfile 已做 manifest 先行 + pnpm store 缓存挂载，构建不再全量拉包）
#
# 用法：
#   AAP_DEPLOY_HOST=user@your-host ./deploy/fast-deploy.sh
#   （部署目标必填，不内置任何真实主机；可选 AAP_DEPLOY_KEY 指定私钥路径）
# ============================================================================
set -euo pipefail

HOST="${AAP_DEPLOY_HOST:?'必须通过环境变量指定部署目标：AAP_DEPLOY_HOST=user@host ./deploy/fast-deploy.sh'}"
KEY="${AAP_DEPLOY_KEY:-$HOME/.ssh/aap_portal_test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="/opt/ai-app-portal"
CONTAINER="ai-app-portal"

echo "==> [1/3] 本地构建 shared -> server -> web"
pnpm --filter @aap/shared build
pnpm --filter @aap/server build
pnpm --filter @aap/web build

echo "==> [2/3] rsync -> $HOST:$REMOTE_DIR"
rsync -az \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  --exclude office-tool \
  --exclude 'apps/server/e2e/.run' \
  --exclude '*.log' \
  --exclude '*.db*' \
  --exclude .zcode \
  --exclude .DS_Store \
  -e "ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15" \
  "$ROOT/" "$HOST:$REMOTE_DIR/"

echo "==> [3/3] docker cp -> $CONTAINER:/out 并重启"
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" CONTAINER="$CONTAINER" 'bash -s' <<'REMOTE_SCRIPT'
set -e
docker exec "$CONTAINER" sh -c 'rm -rf /out/dist/* /out/public/* /out/aap-sdk/* /out/drizzle/*'
docker cp "$REMOTE_DIR/apps/server/dist/."           "$CONTAINER:/out/dist/"
docker cp "$REMOTE_DIR/apps/web/dist/."              "$CONTAINER:/out/public/"
docker cp "$REMOTE_DIR/packages/aap-sdk/."           "$CONTAINER:/out/aap-sdk/"
docker cp "$REMOTE_DIR/apps/server/drizzle/."        "$CONTAINER:/out/drizzle/"
docker cp "$REMOTE_DIR/ai-app-portal-docs/app-develop.skill-v0.2.md"     "$CONTAINER:/out/assets/app-develop.skill-v0.2.md"
docker cp "$REMOTE_DIR/ai-app-portal-docs/app-develop-internal.skill.md" "$CONTAINER:/out/assets/app-develop-internal.skill.md"
docker cp "$REMOTE_DIR/README.md"                    "$CONTAINER:/out/assets/README.md"
docker restart "$CONTAINER" >/dev/null
sleep 6
docker ps --format '{{.Names}} {{.Status}}'
printf 'health: '
curl -s --max-time 8 http://127.0.0.1/api/health
echo
REMOTE_SCRIPT

echo "==> 部署完成"
