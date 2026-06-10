// TaskStation フォーク用パッチ: マイグレーション
// 配置先: <vikunja>/pkg/migration/20260609090000.go
// (1) task_time_entries テーブル作成 (2) tasks に time_estimate 列追加
// xorm Sync は「無い列/表を足す」ので既存データは保持。サーバ起動時に自動適用。
package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

// マイグレーション専用のローカル構造体（モデルと同じテーブル名を返す）
type taskTimeEntries20260609090000 struct {
	ID       int64     `xorm:"bigint autoincr not null unique pk"`
	TaskID   int64     `xorm:"bigint index not null"`
	UserID   int64     `xorm:"bigint index not null"`
	Seconds  int64     `xorm:"bigint not null"`
	LoggedOn time.Time `xorm:"DATETIME index not null"`
	Note     string    `xorm:"text null"`
	Created  time.Time `xorm:"created not null"`
	Updated  time.Time `xorm:"updated not null"`
}

func (taskTimeEntries20260609090000) TableName() string { return "task_time_entries" }

type tasks20260609090000 struct {
	ID           int64 `xorm:"bigint autoincr not null unique pk"`
	TimeEstimate int64 `xorm:"bigint null default 0"`
}

func (tasks20260609090000) TableName() string { return "tasks" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260609090000",
		Description: "Add task_time_entries table and tasks.time_estimate column (native time tracking)",
		Migrate: func(tx *xorm.Engine) error {
			if err := tx.Sync(taskTimeEntries20260609090000{}); err != nil {
				return err
			}
			return tx.Sync(tasks20260609090000{})
		},
		Rollback: func(tx *xorm.Engine) error {
			return tx.DropTables(taskTimeEntries20260609090000{})
		},
	})
}
