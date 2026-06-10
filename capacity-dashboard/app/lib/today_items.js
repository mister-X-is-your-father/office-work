// 本日の稼働予定（円時計ビュー）用の整形レイヤー（純関数・TDD対象）。
// タスク(予定/見積り日割り)＋会議/定例(RRULE展開)を統合し、メンバー別にカテゴリ・優先度・前倒し付きで列挙。
// 並び: 会議 → 定例 → 予定タスク(優先度 最優先→低)。色/模様はビュー側。
import { toH, dateOnly, hasDate, taskPlannedHoursByMemberOn, assigneeIds, shiftISO } from "./capacity.js";
import { expandRecurrences, occurrenceLoadEntries, freeByMemberDay } from "./recurrence.js";

const round1 = (x) => Math.round(x * 10) / 10;
const planEntriesFor = (plansByTask, id) =>
  plansByTask ? ((plansByTask.get ? plansByTask.get(id) : plansByTask[id]) || null) : null;

// Vikunja priority(0–5) → 4段バケット: 4=最優先 / 3=高 / 2=中 / 1=低
export function prioBucket(p) {
  const n = p || 0;
  if (n >= 4) return 4;
  if (n === 3) return 3;
  if (n === 2) return 2;
  return 1;
}

// 前倒し: 本日に予定(plan)があり、かつ期日が本日より先。
function isAdvanced(task, planEntries, isoDay) {
  if (!hasDate(task.due_date)) return false;
  const due = dateOnly(task.due_date);
  if (!(due > isoDay)) return false;
  return (planEntries || []).some((e) => dateOnly(e.plan_date) === isoDay);
}

const REVIEW_LABEL = "レビュー";
const isReviewTask = (t) => (t.labels || []).some((l) => (l.title || "") === REVIEW_LABEL);
const CRANK = { meeting: 0, recurring: 1, review: 2, planned: 3, adhoc: 3 };

// data: { tasks, members, plansByTask, recurrences }
// 返り値: Map<memberId, { member, items:[{taskId?,title,h,cat,prio,advanced}], usedH, freeH, overH, status }>
export function todayItemsByMember(data, isoDay, capH = 8) {
  const { tasks = [], members = [], plansByTask = null, recurrences = [] } = data || {};
  const map = new Map(members.map((m) => [m.id, { member: m, items: [], usedH: 0 }]));
  const push = (mid, item) => { const r = map.get(mid); if (r) { r.items.push(item); r.usedH += item.h; } };

  // 通常タスク（予定 or 見積り日割り）
  for (const t of tasks) {
    const planEntries = planEntriesFor(plansByTask, t.id);
    const byMember = taskPlannedHoursByMemberOn(t, isoDay, planEntries);
    if (!byMember.size) continue;
    const adhoc = hasDate(t.created) && dateOnly(t.created) === isoDay;
    const advanced = isAdvanced(t, planEntries, isoDay);
    const cat = isReviewTask(t) ? "review" : (adhoc ? "adhoc" : "planned");
    for (const [mid, h] of byMember) {
      push(mid, { taskId: t.id, title: t.title, h: round1(h), cat, prio: prioBucket(t.priority), advanced });
    }
  }

  // 会議/定例（本日に展開した occurrence）
  for (const { recurrence, dateISO } of expandRecurrences(recurrences, isoDay, isoDay)) {
    if (dateISO !== isoDay) continue;
    const h = round1(toH(recurrence.duration_seconds));
    if (h <= 0) continue;
    const cat = recurrence.kind === "meeting" ? "meeting" : "recurring";
    const title = recurrence.title || (cat === "meeting" ? "会議" : "定例");
    for (const uid of recurrence.assignee_ids || []) {
      push(uid, { title, h, cat, prio: null, advanced: false });
    }
  }

  // 並べ替え＋集計
  for (const r of map.values()) {
    r.items.sort((a, b) => (CRANK[a.cat] - CRANK[b.cat]) || ((b.prio || 0) - (a.prio || 0)));
    r.usedH = round1(r.usedH);
    r.freeH = round1(Math.max(0, capH - r.usedH));
    r.overH = round1(Math.max(0, r.usedH - capH));
    r.capH = capH;
    r.status = r.usedH > capH + 1e-6 ? "over" : (Math.abs(r.usedH - capH) < 1e-6 ? "full" : "free");
  }
  return map;
}

// isoDays(両端含む)の連番を返す（最大maxで打ち切り）。
export function daysBetween(fromISO, toISO, max = 45) {
  const out = [];
  let d = fromISO;
  while (d <= toISO && out.length < max) { out.push(d); d = shiftISO(d, 1); }
  return out;
}

// ウィンドウ内のメンバー×日 空き（タスク負荷＋会議/定例負荷を合算）。freefinder と同じ計算。
export function freeWindow(data, isoDays, capH = 8) {
  const { tasks = [], members = [], plansByTask = null, recurrences = [], holidaysSet, unavailabilityByMember } = data || {};
  const taskLoad = [];
  for (const t of tasks) {
    const plans = planEntriesFor(plansByTask, t.id);
    for (const day of isoDays) {
      for (const [mid, h] of taskPlannedHoursByMemberOn(t, day, plans)) taskLoad.push({ memberId: mid, day, h });
    }
  }
  const occLoad = isoDays.length
    ? occurrenceLoadEntries(expandRecurrences(recurrences, isoDays[0], isoDays[isoDays.length - 1]))
    : [];
  return freeByMemberDay(members, isoDays, [taskLoad, occLoad], { holidays: holidaysSet, unavailabilityByMember, capH });
}

// あるメンバーが neededH を入れられる候補日を [fromISO, toISO] から提案（収まる日優先→空き多い順）。
// 週末/祝日/休暇(off)・超過日は除外。返り値: [{day, freeH, fits}]
export function suggestDays(data, memberId, fromISO, toISO, neededH, capH = 8) {
  if (toISO < fromISO) return [];
  const days = daysBetween(fromISO, toISO);
  const dm = freeWindow(data, days, capH).get(memberId);
  if (!dm) return [];
  const out = [];
  for (const day of days) {
    const cell = dm.get(day);
    if (!cell || cell.status === "off" || cell.status === "over" || cell.freeH <= 0) continue;
    out.push({ day, freeH: cell.freeH, fits: cell.freeH >= neededH - 1e-6 });
  }
  out.sort((a, b) => (b.fits - a.fits) || (b.freeH - a.freeH) || (a.day < b.day ? -1 : 1));
  return out;
}
