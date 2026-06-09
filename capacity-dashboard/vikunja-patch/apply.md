# vikunja-patch 適用手順

Vikunja を fork して**ネイティブ実績時間トラッキング**を足すパッチ。
設計は [`../docs/05-time-tracking-fork.md`](../docs/05-time-tracking-fork.md)。

## 1. clone

```bash
git clone https://code.vikunja.io/vikunja
cd vikunja
```

## 2. 新規ファイルを配置（このパッチをそのままコピー）

```
pkg/models/task_time_entry.go              ← vikunja-patch/pkg/models/task_time_entry.go
pkg/models/task_time_entry_permissions.go  ← vikunja-patch/pkg/models/task_time_entry_permissions.go
pkg/models/error_time_entry.go             ← vikunja-patch/pkg/models/error_time_entry.go
pkg/migration/20260609090000.go            ← vikunja-patch/pkg/migration/20260609090000_task_time_entries.go
```

> module path は **`code.vikunja.io/api`**（`code.vikunja.io/vikunja` ではない）。`web` の権限IFは
> **`web.Rights`**。本パッチは v0.24.6 実ソースに照合済み。
（migration のファイル名はタイムスタンプ部分だけでよい。`init()` が自動登録するので登録一覧の編集は不要。）

## 3. 既存ファイルを2箇所だけ編集

### 3-1. `pkg/models/tasks.go`

(a) Task struct に2フィールド追加（`PercentDone` の近く）:
```go
	// 見積り（秒）。実カラム。
	TimeEstimate int64 `xorm:"bigint null default 0" json:"time_estimate"`
	// 実績合計（秒）。computed（task_time_entries の SUM）。永続化しない。
	TimeSpent int64 `xorm:"-" json:"time_spent"`
```

(b) `addMoreInfoToTasks(s *xorm.Session, taskMap map[int64]*Task, a web.Auth, view *ProjectView)` 内、
`addAttachmentsToTasks(s, taskIDs, taskMap)` 呼び出しの直後に、同じ形でローダを追加（`taskIDs` は同関数内の既存変数）:
```go
	// 実績合計(time_spent)を attach
	err = addTimeSpentToTasks(s, taskIDs, taskMap)
	if err != nil {
		return
	}
```
（`addTimeSpentToTasks(s, taskIDs, taskMap)` は `task_time_entry.go` に同梱。他の `addXToTasks` と同一シグネチャ。）

(c) **`Task.Update` の `colsToUpdate` リストに `"time_estimate"` を追加**（**必須**。これが無いと
見積りが永続化されない＝e2e で検出したバグ）:
```go
	colsToUpdate := []string{
		...
		"cover_image_attachment_id",
		"time_estimate",   // 追加
	}
```

### 3-2. `pkg/routes/routes.go`

comments のハンドラ登録ブロック（`/tasks/:task/comments` を登録している箇所）の直後に追加:
```go
	timeEntryHandler := &handler.WebHandler{
		EmptyStruct: func() handler.CObject {
			return &models.TaskTimeEntry{}
		},
	}
	a.GET("/tasks/:task/times", timeEntryHandler.ReadAllWeb)
	a.PUT("/tasks/:task/times", timeEntryHandler.CreateWeb)
	a.POST("/tasks/:task/times/:timeentry", timeEntryHandler.UpdateWeb)
	a.DELETE("/tasks/:task/times/:timeentry", timeEntryHandler.DeleteWeb)
```
（パスパラメータ名 `:task` / `:timeentry` はモデルの `param:"task"` / `param:"timeentry"` と一致させること。）

### 3-3. `pkg/models/models.go` — `GetTables()` に登録（**必須**）

テストDB・新規インストールのスキーマ生成に必要。`&TaskComment{}` の直後に1行追加:
```go
		&TaskComment{},
		&TaskTimeEntry{},
		&Bucket{},
```

### 3-4. `pkg/models/unit_tests.go` — テスト fixture 一覧に登録（**必須**）

`db.InitTestFixtures(...)` の一覧に `"task_time_entries"` を追加（`"task_comments"` の次など）。
無いと LoadAndAssertFixtures がこのテーブルを truncate せず、テスト間でデータが漏れる。

