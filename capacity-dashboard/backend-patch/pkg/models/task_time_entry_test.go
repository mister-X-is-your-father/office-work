// TaskStation フォーク用パッチ: 実績時間モデルのユニットテスト（TDD）
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
	t.Run("attribution: created_by=recorder, user_id=target (#3)", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		// user1 が user2 のために代理記録（対象者=2）
		te := &TaskTimeEntry{TaskID: 1, Seconds: 1800, UserID: 2}
		require.NoError(t, te.Create(s, u)) // recorder = user1
		require.NoError(t, s.Commit())
		assert.Equal(t, int64(1), te.CreatedBy, "記録者=呼び出し元")
		assert.Equal(t, int64(2), te.UserID, "対象者=指定値")
		require.NotNil(t, te.User)
		assert.Equal(t, int64(2), te.User.ID)
		require.NotNil(t, te.CreatedByUser)
		assert.Equal(t, int64(1), te.CreatedByUser.ID)
		db.AssertExists(t, "task_time_entries", map[string]interface{}{"id": te.ID, "user_id": 2, "created_by": 1}, false)

		// 対象者未指定 → 記録者
		te2 := &TaskTimeEntry{TaskID: 1, Seconds: 600}
		require.NoError(t, te2.Create(s, u))
		assert.Equal(t, int64(1), te2.UserID, "未指定なら対象者=記録者")
		assert.Equal(t, int64(1), te2.CreatedBy)
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
	t.Run("user without task write cannot delete (#3: task-write gated)", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		te := &TaskTimeEntry{TaskID: 1, Seconds: 600}
		require.NoError(t, te.Create(s, owner))
		// user2 は project1 に書き込み権が無い → 削除不可
		can, err := (&TaskTimeEntry{ID: te.ID}).CanDelete(s, other)
		require.NoError(t, err)
		assert.False(t, can)
	})
	t.Run("task-write user can delete regardless of recorder/target (#3)", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		// 対象者=user2 の代理エントリ（記録者=user1）。旧コードは UserID(2)!=auth(1) で不可だった。
		te := &TaskTimeEntry{TaskID: 1, Seconds: 600, UserID: 2}
		require.NoError(t, te.Create(s, owner))
		can, err := (&TaskTimeEntry{ID: te.ID}).CanDelete(s, owner) // user1 は task write を持つ
		require.NoError(t, err)
		assert.True(t, can)
	})
}
