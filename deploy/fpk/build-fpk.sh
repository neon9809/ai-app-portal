#!/usr/bin/env bash
# ============================================================
# build-fpk.sh — 组装 ai-app-portal 的飞牛 FPK 包（Docker 类）
#
# 形态说明（app-develop-internal.skill §8）：
#   - Docker 类 FPK = 包内 app/docker/docker-compose.yaml 模板
#   - 业务流量走 service_port 监听端口，不走飞牛统一网关；
#     统一网关只做桌面图标入口（NAS 管理员免密通道，后续版本接入）
#
# 包源：fpk-root/（模板，__VERSION__ 占位符由本脚本替换）
# 用法：./build-fpk.sh <版本号> [镜像引用]
#   例：./build-fpk.sh 0.1.0 ghcr.io/neon9809/ai-app-portal
# ============================================================
set -euo pipefail

VERSION="${1:?用法: ./build-fpk.sh <版本号> [镜像引用]}"
IMAGE_REF="${2:-ghcr.io/neon9809/ai-app-portal}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)/ai-app-portal"
OUT="$ROOT/dist"

[ -d "$ROOT/fpk-root" ] || { echo "✗ 缺少包源目录 $ROOT/fpk-root"; exit 1; }

# 1. 复制模板并替换版本占位符
mkdir -p "$STAGE"
cp -R "$ROOT/fpk-root/." "$STAGE/"
grep -rl "__VERSION__" "$STAGE" | while read -r f; do
  sed -i.bak "s|__VERSION__|${VERSION}|g" "$f" && rm -f "$f.bak"
done
# 镜像引用（CI 传入 github.repository；本地默认 ghcr 固定路径）
if [ -f "$STAGE/app/docker/docker-compose.yaml" ]; then
  sed -i.bak "s|__IMAGE_REF__|${IMAGE_REF}|g" "$STAGE/app/docker/docker-compose.yaml" && rm -f "$STAGE/app/docker/docker-compose.yaml.bak"
fi

# 2. 图标（上架前替换为正式 512x512 PNG）
if [ -f "$ROOT/icon.png" ]; then
  cp "$ROOT/icon.png" "$STAGE/icon.png"
else
  echo "⚠ 缺少 $ROOT/icon.png（上架必需），先产出无图标包"
fi

# 3. 打包
mkdir -p "$OUT"
( cd "$STAGE" && zip -qr "$OUT/ai-app-portal_${VERSION}.fpk" . )
echo "✓ 产出: $OUT/ai-app-portal_${VERSION}.fpk（镜像 ${IMAGE_REF}:${VERSION}）"
echo "⚠ 上架前必查（见 README.md）：manifest 字段名 / install_dep_apps=database 凭据注入 / 桌面图标免密通道 / ed25519 签名"