### 3-5. `pkg/models/tasks.go` — `Task.Update` を nil ガード（#1 書き込み破壊性の根治・[ADR-008](../docs/01-decisions.md)）

`POST /tasks/:id` で `assignees`/`reminders` を含めない部分更新（例 `{"title":...}`）が既存の担当者・
リマインダーを**全削除**する upstream バグの根治。`Task.Update` 内の2つの無条件呼び出しを
「payload に明示されたときだけ実行」にガードする。

(a) **assignees**（`ot.updateTaskAssignees(s, t.Assignees, a)` の呼び出し）を `if t.Assignees != nil { … }` で包む。
さらに **else 節で現状 assignees を `ot.Assignees` にロード**する（skip 時もレスポンスに現状を載せるため。
`ot.Reminders` が上で無条件ロードされるのと対称。`getRawTaskAssigneesForTasks` を使用）。

(b) **reminders**（`updateDone(&ot, t)` 直後の `ot.updateReminders(s, t)` 呼び出し）を `if t.Reminders != nil { … }` で包む。
繰り返しタスクの done 化では `updateDone`→`setTaskDates*` が `t.Reminders` を非nilにするためガードを通過し、
再スケジュールは従来どおり維持される。

意味論: **不在/`null`＝維持、`[]`＝明示クリア、`[{…}]`＝置換**。upstream の `null=クリア` 契約を
`null=維持` に変える意図的変更（部分更新の安全性優先）。migration 無し（コードのみ）＝ rollback は `git revert`。

**テスト更新（必須・パッチの一部）**：
- `pkg/integrations/task_test.go`：`{"assignees":null}` / `{"reminders":null}` の「クリア期待」テスト2件を**維持期待に反転**し、
  「部分更新で維持」の回帰テストを追加（rebase 時 upstream 版と衝突→ fork 版採用）。
- `pkg/models/tasks_test.go`：`Task.Update` に「nil で維持 / `[]` でクリア」のモデル単体テストを assignees・reminders 各2本追加。

> 関連の既存債務（同時に修正）：時間トラッキングで Task JSON に `time_estimate`/`time_spent`/`time_planned` を
> 足した際、`pkg/integrations/task_collection_test.go` のソート系の完全一致 JSON 期待値（15箇所）を更新し忘れ
> ていた。`"percent_done":N,"identifier"` の間に3フィールドを挿入して green 化した（これは §フェーズ1/2 の
> 時間トラッキングパッチに属する取りこぼし。rebase 時もこの期待値更新が必要）。

## 4. テスト（TDD）

同梱のテスト＆フィクスチャを配置:
```
pkg/models/task_time_entry_test.go     ← vikunja-patch/pkg/models/task_time_entry_test.go
pkg/db/fixtures/task_time_entries.yml  ← vikunja-patch/pkg/db/fixtures/task_time_entries.yml （空[]）
```
※ フィクスチャは空（`[]`）。エントリは各テスト内で生成する（全タスク比較の順序テストを汚さないため）。
v0.24.6 にて全テスト green・`pkg/models` 回帰なしを確認済み。
ホストに Go が無くてもコンテナで実行可:
```bash
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app golang:1.22 \
  go test ./pkg/models/ -run TaskTimeEntry -count=1 -v
```
（Create / ReadAll / time_spent集計(=4.5h) / 権限 / Delete を検証）

## 5. ビルド

### 軽量検証ビルド（API のみ・xgo/node 不要）— 推奨の開発ループ
frontend を最小スタブにして、ネイティブ `go build` で API バイナリだけ作る（CGO sqlite）:
```bash
mkdir -p frontend/dist && echo '<!doctype html>' > frontend/dist/index.html
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app -e CGO_ENABLED=1 \
  golang:1.22 go build -buildvcs=false -ldflags "-s -w" -o vikunja .
```
これを使い捨て sqlite で起動して migration＋API を検証できる（本パッチはこの方法で実証済み）。

