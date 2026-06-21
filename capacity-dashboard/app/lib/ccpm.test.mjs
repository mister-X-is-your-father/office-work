import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backcast, estHours, hhmmToH, isUnavailable, isWorkDay, protectedHoursOnDow, localTodayIso,
} from "./ccpm.js";

// 2026-06 の曜日: 06-01=月。06-20(土)/06-21(日)/06-27(土)/06-28(日) が週末。
// 平日: 06-22(月)06-23(火)06-24(水)06-25(木)06-26(金)、06-29(月)06-30(火)。

// ── 純ヘルパ ──────────────────────────────────────────────────────
test("estHours: 空・不正・0以下は null、正の数値はそのまま", () => {
  assert.equal(estHours("2"), 2);
  assert.equal(estHours("1.5"), 1.5);
  assert.equal(estHours(""), null);
  assert.equal(estHours("  "), null);
  assert.equal(estHours("abc"), null);
  assert.equal(estHours("0"), null);
  assert.equal(estHours("-1"), null);
  assert.equal(estHours(null), null);
  assert.equal(estHours(undefined), null);
});

test("hhmmToH: HH:MM → 時間(小数)、不正は null", () => {
  assert.equal(hhmmToH("09:00"), 9);
  assert.equal(hhmmToH("09:30"), 9.5);
  assert.equal(hhmmToH("13:15"), 13.25);
  assert.equal(hhmmToH("bad"), null);
  assert.equal(hhmmToH(""), null);
  assert.equal(hhmmToH(null), null);
});

test("isUnavailable: 休暇レンジ(両端含む)に入る日は true", () => {
  const ranges = [{ start: "2026-06-24", end: "2026-06-26" }];
  assert.equal(isUnavailable("2026-06-24", ranges), true);
  assert.equal(isUnavailable("2026-06-25", ranges), true);
  assert.equal(isUnavailable("2026-06-26", ranges), true);
  assert.equal(isUnavailable("2026-06-23", ranges), false);
  assert.equal(isUnavailable("2026-06-27", ranges), false);
  assert.equal(isUnavailable("2026-06-25", []), false);
});

test("isWorkDay: 土日・祝日・休暇を除外", () => {
  assert.equal(isWorkDay("2026-06-22", null, []), true);  // 月
  assert.equal(isWorkDay("2026-06-20", null, []), false); // 土
  assert.equal(isWorkDay("2026-06-21", null, []), false); // 日
  assert.equal(isWorkDay("2026-06-22", new Set(["2026-06-22"]), []), false); // 祝日
  assert.equal(isWorkDay("2026-06-22", null, [{ start: "2026-06-22", end: "2026-06-22" }]), false); // 休暇
});

test("protectedHoursOnDow: 曜日一致の枠を合算。deep は includeDeep=false で除外", () => {
  const windows = [
    { days: [5], start: "09:00", end: "13:00", kind: "buffer" }, // 金 4h
    { days: [5], start: "15:00", end: "17:00", kind: "deep" },   // 金 deep 2h
    { days: [1], start: "12:00", end: "13:00", kind: "buffer" }, // 月 1h
  ];
  assert.equal(protectedHoursOnDow(windows, 5), 6);                          // 金: 4+2(deep含む)
  assert.equal(protectedHoursOnDow(windows, 5, { includeDeep: false }), 4); // 金: deep除外で4
  assert.equal(protectedHoursOnDow(windows, 1), 1);                          // 月: 1h
  assert.equal(protectedHoursOnDow(windows, 2), 0);                          // 火: なし
  assert.equal(protectedHoursOnDow([], 5), 0);
});

test("localTodayIso: YYYY-MM-DD 形式", () => {
  assert.match(localTodayIso(), /^\d{4}-\d{2}-\d{2}$/);
});

// ── backcast 基本 ─────────────────────────────────────────────────
test("backcast: 1日に収まる手順は締切日にまとめて配置", () => {
  const { dueByIndex, unplaced } = backcast({
    steps: [{ est: 2 }, { est: 3 }, { est: 2 }], deadlineIso: "2026-06-25",
    capH: 8, todayIso: "2026-06-22",
  });
  assert.equal(unplaced, 0);
  assert.equal(dueByIndex.get(0), "2026-06-25");
  assert.equal(dueByIndex.get(1), "2026-06-25");
  assert.equal(dueByIndex.get(2), "2026-06-25");
});

test("backcast: 容量超過は手前の営業日へ。後の手順ほど締切寄り", () => {
  const { dueByIndex, unplaced } = backcast({
    steps: [{ est: 6 }, { est: 6 }, { est: 6 }], deadlineIso: "2026-06-26",
    capH: 8, todayIso: "2026-06-22",
  });
  assert.equal(unplaced, 0);
  assert.equal(dueByIndex.get(2), "2026-06-26"); // 末尾＝締切寄り
  assert.equal(dueByIndex.get(1), "2026-06-25");
  assert.equal(dueByIndex.get(0), "2026-06-24");
});

test("backcast: 週末(土日)はスキップして配置", () => {
  const { dueByIndex } = backcast({
    steps: [{ est: 8 }, { est: 8 }], deadlineIso: "2026-06-22", // 月
    capH: 8, todayIso: "2026-06-17",
  });
  assert.equal(dueByIndex.get(1), "2026-06-22"); // 月
  assert.equal(dueByIndex.get(0), "2026-06-19"); // 金（土日 06-20/21 をスキップ）
});

