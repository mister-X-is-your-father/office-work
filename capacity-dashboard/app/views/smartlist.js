// スマートリスト（TickTick の Smart List をブラッシュアップ）。
// 左レール=組み込みビュー＋保存したカスタムフィルタ。右=フィルタバー＋結果（インライン完了/フラグ/編集）。
// 保存はローカル（localStorage・スキーマ変更なし）。完了/フラグは updateTask（#9 非破壊）。
import { load, invalidate, projectName } from "../lib/store.js";
import { updateTask } from "../lib/api.js";
import { taskMatches, next7End, EMPTY_FILTER, BUILTIN_VIEWS } from "../lib/smartlist.js";
import { shiftISO } from "../lib/capacity.js";
import { PRIO, categoryLabels, categoryColor } from "../lib/kinds.js";
import { INBOX_WS } from "./quickadd.js";
import { openTaskForm } from "./taskform.js";
import { C, esc, fmtH, member_color, todayISO } from "../lib/ui.js";

const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

const SEL_KEY = (uid) => `ts.smartlist.sel.${uid ?? "anon"}`;
const LISTS_KEY = (uid) => `ts.smartlists.${uid ?? "anon"}`;
const SORTS = [["due", "期日順"], ["prio", "優先度順"], ["title", "名前順"], ["created", "追加順"]];

let state = null; // { sel, filter, sort }
const loadLists = (uid) => { try { return JSON.parse(localStorage.getItem(LISTS_KEY(uid)) || "[]"); } catch { return []; } };
const saveLists = (uid, v) => { try { localStorage.setItem(LISTS_KEY(uid), JSON.stringify(v)); } catch {} };

export async function render(root) {
  const data = await load();
  const { tasks, projects, labels = [], me } = data;
  const uid = (me && me.id) || 0;
  const today = todayISO();
  const ctx = { today, next7: next7End(today) };
  const inboxWs = (projects || []).find((p) => p.title === INBOX_WS);
  const lists = loadLists(uid);

  // 組み込みビューの実フィルタ（inbox は ws を解決）。
  const presetOf = (v) => v.inbox ? { ...EMPTY_FILTER, ...v.filter, ws: inboxWs ? inboxWs.id : 0 } : { ...EMPTY_FILTER, ...v.filter };

  if (!state) {
    let sel = "inbox"; try { sel = localStorage.getItem(SEL_KEY(uid)) || "inbox"; } catch {}
    state = { sel, sort: "due", filter: null };
  }
  // 選択中ビュー → filter を確定（adhoc 以外は選択から再構築）
  if (state.sel !== "adhoc") {
    const bv = BUILTIN_VIEWS.find((v) => v.key === state.sel);
    const cv = lists.find((l) => l.id === state.sel);
    state.filter = bv ? presetOf(bv) : (cv ? { ...EMPTY_FILTER, ...cv.filter } : presetOf(BUILTIN_VIEWS[0]));
    if (!bv && !cv) state.sel = "inbox";
  }

  // 一致＋分類（kinds 依存は view 側）＋ソート
  const catTitle = state.filter._cat || "";
  const matched = (tasks || []).filter((t) => taskMatches(t, state.filter, ctx) && (!catTitle || categoryLabels(t).some((l) => l.title === catTitle)));
  const sorted = sortTasks(matched, state.sort, today);

  // 左レール件数（組み込み）
  const countOf = (v) => (tasks || []).filter((t) => taskMatches(t, presetOf(v), ctx)).length;

  const curName = currentViewName(state, lists);

  root.innerHTML = `
    <style>${css()}</style>
    <div class="sl">
      <aside class="sl-rail">
        <div class="sl-rgrp">ビュー</div>
        ${BUILTIN_VIEWS.map((v) => railItem(v.key, v.icon, v.label, countOf(v), state.sel === v.key)).join("")}
        <div class="sl-rgrp">スマートリスト ${lists.length ? "" : `<span class="sl-rhint">条件を保存</span>`}</div>
        ${lists.map((l) => railItem(l.id, "🔖", l.name, null, state.sel === l.id, true)).join("") || `<div class="sl-rempty">右で条件を作って「保存」</div>`}
      </aside>
      <section class="sl-main">
        <div class="sl-head">
          <div class="sl-title">${esc(curName)} <span class="sl-count" id="sl-count">${sorted.length}</span></div>
          <div class="sl-sort">並べ替え
            <select id="sl-sort">${SORTS.map(([k, n]) => `<option value="${k}"${state.sort === k ? " selected" : ""}>${n}</option>`).join("")}</select>
          </div>
        </div>
        <div class="sl-bar">
          <input id="sl-text" class="sl-in sl-text" placeholder="🔍 このビュー内を検索" value="${esc(state.filter.text || "")}">
          ${sel("sl-due", state.filter.due, [["", "期日：すべて"], ["today", "今日"], ["next7", "次の7日間"], ["overdue", "期限切れ"], ["hasdue", "期日あり"], ["none", "期日なし"]])}
          ${sel("sl-prio", state.filter.prio, [["", "優先度：すべて"], ["top", "最優先"], ["high", "高+"], ["mid", "中+"], ["none", "なし"]])}
          ${sel("sl-cat", catTitle, [["", "分類：すべて"], ...catChoices(labels)])}
          ${sel("sl-ws", String(state.filter.ws || ""), [["", "WS：すべて"], ...(projects || []).map((p) => [String(p.id), p.title])])}
          ${sel("sl-status", state.filter.status, [["undone", "未完了"], ["todo", "未着手"], ["doing", "進行中"], ["done", "完了"], ["", "すべて"]])}
          <button id="sl-flag" class="sl-flagbtn${state.filter.flag ? " on" : ""}" title="フラグ付きのみ">🚩</button>
          ${state.sel === "adhoc" ? `<button id="sl-save" class="sl-save">＋ 保存</button>` : ""}
          ${typeof state.sel === "number" ? `<button id="sl-del" class="sl-del">このリストを削除</button>` : ""}
        </div>
        <div class="sl-list" id="sl-results">${resultsHtml(sorted, projects, today, state.sort)}</div>
      </section>
    </div>`;

  wire(root, data, uid, lists, ctx);
}

