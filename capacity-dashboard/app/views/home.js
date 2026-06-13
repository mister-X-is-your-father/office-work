// 総合ホーム（mock 27 相当・実データ。今日の空き＋アラート）
import { load } from "../lib/store.js";
import { loadByMember, estimateVsActual, triage } from "../lib/capacity.js";
import { holidayDataStatus, capacityOn } from "../lib/recurrence.js";
import { C, fmtH, esc, capacityBar, todayISO } from "../lib/ui.js";

export async function render(root) {
  const { tasks, members, plansByTask, holidaysSet, unavailabilityByMember, settings } = await load();
  const day = todayISO();
  // 営業日割り＋人別容量（週末/祝日/休暇=0）で今日KPIを正確に（§土日祝ギャップ）
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH });
  const rows = loadByMember(tasks, members, day, settings.capH, plansByTask, { holidays: holidaysSet, capacityFor }).sort((a, b) => b.freeH - a.freeH);
  const ev = estimateVsActual(tasks);
  const tri = triage(tasks, day);

  const totCap = rows.reduce((s, r) => s + r.capH, 0), totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const over = rows.filter(r => r.status === "over");
  const free = rows.filter(r => r.status === "free");
  const must = tri.filter(t => t.cls === "must");

  const alerts = [];
  over.forEach(r => alerts.push([C.over, `${esc(r.name)} が過負荷（+${fmtH(r.overH)}）`]));
  must.slice(0, 4).forEach(t => alerts.push([C.amber, `今日必須: ${esc(t.title)}`]));
  if (ev.totEst && ev.ratio > 1.1) alerts.push([C.over, `見積り超過 全体 +${Math.round((ev.ratio - 1) * 100)}%`]);
  // 祝日カレンダーの鮮度（同期ジョブ taskstation-holiday-sync が止まると stale になる）
  const hs = holidayDataStatus(holidaysSet, day);
  if (hs.stale) alerts.push([C.amber, hs.latest
    ? `祝日カレンダーが更新されていません（登録は ${esc(hs.latest)} まで）。同期ジョブ taskstation-holiday-sync を確認してください`
    : "祝日カレンダーが未登録です。同期ジョブ taskstation-holiday-sync を実行してください"]);
  if (!alerts.length) alerts.push([C.free, "過負荷・必須タスクはありません。"]);

  root.innerHTML = `
    <h1 class="vtitle">ホーム <small>${day}</small></h1>
    <div class="kpis">
      <div class="kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></div>
      <div class="kpi free"><div class="l">空き工数</div><div class="v">${fmtH(Math.max(0, totCap - totAsg))}</div></div>
      <div class="kpi ${over.length ? "over" : ""}"><div class="l">過負荷</div><div class="v">${over.length}<small>名</small></div></div>
      <div class="kpi"><div class="l">今日必須</div><div class="v">${must.length}<small>件</small></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start">
      <div class="card" style="padding:6px 0">
        <div style="padding:10px 16px;font-weight:700;font-size:13px;border-bottom:1px solid ${C.line}">今日の稼働予定 <span style="color:${C.muted};font-weight:400">→ 稼働予定</span></div>
        ${rows.slice(0, 6).map(r => `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px">
          <div style="width:90px;font-weight:600;font-size:13px">${esc(r.name)}</div>
          <div style="flex:1">${capacityBar(r.assignedH, r.capH)}</div>
          <div style="width:96px;text-align:right;font-size:12px;font-weight:600;color:${r.status === "over" ? C.over : r.status === "free" ? C.free : r.status === "off" ? C.muted : C.full}">${r.status === "over" ? "+" + fmtH(r.overH) : r.status === "free" ? "空き" + fmtH(r.freeH) : r.status === "off" ? "休" : "満"}</div>
        </div>`).join("") || `<div style="padding:24px;text-align:center;color:${C.muted}">データなし</div>`}
      </div>
      <div class="card" style="padding:6px 0">
        <div style="padding:10px 16px;font-weight:700;font-size:13px;border-bottom:1px solid ${C.line}">アラート</div>
        ${alerts.map(([c, t]) => `<div style="display:flex;gap:9px;padding:9px 16px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:${c};flex:none"></span><span style="font-size:12.5px">${t}</span></div>`).join("")}
      </div>
    </div>`;
}
