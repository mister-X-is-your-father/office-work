// キャパ計算レイヤー（純関数・TDD対象）
// 入力は TaskStation のタスク/メンバー。time_estimate(秒) と time_spent(秒, フォーク) を使う。
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

// plansByTask（Map or obj: taskId -> plan entries）から該当タスクの plan 配列を引く。
function planEntriesFor(plansByTask, taskId) {
  if (!plansByTask) return null;
  return (plansByTask.get ? plansByTask.get(taskId) : plansByTask[taskId]) || null;
}

// 【単一真実】タスクの isoDay 当日の予定負荷を memberId -> h で返す（#4）。
// plans があればその日の plan 秒を、無ければ見積り日割りを。いずれも担当者全員に「フル」（按分しない）。
// 特定の対象者(user_id, #3)が信頼できる場合はその1人にフル。done タスクは負荷ゼロ。
export function taskPlannedHoursByMemberOn(task, isoDay, planEntries) {
  const out = new Map();
  if (task.done) return out;
  const add = (mid, h) => { if (h > 0) out.set(mid, (out.get(mid) || 0) + h); };
  const aids = assigneeIds(task);
  if (planEntries && planEntries.length) {
    for (const e of planEntries) {
      if (dateOnly(e.plan_date) !== isoDay) continue;
      const h = toH(e.seconds), uid = e.user_id;
      if (uid && (aids.length === 0 || aids.includes(uid))) add(uid, h);
      else for (const aid of aids) add(aid, h); // 多担当=全員にフル
    }
  } else {
    const h = taskHoursOn(task, isoDay);
    if (h > 0) for (const aid of aids) add(aid, h); // 多担当=全員にフル
  }
  return out;
}

