// 概要/統計ダッシュボードの集計（純関数・TDD対象）。store のタスク（time_estimate/time_spent/
// done/done_at/created/project_id/labels）だけで計算＝N+1なし。
import { shiftISO, dateOnly, hasDate, toH } from "./capacity.js";

// 日別スループット（追加 vs 完了）。todayISO を末尾に days 日ぶん。
// 返り値: [{ day, added, done }]（古い→新しい）
export function dailyThroughput(tasks, todayISO, days = 14) {
  const start = shiftISO(todayISO, -(days - 1));
  const map = new Map();
  for (let i = 0; i < days; i++) map.set(shiftISO(start, i), { added: 0, done: 0 });
  for (const t of tasks || []) {
    const c = hasDate(t.created) ? dateOnly(t.created) : "";
    if (map.has(c)) map.get(c).added++;
    if (t.done && hasDate(t.done_at)) {
      const d = dateOnly(t.done_at);
      if (map.has(d)) map.get(d).done++;
    }
  }
  return [...map.entries()].map(([day, v]) => ({ day, added: v.added, done: v.done }));
}

const r1 = (x) => Math.round(x * 100) / 100; // 時間表示=小数2桁

// プロジェクト別の見積り/実績/件数/完了数。
export function projectTotals(tasks) {
  const m = new Map();
  for (const t of tasks || []) {
    const e = m.get(t.project_id) || { projectId: t.project_id, estH: 0, spentH: 0, count: 0, done: 0 };
    e.estH += toH(t.time_estimate); e.spentH += toH(t.time_spent); e.count++; if (t.done) e.done++;
    m.set(t.project_id, e);
  }
  return [...m.values()].map((e) => ({ ...e, estH: r1(e.estH), spentH: r1(e.spentH) }));
}

// 分類（ラベル）別のタスク数（レビュー予約語は除外）。多い順。
export function labelTotals(tasks, excludeTitle = "レビュー") {
  const m = new Map();
  for (const t of tasks || []) for (const l of t.labels || []) {
    if (!l.title || l.title === excludeTitle) continue;
    m.set(l.title, (m.get(l.title) || 0) + 1);
  }
  return [...m.entries()].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count);
}

// 全体サマリーの数値（KPIカード用）。todayISO で今週(月起点)/期限切れを判定。
export function overallStats(tasks, todayISO) {
  const wkStart = weekStartISO(todayISO);
  let total = 0, done = 0, doneThisWeek = 0, open = 0, overdue = 0, flagged = 0, important = 0, estH = 0, spentH = 0;
  for (const t of tasks || []) {
    total++;
    estH += toH(t.time_estimate); spentH += toH(t.time_spent);
    if (t.done) {
      done++;
      if (hasDate(t.done_at) && dateOnly(t.done_at) >= wkStart) doneThisWeek++;
    } else {
      open++;
      const due = hasDate(t.due_date) ? dateOnly(t.due_date) : "";
      if (due && due < todayISO) overdue++;
      if (t.is_favorite) flagged++;
      if ((t.priority || 0) >= 3) important++;
    }
  }
  return {
    total, done, doneThisWeek, open, overdue, flagged, important,
    estH: r1(estH), spentH: r1(spentH),
    accuracy: estH > 0 ? spentH / estH : null, // 実績/見積り（1で一致）
  };
}

// 週の月曜（todayISO 基準・UTC）
export function weekStartISO(todayISO) {
  const dow = new Date(todayISO + "T00:00:00Z").getUTCDay(); // 0=日
  return shiftISO(todayISO, dow === 0 ? -6 : 1 - dow);
}
