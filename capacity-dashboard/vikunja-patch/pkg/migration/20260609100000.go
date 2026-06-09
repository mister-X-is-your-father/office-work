// Vikunja フォーク用パッチ: マイグレーション（task_time_plans テーブル作成）
package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type taskTimePlans20260609100000 struct {
	ID       int64     `xorm:"bigint autoincr not null unique pk"`
	TaskID   int64     `xorm:"bigint index not null"`
	UserID   int64     `xorm:"bigint index not null"`
	Seconds  int64     `xorm:"bigint not null"`
	PlanDate time.Time `xorm:"DATETIME index not null"`
	Note     string    `xorm:"text null"`
	Created  time.Time `xorm:"created not null"`
	Updated  time.Time `xorm:"updated not null"`
}

func (taskTimePlans20260609100000) TableName() string { return "task_time_plans" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260609100000",
		Description: "Add task_time_plans table (per-day planned time)",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(taskTimePlans20260609100000{})
		},
		Rollback: func(tx *xorm.Engine) error {
			return tx.DropTables(taskTimePlans20260609100000{})
		},
	})
}
