# vikunja-patch — ネイティブ実績時間トラッキング

Vikunja を fork して **実績時間（worklog）と見積りを DB に第一級で持たせる**ためのパッチ。
背景・設計は [`../docs/05-time-tracking-fork.md`](../docs/05-time-tracking-fork.md)、意思決定は
[`../docs/01-decisions.md` ADR-006](../docs/01-decisions.md)。

## 入っているもの

```
vikunja-patch/
├── pkg/models/task_time_entry.go              # 新規モデル（CRUDable）＋ time_spent SUM ローダ
├── pkg/models/task_time_entry_permissions.go  # 権限（親タスクへ委譲＋所有者チェック）
├── pkg/migration/20260609090000_task_time_entries.go  # task_time_entries 作成＋tasks.time_estimate 追加
└── apply.md                                    # 適用手順（既存2ファイルの編集差分・ビルド・デプロイ・動作確認）
```

## やること（要約）

1. `git clone https://code.vikunja.io/vikunja`
2. 上記3ファイルを所定パスへ配置
3. `pkg/models/tasks.go` と `pkg/routes/routes.go` を2箇所だけ編集（[apply.md](apply.md)）
4. `docker build -t leo-vikunja:timetracking .`
5. pm-trials の compose の image を差し替えて起動（migration 自動適用）

## スキーマ

- **`task_time_entries`**（新規）: id / task_id / user_id / seconds / logged_on / note / created / updated
- **`tasks.time_estimate`**（列追加）: 見積り（秒）
- **`tasks.time_spent`**（computed, 非永続）: `SUM(task_time_entries.seconds)`

## API

```
PUT    /api/v1/tasks/:task/times          # 実績を記録 {seconds, logged_on?, note?}
GET    /api/v1/tasks/:task/times          # 一覧
POST   /api/v1/tasks/:task/times/:id      # 更新（自分の記録）
DELETE /api/v1/tasks/:task/times/:id      # 削除（自分の記録）
POST   /api/v1/tasks/:id  {time_estimate} # 見積り設定
```

> 注: これは設計に忠実なスキャフォルド。実ビルドでは Vikunja の errors 規約に沿った専用エラー型の追加、
> `go build ./...` での型確認、テスト追加を行うこと。upstream main の native `time_entries`（ライセンスゲート付きv2）
> に将来寄せる選択肢もある（[05](../docs/05-time-tracking-fork.md)）。
