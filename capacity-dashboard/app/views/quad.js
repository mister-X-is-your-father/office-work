// 四象限（アイゼンハワー・マトリクス。TickTickプレミアムの同等機能）。
// 重要=優先度 高以上(>=3) / 緊急=期日が3日以内 or 超過。未完了タスクを4区画に配置。
// ドラッグで区画移動=優先度・期日を書き換え（undoトースト付き）。クリックで編集モーダル。
import { load, invalidate, projectName, isAiUser } from "../lib/store.js";
import { updateTask } from "../lib/api.js";
import { C, esc, fmtH, member_color, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const URGENT_DAYS = 3;
const HOUR = 3600;
let FILTER = { who: "" };

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");

// 区画判定: q1=重要×緊急 / q2=重要×非緊急 / q3=非重要×緊急 / q4=非重要×非緊急
function quadOf(t, today) {
  const imp = (t.priority || 0) >= 3;
  const due = dueISO(t);
  const urg = !!due && due <= addDays(today, URGENT_DAYS);
  return imp ? (urg ? "q1" : "q2") : (urg ? "q3" : "q4");
}

const QUADS = {
  q1: { title: "重要 × 緊急", sub: "今すぐやる", color: "#e5484d" },
  q2: { title: "重要 × 緊急でない", sub: "計画してやる", color: "#3a86ff" },
  q3: { title: "重要でない × 緊急", sub: "任せる・さばく", color: "#f5872e" },
  q4: { title: "重要でない × 緊急でない", sub: "やらない・あとで", color: "#8a93a0" },
};

export async function render(root) {
  const { tasks, projects, members, me } = await load();
  const today = todayISO();
  let rows = (tasks || []).filter((t) => !t.done);
  if (FILTER.who) rows = rows.filter((t) => (t.assignees || []).some((a) => String(a.id) === FILTER.who));
  const byQuad = { q1: [], q2: [], q3: [], q4: [] };
  for (const t of rows) byQuad[quadOf(t, today)].push(t);
  for (const k of Object.keys(byQuad)) byQuad[k].sort((a, b) => (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999"));

  const whoOpts = `<option value="">全員</option>` + (members || []).map((m) =>
    `<option value="${m.id}"${String(m.id) === FILTER.who ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">四象限 <small>重要=優先度 高以上 ・ 緊急=期日${URGENT_DAYS}日以内/超過 ・ ドラッグで再分類</small></h1>
    <div class="qd-tools"><select id="qd-who">${whoOpts}</select></div>
    <div class="qd-grid">
      ${Object.entries(QUADS).map(([k, q]) => `
        <div class="card qd-cell" data-q="${k}">
          <div class="qd-h" style="color:${q.color}">${q.title} <span class="qd-sub">${q.sub} ・ ${byQuad[k].length}件</span></div>
          <div class="qd-list">${byQuad[k].map((t) => cardHtml(t, projects, today)).join("") || `<div class="qd-empty">なし</div>`}</div>
        </div>`).join("")}
    </div>
    <div class="qd-undo" id="qd-undo" hidden></div>`;

  root.querySelector("#qd-who").onchange = (e) => { FILTER.who = e.target.value; render(root); };
  root.querySelectorAll(".qd-card").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: async () => { invalidate(); await load(); render(root); } });
    el.ondragstart = (ev) => { ev.dataTransfer.setData("text/plain", el.dataset.id); ev.dataTransfer.effectAllowed = "move"; };
  });
  root.querySelectorAll(".qd-cell").forEach((cell) => {
    cell.ondragover = (ev) => { ev.preventDefault(); cell.classList.add("over"); };
    cell.ondragleave = () => cell.classList.remove("over");
    cell.ondrop = async (ev) => {
      ev.preventDefault();
      cell.classList.remove("over");
      const id = +ev.dataTransfer.getData("text/plain");
      const t = rows.find((x) => x.id === id);
      const dst = cell.dataset.q;
      if (!t || quadOf(t, today) === dst) return;
      // 区画→属性: 重要=優先度3/2、緊急=期日today/今日+7（期日なし→緊急でないならそのまま無期日）
      const imp = dst === "q1" || dst === "q2";
      const urg = dst === "q1" || dst === "q3";
      const prev = { priority: t.priority || 0, due_date: t.due_date || null };
      const patch = { priority: imp ? Math.max(3, prev.priority) : Math.min(2, prev.priority || 2) };
      const due = dueISO(t);
      if (urg) patch.due_date = (due && due <= addDays(today, URGENT_DAYS)) ? t.due_date : today + "T00:00:00Z";
      else if (due && due <= addDays(today, URGENT_DAYS)) patch.due_date = addDays(today, 7) + "T00:00:00Z";
      try {
        await updateTask(id, patch);
        invalidate(); await load(); render(root);
        showUndo(`「${t.title}」を ${QUADS[dst].title} へ移動しました`, async () => {
          await updateTask(id, prev.due_date ? prev : { ...prev, due_date: "0001-01-01T00:00:00Z" });
          invalidate(); await load(); render(root);
        });
      } catch (e) {
        showUndo(`× 移動に失敗: ${e.message}`, null);
      }
    };
  });

  function showUndo(text, onUndo) {
    const box = document.getElementById("qd-undo");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<span>${esc(text)}</span>${onUndo ? `<button id="qd-undo-b">元に戻す</button>` : ""}`;
    const b = box.querySelector("#qd-undo-b");
    if (b) b.onclick = async () => { box.hidden = true; await onUndo(); };
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.hidden = true; }, 8000);
  }
}

function cardHtml(t, projects, today) {
  const due = dueISO(t);
  const late = due && due < today;
  const who = (t.assignees || []).find((a) => !isAiUser(a));
  const wn = who ? (who.name || who.username) : "";
  return `<div class="qd-card" draggable="true" data-id="${t.id}">
    <div class="qd-t">${esc(t.title)}</div>
    <div class="qd-m">
      ${who ? `<span class="qd-ava" style="background:${member_color(who.id)}" title="${esc(wn)}">${esc(wn[0] || "?")}</span>` : ""}
      <span>${esc(projectName(projects, t.project_id))}</span>
      ${due ? `<span class="${late ? "late" : ""}">${due.slice(5).replace("-", "/")}${late ? " 超過" : ""}</span>` : ""}
      ${t.time_estimate ? `<span>${fmtH(t.time_estimate / HOUR)}</span>` : ""}
    </div>
  </div>`;
}

function css() {
  return `
  .qd-tools{margin:0 0 14px}
  .qd-tools select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff}
  .qd-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:760px){.qd-grid{grid-template-columns:1fr}}
  .qd-cell{padding:13px 15px;min-height:170px}
  .qd-cell.over{outline:2px dashed ${C.fill};outline-offset:-2px}
  .qd-h{font-size:13px;font-weight:800;margin-bottom:9px}
  .qd-sub{font-size:11px;color:${C.muted};font-weight:500}
  .qd-list{display:flex;flex-direction:column;gap:7px}
  .qd-empty{font-size:12px;color:${C.muted};padding:14px;text-align:center}
  .qd-card{border:1px solid ${C.line};border-radius:10px;padding:8px 11px;background:#fff;cursor:grab}
  .qd-card:hover{border-color:#cfd9e6;box-shadow:0 2px 8px rgba(20,30,50,.06)}
  .qd-t{font-size:13px;font-weight:600;margin-bottom:3px}
  .qd-m{display:flex;align-items:center;gap:8px;font-size:11px;color:${C.muted}}
  .qd-m .late{color:${C.over};font-weight:700}
  .qd-ava{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;color:#fff;font-size:9px;font-weight:700}`;
}
