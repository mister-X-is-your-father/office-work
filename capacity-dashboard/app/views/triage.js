// 優先度・トリアージ（mock 46 相当・実データ）
import { load, isAiUser } from "../lib/store.js";
import { triage } from "../lib/capacity.js";
import { C, fmtH, esc, todayISO, avatar } from "../lib/ui.js";
import { categoryLabels, categoryColor } from "../lib/kinds.js";
import { dot } from "../lib/icons.js";
import { openTaskForm } from "./taskform.js";

const COLS = [
  { key: "must", label: "今日必須", color: C.over },
  { key: "should", label: "今日着手", color: C.amber },
  { key: "movable", label: "後日可", color: C.free },
];

// triage() の返り値は slim（assignee/project/labels を持たない）ので、生タスクから id→補足情報を引けるようにする。
//   担当=人間アサイニ先頭（AIユーザー除外）、プロジェクト=親タスク（related_tasks.parenttask）、分類=categoryLabels（レビュー/連絡待ち除外）。
function buildMeta(tasks) {
  const meta = new Map();
  for (const t of tasks || []) {
    const who = (t.assignees || []).find((a) => !isAiUser(a)) || null;
    const parent = (((t.related_tasks || {}).parenttask) || [])[0] || null;
    meta.set(t.id, { who, parent, cats: categoryLabels(t) });
  }
  return meta;
}

export async function render(root) {
  const { tasks, settings = {} } = await load();
  const capH = (settings && settings.capH) || 8;
  const meta = buildMeta(tasks);
  const items = triage(tasks, todayISO())
    .sort((a, b) => (b.priority - a.priority) || ((a.slack ?? 99) - (b.slack ?? 99)));

  const col = (c) => {
    const list = items.filter(i => i.cls === c.key);
    const sumH = list.reduce((s, i) => s + (i.estH || 0), 0);
    // 列の見積り合計（Σ estH）。capH 超過は警告色（C.over）で目立たせる。
    const sumColor = sumH > capH + 1e-6 ? C.over : C.muted;
    const sumBadge = `<span title="見積り合計" style="color:${sumColor};font-weight:${sumH > capH + 1e-6 ? 700 : 400}">Σ ${fmtH(sumH)}</span>`;
    return `<div class="card" style="flex:1;min-width:220px">
      <div style="padding:11px 14px;border-bottom:1px solid ${C.line};font-weight:700;color:${c.color};display:flex;align-items:center;gap:7px">${dot(c.color, 10)} <span>${esc(c.label)}</span> <span style="color:${C.muted};font-weight:400">${list.length}</span> <span style="margin-left:auto;font-size:12px">${sumBadge}</span></div>
      ${list.length ? list.map((i) => cardHtml(i, meta.get(i.id))).join("") : `<div style="padding:22px;text-align:center;color:${C.muted};font-size:12px">なし</div>`}
    </div>`;
  };
  root.innerHTML = `
    <style>
      .tr-card{cursor:pointer;transition:background .12s}.tr-card:hover{background:${C.hover || "rgba(127,127,127,.08)"}}
      .tr-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px}
      .tr-proj{font-size:10.5px;color:${C.muted};border:1px solid ${C.line};border-radius:5px;padding:1px 6px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
      .tr-cat{font-size:10.5px;border:1px solid;border-radius:5px;padding:1px 6px;white-space:nowrap;font-weight:600}
    </style>
    <h1 class="vtitle">優先度・トリアージ <small>今日の着手優先度（カードをクリックで編集） ${todayISO()}</small></h1>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">${COLS.map(col).join("")}</div>`;

  // カードクリックで編集（イベント委譲）。保存後 再描画。
  root.querySelectorAll(".tr-card[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
  });
}

function cardHtml(t, m) {
  const due = t.due ? `期限 ${t.due.slice(5)}${t.slack != null ? `（${t.slack <= 0 ? "超過/今日" : "あと" + t.slack + "日"}）` : ""}` : "期限なし";
  const pr = t.priority >= 4 ? `<span style="color:${C.over};font-weight:700">優先${t.priority}</span>` : `優先${t.priority}`;
  const who = m && m.who;
  const parent = m && m.parent;
  const cats = (m && m.cats) || [];
  const ava = who ? avatar(who, { size: 18 }) : "";
  const projChip = parent ? `<span class="tr-proj" title="プロジェクト: ${esc(parent.title)}">${esc(parent.title)}</span>` : "";
  const catChips = cats.map((c) => `<span class="tr-cat" style="color:${categoryColor(c)};border-color:${categoryColor(c)}40">${esc(c.title)}</span>`).join("");
  const metaRow = (ava || projChip || catChips)
    ? `<div class="tr-meta">${ava}${projChip}${catChips}</div>` : "";
  return `<div class="tr-card" data-id="${t.id}" style="padding:11px 14px;border-bottom:1px solid ${C.line}">
    <div style="font-weight:600;font-size:13.5px">${esc(t.title)}</div>
    <div style="font-size:11.5px;color:${C.muted};margin-top:3px">${pr} ・ ${due} ・ ${fmtH(t.estH)}</div>
    ${metaRow}
  </div>`;
}
