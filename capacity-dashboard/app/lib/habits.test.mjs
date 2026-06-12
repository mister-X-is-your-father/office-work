import { test } from "node:test";
import assert from "node:assert/strict";
import { habitStreak, lastDays } from "./habits.js";

const D = "2026-06-12";

test("habitStreak: 今日含む連続", () => {
  assert.equal(habitStreak(new Set(["2026-06-12", "2026-06-11", "2026-06-10"]), D), 3);
});

test("habitStreak: 今日未チェックでも昨日まで続いていれば継続中", () => {
  assert.equal(habitStreak(new Set(["2026-06-11", "2026-06-10"]), D), 2);
});

test("habitStreak: 一昨日で途切れたら0（昨日が抜けている）", () => {
  assert.equal(habitStreak(new Set(["2026-06-10", "2026-06-09"]), D), 0);
});

test("habitStreak: 空は0・飛び石は直近の連続のみ", () => {
  assert.equal(habitStreak(new Set(), D), 0);
  assert.equal(habitStreak(new Set(["2026-06-12", "2026-06-10"]), D), 1);
});

test("lastDays: 7日分・末尾が今日", () => {
  const w = lastDays(new Set(["2026-06-12", "2026-06-08"]), D);
  assert.equal(w.length, 7);
  assert.equal(w[6].iso, D);
  assert.equal(w[6].done, true);
  assert.equal(w[0].iso, "2026-06-06");
  assert.deepEqual(w.map((d) => d.done), [false, false, true, false, false, false, true]);
});
