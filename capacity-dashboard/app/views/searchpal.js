// 全文検索パレット（Ctrl+K / トップバー🔍）。タイトル/説明/分類/WSを横断検索 → Enter/クリックで編集モーダル。
// TickTickの検索のブラッシュアップ: コマンドパレット型（キーボード完結・↑↓選択）・完了込み・ランク付け。
import { load, projectName } from "../lib/store.js";
import { searchTasks } from "../lib/search.js";
import { esc, todayISO, openOverlay } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

let overlay = null;
let _searchKeyHandler = null; // mount のたび増殖しないようモジュールレベルで1つだけ保持

function rowHtml(t, projects, i, sel) {
  const due = t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(5, 10).replace("-", "/") : "";
  const late = due && t.due_date.slice(0, 10) < todayISO() && !t.done;
  const cats = (t.labels || []).map((l) => `<span class="sp-cat">${esc(l.title)}</span>`).join("");
  return `<div class="sp-row${i === sel ? " sel" : ""}${t.done ? " done" : ""}" data-id="${t.id}">
    <span class="sp-title">${esc(t.title)}</span>${cats}
    <span class="sp-meta">${esc(projectName(projects, t.project_id))}${due ? ` ・ <span class="${late ? "sp-late" : ""}">${due}</span>` : ""}${t.done ? " ・ 完了" : ""}</span>
  </div>`;
}

export function openSearch() {
  if (overlay) return; // 多重起動防止
  ensureStyle();
  const box = document.createElement("div");
  box.className = "sp-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "タスク検索");
  box.innerHTML = `
      <input id="sp-in" autocomplete="off" placeholder="タスクを検索（タイトル・説明・分類・ワークスペース）" aria-label="検索語">
      <div class="sp-list" id="sp-list"><div class="sp-hint">入力で検索 ・ ↑↓ 選択 ・ Enter 開く ・ Esc 閉じる</div></div>`;
  const input = box.querySelector("#sp-in");
  const list = box.querySelector("#sp-list");
  let results = [], sel = 0, data = null;

  // 共有 openOverlay にカードを渡す（背景生成/Escape/背景クリック/フォーカストラップ/スクロールロックを自動付与）。
  const ui = openOverlay(box, { align: "top", onClose: () => { overlay = null; }, initialFocus: input });
  overlay = ui.bg; // 多重起動ガードの真値として保持
  const close = ui.close;
  const open = (id) => { close(); openTaskForm({ taskId: id }); };

  const paint = () => {
    if (!results.length) {
      list.innerHTML = input.value.trim()
        ? `<div class="sp-hint">該当なし</div>`
        : `<div class="sp-hint">入力で検索 ・ ↑↓ 選択 ・ Enter 開く ・ Esc 閉じる</div>`;
      return;
    }
    list.innerHTML = results.map((t, i) => rowHtml(t, data.projects, i, sel)).join("");
    list.querySelectorAll(".sp-row").forEach((r) => {
      r.onmousedown = (ev) => { ev.preventDefault(); open(+r.dataset.id); };
    });
    const cur = list.querySelector(".sp-row.sel");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  };
  const run = async () => {
    if (!data) { try { data = await load(); } catch { data = { tasks: [], projects: [] }; } }
    results = searchTasks(data.tasks, input.value, { projOf: (t) => projectName(data.projects, t.project_id) });
    sel = 0;
    paint();
  };
  input.addEventListener("input", run);
  input.addEventListener("keydown", (ev) => {
    // Escape／背景クリックは openOverlay が担当（document capture keydown + 背景 mousedown）。
    if (ev.key === "ArrowDown") { ev.preventDefault(); if (results.length) { sel = (sel + 1) % results.length; paint(); } }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); if (results.length) { sel = (sel - 1 + results.length) % results.length; paint(); } }
    else if (ev.key === "Enter") { ev.preventDefault(); if (results[sel]) open(results[sel].id); }
  });
}

// app.js から1回だけ呼ぶ: トップバーに🔍ボタン＋Ctrl/Cmd+K のグローバルフック
export function mountSearch(topbar) {
  const btn = document.createElement("button");
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;pointer-events:none"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.title = "検索（Ctrl/Cmd+K）";
  btn.setAttribute("aria-label", "検索（Ctrl/Cmd+K）");
  const anchor = topbar.querySelector("#refresh");
  anchor ? anchor.before(btn) : topbar.appendChild(btn);
  btn.onclick = openSearch;
  // shell() 再実行（再ログイン等）で mountSearch が再度呼ばれてもリスナが増殖しないよう、
  // 既存ハンドラを解除してから1つだけ登録する（常にちょうど1個を担保）。
  if (_searchKeyHandler) document.removeEventListener("keydown", _searchKeyHandler);
  _searchKeyHandler = (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); openSearch(); }
  };
  document.addEventListener("keydown", _searchKeyHandler);
}

let _style = false;
function ensureStyle() {
  if (_style) return; _style = true;
  const s = document.createElement("style");
  // バックドロップ（旧 .sp-ov）は openOverlay の共有 .ov-bg.ov-top に置換済み。ここはカード本体以下のみ。
  s.textContent = `
  .sp-box{width:min(640px,92vw);background:#fff;border-radius:14px;box-shadow:0 24px 70px rgba(10,18,35,.35);overflow:hidden}
  .sp-box input{width:100%;box-sizing:border-box;border:0;border-bottom:1px solid var(--line);font:inherit;font-size:15px;padding:15px 18px;outline:none}
  .sp-list{max-height:54vh;overflow-y:auto;padding:6px}
  .sp-hint{font-size:12px;color:var(--muted);padding:14px;text-align:center}
  .sp-row{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:9px;cursor:pointer;font-size:13.5px}
  .sp-row:hover,.sp-row.sel{background:#eef4ff}
  .sp-row.done .sp-title{color:var(--muted);text-decoration:line-through}
  .sp-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-cat{flex:none;font-size:10.5px;color:var(--fill);border:1px solid #cfe0ff;border-radius:5px;padding:0 6px}
  .sp-meta{flex:none;margin-left:auto;font-size:11.5px;color:var(--muted);white-space:nowrap}
  .sp-late{color:#e5484d;font-weight:600}

  /* ===== ダークモード上書き（lightは不変・末尾で html[data-theme="dark"] のみ追加） ===== */
  html[data-theme="dark"] .sp-box{background:var(--card);box-shadow:0 24px 70px rgba(0,0,0,.5)}
  html[data-theme="dark"] .sp-row:hover,html[data-theme="dark"] .sp-row.sel{background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .sp-cat{border-color:rgba(58,134,255,.40)}
  html[data-theme="dark"] .sp-late{color:#ff9b96}`;
  document.head.appendChild(s);
}
