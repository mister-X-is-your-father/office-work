// キャパ計算レイヤー（純関数・TDD対象）
// 入力は TaskStation のタスク/メンバー。time_estimate(秒) と time_spent(秒, フォーク) を使う。
// 日別の負荷は「タスク見積りを [start,end] 日数で日割り、due のみなら due 日に全量」。
// （フェーズ2で task_time_plans の明示的な日別予定に置換予定）

export const HOUR = 3600;
export const toH = (s) => (s || 0) / HOUR;
export const dateOnly = (d) => (d && typeof d === "string") ? d.slice(0, 10) : "";
export const hasDate = (d) => !!d && typeof d === "string" && !d.startsWith("0001");
// 期限などの "YYYY-MM-DD"。未設定/空日付センチネルは ""。各所の hasDate(due)?dateOnly(due):"" の SSoT。
export const dueISO = (d) => hasDate(d) ? dateOnly(d) : "";
// アプリ全体の「今日」の SSoT。ローカル暦日の "YYYY-MM-DD"。
// （new Date().toISOString() は UTC なので JST 早朝に前日へズレる＝使わない）
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// 空日付センチネル（hasDate が false を返す値）。各所のリテラル "0001-01-01T00:00:00Z" の SSoT。
export const EMPTY_DATE = "0001-01-01T00:00:00Z";
// 曜日番号（0=日..6=土、UTC統一）。各 lib/view の自前 new Date(iso).getUTCDay() を集約。
export const dowOf = (isoDay) => new Date(isoDay + "T00:00:00Z").getUTCDay();
// 着手済み判定（=進行中）。started_at（着手時刻・BE実カラム）が立っていれば進行中。
// percent_done>0 も OR で拾う（外部クライアント編集や旧データで進捗だけ入っているケースの保険）。
export const hasStarted = (t) => hasDate(t.started_at) || (t.percent_done || 0) > 0;

export function inclusiveDays(isoA, isoB) {
  const n = Math.round((Date.parse(isoB) - Date.parse(isoA)) / 86400000) + 1;
  return n > 0 ? n : 1;
}
// 営業日判定: 土日 と（渡されれば）祝日を除く。holidays は Set<"YYYY-MM-DD"> 想定。
export function isBusinessDay(iso, holidays = null) {
  const dow = dowOf(iso);
  if (dow === 0 || dow === 6) return false;
  if (holidays && holidays.has && holidays.has(iso)) return false;
  return true;
}
// [isoA,isoB] inclusive の営業日数（土日祝除く）。0=全期間が休日。
export function businessDays(isoA, isoB, holidays = null) {
  let n = 0;
  for (let cur = isoA, i = 0; cur <= isoB && i < 4000; cur = shiftISO(cur, 1), i++) {
    if (isBusinessDay(cur, holidays)) n++;
  }
  return n;
}
export function daysUntil(isoFrom, isoTo) {
  return Math.round((Date.parse(isoTo) - Date.parse(isoFrom)) / 86400000);
}
export function assigneeIds(task) { return (task.assignees || []).map((a) => a.id); }

// isoDay にこのタスクが要する見積り時間(h)。期間タスクは**営業日割り**（土日祝に負荷を載せず、
// 平日のみで等分＝週末に負荷が漏れない）。holidays(Set) を渡すと祝日も休みとして除外。
// isoDay が [start,end] 内の営業日のとき estH を営業日数で等分（isoDay 自身が営業日＝営業日数≥1 で0除算しない）。
export function taskHoursOn(task, isoDay, { holidays = null } = {}) {
  if (task.done) return 0;
  const estH = toH(task.time_estimate);
  if (!estH) return 0;
  if (hasDate(task.start_date) && hasDate(task.end_date)) {
    const st = dateOnly(task.start_date), en = dateOnly(task.end_date);
    if (st <= isoDay && isoDay <= en) {
      if (!isBusinessDay(isoDay, holidays)) return 0; // 土日祝には負荷を載せない
      const bd = businessDays(st, en, holidays);
      return estH / bd; // isoDay が営業日なので bd≥1（旧 bd>0 三項は到達不能な else を持っていた）
    }
  }
  if (hasDate(task.due_date) && dateOnly(task.due_date) === isoDay) return estH;
  return 0;
}

// plansByTask（Map or obj: taskId -> plan entries）から該当タスクの plan 配列を引く。
export function planEntriesFor(plansByTask, taskId) {
  if (!plansByTask) return null;
  return (plansByTask.get ? plansByTask.get(taskId) : plansByTask[taskId]) || null;
}

// 【単一真実】タスクの isoDay 当日の予定負荷を memberId -> h で返す（#4）。
// plans があればその日の plan 秒を、無ければ見積り日割りを。いずれも担当者全員に「フル」（按分しない）。
// 特定の対象者(user_id, #3)が信頼できる場合はその1人にフル。done タスクは負荷ゼロ。
export function taskPlannedHoursByMemberOn(task, isoDay, planEntries, { holidays = null } = {}) {
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
    const h = taskHoursOn(task, isoDay, { holidays }); // 見積りフォールバックは営業日割り
    if (h > 0) for (const aid of aids) add(aid, h); // 多担当=全員にフル
  }
  return out;
}

