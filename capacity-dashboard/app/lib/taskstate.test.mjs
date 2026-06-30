import { test } from "node:test";
import assert from "node:assert/strict";
import { statePatchFor } from "./taskstate.js";

const NOW = () => "2026-06-30T05:00:00.000Z"; // 決定化のため固定注入

test("statePatchFor done: table/smartlist(false)は started_at 省略、kanban(true)は温存", () => {
  const t = { done: false, percent_done: 40, started_at: "2026-06-20T00:00:00Z" };
  assert.deepEqual(statePatchFor("done", t, { now: NOW }), { done: true, percent_done: 100 });
  assert.deepEqual(statePatchFor("done", t, { keepStartedOnDone: true, now: NOW }),
    { done: true, percent_done: 100, started_at: "2026-06-20T00:00:00Z" });
  // started_at 未設定なら null 温存
  assert.deepEqual(statePatchFor("done", { percent_done: 10 }, { keepStartedOnDone: true, now: NOW }),
    { done: true, percent_done: 100, started_at: null });
});

test("statePatchFor doing: started_at=now、keepPct（再オープン時は0/それ以外は現%）", () => {
  // 通常: 現 % を温存
  assert.deepEqual(statePatchFor("doing", { percent_done: 30 }, { now: NOW }),
    { done: false, percent_done: 30, started_at: "2026-06-30T05:00:00.000Z" });
  // 完了済を進行中へ → % は 0 リセット
  assert.deepEqual(statePatchFor("doing", { done: true, percent_done: 100 }, { now: NOW }),
    { done: false, percent_done: 0, started_at: "2026-06-30T05:00:00.000Z" });
  // 100%以上を進行中へ → 0 リセット
  assert.deepEqual(statePatchFor("doing", { percent_done: 100 }, { now: NOW }),
    { done: false, percent_done: 0, started_at: "2026-06-30T05:00:00.000Z" });
  // percent_done 欠落 → 0
  assert.deepEqual(statePatchFor("doing", {}, { now: NOW }),
    { done: false, percent_done: 0, started_at: "2026-06-30T05:00:00.000Z" });
});

test("statePatchFor todo: 未完了化・%0・started_at null", () => {
  assert.deepEqual(statePatchFor("todo", { done: true, percent_done: 100, started_at: "x" }, { now: NOW }),
    { done: false, percent_done: 0, started_at: null });
});

test("statePatchFor: task=null でも落ちない（todo相当）", () => {
  assert.deepEqual(statePatchFor("todo", null, { now: NOW }), { done: false, percent_done: 0, started_at: null });
});
