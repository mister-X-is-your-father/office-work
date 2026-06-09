// 週プランナー（フェーズ2: 日別の予定×実績）。task_time_plans を読み書き。
import { load, invalidate } from "../lib/store.js";
import * as vik from "../lib/vikunja.js";
import { sumByMemberDay, toH, dateOnly } from "../lib/capacity.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";

const DOW = ["月", "火", "水", "木", "金"];
function weekDates(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
  return [0, 1, 2, 3, 4].map(i => { const x = new Date(mon); x.setUTCDate(mon.getUTCDate() + i); return x.toISOString().slice(0, 10); });
}

export async function render(root) {
  const { tasks, members } = await load();
  const today = todayISO();
  const days = weekDates(today);

  // 予定/実績エントリを収集（タスクの担当者に按分して帰属）
  const plannedTasks = tasks.filter(t => (t.time_planned || 0) > 0);
  const actualTasks = tasks.filter(t => (t.time_spent || 0) > 0 && (t.assignees || []).length);
  const [plansArr, timesArr] = await Promise.all([
    Promise.all(plannedTasks.map(t => vik.getPlans(t.id).then(p => [t, p]).catch(() => [t, []]))),
    Promise.all(actualTasks.map(t => vik.getTimes(t.id).then(p => [t, p]).catch(() => [t, []]))),
  ]);
  const plannedEntries = [], actualEntries = [];
  for (const [t, plans] of plansArr) {
    const aids = (t.assignees || []).map(a => a.id); if (!aids.length) continue;
    for (const p of plans || []) for (const aid of aids)
      plannedEntries.push({ memberId: aid, day: dateOnly(p.plan_date), h: toH(p.seconds) / aids.length });
  }
  for (const [t, times] of timesArr) {
    const aids = (t.assignees || []).map(a => a.id); if (!aids.length) continue;
    for (const e of times || []) for (const aid of aids)
      actualEntries.push({ memberId: aid, day: dateOnly(e.logged_on), h: toH(e.seconds) / aids.length });
  }
  const planned = sumByMemberDay(plannedEntries);
  const actual = sumByMemberDay(actualEntries);

  const head = `<th style="text-align:left">メンバー</th>` +
    days.map((d, i) => `<th style="${d === today ? "color:" + C.fill : ""}">${DOW[i]}<div style="font-size:10px;color:${C.muted}">${d.slice(5)}</div></th>`).join("") + `<th>週計(予定)</th>`;
  const body = members.length ? members.map(m => {
    let wk = 0;
    const cells = days.map(d => {
      const pl = (planned[m.id] || {})[d] || 0; const ac = (actual[m.id] || {})[d] || 0; wk += pl;
      const col = pl > 8 ? C.over : pl > 0 ? C.ink : C.muted;
      return `<td style="text-align:center">
        <div style="font-weight:${pl > 0 ? 700 : 400};color:${col}">${pl ? "予" + fmtH(pl) : "·"}</div>
        ${ac > 0 ? `<div style="font-size:10.5px;color:${C.free}">実${fmtH(ac)}</div>` : ""}</td>`;
    }).join("");
    return `<tr><td style="font-weight:600">${esc(m.name)}<div style="font-size:10px;color:${C.muted}">8h/日</div></td>${cells}<td style="text-align:center;font-weight:700">${fmtH(wk)}</td></tr>`;
  }).join("") : `<tr><td colspan="7" style="padding:30px;text-align:center;color:${C.muted}">メンバーがいません。</td></tr>`;

  // 予定追加フォーム（担当のあるタスク）
  const assigned = tasks.filter(t => (t.assignees || []).length && !t.done);
  const taskOpts = assigned.map(t => `<option value="${t.id}">${esc(t.title)}（${esc((t.assignees[0] || {}).username || "")}）</option>`).join("");
  const dayOpts = days.map((d, i) => `<option value="${d}">${DOW[i]} ${d.slice(5)}</option>`).join("");

  root.innerHTML = `
    <h1 class="vtitle">週プランナー <small>${days[0].slice(5)}〜${days[4].slice(5)} ・ 予定×実績</small></h1>
    <div class="card" style="padding:6px 12px 12px;margin-bottom:14px">
      <table class="ptable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>
    <div class="card" style="padding:14px 16px">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px">予定を追加（何日に何を何時間）</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="pl-task" style="flex:1;min-width:200px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px">${taskOpts}</select>
        <select id="pl-day" style="padding:7px 9px;border:1px solid ${C.line};border-radius:8px">${dayOpts}</select>
        <input id="pl-h" type="number" min="0.5" step="0.5" value="2" style="width:72px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px"> h
        <button id="pl-add" style="border:0;background:${C.fill};color:#fff;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer">追加</button>
        <span id="pl-msg" style="font-size:12px;color:${C.muted}"></span>
      </div>
    </div>
    <div style="font-size:11.5px;color:${C.muted};margin-top:10px">「予」=予定（task_time_plans）／「実」=実績（task_time_entries）。予定が容量8hを超える日は赤。</div>
    <style>.ptable{width:100%;border-collapse:collapse;font-size:13px}.ptable th{font-size:11px;color:${C.muted};font-weight:600;padding:8px 6px;border-bottom:1px solid ${C.line}}.ptable td{padding:8px 6px;border-bottom:1px solid ${C.line};font-variant-numeric:tabular-nums}</style>`;

  root.querySelector("#pl-add").onclick = async () => {
    const tid = +root.querySelector("#pl-task").value;
    const day = root.querySelector("#pl-day").value;
    const h = parseFloat(root.querySelector("#pl-h").value);
    const msg = root.querySelector("#pl-msg");
    if (!tid || !day || !(h > 0)) { msg.textContent = "入力を確認"; return; }
    msg.textContent = "保存中…";
    try {
      await vik.logPlan(tid, Math.round(h * 3600), day);
      invalidate();
      await render(root); // 再描画で反映
    } catch (e) { msg.textContent = "× " + e.message; }
  };
}