// 人別の負荷ステータス判定の SSoT（loadH/capH/offplan → "off"|"offplan"|"over"|"full"|"free"）。
// loadByMember と today_items（todayItemsByMember）が同一基準を使う。
// ※ recurrence.js の full は round1 後の freeH<=1e-6 を見るため基準が異なる＝別物として独立維持（統合しない）。
export function capStatus(loadH, capH, offplan) {
  if (capH <= 1e-6) return offplan ? "offplan" : "off";
  if (loadH > capH + 1e-6) return "over";
  if (Math.abs(loadH - capH) < 1e-6) return "full";
  return "free";
}

// 指定日の人別負荷。plansByTask を渡すと plans 優先（無いタスクは見積り営業日割り）。
// opts.holidays(Set): 見積り割りで祝日を除外。opts.capacityFor(member,isoDay): 人別の容量
//   （週末/祝日/休暇=0 等）。未指定なら scalar capH を全員一律で使用（従来挙動）。
export function loadByMember(tasks, members, isoDay, capH = 8, plansByTask = null, { holidays = null, capacityFor = null } = {}) {
  const capOf = (m) => (capacityFor ? capacityFor(m, isoDay) : capH);
  const map = new Map(members.map((m) => [m.id, { id: m.id, name: m.name || m.username, capH: capOf(m), assignedH: 0, tasks: [] }]));
  for (const t of tasks) {
    const byMember = taskPlannedHoursByMemberOn(t, isoDay, planEntriesFor(plansByTask, t.id), { holidays });
    for (const [mid, h] of byMember) {
      const row = map.get(mid);
      if (!row) continue;
      row.assignedH += h;
      row.tasks.push({ id: t.id, title: t.title, h: round1(h) });
    }
  }
  return [...map.values()].map((r) => {
    // capH=0（週末/祝日/休暇）に負荷がある＝「非稼働日に予定」(offplan)。平日の過負荷('over')とは
    // 別状態として扱う＝解決策が「減らす(再配分)」でなく「稼働日へ移す」なので、overH(=要再配分量)には
    // 混ぜない（overH=0）。移動を促すための負荷量は assignedH を見れば分かる。
    const offplan = r.capH <= 1e-6 && r.assignedH > 1e-6;
    return {
      ...r,
      assignedH: round1(r.assignedH),
      freeH: round1(Math.max(0, r.capH - r.assignedH)),
      overH: offplan ? 0 : round1(Math.max(0, r.assignedH - r.capH)),
      // status は表示と同じ round1 済の値で判定（today_items と一貫）。生値だと「割当8/容量8/
      // 空き0/超過0 なのに生8.004 で status=over」という説明不能な境界表示が出るため。
      status: capStatus(round1(r.assignedH), r.capH, offplan),
    };
  });
}

// 【F1 横断逆算の実空き源】指定メンバーが各日に既にコミット済みの予定負荷(h) を
// Map<"YYYY-MM-DD", h> で返す。逆算が「他タスクで既に埋まっている分」を差し引くのに使う。
//   範囲は [fromIso, toIso] inclusive（逆算窓ぶんだけ・全カレンダー走査を避ける）。
//   plans 優先（無ければ見積り営業日割り＝loadByMember と同じ単一真実 #4）。
//   excludeTaskId（=逆算対象タスク自身）と done タスクは除外。多担当はそのメンバーにフル（按分しない）。
export function committedHoursByDayInRange(tasks, plansByTask, memberId, fromIso, toIso, { excludeTaskId = null, holidays = null } = {}) {
  const out = new Map();
  if (!fromIso || !toIso || memberId == null || fromIso > toIso) return out;
  const days = [];
  for (let cur = fromIso, i = 0; cur <= toIso && i < 4000; cur = shiftISO(cur, 1), i++) days.push(cur);
  for (const t of tasks || []) {
    if (excludeTaskId != null && t.id === excludeTaskId) continue;
    if (t.done) continue;
    const entries = planEntriesFor(plansByTask, t.id);
    for (const day of days) {
      const h = taskPlannedHoursByMemberOn(t, day, entries, { holidays }).get(memberId) || 0;
      if (h > 0) out.set(day, round1((out.get(day) || 0) + h));
    }
  }
  return out;
}