function sortTasks(arr, sort, today) {
  const due = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "9999-99-99");
  const cmp = {
    due: (a, b) => due(a).localeCompare(due(b)) || (b.priority || 0) - (a.priority || 0),
    prio: (a, b) => (b.priority || 0) - (a.priority || 0) || due(a).localeCompare(due(b)),
    title: (a, b) => (a.title || "").localeCompare(b.title || "", "ja"),
    created: (a, b) => String(b.created || "").localeCompare(String(a.created || "")),
  }[sort] || (() => 0);
  return [...arr].sort(cmp);
}

function currentViewName(state, lists) {
  if (state.sel === "adhoc") return "カスタム条件";
  const bv = BUILTIN_VIEWS.find((v) => v.key === state.sel);
  if (bv) return `${bv.icon} ${bv.label}`;
  const cv = lists.find((l) => l.id === state.sel);
  return cv ? `🔖 ${cv.name}` : "ビュー";
}

const catChoices = (labels) => [...new Set((labels || []).map((l) => l.title).filter((t) => t && t !== "レビュー"))]
  .sort((a, b) => a.localeCompare(b, "ja")).map((t) => [t, t]);

function sel(id, val, opts) {
  return `<select id="${id}" class="sl-in">${opts.map(([v, n]) => `<option value="${esc(v)}"${String(v) === String(val || "") ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
}

function railItem(key, icon, label, count, on, custom) {
  return `<button class="sl-ritem${on ? " on" : ""}" data-view="${esc(String(key))}"${custom ? ' data-custom="1"' : ""}>
    <span class="sl-ric">${icon}</span><span class="sl-rlbl">${esc(label)}</span>
    ${count != null ? `<span class="sl-rcnt">${count}</span>` : ""}
    ${custom ? `<span class="sl-rdel" data-del="${esc(String(key))}" title="削除">×</span>` : ""}
  </button>`;
}

function rowHtml(t, projects, today) {
  const done = !!t.done;
  const dueRaw = t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "";
  const overdue = dueRaw && dueRaw < today && !done;
  const isToday = dueRaw === today;
  const dueCls = overdue ? "over" : isToday ? "today" : "";
  const dueTxt = dueRaw ? (isToday ? "今日" : dueRaw.slice(5).replace("-", "/")) : "";
  const p = PRIO[t.priority || 0];
  const cat = categoryLabels(t)[0] || null;
  const est = (t.time_estimate || 0) / 3600;
  return `<div class="sl-row${done ? " is-done" : ""}" data-id="${t.id}">
    <button class="sl-check${done ? " done" : ""}" data-check="${t.id}" title="${done ? "未完了に戻す" : "完了にする"}">${done ? "✓" : ""}</button>
    <span class="sl-pdot${p ? "" : " none"}" style="${p ? `background:${p.c}` : ""}"></span>
    <span class="sl-rtitle">${esc(t.title)}</span>
    <span class="sl-meta">
      ${cat ? `<span class="sl-cat" style="color:${categoryColor(cat)};border-color:${categoryColor(cat)}55">${esc(cat.title)}</span>` : ""}
      <span class="sl-ws">${esc(projectName(projects, t.project_id))}</span>
      ${est ? `<span class="sl-est">${fmtH(est)}</span>` : ""}
    </span>
    ${dueTxt ? `<span class="sl-due ${dueCls}">${dueTxt}</span>` : `<span class="sl-due none"></span>`}
    <button class="sl-flagrow${t.is_favorite ? " on" : ""}" data-flag="${t.id}" title="フラグ">🚩</button>
  </div>`;
}

const emptyHtml = () => `<div class="sl-empty"><div class="sl-empty-i">🗂️</div>このビューに該当するタスクはありません。</div>`;

// 期日ソート時はアジェンダ風に日別グルーピング（期限切れ/今日/明日/日付/期日なし）。
function resultsHtml(sorted, projects, today, sort) {
  if (!sorted.length) return emptyHtml();
  if (sort !== "due") return sorted.map((t) => rowHtml(t, projects, today)).join("");
  const groups = groupByDue(sorted, today);
  return groups.map((g) => `<div class="sl-gh ${g.cls}">${esc(g.header)} <span class="sl-gn">${g.tasks.length}</span></div>
    ${g.tasks.map((t) => rowHtml(t, projects, today)).join("")}`).join("");
}

function groupByDue(tasks, today) {
  const tomorrow = shiftISO(today, 1);
  const dueOf = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
  const order = [];
  const map = new Map();
  const put = (key, header, cls, t) => {
    if (!map.has(key)) { map.set(key, { key, header, cls, tasks: [] }); order.push(key); }
    map.get(key).tasks.push(t);
  };
  for (const t of tasks) {
    const d = dueOf(t);
    if (!d) put("none", "期日なし", "none", t);
    else if (d < today) put("over", "期限切れ", "over", t);
    else if (d === today) put("today", "今日", "today", t);
    else if (d === tomorrow) put("tomorrow", "明日", "", t);
    else {
      const dt = new Date(d + "T00:00:00Z");
      put(d, `${d.slice(5).replace("-", "/")}（${DOW_JA[dt.getUTCDay()]}）`, "", t);
    }
  }
  // 期限切れ→今日→明日→日付昇順→期日なし
  const rank = (k) => k === "over" ? 0 : k === "today" ? 1 : k === "tomorrow" ? 2 : k === "none" ? 9 : 5;
  return order.map((k) => map.get(k)).sort((a, b) => (rank(a.key) - rank(b.key)) || a.key.localeCompare(b.key));
}

function wire(root, data, uid, lists, ctx) {
  const rerender = () => render(root);
  const persistSel = () => { try { localStorage.setItem(SEL_KEY(uid), String(state.sel)); } catch {} };

  // 左レール選択
  root.querySelectorAll(".sl-ritem").forEach((b) => {
    b.onclick = (e) => {
      if (e.target.closest("[data-del]")) return; // 削除は別ハンドラ
      const v = b.dataset.view;
      state.sel = b.dataset.custom ? +v : v;
      persistSel(); rerender();
    };
  });
  root.querySelectorAll("[data-del]").forEach((x) => {
    x.onclick = (e) => {
      e.stopPropagation();
      const id = +x.dataset.del;
      const next = lists.filter((l) => l.id !== id);
      saveLists(uid, next);
      if (state.sel === id) state.sel = "inbox";
      rerender();
    };
  });

  // フィルタバー → adhoc 化
  const toAdhoc = (patch) => { state.filter = { ...state.filter, ...patch }; state.sel = "adhoc"; };
  const textEl = root.querySelector("#sl-text");
  if (textEl) textEl.oninput = () => { toAdhoc({ text: textEl.value }); paintResults(root, data, ctx); updateCount(root, data, ctx); };
  const onSel = (id, key, num) => { const el = root.querySelector("#" + id); if (el) el.onchange = () => { const v = num ? (+el.value || 0) : el.value; toAdhoc({ [key]: v }); rerender(); }; };
  onSel("sl-due", "due"); onSel("sl-prio", "prio"); onSel("sl-ws", "ws", true); onSel("sl-status", "status");
  const catEl = root.querySelector("#sl-cat");
  if (catEl) catEl.onchange = () => { toAdhoc({ _cat: catEl.value }); rerender(); };
  const flagBtn = root.querySelector("#sl-flag");
  if (flagBtn) flagBtn.onclick = () => { toAdhoc({ flag: !state.filter.flag }); rerender(); };
  const sortEl = root.querySelector("#sl-sort");
  if (sortEl) sortEl.onchange = () => { state.sort = sortEl.value; paintResults(root, data, ctx); };

  // 保存 / 削除
  const saveBtn = root.querySelector("#sl-save");
  if (saveBtn) saveBtn.onclick = () => {
    const name = (prompt("スマートリスト名", suggestName(state.filter)) || "").trim();
    if (!name) return;
    const id = Date.now();
    const { _cat, ...f } = state.filter;
    const next = [...lists, { id, name, filter: { ...f, _cat } }];
    saveLists(uid, next); state.sel = id; persistSel(); rerender();
  };
  const delBtn = root.querySelector("#sl-del");
  if (delBtn) delBtn.onclick = () => {
    const next = lists.filter((l) => l.id !== state.sel);
    saveLists(uid, next); state.sel = "inbox"; rerender();
  };

  // 結果行: 完了/フラグ/編集
  wireRows(root, data, rerender);
}

function wireRows(root, data, rerender) {
  root.querySelectorAll(".sl-row").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest("[data-check]") || e.target.closest("[data-flag]")) return;
      openTaskForm({ taskId: +row.dataset.id, onSaved: rerender });
    };
  });
  root.querySelectorAll("[data-check]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = +b.dataset.check;
      const t = (data.tasks || []).find((x) => x.id === id); if (!t) return;
      const row = b.closest(".sl-row");
      row.classList.add("completing"); b.disabled = true;
      try {
        await updateTask(id, t.done ? { done: false } : { done: true, percent_done: 100 });
        invalidate(); rerender();
      } catch (err) { row.classList.remove("completing"); b.disabled = false; alert("更新に失敗: " + err.message); }
    };
  });
  root.querySelectorAll("[data-flag]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = +b.dataset.flag;
      const t = (data.tasks || []).find((x) => x.id === id); if (!t) return;
      b.classList.toggle("on"); b.disabled = true;
      try { await updateTask(id, { is_favorite: !t.is_favorite }); invalidate(); rerender(); }
      catch (err) { b.disabled = false; alert("更新に失敗: " + err.message); }
    };
  });
}

