# Capacity Board

少人数チーム（2〜4名）向けの **「今日の空き容量さがし」を中心としたキャパ／タスク可視化ツール** のUIプロトタイプ。
Instagantt の Workload ビュー相当を **OSS・自前ホスト（データ主権あり）** で実現することを狙い、
タスクの箱には **TaskStation** を採用し、その上に自前の可視化レイヤーを載せる構成を検討している。

> **状態: ① UIモック72案 → ② フォークしたTaskStationで時間管理(見積り/実績/予定)をDB実装・本番稼働 → ③ 実データ統合SPA(中核＋日別予定まで動作)**
>
> 🤝 **引き継ぎ・全体像・runbook は [HANDOFF.md](HANDOFF.md) を最初に読む。**

---

## 👀 見る（leo 稼働時）

| 方法 | URL |
|---|---|
| **🟢 実データSPA（本番）** | http://leo:7010/app/ — TaskStation。本日(円時計/積み上げ)・レビュー・残容量・時刻カレンダー・週日別・一覧・アウトライン・依存グラフ・ガント 等 |
| TaskStation 本体 | http://leo:7005 |
| 切り口別ギャラリー（モック72案） | http://leo:7010/ ／ Pages: https://mister-x-is-your-father.github.io/office-work/capacity-dashboard/ |

ログイン: **capdemo / CapDemoPass123**（デモ）。SPAログイン画面から **新規アカウント作成**も可。

`app/` が **実データ統合SPA**（`lib/` API client＋純関数＋ハッシュルータ・Vanilla ESM・ビルド不要）。
`index.html` は **切り口別ギャラリー**（全72案）。main に push すると Pages は自動更新。

---

## 🚀 セットアップ／起動

**前提**: Docker（フォークのビルド/本番に使用。ホストに Go/Node 不要）、Python3（静的配信）。
**全体像・詳細 runbook は [HANDOFF.md](HANDOFF.md) §5 が正本。** 最短手順:

```bash
# 1) SPA／ギャラリーを配信（ビルド不要・作業ツリー直配信＝編集即反映）
cd capacity-dashboard
python3 -m http.server 7010 --bind 0.0.0.0          # → http://leo:7010/（/app/ がSPA）

# 2) バックエンド（TaskStationフォーク）= 本番は docker compose で常時稼働
cd /home/neo/apps/pm-trials/vikunja && docker compose up -d   # → http://leo:7005（image leo-taskstation:0.24.6-fixN）

# 3) テスト
cd capacity-dashboard/app/lib && docker run --rm -v "$PWD":/w -w /w node:20-alpine node --test   # 計算層37件
# フォーク回帰は HANDOFF §5「テスト」参照（docker golang:1.22 で go test）

# 4) フォークを直して再デプロイ（スキーマ変更/再ビルド時）→ HANDOFF §5 runbook（go build → image → backup → recreate）
```

> 本番への反映（フォーク再ビルド・migration・recreate）は必ず **DBバックアップ → image差し替え → recreate** の順。手順と注意は HANDOFF §5/§7。

---

## 🧭 設計思想・意思決定はここから辿れる

| ドキュメント | 内容 |
|---|---|
| **[docs/00-design-philosophy.md](docs/00-design-philosophy.md)** | なぜ作るか／要件 v0.1／5つの切り口／Instagantt と TaskStation の関係／アーキテクチャ |
| **[docs/01-decisions.md](docs/01-decisions.md)** | ADR（採用しなかった選択肢つき）— TaskStation採用・自前レイヤー・見積り時間の持ち方 等 |
| **[docs/02-screens.md](docs/02-screens.md)** | 全72モックの一覧（切り口別）と、統合プロトタイプへの採用候補 |
| **[docs/03-integration-plan.md](docs/03-integration-plan.md)** | 統合プロトタイプの設計（アプリ構成・画面遷移・段階的な作り方） |
| **[docs/04-feasibility.md](docs/04-feasibility.md)** | 実現可能性スクリーニング — 全72案を TaskStation データモデルに照合（🔴別系統必須／🟠履歴要／🟡軽微／✅標準） |
| **[docs/05-time-tracking-fork.md](docs/05-time-tracking-fork.md)** | 実績時間トラッキング — TaskStation を fork して DB に実装（スキーマ/API/ビルド）。コード雛形は [`backend-patch/`](backend-patch/) |

---

## 📁 構成

```
capacity-dashboard/
├── README.md            # このファイル（ハブ）
├── index.html           # 切り口別ギャラリー（全72案の入口）
├── mock.html            # 01 横バー
├── mock-vertical.html   # 02 縦バー
├── mocks/               # 03〜72 の個別モック
└── docs/                # 設計思想・ADR・画面一覧・統合計画
```

## 要件 v0.1（要約）

- **主目的**: 空き容量さがし＝「今日、誰に新しい仕事を振れるか」を即断
- **時間軸**: 今日（日次）中心
- **工数の出どころ**: タスクの見積り時間（TaskStation ラベル `est:4h` 等）
- **キャパ**: まず全員一律 8h/日
- **データ源**: TaskStation API（＋一部 Claude で自然文要約）

詳細・背景は [docs/00-design-philosophy.md](docs/00-design-philosophy.md) を参照。
