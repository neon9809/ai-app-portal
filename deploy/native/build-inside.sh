#!/usr/bin/env bash
# 在 node:22-bookworm（glibc Debian）容器内执行：构建原生部署产物。
# 由宿主机 build-native.sh 通过 docker run 挂载调用；产物写到 /out-native/out。
# 依赖安装（python3/make/g++）用于 better-sqlite3 无预编译包时的源码编译。
set -euo pipefail
apt-get update -qq
apt-get install -y -qq python3 make g++ >/dev/null
corepack enable
cd /app
pnpm install --frozen-lockfile
pnpm --filter @aap/shared build
pnpm --filter @aap/server build
pnpm --filter @aap/web build
pnpm --filter @aap/server --prod deploy --legacy /out-native/out
echo BUILD_INSIDE_OK
