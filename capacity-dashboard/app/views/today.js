// 本日の稼働予定。円時計(clock.js)／積み上げ(mock54) を切替表示。
import { load } from "../lib/store.js";
import { loadByMember } from "../lib/capacity.js";
import { projectName } from "../lib/store.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";
import { renderClock } from "./clock.js";

const CAP = 8;
const PJPAL = ["#3a86ff", "#2fa66b", "#b657d6", "#e5772d", "#0ea5e9", "#f5a623", "#ef476f", "#14b8a6"];
let MODE = "clock"; // 'clock' | 'stacked'（セッション内保持）

export async function render(root) {
  const data = await load();
  const day = todayISO();
  root.innerHTML = `
    <style>.t-seg{display:inline-flex;background:#fff;border:1px solid ${C.line};border-radius:10px;padding:3px;margin:0 0 16px;box-shadow:0 1px 2px rgba(20,30,50,.04)}
    .t-seg button{border:0;background:transparent;color:${C.muted};font:inherit;font-size:13px;font-weight:600;padding:5px 14px;border-radius:8px;cursor:pointer}
    .t-seg button.on{background:${C.fill};color:#fff}</style>
    <h1 class="vtitle">本日の稼働予定 <small>${day}</small></h1>
    <div class="t-seg">
      <button data-m="clock" class="${MODE === "clock" ? "on" : ""}">円時計</button>
      <button data-m="stacked" class="${MODE === "stacked" ? "on" : ""}">積み上げ</button>
    </div>
    <div id="t-body"></div>`;
  root.querySelectorAll(".t-seg button").forEach((b) => { b.onclick = () => { MODE = b.dataset.m; render(root); }; });
  const body = root.querySelector("#t-body");
  if (MODE === "clock") renderClock(body, data, day, () => render(root));
  else renderStacked(body, data, day);
}

function renderStacked(body, data, day) {
  const { tasks, members, projects, plansByTask } = data;
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  const pjIdx = new Map();
  const pjColor = (pid) => {
    if (pid == null) return C.full;
    if (!pjIdx.has(pid)) pjIdx.set(pid, pjIdx.size);
    return PJPAL[pjIdx.get(pid) % PJPAL.length];
  };
  const rows = loadByMember(tasks, members, day, CAP, plansByTask).sort((a, b) => b.freeH - a.freeH);
  const totCap = rows.reduce((s, r) => s + r.capH, 0);
  const totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const free = Math.max(0, totCap - totAsg);
  const over = Math.max(0, totAsg - totCap);
  const rate = totCap > 0 ? Math.round((totAsg / totCap) * 100) : 0;
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.assignedH), 0);
  const yMax = Math.max(11, Math.ceil(maxTotal) + 1);
  const CHART_H = 400, FOOT_H = 54, PLOT_H = CHART_H - FOOT_H;
  const pxPerH = PLOT_H / yMax;
  const usedPjs = [...pjIdx.keys()];

  body.innerHTML = `
    <style>${css()}</style>
    <div class="t54-sub">メンバー別の予定工数と空き（容量 ${CAP}h/人・予定があれば予定、無ければ見積りの期間日割り）</div>
    <div class="kpis">
      <div class="kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></div>
      <div class="kpi"><div class="l">稼働率</div><div class="v">${rate}<small>%</small></div></div>
      <div class="kpi free"><div class="l">空き工数</div><div class="v">${fmtH(free)}</div></div>
      <div class="kpi over"><div class="l">超過</div><div class="v">${over > 0 ? "+" + fmtH(over) : "0h"}</div></div>
    </div>
    <div class="t54-card">
      ${rows.length ? chartHtml(rows, { yMax, PLOT_H, FOOT_H, pxPerH, taskById, pjColor }) : empty()}
      ${rows.length ? legendHtml(usedPjs, projects, pjColor) : ""}
    </div>
    ${rows.length ? `<div class="t54-hint">タイル＝本日のタスク（高さ＝工数）。容量線(${CAP}h)を超えた分が赤、線の下の点線が空き工数。</div>` : ""}`;
}

