#!/usr/bin/env bash
# ============================================================
# build-fpk.sh — 组装 ai-app-portal 的飞牛 FPK 包（Docker 类）
#
# 形态说明（app-develop-internal.skill §8）：
#   - Docker 类 FPK = 包内 app/docker/docker-compose.yaml 模板
#   - 业务流量走 service_port 监听端口，不走飞牛统一网关；
#     统一网关只做桌面图标入口（NAS 管理员免密通道，W10 后续接入）
#
# ⚠ 状态：脚手架。manifest 字段与目录命名需按
#   github.com/ckcoding/fnnas-docs（每晚同步官方）逐一校对后再上架。
# 用法：./build-fpk.sh <版本号>   例：./build-fpk.sh 0.1.0
# ============================================================
set -euo pipefail

VERSION="${1:?用法: ./build-fpk.sh <版本号>}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)/ai-app-portal"
OUT="$ROOT/dist"

mkdir -p "$STAGE/app/docker" "$OUT"

# 1. Docker 类 FPK：compose 模板（镜像来自 ghcr，按实际发布仓库替换）
cat > "$STAGE/app/docker/docker-compose.yaml" <<YAML
services:
  ai-app-portal:
    image: ghcr.io/neon/ai-app-portal:${VERSION}
    container_name: ai-app-portal
    restart: unless-stopped
    ports:
      - "${SERVICE_PORT:-8080}:8080"   # service_port：业务流量入口
    volumes:
      - /var/apps/ai-app-portal/data:/data
    environment:
      NODE_ENV: production
      DATA_DIR: /data
      TRIM_APPDEST: "\${TRIM_APPDEST}"
      TRIM_PKGVAR: "\${TRIM_PKGVAR}"
YAML

# 2. 包信息（字段名待按 fnnas-docs 校对：identifier/version/architecture/...）
cat > "$STAGE/info.json" <<JSON
{
  "_comment": "字段名待按 fnnas-docs 校对",
  "name": "ai-app-portal",
  "displayName": "AI应用门户",
  "version": "${VERSION}",
  "description": "自托管 AI 应用网关 + 门户：统一入口 / 自动 HTTPS / 登录鉴权 / 主题品牌",
  "arch": "all",
  "service_port": 8080,
  "gatewayPrefix": "/app/ai-app-portal"
}
JSON

# 3. 图标（上架前替换为正式 512x512 PNG）
if [ -f "$ROOT/icon.png" ]; then
  cp "$ROOT/icon.png" "$STAGE/icon.png"
else
  echo "⚠ 缺少 $ROOT/icon.png（上架必需），先产出无图标包"
fi

# 4. 打包
mkdir -p "$OUT"
( cd "$STAGE" && zip -qr "$OUT/ai-app-portal_${VERSION}.fpk" . )
echo "✓ 产出: $OUT/ai-app-portal_${VERSION}.fpk"
echo "⚠ 上架前必查（见 README.md）：manifest 字段名 / install_dep_apps=database 凭据注入 / 桌面图标免密通道 / ed25519 签名"
