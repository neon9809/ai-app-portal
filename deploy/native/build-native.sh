#!/usr/bin/env bash
# ============================================================
# build-native.sh — 产出「无 Docker」原生部署包（自含 glibc Node 22）
#
# 用法：./build-native.sh linux/arm64|linux/amd64
# 产物：dist/ai-app-portal-native_<版本>_linux_<arch>.tar.gz
#
# 原理：在 node:22-bookworm（glibc Debian）容器内构建产物——
#   better-sqlite3 等原生模块必须按目标平台的 C 库编译，不能复用
#   alpine（musl）镜像产物；Node 二进制取自同一镜像（ABI 一致）。
#   包内自含 Node，飞牛/Debian 主机解压即跑，无需安装 Node。
# ============================================================
set -euo pipefail
PLATFORM="${1:?用法: ./build-native.sh linux/arm64|linux/amd64}"
case "$PLATFORM" in
  linux/arm64) ARCH=arm64 ;;
  linux/amd64) ARCH=amd64 ;;
  *) echo "不支持的平台: $PLATFORM" >&2; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST="$ROOT/deploy/native/dist"
VER="$(node -p "require('$ROOT/package.json').version")"
IMG="docker.m.daocloud.io/library/node:22-bookworm"
SRC="$(mktemp -d)/src"
mkdir -p "$DIST"

echo "① 复制源码（排除 node_modules/dist/.git，不污染宿主依赖树）"
rsync -a \
  --exclude node_modules --exclude '*/node_modules' \
  --exclude .git --exclude dist --exclude data \
  --exclude '.zcode' --exclude '*.log' \
  "$ROOT/" "$SRC/"

echo "② 拉基础镜像（Docker Hub 直连超时时走 DaoCloud 源）"
docker pull --platform "$PLATFORM" "$IMG" || {
  docker pull --platform "$PLATFORM" "node:22-bookworm"
  IMG="node:22-bookworm"
}

echo "③ 容器内构建（glibc 产物）"
docker run --rm --platform "$PLATFORM" \
  -v "$SRC:/app" -v "$DIST/out-$ARCH:/out-native" \
  "$IMG" bash /app/deploy/native/build-inside.sh

echo "④ 取出同镜像的 Node 22 二进制（ABI 与编译环境一致）"
CID=$(docker create --platform "$PLATFORM" "$IMG")
docker cp "$CID:/usr/local/bin/node" "$DIST/out-$ARCH/node"
docker rm "$CID" >/dev/null

echo "⑤ 组装包"
BUNDLE="$DIST/ai-app-portal-native_${VER}_linux_$ARCH"
rm -rf "$BUNDLE" && mkdir -p "$BUNDLE/bin"
cp "$DIST/out-$ARCH/node" "$BUNDLE/bin/node" && chmod +x "$BUNDLE/bin/node"
cp -R "$DIST/out-$ARCH/out/node_modules" "$BUNDLE/node_modules"
cp "$DIST/out-$ARCH/out/package.json" "$BUNDLE/package.json"
cp -R "$SRC/apps/server/dist" "$BUNDLE/dist"
cp -R "$SRC/apps/server/drizzle" "$BUNDLE/drizzle"
cp -R "$SRC/apps/web/dist" "$BUNDLE/public"
cp -R "$SRC/packages/aap-sdk" "$BUNDLE/aap-sdk"
cp "$ROOT/deploy/native/start.sh" "$BUNDLE/start.sh" && chmod +x "$BUNDLE/start.sh"
cp "$ROOT/deploy/native/README-NATIVE.md" "$BUNDLE/README-NATIVE.md"
# 开发指南/平台文档随包（guideRouter 定位 <载荷根>/assets/，三件与 Dockerfile 同源；
# 此前遗漏导致原生形态「开发指南」404）
mkdir -p "$BUNDLE/assets"
cp "$ROOT/ai-app-portal-docs/app-develop.skill-v0.2.md" "$BUNDLE/assets/"
cp "$ROOT/README.md" "$BUNDLE/assets/README.md"
cp "$ROOT/ai-app-portal-docs/app-develop-internal.skill.md" "$BUNDLE/assets/"

echo "⑥ 打包"
tar -C "$DIST" -czf "$BUNDLE.tar.gz" "$(basename "$BUNDLE")"
echo "✓ 产出: $BUNDLE.tar.gz"
