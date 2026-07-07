# 手順書確認 PoC

インフラ作業手順書（Excel）に開発依頼の内容が正しく反映されているかを AI がチェックするパイプライン。
最終ジャッジは人間が行う前提で、AI は根拠付きの指摘リスト（Markdown）を出す。

- TaskStation: #762（PoC 本体）/ #763（テスト仕様書）
- マイルストーン: 7/8 小西さんレビュー（動く PoC ＋ v11.2 実データでの検出結果 1 件）

## 構成

```
procedure-check-poc/
├── docs/
│   ├── check-perspectives.md   # チェック観点リスト（A〜F・ドラフト v2）
│   └── test-spec.md            # テスト仕様書（#763・ドラフト。誤り埋め込み＋過去実データ再現）
├── prompts/
│   └── check_prompt.md         # 判定プロンプト v1
├── scripts/
│   ├── extract_excel.py        # Excel 手順書 → Markdown 整形（依存: openpyxl のみ）
│   └── run_check.sh            # 一括実行（整形 → 入力束ね → AI 判定）
├── testdata/
│   ├── sample_request.md       # 模擬 特殊手順追加指示
│   ├── make_sample.py          # 正しいベース＋観点別の誤り注入で模擬手順書 xlsx を生成（--list 参照）
│   └── sample_procedure.xlsx   # 生成済み模擬手順書（既定=複合ケース mix）
└── work/                       # 実行時の中間・結果ファイル（git 管理外）
```

## 使い方

```bash
./scripts/run_check.sh <手順書.xlsx> <開発依頼.md> [過去類似手順.md]
```

1. Excel を Markdown に整形（`work/procedure.md`）
2. 判定プロンプト＋資料を 1 ファイルに束ねる（`work/bundle.md`）
3. `claude` CLI があればそのまま判定して `work/result.md` に保存。
   無い環境では `work/bundle.md` を社内 Claude Code に貼り付ければ同じ判定ができる（可搬性のための逃げ道）

## 動作確認（模擬データ）

```bash
python3 testdata/make_sample.py   # 誤り埋め込み模擬手順書を生成
./scripts/run_check.sh testdata/sample_procedure.xlsx testdata/sample_request.md
```

2026-07-06 実行（プロンプト v2）: 埋め込んだ誤り（環境取り違え / 対象サーバの部分欠落 / 停止手順漏れ /
除外指示への違反=nginx 残存）をすべて検出、誤検出 0 件。指摘には実 Excel の行番号（xlsx-row）が付く。
結果例は `work/result.md`。

観点別の単一障害テスト・負制御（誤検出0）の初回計測は `docs/test-spec.md` §2.6 参照。
ケース別生成: `python3 testdata/make_sample.py --case B1 -o work/x.xlsx`（`--list` で一覧）。

## 社内環境への持ち込み

- 依存は Python3 + openpyxl のみ。`scripts/` `prompts/` `docs/` を持ち込めば動く
- 実データ（v11.2 手順書・開発依頼）は社外持ち出し不可のため、実データでの検出（#770）は社内環境で実行する

## TODO

- [ ] 実物 Excel のシート・列構成に合わせた整形調整（現状は一般的な表形式を想定。列は固定だが行途中にコメント混在あり → 行番号付与＋内容解釈で吸収済み。実物で要検証）
- [ ] 過去指摘事例（#765）を観点リストへ反映 → 観点確定（#767）
- [ ] 環境取り違えの種別割り当て（B1 / B2 の寄せ方）を 7/8 レビューで確定
- [ ] 切り戻し手順の扱い（現状は AI が「要確認」に回す）と重大度基準の明文化
- [ ] テスト仕様書（#763）: 誤り埋め込みテスト＋過去実データ再現テストの二段構え

## 変更履歴

- v2 (2026-07-06): 照合の枠組みを「特殊手順追加指示 → 手順書の遵守」に変更。旧 D1「過剰手順」を
  廃止し、除外指示に反する残存のみを拾う F を新設。整形結果に Excel 行番号を付与。
- v1 (2026-07-06): 初版（開発依頼との一般照合・14 観点）。
