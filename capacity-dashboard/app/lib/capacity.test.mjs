import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toH, dateOnly, hasDate, isActiveOn, taskHoursOn, isBusinessDay, businessDays,
  loadByMember, weekLoadByMember, estimateVsActual, triage, sumByMemberDay,
  shiftISO, taskRanges, dependencyEdges, dayScale, toMemberDayEntries, taskPlannedHoursByMemberOn,
  buildTaskTree, depLayers, applyBarDrag, committedHoursByDayInRange,
} from "./capacity.js";

test("committedHoursByDayInRange: plans を日別に集計（範囲外・除外・done を弾く）", () => {
  const tasks = [
    { id: 10, title: "A", done: false, assignees: [{ id: 1 }], time_planned: 7200 },
    { id: 11, title: "B(除外対象)", done: false, assignees: [{ id: 1 }], time_planned: 3600 },
    { id: 12, title: "C(完了)", done: true, assignees: [{ id: 1 }], time_planned: 3600 },
  ];
  const plansByTask = new Map([
    [10, [{ plan_date: "2026-06-10", seconds: 7200, user_id: 1 }, // 2h 当日
          { plan_date: "2026-06-12", seconds: 3600, user_id: 1 }, // 1h 範囲内
          { plan_date: "2026-06-20", seconds: 3600, user_id: 1 }]], // 範囲外（無視）
    [11, [{ plan_date: "2026-06-10", seconds: 3600, user_id: 1 }]], // excludeTaskId で無視
    [12, [{ plan_date: "2026-06-10", seconds: 3600, user_id: 1 }]], // done で無視
  ]);
  const m = committedHoursByDayInRange(tasks, plansByTask, 1, "2026-06-10", "2026-06-12", { excludeTaskId: 11 });
  assert.equal(m.get("2026-06-10"), 2); // A のみ（B除外・C完了）
  assert.equal(m.get("2026-06-12"), 1);
  assert.equal(m.has("2026-06-20"), false); // 範囲外
  assert.equal(m.get("2026-06-11"), undefined); // 予定なし日は欠落
});

test("committedHoursByDayInRange: plans 無しは見積り営業日割り、他メンバーは拾わない", () => {
  // 見積り 8h を 6/11(木)-6/12(金) の2営業日に割る = 各日4h。担当 id=2。
  const tasks = [{ id: 20, title: "D", done: false, assignees: [{ id: 2 }],
                   time_estimate: 8 * 3600, start_date: "2026-06-11T00:00:00Z", end_date: "2026-06-12T00:00:00Z" }];
  const m2 = committedHoursByDayInRange(tasks, null, 2, "2026-06-10", "2026-06-15");
  assert.equal(m2.get("2026-06-11"), 4);
  assert.equal(m2.get("2026-06-12"), 4);
  const m1 = committedHoursByDayInRange(tasks, null, 1, "2026-06-10", "2026-06-15"); // 別メンバー
  assert.equal(m1.size, 0);
});

test("committedHoursByDayInRange: 不正範囲・memberId null は空 Map", () => {
  const tasks = [{ id: 30, done: false, assignees: [{ id: 1 }], time_planned: 3600 }];
  assert.equal(committedHoursByDayInRange(tasks, null, 1, "2026-06-12", "2026-06-10").size, 0); // from>to
  assert.equal(committedHoursByDayInRange(tasks, null, null, "2026-06-10", "2026-06-12").size, 0);
});

test("depLayers: 段組み＋クリティカルパス(最長鎖)", () => {
  // 1→2→4, 1→3, 3→4  : 最長鎖は 1→2→4 もしくは 1→3→4(同長3)
  const ids = [1, 2, 3, 4];
  const edges = [{ from: 1, to: 2 }, { from: 2, to: 4 }, { from: 1, to: 3 }, { from: 3, to: 4 }];
  const { level, critical } = depLayers(ids, edges);
  assert.equal(level.get(1), 0);
  assert.equal(level.get(4), 2); // 1→2→4 = level2
  assert.equal(critical.has(1), true);
  assert.equal(critical.has(4), true);
  assert.equal(critical.size, 3); // 3ノードの鎖
});

