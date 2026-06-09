// Vikunja フォーク用パッチ: 実績時間エラー型
// 配置先: <vikunja>/pkg/models/error_time_entry.go
// （pkg/models/error.go に直接追記してもよいが、パッチ分離のため別ファイルにする）
package models

import (
	"fmt"
	"net/http"

	"code.vikunja.io/api/pkg/web"
)

// ErrTimeEntryDoesNotExist は実績エントリが存在しないエラー。
type ErrTimeEntryDoesNotExist struct {
	ID int64
}

// IsErrTimeEntryDoesNotExist は err が ErrTimeEntryDoesNotExist か判定する。
func IsErrTimeEntryDoesNotExist(err error) bool {
	_, ok := err.(ErrTimeEntryDoesNotExist)
	return ok
}

func (err ErrTimeEntryDoesNotExist) Error() string {
	return fmt.Sprintf("Time entry does not exist [ID: %d]", err.ID)
}

// ErrorCodeTimeEntryDoesNotExist は Vikunja のエラーコード規約に沿った識別子。
// 既存コードと衝突しない番号を割り当てること（error.go の最大値の次など）。
const ErrorCodeTimeEntryDoesNotExist = 6001

// HTTPError は HTTP レスポンス表現。
func (err ErrTimeEntryDoesNotExist) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: http.StatusNotFound,
		Code:     ErrorCodeTimeEntryDoesNotExist,
		Message:  "This time entry does not exist.",
	}
}
