// スマートリスト（TickTick の Smart List をブラッシュアップ）。
// 上部タブ=組み込みビュー＋保存したカスタムフィルタ（横セグメント・wrap/横スクロール対応）。下=フィルタバー＋結果（インライン完了/フラグ/編集）。
// 左の縦レールは廃止（アプリ共通ナビと差別化、本文フル幅）。各タブ=icon＋ラベル＋件数バッジ、クリックでビュー切替。
// 保存はローカル（localStorage・スキーマ変更なし）。完了/フラグは updateTask（#9 非破壊）。
import { load, invalidate, isAiUser } from "../lib/store.js";
import { updateTask } from "../lib/api.js";
import { taskMatches, next7End, EMPTY_FILTER, BUILTIN_VIEWS } from "../lib/smartlist.js";
import { shiftISO } from "../lib/capacity.js";
import { PRIO, categoryLabels, categoryColor } from "../lib/kinds.js";
import { openTaskForm } from "./taskform.js";
import { C, esc, fmtH, member_color, todayISO, emptyState } from "../lib/ui.js";
import { push as histPush, initHistoryHotkeys } from "../lib/history.js";
import { icon } from "../lib/icons.js";

const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
const ICON_X = icon("x", { size: 13 });

const SEL_KEY = (uid) => `ts.smartlist.sel.${uid ?? "anon"}`;
const LISTS_KEY = (uid) => `ts.smartlists.${uid ?? "anon"}`;
// 担当フィルタ（"" すべて / "none" 担当なし / "<id>" その人）。ビュー切替をまたいで個人保存（quad の WHO_KEY 同様）。
const WHO_KEY = (uid) => `ts.smartlist.who.${uid ?? "anon"}`;
const loadWho = (uid) => { try { return localStorage.getItem(WHO_KEY(uid)) || ""; } catch { return ""; } };
const saveWho = (uid, v) => { try { localStorage.setItem(WHO_KEY(uid), v == null ? "" : String(v)); } catch {} };
const SORTS = [["due", "期限順"], ["prio", "重要度順"], ["title", "名前順"], ["created", "追加順"]];

let state = null; // { sel, filter, sort }
let searchTimer = null; // 検索入力デバウンス用タイマ
const loadLists = (uid) => { try { return JSON.parse(localStorage.getItem(LISTS_KEY(uid)) || "[]"); } catch { return []; } };
const saveLists = (uid, v) => { try { localStorage.setItem(LISTS_KEY(uid), JSON.stringify(v)); } catch {} };

