// Vikunja フォーク用パッチ: メンバー個人の休暇/PTO。capacity 計算で対象者の容量0にする。
package models

import (
	"time"

	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// MemberUnavailability は個人の非稼働期間（単日は start==end）。
type MemberUnavailability struct {
	ID        int64     `xorm:"bigint autoincr not null unique pk" json:"id" param:"unavailability"`
	UserID    int64     `xorm:"bigint index not null" json:"user_id" valid:"required"` // 対象者（#3）
	StartDate time.Time `xorm:"DATETIME not null" json:"start_date"`
	EndDate   time.Time `xorm:"DATETIME not null" json:"end_date"`
	Reason    string    `xorm:"text null" json:"reason"`

	CreatedBy int64     `xorm:"bigint index not null default 0" json:"-"` // 記録者
	Created   time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated   time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	DeletedAt time.Time `xorm:"deleted_at deleted" json:"-"`

	web.CRUDable `xorm:"-" json:"-"`
	web.Rights   `xorm:"-" json:"-"`
}

func (*MemberUnavailability) TableName() string { return "member_unavailability" }

func (m *MemberUnavailability) Create(s *xorm.Session, a web.Auth) (err error) {
	m.ID = 0
	m.CreatedBy = a.GetID()
	if m.EndDate.IsZero() {
		m.EndDate = m.StartDate
	}
	_, err = s.Insert(m)
	return
}

func (m *MemberUnavailability) ReadOne(s *xorm.Session, _ web.Auth) (err error) {
	exists, err := s.ID(m.ID).Get(m)
	if err != nil {
		return
	}
	if !exists {
		return ErrUnavailabilityDoesNotExist{ID: m.ID}
	}
	return
}

// ReadAll は全件（任意で受信側の UserID で絞る）。
func (m *MemberUnavailability) ReadAll(s *xorm.Session, _ web.Auth, _ string, page int, perPage int) (result interface{}, resultCount int, total int64, err error) {
	var us []*MemberUnavailability
	q := s.OrderBy("start_date asc")
	if m.UserID > 0 {
		q = q.Where("user_id = ?", m.UserID)
	}
	if perPage > 0 {
		q = q.Limit(perPage, (page-1)*perPage)
	}
	if err = q.Find(&us); err != nil {
		return nil, 0, 0, err
	}
	if m.UserID > 0 {
		total, err = s.Where("user_id = ?", m.UserID).Count(&MemberUnavailability{})
	} else {
		total, err = s.Count(&MemberUnavailability{})
	}
	return us, len(us), total, err
}

func (m *MemberUnavailability) Update(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(m.ID).Cols("user_id", "start_date", "end_date", "reason").Update(m)
	return
}

func (m *MemberUnavailability) Delete(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(m.ID).Delete(&MemberUnavailability{})
	return
}

func (m *MemberUnavailability) CanRead(_ *xorm.Session, a web.Auth) (bool, int, error) {
	return authedNotLinkShare(a), 0, nil
}
func (m *MemberUnavailability) CanCreate(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
func (m *MemberUnavailability) CanUpdate(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
func (m *MemberUnavailability) CanDelete(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
