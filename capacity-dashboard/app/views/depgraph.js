// 依存関係グラフ／クリティカルパス（mock65 相当・実データ）。dependencyEdges + depLayers。
import { load } from "../lib/store.js";
import { dependencyEdges, depLayers } from "../lib/capacity.js";
import { C, esc, member_color } from "../lib/ui.js";

const COLW = 196, ROWH = 92, NW = 168, NH = 66, PAD = 14;
const stateOf = (t) => (t.done ? "done" : ((t.percent_done || 0) > 0 ? "doing" : "todo"));

export async function render(root) {
  const { tasks } = await load();
  const edges = dependencyEdges(tasks);
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  const nodeIds = ids.filter((id) => byId.has(id));

  if (!nodeIds.length) {
    root.innerHTML = `<h1 class="vtitle">依存グラフ</h1><div class="card" style="padding:30px;text-align:center;color:${C.muted}">依存関係（precedes/follows）を持つタスクがありません。<br>ガント等で依存を設定すると表示されます。</div>`;
    return;
  }

  const { level, critical } = depLayers(nodeIds, edges);
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
  const isCrit = (e) => critical.has(e.from) && critical.has(e.to) && level.get(e.to) === level.get(e.from) + 1;
  const paths = edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const crit = isCrit(e);
    return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}" fill="none" stroke="${crit ? C.over : "#c4ccd6"}" stroke-width="${crit ? 2.4 : 1.5}" ${crit ? "" : 'stroke-dasharray="4 3"'} marker-end="url(#dg-arrow${crit ? "-c" : ""})"/>`;
  }).join("");

  const nodes = nodeIds.map((id) => nodeHtml(byId.get(id), pos.get(id), critical.has(id))).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">依存グラフ <small>${nodeIds.length}タスク ・ 赤=クリティカルパス（最長経路）</small></h1>
    <div class="card dg-card"><div class="dg-scroll"><div class="dg-canvas" style="width:${W}px;height:${H}px">
      <svg class="dg-edges" width="${W}" height="${H}"><defs>
        <marker id="dg-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#c4ccd6"/></marker>
        <marker id="dg-arrow-c" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${C.over}"/></marker>
      </defs>${paths}</svg>
      ${nodes}
    </div></div></div>`;
}

function nodeHtml(t, p, crit) {
  const st = stateOf(t);
  const who = (t.assignees || [])[0];
  const wn = who ? (who.name || who.username) : "";
  return `<div class="dg-node ${st} ${crit ? "crit" : ""}" style="left:${p.x}px;top:${p.y}px;width:${NW}px;height:${NH}px">
    <div class="dg-t">${esc(t.title)}</div>
    <div class="dg-meta">
      ${who ? `<span class="dg-ava" style="background:${member_color(who.id)}">${esc((wn[0] || "?"))}</span>` : ""}
      <span class="dg-st ${st}">${st === "done" ? "完了" : st === "doing" ? "進行中" : "未着手"}</span>
      <span class="dg-pct">${t.percent_done || 0}%</span>
    </div>
  </div>`;
}

function css() {
  return `
  .dg-card{padding:0}
  .dg-scroll{overflow:auto;padding:14px}
  .dg-canvas{position:relative}
  .dg-edges{position:absolute;inset:0;pointer-events:none}
  .dg-node{position:absolute;background:#fff;border:1px solid ${C.line};border-radius:11px;padding:9px 11px;box-shadow:0 1px 3px rgba(20,30,50,.08);display:flex;flex-direction:column;justify-content:space-between;z-index:1}
  .dg-node.crit{border-color:${C.over};box-shadow:0 2px 8px rgba(229,72,77,.18)}
  .dg-node.done{background:#f7fbf8}
  .dg-t{font-size:12.5px;font-weight:600;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .dg-meta{display:flex;align-items:center;gap:6px}
  .dg-ava{width:17px;height:17px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:9.5px;font-weight:700;flex:none}
  .dg-st{font-size:10px;font-weight:600;border-radius:20px;padding:0 7px}
  .dg-st.todo{color:${C.muted};background:#f0f1f4}.dg-st.doing{color:${C.fill};background:#eaf2ff}.dg-st.done{color:${C.free};background:#eaf7ef}
  .dg-pct{margin-left:auto;font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums}`;
}
