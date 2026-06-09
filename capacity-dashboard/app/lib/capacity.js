// キャパ計算レイヤー（純関数・TDD対象）
// 入力は Vikunja のタスク/メンバー。time_estimate(秒) と time_spent(秒, フォーク) を使う。
// 日別の負荷は「タスク見積りを [start,end] 日数で日割り、due のみなら due 日に全量」。
// （フェーズ2で task_time_plans の明示的な日別予定に置換予定）

export const HOUR = 3600;
export const toH = (s) => (s || 0) / HOUR;
export const dateOnly = (d) => (d && typeof d === "string") ? d.slice(0, 10) : "";
export const hasDate = (d) => !!d && typeof d === "string" && !d.startsWith("0001");

export function inclusiveDays(isoA, isoB) {
  const n = Math.round((Date.parse(isoB) - Date.parse(isoA)) / 86400000) + 1;
  return n > 0 ? n : 1;
}
export function daysUntil(isoFrom, isoTo) {
  return Math.round((Date.parse(isoTo) - Date.parse(isoFrom)) / 86400000);
}
export function assigneeIds(task) { return (task.assignees || []).map((a) => a.id); }

// タスクが isoDay にアクティブか（未完了 かつ due==day もしくは start<=day<=end）
export function isActiveOn(task, isoDay) {
  if (task.done) return false;
  if (hasDate(task.due_date) && dateOnly(task.due_date) === isoDay) return true;
  if (hasDate(task.start_date) && hasDate(task.end_date)) {
    const st = dateOnly(task.start_date), en = dateOnly(task.end_date);
    if (st <= isoDay && isoDay <= en) return true;
  }
  return false;
}

// isoDay にこのタスクが要する見積り時間(h)。期間タスクは日割り。
export function taskHoursOn(task, isoDay) {
  if (task.done) return 0;
  const estH = toH(task.time_estimate);
  if (!estH) return 0;
  if (hasDate(task.start_date) && hasDate(task.end_date)) {
    const st = dateOnly(task.start_date), en = dateOnly(task.end_date);
    if (st <= isoDay && isoDay <= en) return estH / inclusiveDays(st, en);
  }
  if (hasDate(task.due_date) && dateOnly(task.due_date) === isoDay) return estH;
  return 0;
}

// 指定日の人別負荷
export function loadByMember(tasks, members, isoDay, capH = 8) {
  const map = new Map(members.map((m) => [m.id, { id: m.id, name: m.name || m.username, capH, assignedH: 0, tasks: [] }]));
  for (const t of tasks) {
    const h = taskHoursOn(t, isoDay);
    if (h <= 0) continue;
    for (const aid of assigneeIds(t)) {
      const row = map.get(aid);
      if (!row) continue;
      row.assignedH += h;
      row.tasks.push({ id: t.id, title: t.title, h });
    }
  }
  return [...map.values()].map((r) => ({
    ...r,
    assignedH: round1(r.assignedH),
    freeH: round1(Math.max(0, r.capH - r.assignedH)),
    overH: round1(Math.max(0, r.assignedH - r.capH)),
    status: r.assignedH > r.capH + 1e-6 ? "over" : (Math.abs(r.assignedH - r.capH) < 1e-6 ? "full" : "free"),
  }));
}

// 週（isoDays配列）の人別×日 負荷
export function weekLoadByMember(tasks, members, isoDays, capH = 8) {
  return members.map((m) => {
    const days = isoDays.map((day) => {
      let h = 0;
      for (const t of tasks) if (assigneeIds(t).includes(m.id)) h += taskHoursOn(t, day);
      return { day, h: round1(h), over: h > capH + 1e-6 };
    });
    return { id: m.id, name: m.name || m.username, capH, days, weekH: round1(days.reduce((s, d) => s + d.h, 0)) };
  });
}

// 見積り vs 実績（タスク別＋全体）
export function estimateVsActual(tasks) {
  const rows = tasks
    .filter((t) => (t.time_estimate || 0) > 0 || (t.time_spent || 0) > 0)
    .map((t) => {
      const estH = toH(t.time_estimate), actH = toH(t.time_spent);
      return { id: t.id, title: t.title, estH, actH, diff: estH ? (actH - estH) / estH : null,
               status: actH > estH ? "over" : (actH < estH ? "under" : "exact") };
    });
  const totEst = rows.reduce((s, r) => s + r.estH, 0);
  const totAct = rows.reduce((s, r) => s + r.actH, 0);
  return { rows, totEst: round1(totEst), totAct: round1(totAct), ratio: totEst ? totAct / totEst : null };
}

// トリアージ分類: 今日必須 / 今日やるべき / ずらせる（未完了タスク）
export function triage(tasks, isoDay) {
  return tasks.filter((t) => !t.done).map((t) => {
    const hasDue = hasDate(t.due_date);
    const slack = hasDue ? daysUntil(isoDay, dateOnly(t.due_date)) : null;
    let cls;
    if ((hasDue && slack <= 0) || (t.priority >= 4 && (slack === null || slack <= 0))) cls = "must";
    else if ((hasDue && slack <= 1) || t.priority >= 4) cls = "should";
    else cls = "movable";
    return { id: t.id, title: t.title, priority: t.priority || 0, due: hasDue ? dateOnly(t.due_date) : null,
             slack, cls, estH: toH(t.time_estimate) };
  });
}

// 予定/実績エントリ [{memberId, day:"YYYY-MM-DD", h}] を memberId -> day -> h に集計
export function sumByMemberDay(entries) {
  const m = {};
  for (const e of entries) {
    (m[e.memberId] ||= {});
    m[e.memberId][e.day] = round1((m[e.memberId][e.day] || 0) + e.h);
  }
  return m;
}

function round1(x) { return Math.round(x * 10) / 10; }
