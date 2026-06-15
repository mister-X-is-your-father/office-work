// 定期業務・定期MTG の管理（独立ビュー）。
// 旧「予定の基礎データ」(#/manage) の①定期・会議カードを単独画面に抽出したもの。
// 定例MTG・定期タスク・単発MTGを RRULE で管理。新規/編集は recurrenceform の種別タブ付きモーダル。
// データはすべて TaskStation API のグローバルエンティティ（ログインユーザーがCRUD可）。
import { load, invalidate } from "../lib/store.js";
import { deleteRecurrence } from "../lib/api.js";
import { openRecurrenceForm, summarizeRecurrence, recurrenceMode } from "./recurrenceform.js";
import { C, esc } from "../lib/ui.js";

const KIND_ICON = { mtg: "📅", rmtg: "🔁", rtask: "🔁" };

export async function render(root) {
  ensureStyle();
  const { members, holidaysByDate, recurrences } = await load();
  const memberName = (id) => { const m = (members || []).find((x) => x.id === id); return m ? (m.name || m.username) : `user${id}`; };

  root.innerHTML = `
    <h1 class="vtitle">定期業務・定期MTG <small>定例MTG・定期タスク・単発MTGの登録・編集</small></h1>
    <div class="rc-grid">
      <div class="card rc-card" id="rc-rec"></div>
    </div>`;

  const reload = () => { invalidate(); render(root); };

  renderRecurrences(root.querySelector("#rc-rec"), recurrences || [], memberName, { members, holidaysByDate, reload });
}

function renderRecurrences(el, recurrences, memberName, { members, holidaysByDate, reload }) {
  const sorted = [...(recurrences || [])].sort((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)));
  el.innerHTML = `
    <div class="rc-h"><span>定期・会議 <span class="rc-cnt">${sorted.length}</span></span>
      <button class="rc-add" id="rec-add">＋ 新規</button></div>
    <div class="rc-hint">定例MTG・定期タスク・単発MTGをRRULEで管理。「持ち回り」は担当が順番に巡回します。</div>
    <div class="rc-list">${sorted.length ? sorted.map((r) => recRow(r, memberName)).join("") : `<div class="rc-empty">まだありません</div>`}</div>`;

  el.querySelector("#rec-add").onclick = () =>
    openRecurrenceForm({ members, holidaysByDate, onSaved: reload });

  el.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const rec = sorted.find((r) => r.id === +b.dataset.edit);
      if (rec) openRecurrenceForm({ existing: rec, members, holidaysByDate, onSaved: reload });
    };
  });
  el.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const rec = sorted.find((r) => r.id === +b.dataset.del);
      if (!rec || !confirm(`「${rec.title}」を削除しますか？`)) return;
      b.disabled = true;
      try { await deleteRecurrence(rec.id); reload(); } catch (e) { b.disabled = false; alert("削除に失敗: " + e.message); }
    };
  });
}

function recRow(r, memberName) {
  const s = summarizeRecurrence(r);
  const names = (r.assignee_ids || []).map(memberName);
  const who = r.rotation
    ? `持ち回り: ${names.join(" → ") || "—"}`
    : (names.join("・") || "—");
  const meta = [s.rep, s.time, s.durTxt].filter(Boolean).join(" ・ ");
  const until = s.untilISO ? ` <span class="rc-until">〜${s.untilISO.replace(/-/g, "/")}</span>` : "";
  return `<div class="rc-row">
    <div class="rc-row-main">
      <div class="rc-row-t">${KIND_ICON[recurrenceMode(r)] || "🔁"} ${esc(r.title)}</div>
      <div class="rc-row-sub">${esc(meta)}${until} ・ ${esc(who)}</div>
    </div>
    <div class="rc-row-acts">
      <button class="rc-btn" data-edit="${r.id}">編集</button>
      <button class="rc-btn rc-del" data-del="${r.id}">削除</button>
    </div>
  </div>`;
}

let _styled = false;
function ensureStyle() {
  if (_styled) return; _styled = true;
  const s = document.createElement("style");
  s.textContent = `
  .rc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;align-items:start;max-width:640px}
  .rc-card{padding:16px 18px}
  .rc-h{display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:700;margin-bottom:4px}
  .rc-cnt{font-size:12px;color:${C.muted};font-weight:600;background:${C.track};border-radius:10px;padding:1px 8px;margin-left:4px}
  .rc-hint{font-size:11.5px;color:${C.muted};margin-bottom:10px;line-height:1.5}
  .rc-add{font:inherit;font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:8px;border:1px solid ${C.fill};background:${C.fill};color:#fff;cursor:pointer;white-space:nowrap}
  .rc-add:hover{filter:brightness(1.05)}.rc-add:disabled{opacity:.6}
  .rc-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}
  .rc-empty{font-size:12.5px;color:${C.muted};padding:10px 2px}
  .rc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 4px;border-top:1px solid ${C.track}}
  .rc-row:first-child{border-top:0}
  .rc-row-t{font-size:13px;font-weight:600;color:${C.ink}}
  .rc-row-sub{font-size:11.5px;color:${C.muted};margin-top:2px}
  .rc-until{color:${C.amber};font-weight:600}
  .rc-row-acts{display:flex;gap:5px;flex-shrink:0}
  .rc-btn{font:inherit;font-size:11.5px;padding:4px 10px;border-radius:7px;border:1px solid ${C.line};background:#fff;color:${C.muted};cursor:pointer}
  .rc-btn:hover{border-color:${C.fill};color:${C.fill}}
  .rc-del:hover{border-color:${C.over};color:${C.over}}

  /* ダークモード: 白背景ボタンを面色に（ライト値は不変） */
  html[data-theme="dark"] .rc-btn{background:var(--card)}`;
  document.head.appendChild(s);
}