// 指定日の人別負荷。plansByTask を渡すと plans 優先（無いタスクは見積り日割り）。
export function loadByMember(tasks, members, isoDay, capH = 8, plansByTask = null) {
  const map = new Map(members.map((m) => [m.id, { id: m.id, name: m.name || m.username, capH, assignedH: 0, tasks: [] }]));
  for (const t of tasks) {
    const byMember = taskPlannedHoursByMemberOn(t, isoDay, planEntriesFor(plansByTask, t.id));
    for (const [mid, h] of byMember) {
      const row = map.get(mid);
      if (!row) continue;
      row.assignedH += h;
      row.tasks.push({ id: t.id, title: t.title, h: round1(h) });
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

// 週（isoDays配列）の人別×日 負荷。plansByTask を渡すと plans 優先。
export function weekLoadByMember(tasks, members, isoDays, capH = 8, plansByTask = null) {
  return members.map((m) => {
    const days = isoDays.map((day) => {
      let h = 0;
      for (const t of tasks) {
        const byMember = taskPlannedHoursByMemberOn(t, day, planEntriesFor(plansByTask, t.id));
        h += byMember.get(m.id) || 0;
      }
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

// ── ガント用（予実ガント） ──────────────────────────────────────────

// ISO日に n 日足す（UTC, "YYYY-MM-DD" 入出力）
export function shiftISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// タスクの予定/実績の範囲・合計を正規化（描画のフォールバック階層をここに閉じ込める）
// plans: [{plan_date, seconds}], times: [{logged_on, seconds}]
export function taskRanges(task, plans = [], times = []) {
  const estH = toH(task.time_estimate), spentH = toH(task.time_spent);
  // 予定: plans優先 → start/end → due点 → null
  let planned;
  const pdays = (plans || []).map((p) => dateOnly(p.plan_date)).filter(Boolean).sort();
  if (pdays.length) {
    planned = { start: pdays[0], end: pdays[pdays.length - 1],
                h: round1((plans || []).reduce((s, p) => s + toH(p.seconds), 0)), source: "plans" };
  } else if (hasDate(task.start_date) && hasDate(task.end_date)) {
    planned = { start: dateOnly(task.start_date), end: dateOnly(task.end_date), h: estH, source: "dates" };
  } else if (hasDate(task.due_date)) {
    planned = { start: dateOnly(task.due_date), end: dateOnly(task.due_date), h: estH, source: "due" };
  } else {
    planned = { start: null, end: null, h: 0, source: null };
  }
  // 実績: times の logged_on 範囲
  let actual;
  const tdays = (times || []).map((t) => dateOnly(t.logged_on)).filter(Boolean).sort();
  if (tdays.length) {
    actual = { start: tdays[0], end: tdays[tdays.length - 1],
               h: round1((times || []).reduce((s, t) => s + toH(t.seconds), 0)) };
  } else {
    actual = { start: null, end: null, h: 0 };
  }
  return { planned, actual, estH, spentH, percent: task.percent_done || 0, over: estH > 0 && spentH > estH };
}

// related_tasks を前向き辺リスト [{from, to, kind}] に正規化（時間的 前→後）
// precedes/blocks はそのまま、follows/blocked は反転。他kindは無視。重複・自己参照・片端欠落を除去。
export function dependencyEdges(tasks) {
  const ids = new Set((tasks || []).map((t) => t.id));
  const seen = new Set(), edges = [];
  for (const t of tasks || []) {
    const rt = t.related_tasks || {};
    for (const [kind, arr] of Object.entries(rt)) {
      for (const rel of arr || []) {
        let from, to;
        if (kind === "precedes" || kind === "blocks") { from = t.id; to = rel.id; }
        else if (kind === "follows" || kind === "blocked") { from = rel.id; to = t.id; }
        else continue;
        if (from === to || !ids.has(from) || !ids.has(to)) continue;
        const key = `${from}->${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to, kind: kind === "blocks" || kind === "blocked" ? "blocks" : "precedes" });
      }
    }
  }
  return edges;
}

// related_tasks.subtask から親子フォレストを構築。返り値: [{task, children:[...]}]。
// ルート=どの subtask にもならないタスク。循環は guard で打ち切り。
export function buildTaskTree(tasks) {
  const list = tasks || [];
  const byId = new Map(list.map((t) => [t.id, t]));
  const childIds = new Set();
  const childrenOf = new Map();
  for (const t of list) {
    const ids = (((t.related_tasks || {}).subtask) || []).map((s) => s.id).filter((id) => byId.has(id) && id !== t.id);
    childrenOf.set(t.id, ids);
    ids.forEach((id) => childIds.add(id));
  }
  const seen = new Set();
  const node = (t) => {
    if (!t || seen.has(t.id)) return { task: t, children: [] };
    seen.add(t.id);
    return { task: t, children: (childrenOf.get(t.id) || []).map((id) => node(byId.get(id))) };
  };
  return list.filter((t) => !childIds.has(t.id)).map(node);
}

// 日付軸スケール器。startISO から days 日の窓。列index と範囲→span を返す。
export function dayScale(startISO, days) {
  const axis = [];
  for (let i = 0; i < days; i++) {
    const iso = shiftISO(startISO, i);
    const dow = new Date(iso + "T00:00:00Z").getUTCDay();
    axis.push({ iso, dow, weekend: dow === 0 || dow === 6, isToday: (t) => t === iso });
  }
  const indexOf = (iso) => daysUntil(startISO, iso);
  const clamp = (i) => Math.max(0, Math.min(days - 1, i));
  const range = (startIso, endIso) => {
    const a = indexOf(startIso), b = indexOf(endIso);
    const fromIdx = clamp(a), toIdx = clamp(b);
    return { fromIdx, toIdx, span: Math.max(1, toIdx - fromIdx + 1),
             clippedLeft: a < 0, clippedRight: b > days - 1 };
  };
  // 窓と交差するか（範囲が窓に少しでも重なるか）
  const intersects = (startIso, endIso) => indexOf(endIso) >= 0 && indexOf(startIso) <= days - 1;
  return { startISO, days, axis, indexOf, range, intersects };
}

// [[task, entries], ...] を [{memberId, day, h}] に。
// 帰属（#3 ADR-009）: entry.user_id（対象者）が信頼できる時はそのまま全量を帰属、
// それ以外（user_id 未設定 or 非assignee=代理の旧データ）は担当者へ按分（従来挙動）。
// kind: "plan" → entries は {plan_date, seconds, user_id} / "time" → {logged_on, seconds, user_id}
export function toMemberDayEntries(taskPairs, kind) {
  const dateKey = kind === "plan" ? "plan_date" : "logged_on";
  const out = [];
  for (const [task, entries] of taskPairs || []) {
    const aids = (task.assignees || []).map((a) => a.id);
    for (const e of entries || []) {
      const day = dateOnly(e[dateKey]);
      if (!day) continue;
      const hTotal = toH(e.seconds);
      const uid = e.user_id;
      if (uid && (aids.length === 0 || aids.includes(uid))) {
        out.push({ memberId: uid, day, h: hTotal }); // 対象者そのものに全量
      } else if (aids.length) {
        for (const aid of aids) out.push({ memberId: aid, day, h: hTotal }); // 多担当=全員にフル（按分しない・#4）
      }
    }
  }
  return out;
}

function round1(x) { return Math.round(x * 10) / 10; }
