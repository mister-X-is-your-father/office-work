// 週プランナー（フェーズ2: 日別の予定×実績）。task_time_plans を読み書き。
// B13: 既存予定をセルに表示→クリックでポップオーバー一覧（削除/時間編集）。
// B14: 容量は capacityOn ベース（週末/祝日/休暇=0・休暇日は薄塗り＋「休」）。
// B15: 週ナビ（前週/翌週/今日）。基準ISO=今日+offset週。
// B16: store.plansByTask を流用（重複fetch廃止）。追加成功時は invalidate→再描画で局所反映。
import { load, invalidate } from "../lib/store.js";
import * as vik from "../lib/api.js";
import { sumByMemberDay, toMemberDayEntries, toH, dateOnly } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";

const DOW = ["月", "火", "水", "木", "金"];
let weekOffset = 0; // B15: 表示週オフセット（0=今週・前週=-1・翌週=+1）。セッション内で保持。

function weekDates(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
  return [0, 1, 2, 3, 4].map(i => { const x = new Date(mon); x.setUTCDate(mon.getUTCDate() + i); return x.toISOString().slice(0, 10); });
}

export async function render(root) {
  const { tasks, members, settings, holidaysSet, unavailabilityByMember, plansByTask } = await load();
  const capH = (settings && settings.capH) || 8;
  const today = todayISO();
  // B15: 基準＝今日に weekOffset 週を足した日。weekDates でその週の月〜金を得る。
  const baseISO = (() => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + weekOffset * 7); return d.toISOString().slice(0, 10); })();
  const days = weekDates(baseISO);

  // B16: 予定は store.plansByTask を流用（重複fetch廃止）。実績のみ N+1 で取得（store に無いため）。
  const actualTasks = tasks.filter(t => (t.time_spent || 0) > 0 && (t.assignees || []).length);
  const timesArr = await Promise.all(
    actualTasks.map(t => vik.getTimes(t.id).then(p => [t, p]).catch(() => [t, []]))
  );
  const actualEntries = toMemberDayEntries(timesArr, "actual");
  const plannedPairs = tasks.map((t) => [t, (plansByTask && (plansByTask.get ? plansByTask.get(t.id) : plansByTask[t.id])) || null]);
  const planned = sumByMemberDay(toMemberDayEntries(plannedPairs, "plan"));
  const actual = sumByMemberDay(actualEntries);

  // B14: 人別×日の容量（週末/祝日/休暇=0）。休暇/祝日/週末はセルを薄塗り＋容量0表示。
  const capFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH });

  // 表ヘッダに scope="col"（行頭のメンバー名セルは tbody 側で <th scope="row"> ではないが、列見出しの所属を明示）。
  const head = `<th scope="col" style="text-align:left">メンバー</th>` +
    days.map((d, i) => `<th scope="col" style="${d === today ? "color:" + C.fill : ""}">${DOW[i]}<div style="font-size:10px;color:${C.muted}">${d.slice(5)}</div></th>`).join("") + `<th scope="col">週計(予定)</th>`;
  const body = members.length ? members.map(m => {
    let wk = 0;
    const cells = days.map(d => {
      const pl = (planned[m.id] || {})[d] || 0; const ac = (actual[m.id] || {})[d] || 0; wk += pl;
      const cap = capFor(m, d);
      const off = cap <= 1e-6; // 容量0=休み（週末/祝日/休暇）
      // 文字色: 容量超過=赤 / 予定あり=インク / それ以外=淡色
      const col = (cap > 0 && pl > cap + 1e-6) ? C.over : pl > 0 ? C.ink : C.muted;
      const cls = `pl-cell${pl > 0 ? " has" : ""}${off ? " off" : ""}`;
      const restMark = off ? `<div class="pl-rest">休</div>` : "";
      return `<td class="${cls}" data-mid="${m.id}" data-day="${d}" data-h="${pl}">
        <div style="font-weight:${pl > 0 ? 700 : 400};color:${col}">${pl ? "予" + fmtH(pl) : (off ? "" : "·")}</div>
        ${ac > 0 ? `<div style="font-size:10.5px;color:${C.free}">実${fmtH(ac)}</div>` : ""}
        ${restMark}</td>`;
    }).join("");
    return `<tr><td style="font-weight:600">${esc(m.name)}<div style="font-size:10px;color:${C.muted}">${fmtH(capH)}/日</div></td>${cells}<td style="text-align:center;font-weight:700">${fmtH(wk)}</td></tr>`;
  }).join("") : `<tr><td colspan="7" style="padding:30px;text-align:center;color:${C.muted}">メンバーがいません。</td></tr>`;

  // 予定追加フォーム（担当のあるタスク）。#3: 対象者(user_id)を明示して予定を帰属させる。
  const memById = new Map(members.map(m => [m.id, m]));
  const humanAssignees = (t) => (t.assignees || []).map(a => a.id).filter(id => memById.has(id));
  const assigned = tasks.filter(t => humanAssignees(t).length && !t.done);
  const taskOpts = assigned.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
  const dayOpts = days.map((d, i) => `<option value="${d}">${DOW[i]} ${d.slice(5)}</option>`).join("");
  const memOptsFor = (t) => humanAssignees(t).map((id, i) => {
    const m = memById.get(id);
    return `<option value="${id}"${i === 0 ? " selected" : ""}>${esc(m.name || m.username)}</option>`;
  }).join("");

  // B15: 週ラベル（今週/前週/翌週 を補足）
  const weekTag = weekOffset === 0 ? "今週" : weekOffset === -1 ? "前週" : weekOffset === 1 ? "翌週" : (weekOffset > 0 ? `+${weekOffset}週` : `${weekOffset}週`);

  root.innerHTML = `
    <h1 class="vtitle">週プランナー <small>${days[0].slice(5)}〜${days[4].slice(5)} ・ ${weekTag} ・ 予定×実績</small></h1>
    <div class="card" style="padding:6px 12px 12px;margin-bottom:14px">
      <div class="pl-nav" style="display:flex;align-items:center;gap:8px;padding:6px 2px 8px">
        <button id="pl-prev" class="pl-navb" type="button">‹ 前週</button>
        <button id="pl-today" class="pl-navb${weekOffset === 0 ? " on" : ""}" type="button">今日</button>
        <button id="pl-next" class="pl-navb" type="button">翌週 ›</button>
        <span style="font-size:11.5px;color:${C.muted};margin-left:4px">${days[0].slice(0, 4)}/${days[0].slice(5)}〜${days[4].slice(5)}</span>
      </div>
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
    <div style="font-size:11.5px;color:${C.muted};margin-top:10px">「予」=予定（task_time_plans）／「実」=実績（task_time_entries）。容量(${fmtH(capH)}/日・週末/祝日/休暇=0)を超える日は赤。予定セルをクリックで内訳の削除/時間編集。</div>
    <style>${css()}</style>`;

  const taskSel = root.querySelector("#pl-task");
  const memSel = root.querySelector("#pl-mem");
  taskSel.onchange = () => {
    const t = assigned.find(x => x.id === +taskSel.value);
    memSel.innerHTML = t ? memOptsFor(t) : "";
  };

  // B15: 週ナビ
  root.querySelector("#pl-prev").onclick = () => { weekOffset -= 1; render(root); };
  root.querySelector("#pl-next").onclick = () => { weekOffset += 1; render(root); };
  root.querySelector("#pl-today").onclick = () => { weekOffset = 0; render(root); };

  // B13: 予定ありセルをクリック→そのメンバー×日の予定一覧ポップオーバー（削除/時間編集）。
  root.querySelectorAll(".pl-cell.has").forEach(cell => {
    cell.onclick = (ev) => {
      ev.stopPropagation();
      const mid = +cell.dataset.mid, day = cell.dataset.day;
      const already = root.querySelector(".pl-pop");
      closePopover(root);
      if (already && already.dataset.mid === String(mid) && already.dataset.day === day) return; // 同セルのトグルは閉じるだけ
      openPopover(root, cell, mid, day, tasks, plansByTask, memById);
    };
  });

  const addBtn = root.querySelector("#pl-add"); addBtn.onclick = async () => {
    const tid = +taskSel.value;
    const uid = +memSel.value || null; // #3: 対象者を user_id として帰属
    const day = root.querySelector("#pl-day").value;
    const h = parseFloat(root.querySelector("#pl-h").value);
    const msg = root.querySelector("#pl-msg");
    if (!tid || !day || !(h > 0)) { msg.textContent = "入力を確認"; return; }
    msg.textContent = "保存中…";
    addBtn.disabled = true; // 二重送信防止（維持）
    try {
      await vik.logPlan(tid, Math.round(h * 3600), day, "", uid);
      invalidate();
      await render(root); // B16: store 再取得（plansByTask 更新）→該当週を再描画で反映
    } catch (e) { msg.textContent = "× " + e.message; addBtn.disabled = false; }
  };
}

