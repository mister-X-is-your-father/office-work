// 見積り vs 実績（mock 23 相当・実データ。fork の time_estimate/time_spent）
import { load } from "../lib/store.js";
import { estimateVsActual, dateOnly, hasDate, shiftISO, isContainer } from "../lib/capacity.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

// B70: 集計対象の期間切替（個人保存）。タスクの基準日（期限→終了→開始の順）が
//   直近 N 日以内のものを対象にする。基準日が無いタスクは常に対象（期間で隠さない）。
const PERIOD_KEY = "ts.estactual.periodDays";
const PERIODS = [14, 30, 90];
const periodDays = () => {
  try { const v = +localStorage.getItem(PERIOD_KEY); return PERIODS.includes(v) ? v : 30; }
  catch { return 30; }
};
// B71: 横軸スケール（個人保存）。global=全行共通の最大値 / row=各行 max(estH,actH) 基準。
const SCALE_KEY = "ts.estactual.scale";
const SCALES = { global: "全体共通", row: "行内" };
const scaleMode = () => { try { const v = localStorage.getItem(SCALE_KEY); return SCALES[v] ? v : "global"; } catch { return "global"; } };

// タスクの基準日（ISO "YYYY-MM-DD"）。期限→終了→開始の順。無ければ ""。
function anchorDay(t) {
  if (hasDate(t.due_date)) return dateOnly(t.due_date);
  if (hasDate(t.end_date)) return dateOnly(t.end_date);
  if (hasDate(t.start_date)) return dateOnly(t.start_date);
  return "";
}

