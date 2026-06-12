// Vikunja フォーク用パッチ: recurrences に overrides（この回だけの例外）列を追加。capacity-dashboard 用。
// キー=元 occurrence の日付。値={"skip":true} or {"date","start_minute","duration_seconds"}（解釈は SPA 側）。
package migration

import (
	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type recurrences20260613000000 struct {
	Overrides map[string]interface{} `xorm:"json null"`
}

func (recurrences20260613000000) TableName() string { return "recurrences" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260613000000",
		Description: "Add overrides column to recurrences (per-occurrence exceptions)",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(recurrences20260613000000{})
		},
		Rollback: func(tx *xorm.Engine) error {
			_, err := tx.Exec("ALTER TABLE recurrences DROP COLUMN overrides")
			return err
		},
	})
}
