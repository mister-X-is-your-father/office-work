// Vikunja フォーク用パッチ: 実績時間モデルの権限
// 配置先: <vikunja>/pkg/models/task_time_entry_permissions.go
// task_comment_permissions.go と同じ「親タスクへ委譲」パターン。
package models

import (
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// CanRead は親タスクの読み取り権限に委譲する。
func (te *TaskTimeEntry) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	t := Task{ID: te.TaskID}
	return t.CanRead(s, a)
}

// CanCreate は親タスクへの書き込み権限が要る。
func (te *TaskTimeEntry) CanCreate(s *xorm.Session, a web.Auth) (bool, error) {
	t := Task{ID: te.TaskID}
	return t.CanWrite(s, a)
}

// CanUpdate は「親タスクへの書き込み権限」かつ「自分の記録」のみ。
func (te *TaskTimeEntry) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	return te.canModify(s, a)
}

// CanDelete は CanUpdate と同条件。
func (te *TaskTimeEntry) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	return te.canModify(s, a)
}

func (te *TaskTimeEntry) canModify(s *xorm.Session, a web.Auth) (bool, error) {
	// 保存済みエントリから親タスクを引く（ID→TaskID 確定）
	saved := &TaskTimeEntry{}
	exists, err := s.ID(te.ID).Get(saved)
	if err != nil || !exists {
		return false, err
	}
	te.TaskID = saved.TaskID
	// #3 ADR-009: 親タスクに書ける人なら誰でも編集/削除可（記録者/対象者を問わない）。
	t := Task{ID: saved.TaskID}
	return t.CanWrite(s, a)
}
