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

# 官方发布公钥内置信任（G4）：官方签名 .neon-aap 包免审；与 docker-compose.yml 同源，env 可覆盖
export AAP_OFFICIAL_SIGN_PUBKEY="${AAP_OFFICIAL_SIGN_PUBKEY:-TZxb0LoJihvn7d0c+9D6dVY3BgbhpCUAjZiWgMw7AnE=}"
export AAP_OFFICIAL_SIGNER_NAME="${AAP_OFFICIAL_SIGNER_NAME:-neon9809}"

mkdir -p "$DATA_DIR"
exec "$DIR/bin/node" "$DIR/dist/server.js"
