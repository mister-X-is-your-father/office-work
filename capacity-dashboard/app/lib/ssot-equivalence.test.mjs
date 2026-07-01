// 敵対的等価性の回帰テスト: 横断品質スイープで集約した SSoT 関数が、集約前の元インライン実装と
// 境界値・異常値で完全一致し続けることを保証する（将来の改修で SSoT がドリフトしたら落ちる）。
// 由来: 2026-07-01 の整合性 敵対テスト（516 checks 全合格）を回帰用に恒久化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { capStatus, dueISO, shiftISO, hasDate, dateOnly, toMemberDayEntries, todayISO, planEntriesFor } from "./capacity.js";
import { statePatchFor } from "./taskstate.js";
import { snapshotTask } from "./tasksnapshot.js";
import { firstHuman, humanAssignees, isAiUser } from "./users.js";

test("capStatus == 元の loadByMember/today_items 三項式（境界1e-6・offplan含む）", () => {
  const orig = (load, cap, off) => cap <= 1e-6
    ? (off ? "offplan" : "off")
    : (load > cap + 1e-6 ? "over" : (Math.abs(load - cap) < 1e-6 ? "full" : "free"));
  const caps = [0, -1, 1e-7, 1e-6, 2e-6, 1, 8, 8.0000001, 100];
  const loads = [0, -5, 1e-7, 7.999999, 7.9999999, 8, 8.0000001, 8.5, 16, 0.0000005];
  for (const cap of caps) for (const load of loads) for (const off of [true, false]) {
    assert.equal(capStatus(load, cap, off), orig(load, cap, off), `capStatus(${load},${cap},${off})`);
  }
});

test("statePatchFor == 元の table(false)/kanban(true) インライン patch", () => {
  const NOW = "2026-07-01T05:00:00.000Z";
  const oTable = (key, t) => {
    const keepPct = (t.done || (t.percent_done || 0) >= 100) ? 0 : (t.percent_done || 0);
    return key === "done" ? { done: true, percent_done: 100 }
      : key === "doing" ? { done: false, percent_done: keepPct, started_at: NOW }
      : { done: false, percent_done: 0, started_at: null };
  };
  const oKan = (key, t) => {
    const keepPct = (t.done || (t.percent_done || 0) >= 100) ? 0 : (t.percent_done || 0);
    if (key === "done") return { done: true, percent_done: 100, started_at: t.started_at || null };
    if (key === "doing") return { done: false, percent_done: keepPct, started_at: NOW };
    return { done: false, percent_done: 0, started_at: null };
  };
  const tasks = [
    {}, { done: true }, { percent_done: 0 }, { percent_done: 50 }, { percent_done: 100 },
    { percent_done: 101 }, { percent_done: -5 }, { percent_done: NaN }, { done: true, percent_done: 100 },
    { done: true, percent_done: 30 }, { done: false, percent_done: 100 }, { started_at: "2026-06-20T00:00:00Z" },
    { started_at: undefined, percent_done: 40 }, { done: true, percent_done: 100, started_at: "x" },
  ];
  for (const t of tasks) for (const key of ["todo", "doing", "done"]) {
    assert.deepEqual(statePatchFor(key, t, { now: () => NOW }), oTable(key, t), `table ${key} ${JSON.stringify(t)}`);
    assert.deepEqual(statePatchFor(key, t, { keepStartedOnDone: true, now: () => NOW }), oKan(key, t), `kanban ${key} ${JSON.stringify(t)}`);
  }
  assert.deepEqual(statePatchFor("todo", null, { now: () => "N" }), { done: false, percent_done: 0, started_at: null });
});

test("snapshotTask == 元の snapshot（0001センチネル/waiting/欠落値）", () => {
  const ZERO = "0001-01-01T00:00:00Z";
  const orig = (t) => ({
    id: t.id, done: !!t.done, percent_done: t.percent_done || 0, started_at: t.started_at || null,
    priority: t.priority || 0, is_favorite: !!t.is_favorite,
    due_date: (t.due_date && !t.due_date.startsWith("0001")) ? t.due_date : ZERO,
    waiting: (t.labels || []).some((l) => (l.title || "") === "連絡待ち"),
    assignees: (t.assignees || []).map((a) => a.id), labels: (t.labels || []).map((l) => l.id),
  });
  const inputs = [
    { id: 1 }, { id: 3, due_date: ZERO }, { id: 4, due_date: "0001-05-05T00:00:00Z" }, { id: 5, due_date: "" },
    { id: 6, due_date: null }, { id: 7, labels: [{ id: 1, title: "重要" }] }, { id: 8, labels: [{ title: "連絡待ち" }] },
    { id: 2, done: true, percent_done: 100, started_at: "2026-06-20T00:00:00Z", priority: 4, is_favorite: true, due_date: "2026-06-30T00:00:00Z", assignees: [{ id: 1 }, { id: 2 }], labels: [{ id: 10, title: "連絡待ち" }, { id: 11, title: "x" }] },
  ];
  for (const t of inputs) assert.deepEqual(snapshotTask(t), orig(t), JSON.stringify(t));
});

