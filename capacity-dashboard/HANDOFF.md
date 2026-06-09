# ハンドオフ — Capacity Board

> status: **稼働中**（2026-06-09）。モック72案 → Vikunjaフォークで時間管理をDB実装（本番稼働） → 実データ統合SPA（中核＋日別予定まで動作、タスク系ビューは未）。
> 次の人がコンテキスト無しで読む前提。困ったらまず本書 → `docs/00-05` → 各ADR。

## 0. これは何 / なぜ

少人数チーム(2〜4名)向けの **「今日の空き容量さがし」＋「日別の予定×実績」キャパ可視化ツール**。
狙いは **Instagantt の Workload 相当を OSS・自前ホスト（データ主権）** で。タスクの箱は **Vikunja**。
ただし Vikunja は素だと「時間」概念ゼロ → **Vikunja を fork して時間管理を DB ネイティブに足した**（ここが本体作業）。
背景・意思決定は [`docs/00-design-philosophy.md`](docs/00-design-philosophy.md) と [`docs/01-decisions.md`](docs/01-decisions.md)（ADR）。

## 1. どこで動いてる / 見る

| 物 | 場所 |
|---|---|
| **実データSPA** | http://leo:7010/app/ （capdemo / CapDemoPass123） |
| モックギャラリー(72案) | http://leo:7010/ ／ Pages: https://mister-x-is-your-father.github.io/office-work/capacity-dashboard/ |
| **Vikunja（フォーク稼働）** | http://leo:7005 （image `leo-vikunja:0.24.6-timetracking`） |
| GitHub | https://github.com/mister-X-is-your-father/office-work （public）→ `capacity-dashboard/` |

配信は `python3 -m http.server 7010 --bind 0.0.0.0` を `capacity-dashboard/` で実行（leo:7010）。落ちてたら再起動。

## 2. ディレクトリ

```
office-work/capacity-dashboard/          # ← このプロジェクト（gitは office-work リポジトリ）
├── index.html / mock.html / mocks/      # モック72案＋切り口別ギャラリー
├── app/                                 # 実データ統合SPA（Vanilla, ビルド不要）
│   ├── index.html  app.js               # シェル＋ハッシュルータ＋ログイン
│   ├── lib/ vikunja.js capacity.js store.js ui.js   # APIクライアント / 計算(純関数) / キャッシュ / UI
│   ├── lib/capacity.test.mjs            # capacity.js のTDD（node --test, 9件green）
│   └── views/ home today week planner triage estactual .js
├── live/estimate-vs-actual.html         # 単発ライブページ（接続パターンの原型）
├── docs/ 00-design 01-decisions 02-screens 03-integration 04-feasibility 05-time-tracking-fork
└── vikunja-patch/                       # ★Vikunjaフォークのパッチ一式（再現可能）＋ apply.md

/home/neo/vikunja-fork/vikunja/          # ← Vikunja v0.24.6 clone ＋ パッチ適用済（ビルド元）
/home/neo/pm-trials/vikunja/docker-compose.yml  # ← 本番Vikunjaの compose（image差し替え済）
```

## 3. アーキテクチャ（3層）

1. **データ構造（Vikunjaフォーク）** ＝ 一番の土台。タスクの時間を **(task, user, day) 粒度の3軸**で持つ:
   | 軸 | 格納 | API |
   |---|---|---|
   | 見積り | `tasks.time_estimate`(秒, 実カラム) | `POST /tasks/:id {time_estimate}` |
   | 実績 | `task_time_entries(logged_on, seconds)` ＋ computed `time_spent`(SUM) | `PUT/GET /tasks/:task/times` |
   | 予定 | `task_time_plans(plan_date, seconds)` ＋ computed `time_planned`(SUM) | `PUT/GET /tasks/:task/plans` |
   設計詳細 [`docs/05-time-tracking-fork.md`](docs/05-time-tracking-fork.md)、適用手順 [`vikunja-patch/apply.md`](vikunja-patch/apply.md)、判断 ADR-006。
2. **計算レイヤー** `app/lib/capacity.js` ＝ 純関数（空き/超過/今日負荷/週負荷/見積りvs実績/トリアージ分類/日別集計）。**TDD対象**（`capacity.test.mjs`）。
3. **UI** `app/` ＝ 上2層の描画にすぎない。見た目はモック資産から流用。

## 4. 状態（done / TODO）

**Done**
- モック72案＋切り口別ギャラリー（Pages公開）。
- Vikunjaフォーク: 実績時間トラッキング(`time_estimate`/`time_spent`/`/times`) ＋ 日別予定(`time_planned`/`/plans`)。**本番デプロイ・検証済**（TDD/隔離e2e/Playwright/ロールバック網）。
- SPA中核ビュー（実データ）: **ホーム・空き探し(54)・週プラン(18)・週プランナー(予定×実績)・トリアージ(46)・見積りvs実績(23)**。
- 週プランナーは**読み書き両方**（フォームで「日・タスク・時間」の予定を保存→Vikunja永続）。

