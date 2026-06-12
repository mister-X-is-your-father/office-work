import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyEvents } from "./notify.js";

const DAY = "2026-06-12"; // 金曜
const ME = 7;

const baseTasks = [
  { id: 1, title: "資料作成", done: false, assignees: [{ id: ME }] },
  { id: 2, title: "期日タスク", done: false, due_date: DAY + "T00:00:00Z", assignees: [{ id: ME }] },
  { id: 3, title: "他人の期日", done: false, due_date: DAY + "T00:00:00Z", assignees: [{ id: 99 }] },
  { id: 4, title: "完了済み", done: true, due_date: DAY + "T00:00:00Z", assignees: [{ id: ME }] },
];
const plans = new Map([[1, [{ id: 10, user_id: ME, plan_date: DAY + "T00:00:00Z", start_minute: 600, seconds: 3600 }]]]);

test("plan(start_minute)と期日タスクが列挙され、時刻順", () => {
  const ev = notifyEvents({ tasks: baseTasks, plansByTask: plans, recurrences: [], meId: ME, calStart: 9 }, DAY);
  assert.deepEqual(ev.map((e) => e.key), ["due:2:" + DAY, "plan:10"]); // 9:00=540 < 10:00=600
  assert.equal(ev[1].minute, 600);
});

test("会議(dtstart時刻)は出席者のみ・00:00は時刻なし扱い", () => {
  const recs = [
    { id: 5, title: "朝会", kind: "meeting", rrule: "FREQ=DAILY;COUNT=1", dtstart: DAY + "T09:30:00Z", duration_seconds: 900, assignee_ids: [ME, 99] },
    { id: 6, title: "他人の会議", kind: "meeting", rrule: "FREQ=DAILY;COUNT=1", dtstart: DAY + "T10:00:00Z", duration_seconds: 900, assignee_ids: [99] },
    { id: 7, title: "時刻なし定例", kind: "recurring", rrule: "FREQ=DAILY;COUNT=1", dtstart: DAY + "T00:00:00Z", duration_seconds: 900, assignee_ids: [ME] },
  ];
  const ev = notifyEvents({ tasks: [], plansByTask: new Map(), recurrences: recs, meId: ME }, DAY);
  assert.deepEqual(ev.map((e) => e.key), [`rec:5:${DAY}`]);
  assert.equal(ev[0].minute, 570);
});

test("時刻つき予定を立て済みのタスクは期日通知から除外（二重通知防止）", () => {
  const tasks = [{ id: 1, title: "x", done: false, due_date: DAY + "T00:00:00Z", assignees: [{ id: ME }] }];
  const ev = notifyEvents({ tasks, plansByTask: plans, recurrences: [], meId: ME }, DAY);
  assert.deepEqual(ev.map((e) => e.key), ["plan:10"]);
});

test("meId なしは空", () => {
  assert.deepEqual(notifyEvents({ tasks: baseTasks, plansByTask: plans, recurrences: [], meId: null }, DAY), []);
});
