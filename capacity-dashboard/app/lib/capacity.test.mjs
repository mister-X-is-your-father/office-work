import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toH, dateOnly, hasDate, isActiveOn, taskHoursOn,
  loadByMember, weekLoadByMember, estimateVsActual, triage,
} from "./capacity.js";

const TODAY = "2026-06-10";
const members = [
  { id: 1, username: "morita", name: "森田" },
  { id: 2, username: "tanaka", name: "田中" },
];
const due = (d) => `${d}T00:00:00Z`;

test("helpers", () => {
  assert.equal(toH(3600), 1);
  assert.equal(dateOnly("2026-06-10T09:00:00Z"), "2026-06-10");
  assert.equal(hasDate("0001-01-01T00:00:00Z"), false);
  assert.equal(hasDate("2026-06-10T00:00:00Z"), true);
});

test("isActiveOn", () => {
  assert.equal(isActiveOn({ due_date: due(TODAY) }, TODAY), true);
  assert.equal(isActiveOn({ due_date: due(TODAY), done: true }, TODAY), false);
  assert.equal(isActiveOn({ start_date: due("2026-06-09"), end_date: due("2026-06-11") }, TODAY), true);
  assert.equal(isActiveOn({ due_date: due("2026-06-12") }, TODAY), false);
});

test("taskHoursOn: 期間は日割り / due は全量", () => {
  // 8h を 2日(6/09-6/10) → 4h/日
  assert.equal(taskHoursOn({ time_estimate: 28800, start_date: due("2026-06-09"), end_date: due(TODAY) }, TODAY), 4);
  // due のみ → 全量
  assert.equal(taskHoursOn({ time_estimate: 14400, due_date: due(TODAY) }, TODAY), 4);
  assert.equal(taskHoursOn({ time_estimate: 14400, due_date: due("2026-06-12") }, TODAY), 0);
});

test("loadByMember: 空き/超過/満", () => {
  const tasks = [
    { id: 1, title: "A", assignees: [{ id: 1 }], time_estimate: 14400, due_date: due(TODAY) },          // 森田 4h
    { id: 2, title: "B", assignees: [{ id: 1 }], time_estimate: 28800, start_date: due("2026-06-09"), end_date: due(TODAY) }, // 森田 +4h
    { id: 3, title: "C", assignees: [{ id: 2 }], time_estimate: 7200, due_date: due(TODAY) },           // 田中 2h
    { id: 4, title: "done", assignees: [{ id: 2 }], time_estimate: 36000, due_date: due(TODAY), done: true }, // 無視
  ];
  const rows = loadByMember(tasks, members, TODAY, 8);
  const morita = rows.find((r) => r.id === 1);
  const tanaka = rows.find((r) => r.id === 2);
  assert.equal(morita.assignedH, 8);
  assert.equal(morita.status, "full");
  assert.equal(morita.freeH, 0);
  assert.equal(tanaka.assignedH, 2);
  assert.equal(tanaka.freeH, 6);
  assert.equal(tanaka.status, "free");
});

test("loadByMember: 超過", () => {
  const tasks = [{ id: 1, title: "big", assignees: [{ id: 1 }], time_estimate: 36000, due_date: due(TODAY) }]; // 10h
  const m = loadByMember(tasks, members, TODAY, 8).find((r) => r.id === 1);
  assert.equal(m.assignedH, 10);
  assert.equal(m.overH, 2);
  assert.equal(m.status, "over");
});

test("estimateVsActual", () => {
  const tasks = [
    { id: 1, title: "X", time_estimate: 14400, time_spent: 21600 }, // 見積4h 実績6h → over
    { id: 2, title: "Y", time_estimate: 10800, time_spent: 10800 }, // 3h/3h exact
    { id: 3, title: "Z", time_estimate: 0, time_spent: 0 },         // 除外
  ];
  const r = estimateVsActual(tasks);
  assert.equal(r.rows.length, 2);
  assert.equal(r.totEst, 7);
  assert.equal(r.totAct, 9);
  assert.equal(r.rows.find((x) => x.id === 1).status, "over");
  assert.equal(r.rows.find((x) => x.id === 2).status, "exact");
});

test("triage 分類", () => {
  const tasks = [
    { id: 1, title: "本番障害", priority: 5, due_date: due(TODAY) },        // 締切今日＋高 → must
    { id: 2, title: "DB", priority: 3, due_date: due("2026-06-11") },        // 明日 → should
    { id: 3, title: "doc", priority: 1 },                                    // 締切無し低 → movable
    { id: 4, title: "done", priority: 5, due_date: due(TODAY), done: true }, // 除外
  ];
  const r = triage(tasks, TODAY);
  assert.equal(r.length, 3);
  assert.equal(r.find((x) => x.id === 1).cls, "must");
  assert.equal(r.find((x) => x.id === 2).cls, "should");
  assert.equal(r.find((x) => x.id === 3).cls, "movable");
});

test("weekLoadByMember", () => {
  const tasks = [{ id: 1, title: "A", assignees: [{ id: 1 }], time_estimate: 14400, due_date: due("2026-06-11") }];
  const week = ["2026-06-10", "2026-06-11", "2026-06-12"];
  const rows = weekLoadByMember(tasks, members, week, 8);
  const m = rows.find((r) => r.id === 1);
  assert.equal(m.days.find((d) => d.day === "2026-06-11").h, 4);
  assert.equal(m.weekH, 4);
});
