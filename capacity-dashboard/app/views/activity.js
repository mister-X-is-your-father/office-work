// アクティビティ（行動・進捗ログのフィード）
// 「いつ・誰が・どのタスクに・どれだけ・どうなったか」を時系列フィードで見せる。
// イベント源は 4 つを統合: 実績(getTimes) / 進捗差分・完了・フィールド変更・作成・削除(getActivity) / 作成(task.created 補完)。
// 完了はログ(getActivity done)優先・無ければ task.done_at で historical 補完（重複防止）。作成も同方式。
// フィールド変更(type=field)は 旧→新 を整形表示＋「戻す」で updateTask によるリカバリー。期日変更は琥珀バッジで強調。
// スコープは「自分（今日）」/「全体（直近2週間）」の 2 モード（localStorage 永続）＋種類チップ（モジュール変数・非永続）。
// exec/API 失敗は握って空で続行＝画面を壊さない。route 登録/exec/api は指示役が済ませてある。
import { load, invalidate, isAiUser } from "../lib/store.js";
import { getActivity } from "../lib/exec.js";
import { getTimes, updateTask } from "../lib/api.js";
import { C, esc, fmtH, todayISO, member_color, announce } from "../lib/ui.js";
import { PRIO } from "../lib/kinds.js";
import { dateOnly, shiftISO } from "../lib/capacity.js";
import { DOW_JA } from "../lib/form.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";

const SCOPE_KEY = "ts.activity.scope"; // "me" | "team"（既定 "team"）
const MAX_PER_DAY = 60; // 1 日あたりの表示上限（多すぎ防止）

// ── フィールド変更(type=field)の定義 ──
// フィールド名の日本語（未知 field は生名のまま表示＝行を壊さない）。
const FIELD_JA = {
  title: "タイトル", due_date: "期日", start_date: "開始予定日", end_date: "終了予定日",
  time_estimate: "見積り", description: "説明", priority: "重要度",
};
const DATE_FIELDS = new Set(["due_date", "start_date", "end_date"]);
// 「戻す」を出せる field（= 逆変換して updateTask に渡せるもの）。
const REVERTIBLE = new Set(["title", "due_date", "start_date", "end_date", "time_estimate", "description", "priority"]);

// 種類チップ（モジュール変数＝セッション内のみ・永続不要）。
let typeFilter = "all"; // all | due | field | prog | cd
const TYPE_CHIPS = [
  ["all", "すべて"], ["due", "📅 期日変更"], ["field", "変更"], ["prog", "進捗・完了"], ["cd", "作成・削除"],
];

// field の生値（APIの文字列表現）→ 表示文字列。日付="M/D"（未設定は「未設定」）／見積り=秒→h／
// 重要度=なし..MUST／説明=40字切詰め／タイトル等=そのまま（空は「（空）」）。
function fmtFieldVal(field, raw) {
  const s = raw == null ? "" : String(raw);
  if (DATE_FIELDS.has(field)) {
    if (!validDate(s)) return "未設定";
    const d = new Date(s);
    if (isNaN(d.getTime())) return "未設定";
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  }
  if (field === "time_estimate") {
    const n = Number(s) || 0;
    return n > 0 ? fmtH(n / 3600) : "未設定";
  }
  if (field === "priority") {
    const n = Number(s) || 0;
    return (PRIO[n] && PRIO[n].n) || String(n);
  }
  if (field === "description") {
    const t = s.replace(/\s+/g, " ").trim();
    if (!t) return "（空）";
    return t.length > 40 ? t.slice(0, 40) + "…" : t;
  }
  return s || "（空）";
}

// 「戻す」用の逆変換: from は APIの生値文字列なのでほぼそのまま。数値系は Number、日付の空は未設定表現に。
function revertValue(field, from) {
  if (field === "time_estimate" || field === "priority") return Number(from) || 0;
  if (DATE_FIELDS.has(field) && !from) return "0001-01-01T00:00:00Z";
  return from;
}

// 有効な日付文字列か（""/"0001"始まり/未設定 は無効）。
const validDate = (d) => !!d && typeof d === "string" && !d.startsWith("0001") && !d.startsWith("0000");

