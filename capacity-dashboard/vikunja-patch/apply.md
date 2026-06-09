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

(b) `addMoreInfoToTasks(s *xorm.Session, taskMap map[int64]*Task, a web.Auth, view *ProjectView)` の
末尾近く（`addAssigneesToTasks` 等を呼んでいる箇所）に SUM ローダ呼び出しを追加。
**この関数は `taskMap` を受け取るので、taskIDs は keys から導出する**:
```go
	// 実績合計(time_spent)を attach
	timeTaskIDs := make([]int64, 0, len(taskMap))
	for id := range taskMap {
		timeTaskIDs = append(timeTaskIDs, id)
	}
	spentMap, err := sumTaskTimeSpent(s, timeTaskIDs)
	if err != nil {
		return err
	}
	for id, secs := range spentMap {
		if t, ok := taskMap[id]; ok {
			t.TimeSpent = secs
		}
	}
```
（`sumTaskTimeSpent` は `task_time_entry.go` に同梱済み。`taskMap` は同関数の引数。）

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

## 4. ビルド

```bash
# クイック検証（API のみ。frontend/dist が既にあればOK）
go build ./...

# 配布用イメージ（既存 Dockerfile, multi-stage）
docker build -t leo-vikunja:timetracking .
```

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

- これは fork（[ADR-002 改訂](../docs/01-decisions.md)）。本家アップグレード時はこの3新規ファイル＋2編集を rebase する。
- upstream main には既に `time_entries`（ライセンスゲート付き v2 タイマー型）がある。将来そちらに寄せる選択肢もある（[05](../docs/05-time-tracking-fork.md) 参照）。本パッチは要件（タスク単位の実績合計）に直球の最小版。
- 専用エラー型（`ErrTimeEntryDoesNotExist` 等）は実装時に Vikunja の errors 規約に合わせて追加するとよい。