### 配布用イメージ（実 frontend 入り）
`Dockerfile` の frontend ステージは corepack の署名キー不整合(node:20.16.0)でコケるため、
`RUN corepack enable && pnpm install ...` を **`RUN npm install -g pnpm@9.10.0 && pnpm install ...`** に変更してから:
```bash
docker build -t leo-vikunja:0.24.6-timetracking .
```
（frontend は一度ビルドすれば以後の Go 修正では再ビルド不要＝キャッシュが効く）

## 5. デプロイ（pm-trials の Vikunja を差し替え）

`/home/neo/pm-trials/vikunja/docker-compose.yml` の
`image: vikunja/vikunja:0.24.6` を `image: leo-vikunja:timetracking` に変更し:
```bash
cd /home/neo/pm-trials/vikunja && docker compose up -d
```
→ 起動時に migration 自動適用（`task_time_entries` 作成・`tasks.time_estimate` 追加）。

## 6. 動作確認

```bash
B=http://localhost:7005/api/v1
TOKEN=...   # ログインして取得
# 見積りを設定（time_estimate=18000秒=5h）
curl -X POST $B/tasks/1 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"time_estimate":18000}'
# 実績を記録（7200秒=2h）
curl -X PUT $B/tasks/1/times -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"seconds":7200,"note":"着手"}'
# 一覧 & タスク（time_spent が乗る）
curl $B/tasks/1/times -H "Authorization: Bearer $TOKEN"
curl $B/tasks/1       -H "Authorization: Bearer $TOKEN"   # → time_estimate, time_spent
```

## 注意

- これは fork（[ADR-002 改訂](../docs/01-decisions.md) / [ADR-007 昇格モデル](../docs/01-decisions.md)）。本家アップグレード時は新規ファイル群＋既存ファイル編集（§3-1〜3-5）を rebase する。特に §3-5（`Task.Update` の nil ガード, [ADR-008](../docs/01-decisions.md)）と §3-5 注記の `task_collection_test.go` 期待値更新は upstream と意図的に衝突する箇所＝ fork 版を採用。
- upstream main には既に `time_entries`（ライセンスゲート付き v2 タイマー型）がある。将来そちらに寄せる選択肢もある（[05](../docs/05-time-tracking-fork.md) 参照）。本パッチは要件（タスク単位の実績合計）に直球の最小版。
- 専用エラー型（`ErrTimeEntryDoesNotExist` 等）は実装時に Vikunja の errors 規約に合わせて追加するとよい。

---

## フェーズ2: 日別の予定 `task_time_plans`（実績 task_time_entries と対称）

実績(`task_time_entries`)と同型に「日別の予定」を追加。「何日に何を何時間やる予定か」を持つ。
新規ファイル（`task_time_entries` のコピー改名）:
```
pkg/models/task_time_plan.go         (model+CRUDable+addTimePlannedToTasks)
pkg/models/task_time_plan_rights.go  (権限: 親委譲＋本人所有)
pkg/models/error_time_plan.go        (ErrTimePlanDoesNotExist, code 15002)
pkg/models/task_time_plan_test.go    (TDD: CRUD/日別/集計/権限)
pkg/migration/20260609100000.go      (task_time_plans 作成)
pkg/db/fixtures/task_time_plans.yml  (空[])
```
既存編集（`times` と同じ箇所に追加）:
- `pkg/models/models.go` GetTables に `&TaskTimePlan{}`
- `pkg/models/unit_tests.go` fixture一覧に `"task_time_plans"`
- `pkg/models/tasks.go` Task に `TimePlanned int64 xorm:"-" json:"time_planned"`（computed）＋ `addMoreInfoToTasks` で `addTimePlannedToTasks` 呼び出し
- `pkg/routes/routes.go` に `/tasks/:task/plans`（GET/PUT/POST/DELETE、param `:timeplan`）

API: `PUT/GET /tasks/:task/plans {seconds, plan_date, note}`。Task に `time_planned`(合計) が乗る。
→ 3軸: `time_estimate`(見積り) / `time_planned`(予定合計) / `time_spent`(実績合計)。日別は plan_date / logged_on で取得。
v0.24.6 にて TDD全green・pkg/models回帰なし・隔離e2e・本番デプロイ・Playwright(予定の入力→保存→反映) 確認済み。

