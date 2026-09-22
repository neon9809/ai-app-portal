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

# 平台预置 Python 框架自检补装（契约 §五「平台预置框架」= flask）：docker 镜像构建期
# apk add py3-flask 无此问题；native/FPK 依赖宿主 python3，宿主缺 flask 时补装到数据
# 目录并经 AAP_PREINSTALLED_PYTHONPATH 前置进沙箱 sys.path（server baseEnv 读取）。
# 数据目录存放：FPK 升级换载荷不丢；python312 等宿主应用更新后重启本服务即可自愈。
# 补装源可用 env PIP_INDEX_URL 指定镜像。失败不阻断启动（persistent 包会 503，日志有线索）。
export AAP_PREINSTALLED_PYTHONPATH="${AAP_PREINSTALLED_PYTHONPATH:-$DATA_DIR/python-libs}"
# 宿主 python3 不带 pip 时先尝试 ensurepip（Debian 系默认无 pip；fnOS python312 自带）
if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
  "$PYTHON_BIN" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! PYTHONPATH="$AAP_PREINSTALLED_PYTHONPATH" "$PYTHON_BIN" -c 'import flask' >/dev/null 2>&1; then
  echo "[aap] 宿主 ${PYTHON_BIN} 缺 flask，pip 补装到 ${AAP_PREINSTALLED_PYTHONPATH}${PIP_INDEX_URL:+（index=$PIP_INDEX_URL）}" >&2
  mkdir -p "$AAP_PREINSTALLED_PYTHONPATH"
  if ! "$PYTHON_BIN" -m pip install --only-binary=:all: --no-compile --disable-pip-version-check \
      --target "$AAP_PREINSTALLED_PYTHONPATH" flask \
      ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} >&2; then
    echo "[aap] WARN flask 补装失败：flask 类 persistent 包将启动失败（503）；请检查宿主 pip（Debian: apt install python3-pip）、网络/PIP_INDEX_URL 后重启" >&2
  fi
fi

exec "$DIR/bin/node" "$DIR/dist/server.js"
