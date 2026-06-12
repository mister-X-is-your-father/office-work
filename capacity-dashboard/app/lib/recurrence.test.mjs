import { test } from "node:test";
import assert from "node:assert/strict";
import { rrulestr } from "./vendor/rrule.mjs";
import { expandRecurrences, occurrenceLoadEntries, capacityOn, freeByMemberDay, holidayDataStatus } from "./recurrence.js";

const rec = (o) => ({ dtstart: "2026-06-01T00:00:00Z", duration_seconds: 3600, assignee_ids: [1], ...o });
const days = (from, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10);
});

test("rrule.mjs スモーク", () => {
  const r = rrulestr("DTSTART:20260601T000000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO");
  assert.ok(r.between(new Date("2026-06-08T00:00:00Z"), new Date("2026-06-30T00:00:00Z"), true).length >= 3);
});

test("expandRecurrences: 毎週月", () => {
  const occ = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;BYDAY=MO" })], "2026-06-08", "2026-07-05");
  assert.deepEqual(occ.map((o) => o.dateISO), ["2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"]);
});

test("expandRecurrences: 毎月第2火", () => {
  const occ = expandRecurrences([rec({ rrule: "FREQ=MONTHLY;BYDAY=2TU" })], "2026-06-01", "2026-07-31");
  assert.deepEqual(occ.map((o) => o.dateISO), ["2026-06-09", "2026-07-14"]);
});

test("expandRecurrences: 隔週(INTERVAL=2)", () => {
  // dtstart=2026-06-01(月)。隔週月 → 6/1,6/15,6/29...
  const occ = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" })], "2026-06-01", "2026-06-30");
  assert.deepEqual(occ.map((o) => o.dateISO), ["2026-06-01", "2026-06-15", "2026-06-29"]);
});

test("expandRecurrences: UNTIL / COUNT / 境界inclusive", () => {
  const until = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260616T000000Z" })], "2026-06-01", "2026-07-31");
  assert.deepEqual(until.map((o) => o.dateISO), ["2026-06-01", "2026-06-08", "2026-06-15"]); // 6/16以降なし
  const count = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=2" })], "2026-06-01", "2026-07-31");
  assert.equal(count.length, 2);
  // 境界: from がちょうど発生日
  const edge = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;BYDAY=MO" })], "2026-06-08", "2026-06-08");
  assert.deepEqual(edge.map((o) => o.dateISO), ["2026-06-08"]);
});

test("rotation: 持ち回りは assignee_ids を出現順に巡回（1名ずつ）", () => {
  // dtstart=6/1(月)・毎週月・担当 [1,2,3] 持ち回り → 6/1=1, 6/8=2, 6/15=3, 6/22=1
  const r = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", assignee_ids: [1, 2, 3], rotation: true });
  const occ = expandRecurrences([r], "2026-06-01", "2026-06-22");
  assert.deepEqual(occ.map((o) => [o.dateISO, ...o.assignees]),
    [["2026-06-01", 1], ["2026-06-08", 2], ["2026-06-15", 3], ["2026-06-22", 1]]);
});

test("rotation: ウィンドウが dtstart より後でも通し番号で巡回が続く", () => {
  // 6/15 は dtstart=6/1 から3回目（index 2）→ 担当3
  const r = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", assignee_ids: [1, 2, 3], rotation: true });
  const occ = expandRecurrences([r], "2026-06-15", "2026-06-29");
  assert.deepEqual(occ.map((o) => [o.dateISO, ...o.assignees]),
    [["2026-06-15", 3], ["2026-06-22", 1], ["2026-06-29", 2]]);
});

test("rotation: 負荷はその回の担当1名のみ・非rotationは全員のまま", () => {
  const rot = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", duration_seconds: 7200, assignee_ids: [1, 2], rotation: true });
  const entries = occurrenceLoadEntries(expandRecurrences([rot], "2026-06-01", "2026-06-08"));
  assert.deepEqual(entries, [
    { memberId: 1, day: "2026-06-01", h: 2 },
    { memberId: 2, day: "2026-06-08", h: 2 },
  ]);
  // rotation=false は従来通り全員フル
  const all = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", duration_seconds: 3600, assignee_ids: [1, 2], rotation: false });
  const entries2 = occurrenceLoadEntries(expandRecurrences([all], "2026-06-01", "2026-06-01"));
  assert.equal(entries2.length, 2);
});

test("occurrenceLoadEntries: 多担当=全員フル", () => {
  const occ = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", duration_seconds: 3600, assignee_ids: [1, 2] })], "2026-06-08", "2026-06-08");
  const entries = occurrenceLoadEntries(occ);
  assert.deepEqual(entries, [
    { memberId: 1, day: "2026-06-08", h: 1 },
    { memberId: 2, day: "2026-06-08", h: 1 },
  ]);
});

test("holidayDataStatus: 最終登録日が90日先に届かなければ stale", () => {
  // 十分先まで登録あり → 健全
  const ok = holidayDataStatus(new Set(["2026-07-20", "2027-01-01"]), "2026-06-12");
  assert.equal(ok.stale, false);
  assert.equal(ok.latest, "2027-01-01");
  // 90日以内で途切れている → stale
  const old = holidayDataStatus(new Set(["2026-06-22"]), "2026-06-12");
  assert.equal(old.stale, true);
  // 未登録 → stale（latest=null）
  const none = holidayDataStatus(new Set(), "2026-06-12");
  assert.equal(none.stale, true);
  assert.equal(none.latest, null);
});

