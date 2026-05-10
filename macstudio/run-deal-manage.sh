#!/usr/bin/env bash
# Mac Studio 一键启动：deal-manage 服务
# 后续可在本目录增加其他 *.sh，或在此脚本末尾串联更多步骤。
set -euo pipefail

ROOT="/Users/maotouying/frontend/code/1.operations/deal-manage"
cd "$ROOT"

if [[ ! -f "venv/bin/activate" ]]; then
  echo "错误: 未找到 $ROOT/venv/bin/activate，请先创建虚拟环境。" >&2
  exit 1
fi

# shellcheck source=/dev/null
source venv/bin/activate

exec python run.py
