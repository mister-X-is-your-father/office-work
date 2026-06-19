// 週プランナー（フェーズ2: 日別の予定×実績）。task_time_plans を読み書き。
import { load, invalidate } from "../lib/store.js";
import * as vik from "../lib/api.js";
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
  // 多担当=全員にフル（按分しない・#4）。対象者(user_id)が信頼できればその1人にフル。
  const attribute = (t, entry, dateKey, sink) => {
    const aids = (t.assignees || []).map(a => a.id);
    const day = dateOnly(entry[dateKey]); if (!day) return;
    const h = toH(entry.seconds), uid = entry.user_id;
    if (uid && (aids.length === 0 || aids.includes(uid))) sink.push({ memberId: uid, day, h });
    else for (const aid of aids) sink.push({ memberId: aid, day, h });
  };
  for (const [t, plans] of plansArr) for (const p of plans || []) attribute(t, p, "plan_date", plannedEntries);
  for (const [t, times] of timesArr) for (const e of times || []) attribute(t, e, "logged_on", actualEntries);
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

  // 予定追加フォーム（担当のあるタスク）。#3: 対象者(user_id)を明示して予定を帰属させる。
  const memById = new Map(members.map(m => [m.id, m]));
  // タスクの人間担当 id（AI/不明は members から除外済みなので memById で絞る）
  const humanAssignees = (t) => (t.assignees || []).map(a => a.id).filter(id => memById.has(id));
  const assigned = tasks.filter(t => humanAssignees(t).length && !t.done);
  const taskOpts = assigned.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
  const dayOpts = days.map((d, i) => `<option value="${d}">${DOW[i]} ${d.slice(5)}</option>`).join("");
  // 対象者オプション（選択タスクの担当者に追従。初期=先頭タスクの担当）
  const memOptsFor = (t) => humanAssignees(t).map((id, i) => {
    const m = memById.get(id);
    return `<option value="${id}"${i === 0 ? " selected" : ""}>${esc(m.name || m.username)}</option>`;
  }).join("");

  root.innerHTML = `
    <h1 class="vtitle">週プランナー <small>${days[0].slice(5)}〜${days[4].slice(5)} ・ 予定×実績</small></h1>
    <div class="card" style="padding:6px 12px 12px;margin-bottom:14px">
      <div class="ptable-scroll" style="overflow-x:auto;-webkit-overflow-scrolling:touch">
        <table class="ptable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      </div>
    </div>
    <div class="card" style="padding:14px 16px">
      <div style="font-weight:700;font-size:13px;margin-bottom:10px">予定を追加（何日に何を何時間）</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="pl-task" style="flex:1 1 200px;min-width:160px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px">${taskOpts}</select>
        <select id="pl-mem" title="この予定を誰の容量に乗せるか" style="padding:7px 9px;border:1px solid ${C.line};border-radius:8px">${assigned[0] ? memOptsFor(assigned[0]) : ""}</select>
        <select id="pl-day" style="padding:7px 9px;border:1px solid ${C.line};border-radius:8px">${dayOpts}</select>
        <input id="pl-h" type="number" min="0.5" step="0.5" value="2" style="width:72px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px"> h
        <button id="pl-add" style="border:0;background:${C.fill};color:#fff;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer">追加</button>
        <span id="pl-msg" style="font-size:12px;color:${C.muted}"></span>
      </div>
    </div>
    <div style="font-size:11.5px;color:${C.muted};margin-top:10px">「予」=予定（task_time_plans）／「実」=実績（task_time_entries）。予定が容量8hを超える日は赤。</div>
    <style>.ptable-scroll{margin:0 -6px}.ptable{width:100%;min-width:560px;border-collapse:collapse;font-size:13px}.ptable th{font-size:11px;color:${C.muted};font-weight:600;padding:8px 6px;border-bottom:1px solid ${C.line};white-space:nowrap}.ptable td{padding:8px 6px;border-bottom:1px solid ${C.line};font-variant-numeric:tabular-nums}</style>`;

  // タスクを変えたら対象者セレクタをそのタスクの担当者に追従
  const taskSel = root.querySelector("#pl-task");
  const memSel = root.querySelector("#pl-mem");
  taskSel.onchange = () => {
    const t = assigned.find(x => x.id === +taskSel.value);
    memSel.innerHTML = t ? memOptsFor(t) : "";
  };

  const addBtn = root.querySelector("#pl-add"); addBtn.onclick = async () => {
    const tid = +taskSel.value;
    const uid = +memSel.value || null; // #3: 対象者を user_id として帰属
    const day = root.querySelector("#pl-day").value;
    const h = parseFloat(root.querySelector("#pl-h").value);
    const msg = root.querySelector("#pl-msg");
    if (!tid || !day || !(h > 0)) { msg.textContent = "入力を確認"; return; }
    msg.textContent = "保存中…";
    addBtn.disabled = true;
    try {
      await vik.logPlan(tid, Math.round(h * 3600), day, "", uid);
      invalidate();
      await render(root); // 再描画で反映
    } catch (e) { msg.textContent = "× " + e.message; addBtn.disabled = false; }
  };
}