export async function render(root) {
  initHistoryHotkeys(); // Ctrl+Z / Ctrl+Y（完了/フラグの取り消し）を有効化
  const data = await load();
  const { tasks, projects, labels = [], members = [], me } = data;
  const uid = (me && me.id) || 0;
  const today = todayISO();
  const ctx = { today, next7: next7End(today) };
  const lists = loadLists(uid);

  // 組み込みビューの実フィルタ（未整理は v.filter.unsorted で判定。WS解決は不要）。
  const presetOf = (v) => ({ ...EMPTY_FILTER, ...v.filter });

  if (!state) {
    let sel = "inbox"; try { sel = localStorage.getItem(SEL_KEY(uid)) || "inbox"; } catch {}
    state = { sel, sort: "due", filter: null, who: loadWho(uid) };
  }
  if (state.who == null) state.who = loadWho(uid);
  // 選択中ビュー → filter を確定（adhoc 以外は選択から再構築）
  if (state.sel !== "adhoc") {
    const bv = BUILTIN_VIEWS.find((v) => v.key === state.sel);
    const cv = lists.find((l) => l.id === state.sel);
    state.filter = bv ? presetOf(bv) : (cv ? { ...EMPTY_FILTER, ...cv.filter } : presetOf(BUILTIN_VIEWS[0]));
    if (!bv && !cv) state.sel = "inbox";
  }
  // 担当フィルタはビュー横断で適用（保存リスト固有の assignee より個人選択を優先）。
  state.filter.assignee = state.who || "";

  // 一致＋分類（kinds 依存は view 側）＋ソート
  const catTitle = state.filter._cat || "";
  const matched = (tasks || []).filter((t) => taskMatches(t, state.filter, ctx) && (!catTitle || categoryLabels(t).some((l) => l.title === catTitle)));
  const sorted = sortTasks(matched, state.sort, today);
  const sumH = sorted.reduce((s, t) => s + (t.time_estimate || 0), 0) / 3600; // ビュー内の見積り合計

  // タブ件数（組み込み）。担当フィルタはビュー横断なので件数にも反映＝タブを開いた時の件数と一致させる。
  const who = state.who || "";
  const countOf = (v) => (tasks || []).filter((t) => taskMatches(t, { ...presetOf(v), assignee: who }, ctx)).length;
  const countOfList = (l) => {
    const f = { ...EMPTY_FILTER, ...l.filter, assignee: who }, cat = f._cat || "";
    return (tasks || []).filter((t) => taskMatches(t, f, ctx) && (!cat || categoryLabels(t).some((x) => x.title === cat))).length;
  };

  const curName = currentViewName(state, lists);

  root.innerHTML = `
    <style>${css()}</style>
    <div class="sl">
      <section class="sl-main">
        <div class="sl-tabs" role="tablist" aria-label="ビュー">
          ${BUILTIN_VIEWS.map((v) => tabItem(v.key, icon(v.icon, { size: 14 }), v.label, countOf(v), state.sel === v.key)).join("")}
          ${lists.map((l) => tabItem(l.id, icon("bookmark", { size: 14 }), l.name, countOfList(l), state.sel === l.id, true)).join("")}
          ${state.sel === "adhoc" ? `<span class="sl-tab is-adhoc" role="tab" aria-selected="true" tabindex="0">${icon("tag", { size: 14 })}<span class="sl-tlbl">${esc(curName.label)}</span></span>` : ""}
          <button id="sl-savetab" class="sl-tabsave" title="現在の条件をスマートリストとして保存">${icon("save", { size: 14 })}<span class="sl-tlbl">保存</span></button>
        </div>
        <div class="sl-head">
          <div class="sl-title">${curName.icon ? icon(curName.icon, { size: 20, cls: "sl-titic" }) + " " : ""}${esc(curName.label)} <span class="sl-count" id="sl-count">${sorted.length}</span><span class="sl-sum" id="sl-sum" title="このビュー内の見積り合計"${sumH ? "" : ' hidden'}>Σ ${fmtH(sumH)}</span></div>
          <div class="sl-sort">並べ替え
            <select id="sl-sort">${SORTS.map(([k, n]) => `<option value="${k}"${state.sort === k ? " selected" : ""}>${n}</option>`).join("")}</select>
          </div>
        </div>
        ${curName.desc ? `<div class="sl-desc">${esc(curName.desc)}</div>` : ""}
        <div class="sl-bar">
          <span class="sl-textwrap">${icon("search", { size: 14, cls: "sl-searchic" })}<input id="sl-text" class="sl-in sl-text" type="search" aria-label="このビュー内を検索" placeholder="このビュー内を検索" value="${esc(state.filter.text || "")}"></span>
          ${sel("sl-due", state.filter.due, [["", "期限：すべて"], ["today", "今日"], ["next7", "次の7日間"], ["overdue", "期限切れ"], ["hasdue", "期限あり"], ["none", "期限なし"]])}
          ${sel("sl-prio", state.filter.prio, [["", "重要度：すべて"], ["top", "MUST"], ["high", "高+"], ["mid", "中+"], ["none", "なし"]])}
          ${sel("sl-cat", catTitle, [["", "分類：すべて"], ...catChoices(labels)])}
          ${sel("sl-who", state.who, whoChoices(members, me))}
          ${sel("sl-status", state.filter.status, [["undone", "未完了"], ["todo", "未着手"], ["doing", "進行中"], ["waiting", "連絡待ち"], ["done", "完了"], ["", "すべて"]])}
          <button id="sl-flag" class="sl-flagbtn${state.filter.flag ? " on" : ""}" aria-pressed="${state.filter.flag ? "true" : "false"}" aria-label="フラグ付きのみ表示" title="フラグ付きのみ">${icon("flag", { size: 15 })}</button>
          ${state.sel === "adhoc" ? `<button id="sl-save" class="sl-save">${icon("save", { size: 14 })} 保存</button>` : ""}
          ${typeof state.sel === "number" ? `<button id="sl-del" class="sl-del">このリストを削除</button>` : ""}
        </div>
        ${chipsHtml(activeChips(state.filter, state.who, members, me, labels))}
        <div class="sl-list" id="sl-results">${resultsHtml(sorted, projects, today, state.sort, state.sel)}</div>
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

// 現在ビューの { icon: アイコン名, label, desc } を返す（adhoc/未知は icon 空）。
function currentViewName(state, lists) {
  if (state.sel === "adhoc") return { icon: "", label: "カスタム条件", desc: "" };
  const bv = BUILTIN_VIEWS.find((v) => v.key === state.sel);
  if (bv) return { icon: bv.icon, label: bv.label, desc: bv.desc || "" };
  const cv = lists.find((l) => l.id === state.sel);
  return cv ? { icon: "bookmark", label: cv.name, desc: "" } : { icon: "", label: "ビュー", desc: "" };
}

const catChoices = (labels) => [...new Set((labels || []).map((l) => l.title).filter((t) => t && t !== "レビュー" && t !== "連絡待ち"))]
  .sort((a, b) => a.localeCompare(b, "ja")).map((t) => [t, t]);

function sel(id, val, opts) {
  return `<select id="${id}" class="sl-in">${opts.map(([v, n]) => `<option value="${esc(v)}"${String(v) === String(val || "") ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
}

// 担当フィルタの選択肢（quad の whoTabs に倣う: すべて / 自分 / 担当なし / 各メンバー）。「自分」は load() の me。
function whoChoices(members, me) {
  const meId = me && me.id;
  const opts = [["", "担当：すべて"]];
  if (meId && (members || []).some((m) => m.id === meId)) opts.push([String(meId), "自分"]);
  opts.push(["none", "担当なし"]);
  for (const m of members || []) {
    if (m.id === meId) continue; // 「自分」で出している
    opts.push([String(m.id), m.name || m.username]);
  }
  return opts;
}
// 担当 id → 表示名（チップ用）。me は「自分」、none は「担当なし」。
function whoLabel(val, members, me) {
  if (val === "none") return "担当なし";
  const meId = me && me.id;
  if (meId && String(val) === String(meId)) return "自分";
  const m = (members || []).find((x) => String(x.id) === String(val));
  return m ? (m.name || m.username) : "担当";
}

// 有効な絞り込み条件をチップ配列で返す（{ key, label } …各チップは×で個別解除可能）。
//   key は解除時にどの条件をリセットするかの識別子（text/due/prio/cat/status/flag/who）。
function activeChips(filter, who, members, me, labels) {
  const chips = [];
  if (filter.text) chips.push({ key: "text", label: `検索: ${filter.text}` });
  if (who) chips.push({ key: "who", label: `担当: ${whoLabel(who, members, me)}` });
  const dueN = { today: "今日", next7: "次の7日間", overdue: "期限切れ", hasdue: "期限あり", none: "期限なし" }[filter.due];
  if (dueN) chips.push({ key: "due", label: `期限: ${dueN}` });
  const prN = { top: "MUST", high: "高+", mid: "中+", none: "なし" }[filter.prio];
  if (prN) chips.push({ key: "prio", label: `重要度: ${prN}` });
  if (filter._cat) chips.push({ key: "cat", label: `分類: ${filter._cat}` });
  // status は既定が "undone"。既定以外のときだけチップ化（"undone" は通常状態なので出さない）。
  const stN = { todo: "未着手", doing: "進行中", waiting: "連絡待ち", done: "完了", "": "すべて" }[filter.status];
  if (filter.status !== "undone" && stN != null) chips.push({ key: "status", label: `状態: ${stN}` });
  if (filter.flag) chips.push({ key: "flag", label: "フラグ付き" });
  return chips;
}
function chipsHtml(chips) {
  if (!chips.length) return "";
  return `<div class="sl-chips" id="sl-chips" role="group" aria-label="有効な絞り込み条件">
    ${chips.map((c) => `<span class="sl-chip">${esc(c.label)}<button class="sl-chipx" data-chip="${esc(c.key)}" title="この条件を解除" aria-label="${esc(c.label)} を解除">${ICON_X}</button></span>`).join("")}
    <button class="sl-chipclear" id="sl-chipclear" type="button">すべて解除</button>
  </div>`;
}

// 上部タブ（セグメント／WAI-ARIA Tabs）。icon＋ラベル＋件数バッジ。アクティブは下線＋強調。
// roving tabindex: 選択中のみ tabindex=0、他は -1（←→/Home/End で移動・wire 側で配線）。
// カスタムは削除（×）付き。削除ボタンは tab の「中」ではなく「兄弟」に置く（button のネスト＝
// 不正な入れ子を避ける）。tab と × を presentation 用の包みでまとめ、見た目上のセグメントにする。
function tabItem(key, icon, label, count, on, custom) {
  const tab = `<button class="sl-tab${on ? " on" : ""}" role="tab" aria-selected="${on ? "true" : "false"}" tabindex="${on ? "0" : "-1"}" data-view="${esc(String(key))}"${custom ? ' data-custom="1"' : ""}>
    <span class="sl-tic">${icon}</span><span class="sl-tlbl">${esc(label)}</span>
    ${count != null ? `<span class="sl-tcnt">${count}</span>` : ""}
  </button>`;
  if (!custom) return tab;
  // tab（role=tab）と削除ボタンを兄弟として横並びにする包み。包みは presentation（tablist の意味は tab が担う）。
  return `<span class="sl-tabwrap" role="presentation">${tab}<button class="sl-tdel" type="button" data-del="${esc(String(key))}" title="このリストを削除" aria-label="${esc(label)} を削除" tabindex="-1">${ICON_X}</button></span>`;
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
    <button class="sl-check${done ? " done" : ""}" data-check="${t.id}" title="${done ? "未完了に戻す" : "完了にする"}">${done ? icon("check", { size: 13 }) : ""}</button>
    <span class="sl-pdot${p ? "" : " none"}" title="重要度: ${esc(p ? p.n : "なし")}" style="${p ? `background:${p.c}` : ""}"></span>
    <span class="sl-rtitle">${esc(t.title)}</span>
    <span class="sl-meta">
      ${cat ? `<span class="sl-cat" style="color:${categoryColor(cat)};border-color:${categoryColor(cat)}55">${esc(cat.title)}</span>` : ""}
      ${est ? `<span class="sl-est">${fmtH(est)}</span>` : ""}
    </span>
    ${dueTxt ? `<span class="sl-due ${dueCls}">${dueTxt}</span>` : `<span class="sl-due none"></span>`}
    <button class="sl-flagrow${t.is_favorite ? " on" : ""}" data-flag="${t.id}" aria-pressed="${t.is_favorite ? "true" : "false"}" aria-label="フラグ" title="フラグ">${icon("flag", { size: 15 })}</button>
  </div>`;
}

// バーで絞り込みが効いているか（＝空が「条件起因」か「本当に0件」かの判定）。
// バー操作は必ず state.sel="adhoc" 化する（組み込み/保存ビューの定義由来の due/prio 等を
// 条件起因と誤判定しないよう、選択状態で判定する）。
function hasActiveFilter(sel) {
  return sel === "adhoc";
}

// 空状態を出し分け。条件起因ならクリア導線、本当に0件なら案内のみ。
function emptyHtml(filtered) {
  if (filtered) {
    return emptyState({
      icon: "search",
      title: "条件に一致するタスクがありません",
      desc: "絞り込み条件を緩めるか、クリアして再表示できます。",
    }).replace("</div>", `<button id="sl-clear" class="ui-empty-act" type="button">フィルタをクリア</button></div>`);
  }
  return emptyState({
    icon: "folders",
    title: "このビューにタスクはありません",
    desc: "新しいタスクを追加すると、ここに表示されます。",
  });
}

// 期限ソート時はアジェンダ風に日別グルーピング（期限切れ/今日/明日/日付/期限なし）。
function resultsHtml(sorted, projects, today, sort, sel) {
  if (!sorted.length) return emptyHtml(hasActiveFilter(sel));
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
    if (!d) put("none", "期限なし", "none", t);
    else if (d < today) put("over", "期限切れ", "over", t);
    else if (d === today) put("today", "今日", "today", t);
    else if (d === tomorrow) put("tomorrow", "明日", "", t);
    else {
      const dt = new Date(d + "T00:00:00Z");
      put(d, `${d.slice(5).replace("-", "/")}（${DOW_JA[dt.getUTCDay()]}）`, "", t);
    }
  }
  // 期限切れ→今日→明日→日付昇順→期限なし
  const rank = (k) => k === "over" ? 0 : k === "today" ? 1 : k === "tomorrow" ? 2 : k === "none" ? 9 : 5;
  return order.map((k) => map.get(k)).sort((a, b) => (rank(a.key) - rank(b.key)) || a.key.localeCompare(b.key));
}

function wire(root, data, uid, lists, ctx) {
  const rerender = () => render(root);
  const persistSel = () => { try { localStorage.setItem(SEL_KEY(uid), String(state.sel)); } catch {} };

  // 上部タブ選択（保存リストは保存時の sort も復元）
  const selectTab = (b) => {
    const v = b.dataset.view;
    if (v == null) return; // adhoc 表示用の現在タブ（クリック対象外）
    state.sel = b.dataset.custom ? +v : v;
    if (b.dataset.custom) {
      const cv = lists.find((l) => l.id === +v);
      if (cv && cv.sort) state.sort = cv.sort; // 保存した並べ替えを復元
    }
    persistSel(); rerender();
  };
  const tabsEl = root.querySelector(".sl-tabs");
  const tabs = tabsEl ? Array.from(tabsEl.querySelectorAll('[role="tab"]')) : [];
  tabs.forEach((b) => { b.onclick = () => selectTab(b); });
  // roving tabindex（WAI-ARIA Tabs）: ←→で移動・Home/End で端へ。移動先にフォーカスを移す。
  if (tabsEl) tabsEl.addEventListener("keydown", (e) => {
    const cur = e.target.closest('[role="tab"]');
    if (!cur || tabs.indexOf(cur) < 0) return;
    let idx = tabs.indexOf(cur), next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const nt = tabs[next];
    tabs.forEach((t) => t.setAttribute("tabindex", t === nt ? "0" : "-1"));
    nt.focus();
  });
  root.querySelectorAll("[data-del]").forEach((x) => {
    x.onclick = (e) => {
      e.stopPropagation();
      const id = +x.dataset.del;
      const l = lists.find((v) => v.id === id);
      if (!confirm(`保存リスト「${l ? l.name : ""}」を削除しますか？`)) return; // 誤削除防止
      const next = lists.filter((v) => v.id !== id);
      saveLists(uid, next);
      if (state.sel === id) state.sel = "inbox";
      rerender();
    };
  });

  // フィルタバー → adhoc 化
  const toAdhoc = (patch) => { state.filter = { ...state.filter, ...patch }; state.sel = "adhoc"; };
  const textEl = root.querySelector("#sl-text");
  if (textEl) textEl.oninput = () => { // 150-200ms デバウンス（入力ごとの再フィルタを抑制）
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { toAdhoc({ text: textEl.value }); paintResults(root, data, ctx); updateCount(root, data, ctx); }, 180);
  };
  const onSel = (id, key, num) => { const el = root.querySelector("#" + id); if (el) el.onchange = () => { const v = num ? (+el.value || 0) : el.value; toAdhoc({ [key]: v }); rerender(); }; };
  onSel("sl-due", "due"); onSel("sl-prio", "prio"); onSel("sl-status", "status");
  const catEl = root.querySelector("#sl-cat");
  if (catEl) catEl.onchange = () => { toAdhoc({ _cat: catEl.value }); rerender(); };
  // 担当フィルタ（ビュー横断・個人保存）。adhoc 化はしない＝どのビューでも「自分/担当なし/各人」で絞れる。
  const whoEl = root.querySelector("#sl-who");
  if (whoEl) whoEl.onchange = () => { state.who = whoEl.value; saveWho(uid, state.who); rerender(); };
  const flagBtn = root.querySelector("#sl-flag");
  if (flagBtn) flagBtn.onclick = () => { toAdhoc({ flag: !state.filter.flag }); rerender(); };
  const sortEl = root.querySelector("#sl-sort");
  if (sortEl) sortEl.onchange = () => { state.sort = sortEl.value; paintResults(root, data, ctx); };

  // 保存 / 削除（保存はフィルタ行のボタンとタブ末尾ボタンの両方から）
  const doSave = () => {
    const name = (prompt("スマートリスト名", suggestName(state.filter)) || "").trim();
    if (!name) return;
    const id = Date.now();
    const { _cat, ...f } = state.filter;
    const next = [...lists, { id, name, sort: state.sort, filter: { ...f, _cat } }]; // 現在の並べ替えも保存
    saveLists(uid, next); state.sel = id; persistSel(); rerender();
  };
  const saveBtn = root.querySelector("#sl-save");
  if (saveBtn) saveBtn.onclick = doSave;
  const saveTab = root.querySelector("#sl-savetab");
  if (saveTab) saveTab.onclick = doSave;
  const delBtn = root.querySelector("#sl-del");
  if (delBtn) delBtn.onclick = () => {
    const l = lists.find((v) => v.id === state.sel);
    if (!confirm(`保存リスト「${l ? l.name : ""}」を削除しますか？`)) return; // 誤削除防止
    const next = lists.filter((v) => v.id !== state.sel);
    saveLists(uid, next); state.sel = "inbox"; rerender();
  };

  // 結果行: 完了/フラグ/編集
  wireRows(root, data, rerender);
  // 空状態（条件起因）のフィルタクリア導線
  wireClear(root, data, ctx);
  // 有効な絞り込みチップ（個別×・すべて解除）
  wireChips(root, uid);
}

