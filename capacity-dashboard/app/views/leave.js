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

// ISO日付に日数を加算（UTC基準）。隣接判定（終了の翌日＝相手の開始 等）に使う。
function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 同一ユーザーの他レコードと期間が重複/隣接するかを検出（editId は自分自身を除外）。
// 重複 = 区間が交差。隣接 = 一方の終了の翌日が他方の開始（＝連続した1期間にまとめられる）。
function findOverlapOrAdjacent(records, uid, s, e2, editId) {
  const hits = { overlap: [], adjacent: [] };
  for (const u of records || []) {
    if (u.id === editId) continue;
    if (+u.user_id !== +uid) continue;
    const us = String(u.start_date).slice(0, 10), ue = String(u.end_date).slice(0, 10);
    if (s <= ue && us <= e2) hits.overlap.push(u);           // 区間交差
    else if (addDaysISO(e2, 1) === us || addDaysISO(ue, 1) === s) hits.adjacent.push(u); // 隙間なく連続
  }
  return hits;
}

// ===== 個人休暇 =====
function renderUnavailability(el, unavailability, memberName, { members, holidaysByDate, holidaysSet, me, reload }) {
  const records = [...(unavailability || [])];
  const todayISO = new Date().toISOString().slice(0, 10);
  const meId = me && me.id;
  const memOpts = (members || []).map((m) => `<option value="${m.id}"${m.id === meId ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");
  const chips = REASON_CHIPS.map((r) => `<button type="button" class="una-chip" data-chip="${esc(r)}">${esc(r)}</button>`).join("");

  // B52: today 基準で二分。今後（終了が今日以降）は近い順、過去（終了が今日より前）は新しい順でトグル内に。
  const isPast = (u) => String(u.end_date).slice(0, 10) < todayISO;
  const upcoming = records.filter((u) => !isPast(u)).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const past = records.filter((u) => isPast(u)).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));

  const rowHtml = (u) => {
    const s = String(u.start_date).slice(0, 10), e2 = String(u.end_date).slice(0, 10);
    const pastRow = e2 < todayISO;
    const bd = businessDays(s, e2, holidaysSet);
    const range = (s === e2 ? fmtDate(s) : `${fmtDate(s)} 〜 ${fmtDate(e2)}`) + (bd ? ` <span class="una-bd">(営業${bd}日)</span>` : "");
    return `<div class="mg-row${pastRow ? " mg-past" : ""}">
      <div class="mg-row-main"><div class="mg-row-t">${esc(memberName(u.user_id))}</div>
        <div class="mg-row-sub">${range}${u.reason ? " ・ " + esc(u.reason) : ""}</div></div>
      <div class="mg-row-acts">
        <button class="mg-btn mg-edit" data-edit="${u.id}">編集</button>
        <button class="mg-btn mg-del" data-del="${u.id}">削除</button>
      </div>
    </div>`;
  };

  el.innerHTML = `
    <div class="mg-h"><span>個人休暇 <span class="mg-cnt">${records.length}</span></span></div>
    <div class="mg-hint">休暇期間（両端含む）はその人の容量が0になり、空き・負荷計算に反映されます。</div>
    <div class="mg-form mg-form-una">
      <div class="una-edit-tag" id="una-edit-tag" hidden></div>
      <select id="una-mem" class="mg-in">${memOpts || `<option value="">メンバーなし</option>`}</select>
      <input id="una-s" class="mg-in mg-in-date" inputmode="numeric" autocomplete="off" placeholder="開始（例: 629）">
      <input id="una-e" class="mg-in mg-in-date" inputmode="numeric" autocomplete="off" placeholder="終了（例: 701）">
      <input id="una-r" class="mg-in" placeholder="理由（例: 有給）">
      <div class="una-chips">${chips}</div>
      <div class="una-form-acts">
        <button class="mg-add" id="una-save">追加</button>
        <button class="mg-btn una-cancel" id="una-cancel" hidden>キャンセル</button>
      </div>
    </div>
    <div class="mg-err" id="una-err"></div>
    <div class="mg-list">${upcoming.length ? upcoming.map(rowHtml).join("") : `<div class="mg-empty">今後の休暇はありません</div>`}</div>
    ${past.length ? `
      <button type="button" class="una-past-toggle" id="una-past-toggle" aria-expanded="false">▸ 過去の休暇 <span class="mg-cnt">${past.length}</span></button>
      <div class="mg-list una-past-list" id="una-past-list" hidden>${past.map(rowHtml).join("")}</div>
    ` : ""}`;

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

  const memEl = el.querySelector("#una-mem");
  const saveBtn = el.querySelector("#una-save");
  const cancelBtn = el.querySelector("#una-cancel");
  const editTag = el.querySelector("#una-edit-tag");
  const err = el.querySelector("#una-err");

  // B50: 編集状態。null=新規追加、idあり=既存差し替え（delete→create）。
  let editId = null;
  const clearEdit = () => {
    editId = null;
    saveBtn.textContent = "追加";
    cancelBtn.hidden = true;
    editTag.hidden = true; editTag.textContent = "";
    memEl.value = String(meId || (members && members[0] && members[0].id) || "");
    sEl.value = ""; eEl.value = ""; rEl.value = "";
  };
  cancelBtn.onclick = () => { clearEdit(); err.textContent = ""; };

  // B52: 過去休暇トグル。
  const pastToggle = el.querySelector("#una-past-toggle");
  if (pastToggle) {
    const pastList = el.querySelector("#una-past-list");
    pastToggle.onclick = () => {
      const open = pastList.hidden;
      pastList.hidden = !open;
      pastToggle.setAttribute("aria-expanded", String(open));
      pastToggle.firstChild.textContent = (open ? "▾ " : "▸ ") + "過去の休暇 ";
    };
  }

  el.querySelector("#una-save").onclick = async () => {
    err.textContent = "";
    const uid = +memEl.value;
    const s = parseSmartDate(sEl.value), e2 = parseSmartDate(eEl.value);
    const reason = rEl.value.trim();
    if (!uid) { err.textContent = "メンバーを選んでください。"; return; }
    if (!s) { err.textContent = "開始日の形式が不正です（例: 629 → 6/29）。"; return; }
    if (!e2) { err.textContent = "終了日の形式が不正です（例: 701 → 7/1）。"; return; }
    if (e2 < s) { err.textContent = "終了日は開始日以降にしてください。"; return; }

    // B51: 同一ユーザーの期間重複/隣接を検出して警告（confirm で続行可）。
    const hits = findOverlapOrAdjacent(records, uid, s, e2, editId);
    if (hits.overlap.length || hits.adjacent.length) {
      const desc = (u) => `${fmtDate(String(u.start_date).slice(0, 10))}〜${fmtDate(String(u.end_date).slice(0, 10))}`;
      const lines = [];
      if (hits.overlap.length) lines.push("重複する期間:\n" + hits.overlap.map(desc).join("\n"));
      if (hits.adjacent.length) lines.push("隣接する期間:\n" + hits.adjacent.map(desc).join("\n"));
      if (!confirm(`${memberName(uid)} に既存の休暇と重なる/連続する期間があります。\n\n${lines.join("\n\n")}\n\nこのまま登録しますか？`)) return;
    }

    saveBtn.disabled = true; if (cancelBtn) cancelBtn.disabled = true;
    try {
      // B50: 編集は delete→create の差し替え（API に update が無いため）。
      if (editId != null) await deleteUnavailability(editId);
      await createUnavailability({ user_id: uid, start_date: s + "T00:00:00Z", end_date: e2 + "T00:00:00Z", reason });
      reload();
    } catch (e) {
      saveBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = false;
      err.textContent = "× " + e.message;
    }
  };

  // B50: 編集ボタン → フォームに値を流し込み、保存を差し替えモードに。
  el.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const u = records.find((x) => x.id === +b.dataset.edit);
      if (!u) return;
      editId = u.id;
      const s = String(u.start_date).slice(0, 10), e2 = String(u.end_date).slice(0, 10);
      memEl.value = String(u.user_id);
      sEl.value = fmtDisplayDow(s);
      eEl.value = fmtDisplayDow(e2);
      rEl.value = u.reason || "";
      saveBtn.textContent = "適用";
      cancelBtn.hidden = false;
      editTag.hidden = false;
      editTag.textContent = `編集中: ${memberName(u.user_id)} ${fmtDate(s)}${s === e2 ? "" : " 〜 " + fmtDate(e2)}`;
      err.textContent = "";
      el.querySelector(".mg-form-una").scrollIntoView({ block: "nearest" });
      sEl.focus();
    };
  });

  el.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const u = records.find((x) => x.id === +b.dataset.del);
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
  .una-edit-tag{font-size:11.5px;font-weight:700;color:${C.fill};background:${C.track};border:1px solid ${C.line};border-radius:8px;padding:5px 9px;width:100%;box-sizing:border-box}
  .una-form-acts{display:flex;gap:6px;align-items:center}
  .una-cancel{font-size:12.5px;padding:7px 12px}
  .una-past-toggle{display:flex;align-items:center;gap:4px;font:inherit;font-size:12px;font-weight:700;color:${C.muted};background:none;border:0;padding:8px 2px 4px;margin-top:6px;cursor:pointer;width:100%;text-align:left}
  .una-past-toggle:hover{color:${C.fill}}
  .una-past-list{margin-top:0}
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
