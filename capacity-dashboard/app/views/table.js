// タスク一覧（表・mock60 相当）。ソート/絞り込み＋**個人ごとの並び順**（マイ並び＝手動ドラッグ）。
// 並び設定（ソート基準・手動順・絞り込み）は **見ている本人ごとに localStorage 保存**＝共有データ
// （DB）は一切変えないので、誰がどう並べても他のメンバーの見え方に影響しない（衝突しない）。
import { load, projectName, isAiUser } from "../lib/store.js";
import { PRIO, prioBucket, kindOf, isReviewTask, categoryLabels, categoryColor } from "../lib/kinds.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const HOUR = 3600;
// 並び設定は本人ごと（uid キー）。key="manual" は手動ドラッグ順（manual=[taskId,...]）。
const VKEY = (uid) => `ts.list.view.${uid ?? "anon"}`;
function loadView(uid) {
  const def = { key: "due", dir: 1, manual: [], hideDone: true, proj: "", cat: "" };
  try { return { ...def, ...(JSON.parse(localStorage.getItem(VKEY(uid))) || {}) }; } catch { return { ...def }; }
}
function saveView(uid, v) { try { localStorage.setItem(VKEY(uid), JSON.stringify(v)); } catch { /* noop */ } }

let V = null, UID = null;

const stateOf = (t) => (t.done ? "完了" : ((t.percent_done || 0) > 0 ? "進行中" : "未着手"));
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");

const SORT_OPTS = [
  ["manual", "マイ並び（手動）"], ["due", "期日"], ["prio", "優先度"], ["who", "担当"],
  ["state", "状態"], ["pct", "進捗"], ["est", "見積"], ["cat", "分類"], ["title", "タスク名"],
];

