# 手順書確認 PoC

インフラ作業手順書（Excel）に開発依頼の内容が正しく反映されているかを AI がチェックするパイプライン。
最終ジャッジは人間が行う前提で、AI は根拠付きの指摘リスト（Markdown）を出す。

- TaskStation: #762（PoC 本体）/ #763（テスト仕様書）
- マイルストーン: 7/8 小西さんレビュー（動く PoC ＋ v11.2 実データでの検出結果 1 件）

## 構成

```
procedure-check-poc/
├── docs/
│   └── check-perspectives.md   # チェック観点リスト（A1〜E2・ドラフト v1）
├── prompts/
│   └── check_prompt.md         # 判定プロンプト v1
├── scripts/
│   ├── extract_excel.py        # Excel 手順書 → Markdown 整形（依存: openpyxl のみ）
│   └── run_check.sh            # 一括実行（整形 → 入力束ね → AI 判定）
├── testdata/
│   ├── sample_request.md       # 模擬開発依頼
│   ├── make_sample.py          # 誤り 4 件を埋め込んだ模擬手順書 xlsx の生成
│   └── sample_procedure.xlsx   # 生成済み模擬手順書
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

2026-07-06 実行: 埋め込んだ誤り 4 件（環境取り違え / 対象サーバの部分欠落 / 停止手順漏れ / 過剰手順）を
すべて検出、誤検出 0 件。結果例は `work/result.md`。

## 社内環境への持ち込み

- 依存は Python3 + openpyxl のみ。`scripts/` `prompts/` `docs/` を持ち込めば動く
- 実データ（v11.2 手順書・開発依頼）は社外持ち出し不可のため、実データでの検出（#770）は社内環境で実行する

## TODO

- [ ] 実物 Excel のシート・列構成に合わせた整形調整（現状は一般的な表形式を想定）
- [ ] 過去指摘事例（#765）を観点リストへ反映 → 観点確定（#767）
- [ ] プロンプト v2: 環境取り違え時の種別割り当て優先順位（B1/B2/A1）と、過去類似手順が無い場合の D1 の扱いを明文化
- [ ] テスト仕様書（#763）: 誤り埋め込みテスト＋過去実データ再現テストの二段構え
