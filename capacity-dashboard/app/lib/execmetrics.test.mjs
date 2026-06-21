import { test } from "node:test";
import assert from "node:assert/strict";
import { stepDigestion, taskEngagement, dailyExecSeries, stalledTasks } from "./execmetrics.js";

const TODAY = "2026-06-21";

test("stepDigestion: 今日以前が期日の手順の消化率（未来期日は母数外）", () => {
  const stepsByTask = {
    "1": [
      { due: "2026-06-21", done: true },   // 今日・完了
      { due: "2026-06-20", done: false },  // 過去・未完
      { due: "2026-06-30", done: false },  // 未来=母数外
    ],
    "2": [{ due: "2026-06-19", done: true }], // 過去・完了
  };
  const r = stepDigestion(stepsByTask, TODAY);
  assert.equal(r.total, 3); // 6/21, 6/20, 6/19（6/30は除外）
  assert.equal(r.done, 2);  // 6/21, 6/19
  assert.equal(r.pct, 67);  // 2/3
});

test("stepDigestion: 空は 0/0/0%", () => {
  assert.deepEqual(stepDigestion({}, TODAY), { total: 0, done: 0, pct: 0 });
});

test("taskEngagement: 今日対象(期日 or plan)の着手率＋未着手items", () => {
  const tasks = [
    { id: 1, title: "今日期日・着手済", done: false, due_date: TODAY + "T00:00:00Z", started_at: "2026-06-21T01:00:00Z" },
    { id: 2, title: "今日期日・未着手", done: false, due_date: TODAY + "T00:00:00Z" },
    { id: 3, title: "今日plan・進捗あり", done: false, percent_done: 30 },
    { id: 4, title: "対象外(別日期日)", done: false, due_date: "2026-06-25T00:00:00Z" },
    { id: 5, title: "完了済(対象外)", done: true, due_date: TODAY + "T00:00:00Z" },
  ];
  const plansByTask = new Map([[3, [{ plan_date: TODAY + "T00:00:00Z" }]]]);
  const r = taskEngagement(tasks, plansByTask, TODAY);
  assert.equal(r.target, 3);   // id1,2,3（4=別日, 5=完了 は除外）
  assert.equal(r.engaged, 2);  // id1(started_at), id3(percent>0)
  assert.equal(r.pct, 67);
  // 未着手対象 = id2
  assert.deepEqual(r.items.filter((x) => !x.engaged).map((x) => x.id), [2]);
});

test("dailyExecSeries: 日別の完了数・実働h・触れたタスク数", () => {
  const tasks = [
    { id: 1, done: true, done_at: "2026-06-20T05:00:00Z" },
    { id: 2, done: true, done_at: "2026-06-21T05:00:00Z" },
    { id: 3, done: false },
  ];
  const timeEntries = [
    { day: "2026-06-21", seconds: 3600, taskId: 1 },
    { day: "2026-06-21", seconds: 1800, taskId: 2 }, // 同日・別タスク
    { day: "2026-06-21", seconds: 1800, taskId: 1 }, // 同日・同タスク(touched は distinct)
    { day: "2026-06-19", seconds: 7200, taskId: 3 },
  ];
  const s = dailyExecSeries(tasks, timeEntries, TODAY, 3); // 6/19,6/20,6/21
  assert.deepEqual(s.map((d) => d.day), ["2026-06-19", "2026-06-20", "2026-06-21"]);
  const d21 = s.find((d) => d.day === "2026-06-21");
  assert.equal(d21.completed, 1);     // id2 完了
  assert.equal(d21.workedH, 2);       // 1h+0.5h+0.5h
  assert.equal(d21.touched, 2);       // task1,2（distinct）
  const d20 = s.find((d) => d.day === "2026-06-20");
  assert.equal(d20.completed, 1);     // id1 完了
  assert.equal(d20.workedH, 0);
  const d19 = s.find((d) => d.day === "2026-06-19");
  assert.equal(d19.workedH, 2);
  assert.equal(d19.touched, 1);
});

test("stalledTasks: N日以上動きの無い未完了の計画タスクを停滞日数降順で", () => {
  const tasks = [
    // 計画あり(期日)・作成は古いが最近 time entry あり → 動いている＝停滞でない
    { id: 1, title: "動いてる", done: false, due_date: "2026-06-30T00:00:00Z", created: "2026-06-01T00:00:00Z" },
    // 計画あり(見積り)・作成6/10・以後動き無し → 停滞11日
    { id: 2, title: "止まってる(見積)", done: false, time_estimate: 3600, created: "2026-06-10T00:00:00Z" },
    // 期日あり・期日超過・作成6/05・動き無し → 停滞16日・overdue
    { id: 3, title: "止まってる(期日超過)", done: false, due_date: "2026-06-18T00:00:00Z", created: "2026-06-05T00:00:00Z" },
    // 計画の意思なし(期日/開始/見積り/着手すべて無) → 古くても対象外
    { id: 4, title: "未整理backlog", done: false, created: "2026-06-01T00:00:00Z" },
    // 完了 → 対象外
    { id: 5, title: "完了", done: true, due_date: "2026-06-08T00:00:00Z", created: "2026-06-01T00:00:00Z" },
    // 進捗ログが最近 → 停滞でない（着手痕跡 percent>0 も committed）
    { id: 6, title: "最近進捗", done: false, percent_done: 30, created: "2026-06-01T00:00:00Z" },
  ];
  const timeEntries = [{ day: "2026-06-20", taskId: 1, seconds: 3600 }]; // id1 は昨日動いた
  const activityLog = [{ task_id: 6, at: "2026-06-19T05:00:00Z" }]; // id6 は2日前に進捗
  const r = stalledTasks(tasks, timeEntries, activityLog, TODAY, { thresholdDays: 7 });
  assert.deepEqual(r.map((x) => x.id), [3, 2]); // 停滞日数降順: id3(16日) > id2(11日)
  assert.equal(r[0].days, 16);
  assert.equal(r[0].overdue, true);
  assert.equal(r[1].days, 11);
  assert.equal(r[1].overdue, false);
  // id1(最近動いた)/id4(計画意思なし)/id5(完了)/id6(最近進捗) は含まれない
});