test("dueISO == 元の hasDate(d)?dateOnly(d):\"\"（||null 版も）", () => {
  const dues = [null, undefined, "", "0001-01-01T00:00:00Z", "0001-12-31T23:59:59Z", "2026-06-30T12:00:00Z", "2026-06-30", "garbage", 12345];
  for (const d of dues) {
    assert.equal(dueISO(d), hasDate(d) ? dateOnly(d) : "", `dueISO ${JSON.stringify(d)}`);
    assert.equal(dueISO(d) || null, hasDate(d) ? dateOnly(d) : null, `dueISO||null ${JSON.stringify(d)}`);
  }
});

test("shiftISO == 元の addDays（UTCアンカー・月跨ぎ/閏年）", () => {
  const orig = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  for (const iso of ["2026-06-30", "2026-01-01", "2026-12-31", "2024-02-28", "2024-02-29", "2026-02-28", "2026-03-01"])
    for (const n of [0, 1, -1, 6, -6, 7, 30, -30, 365, -365, 100])
      assert.equal(shiftISO(iso, n), orig(iso, n), `shiftISO(${iso},${n})`);
});

test("firstHuman/humanAssignees == 元の find/filter(!isAiUser)", () => {
  const sets = [
    undefined, [], [{ username: "fable" }], [{ id: 1, username: "morita" }],
    [{ id: 9, username: "fable" }, { id: 1, username: "morita" }],
    [{ id: 1, username: "morita" }, { id: 9, username: "fable" }],
    [{ id: 9, username: "fable" }, { id: 8, username: "fable" }], [{}], [{ username: null }],
  ];
  for (const as of sets) {
    const t = { assignees: as };
    assert.deepEqual(firstHuman(t), (t.assignees || []).find((a) => !isAiUser(a)) || null, `firstHuman ${JSON.stringify(as)}`);
    assert.deepEqual(humanAssignees(t), (t.assignees || []).filter((a) => !isAiUser(a)), `humanAssignees ${JSON.stringify(as)}`);
  }
});

test("toMemberDayEntries == 元の planner collectPlannedEntries/attribute", () => {
  const oAttr = (t, e, dateKey) => {
    const out = [], aids = (t.assignees || []).map((a) => a.id), day = dateOnly(e[dateKey]);
    if (!day) return out;
    const h = (e.seconds || 0) / 3600, uid = e.user_id;
    if (uid && (aids.length === 0 || aids.includes(uid))) out.push({ memberId: uid, day, h });
    else for (const aid of aids) out.push({ memberId: aid, day, h });
    return out;
  };
  const scen = [
    { t: { assignees: [{ id: 1 }, { id: 2 }] }, e: { plan_date: "2026-06-30T00:00:00Z", seconds: 3600, user_id: 1 } },
    { t: { assignees: [{ id: 1 }, { id: 2 }] }, e: { plan_date: "2026-06-30T00:00:00Z", seconds: 7200, user_id: null } },
    { t: { assignees: [] }, e: { plan_date: "2026-06-30T00:00:00Z", seconds: 3600, user_id: 5 } },
    { t: { assignees: [] }, e: { plan_date: "2026-06-30T00:00:00Z", seconds: 3600, user_id: null } },
    { t: { assignees: [{ id: 1 }] }, e: { plan_date: "2026-06-30T00:00:00Z", seconds: 3600, user_id: 9 } },
    { t: { assignees: [{ id: 1 }] }, e: { plan_date: "", seconds: 3600, user_id: 1 } },
  ];
  for (const { t, e } of scen) assert.deepEqual(toMemberDayEntries([[t, [e]]], "plan"), oAttr(t, e, "plan_date"), JSON.stringify(e));
});

test("planEntriesFor == 元の today_items ローカル版（Map/obj/null）", () => {
  const orig = (pbt, id) => pbt ? ((pbt.get ? pbt.get(id) : pbt[id]) || null) : null;
  const cases = [null, undefined, new Map([[7, [{ x: 1 }]]]), { 7: [{ x: 1 }] }, new Map(), {}, new Map([[7, null]])];
  for (const pbt of cases) for (const id of [7, 99]) assert.deepEqual(planEntriesFor(pbt, id), orig(pbt, id));
});

test("todayISO はローカル暦日（UTCの toISOString ではない）", () => {
  const d = new Date();
  assert.equal(todayISO(), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});
