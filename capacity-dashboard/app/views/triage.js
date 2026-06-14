// 優先度・トリアージ（mock 46 相当・実データ）
import { load } from "../lib/store.js";
import { triage } from "../lib/capacity.js";
import { C, fmtH, esc, todayISO } from "../lib/ui.js";

const COLS = [
  { key: "must", label: "🔴 今日必須", color: C.over },
  { key: "should", label: "🟠 今日着手", color: C.amber },
  { key: "movable", label: "🟢 後日可", color: C.free },
];

export async function render(root) {
  const { tasks } = await load();
  const items = triage(tasks, todayISO())
    .sort((a, b) => (b.priority - a.priority) || ((a.slack ?? 99) - (b.slack ?? 99)));

  const col = (c) => {
    const list = items.filter(i => i.cls === c.key);
    return `<div class="card" style="flex:1;min-width:220px">
      <div style="padding:11px 14px;border-bottom:1px solid ${C.line};font-weight:700;color:${c.color}">${c.label} <span style="color:${C.muted};font-weight:400">${list.length}</span></div>
      ${list.length ? list.map(cardHtml).join("") : `<div style="padding:22px;text-align:center;color:${C.muted};font-size:12px">なし</div>`}
    </div>`;
  };
  root.innerHTML = `
    <h1 class="vtitle">優先度・トリアージ <small>今日の着手優先度 ${todayISO()}</small></h1>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">${COLS.map(col).join("")}</div>`;
}

function cardHtml(t) {
  const due = t.due ? `期限 ${t.due.slice(5)}${t.slack != null ? `（${t.slack <= 0 ? "超過/今日" : "あと" + t.slack + "日"}）` : ""}` : "期限なし";
  const pr = t.priority >= 4 ? `<span style="color:${C.over};font-weight:700">優先${t.priority}</span>` : `優先${t.priority}`;
  return `<div style="padding:11px 14px;border-bottom:1px solid ${C.line}">
    <div style="font-weight:600;font-size:13.5px">${esc(t.title)}</div>
    <div style="font-size:11.5px;color:${C.muted};margin-top:3px">${pr} ・ ${due} ・ ${fmtH(t.estH)}</div>
  </div>`;
}
