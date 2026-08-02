#!/usr/bin/env bash
# 启动本仓库 oi_mornitor（读取 discord-collector/.env 的 OI_WEB_PORT，默认 8766）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OI="$ROOT/oi_mornitor"
PY="$OI/venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "缺少 $PY — 请先: ln -sfn /path/to/working/venv $OI/venv" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a
[[ -f "$ROOT/.env" ]] && source "$ROOT/.env"
set +a
PORT="${OI_WEB_PORT:-8766}"
mkdir -p "$OI/data"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已有进程监听，跳过启动"
  exit 0
fi
echo "启动 oi_mornitor → http://127.0.0.1:${PORT}"
exec env OI_WEB_PORT="$PORT" "$PY" "$OI/run.py" --backend-only --skip-build
