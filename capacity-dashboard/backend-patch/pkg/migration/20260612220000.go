// Vikunja フォーク用パッチ: recurrences に rotation（持ち回り）列を追加。capacity-dashboard 用。
// true なら各 occurrence の担当は assignee_ids を配列順に巡回する（解釈は SPA 側）。
package migration

import (
	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type recurrences20260612220000 struct {
	Rotation bool `xorm:"not null default false"`
}

func (recurrences20260612220000) TableName() string { return "recurrences" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260612220000",
		Description: "Add rotation column to recurrences (rotating assignee for recurring tasks)",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(recurrences20260612220000{})
		},
		Rollback: func(tx *xorm.Engine) error {
			_, err := tx.Exec("ALTER TABLE recurrences DROP COLUMN rotation")
			return err
		},
	})
}
