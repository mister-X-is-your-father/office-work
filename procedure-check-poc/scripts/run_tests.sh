#!/usr/bin/env bash
# 誤り埋め込みテストの一括実行ハーネス（テスト仕様書 §2 の自動化）。
#
# 各観点ケースを「生成 → 判定」し、期待種別が指摘リストに出るか
# （負制御 NEG は指摘0か）を検査して、PASS/FAIL のマトリクスを出力ファイルへ書く。
#
# 使い方:
#   ./scripts/run_tests.sh                 # 既定で docs/test-results.md に書き出し
#   ./scripts/run_tests.sh out.md          # 出力先を指定
#
# 特性:
#   - 再開可能: work/tests/result_<case>.md が既にあればその判定を再利用（中断に強い）
#     再計測したいときは work/tests/ を消す
#   - アトミック書込: 一時ファイルに書いてから mv（中断で空ファイルを残さない）
# 前提: claude CLI が使えること（run_check.sh が AI 判定に使う）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REQ="testdata/sample_request.md"
TMP="work/tests"
OUT="${1:-docs/test-results.md}"
mkdir -p "$TMP"

# ケース:期待種別（指摘リストの種別セルに現れる文字列で照合）
# ※ F 観点は出力上「F 指示違反（残存）」で番号を持たないため "指示違反" で照合する
CASES=(A1:A1 A2:A2 B1:B1 B2:B2 B3:B3 C1:C1 C2:C2 D2:D2 D3:D3 D4:D4 E1:E1 E2:E2 F1:指示違反)

# 指摘リスト部（## 指摘リスト 〜 ## 要確認 の手前）だけを取り出す
findings() { awk '/## 指摘リスト/{f=1} /## 要確認/{f=0} f' "$1"; }

pass=0
total=0
rows=""

run_one() {  # $1=ラベル $2=xlsx $3=期待種別（空=NEG）
    local label="$1" xlsx="$2" exp="${3:-}"
    if [ ! -f "$TMP/result_${label}.md" ]; then
        ./scripts/run_check.sh "$xlsx" "$REQ" >/dev/null 2>&1
        cp work/result.md "$TMP/result_${label}.md"
        echo "  [$label] 判定実行" >&2
    else
        echo "  [$label] 既存結果を再利用" >&2
    fi
    local n hit verdict
    n=$(findings "$TMP/result_${label}.md" | grep -cE '^\| [0-9]+ ')
    total=$((total + 1))
    if [ -z "$exp" ]; then
        if [ "$n" -eq 0 ]; then verdict="PASS"; pass=$((pass + 1)); else verdict="FAIL"; fi
        rows+="| $label | 指摘0 | $n | - | $verdict |\n"
    else
        hit=$(findings "$TMP/result_${label}.md" | grep -c "$exp")
        if [ "$hit" -gt 0 ]; then verdict="PASS"; pass=$((pass + 1)); else verdict="FAIL"; fi
        rows+="| $label | $exp | $n | $([ "$hit" -gt 0 ] && echo 出現 || echo 無) | $verdict |\n"
    fi
}

echo "誤り埋め込みテスト ハーネス実行中..." >&2

python3 testdata/make_sample.py --case base -o "$TMP/NEG.xlsx" >/dev/null
run_one NEG "$TMP/NEG.xlsx" ""

for pair in "${CASES[@]}"; do
    c="${pair%%:*}"
    exp="${pair##*:}"
    python3 testdata/make_sample.py --case "$c" -o "$TMP/$c.xlsx" >/dev/null
    run_one "$c" "$TMP/$c.xlsx" "$exp"
done

# 結果マトリクスをアトミックに書き出す
{
    echo "# 誤り埋め込みテスト 結果マトリクス"
    echo
    echo "生成: \`scripts/run_tests.sh\`（各ケース: 手順書生成 → AI 判定 → 期待種別の出現確認）。"
    echo "判定基準: 単一障害ケースは期待種別が指摘リストに出現で PASS / 負制御 NEG は指摘0で PASS。"
    echo "指摘件数は AI が挙げた指摘の総数（単一障害でも対象が複数台なら複数件になりうる＝真陽性）。"
    echo
    echo "| ケース | 期待 | 指摘件数 | 期待種別 | 判定 |"
    echo "|--------|------|----------|----------|------|"
    printf "%b" "$rows"
    echo
    echo "**合計: $pass/$total PASS**"
} > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"

echo "完了: $OUT （$pass/$total PASS）" >&2
