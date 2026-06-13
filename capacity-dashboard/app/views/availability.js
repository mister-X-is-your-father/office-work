// 残容量カード（mock04 相当・実データ）。本日のメンバー別 残り容量を大きく表示。
import { load } from "../lib/store.js";
import { loadByMember } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";

let CAP = 8; // 設定（容量 h/日）で上書き

export async function render(root) {
  const { tasks, members, plansByTask, settings, holidaysSet, unavailabilityByMember } = await load();
  CAP = settings.capH;
  const day = todayISO();
  // 営業日割り＋人別容量（週末/祝日/休暇=0）で残容量を正確に（§土日祝ギャップ）
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: CAP });
  const rows = loadByMember(tasks, members, day, CAP, plansByTask, { holidays: holidaysSet, capacityFor })
    .sort((a, b) => b.freeH - a.freeH);

  const totFree = rows.reduce((s, r) => s + r.freeH, 0);
  const overN = rows.filter((r) => r.overH > 0).length;
  const freeN = rows.filter((r) => r.freeH > 0).length;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">残容量カード <small>${day} ・ 容量 ${CAP}h/人</small></h1>
    <div class="kpis">
      <div class="kpi free"><div class="l">空き工数（合計）</div><div class="v">${fmtH(totFree)}</div></div>
      <div class="kpi"><div class="l">受け入れ余力</div><div class="v">${freeN}<small>名</small></div></div>
      <div class="kpi ${overN ? "over" : ""}"><div class="l">超過</div><div class="v">${overN}<small>名</small></div></div>
    </div>
    <div class="av-grid">${rows.length ? rows.map(cardHtml).join("") : `<div class="av-empty">本日のメンバー負荷がありません。</div>`}</div>`;
}

function cardHtml(r, i) {
  const nm = r.name;
  const off = r.status === "off"; // 週末/祝日/休暇＝容量0
  const over = r.overH > 0;
  const big = off ? "休" : (over ? `-${fmtH(r.overH)}` : (r.freeH > 0 ? `+${fmtH(r.freeH)}` : "±0h"));
  const bigcls = off ? "full" : (over ? "over" : (r.freeH > 0 ? "free" : "full"));
  const ratio = r.capH > 0 ? Math.min(100, Math.round((r.assignedH / r.capH) * 100)) : 0;
  const overRatio = over && r.capH > 0 ? Math.min(100, Math.round((r.overH / r.capH) * 100)) : 0;
  const tasks = (r.tasks || []).sort((a, b) => b.h - a.h).map((t) =>
    `<div class="av-t"><span class="av-tn">${esc(t.title)}</span><span class="av-th">${fmtH(t.h)}</span></div>`).join("")
    || `<div class="av-none">本日のアサインなし</div>`;
  const badge = off ? `<span class="av-badge full">非稼働日</span>`
    : (over ? `<span class="av-badge over">超過</span>` : (r.freeH > 0 ? `<span class="av-badge free">余裕</span>` : `<span class="av-badge full">満</span>`));
  return `<div class="av-card ${over ? "is-over" : ""}">
    <div class="av-h"><span class="av-ava" style="background:${member_color(r.id)}">${esc((nm[0] || "?"))}</span><span class="av-nm">${esc(nm)}</span>
      ${badge}</div>
    <div class="av-big ${bigcls}">${big}</div>
    <div class="av-sub">${off ? "非稼働日（週末/祝日/休暇）" : `${fmtH(r.assignedH)} / ${r.capH}h`}</div>
    <div class="av-bar"><i style="width:${ratio}%;background:${over ? C.over : C.fill}"></i>${over ? `<b style="width:${overRatio}%"></b>` : ""}</div>
    <div class="av-list">${tasks}</div>
  </div>`;
}

function css() {
  return `
  .av-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
  .av-card{background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:16px;box-shadow:0 1px 3px rgba(20,30,50,.05)}
  .av-card.is-over{border-color:#f3c9cb;background:#fffafa}
  .av-h{display:flex;align-items:center;gap:9px;margin-bottom:10px}
  .av-ava{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:700;flex:none}
  .av-nm{font-size:15px;font-weight:600}
  .av-badge{margin-left:auto;font-size:11px;font-weight:600;border-radius:999px;padding:3px 9px}
  .av-badge.free{color:${C.free};background:#eaf7ef}.av-badge.over{color:${C.over};background:#fdecec}.av-badge.full{color:${C.full};background:#f0f1f4}
  .av-big{font-size:34px;font-weight:800;line-height:1.1;letter-spacing:-.01em}
  .av-big.free{color:${C.free}}.av-big.over{color:${C.over}}.av-big.full{color:${C.full}}
  .av-sub{font-size:12px;color:${C.muted};margin-top:2px;font-variant-numeric:tabular-nums}
  .av-bar{position:relative;height:8px;border-radius:6px;background:${C.track};overflow:hidden;margin:10px 0 12px;display:flex}
  .av-bar i{display:block;height:100%}
  .av-bar b{display:block;height:100%;background:repeating-linear-gradient(45deg,${C.over} 0 4px,#fff5 4px 7px)}
  .av-list{border-top:1px solid ${C.line};padding-top:8px}
  .av-t{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:2.5px 0}
  .av-tn{color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .av-th{color:${C.muted};font-variant-numeric:tabular-nums;flex:none}
  .av-none{font-size:12px;color:${C.muted};padding:4px 0}
  .av-empty{color:${C.muted};padding:30px;text-align:center}`;
}
