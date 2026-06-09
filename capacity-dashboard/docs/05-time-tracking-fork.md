# 実績時間トラッキング — Vikunja フォークで DB に実装

> status: **本番デプロイ・検証済み（2026-06-09）**。コメント解析方式は却下（脆弱）。Vikunja v0.24.6 を fork し
> **DB にテーブル/カラムを足すネイティブ実装**。TDDユニット全green＋pkg/models回帰なし＋使い捨てDBで
> e2e（見積り5h/実績4.5h・権限403/200）成功 → **本番 leo:7005 を自前イメージ `leo-vikunja:0.24.6-timetracking`
> に差し替え（volumeバックアップ済み・既存データ無傷・migration自動適用）** → 本番でも見積り/実績API稼働確認 →
> **Playwright で Vikunja UI 周辺モンキーテスト（ログイン/各ビュー/タスク作成）console error 0・回帰なし**。
> ビルドは軽量化（xgo不使用＝ネイティブgo build、frontendは一度きり）。配布は `vikunja-patch/Dockerfile.deploy`。
> [ADR-006](01-decisions.md) / 関連: [ADR-002 改訂](01-decisions.md)（time tracking に限り fork を許可）
>
> 検証で判明し修正した実バグ: `Task.Update` の `colsToUpdate` に `time_estimate` が無く見積りが永続化されなかった
> → 追加＋ユニットテスト `TestTask_TimeEstimate_Persisted` を追加。e2e が捕捉した。

## なぜ fork / DB変更なのか

- 当初は「本体無改造・API越し」（[ADR-002](01-decisions.md)）で、見積りは `est:4h` ラベル、実績はコメント解析で代替しようとした。
- **実績をコメント解析で持つのは破綻する**: 自由記述コメントと混ざる／書式ドリフト／DB制約もインデックスも集計の信頼性も無い。
- よって **Vikunja を fork し、実績時間を第一級のDBエンティティとして持つ**。見積りも同時に実カラム化し、`est:4h` ラベルのハックも卒業する。

## 追い風（実機調査の発見）

upstream Vikunja main は**既に**ネイティブ time tracking を持つ:
- `pkg/models/time_tracking.go` … `TimeEntry`（start/end のタイマー型・XOR で task/project に紐付け）
- `pkg/migration/20260607132257.go` … `time_entries` テーブル作成

ただし **ライセンスゲート**（`license.IsFeatureEnabled(license.FeatureTimeTracking)`）付きで、v2 のルートは main 未配線。
→ fork なら **ゲートを外して有効化** or **自前の素直な `task_time_entries` を足す**かを選べる。

## 採用設計

**A. 自前の素直なエントリ表 `task_time_entries`**（タスク単位の worklog。我々の要件＝見積りvs実績 に直球）を追加。
upstream の v2 タイマー型より、まず「1タスクに実績Nh を積む」モデルが要件に合う。

### スキーマ

`task_time_entries`（新規テーブル）:
| 列 | 型(xorm) | 説明 |
|---|---|---|
| id | bigint autoincr pk | |
| task_id | bigint index not null | 対象タスク |
| user_id | bigint index not null | 記録者（auth から自動） |
| seconds | bigint not null | 実績の長さ（秒） |
| logged_on | datetime index not null | 作業日（既定: now） |
| note | text null | メモ |
| created / updated | xorm auto | |

`tasks`（既存テーブルに列追加）:
| 列 | 型 | 説明 |
|---|---|---|
| time_estimate | bigint null default 0 | **見積り（秒）** — `est:4h` ラベルを置換 |

`time_spent`（実績合計）は**永続カラムにせず computed**（`xorm:"-"`）で、`SUM(seconds)` を
`addMoreInfoToTasks` で attach する（drift しない。upstream の `addTimeEntriesCountToTasks` と同型で `COUNT`→`SUM`）。

### API（ルート追加）

comments ブロック（`pkg/routes/routes.go`）と同型で:
```
PUT    /api/v1/tasks/:task/times        # 実績を1件記録（seconds, logged_on?, note?）
GET    /api/v1/tasks/:task/times        # タスクの実績一覧
DELETE /api/v1/tasks/:task/times/:id    # 自分のエントリ削除
```
見積りは通常のタスク更新（`POST /tasks/:id` の `time_estimate`）で設定。
Task のレスポンスに `time_spent`（合計秒）と `time_estimate`（秒）が乗る。

### 権限

`task_comments` と同じ委譲パターン:
- CanRead → 親 `Task.CanRead`
- CanCreate → 親 `Task.CanWrite`
- CanDelete → `Task.CanWrite` かつ `user_id == auth.GetID()`（自分の記録のみ）

## 変更ファイル（実ファイルパス）

| 種別 | パス | 内容 |
|---|---|---|
| 新規 | `pkg/models/task_time_entry.go` | モデル＋CRUDable（mirror `task_comments.go`） |
| 新規 | `pkg/models/task_time_entry_permissions.go` | Can* 委譲 |
| 新規 | `pkg/migration/<ts>.go` | `task_time_entries` 作成＋`tasks.time_estimate` 追加 |
| 編集 | `pkg/models/tasks.go` | `TimeSpent`(computed)/`TimeEstimate`(列) フィールド＋SUMローダ呼び出し |
| 編集 | `pkg/routes/routes.go` | `/tasks/:task/times` ルート登録 |

適用可能なコード雛形は **[`../vikunja-patch/`](../vikunja-patch/)** に置いた（model・permissions・migration の実体＋ `apply.md`）。

## ビルド/デプロイ

Vikunja は Go + mage。マイグレーションは**サーバ起動時に自動適用**（別手順不要）。
```bash
git clone https://code.vikunja.io/vikunja && cd vikunja
# vikunja-patch/ の Go ファイルを所定パスへ配置、tasks.go / routes.go へ差分適用
docker build -t leo-vikunja:timetracking .     # 既存 Dockerfile（multi-stage）
# pm-trials の compose の image を差し替え → 起動で migration 実行
```
`docker-compose` の `vikunja` サービスを自前イメージに差し替え、`docker compose up -d` で
新カラム/テーブルが立ち上げ時に作られる。

## 見積りvs実績 のデータ経路（fork 後）

| 本モデル | fork 後 Vikunja |
|---|---|
| task.estimateH | **`tasks.time_estimate`（秒）** ← 実カラム |
| task.actualH | **`SUM(task_time_entries.seconds)`** ← `time_spent` computed |
| 実績の記録 | `PUT /tasks/:task/times {seconds, logged_on, note}` |
| 人別・日別の実績 | `task_time_entries` を user_id / logged_on で集計（過負荷ヒストリーや実績にも使える） |

→ これで **23 見積りvs実績 / 24 見積り精度 / 42 工数消化** が**ネイティブに成立**（[04-feasibility.md](04-feasibility.md) 更新）。
さらに `logged_on` 別集計で **25 過負荷ヒストリー / 37 バーンダウン**の実績側も裏付く。

## 次アクション

1. （任意）本ドキュメントのレビュー。
2. Vikunja を clone → `vikunja-patch/` を適用 → 自前イメージをビルド。
3. pm-trials の Vikunja を自前イメージへ差し替え、起動（migration 自動）。
4. `/tasks/:task/times` を叩いて実機確認 → 見積りvs実績モックを実データに接続。
