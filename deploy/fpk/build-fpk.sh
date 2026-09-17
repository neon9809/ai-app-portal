#!/usr/bin/env bash
# ============================================================
# build-fpk.sh — 组装 ai-app-portal 的飞牛 FPK 包（原生形态）
#
# 形态（app-develop-internal.skill §8，2026-09 定稿）：
#   - 原生 FPK：载荷 = deploy/native 自包含包（自带 glibc Node 22 + 按目标
#     C 库编译的 better-sqlite3），运行时依赖声明 install_dep_apps=python312
#   - 入口 = 本服务自主监听端口（wizard_port，默认 8080，0.0.0.0）：
#     内网直连，外网走门户自带 HTTPS/ACME 或用户自有反代；业务鉴权全部
#     走门户自有账号体系。桌面图标 = type=url 快捷方式，不经飞牛统一网关
#     （GATEWAY_PREFIX/SOCKET_PATH 服务端能力保留休眠，默认不启用）
#   - 前端用包内根路径构建（与 Docker/端口形态同一套 dist，无前缀差异）
#   - Docker 形态不再出 FPK（deploy/docker 继续服务非飞牛用户）
#
# 包源：fpk-root/（manifest 内 __VERSION__/__PLATFORM__ 占位符）
# 用法：./build-fpk.sh <版本号> <x86|arm|all> [原生包tar.gz路径]
#   例：./build-fpk.sh 0.1.0 all
# 前置：deploy/native/dist 下有对应版本与架构的原生包（缺省自动查找）。
# ============================================================
set -euo pipefail

VERSION="${1:?用法: ./build-fpk.sh <版本号> <x86|arm|all> [原生包tar.gz路径]}"
PLATFORMS="${2:-all}"
NATIVE_TARBALL="${3:-}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIST="$ROOT/../native/dist"
OUT="$ROOT/dist"
REPO="$(cd "$ROOT/../.." && pwd)"

case "$PLATFORMS" in x86|arm|all) ;; *) echo "✗ 平台参数必须是 x86|arm|all" >&2; exit 1;; esac
[ -d "$ROOT/fpk-root" ] || { echo "✗ 缺少包源目录 $ROOT/fpk-root" >&2; exit 1; }
mkdir -p "$OUT"

