import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toH, dateOnly, hasDate, isActiveOn, taskHoursOn,
  loadByMember, weekLoadByMember, estimateVsActual, triage, sumByMemberDay,
  shiftISO, taskRanges, dependencyEdges, dayScale, toMemberDayEntries,
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

test("sumByMemberDay: 予定/実績の人別日別集計", () => {
  const r = sumByMemberDay([
    { memberId: 1, day: "2026-06-10", h: 4 },
    { memberId: 1, day: "2026-06-10", h: 1 },
    { memberId: 1, day: "2026-06-11", h: 3 },
    { memberId: 2, day: "2026-06-10", h: 2 },
  ]);
  assert.equal(r[1]["2026-06-10"], 5);
  assert.equal(r[1]["2026-06-11"], 3);
  assert.equal(r[2]["2026-06-10"], 2);
});

test("weekLoadByMember", () => {
  const tasks = [{ id: 1, title: "A", assignees: [{ id: 1 }], time_estimate: 14400, due_date: due("2026-06-11") }];
  const week = ["2026-06-10", "2026-06-11", "2026-06-12"];
  const rows = weekLoadByMember(tasks, members, week, 8);
  const m = rows.find((r) => r.id === 1);
  assert.equal(m.days.find((d) => d.day === "2026-06-11").h, 4);
  assert.equal(m.weekH, 4);
});

// ── ガント（予実ガント） ──

const plan = (d, sec) => ({ plan_date: due(d), seconds: sec });
const time = (d, sec) => ({ logged_on: `${d}T09:00:00Z`, seconds: sec });

test("taskRanges: plans優先", () => {
  const r = taskRanges(
    { time_estimate: 28800, time_spent: 36000, percent_done: 60, due_date: due("2026-06-12") },
    [plan("2026-06-10", 7200), plan("2026-06-12", 14400)],
    [time("2026-06-11", 36000)]
  );
  assert.deepEqual(r.planned, { start: "2026-06-10", end: "2026-06-12", h: 6, source: "plans" });
  assert.deepEqual(r.actual, { start: "2026-06-11", end: "2026-06-11", h: 10 });
  assert.equal(r.estH, 8); assert.equal(r.spentH, 10);
  assert.equal(r.percent, 60); assert.equal(r.over, true);
});

test("taskRanges: plans無→start/end→due点→null", () => {
  const dates = taskRanges({ time_estimate: 14400, start_date: due("2026-06-09"), end_date: due("2026-06-11") }, [], []);
  assert.deepEqual(dates.planned, { start: "2026-06-09", end: "2026-06-11", h: 4, source: "dates" });
  const duep = taskRanges({ time_estimate: 14400, due_date: due("2026-06-10") }, [], []);
  assert.deepEqual(duep.planned, { start: "2026-06-10", end: "2026-06-10", h: 4, source: "due" });
  const none = taskRanges({ time_estimate: 14400 }, [], []);
  assert.equal(none.planned.source, null);
  assert.equal(none.planned.start, null);
});

test("taskRanges: times範囲とover/percentエッジ", () => {
  const noTimes = taskRanges({ time_estimate: 14400, due_date: due("2026-06-10") }, [], []);
  assert.deepEqual(noTimes.actual, { start: null, end: null, h: 0 });
  // est=0 は over 誤検知しない
  const est0 = taskRanges({ time_estimate: 0, time_spent: 21600, due_date: due("2026-06-10") }, [], []);
  assert.equal(est0.over, false);
  // percent 未定義は 0
  assert.equal(noTimes.percent, 0);
});

test("dependencyEdges: precedes/follows正規化と重複除去", () => {
  // Vikunja は precedes 作成時に逆 follows も自動付与 → 同一辺に畳む
  const tasks = [
    { id: 3, related_tasks: { precedes: [{ id: 4 }] } },
    { id: 4, related_tasks: { follows: [{ id: 3 }], precedes: [{ id: 1 }] } },
    { id: 1, related_tasks: { follows: [{ id: 4 }] } },
  ];
  const e = dependencyEdges(tasks);
  assert.equal(e.length, 2);
  assert.ok(e.some((x) => x.from === 3 && x.to === 4));
  assert.ok(e.some((x) => x.from === 4 && x.to === 1));
});

test("dependencyEdges: 空/無視kind/自己参照/片端欠落", () => {
  assert.deepEqual(dependencyEdges([{ id: 1, related_tasks: {} }, { id: 2, related_tasks: null }]), []);
  assert.deepEqual(dependencyEdges([{ id: 1, related_tasks: { subtask: [{ id: 2 }], related: [{ id: 2 }] } }, { id: 2 }]), []);
  assert.deepEqual(dependencyEdges([{ id: 1, related_tasks: { precedes: [{ id: 1 }] } }]), []); // 自己参照
  assert.deepEqual(dependencyEdges([{ id: 1, related_tasks: { precedes: [{ id: 99 }] } }]), []); // 片端欠落
});

test("dayScale: axis/range/clip/indexOf", () => {
  const s = dayScale("2026-06-01", 21);
  assert.equal(s.axis.length, 21);
  assert.equal(s.axis[0].iso, "2026-06-01");
  assert.equal(s.axis[20].iso, "2026-06-21");
  assert.equal(s.axis[5].weekend, true); // 2026-06-06 は土曜
  assert.equal(s.axis[9].isToday("2026-06-10"), true);
  assert.equal(s.indexOf("2026-06-10"), 9);
  assert.deepEqual(s.range("2026-06-10", "2026-06-12"), { fromIdx: 9, toIdx: 11, span: 3, clippedLeft: false, clippedRight: false });
  assert.equal(s.range("2026-06-10", "2026-06-10").span, 1); // 単日
  const cl = s.range("2026-05-25", "2026-06-03");
  assert.equal(cl.fromIdx, 0); assert.equal(cl.clippedLeft, true);
  const cr = s.range("2026-06-19", "2026-06-30");
  assert.equal(cr.toIdx, 20); assert.equal(cr.clippedRight, true);
  assert.equal(s.intersects("2026-05-01", "2026-05-10"), false); // 窓外
  assert.equal(s.intersects("2026-05-25", "2026-06-03"), true);  // 一部交差
});

test("shiftISO", () => {
  assert.equal(shiftISO("2026-06-09", -7), "2026-06-02");
  assert.equal(shiftISO("2026-06-30", 1), "2026-07-01");
});

test("toMemberDayEntries: 按分とエッジ", () => {
  const plan2 = toMemberDayEntries([[{ assignees: [{ id: 1 }, { id: 2 }] }, [plan("2026-06-10", 14400)]]], "plan");
  assert.equal(plan2.length, 2);
  assert.deepEqual(plan2[0], { memberId: 1, day: "2026-06-10", h: 2 });
  assert.deepEqual(plan2[1], { memberId: 2, day: "2026-06-10", h: 2 });
  // time
  const t = toMemberDayEntries([[{ assignees: [{ id: 3 }] }, [time("2026-06-11", 3600)]]], "time");
  assert.deepEqual(t, [{ memberId: 3, day: "2026-06-11", h: 1 }]);
  // assignees空 → 0行
  assert.deepEqual(toMemberDayEntries([[{ assignees: [] }, [plan("2026-06-10", 3600)]]], "plan"), []);
  // sumByMemberDay と合成
  const m = sumByMemberDay(toMemberDayEntries([[{ assignees: [{ id: 1 }] }, [plan("2026-06-10", 3600), plan("2026-06-10", 3600)]]], "plan"));
  assert.equal(m[1]["2026-06-10"], 2);
});
