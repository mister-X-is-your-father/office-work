// TaskStation フォーク用パッチ: チーム共通の祝日/非稼働日。capacity 計算で容量0にする。
package models

import (
	"time"

	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// Holiday はチーム共通の非稼働日。
type Holiday struct {
	ID   int64     `xorm:"bigint autoincr not null unique pk" json:"id" param:"holiday"`
	Date time.Time `xorm:"DATETIME index not null" json:"date"` // UTC 00:00:00Z 日次
	Name string    `xorm:"text not null" json:"name" valid:"required"`

	CreatedBy int64     `xorm:"bigint index not null default 0" json:"-"`
	Created   time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated   time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	DeletedAt time.Time `xorm:"deleted_at deleted" json:"-"`

	web.CRUDable `xorm:"-" json:"-"`
	web.Rights   `xorm:"-" json:"-"`
}

func (*Holiday) TableName() string { return "holidays" }

func (h *Holiday) Create(s *xorm.Session, a web.Auth) (err error) {
	h.ID = 0
	h.CreatedBy = a.GetID()
	_, err = s.Insert(h)
	return
}

func (h *Holiday) ReadOne(s *xorm.Session, _ web.Auth) (err error) {
	exists, err := s.ID(h.ID).Get(h)
	if err != nil {
		return
	}
	if !exists {
		return ErrHolidayDoesNotExist{ID: h.ID}
	}
	return
}

func (h *Holiday) ReadAll(s *xorm.Session, _ web.Auth, _ string, page int, perPage int) (result interface{}, resultCount int, total int64, err error) {
	var hs []*Holiday
	q := s.OrderBy("date asc")
	if perPage > 0 {
		q = q.Limit(perPage, (page-1)*perPage)
	}
	if err = q.Find(&hs); err != nil {
		return nil, 0, 0, err
	}
	total, err = s.Count(&Holiday{})
	return hs, len(hs), total, err
}

func (h *Holiday) Update(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(h.ID).Cols("date", "name").Update(h)
	return
}

func (h *Holiday) Delete(s *xorm.Session, _ web.Auth) (err error) {
	_, err = s.ID(h.ID).Delete(&Holiday{})
	return
}

func (h *Holiday) CanRead(_ *xorm.Session, a web.Auth) (bool, int, error) {
	return authedNotLinkShare(a), 0, nil
}
func (h *Holiday) CanCreate(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
func (h *Holiday) CanUpdate(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
func (h *Holiday) CanDelete(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
