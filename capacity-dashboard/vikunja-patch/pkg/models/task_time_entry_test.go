// Vikunja フォーク用パッチ: 実績時間モデルのユニットテスト（TDD）
// エントリは各テスト内で生成し、グローバルな task_time_entries フィクスチャは空に保つ
// （他テスト=全タスク比較の順序テスト等を汚さないため）。
package models

import (
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskTimeEntry_Create(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("normal", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		te := &TaskTimeEntry{TaskID: 1, Seconds: 1800, Note: "テスト"}
		err := te.Create(s, u)
		require.NoError(t, err)
		assert.NotZero(t, te.ID)
		assert.Equal(t, int64(1), te.UserID)
		assert.False(t, te.LoggedOn.IsZero(), "logged_on は未指定なら now が入る")
		require.NoError(t, s.Commit())

		db.AssertExists(t, "task_time_entries", map[string]interface{}{
			"id":      te.ID,
			"task_id": 1,
			"user_id": 1,
			"seconds": 1800,
		}, false)
	})
}

func TestTaskTimeEntry_ReadAll(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("returns entries for task", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		for _, sec := range []int64{7200, 5400, 3600} {
			require.NoError(t, (&TaskTimeEntry{TaskID: 1, Seconds: sec}).Create(s, u))
		}

		te := &TaskTimeEntry{TaskID: 1}
		result, count, total, err := te.ReadAll(s, u, "", 0, -1)
		require.NoError(t, err)
		entries := result.([]*TaskTimeEntry)
		assert.Equal(t, 3, count)
		assert.Equal(t, int64(3), total)
		var sum int64
		for _, e := range entries {
			sum += e.Seconds
			assert.NotNil(t, e.User, "記録者がattachされる")
		}
		assert.Equal(t, int64(16200), sum, "2h+1.5h+1h")
	})
}

func TestTaskTimeEntry_TimeSpentAggregation(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("addTimeSpentToTasks sums seconds into Task.TimeSpent", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		for _, sec := range []int64{7200, 5400, 3600} {
			require.NoError(t, (&TaskTimeEntry{TaskID: 1, Seconds: sec}).Create(s, u))
		}

		taskMap := map[int64]*Task{1: {ID: 1}, 2: {ID: 2}}
		require.NoError(t, addTimeSpentToTasks(s, []int64{1, 2}, taskMap))
		assert.Equal(t, int64(16200), taskMap[1].TimeSpent, "task1 = 4.5h")
		assert.Equal(t, int64(0), taskMap[2].TimeSpent, "実績なしは 0")
	})
}

func TestTaskTimeEntry_Delete(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("soft delete keeps row but hides from reads (#2)", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		te := &TaskTimeEntry{TaskID: 1, Seconds: 1200}
		require.NoError(t, te.Create(s, u))
		require.NoError(t, te.Delete(s, u))
		require.NoError(t, s.Commit())

		// 行は残る（監査痕跡）。xorm の deleted タグで Delete は deleted_at をセットする UPDATE になる。
		db.AssertExists(t, "task_time_entries", map[string]interface{}{"id": te.ID}, false)
		// が、struct クエリ（ReadOne=Get）からは除外され「存在しない」扱い。
		err := (&TaskTimeEntry{ID: te.ID}).ReadOne(s, u)
		require.Error(t, err)
		assert.True(t, IsErrTimeEntryDoesNotExist(err))
	})
	t.Run("soft-deleted entries are excluded from TimeSpent (#2)", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		keep := &TaskTimeEntry{TaskID: 1, Seconds: 3600}
		require.NoError(t, keep.Create(s, u))
		del := &TaskTimeEntry{TaskID: 1, Seconds: 1800}
		require.NoError(t, del.Create(s, u))
		require.NoError(t, del.Delete(s, u))
		require.NoError(t, s.Commit())

		taskMap := map[int64]*Task{1: {ID: 1}}
		require.NoError(t, addTimeSpentToTasks(s, []int64{1}, taskMap))
		assert.Equal(t, int64(3600), taskMap[1].TimeSpent, "論理削除分(1800)は集計から除外")
	})
}

func TestTask_TimeEstimate_Persisted(t *testing.T) {
	u := &user.User{ID: 1}
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()

	// 既存タスクをフルで読み、見積りだけ変えて更新（title 等を消さない）
	task, err := GetTaskByIDSimple(s, 1)
	require.NoError(t, err)
	task.TimeEstimate = 18000
	require.NoError(t, (&task).Update(s, u))
	require.NoError(t, s.Commit())

	db.AssertExists(t, "tasks", map[string]interface{}{
		"id":            1,
		"time_estimate": 18000,
	}, false)
	// title が消えていないことも確認（colsToUpdate の副作用回帰防止）
	reread, err := GetTaskByIDSimple(s, 1)
	require.NoError(t, err)
	assert.NotEmpty(t, reread.Title)
	assert.Equal(t, int64(18000), reread.TimeEstimate)
}

func TestTaskTimeEntry_Rights(t *testing.T) {
	owner := &user.User{ID: 1}
	other := &user.User{ID: 2}

	t.Run("owner can create on accessible task", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		can, err := (&TaskTimeEntry{TaskID: 1}).CanCreate(s, owner)
		require.NoError(t, err)
		assert.True(t, can)
	})
	t.Run("can read on accessible task", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		can, _, err := (&TaskTimeEntry{TaskID: 1}).CanRead(s, owner)
		require.NoError(t, err)
		assert.True(t, can)
	})
	t.Run("non-owner cannot delete others entry", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		te := &TaskTimeEntry{TaskID: 1, Seconds: 600}
		require.NoError(t, te.Create(s, owner)) // owned by user 1
		can, err := (&TaskTimeEntry{ID: te.ID}).CanDelete(s, other)
		require.NoError(t, err)
		assert.False(t, can)
	})
	t.Run("owner can delete own entry", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		te := &TaskTimeEntry{TaskID: 1, Seconds: 600}
		require.NoError(t, te.Create(s, owner))
		can, err := (&TaskTimeEntry{ID: te.ID}).CanDelete(s, owner)
		require.NoError(t, err)
		assert.True(t, can)
	})
}
