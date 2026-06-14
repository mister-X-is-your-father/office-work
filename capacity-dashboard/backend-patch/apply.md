# backend-patch 適用手順

TaskStation を fork して**ネイティブ実績時間トラッキング**を足すパッチ。
設計は [`../docs/05-time-tracking-fork.md`](../docs/05-time-tracking-fork.md)。

## 1. clone

```bash
git clone https://code.vikunja.io/vikunja
cd vikunja
```

## 2. 新規ファイルを配置（このパッチをそのままコピー）

```
pkg/models/task_time_entry.go              ← backend-patch/pkg/models/task_time_entry.go
pkg/models/task_time_entry_permissions.go  ← backend-patch/pkg/models/task_time_entry_permissions.go
pkg/models/error_time_entry.go             ← backend-patch/pkg/models/error_time_entry.go
pkg/migration/20260609090000.go            ← backend-patch/pkg/migration/20260609090000_task_time_entries.go
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

(c-2) **`Task.Update` の「ゼロ値を 0 に戻す」ブロックに `TimeEstimate` を追加**（fix10・**必須**）。
Vikunja は受信タスクを mergo（ゼロ値は無視）で DB 既存値にマージするため、`Priority`/`DueDate` 等と
同様に明示的に 0 へ戻さないと **見積りを 0 にクリアできない**（非ゼロは保存できるがクリアだけ不可）。
`cover_image_attachment_id` のゼロ戻しブロック直後に追加:
```go
	// Time estimate (fork: native time tracking) — allow clearing back to 0
	if t.TimeEstimate == 0 {
		ot.TimeEstimate = 0
	}
```
→ デプロイ: `go build -buildvcs=false -ldflags "-s -w" -o vikunja .` → `docker build -f backend-patch/Dockerfile.deploy
-t leo-taskstation:0.24.6-fix10 .`（context=fork ルート）→ `~/apps/pm-trials/vikunja/docker-compose.yml` の
image を fix10 に上げて `docker compose up -d`。

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
pkg/models/task_time_entry_test.go     ← backend-patch/pkg/models/task_time_entry_test.go
pkg/db/fixtures/task_time_entries.yml  ← backend-patch/pkg/db/fixtures/task_time_entries.yml （空[]）
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

## 5. デプロイ（pm-trials の TaskStation を差し替え）

`/home/neo/apps/pm-trials/vikunja/docker-compose.yml` の
`image: vikunja/vikunja:0.24.6` を `image: leo-vikunja:timetracking` に変更し:
```bash
cd /home/neo/apps/pm-trials/vikunja && docker compose up -d
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
- 専用エラー型（`ErrTimeEntryDoesNotExist` 等）は実装時に TaskStation の errors 規約に合わせて追加するとよい。

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

---

## フェーズ5: 定期タスク/会議(RRULE)＋祝日＋個人休暇（[ADR-011](../docs/01-decisions.md)）

1ヶ月先の (メンバー×日) 空きを「定期/会議・祝日・休暇込み」で出すためのデータ層。**fork は RRULE 文字列を保存するだけ（dumb storage、展開しない）**、展開は SPA(rrule.js)。
新規ファイル（model/rights/error/test ＋ migration ＋ 空fixture）:
```
pkg/models/recurrence.go / recurrence_rights.go / error_recurrence.go(15003) / recurrence_test.go
pkg/models/holiday.go / error_holiday.go(15004) / holiday_test.go
pkg/models/member_unavailability.go / error_member_unavailability.go(15005) / member_unavailability_test.go
pkg/migration/20260610081121.go                      (3テーブル作成)
pkg/db/fixtures/{recurrences,holidays,member_unavailability}.yml (空[])
```
既存編集（time系と同じ4箇所）:
- `pkg/models/models.go` GetTables に `&Recurrence{} &Holiday{} &MemberUnavailability{}`
- `pkg/models/unit_tests.go` fixture一覧に3テーブル名
- `pkg/routes/routes.go` に `/recurrences`(+`:recurrence`)/`/holidays`/`/unavailability` の WebHandler CRUD（**認証済みグループ a 配下＝認証ユーザーCRUD可**、`label_rights.go` 流の Can* で実装）

