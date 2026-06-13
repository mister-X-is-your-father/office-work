import { test } from "node:test";
import assert from "node:assert/strict";
import { taskMatches, next7End, EMPTY_FILTER, BUILTIN_VIEWS } from "./smartlist.js";

const TODAY = "2026-06-13";
const ctx = { today: TODAY, next7: next7End(TODAY) }; // 2026-06-19
const due = (d) => `${d}T00:00:00Z`;
const T = (o) => ({ title: "t", priority: 0, percent_done: 0, project_id: 1, ...o });

test("next7End: 今日含む7日（today+6）", () => {
  assert.equal(next7End("2026-06-13"), "2026-06-19");
});

test("status: undone/done/todo/doing", () => {
  assert.equal(taskMatches(T({ done: true }), { status: "undone" }, ctx), false);
  assert.equal(taskMatches(T({ done: true }), { status: "done" }, ctx), true);
  assert.equal(taskMatches(T({ percent_done: 50 }), { status: "todo" }, ctx), false); // 進行中はtodoでない
  assert.equal(taskMatches(T({ percent_done: 50 }), { status: "doing" }, ctx), true);
  assert.equal(taskMatches(T({ percent_done: 0 }), { status: "doing" }, ctx), false);
});

test("due: today/overdue/next7/none/hasdue", () => {
  assert.equal(taskMatches(T({ due_date: due(TODAY) }), { due: "today" }, ctx), true);
  assert.equal(taskMatches(T({ due_date: due("2026-06-10") }), { due: "overdue" }, ctx), true);
  assert.equal(taskMatches(T({ due_date: due("2026-06-10"), done: true }), { due: "overdue" }, ctx), false); // 完了は期限切れでない
  assert.equal(taskMatches(T({ due_date: due("2026-06-19") }), { due: "next7" }, ctx), true);
  assert.equal(taskMatches(T({ due_date: due("2026-06-20") }), { due: "next7" }, ctx), false); // 窓外
  assert.equal(taskMatches(T({}), { due: "none" }, ctx), true);
  assert.equal(taskMatches(T({ due_date: due(TODAY) }), { due: "none" }, ctx), false);
  assert.equal(taskMatches(T({ due_date: due(TODAY) }), { due: "hasdue" }, ctx), true);
});

test("priority: top/high/mid/none", () => {
  assert.equal(taskMatches(T({ priority: 4 }), { prio: "top" }, ctx), true);
  assert.equal(taskMatches(T({ priority: 3 }), { prio: "top" }, ctx), false);
  assert.equal(taskMatches(T({ priority: 3 }), { prio: "high" }, ctx), true);
  assert.equal(taskMatches(T({ priority: 0 }), { prio: "none" }, ctx), true);
  assert.equal(taskMatches(T({ priority: 2 }), { prio: "none" }, ctx), false);
});

test("ws / flag / text", () => {
  assert.equal(taskMatches(T({ project_id: 5 }), { ws: 5 }, ctx), true);
  assert.equal(taskMatches(T({ project_id: 1 }), { ws: 5 }, ctx), false);
  assert.equal(taskMatches(T({ is_favorite: true }), { flag: true }, ctx), true);
  assert.equal(taskMatches(T({ is_favorite: false }), { flag: true }, ctx), false);
  assert.equal(taskMatches(T({ title: "請求書ドラフト" }), { text: "請求" }, ctx), true);
  assert.equal(taskMatches(T({ title: "会議", description: "予算メモ" }), { text: "予算" }, ctx), true);
  assert.equal(taskMatches(T({ title: "会議" }), { text: "予算" }, ctx), false);
});

test("複合条件（重要かつ今日）", () => {
  const t = T({ priority: 4, due_date: due(TODAY) });
  assert.equal(taskMatches(t, { prio: "high", due: "today", status: "undone" }, ctx), true);
  assert.equal(taskMatches(T({ priority: 1, due_date: due(TODAY) }), { prio: "high", due: "today" }, ctx), false);
});

test("BUILTIN_VIEWS と EMPTY_FILTER の健全性", () => {
  assert.ok(BUILTIN_VIEWS.length >= 6);
  assert.ok(BUILTIN_VIEWS.every((v) => v.key && v.label && v.filter));
  assert.equal(EMPTY_FILTER.status, "undone");
});
