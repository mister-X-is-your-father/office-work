// 今日の稼働予定（円時計ビュー）用の整形レイヤー（純関数・TDD対象）。
// タスク(予定/見積り日割り)＋会議/定例(RRULE展開)を統合し、メンバー別に WorkItem として列挙。
// WorkItem は「種別(kind) × 時間属性(flags: adhoc/advanced)」の2軸（ADR-012）。色/模様はビュー側。
// 並び: 会議 → 定例 → レビュー → タスク(重要度 MUST→低)。
import { toH, dateOnly, hasDate, taskPlannedHoursByMemberOn, assigneeIds, shiftISO } from "./capacity.js";
import { expandRecurrences, occurrenceLoadEntries, freeByMemberDay, capacityOn } from "./recurrence.js";
import { kindOf, kindRank, prioBucket, isReviewTask } from "./kinds.js";

// 後方互換の再export（既存の import 元を壊さない）
export { prioBucket, isReviewTask };

const round1 = (x) => Math.round(x * 100) / 100; // 時間表示=小数2桁
const planEntriesFor = (plansByTask, id) =>
  plansByTask ? ((plansByTask.get ? plansByTask.get(id) : plansByTask[id]) || null) : null;

// 前倒し: 今日に予定(plan)があり、かつ期限が今日より先。
function isAdvanced(task, planEntries, isoDay) {
  if (!hasDate(task.due_date)) return false;
  const due = dateOnly(task.due_date);
  if (!(due > isoDay)) return false;
  return (planEntries || []).some((e) => dateOnly(e.plan_date) === isoDay);
}

// data: { tasks, members, plansByTask, recurrences }
// 返り値: Map<memberId, { member, items:[{taskId?,title,h,kind,prio,flags:{adhoc,advanced}}], usedH, freeH, overH, status }>
export function todayItemsByMember(data, isoDay, capH = 8) {
  const { tasks = [], members = [], plansByTask = null, recurrences = [], holidaysSet, unavailabilityByMember } = data || {};
  const map = new Map(members.map((m) => [m.id, { member: m, items: [], usedH: 0 }]));
  const push = (mid, item) => { const r = map.get(mid); if (r) { r.items.push(item); r.usedH += item.h; } };

  // 通常タスク／レビュー（予定 or 見積り営業日割り）。kind=種別, flags=時間属性。
  for (const t of tasks) {
    const planEntries = planEntriesFor(plansByTask, t.id);
    const byMember = taskPlannedHoursByMemberOn(t, isoDay, planEntries, { holidays: holidaysSet });
    if (!byMember.size) continue;
    const kind = kindOf(t); // 'review' | 'task'
    const flags = {
      adhoc: hasDate(t.created) && dateOnly(t.created) === isoDay,
      advanced: isAdvanced(t, planEntries, isoDay),
    };
    for (const [mid, h] of byMember) {
      push(mid, { taskId: t.id, title: t.title, h: round1(h), kind, prio: prioBucket(t.priority), flags });
    }
  }

  // 会議/定例（今日に展開した occurrence）。重要度なし・時間属性なし。
  // 持ち回りは expandRecurrences が assignees をその回の担当1名に解決済み。
  for (const { recurrence, dateISO, assignees, override } of expandRecurrences(recurrences, isoDay, isoDay)) {
    if (dateISO !== isoDay) continue;
    const h = round1(toH((override && override.duration_seconds) || recurrence.duration_seconds));
    if (h <= 0) continue;
    const kind = recurrence.kind === "meeting" ? "meeting" : "recurring";
    const title = recurrence.title || (kind === "meeting" ? "会議" : "定例");
    for (const uid of assignees || recurrence.assignee_ids || []) {
      push(uid, { title, h, kind, prio: null, flags: { adhoc: false, advanced: false } });
    }
  }

  // 並べ替え＋集計。容量は人別（週末/祝日/休暇=0＝capacityOn）で今日KPIを正確に。
  for (const r of map.values()) {
    r.items.sort((a, b) => (kindRank(a.kind) - kindRank(b.kind)) || ((b.prio || 0) - (a.prio || 0)));
    r.usedH = round1(r.usedH);
    const memCap = capacityOn(r.member, isoDay, { holidays: holidaysSet, unavailabilityByMember, capH });
    r.freeH = round1(Math.max(0, memCap - r.usedH));
    r.overH = round1(Math.max(0, r.usedH - memCap));
    r.capH = memCap;
    // capH=0（週末/祝日/休暇）: 負荷ありは衝突='over'、無ければ'off'。
    r.status = memCap <= 1e-6
      ? (r.usedH > 1e-6 ? "over" : "off")
      : (r.usedH > memCap + 1e-6 ? "over" : (Math.abs(r.usedH - memCap) < 1e-6 ? "full" : "free"));
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
