// TaskStation フォーク用パッチ: 予定時間エラー型
package models

import (
	"fmt"
	"net/http"

	"code.vikunja.io/api/pkg/web"
)

type ErrTimePlanDoesNotExist struct {
	ID int64
}

func IsErrTimePlanDoesNotExist(err error) bool {
	_, ok := err.(ErrTimePlanDoesNotExist)
	return ok
}

func (err ErrTimePlanDoesNotExist) Error() string {
	return fmt.Sprintf("Time plan does not exist [ID: %d]", err.ID)
}

// 15001 は実績用に採番済み。予定は 15002。
const ErrorCodeTimePlanDoesNotExist = 15002

func (err ErrTimePlanDoesNotExist) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: http.StatusNotFound,
		Code:     ErrorCodeTimePlanDoesNotExist,
		Message:  "This time plan does not exist.",
	}
}
