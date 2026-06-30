// 月カレンダー（TickTickのカレンダービュー相当）。月グリッドに 期限タスク＋会議/定例 を俯瞰表示。
// タスクチップをドラッグで別日に落とすと期限を移動（updateTask #9非破壊）。クリックで編集モーダル。
// 会議/定例は recurrences の展開（override 適用済み・時刻表示）＝動かせない（例外編集は時刻カレンダーで）。
import { load, invalidate } from "../lib/store.js";
import { firstHuman } from "../lib/users.js";
import { updateTask } from "../lib/api.js";
import { expandRecurrences } from "../lib/recurrence.js";
import { monthMatrix, DOW_JA } from "../lib/form.js";
import { C, esc, member_color, todayISO, avatar } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { openTaskForm } from "./taskform.js";

let VIEW = null; // {y, m}（表示中の月・セッション内で保持）
const WHO_KEY = "ts.monthcal.who"; // 担当者フィルタ選択を個人保存（再読込でも維持）
const TASK_KEY = "ts.monthcal.showTask"; // 種別トグル: タスクを表示するか（既定: 表示）
const REC_KEY = "ts.monthcal.showRec"; // 種別トグル: 会議/定例を表示するか（既定: 表示）
const lsFlag = (k) => { try { return localStorage.getItem(k) !== "0"; } catch { return true; } }; // 既定 true（"0" のときだけ false）
let FILTER = {
  who: (() => { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } })(),
  task: lsFlag(TASK_KEY),
  rec: lsFlag(REC_KEY),
};

const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
const hhmm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

// ローカル日付の足し算で ISO(YYYY-MM-DD)を作る（タイムゾーンずれ回避にローカル年月日で組む）。
const isoFromDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDaysISO = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoFromDate(d); };
// 今週末(=直近の土曜)。今日が土なら今日、日なら前日土曜は過ぎているので翌週末は使わず「今週の土曜」=今日扱い。
const thisWeekendISO = (iso) => { const dow = new Date(iso + "T00:00:00").getDay(); return addDaysISO(iso, (6 - dow + 7) % 7); };
// 来週(=次の月曜)。今日の曜日から次の月曜までの日数。
const nextWeekISO = (iso) => { const dow = new Date(iso + "T00:00:00").getDay(); return addDaysISO(iso, ((8 - dow) % 7) || 7); };

// タスクチップ（日セル＝drag可 / ポップオーバー＝clickのみ で共用）。
// 期限超過は赤左ボーダー(.overdue)、重要度(priority>=1)は先頭に赤ドット(.mc-prio)を出す。
// タッチ端末は HTML5 DnD が効かないため、各チップに「日付を変更」の代替メニューを開く ⋮ ボタンを付ける
// （マウス環境では hover 時だけ薄く出す＝既存の見た目を邪魔しない。クリックでも動く）。
const taskChip = (it, { drag } = {}) =>
  `<div class="mc-task${it.done ? " done" : ""}${it.overdue ? " overdue" : ""}"${drag ? ` draggable="true"` : ""} data-id="${it.t.id}" title="${esc(it.title)}">
     ${it.prio >= 1 ? `<span class="mc-prio" aria-label="重要"></span>` : ""}${it.who ? `<i style="background:${member_color(it.who.id)}"></i>` : ""}<span class="mc-task-t">${esc(it.title)}</span><button type="button" class="mc-task-move" data-id="${it.t.id}" aria-label="日付を変更" title="日付を変更">⋮</button></div>`;

