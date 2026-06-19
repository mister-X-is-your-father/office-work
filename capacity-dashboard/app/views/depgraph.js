// 依存関係グラフ／クリティカルパス（mock65 相当・実データ）。dependencyEdges + depLayers。
import { load } from "../lib/store.js";
import { dependencyEdges, depLayers, toH } from "../lib/capacity.js";
import { statusOf, STATUS } from "../lib/kinds.js";
import { C, esc, member_color, fmtH, emptyState } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const COLW = 196, ROWH = 92, NW = 168, NH = 66, PAD = 14;

export async function render(root) {
  const { tasks } = await load();
  const edges = dependencyEdges(tasks);
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  const nodeIds = ids.filter((id) => byId.has(id));

  if (!nodeIds.length) {
    root.innerHTML = `<h1 class="vtitle">依存グラフ</h1><div class="card" style="padding:14px">${emptyState({
      icon: "network",
      title: "依存関係を持つタスクがありません",
      desc: "タスク編集の「先行タスク」で依存を設定すると、ここに関係図とクリティカルパスが表示されます。",
    })}</div>`;
    return;
  }

  const { level, critical } = depLayers(nodeIds, edges);
  // クリティカルパスを「実際の鎖（連続辺）」として復元する。depLayers と同じ最長経路アルゴ
  // （トポロジカル順 → 各ノードの最長距離 dist と直前ノード back）をここでも回し、終端から
  // back を辿って得た連続辺だけを Set 化する。これで赤線が必ず一本の連続した経路になる
  // （旧実装は critical ノード同士が level 差1なら塗っていたため、鎖外の辺まで赤くなる不具合があった）。
  const { critEdges, critIds } = criticalChain(nodeIds, edges);
  const critEstH = [...critIds].reduce((s, id) => s + toH((byId.get(id) || {}).time_estimate), 0);
  // 段(level)ごとに並べる
  const byLevel = new Map();
  for (const id of nodeIds) { const l = level.get(id); (byLevel.get(l) || byLevel.set(l, []).get(l)).push(id); }
  const maxLevel = Math.max(...nodeIds.map((id) => level.get(id)));
  const pos = new Map();
  let maxRows = 0;
  for (let l = 0; l <= maxLevel; l++) {
    const col = (byLevel.get(l) || []).sort((a, b) => a - b);
    maxRows = Math.max(maxRows, col.length);
    col.forEach((id, i) => pos.set(id, { x: l * COLW + PAD, y: i * ROWH + PAD }));
  }
  const W = (maxLevel + 1) * COLW + PAD, H = maxRows * ROWH + PAD;

  // 辺SVG
  const isCrit = (e) => critEdges.has(`${e.from}->${e.to}`);
  const paths = edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const crit = isCrit(e);
    return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}" fill="none" stroke="${crit ? C.over : "#c4ccd6"}" stroke-width="${crit ? 2.4 : 1.5}" ${crit ? "" : 'stroke-dasharray="4 3"'} marker-end="url(#dg-arrow${crit ? "-c" : ""})"/>`;
  }).join("");

  const nodes = nodeIds.map((id) => nodeHtml(byId.get(id), pos.get(id), critical.has(id))).join("");

  const critSummary = critEdges.size
    ? `クリティカルパス: ${critEdges.size}辺・計${fmtH(critEstH)}`
    : "クリティカルパス: なし";
  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">依存グラフ <small>${nodeIds.length}タスク</small></h1>
    <div class="dg-legend">
      <span class="dg-leg"><i class="dg-leg-crit"></i>クリティカルパス（最長経路）</span>
      <span class="dg-leg"><i class="dg-leg-dep"></i>依存</span>
      <span class="dg-leg-sum">${esc(critSummary)}</span>
    </div>
    <div class="card dg-card"><div class="dg-scroll"><div class="dg-canvas" style="width:${W}px;height:${H}px">
      <svg class="dg-edges" width="${W}" height="${H}"><defs>
        <marker id="dg-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#c4ccd6"/></marker>
        <marker id="dg-arrow-c" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${C.over}"/></marker>
      </defs>${paths}</svg>
      ${nodes}
    </div></div></div>`;

  // ノードクリックで編集モーダル（table.js と同じパターン: 保存後に再描画）。
  // クリックはノード本体に限定（背景・SVGの線では発火しない）。
  root.querySelectorAll(".dg-node[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
  });
}

// クリティカルパス＝最長経路の「連続辺」を復元する。depLayers と同じ longest-path 計算を
// ここでも行い、back ポインタを終端から辿って一本の鎖（連続した辺の列）を取り出す。
// 返り値: { critEdges:Set<"from->to">, critIds:Set<id> }。空グラフ/単独ノードなら空。
function criticalChain(ids, edges) {
  const idset = new Set(ids);
  const adj = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges || []) {
    if (!idset.has(e.from) || !idset.has(e.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const ind = new Map(indeg);
  const q = ids.filter((id) => ind.get(id) === 0);
  const order = [];
  while (q.length) {
    const n = q.shift();
    order.push(n);
    for (const m of adj.get(n)) { ind.set(m, ind.get(m) - 1); if (ind.get(m) === 0) q.push(m); }
  }
  const dist = new Map(ids.map((id) => [id, 1])); // ノード数ベースの最長距離（depLayers と一致）
  const back = new Map();
  for (const n of order) for (const m of adj.get(n)) {
    if (dist.get(n) + 1 > dist.get(m)) { dist.set(m, dist.get(n) + 1); back.set(m, n); }
  }
  let end = ids[0], best = -1;
  for (const id of ids) if (dist.get(id) > best) { best = dist.get(id); end = id; }
  const critEdges = new Set();
  const critIds = new Set();
  for (let cur = end; cur != null; cur = back.get(cur)) {
    critIds.add(cur);
    const prev = back.get(cur);
    if (prev != null) critEdges.add(`${prev}->${cur}`);
  }
  return { critEdges, critIds };
}

function nodeHtml(t, p, crit) {
  const st = statusOf(t);
  const who = (t.assignees || [])[0];
  const wn = who ? (who.name || who.username) : "";
  return `<div class="dg-node ${st} ${crit ? "crit" : ""}" data-id="${t.id}" title="${esc(t.title)}" style="left:${p.x}px;top:${p.y}px;width:${NW}px;height:${NH}px">
    <div class="dg-t">${esc(t.title)}</div>
    <div class="dg-meta">
      ${who ? `<span class="dg-ava" style="background:${member_color(who.id)}">${esc((wn[0] || "?"))}</span>` : ""}
      <span class="dg-st ${st}">${STATUS[st].label}</span>
      <span class="dg-pct">${t.percent_done || 0}%</span>
    </div>
  </div>`;
}

function css() {
  return `
  .dg-legend{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:-4px 0 12px;font-size:12px;color:${C.muted}}
  .dg-leg{display:inline-flex;align-items:center;gap:6px}
  .dg-leg i{display:inline-block;width:22px;height:0;flex:none}
  .dg-leg-crit{border-top:2.4px solid ${C.over}}
  .dg-leg-dep{border-top:1.5px dashed #c4ccd6}
  .dg-leg-sum{margin-left:auto;font-weight:600;color:${C.ink};font-variant-numeric:tabular-nums}
  .dg-card{padding:0}
  .dg-scroll{overflow:auto;padding:14px}
  .dg-canvas{position:relative}
  .dg-edges{position:absolute;inset:0;pointer-events:none}
  .dg-node{position:absolute;background:#fff;border:1px solid ${C.line};border-radius:11px;padding:9px 11px;box-shadow:0 1px 3px rgba(20,30,50,.08);display:flex;flex-direction:column;justify-content:space-between;z-index:1;cursor:pointer}
  .dg-node.crit{border-color:${C.over};box-shadow:0 2px 8px rgba(229,72,77,.18)}
  .dg-node.done{background:#f7fbf8}
  .dg-t{font-size:12.5px;font-weight:600;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .dg-meta{display:flex;align-items:center;gap:6px}
  .dg-ava{width:17px;height:17px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:9.5px;font-weight:700;flex:none}
  .dg-st{font-size:10px;font-weight:600;border-radius:20px;padding:0 7px}
  .dg-st.todo{color:${C.muted};background:#f0f1f4}.dg-st.doing{color:${C.fill};background:#eaf2ff}.dg-st.waiting{color:#9a6a00;background:#fbf0d6}.dg-st.done{color:${C.free};background:#eaf7ef}
  .dg-pct{margin-left:auto;font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums}`;
}