要点・gotcha:
- **GonicMapper の列名ズレ**: `DTStart`→`d_t_start`、`RRule`→`r_rule`、`AssigneeIDs`→`assignee_i_ds` になるため、`xorm:"... 'dtstart'"` のように**明示列名**を付ける（model と migration の両方）。`UserID`/`ProjectID`/`CreatedBy` は GonicMapper が正しく `user_id`/`project_id`/`created_by` にする。
- **JSON列**: `AssigneeIDs []int64 xorm:"json not null 'assignee_ids'"`（前例 `api_tokens`）。4つ目の表を回避。多担当=全員フル(ADR-010)。
- soft delete(#2)/created_by(#3) 踏襲。グローバル設定なので親委譲なし。occurrence は仮想。
- API: `PUT /recurrences {title,kind,rrule,dtstart,duration_seconds,assignee_ids,...}`、`/holidays {date,name}`、`/unavailability {user_id,start_date,end_date,reason}`。
v0.24.6 で S1(models+integrations green)→S2(隔離7011: migration3表＋JSON往復＋soft delete)→本番 `leo-vikunja:0.24.6-timetracking-fix4`→seed(`seed-recurrence-demo.py`)→Playwright(freefinder で定期/祝日/休暇 反映・console0) 確認済み。

---

## フェーズ6: recurrences.rotation（持ち回り）

定期タスクの担当を「毎回1名が順番に巡回」させるためのフラグ。**順番=assignee_ids の配列順**。巡回の割当・負荷計算は SPA([recurrence.js](../app/lib/recurrence.js) `expandRecurrences` が occurrence ごとに `assignees` を解決、dtstart からの通し番号 % 人数)。fork は保持のみ。
```
pkg/models/recurrence.go        Rotation bool `xorm:"not null default false" json:"rotation"` 追加＋Update Cols に "rotation"
pkg/models/recurrence_test.go   rotation 往復/default false/update で倒せる テスト追加
pkg/migration/20260612220000.go rotation 列追加（Sync・additive）
```
v0.24.6 で S1(models+integrations green)→S2(隔離7011: rotation 往復/update)→本番 `leo-taskstation:0.24.6-fix8`（migration 自動・既存行は rotation=false）確認済み。
入力UI: タスク追加モーダルの種別タブ（[recurrenceform.js](../app/views/recurrenceform.js)・MTG=COUNT=1/定例MTG/定期タスク=持ち回り順序UI）。

---

## フェーズ7: recurrences.overrides（この回だけの例外）

Googleカレンダーの「この予定のみ変更」相当。**キー=元 occurrence の日付 "YYYY-MM-DD"**、値は差分のみ:
`{"skip":true}`（休止）/ `{"date":"YYYY-MM-DD","start_minute":840,"duration_seconds":1800}`（移動/時刻/所要・部分指定可）。
解釈は SPA([recurrence.js](../app/lib/recurrence.js) `expandRecurrences`): ±31日パディングで展開→override 適用→最終日付で窓フィルタ（窓またぎの移動も正しく拾う）。**持ち回りの巡回番号は元の日基準**＝休止/移動しても順番が崩れない。fork は保持のみ（JSON列・dumb storage）。
```
pkg/models/recurrence.go        Overrides map[string]interface{} `xorm:"json null 'overrides'"` 追加＋Update Cols に "overrides"
pkg/migration/20260613000000.go overrides 列追加（Sync・additive）
```
v0.24.6 で S1(models+integrations green)→S2(隔離7011: overrides 作成/更新の往復)→本番 `leo-taskstation:0.24.6-fix9`（migration 自動・既存行は overrides=null）確認済み。
入力UI: 時刻カレンダー([calendar.js](../app/views/calendar.js))の会議/定例ブロックをクリック→「この回だけ変更」モーダル（日付/開始時刻/所要・この回を休止・例外を解除。例外中は ✱＋破線枠）。

---

## フェーズ8: tasks.started_at（着手時刻 / 未着手↔進行中を percent_done と独立化）

**背景**: 「未着手 / 進行中」をどこにも保存しておらず `percent_done` から逆算していた（0%=未着手 / 1-99%=進行中 / 100%=完了）。
そのため「進行中にする」＝「%を非ゼロにする」しか手段がなく、UI が `percent_done=50` を**捏造**していた（ステータス操作が進捗%に
影響＝設計上の歪み）。**ステータスと進捗%は別軸**にすべき、という要件（唯一の許容カップリングは「完了=100%」）。

**解決**: `tasks` に `started_at`（着手時刻・nullable）を実カラムとして追加。`null`=未着手 / 非null=進行中。完了は `done` で別軸。
SPA はステータス操作で **%を触らず** `started_at` だけを立て下げする（進行中=now / 未着手=null / 完了=done+100）。
`start_date`（開始予定日）とは別物＝実際に着手した時刻。

新規ファイル:
```
pkg/migration/20260614120000.go   (tasks に started_at 追加＋既存進行中=percent_done>0&未完了 を updated で backfill)
```
既存編集（`time_estimate` と同じ3箇所＝§3-1 と同型）:
- `pkg/models/tasks.go`:
  - (a) Task struct に `StartedAt time.Time xorm:"null 'started_at'" json:"started_at"`（`TimePlanned` の近く）。
  - (b) `Task.Update` の `colsToUpdate` に `"started_at"` を追加（**必須**・無いと永続化されない）。
  - (c) `Task.Update` の「ゼロ値を戻す」ブロックに `started_at` を追加（**必須**・mergo がゼロ時刻を無視するため、
    これが無いと **進行中→未着手（null クリア）ができない**。`TimeEstimate` のゼロ戻し直後に）:
    ```go
    // Started at (fork: capacity-dashboard) — allow clearing back to null (進行中→未着手).
    if t.StartedAt.IsZero() {
        ot.StartedAt = time.Time{}
    }
    ```
  - GetTables/routes の追加は不要（既存 `tasks` テーブルへの列追加のみ・新エンドポイント無し）。

SPA 側（参考・本パッチと同一PR）:
- `app/lib/api.js` TASK_SCALARS に `"started_at"`（full-send で維持）。
- `app/lib/capacity.js` `hasStarted(t) = hasDate(started_at) || percent_done>0`（後者は外部編集/旧データの保険）。
- `app/views/table.js` ステータスメニュー: 進行中=`{done:false, percent_done:keepPct, started_at:now}`（完了からの復帰のみ100→0、
  それ以外は%維持＝**50捏造を廃止**）／未着手=`{…, started_at:null}`／完了=`{done:true, percent_done:100}`。
  `stateOf`/`stateRank`/状態チップ＋ `outline.js`/`depgraph.js`/`smartlist.js` の逆算を `hasStarted` に統一。

→ デプロイ: §3-1(c) と同じ手順で `go build` → `docker build -f Dockerfile.deploy -t leo-taskstation:0.24.6-fix11 .`
→ `~/apps/pm-trials/vikunja/docker-compose.yml` の image を fix11 に上げて `docker compose up -d`（migration 自動・既存行は started_at=null、進行中相当は backfill 済）。

v0.24.6 にて `go build` OK・migration 自動適用（started_at 列追加＋backfill 6件一致）・実API往復で
**進行中=started_at立つ&percent=0（50捏造なし）/ 未着手=null戻し / 完了=100 / 完了→進行中=100→0 / 無関係full-send更新で started_at 維持** を確認・
Playwright（leo:7010/app）で未着手→進行中クリックでバー0%維持（旧50%が消滅）・console アプリ由来0 を確認済み。配布 `leo-taskstation:0.24.6-fix11`。