function loadScope() {
  try { const v = localStorage.getItem(SCOPE_KEY); return v === "me" ? "me" : "team"; } catch { return "team"; }
}
function saveScope(s) { try { localStorage.setItem(SCOPE_KEY, s); } catch { /* noop */ } }

export async function render(root) {
  const { tasks, members, aiMembers, me } = await load();
  const today = todayISO();
  const meId = me && me.id != null ? +me.id : null;

  // ── 名簿（id→名前）。members ＋ AI 担当(aiMembers=fable 等)を統合し、居ない uid は user{id}。
  //    AI は表示時に 🤖 を付ける（aiIds で判定）。
  const nameById = new Map();
  const aiIds = new Set();
  for (const m of members || []) if (m && m.id != null) nameById.set(+m.id, m.name || m.username || `user${m.id}`);
  for (const m of aiMembers || []) {
    if (!m || m.id == null) continue;
    nameById.set(+m.id, m.name || m.username || `user${m.id}`);
    if (isAiUser(m)) aiIds.add(+m.id);
  }
  const memberName = (id) => {
    if (id == null) return "";
    const k = +id;
    return nameById.get(k) || `user${k}`;
  };
  // アクター表示名（AI は 🤖 前置き）。
  const actorLabel = (id) => {
    if (id == null) return "";
    const nm = memberName(id);
    return aiIds.has(+id) ? `🤖 ${nm}` : nm;
  };

  const taskById = new Map((tasks || []).map((t) => [+t.id, t]));

  // ── 進捗/完了ログ（exec 停止時は空配列） ──
  let activityLog = [];
  try { activityLog = (await getActivity())?.activity || []; } catch { activityLog = []; }

  // ── 実績（time_spent>0 のタスクだけ N+1 取得・ガント同方式） ──
  const timeTasks = (tasks || []).filter((t) => (t.time_spent || 0) > 0);
  const timePairs = await Promise.all(
    timeTasks.map((t) => getTimes(t.id).then((es) => [t, es || []]).catch(() => [t, []]))
  );

  // ── イベント統合 ──
  const events = [];

  // time（実績）
  for (const [t, entries] of timePairs) {
    for (const e of entries || []) {
      if (!validDate(e.logged_on)) continue;
      if (!(e.seconds > 0)) continue;
      events.push({
        kind: "time", day: dateOnly(e.logged_on), at: e.logged_on,
        taskId: +t.id, taskTitle: t.title, actorId: e.user_id != null ? +e.user_id : null,
        seconds: e.seconds, pomo: /🍅/.test(e.note || ""),
      });
    }
  }

  // progress（進捗差分）＋ done（完了・ログ優先）＋ field（フィールド変更）＋ created/deleted（ログ発）。
  // done/created がログにある taskId を控える（historical 補完の重複防止）。未知 type は無視＝行を壊さない。
  const loggedDoneTaskIds = new Set();
  const loggedCreatedTaskIds = new Set();
  for (const a of activityLog || []) {
    if (!a || !validDate(a.at)) continue;
    const tid = a.task_id != null ? +a.task_id : null;
    const title = (tid != null && taskById.get(tid)?.title) || a.title || "";
    const actorId = a.actor_uid != null ? +a.actor_uid : null;
    if (a.type === "progress") {
      events.push({
        kind: "progress", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: title,
        actorId, from: a.from, to: a.to,
      });
    } else if (a.type === "done") {
      if (tid != null) loggedDoneTaskIds.add(tid);
      events.push({
        kind: "done", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: title, actorId,
      });
    } else if (a.type === "field") {
      if (!a.field) continue; // field 名不明は無視（防御）
      events.push({
        kind: "field", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: title, actorId,
        field: String(a.field), from: a.from == null ? "" : String(a.from), to: a.to == null ? "" : String(a.to),
      });
    } else if (a.type === "created") {
      if (tid != null) loggedCreatedTaskIds.add(tid);
      events.push({
        kind: "created", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: title, actorId,
      });
    } else if (a.type === "deleted") {
      events.push({
        kind: "deleted", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: a.title || "", actorId,
      });
    }
    // それ以外の type は黙って無視（後方互換）。
  }

  // done（historical 補完）: done かつ done_at 有効 かつ ログに done が無い taskId。
  for (const t of tasks || []) {
    if (!t.done || !validDate(t.done_at)) continue;
    if (loggedDoneTaskIds.has(+t.id)) continue;
    events.push({
      kind: "done", day: dateOnly(t.done_at), at: t.done_at,
      taskId: +t.id, taskTitle: t.title, actorId: null,
    });
  }

  // created（historical 補完）: created 有効 かつ ログに created が無い taskId（ログ発と重複させない）。
  for (const t of tasks || []) {
    if (!validDate(t.created)) continue;
    if (loggedCreatedTaskIds.has(+t.id)) continue;
    events.push({
      kind: "created", day: dateOnly(t.created), at: t.created,
      taskId: +t.id, taskTitle: t.title,
      actorId: (t.created_by && t.created_by.id != null) ? +t.created_by.id : null,
    });
  }

  // 新しい順
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // ── 描画状態（スコープ切替で再構築） ──
  let scope = loadScope();
  const since = shiftISO(today, -13); // 直近2週間（今日含め14日）

  // 種類チップの判定（time=実績記録 は「進捗・完了」に含める）。
  const matchType = (ev) => {
    if (typeFilter === "due") return ev.kind === "field" && ev.field === "due_date";
    if (typeFilter === "field") return ev.kind === "field";
    if (typeFilter === "prog") return ev.kind === "progress" || ev.kind === "done" || ev.kind === "time";
    if (typeFilter === "cd") return ev.kind === "created" || ev.kind === "deleted";
    return true; // all
  };

  const filterEvents = () => {
    let list;
    if (scope === "me") {
      list = events.filter((ev) => ev.actorId != null && meId != null && ev.actorId === meId && ev.day === today);
    } else {
      // team: 直近2週間の全イベント
      list = events.filter((ev) => ev.day && ev.day >= since);
    }
    return typeFilter === "all" ? list : list.filter(matchType);
  };

  // アバター（home/status 意匠）。id が null なら空。
  const avatarHtml = (id) => {
    if (id == null) return "";
    const nm = memberName(id);
    return `<span class="ac-ava" style="background:${member_color(+id)}" title="${esc(nm)}">${esc((nm[0] || "?").toUpperCase())}</span>`;
  };

  // 進捗バッジ（行右・薄く）。
  const progressBadge = (taskId) => {
    const t = taskById.get(+taskId);
    if (!t) return "";
    if (t.done) return `<span class="ac-badge done">完了</span>`;
    const p = t.percent_done;
    if (p != null && p > 0) return `<span class="ac-badge">${Math.round(p)}%</span>`;
    return "";
  };

  // 表示中イベントの索引（「戻す」が data-ei で参照。feedHtml のたびに詰め直す）。
  let shownEvents = [];

  // 1 イベント行の HTML。
  const rowHtml = (ev) => {
    const ei = shownEvents.push(ev) - 1;
    const actor = actorLabel(ev.actorId);
    const tt = `〈${esc(ev.taskTitle || "（無題）")}〉`;
    let ic = "", body = "", rightExtra = "";
    if (ev.kind === "time") {
      ic = icon("timer", { size: 14 }) || "🕒";
      const who = actor ? `${esc(actor)} が ` : "";
      const pomo = ev.pomo ? ` <span class="ac-pomo">🍅</span>` : "";
      body = `${who}${tt} に <b>${esc(fmtH((ev.seconds || 0) / 3600))}</b> 記録${pomo}`;
    } else if (ev.kind === "progress") {
      ic = icon("trendingUp", { size: 14 }) || "📈";
      const who = actor ? `${esc(actor)} が ` : "";
      body = `${who}${tt} を <b>${esc(ev.from)}%→${esc(ev.to)}%</b>`;
    } else if (ev.kind === "done") {
      ic = icon("check", { size: 14 }) || "✅";
      body = `${tt} 完了${actor ? `（${esc(actor)}）` : ""}`;
    } else if (ev.kind === "created") {
      ic = icon("plus", { size: 14 }) || "＋";
      body = `${tt} 作成${actor ? `（${esc(actor)}）` : ""}`;
    } else if (ev.kind === "deleted") {
      ic = icon("x", { size: 14 }) || "✕";
      const who = actor ? `${esc(actor)} が ` : "";
      const target = ev.taskTitle ? tt : `タスク #${ev.taskId ?? "?"}`;
      body = `${who}${target} を削除`;
    } else if (ev.kind === "field") {
      ic = icon("pencil", { size: 14 }) || "✎";
      const who = actor ? `${esc(actor)} が ` : "";
      const fname = FIELD_JA[ev.field] || ev.field;
      const isDue = ev.field === "due_date";
      const badge = isDue ? `<span class="ac-due-badge">📅 期日変更</span>` : "";
      body = `${who}${tt} の <b>${esc(fname)}</b> を変更${badge}
        <span class="ac-diff">${esc(fmtFieldVal(ev.field, ev.from))} <span class="ac-arrow">→</span> <b>${esc(fmtFieldVal(ev.field, ev.to))}</b></span>`;
      if (REVERTIBLE.has(ev.field)) {
        rightExtra = `<button class="ac-undo" type="button" data-ei="${ei}" title="${esc(fname)}を変更前に戻す">${icon("undo", { size: 12 }) || "↩"}戻す</button>`;
      }
    } else {
      // 未知 kind（後方互換の保険。events には積まれない想定だが行は壊さない）。
      ic = icon("pencil", { size: 14 }) || "・";
      body = `${tt} 更新${actor ? `（${esc(actor)}）` : ""}`;
    }
    const ava = avatarHtml(ev.actorId);
    const inner = `
      <span class="ac-ic">${ic}</span>
      ${ava}
      <span class="ac-body">${body}</span>
      <span class="ac-right">${rightExtra}${progressBadge(ev.taskId)}<span class="ac-time">${esc(clockOf(ev.at))}</span></span>`;
    if (ev.kind === "deleted") {
      // 削除済み＝開けないので非クリック行（<button> にしない）。
      return `<div class="ac-row ac-deleted ac-static">${inner}</div>`;
    }
    if (ev.kind === "field") {
      // 「戻す」の入れ子ボタンを valid HTML にするため外側は div（role=button でキーボード対応）。
      return `<div class="ac-row ac-field" data-id="${ev.taskId}" role="button" tabindex="0">${inner}</div>`;
    }
    return `<button class="ac-row ac-${ev.kind}" data-id="${ev.taskId}" type="button">${inner}</button>`;
  };

  // 日付見出し: 「6/20（金）」、今日は「今日 6/20（金）」。
  const dayHead = (day) => {
    const d = new Date(day + "T00:00:00Z");
    const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    const dow = DOW_JA[d.getUTCDay()];
    const isToday = day === today ? "今日 " : "";
    return `${isToday}${md}（${dow}）`;
  };

  // フィード本体（フィルタ→日付グルーピング→行）。
  const feedHtml = () => {
    shownEvents = [];
    const list = filterEvents();
    if (!list.length) {
      return `<div class="ac-empty">${typeFilter === "all" ? "アクティビティはまだありません" : "この種類のアクティビティはありません"}</div>`;
    }
    // day 降順でグルーピング（events は既に at 降順なので、出現順で Map に積めば day も降順）。
    const byDay = new Map();
    for (const ev of list) {
      if (!byDay.has(ev.day)) byDay.set(ev.day, []);
      byDay.get(ev.day).push(ev);
    }
    let out = "";
    for (const [day, evs] of byDay) {
      const shown = evs.slice(0, MAX_PER_DAY);
      const more = evs.length - shown.length;
      out += `<div class="ac-group">
        <div class="ac-day">${esc(dayHead(day))}<span class="ac-day-n">${evs.length}</span></div>
        <div class="ac-rows">${shown.map(rowHtml).join("")}</div>
        ${more > 0 ? `<div class="ac-more">他 ${more} 件</div>` : ""}
      </div>`;
    }
    return out;
  };

  const segHtml = () => `
    <div class="seg ac-seg" role="tablist">
      <button class="seg-b${scope === "me" ? " on" : ""}" data-scope="me" type="button" role="tab" aria-selected="${scope === "me"}">自分（今日）</button>
      <button class="seg-b${scope === "team" ? " on" : ""}" data-scope="team" type="button" role="tab" aria-selected="${scope === "team"}">全体（直近2週間）</button>
    </div>`;

  // 種類チップ（すべて/期日変更/変更/進捗・完了/作成・削除）。
  const chipsHtml = () => `
    <div class="ac-chips" role="group" aria-label="種類で絞り込み">
      ${TYPE_CHIPS.map(([k, label]) =>
        `<button class="ac-chip${typeFilter === k ? " on" : ""}${k === "due" ? " due" : ""}" data-type="${k}" type="button" aria-pressed="${typeFilter === k}">${esc(label)}</button>`
      ).join("")}
    </div>`;

  // 初回描画。
  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">アクティビティ <small>${today}</small></h1>
    ${segHtml()}
    ${chipsHtml()}
    <div class="ac-feed" id="ac-feed">${feedHtml()}</div>
  `;

  const feedEl = root.querySelector("#ac-feed");
  const segEl = root.querySelector(".ac-seg");
  const chipsEl = root.querySelector(".ac-chips");

  // スコープ切替（再描画＝フィルタしてフィードだけ再構築）。
  if (segEl) {
    segEl.addEventListener("click", (e) => {
      const b = e.target.closest(".seg-b");
      if (!b) return;
      const next = b.getAttribute("data-scope");
      if (!next || next === scope) return;
      scope = next === "me" ? "me" : "team";
      saveScope(scope);
      for (const x of segEl.querySelectorAll(".seg-b")) {
        const on = x.getAttribute("data-scope") === scope;
        x.classList.toggle("on", on);
        x.setAttribute("aria-selected", String(on));
      }
      if (feedEl) feedEl.innerHTML = feedHtml();
    });
  }

  // 種類チップ切替（フィードだけ再構築）。
  if (chipsEl) {
    chipsEl.addEventListener("click", (e) => {
      const b = e.target.closest(".ac-chip");
      if (!b) return;
      const next = b.getAttribute("data-type");
      if (!next || next === typeFilter) return;
      typeFilter = next;
      for (const x of chipsEl.querySelectorAll(".ac-chip")) {
        const on = x.getAttribute("data-type") === typeFilter;
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", String(on));
      }
      if (feedEl) feedEl.innerHTML = feedHtml();
    });
  }

  // 「戻す」＝フィールド変更のリカバリー。confirm → updateTask({field: 逆変換したfrom}) → 再描画。
  const revertField = async (ev) => {
    const fname = FIELD_JA[ev.field] || ev.field;
    const tname = (ev.taskId != null && taskById.get(+ev.taskId)?.title) || ev.taskTitle || `#${ev.taskId}`;
    const oldDisp = fmtFieldVal(ev.field, ev.from);
    if (!confirm(`「${tname}」の${fname}を「${oldDisp}」に戻しますか？`)) return;
    try {
      await updateTask(ev.taskId, { [ev.field]: revertValue(ev.field, ev.from) });
      invalidate();
      announce("戻しました");
      render(root);
    } catch {
      announce(`${fname}を戻せませんでした`, { assertive: true });
    }
  };

  // 行クリック→タスク編集（.ac-undo は「戻す」、.ac-static=削除行 は開かない）。
  const onRowActivate = (e) => {
    const undo = e.target.closest(".ac-undo");
    if (undo) {
      const ev = shownEvents[+undo.getAttribute("data-ei")];
      if (ev && ev.kind === "field") revertField(ev);
      return;
    }
    const row = e.target.closest(".ac-row");
    if (!row || row.classList.contains("ac-static")) return;
    const id = +row.getAttribute("data-id");
    if (!id) return;
    openTaskForm({ taskId: id, onSaved: () => render(root) });
  };
  if (feedEl) {
    feedEl.addEventListener("click", onRowActivate);
    // field 行は div[role=button] なので Enter/Space をクリック相当に。
    feedEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.classList.contains("ac-row") && t.getAttribute("role") === "button") {
        e.preventDefault();
        onRowActivate(e);
      }
    });
  }
}

