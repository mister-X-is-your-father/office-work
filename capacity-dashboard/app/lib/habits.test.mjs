import { test } from "node:test";
import assert from "node:assert/strict";
import {
  habitStreak, lastDays,
  parseGoalToken, parseGoal, goalLabel, setGoalMeta, weekToDate, weekProgress,
} from "./habits.js";

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

// ── C11: 目標頻度 ───────────────────────────────────────────────

test("parseGoalToken: 毎日/平日/週N の解釈", () => {
  assert.deepEqual(parseGoalToken("毎日"), { type: "daily" });
  assert.deepEqual(parseGoalToken("平日"), { type: "weekdays" });
  assert.deepEqual(parseGoalToken("平日のみ"), { type: "weekdays" });
  assert.deepEqual(parseGoalToken("週3"), { type: "week_n", n: 3 });
  assert.deepEqual(parseGoalToken("週 5"), { type: "week_n", n: 5 });
  assert.deepEqual(parseGoalToken("3回"), { type: "week_n", n: 3 });
  assert.deepEqual(parseGoalToken("2"), { type: "week_n", n: 2 });
});

test("parseGoalToken: 範囲外は1..7にクランプ・不明はnull", () => {
  assert.deepEqual(parseGoalToken("週9"), { type: "week_n", n: 7 });
  assert.deepEqual(parseGoalToken("週0"), { type: "week_n", n: 1 });
  assert.equal(parseGoalToken(""), null);
  assert.equal(parseGoalToken("ときどき"), null);
});

test("parseGoal: description のメタ記法から解釈（本文混在可）", () => {
  assert.deepEqual(parseGoal("朝のレビュー\n[目標:週3]"), { type: "week_n", n: 3 });
  assert.deepEqual(parseGoal("[目標: 平日 ]"), { type: "weekdays" });
  assert.equal(parseGoal("ただのメモ"), null);
  assert.equal(parseGoal(""), null);
  assert.equal(parseGoal(null), null);
});

test("goalLabel: 表示ラベル", () => {
  assert.equal(goalLabel({ type: "daily" }), "毎日");
  assert.equal(goalLabel({ type: "weekdays" }), "平日のみ");
  assert.equal(goalLabel({ type: "week_n", n: 3 }), "週3回");
  assert.equal(goalLabel(null), "");
});

test("setGoalMeta: 既存目標の置換・本文温存・解除", () => {
  // 新規付与（本文温存）
  assert.equal(setGoalMeta("メモ", { type: "week_n", n: 3 }), "メモ\n[目標:週3]");
  // 置換（既存の目標行は1つに）
  assert.equal(setGoalMeta("メモ\n[目標:週2]", { type: "daily" }), "メモ\n[目標:毎日]");
  // 平日
  assert.equal(setGoalMeta("", { type: "weekdays" }), "[目標:平日]");
  // 解除（null）で目標行を除去・本文だけ残る
  assert.equal(setGoalMeta("メモ\n[目標:週3]", null), "メモ");
  assert.equal(setGoalMeta("[目標:週3]", null), "");
});

test("setGoalMeta→parseGoal: 往復で同値", () => {
  for (const g of [{ type: "daily" }, { type: "weekdays" }, { type: "week_n", n: 4 }]) {
    assert.deepEqual(parseGoal(setGoalMeta("本文", g)), g);
  }
});

test("weekToDate: 日曜起点〜today（todayは金曜→6日）", () => {
  const w = weekToDate(D); // 2026-06-12(金)
  assert.deepEqual(w, ["2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"]);
});

test("weekProgress: 週N回の達成カウント", () => {
  const dates = new Set(["2026-06-08", "2026-06-10", "2026-06-12"]); // 今週3回
  assert.deepEqual(
    weekProgress(dates, D, { type: "week_n", n: 3 }),
    { done: 3, target: 3, met: true, type: "week_n", n: 3 },
  );
  assert.deepEqual(
    weekProgress(dates, D, { type: "week_n", n: 5 }),
    { done: 3, target: 5, met: false, type: "week_n", n: 5 },
  );
});

test("weekProgress: 平日のみは平日だけカウント・targetは5", () => {
  // 2026-06-07(日)を含めても平日カウントから除外される
  const dates = new Set(["2026-06-07", "2026-06-08", "2026-06-09"]);
  const r = weekProgress(dates, D, { type: "weekdays" });
  assert.deepEqual(r, { done: 2, target: 5, met: false, type: "weekdays", n: undefined });
});

test("weekProgress: 毎日は target=7・先週分は数えない", () => {
  const dates = new Set(["2026-06-05", "2026-06-11", "2026-06-12"]); // 06-05は先週
  const r = weekProgress(dates, D, { type: "daily" });
  assert.deepEqual(r, { done: 2, target: 7, met: false, type: "daily", n: undefined });
});

test("weekProgress: goal=null は null", () => {
  assert.equal(weekProgress(new Set(), D, null), null);
});
