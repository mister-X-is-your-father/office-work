# Capacity Board

少人数チーム（2〜4名）向けの **「今日の空き容量さがし」を中心としたキャパ／タスク可視化ツール** のUIプロトタイプ。
Instagantt の Workload ビュー相当を **OSS・自前ホスト（データ主権あり）** で実現することを狙い、
タスクの箱には **Vikunja** を採用し、その上に自前の可視化レイヤーを載せる構成を検討している。

> **状態: UIモック段階（72案）→ 統合プロトタイプ設計へ**
> 実データ（Vikunja API）接続前。各画面は静的HTML・サンプルデータ駆動。

---

## 👀 見る

| 方法 | URL |
|---|---|
| **GitHub Pages（公開・永続）** | https://mister-x-is-your-father.github.io/office-work/capacity-dashboard/ |
| ローカル（Tailscale, 稼働中のみ） | http://leo:7010/ |

`index.html` が **切り口別ギャラリー**（全72案・ライブサムネ）。main に push すると Pages は自動更新。

ローカル配信:
```bash
cd capacity-dashboard
python3 -m http.server 7010 --bind 0.0.0.0   # → http://leo:7010/
```

---

## 🧭 設計思想・意思決定はここから辿れる

| ドキュメント | 内容 |
|---|---|
| **[docs/00-design-philosophy.md](docs/00-design-philosophy.md)** | なぜ作るか／要件 v0.1／5つの切り口／Instagantt と Vikunja の関係／アーキテクチャ |
| **[docs/01-decisions.md](docs/01-decisions.md)** | ADR（採用しなかった選択肢つき）— Vikunja採用・自前レイヤー・見積り時間の持ち方 等 |
| **[docs/02-screens.md](docs/02-screens.md)** | 全72モックの一覧（切り口別）と、統合プロトタイプへの採用候補 |
| **[docs/03-integration-plan.md](docs/03-integration-plan.md)** | 統合プロトタイプの設計（アプリ構成・画面遷移・段階的な作り方） |

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
- **工数の出どころ**: タスクの見積り時間（Vikunja ラベル `est:4h` 等）
- **キャパ**: まず全員一律 8h/日
- **データ源**: Vikunja API（＋一部 Claude で自然文要約）

詳細・背景は [docs/00-design-philosophy.md](docs/00-design-philosophy.md) を参照。