test("backcast: 祝日をスキップ", () => {
  const { dueByIndex } = backcast({
    steps: [{ est: 8 }, { est: 8 }], deadlineIso: "2026-06-22",
    capH: 8, todayIso: "2026-06-17", holidaysSet: new Set(["2026-06-19"]),
  });
  assert.equal(dueByIndex.get(1), "2026-06-22");
  assert.equal(dueByIndex.get(0), "2026-06-18"); // 金(06-19)が祝日→木
});

test("backcast: 担当の休暇日をスキップ", () => {
  const { dueByIndex } = backcast({
    steps: [{ est: 8 }, { est: 8 }], deadlineIso: "2026-06-26",
    capH: 8, todayIso: "2026-06-22", unavailRanges: [{ start: "2026-06-25", end: "2026-06-25" }],
  });
  assert.equal(dueByIndex.get(1), "2026-06-26");
  assert.equal(dueByIndex.get(0), "2026-06-24"); // 木(06-25)休暇→水
});

test("backcast: bufferPct で1日容量を減らす", () => {
  const { dueByIndex } = backcast({
    steps: [{ est: 4 }, { est: 4 }], deadlineIso: "2026-06-26",
    capH: 8, bufferPct: 50, todayIso: "2026-06-22", // 実空き4h/日
  });
  assert.equal(dueByIndex.get(1), "2026-06-26");
  assert.equal(dueByIndex.get(0), "2026-06-25"); // 4h枠が埋まり前日へ
});

test("backcast: 見積り無し(est空)は1日1件", () => {
  const { dueByIndex, unplaced } = backcast({
    steps: [{ est: "" }, { est: "" }], deadlineIso: "2026-06-26",
    capH: 8, todayIso: "2026-06-22",
  });
  assert.equal(unplaced, 0);
  assert.equal(dueByIndex.get(1), "2026-06-26");
  assert.equal(dueByIndex.get(0), "2026-06-25");
});

// ── 既存不変条件（壊すと退行）────────────────────────────────────
test("backcast[E4床止め]: 今日より前へは置かず、入り切らない分は unplaced", () => {
  const { dueByIndex, unplaced } = backcast({
    steps: [{ est: 8 }, { est: 8 }, { est: 8 }], deadlineIso: "2026-06-24",
    capH: 8, todayIso: "2026-06-23", // 配置可能は 06-23,06-24 の2日のみ
  });
  assert.equal(dueByIndex.get(2), "2026-06-24");
  assert.equal(dueByIndex.get(1), "2026-06-23");
  assert.equal(dueByIndex.has(0), false); // 06-22 は床より前→置けない
  assert.equal(unplaced, 1);
});

test("backcast[E4床止め]: 締切が今日より前なら全 unplaced", () => {
  const { dueByIndex, unplaced } = backcast({
    steps: [{ est: 2 }], deadlineIso: "2026-06-20", capH: 8, todayIso: "2026-06-22",
  });
  assert.equal(dueByIndex.size, 0);
  assert.equal(unplaced, 1);
});

test("backcast[F1横断逆算]: committedByDay 分を実空きから差し引く", () => {
  const committedByDay = new Map([["2026-06-26", 6]]); // 金は他タスクで6h埋まり
  const { dueByIndex } = backcast({
    steps: [{ est: 4 }], deadlineIso: "2026-06-26", capH: 8, todayIso: "2026-06-22",
    committedByDay,
  });
  // 金の実空きは 8-6=2h <4 → 木へ
  assert.equal(dueByIndex.get(0), "2026-06-25");
});

test("backcast[F6 deep枠]: taskIsImportant で deep を実空きに開放", () => {
  const windows = [{ days: [5], start: "09:00", end: "17:00", kind: "deep" }]; // 金 8h deep
  // 通常タスク: 金は deep で 0h → 木へ
  const normal = backcast({
    steps: [{ est: 4 }], deadlineIso: "2026-06-26", capH: 8, todayIso: "2026-06-22", windows,
  });
  assert.equal(normal.dueByIndex.get(0), "2026-06-25");
  // 重要タスク: deep を使える → 金に置ける
  const important = backcast({
    steps: [{ est: 4 }], deadlineIso: "2026-06-26", capH: 8, todayIso: "2026-06-22", windows,
    taskIsImportant: true,
  });
  assert.equal(important.dueByIndex.get(0), "2026-06-26");
});

test("backcast: 空 steps / 無効 deadline は dueByIndex 空", () => {
  assert.equal(backcast({ steps: [], deadlineIso: "2026-06-26" }).unplaced, 0);
  assert.equal(backcast({ steps: [{ est: 2 }], deadlineIso: "" }).unplaced, 1);
  assert.equal(backcast({ steps: [{ est: 2 }], deadlineIso: "0001-01-01T00:00:00Z" }).unplaced, 1);
});

test("backcast: 1日容量を超える巨大手順は1日に置いて消費しきる（無限ループ回避）", () => {
  const { dueByIndex, unplaced } = backcast({
    steps: [{ est: 20 }], deadlineIso: "2026-06-26", capH: 8, todayIso: "2026-06-22",
  });
  assert.equal(unplaced, 0);
  // 既存挙動: 締切日(06-26)に入らず次営業日を取得し、そこにも入らないがその日へ置く＝06-25。
  assert.equal(dueByIndex.get(0), "2026-06-25");
  assert.equal(dueByIndex.size, 1);
});
