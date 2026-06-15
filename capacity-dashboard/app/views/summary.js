// 概要ダッシュボード（TickTick の「概要/統計」をブラッシュアップ＋§9 のPJ別配分/負荷ヒストリー）。
// store のタスクだけで集計（N+1なし）。完了の推移・PJ別配分・分類別・見積りvs実績。
import { load, projectName } from "../lib/store.js";
import { dailyThroughput, projectTotals, labelTotals, overallStats } from "../lib/summary.js";
import { estimateVsActual } from "../lib/capacity.js";
import { categoryColor } from "../lib/kinds.js";
import { C, esc, fmtH, todayISO } from "../lib/ui.js";

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

export async function render(root) {
  const { tasks, projects, labels = [] } = await load();
  const today = todayISO();
  const s = overallStats(tasks, today);
  const tp = dailyThroughput(tasks, today, 14);
  const pjs = projectTotals(tasks)
    .filter((p) => p.estH > 0 || p.spentH > 0 || p.count > 0)
    .sort((a, b) => (b.estH + b.spentH) - (a.estH + a.spentH)).slice(0, 8);
  const cats = labelTotals(tasks).slice(0, 8);
  const labelById = new Map((labels || []).map((l) => [l.title, l]));
  const eva = estimateVsActual(tasks).rows
    .filter((r) => r.actH > 0).sort((a, b) => Math.abs(b.actH - b.estH) - Math.abs(a.actH - a.estH)).slice(0, 6);

  const accPct = s.accuracy == null ? "—" : Math.round(s.accuracy * 100) + "%";
  const accCls = s.accuracy == null ? "" : (s.accuracy > 1.1 ? "over" : s.accuracy < 0.9 ? "under" : "ok");

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">概要 <small>${today} 時点</small></h1>
    <div class="sm-kpis">
      ${kpi("今週の完了", `${s.doneThisWeek}`, `件 ・ 累計 ${s.done}`, "free")}
      ${kpi("実績 / 見積り", `${fmtH(s.spentH)}`, `/ ${fmtH(s.estH)}`, "")}
      ${kpi("見積り精度", accPct, "実績÷見積り", accCls)}
      ${kpi("未完了", `${s.open}`, `件 ・ 期限切れ ${s.overdue}`, s.overdue ? "over" : "")}
    </div>

    <div class="card sm-card">
      <div class="sm-h">完了の推移 <span class="sm-sub">過去14日 ・ <i class="lg add"></i>追加 <i class="lg done"></i>完了</span></div>
      ${throughputChart(tp)}
    </div>

    <div class="sm-grid2">
      <div class="card sm-card">
        <div class="sm-h">ワークスペース別の配分 <span class="sm-sub">見積り / 実績</span></div>
        ${pjs.length ? pjBars(pjs, projects) : empty()}
      </div>
      <div class="card sm-card">
        <div class="sm-h">分類別のタスク数</div>
        ${cats.length ? catBars(cats, labelById) : empty()}
      </div>
    </div>

    <div class="card sm-card">
      <div class="sm-h">見積り vs 実績 <span class="sm-sub">ズレの大きい順 ・ 実績のあるタスク</span></div>
      ${eva.length ? evaRows(eva) : empty()}
    </div>`;
}

function kpi(label, big, sub, cls) {
  return `<div class="sm-kpi ${cls}">
    <div class="sm-kl">${label}</div>
    <div class="sm-kv">${big}<small>${sub}</small></div>
  </div>`;
}

function throughputChart(tp) {
  const max = Math.max(1, ...tp.map((d) => Math.max(d.added, d.done)));
  const H = 84;
  const bars = tp.map((d) => {
    const dt = new Date(d.day + "T00:00:00Z");
    const wd = dt.getUTCDay();
    const ha = Math.round((d.added / max) * H), hd = Math.round((d.done / max) * H);
    return `<div class="sm-bcol${wd === 0 || wd === 6 ? " wknd" : ""}">
      <div class="sm-bwrap" style="height:${H}px">
        <div class="sm-bar add" style="height:${ha}px" title="追加 ${d.added}"></div>
        <div class="sm-bar done" style="height:${hd}px" title="完了 ${d.done}"></div>
      </div>
      <div class="sm-bx">${+d.day.slice(8)}</div>
      <div class="sm-bw">${DOW[wd]}</div>
    </div>`;
  }).join("");
  return `<div class="sm-chart">${bars}</div>`;
}

function pjBars(pjs, projects) {
  const max = Math.max(1, ...pjs.map((p) => Math.max(p.estH, p.spentH)));
  return `<div class="sm-rows">${pjs.map((p) => {
    const name = projectName(projects, p.projectId);
    return `<div class="sm-prow">
      <div class="sm-pname" title="${esc(name)}">${esc(name)} <span class="sm-pmeta">${p.done}/${p.count}件</span></div>
      <div class="sm-pbars">
        <div class="sm-pb"><i class="est" style="width:${(p.estH / max) * 100}%"></i><b>${fmtH(p.estH)}</b></div>
        <div class="sm-pb"><i class="spent" style="width:${(p.spentH / max) * 100}%"></i><b>${fmtH(p.spentH)}</b></div>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function catBars(cats, labelById) {
  const max = Math.max(1, ...cats.map((c) => c.count));
  return `<div class="sm-rows">${cats.map((c) => {
    const col = categoryColor(labelById.get(c.title) || { id: 0 });
    return `<div class="sm-crow">
      <div class="sm-cname">${esc(c.title)}</div>
      <div class="sm-cbar"><i style="width:${(c.count / max) * 100}%;background:${col}"></i></div>
      <div class="sm-cn">${c.count}</div>
    </div>`;
  }).join("")}</div>`;
}

function evaRows(eva) {
  return `<div class="sm-rows">${eva.map((r) => {
    const diff = r.actH - r.estH;
    const cls = diff > 0.05 ? "over" : diff < -0.05 ? "under" : "ok";
    const sign = diff > 0 ? "+" : "";
    return `<div class="sm-erow">
      <div class="sm-etitle" title="${esc(r.title)}">${esc(r.title)}</div>
      <div class="sm-ev">見 ${fmtH(r.estH)} → 実 ${fmtH(r.actH)} <span class="sm-ediff ${cls}">${sign}${fmtH(diff)}</span></div>
    </div>`;
  }).join("")}</div>`;
}

const empty = () => `<div class="sm-empty">データがありません。</div>`;

function css() {
  return `
  .sm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
  .sm-kpi{background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:14px 16px}
  .sm-kl{font-size:11.5px;color:${C.muted};font-weight:600;margin-bottom:6px}
  .sm-kv{font-size:26px;font-weight:800;letter-spacing:-.01em;line-height:1}
  .sm-kv small{font-size:12px;font-weight:600;color:${C.muted};margin-left:6px}
  .sm-kpi.free .sm-kv{color:${C.free}}.sm-kpi.over .sm-kv{color:${C.over}}
  .sm-kpi.under .sm-kv{color:${C.amber}}.sm-kpi.ok .sm-kv{color:${C.free}}
  .sm-card{padding:16px 18px;margin-bottom:14px}
  .sm-h{font-size:13.5px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:10px}
  .sm-sub{font-size:11px;color:${C.muted};font-weight:400;display:inline-flex;align-items:center;gap:5px}
  .sm-h .lg{width:10px;height:10px;border-radius:3px;display:inline-block;margin-left:6px}
  .lg.add{background:${C.fill}}.lg.done{background:${C.free}}
  .sm-chart{display:flex;align-items:flex-end;gap:3px;justify-content:space-between}
  .sm-bcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
  .sm-bcol.wknd .sm-bx,.sm-bcol.wknd .sm-bw{color:#b9c0cb}
  .sm-bwrap{display:flex;align-items:flex-end;justify-content:center;gap:2px;width:100%}
  .sm-bar{width:8px;border-radius:3px 3px 0 0;min-height:2px}
  .sm-bar.add{background:${C.fill}}
  .sm-bar.done{background:${C.free}}
  .sm-bx{font-size:10.5px;color:${C.ink};font-variant-numeric:tabular-nums}
  .sm-bw{font-size:9px;color:${C.muted}}
  .sm-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:760px){.sm-grid2{grid-template-columns:1fr}}
  .sm-rows{display:flex;flex-direction:column;gap:11px}
  .sm-prow{display:grid;grid-template-columns:140px 1fr;gap:10px;align-items:center}
  .sm-pname{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sm-pmeta{font-size:10.5px;color:${C.muted};font-weight:400}
  .sm-pbars{display:flex;flex-direction:column;gap:3px}
  .sm-pb{position:relative;height:15px;background:${C.track};border-radius:5px;overflow:hidden;display:flex;align-items:center}
  .sm-pb i{position:absolute;left:0;top:0;bottom:0;border-radius:5px}
  .sm-pb i.est{background:rgba(58,134,255,.45)}
  .sm-pb i.spent{background:${C.free}}
  .sm-pb b{position:relative;font-size:10px;font-weight:700;color:${C.ink};margin-left:7px;font-variant-numeric:tabular-nums}
  .sm-crow{display:grid;grid-template-columns:90px 1fr 28px;gap:10px;align-items:center}
  .sm-cname{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sm-cbar{height:13px;background:${C.track};border-radius:5px;overflow:hidden}
  .sm-cbar i{display:block;height:100%;border-radius:5px}
  .sm-cn{font-size:12px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;color:${C.muted}}
  .sm-erow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid ${C.track}}
  .sm-erow:first-child{border-top:0}
  .sm-etitle{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .sm-ev{font-size:12px;color:${C.muted};white-space:nowrap;flex:none}
  .sm-ediff{font-weight:700;margin-left:4px}
  .sm-ediff.over{color:${C.over}}.sm-ediff.under{color:${C.amber}}.sm-ediff.ok{color:${C.free}}
  .sm-empty{font-size:12.5px;color:${C.muted};padding:18px 2px;text-align:center}

  /* ── ダーク上書き：css()内のハードコード淡色だけ補正。ライト値は上で維持＝非回帰。
     カード/罫線/track/ink/muted は C.* 経由で var() 参照済＝自動反転するので再指定不要。
     ここで直す対象＝var()を介さず直書きした淡色のみ。アクセント色(青/緑/amber)は据え置き。 */
  html[data-theme="dark"] .sm-bcol.wknd .sm-bx,
  html[data-theme="dark"] .sm-bcol.wknd .sm-bw{color:var(--line-strong)}`;
}
