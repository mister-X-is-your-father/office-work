// 月次空き finder（~5週間先までの メンバー×日 空き時間）。
// 負荷源 = 通常タスク(plans優先・見積りフォールバック, #4) ＋ 定期/会議の occurrence(RRULE展開)。
// 容量 = 週末/祝日/個人休暇は 0。占有が非稼働日に重なれば over(衝突) として可視化。
import { load } from "../lib/store.js";
import { taskPlannedHoursByMemberOn, shiftISO } from "../lib/capacity.js";
import { expandRecurrences, occurrenceLoadEntries, freeByMemberDay } from "../lib/recurrence.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";

const WINDOW_DAYS = 35; // ~5週間
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

export async function render(root) {
  const { tasks, members, plansByTask, recurrences, holidaysSet, unavailabilityByMember, settings } = await load();
  const today = todayISO();
  const isoDays = Array.from({ length: WINDOW_DAYS }, (_, i) => shiftISO(today, i));
  const fromISO = isoDays[0], toISO = isoDays[WINDOW_DAYS - 1];
  const availability = { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH };

  // 負荷源1: 通常タスク（plans優先・見積りフォールバック・全員フル）
  const taskLoad = [];
  for (const t of tasks) {
    const plans = plansByTask.get ? plansByTask.get(t.id) : null;
    for (const day of isoDays) {
      const bm = taskPlannedHoursByMemberOn(t, day, plans);
      for (const [mid, h] of bm) taskLoad.push({ memberId: mid, day, h });
    }
  }
  // 負荷源2: 定期/会議の occurrence（RRULE展開・全員フル）
  const occ = expandRecurrences(recurrences, fromISO, toISO);
  const occLoad = occurrenceLoadEntries(occ);

  const free = freeByMemberDay(members, isoDays, [taskLoad, occLoad], availability);

  const dow = (d) => DOW[new Date(d + "T00:00:00Z").getUTCDay()];
  const head = `<th class="ff-m">メンバー</th>` + isoDays.map((d) => {
    const off = (free.get((members[0] || {}).id)?.get(d)?.capH) === 0;
    const isToday = d === today;
    return `<th class="${off ? "off" : ""}${isToday ? " today" : ""}"><div>${dow(d)}</div><div class="dom">${+d.slice(8)}</div><div class="mo">${d.slice(5, 7)}</div></th>`;
  }).join("");

  const cell = (c) => {
    if (!c) return `<td>·</td>`;
    if (c.status === "off") return `<td class="off">${c.capH === 0 ? "—" : ""}</td>`;
    const col = c.status === "over" ? C.over : c.status === "full" ? C.full : C.free;
    const txt = c.status === "over" ? `${fmtH(c.loadH)}!` : fmtH(c.freeH);
    return `<td style="color:${col};font-weight:${c.freeH > 0 ? 600 : 700}">${txt}</td>`;
  };

  const body = members.length ? members.map((m) => {
    const dm = free.get(m.id);
    const totalFree = isoDays.reduce((s, d) => s + Math.max(0, dm.get(d).freeH), 0);
    return `<tr><td class="ff-m">${esc(m.name)}<div class="sub">空き計</div></td>${isoDays.map((d) => cell(dm.get(d))).join("")}<td class="ff-tot">${fmtH(totalFree)}</td></tr>`;
  }).join("") : `<tr><td colspan="${WINDOW_DAYS + 2}" class="empty">メンバーがいません。</td></tr>`;

  root.innerHTML = `
    <h1 class="vtitle">月次空き <small>${fromISO.slice(5)}〜${toISO.slice(5)} ・ 定期/会議・祝日・休暇込み</small></h1>
    <div class="card ff-wrap">
      <div class="ff-scroll"><table class="fftable">
        <thead><tr><th class="ff-m"></th>${head}<th class="ff-tot">計</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>
    <div class="legend">
      <span><b style="color:${C.free}">緑</b>=空き時間 / <b style="color:${C.over}">赤!</b>=超過・衝突(占有h) / <b style="color:${C.full}">満</b>=空き0 / —=週末/祝日/休暇(非稼働)</span>
      <span style="color:${C.muted}">負荷=通常タスク(予定/見積り)＋定期/会議(RRULE)。多担当・会議は全員にフル時間。占有が非稼働日に重なると赤!。</span>
    </div>
    <style>
    .ff-wrap{padding:6px 8px 10px}
    .ff-scroll{overflow-x:auto}
    .fftable{border-collapse:collapse;font-size:12px;white-space:nowrap}
    .fftable th,.fftable td{padding:6px 7px;border-bottom:1px solid ${C.line};text-align:center;font-variant-numeric:tabular-nums}
    .fftable th{font-size:10px;color:${C.muted};font-weight:600;position:sticky;top:0;background:#fff}
    .fftable th .dom{font-size:12px;color:${C.ink};font-weight:700}
    .fftable th .mo{font-size:9px}
    .fftable th.off,.fftable td.off{background:#fafbfc;color:${C.muted}}
    .fftable th.today .dom{color:${C.fill}}
    .fftable .ff-m{position:sticky;left:0;background:#fff;text-align:left;font-weight:600;min-width:80px;z-index:1}
    .fftable .ff-m .sub{font-size:9px;color:${C.muted};font-weight:400}
    .fftable .ff-tot{font-weight:700}
    .fftable .empty{padding:28px;color:${C.muted}}
    .legend{display:flex;flex-direction:column;gap:4px;font-size:11px;margin-top:8px}
    </style>`;
}
