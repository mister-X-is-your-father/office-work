// 設定（チーム共有＋個人設定）。チーム共有の保存先は taskstation-exec（許可ユーザーのみ書き込み可）。
// 個人設定（リマインダー通知）は localStorage＝exec が落ちていても使える。
// UI: 「個人設定 / チーム共有設定」の2グループに分け、各設定を行レイアウト＋アイコン＋明確な保存バーで構造化。
import { load, invalidate, TEMPLATE_WS } from "../lib/store.js";
import { getSettings, saveSettings } from "../lib/exec.js";
import { notifyPrefs, saveNotifyPrefs } from "../lib/notify.js";
import { C, esc } from "../lib/ui.js";

export async function render(root) {
  const { projects, templateProject, me } = await load();
  let cur = null, canEdit = false, execDown = false;
  try {
    const d = await getSettings();
    cur = d.settings; canEdit = !!d.can_edit;
  } catch {
    execDown = true;
    cur = { cap_hours: 8, cal_start: 8, cal_end: 20, excluded_project_ids: [] };
  }
  // 個人設定: リマインダー通知（自分の予定/会議のN分前・期限タスクは営業開始に）
  const np = notifyPrefs((me && me.id) || 0);
  const leadOpts = [1, 5, 10, 15, 30].map((n) =>
    `<option value="${n}"${n === np.lead ? " selected" : ""}>${n}分前</option>`).join("");

  // 個人設定セクション（execDown でも使える＝localStorage）
  const personalSection = `
    <section class="sx-group personal">
      <div class="sx-ghd">
        <span class="sx-ico">🔔</span>
        <div>
          <div class="sx-gtitle">個人設定</div>
          <div class="sx-scope"><span class="dot" style="background:#6c63f2"></span>この端末のブラウザのみ・変更は即保存</div>
        </div>
      </div>
      <div class="sx-panel">
        <div class="sx-row">
          <div><div class="sx-rt">リマインダー通知</div>
            <div class="sx-rd">自分の予定・出席する会議/定例の開始前に通知。期限が今日のタスクは営業開始時刻にまとめて通知します（アプリを開いている間に動作）。</div></div>
          <div class="sx-rc"><label class="sx-tg"><input type="checkbox" id="st-ntf"${np.on ? " checked" : ""}><span class="sl"></span></label></div>
        </div>
        <div class="sx-row" id="st-ntf-leadrow">
          <div><div class="sx-rt">通知タイミング</div><div class="sx-rd">予定の何分前に知らせるか。</div></div>
          <div class="sx-rc"><select id="st-ntf-lead" class="sx-in">${leadOpts}</select></div>
        </div>
        <div class="sx-note" id="st-ntf-msg"></div>
      </div>
    </section>`;

  if (execDown) {
    root.innerHTML = `
      <style>${css()}</style>
      <div class="sx">
        ${topHtml()}
        ${personalSection}
        <section class="sx-group team">
          <div class="sx-ghd"><span class="sx-ico">👥</span>
            <div><div class="sx-gtitle">チーム共有設定</div>
              <div class="sx-scope"><span class="dot" style="background:${C.over}"></span>設定サービスに接続できません</div></div></div>
          <div class="sx-panel"><div class="sx-note warn">設定サービス（taskstation-exec）に接続できません。既定値（8h/平日・全WS集計）で動作中です。復旧後にこの画面を開き直してください。</div></div>
        </section>
      </div>`;
    wireNotify(root, me);
    return;
  }

  const wsList = (projects || []).filter((p) => !templateProject || p.id !== templateProject.id);
  const excluded = new Set(cur.excluded_project_ids || []);
  const hourOpts = (sel) => Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === sel ? " selected" : ""}>${h}:00</option>`).join("");

  root.innerHTML = `
    <style>${css()}</style>
    <div class="sx">
      ${topHtml()}
      ${personalSection}

      <section class="sx-group team">
        <div class="sx-ghd">
          <span class="sx-ico">👥</span>
          <div>
            <div class="sx-gtitle">チーム共有設定</div>
            <div class="sx-scope"><span class="dot" style="background:${C.fill}"></span>${canEdit ? "保存すると全員のビューに反映されます" : "閲覧のみ・変更は管理者に依頼してください"}</div>
          </div>
          ${canEdit ? "" : `<span class="sx-lock">🔒 ロック中</span>`}
        </div>
        <div class="sx-panel">
          <div class="sx-row">
            <div><div class="sx-rt">1人あたりの容量</div>
              <div class="sx-rd">空き・負荷・超過を判定する基準値。平日のみで計算（週末・祝日・休暇は0）。</div></div>
            <div class="sx-rc"><div class="sx-field">
              <input id="st-cap" class="sx-in sx-num" type="number" min="1" max="24" step="0.5" value="${cur.cap_hours}"${canEdit ? "" : " disabled"}>
              <span class="sx-unit">時間 / 日</span></div></div>
          </div>
          <div class="sx-row">
            <div><div class="sx-rt">時刻カレンダーの表示時間帯</div>
              <div class="sx-rd">稼働予定・時刻カレンダーで表示する時間の範囲。</div></div>
            <div class="sx-rc"><div class="sx-field">
              <select id="st-cal0" class="sx-in"${canEdit ? "" : " disabled"}>${hourOpts(cur.cal_start)}</select>
              <span class="sx-dash">〜</span>
              <select id="st-cal1" class="sx-in"${canEdit ? "" : " disabled"}>${hourOpts(cur.cal_end)}</select></div></div>
          </div>
          <div class="sx-row col">
            <div><div class="sx-rt">集計対象ワークスペース</div>
              <div class="sx-rd">チェックを外したワークスペースのタスクは、負荷・空き・一覧から除外されます（デモ・アーカイブ向け）。「${esc(TEMPLATE_WS)}」は常に対象外です。</div></div>
            <div class="sx-wsgrid">
              ${wsList.map((p) => `<label class="sx-chk"><input type="checkbox" data-ws="${p.id}"${excluded.has(p.id) ? "" : " checked"}${canEdit ? "" : " disabled"}><span>${esc(p.title)}</span></label>`).join("")}
            </div>
          </div>
        </div>
      </section>

      ${canEdit ? `
      <div class="sx-savebar">
        <div class="sx-savemeta">チーム共有設定の変更は<br><b>保存するまで反映されません</b></div>
        <span class="sx-msg" id="st-msg"></span>
        <button id="st-save" class="sx-save">変更を保存</button>
      </div>` : ""}
    </div>`;

  wireNotify(root, me);

  const btn = root.querySelector("#st-save");
  if (btn) btn.onclick = async () => {
    const msg = root.querySelector("#st-msg");
    const cap = parseFloat(root.querySelector("#st-cap").value);
    const c0 = +root.querySelector("#st-cal0").value, c1 = +root.querySelector("#st-cal1").value;
    if (!isFinite(cap) || cap < 1 || cap > 24) { msg.className = "sx-msg err"; msg.textContent = "容量は1〜24で入力してください。"; return; }
    if (c1 <= c0) { msg.className = "sx-msg err"; msg.textContent = "カレンダーの終了は開始より後にしてください。"; return; }
    const excludedIds = [...root.querySelectorAll("[data-ws]")].filter((b) => !b.checked).map((b) => +b.dataset.ws);
    btn.disabled = true;
    try {
      await saveSettings({ cap_hours: cap, cal_start: c0, cal_end: c1, excluded_project_ids: excludedIds });
      invalidate(); // 全ビューに即反映
      msg.className = "sx-msg ok"; msg.textContent = "✓ 保存しました（全員のビューに反映）";
    } catch (e) {
      msg.className = "sx-msg err"; msg.textContent = "× " + e.message;
    }
    btn.disabled = false;
  };
}

function topHtml() {
  return `
    <header class="sx-top">
      <h1 class="sx-title">設定</h1>
      <p class="sx-sub">通知などの<b>個人設定</b>と、容量・表示・集計対象などチーム全員で共有する<b>共通設定</b>を管理します。</p>
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
    msg.textContent = perm === "granted"
      ? "✓ デスクトップ通知が有効です。"
      : "ブラウザ通知が許可されていません（アプリ内トーストで通知します）。";
  };
  lead.onchange = save;
}

