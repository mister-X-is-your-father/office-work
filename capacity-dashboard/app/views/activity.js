// アクティビティ（行動・進捗ログのフィード）
// 「いつ・誰が・どのタスクに・どれだけ・どうなったか」を時系列フィードで見せる。
// イベント源は 4 つを統合: 実績(getTimes) / 進捗差分・完了(getActivity) / 作成(task.created)。
// 完了はログ(getActivity done)優先・無ければ task.done_at で historical 補完（重複防止）。
// スコープは「自分（今日）」/「全体（直近2週間）」の 2 モード（localStorage 永続）。
// exec/API 失敗は握って空で続行＝画面を壊さない。route 登録/exec/api は指示役が済ませてある。
import { load, isAiUser } from "../lib/store.js";
import { getActivity } from "../lib/exec.js";
import { getTimes } from "../lib/api.js";
import { C, esc, fmtH, todayISO, member_color } from "../lib/ui.js";
import { dateOnly, shiftISO } from "../lib/capacity.js";
import { DOW_JA } from "../lib/form.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";

const SCOPE_KEY = "ts.activity.scope"; // "me" | "team"（既定 "team"）
const MAX_PER_DAY = 60; // 1 日あたりの表示上限（多すぎ防止）

// 有効な日付文字列か（""/"0001"始まり/未設定 は無効）。
const validDate = (d) => !!d && typeof d === "string" && !d.startsWith("0001") && !d.startsWith("0000");

function loadScope() {
  try { const v = localStorage.getItem(SCOPE_KEY); return v === "me" ? "me" : "team"; } catch { return "team"; }
}
function saveScope(s) { try { localStorage.setItem(SCOPE_KEY, s); } catch { /* noop */ } }

export async function render(root) {
  const { tasks, members, me } = await load();
  const today = todayISO();
  const meId = me && me.id != null ? +me.id : null;

  // ── 名簿（id→名前）。AI(fable)も actor として名前解決はするが、members には居ない場合があるため
  //    members を基にしつつ無ければ user{id}。
  const nameById = new Map();
  for (const m of members || []) if (m && m.id != null) nameById.set(+m.id, m.name || m.username || `user${m.id}`);
  const memberName = (id) => {
    if (id == null) return "";
    const k = +id;
    return nameById.get(k) || `user${k}`;
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

  // progress（進捗差分）＋ done（完了・ログ優先）。done がログにある taskId を控える（historical 補完の重複防止）。
  const loggedDoneTaskIds = new Set();
  for (const a of activityLog || []) {
    if (!a || !validDate(a.at)) continue;
    const tid = a.task_id != null ? +a.task_id : null;
    const title = (tid != null && taskById.get(tid)?.title) || a.title || "";
    if (a.type === "progress") {
      events.push({
        kind: "progress", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: title,
        actorId: a.actor_uid != null ? +a.actor_uid : null, from: a.from, to: a.to,
      });
    } else if (a.type === "done") {
      if (tid != null) loggedDoneTaskIds.add(tid);
      events.push({
        kind: "done", day: dateOnly(a.at), at: a.at, taskId: tid, taskTitle: title,
        actorId: a.actor_uid != null ? +a.actor_uid : null,
      });
    }
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

  // created（作成）
  for (const t of tasks || []) {
    if (!validDate(t.created)) continue;
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

  const filterEvents = () => {
    if (scope === "me") {
      return events.filter((ev) => ev.actorId != null && meId != null && ev.actorId === meId && ev.day === today);
    }
    // team: 直近2週間の全イベント
    return events.filter((ev) => ev.day && ev.day >= since);
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

  // 1 イベント行の HTML。
  const rowHtml = (ev) => {
    const actor = memberName(ev.actorId);
    const tt = `〈${esc(ev.taskTitle || "（無題）")}〉`;
    let ic = "", body = "";
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
    }
    const ava = avatarHtml(ev.actorId);
    return `<button class="ac-row ac-${ev.kind}" data-id="${ev.taskId}" type="button">
      <span class="ac-ic">${ic}</span>
      ${ava}
      <span class="ac-body">${body}</span>
      <span class="ac-right">${progressBadge(ev.taskId)}<span class="ac-time">${esc(clockOf(ev.at))}</span></span>
    </button>`;
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
    const list = filterEvents();
    if (!list.length) {
      return `<div class="ac-empty">アクティビティはまだありません</div>`;
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

  // 初回描画。
  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">アクティビティ <small>${today}</small></h1>
    ${segHtml()}
    <div class="ac-feed" id="ac-feed">${feedHtml()}</div>
  `;

  const feedEl = root.querySelector("#ac-feed");
  const segEl = root.querySelector(".ac-seg");

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

  // 行クリック→タスク編集。
  if (feedEl) {
    feedEl.addEventListener("click", (e) => {
      const row = e.target.closest(".ac-row");
      if (!row) return;
      const id = +row.getAttribute("data-id");
      if (!id) return;
      openTaskForm({ taskId: id, onSaved: () => render(root) });
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
  .ac-seg{margin:2px 0 16px}
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
  .ac-ava{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:#fff;
    font-size:9.5px;font-weight:700;flex:none}
  .ac-body{font-size:13px;line-height:1.4;color:${C.ink};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ac-body b{font-weight:700;font-variant-numeric:tabular-nums}
  .ac-pomo{font-size:11px}
  .ac-right{display:flex;align-items:center;gap:8px;flex:none}
  .ac-badge{font-size:10.5px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;
    padding:1px 8px;font-variant-numeric:tabular-nums}
  .ac-badge.done{color:${C.free};background:transparent;border:1px solid ${C.free}}
  .ac-time{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;flex:none}
  .ac-more{font-size:11.5px;color:${C.muted};padding:4px 10px 2px}

  @media(max-width:560px){
    .ac-body{white-space:normal}
    .ac-time{display:none}
  }`;
}
