import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertIntentBlock, eisenhowerPriority, hhmmToMinutes, unknownsToSteps, CI_OPEN, CI_CLOSE,
} from "./onapply.js";

test("upsertIntentBlock: 空説明に意図ブロックを先頭付与", () => {
  const r = upsertIntentBlock("", { purpose: "売上を上げる", endState: "資料が承認された" });
  assert.ok(r.startsWith(CI_OPEN));
  assert.ok(r.includes("◎ 意図"));
  assert.ok(r.includes("売上を上げる"));
  assert.ok(r.includes("終末状態"));
  assert.ok(r.includes("資料が承認された"));
  assert.ok(r.includes(CI_CLOSE));
});

test("upsertIntentBlock: 既存本文の前に付き、本文は保持", () => {
  const r = upsertIntentBlock("<p>既存の説明</p>", { purpose: "P", endState: "E" });
  assert.ok(r.includes("<p>既存の説明</p>"));
  assert.ok(r.indexOf(CI_OPEN) < r.indexOf("既存の説明"));
});

test("upsertIntentBlock: 再適用しても重複せず置換（番兵で1ブロック）", () => {
  const once = upsertIntentBlock("<p>本文</p>", { purpose: "P1", endState: "E1" });
  const twice = upsertIntentBlock(once, { purpose: "P2", endState: "E2" });
  assert.equal((twice.match(new RegExp(CI_OPEN, "g")) || []).length, 1); // ブロックは1つ
  assert.ok(twice.includes("P2") && twice.includes("E2"));
  assert.ok(!twice.includes("P1")); // 旧内容は消える
  assert.ok(twice.includes("<p>本文</p>")); // 本文は残る
});

test("upsertIntentBlock: 空入力は既存ブロックを除去するだけ", () => {
  const withBlock = upsertIntentBlock("<p>本文</p>", { purpose: "P", endState: "E" });
  const cleared = upsertIntentBlock(withBlock, { purpose: "", endState: "" });
  assert.ok(!cleared.includes(CI_OPEN));
  assert.ok(cleared.includes("<p>本文</p>"));
});

test("upsertIntentBlock: HTML をエスケープ", () => {
  const r = upsertIntentBlock("", { purpose: "<script>x</script>", endState: "E" });
  assert.ok(!r.includes("<script>"));
  assert.ok(r.includes("&lt;script&gt;"));
});

test("upsertIntentBlock: mustHold/acceptableLoss も反映", () => {
  const r = upsertIntentBlock("", { purpose: "P", endState: "E", mustHold: "品質", acceptableLoss: "見た目" });
  assert.ok(r.includes("必須") && r.includes("品質"));
  assert.ok(r.includes("削ってよい") && r.includes("見た目"));
});

test("eisenhowerPriority: 象限→優先度", () => {
  assert.equal(eisenhowerPriority(true, true), 4);
  assert.equal(eisenhowerPriority(true, false), 3);
  assert.equal(eisenhowerPriority(false, true), null);
  assert.equal(eisenhowerPriority(false, false), null);
});

test("hhmmToMinutes: HH:MM→分、不正は null", () => {
  assert.equal(hhmmToMinutes("09:00"), 540);
  assert.equal(hhmmToMinutes("13:30"), 810);
  assert.equal(hhmmToMinutes("00:00"), 0);
  assert.equal(hhmmToMinutes("24:00"), null);
  assert.equal(hhmmToMinutes("9:5"), null);
  assert.equal(hhmmToMinutes(""), null);
});

test("unknownsToSteps: 高影響・未解消のみ先行検証手順化（slice=true）", () => {
  const items = [
    { unknown: "API上限", impact: "high", resolved: false, due: "2026-06-25" },
    { unknown: "解決済み", impact: "high", resolved: true },
    { unknown: "中影響", impact: "med", resolved: false },
    { unknown: "", impact: "high", resolved: false },
  ];
  let i = 0;
  const steps = unknownsToSteps(items, { uid: () => `u${++i}` });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].title, "[先行検証] API上限");
  assert.equal(steps[0].slice, true);
  assert.equal(steps[0].due, "2026-06-25");
  assert.equal(steps[0].kind, "自作業");
});

test("unknownsToSteps: 空配列は空", () => {
  assert.deepEqual(unknownsToSteps([]), []);
  assert.deepEqual(unknownsToSteps(null), []);
});
