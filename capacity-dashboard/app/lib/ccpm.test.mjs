import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backcast, estHours, hhmmToH, isUnavailable, isWorkDay, protectedHoursOnDow, localTodayIso,
  addBusinessDays, businessDaysBefore, compressSteps, projectBufferDays, ccpmPlan, feverStatus,
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

// ── CCPM 強化: 営業日シフト ─────────────────────────────────────────
test("addBusinessDays / businessDaysBefore: 土日を飛ばす", () => {
  assert.equal(addBusinessDays("2026-06-26", 1), "2026-06-29");  // 金→月
  assert.equal(addBusinessDays("2026-06-22", -1), "2026-06-19"); // 月→金
  assert.equal(addBusinessDays("2026-06-26", 0), "2026-06-26");  // 0=そのまま
  assert.equal(businessDaysBefore("2026-06-26", 2), "2026-06-24"); // 金-2=水
  assert.equal(businessDaysBefore("2026-06-22", 1), "2026-06-19"); // 月-1=前金
  assert.equal(businessDaysBefore("2026-06-26", 0), "2026-06-26");
});

test("addBusinessDays: 祝日も飛ばす", () => {
  // 06-25(木)が祝日 → 金(06-26)の1営業日前は水(06-24)
  assert.equal(businessDaysBefore("2026-06-26", 1, { holidaysSet: new Set(["2026-06-25"]) }), "2026-06-24");
});

// ── CCPM 強化: 手順圧縮＋バッファ ──────────────────────────────────
test("compressSteps: est を圧縮し抜いた余裕を合計。見積り無しは据え置き", () => {
  const r = compressSteps([{ est: 10, title: "a" }, { est: "", title: "b" }, { est: 5 }], 30);
  assert.equal(r.steps[0].est, 7);
  assert.equal(r.steps[0].title, "a");  // 他フィールド保持
  assert.equal(r.steps[1].est, "");     // 見積り無しは不変
  assert.equal(r.steps[2].est, 3.5);
  assert.equal(r.removedSlackH, 4.5);   // (10-7)+(5-3.5)
});

test("compressSteps: 元配列を破壊しない / 0%は据え置き", () => {
  const src = [{ est: 8 }];
  const r = compressSteps(src, 0);
  assert.equal(r.steps[0].est, 8);
  assert.equal(r.removedSlackH, 0);
  assert.equal(src[0].est, 8); // 非破壊
});

test("projectBufferDays: 既定=抜いた余裕の半分/容量 切り上げ。override優先", () => {
  assert.deepEqual(projectBufferDays(4.5, 8), { bufferDays: 1, bufferH: 2.25, auto: 1 });
  assert.deepEqual(projectBufferDays(0, 8), { bufferDays: 0, bufferH: 0, auto: 0 });
  const ov = projectBufferDays(4.5, 8, "3");
  assert.equal(ov.bufferDays, 3);
  assert.equal(ov.auto, 1); // auto は併記
});

// ── CCPM 強化: ccpmPlan 統合 ───────────────────────────────────────
test("ccpmPlan: 前倒し締切ぶん手前に圧縮配置（圧縮なし）", () => {
  const r = ccpmPlan({
    steps: [{ est: 6 }, { est: 6 }], deadlineIso: "2026-06-26", capH: 8, todayIso: "2026-06-22",
    personalDueOffset: 2, aggressivePct: 0,
  });
  assert.equal(r.personalDueIso, "2026-06-24"); // 金-2営業日=水
  assert.equal(r.bufferDays, 0);                 // 圧縮0→バッファ0
  assert.equal(r.workDeadlineIso, "2026-06-24");
  assert.equal(r.unplaced, 0);
  assert.equal(r.dueByIndex.get(1), "2026-06-24");
  assert.equal(r.dueByIndex.get(0), "2026-06-23"); // 水に6h置き残りは火へ
});