export async function render(root) {
  const { tasks } = await load();
  const days = periodDays();
  const scale = scaleMode();

  // B70: 期間で集計対象を絞る。基準日が直近 N 日以内（today-N 〜 today）なら対象。
  //   基準日の無いタスクは常に対象（期間では隠さない）。
  const today = todayISO();
  const since = shiftISO(today, -days);
  const inPeriod = (t) => {
    const a = anchorDay(t);
    if (!a) return true;          // 日付なし＝常に対象
    return a >= since && a <= today;
  };
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  // コンテナ（子持ち親）は作業行に出さない（#732）
  const scoped = (tasks || []).filter((t) => inPeriod(t) && !isContainer(t, byId));

  const r = estimateVsActual(scoped);
  const overall = r.totEst ? Math.round((r.ratio - 1) * 100) : null;
  const maxH = Math.max(...r.rows.flatMap(x => [x.estH, x.actH]), 1);

  // 件数の内訳（status 基準: 超過 / 過小 / 一致）と見積精度
  const nTotal = r.rows.length;
  const nOver = r.rows.filter(x => x.status === "over").length;
  const nUnder = r.rows.filter(x => x.status === "under").length;
  const nExact = nTotal - nOver - nUnder;
  // 見積精度 = 見積/実績の比を 1.0 に近いほど高精度として平均（見積のあるタスクのみ対象）。100% に近いほど良い。
  const acc = estimateAccuracy(r.rows);

  const periodBtns = PERIODS.map(n =>
    `<button class="ea-seg-b${n === days ? " on" : ""}" data-period="${n}">${n}日</button>`).join("");
  const scaleBtns = Object.entries(SCALES).map(([v, label]) =>
    `<button class="ea-seg-b${v === scale ? " on" : ""}" data-scale="${v}">${esc(label)}</button>`).join("");

  root.innerHTML = `
    <h1 class="vtitle">見積り vs 実績</h1>
    <div class="ea-tools">
      <div class="ea-seg" id="ea-period" role="group" aria-label="集計期間"><span class="ea-seg-l">期間</span>${periodBtns}</div>
      <div class="ea-seg" id="ea-scale" role="group" aria-label="横軸スケール"><span class="ea-seg-l">横軸</span>${scaleBtns}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="l">対象タスク</div><div class="v">${nTotal}件 <span class="sub">(<span style="color:${C.over}">超過${nOver}</span> / <span style="color:${C.free}">過小${nUnder}</span> / <span style="color:${C.amber}">一致${nExact}</span>)</span></div></div>
      <div class="kpi"><div class="l">見積精度</div><div class="v">${acc == null ? "—" : acc + "%"}</div></div>
      <div class="kpi"><div class="l">見積り合計</div><div class="v">${fmtH(r.totEst)}</div></div>
      <div class="kpi"><div class="l">実績合計</div><div class="v">${fmtH(r.totAct)}</div></div>
      <div class="kpi ${overall>0?"over":overall<0?"under":""}"><div class="l">全体差分</div><div class="v">${overall==null?"—":(overall>=0?"+":"")+overall+"%"}</div></div>
    </div>
    <div class="card">${r.rows.length ? r.rows.map(x => rowHtml(x, maxH, scale)).join("") : empty()}</div>
    <div class="legend"><span><i style="background:${C.full}"></i>見積り</span><span><i style="background:${C.over}"></i>超過</span><span><i style="background:${C.amber}"></i>一致</span><span><i style="background:${C.free}"></i>過小</span>${scale === "row" ? `<span class="ea-base-leg"><i class="ea-base-i"></i>見積100%基準線（行内）</span>` : ""}</span></div>
    <style>${css()}</style>`;

  // 期間切替（B70）: localStorage 永続 → 再描画。
  root.querySelectorAll("#ea-period [data-period]").forEach((b) => {
    b.onclick = () => { try { localStorage.setItem(PERIOD_KEY, b.dataset.period); } catch {} render(root); };
  });
  // 横軸スケール切替（B71）: localStorage 永続 → 再描画。
  root.querySelectorAll("#ea-scale [data-scale]").forEach((b) => {
    b.onclick = () => { try { localStorage.setItem(SCALE_KEY, b.dataset.scale); } catch {} render(root); };
  });

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

// scale="global": 全行共通の maxH を基準。
// scale="row": この行の max(estH,actH) を基準（行ごとに横幅いっぱいへ拡大）＋見積100%基準線を表示。
//   ＝行内では各バーが相対的に比較しやすく、見積線を超えた分が「超過」として一目で分かる。
function rowHtml(x, maxH, scale) {
  const diffTxt = x.diff == null ? "実績のみ" : (x.diff >= 0 ? "+" : "") + Math.round(x.diff * 100) + "%";
  const cls = statusColor(x);
  const actColor = statusColor(x);   // 群A維持: status 基準の色
  // 行内モードの基準＝その行の max(estH,actH)。0 のときは 1（ゼロ割回避）。
  const denom = scale === "row" ? Math.max(x.estH, x.actH, 1) : maxH;
  // 行内モードかつ見積>0 のとき、見積位置に 100% 基準線を引く（実績バー上の参照線）。
  const baseLeft = (scale === "row" && x.estH > 0) ? (x.estH / denom * 100) : null;
  const baseLine = baseLeft == null ? "" :
    `<div class="ea-base" style="left:${baseLeft}%" title="見積100%（基準線）"></div>`;
  const bar = (val, color, withBase) => `<div class="ea-track" style="flex:1;height:14px;background:${C.track};border-radius:5px;overflow:hidden;position:relative"><div style="height:100%;width:${val / denom * 100}%;background:${color};border-radius:5px"></div>${withBase ? baseLine : ""}</div>`;
  return `<div class="ea-row" data-id="${x.id}" title="クリックで編集" style="padding:13px 16px;border-bottom:1px solid ${C.line};cursor:pointer;transition:background .12s">
    <div style="display:flex;justify-content:space-between;margin-bottom:7px"><b style="font-size:14px">${esc(x.title)}</b>
      <span style="font-weight:700;color:${cls}">${diffTxt} <span style="color:${C.muted};font-weight:400">${fmtH(x.estH)} → ${fmtH(x.actH)}</span></span></div>
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:40px;font-size:10.5px;color:${C.muted};text-align:right">見積</span>${bar(x.estH, C.full, false)}<span style="width:42px;font-size:11.5px;font-weight:600">${fmtH(x.estH)}</span></div>
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:40px;font-size:10.5px;color:${C.muted};text-align:right">実績</span>${bar(x.actH, actColor, true)}<span style="width:42px;font-size:11.5px;font-weight:600">${fmtH(x.actH)}</span></div>
  </div>`;
}
const empty = () => `<div style="padding:34px;text-align:center;color:${C.muted}">見積り/実績のあるタスクがありません。タスクに見積り時間を設定し、実績を記録してください。</div>`;

function css() {
  return `
  .kpi .v .sub{font-size:12px;font-weight:600}
  .ea-tools{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:2px 0 16px}
  .ea-seg{display:inline-flex;align-items:center;gap:2px;background:${C.track};border:1px solid ${C.line};border-radius:9px;padding:3px}
  .ea-seg-l{font-size:11.5px;color:${C.muted};font-weight:600;padding:0 8px 0 6px}
  .ea-seg-b{font:inherit;font-size:12.5px;font-weight:600;color:${C.muted};background:transparent;border:0;border-radius:7px;padding:5px 12px;cursor:pointer;transition:background .12s,color .12s}
  .ea-seg-b:hover{color:${C.ink}}
  .ea-seg-b.on{background:${C.card};color:${C.fill};box-shadow:0 1px 2px rgba(20,30,50,.1)}
  /* B71 行内モードの見積100%基準線（実績バー上の参照線） */
  .ea-base{position:absolute;top:-2px;bottom:-2px;width:0;border-left:2px dashed ${C.muted};pointer-events:none;z-index:1}
  .ea-base-leg{display:inline-flex;align-items:center;gap:5px}
  .ea-base-i{display:inline-block;width:0;height:12px;border-left:2px dashed ${C.muted}}
  `;
}