export async function render(root) {
  const { tasks, projects, members, me = null } = await load();
  const today = todayISO();
  UID = (me && me.id) || 0;
  V = loadView(UID);
  // Fable ▶（隠し要素）: 実行サービスの許可ユーザーだけ判定が立つ（未許可は probe が null）
  let execOk = false;
  try { const ex = await import("../lib/exec.js"); execOk = !!(await ex.execMe()); } catch { /* noop */ }
  let rows = (tasks || []).map((t) => ({
    t, title: t.title, who: (t.assignees || []).find((a) => !isAiUser(a)) || null, // AI担当(隠し要素)は一覧に出さない
    fable: execOk && !t.done && (t.assignees || []).some((a) => isAiUser(a))
      && ((t.created_by || {}).id || 0) === ((me && me.id) || -1), // 作成者本人のみ▶表示
    proj: projectName(projects, t.project_id), pid: t.project_id,
    review: isReviewTask(t), prio: prioBucket(t.priority), cat: categoryLabels(t)[0] || null,
    due: dueISO(t), est: (t.time_estimate || 0) / HOUR, pct: t.percent_done || 0,
    done: !!t.done, state: stateOf(t),
  }));
  if (V.hideDone) rows = rows.filter((r) => !r.done);
  if (V.proj) rows = rows.filter((r) => String(r.pid) === V.proj);
  if (V.cat) rows = rows.filter((r) => (r.cat ? r.cat.title : "") === V.cat);

  const manual = V.key === "manual";
  if (manual) {
    // 手動順を全タスクで正規化（欠番を除去・新規タスクは末尾に追加）してから保存
    const allIds = rows.map((r) => r.t.id);
    const have = new Set(V.manual);
    const allSet = new Set(allIds);
    V.manual = [...V.manual.filter((id) => allSet.has(id)), ...allIds.filter((id) => !have.has(id))];
    saveView(UID, V);
    const pos = new Map(V.manual.map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(a.t.id) ?? 1e9) - (pos.get(b.t.id) ?? 1e9));
  } else {
    const cmp = {
      title: (a, b) => a.title.localeCompare(b.title, "ja"),
      who: (a, b) => ((a.who && (a.who.name || a.who.username)) || "").localeCompare((b.who && (b.who.name || b.who.username)) || "", "ja"),
      prio: (a, b) => a.prio - b.prio,
      due: (a, b) => (a.due || "9999").localeCompare(b.due || "9999"),
      est: (a, b) => a.est - b.est,
      pct: (a, b) => a.pct - b.pct,
      state: (a, b) => a.state.localeCompare(b.state, "ja"),
      cat: (a, b) => ((a.cat && a.cat.title) || "").localeCompare((b.cat && b.cat.title) || "", "ja"),
    }[V.key] || (() => 0);
    rows.sort((a, b) => cmp(a, b) * V.dir);
  }

  const projOpts = `<option value="">全ワークスペース</option>` +
    (projects || []).map((p) => `<option value="${p.id}"${String(p.id) === V.proj ? " selected" : ""}>${esc(p.title)}</option>`).join("");
  const usedCats = [...new Map(rows.concat([]).map((r) => r.cat).filter(Boolean).map((c) => [c.title, c])).values()]
    .sort((a, b) => a.title.localeCompare(b.title, "ja"));
  const allCats = V.cat && !usedCats.some((c) => c.title === V.cat) ? usedCats.concat([{ title: V.cat, id: 0 }]) : usedCats;
  const catOpts = `<option value="">全分類</option>` +
    allCats.map((c) => `<option value="${esc(c.title)}"${c.title === V.cat ? " selected" : ""}>${esc(c.title)}</option>`).join("");
  const sortOpts = SORT_OPTS.map(([k, n]) => `<option value="${k}"${k === V.key ? " selected" : ""}>${n}</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">タスク一覧 <small>${rows.length}件 ${manual ? "・ ⠿ をドラッグで自分用に並べ替え" : "・ 列クリックでソート"}</small></h1>
    <div class="tb-tools">
      <button id="tb-add" class="tb-add">タスク追加</button>
      <label class="tb-sortl">並び順 <select id="tb-sort">${sortOpts}</select></label>
      <select id="tb-proj">${projOpts}</select>
      <select id="tb-cat">${catOpts}</select>
      <label class="tb-chk"><input type="checkbox" id="tb-hd" ${V.hideDone ? "checked" : ""}> 完了を隠す</label>
    </div>
    ${manual ? `<div class="tb-mynote">「マイ並び」はあなただけの順番です（この端末に保存・他のメンバーには影響しません）。${V.key === "manual" ? "" : ""}</div>` : ""}
    <div class="card tb-wrap"><table class="tb">
      <thead><tr>${cols(manual).map((c) => th(c, manual)).join("")}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => rowHtml(r, members, i, manual)).join("") : `<tr><td colspan="${manual ? 10 : 9}" class="tb-empty">該当なし</td></tr>`}</tbody>
    </table></div>`;

  const persist = () => saveView(UID, V);
  root.querySelector("#tb-sort").onchange = (e) => { V.key = e.target.value; persist(); render(root); };
  root.querySelector("#tb-proj").onchange = (e) => { V.proj = e.target.value; persist(); render(root); };
  root.querySelector("#tb-cat").onchange = (e) => { V.cat = e.target.value; persist(); render(root); };
  root.querySelector("#tb-hd").onchange = (e) => { V.hideDone = e.target.checked; persist(); render(root); };
  root.querySelector("#tb-add").onclick = () => openTaskForm({ onSaved: () => render(root) });
  root.querySelectorAll("th[data-k]").forEach((h) => {
    h.onclick = () => { const k = h.dataset.k; if (V.key === k) V.dir *= -1; else { V.key = k; V.dir = 1; } persist(); render(root); };
  });
  root.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.onclick = (e) => { if (e.target.closest(".tb-grip") || e.target.closest(".tb-fable")) return; openTaskForm({ taskId: +tr.dataset.id, onSaved: () => render(root) }); };
  });
  // ▶ Fable 実行
  root.querySelectorAll(".tb-fable").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try {
        const { runAi } = await import("../lib/exec.js");
        const j = await runAi(+b.dataset.fable, b.dataset.title);
        b.textContent = "⏵…";
        b.title = `キュー #${j.job.id} に追加済み（🤖 Fable 画面でコンソール）`;
      } catch { b.disabled = false; }
    };
  });

  if (manual) wireDrag(root, () => render(root));
}