export async function render(root) {
  closePopover(root); closeMoveMenu(root); // 再描画前に開いていたポップ/移動メニューと document リスナを掃除
  const { tasks, members, recurrences, holidaysByDate, me } = await load();
  const today = todayISO();
  if (!VIEW) VIEW = { y: +today.slice(0, 4), m: +today.slice(5, 7) };
  const weeks = monthMatrix(VIEW.y, VIEW.m);
  const firstISO = weeks[0][0].iso, lastISO = weeks[5][6].iso;

  // 日付 → 項目。タスク=期限ベース（完了は薄く）・会議/定例=展開結果（時刻つき）
  const byDay = new Map();
  const add = (iso, item) => { (byDay.get(iso) || byDay.set(iso, []).get(iso)).push(item); };
  if (FILTER.rec) for (const { recurrence: rec, dateISO, assignees, override } of expandRecurrences(recurrences || [], firstISO, lastISO)) {
    const ids = assignees || rec.assignee_ids || [];
    if (FILTER.who && ids.length && !ids.includes(+FILTER.who)) continue;
    const d = new Date(rec.dtstart);
    const baseMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const min = override && override.start_minute != null ? override.start_minute : baseMin;
    add(dateISO, { kind: "rec", title: rec.title || "会議", min: min || null, sort: min || 0 });
  }
  if (FILTER.task) for (const t of tasks || []) {
    const due = dueISO(t);
    if (!due || due < firstISO || due > lastISO) continue;
    if (FILTER.who && !(t.assignees || []).some((a) => String(a.id) === FILTER.who)) continue;
    const who = firstHuman(t);
    const overdue = !t.done && due < today; // 未完了かつ期限切れ
    add(due, { kind: "task", t, title: t.title, who, done: !!t.done, prio: +t.priority || 0, overdue, sort: 10000 + (t.priority ? -t.priority : 0) });
  }
  for (const list of byDay.values()) list.sort((a, b) => a.sort - b.sort);

  // 担当者切替=ワンタップのボタンタブ（全員 / 自分 / 各メンバー）。選択は localStorage 永続（quad.js と同作法）。
  const meId = me && me.id;
  const meMember = (members || []).find((m) => m.id === meId);
  const others = (members || []).filter((m) => m.id !== meId);
  // av=avatar()用member（無ければアバター無し＝「全員」）。「自分」は表記を保つため name を上書きした合成member。
  const whoBtn = (val, label, av) => {
    const on = String(FILTER.who) === String(val) ? " on" : "";
    return `<button class="mc-who-b${on}" data-who="${esc(String(val))}">${av ? avatar(av, { size: 16 }) : ""}${esc(label)}</button>`;
  };
  const whoTabs = whoBtn("", "全員", null)
    + (meMember ? whoBtn(meMember.id, "自分", { id: meMember.id, name: "自分" }) : "")
    + others.map((m) => whoBtn(m.id, m.name || m.username, m)).join("");
  const kindBtn = (k, label, on) =>
    `<button class="mc-kind-b${on ? " on" : ""}" data-kind="${k}" aria-pressed="${on}">${label}</button>`;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">月カレンダー <small>期限タスク＋会議/定例 ・ チップをドラッグで期限移動 ・ 空きをクリックで新規</small></h1>
    <div class="mc-tools">
      <button id="mc-prev" class="mc-nav">‹</button>
      <b class="mc-title">${VIEW.y}年${VIEW.m}月</b>
      <button id="mc-next" class="mc-nav">›</button>
      <button id="mc-today" class="mc-nav mc-tdy">今日</button>
      <div class="mc-kinds" id="mc-kinds">${kindBtn("task", "タスク", FILTER.task)}${kindBtn("rec", "会議", FILTER.rec)}</div>
    </div>
    <div class="mc-who" id="mc-who">${whoTabs}</div>
    <div class="card mc-grid">
      ${DOW_JA.map((n, i) => `<div class="mc-dow ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${n}</div>`).join("")}
      ${weeks.flat().map((c) => dayHtml(c, byDay.get(c.iso) || [], today, holidaysByDate)).join("")}
    </div>`;

  root.querySelector("#mc-prev").onclick = () => { VIEW.m--; if (VIEW.m < 1) { VIEW.m = 12; VIEW.y--; } render(root); };
  root.querySelector("#mc-next").onclick = () => { VIEW.m++; if (VIEW.m > 12) { VIEW.m = 1; VIEW.y++; } render(root); };
  root.querySelector("#mc-today").onclick = () => { VIEW = null; render(root); };
  root.querySelectorAll("#mc-who [data-who]").forEach((b) => {
    b.onclick = () => { FILTER.who = b.dataset.who; try { localStorage.setItem(WHO_KEY, FILTER.who); } catch {} render(root); };
  });
  root.querySelectorAll("#mc-kinds [data-kind]").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.kind;
      FILTER[k] = !FILTER[k];
      try { localStorage.setItem(k === "task" ? TASK_KEY : REC_KEY, FILTER[k] ? "1" : "0"); } catch {}
      render(root);
    };
  });

  root.querySelectorAll(".mc-task").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: async () => { invalidate(); await load(); render(root); } });
    el.ondragstart = (ev) => { ev.dataTransfer.setData("text/plain", el.dataset.id); ev.dataTransfer.effectAllowed = "move"; };
  });
  // 「他N件」＝その日の全項目ポップオーバー。クリックで開閉・外側クリック/Escで閉じる。
  root.querySelectorAll(".mc-more").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const iso = btn.dataset.iso;
      const already = root.querySelector(".mc-pop");
      closePopover(root);
      if (already && already.dataset.iso === iso) return; // 同じ日のトグルは閉じるだけ
      openPopover(root, btn, iso, byDay.get(iso) || [], tasks, today);
    };
  });

  root.querySelectorAll(".mc-day").forEach((cell) => {
    // 空き領域クリックで新規作成（B12 軽量版・プリフィルは将来）。チップ/他N件/祝日ラベル等の上は除外。
    cell.onclick = (ev) => {
      if (root.querySelector(".mc-pop")) return; // ポップオーバー表示中はその外側クリックの後始末に専念
      if (ev.target.closest(".mc-task,.mc-rec,.mc-more,.mc-hol")) return; // 既存項目・操作の上は新規作成しない
      openTaskForm({ onSaved: async () => { invalidate(); await load(); render(root); } });
    };
    cell.ondragover = (ev) => { ev.preventDefault(); cell.classList.add("over"); };
    cell.ondragleave = () => cell.classList.remove("over");
    cell.ondrop = async (ev) => {
      ev.preventDefault();
      cell.classList.remove("over");
      const id = +ev.dataTransfer.getData("text/plain");
      await moveTaskDue(root, tasks, id, cell.dataset.iso);
    };
  });

  // タッチ代替: 各チップの ⋮ で「日付を変更」メニュー（クイック日付＋日付指定）を開く。
  // ＝デスクトップの DnD はそのまま、追加のみ。チップ本体の click(=編集) へ伝播させない。
  root.querySelectorAll(".mc-task-move").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const id = +btn.dataset.id;
      openMoveMenu(root, btn, id, tasks, today);
    };
  });
}

// 期限の移動を一括で行う共通関数（DnD のドロップ・タッチメニューの双方から呼ぶ）。
// 既存の updateTask(#9 非破壊) → invalidate → load → 再描画 の流れをそのまま再利用する。
async function moveTaskDue(root, tasks, id, iso) {
  const t = (tasks || []).find((x) => x.id === id);
  if (!t || dueISO(t) === iso) return;
  try {
    await updateTask(id, { due_date: iso + "T00:00:00Z" });
    invalidate(); await load(); render(root);
  } catch (e) { console.error(e); }
}

// チップの ⋮ から開く「日付を変更」小メニュー。tb-ctx 風の軽量ポップ。
// クイック日付（今日/明日/今週末/来週）＋日付指定（input[type=date]）。選ぶと moveTaskDue を呼ぶ。
function openMoveMenu(root, anchor, id, tasks, today) {
  // 「他N件」ポップ内のチップからも開くため、ポップは閉じない（anchor 消失を防ぐ）。
  // 同じ機構の移動メニューだけ排他にする（別チップを叩いたら旧メニューを畳む）。
  const existing = root.querySelector(".mc-move");
  closeMoveMenu(root);
  if (existing && +existing.dataset.id === id) return; // 同じチップの再タップで閉じる

  const cur = dueISO((tasks || []).find((x) => x.id === id) || {});
  const quick = [
    ["今日", today],
    ["明日", addDaysISO(today, 1)],
    ["今週末", thisWeekendISO(today)],
    ["来週", nextWeekISO(today)],
  ];
  const menu = document.createElement("div");
  menu.className = "mc-move";
  menu.dataset.id = String(id);
  menu.innerHTML = `
    <div class="mc-move-hd">日付を変更</div>
    ${quick.map(([label, iso]) => {
      const md = `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
      const on = iso === cur ? " on" : "";
      return `<button type="button" class="mc-move-b${on}" data-iso="${iso}"><span>${label}</span><small>${md}</small></button>`;
    }).join("")}
    <label class="mc-move-date">日付指定<input type="date" value="${cur || today}"></label>`;

  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  root.appendChild(menu);
  // anchor の近くに配置（root 基準の絶対配置。「他N件」ポップと同じ算法）。
  const rr = root.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const W = menu.offsetWidth || 168;
  let left = ar.left - rr.left;
  if (left + W > rr.width) left = Math.max(0, rr.width - W);
  let top = ar.bottom - rr.top + 2;
  if (ar.bottom + (menu.offsetHeight || 0) > window.innerHeight) {
    top = Math.max(0, ar.top - rr.top - (menu.offsetHeight || 0) - 2);
  }
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  menu.querySelectorAll(".mc-move-b").forEach((b) => {
    b.onclick = async (e) => { e.stopPropagation(); const iso = b.dataset.iso; closeMoveMenu(root); await moveTaskDue(root, tasks, id, iso); };
  });
  const dateInput = menu.querySelector(".mc-move-date input");
  dateInput.onclick = (e) => e.stopPropagation();
  dateInput.onchange = async (e) => { e.stopPropagation(); const iso = e.target.value; if (!iso) return; closeMoveMenu(root); await moveTaskDue(root, tasks, id, iso); };

  // 外側クリック / Esc で閉じる（次フレーム登録で自身のタップを拾わない＝「他N件」ポップと同作法）。
  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeMoveMenu(root); };
  const onKey = (e) => { if (e.key === "Escape") closeMoveMenu(root); };
  menu._cleanup = () => { document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onKey, true); };
  setTimeout(() => { document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onKey, true); }, 0);
}

