// 月カレンダー（TickTickのカレンダービュー相当）。月グリッドに 期日タスク＋会議/定例 を俯瞰表示。
// タスクチップをドラッグで別日に落とすと期日を移動（updateTask #9非破壊）。クリックで編集モーダル。
// 会議/定例は recurrences の展開（override 適用済み・時刻表示）＝動かせない（例外編集は時刻カレンダーで）。
import { load, invalidate, isAiUser } from "../lib/store.js";
import { updateTask } from "../lib/api.js";
import { expandRecurrences } from "../lib/recurrence.js";
import { monthMatrix, DOW_JA } from "../lib/form.js";
import { C, esc, member_color, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

let VIEW = null; // {y, m}（表示中の月・セッション内で保持）
let FILTER = { who: "" };

const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
const hhmm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

export async function render(root) {
  const { tasks, members, recurrences, holidaysByDate } = await load();
  const today = todayISO();
  if (!VIEW) VIEW = { y: +today.slice(0, 4), m: +today.slice(5, 7) };
  const weeks = monthMatrix(VIEW.y, VIEW.m);
  const firstISO = weeks[0][0].iso, lastISO = weeks[5][6].iso;

  // 日付 → 項目。タスク=期日ベース（完了は薄く）・会議/定例=展開結果（時刻つき）
  const byDay = new Map();
  const add = (iso, item) => { (byDay.get(iso) || byDay.set(iso, []).get(iso)).push(item); };
  for (const { recurrence: rec, dateISO, assignees, override } of expandRecurrences(recurrences || [], firstISO, lastISO)) {
    const ids = assignees || rec.assignee_ids || [];
    if (FILTER.who && ids.length && !ids.includes(+FILTER.who)) continue;
    const d = new Date(rec.dtstart);
    const baseMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const min = override && override.start_minute != null ? override.start_minute : baseMin;
    add(dateISO, { kind: "rec", title: rec.title || "会議", min: min || null, sort: min || 0 });
  }
  for (const t of tasks || []) {
    const due = dueISO(t);
    if (!due || due < firstISO || due > lastISO) continue;
    if (FILTER.who && !(t.assignees || []).some((a) => String(a.id) === FILTER.who)) continue;
    const who = (t.assignees || []).find((a) => !isAiUser(a)) || null;
    add(due, { kind: "task", t, title: t.title, who, done: !!t.done, sort: 10000 + (t.priority ? -t.priority : 0) });
  }
  for (const list of byDay.values()) list.sort((a, b) => a.sort - b.sort);

  const whoOpts = `<option value="">全員</option>` + (members || []).map((m) =>
    `<option value="${m.id}"${String(m.id) === FILTER.who ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">月カレンダー <small>期日タスク＋会議/定例 ・ チップをドラッグで期日移動</small></h1>
    <div class="mc-tools">
      <button id="mc-prev" class="mc-nav">‹</button>
      <b class="mc-title">${VIEW.y}年${VIEW.m}月</b>
      <button id="mc-next" class="mc-nav">›</button>
      <button id="mc-today" class="mc-nav mc-tdy">今日</button>
      <select id="mc-who">${whoOpts}</select>
    </div>
    <div class="card mc-grid">
      ${DOW_JA.map((n, i) => `<div class="mc-dow ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${n}</div>`).join("")}
      ${weeks.flat().map((c) => dayHtml(c, byDay.get(c.iso) || [], today, holidaysByDate)).join("")}
    </div>`;

  root.querySelector("#mc-prev").onclick = () => { VIEW.m--; if (VIEW.m < 1) { VIEW.m = 12; VIEW.y--; } render(root); };
  root.querySelector("#mc-next").onclick = () => { VIEW.m++; if (VIEW.m > 12) { VIEW.m = 1; VIEW.y++; } render(root); };
  root.querySelector("#mc-today").onclick = () => { VIEW = null; render(root); };
  root.querySelector("#mc-who").onchange = (e) => { FILTER.who = e.target.value; render(root); };

  root.querySelectorAll(".mc-task").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: async () => { invalidate(); await load(); render(root); } });
    el.ondragstart = (ev) => { ev.dataTransfer.setData("text/plain", el.dataset.id); ev.dataTransfer.effectAllowed = "move"; };
  });
  root.querySelectorAll(".mc-day").forEach((cell) => {
    cell.ondragover = (ev) => { ev.preventDefault(); cell.classList.add("over"); };
    cell.ondragleave = () => cell.classList.remove("over");
    cell.ondrop = async (ev) => {
      ev.preventDefault();
      cell.classList.remove("over");
      const id = +ev.dataTransfer.getData("text/plain");
      const iso = cell.dataset.iso;
      const t = (tasks || []).find((x) => x.id === id);
      if (!t || dueISO(t) === iso) return;
      try {
        await updateTask(id, { due_date: iso + "T00:00:00Z" });
        invalidate(); await load(); render(root);
      } catch (e) { console.error(e); }
    };
  });
}

function dayHtml(c, items, today, holidaysByDate) {
  const dow = new Date(c.iso + "T00:00:00Z").getUTCDay();
  const hol = holidaysByDate && holidaysByDate.get(c.iso);
  const cls = ["mc-day"];
  if (!c.inMonth) cls.push("out");
  if (dow === 0 || hol) cls.push("sun");
  if (dow === 6) cls.push("sat");
  if (c.iso === today) cls.push("today");
  const MAX = 4;
  const shown = items.slice(0, MAX);
  return `<div class="${cls.join(" ")}" data-iso="${c.iso}">
    <div class="mc-num">${+c.iso.slice(8, 10)}${hol ? `<span class="mc-hol" title="${esc(hol)}">${esc(hol)}</span>` : ""}</div>
    ${shown.map((it) => it.kind === "rec"
      ? `<div class="mc-rec" title="${esc(it.title)}">🔁${it.min != null ? ` ${hhmm(it.min)}` : ""} ${esc(it.title)}</div>`
      : `<div class="mc-task${it.done ? " done" : ""}" draggable="true" data-id="${it.t.id}" title="${esc(it.title)}">
           ${it.who ? `<i style="background:${member_color(it.who.id)}"></i>` : ""}${esc(it.title)}</div>`).join("")}
    ${items.length > MAX ? `<div class="mc-more">他${items.length - MAX}件</div>` : ""}
  </div>`;
}

function css() {
  return `
  .mc-tools{display:flex;align-items:center;gap:10px;margin:0 0 14px}
  .mc-title{font-size:15px;min-width:110px;text-align:center}
  .mc-nav{font:inherit;font-size:14px;border:1px solid ${C.line};background:#fff;border-radius:8px;padding:5px 13px;cursor:pointer}
  .mc-nav:hover{background:${C.track}}
  .mc-tdy{font-size:12.5px}
  .mc-tools select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff;margin-left:auto}
  .mc-grid{display:grid;grid-template-columns:repeat(7,1fr);overflow:hidden;padding:0}
  .mc-dow{font-size:11px;color:${C.muted};font-weight:700;text-align:center;padding:8px 0;border-bottom:1px solid ${C.line};background:#fafbfc}
  .mc-dow.sat{color:#3a86ff}.mc-dow.sun{color:#e5484d}
  .mc-day{min-height:96px;border-bottom:1px solid ${C.line};border-right:1px solid ${C.line};padding:5px 6px;background:#fff}
  .mc-day:nth-child(7n+1){border-left:0}
  .mc-day.out{background:#fafbfd}.mc-day.out .mc-num{color:#c3c9d2}
  .mc-day.today{background:#f3f8ff;box-shadow:inset 0 0 0 1.5px ${C.fill}}
  .mc-day.over{outline:2px dashed ${C.fill};outline-offset:-2px}
  .mc-num{font-size:11.5px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:5px}
  .mc-day.sat .mc-num{color:#3a86ff}.mc-day.sun .mc-num{color:#e5484d}
  .mc-hol{font-size:9.5px;color:#e5484d;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mc-task,.mc-rec{font-size:10.5px;line-height:1.35;border-radius:5px;padding:2px 5px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mc-task{background:#eaf2ff;color:#1d2430;cursor:grab;display:flex;align-items:center;gap:4px}
  .mc-task:hover{background:#dcebff}
  .mc-task.done{opacity:.45;text-decoration:line-through}
  .mc-task i{flex:none;width:7px;height:7px;border-radius:50%;display:inline-block}
  .mc-rec{background:#f2eefc;color:#6b4fa0}
  .mc-more{font-size:10px;color:${C.muted};padding:1px 5px}`;
}