test("buildTaskTree: subtask 親子フォレスト", () => {
  const tasks = [
    { id: 1, title: "Epic", related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } },
    { id: 2, title: "子A", related_tasks: { subtask: [{ id: 4 }] } },
    { id: 3, title: "子B" },
    { id: 4, title: "孫" },
    { id: 5, title: "単独" },
  ];
  const forest = buildTaskTree(tasks);
  assert.deepEqual(forest.map((n) => n.task.id), [1, 5]); // ルート=Epicと単独
  const epic = forest[0];
  assert.deepEqual(epic.children.map((c) => c.task.id), [2, 3]);
  assert.deepEqual(epic.children[0].children.map((c) => c.task.id), [4]); // 子A→孫
});

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

test("taskHoursOn: 期間は営業日割り / due は全量", () => {
  // 8h を 2営業日(6/09火-6/10水) → 4h/日
  assert.equal(taskHoursOn({ time_estimate: 28800, start_date: due("2026-06-09"), end_date: due(TODAY) }, TODAY), 4);
  // due のみ → 全量
  assert.equal(taskHoursOn({ time_estimate: 14400, due_date: due(TODAY) }, TODAY), 4);
  assert.equal(taskHoursOn({ time_estimate: 14400, due_date: due("2026-06-12") }, TODAY), 0);
});

test("taskHoursOn: 週末をまたぐ期間は営業日のみで等分（週末に負荷を載せない）", () => {
  // 6/12(金)〜6/15(月): 暦4日だが営業日は金・月の2日 → 8h/2 = 4h/営業日
  const t = { time_estimate: 28800, start_date: due("2026-06-12"), end_date: due("2026-06-15") };
  assert.equal(taskHoursOn(t, "2026-06-12"), 4); // 金
  assert.equal(taskHoursOn(t, "2026-06-13"), 0); // 土=0
  assert.equal(taskHoursOn(t, "2026-06-14"), 0); // 日=0
  assert.equal(taskHoursOn(t, "2026-06-15"), 4); // 月
});

test("taskHoursOn: holidays を渡すと祝日も除外して等分", () => {
  // 6/10(水)〜6/12(金) 営業3日だが 6/11 を祝日にすると 2日 → 6h/2=3h
  const holidays = new Set(["2026-06-11"]);
  const t = { time_estimate: 21600, start_date: due("2026-06-10"), end_date: due("2026-06-12") };
  assert.equal(taskHoursOn(t, "2026-06-10", { holidays }), 3);
  assert.equal(taskHoursOn(t, "2026-06-11", { holidays }), 0); // 祝日=0
  assert.equal(taskHoursOn(t, "2026-06-12", { holidays }), 3);
});

test("applyBarDrag: move は両端を delta 日ずらす", () => {
  const r = applyBarDrag({ start: "2026-06-09", end: "2026-06-11", source: "dates" }, 3, "move");
  assert.deepEqual(r, { start: "2026-06-12", end: "2026-06-14" });
  // 負方向
  assert.deepEqual(applyBarDrag({ start: "2026-06-09", end: "2026-06-11", source: "dates" }, -2, "move"),
    { start: "2026-06-07", end: "2026-06-09" });
});

test("applyBarDrag: due は move で1日点ごと移動", () => {
  // due は start=end（1日点）として渡す
  assert.deepEqual(applyBarDrag({ start: "2026-06-10", end: "2026-06-10", source: "due" }, 5, "move"),
    { start: "2026-06-15", end: "2026-06-15" });
});

