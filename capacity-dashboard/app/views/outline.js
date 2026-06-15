// アウトライン階層リスト（mock68 相当・実データ）。related_tasks.subtask の親子を折りたたみ表示。
import { load, projectName } from "../lib/store.js";
import { buildTaskTree } from "../lib/capacity.js";
import { statusOf, STATUS } from "../lib/kinds.js";
import { C, esc, member_color } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const collapsed = new Set();
const dueLabel = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(5, 10).replace("-", "/") : "");

export async function render(root) {
  const { tasks, projects } = await load();
  const forest = buildTaskTree(tasks);
  const counts = countChildren(forest);

  const rows = [];
  const walk = (node, depth) => {
    rows.push(rowHtml(node, depth, projects, counts));
    if (!collapsed.has(node.task.id)) for (const c of node.children) walk(c, depth + 1);
  };
  forest.forEach((n) => walk(n, 0));

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">アウトライン <small>${forest.length}トップ ・ プロジェクト＞タスク階層</small></h1>
    <div class="card ol-card">${rows.join("") || `<div class="ol-empty">タスクがありません。</div>`}</div>`;

  // 折りたたみトグル: 展開/折りたたみのみ（行クリックの編集には伝播させない）
  root.querySelectorAll(".ol-tw").forEach((tw) => {
    if (!tw.dataset.id) return; // 子なし行のプレースホルダは無反応
    tw.onclick = (e) => { e.stopPropagation(); const id = +tw.dataset.id; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render(root); };
  });
  // 行クリックで編集（トグル以外）。保存後に再描画。
  root.querySelectorAll(".ol-row").forEach((rowEl) => {
    rowEl.onclick = (e) => {
      if (e.target.closest(".ol-tw:not(.none)")) return; // 実トグルだけは展開/折りたたみ専用（子なしのプレースホルダは編集を開く）
      openTaskForm({ taskId: +rowEl.dataset.id, onSaved: () => render(root) });
    };
  });
}

function countChildren(forest) {
  // node.task.id -> {done, total} （直下の子の完了数）
  const m = new Map();
  const visit = (n) => {
    let done = 0; for (const c of n.children) { if (c.task.done) done++; visit(c); }
    m.set(n.task.id, { done, total: n.children.length });
  };
  forest.forEach(visit);
  return m;
}

function rowHtml(node, depth, projects, counts) {
  const t = node.task;
  const has = node.children.length > 0;
  const open = !collapsed.has(t.id);
  const st = statusOf(t);
  const who = (t.assignees || [])[0];
  const wn = who ? (who.name || who.username) : "";
  const cc = counts.get(t.id);
  const childInfo = has ? `<span class="ol-cc">${cc.done}/${cc.total}</span>` : "";
  const tw = has ? `<span class="ol-tw" data-id="${t.id}">${open ? "▾" : "▸"}</span>` : `<span class="ol-tw none"></span>`;
  const due = dueLabel(t);
  return `<div class="ol-row" data-id="${t.id}" style="padding-left:${12 + depth * 22}px">
    ${tw}
    <span class="ol-cb ${st}"></span>
    <span class="ol-name ${t.done ? "done" : ""}">${esc(t.title)}</span>
    ${childInfo}
    <span class="ol-meta">
      ${who ? `<span class="ol-ava" style="background:${member_color(who.id)}">${esc((wn[0] || "?"))}</span>` : ""}
      ${due ? `<span class="ol-due">${due}</span>` : ""}
      <span class="ol-st ${st}">${STATUS[st].label}</span>
    </span>
  </div>`;
}

function css() {
  return `
  .ol-card{padding:6px 0}
  .ol-row{display:flex;align-items:center;gap:8px;padding-top:7px;padding-bottom:7px;padding-right:14px;border-bottom:1px solid ${C.line};font-size:13.5px;cursor:pointer}
  .ol-row:last-child{border-bottom:0}
  .ol-row:hover{background:#f7fbff}
  .ol-tw{width:26px;height:26px;margin:-6px 0;flex:none;display:grid;place-items:center;color:${C.muted};cursor:pointer;font-size:13px;line-height:1;user-select:none;border-radius:6px}
  .ol-tw:not(.none):hover{background:#e7eef7;color:${C.fill}}
  .ol-tw.none{cursor:pointer;visibility:hidden}
  .ol-cb{width:13px;height:13px;border-radius:4px;flex:none;border:1.5px solid ${C.line}}
  .ol-cb.done{background:${C.free};border-color:${C.free}}
  .ol-cb.doing{background:#eaf2ff;border-color:${C.fill}}
  .ol-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ol-name.done{color:${C.muted};text-decoration:line-through}
  .ol-cc{font-size:10.5px;color:${C.muted};background:#f0f1f4;border-radius:10px;padding:1px 7px;flex:none}
  .ol-meta{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}
  .ol-ava{width:19px;height:19px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:700}
  .ol-due{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .ol-st{font-size:10.5px;font-weight:600;border-radius:20px;padding:1px 8px}
  .ol-st.todo{color:${C.muted};background:#f0f1f4}.ol-st.doing{color:${C.fill};background:#eaf2ff}.ol-st.waiting{color:#9a6a00;background:#fbf0d6}.ol-st.done{color:${C.free};background:#eaf7ef}
  .ol-empty{padding:30px;text-align:center;color:${C.muted}}`;
}
