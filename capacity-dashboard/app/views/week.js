// 週プランニング（mock 18 相当・実データ。日割り見積りの俯瞰。フェーズ2で予定テーブルに発展）
import { load } from "../lib/store.js";
import { weekLoadByMember } from "../lib/capacity.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";

const DOW = ["月", "火", "水", "木", "金"];
function weekDates(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
  return [0, 1, 2, 3, 4].map(i => { const x = new Date(mon); x.setUTCDate(mon.getUTCDate() + i); return x.toISOString().slice(0, 10); });
}

export async function render(root) {
  const { tasks, members, plansByTask } = await load();
  const today = todayISO();
  const days = weekDates(today);
  const rows = weekLoadByMember(tasks, members, days, 8, plansByTask);

  const head = `<th style="text-align:left">メンバー</th>` +
    days.map((d, i) => `<th style="${d === today ? "color:" + C.fill : ""}">${DOW[i]}<div style="font-size:10px;color:${C.muted}">${d.slice(5)}</div></th>`).join("") +
    `<th>週計</th>`;
  const body = rows.length ? rows.map(r => {
    const cells = r.days.map(d => {
      const col = d.over ? C.over : d.h > 0 ? C.ink : C.muted;
      return `<td style="text-align:center;color:${col};font-weight:${d.h > 0 ? 600 : 400}">${d.h ? fmtH(d.h) : "·"}${d.over ? "!" : ""}</td>`;
    }).join("");
    return `<tr><td style="font-weight:600">${esc(r.name)}<div style="font-size:10px;color:${C.muted}">8h/日</div></td>${cells}<td style="text-align:center;font-weight:700">${fmtH(r.weekH)}<div style="font-size:10px;color:${C.muted}">/40h</div></td></tr>`;
  }).join("") : `<tr><td colspan="7" style="padding:30px;text-align:center;color:${C.muted}">期間/期日＋見積りのある担当タスクがありません。</td></tr>`;

  root.innerHTML = `
    <h1 class="vtitle">週プランニング <small>${days[0].slice(5)}〜${days[4].slice(5)}</small></h1>
    <div class="card" style="padding:6px 12px 12px">
      <table class="wtable">${`<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`}</table>
    </div>
    <div style="font-size:11.5px;color:${C.muted};margin-top:10px">※ 日別予定(plans)があれば予定、無ければ見積りを期間日割り（! = 容量超過）。多担当タスクは全員にフル時間。日別予定は「週プランナー」で入力。</div>
    <style>.wtable{width:100%;border-collapse:collapse;font-size:13px}.wtable th{font-size:11px;color:${C.muted};font-weight:600;padding:8px 6px;border-bottom:1px solid ${C.line}}.wtable td{padding:9px 6px;border-bottom:1px solid ${C.line};font-variant-numeric:tabular-nums}</style>`;
}
