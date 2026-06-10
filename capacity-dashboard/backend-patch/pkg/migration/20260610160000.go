// Vikunja フォーク用パッチ: task_time_plans に start_minute（時刻配置）を追加。capacity-dashboard カレンダー用（ADR-013）。
package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type taskTimePlans20260610160000 struct {
	ID          int64     `xorm:"bigint autoincr not null unique pk"`
	TaskID      int64     `xorm:"bigint index not null"`
	UserID      int64     `xorm:"bigint index not null"`
	CreatedBy   int64     `xorm:"bigint index not null default 0"`
	Seconds     int64     `xorm:"bigint not null"`
	PlanDate    time.Time `xorm:"DATETIME index not null"`
	StartMinute *int64    `xorm:"'start_minute' null"`
	Note        string    `xorm:"text null"`
	Created     time.Time `xorm:"created not null"`
	Updated     time.Time `xorm:"updated not null"`
	DeletedAt   time.Time `xorm:"deleted_at"`
}

func (taskTimePlans20260610160000) TableName() string { return "task_time_plans" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260610160000",
		Description: "Add start_minute to task_time_plans (time-of-day calendar, ADR-013)",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(taskTimePlans20260610160000{})
		},
		Rollback: func(tx *xorm.Engine) error {
			// 追加のみ（列削除は sqlite で煩雑）。ロールバックは image 戻しで対応（runbook）。
			return nil
		},
	})
}
