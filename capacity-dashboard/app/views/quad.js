// 優先度マトリクス（アイゼンハワー・マトリクス。TickTickプレミアムの同等機能）。
// 分類ルール（画面の凡例にも明記）:
//   重要 = 重要度が「高」以上（priority>=3） / 緊急 = 期限が today+N日以内 or 超過（期限なし=緊急でない）。
//   N（緊急しきい値）は画面で変更可・localStorage に個人保存（ts.quad.urgentDays・既定3日）。
// ドラッグで区画移動=重要度・期限を書き換え（undoトースト付き）。クリックで編集モーダル。
import { load, invalidate, projectName, isAiUser } from "../lib/store.js";
import { updateTask } from "../lib/api.js";
import { C, esc, fmtH, member_color, todayISO, announce, avatar } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";
import { shiftISO } from "../lib/capacity.js";

const HOUR = 3600;
const DAYS_KEY = "ts.quad.urgentDays";
const WHO_KEY = "ts.quad.who"; // 担当者フィルタ選択を個人保存（再読込でも維持）
const SORT_KEY = "ts.quad.sort"; // 各象限内のソート切替を個人保存（再読込でも維持）
let FILTER = { who: (() => { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } })() };
const urgentDays = () => Math.max(1, +(localStorage.getItem(DAYS_KEY) || 3));
// 各象限内のソート: due=期限が近い順 / priority=重要度が高い順 / estimate=見積が大きい順
const SORTS = {
  due: { label: "期限が近い順" },
  priority: { label: "重要度が高い順" },
  estimate: { label: "見積が大きい順" },
};
const sortMode = () => { try { const v = localStorage.getItem(SORT_KEY); return SORTS[v] ? v : "due"; } catch { return "due"; } };
function cmpInQuad(mode) {
  if (mode === "priority") return (a, b) => (b.priority || 0) - (a.priority || 0) || (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999");
  if (mode === "estimate") return (a, b) => (b.time_estimate || 0) - (a.time_estimate || 0) || (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999");
  return (a, b) => (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999"); // due（既定）
}

const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");

// 区画判定: q1=重要×緊急 / q2=重要×非緊急 / q3=非重要×緊急 / q4=非重要×非緊急
function quadOf(t, today, days) {
  const imp = (t.priority || 0) >= 3;
  const due = dueISO(t);
  const urg = !!due && due <= shiftISO(today, days);
  return imp ? (urg ? "q1" : "q2") : (urg ? "q3" : "q4");
}

const QUADS = {
  q1: { title: "重要 × 緊急", sub: "今すぐやる", color: "#e5484d", tint: "#fdf3f3" },
  q2: { title: "重要 × 緊急でない", sub: "計画してやる", color: "#3a86ff", tint: "#f1f7ff" },
  q3: { title: "重要でない × 緊急", sub: "減らす・さばく・任せる", color: "#f5872e", tint: "#fdf8f1" },
  q4: { title: "重要でない × 緊急でない", sub: "捨てる・まとめる・合間で", color: "#8a93a0", tint: "#f6f7f9" },
};

// 区画移動の差分を算出（ドロップ／タップメニュー共通）。重要度0の昇格バグ修正式を維持。
//   重要=重要度を3以上に / 非重要=2以下に。緊急=期限を今日に / 非緊急=超過期限は＋7日へ。
// 戻り: { patch, prev } （prevはundo用。変化なしなら null）。
function moveDiff(t, dst, today, days) {
  if (!t || quadOf(t, today, days) === dst) return null;
  const imp = dst === "q1" || dst === "q2";
  const urg = dst === "q1" || dst === "q3";
  const prev = { priority: t.priority || 0, due_date: t.due_date || null };
  const patch = { priority: imp ? Math.max(3, prev.priority || 0) : Math.min(prev.priority || 0, 2) };
  const due = dueISO(t);
  if (urg) patch.due_date = (due && due <= shiftISO(today, days)) ? t.due_date : today + "T00:00:00Z";
  else if (due && due <= shiftISO(today, days)) patch.due_date = shiftISO(today, 7) + "T00:00:00Z";
  return { patch, prev };
}

export async function render(root) {
  const { tasks, projects, members, me } = await load();
  const today = todayISO();
  const days = urgentDays();
  let rows = (tasks || []).filter((t) => !t.done);
  if (FILTER.who) rows = rows.filter((t) => (t.assignees || []).some((a) => String(a.id) === FILTER.who));
  const sort = sortMode();
  const cmp = cmpInQuad(sort);
  const byQuad = { q1: [], q2: [], q3: [], q4: [] };
  for (const t of rows) byQuad[quadOf(t, today, days)].push(t);
  for (const k of Object.keys(byQuad)) byQuad[k].sort(cmp);

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
  const sortOpts = Object.entries(SORTS).map(([v, s]) =>
    `<option value="${v}"${v === sort ? " selected" : ""}>${esc(s.label)}</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">優先度マトリクス <small>アイゼンハワー・マトリクス ・ ドラッグで再分類</small></h1>
    <div class="qd-tools">
      <div class="qd-who" id="qd-who">${whoTabs}</div>
      <label class="qd-sort">${icon("list", { size: 13 })} 並び替え
        <select id="qd-sort">${sortOpts}</select></label>
      <span class="qd-rule">${icon("ruler", { size: 14 })} <b>重要</b> = 重要度が「高」以上 ／ <b>緊急</b> = 期限が
        <select id="qd-days">${dayOpts}</select>
        以内 または超過（期限なし＝緊急でない）</span>
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
  root.querySelector("#qd-sort").onchange = (e) => { try { localStorage.setItem(SORT_KEY, e.target.value); } catch {} render(root); };
  // ドロップ／タップメニュー共通の移動実行。差分算出→更新→再描画→undoトースト＋読み上げ。
  async function applyMove(id, dst) {
    const t = rows.find((x) => x.id === id);
    const diff = moveDiff(t, dst, today, days);
    if (!diff) return;
    const { patch, prev } = diff;
    try {
      await updateTask(id, patch);
      invalidate(); await load(); render(root);
      announce(`「${t.title}」を「${QUADS[dst].title}」へ移動しました`);
      showUndo(`「${t.title}」を「${QUADS[dst].title}」へ移動しました`, async () => {
        await updateTask(id, prev.due_date ? prev : { ...prev, due_date: "0001-01-01T00:00:00Z" });
        invalidate(); await load(); render(root);
      });
    } catch (e) {
      showUndo(`× 移動に失敗: ${e.message}`, null);
    }
  }

  root.querySelectorAll(".qd-card").forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest(".qd-mvbtn")) return; // 移動ボタンはメニューを開く（編集を開かない）
      openTaskForm({ taskId: +el.dataset.id, onSaved: async () => { invalidate(); await load(); render(root); } });
    };
    el.ondragstart = (ev) => { ev.dataTransfer.setData("text/plain", el.dataset.id); ev.dataTransfer.effectAllowed = "move"; };
    // タップ移動代替（タッチ端末＝ネイティブDnD不可の救済。マウス環境でも害なく動く）。
    const mv = el.querySelector(".qd-mvbtn");
    if (mv) mv.onclick = (ev) => { ev.stopPropagation(); openMoveMenu(mv, +el.dataset.id); };
  });
  root.querySelectorAll(".qd-cell").forEach((cell) => {
    cell.ondragover = (ev) => { ev.preventDefault(); cell.classList.add("over"); };
    cell.ondragleave = () => cell.classList.remove("over");
    cell.ondrop = async (ev) => {
      ev.preventDefault();
      cell.classList.remove("over");
      const id = +ev.dataTransfer.getData("text/plain");
      await applyMove(id, cell.dataset.q);
    };
  });

  // タップで開く移動先メニュー（4象限。現在の区画は選択不可）。tb-ctx 風の軽量ポップ。
  function openMoveMenu(anchor, id) {
    closeMoveMenu();
    const t = rows.find((x) => x.id === id);
    if (!t) return;
    const cur = quadOf(t, today, days);
    const m = document.createElement("div");
    m.className = "qd-mvmenu";
    m.innerHTML = `<div class="qd-mvmenu-hd">移動先を選ぶ</div>`
      + Object.entries(QUADS).map(([k, q]) =>
        `<button class="qd-mvmenu-it${k === cur ? " cur" : ""}" data-q="${k}"${k === cur ? " disabled" : ""}>
          <i class="qd-mvmenu-dot" style="background:${q.color}"></i>
          <span class="qd-mvmenu-t">${esc(q.title)}${k === cur ? "（現在）" : ""}</span></button>`).join("");
    document.body.appendChild(m);
    // 位置: アンカー（移動ボタン）の下に。はみ出すなら画面内へ寄せる。
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.left = Math.max(8, left) + "px";
    m.style.top = top + "px";
    m.querySelectorAll(".qd-mvmenu-it:not(.cur)").forEach((b) => {
      b.onclick = async () => { const dst = b.dataset.q; closeMoveMenu(); await applyMove(id, dst); };
    });
    // 外側クリック／Escで閉じる（次フレームから有効化＝開いた瞬間のクリックで即閉じない）。
    setTimeout(() => {
      m._out = (ev) => { if (!m.contains(ev.target)) closeMoveMenu(); };
      m._key = (ev) => { if (ev.key === "Escape") closeMoveMenu(); };
      document.addEventListener("pointerdown", m._out, true);
      document.addEventListener("keydown", m._key, true);
    }, 0);
  }
  function closeMoveMenu() {
    document.querySelectorAll(".qd-mvmenu").forEach((m) => {
      if (m._out) document.removeEventListener("pointerdown", m._out, true);
      if (m._key) document.removeEventListener("keydown", m._key, true);
      m.remove();
    });
  }

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
    <button class="qd-mvbtn" type="button" aria-label="別の区画へ移動" title="別の区画へ移動"><span aria-hidden="true">⋮</span></button>
    <div class="qd-t">${esc(t.title)}</div>
    <div class="qd-m">
      ${who ? avatar(who, { size: 17 }) : ""}
      <span>${esc(projectName(projects, t.project_id))}</span>
      ${due ? `<span class="${late ? "late" : ""}">${due.slice(5).replace("-", "/")}${late ? " 超過" : ""}</span>` : ""}
      ${t.time_estimate ? `<span>${fmtH(t.time_estimate / HOUR)}</span>` : ""}
    </div>
  </div>`;
}

function css() {
  return `
  .qd-tools{display:flex;align-items:center;gap:14px;margin:0 0 14px;flex-wrap:wrap}
  .qd-rule{font-size:12px;color:${C.muted};background:${C.card};border:1px solid ${C.line};border-radius:9px;padding:7px 12px;margin-left:auto}
  .qd-rule b{color:${C.ink}}
  .qd-tools select{font:inherit;font-size:12.5px;padding:4px 8px;border:1px solid ${C.line};border-radius:7px;background:${C.card}}
  .qd-sort{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${C.muted}}
  .qd-sort svg{flex:none;color:${C.muted}}
  .qd-who{display:flex;flex-wrap:wrap;gap:5px}
  .qd-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:${C.card};color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
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
  .qd-card{position:relative;border:1px solid ${C.line};border-radius:10px;padding:8px 11px;background:${C.card};cursor:grab}
  .qd-card:hover{border-color:#cfd9e6;box-shadow:0 2px 8px rgba(20,30,50,.06)}
  /* タップ移動ボタン（⋮）。マウス環境では控えめ＝hover/フォーカスで出す。タッチ端末では常時可視。 */
  .qd-mvbtn{position:absolute;top:3px;right:3px;width:24px;height:24px;display:grid;place-items:center;
    border:0;background:transparent;color:${C.muted};font-size:17px;line-height:1;border-radius:7px;cursor:pointer;
    opacity:0;transition:opacity .12s,background .12s;-webkit-tap-highlight-color:transparent}
  .qd-mvbtn:hover{background:${C.track};color:${C.ink}}
  .qd-card:hover .qd-mvbtn,.qd-mvbtn:focus-visible{opacity:1}
  /* タッチ端末（hoverできない/粗いポインタ）はDnD不可なので常時表示＝代替操作が見える */
  @media (hover:none),(pointer:coarse){.qd-mvbtn{opacity:.6}.qd-t{padding-right:20px}}
  .qd-mvmenu{position:fixed;z-index:10000;min-width:210px;background:${C.card};border:1px solid ${C.line};border-radius:11px;
    box-shadow:0 12px 34px rgba(20,30,50,.22);padding:5px;display:flex;flex-direction:column}
  .qd-mvmenu-hd{font-size:10px;font-weight:700;letter-spacing:.04em;color:${C.muted};padding:6px 11px 4px}
  .qd-mvmenu-it{display:flex;align-items:center;gap:9px;font:inherit;font-size:13px;text-align:left;border:0;background:transparent;
    color:${C.ink};padding:9px 11px;border-radius:7px;cursor:pointer;white-space:nowrap}
  .qd-mvmenu-it:hover{background:${C.track}}
  .qd-mvmenu-it.cur{color:${C.muted};cursor:default}
  .qd-mvmenu-it[disabled]{opacity:.55;cursor:default}
  .qd-mvmenu-dot{flex:none;width:9px;height:9px;border-radius:50%}
  .qd-t{font-size:13px;font-weight:600;margin-bottom:3px}
  .qd-m{display:flex;align-items:center;gap:8px;font-size:11px;color:${C.muted}}
  .qd-m .late{color:${C.over};font-weight:700}
  .qd-hint{font-size:11px;color:${C.muted};margin-top:10px}
  .qd-undo{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:55;display:flex;align-items:center;gap:12px;
    background:#1d2430;color:#fff;border-radius:11px;padding:10px 16px;font-size:12.5px;box-shadow:0 10px 30px rgba(10,18,35,.35)}
  .qd-undo[hidden]{display:none}
  .qd-undo button{font:inherit;font-size:12px;font-weight:700;border:1px solid #5b6470;background:transparent;color:#9cc3ff;border-radius:7px;padding:4px 12px;cursor:pointer}

  /* ダークモード: 面=card / 区画罫線=line / 文字=ink。四象限tintは同系の暗いtintへ。アクセント/PRIO色は維持 */
  html[data-theme="dark"] .qd-sort{color:var(--muted)}
  html[data-theme="dark"] .qd-rule,
  html[data-theme="dark"] .qd-tools select,
  html[data-theme="dark"] .qd-who-b,
  html[data-theme="dark"] .qd-card{color:var(--muted)}
  html[data-theme="dark"] .qd-card{color:var(--ink)}
  html[data-theme="dark"] .qd-who-b:hover,
  html[data-theme="dark"] .qd-card:hover{border-color:${C.fill}}
  html[data-theme="dark"] .qd-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.35)}
  html[data-theme="dark"] .qd-cell{background:var(--card)!important}
  html[data-theme="dark"] .qd-cell[data-q="q1"]{background:rgba(229,72,77,.12)!important}
  html[data-theme="dark"] .qd-cell[data-q="q2"]{background:rgba(58,134,255,.12)!important}
  html[data-theme="dark"] .qd-cell[data-q="q3"]{background:rgba(245,135,46,.12)!important}
  html[data-theme="dark"] .qd-cell[data-q="q4"]{background:rgba(138,147,160,.12)!important}
  html[data-theme="dark"] .qd-mvbtn{color:var(--muted)}
  html[data-theme="dark"] .qd-mvbtn:hover{background:var(--track);color:var(--ink)}
  html[data-theme="dark"] .qd-mvmenu{border-color:var(--line);box-shadow:0 12px 34px rgba(0,0,0,.45)}
  html[data-theme="dark"] .qd-mvmenu-it{color:var(--ink)}
  html[data-theme="dark"] .qd-mvmenu-it:hover{background:var(--track)}
  html[data-theme="dark"] .qd-mvmenu-it.cur{color:var(--muted)}`;
}