// 有効な絞り込み条件チップを配線（B29）。各×で個別解除・「すべて解除」で一括。
function wireChips(root, uid) {
  // テキスト/分類はバー操作と同様に adhoc 化、担当はビュー横断の who をリセット。
  const removeChip = (key) => {
    if (key === "who") { state.who = ""; saveWho(uid, ""); render(root); return; }
    const one = {
      text: { text: "" }, due: { due: "" }, prio: { prio: "" },
      cat: { _cat: "" }, flag: { flag: false }, status: { status: "undone" },
    }[key];
    if (!one) return;
    state.filter = { ...state.filter, ...one };
    state.sel = "adhoc";
    render(root);
  };
  root.querySelectorAll(".sl-chipx[data-chip]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); removeChip(b.dataset.chip); };
  });
  const clearAll = root.querySelector("#sl-chipclear");
  if (clearAll) clearAll.onclick = () => {
    state.filter = { ...state.filter, text: "", due: "", prio: "", _cat: "", flag: false, status: "undone" };
    state.who = ""; saveWho(uid, "");
    state.sel = "adhoc";
    render(root);
  };
}

// 空状態の「フィルタをクリア」ボタンを配線（バーの絞り込みのみリセット、選択ビューは維持）。
function wireClear(root, data, ctx) {
  const btn = root.querySelector("#sl-clear");
  if (!btn) return;
  btn.onclick = () => {
    state.filter = { ...state.filter, text: "", due: "", prio: "", _cat: "", flag: false };
    render(root);
  };
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
      // 完了/未完了の前後パッチ（Undo 用に「完了前の状態」を保持）。
      const wasDone = !!t.done, wasPct = t.percent_done || 0;
      const doPatch = wasDone ? { done: false } : { done: true, percent_done: 100 };
      const undoPatch = wasDone ? { done: true, percent_done: wasPct } : { done: false, percent_done: wasPct };
      row.classList.add("completing"); b.disabled = true;
      try {
        await updateTask(id, doPatch);
        invalidate(); rerender();
        // 完了/未完了トグルを Undo/Redo 対象に（Ctrl+Z/Y）。
        histPush({
          label: wasDone ? "未完了に戻す" : "完了にする",
          undo: async () => { await updateTask(id, undoPatch); invalidate(); rerender(); },
          redo: async () => { await updateTask(id, doPatch); invalidate(); rerender(); },
        });
      } catch (err) { row.classList.remove("completing"); b.disabled = false; alert("更新に失敗: " + err.message); }
    };
  });
  root.querySelectorAll("[data-flag]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = +b.dataset.flag;
      const t = (data.tasks || []).find((x) => x.id === id); if (!t) return;
      const was = !!t.is_favorite;
      b.classList.toggle("on"); b.disabled = true;
      try {
        await updateTask(id, { is_favorite: !was }); invalidate(); rerender();
        // フラグのトグルを Undo/Redo 対象に（Ctrl+Z/Y）。
        histPush({
          label: was ? "フラグを外す" : "フラグを付ける",
          undo: async () => { await updateTask(id, { is_favorite: was }); invalidate(); rerender(); },
          redo: async () => { await updateTask(id, { is_favorite: !was }); invalidate(); rerender(); },
        });
      } catch (err) { b.disabled = false; alert("更新に失敗: " + err.message); }
    };
  });
}