test("capacityOn: 週末/祝日/休暇=0、平日=capH", () => {
  const A = { id: 1 };
  const holidays = new Set(["2026-06-15"]);
  const unavailabilityByMember = new Map([[1, [{ start: "2026-06-22", end: "2026-06-24" }]]]);
  const opt = { holidays, unavailabilityByMember, capH: 8 };
  assert.equal(capacityOn(A, "2026-06-09", opt), 8);   // 平日
  assert.equal(capacityOn(A, "2026-06-13", opt), 0);   // 土
  assert.equal(capacityOn(A, "2026-06-14", opt), 0);   // 日
  assert.equal(capacityOn(A, "2026-06-15", opt), 0);   // 祝日
  assert.equal(capacityOn(A, "2026-06-23", opt), 0);   // 休暇範囲内
  assert.equal(capacityOn(A, "2026-06-25", opt), 8);   // 休暇範囲外
});

test("freeByMemberDay: 合算・status・祝日衝突=over", () => {
  const members = [{ id: 1 }, { id: 2 }];
  const isoDays = ["2026-06-08", "2026-06-09", "2026-06-13", "2026-06-15"]; // 月/火/土/月(祝日)
  // occurrence: 毎週月の会議1h(A,B)。タスク由来: 火に A 3h。
  const occ = expandRecurrences([rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", duration_seconds: 3600, assignee_ids: [1, 2] })], "2026-06-08", "2026-06-15");
  const occLoad = occurrenceLoadEntries(occ);
  const taskLoad = [{ memberId: 1, day: "2026-06-09", h: 3 }];
  const availability = { holidays: new Set(["2026-06-15"]), unavailabilityByMember: new Map(), capH: 8 };
  const res = freeByMemberDay(members, isoDays, [occLoad, taskLoad], availability);
  const a = res.get(1), b = res.get(2);
  assert.deepEqual(a.get("2026-06-08"), { capH: 8, loadH: 1, freeH: 7, status: "free" });  // 月: 会議1h
  assert.deepEqual(a.get("2026-06-09"), { capH: 8, loadH: 3, freeH: 5, status: "free" });  // 火: タスク3h
  assert.equal(a.get("2026-06-13").status, "off");                                          // 土: 予定なし
  assert.equal(a.get("2026-06-15").status, "over");                                         // 祝日に会議1h=衝突
  assert.equal(b.get("2026-06-09").loadH, 0);                                               // B は火に予定なし
});

test("overrides: skip=休止・date=移動（origISO保持）・窓またぎの移動も拾う", () => {
  // 毎週月（6/8, 6/15, 6/22）に例外: 6/8=休止、6/15→6/17 へ移動
  const r = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO",
    overrides: { "2026-06-08": { skip: true }, "2026-06-15": { date: "2026-06-17" } } });
  const occ = expandRecurrences([r], "2026-06-08", "2026-06-22");
  assert.deepEqual(occ.map((o) => o.dateISO), ["2026-06-17", "2026-06-22"]);
  assert.equal(occ[0].origISO, "2026-06-15");           // 移動しても元の日を保持
  assert.equal(occ[1].override, null);                   // 例外なしの回は override=null
  // 窓の外(6/29)から窓内(6/24)へ移動した回も拾う
  const r2 = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", overrides: { "2026-06-29": { date: "2026-06-24" } } });
  const occ2 = expandRecurrences([r2], "2026-06-23", "2026-06-26");
  assert.deepEqual(occ2.map((o) => o.dateISO), ["2026-06-24"]);
});

test("overrides: duration_seconds の例外が負荷に反映される", () => {
  const r = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", duration_seconds: 3600, assignee_ids: [1, 2],
    overrides: { "2026-06-15": { duration_seconds: 7200 } } });
  const load = occurrenceLoadEntries(expandRecurrences([r], "2026-06-08", "2026-06-15"));
  const byDay = (d) => load.filter((e) => e.day === d).map((e) => e.h);
  assert.deepEqual(byDay("2026-06-08"), [1, 1]);  // 通常回 1h
  assert.deepEqual(byDay("2026-06-15"), [2, 2]);  // 例外回 2h
});

test("overrides: rotation の巡回番号は元の日基準（移動・休止でも順番が崩れない）", () => {
  // 毎週月 A→B→A→B…。6/15 を休止しても 6/22 は「3番目」= A のまま。
  const r = rec({ rrule: "FREQ=WEEKLY;BYDAY=MO", rotation: true, assignee_ids: [1, 2],
    overrides: { "2026-06-15": { skip: true } } });
  const occ = expandRecurrences([r], "2026-06-01", "2026-06-22");
  assert.deepEqual(occ.map((o) => [o.dateISO, o.assignees[0]]),
    [["2026-06-01", 1], ["2026-06-08", 2], ["2026-06-22", 1]]);
});