function closeMoveMenu(root) {
  const m = root.querySelector(".mc-move");
  if (!m) return;
  if (m._cleanup) m._cleanup();
  m.remove();
}

// その日の全項目を出すポップオーバー。各タスクは既存と同様 openTaskForm で編集へ。
function openPopover(root, anchor, iso, items, tasks, today) {
  const pop = document.createElement("div");
  pop.className = "mc-pop";
  pop.dataset.iso = iso;
  const dlabel = `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
  pop.innerHTML = `
    <div class="mc-pop-hd"><b>${dlabel}</b><span>${items.length}件</span><button type="button" class="mc-pop-x" aria-label="閉じる">×</button></div>
    <div class="mc-pop-list">
      ${items.length ? items.map((it) => it.kind === "rec"
        ? `<div class="mc-rec" title="${esc(it.title)}">${icon("repeat", { size: 12 })}${it.min != null ? ` ${hhmm(it.min)}` : ""} ${esc(it.title)}</div>`
        : taskChip(it, { drag: false })).join("")
        : `<div class="mc-pop-empty">項目なし</div>`}
    </div>`;

  // セルの近くに配置（root 基準の絶対配置。grid の overflow:hidden で切れないよう外に出す）
  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  root.appendChild(pop);
  const rr = root.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const W = pop.offsetWidth || 230;
  let left = ar.left - rr.left;
  if (left + W > rr.width) left = Math.max(0, rr.width - W);
  let top = ar.bottom - rr.top + 2;
  // 下にはみ出すなら上方向に出す
  if (ar.bottom + (pop.offsetHeight || 0) > window.innerHeight) {
    top = Math.max(0, ar.top - rr.top - (pop.offsetHeight || 0) - 2);
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";

  pop.querySelector(".mc-pop-x").onclick = (e) => { e.stopPropagation(); closePopover(root); };
  pop.querySelectorAll(".mc-task").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = +el.dataset.id;
      closePopover(root);
      openTaskForm({ taskId: id, onSaved: async () => { invalidate(); await load(); render(root); } });
    };
  });
  // ポップ内チップの ⋮ も「日付を変更」メニューへ（日セルと同じ代替操作）。
  pop.querySelectorAll(".mc-task-move").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openMoveMenu(root, btn, +btn.dataset.id, tasks, today);
    };
  });

  // 外側クリック / Esc で閉じる（次フレームで登録して自身のクリックを拾わない）。
  // 上に開いた移動メニュー(.mc-move)内のクリックでは閉じない（ポップから移動メニューへ操作が続くため）。
  const onDoc = (e) => {
    if (pop.contains(e.target) || e.target === anchor) return;
    const mv = root.querySelector(".mc-move");
    if (mv && mv.contains(e.target)) return;
    closePopover(root);
  };
  const onKey = (e) => { if (e.key === "Escape") closePopover(root); };
  pop._cleanup = () => { document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onKey, true); };
  setTimeout(() => { document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onKey, true); }, 0);
}

function closePopover(root) {
  const pop = root.querySelector(".mc-pop");
  if (!pop) return;
  if (pop._cleanup) pop._cleanup();
  pop.remove();
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
      ? `<div class="mc-rec" title="${esc(it.title)}">${icon("repeat", { size: 12 })}${it.min != null ? ` ${hhmm(it.min)}` : ""} ${esc(it.title)}</div>`
      : taskChip(it, { drag: true })).join("")}
    ${items.length > MAX ? `<button type="button" class="mc-more" data-iso="${c.iso}">他${items.length - MAX}件</button>` : ""}
  </div>`;
}

