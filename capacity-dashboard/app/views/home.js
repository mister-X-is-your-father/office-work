// 総合ホーム（実データ）。上:KPI / 中:稼働予定｜稼働プラン / 下:月間ガント。
import { load } from "../lib/store.js";
import { loadByMember, estimateVsActual, triage } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { C, fmtH, todayISO } from "../lib/ui.js";
import * as today from "./today.js";
import * as workplan from "./workplan.js";
import * as gantt from "./gantt.js";

export async function render(root) {
  const { tasks, members, plansByTask, holidaysSet, unavailabilityByMember, settings } = await load();
  const day = todayISO();
  // 営業日割り＋人別容量（週末/祝日/休暇=0）で今日KPIを正確に（§土日祝ギャップ）
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH });
  const rows = loadByMember(tasks, members, day, settings.capH, plansByTask, { holidays: holidaysSet, capacityFor });
  const ev = estimateVsActual(tasks);
  const tri = triage(tasks, day);

  const totCap = rows.reduce((s, r) => s + r.capH, 0), totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const over = rows.filter(r => r.status === "over");
  const must = tri.filter(t => t.cls === "must");

  const cardHead = (t) => `<div style="padding:10px 16px;font-weight:700;font-size:13px;border-bottom:1px solid ${C.line}">${t}</div>`;

  root.innerHTML = `
    <h1 class="vtitle">ホーム <small>${day}</small></h1>
    <div class="kpis">
      <div class="kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></div>
      <div class="kpi free"><div class="l">空き工数</div><div class="v">${fmtH(Math.max(0, totCap - totAsg))}</div></div>
      <div class="kpi ${over.length ? "over" : ""}"><div class="l">過負荷</div><div class="v">${over.length}<small>名</small></div></div>
      <div class="kpi"><div class="l">今日必須</div><div class="v">${must.length}<small>件</small></div></div>
    </div>
    <div class="home-mid" style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;align-items:start">
      <div class="card" style="padding:6px 0">
        ${cardHead("今日の稼働予定")}
        <div class="home-today" style="padding:8px 16px"></div>
      </div>
      <div class="card" style="padding:6px 0">
        ${cardHead("稼働プラン（1ヶ月）")}
        <div class="home-plan" style="padding:8px 16px"></div>
      </div>
    </div>
    <div class="card" style="padding:6px 0;margin-top:16px">
      ${cardHead("月間ガント（人別レーン）")}
      <div class="home-gantt" style="padding:8px 16px"></div>
    </div>
    <style>@media (max-width:900px){.home-mid{grid-template-columns:1fr!important}}</style>`;

  // 各埋め込みは load() の共有キャッシュ経由（二重 fetch なし）。
  await today.renderInto(root.querySelector(".home-today"), { compact: true, showToggle: false, mode: "stacked", title: false });
  await workplan.renderInto(root.querySelector(".home-plan"), { preset: "1m", who: "all" });
  // ガントは teardown を返す。app.js が route ごとに content.innerHTML を差し替える＝
  // 子要素入替を検知して自動 teardown されるので、ここでは取得のみ（多重生成しない）。
  const _teardown = await gantt.renderInto(root.querySelector(".home-gantt"), { months: 1, mode: "member" });
  void _teardown;
}