// "YYYY-MM-DDTHH:MM:SSZ" → "HH:MM"（ローカル）。無効なら空。
function clockOf(iso) {
  if (!iso || typeof iso !== "string") return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 配色は全て C.* トークン（テーマ追従）。home/status の .st-* に倣う。
function css() {
  return `
  .ac-seg{margin:2px 0 10px}
  .ac-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
  .ac-chip{font:inherit;font-size:11.5px;font-weight:600;color:${C.muted};background:transparent;
    border:1px solid ${C.line};border-radius:999px;padding:3px 11px;cursor:pointer;transition:background .12s,color .12s}
  .ac-chip:hover{background:${C.track}}
  .ac-chip.on{color:#fff;background:${C.fill};border-color:${C.fill}}
  .ac-chip.due.on{color:#fff;background:${C.amber};border-color:${C.amber}}
  .ac-feed{display:flex;flex-direction:column;gap:18px}
  .ac-empty{font-size:13px;color:${C.muted};padding:24px 4px;text-align:center}

  .ac-group{display:flex;flex-direction:column;gap:4px}
  .ac-day{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;color:${C.muted};
    padding:2px 4px 6px;border-bottom:1px solid ${C.line};margin-bottom:4px}
  .ac-day-n{font-size:10.5px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;padding:1px 8px}

  .ac-rows{display:flex;flex-direction:column;gap:2px}
  .ac-row{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;text-align:left;
    border:0;background:transparent;color:${C.ink};font:inherit;cursor:pointer;border-radius:9px;padding:8px 10px;
    transition:background .12s}
  .ac-row:hover{background:${C.track}}
  .ac-ic{display:inline-grid;place-items:center;width:18px;color:${C.muted};flex:none}
  .ac-time .ic,.ac-row.ac-progress .ac-ic{color:${C.muted}}
  .ac-row.ac-done .ac-ic{color:${C.free}}
  .ac-row.ac-time .ac-ic{color:${C.fill}}
  .ac-row.ac-created .ac-ic{color:${C.muted}}
  .ac-row.ac-field .ac-ic{color:${C.amber}}
  .ac-row.ac-deleted .ac-ic{color:${C.over}}
  .ac-row.ac-static{cursor:default}
  .ac-row.ac-static:hover{background:transparent}
  .ac-row.ac-deleted .ac-body{color:${C.muted}}
  .ac-ava{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:#fff;
    font-size:9.5px;font-weight:700;flex:none}
  .ac-body{font-size:13px;line-height:1.4;color:${C.ink};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-body b{font-weight:700;font-variant-numeric:tabular-nums}
  .ac-pomo{font-size:11px}
  .ac-right{display:flex;align-items:center;gap:8px;flex:none}
  .ac-badge{font-size:10.5px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;
    padding:1px 8px;font-variant-numeric:tabular-nums}
  .ac-badge.done{color:${C.free};background:transparent;border:1px solid ${C.free}}

  .ac-due-badge{display:inline-block;margin:0 4px;font-size:10.5px;font-weight:700;color:${C.amber};
    background:rgba(245,166,35,.14);border:1px solid ${C.amber};
    border-radius:999px;padding:1px 8px;vertical-align:1px;white-space:nowrap}
  .ac-diff{color:${C.muted};margin-left:2px}
  .ac-diff b{color:${C.ink}}
  .ac-arrow{color:${C.muted}}
  .ac-undo{display:inline-flex;align-items:center;gap:3px;font:inherit;font-size:10.5px;font-weight:700;
    color:${C.muted};background:transparent;border:1px solid ${C.line};border-radius:999px;padding:1px 9px;
    cursor:pointer;flex:none;transition:background .12s,color .12s}
  .ac-undo:hover{color:${C.ink};background:${C.track};border-color:${C.lineStrong}}
  .ac-time{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;flex:none}
  .ac-more{font-size:11.5px;color:${C.muted};padding:4px 10px 2px}

  @media(max-width:560px){
    .ac-body{white-space:normal}
    .ac-time{display:none}
  }`;
}
