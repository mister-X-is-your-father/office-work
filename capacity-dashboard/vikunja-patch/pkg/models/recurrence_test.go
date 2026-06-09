// Vikunja フォーク用パッチ: 定期定義モデルのユニットテスト（TDD）
package models

import (
	"testing"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func recDate(s string) time.Time {
	d, _ := time.Parse("2006-01-02", s)
	return d
}

func TestRecurrence_CRUD(t *testing.T) {
	u := &user.User{ID: 1}

	t.Run("create sets created_by, roundtrips assignee_ids JSON", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()

		r := &Recurrence{
			Title: "毎週月の定例", Kind: "meeting", RRule: "FREQ=WEEKLY;BYDAY=MO",
			DTStart: recDate("2026-06-08"), DurationSeconds: 3600, AssigneeIDs: []int64{1, 2},
		}
		require.NoError(t, r.Create(s, u))
		require.NoError(t, s.Commit())
		assert.NotZero(t, r.ID)
		assert.Equal(t, int64(1), r.CreatedBy)

		got := &Recurrence{ID: r.ID}
		require.NoError(t, got.ReadOne(s, u))
		assert.Equal(t, "FREQ=WEEKLY;BYDAY=MO", got.RRule)
		assert.Equal(t, "meeting", got.Kind)
		assert.Equal(t, []int64{1, 2}, got.AssigneeIDs, "JSON列が往復する")
		assert.Equal(t, int64(3600), got.DurationSeconds)
	})

	t.Run("kind defaults to task", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		r := &Recurrence{Title: "t", RRule: "FREQ=DAILY", DTStart: recDate("2026-06-08"), DurationSeconds: 1800, AssigneeIDs: []int64{1}}
		require.NoError(t, r.Create(s, u))
		assert.Equal(t, "task", r.Kind)
	})

	t.Run("readAll returns created", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		for _, rr := range []string{"FREQ=WEEKLY;BYDAY=MO", "FREQ=MONTHLY;BYDAY=2TU"} {
			require.NoError(t, (&Recurrence{Title: "x", RRule: rr, DTStart: recDate("2026-06-08"), DurationSeconds: 3600, AssigneeIDs: []int64{1}}).Create(s, u))
		}
		res, count, total, err := (&Recurrence{}).ReadAll(s, u, "", 0, -1)
		require.NoError(t, err)
		assert.Equal(t, 2, count)
		assert.Equal(t, int64(2), total)
		assert.Len(t, res.([]*Recurrence), 2)
	})

	t.Run("update changes fields, not created_by", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		r := &Recurrence{Title: "old", RRule: "FREQ=DAILY", DTStart: recDate("2026-06-08"), DurationSeconds: 1800, AssigneeIDs: []int64{1}}
		require.NoError(t, r.Create(s, u))
		upd := &Recurrence{ID: r.ID, Title: "new", Kind: "task", RRule: "FREQ=WEEKLY;BYDAY=FR", DTStart: recDate("2026-06-08"), DurationSeconds: 7200, AssigneeIDs: []int64{2}}
		require.NoError(t, upd.Update(s, u))
		require.NoError(t, s.Commit())
		got := &Recurrence{ID: r.ID}
		require.NoError(t, got.ReadOne(s, u))
		assert.Equal(t, "new", got.Title)
		assert.Equal(t, []int64{2}, got.AssigneeIDs)
		assert.Equal(t, int64(1), got.CreatedBy, "created_by は不変")
	})

	t.Run("delete is soft: row remains, ReadOne errs", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		r := &Recurrence{Title: "del", RRule: "FREQ=DAILY", DTStart: recDate("2026-06-08"), DurationSeconds: 1800, AssigneeIDs: []int64{1}}
		require.NoError(t, r.Create(s, u))
		require.NoError(t, r.Delete(s, u))
		require.NoError(t, s.Commit())
		db.AssertExists(t, "recurrences", map[string]interface{}{"id": r.ID}, false)
		err := (&Recurrence{ID: r.ID}).ReadOne(s, u)
		require.Error(t, err)
		assert.True(t, IsErrRecurrenceDoesNotExist(err))
	})
}
