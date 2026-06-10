// 週・日別 積み上げ（mock33 相当・実データ）。週×日のメンバー積み上げ／合算をトグル。
import { load } from "../lib/store.js";
import { weekLoadByMember, shiftISO } from "../lib/capacity.js";
import { C, fmtH, esc, member_color } from "../lib/ui.js";

const CAP = 8;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
let MODE = "member"; // 'member'(担当者別積み) | 'total'(合算)

function weekDays() {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const monday = shiftISO(today, dow === 0 ? -6 : 1 - dow);
  return [0, 1, 2, 3, 4].map((i) => shiftISO(monday, i));
}

export async function render(root) {
  const { tasks, members, plansByTask } = await load();
  const isoDays = weekDays();
  const perMember = weekLoadByMember(tasks, members, isoDays, CAP, plansByTask); // [{id,name,days:[{day,h,over}]}]
  const idx = new Map(members.map((m, i) => [m.id, i]));

  // 日 → [{member, h}] へ転置
  const byDay = isoDays.map((day, di) => {
    const segs = perMember.map((m) => ({ id: m.id, name: m.name, h: m.days[di].h }))
      .filter((s) => s.h > 0).sort((a, b) => b.h - a.h);
    const total = segs.reduce((s, x) => s + x.h, 0);
    return { day, di, segs, total };
  });

  const capLine = members.length * CAP;
  const maxTotal = byDay.reduce((m, d) => Math.max(m, d.total), 0);
  const yMax = Math.max(Math.ceil(capLine * 1.1), Math.ceil(maxTotal) + 2);
  const H = 300, pxPerH = H / yMax;

  // Y目盛り
  const step = yMax > 40 ? 16 : 8;
  let ticks = "";
  for (let h = 0; h <= yMax - step / 2; h += step) ticks += `<div class="ws-tick" style="bottom:${h * pxPerH}px">${h}h</div>`;
  const capBottom = capLine * pxPerH;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">週・日別の負荷 <small>${isoDays[0].slice(5)}〜${isoDays[4].slice(5)} ・ 容量 ${capLine}h/日</small></h1>
    <div class="ws-seg">
      <button data-m="member" class="${MODE === "member" ? "on" : ""}">担当者別</button>
      <button data-m="total" class="${MODE === "total" ? "on" : ""}">合算</button>
    </div>
    <div class="card ws-card">
      <div class="ws-chart" style="height:${H + 40}px">
        <div class="ws-yaxis" style="height:${H}px">${ticks}</div>
        <div class="ws-cap" style="bottom:${capBottom + 40}px"><span>容量 ${capLine}h</span></div>
        <div class="ws-cols" style="height:${H}px">${byDay.map((d) => colHtml(d, isoDays, pxPerH, idx)).join("")}</div>
      </div>
    </div>
    <div class="ws-legend">${MODE === "member" ? members.map((m, i) => `<span class="it"><i style="background:${member_color(i)}"></i>${esc(m.name || m.username)}</span>`).join("") : `<span class="it"><i style="background:${C.fill}"></i>合計負荷</span>`}<span class="it"><span class="rule"></span>容量線</span></div>`;

  root.querySelectorAll(".ws-seg button").forEach((b) => { b.onclick = () => { MODE = b.dataset.m; render(root); }; });
}

function colHtml(d, isoDays, pxPerH, idx) {
  const dow = WD[new Date(d.day + "T00:00:00Z").getUTCDay()];
  const over = d.total > 0 && d.total > (idx.size * CAP);
  let stack = "";
  if (MODE === "member") {
    stack = d.segs.map((s) => `<div class="ws-seg-i" style="height:${s.h * pxPerH}px;background:${member_color(idx.get(s.id) ?? 0)}" title="${esc(s.name)} ${fmtH(s.h)}"><span>${s.h >= 1 ? fmtH(s.h) : ""}</span></div>`).join("");
  } else {
    stack = `<div class="ws-seg-i total" style="height:${d.total * pxPerH}px;background:${C.fill}"><span>${d.total > 0 ? fmtH(d.total) : ""}</span></div>`;
  }
  return `<div class="ws-col">
    <div class="ws-bar">${stack}</div>
    <div class="ws-foot"><div class="ws-dow">${d.day.slice(5).replace("-", "/")}<small>(${dow})</small></div><div class="ws-tot ${over ? "over" : ""}">${fmtH(d.total)}</div></div>
  </div>`;
}

function css() {
  return `
  .ws-seg{display:inline-flex;background:#fff;border:1px solid ${C.line};border-radius:10px;padding:3px;margin-bottom:14px;box-shadow:0 1px 2px rgba(20,30,50,.04)}
  .ws-seg button{border:0;background:transparent;color:${C.muted};font:inherit;font-size:13px;font-weight:600;padding:5px 14px;border-radius:8px;cursor:pointer}
  .ws-seg button.on{background:${C.fill};color:#fff}
  .ws-card{padding:18px 20px 14px}
  .ws-chart{position:relative;padding-left:34px}
  .ws-yaxis{position:absolute;left:0;bottom:40px;width:34px}
  .ws-tick{position:absolute;right:6px;font-size:10px;color:${C.muted};transform:translateY(50%)}
  .ws-cap{position:absolute;left:34px;right:0;border-top:2px dashed ${C.capline};z-index:3;pointer-events:none}
  .ws-cap span{position:absolute;right:0;top:-9px;font-size:10px;color:${C.muted};background:#fff;padding:0 5px;border:1px solid ${C.line};border-radius:10px}
  .ws-cols{display:flex;gap:14px;align-items:flex-end}
  .ws-col{flex:1;display:flex;flex-direction:column;align-items:center}
  .ws-bar{width:100%;max-width:70px;display:flex;flex-direction:column-reverse;border-radius:7px 7px 0 0;overflow:hidden}
  .ws-seg-i{display:flex;align-items:center;justify-content:center;color:#fff;font-size:10.5px;font-weight:600;border-bottom:1px solid #fff;min-height:2px}
  .ws-seg-i span{text-shadow:0 1px 1px rgba(0,0,0,.15)}
  .ws-foot{margin-top:8px;text-align:center}
  .ws-dow{font-size:12px;font-weight:600}.ws-dow small{color:${C.muted};font-weight:400;margin-left:2px}
  .ws-tot{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;margin-top:1px}.ws-tot.over{color:${C.over};font-weight:700}
  .ws-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:${C.muted}}
  .ws-legend .it{display:inline-flex;align-items:center;gap:6px}
  .ws-legend .it i{width:11px;height:11px;border-radius:3px;display:inline-block}
  .ws-legend .rule{width:18px;border-top:2px dashed ${C.capline};display:inline-block}`;
}