// 結果のみ再描画（テキスト/ソート変更で入力フォーカスを保つ）
function paintResults(root, data, ctx) {
  const catTitle = state.filter._cat || "";
  const matched = (data.tasks || []).filter((t) => taskMatches(t, state.filter, ctx) && (!catTitle || categoryLabels(t).some((l) => l.title === catTitle)));
  const sorted = sortTasks(matched, state.sort, ctx.today);
  const box = root.querySelector("#sl-results");
  box.innerHTML = resultsHtml(sorted, data.projects, ctx.today, state.sort);
  wireRows(root, data, () => render(root));
}
function updateCount(root, data, ctx) {
  const catTitle = state.filter._cat || "";
  const n = (data.tasks || []).filter((t) => taskMatches(t, state.filter, ctx) && (!catTitle || categoryLabels(t).some((l) => l.title === catTitle))).length;
  const el = root.querySelector("#sl-count"); if (el) el.textContent = n;
}

function suggestName(f) {
  const parts = [];
  const dueN = { today: "今日", next7: "今週", overdue: "期限切れ", none: "期日なし", hasdue: "期日あり" }[f.due];
  const prN = { top: "最優先", high: "重要", mid: "中+", none: "優先度なし" }[f.prio];
  if (prN) parts.push(prN); if (dueN) parts.push(dueN); if (f.flag) parts.push("フラグ"); if (f._cat) parts.push(f._cat);
  return parts.join("・") || "マイリスト";
}

