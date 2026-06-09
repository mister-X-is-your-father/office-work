// Vikunja フォーク用パッチ: 実績時間（worklog）モデル
// 配置先: <vikunja>/pkg/models/task_time_entry.go
// task_comments.go の CRUDable パターンを踏襲。
package models

import (
	"time"

	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// TaskTimeEntry は1タスクに対する実績時間の1エントリ（worklog）。
type TaskTimeEntry struct {
	// エントリID
	ID int64 `xorm:"bigint autoincr not null unique pk" json:"id" param:"timeentry"`
	// 対象タスク
	TaskID int64 `xorm:"bigint index not null" json:"-" param:"task"`
	// 記録者（auth から自動設定）
	UserID int64      `xorm:"bigint index not null" json:"-"`
	User   *user.User `xorm:"-" json:"user" readOnly:"true"`
	// 実績の長さ（秒）
	Seconds int64 `xorm:"bigint not null" json:"seconds" valid:"required"`
	// 作業日（既定: now）
	LoggedOn time.Time `xorm:"DATETIME index not null" json:"logged_on"`
	// メモ
	Note string `xorm:"text null" json:"note"`

	Created time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`

	web.CRUDable `xorm:"-" json:"-"`
	web.Rights   `xorm:"-" json:"-"`
}

// TableName は DB テーブル名。
func (*TaskTimeEntry) TableName() string {
	return "task_time_entries"
}

// Create は実績エントリを1件記録する。記録者は認証ユーザー。
func (te *TaskTimeEntry) Create(s *xorm.Session, a web.Auth) (err error) {
	te.ID = 0
	te.UserID = a.GetID()
	if te.LoggedOn.IsZero() {
		te.LoggedOn = time.Now()
	}
	if _, err = s.Insert(te); err != nil {
		return
	}
	te.User, err = user.GetUserByID(s, te.UserID)
	return
}

// ReadOne は単一エントリを取得する。
func (te *TaskTimeEntry) ReadOne(s *xorm.Session, _ web.Auth) (err error) {
	exists, err := s.ID(te.ID).Get(te)
	if err != nil {
		return
	}
	if !exists {
		return ErrTimeEntryDoesNotExist{ID: te.ID}
	}
	te.User, err = user.GetUserByID(s, te.UserID)
	return
}

// ReadAll はタスクの実績エントリ一覧（新しい作業日順）を返す。
func (te *TaskTimeEntry) ReadAll(s *xorm.Session, _ web.Auth, _ string, page int, perPage int) (result interface{}, resultCount int, total int64, err error) {
	var entries []*TaskTimeEntry
	q := s.Where("task_id = ?", te.TaskID).OrderBy("logged_on desc")
	if perPage > 0 {
		q = q.Limit(perPage, (page-1)*perPage)
	}
	if err = q.Find(&entries); err != nil {
		return nil, 0, 0, err
	}
	// 記録者をまとめて attach
	for _, e := range entries {
		e.User, _ = user.GetUserByID(s, e.UserID)
	}
	total, err = s.Where("task_id = ?", te.TaskID).Count(&TaskTimeEntry{})
	return entries, len(entries), total, err
}

// Update は自分のエントリの seconds/note/logged_on を更新する。
func (te *TaskTimeEntry) Update(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(te.ID).Cols("seconds", "note", "logged_on").Update(te)
	return
}

// Delete はエントリを削除する。
func (te *TaskTimeEntry) Delete(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(te.ID).Delete(&TaskTimeEntry{})
	return
}

// sumTaskTimeSpent は複数タスクの実績合計(秒)を task_id => seconds で返す。
// tasks.go の addMoreInfoToTasks から呼び、Task.TimeSpent に attach する。
func sumTaskTimeSpent(s *xorm.Session, taskIDs []int64) (map[int64]int64, error) {
	if len(taskIDs) == 0 {
		return map[int64]int64{}, nil
	}
	type row struct {
		TaskID  int64 `xorm:"task_id"`
		Seconds int64 `xorm:"seconds"`
	}
	var rows []row
	err := s.Table("task_time_entries").
		Select("task_id, SUM(seconds) AS seconds").
		In("task_id", taskIDs).
		GroupBy("task_id").
		Find(&rows)
	out := make(map[int64]int64, len(rows))
	for _, r := range rows {
		out[r.TaskID] = r.Seconds
	}
	return out, err
}
