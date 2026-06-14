// 優先度マトリクス（アイゼンハワー・マトリクス。TickTickプレミアムの同等機能）。
// 分類ルール（画面の凡例にも明記）:
//   重要 = 重要度が「高」以上（priority>=3） / 緊急 = 期限が today+N日以内 or 超過（期限なし=緊急でない）。
//   N（緊急しきい値）は画面で変更可・localStorage に個人保存（ts.quad.urgentDays・既定3日）。
// ドラッグで区画移動=重要度・期限を書き換え（undoトースト付き）。クリックで編集モーダル。
import { load, invalidate, projectName, isAiUser } from "../lib/store.js";
import { updateTask } from "../lib/api.js";
import { C, esc, fmtH, member_color, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const HOUR = 3600;
const DAYS_KEY = "ts.quad.urgentDays";
const WHO_KEY = "ts.quad.who"; // 担当者フィルタ選択を個人保存（再読込でも維持）
let FILTER = { who: (() => { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } })() };
const urgentDays = () => Math.max(1, +(localStorage.getItem(DAYS_KEY) || 3));

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");

// 区画判定: q1=重要×緊急 / q2=重要×非緊急 / q3=非重要×緊急 / q4=非重要×非緊急
function quadOf(t, today, days) {
  const imp = (t.priority || 0) >= 3;
  const due = dueISO(t);
  const urg = !!due && due <= addDays(today, days);
  return imp ? (urg ? "q1" : "q2") : (urg ? "q3" : "q4");
}

const QUADS = {
  q1: { title: "重要 × 緊急", sub: "今すぐやる", color: "#e5484d", tint: "#fdf3f3" },
  q2: { title: "重要 × 緊急でない", sub: "計画してやる", color: "#3a86ff", tint: "#f1f7ff" },
  q3: { title: "重要でない × 緊急", sub: "任せる・さばく・減らす", color: "#f5872e", tint: "#fdf8f1" },
  q4: { title: "重要でない × 緊急でない", sub: "やらない・あとで", color: "#8a93a0", tint: "#f6f7f9" },
};