// マイ並びのドラッグ並べ替え（⠿ グリップを掴む・行が drop ターゲット）。
function wireDrag(root, rerender) {
  const tbody = root.querySelector("tbody");
  let dragId = null;
  root.querySelectorAll(".tb-grip").forEach((g) => {
    g.addEventListener("dragstart", (e) => {
      dragId = +g.closest("tr").dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragId));
      g.closest("tr").classList.add("tb-dragging");
    });
    g.addEventListener("dragend", () => { root.querySelectorAll(".tb-dragging,.tb-over").forEach((x) => x.classList.remove("tb-dragging", "tb-over")); });
  });
  root.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("dragover", (e) => {
      if (dragId == null) return;
      e.preventDefault();
      root.querySelectorAll(".tb-over").forEach((x) => x.classList.remove("tb-over"));
      tr.classList.add("tb-over");
    });
    tr.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetId = +tr.dataset.id;
      if (dragId == null || targetId === dragId) return;
      // 現在の表示順（フィルタ後）を取得→ドラッグ要素をターゲットの上/下へ移動
      const vis = [...tbody.querySelectorAll("tr[data-id]")].map((x) => +x.dataset.id);
      const from = vis.indexOf(dragId); if (from >= 0) vis.splice(from, 1);
      let to = vis.indexOf(targetId);
      const rect = tr.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) to += 1; // 下半分なら後ろへ
      vis.splice(Math.max(0, to), 0, dragId);
      // 表示中の id だけ新順に差し替え、非表示(フィルタ外)の位置は保持して全体順を再構築
      const visSet = new Set(vis);
      let vi = 0;
      const next = [];
      for (const id of V.manual) next.push(visSet.has(id) ? vis[vi++] : id);
      while (vi < vis.length) next.push(vis[vi++]);
      V.manual = [...new Set(next)];
      saveView(UID, V);
      dragId = null;
      rerender();
    });
  });
}

const cols = (manual) => [
  ...(manual ? [{ k: null, label: "" }] : []),
  { k: "title", label: "タスク" }, { k: "who", label: "担当" }, { k: null, label: "種別" },
  { k: "cat", label: "分類" },
  { k: "prio", label: "優先度" }, { k: "due", label: "期日" }, { k: "est", label: "見積" },
  { k: "pct", label: "進捗" }, { k: "state", label: "状態" },
];
const th = (c, manual) => c.k
  ? `<th data-k="${c.k}" class="sortable">${c.label}${!manual && V.key === c.k ? (V.dir > 0 ? " ▲" : " ▼") : ""}</th>`
  : `<th>${c.label}</th>`;

function rowHtml(r, members, i, manual) {
  const wn = r.who ? (r.who.name || r.who.username) : "—";
  const ava = r.who ? `<span class="tb-ava" style="background:${member_color(r.who.id)}">${esc((wn[0] || "?"))}</span>` : "";
  const kind = r.review ? `<span class="tb-k review">レビュー</span>` : `<span class="tb-k">タスク</span>`;
  const cat = r.cat ? `<span class="tb-cat" style="color:${categoryColor(r.cat)};border-color:${categoryColor(r.cat)}40">${esc(r.cat.title)}</span>` : `<span class="tb-cat none">—</span>`;
  const pc = PRIO[r.prio];
  const prio = `<span class="tb-prio"><i style="background:${pc.c}"></i>${pc.n}</span>`;
  const dueCls = r.due && r.due < todayISO() && !r.done ? "over" : "";
  const st = `<span class="tb-st ${r.done ? "done" : (r.pct > 0 ? "doing" : "todo")}">${r.state}</span>`;
  const grip = manual ? `<td class="tb-gripcell"><span class="tb-grip" draggable="true" title="ドラッグで並べ替え">⠿</span></td>` : "";
  return `<tr data-id="${r.t.id}">
    ${grip}
    <td class="tb-title">${esc(r.title)}${r.fable ? ` <button type="button" class="tb-fable" data-fable="${r.t.id}" data-title="${esc(r.title)}" title="Fableに実行させる">▶</button>` : ""}<div class="tb-sub">${esc(r.proj)}</div></td>
    <td>${ava}${esc(wn)}</td>
    <td>${kind}</td>
    <td>${cat}</td>
    <td>${prio}</td>
    <td class="${dueCls}">${r.due ? r.due.slice(5).replace("-", "/") : "—"}</td>
    <td class="tb-num">${r.est ? fmtH(r.est) : "—"}</td>
    <td><div class="tb-bar"><i style="width:${r.pct}%"></i></div><span class="tb-pct">${r.pct}%</span></td>
    <td>${st}</td>
  </tr>`;
}