**TODO / 未**
- **SPA-C/D**: かんばん(59)・一覧(60)・ガント(29)・設定(17) ＝ ナビに「準備中」枠のみ。
- AI Q&A(53): Claude バックエンドが要る → 保留（要相談）。
- 週プランナー作り込み: ドラッグで予定配置、容量超過の強警告、予定の編集/削除UI。
- 既知の割り切り（下記）。

## 5. 運用 runbook

### Vikunja を直して再デプロイ（小さなGo修正）
ホストに Go 無し。**xgoは使わない**（重い）。frontend は一度ビルド済みなので再ビルド不要。
```bash
cd /home/neo/vikunja-fork/vikunja
# 1) バイナリ（ネイティブgo build, warmキャッシュ, CGO sqlite）
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app -e CGO_ENABLED=1 \
  golang:1.22 sh -c 'go build -buildvcs=false -ldflags "-s -w" -o vikunja .'
# 2) 配布イメージ（debian-slim＋バイナリ）
docker build -f Dockerfile.deploy -t leo-vikunja:0.24.6-timetracking .
# 3) 本番差し替え（migrationは起動時自動）
cd /home/neo/pm-trials/vikunja && docker compose up -d --force-recreate
```
### テスト（TDD, Go無しでOK）
```bash
cd /home/neo/vikunja-fork/vikunja
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app -e VIKUNJA_SERVICE_ROOTPATH=/app \
  golang:1.22 go test ./pkg/models/ -count=1            # 全体（回帰）
# capacity.js: cd capacity-dashboard/app/lib && docker run --rm -v "$PWD":/w -w /w node:20-alpine node --test
```
### 隔離検証（本番に触れず）
新バイナリを使い捨てsqlite・別ポート7011で起動して API を叩く（手順は git log / 05 参照）。
### ロールバック
```bash
# compose の image を vikunja/vikunja:0.24.6 に戻して up -d。DB破損時はバックアップvolumeから復元:
# 既存backup: vikunja_vikunja-db-backup-20260609 / -plans （docker volume ls）
```
### SPAを直す
`app/` のファイルを編集 → push（Pagesは自動更新）。**ブラウザはESモジュールをキャッシュするので、`app.js`等を直したら強制リロード**（Playwrightなら about:blank 経由で再ナビ）。

## 6. 認証・デモデータ

- **capdemo / CapDemoPass123** … オーナー（プロジェクト「チーム作業」id=4 の所有者）。SPAログインはこれ。
- チームメンバー: **morita / tanaka / satou / suzuki**（各 TeamPass123, id=2..5）。タスクに担当・期日・見積り・実績・予定を投入済み。
- CORS は compose で `VIKUNJA_CORS_ENABLE=true` / `VIKUNJA_CORS_ORIGINS=*`（別オリジンSPAから叩くため）。
- デモデータ再投入は git log の seed コマンド参照（users登録→`/projects/:id/users`で共有(`user_id`=ユーザー名文字列)→タスク作成→`/tasks/:id/assignees`→`/times`/`/plans`）。

## 7. 既知の割り切り / gotcha

- **メンバー集合** = 全タスクの assignees の和（`store.js`）。仕事ゼロの人は出ない。将来 projectusers と統合。
- **日別負荷(today/week)** = 見積りを [start,end] で日割り or due日に全量（`capacity.js taskHoursOn`）。本来は予定(plans)で上書きすべき → 週プランナーは plans を使うが、today/week は estimate ベース。統一余地あり。
- **週プランナーの帰属** = plan.user_id ではなく **タスクの担当者**に按分（capdemoが代理入力したため）。自己計画なら user_id を使う設計に寄せられる。
- Vikunja gotcha: username≥3文字 / 共有の `user_id` は文字列(ユーザー名) / `colsToUpdate` に列追加必須 / 新モデルは `GetTables()`＋テスト fixture 一覧＋空yml が必須 / エラーコードは未使用帯(15001=times,15002=plans)。
- bash の `UID` は予約変数（配列名に使わない）。

## 8. 次の一手（おすすめ順）

1. **SPA-C/D**: かんばん(bucket)→一覧(table)→ガント(start/end/done/deps)→設定(容量/対象PJ)。`docs/03-integration-plan.md` の8画面MVP。
2. 週プランナー作り込み（ドラッグ配置・予定編集削除・容量警告）。
3. members を projectusers と統合、today/week も予定(plans)優先に統一。
4. AI Q&A(53) を別API化するか判断。

参照: 計画ファイル `~/.claude/plans/polished-frolicking-panda.md`（フェーズ1/2の全体計画）。