build_one() {
  local platform="$1"   # fnOS platform 值：x86 | arm
  local arch            # 原生包架构：amd64 | arm64
  case "$platform" in
    x86) arch=amd64 ;;
    arm) arch=arm64 ;;
  esac

  # ① 原生包定位（显式参数 > dist 目录按版本+架构查找）
  local tarball="$NATIVE_TARBALL"
  if [ -z "$tarball" ]; then
    tarball="$NATIVE_DIST/ai-app-portal-native_${VERSION}_linux_${arch}.tar.gz"
  fi
  if [ ! -f "$tarball" ]; then
    echo "✗ 缺少原生包 $tarball" >&2
    echo "  先执行 ./deploy/native/build-native.sh linux/${arch}，或把 tar.gz 路径作为第三个参数传入" >&2
    exit 1
  fi

  local stage
  stage="$(mktemp -d)/ai-app-portal"
  mkdir -p "$stage"

  # ② 模板 + 占位符（manifest 版本 / 平台）
  cp -R "$ROOT/fpk-root/." "$stage/"
  mkdir -p "$stage/wizard"   # git 不跟踪空目录，fnpack 必检项，打包时补齐
  grep -rl "__VERSION__\|__PLATFORM__" "$stage" | while read -r f; do
    sed -i.bak -e "s|__VERSION__|${VERSION}|g" -e "s|__PLATFORM__|${platform}|g" "$f" && rm -f "$f.bak"
  done

  # ③ 载荷：原生自包含包 → app/server/（安装后 $TRIM_APPDEST/server）
  mkdir -p "$stage/app"
  tar -xzf "$tarball" -C "$stage/app"
  mv "$stage/app/ai-app-portal-native_${VERSION}_linux_${arch}" "$stage/app/server"
  # 开发指南/平台文档随包（guideRouter 定位 <载荷根>/assets/；旧 native 包亦补齐）
  mkdir -p "$stage/app/server/assets"
  cp "$REPO/ai-app-portal-docs/app-develop.skill-v0.2.md" \
     "$REPO/README.md" \
     "$REPO/ai-app-portal-docs/app-develop-internal.skill.md" \
     "$stage/app/server/assets/"

  # ④ 剔除编译进 dist 的测试文件（不随包分发）；前端直接用包内根路径构建
  #    （build-native 产物即 Docker/端口同款 dist，与图标端口入口语义一致）
  rm -rf "$stage/app/server/dist/__tests__"

  # ⑤ 图标（包根 ICON.PNG/ICON_256.PNG + 入口 images/icon_{0}.png）
  cp "$ROOT/icon_64.png" "$stage/ICON.PNG"
  cp "$ROOT/icon_256.png" "$stage/ICON_256.PNG"
  mkdir -p "$stage/app/ui/images"
  cp "$ROOT/icon_64.png" "$stage/app/ui/images/icon_64.png"
  cp "$ROOT/icon_256.png" "$stage/app/ui/images/icon_256.png"
  chmod 755 "$stage/cmd/"* "$stage/app/server/start.sh" "$stage/app/server/bin/node"

  # ⑥ 打包（官方 .fpk 格式 = tar.gz；格式依据官方 fnpack 1.2.3 产物逆向 +
  #    fnos-dashboard/fpk-sandbox 已验证实现，此前用 zip 被真机判「无效」）：
  #    a) 内层 app.tgz = gzip(tar(app/** ++ config/** 副本))
  #    b) manifest 按 key 宽度对齐「 = 」并追加 checksum = md5(app.tgz)（安装器完整性校验）
  #    c) 外层 tar.gz：app.tgz 置首 + 其余条目平铺
  local out="$OUT/ai-app-portal_${VERSION}_${platform}.fpk"
  rm -f "$out"
  # COPYFILE_DISABLE + --no-xattrs：禁止 macOS tar 把扩展属性打成 ._*/PaxHeader 条目
  export COPYFILE_DISABLE=1
  ( cd "$stage/app" && tar --no-xattrs -czf "$stage/app.tgz" \
      --exclude='.DS_Store' --exclude='Thumbs.db' --exclude='__MACOSX' --exclude='._*' --exclude='*.bak' \
      server ui -C "$stage" config )
  rm -rf "$stage/app"
  local md5 width
  md5="$(md5 -q "$stage/app.tgz" 2>/dev/null || md5sum "$stage/app.tgz" | awk '{print $1}')"
  width="$(awk -F= '{k=$1; sub(/[ \t]+$/,"",k); if(length(k)>w) w=length(k)} END{print w+0}' "$stage/manifest")"
  awk -F= -v w="$width" '{k=$1; sub(/[ \t]+$/,"",k); v=substr($0, index($0,"=")+1); sub(/^[ ]/,"",v); printf "%-*s = %s\n", w, k, v}' \
      "$stage/manifest" > "$stage/manifest.packed"
  printf '%-*s = %s\n' "$width" "checksum" "$md5" >> "$stage/manifest.packed"
  mv "$stage/manifest.packed" "$stage/manifest"
  ( cd "$stage" && tar --no-xattrs -czf "$out" \
      --exclude='.DS_Store' --exclude='._*' app.tgz cmd config ICON.PNG ICON_256.PNG manifest wizard )
  echo "✓ 产出: ${out}（platform=${platform}，载荷 ${tarball##*/}，checksum=${md5}）"
}

for p in $([ "$PLATFORMS" = all ] && echo "x86 arm" || echo "$PLATFORMS"); do
  echo "=== platform=$p ==="
  build_one "$p"
done

echo "⚠ 真机验证清单：安装（.fpk=tar.gz+内层app.tgz，格式已对齐官方 fnpack）→ 向导端口（wizard_port）→ 桌面图标新标签页打开 http://NAS:端口 → 启停/状态 → 初始管理员密码在数据目录 app.log（TRIM_PKGVAR）"
