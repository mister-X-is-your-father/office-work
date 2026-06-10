// TaskStation フォーク用パッチ: 定期定義のエラー型
package models

import (
	"fmt"
	"net/http"

	"code.vikunja.io/api/pkg/web"
)

// ErrRecurrenceDoesNotExist は定期定義が存在しないエラー。
type ErrRecurrenceDoesNotExist struct {
	ID int64
}

func IsErrRecurrenceDoesNotExist(err error) bool {
	_, ok := err.(ErrRecurrenceDoesNotExist)
	return ok
}

func (err ErrRecurrenceDoesNotExist) Error() string {
	return fmt.Sprintf("Recurrence does not exist [ID: %d]", err.ID)
}

// 既存コード最大 15002（plans）のため 15003 を採番。
const ErrorCodeRecurrenceDoesNotExist = 15003

func (err ErrRecurrenceDoesNotExist) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: http.StatusNotFound,
		Code:     ErrorCodeRecurrenceDoesNotExist,
		Message:  "This recurrence does not exist.",
	}
}
