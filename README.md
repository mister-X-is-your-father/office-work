# OfficeOS — 仕事のOS（会議ファシリテーション・プロダクト）

> 会議をするだけで、ファシリが上達し、タスクと論点が勝手に溜まり、抜け漏れが構造的に消える。

『世界で一番やさしい会議の教科書』(榊巻亮/日経BP) の手法を仕組みに埋め込んだ、Google Sheets ベースの会議運用テンプレ＋自動化。将来 Web アプリ化（段階戦略）。

## 構成
- `docs/PRD.md` — プロダクト要求（SoT）
- `docs/adr/` — 意思決定記録（ADR）
- `build_template.py` — Sheets テンプレ（xlsx）を openpyxl で生成 → Driveへアップ&変換
- `apps-script/` — Phase 1 自動化（Apps Script コード＋導入手順）

## 現在地（2026-05-30）
- P0 完了: Sheets テンプレ v5（4タブ：▶会議 / 🗂課題・タスク台帳 / 🧭網羅チェック / 📖ガイド）
  - 数式（カバレッジ/予実/コスト/点数）・プルダウン・条件付き書式・決定/論点の自動集約まで動作確認済み
  - 本番ファイル: Google Sheets `1Hdd2YDLXJWUDa2qxr40svh32ChPTTo_8HeFczsSnABk`
- P1 着手: `apps-script/Code.gs`（新会議ボタン・会議→台帳自動転記・最終更新自動打刻・棚卸し）
  - ※スプレッドシートへの貼り付けは手動1回（API注入不可）。手順は `apps-script/README.md`

## テンプレの作り直し
```
python3 build_template.py            # xlsx生成
# /tmp にコピーして gws uploadFileToDrive(convertToGoogleFormat=true) でSheets化
```
旧バージョンは消さない方針（反復の記録）。
