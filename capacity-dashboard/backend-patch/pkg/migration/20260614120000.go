// Vikunja フォーク用パッチ: tasks に started_at（着手時刻）列を追加。capacity-dashboard 用。
// 「未着手 / 進行中」を percent_done と独立に持つための1ビット相当（null=未着手 / 非null=進行中）。
// 完了(done)は別軸。既存の進行中タスク（percent_done>0 かつ未完了）は updated を着手時刻に backfill。
package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type tasks20260614120000 struct {
	StartedAt time.Time `xorm:"null 'started_at'"`
}

func (tasks20260614120000) TableName() string { return "tasks" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260614120000",
		Description: "Add started_at column to tasks (着手時刻 / 未着手↔進行中 を percent_done と独立化)",
		Migrate: func(tx *xorm.Engine) error {
			if err := tx.Sync(tasks20260614120000{}); err != nil {
				return err
			}
			// 既存の「進行中」相当（進捗あり・未完了）を着手済みとして backfill。
			// done が NULL の行も未完了として拾う。値は updated（最終更新≒作業時刻）を流用。
			_, err := tx.Exec(
				"UPDATE tasks SET started_at = updated " +
					"WHERE (percent_done > 0) AND (done = ? OR done IS NULL) AND started_at IS NULL",
				false,
			)
			return err
		},
		Rollback: func(tx *xorm.Engine) error {
			_, err := tx.Exec("ALTER TABLE tasks DROP COLUMN started_at")
			return err
		},
	})
}