// 結果のみ再描画（テキスト/ソート変更で入力フォーカスを保つ）
function paintResults(root, data, ctx) {
  const catTitle = state.filter._cat || "";
  const matched = (data.tasks || []).filter((t) => taskMatches(t, state.filter, ctx) && (!catTitle || categoryLabels(t).some((l) => l.title === catTitle)));
  const sorted = sortTasks(matched, state.sort, ctx.today);
  const box = root.querySelector("#sl-results");
  box.innerHTML = resultsHtml(sorted, data.projects, ctx.today, state.sort, state.sel);
  wireRows(root, data, () => render(root));
  wireClear(root, data, ctx);
  updateSum(root, sorted);
}
function updateCount(root, data, ctx) {
  const catTitle = state.filter._cat || "";
  const n = (data.tasks || []).filter((t) => taskMatches(t, state.filter, ctx) && (!catTitle || categoryLabels(t).some((l) => l.title === catTitle))).length;
  const el = root.querySelector("#sl-count"); if (el) el.textContent = n;
}
// ビュー内見積り合計バッジを更新（0 のときは非表示）。
function updateSum(root, sorted) {
  const el = root.querySelector("#sl-sum"); if (!el) return;
  const sumH = sorted.reduce((s, t) => s + (t.time_estimate || 0), 0) / 3600;
  if (sumH) { el.hidden = false; el.textContent = `Σ ${fmtH(sumH)}`; } else { el.hidden = true; }
}

