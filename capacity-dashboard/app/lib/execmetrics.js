// 実行の歩留まり（ふりかえり）の純関数・TDD対象。
// 「やると決めた → 実際に実行したか」を store/exec の素データから測る。森田の本丸＝設計済み未実行を“数字”で可視化。
//   - stepDigestion: 今日(以前)が期日の段取り手順の消化率（done/total）。
//   - taskEngagement: 今日やるべきタスク（今日期日 or 今日plan・未完了）の着手率（＝踏み込めたか）。
//   - dailyExecSeries: 過去 N 日の日別実行量（完了数・実働h・触れたタスク数）＝勢いのトレンド。
// ※ 過去日の「やると決めた母数」はスナップショットしていないため、率は“今日”が対象。週はトレンド（記述）として見る。
import { toH, dateOnly, hasDate, hasStarted, shiftISO, daysUntil } from "./capacity.js";

const round1 = (x) => Math.round(x * 100) / 100;
const pctOf = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);

// 今日(以前)が期日の段取り手順の消化率。stepsByTask = { "<taskId>": [{due,done}, ...] }（exec /prep の steps_by_task）。
// total = due<=today の手順数 / done = うち完了。pct = done/total。
export function stepDigestion(stepsByTask, todayISO) {
  let total = 0, done = 0;
  for (const steps of Object.values(stepsByTask || {})) {
    for (const s of steps || []) {
      if (!s || !s.due || s.due > todayISO) continue; // 今日以前が期日の手順のみ
      total++;
      if (s.done) done++;
    }
  }
  return { total, done, pct: pctOf(done, total) };
}

// 今日やるべきタスクの着手率。対象 = 未完了 かつ（今日が期日 or 今日のplanがある）。
// 着手 = started_at あり or 進捗>0（hasStarted）。返り値の items に未着手対象も含める（拾い上げ用）。
export function taskEngagement(tasks, plansByTask, todayISO) {
  const plannedToday = (tid) => {
    const entries = plansByTask && (plansByTask.get ? plansByTask.get(tid) : plansByTask[tid]);
    return (entries || []).some((p) => dateOnly(p.plan_date) === todayISO);
  };
  let target = 0, engaged = 0;
  const items = [];
  for (const t of tasks || []) {
    if (t.done) continue; // 完了済みは対象外（もう終わっている）
    const dueToday = hasDate(t.due_date) && dateOnly(t.due_date) === todayISO;
    if (!dueToday && !plannedToday(t.id)) continue;
    target++;
    const eng = hasStarted(t);
    if (eng) engaged++;
    items.push({ id: t.id, title: t.title, engaged: !!eng, due: dueToday });
  }
  return { target, engaged, pct: pctOf(engaged, target), items };
}

// 過去 nDays（今日含む）の日別実行量。timeEntries = [{day:"YYYY-MM-DD", seconds, taskId}]（実績エントリを平坦化したもの）。
// completed = done_at がその日のタスク数 / workedH = その日の実働時間合計 / touched = その日に実働のあった distinct タスク数。
export function dailyExecSeries(tasks, timeEntries, todayISO, nDays = 14) {
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) days.push(shiftISO(todayISO, -i));
  const idx = new Map(days.map((d) => [d, { day: d, completed: 0, workedH: 0, _touched: new Set() }]));
  for (const e of timeEntries || []) {
    const r = e && idx.get(e.day);
    if (!r) continue;
    r.workedH += toH(e.seconds);
    if (e.taskId != null) r._touched.add(e.taskId);
  }
  for (const t of tasks || []) {
    if (t.done && hasDate(t.done_at)) {
      const r = idx.get(dateOnly(t.done_at));
      if (r) r.completed++;
    }
  }
  return days.map((d) => {
    const r = idx.get(d);
    return { day: d, completed: r.completed, workedH: round1(r.workedH), touched: r._touched.size };
  });
}

// 停滞タスク: 未完了 かつ「計画の意思あり」かつ thresholdDays 以上 何の動きも無いもの（＝レーダーから消えた設計済み未実行）。
//   「動き」= 実績(timeEntries.day) / 進捗ログ(activityLog.at) / 着手(started_at) / 作成(created＝基準) の最新日。
//   「計画の意思」= 期日 or 開始日 or 見積り>0 or 着手痕跡(started_at/percent>0) のいずれか（純未整理backlogは除外）。
//   timeEntries=[{day:"YYYY-MM-DD",taskId}]、activityLog=[{task_id,at}]。返り値は停滞日数の降順。
export function stalledTasks(tasks, timeEntries, activityLog, todayISO, { thresholdDays = 7 } = {}) {
  const last = new Map(); // taskId -> 最新活動日 "YYYY-MM-DD"
  const bump = (id, raw) => {
    if (id == null) return;
    const d = dateOnly(raw);
    if (!d || d.startsWith("0001")) return;
    const cur = last.get(id);
    if (!cur || d > cur) last.set(id, d);
  };
  for (const t of tasks || []) {
    bump(t.id, t.created);                    // 作成＝活動の基準（何もしなければ作成日が最終活動）
    if (hasDate(t.started_at)) bump(t.id, t.started_at);
  }
  for (const e of timeEntries || []) bump(e.taskId, e.day);
  for (const a of activityLog || []) bump(a.task_id, a.at);

  const out = [];
  for (const t of tasks || []) {
    if (t.done) continue;
    const committed = hasDate(t.due_date) || hasDate(t.start_date) || (t.time_estimate || 0) > 0 || hasStarted(t);
    if (!committed) continue;
    const lastISO = last.get(t.id) || null;
    if (!lastISO) continue;
    const days = daysUntil(lastISO, todayISO);
    if (days < thresholdDays) continue;
    out.push({
      id: t.id, title: t.title, days, lastISO,
      due: hasDate(t.due_date) ? dateOnly(t.due_date) : null,
      overdue: hasDate(t.due_date) && dateOnly(t.due_date) < todayISO,
    });
  }
  out.sort((a, b) => b.days - a.days || a.id - b.id);
  return out;
}
