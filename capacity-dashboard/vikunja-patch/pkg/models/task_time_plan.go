// Vikunja フォーク用パッチ: 日別の予定時間（plan）モデル
// 「user が plan_date に task に seconds 充てる予定」。実績(task_time_entries)と対称。
// 配置先: <vikunja>/pkg/models/task_time_plan.go
package models

import (
	"time"

	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// TaskTimePlan は1タスクに対する日別の予定時間の1エントリ。
type TaskTimePlan struct {
	ID       int64      `xorm:"bigint autoincr not null unique pk" json:"id" param:"timeplan"`
	TaskID   int64      `xorm:"bigint index not null" json:"-" param:"task"`
	// 対象者（誰の予定か。client が user_id で指定可、未指定なら記録者）
	UserID int64      `xorm:"bigint index not null" json:"user_id"`
	User   *user.User `xorm:"-" json:"user" readOnly:"true"`
	// 記録者（auth から自動設定・不変。#3 ADR-009）
	CreatedBy     int64      `xorm:"bigint index not null default 0" json:"-"`
	CreatedByUser *user.User `xorm:"-" json:"created_by_user" readOnly:"true"`
	// 予定時間（秒）
	Seconds int64 `xorm:"bigint not null" json:"seconds" valid:"required"`
	// 予定日
	PlanDate time.Time `xorm:"DATETIME index not null" json:"plan_date"`
	Note     string    `xorm:"text null" json:"note"`

	Created time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	// 論理削除マーカー（#2 soft delete）。列名 deleted_at。
	DeletedAt time.Time `xorm:"deleted_at deleted" json:"-"`

	web.CRUDable `xorm:"-" json:"-"`
	web.Rights   `xorm:"-" json:"-"`
}

func (*TaskTimePlan) TableName() string { return "task_time_plans" }

func (tp *TaskTimePlan) Create(s *xorm.Session, a web.Auth) (err error) {
	tp.ID = 0
	tp.CreatedBy = a.GetID() // 記録者
	if tp.UserID == 0 {      // 対象者（未指定なら記録者）
		tp.UserID = a.GetID()
	}
	if tp.PlanDate.IsZero() {
		tp.PlanDate = time.Now()
	}
	if _, err = s.Insert(tp); err != nil {
		return
	}
	if tp.User, err = user.GetUserByID(s, tp.UserID); err != nil {
		return
	}
	tp.CreatedByUser, err = user.GetUserByID(s, tp.CreatedBy)
	return
}

func (tp *TaskTimePlan) ReadOne(s *xorm.Session, _ web.Auth) (err error) {
	exists, err := s.ID(tp.ID).Get(tp)
	if err != nil {
		return
	}
	if !exists {
		return ErrTimePlanDoesNotExist{ID: tp.ID}
	}
	if tp.User, err = user.GetUserByID(s, tp.UserID); err != nil {
		return
	}
	tp.CreatedByUser, err = user.GetUserByID(s, tp.CreatedBy)
	return
}

func (tp *TaskTimePlan) ReadAll(s *xorm.Session, _ web.Auth, _ string, page int, perPage int) (result interface{}, resultCount int, total int64, err error) {
	var plans []*TaskTimePlan
	q := s.Where("task_id = ?", tp.TaskID).OrderBy("plan_date asc")
	if perPage > 0 {
		q = q.Limit(perPage, (page-1)*perPage)
	}
	if err = q.Find(&plans); err != nil {
		return nil, 0, 0, err
	}
	for _, e := range plans {
		e.User, _ = user.GetUserByID(s, e.UserID)
		e.CreatedByUser, _ = user.GetUserByID(s, e.CreatedBy)
	}
	total, err = s.Where("task_id = ?", tp.TaskID).Count(&TaskTimePlan{})
	return plans, len(plans), total, err
}

func (tp *TaskTimePlan) Update(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(tp.ID).Cols("seconds", "note", "plan_date", "user_id").Update(tp)
	return
}

func (tp *TaskTimePlan) Delete(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(tp.ID).Delete(&TaskTimePlan{})
	return
}

// addTimePlannedToTasks は task_time_plans の SUM(seconds) を各 Task.TimePlanned に attach する。
func addTimePlannedToTasks(s *xorm.Session, taskIDs []int64, taskMap map[int64]*Task) error {
	if len(taskIDs) == 0 {
		return nil
	}
	type plannedRow struct {
		TaskID  int64 `xorm:"task_id"`
		Seconds int64 `xorm:"seconds"`
	}
	var rows []plannedRow
	err := s.Table("task_time_plans").
		Select("task_id, SUM(seconds) AS seconds").
		Where("deleted_at IS NULL"). // #2: 論理削除分を集計から除外
		In("task_id", taskIDs).
		GroupBy("task_id").
		Find(&rows)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if t, ok := taskMap[r.TaskID]; ok {
			t.TimePlanned = r.Seconds
		}
	}
	return nil
}
