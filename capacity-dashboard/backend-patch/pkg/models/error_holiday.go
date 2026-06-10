// TaskStation フォーク用パッチ: 祝日のエラー型
package models

import (
	"fmt"
	"net/http"

	"code.vikunja.io/api/pkg/web"
)

type ErrHolidayDoesNotExist struct {
	ID int64
}

func IsErrHolidayDoesNotExist(err error) bool {
	_, ok := err.(ErrHolidayDoesNotExist)
	return ok
}

func (err ErrHolidayDoesNotExist) Error() string {
	return fmt.Sprintf("Holiday does not exist [ID: %d]", err.ID)
}

const ErrorCodeHolidayDoesNotExist = 15004

func (err ErrHolidayDoesNotExist) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: http.StatusNotFound,
		Code:     ErrorCodeHolidayDoesNotExist,
		Message:  "This holiday does not exist.",
	}
}
