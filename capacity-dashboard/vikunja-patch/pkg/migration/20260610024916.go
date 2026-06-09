// Vikunja フォーク用パッチ: マイグレーション（#2 soft delete）
// task_time_entries / task_time_plans に deleted_at（論理削除）を追加。
// xorm Sync は「無い列を足す」だけ＝既存データ保持。既存行の deleted_at は NULL（=未削除）。
package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type taskTimeEntriesSoftDelete20260610024916 struct {
	ID        int64     `xorm:"bigint autoincr not null unique pk"`
	DeletedAt time.Time `xorm:"deleted_at"`
}

func (taskTimeEntriesSoftDelete20260610024916) TableName() string { return "task_time_entries" }

type taskTimePlansSoftDelete20260610024916 struct {
	ID        int64     `xorm:"bigint autoincr not null unique pk"`
	DeletedAt time.Time `xorm:"deleted_at"`
}

func (taskTimePlansSoftDelete20260610024916) TableName() string { return "task_time_plans" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260610024916",
		Description: "Add deleted_at (soft delete) to task_time_entries and task_time_plans",
		Migrate: func(tx *xorm.Engine) error {
			if err := tx.Sync(taskTimeEntriesSoftDelete20260610024916{}); err != nil {
				return err
			}
			return tx.Sync(taskTimePlansSoftDelete20260610024916{})
		},
		Rollback: func(tx *xorm.Engine) error {
			if _, err := tx.Exec("ALTER TABLE task_time_entries DROP COLUMN deleted_at"); err != nil {
				return err
			}
			_, err := tx.Exec("ALTER TABLE task_time_plans DROP COLUMN deleted_at")
			return err
		},
	})
}
