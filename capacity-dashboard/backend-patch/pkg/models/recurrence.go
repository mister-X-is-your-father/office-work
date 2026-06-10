// TaskStation フォーク用パッチ: 定期タスク/会議の定義（RRULE）。capacity-dashboard 用。
// occurrence は SPA(rrule.js) がウィンドウ展開する仮想インスタンス。サーバは RRULE 文字列を
// そのまま保持する dumb storage（Go で展開しない）。task_time_entry.go の作法を踏襲。
package models

import (
	"time"

	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// Recurrence は定期タスク/会議の定義。
type Recurrence struct {
	ID int64 `xorm:"bigint autoincr not null unique pk" json:"id" param:"recurrence"`
	// 表示名
	Title string `xorm:"text not null" json:"title" valid:"required"`
	// 種別（'task' | 'meeting'）。表示用のみ。負荷計算は共通（assignee 全員にフル）。
	Kind string `xorm:"varchar(16) not null default 'task'" json:"kind"`
	// RFC5545 の RRULE 文字列（例: FREQ=WEEKLY;BYDAY=MO）。サーバは解釈しない。
	// ※ GonicMapper だと RRule→r_rule になるため列名を明示。
	RRule string `xorm:"text not null 'rrule'" json:"rrule" valid:"required"`
	// RRULE のアンカー開始日（UTC 00:00:00Z の日次粒度で保存）。DTStart→d_t_start 回避で明示。
	DTStart time.Time `xorm:"DATETIME not null 'dtstart'" json:"dtstart"`
	// 各 occurrence の長さ（秒）
	DurationSeconds int64 `xorm:"bigint not null" json:"duration_seconds" valid:"required"`
	// 対象プロジェクト（任意・色/グルーピング用）
	ProjectID int64 `xorm:"bigint null" json:"project_id"`
	// 参加者（対象者）の user_id 集合。多担当=全員フル（ADR-010）。JSON列（4つ目の表を回避）。
	// AssigneeIDs→assignee_i_ds 回避で列名を明示。
	AssigneeIDs []int64 `xorm:"json not null 'assignee_ids'" json:"assignee_ids"`
	// メモ
	Note string `xorm:"text null" json:"note"`

	// 記録者（#3 ADR-009・auth から自動）
	CreatedBy int64 `xorm:"bigint index not null default 0" json:"-"`

	Created   time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated   time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	DeletedAt time.Time `xorm:"deleted_at deleted" json:"-"` // #2 soft delete

	web.CRUDable `xorm:"-" json:"-"`
	web.Rights   `xorm:"-" json:"-"`
}

// TableName は DB テーブル名。
func (*Recurrence) TableName() string { return "recurrences" }

// Create は定期定義を1件作る。
func (r *Recurrence) Create(s *xorm.Session, a web.Auth) (err error) {
	r.ID = 0
	r.CreatedBy = a.GetID()
	if r.Kind == "" {
		r.Kind = "task"
	}
	if r.AssigneeIDs == nil {
		r.AssigneeIDs = []int64{}
	}
	_, err = s.Insert(r)
	return
}

// ReadOne は単一の定期定義を取得する。
func (r *Recurrence) ReadOne(s *xorm.Session, _ web.Auth) (err error) {
	exists, err := s.ID(r.ID).Get(r)
	if err != nil {
		return
	}
	if !exists {
		return ErrRecurrenceDoesNotExist{ID: r.ID}
	}
	return
}

// ReadAll は全ての定期定義を返す（グローバル設定）。
func (r *Recurrence) ReadAll(s *xorm.Session, _ web.Auth, _ string, page int, perPage int) (result interface{}, resultCount int, total int64, err error) {
	var recs []*Recurrence
	q := s.OrderBy("dtstart asc")
	if perPage > 0 {
		q = q.Limit(perPage, (page-1)*perPage)
	}
	if err = q.Find(&recs); err != nil {
		return nil, 0, 0, err
	}
	total, err = s.Count(&Recurrence{})
	return recs, len(recs), total, err
}

// Update は編集可能フィールドを更新する。created_by は不変。
func (r *Recurrence) Update(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(r.ID).
		Cols("title", "kind", "rrule", "dtstart", "duration_seconds", "project_id", "assignee_ids", "note").
		Update(r)
	return
}

// Delete は定期定義を論理削除する（xorm が deleted_at をセット）。
func (r *Recurrence) Delete(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(r.ID).Delete(&Recurrence{})
	return
}
