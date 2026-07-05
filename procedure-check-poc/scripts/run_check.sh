#!/usr/bin/env bash
# 手順書チェック PoC 一括実行
#
# 使い方:
#   ./run_check.sh <手順書.xlsx> <開発依頼.md> [過去類似手順.md]
#
# 動作:
#   1. Excel 手順書を Markdown に整形（scripts/extract_excel.py）
#   2. 判定プロンプト＋資料一式を 1 ファイルに束ねる（work/bundle.md）
#   3. claude CLI があれば判定を実行し work/result.md に保存
#      無ければ bundle.md を社内 Claude Code に手貼りする案内を出す
set -euo pipefail

if [ $# -lt 2 ]; then
    echo "使い方: $0 <手順書.xlsx> <開発依頼.md> [過去類似手順.md]" >&2
    exit 1
fi

XLSX="$1"
REQUEST="$2"
PAST="${3:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/work"
mkdir -p "$WORK"

echo "[1/3] 手順書を整形中..."
python3 "$ROOT/scripts/extract_excel.py" "$XLSX" -o "$WORK/procedure.md"

echo "[2/3] 入力を束ねています..."
{
    cat "$ROOT/prompts/check_prompt.md"
    echo
    echo "# 【開発依頼】"
    echo
    cat "$REQUEST"
    echo
    echo "# 【作業手順書】"
    echo
    cat "$WORK/procedure.md"
    if [ -n "$PAST" ]; then
        echo
        echo "# 【過去類似手順】"
        echo
        cat "$PAST"
    fi
} > "$WORK/bundle.md"
echo "  -> $WORK/bundle.md"

echo "[3/3] AI 判定..."
if command -v claude >/dev/null 2>&1; then
    claude -p "$(cat "$WORK/bundle.md")" > "$WORK/result.md"
    echo "  -> 判定結果: $WORK/result.md"
else
    echo "  claude CLI が見つかりません。"
    echo "  $WORK/bundle.md の内容を社内 Claude Code に貼り付けて実行してください。"
fi
