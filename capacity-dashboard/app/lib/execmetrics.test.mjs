import { test } from "node:test";
import assert from "node:assert/strict";
import { stepDigestion, taskEngagement, dailyExecSeries } from "./execmetrics.js";

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
