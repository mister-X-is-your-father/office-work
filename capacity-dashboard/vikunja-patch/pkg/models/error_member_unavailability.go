// Vikunja フォーク用パッチ: 個人休暇のエラー型
package models

import (
	"fmt"
	"net/http"

	"code.vikunja.io/api/pkg/web"
)

type ErrUnavailabilityDoesNotExist struct {
	ID int64
}

func IsErrUnavailabilityDoesNotExist(err error) bool {
	_, ok := err.(ErrUnavailabilityDoesNotExist)
	return ok
}

func (err ErrUnavailabilityDoesNotExist) Error() string {
	return fmt.Sprintf("Member unavailability does not exist [ID: %d]", err.ID)
}

const ErrorCodeUnavailabilityDoesNotExist = 15005

func (err ErrUnavailabilityDoesNotExist) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: http.StatusNotFound,
		Code:     ErrorCodeUnavailabilityDoesNotExist,
		Message:  "This member unavailability does not exist.",
	}
}
