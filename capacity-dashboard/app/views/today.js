// 今日の空き容量さがし（mock 54 相当・実データ）
import { load } from "../lib/store.js";
import { loadByMember } from "../lib/capacity.js";
import { C, fmtH, esc, capacityBar, todayISO } from "../lib/ui.js";

export async function render(root) {
  const { tasks, members } = await load();
  const day = todayISO();
  const rows = loadByMember(tasks, members, day, 8).sort((a, b) => b.freeH - a.freeH);
  const totCap = rows.reduce((s, r) => s + r.capH, 0);
  const totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const free = Math.max(0, totCap - totAsg);

  root.innerHTML = `
    <h1 class="vtitle">今日の空き容量さがし <small>${day}</small></h1>
    <div class="kpis">
      <div class="kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></div>
      <div class="kpi free"><div class="l">振れる空き</div><div class="v">${fmtH(free)}</div></div>
      <div class="kpi"><div class="l">メンバー</div><div class="v">${rows.length}</div></div>
    </div>
    <div class="card">${rows.length ? rows.map(rowHtml).join("") : empty()}</div>`;
}

function rowHtml(r) {
  const status = r.status === "over" ? `<span style="color:${C.over};font-weight:700">超過 +${fmtH(r.overH)}</span>`
    : r.status === "full" ? `<span style="color:${C.full};font-weight:700">満稼働</span>`
    : `<span style="color:${C.free};font-weight:700">空き ${fmtH(r.freeH)}</span>`;
  const tip = r.tasks.length ? r.tasks.map(t => `${esc(t.title)} ${fmtH(t.h)}`).join(" / ") : "今日のアサインなし";
  return `<div title="${esc(tip)}" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid ${C.line}">
    <div style="width:130px;flex:none"><div style="font-weight:600">${esc(r.name)}</div><div style="font-size:11px;color:${C.muted}">容量 ${r.capH}h/日</div></div>
    <div style="flex:1">${capacityBar(r.assignedH, r.capH)}</div>
    <div style="width:150px;flex:none;text-align:right"><div style="font-weight:700;font-variant-numeric:tabular-nums">${fmtH(r.assignedH)} / ${r.capH}h</div><div style="font-size:11.5px">${status}</div></div>
  </div>`;
}
const empty = () => `<div style="padding:34px;text-align:center;color:${C.muted}">今日アクティブな担当タスク（期日が今日 or 期間に今日を含む＋見積りあり）がありません。<br>タスクに担当・期日・見積り時間を設定してください。</div>`;
