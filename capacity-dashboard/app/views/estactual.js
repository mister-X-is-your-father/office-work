// 見積り vs 実績（mock 23 相当・実データ。fork の time_estimate/time_spent）
import { load } from "../lib/store.js";
import { estimateVsActual } from "../lib/capacity.js";
import { C, fmtH, esc } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

export async function render(root) {
  const { tasks } = await load();
  const r = estimateVsActual(tasks);
  const overall = r.totEst ? Math.round((r.ratio - 1) * 100) : null;
  const maxH = Math.max(...r.rows.flatMap(x => [x.estH, x.actH]), 1);

  // 件数の内訳（status 基準: 超過 / 過小 / 一致）と見積精度
  const nTotal = r.rows.length;
  const nOver = r.rows.filter(x => x.status === "over").length;
  const nUnder = r.rows.filter(x => x.status === "under").length;
  const nExact = nTotal - nOver - nUnder;
  // 見積精度 = 見積/実績の比を 1.0 に近いほど高精度として平均（見積のあるタスクのみ対象）。100% に近いほど良い。
  const acc = estimateAccuracy(r.rows);

  root.innerHTML = `
    <h1 class="vtitle">見積り vs 実績</h1>
    <div class="kpis">
      <div class="kpi"><div class="l">対象タスク</div><div class="v">${nTotal}件 <span class="sub">(<span style="color:${C.over}">超過${nOver}</span> / <span style="color:${C.free}">過小${nUnder}</span> / <span style="color:${C.amber}">一致${nExact}</span>)</span></div></div>
      <div class="kpi"><div class="l">見積精度</div><div class="v">${acc == null ? "—" : acc + "%"}</div></div>
      <div class="kpi"><div class="l">見積り合計</div><div class="v">${fmtH(r.totEst)}</div></div>
      <div class="kpi"><div class="l">実績合計</div><div class="v">${fmtH(r.totAct)}</div></div>
      <div class="kpi ${overall>0?"over":overall<0?"under":""}"><div class="l">全体差分</div><div class="v">${overall==null?"—":(overall>=0?"+":"")+overall+"%"}</div></div>
    </div>
    <div class="card">${r.rows.length ? r.rows.map(x => rowHtml(x, maxH)).join("") : empty()}</div>
    <div class="legend"><span><i style="background:${C.full}"></i>見積り</span><span><i style="background:${C.over}"></i>超過</span><span><i style="background:${C.amber}"></i>一致</span><span><i style="background:${C.free}"></i>過小</span></div>
    <style>
      .kpi .v .sub{font-size:12px;font-weight:600}
    </style>`;

  // 行クリックで編集（保存後 再描画）。他画面（一覧/かんばん）と挙動を揃える。
  root.querySelectorAll(".ea-row[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
    el.onmouseenter = () => { el.style.background = C.track; };
    el.onmouseleave = () => { el.style.background = ""; };
  });
}

// status 基準の色: 超過=赤 / 一致=琥珀 / 過小=緑。見積が無い(実績のみ)は中立色。
function statusColor(x) {
  if (x.estH <= 0) return C.muted;      // 見積なし＝判定不能（"実績があるだけで赤"を回避）
  if (x.status === "over") return C.over;
  if (x.status === "under") return C.free;
  return C.amber;                        // exact（一致）
}

// 見積精度(%): 見積のあるタスクごとに |差分| を見積で正規化し、1 - 平均相対誤差 を百分率化。
// 100% = 見積と実績が完全一致。下振れ/上振れの大きさで減点。見積なしタスクは対象外。
function estimateAccuracy(rows) {
  const withEst = rows.filter(x => x.estH > 0);
  if (!withEst.length) return null;
  const meanErr = withEst.reduce((s, x) => s + Math.abs(x.actH - x.estH) / x.estH, 0) / withEst.length;
  return Math.max(0, Math.round((1 - meanErr) * 100));
}

function rowHtml(x, maxH) {
  const diffTxt = x.diff == null ? "実績のみ" : (x.diff >= 0 ? "+" : "") + Math.round(x.diff * 100) + "%";
  const cls = statusColor(x);
  const actColor = statusColor(x);
  const bar = (val, color) => `<div style="flex:1;height:14px;background:${C.track};border-radius:5px;overflow:hidden"><div style="height:100%;width:${val / maxH * 100}%;background:${color};border-radius:5px"></div></div>`;
  return `<div class="ea-row" data-id="${x.id}" title="クリックで編集" style="padding:13px 16px;border-bottom:1px solid ${C.line};cursor:pointer;transition:background .12s">
    <div style="display:flex;justify-content:space-between;margin-bottom:7px"><b style="font-size:14px">${esc(x.title)}</b>
      <span style="font-weight:700;color:${cls}">${diffTxt} <span style="color:${C.muted};font-weight:400">${fmtH(x.estH)} → ${fmtH(x.actH)}</span></span></div>
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:40px;font-size:10.5px;color:${C.muted};text-align:right">見積</span>${bar(x.estH, C.full)}<span style="width:42px;font-size:11.5px;font-weight:600">${fmtH(x.estH)}</span></div>
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:40px;font-size:10.5px;color:${C.muted};text-align:right">実績</span>${bar(x.actH, actColor)}<span style="width:42px;font-size:11.5px;font-weight:600">${fmtH(x.actH)}</span></div>
  </div>`;
}
const empty = () => `<div style="padding:34px;text-align:center;color:${C.muted}">見積り/実績のあるタスクがありません。タスクに見積り時間を設定し、実績を記録してください。</div>`;