function css() {
  return `
  .sx{max-width:760px}
  .sx-top{margin:2px 0 24px}
  .sx-title{font-size:25px;font-weight:800;letter-spacing:-.02em;margin:0}
  .sx-sub{margin:7px 0 0;font-size:13px;color:${C.muted};line-height:1.65}
  .sx-sub b{color:${C.ink};font-weight:700}

  .sx-group{margin-bottom:26px}
  .sx-ghd{display:flex;align-items:center;gap:12px;margin:0 2px 13px}
  .sx-ico{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-size:18px;flex:none;box-shadow:inset 0 0 0 1px rgba(20,30,50,.06)}
  .sx-gtitle{font-size:16px;font-weight:800;letter-spacing:-.01em;line-height:1.2}
  .sx-scope{display:inline-flex;align-items:center;gap:6px;margin-top:4px;font-size:11.5px;font-weight:600;color:${C.muted}}
  .sx-scope .dot{width:6px;height:6px;border-radius:50%;flex:none}
  .sx-lock{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};background:${C.track};border:1px solid var(--line);padding:5px 11px;border-radius:999px}

  .sx-panel{background:#fff;border:1px solid var(--line);border-radius:15px;box-shadow:var(--shadow);overflow:hidden}
  .sx-group.personal .sx-ico{background:#ecebfe;color:#5b54e6}
  .sx-group.personal .sx-panel{border-top:3px solid #6c63f2}
  .sx-group.team .sx-ico{background:#e7f0ff;color:${C.fill}}
  .sx-group.team .sx-panel{border-top:3px solid ${C.fill}}

  .sx-row{display:grid;grid-template-columns:1fr auto;gap:14px 24px;align-items:center;padding:16px 18px;border-top:1px solid var(--line);transition:opacity .15s}
  .sx-row:first-child{border-top:0}
  .sx-row.col{grid-template-columns:1fr;align-items:stretch}
  .sx-row.muted{opacity:.45}
  .sx-rt{font-size:13.5px;font-weight:700;color:${C.ink}}
  .sx-rd{font-size:11.5px;color:${C.muted};line-height:1.55;margin-top:4px;max-width:450px}
  .sx-rc{display:flex;align-items:center;gap:8px;justify-self:end}

  .sx-in{font:inherit;font-size:14px;font-weight:600;color:${C.ink};padding:9px 11px;border:1px solid var(--line-strong);border-radius:10px;background:#fff;transition:border-color .15s,box-shadow .15s}
  .sx-in:focus{outline:0;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.16)}
  .sx-in:disabled{background:#f3f5f9;color:${C.muted};cursor:not-allowed;border-color:var(--line)}
  .sx-num{width:88px;text-align:right}
  .sx-field{display:inline-flex;align-items:center;gap:8px}
  .sx-unit{font-size:12.5px;color:${C.muted};font-weight:600;white-space:nowrap}
  .sx-dash{color:${C.muted};font-weight:600}

  /* トグルスイッチ（チェックボックスより「効いている感」を出す） */
  .sx-tg{position:relative;display:inline-block;width:46px;height:27px;flex:none;cursor:pointer}
  .sx-tg input{position:absolute;opacity:0;width:0;height:0}
  .sx-tg .sl{position:absolute;inset:0;background:#ccd2dd;border-radius:999px;transition:background .18s}
  .sx-tg .sl::before{content:"";position:absolute;left:3px;top:3px;width:21px;height:21px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .18s}
  .sx-tg input:checked + .sl{background:#6c63f2}
  .sx-tg input:checked + .sl::before{transform:translateX(19px)}

  .sx-wsgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:9px;margin-top:13px}
  .sx-chk{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--line-strong);border-radius:11px;background:#fbfcfe;font-size:13px;font-weight:600;cursor:pointer;transition:border-color .12s,background .12s}
  .sx-chk:hover{border-color:#bcc6d4;background:#fff}
  .sx-chk:has(input:not(:checked)){opacity:.5}
  .sx-chk input{width:17px;height:17px;accent-color:${C.fill};cursor:pointer;flex:none}

  .sx-note{padding:11px 18px 15px;font-size:11.5px;color:${C.muted};line-height:1.55}
  .sx-note.ok{color:${C.free};font-weight:600}
  .sx-note.warn{color:${C.over};font-weight:600}

  /* 保存バー（チーム設定の変更導線を明確に・セクション末尾の独立バー） */
  .sx-savebar{display:flex;align-items:center;gap:14px;margin-top:8px;
    padding:14px 16px 14px 20px;background:#fff;
    border:1px solid var(--line-strong);border-radius:14px;box-shadow:var(--shadow)}
  .sx-savemeta{font-size:11.5px;color:${C.muted};line-height:1.45}
  .sx-savemeta b{color:${C.ink};font-weight:700}
  .sx-msg{margin-left:auto;font-size:12.5px;font-weight:700;min-height:16px}
  .sx-msg.ok{color:${C.free}}.sx-msg.err{color:${C.over}}
  .sx-save{font:inherit;font-size:13.5px;font-weight:700;padding:11px 24px;border-radius:11px;border:0;
    background:${C.fill};color:#fff;cursor:pointer;box-shadow:0 3px 10px rgba(58,134,255,.38);transition:filter .15s,transform .06s}
  .sx-save:hover{filter:brightness(1.07)}.sx-save:active{transform:translateY(1px)}
  .sx-save:disabled{opacity:.55;cursor:default;box-shadow:none}`;
}
