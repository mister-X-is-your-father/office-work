// 個人休暇（member leave / unavailability）の登録・編集・削除。
// 休暇期間（両端含む）はその人の容量が0になり、空き・負荷計算に反映される。
// データは TaskStation API のグローバルエンティティ（ログインユーザーがCRUD可）。
// ※祝日・休業日の管理は views/manage.js（#/manage）、定期業務は views/recurring.js（#/recurring）。
import { load, invalidate } from "../lib/store.js";
import { getUnavailability, createUnavailability, deleteUnavailability } from "../lib/api.js";
import { parseSmartDate, fmtDisplayDow, attachDatePicker } from "../lib/form.js";
import { C, esc } from "../lib/ui.js";

const fmtDate = (iso) => fmtDisplayDow(iso);

export async function render(root) {
  ensureStyle();
  const { members, holidaysByDate, holidaysSet, me } = await load();
  const memberName = (id) => { const m = (members || []).find((x) => x.id === id); return m ? (m.name || m.username) : `user${id}`; };

  // 管理対象は id 付きの生データが要る（削除のため）。store のキャッシュとは別に直接取得。
  const unavailability = await getUnavailability().catch(() => []);

  root.innerHTML = `
    <h1 class="vtitle">休暇 <small>メンバーの個人休暇の登録・編集</small></h1>
    <div class="mg-grid">
      <div class="card mg-card" id="mg-una"></div>
    </div>`;

  const reload = () => { invalidate(); render(root); };

  renderUnavailability(root.querySelector("#mg-una"), unavailability, memberName, { members, holidaysByDate, holidaysSet, me, reload });
}