function chartHtml(rows, g) {
  const { yMax, PLOT_H, FOOT_H, pxPerH, taskById, pjColor } = g;
  // Y目盛り＋グリッド
  let yaxis = "", grids = "";
  const step = yMax > 14 ? 4 : 2;
  for (let hh = 0; hh <= yMax - 1; hh += step) {
    const topY = PLOT_H - hh * pxPerH;
    yaxis += `<div class="t54-ytick" style="top:${topY}px">${hh}h</div>`;
    grids += `<div class="t54-ygrid" style="top:${topY}px"></div>`;
  }
  // 容量線
  const capTop = PLOT_H - CAP * pxPerH;
  const capline = `<div class="t54-capline" style="top:${capTop}px"></div><div class="t54-caplabel" style="top:${capTop}px">容量 ${CAP}h</div>`;

  const cols = rows.map((r, i) => colHtml(r, i, g)).join("");
  return `<div class="t54-chart" style="height:${PLOT_H + FOOT_H}px">
      <div class="t54-yaxis">${yaxis}</div>${grids}${capline}${cols}
    </div>`;
}

function colHtml(r, i, g) {
  const { PLOT_H, FOOT_H, pxPerH, taskById, pjColor } = g;
  const total = r.assignedH, over = r.overH, free = r.freeH;
  let inner = "";

  // 空きゾーン（容量線の下・スタック上端まで）
  if (free > 0) {
    inner += `<div class="t54-freezone" style="bottom:${FOOT_H + total * pxPerH}px;height:${free * pxPerH}px"><span>空き ${fmtH(free)}</span></div>`;
  }
  // タスク積み木
  let segs = "";
  for (const t of r.tasks) {
    const hpx = t.h * pxPerH;
    const pid = taskById.get(t.id)?.project_id;
    const col = pjColor(pid);
    const small = hpx < 40 ? " small" : "";
    segs += `<div class="t54-seg${small}" style="height:${hpx}px;background:${col}" title="${esc(t.title)} ・ ${fmtH(t.h)}">
        <div class="t54-tname">${esc(t.title)}</div><div class="t54-thrs"><b>${fmtH(t.h)}</b></div></div>`;
  }
  if (!r.tasks.length) {
    inner += `<div class="t54-none" style="bottom:${FOOT_H}px">本日の予定なし</div>`;
  } else {
    inner += `<div class="t54-stack" style="bottom:${FOOT_H}px;height:${total * pxPerH}px">${segs}</div>`;
  }
  // 超過オーバーレイ
  if (over > 0) {
    inner += `<div class="t54-overlay" style="bottom:${FOOT_H + CAP * pxPerH}px;height:${over * pxPerH}px"></div>`;
    inner += `<div class="t54-overbadge" style="bottom:${FOOT_H + total * pxPerH + 8}px">超過 +${fmtH(over)}</div>`;
  }
  // フッター
  const cls = r.status === "over" ? "over" : (r.status === "full" ? "full" : "free");
  const txt = r.status === "over" ? "超過 +" + fmtH(over) : (r.status === "full" ? "満稼働" : "空き " + fmtH(free));
  const dot = ["#e5772d", "#3a86ff", "#2fa66b", "#b657d6", "#0ea5e9", "#f5a623"][i % 6];
  inner += `<div class="t54-foot">
      <div class="t54-nm"><span class="t54-dot" style="background:${dot}"></span>${esc(r.name)}</div>
      <div class="t54-status ${cls}">${txt}</div>
      <div class="t54-total">${fmtH(total)} / ${r.capH}h</div>
    </div>`;

  return `<div class="t54-col"><div class="t54-area">${inner}</div></div>`;
}

function legendHtml(usedPjs, projects, pjColor) {
  const pj = usedPjs.map((pid) =>
    `<span class="item"><span class="sw" style="background:${pjColor(pid)}"></span>${esc(projectName(projects, pid))}</span>`).join("");
  return `<div class="t54-legend">
      ${pj}
      <span class="item"><span class="rule"></span>容量線 ${CAP}h</span>
      <span class="item"><span class="oversw"></span>容量超過</span>
      <span class="item"><span class="sw" style="background:#fff;border:1.5px dashed #c4d6c9"></span>空き工数</span>
    </div>`;
}

const empty = () => `<div class="t54-empty">本日の予定工数を持つ担当タスクがありません。<br>タスクに担当・期日・見積り、または日別予定を設定してください。</div>`;

