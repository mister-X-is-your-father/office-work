// Vikunja フォーク用パッチ: マイグレーション（#3 帰属・ADR-009）
// task_time_entries / task_time_plans に created_by（記録者）を追加。
// 既存行は user_id が元々「作成者」なので、created_by = user_id で backfill（記録者を保全）。
// 以降 user_id は「対象者」を表す（client が指定可、Create で未指定なら記録者）。
package migration

import (
	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type taskTimeEntriesCreatedBy20260610032051 struct {
	ID        int64 `xorm:"bigint autoincr not null unique pk"`
	CreatedBy int64 `xorm:"bigint index not null default 0"`
}

func (taskTimeEntriesCreatedBy20260610032051) TableName() string { return "task_time_entries" }

type taskTimePlansCreatedBy20260610032051 struct {
	ID        int64 `xorm:"bigint autoincr not null unique pk"`
	CreatedBy int64 `xorm:"bigint index not null default 0"`
}

func (taskTimePlansCreatedBy20260610032051) TableName() string { return "task_time_plans" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260610032051",
		Description: "Add created_by (recorder) to task_time_entries/task_time_plans and backfill from user_id",
		Migrate: func(tx *xorm.Engine) error {
			if err := tx.Sync(taskTimeEntriesCreatedBy20260610032051{}); err != nil {
				return err
			}
			if err := tx.Sync(taskTimePlansCreatedBy20260610032051{}); err != nil {
				return err
			}
			// 既存行: user_id(=旧作成者) を記録者として保全
			if _, err := tx.Exec("UPDATE task_time_entries SET created_by = user_id WHERE created_by = 0"); err != nil {
				return err
			}
			_, err := tx.Exec("UPDATE task_time_plans SET created_by = user_id WHERE created_by = 0")
			return err
		},
		Rollback: func(tx *xorm.Engine) error {
			if _, err := tx.Exec("ALTER TABLE task_time_entries DROP COLUMN created_by"); err != nil {
				return err
			}
			_, err := tx.Exec("ALTER TABLE task_time_plans DROP COLUMN created_by")
			return err
		},
	})
}
