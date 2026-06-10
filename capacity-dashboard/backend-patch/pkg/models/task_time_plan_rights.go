// TaskStation フォーク用パッチ: 予定時間モデルの権限（親タスク委譲＋本人所有）
package models

import (
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

func (tp *TaskTimePlan) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	t := Task{ID: tp.TaskID}
	return t.CanRead(s, a)
}

func (tp *TaskTimePlan) CanCreate(s *xorm.Session, a web.Auth) (bool, error) {
	t := Task{ID: tp.TaskID}
	return t.CanWrite(s, a)
}

func (tp *TaskTimePlan) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	return tp.canModify(s, a)
}

func (tp *TaskTimePlan) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	return tp.canModify(s, a)
}

func (tp *TaskTimePlan) canModify(s *xorm.Session, a web.Auth) (bool, error) {
	saved := &TaskTimePlan{}
	exists, err := s.ID(tp.ID).Get(saved)
	if err != nil || !exists {
		return false, err
	}
	tp.TaskID = saved.TaskID
	// #3 ADR-009: 親タスクに書ける人なら誰でも編集/削除可（記録者/対象者を問わない）。
	t := Task{ID: saved.TaskID}
	return t.CanWrite(s, a)
}