function css() {
  return `
  .t54-sub{font-size:12.5px;color:${C.muted};margin:-4px 0 14px}
  .t54-card{background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:30px 26px 16px;box-shadow:0 4px 16px rgba(20,30,50,.06)}
  .t54-chart{display:flex;align-items:flex-end;gap:30px;position:relative;padding:0 6px 0 42px}
  .t54-yaxis{position:absolute;left:0;top:0;bottom:0;width:38px;pointer-events:none}
  .t54-ytick{position:absolute;right:7px;font-size:10.5px;color:${C.muted};transform:translateY(-50%)}
  .t54-ygrid{position:absolute;left:42px;right:6px;border-top:1px solid ${C.track};pointer-events:none}
  .t54-capline{position:absolute;left:42px;right:6px;border-top:2px dashed ${C.capline};z-index:6;pointer-events:none}
  .t54-caplabel{position:absolute;right:6px;font-size:10px;color:${C.muted};background:${C.card};padding:1px 6px;border:1px solid ${C.line};border-radius:20px;transform:translateY(-50%);font-weight:700;z-index:7}
  .t54-col{flex:1;display:flex;justify-content:center;height:100%;position:relative;min-width:0}
  .t54-area{position:relative;width:100%;max-width:124px;height:100%}
  .t54-stack{position:absolute;left:0;right:0;display:flex;flex-direction:column-reverse;filter:drop-shadow(0 2px 5px rgba(20,30,50,.10))}
  .t54-seg{position:relative;display:flex;flex-direction:column;justify-content:center;padding:0 11px;color:#fff;overflow:hidden;border-bottom:2px solid ${C.card}}
  .t54-stack .t54-seg:first-child{border-bottom:0;border-radius:0 0 9px 9px}
  .t54-stack .t54-seg:last-child{border-radius:9px 9px 0 0}
  .t54-seg::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(0,0,0,.06))}
  .t54-seg:hover{filter:brightness(1.05)}
  .t54-tname{font-size:12px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative;z-index:1}
  .t54-thrs{font-size:10.5px;line-height:1.2;margin-top:2px;opacity:.92;position:relative;z-index:1}
  .t54-seg.small{justify-content:center}.t54-seg.small .t54-thrs{display:none}.t54-seg.small .t54-tname{font-size:11px}
  .t54-overlay{position:absolute;left:0;right:0;z-index:5;pointer-events:none;background:rgba(229,72,77,.20);border-radius:9px 9px 0 0;border-top:2px solid ${C.over};box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
  .t54-overbadge{position:absolute;left:50%;transform:translateX(-50%);background:${C.over};color:#fff;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;box-shadow:0 3px 8px rgba(229,72,77,.35);z-index:9}
  .t54-freezone{position:absolute;left:0;right:0;z-index:3;pointer-events:none;border:1.5px dashed #c4d6c9;border-radius:9px;display:flex;align-items:center;justify-content:center}
  .t54-freezone span{font-size:11px;color:${C.free};font-weight:700;background:${C.card};padding:2px 9px;border-radius:20px;border:1px solid #d7ecdf}
  .t54-none{position:absolute;left:0;right:0;height:24px;text-align:center;font-size:11px;color:${C.muted}}
  .t54-foot{position:absolute;bottom:0;left:0;right:0;text-align:center;height:50px}
  .t54-nm{font-size:14.5px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px}
  .t54-dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .t54-status{font-size:11.5px;margin-top:3px;font-weight:700}
  .t54-status.free{color:${C.free}}.t54-status.over{color:${C.over}}.t54-status.full{color:${C.full}}
  .t54-total{font-size:10.5px;color:${C.muted};margin-top:2px}
  .t54-legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:18px 2px 0;font-size:11.5px;color:${C.muted}}
  .t54-legend .item{display:flex;align-items:center;gap:6px}
  .t54-legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block}
  .t54-legend .rule{width:20px;height:0;border-top:2px dashed ${C.capline}}
  .t54-legend .oversw{width:11px;height:11px;border-radius:3px;display:inline-block;background:rgba(229,72,77,.22);border:1.5px solid ${C.over}}
  .t54-hint{font-size:11px;color:${C.muted};text-align:right;margin-top:10px}
  .t54-empty{padding:34px;text-align:center;color:${C.muted}}
  @media(max-width:760px){.t54-chart{gap:14px;padding-left:38px}.t54-tname{font-size:10.5px}.t54-area{max-width:none}}`;
}