function css() {
  return `
  .tb-tools{display:flex;gap:12px;align-items:center;margin:0 0 14px;flex-wrap:wrap}
  .tb-tools select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff}
  .tb-sortl{font-size:12px;color:${C.muted};display:flex;align-items:center;gap:6px}
  .tb-add{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;padding:6px 13px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};cursor:pointer;transition:background .12s,border-color .12s}
  .tb-add::before{content:"+";font-size:15px;color:${C.fill};line-height:1}
  .tb-add:hover{background:${C.track};border-color:#d7dde6}
  .tb-chk{font-size:13px;color:${C.muted};display:flex;align-items:center;gap:6px}
  .tb-mynote{font-size:11.5px;color:${C.muted};margin:-6px 0 12px;background:#f3f8ff;border:1px solid #dce9ff;border-radius:8px;padding:7px 11px}
  .tb-wrap{overflow-x:auto}
  table.tb{width:100%;border-collapse:collapse;font-size:13px}
  .tb tbody tr[data-id]{cursor:pointer}
  .tb tbody tr.tb-dragging{opacity:.4}
  .tb tbody tr.tb-over td{box-shadow:inset 0 2px 0 ${C.fill}}
  .tb-gripcell{width:26px;text-align:center;padding-left:6px!important;padding-right:0!important}
  .tb-grip{display:inline-block;cursor:grab;color:${C.muted};font-size:15px;line-height:1;user-select:none}
  .tb-grip:hover{color:${C.fill}}
  .tb-grip:active{cursor:grabbing}
  .tb-fable{width:22px;height:22px;border-radius:50%;border:1px solid ${C.fill};background:#fff;color:${C.fill};cursor:pointer;font-size:9px;padding:0;vertical-align:1px;margin-left:4px}
  .tb-fable:hover{background:${C.fill};color:#fff}
  .tb-fable:disabled{opacity:.5;cursor:default}
  .tb th{font-size:11px;color:${C.muted};font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid ${C.line};white-space:nowrap;background:#fafbfc}
  .tb th.sortable{cursor:pointer;user-select:none}.tb th.sortable:hover{color:${C.ink}}
  .tb td{padding:10px 12px;border-bottom:1px solid ${C.line};vertical-align:middle}
  .tb tbody tr:hover{background:#f7fbff}
  .tb-title{font-weight:600;min-width:180px}
  .tb-sub{font-size:11px;color:${C.muted};font-weight:400;margin-top:2px}
  .tb-ava{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#fff;font-size:10px;font-weight:700;margin-right:6px;vertical-align:-5px}
  .tb-k{font-size:10.5px;color:${C.muted};border:1px solid ${C.line};border-radius:5px;padding:1px 6px}
  .tb-k.review{color:${C.fill};border-color:#cfe0ff}
  .tb-cat{font-size:10.5px;border:1px solid;border-radius:5px;padding:1px 7px;white-space:nowrap;font-weight:600}
  .tb-cat.none{color:${C.muted};border:0}
  .tb-prio{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.tb-prio i{width:9px;height:9px;border-radius:3px;display:inline-block}
  .tb-num{font-variant-numeric:tabular-nums;white-space:nowrap}
  td.over{color:${C.over};font-weight:600}
  .tb-bar{display:inline-block;width:64px;height:7px;border-radius:5px;background:${C.track};overflow:hidden;vertical-align:middle;margin-right:7px}
  .tb-bar i{display:block;height:100%;background:${C.fill}}
  .tb-pct{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .tb-st{font-size:11px;font-weight:600;border-radius:20px;padding:2px 9px}
  .tb-st.todo{color:${C.muted};background:#f0f1f4}.tb-st.doing{color:${C.fill};background:#eaf2ff}.tb-st.done{color:${C.free};background:#eaf7ef}
  .tb-empty{text-align:center;color:${C.muted};padding:30px}`;
}
