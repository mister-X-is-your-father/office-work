import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotTask } from "./tasksnapshot.js";
import { EMPTY_DATE } from "./capacity.js";

test("snapshotTask: スカラ＋連絡待ち＋担当/分類idの集合を取る", () => {
  const t = {
    id: 5, done: true, percent_done: 100, started_at: "2026-06-20T00:00:00Z",
    priority: 3, is_favorite: true, due_date: "2026-06-30T00:00:00Z",
    assignees: [{ id: 1 }, { id: 2 }],
    labels: [{ id: 10, title: "連絡待ち" }, { id: 11, title: "重要" }],
  };
  assert.deepEqual(snapshotTask(t), {
    id: 5, done: true, percent_done: 100, started_at: "2026-06-20T00:00:00Z",
    priority: 3, is_favorite: true, due_date: "2026-06-30T00:00:00Z",
    waiting: true, assignees: [1, 2], labels: [10, 11],
  });
});

test("snapshotTask: 欠落値の既定（空日付センチネル・false・空配列）", () => {
  assert.deepEqual(snapshotTask({ id: 7 }), {
    id: 7, done: false, percent_done: 0, started_at: null,
    priority: 0, is_favorite: false, due_date: EMPTY_DATE,
    waiting: false, assignees: [], labels: [],
  });
});

test("snapshotTask: 空日付センチネル(0001)は due_date を EMPTY_DATE に正規化", () => {
  const s = snapshotTask({ id: 8, due_date: "0001-01-01T00:00:00Z" });
  assert.equal(s.due_date, EMPTY_DATE);
});

test("snapshotTask: waiting ラベルが無ければ waiting=false", () => {
  assert.equal(snapshotTask({ id: 9, labels: [{ id: 1, title: "重要" }] }).waiting, false);
});