// B13: メンバー×日の予定一覧ポップオーバー。各予定: タスク名・対象者・時間編集(h)・削除。
function openPopover(root, anchor, memberId, day, tasks, plansByTask, memById) {
  // この (memberId, day) に乗っている予定を全タスク横断で集める（帰属ルールは表示集計と同じ）。
  const items = [];
  for (const t of tasks) {
    const plans = (plansByTask && (plansByTask.get ? plansByTask.get(t.id) : plansByTask[t.id])) || null;
    if (!plans || !plans.length) continue;
    const aids = (t.assignees || []).map(a => a.id);
    for (const p of plans) {
      if (dateOnly(p.plan_date) !== day) continue;
      const uid = p.user_id;
      const onMember = (uid && (aids.length === 0 || aids.includes(uid)))
        ? uid === memberId
        : aids.includes(memberId);
      if (onMember) items.push({ taskId: t.id, title: t.title, plan: p });
    }
  }

  const m = memById.get(memberId);
  const dlabel = `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;
  const pop = document.createElement("div");
  pop.className = "pl-pop";
  pop.dataset.mid = String(memberId);
  pop.dataset.day = day;
  pop.innerHTML = `
    <div class="pl-pop-hd"><b>${esc((m && m.name) || "")} ・ ${dlabel}</b><span>${items.length}件</span><button type="button" class="pl-pop-x" aria-label="閉じる">×</button></div>
    <div class="pl-pop-list">
      ${items.length ? items.map((it, i) => `
        <div class="pl-pop-row" data-i="${i}">
          <span class="pl-pop-title" title="${esc(it.title)}">${esc(it.title)}</span>
          <span class="pl-pop-edit">
            <input class="pl-pop-h" type="number" min="0.5" step="0.5" value="${toH(it.plan.seconds)}" aria-label="時間(h)"> h
            <button type="button" class="pl-pop-save" title="時間を更新">保存</button>
            <button type="button" class="pl-pop-del" title="この予定を削除">×</button>
          </span>
        </div>`).join("")
        : `<div class="pl-pop-empty">予定なし</div>`}
    </div>
    <div class="pl-pop-msg" hidden></div>`;

  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  root.appendChild(pop);
  const rr = root.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const W = pop.offsetWidth || 280;
  let left = ar.left - rr.left;
  if (left + W > rr.width) left = Math.max(0, rr.width - W);
  let top = ar.bottom - rr.top + 2;
  if (ar.bottom + (pop.offsetHeight || 0) > window.innerHeight) {
    top = Math.max(0, ar.top - rr.top - (pop.offsetHeight || 0) - 2);
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";

  const showMsg = (txt) => { const el = pop.querySelector(".pl-pop-msg"); el.hidden = false; el.textContent = txt; };
  pop.querySelector(".pl-pop-x").onclick = (e) => { e.stopPropagation(); closePopover(root); };

  pop.querySelectorAll(".pl-pop-row").forEach((rowEl, idx) => {
    const it = items[idx];
    // B13: 時間編集（h）→ deletePlan＋logPlan で入れ直し（plan の seconds 直更新APIが無いため）。
    const saveBtn = rowEl.querySelector(".pl-pop-save");
    saveBtn.onclick = async (e) => {
      e.stopPropagation();
      const h = parseFloat(rowEl.querySelector(".pl-pop-h").value);
      if (!(h > 0)) { showMsg("時間を確認"); return; }
      if (Math.abs(h - toH(it.plan.seconds)) < 1e-9) { closePopover(root); return; } // 変更なし
      saveBtn.disabled = true; showMsg("保存中…");
      try {
        await vik.deletePlan(it.taskId, it.plan.id);
        await vik.logPlan(it.taskId, Math.round(h * 3600), day, it.plan.note || "", it.plan.user_id || null, it.plan.start_minute ?? null);
        closePopover(root);
        invalidate();
        await render(root); // B16: 局所更新＝再取得→再描画（該当セルが反映される）
      } catch (err) { saveBtn.disabled = false; showMsg("× " + err.message); }
    };
    // B13: 削除（deletePlan）
    const delBtn = rowEl.querySelector(".pl-pop-del");
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      delBtn.disabled = true; showMsg("削除中…");
      try {
        await vik.deletePlan(it.taskId, it.plan.id);
        closePopover(root);
        invalidate();
        await render(root);
      } catch (err) { delBtn.disabled = false; showMsg("× " + err.message); }
    };
  });

  // 外側クリック / Esc で閉じる（次フレームで登録して自身のクリックを拾わない）
  const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closePopover(root); };
  const onKey = (e) => { if (e.key === "Escape") closePopover(root); };
  pop._cleanup = () => { document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onKey, true); };
  setTimeout(() => { document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onKey, true); }, 0);
}

function closePopover(root) {
  const pop = root.querySelector(".pl-pop");
  if (!pop) return;
  if (pop._cleanup) pop._cleanup();
  pop.remove();
}

function css() {
  return `
  .ptable-scroll{margin:0 -6px}
  .ptable{width:100%;min-width:560px;border-collapse:collapse;font-size:13px}
  .ptable th{font-size:11px;color:${C.muted};font-weight:600;padding:8px 6px;border-bottom:1px solid ${C.line};white-space:nowrap}
  .ptable td{padding:8px 6px;border-bottom:1px solid ${C.line};font-variant-numeric:tabular-nums}
  .ptable td.pl-cell{text-align:center;position:relative}
  .ptable td.pl-cell.has{cursor:pointer}
  .ptable td.pl-cell.has:hover{background:color-mix(in srgb, ${C.fill} 8%, transparent)}
  .ptable td.pl-cell.off{background:rgba(120,130,150,.08)}
  .pl-rest{font-size:9.5px;color:${C.muted};margin-top:1px}
  .pl-navb{font:inherit;font-size:12px;border:1px solid ${C.line};background:var(--card);color:${C.ink};border-radius:7px;padding:5px 10px;cursor:pointer}
  .pl-navb:hover{border-color:${C.fill};color:${C.fill}}
  .pl-navb.on{background:${C.fill};color:#fff;border-color:${C.fill}}
  .pl-pop{position:absolute;z-index:30;width:280px;max-height:320px;overflow:auto;background:var(--card);border:1px solid ${C.line};border-radius:10px;box-shadow:0 8px 28px rgba(20,30,50,.18);padding:8px}
  .pl-pop-hd{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:0 2px}
  .pl-pop-hd b{font-size:12.5px}
  .pl-pop-hd span{font-size:11px;color:${C.muted}}
  .pl-pop-x{margin-left:auto;font:inherit;font-size:15px;line-height:1;border:0;background:none;color:${C.muted};cursor:pointer;padding:0 2px}
  .pl-pop-x:hover{color:${C.fill}}
  .pl-pop-row{display:flex;align-items:center;gap:6px;padding:5px 2px;border-top:1px solid ${C.line}}
  .pl-pop-row:first-child{border-top:0}
  .pl-pop-title{flex:1 1 auto;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pl-pop-edit{flex:0 0 auto;display:flex;align-items:center;gap:4px;font-size:11px;color:${C.muted}}
  .pl-pop-h{width:54px;padding:3px 5px;border:1px solid ${C.line};border-radius:6px;font:inherit;font-size:12px}
  .pl-pop-save{font:inherit;font-size:11px;border:1px solid ${C.line};background:var(--card);color:${C.fill};border-radius:6px;padding:3px 7px;cursor:pointer}
  .pl-pop-save:hover{background:color-mix(in srgb, ${C.fill} 10%, transparent)}
  .pl-pop-del{font:inherit;font-size:14px;line-height:1;border:0;background:none;color:${C.muted};cursor:pointer;padding:0 4px}
  .pl-pop-del:hover{color:${C.over}}
  .pl-pop-empty{font-size:11px;color:${C.muted};padding:4px 2px}
  .pl-pop-msg{font-size:11px;color:${C.muted};padding:4px 2px}`;
}