export async function render(root) {
  const { tasks, projects, members, me } = await load();
  const today = todayISO();
  const days = urgentDays();
  let rows = (tasks || []).filter((t) => !t.done);
  if (FILTER.who) rows = rows.filter((t) => (t.assignees || []).some((a) => String(a.id) === FILTER.who));
  const byQuad = { q1: [], q2: [], q3: [], q4: [] };
  for (const t of rows) byQuad[quadOf(t, today, days)].push(t);
  for (const k of Object.keys(byQuad)) byQuad[k].sort((a, b) => (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999"));

  // 担当者切替=ワンタップのボタンタブ（全員 / 自分 / 各メンバー）。選択は localStorage 永続。
  const meId = me && me.id;
  const meMember = (members || []).find((m) => m.id === meId);
  const others = (members || []).filter((m) => m.id !== meId);
  const whoBtn = (val, label, color) => {
    const on = String(FILTER.who) === String(val) ? " on" : "";
    const av = color ? `<i class="qd-who-av" style="background:${color}">${esc(label[0] || "?")}</i>` : "";
    return `<button class="qd-who-b${on}" data-who="${esc(String(val))}">${av}${esc(label)}</button>`;
  };
  const whoTabs = whoBtn("", "全員", "")
    + (meMember ? whoBtn(meMember.id, "自分", member_color(meMember.id)) : "")
    + others.map((m) => whoBtn(m.id, m.name || m.username, member_color(m.id))).join("");
  const dayOpts = [1, 2, 3, 5, 7].map((n) =>
    `<option value="${n}"${n === days ? " selected" : ""}>${n}日</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">優先度マトリクス <small>アイゼンハワー・マトリクス ・ ドラッグで再分類</small></h1>
    <div class="qd-tools">
      <span class="qd-rule">📐 <b>重要</b> = 重要度が「高」以上 ／ <b>緊急</b> = 期限が
        <select id="qd-days">${dayOpts}</select>
        以内 または超過（期限なし＝緊急でない）</span>
      <div class="qd-who" id="qd-who">${whoTabs}</div>
    </div>
    <div class="qd-matrix">
      <div class="qd-corner"></div>
      <div class="qd-ax-x"><span>◀ 緊急（期限が近い）</span><span>緊急でない ▶</span></div>
      <div class="qd-ax-y"><span>▲ 重要（重要度 高〜）</span><span>重要でない ▼</span></div>
      <div class="qd-grid">
        ${Object.entries(QUADS).map(([k, q]) => `
          <div class="qd-cell" data-q="${k}" style="background:${q.tint};border-top-color:${q.color}">
            <div class="qd-h" style="color:${q.color}">${q.title} <span class="qd-sub">${q.sub} ・ ${byQuad[k].length}件</span></div>
            <div class="qd-list">${byQuad[k].map((t) => cardHtml(t, projects, today)).join("") || `<div class="qd-empty">なし</div>`}</div>
          </div>`).join("")}
      </div>
    </div>
    <div class="qd-hint">ドラッグでの移動はタスクを書き換えます: 重要側へ=重要度を高に ／ 緊急側へ=期限を今日に ／ 緊急でない側へ=期限を＋7日（取り消しは移動直後の「元に戻す」）。</div>
    <div class="qd-undo" id="qd-undo" hidden></div>`;

  root.querySelectorAll("#qd-who [data-who]").forEach((b) => {
    b.onclick = () => { FILTER.who = b.dataset.who; try { localStorage.setItem(WHO_KEY, FILTER.who); } catch {} render(root); };
  });
  root.querySelector("#qd-days").onchange = (e) => { localStorage.setItem(DAYS_KEY, e.target.value); render(root); };
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
      if (!t || quadOf(t, today, days) === dst) return;
      // 区画→属性: 重要=重要度3/2、緊急=期限today/今日+7（期限なし→緊急でないならそのまま無期限）
      const imp = dst === "q1" || dst === "q2";
      const urg = dst === "q1" || dst === "q3";
      const prev = { priority: t.priority || 0, due_date: t.due_date || null };
      const patch = { priority: imp ? Math.max(3, prev.priority) : Math.min(2, prev.priority || 2) };
      const due = dueISO(t);
      if (urg) patch.due_date = (due && due <= addDays(today, days)) ? t.due_date : today + "T00:00:00Z";
      else if (due && due <= addDays(today, days)) patch.due_date = addDays(today, 7) + "T00:00:00Z";
      try {
        await updateTask(id, patch);
        invalidate(); await load(); render(root);
        showUndo(`「${t.title}」を ${QUADS[dst].num} ${QUADS[dst].title} へ移動しました`, async () => {
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
  .qd-tools{display:flex;align-items:center;gap:14px;margin:0 0 14px;flex-wrap:wrap}
  .qd-rule{font-size:12px;color:${C.muted};background:#fff;border:1px solid ${C.line};border-radius:9px;padding:7px 12px}
  .qd-rule b{color:${C.ink}}
  .qd-tools select{font:inherit;font-size:12.5px;padding:4px 8px;border:1px solid ${C.line};border-radius:7px;background:#fff}
  .qd-who{margin-left:auto;display:flex;flex-wrap:wrap;gap:5px;justify-content:flex-end}
  .qd-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:#fff;color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .qd-who-b:hover{border-color:#cfd9e6}
  .qd-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .qd-who-av{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#fff;font-size:9px;font-weight:700}
  .qd-who-b.on .qd-who-av{box-shadow:0 0 0 1.5px #fff}
  .qd-matrix{display:grid;grid-template-columns:24px 1fr;grid-template-rows:22px 1fr;gap:0 6px}
  .qd-ax-x{grid-column:2;grid-row:1;display:flex;justify-content:space-around;align-items:center;font-size:11px;font-weight:700;color:${C.muted};letter-spacing:.5px}
  .qd-ax-y{grid-column:1;grid-row:2;display:flex;flex-direction:column;justify-content:space-around;align-items:center;font-size:11px;font-weight:700;color:${C.muted};letter-spacing:.5px}
  .qd-ax-y span{writing-mode:vertical-rl;text-orientation:mixed}
  .qd-grid{grid-column:2;grid-row:2;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;
    position:relative;border-radius:12px}
  @media(max-width:760px){.qd-grid{grid-template-columns:1fr;grid-template-rows:none}.qd-matrix{grid-template-columns:1fr}.qd-ax-x,.qd-ax-y{display:none}}
  .qd-cell{position:relative;padding:13px 15px;min-height:190px;border:1px solid ${C.line};border-top:3px solid;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
  .qd-cell .qd-list{flex:1;max-height:300px;overflow-y:auto} /* 1区画が膨らんでも他区画が間延びしない */
  .qd-cell.over{outline:2px dashed ${C.fill};outline-offset:-2px}
  .qd-h{font-size:13px;font-weight:800;margin-bottom:9px}
  .qd-sub{font-size:11px;color:${C.muted};font-weight:500}
  .qd-list{display:flex;flex-direction:column;gap:7px;position:relative}
  .qd-empty{font-size:12px;color:${C.muted};padding:14px;text-align:center}
  .qd-card{border:1px solid ${C.line};border-radius:10px;padding:8px 11px;background:#fff;cursor:grab}
  .qd-card:hover{border-color:#cfd9e6;box-shadow:0 2px 8px rgba(20,30,50,.06)}
  .qd-t{font-size:13px;font-weight:600;margin-bottom:3px}
  .qd-m{display:flex;align-items:center;gap:8px;font-size:11px;color:${C.muted}}
  .qd-m .late{color:${C.over};font-weight:700}
  .qd-ava{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:50%;color:#fff;font-size:9px;font-weight:700}
  .qd-hint{font-size:11px;color:${C.muted};margin-top:10px}
  .qd-undo{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:55;display:flex;align-items:center;gap:12px;
    background:#1d2430;color:#fff;border-radius:11px;padding:10px 16px;font-size:12.5px;box-shadow:0 10px 30px rgba(10,18,35,.35)}
  .qd-undo[hidden]{display:none}
  .qd-undo button{font:inherit;font-size:12px;font-weight:700;border:1px solid #5b6470;background:transparent;color:#9cc3ff;border-radius:7px;padding:4px 12px;cursor:pointer}`;
}