function css() {
  return `
  .sl{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}
  .sl-rail{position:sticky;top:8px;background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:8px;display:flex;flex-direction:column;gap:1px}
  .sl-rgrp{font-size:10.5px;font-weight:700;color:${C.muted};letter-spacing:.04em;padding:10px 8px 4px;display:flex;justify-content:space-between;align-items:center}
  .sl-rhint{font-weight:400}
  .sl-rempty{font-size:11px;color:${C.muted};padding:4px 8px 8px}
  .sl-ritem{display:flex;align-items:center;gap:9px;width:100%;border:0;background:transparent;font:inherit;font-size:13px;color:${C.ink};padding:7px 9px;border-radius:9px;cursor:pointer;text-align:left;position:relative}
  .sl-ritem:hover{background:${C.track}}
  .sl-ritem.on{background:${C.fill};color:#fff;font-weight:600}
  .sl-ric{width:18px;text-align:center;flex:none}
  .sl-rlbl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sl-rcnt{font-size:11px;font-variant-numeric:tabular-nums;background:rgba(0,0,0,.06);border-radius:9px;padding:0 7px;color:inherit}
  .sl-ritem.on .sl-rcnt{background:rgba(255,255,255,.25)}
  .sl-rdel{display:none;font-size:14px;color:inherit;opacity:.7;padding:0 2px}
  .sl-ritem:hover .sl-rdel{display:inline}
  .sl-rdel:hover{opacity:1}
  .sl-main{min-width:0}
  .sl-head{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 12px}
  .sl-title{font-size:20px;font-weight:800;letter-spacing:-.01em}
  .sl-count{font-size:13px;font-weight:700;color:${C.muted};background:${C.track};border-radius:11px;padding:1px 10px;margin-left:6px;vertical-align:2px}
  .sl-sort{font-size:12px;color:${C.muted};display:flex;align-items:center;gap:6px}
  .sl-sort select,.sl-in{font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid ${C.line};border-radius:9px;background:#fff;color:${C.ink}}
  .sl-bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;align-items:center}
  .sl-text{flex:1;min-width:200px}
  .sl-flagbtn{font:inherit;font-size:14px;padding:6px 11px;border:1px solid ${C.line};border-radius:9px;background:#fff;cursor:pointer;filter:grayscale(1) opacity(.55)}
  .sl-flagbtn.on{filter:none;border-color:${C.over};background:#fff5f5}
  .sl-save,.sl-del{font:inherit;font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:9px;cursor:pointer}
  .sl-save{border:1px solid ${C.fill};background:${C.fill};color:#fff}
  .sl-del{border:1px solid ${C.line};background:#fff;color:${C.over}}
  .sl-list{display:flex;flex-direction:column;gap:6px}
  .sl-gh{font-size:11.5px;font-weight:700;color:${C.muted};letter-spacing:.03em;padding:10px 4px 2px;display:flex;align-items:center;gap:7px}
  .sl-gh:first-child{padding-top:0}
  .sl-gh.over{color:${C.over}}.sl-gh.today{color:${C.amber}}
  .sl-gn{font-size:10.5px;font-weight:700;background:${C.track};color:${C.muted};border-radius:9px;padding:0 7px}
  .sl-row{display:flex;align-items:center;gap:11px;background:${C.card};border:1px solid ${C.line};border-radius:11px;padding:11px 14px;cursor:pointer;transition:box-shadow .12s,transform .12s,opacity .25s}
  .sl-row:hover{box-shadow:0 2px 10px rgba(20,30,50,.07);border-color:#dbe2ec}
  .sl-row.completing{opacity:0;transform:translateX(8px)}
  .sl-row.is-done .sl-rtitle{text-decoration:line-through;color:${C.muted}}
  .sl-check{width:21px;height:21px;border-radius:50%;border:2px solid ${C.line};background:#fff;color:#fff;cursor:pointer;flex:none;font-size:12px;line-height:1;display:grid;place-items:center;padding:0;transition:background .12s,border-color .12s}
  .sl-check:hover{border-color:${C.free}}
  .sl-check.done{background:${C.free};border-color:${C.free}}
  .sl-pdot{width:8px;height:8px;border-radius:3px;flex:none}
  .sl-pdot.none{width:5px;height:5px;border-radius:50%;background:${C.line};margin:0 1.5px}
  .sl-rtitle{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
  .sl-meta{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
  .sl-cat{font-size:10.5px;border:1px solid;border-radius:5px;padding:1px 7px;font-weight:600;white-space:nowrap}
  .sl-ws{font-size:11px;color:${C.muted};white-space:nowrap}
  .sl-est{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums}
  .sl-due{font-size:11.5px;font-weight:700;color:${C.muted};min-width:42px;text-align:right;flex:none;font-variant-numeric:tabular-nums}
  .sl-due.over{color:${C.over}}.sl-due.today{color:${C.amber}}.sl-due.none{min-width:42px}
  .sl-flagrow{border:0;background:transparent;cursor:pointer;font-size:14px;flex:none;filter:grayscale(1) opacity(.3);padding:0 2px}
  .sl-flagrow:hover{filter:grayscale(.3) opacity(.7)}
  .sl-flagrow.on{filter:none}
  .sl-empty{text-align:center;color:${C.muted};padding:50px 0;font-size:13px}
  .sl-empty-i{font-size:34px;margin-bottom:8px;filter:grayscale(.3) opacity(.6)}
  @media(max-width:720px){.sl{grid-template-columns:1fr}.sl-rail{flex-direction:row;flex-wrap:wrap;position:static}}`;
}
