// 設定。location.hash で「個人設定」/「チーム設定」を出し分ける（recurring.js と同作法）。
//  - "settings-team" を含む  → チーム設定モード = チーム共有設定 + 祝日・休業日（管理者保存バーはチーム設定でのみ）。
//  - それ以外（settings-personal / 後方互換の素 settings）→ 個人設定モード = リマインダー通知（localStorage 即保存）。
// チーム共有の保存先は taskstation-exec（許可ユーザーのみ書き込み可）。個人設定は localStorage＝exec が落ちていても使える。
import { load, invalidate } from "../lib/store.js";
import { getSettings, saveSettings } from "../lib/exec.js";
import { getHolidays, createHoliday, deleteHoliday,
  getLabels, createLabel, updateLabel, deleteLabel,
  REVIEW_LABEL, WAITING_LABEL } from "../lib/api.js";
import { parseSmartDate, fmtDisplayDow, attachDatePicker } from "../lib/form.js";
import { notifyPrefs, saveNotifyPrefs } from "../lib/notify.js";
import { C, esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

// チーム設定モードか否か（hash に "settings-team" を含むか）。
function isTeamMode() {
  return location.hash.includes("settings-team");
}

export async function render(root) {
  if (isTeamMode()) return renderTeam(root);
  return renderPersonal(root);
}

// ── 個人設定モード ───────────────────────────────────────────────
// リマインダー通知のみ。exec に依存しないので load() の me だけで完結。
async function renderPersonal(root) {
  const { me } = await load();
  const np = notifyPrefs((me && me.id) || 0);
  const leadOpts = [1, 5, 10, 15, 30].map((n) =>
    `<option value="${n}"${n === np.lead ? " selected" : ""}>${n}分前</option>`).join("");

  const personalSection = `
    <section class="sx-card">
      <header class="sx-chd">
        <div class="sx-ctitle">個人設定</div>
        <span class="sx-scope"><span class="dot" style="background:${C.fill}"></span>この端末のみ・変更は即保存</span>
      </header>
      <div class="sx-body">
        <div class="sx-row">
          <div class="sx-label"><div class="sx-rt">リマインダー通知</div>
            <div class="sx-rd">自分の予定・会議の開始前と、期限が今日のタスクを通知します（アプリを開いている間）。</div></div>
          <div class="sx-rc"><label class="sx-tg"><input type="checkbox" id="st-ntf"${np.on ? " checked" : ""}><span class="sl"></span></label></div>
        </div>
        <div class="sx-row" id="st-ntf-leadrow">
          <div class="sx-label"><div class="sx-rt">通知タイミング</div><div class="sx-rd">予定の何分前に知らせるか。</div></div>
          <div class="sx-rc"><select id="st-ntf-lead" class="sx-in">${leadOpts}</select></div>
        </div>
        <div class="sx-note" id="st-ntf-msg"></div>
      </div>
    </section>`;

  root.innerHTML = `
    <style>${css()}</style>
    <div class="sx">
      ${topHtml("personal")}
      ${personalSection}
    </div>`;
  wireNotify(root, me);
}

// ── チーム設定モード ─────────────────────────────────────────────
// チーム共有設定（exec で管理者保存）＋ 祝日・休業日（即時CRUD）。
async function renderTeam(root) {
  const { holidaysByDate } = await load();
  let cur = null, canEdit = false, execDown = false;
  try {
    const d = await getSettings();
    cur = d.settings; canEdit = !!d.can_edit;
  } catch {
    execDown = true;
    cur = { cap_hours: 8, cal_start: 8, cal_end: 20, excluded_project_ids: [] };
  }

  if (execDown) {
    root.innerHTML = `
      <style>${css()}</style>
      <div class="sx">
        ${topHtml("team")}
        <section class="sx-card">
          <header class="sx-chd">
            <div class="sx-ctitle">チーム共有設定</div>
            <span class="sx-scope"><span class="dot" style="background:${C.over}"></span>サービスに接続できません</span>
          </header>
          <div class="sx-body"><div class="sx-note warn">設定サービス（taskstation-exec）に接続できません。既定値（8h/平日・全WS集計）で動作中です。復旧後にこの画面を開き直してください。</div></div>
        </section>
      </div>`;
    return;
  }

  const hourOpts = (sel) => Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === sel ? " selected" : ""}>${h}:00</option>`).join("");

  // 祝日・休業日: id 付き生データを直接取得（削除のため）。store キャッシュとは別。
  const holidays = await getHolidays().catch(() => []);
  // 分類（ラベル）: 生データを直接取得（予約ラベルは保護のためフィルタ前に持つ）。
  const labels = await getLabels().catch(() => []);

  root.innerHTML = `
    <style>${css()}</style>
    <div class="sx">
      ${topHtml("team")}

      <section class="sx-card">
        <header class="sx-chd">
          <div class="sx-ctitle">チーム共有設定</div>
          <span class="sx-scope"><span class="dot" style="background:${canEdit ? C.free : C.muted}"></span>${canEdit ? "保存すると全員に反映" : "閲覧のみ"}</span>
          ${canEdit ? "" : `<span class="sx-lock">${icon("lock", { size: 13 })} 読み取り専用</span>`}
        </header>
        <div class="sx-body">
          <div class="sx-row">
            <div class="sx-label"><div class="sx-rt">1人あたりの容量</div>
              <div class="sx-rd">空き・負荷・超過を判定する基準値。平日のみで計算（週末・祝日・休暇は0）。</div></div>
            <div class="sx-rc"><div class="sx-field">
              <input id="st-cap" class="sx-in sx-num" type="number" min="1" max="24" step="0.5" value="${cur.cap_hours}"${canEdit ? "" : " disabled"}>
              <span class="sx-unit">時間 / 日</span></div></div>
          </div>
          <div class="sx-row">
            <div class="sx-label"><div class="sx-rt">時刻カレンダーの表示時間帯</div>
              <div class="sx-rd">稼働予定・時刻カレンダーで表示する時間の範囲。</div></div>
            <div class="sx-rc"><div class="sx-field">
              <select id="st-cal0" class="sx-in"${canEdit ? "" : " disabled"}>${hourOpts(cur.cal_start)}</select>
              <span class="sx-dash">〜</span>
              <select id="st-cal1" class="sx-in"${canEdit ? "" : " disabled"}>${hourOpts(cur.cal_end)}</select></div></div>
          </div>
        </div>
      </section>

      ${holidaySection(holidays)}

      ${labelSection(labels)}

      ${canEdit ? `
      <div class="sx-savebar">
        <span class="sx-savemeta">変更は<b>保存するまで反映されません</b></span>
        <span class="sx-msg" id="st-msg"></span>
        <button id="st-save" class="sx-save">変更を保存</button>
      </div>` : ""}
    </div>`;

  wireHolidays(root, holidays, holidaysByDate);
  wireLabels(root, labels);

  const btn = root.querySelector("#st-save");
  if (btn) btn.onclick = async () => {
    const msg = root.querySelector("#st-msg");
    const cap = parseFloat(root.querySelector("#st-cap").value);
    const c0 = +root.querySelector("#st-cal0").value, c1 = +root.querySelector("#st-cal1").value;
    if (!isFinite(cap) || cap < 1 || cap > 24) { msg.className = "sx-msg err"; msg.textContent = "容量は1〜24で入力してください。"; return; }
    if (c1 <= c0) { msg.className = "sx-msg err"; msg.textContent = "カレンダーの終了は開始より後にしてください。"; return; }
    btn.disabled = true;
    try {
      // WSはUIから廃止＝常に全WS集計（excluded は空で保存）
      await saveSettings({ cap_hours: cap, cal_start: c0, cal_end: c1, excluded_project_ids: [] });
      invalidate(); // 全ビューに即反映
      msg.className = "sx-msg ok"; msg.innerHTML = `${icon("check", { size: 14 })} 保存しました（全員のビューに反映）`;
    } catch (e) {
      msg.className = "sx-msg err"; msg.textContent = "× " + e.message;
    }
    btn.disabled = false;
  };
}

function topHtml(mode) {
  if (mode === "team") {
    return `
    <header class="sx-top">
      <h1 class="sx-title">チーム設定</h1>
      <p class="sx-sub">容量・表示などチーム全員で共有する<b>共通設定</b>と、<b>祝日・休業日</b>を管理します。共通設定の保存は許可ユーザーのみ。</p>
    </header>`;
  }
  return `
    <header class="sx-top">
      <h1 class="sx-title">個人設定</h1>
      <p class="sx-sub">この端末でのリマインダー<b>通知</b>などを管理します。変更は即保存され、あなたの端末にのみ反映されます。</p>
    </header>`;
}

// 通知の個人設定: 変更は即保存（localStorage）。ONにした瞬間にブラウザ権限を要求（要ユーザー操作）。
function wireNotify(root, me) {
  const uid = (me && me.id) || 0;
  const cb = root.querySelector("#st-ntf");
  const lead = root.querySelector("#st-ntf-lead");
  const msg = root.querySelector("#st-ntf-msg");
  const leadRow = root.querySelector("#st-ntf-leadrow");
  const save = () => saveNotifyPrefs(uid, { on: cb.checked, lead: +lead.value });
  const syncLeadRow = () => { if (leadRow) leadRow.classList.toggle("muted", !cb.checked); };
  syncLeadRow();
  cb.onchange = async () => {
    save(); syncLeadRow();
    if (!cb.checked) { msg.className = "sx-note"; msg.textContent = ""; return; }
    if (typeof Notification === "undefined") { msg.className = "sx-note"; msg.textContent = "このブラウザはデスクトップ通知に未対応です（アプリ内トーストで通知します）。"; return; }
    let perm = Notification.permission;
    if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { perm = "denied"; } }
    msg.className = perm === "granted" ? "sx-note ok" : "sx-note";
    if (perm === "granted") {
      msg.innerHTML = `${icon("check", { size: 14 })} デスクトップ通知が有効です。`;
    } else {
      msg.textContent = "ブラウザ通知が許可されていません（アプリ内トーストで通知します）。";
    }
  };
  lead.onchange = save;
}

// 祝日・休業日: 任意のログインユーザーが即時に作成/削除できる自己完結セクション。
// チーム共有設定の管理者専用 savebar には紐づけず、create/delete API を直接叩く（manage.js と同挙動）。
function holidaySection(holidays) {
  const sorted = [...(holidays || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const todayISO = new Date().toISOString().slice(0, 10);
  const rows = sorted.length ? sorted.map((h) => {
    const iso = String(h.date).slice(0, 10);
    const past = iso < todayISO;
    return `<div class="sx-hrow${past ? " past" : ""}">
      <div class="sx-hmain"><div class="sx-ht">${fmtDisplayDow(iso)}</div><div class="sx-hsub">${esc(h.name)}</div></div>
      <button class="sx-hdel" data-hol-del="${h.id}">削除</button>
    </div>`;
  }).join("") : `<div class="sx-hempty">まだありません</div>`;
  return `
    <section class="sx-card">
      <header class="sx-chd">
        <div class="sx-ctitle">祝日・休業日 <span class="sx-hcnt">${sorted.length}</span></div>
        <span class="sx-scope"><span class="dot" style="background:${C.fill}"></span>追加・削除は即反映</span>
      </header>
      <div class="sx-body">
        <div class="sx-hhint">国民の祝日は自動同期（週1）。会社独自の休業日などはここで手動追加できます。</div>
        <div class="sx-hform">
          <input id="hol-date" class="sx-in sx-hdate" inputmode="numeric" autocomplete="off" placeholder="日付（例: 1112）">
          <input id="hol-name" class="sx-in sx-hname" placeholder="名称（例: 創立記念日）">
          <button class="sx-hadd" id="hol-save">追加</button>
        </div>
        <div class="sx-herr" id="hol-err"></div>
        <div class="sx-hlist">${rows}</div>
      </div>
    </section>`;
}

function wireHolidays(root, holidays, holidaysByDate) {
  const sorted = [...(holidays || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const reload = () => { invalidate(); render(root); };
  const dateEl = root.querySelector("#hol-date");
  if (!dateEl) return;
  attachDatePicker(dateEl, { holidaysByDate });
  dateEl.onblur = () => { const iso = parseSmartDate(dateEl.value); if (iso) dateEl.value = fmtDisplayDow(iso); };

  root.querySelector("#hol-save").onclick = async () => {
    const err = root.querySelector("#hol-err"); err.textContent = "";
    const iso = parseSmartDate(dateEl.value);
    const name = root.querySelector("#hol-name").value.trim();
    if (!iso) { err.textContent = "日付の形式が不正です（例: 1112 → 11/12）。"; return; }
    if (!name) { err.textContent = "名称を入力してください。"; return; }
    const btn = root.querySelector("#hol-save"); btn.disabled = true;
    try { await createHoliday({ date: iso + "T00:00:00Z", name }); reload(); }
    catch (e) { btn.disabled = false; err.textContent = "× " + e.message; }
  };
  root.querySelectorAll("[data-hol-del]").forEach((b) => {
    b.onclick = async () => {
      const h = sorted.find((x) => x.id === +b.dataset.holDel);
      if (!h || !confirm(`祝日「${h.name}」を削除しますか？`)) return;
      b.disabled = true;
      try { await deleteHoliday(h.id); reload(); } catch (e) { b.disabled = false; alert("削除に失敗: " + e.message); }
    };
  });
}

// 分類（ラベル）マスタ: ユーザー定義の分類ラベルを管理する自己完結セクション。
// 予約ラベル（レビュー・連絡待ち）は kind/ステータス判定に使うので編集・削除させない（保護）。
const RESERVED_LABELS = new Set([REVIEW_LABEL, WAITING_LABEL]);
const isReserved = (l) => RESERVED_LABELS.has(l.title || "");
// 色を #rrggbb に正規化（input type=color は # 必須。Vikunja は # 無しで返すことがある）。
function normHex(c) {
  if (!c) return "#3a86ff";
  const h = String(c).startsWith("#") ? c : "#" + c;
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : "#3a86ff";
}

function labelSection(labels) {
  const all = [...(labels || [])].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "ja"));
  const editable = all.filter((l) => !isReserved(l));
  const reserved = all.filter(isReserved);
  const rows = editable.length ? editable.map((l) => {
    const hex = normHex(l.hex_color);
    return `<div class="sx-lbrow" data-lb="${l.id}">
      <input type="color" class="sx-lbcolor" value="${hex}" data-lb-color="${l.id}" title="色を変更">
      <span class="sx-lbname">${esc(l.title || "")}</span>
      <div class="sx-lbacts">
        <button class="sx-lbbtn" data-lb-rename="${l.id}">改名</button>
        <button class="sx-lbbtn sx-lbdel" data-lb-del="${l.id}">削除</button>
      </div>
    </div>`;
  }).join("") : `<div class="sx-hempty">まだ分類がありません</div>`;
  const reservedRows = reserved.map((l) => {
    const hex = normHex(l.hex_color);
    return `<div class="sx-lbrow res">
      <span class="sx-lbsw" style="background:${hex}"></span>
      <span class="sx-lbname">${esc(l.title || "")}</span>
      <span class="sx-lbprot">${icon("lock", { size: 12 })} システム予約</span>
    </div>`;
  }).join("");
  return `
    <section class="sx-card">
      <header class="sx-chd">
        <div class="sx-ctitle">分類 <span class="sx-hcnt">${editable.length}</span></div>
        <span class="sx-scope"><span class="dot" style="background:${C.fill}"></span>追加・変更は即反映</span>
      </header>
      <div class="sx-body">
        <div class="sx-hhint">タスクに付ける分類（ラベル）を管理します。色は一覧やクロックで使われます。「レビュー」「連絡待ち」はシステムが使う予約分類のため変更できません。</div>
        <div class="sx-hform">
          <input id="lb-name" class="sx-in sx-hname" placeholder="分類名（例: エンジニア依頼）">
          <input type="color" id="lb-color" class="sx-lbcolor" value="#3a86ff" title="色">
          <button class="sx-hadd" id="lb-add">追加</button>
        </div>
        <div class="sx-herr" id="lb-err"></div>
        <div class="sx-hlist">${rows}${reservedRows}</div>
      </div>
    </section>`;
}

function wireLabels(root, labels) {
  const reload = () => { invalidate(); render(root); };
  const addBtn = root.querySelector("#lb-add");
  if (!addBtn) return;
  const err = root.querySelector("#lb-err");
  const byId = (id) => (labels || []).find((l) => l.id === id);

  // 追加
  addBtn.onclick = async () => {
    err.textContent = "";
    const name = root.querySelector("#lb-name").value.trim();
    const color = root.querySelector("#lb-color").value;
    if (!name) { err.textContent = "分類名を入力してください。"; return; }
    if (RESERVED_LABELS.has(name)) { err.textContent = "その名前はシステム予約のため使用できません。"; return; }
    if ((labels || []).some((l) => (l.title || "") === name)) { err.textContent = "同じ名前の分類が既にあります。"; return; }
    addBtn.disabled = true;
    try { await createLabel(name, color); reload(); }
    catch (e) { addBtn.disabled = false; err.textContent = "× " + e.message; }
  };

  // 色変更（即保存）
  root.querySelectorAll("[data-lb-color]").forEach((el) => {
    el.onchange = async () => {
      const id = +el.dataset.lbColor;
      el.disabled = true;
      try { await updateLabel(id, { hex_color: el.value }); invalidate(); }
      catch (e) { err.textContent = "× " + e.message; }
      el.disabled = false;
    };
  });

  // 改名
  root.querySelectorAll("[data-lb-rename]").forEach((b) => {
    b.onclick = async () => {
      const id = +b.dataset.lbRename;
      const l = byId(id); if (!l) return;
      const next = prompt("新しい分類名", l.title || "");
      if (next == null) return;
      const name = next.trim();
      if (!name || name === (l.title || "")) return;
      if (RESERVED_LABELS.has(name)) { err.textContent = "その名前はシステム予約のため使用できません。"; return; }
      if ((labels || []).some((x) => x.id !== id && (x.title || "") === name)) { err.textContent = "同じ名前の分類が既にあります。"; return; }
      b.disabled = true;
      try { await updateLabel(id, { title: name }); reload(); }
      catch (e) { b.disabled = false; err.textContent = "× " + e.message; }
    };
  });

  // 削除（確認 → 使用中タスクからは自動で外れる）
  root.querySelectorAll("[data-lb-del]").forEach((b) => {
    b.onclick = async () => {
      const id = +b.dataset.lbDel;
      const l = byId(id); if (!l) return;
      if (!confirm(`分類「${l.title}」を削除しますか？\n使用中のタスクからは自動で外れます。`)) return;
      b.disabled = true;
      try { await deleteLabel(id); reload(); }
      catch (e) { b.disabled = false; err.textContent = "× " + e.message; }
    };
  });
}

function css() {
  return `
  .sx{max-width:680px}
  .sx-top{margin:2px 0 22px}
  .sx-title{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:0}
  .sx-sub{margin:6px 0 0;font-size:13px;color:${C.muted};line-height:1.6;max-width:560px}
  .sx-sub b{color:${C.ink};font-weight:700}

  /* セクション = フラットなカード。色帯やアイコンチップは廃し、見出し帯で整理 */
  .sx-card{background:var(--card);border:1px solid var(--line);border-radius:14px;
    box-shadow:var(--shadow);overflow:hidden;margin-bottom:18px}
  .sx-chd{display:flex;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line);background:#fcfdfe}
  .sx-ctitle{font-size:15px;font-weight:800;letter-spacing:-.01em;color:${C.ink}}
  .sx-scope{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:${C.muted}}
  .sx-scope .dot{width:6px;height:6px;border-radius:50%;flex:none}
  .sx-lock{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};
    background:var(--track);border:1px solid var(--line);padding:4px 11px;border-radius:999px}

  .sx-body{padding:4px 20px}

  /* 行: ラベル(左)＋コントロール(右)を上下中央で整列。十分な余白と細い区切り */
  .sx-row{display:grid;grid-template-columns:1fr auto;gap:10px 28px;align-items:center;
    padding:16px 0;border-top:1px solid var(--line);transition:opacity .15s}
  .sx-row:first-child{border-top:0}
  .sx-row.col{grid-template-columns:1fr;align-items:stretch}
  .sx-row.muted{opacity:.45}
  .sx-label{min-width:0}
  .sx-rt{font-size:13.5px;font-weight:700;color:${C.ink}}
  .sx-rd{font-size:11.5px;color:${C.muted};line-height:1.55;margin-top:3px;max-width:420px}
  .sx-rc{display:flex;align-items:center;gap:8px;justify-self:end}

  /* 入力・セレクトの体裁を統一 */
  .sx-in{font:inherit;font-size:14px;font-weight:600;color:${C.ink};padding:9px 12px;
    border:1px solid var(--line-strong);border-radius:9px;background:var(--card);
    transition:border-color .15s,box-shadow .15s}
  .sx-in:focus{outline:0;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.16)}
  .sx-in:disabled{background:var(--track);color:${C.muted};cursor:not-allowed;border-color:var(--line)}
  .sx-num{width:84px;text-align:right}
  .sx-field{display:inline-flex;align-items:center;gap:8px}
  .sx-unit{font-size:12.5px;color:${C.muted};font-weight:600;white-space:nowrap}
  .sx-dash{color:${C.muted};font-weight:600}

  /* トグルスイッチ（チェックボックスより「効いている感」を出す） */
  .sx-tg{position:relative;display:inline-block;width:44px;height:26px;flex:none;cursor:pointer}
  .sx-tg input{position:absolute;opacity:0;width:0;height:0}
  .sx-tg .sl{position:absolute;inset:0;background:var(--line-strong);border-radius:999px;transition:background .18s}
  .sx-tg .sl::before{content:"";position:absolute;left:3px;top:3px;width:20px;height:20px;
    background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s}
  .sx-tg input:checked + .sl{background:${C.fill}}
  .sx-tg input:checked + .sl::before{transform:translateX(18px)}

  .sx-note{padding:0 0 14px;font-size:11.5px;color:${C.muted};line-height:1.55}
  .sx-note.ok{color:${C.free};font-weight:600}
  .sx-note.warn{color:${C.over};font-weight:600;padding:14px 0}

  /* 保存バー: カードに寄り添うシンプルな1本のバー */
  .sx-savebar{display:flex;align-items:center;gap:14px;padding:13px 20px;
    background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
  .sx-savemeta{font-size:11.5px;color:${C.muted}}
  .sx-savemeta b{color:${C.ink};font-weight:700}
  .sx-msg{margin-left:auto;font-size:12.5px;font-weight:700;min-height:16px}
  .sx-msg.ok{color:${C.free}}.sx-msg.err{color:${C.over}}
  .sx-save{font:inherit;font-size:13.5px;font-weight:700;padding:10px 22px;border-radius:10px;border:0;
    background:${C.fill};color:#fff;cursor:pointer;transition:filter .15s,transform .06s}
  .sx-save:hover{filter:brightness(1.06)}.sx-save:active{transform:translateY(1px)}
  .sx-save:disabled{opacity:.55;cursor:default}

  /* 祝日・休業日セクション: 追加フォーム＋日付順リスト（過去は淡色） */
  .sx-hcnt{font-size:12px;color:${C.muted};font-weight:600;background:var(--track);border-radius:10px;padding:1px 8px;margin-left:6px}
  .sx-hhint{font-size:11.5px;color:${C.muted};line-height:1.55;padding:14px 0 0}
  .sx-hform{display:flex;gap:8px;flex-wrap:wrap;padding:12px 0 0}
  .sx-hdate{flex:0 0 auto;width:150px}
  .sx-hname{flex:1;min-width:140px}
  .sx-hadd{font:inherit;font-size:13.5px;font-weight:700;padding:9px 20px;border-radius:9px;border:0;
    background:${C.fill};color:#fff;cursor:pointer;white-space:nowrap;transition:filter .15s,transform .06s}
  .sx-hadd:hover{filter:brightness(1.06)}.sx-hadd:active{transform:translateY(1px)}.sx-hadd:disabled{opacity:.55;cursor:default}
  .sx-herr{font-size:12px;font-weight:600;color:${C.over};min-height:14px;margin:6px 0 0}
  .sx-hlist{display:flex;flex-direction:column;gap:2px;margin:6px 0 14px}
  .sx-hempty{font-size:12.5px;color:${C.muted};padding:10px 2px}
  .sx-hrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 2px;border-top:1px solid var(--line)}
  .sx-hrow:first-child{border-top:0}
  .sx-hrow.past{opacity:.5}
  .sx-hmain{min-width:0}
  .sx-ht{font-size:13.5px;font-weight:700;color:${C.ink}}
  .sx-hsub{font-size:11.5px;color:${C.muted};margin-top:2px}
  .sx-hdel{font:inherit;font-size:11.5px;font-weight:600;padding:5px 12px;border-radius:8px;flex:none;
    border:1px solid var(--line-strong);background:var(--card);color:${C.muted};cursor:pointer;transition:border-color .12s,color .12s}
  .sx-hdel:hover{border-color:${C.over};color:${C.over}}

  /* 分類（ラベル）マスタ: 色スウォッチ＋名前＋操作ボタン。予約ラベルは保護表示 */
  .sx-lbcolor{flex:none;width:30px;height:30px;padding:0;border:1px solid var(--line-strong);
    border-radius:8px;background:var(--card);cursor:pointer}
  .sx-lbcolor::-webkit-color-swatch-wrapper{padding:3px}
  .sx-lbcolor::-webkit-color-swatch{border:0;border-radius:5px}
  .sx-lbcolor:disabled{opacity:.55;cursor:default}
  .sx-lbrow{display:flex;align-items:center;gap:10px;padding:9px 2px;border-top:1px solid var(--line)}
  .sx-lbrow:first-child{border-top:0}
  .sx-lbsw{flex:none;width:14px;height:14px;border-radius:4px;border:1px solid rgba(0,0,0,.12)}
  .sx-lbname{flex:1;min-width:0;font-size:13.5px;font-weight:700;color:${C.ink};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sx-lbacts{display:flex;gap:6px;flex:none}
  .sx-lbbtn{font:inherit;font-size:11.5px;font-weight:600;padding:5px 12px;border-radius:8px;
    border:1px solid var(--line-strong);background:var(--card);color:${C.muted};cursor:pointer;transition:border-color .12s,color .12s}
  .sx-lbbtn:hover{border-color:${C.fill};color:${C.fill}}
  .sx-lbbtn:disabled{opacity:.55;cursor:default}
  .sx-lbdel:hover{border-color:${C.over};color:${C.over}}
  .sx-lbrow.res{opacity:.7}
  .sx-lbprot{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:11px;font-weight:700;color:${C.muted};
    background:var(--track);border:1px solid var(--line);padding:4px 10px;border-radius:999px}

  /* ダークモード: ハードコードした淡色面/tintを反転（ライト値は不変） */
  html[data-theme="dark"] .sx-chd{background:var(--track)}`;
}