function suggestName(f) {
  const parts = [];
  const dueN = { today: "今日", next7: "今週", overdue: "期限切れ", none: "期限なし", hasdue: "期限あり" }[f.due];
  const prN = { top: "MUST", high: "高+", mid: "中+", none: "なし" }[f.prio];
  if (prN) parts.push(prN); if (dueN) parts.push(dueN); if (f.flag) parts.push("フラグ"); if (f._cat) parts.push(f._cat);
  return parts.join("・") || "マイリスト";
}

function css() {
  return `
  .sl{display:block}
  .sl-main{min-width:0}
  /* ===== 上部タブ（セグメント／フィルタ体裁。左の共通ナビと差別化＝塗りボタンではなく軽い下線強調） ===== */
  .sl-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-bottom:1px solid ${C.line};padding:0 0 2px;margin:0 0 14px;overflow-x:auto}
  /* カスタムタブは tab(role=tab) と削除× を横並びにする包み（button のネストを避けるため兄弟構成） */
  .sl-tabwrap{display:inline-flex;align-items:stretch;position:relative;margin-bottom:-3px}
  .sl-tab{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;font:inherit;font-size:12.5px;color:${C.muted};padding:7px 11px;border-radius:9px 9px 0 0;cursor:pointer;white-space:nowrap;position:relative;border-bottom:2px solid transparent;margin-bottom:-3px}
  .sl-tabwrap .sl-tab{margin-bottom:0}
  .sl-tab:hover{background:${C.track};color:${C.ink}}
  .sl-tab.on,.sl-tab.is-adhoc{color:${C.fill};font-weight:700;border-bottom-color:${C.fill}}
  .sl-tab:focus-visible{outline:2px solid ${C.fill};outline-offset:-2px;border-radius:9px 9px 0 0}
  .sl-tic{flex:none;display:inline-flex}
  .sl-tlbl{flex:none}
  .sl-tcnt{font-size:10.5px;font-variant-numeric:tabular-nums;background:${C.track};border-radius:9px;padding:0 6px;color:${C.muted};font-weight:600}
  .sl-tab.on .sl-tcnt{background:${C.fill};color:#fff}
  .sl-tdel{display:none;align-items:center;border:0;background:transparent;cursor:pointer;color:${C.muted};opacity:.6;padding:0 5px 0 0;margin-left:-4px;border-radius:5px}
  .sl-tabwrap:hover .sl-tdel,.sl-tdel:focus-visible{display:inline-flex}
  .sl-tdel:hover{opacity:1;color:${C.over}}
  .sl-tdel:focus-visible{opacity:1;outline:2px solid ${C.over};outline-offset:-2px}
  .sl-tabsave{display:inline-flex;align-items:center;gap:5px;border:1px dashed ${C.line};background:transparent;font:inherit;font-size:12px;color:${C.muted};padding:6px 10px;border-radius:9px;cursor:pointer;white-space:nowrap;margin-bottom:1px}
  .sl-tabsave:hover{border-color:${C.fill};color:${C.fill}}
  .sl-head{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 12px}
  .sl-title{font-size:20px;font-weight:800;letter-spacing:-.01em}
  .sl-count{font-size:13px;font-weight:700;color:${C.muted};background:${C.track};border-radius:11px;padding:1px 10px;margin-left:6px;vertical-align:2px}
  .sl-sum{font-size:12px;font-weight:700;color:${C.muted};margin-left:8px;vertical-align:2px;font-variant-numeric:tabular-nums;letter-spacing:.01em}
  .sl-sum[hidden]{display:none}
  .sl-desc{font-size:12px;color:${C.muted};margin:-6px 2px 12px;line-height:1.4}
  .sl-sort{font-size:12px;color:${C.muted};display:flex;align-items:center;gap:6px}
  .sl-sort select,.sl-in{font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid ${C.line};border-radius:9px;background:#fff;color:${C.ink}}
  .sl-bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;align-items:center}
  .sl-textwrap{position:relative;flex:1;min-width:200px;display:flex;align-items:center}
  .sl-searchic{position:absolute;left:10px;color:${C.muted};pointer-events:none}
  .sl-text{flex:1;min-width:0;width:100%;padding-left:30px}
  .sl-flagbtn{font:inherit;display:inline-flex;align-items:center;padding:7px 11px;border:1px solid ${C.line};border-radius:9px;background:#fff;cursor:pointer;color:${C.muted}}
  .sl-flagbtn.on{border-color:${C.over};background:#fff5f5;color:${C.over}}
  .sl-save,.sl-del{font:inherit;font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:9px;cursor:pointer}
  .sl-save{display:inline-flex;align-items:center;gap:5px;border:1px solid ${C.fill};background:${C.fill};color:#fff}
  .sl-del{border:1px solid ${C.line};background:#fff;color:${C.over}}
  /* ===== 有効な絞り込みチップ（個別×・すべて解除） ===== */
  .sl-chips{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:-4px 2px 14px}
  .sl-chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;color:${C.fill};background:#eef4ff;border:1px solid #d6e4ff;border-radius:14px;padding:3px 5px 3px 10px;white-space:nowrap}
  .sl-chipx{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;cursor:pointer;color:${C.fill};opacity:.7;padding:1px;border-radius:50%;line-height:0}
  .sl-chipx:hover{opacity:1;background:#d6e4ff}
  .sl-chipx:focus-visible{outline:2px solid ${C.fill};outline-offset:1px}
  .sl-chipclear{font:inherit;font-size:11.5px;font-weight:600;color:${C.muted};border:0;background:transparent;cursor:pointer;padding:3px 6px;border-radius:7px;text-decoration:underline;text-underline-offset:2px}
  .sl-chipclear:hover{color:${C.over}}
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
  .sl-est{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums}
  .sl-due{font-size:11.5px;font-weight:700;color:${C.muted};min-width:42px;text-align:right;flex:none;font-variant-numeric:tabular-nums}
  .sl-due.over{color:${C.over}}.sl-due.today{color:${C.amber}}.sl-due.none{min-width:42px}
  .sl-flagrow{border:0;background:transparent;cursor:pointer;flex:none;display:inline-flex;align-items:center;padding:0 2px;color:${C.line}}
  .sl-flagrow:hover{color:${C.muted}}
  .sl-flagrow.on{color:${C.over}}
  .sl-empty{text-align:center;color:${C.muted};padding:50px 0;font-size:13px}
  .sl-empty-i{font-size:34px;margin-bottom:8px;filter:grayscale(.3) opacity(.6)}
  #sl-clear{border:0;cursor:pointer;font:inherit;font-size:13px;font-weight:600}
  @media(max-width:720px){.sl-tabs{flex-wrap:nowrap}}
  /* ===== ダークモード（ハードコード淡色を暗側に上書き。ライト不変） ===== */
  html[data-theme="dark"] .sl-tcnt{background:${C.track}}
  html[data-theme="dark"] .sl-sort select,html[data-theme="dark"] .sl-in{background:${C.card};color:${C.ink}}
  html[data-theme="dark"] .sl-flagbtn{background:${C.card}}
  html[data-theme="dark"] .sl-flagbtn.on{background:rgba(229,72,77,.18)}
  html[data-theme="dark"] .sl-del{background:${C.card}}
  html[data-theme="dark"] .sl-chip{background:rgba(58,134,255,.16);border-color:rgba(58,134,255,.35)}
  html[data-theme="dark"] .sl-chipx:hover{background:rgba(58,134,255,.3)}
  html[data-theme="dark"] .sl-row:hover{box-shadow:0 2px 10px rgba(0,0,0,.4);border-color:${C.lineStrong}}
  html[data-theme="dark"] .sl-check{background:${C.card}}`;
}