test("applyBarDrag: start/end の伸縮と最小1日クランプ", () => {
  // 左端を後ろへ → 開始日だけ変わる
  assert.deepEqual(applyBarDrag({ start: "2026-06-09", end: "2026-06-15", source: "dates" }, 2, "start"),
    { start: "2026-06-11", end: "2026-06-15" });
  // 右端を前へ → 終了日だけ変わる
  assert.deepEqual(applyBarDrag({ start: "2026-06-09", end: "2026-06-15", source: "dates" }, -3, "end"),
    { start: "2026-06-09", end: "2026-06-12" });
  // 左端を終了日より後ろへ動かしても end でクランプ（最小1日）
  assert.deepEqual(applyBarDrag({ start: "2026-06-09", end: "2026-06-11", source: "dates" }, 10, "start"),
    { start: "2026-06-11", end: "2026-06-11" });
  // 右端を開始日より前へ動かしても start でクランプ
  assert.deepEqual(applyBarDrag({ start: "2026-06-09", end: "2026-06-11", source: "dates" }, -10, "end"),
    { start: "2026-06-09", end: "2026-06-09" });
});

test("loadByMember: capacityFor で週末は容量0='off'、負荷ありは'over'", () => {
  const SAT = "2026-06-13";
  const capacityFor = (m, day) => isBusinessDay(day) ? 8 : 0;
  // 週末に due のタスク（due は全量載る）→ 容量0なので over
  const tasks = [{ id: 1, title: "x", assignees: [{ id: 1 }], time_estimate: 7200, due_date: due(SAT) }];
  const rows = loadByMember(tasks, members, SAT, 8, null, { capacityFor });
  assert.equal(rows.find((r) => r.id === 1).status, "over");
  assert.equal(rows.find((r) => r.id === 2).status, "off"); // 負荷なし・容量0
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
  // TaskStation は precedes 作成時に逆 follows も自動付与 → 同一辺に畳む
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

test("toMemberDayEntries: 多担当=全員フル（#4・按分しない）とエッジ", () => {
  const plan2 = toMemberDayEntries([[{ assignees: [{ id: 1 }, { id: 2 }] }, [plan("2026-06-10", 14400)]]], "plan");
  assert.equal(plan2.length, 2);
  assert.deepEqual(plan2[0], { memberId: 1, day: "2026-06-10", h: 4 }); // 4h を各担当にフル
  assert.deepEqual(plan2[1], { memberId: 2, day: "2026-06-10", h: 4 });
  // time
  const t = toMemberDayEntries([[{ assignees: [{ id: 3 }] }, [time("2026-06-11", 3600)]]], "time");
  assert.deepEqual(t, [{ memberId: 3, day: "2026-06-11", h: 1 }]);
  // assignees空 & user_idなし → 0行
  assert.deepEqual(toMemberDayEntries([[{ assignees: [] }, [plan("2026-06-10", 3600)]]], "plan"), []);
  // sumByMemberDay と合成
  const m = sumByMemberDay(toMemberDayEntries([[{ assignees: [{ id: 1 }] }, [plan("2026-06-10", 3600), plan("2026-06-10", 3600)]]], "plan"));
  assert.equal(m[1]["2026-06-10"], 2);
});

test("toMemberDayEntries: user_id 優先（#3 帰属）", () => {
  const withUid = (d, sec, uid) => ({ plan_date: due(d), seconds: sec, user_id: uid });
  // uid が assignee に含まれる → 対象者に全量（按分しない）
  const a = toMemberDayEntries([[{ assignees: [{ id: 1 }, { id: 2 }] }, [withUid("2026-06-10", 14400, 2)]]], "plan");
  assert.deepEqual(a, [{ memberId: 2, day: "2026-06-10", h: 4 }]);
  // uid が非assignee（代理の旧データ）→ assignee へフル（#4: 按分しない）
  const b = toMemberDayEntries([[{ assignees: [{ id: 1 }, { id: 2 }] }, [withUid("2026-06-10", 14400, 99)]]], "plan");
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { memberId: 1, day: "2026-06-10", h: 4 });
  // assignee 無 & uid あり → uid に全量
  const c = toMemberDayEntries([[{ assignees: [] }, [withUid("2026-06-10", 3600, 5)]]], "plan");
  assert.deepEqual(c, [{ memberId: 5, day: "2026-06-10", h: 1 }]);
});

// ── #4 負荷計算の単一真実（plans 優先・見積りフォールバック・全員フル） ──

test("taskPlannedHoursByMemberOn: plans優先/見積りフォールバック/done/多担当フル", () => {
  const task = { time_estimate: 28800, start_date: due("2026-06-09"), end_date: due("2026-06-11"), assignees: [{ id: 1 }, { id: 2 }] };
  // plans 当日あり → plan 値（各担当にフル）。見積りは無視。
  const r1 = taskPlannedHoursByMemberOn(task, "2026-06-10", [plan("2026-06-10", 7200), plan("2026-06-11", 3600)]);
  assert.equal(r1.get(1), 2); assert.equal(r1.get(2), 2); // 7200=2h を各担当にフル
  // plans あるが当日に無い → 0（見積りにフォールバックしない）
  const r2 = taskPlannedHoursByMemberOn(task, "2026-06-10", [plan("2026-06-11", 3600)]);
  assert.equal(r2.size, 0);
  // plans 無し → 見積り日割り（8h/3日=2.67h）を各担当にフル
  const r3 = taskPlannedHoursByMemberOn(task, "2026-06-10", null);
  assert.ok(Math.abs(r3.get(1) - 8 / 3) < 1e-9); assert.ok(Math.abs(r3.get(2) - 8 / 3) < 1e-9);
  // done → 負荷ゼロ
  assert.equal(taskPlannedHoursByMemberOn({ ...task, done: true }, "2026-06-10", null).size, 0);
  // uid∈assignee の plan → 対象者1人にフル
  const r4 = taskPlannedHoursByMemberOn(task, "2026-06-10", [{ plan_date: due("2026-06-10"), seconds: 3600, user_id: 2 }]);
  assert.equal(r4.get(2), 1); assert.equal(r4.has(1), false);
});

test("loadByMember: plansByTask で plans優先・見積り混在（後方互換）", () => {
  const tasks = [
    { id: 1, title: "plan task", assignees: [{ id: 1 }], time_estimate: 36000, due_date: due(TODAY) }, // 見積り10hだが plans 優先
    { id: 2, title: "est task", assignees: [{ id: 2 }], time_estimate: 7200, due_date: due(TODAY) },    // plans 無し→見積り2h
  ];
  const plansByTask = new Map([[1, [plan(TODAY, 5400)]]]); // task1 当日 1.5h
  const rows = loadByMember(tasks, members, TODAY, 8, plansByTask);
  assert.equal(rows.find((r) => r.id === 1).assignedH, 1.5); // plans 値（見積り10hではない）
  assert.equal(rows.find((r) => r.id === 2).assignedH, 2);   // 見積り
  // 後方互換: plansByTask 無し → 純見積り
  const rowsNoPlan = loadByMember(tasks, members, TODAY, 8);
  assert.equal(rowsNoPlan.find((r) => r.id === 1).assignedH, 10);
});

test("weekLoadByMember: plansByTask で日別 plans/見積り混在", () => {
  const tasks = [{ id: 1, title: "A", assignees: [{ id: 1 }], time_estimate: 14400, due_date: due("2026-06-11") }];
  const week = ["2026-06-10", "2026-06-11", "2026-06-12"];
  const plansByTask = new Map([[1, [plan("2026-06-10", 3600), plan("2026-06-12", 7200)]]]);
  const m = weekLoadByMember(tasks, members, week, 8, plansByTask).find((r) => r.id === 1);
  assert.equal(m.days.find((d) => d.day === "2026-06-10").h, 1); // plan 1h
  assert.equal(m.days.find((d) => d.day === "2026-06-11").h, 0); // plans有・当日無→0（見積りにしない）
  assert.equal(m.days.find((d) => d.day === "2026-06-12").h, 2); // plan 2h
  assert.equal(m.weekH, 3);
});
