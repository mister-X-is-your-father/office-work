// Vikunja フォーク用パッチ: 個人休暇モデルのユニットテスト
package models

import (
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMemberUnavailability_CRUD(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("create defaults end=start, soft delete", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		// EndDate 未指定 → start にそろう
		m := &MemberUnavailability{UserID: 2, StartDate: recDate("2026-06-20"), Reason: "有給"}
		require.NoError(t, m.Create(s, u))
		require.NoError(t, s.Commit())
		assert.Equal(t, int64(1), m.CreatedBy, "記録者=呼び出し元")
		assert.Equal(t, m.StartDate, m.EndDate)

		got := &MemberUnavailability{ID: m.ID}
		require.NoError(t, got.ReadOne(s, u))
		assert.Equal(t, int64(2), got.UserID, "対象者")

		require.NoError(t, m.Delete(s, u))
		require.NoError(t, s.Commit())
		db.AssertExists(t, "member_unavailability", map[string]interface{}{"id": m.ID}, false)
		err := (&MemberUnavailability{ID: m.ID}).ReadOne(s, u)
		require.Error(t, err)
		assert.True(t, IsErrUnavailabilityDoesNotExist(err))
	})
	t.Run("readAll filters by user_id when set", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		require.NoError(t, (&MemberUnavailability{UserID: 2, StartDate: recDate("2026-06-20"), EndDate: recDate("2026-06-21")}).Create(s, u))
		require.NoError(t, (&MemberUnavailability{UserID: 3, StartDate: recDate("2026-06-22"), EndDate: recDate("2026-06-22")}).Create(s, u))
		// 受信側 UserID=2 で絞る
		res, count, total, err := (&MemberUnavailability{UserID: 2}).ReadAll(s, u, "", 0, -1)
		require.NoError(t, err)
		assert.Equal(t, 1, count)
		assert.Equal(t, int64(1), total)
		assert.Equal(t, int64(2), res.([]*MemberUnavailability)[0].UserID)
		// 全件
		_, allCount, _, err := (&MemberUnavailability{}).ReadAll(s, u, "", 0, -1)
		require.NoError(t, err)
		assert.Equal(t, 2, allCount)
	})
}
