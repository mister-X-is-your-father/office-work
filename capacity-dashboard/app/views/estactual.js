// 見積り vs 実績（mock 23 相当・実データ。fork の time_estimate/time_spent）
import { load } from "../lib/store.js";
import { estimateVsActual } from "../lib/capacity.js";
import { C, fmtH, esc } from "../lib/ui.js";

export async function render(root) {
  const { tasks } = await load();
  const r = estimateVsActual(tasks);
  const overall = r.totEst ? Math.round((r.ratio - 1) * 100) : null;
  const maxH = Math.max(...r.rows.flatMap(x => [x.estH, x.actH]), 1);

  root.innerHTML = `
    <h1 class="vtitle">見積り vs 実績 <small>実データ</small></h1>
    <div class="kpis">
      <div class="kpi"><div class="l">見積り合計</div><div class="v">${fmtH(r.totEst)}</div></div>
      <div class="kpi"><div class="l">実績合計</div><div class="v">${fmtH(r.totAct)}</div></div>
      <div class="kpi ${overall>0?"over":overall<0?"under":""}"><div class="l">全体差分</div><div class="v">${overall==null?"—":(overall>=0?"+":"")+overall+"%"}</div></div>
    </div>
    <div class="card">${r.rows.length ? r.rows.map(x => rowHtml(x, maxH)).join("") : empty()}</div>
    <div class="legend"><span><i style="background:${C.full}"></i>見積り</span><span><i style="background:${C.fill}"></i>実績(見積内)</span><span><i style="background:${C.over}"></i>実績(超過)</span></div>`;
}

function rowHtml(x, maxH) {
  const diffTxt = x.diff == null ? "実績のみ" : (x.diff >= 0 ? "+" : "") + Math.round(x.diff * 100) + "%";
  const cls = x.status === "over" ? C.over : x.status === "under" ? C.free : C.muted;
  const actColor = x.actH > x.estH ? C.over : C.fill;
  const bar = (val, color) => `<div style="flex:1;height:14px;background:${C.track};border-radius:5px;overflow:hidden"><div style="height:100%;width:${val / maxH * 100}%;background:${color};border-radius:5px"></div></div>`;
  return `<div style="padding:13px 16px;border-bottom:1px solid ${C.line}">
    <div style="display:flex;justify-content:space-between;margin-bottom:7px"><b style="font-size:14px">${esc(x.title)}</b>
      <span style="font-weight:700;color:${cls}">${diffTxt} <span style="color:${C.muted};font-weight:400">${fmtH(x.estH)} → ${fmtH(x.actH)}</span></span></div>
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:40px;font-size:10.5px;color:${C.muted};text-align:right">見積</span>${bar(x.estH, C.full)}<span style="width:42px;font-size:11.5px;font-weight:600">${fmtH(x.estH)}</span></div>
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:40px;font-size:10.5px;color:${C.muted};text-align:right">実績</span>${bar(x.actH, actColor)}<span style="width:42px;font-size:11.5px;font-weight:600">${fmtH(x.actH)}</span></div>
  </div>`;
}
const empty = () => `<div style="padding:34px;text-align:center;color:${C.muted}">見積り/実績のあるタスクがありません。タスクに見積り時間を設定し、実績を記録してください。</div>`;
