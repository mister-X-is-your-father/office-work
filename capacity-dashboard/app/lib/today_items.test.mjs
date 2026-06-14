import { test } from "node:test";
import assert from "node:assert/strict";
import { todayItemsByMember, prioBucket } from "./today_items.js";

const DAY = "2026-06-08"; // 月曜

const data = {
  members: [{ id: 1, name: "A" }, { id: 2, name: "B" }],
  recurrences: [
    { title: "朝会", kind: "meeting", rrule: "FREQ=WEEKLY;BYDAY=MO", dtstart: "2026-06-01T00:00:00Z", duration_seconds: 1800, assignee_ids: [1] },
    { title: "棚卸し", kind: "task", rrule: "FREQ=WEEKLY;BYDAY=MO", dtstart: "2026-06-01T00:00:00Z", duration_seconds: 3600, assignee_ids: [1] },
  ],
  tasks: [
    // 予定(plan)あり・期日先 → 前倒し。優先度5→MUST。
    { id: 10, title: "API設計", priority: 5, assignees: [{ id: 1 }], due_date: "2026-06-20T00:00:00Z", created: "2026-06-01T09:00:00Z" },
    // 本日作成・本日期日 → 当日追加(adhoc)・見積り日割り1h。
    { id: 11, title: "緊急修正", priority: 4, assignees: [{ id: 1 }], due_date: "2026-06-08T00:00:00Z", created: "2026-06-08T09:00:00Z", time_estimate: 3600 },
  ],
  plansByTask: new Map([[10, [{ plan_date: "2026-06-08T00:00:00Z", seconds: 10800, user_id: 1 }]]]),
};

test("prioBucket: 0–5 → 0(なし)..4(MUST)", () => {
  assert.equal(prioBucket(5), 4);
  assert.equal(prioBucket(4), 4);
  assert.equal(prioBucket(3), 3);
  assert.equal(prioBucket(2), 2);
  assert.equal(prioBucket(1), 1);
  assert.equal(prioBucket(0), 0);          // なしは丸めず 0 のまま
  assert.equal(prioBucket(undefined), 0);
});

test("todayItemsByMember: 種別(kind)分類・並び・集計", () => {
  const map = todayItemsByMember(data, DAY, 8);
  const r = map.get(1);
  assert.equal(r.items.length, 4);
  // 並び: 会議 → 定例 → レビュー → タスク(優先度desc)
  assert.deepEqual(r.items.map((i) => i.kind), ["meeting", "recurring", "task", "task"]);
  assert.equal(r.items[0].title, "朝会");
  assert.equal(r.items[1].title, "棚卸し");
  // 集計: 0.5 + 1 + 3 + 1 = 5.5h
  assert.equal(r.usedH, 5.5);
  assert.equal(r.freeH, 2.5);
  assert.equal(r.overH, 0);
  assert.equal(r.status, "free");
});

test("todayItemsByMember: 前倒し・当日追加(flags)・優先度", () => {
  const r = todayItemsByMember(data, DAY, 8).get(1);
  const api = r.items.find((i) => i.title === "API設計");
  const urgent = r.items.find((i) => i.title === "緊急修正");
  assert.equal(api.kind, "task");
  assert.equal(api.flags.advanced, true);  // 期日6/20が先 → 前倒し
  assert.equal(api.flags.adhoc, false);    // 6/1作成
  assert.equal(api.prio, 4);               // priority5 → MUST
  assert.equal(urgent.kind, "task");
  assert.equal(urgent.flags.adhoc, true);  // 本日作成
  assert.equal(urgent.flags.advanced, false); // 期日が本日
});

test("todayItemsByMember: レビュー×当日追加は kind=review かつ flags.adhoc=true（軸が併存）", () => {
  const d = {
    members: [{ id: 1, name: "A" }],
    recurrences: [],
    tasks: [{ id: 1, title: "X のレビュー", priority: 2, assignees: [{ id: 1 }],
      due_date: "2026-06-08T00:00:00Z", created: "2026-06-08T09:00:00Z", time_estimate: 1800,
      labels: [{ title: "レビュー" }] }],
    plansByTask: new Map(),
  };
  const it = todayItemsByMember(d, DAY, 8).get(1).items[0];
  assert.equal(it.kind, "review");      // 種別=レビュー
  assert.equal(it.flags.adhoc, true);   // かつ 当日追加（旧モデルでは択一だった）
  assert.equal(it.flags.advanced, false);
});

test("todayItemsByMember: 超過判定", () => {
  const heavy = {
    members: [{ id: 1, name: "A" }],
    recurrences: [],
    tasks: [{ id: 1, title: "大作業", priority: 3, assignees: [{ id: 1 }], due_date: "2026-06-08T00:00:00Z", created: "2026-06-01T00:00:00Z", time_estimate: 36000 }], // 10h
    plansByTask: new Map(),
  };
  const r = todayItemsByMember(heavy, DAY, 8).get(1);
  assert.equal(r.usedH, 10);
  assert.equal(r.overH, 2);
  assert.equal(r.status, "over");
});

test("todayItemsByMember: 担当のないメンバーは空", () => {
  const r = todayItemsByMember(data, DAY, 8).get(2);
  assert.equal(r.items.length, 0);
  assert.equal(r.freeH, 8);
  assert.equal(r.status, "free");
});
