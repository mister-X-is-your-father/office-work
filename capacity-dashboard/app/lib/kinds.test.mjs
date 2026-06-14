import { test } from "node:test";
import assert from "node:assert/strict";
import { PRIO_LEVELS, PRIO, PRIO_OPTS, prioBucket, NEUTRAL, STATUS, statusOf } from "./kinds.js";

// 重要度 SSoT の導出が正しいこと（PRIO / PRIO_OPTS は PRIO_LEVELS 由来＝二重管理なし）。
test("PRIO_LEVELS: 0..4 の5段で連番", () => {
  assert.equal(PRIO_LEVELS.length, 5);
  assert.deepEqual(PRIO_LEVELS.map((p) => p.v), [0, 1, 2, 3, 4]);
});

test("PRIO: PRIO_LEVELS から導出され 0キーも安全参照できる", () => {
  assert.equal(PRIO[0].n, "なし");
  assert.equal(PRIO[0].c, NEUTRAL);
  assert.equal(PRIO[4].n, "MUST");
  assert.equal(PRIO[4].c, "#e5484d");
});

test("PRIO_OPTS: 選択肢は定義から一意に導出", () => {
  assert.deepEqual(PRIO_OPTS, [[0, "なし"], [1, "低"], [2, "中"], [3, "高"], [4, "MUST"]]);
});

// 0(なし) は丸めず 0 のまま、5 は MUST に丸める。
test("prioBucket: 0→0 / undefined→0 / 5→4", () => {
  assert.equal(prioBucket(0), 0);
  assert.equal(prioBucket(undefined), 0);
  assert.equal(prioBucket(1), 1);
  assert.equal(prioBucket(4), 4);
  assert.equal(prioBucket(5), 4);
});

// ステータス判定 SSoT。done が着手判定に優先。doing=着手済み(started_at or percent_done>0)。
test("statusOf: done 優先 → 着手済み → todo", () => {
  assert.equal(statusOf({ done: true, percent_done: 0 }), "done");
  assert.equal(statusOf({ percent_done: 50 }), "doing");
  assert.equal(statusOf({ started_at: "2026-06-08T00:00:00Z" }), "doing"); // %0でも着手済み
  assert.equal(statusOf({}), "todo");
});

test("STATUS: label と rank（未着手<進行中<完了）", () => {
  assert.equal(STATUS[statusOf({})].label, "未着手");
  assert.equal(STATUS[statusOf({ percent_done: 50 })].label, "進行中");
  assert.equal(STATUS[statusOf({ done: true })].label, "完了");
  assert.ok(STATUS.todo.rank < STATUS.doing.rank && STATUS.doing.rank < STATUS.done.rank);
});
