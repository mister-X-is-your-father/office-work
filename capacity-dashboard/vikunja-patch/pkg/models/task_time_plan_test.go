// Vikunja フォーク用パッチ: 予定時間モデルのユニットテスト（TDD）
package models

import (
	"testing"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func planDate(s string) time.Time {
	d, _ := time.Parse("2006-01-02", s)
	return d
}

func TestTaskTimePlan_Create(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("normal", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		tp := &TaskTimePlan{TaskID: 1, Seconds: 14400, PlanDate: planDate("2026-06-10"), Note: "午前API"}
		require.NoError(t, tp.Create(s, u))
		assert.NotZero(t, tp.ID)
		assert.Equal(t, int64(1), tp.UserID)
		require.NoError(t, s.Commit())
		db.AssertExists(t, "task_time_plans", map[string]interface{}{
			"id": tp.ID, "task_id": 1, "user_id": 1, "seconds": 14400,
		}, false)
	})
}

func TestTaskTimePlan_ReadAll_perDay(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("複数日の予定が日付順で取れる", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		require.NoError(t, (&TaskTimePlan{TaskID: 1, Seconds: 14400, PlanDate: planDate("2026-06-10")}).Create(s, u))
		require.NoError(t, (&TaskTimePlan{TaskID: 1, Seconds: 10800, PlanDate: planDate("2026-06-11")}).Create(s, u))

		res, count, total, err := (&TaskTimePlan{TaskID: 1}).ReadAll(s, u, "", 0, -1)
		require.NoError(t, err)
		plans := res.([]*TaskTimePlan)
		assert.Equal(t, 2, count)
		assert.Equal(t, int64(2), total)
		// 日付昇順
		assert.Equal(t, "2026-06-10", plans[0].PlanDate.Format("2006-01-02"))
		assert.Equal(t, int64(14400), plans[0].Seconds)
		assert.Equal(t, "2026-06-11", plans[1].PlanDate.Format("2006-01-02"))
	})
}

func TestTaskTimePlan_PlannedAggregation(t *testing.T) {
	u := &user.User{ID: 1}
	t.Run("addTimePlannedToTasks が SUM を Task.TimePlanned に入れる", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		for _, sec := range []int64{14400, 10800} { // 4h + 3h = 7h
			require.NoError(t, (&TaskTimePlan{TaskID: 1, Seconds: sec, PlanDate: planDate("2026-06-10")}).Create(s, u))
		}
		taskMap := map[int64]*Task{1: {ID: 1}, 2: {ID: 2}}
		require.NoError(t, addTimePlannedToTasks(s, []int64{1, 2}, taskMap))
		assert.Equal(t, int64(25200), taskMap[1].TimePlanned) // 7h
		assert.Equal(t, int64(0), taskMap[2].TimePlanned)
	})
}

func TestTaskTimePlan_Rights(t *testing.T) {
	owner := &user.User{ID: 1}
	other := &user.User{ID: 2}
	t.Run("owner create / non-owner cannot delete", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		can, err := (&TaskTimePlan{TaskID: 1}).CanCreate(s, owner)
		require.NoError(t, err)
		assert.True(t, can)

		tp := &TaskTimePlan{TaskID: 1, Seconds: 3600, PlanDate: planDate("2026-06-10")}
		require.NoError(t, tp.Create(s, owner))
		canDel, err := (&TaskTimePlan{ID: tp.ID}).CanDelete(s, other)
		require.NoError(t, err)
		assert.False(t, canDel)
		canDelOwn, err := (&TaskTimePlan{ID: tp.ID}).CanDelete(s, owner)
		require.NoError(t, err)
		assert.True(t, canDelOwn)
	})
}
