#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
ZSHRC="$HOME/.zshrc"

mkdir -p "$BIN_DIR"

chmod +x "$SCRIPT_DIR/gpll" "$SCRIPT_DIR/gpsh"
ln -sf "$SCRIPT_DIR/gpll" "$BIN_DIR/gpll"
ln -sf "$SCRIPT_DIR/gpsh" "$BIN_DIR/gpsh"

if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$ZSHRC" 2>/dev/null; then
  {
    echo ""
    echo '# auto-script commands'
    echo 'export PATH="$HOME/.local/bin:$PATH"'
  } >> "$ZSHRC"
fi

echo "安装完成。"
echo "请执行: source \"$ZSHRC\""
echo "然后可直接使用:"
echo "  gpll"
echo "  gpsh"
echo '  gpsh --message "your commit message"'