function css() {
  return `
  .mc-tools{display:flex;align-items:center;gap:10px;margin:0 0 14px}
  .mc-title{font-size:15px;min-width:110px;text-align:center}
  .mc-nav{font:inherit;font-size:14px;border:1px solid ${C.line};background:${C.card};border-radius:8px;padding:5px 13px;cursor:pointer}
  .mc-nav:hover{background:${C.track}}
  .mc-tdy{font-size:12.5px}
  .mc-kinds{display:flex;gap:6px;margin-left:auto}
  .mc-kind-b{font:inherit;font-size:12.5px;padding:5px 12px;border:1px solid ${C.line};border-radius:8px;background:${C.card};color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .mc-kind-b:hover{border-color:#cfd9e6}
  .mc-kind-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .mc-who{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 14px}
  .mc-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:${C.card};color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .mc-who-b:hover{border-color:#cfd9e6}
  .mc-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .mc-who-b.on .ui-ava{box-shadow:0 0 0 1.5px #fff}
  .mc-grid{display:grid;grid-template-columns:repeat(7,1fr);overflow:hidden;padding:0;position:relative}
  .mc-dow{font-size:11px;color:${C.muted};font-weight:700;text-align:center;padding:8px 0;border-bottom:1px solid ${C.line};background:#fafbfc}
  .mc-dow.sat{color:#3a86ff}.mc-dow.sun{color:#e5484d}
  .mc-day{min-height:96px;border-bottom:1px solid ${C.line};border-right:1px solid ${C.line};padding:5px 6px;background:${C.card};cursor:pointer}
  .mc-day.out{cursor:default}
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
  .mc-task.overdue{background:#fdecec;color:#9a2b2e;border-left:3px solid #e5484d;padding-left:4px}
  .mc-task.overdue:hover{background:#fbdede}
  .mc-task.overdue.done{border-left-color:#c3c9d2}
  .mc-task i{flex:none;width:7px;height:7px;border-radius:50%;display:inline-block}
  .mc-prio{flex:none;width:5px;height:5px;border-radius:50%;background:#e5484d;display:inline-block}
  .mc-task-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* タッチ代替の「日付を変更」ボタン。マウス環境では既存の見た目を邪魔しないよう hover 時だけ薄く出す。 */
  .mc-task-move{flex:none;margin-left:auto;font:inherit;font-size:12px;line-height:1;color:${C.muted};background:none;border:0;border-radius:4px;padding:0 2px;cursor:pointer;opacity:0;transition:opacity .12s,background .12s}
  .mc-task:hover .mc-task-move{opacity:.7}
  .mc-task-move:hover{opacity:1;background:rgba(20,30,50,.10)}
  /* タッチ端末（hover 不可・粗ポインタ）では常時可視＝指で押せるアフォーダンスを確保。 */
  @media (hover:none),(pointer:coarse){
    .mc-task-move{opacity:.85;font-size:14px;padding:0 4px}
    .mc-task{padding-top:3px;padding-bottom:3px}
  }
  /* 「日付を変更」小メニュー（tb-ctx 風）。 */
  .mc-move{position:absolute;z-index:40;width:168px;background:${C.card};border:1px solid ${C.line};border-radius:10px;box-shadow:0 8px 28px rgba(20,30,50,.18);padding:6px}
  .mc-move-hd{font-size:10.5px;color:${C.muted};font-weight:700;padding:2px 6px 4px}
  .mc-move-b{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;font:inherit;font-size:12.5px;text-align:left;padding:6px 8px;border:0;border-radius:6px;background:none;color:${C.ink};cursor:pointer}
  .mc-move-b:hover{background:${C.track}}
  .mc-move-b.on{color:${C.fill};font-weight:700}
  .mc-move-b small{color:${C.muted};font-size:10.5px}
  .mc-move-b.on small{color:${C.fill}}
  .mc-move-date{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:${C.muted};margin-top:4px;padding:4px 8px 2px;border-top:1px solid ${C.line}}
  .mc-move-date input{font:inherit;font-size:12px;border:1px solid ${C.line};border-radius:6px;padding:3px 5px;background:${C.card};color:inherit}
  .mc-rec{background:#f2eefc;color:#6b4fa0}
  .mc-more{font:inherit;font-size:10px;color:${C.muted};padding:1px 5px;background:none;border:0;border-radius:4px;cursor:pointer;display:block;text-align:left}
  .mc-more:hover{background:${C.track};color:${C.fill}}
  .mc-pop{position:absolute;z-index:30;width:230px;max-height:300px;overflow:auto;background:${C.card};border:1px solid ${C.line};border-radius:10px;box-shadow:0 8px 28px rgba(20,30,50,.18);padding:8px}
  .mc-pop-hd{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:0 2px}
  .mc-pop-hd b{font-size:12.5px}
  .mc-pop-hd span{font-size:11px;color:${C.muted}}
  .mc-pop-x{margin-left:auto;font:inherit;font-size:15px;line-height:1;border:0;background:none;color:${C.muted};cursor:pointer;padding:0 2px}
  .mc-pop-x:hover{color:${C.fill}}
  .mc-pop-list .mc-task{white-space:normal;cursor:pointer}
  .mc-pop-list .mc-rec{white-space:normal}
  .mc-pop-empty{font-size:11px;color:${C.muted};padding:4px 2px}
  /* ===== ダーク: ハードコード淡色を構造色へ（ライトは非変更） ===== */
  html[data-theme="dark"] .mc-nav{background:var(--card);color:var(--ink)}
  html[data-theme="dark"] .mc-kind-b,
  html[data-theme="dark"] .mc-who-b{background:var(--card);color:var(--muted)}
  html[data-theme="dark"] .mc-kind-b:hover,
  html[data-theme="dark"] .mc-who-b:hover{border-color:${C.fill}}
  html[data-theme="dark"] .mc-kind-b.on,
  html[data-theme="dark"] .mc-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff}
  html[data-theme="dark"] .mc-dow{background:var(--track)}
  html[data-theme="dark"] .mc-day{background:var(--card)}
  html[data-theme="dark"] .mc-day.out{background:var(--track)}
  html[data-theme="dark"] .mc-day.out .mc-num{color:var(--muted)}
  html[data-theme="dark"] .mc-day.today{background:rgba(58,134,255,.13)}
  html[data-theme="dark"] .mc-task{background:rgba(58,134,255,.18);color:var(--ink)}
  html[data-theme="dark"] .mc-task:hover{background:rgba(58,134,255,.28)}
  html[data-theme="dark"] .mc-task.overdue{background:rgba(229,72,77,.20);color:#ffb3b5;border-left-color:#e5484d}
  html[data-theme="dark"] .mc-task.overdue:hover{background:rgba(229,72,77,.30)}
  html[data-theme="dark"] .mc-rec{background:rgba(124,77,200,.22);color:#c4a9f0}
  html[data-theme="dark"] .mc-pop{background:var(--card)}
  html[data-theme="dark"] .mc-task-move{color:var(--muted)}
  html[data-theme="dark"] .mc-task-move:hover{background:rgba(255,255,255,.12)}
  html[data-theme="dark"] .mc-move{background:var(--card)}
  html[data-theme="dark"] .mc-move-b:hover{background:var(--track)}
  html[data-theme="dark"] .mc-move-date input{background:var(--card);color:var(--ink)}`;
}
