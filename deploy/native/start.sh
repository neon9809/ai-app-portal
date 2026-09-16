#!/usr/bin/env bash
# AI应用门户 原生运行入口（无 Docker）。说明见 README-NATIVE.md。
# 必需外部依赖仅 python3（沙箱运行时；Debian 系系统自带）。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

export NODE_ENV=production
export PORT="${PORT:-8080}"
export HTTPS_PORT="${HTTPS_PORT:-8443}"
export DATA_DIR="${DATA_DIR:-$DIR/data}"
export WEB_DIST="$DIR/public"
export PYTHON_BIN="${PYTHON_BIN:-python3}"
export PYTHONPATH="$DIR/aap-sdk"
# 生产布局下源码相对路径解析不到 runner，必须显式指定（与 docker-compose.yml 一致）
export AAP_RUNNER="$DIR/aap-sdk/aap_runtime/runner.py"
export TZ="${TZ:-Asia/Shanghai}"

mkdir -p "$DATA_DIR"
exec "$DIR/bin/node" "$DIR/dist/server.js"
