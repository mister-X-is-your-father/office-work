import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyThroughput, projectTotals, labelTotals, overallStats, weekStartISO } from "./summary.js";

const iso = (d) => `${d}T09:00:00Z`;
const TODAY = "2026-06-13"; // 土

test("weekStartISO: その週の月曜", () => {
  assert.equal(weekStartISO("2026-06-13"), "2026-06-08"); // 土→月
  assert.equal(weekStartISO("2026-06-08"), "2026-06-08"); // 月→自身
  assert.equal(weekStartISO("2026-06-14"), "2026-06-08"); // 日→前週月
});

test("dailyThroughput: 追加/完了を日別に集計", () => {
  const tasks = [
    { created: iso("2026-06-12"), done: false },
    { created: iso("2026-06-13"), done: true, done_at: iso("2026-06-13") },
    { created: iso("2026-06-01"), done: true, done_at: iso("2026-06-12") }, // 作成は窓外、完了は窓内
  ];
  const out = dailyThroughput(tasks, TODAY, 14);
  assert.equal(out.length, 14);
  assert.equal(out[0].day, "2026-05-31");
  assert.equal(out[out.length - 1].day, TODAY);
  const d12 = out.find((x) => x.day === "2026-06-12");
  const d13 = out.find((x) => x.day === "2026-06-13");
  assert.deepEqual([d12.added, d12.done], [1, 1]);
  assert.deepEqual([d13.added, d13.done], [1, 1]);
});

test("projectTotals: PJ別 見積り/実績/件数/完了", () => {
  const tasks = [
    { project_id: 1, time_estimate: 3600, time_spent: 7200, done: true },
    { project_id: 1, time_estimate: 1800, time_spent: 0, done: false },
    { project_id: 2, time_estimate: 0, time_spent: 3600, done: false },
  ];
  const out = projectTotals(tasks).sort((a, b) => a.projectId - b.projectId);
  assert.deepEqual(out[0], { projectId: 1, estH: 1.5, spentH: 2, count: 2, done: 1 });
  assert.deepEqual(out[1], { projectId: 2, estH: 0, spentH: 1, count: 1, done: 0 });
});

test("labelTotals: 分類別件数（レビュー除外・多い順）", () => {
  const tasks = [
    { labels: [{ title: "開発" }, { title: "レビュー" }] },
    { labels: [{ title: "開発" }] },
    { labels: [{ title: "営業" }] },
  ];
  assert.deepEqual(labelTotals(tasks), [{ title: "開発", count: 2 }, { title: "営業", count: 1 }]);
});

test("overallStats: 完了/今週完了/期限切れ/フラグ/精度", () => {
  const tasks = [
    { time_estimate: 3600, time_spent: 7200, done: true, done_at: iso("2026-06-10") }, // 今週(月6/8〜)
    { time_estimate: 3600, time_spent: 0, done: true, done_at: iso("2026-06-01") },     // 先週
    { time_estimate: 0, done: false, due_date: iso("2026-06-01") },                      // 期限切れ
    { time_estimate: 0, done: false, is_favorite: true, priority: 4 },                   // フラグ＋重要
  ];
  const s = overallStats(tasks, TODAY);
  assert.equal(s.done, 2);
  assert.equal(s.doneThisWeek, 1);
  assert.equal(s.open, 2);
  assert.equal(s.overdue, 1);
  assert.equal(s.flagged, 1);
  assert.equal(s.important, 1);
  assert.equal(s.estH, 2);   // 1h+1h
  assert.equal(s.spentH, 2); // 2h
  assert.equal(s.accuracy, 1); // 2/2
});
