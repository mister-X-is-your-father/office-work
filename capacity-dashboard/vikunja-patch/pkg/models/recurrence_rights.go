// Vikunja フォーク用パッチ: 定期定義の権限（グローバル設定＝認証ユーザーCRUD可）。
// label_rights.go の「LinkSharing 以外は true」パターンに倣う。
package models

import (
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

func authedNotLinkShare(a web.Auth) bool {
	_, isLink := a.(*LinkSharing)
	return !isLink
}

func (r *Recurrence) CanRead(_ *xorm.Session, a web.Auth) (bool, int, error) {
	return authedNotLinkShare(a), 0, nil
}
func (r *Recurrence) CanCreate(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
func (r *Recurrence) CanUpdate(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
func (r *Recurrence) CanDelete(_ *xorm.Session, a web.Auth) (bool, error) {
	return authedNotLinkShare(a), nil
}
