// 依存関係グラフ／クリティカルパス（mock65 相当・実データ）。dependencyEdges + depLayers。
import { load, projectName } from "../lib/store.js";
import { dependencyEdges, depLayers, toH } from "../lib/capacity.js";
import { statusOf, STATUS } from "../lib/kinds.js";
import { C, esc, member_color, fmtH, emptyState } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const COLW = 196, ROWH = 92, NW = 168, NH = 66, PAD = 14;

// B38: 担当/プロジェクトでの強調フィルタ。選択は localStorage 永続（quad.js の whoTabs 作法に倣う）。
const WHO_KEY = "dg.who", PROJ_KEY = "dg.proj";
const FILTER = {
  who: (() => { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } })(),
  proj: (() => { try { return localStorage.getItem(PROJ_KEY) || ""; } catch { return ""; } })(),
};

export async function render(root) {
  const { tasks, projects, members } = await load();
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
  // クリティカルパスを「実際の鎖（連続辺）」として復元する。depLayers は終端から back ポインタを
  // 辿って add した順序付き Set として critical（=[終端, 前駆, …, 始点]）を返す。Set は挿入順を
  // 保持するので、隣接要素 (a=終端寄り, b=その前駆) から辺 b->a を起こせば最長経路の連続辺が得られる。
  // これで赤線が必ず一本の連続した経路になる（旧実装は critical ノード同士が level 差1なら塗っていた
  // ため、鎖外の辺まで赤くなる不具合があった）。
  // Q21(perf): 以前はローカル criticalChain() が同じ最長経路計算（topo+dist+back）を丸ごと再実装し、
  // 同一グラフに対し二重計算していた。depLayers の critical（=同一の end/back 鎖を同一手順で構築）を
  // 再利用して重複を解消。critIds は critical と同集合、critEdges は同じ back 鎖から起こすため出力は不変。
  const critIds = critical;
  const critArr = [...critical];
  const critEdges = new Set();
  for (let i = 0; i + 1 < critArr.length; i++) critEdges.add(`${critArr[i + 1]}->${critArr[i]}`);
  const critEstH = [...critIds].reduce((s, id) => s + toH((byId.get(id) || {}).time_estimate), 0);

  // B36/B37 用の隣接リスト（描画される辺だけ＝両端ノードが存在するもの）。
  // succ: 後続（自分が done で解放する側）, pred: 先行（自分の follows＝これが done で自分が ready）。
  const drawnEdges = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const succ = new Map(nodeIds.map((id) => [id, []]));
  const pred = new Map(nodeIds.map((id) => [id, []]));
  for (const e of drawnEdges) { succ.get(e.from).push(e.to); pred.get(e.to).push(e.from); }

  // B36: ready/blocked 判定。先行(follows)が全て done→ready、未完の先行があれば blocked。
  // done 済みノードや先行を持たないノードはどちらにもしない（待つものが無い＝強調不要）。
  const isDone = (id) => !!(byId.get(id) || {}).done;
  const readiness = new Map();
  for (const id of nodeIds) {
    if (isDone(id)) { readiness.set(id, ""); continue; }
    const ps = pred.get(id);
    if (!ps.length) { readiness.set(id, ""); continue; }
    readiness.set(id, ps.every(isDone) ? "ready" : "blocked");
  }

  // 段(level)ごとに並べる
  const byLevel = new Map();
  for (const id of nodeIds) { const l = level.get(id); (byLevel.get(l) || byLevel.set(l, []).get(l)).push(id); }
  const maxLevel = Math.max(...nodeIds.map((id) => level.get(id)));
  const pos = new Map();

  // 列内順序をバリセンタ法（Sugiyama の交差削減ヒューリスティック）で決める＝辺交差の削減。
  // pred/succ は既存の隣接リスト（描画される辺）。初期順は id 昇順＝安定な開始点。決定論的（乱数なし）。
  const levels = [];
  for (let l = 0; l <= maxLevel; l++) levels[l] = (byLevel.get(l) || []).slice().sort((a, b) => a - b);
  const buildIdx = () => { const m = new Map(); for (const col of levels) col.forEach((id, i) => m.set(id, i)); return m; };
  // ids を neighborsOf(id) の平均インデックス(idxMap)で安定ソート。近傍が無い要素は現在位置を維持。
  const orderByBary = (idsArr, neighborsOf, idxMap) => {
    const bary = new Map();
    idsArr.forEach((id, i) => {
      const ns = (neighborsOf(id) || []).filter((n) => idxMap.has(n));
      bary.set(id, ns.length ? ns.reduce((s, n) => s + idxMap.get(n), 0) / ns.length : i);
    });
    return idsArr.map((id, i) => [id, i]).sort((a, b) => (bary.get(a[0]) - bary.get(b[0])) || (a[1] - b[1])).map((x) => x[0]);
  };
  for (let iter = 0; iter < 4; iter++) {
    let idx = buildIdx();
    for (let l = 1; l <= maxLevel; l++) { levels[l] = orderByBary(levels[l], (id) => pred.get(id), idx); idx = buildIdx(); }
    for (let l = maxLevel - 1; l >= 0; l--) { levels[l] = orderByBary(levels[l], (id) => succ.get(id), idx); idx = buildIdx(); }
  }
  let maxRows = 0;
  for (let l = 0; l <= maxLevel; l++) {
    const col = levels[l] || [];
    maxRows = Math.max(maxRows, col.length);
    col.forEach((id, i) => pos.set(id, { x: l * COLW + PAD, y: i * ROWH + PAD }));
  }
  const W = (maxLevel + 1) * COLW + PAD, H = maxRows * ROWH + PAD;

  // 辺SVG（data-from/to を持たせ、B37 の hover 強調で個別に DOM 操作できるようにする）
  const isCrit = (e) => critEdges.has(`${e.from}->${e.to}`);
  const paths = drawnEdges.map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const crit = isCrit(e);
    return `<path class="dg-edge${crit ? " crit" : ""}" data-from="${e.from}" data-to="${e.to}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2}" fill="none" stroke="${crit ? C.over : "#c4ccd6"}" stroke-width="${crit ? 2.4 : 1.5}" ${crit ? "" : 'stroke-dasharray="4 3"'} marker-end="url(#dg-arrow${crit ? "-c" : ""})"/>`;
  }).join("");

  const nodes = nodeIds.map((id) => nodeHtml(byId.get(id), pos.get(id), critical.has(id), readiness.get(id))).join("");

  const critSummary = critEdges.size
    ? `クリティカルパス: ${critEdges.size}辺・計${fmtH(critEstH)}`
    : "クリティカルパス: なし";

  // B38: 担当/プロジェクトの絞り込み select（強調＝集合外を dim）。
  const memberOpts = `<option value="">担当: 全員</option>` + (members || [])
    .map((m) => `<option value="${m.id}"${String(FILTER.who) === String(m.id) ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");
  const projIds = [...new Set(nodeIds.map((id) => (byId.get(id) || {}).project_id).filter((v) => v != null))];
  const projOpts = `<option value="">プロジェクト: 全て</option>` + projIds
    .map((pid) => `<option value="${pid}"${String(FILTER.proj) === String(pid) ? " selected" : ""}>${esc(projectName(projects, pid))}</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">依存グラフ <small>${nodeIds.length}タスク</small></h1>
    <div class="dg-legend">
      <span class="dg-leg"><i class="dg-leg-crit"></i>クリティカルパス（最長経路）</span>
      <span class="dg-leg"><i class="dg-leg-dep"></i>依存</span>
      <span class="dg-leg"><i class="dg-leg-dot ready"></i>着手可（先行が完了）</span>
      <span class="dg-leg"><i class="dg-leg-lock">🔒</i>未着手の先行あり</span>
      <span class="dg-leg-sum">${esc(critSummary)}</span>
    </div>
    <div class="dg-tools">
      <select id="dg-who" class="dg-sel">${memberOpts}</select>
      <select id="dg-proj" class="dg-sel">${projOpts}</select>
      ${(FILTER.who || FILTER.proj) ? `<button id="dg-clear" class="dg-clear" type="button">絞り込み解除</button>` : ""}
      <div class="dg-zoom" role="group" aria-label="ズーム">
        <button id="dg-zout" class="dg-zbtn" type="button" title="縮小" aria-label="縮小">−</button>
        <span id="dg-zlvl" class="dg-zlvl" aria-live="polite">100%</span>
        <button id="dg-zin" class="dg-zbtn" type="button" title="拡大" aria-label="拡大">＋</button>
        <button id="dg-zfit" class="dg-zfit" type="button" title="全体フィット">フィット</button>
      </div>
    </div>
    <div class="card dg-card"><div class="dg-scroll"><div class="dg-stage" style="width:${W}px;height:${H}px"><div class="dg-canvas" style="width:${W}px;height:${H}px">
      <svg class="dg-edges" width="${W}" height="${H}"><defs>
        <marker id="dg-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#c4ccd6"/></marker>
        <marker id="dg-arrow-c" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${C.over}"/></marker>
      </defs>${paths}</svg>
      ${nodes}
    </div></div></div></div>`;

  const canvas = root.querySelector(".dg-canvas");
  const stage = root.querySelector(".dg-stage");
  const scroll = root.querySelector(".dg-scroll");

  // C14: ズーム/全体フィット。canvas に transform:scale を当て、外側 .dg-stage の
  // 実寸を scale 後サイズに合わせてスクロールバーを正しく出す（transform はレイアウトを
  // 動かさないため stage の幅高でスクロール領域を表現する）。群A/B の挙動はそのまま。
  const Z_MIN = 0.3, Z_MAX = 2, Z_STEP = 0.15, Z_KEY = "dg.zoom";
  let zoom = (() => {
    const v = parseFloat((() => { try { return localStorage.getItem(Z_KEY) || ""; } catch { return ""; } })());
    return Number.isFinite(v) && v > 0 ? Math.min(Z_MAX, Math.max(Z_MIN, v)) : 1;
  })();
  const zLvl = root.querySelector("#dg-zlvl");
  const applyZoom = (persist = true) => {
    canvas.style.transformOrigin = "top left";
    canvas.style.transform = `scale(${zoom})`;
    stage.style.width = `${W * zoom}px`;
    stage.style.height = `${H * zoom}px`;
    if (zLvl) zLvl.textContent = `${Math.round(zoom * 100)}%`;
    if (persist) { try { localStorage.setItem(Z_KEY, String(zoom)); } catch {} }
  };
  const setZoom = (z) => { zoom = Math.min(Z_MAX, Math.max(Z_MIN, Math.round(z * 100) / 100)); applyZoom(); };
  // 全体フィット: スクロール表示領域に内容全体が収まる scale を算出（上限 1＝拡大しすぎない）。
  const fitZoom = () => {
    const cs = getComputedStyle(scroll);
    const availW = scroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = scroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const z = Math.min(availW / W, availH / H, 1);
    setZoom(z);
  };
  applyZoom(false);
  root.querySelector("#dg-zin").onclick = () => setZoom(zoom + Z_STEP);
  root.querySelector("#dg-zout").onclick = () => setZoom(zoom - Z_STEP);
  root.querySelector("#dg-zfit").onclick = fitZoom;

  // B38: filter 適用（強調＝match、集合外を dim）。再描画せず class トグルで反映。
  const matchOf = (id) => {
    const t = byId.get(id) || {};
    if (FILTER.who && !(t.assignees || []).some((a) => String(a.id) === String(FILTER.who))) return false;
    if (FILTER.proj && String(t.project_id) !== String(FILTER.proj)) return false;
    return true;
  };
  const applyFilter = () => {
    const active = !!(FILTER.who || FILTER.proj);
    canvas.classList.toggle("dg-filtering", active);
    canvas.querySelectorAll(".dg-node[data-id]").forEach((el) => {
      el.classList.toggle("filter-out", active && !matchOf(+el.dataset.id));
    });
  };
  applyFilter();

  const setFilter = (key, storeKey, val) => {
    FILTER[key] = val;
    try { val ? localStorage.setItem(storeKey, val) : localStorage.removeItem(storeKey); } catch {}
    render(root);
  };
  root.querySelector("#dg-who").onchange = (e) => setFilter("who", WHO_KEY, e.target.value);
  root.querySelector("#dg-proj").onchange = (e) => setFilter("proj", PROJ_KEY, e.target.value);
  const clearBtn = root.querySelector("#dg-clear");
  if (clearBtn) clearBtn.onclick = () => { FILTER.who = ""; FILTER.proj = ""; try { localStorage.removeItem(WHO_KEY); localStorage.removeItem(PROJ_KEY); } catch {} render(root); };

  // B37: ノード hover で依存チェーン（上流 pred / 下流 succ）を BFS で強調し、集合外を dim。
  // 経由辺は from/to の両方が集合に入る辺を強調。filter(B38)の dim とは別レイヤ（hover が優先）。
  const chainFrom = (start) => {
    const set = new Set([start]);
    const up = [start];
    while (up.length) { const n = up.pop(); for (const p of pred.get(n) || []) if (!set.has(p)) { set.add(p); up.push(p); } }
    const down = [start];
    while (down.length) { const n = down.pop(); for (const s of succ.get(n) || []) if (!set.has(s)) { set.add(s); down.push(s); } }
    return set;
  };
  const clearHover = () => {
    canvas.classList.remove("dg-hover");
    canvas.querySelectorAll(".dg-node.hl, .dg-node.dim").forEach((el) => el.classList.remove("hl", "dim"));
    canvas.querySelectorAll(".dg-edge.hl, .dg-edge.dim").forEach((el) => el.classList.remove("hl", "dim"));
  };
  const applyHover = (id) => {
    const set = chainFrom(id);
    canvas.classList.add("dg-hover");
    canvas.querySelectorAll(".dg-node[data-id]").forEach((el) => {
      const on = set.has(+el.dataset.id);
      el.classList.toggle("hl", on);
      el.classList.toggle("dim", !on);
    });
    canvas.querySelectorAll(".dg-edge").forEach((el) => {
      const on = set.has(+el.dataset.from) && set.has(+el.dataset.to);
      el.classList.toggle("hl", on);
      el.classList.toggle("dim", !on);
    });
  };

  // ノードクリックで編集モーダル（table.js と同じパターン: 保存後に再描画）。
  // クリックはノード本体に限定（背景・SVGの線では発火しない）。
  root.querySelectorAll(".dg-node[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
    el.onmouseenter = () => applyHover(+el.dataset.id);
    el.onmouseleave = clearHover;
  });
}

function nodeHtml(t, p, crit, rdy) {
  const st = statusOf(t);
  const who = (t.assignees || [])[0];
  const wn = who ? (who.name || who.username) : "";
  // B36: ready=緑強調 / blocked=鍵アイコン。クラスは crit と独立（両立しうる）。
  const rdyCls = rdy ? ` ${rdy}` : "";
  const lock = rdy === "blocked" ? `<span class="dg-lock" title="未着手の先行タスクがあります">🔒</span>` : "";
  return `<div class="dg-node ${st} ${crit ? "crit" : ""}${rdyCls}" data-id="${t.id}" title="${esc(t.title)}" style="left:${p.x}px;top:${p.y}px;width:${NW}px;height:${NH}px">
    ${lock}
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
  .dg-legend{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:-4px 0 10px;font-size:12px;color:${C.muted}}
  .dg-leg{display:inline-flex;align-items:center;gap:6px}
  .dg-leg i{display:inline-block;width:22px;height:0;flex:none}
  .dg-leg-crit{border-top:2.4px solid ${C.over}}
  .dg-leg-dep{border-top:1.5px dashed #c4ccd6}
  .dg-leg-dot{width:11px!important;height:11px!important;border-radius:50%;border:0!important}
  .dg-leg-dot.ready{background:${C.free}}
  .dg-leg-lock{width:auto!important;font-size:12px;line-height:1}
  .dg-leg-sum{margin-left:auto;font-weight:600;color:${C.ink};font-variant-numeric:tabular-nums}
  .dg-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}
  .dg-sel{font-size:12px;border:1px solid ${C.line};border-radius:8px;padding:5px 8px;background:#fff;color:${C.ink};cursor:pointer}
  .dg-clear{font-size:12px;border:1px solid ${C.line};border-radius:8px;padding:5px 10px;background:#fff;color:${C.muted};cursor:pointer}
  .dg-clear:hover{background:#f6f7f9}
  /* C14 ズームツールバー */
  .dg-zoom{display:inline-flex;align-items:center;gap:4px;margin-left:auto;border:1px solid ${C.line};border-radius:9px;padding:2px 4px;background:#fff}
  .dg-zbtn{font-size:14px;line-height:1;width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:${C.ink};cursor:pointer}
  .dg-zbtn:hover{background:#f0f1f4}
  .dg-zlvl{font-size:11.5px;min-width:38px;text-align:center;color:${C.muted};font-variant-numeric:tabular-nums;user-select:none}
  .dg-zfit{font-size:11.5px;border:0;border-left:1px solid ${C.line};border-radius:0;margin-left:2px;padding:0 8px;height:24px;background:transparent;color:${C.ink};cursor:pointer}
  .dg-zfit:hover{background:#f0f1f4}
  .dg-card{padding:0}
  .dg-scroll{overflow:auto;padding:14px}
  .dg-stage{position:relative}
  .dg-canvas{position:relative;transform-origin:top left}
  .dg-edges{position:absolute;inset:0;pointer-events:none}
  .dg-edge{transition:opacity .12s}
  .dg-node{position:absolute;background:#fff;border:1px solid ${C.line};border-radius:11px;padding:9px 11px;box-shadow:0 1px 3px rgba(20,30,50,.08);display:flex;flex-direction:column;justify-content:space-between;z-index:1;cursor:pointer;transition:opacity .12s,box-shadow .12s}
  .dg-node.crit{border-color:${C.over};box-shadow:0 2px 8px rgba(229,72,77,.18)}
  .dg-node.done{background:#f7fbf8}
  /* B36 ready/blocked: ready=緑左ライン+緑枠、blocked=鍵バッジ（done でないもののみ付与） */
  .dg-node.ready{border-color:${C.free};box-shadow:0 0 0 1px ${C.free} inset,0 1px 3px rgba(20,30,50,.08)}
  .dg-node.ready::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:3px;background:${C.free}}
  .dg-node.blocked{border-color:#e6c98a}
  .dg-lock{position:absolute;top:6px;right:7px;font-size:11px;line-height:1;opacity:.85}
  .dg-t{font-size:12.5px;font-weight:600;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .dg-meta{display:flex;align-items:center;gap:6px}
  .dg-ava{width:17px;height:17px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:9.5px;font-weight:700;flex:none}
  .dg-st{font-size:10px;font-weight:600;border-radius:20px;padding:0 7px}
  .dg-st.todo{color:${C.muted};background:#f0f1f4}.dg-st.doing{color:${C.fill};background:#eaf2ff}.dg-st.waiting{color:#9a6a00;background:#fbf0d6}.dg-st.done{color:${C.free};background:#eaf7ef}
  .dg-pct{margin-left:auto;font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  /* B37 hover チェーン強調: 集合外を dim、集合内を hl */
  .dg-canvas.dg-hover .dg-node.dim{opacity:.18}
  .dg-canvas.dg-hover .dg-node.hl{box-shadow:0 3px 12px rgba(20,30,50,.18);z-index:2}
  .dg-canvas.dg-hover .dg-edge.dim{opacity:.1}
  .dg-canvas.dg-hover .dg-edge.hl{opacity:1}
  /* B38 filter: 集合外を dim（hover 中は hover の dim が優先されるよう hover 未起動時のみ適用） */
  .dg-canvas.dg-filtering:not(.dg-hover) .dg-node.filter-out{opacity:.16}
  /* ===== ダークモード上書き（light は不変。構造色は var()、色面は rgba tint。
     .dg-sel(=select)/.dg-st.todo/.doing/.waiting/.done は app/index.html の
     グローバルダークブロックで既出のためここでは触らない） ===== */
  html[data-theme="dark"] .dg-clear{background:var(--card);color:${C.muted}}
  html[data-theme="dark"] .dg-clear:hover{background:var(--track)}
  html[data-theme="dark"] .dg-zoom{background:var(--card)}
  html[data-theme="dark"] .dg-zbtn:hover{background:var(--track)}
  html[data-theme="dark"] .dg-zfit:hover{background:var(--track)}
  html[data-theme="dark"] .dg-node{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.4)}
  html[data-theme="dark"] .dg-node.crit{box-shadow:0 2px 8px rgba(229,72,77,.30)}
  html[data-theme="dark"] .dg-node.done{background:rgba(47,166,107,.12)}
  html[data-theme="dark"] .dg-node.blocked{border-color:rgba(245,166,35,.55)}
  html[data-theme="dark"] .dg-node.ready{box-shadow:0 0 0 1px ${C.free} inset,0 1px 3px rgba(0,0,0,.4)}
  html[data-theme="dark"] .dg-canvas.dg-hover .dg-node.hl{box-shadow:0 3px 12px rgba(0,0,0,.5)}`;
}
