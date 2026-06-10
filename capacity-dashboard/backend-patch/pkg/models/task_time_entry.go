// TaskStation フォーク用パッチ: 実績時間（worklog）モデル
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
	// 対象者（その時間を負う人。client が user_id で指定可、未指定なら記録者）
	UserID int64      `xorm:"bigint index not null" json:"user_id"`
	User   *user.User `xorm:"-" json:"user" readOnly:"true"`
	// 記録者（auth から自動設定・不変。#3 ADR-009）
	CreatedBy     int64      `xorm:"bigint index not null default 0" json:"-"`
	CreatedByUser *user.User `xorm:"-" json:"created_by_user" readOnly:"true"`
	// 実績の長さ（秒）
	Seconds int64 `xorm:"bigint not null" json:"seconds" valid:"required"`
	// 作業日（既定: now）
	LoggedOn time.Time `xorm:"DATETIME index not null" json:"logged_on"`
	// メモ
	Note string `xorm:"text null" json:"note"`

	Created time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	// 論理削除マーカー（#2 soft delete）。列名 deleted_at。xorm が Delete を UPDATE 化し、
	// struct クエリ（Find/Get/Count）から自動除外する。
	DeletedAt time.Time `xorm:"deleted_at deleted" json:"-"`

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
	te.CreatedBy = a.GetID() // 記録者
	if te.UserID == 0 {      // 対象者（未指定なら記録者）
		te.UserID = a.GetID()
	}
	if te.LoggedOn.IsZero() {
		te.LoggedOn = time.Now()
	}
	if _, err = s.Insert(te); err != nil {
		return
	}
	if te.User, err = user.GetUserByID(s, te.UserID); err != nil {
		return
	}
	te.CreatedByUser, err = user.GetUserByID(s, te.CreatedBy)
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
	if te.User, err = user.GetUserByID(s, te.UserID); err != nil {
		return
	}
	te.CreatedByUser, err = user.GetUserByID(s, te.CreatedBy)
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
	// 対象者・記録者をまとめて attach
	for _, e := range entries {
		e.User, _ = user.GetUserByID(s, e.UserID)
		e.CreatedByUser, _ = user.GetUserByID(s, e.CreatedBy)
	}
	total, err = s.Where("task_id = ?", te.TaskID).Count(&TaskTimeEntry{})
	return entries, len(entries), total, err
}

// Update は自分のエントリの seconds/note/logged_on を更新する。
func (te *TaskTimeEntry) Update(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(te.ID).Cols("seconds", "note", "logged_on", "user_id").Update(te)
	return
}

// Delete はエントリを削除する。
func (te *TaskTimeEntry) Delete(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(te.ID).Delete(&TaskTimeEntry{})
	return
}

// addTimeSpentToTasks は task_time_entries の SUM(seconds) を各 Task.TimeSpent に attach する。
// tasks.go の addMoreInfoToTasks から、他の addXToTasks(s, taskIDs, taskMap) と同じ形で呼ぶ。
func addTimeSpentToTasks(s *xorm.Session, taskIDs []int64, taskMap map[int64]*Task) error {
	if len(taskIDs) == 0 {
		return nil
	}
	type timeSpentRow struct {
		TaskID  int64 `xorm:"task_id"`
		Seconds int64 `xorm:"seconds"`
	}
	var rows []timeSpentRow
	err := s.Table("task_time_entries").
		Select("task_id, SUM(seconds) AS seconds").
		Where("deleted_at IS NULL"). // #2: 論理削除分を集計から除外（生テーブルSELECTはxormのsoft-deleteフィルタが効かない）
		In("task_id", taskIDs).
		GroupBy("task_id").
		Find(&rows)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if t, ok := taskMap[r.TaskID]; ok {
			t.TimeSpent = r.Seconds
		}
	}
	return nil
}
