// Vikunja フォーク用パッチ: 定期タスク/会議(RRULE)＋祝日＋個人休暇 テーブル作成。capacity-dashboard 用。
package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type recurrences20260610081121 struct {
	ID              int64     `xorm:"bigint autoincr not null unique pk"`
	Title           string    `xorm:"text not null"`
	Kind            string    `xorm:"varchar(16) not null default 'task'"`
	RRule           string    `xorm:"text not null 'rrule'"`
	DTStart         time.Time `xorm:"DATETIME not null 'dtstart'"`
	DurationSeconds int64     `xorm:"bigint not null"`
	ProjectID       int64     `xorm:"bigint null"`
	AssigneeIDs     []int64   `xorm:"json not null 'assignee_ids'"`
	Note            string    `xorm:"text null"`
	CreatedBy       int64     `xorm:"bigint index not null default 0"`
	Created         time.Time `xorm:"created not null"`
	Updated         time.Time `xorm:"updated not null"`
	DeletedAt       time.Time `xorm:"deleted_at"`
}

func (recurrences20260610081121) TableName() string { return "recurrences" }

type holidays20260610081121 struct {
	ID        int64     `xorm:"bigint autoincr not null unique pk"`
	Date      time.Time `xorm:"DATETIME index not null"`
	Name      string    `xorm:"text not null"`
	CreatedBy int64     `xorm:"bigint index not null default 0"`
	Created   time.Time `xorm:"created not null"`
	Updated   time.Time `xorm:"updated not null"`
	DeletedAt time.Time `xorm:"deleted_at"`
}

func (holidays20260610081121) TableName() string { return "holidays" }

type memberUnavailability20260610081121 struct {
	ID        int64     `xorm:"bigint autoincr not null unique pk"`
	UserID    int64     `xorm:"bigint index not null"`
	StartDate time.Time `xorm:"DATETIME not null"`
	EndDate   time.Time `xorm:"DATETIME not null"`
	Reason    string    `xorm:"text null"`
	CreatedBy int64     `xorm:"bigint index not null default 0"`
	Created   time.Time `xorm:"created not null"`
	Updated   time.Time `xorm:"updated not null"`
	DeletedAt time.Time `xorm:"deleted_at"`
}

func (memberUnavailability20260610081121) TableName() string { return "member_unavailability" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20260610081121",
		Description: "Add recurrences, holidays, member_unavailability tables (RRULE recurring tasks/meetings + availability)",
		Migrate: func(tx *xorm.Engine) error {
			if err := tx.Sync(recurrences20260610081121{}); err != nil {
				return err
			}
			if err := tx.Sync(holidays20260610081121{}); err != nil {
				return err
			}
			return tx.Sync(memberUnavailability20260610081121{})
		},
		Rollback: func(tx *xorm.Engine) error {
			return tx.DropTables(
				recurrences20260610081121{},
				holidays20260610081121{},
				memberUnavailability20260610081121{},
			)
		},
	})
}