// 期間（両端含む）の営業日数 = 土日・祝日を除いた平日数。
function businessDays(start, end, holidaysSet) {
  if (!start || !end || end < start) return 0;
  const hol = holidaysSet || new Set();
  let n = 0;
  const d = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  while (d <= last) {
    const dow = d.getUTCDay();          // 0=日, 6=土
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !hol.has(iso)) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

// 理由クイック入力チップの候補。
const REASON_CHIPS = ["有給", "午前休", "午後休", "夏季", "年末年始"];

// ===== 個人休暇 =====
function renderUnavailability(el, unavailability, memberName, { members, holidaysByDate, holidaysSet, me, reload }) {
  const sorted = [...(unavailability || [])].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const todayISO = new Date().toISOString().slice(0, 10);
  const meId = me && me.id;
  const memOpts = (members || []).map((m) => `<option value="${m.id}"${m.id === meId ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");
  const chips = REASON_CHIPS.map((r) => `<button type="button" class="una-chip" data-chip="${esc(r)}">${esc(r)}</button>`).join("");
  el.innerHTML = `
    <div class="mg-h"><span>個人休暇 <span class="mg-cnt">${sorted.length}</span></span></div>
    <div class="mg-hint">休暇期間（両端含む）はその人の容量が0になり、空き・負荷計算に反映されます。</div>
    <div class="mg-form mg-form-una">
      <select id="una-mem" class="mg-in">${memOpts || `<option value="">メンバーなし</option>`}</select>
      <input id="una-s" class="mg-in mg-in-date" inputmode="numeric" autocomplete="off" placeholder="開始（例: 629）">
      <input id="una-e" class="mg-in mg-in-date" inputmode="numeric" autocomplete="off" placeholder="終了（例: 701）">
      <input id="una-r" class="mg-in" placeholder="理由（例: 有給）">
      <div class="una-chips">${chips}</div>
      <button class="mg-add" id="una-save">追加</button>
    </div>
    <div class="mg-err" id="una-err"></div>
    <div class="mg-list">${sorted.length ? sorted.map((u) => {
      const s = String(u.start_date).slice(0, 10), e2 = String(u.end_date).slice(0, 10);
      const past = e2 < todayISO;
      const bd = businessDays(s, e2, holidaysSet);
      const range = (s === e2 ? fmtDate(s) : `${fmtDate(s)} 〜 ${fmtDate(e2)}`) + (bd ? ` <span class="una-bd">(営業${bd}日)</span>` : "");
      return `<div class="mg-row${past ? " mg-past" : ""}">
        <div class="mg-row-main"><div class="mg-row-t">${esc(memberName(u.user_id))}</div>
          <div class="mg-row-sub">${range}${u.reason ? " ・ " + esc(u.reason) : ""}</div></div>
        <div class="mg-row-acts"><button class="mg-btn mg-del" data-del="${u.id}">削除</button></div>
      </div>`;
    }).join("") : `<div class="mg-empty">まだありません</div>`}</div>`;

  const sEl = el.querySelector("#una-s"), eEl = el.querySelector("#una-e");
  [sEl, eEl].forEach((d) => {
    attachDatePicker(d, { holidaysByDate });
    d.onblur = () => { const iso = parseSmartDate(d.value); if (iso) d.value = fmtDisplayDow(iso); };
  });

  // 理由クイック入力チップ → 入力欄に反映してフォーカス。
  const rEl = el.querySelector("#una-r");
  el.querySelectorAll("[data-chip]").forEach((b) => {
    b.onclick = () => { rEl.value = b.dataset.chip; rEl.focus(); };
  });

  el.querySelector("#una-save").onclick = async () => {
    const err = el.querySelector("#una-err"); err.textContent = "";
    const uid = +el.querySelector("#una-mem").value;
    const s = parseSmartDate(sEl.value), e2 = parseSmartDate(eEl.value);
    const reason = rEl.value.trim();
    if (!uid) { err.textContent = "メンバーを選んでください。"; return; }
    if (!s) { err.textContent = "開始日の形式が不正です（例: 629 → 6/29）。"; return; }
    if (!e2) { err.textContent = "終了日の形式が不正です（例: 701 → 7/1）。"; return; }
    if (e2 < s) { err.textContent = "終了日は開始日以降にしてください。"; return; }
    const btn = el.querySelector("#una-save"); btn.disabled = true;
    try {
      await createUnavailability({ user_id: uid, start_date: s + "T00:00:00Z", end_date: e2 + "T00:00:00Z", reason });
      reload();
    } catch (e) { btn.disabled = false; err.textContent = "× " + e.message; }
  };
  el.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const u = sorted.find((x) => x.id === +b.dataset.del);
      if (!u || !confirm(`${memberName(u.user_id)} の休暇を削除しますか？`)) return;
      b.disabled = true;
      try { await deleteUnavailability(u.id); reload(); } catch (e) { b.disabled = false; alert("削除に失敗: " + e.message); }
    };
  });
}

let _styled = false;
function ensureStyle() {
  if (_styled) return; _styled = true;
  const s = document.createElement("style");
  s.textContent = `
  .mg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;align-items:start}
  .mg-card{padding:16px 18px}
  .mg-h{display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:700;margin-bottom:4px}
  .mg-cnt{font-size:12px;color:${C.muted};font-weight:600;background:${C.track};border-radius:10px;padding:1px 8px;margin-left:4px}
  .mg-hint{font-size:11.5px;color:${C.muted};margin-bottom:10px;line-height:1.5}
  .mg-form{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
  .mg-form-una{flex-direction:column}
  .mg-in{font:inherit;font-size:13px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px;background:#fff;box-sizing:border-box;flex:1;min-width:0}
  .mg-in-date{flex:0 0 auto;width:120px}
  .mg-form-una .mg-in{flex:none;width:100%}
  .mg-add{font:inherit;font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:8px;border:1px solid ${C.fill};background:${C.fill};color:#fff;cursor:pointer;white-space:nowrap}
  .mg-add:hover{filter:brightness(1.05)}.mg-add:disabled{opacity:.6}
  .una-chips{display:flex;flex-wrap:wrap;gap:5px}
  .una-chip{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:14px;border:1px solid ${C.line};background:${C.track};color:${C.muted};cursor:pointer;white-space:nowrap}
  .una-chip:hover{border-color:${C.fill};color:${C.fill};background:#fff}
  .una-bd{color:${C.muted};font-size:11px}
  .mg-err{font-size:12px;font-weight:600;color:${C.over};min-height:14px;margin:2px 0 6px}
  .mg-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}
  .mg-empty{font-size:12.5px;color:${C.muted};padding:10px 2px}
  .mg-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 4px;border-top:1px solid ${C.track}}
  .mg-row:first-child{border-top:0}
  .mg-row.mg-past{opacity:.5}
  .mg-row-t{font-size:13px;font-weight:600;color:${C.ink}}
  .mg-row-sub{font-size:11.5px;color:${C.muted};margin-top:2px}
  .mg-row-acts{display:flex;gap:5px;flex-shrink:0}
  .mg-btn{font:inherit;font-size:11.5px;padding:4px 10px;border-radius:7px;border:1px solid ${C.line};background:#fff;color:${C.muted};cursor:pointer}
  .mg-btn:hover{border-color:${C.fill};color:${C.fill}}
  .mg-del:hover{border-color:${C.over};color:${C.over}}

  /* ダークモード: 白背景の入力・ボタンを面色に（ライト値は不変） */
  html[data-theme="dark"] .mg-in{background:var(--card);color:var(--ink)}
  html[data-theme="dark"] .mg-btn{background:var(--card)}
  html[data-theme="dark"] .una-chip:hover{background:var(--card)}`;
  document.head.appendChild(s);
}