test("ccpmPlan: aggressive圧縮でバッファ確保し作業締切が手前へ", () => {
  const r = ccpmPlan({
    steps: [{ est: 6 }, { est: 6 }], deadlineIso: "2026-06-26", capH: 8, todayIso: "2026-06-22",
    personalDueOffset: 2, aggressivePct: 50,
  });
  assert.equal(r.removedSlackH, 6);             // (6-3)*2
  assert.equal(r.bufferDays, 1);                // ceil((6/2)/8)=1
  assert.equal(r.personalDueIso, "2026-06-24"); // 金-2=水
  assert.equal(r.workDeadlineIso, "2026-06-23"); // 水-1営業日=火（バッファ1日確保）
  assert.equal(r.unplaced, 0);
  // 圧縮後 est=3,3 が火(06-23)に両方収まる
  assert.equal(r.dueByIndex.get(0), "2026-06-23");
  assert.equal(r.dueByIndex.get(1), "2026-06-23");
  assert.equal(r.chainWorkH, 6); // 圧縮後 3+3
});

test("ccpmPlan: 前倒し＋バッファで入り切らなければ unplaced（過剰コミット検知）", () => {
  // 1日8h・今日=06-22。締切06-23(火)だが offset2 で personalDue が今日より前→workDeadline 過去→全unplaced
  const r = ccpmPlan({
    steps: [{ est: 4 }], deadlineIso: "2026-06-23", capH: 8, todayIso: "2026-06-22",
    personalDueOffset: 2, aggressivePct: 0,
  });
  assert.equal(r.unplaced, 1);
  assert.equal(r.dueByIndex.size, 0);
});

test("ccpmPlan: 無効 deadline は全 unplaced", () => {
  const r = ccpmPlan({ steps: [{ est: 2 }], deadlineIso: "0001-01-01", personalDueOffset: 2 });
  assert.equal(r.unplaced, 1);
});

// ── CCPM 強化: fever（バッファ消費率）──────────────────────────────
test("feverStatus: 残作業0は緑0%", () => {
  const r = feverStatus({ remainingWorkH: 0, personalDueIso: "2026-06-24", bufferDays: 2, todayIso: "2026-06-22" });
  assert.equal(r.consumedPct, 0);
  assert.equal(r.tier, "green");
});

test("feverStatus: 前倒し締切に間に合えば消費0=緑", () => {
  // today=月, personalDue=水, 残24h=3営業日→投影終了 水(月火水)=personalDueちょうど→超過0
  const r = feverStatus({ remainingWorkH: 24, dailyCapH: 8, todayIso: "2026-06-22", personalDueIso: "2026-06-24", bufferDays: 2 });
  assert.equal(r.projectedFinishIso, "2026-06-24");
  assert.equal(r.consumedDays, 0);
  assert.equal(r.tier, "green");
});

test("feverStatus: バッファを食うと黄→赤", () => {
  const base = { dailyCapH: 8, todayIso: "2026-06-22", personalDueIso: "2026-06-24", bufferDays: 2 };
  const y = feverStatus({ ...base, remainingWorkH: 32 }); // 4日→木 超過1日 /2=50%→緑(境界)
  assert.equal(y.consumedDays, 1); assert.equal(y.consumedPct, 50); assert.equal(y.tier, "green");
  const r = feverStatus({ ...base, remainingWorkH: 40 }); // 5日→金 超過2日 /2=100%→赤
  assert.equal(r.consumedDays, 2); assert.equal(r.consumedPct, 100); assert.equal(r.tier, "red");
  const r2 = feverStatus({ ...base, remainingWorkH: 48 }); // 6日→月(週末跨ぎ) 超過3日(木金月) /2=150%→赤
  assert.equal(r2.projectedFinishIso, "2026-06-29");
  assert.equal(r2.consumedDays, 3); assert.equal(r2.tier, "red");
});

test("feverStatus: bufferDays=0 で超過があれば即100%赤", () => {
  const r = feverStatus({ remainingWorkH: 40, dailyCapH: 8, todayIso: "2026-06-22", personalDueIso: "2026-06-24", bufferDays: 0 });
  assert.equal(r.consumedPct, 100);
  assert.equal(r.tier, "red");
});