---

## フェーズ3: soft delete（#2・DB規範。[06-requirements §6](../docs/06-requirements.md)）

`task_time_entries`/`task_time_plans` を **論理削除**に（CLAUDE.md「全テーブルに deleted_at／hard delete 禁止」準拠）。
新規ファイル:
```
pkg/migration/20260610024916.go   (両テーブルに deleted_at 追加。Rollback=DROP COLUMN)
```
既存編集（model コピーに反映済み）:
- `pkg/models/task_time_entry.go` / `task_time_plan.go` の struct に
  `DeletedAt time.Time xorm:"deleted_at deleted"` を追加（xorm が Delete を UPDATE 化、struct クエリから自動除外）。
- **同ファイルの SUM ローダ（`addTimeSpentToTasks`/`addTimePlannedToTasks`）に `Where("deleted_at IS NULL")` を追加**
  （**最重要**: 生テーブル SELECT は xorm の soft-delete フィルタが効かないため、明示しないと論理削除分が集計に残る）。
- テスト（`task_time_entry_test.go`/`task_time_plan_test.go`）: Delete を soft 用に更新（行は残り `deleted_at` セット・ReadOne は ErrXxxDoesNotExist）＋ SUM 除外テスト＋ plan 側 Delete テスト新設。

意味論: `Delete()` は `deleted_at=now` の UPDATE。Find/Get/Count（struct）は自動で `deleted_at IS NULL`。
列は nullable（既存行は NULL=未削除）。migration は `tx.Sync`（無い列を足す・既存データ保持）。
v0.24.6 にて TDD全green・pkg/models+integrations 回帰なし・隔離e2e（削除→time_spent減・GET除外・DB行残存＋deleted_at セット）・Playwright(UI console 0) 確認済み。配布 `leo-vikunja:0.24.6-timetracking-fix2`。

---

## フェーズ4: 帰属 user_id=対象者 / created_by=記録者（#3・[ADR-009](../docs/01-decisions.md)）

「誰の時間か(対象者)」と「誰が記録したか(記録者)」を分離。
新規ファイル:
```
pkg/migration/20260610032051.go   (両テーブルに created_by 追加＋backfill created_by=user_id)
```
既存編集（model コピーに反映済み）:
- `task_time_entry.go` / `task_time_plan.go`:
  - `UserID` を **対象者**として client 設定可に（`json:"user_id"`。旧 `json:"-"`）。
  - `CreatedBy int64 xorm:"created_by index not null default 0" json:"-"` ＋ `CreatedByUser *user.User xorm:"-" json:"created_by_user"` を追加。
  - `Create`: `CreatedBy=auth`、`UserID==0` なら `UserID=auth`（対象者未指定→記録者）。Read*/ReadAll で両 user を attach。Update Cols に `user_id` 追加（対象者の付け替え可、created_by は不変）。
- `task_time_entry_permissions.go` / `task_time_plan_rights.go`:
  - `canModify` の `UserID==auth` 所有者チェックを**削除** → **task write のみ**（記録者/対象者問わず編集/削除可。小人数チーム向け）。
- テスト: Create 帰属（created_by=記録者・user_id=対象者/未指定なら記録者）・CreatedByUser attach・「task write を持てば他者の対象者エントリも削除可」。

計算層（SPA, [capacity.js](../app/lib/capacity.js) `toMemberDayEntries`）: entry.user_id が信頼できる時（assignee 無 or uid∈assignee）は対象者へ全量、それ以外は assignee 按分（**非regression**: 旧データ uid=capdemo は按分に落ちる）。SPA 配線（フォームの対象者選択・logTime/logPlan の user_id 送信）は次パス。
v0.24.6 にて TDD全green・回帰なし・隔離e2e（user_id で対象者指定→対象者/記録者分離・task-write で他者エントリ削除可）・Playwright(UI console 0) 確認済み。配布 `leo-vikunja:0.24.6-timetracking-fix3`。