// 週（isoDays配列）の人別×日 負荷。plansByTask を渡すと plans 優先。
// opts.holidays(Set): 見積り営業日割りで祝日を除外。
// 最適化(C8): 旧実装は members×days×tasks の三重走査で taskPlannedHoursByMemberOn を
// メンバー数ぶん再計算していた（返るマップは全メンバー分なのに 1メンバーぶんしか使わない）。
// 「日→メンバー→生h」マップを days×tasks の1走査で構築し、各メンバーは引くだけにする。
// シグネチャ・戻り値の形・数値結果は不変（純粋な内部最適化）。
export function weekLoadByMember(tasks, members, isoDays, capH = 8, plansByTask = null, { holidays = null } = {}) {
  // day -> (memberId -> 生h)。1走査で構築（メンバー数ぶんの再走査を排除）。
  const loadByDay = new Map(isoDays.map((day) => [day, new Map()]));
  for (const t of tasks) {
    const entries = planEntriesFor(plansByTask, t.id);
    for (const day of isoDays) {
      const dayMap = loadByDay.get(day);
      const byMember = taskPlannedHoursByMemberOn(t, day, entries, { holidays });
      for (const [mid, h] of byMember) dayMap.set(mid, (dayMap.get(mid) || 0) + h);
    }
  }
  return members.map((m) => {
    const days = isoDays.map((day) => {
      const h = loadByDay.get(day).get(m.id) || 0;
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

// タスクの「プロジェクト」= parenttask 鎖を遡った最上位の祖先（ルート親タスク）。
// 3層運用(WS > プロジェクト > タスク)では parenttask[0] と完全一致するが、誤って4層以上に
// ネストしても最上位プロジェクトへ集約される（中間タスクが「プロジェクト」に化けるのを防ぐ）。
// byId = Map<id, task>（load().tasks 由来の完全タスク）。これが無いと直近親までしか辿れない。
// 親を持たないタスク（=それ自身が最上位）は null（プロジェクト無し＝従来挙動）。循環は guard で打ち切り。
export function projectAncestor(task, byId) {
  if (!task) return null;
  const imm = (((task.related_tasks || {}).parenttask) || [])[0];
  if (!imm) return null; // 親なし＝最上位、プロジェクト無し
  const seen = new Set([task.id]);
  let root = (byId && byId.get(imm.id)) || imm;
  while (!seen.has(root.id)) {
    seen.add(root.id);
    const up = (((root.related_tasks || {}).parenttask) || [])[0];
    if (!up) break; // これ以上親がいない＝最上位プロジェクト
    root = (byId && byId.get(up.id)) || up;
  }
  return root; // {id, title, ...}（byId 解決済みなら完全タスク）
}

// 依存グラフの段組み（level=最長の前段数）＋クリティカルパス（最長ノード鎖）。
// ids: ノードID配列, edges: [{from,to}]（前→後）。返り値: {level:Map, critical:Set, order:[]}。
export function depLayers(ids, edges) {
  const idset = new Set(ids);
  const adj = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges || []) {
    if (!idset.has(e.from) || !idset.has(e.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const ind = new Map(indeg);
  const q = ids.filter((id) => ind.get(id) === 0);
  const order = [];
  while (q.length) { const n = q.shift(); order.push(n); for (const m of adj.get(n)) { ind.set(m, ind.get(m) - 1); if (ind.get(m) === 0) q.push(m); } }
  const level = new Map(ids.map((id) => [id, 0]));
  const dist = new Map(ids.map((id) => [id, 1]));
  const back = new Map();
  for (const n of order) for (const m of adj.get(n)) {
    level.set(m, Math.max(level.get(m), level.get(n) + 1));
    if (dist.get(n) + 1 > dist.get(m)) { dist.set(m, dist.get(n) + 1); back.set(m, n); }
  }
  let end = ids[0], best = -1;
  for (const id of ids) if (dist.get(id) > best) { best = dist.get(id); end = id; }
  const critical = new Set();
  for (let cur = end; cur != null; cur = back.get(cur)) critical.add(cur);
  return { level, critical, order };
}

// ガントのバードラッグ → 新しい開始/終了日（純関数）。
//   bar: { start, end, source }（source: "dates"|"due"|"plans"）, dayDelta: ±整数日
//   edge: "move"（本体移動・両端ずらす） | "start"（左端伸縮） | "end"（右端伸縮）
// 伸縮は最小1日でクランプ（start<=end を保証）。due/plans は move のみ想定（呼び出し側で edge="move"）。
export function applyBarDrag(bar, dayDelta, edge = "move") {
  const start = bar.start, end = bar.end;
  if (edge === "start") {
    let ns = shiftISO(start, dayDelta);
    if (ns > end) ns = end; // 終了日を超えない（最小1日）
    return { start: ns, end };
  }
  if (edge === "end") {
    let ne = shiftISO(end, dayDelta);
    if (ne < start) ne = start; // 開始日を下回らない（最小1日）
    return { start, end: ne };
  }
  return { start: shiftISO(start, dayDelta), end: shiftISO(end, dayDelta) }; // move
}

// 日付軸スケール器。startISO から days 日の窓。列index と範囲→span を返す。
export function dayScale(startISO, days) {
  const axis = [];
  for (let i = 0; i < days; i++) {
    const iso = shiftISO(startISO, i);
    const dow = dowOf(iso);
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

export function round1(x) { return Math.round(x * 100) / 100; } // 時間表示=小数2桁（15分=0.25を保持）。SSoT（各lib/viewはこれを使う）
