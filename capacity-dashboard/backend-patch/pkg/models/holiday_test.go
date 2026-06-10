// TaskStation フォーク用パッチ: 祝日モデルのユニットテスト
package models

import (
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHoliday_CRUD(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("create/read/delete(soft)", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		h := &Holiday{Date: recDate("2026-06-15"), Name: "テスト祝日"}
		require.NoError(t, h.Create(s, u))
		require.NoError(t, s.Commit())
		assert.NotZero(t, h.ID)
		assert.Equal(t, int64(1), h.CreatedBy)

		res, count, _, err := (&Holiday{}).ReadAll(s, u, "", 0, -1)
		require.NoError(t, err)
		assert.Equal(t, 1, count)
		assert.Len(t, res.([]*Holiday), 1)

		require.NoError(t, h.Delete(s, u))
		require.NoError(t, s.Commit())
		db.AssertExists(t, "holidays", map[string]interface{}{"id": h.ID}, false) // soft: 行は残る
		err = (&Holiday{ID: h.ID}).ReadOne(s, u)
		require.Error(t, err)
		assert.True(t, IsErrHolidayDoesNotExist(err))
	})
}
