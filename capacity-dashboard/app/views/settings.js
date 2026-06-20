// 設定。location.hash で「個人設定」/「チーム設定」を出し分ける（recurring.js と同作法）。
//  - "settings-team" を含む  → チーム設定モード = チーム共有設定 + 祝日・休業日（管理者保存バーはチーム設定でのみ）。
//  - それ以外（settings-personal / 後方互換の素 settings）→ 個人設定モード = リマインダー通知（localStorage 即保存）。
// チーム共有の保存先は taskstation-exec（許可ユーザーのみ書き込み可）。個人設定は localStorage＝exec が落ちていても使える。
import { load, invalidate } from "../lib/store.js";
import { getSettings, saveSettings, saveMenuVisibility } from "../lib/exec.js";
import { getHolidays, createHoliday, deleteHoliday,
  getLabels, createLabel, updateLabel, deleteLabel,
  REVIEW_LABEL, WAITING_LABEL } from "../lib/api.js";
import { parseSmartDate, fmtDisplayDow, attachDatePicker } from "../lib/form.js";
import { notifyPrefs, saveNotifyPrefs } from "../lib/notify.js";
import { C, esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { ROUTES, ORDER, ALWAYS_VISIBLE } from "../lib/routes.js";

// ── 外観・起動の個人設定（この端末のみ・localStorage）───────────────
// テーマ: モードを ts.thememode（light/dark/system）に保存。index.html / app.js の従来トグルは
// ts.theme（解決後の light/dark）を読む・書くので、互換維持のため両方を更新する。
//   - mode=system のときは OS 設定（prefers-color-scheme）で解決し、html[data-theme] に即反映。
// 起動既定ビュー: ts.startview に保存（app.js の boot がハッシュ未指定時にこれを採用する想定）。
const THEME_MODE_KEY = "ts.thememode";
const THEME_RESOLVED_KEY = "ts.theme"; // 既存（index.html bootstrap / app.js トグルと共有）
const STARTVIEW_KEY = "ts.startview";
const THEME_MODES = [
  { v: "light", label: "ライト" },
  { v: "dark", label: "ダーク" },
  { v: "system", label: "OSに合わせる" },
];
function getThemeMode() {
  try {
    const m = localStorage.getItem(THEME_MODE_KEY);
    if (m === "light" || m === "dark" || m === "system") return m;
    // 後方互換: 旧 ts.theme(dark/light) しか無い端末はそれをモードとして扱う。
    const legacy = localStorage.getItem(THEME_RESOLVED_KEY);
    return legacy === "dark" ? "dark" : "light";
  } catch { return "light"; }
}
function systemPrefersDark() {
  try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches; }
  catch { return false; }
}
function resolveTheme(mode) {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}
// テーマを即反映＋永続化（再描画は app.js のトグルと同じく呼び出し側で route 等は行わない＝CSS変数のみ）。
function applyThemeMode(mode) {
  const resolved = resolveTheme(mode);
  if (resolved === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try {
    localStorage.setItem(THEME_MODE_KEY, mode);
    localStorage.setItem(THEME_RESOLVED_KEY, resolved); // 既存トグル/bootstrap 互換
  } catch { /* noop */ }
}
function getStartView() {
  try {
    const v = localStorage.getItem(STARTVIEW_KEY);
    return v && ROUTES[v] ? v : "home";
  } catch { return "home"; }
}
// 起動既定ビューの選択肢（ORDER 順・grp ごとに optgroup）。home を先頭に。
function startViewOptionsHtml(cur) {
  const groups = [];
  const gmap = new Map();
  for (const k of ORDER) {
    const r = ROUTES[k]; if (!r) continue;
    const g = r.grp || "その他";
    if (!gmap.has(g)) { gmap.set(g, []); groups.push(g); }
    gmap.get(g).push(k);
  }
  return groups.map((g) => `<optgroup label="${esc(g)}">${gmap.get(g).map((k) =>
    `<option value="${k}"${k === cur ? " selected" : ""}>${esc(ROUTES[k].label)}</option>`).join("")}</optgroup>`).join("");
}

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
      ${appearanceSection()}
    </div>`;
  wireNotify(root, me);
  wireAppearance(root);
}

// 外観・起動（テーマ＋起動既定ビュー）。変更は即 localStorage 保存・即反映。
function appearanceSection() {
  const mode = getThemeMode();
  const themeOpts = THEME_MODES.map((m) =>
    `<option value="${m.v}"${m.v === mode ? " selected" : ""}>${m.label}</option>`).join("");
  return `
    <section class="sx-card">
      <header class="sx-chd">
        <div class="sx-ctitle">外観・起動</div>
        <span class="sx-scope"><span class="dot" style="background:${C.fill}"></span>この端末のみ・変更は即保存</span>
      </header>
      <div class="sx-body">
        <div class="sx-row">
          <div class="sx-label"><div class="sx-rt">テーマ</div>
            <div class="sx-rd">画面の配色。「OSに合わせる」は端末のダーク/ライト設定に追従します。</div></div>
          <div class="sx-rc"><select id="st-theme" class="sx-in">${themeOpts}</select></div>
        </div>
        <div class="sx-row">
          <div class="sx-label"><div class="sx-rt">起動時に開くビュー</div>
            <div class="sx-rd">アプリを開いたときに最初に表示する画面。</div></div>
          <div class="sx-rc"><select id="st-startview" class="sx-in">${startViewOptionsHtml(getStartView())}</select></div>
        </div>
      </div>
    </section>`;
}

function wireAppearance(root) {
  const theme = root.querySelector("#st-theme");
  const startview = root.querySelector("#st-startview");
  if (theme) theme.onchange = () => applyThemeMode(theme.value);
  if (startview) startview.onchange = () => {
    try { localStorage.setItem(STARTVIEW_KEY, startview.value); } catch { /* noop */ }
  };
}

// ── チーム設定モード ─────────────────────────────────────────────
// チーム共有設定（exec で管理者保存）＋ 祝日・休業日（即時CRUD）。
async function renderTeam(root) {
  const { holidaysByDate, members, me, tasks } = await load();
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
  // 分類の使用件数（タスクの labels から集計＝label.id -> 件数）。store の tasks は除外WSを除いた本番タスク。
  const labelCounts = countLabelUsage(tasks);

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

      ${labelSection(labels, labelCounts)}

      ${canEdit ? menuVisibilitySection(members, me) : ""}

      ${canEdit ? `
      <div class="sx-savebar">
        <span class="sx-savemeta">変更は<b>保存するまで反映されません</b></span>
        <span class="sx-msg" id="st-msg"></span>
        <button id="st-save" class="sx-save">変更を保存</button>
      </div>` : ""}
    </div>`;

  wireHolidays(root, holidays, holidaysByDate);
  wireLabels(root, labels, labelCounts);
  if (canEdit) wireMenuVisibility(root, members, me, (cur && cur.menu_visibility) || {});

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
  // 年の選択肢（祝日が属する年・降順）。
  const years = [...new Set(sorted.map((h) => String(h.date).slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const yearOpts = `<option value="">すべての年</option>` +
    years.map((y) => `<option value="${y}">${y}年</option>`).join("");
  return `
    <section class="sx-card">
      <header class="sx-chd">
        <div class="sx-ctitle">祝日・休業日 <span class="sx-hcnt" id="hol-cnt">${sorted.length}</span></div>
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
        ${holidayBulkHtml()}
        <div class="sx-hfilter">
          <div class="sx-hsearch">${icon("search", { size: 14 })}<input id="hol-q" class="sx-in" placeholder="名称で検索" autocomplete="off"></div>
          <select id="hol-year" class="sx-in">${yearOpts}</select>
          <label class="sx-hchk"><input type="checkbox" id="hol-hidepast"><span>過去を隠す</span></label>
        </div>
        <div class="sx-hlist" id="hol-list"></div>
      </div>
    </section>`;
}

// C13: 祝日の一括登録（折りたたみ）。期間（開始〜終了）の各日を直列で createHoliday。
// 「毎年」チェックで今年から数年分（BULK_YEARS）に同じ月日を展開して登録する。
// 既存の単発追加フォーム/検索/CRUD には触れず、自己完結のパネルとして増設する。
const BULK_YEARS = 3; // 「毎年」展開する年数（今年から）。
function holidayBulkHtml() {
  return `
    <details class="sx-hbulk" id="hol-bulk">
      <summary class="sx-hbsum">期間でまとめて登録</summary>
      <div class="sx-hbbody">
        <div class="sx-hbhint">開始〜終了の各日を登録します（既にある日付はスキップ）。連休・閉所期間の一括登録に。</div>
        <div class="sx-hbrow">
          <input id="holb-from" class="sx-in sx-hdate" inputmode="numeric" autocomplete="off" placeholder="開始（例: 1228）">
          <span class="sx-dash">〜</span>
          <input id="holb-to" class="sx-in sx-hdate" inputmode="numeric" autocomplete="off" placeholder="終了（例: 0103）">
        </div>
        <div class="sx-hbrow">
          <input id="holb-name" class="sx-in sx-hname" placeholder="名称（例: 年末年始休業）">
          <label class="sx-hchk"><input type="checkbox" id="holb-yearly"><span>毎年（今年から${BULK_YEARS}年分）</span></label>
          <button class="sx-hadd" id="holb-run">一括登録</button>
        </div>
        <div class="sx-herr" id="holb-err"></div>
        <div class="sx-hbprog" id="holb-prog" hidden></div>
      </div>
    </details>`;
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

  wireHolidayBulk(root, sorted, holidaysByDate, reload);

  // 検索・年フィルタ・「過去を隠す」: クライアント側で絞り込み、リストを描き直す（CRUDは壊さない）。
  const listEl = root.querySelector("#hol-list");
  const cntEl = root.querySelector("#hol-cnt");
  const qEl = root.querySelector("#hol-q");
  const yearEl = root.querySelector("#hol-year");
  const hidePastEl = root.querySelector("#hol-hidepast");
  const todayISO = new Date().toISOString().slice(0, 10);

  const renderList = () => {
    const q = (qEl.value || "").trim().toLowerCase();
    const year = yearEl.value || "";
    const hidePast = !!hidePastEl.checked;
    const shown = sorted.filter((h) => {
      const iso = String(h.date).slice(0, 10);
      if (q && !String(h.name || "").toLowerCase().includes(q)) return false;
      if (year && iso.slice(0, 4) !== year) return false;
      if (hidePast && iso < todayISO) return false;
      return true;
    });
    if (cntEl) cntEl.textContent = shown.length === sorted.length ? String(sorted.length) : `${shown.length}/${sorted.length}`;
    if (!shown.length) {
      listEl.innerHTML = `<div class="sx-hempty">${sorted.length ? "条件に一致する項目がありません" : "まだありません"}</div>`;
      return;
    }
    listEl.innerHTML = shown.map((h) => {
      const iso = String(h.date).slice(0, 10);
      const past = iso < todayISO;
      return `<div class="sx-hrow${past ? " past" : ""}">
        <div class="sx-hmain"><div class="sx-ht">${fmtDisplayDow(iso)}</div><div class="sx-hsub">${esc(h.name)}</div></div>
        <button class="sx-hdel" data-hol-del="${h.id}">削除</button>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-hol-del]").forEach((b) => {
      b.onclick = async () => {
        const h = sorted.find((x) => x.id === +b.dataset.holDel);
        if (!h || !confirm(`祝日「${h.name}」を削除しますか？`)) return;
        b.disabled = true;
        try { await deleteHoliday(h.id); reload(); } catch (e) { b.disabled = false; alert("削除に失敗: " + e.message); }
      };
    });
  };
  qEl.oninput = renderList;
  yearEl.onchange = renderList;
  hidePastEl.onchange = renderList;
  renderList();
}

// C13: 期間（開始〜終了）の各日を直列 createHoliday。「毎年」で今年から BULK_YEARS 年分に展開。
//   - 開始から終了まで1日ずつ enumerate（UTCで日付計算＝DST影響なし）。
//   - 既存日付（holidaysByDate / 同バッチ内で登録済み）はスキップして二重登録を防ぐ。
//   - 連打防止: 実行中は run ボタンを無効化。進捗（n/total）とエラー件数を逐次表示。
//   - 完了後は reload()（invalidate→再描画）でリストへ反映。途中失敗は集計して通知し、成功分はそのまま残す。
function wireHolidayBulk(root, existing, holidaysByDate, reload) {
  const runBtn = root.querySelector("#holb-run");
  if (!runBtn) return;
  const fromEl = root.querySelector("#holb-from");
  const toEl = root.querySelector("#holb-to");
  const nameEl = root.querySelector("#holb-name");
  const yearlyEl = root.querySelector("#holb-yearly");
  const err = root.querySelector("#holb-err");
  const prog = root.querySelector("#holb-prog");

  // 範囲入力にもカレンダーピッカー＋blur整形（単発入力と同じ作法）。
  attachDatePicker(fromEl, { holidaysByDate });
  attachDatePicker(toEl, { holidaysByDate });
  fromEl.onblur = () => { const iso = parseSmartDate(fromEl.value); if (iso) fromEl.value = fmtDisplayDow(iso); };
  toEl.onblur = () => { const iso = parseSmartDate(toEl.value); if (iso) toEl.value = fmtDisplayDow(iso); };

  // ISO日付(YYYY-MM-DD)を1日進める（UTC基準）。
  const nextDay = (iso) => {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  // 開始(月日)〜終了(月日)を年 y に当てはめて日付配列を作る（終了 < 開始なら翌年へまたぐ）。
  const datesForYear = (fromISO, toISO, y) => {
    const mmddFrom = fromISO.slice(5), mmddTo = toISO.slice(5);
    const start = `${y}-${mmddFrom}`;
    // 終了の月日が開始より前なら年末年始など年またぎ＝終了を翌年に。
    const end = (mmddTo < mmddFrom) ? `${y + 1}-${mmddTo}` : `${y}-${mmddTo}`;
    const out = [];
    let cur = start;
    // 暴走防止のため最大2年分(=約740日)で打ち切り。
    for (let guard = 0; guard < 740 && cur <= end; guard++) { out.push(cur); cur = nextDay(cur); }
    return out;
  };

  runBtn.onclick = async () => {
    err.textContent = "";
    const fromISO = parseSmartDate(fromEl.value);
    const toISO = parseSmartDate(toEl.value);
    const name = (nameEl.value || "").trim();
    if (!fromISO) { err.textContent = "開始日の形式が不正です（例: 1228 → 12/28）。"; return; }
    if (!toISO) { err.textContent = "終了日の形式が不正です（例: 0103 → 1/3）。"; return; }
    if (!name) { err.textContent = "名称を入力してください。"; return; }
    const yearly = !!yearlyEl.checked;

    // 登録対象の日付集合を構築（重複排除）。毎年なら今年から BULK_YEARS 年分を展開。
    const set = new Set();
    if (yearly) {
      const thisYear = new Date().getFullYear();
      for (let i = 0; i < BULK_YEARS; i++) {
        for (const d of datesForYear(fromISO, toISO, thisYear + i)) set.add(d);
      }
    } else {
      // 単発: 入力された年そのまま。終了が開始より前なら翌年へまたぐ扱い。
      let cur = fromISO;
      let end = (toISO < fromISO) ? `${+toISO.slice(0, 4) + 1}-${toISO.slice(5)}` : toISO;
      // 年またぎ防止が効くよう、終了は最低でも開始以上に。
      if (end < fromISO) end = fromISO;
      for (let guard = 0; guard < 740 && cur <= end; guard++) { set.add(cur); cur = nextDay(cur); }
    }

    // 既存日付（store の holidaysByDate）はスキップ。日付昇順で直列登録。
    const have = holidaysByDate || {};
    const targets = [...set].sort().filter((iso) => !have[iso]);
    const skipped = set.size - targets.length;

    if (!targets.length) {
      prog.hidden = false; prog.className = "sx-hbprog ok";
      prog.innerHTML = `${icon("check", { size: 13 })} 追加対象がありません（${set.size}日はすべて登録済み）`;
      return;
    }

    // 連打防止＋進捗表示。
    runBtn.disabled = true; fromEl.disabled = toEl.disabled = nameEl.disabled = yearlyEl.disabled = true;
    prog.hidden = false; prog.className = "sx-hbprog";
    let done = 0; const errors = [];
    const total = targets.length;
    const showProg = () => { prog.textContent = `登録中… ${done}/${total}${errors.length ? `（失敗 ${errors.length}）` : ""}`; };
    showProg();
    for (const iso of targets) {
      try { await createHoliday({ date: iso + "T00:00:00Z", name }); }
      catch (e) { errors.push(`${iso}: ${e && e.message ? e.message : e}`); }
      done++; showProg();
    }

    const ok = done - errors.length;
    if (errors.length) {
      prog.className = "sx-hbprog err";
      prog.textContent = `${ok}件登録${skipped ? `・${skipped}件スキップ` : ""}・${errors.length}件失敗（${errors.slice(0, 2).join(" / ")}${errors.length > 2 ? " …" : ""}）`;
      // 一部成功している可能性があるのでリストへ反映。入力は再操作できるよう戻す。
      runBtn.disabled = false; fromEl.disabled = toEl.disabled = nameEl.disabled = yearlyEl.disabled = false;
      if (ok > 0) reload();
      return;
    }
    prog.className = "sx-hbprog ok";
    prog.innerHTML = `${icon("check", { size: 13 })} ${ok}件登録しました${skipped ? `（${skipped}件は登録済みでスキップ）` : ""}`;
    reload();
  };
}

// 分類（ラベル）マスタ: ユーザー定義の分類ラベルを管理する自己完結セクション。
// 予約ラベル（レビュー・連絡待ち）は kind/ステータス判定に使うので編集・削除させない（保護）。
const RESERVED_LABELS = new Set([REVIEW_LABEL, WAITING_LABEL]);
const isReserved = (l) => RESERVED_LABELS.has(l.title || "");
// 分類の使用件数: タスクの labels[] を走査して label.id -> 件数 を作る（store の tasks＝本番タスク）。
function countLabelUsage(tasks) {
  const m = new Map();
  for (const t of tasks || []) for (const l of t.labels || []) {
    if (l && l.id != null) m.set(l.id, (m.get(l.id) || 0) + 1);
  }
  return m;
}
// 色を #rrggbb に正規化（input type=color は # 必須。Vikunja は # 無しで返すことがある）。
function normHex(c) {
  if (!c) return "#3a86ff";
  const h = String(c).startsWith("#") ? c : "#" + c;
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : "#3a86ff";
}

// 1分類行（編集可）。使用件数バッジ付き（0件は淡色「未使用」）。
function labelRowHtml(l, counts) {
  const hex = normHex(l.hex_color);
  const n = (counts && counts.get(l.id)) || 0;
  const cnt = n > 0
    ? `<span class="sx-lbcnt" title="このラベルが付いたタスク数">${n}件</span>`
    : `<span class="sx-lbcnt zero" title="使用中のタスクはありません">未使用</span>`;
  return `<div class="sx-lbrow" data-lb="${l.id}" data-lbtitle="${esc((l.title || "").toLowerCase())}">
    <input type="color" class="sx-lbcolor" value="${hex}" data-lb-color="${l.id}" title="色を変更">
    <span class="sx-lbname">${esc(l.title || "")}</span>
    ${cnt}
    <div class="sx-lbacts">
      <button class="sx-lbbtn" data-lb-rename="${l.id}">改名</button>
      <button class="sx-lbbtn sx-lbdel" data-lb-del="${l.id}">削除</button>
    </div>
  </div>`;
}

function labelSection(labels, counts) {
  const all = [...(labels || [])].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "ja"));
  const editable = all.filter((l) => !isReserved(l));
  const reserved = all.filter(isReserved);
  const rows = editable.length
    ? editable.map((l) => labelRowHtml(l, counts)).join("")
    : `<div class="sx-hempty">まだ分類がありません</div>`;
  const reservedRows = reserved.map((l) => {
    const hex = normHex(l.hex_color);
    const n = (counts && counts.get(l.id)) || 0;
    return `<div class="sx-lbrow res" data-lbtitle="${esc((l.title || "").toLowerCase())}">
      <span class="sx-lbsw" style="background:${hex}"></span>
      <span class="sx-lbname">${esc(l.title || "")}</span>
      ${n > 0 ? `<span class="sx-lbcnt">${n}件</span>` : ""}
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
        <div class="sx-hfilter">
          <div class="sx-hsearch">${icon("search", { size: 14 })}<input id="lb-q" class="sx-in" placeholder="分類名で検索" autocomplete="off"></div>
        </div>
        <div class="sx-hlist" id="lb-list">${rows}${reservedRows}</div>
      </div>
    </section>`;
}

function wireLabels(root, labels, counts) {
  const reload = () => { invalidate(); render(root); };
  const addBtn = root.querySelector("#lb-add");
  if (!addBtn) return;
  const err = root.querySelector("#lb-err");
  const byId = (id) => (labels || []).find((l) => l.id === id);

  // 分類名で検索（クライアント側で行を表示/非表示。CRUDのハンドラは行に残したまま）。
  const qEl = root.querySelector("#lb-q");
  const listEl = root.querySelector("#lb-list");
  if (qEl && listEl) {
    qEl.oninput = () => {
      const q = (qEl.value || "").trim().toLowerCase();
      let shown = 0;
      listEl.querySelectorAll(".sx-lbrow").forEach((row) => {
        const hit = !q || (row.dataset.lbtitle || "").includes(q);
        row.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      let empty = listEl.querySelector(".sx-lbnohit");
      if (!shown && q) {
        if (!empty) {
          empty = document.createElement("div");
          empty.className = "sx-hempty sx-lbnohit";
          empty.textContent = "条件に一致する分類がありません";
          listEl.appendChild(empty);
        }
        empty.style.display = "";
      } else if (empty) {
        empty.style.display = "none";
      }
    };
  }

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
      const n = (counts && counts.get(id)) || 0;
      const impact = n > 0
        ? `この分類は ${n}件のタスクに付いています。\n削除すると、それらのタスクからは自動で外れます。`
        : `使用中のタスクはありません。`;
      if (!confirm(`分類「${l.title}」を削除しますか？\n${impact}`)) return;
      b.disabled = true;
      try { await deleteLabel(id); reload(); }
      catch (e) { b.disabled = false; err.textContent = "× " + e.message; }
    };
  });
}

// ── メニュー表示（管理者専用）─────────────────────────────────────
// 各メンバーごとに、左ナビに出すメニューを ON/OFF する。チェック=表示。保存先はチーム設定の
// menu_visibility（非表示ルートキーの配列＝ブロックリスト）。未設定メンバーは全表示＝現状維持。
// home は必須（ALWAYS_VISIBLE）なので常時 ON・変更不可。変更は即保存＝対象者の次回読み込みで反映。
function menuVisibilitySection(members, me) {
  const list = uniqMembers(members, me);
  return `
    <section class="sx-card">
      <header class="sx-chd">
        <div class="sx-ctitle">メニュー表示</div>
        <span class="sx-scope"><span class="dot" style="background:${C.free}"></span>変更は即保存・対象者の次回読み込みで反映</span>
      </header>
      <div class="sx-body">
        <div class="sx-mvhint">行＝メンバー、列＝メニュー項目のマトリクスです（チェック＝表示）。最上段の<b>既定（全員）</b>行で全員から一括で隠せます。各メンバー行はそのメンバーを<b>さらに</b>隠します（既定との和）。既定で隠した項目はメンバー行では淡色・変更不可になります。各行・各列の見出しで一括ON/OFF、左上で全員一括もできます。<b>ホーム</b>は常に表示されます。</div>
        ${list.length ? `
        <div class="sx-mvbulk">
          <button class="sx-mvbtn" id="mv-all-on">全員すべて表示</button>
          <button class="sx-mvbtn" id="mv-all-off">全員すべて非表示</button>
          <span class="sx-msg" id="mv-msg"></span>
        </div>
        <div class="sx-mvtblwrap"><div id="mv-matrix"></div></div>`
        : `<div class="sx-hempty">対象メンバーがいません（タスク担当・定期・休暇のいずれかを持つ人が対象です）。</div>`}
      </div>
    </section>`;
}

// メンバー一覧の重複排除（me を先頭に。id 無しは除外）。
function uniqMembers(members, me) {
  const out = [], seen = new Set();
  const push = (u) => { if (u && u.id && !seen.has(u.id)) { seen.add(u.id); out.push(u); } };
  push(me);
  for (const u of members || []) push(u);
  return out;
}

function wireMenuVisibility(root, members, me, mvInit) {
  const host = root.querySelector("#mv-matrix");
  const msg = root.querySelector("#mv-msg");
  if (!host) return;
  // 非表示マップのローカル複製（{uid: [hiddenKey,...]}）。
  const mv = {};
  for (const k of Object.keys(mvInit || {})) mv[k] = [...(mvInit[k] || [])];
  // 行＝メンバー、列＝ナビに出る対象ルート（ORDER）。home は必須なので常時 ON・無効化。
  const list = uniqMembers(members, me);
  const keys = ORDER.slice();
  // grp ごとに列をまとめる（ORDER 順を保つ）。ヘッダのグループ行に使う。
  const groups = [];
  const gmap = new Map();
  for (const k of keys) {
    const g = ROUTES[k].grp;
    if (!gmap.has(g)) { gmap.set(g, []); groups.push(g); }
    gmap.get(g).push(k);
  }
  const memberName = (u) => esc(u.name || u.username || ("user" + u.id));

  // マトリクス（table）を1回だけ構築。チェック状態は mv から初期化、その後はDOMが真実源。
  const buildMatrix = () => {
    const grpHeader = groups.map((g) =>
      `<th class="sx-mvgrph" colspan="${gmap.get(g).length}">${esc(g)}</th>`).join("");
    const colHeader = keys.map((k) => {
      const forced = ALWAYS_VISIBLE.has(k);
      // 列見出し＝項目名。クリックでその列を全員一括トグル（forced列は無効）。
      return `<th class="sx-mvch${forced ? " forced" : ""}"${forced ? "" : ` data-mvcol="${k}" title="クリックでこの列を全員一括"`}>
        <span class="sx-mvchl">${esc(ROUTES[k].label)}</span>
      </th>`;
    }).join("");
    // 既定（全員）の非表示集合。実行時の各ユーザー非表示は「_default ∪ 個別」（和集合・app.js側で実装済み）。
    const defHidden = new Set(mv["_default"] || []);
    // 既定（全員）行＝tbody 先頭。トグルで全員から一括で隠す/出す。home は forced。
    const defCells = keys.map((k) => {
      const forced = ALWAYS_VISIBLE.has(k);
      const on = forced || !defHidden.has(k);
      return `<td class="sx-mvtd">
        <input type="checkbox" data-mv-uid="_default" data-mvk="${k}"${on ? " checked" : ""}${forced ? " disabled" : ""}>
      </td>`;
    }).join("");
    const defRow = `<tr class="sx-mvdefrow">
      <th class="sx-mvrh sx-mvdefrh" data-mvrow="_default" title="クリックでこの既定行を一括">既定（全員）</th>
      ${defCells}
    </tr>`;
    const bodyRows = list.map((u) => {
      const indivHidden = new Set(mv[String(u.id)] || []);
      const cells = keys.map((k) => {
        const forced = ALWAYS_VISIBLE.has(k);
        const defOff = defHidden.has(k);   // 既定で全員非表示
        const indivOff = indivHidden.has(k); // この人だけさらに非表示
        const on = forced || (!defOff && !indivOff); // 実効表示
        // forced か defOff の列はメンバー個別では変更不可（和集合の意味＝既定で隠れたら個別では戻せない）。
        const disabled = forced || defOff;
        const cls = "sx-mvtd" + (defOff && !forced ? " sx-mvtd-defoff" : "");
        const title = (defOff && !forced) ? ' title="「既定（全員）」で非表示中"' : "";
        return `<td class="${cls}"${title}>
          <input type="checkbox" data-mv-uid="${u.id}" data-mvk="${k}"${on ? " checked" : ""}${disabled ? " disabled" : ""}>
        </td>`;
      }).join("");
      // 行見出し＝メンバー名。クリックでその行を全項目一括トグル。
      return `<tr>
        <th class="sx-mvrh" data-mvrow="${u.id}" title="クリックでこのメンバーを一括">${memberName(u)}</th>
        ${cells}
      </tr>`;
    }).join("");
    host.innerHTML = `
      <table class="sx-mvtbl">
        <thead>
          <tr><th class="sx-mvcorner" rowspan="2">メンバー</th>${grpHeader}</tr>
          <tr>${colHeader}</tr>
        </thead>
        <tbody>${defRow}${bodyRows}</tbody>
      </table>`;
    // セル変更: メンバー行はそのまま保存、既定行は既定集合が変わる＝メンバー行の表示が変わるので rebuild。
    host.querySelectorAll("input[data-mvk]").forEach((cb) => {
      cb.onchange = (cb.dataset.mvUid === "_default") ? scheduleSaveRebuild : scheduleSave;
    });
    // 列一括（見出しクリック）: 列内の有効チェックボックスを、現状が全ONなら全OFFへ、でなければ全ONへ。
    // 列は既定行セルも含む＝既定に影響しうるので必ず rebuild。
    host.querySelectorAll("th[data-mvcol]").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.mvcol;
        const cbs = [...host.querySelectorAll(`input[data-mvk="${cssEsc(k)}"]:not(:disabled)`)];
        const next = !cbs.every((c) => c.checked);
        cbs.forEach((c) => { c.checked = next; });
        scheduleSaveRebuild();
      };
    });
    // 行一括（行見出しクリック）。既定行（_default）は既定集合が変わるので rebuild、メンバー行は通常保存。
    host.querySelectorAll("th[data-mvrow]").forEach((th) => {
      th.onclick = () => {
        const uid = th.dataset.mvrow;
        const cbs = [...host.querySelectorAll(`input[data-mv-uid="${cssEsc(uid)}"]:not(:disabled)`)];
        const next = !cbs.every((c) => c.checked);
        cbs.forEach((c) => { c.checked = next; });
        (uid === "_default") ? scheduleSaveRebuild() : scheduleSave();
      };
    });
  };

  // 保存の直列化＋デバウンス（M10 を維持）。
  // ・連打しても最後の状態に収束するよう、保存は 350ms デバウンス。
  // ・前の保存の完了を待ってから次を投げる（_mvSaving チェーン）ことで順序逆転を防ぐ。
  // ・mv は scheduleSave のたびに DOM 全体から再構築（applyToMv）するため、発火時は常に最新スナップショット。
  let _mvSaving = Promise.resolve(); // 進行中の保存（直列化用）
  let _mvTimer = null;               // デバウンスタイマー
  const MV_DEBOUNCE = 350;

  // マトリクスに出ている uid 集合（行＝現在の対象メンバー ＋ 既定行 _default）。
  // _default を含めることで applyToMv 冒頭で既定行の旧設定を delete→作り直し、最新状態を反映できる。
  const visibleUids = new Set([...list.map((u) => String(u.id)), "_default"]);

  // マトリクス全体の現在のチェック状態から mv（{uid: [hiddenKey,...], _default: [...]}）を作り直す。
  // ※マトリクスに出ていない uid（過去に設定したが今は対象外の人）の既存設定は壊さず温存する。
  const applyToMv = () => {
    for (const k of Object.keys(mv)) if (visibleUids.has(k)) delete mv[k]; // 表示中の行（＋既定行）だけ作り直す
    const perUser = new Map();
    host.querySelectorAll("input[data-mvk]").forEach((cb) => {
      const uid = cb.dataset.mvUid, k = cb.dataset.mvk;
      // forced（ALWAYS_VISIBLE）と disabled セル（メンバー行で既定非表示の列）は記録しない。
      // ＝既定で隠れた列を個別 hidden に重複記録せず、和集合の意味を保つ。
      if (!cb.checked && !ALWAYS_VISIBLE.has(k) && !cb.disabled) {
        const arr = perUser.get(uid) || []; arr.push(k); perUser.set(uid, arr);
      }
    });
    for (const [uid, arr] of perUser) if (arr.length) mv[uid] = arr;
  };

  // mv の現在値を実際に永続化（直列化チェーンの末尾に積む）。
  const flushSave = () => {
    if (msg) { msg.className = "sx-msg"; msg.textContent = "保存中…"; }
    _mvSaving = _mvSaving
      .catch(() => {}) // 前回失敗は飲み込み、後続は最新 mv で続行
      .then(async () => {
        // この時点での mv（最新スナップショット）を保存。
        const snapshot = {};
        for (const k of Object.keys(mv)) snapshot[k] = [...mv[k]];
        try {
          await saveMenuVisibility(snapshot);
          invalidate(); // 次回 load() で反映
          if (msg) { msg.className = "sx-msg ok"; msg.innerHTML = `${icon("check", { size: 14 })} 保存しました`; }
        } catch (e) {
          if (msg) { msg.className = "sx-msg err"; msg.textContent = "× " + e.message; }
        }
      });
    return _mvSaving;
  };

  // 保存のデバウンス（mv は呼び出し前に applyToMv 済みの前提）。
  const debouncedSave = () => {
    if (_mvTimer) clearTimeout(_mvTimer);
    _mvTimer = setTimeout(() => { _mvTimer = null; flushSave(); }, MV_DEBOUNCE);
  };
  // メンバー行用：mv を即時更新し、保存をデバウンス（rebuild 不要）。
  function scheduleSave() {
    applyToMv();
    debouncedSave();
  }
  // 既定行・列見出し一括・全員ボタン用：既定集合が変わるとメンバー行の disabled/checked が変わるため、
  // 反映してから DOM を再構築（buildMatrix）して実効状態に揃える。
  const scheduleSaveRebuild = () => {
    applyToMv();
    buildMatrix();
    debouncedSave();
  };

  // 全員一括（左上ボタン）: 全行×全列の有効チェックを一括設定。
  // メンバー行の defOff セルは disabled なので触れず、既定行とメンバー行の有効セルだけ動く。rebuild で整合。
  const setAll = (on) => {
    host.querySelectorAll("input[data-mvk]:not(:disabled)").forEach((cb) => { cb.checked = on; });
    scheduleSaveRebuild();
  };
  const onBtn = root.querySelector("#mv-all-on");
  const offBtn = root.querySelector("#mv-all-off");
  if (onBtn) onBtn.onclick = () => setAll(true);
  if (offBtn) offBtn.onclick = () => setAll(false);

  buildMatrix();
}

// CSS セレクタ用の最小エスケープ（ルートキー/uid は英数記号のみだが念のため）。
function cssEsc(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
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

  /* C13: 期間一括登録（折りたたみ）。単発フォームの下に控えめに置く */
  .sx-hbulk{margin:10px 0 0;border:1px solid var(--line);border-radius:10px;background:var(--track);overflow:hidden}
  .sx-hbsum{font-size:12.5px;font-weight:700;color:${C.ink};padding:10px 14px;cursor:pointer;list-style:none;user-select:none}
  .sx-hbsum::-webkit-details-marker{display:none}
  .sx-hbsum::before{content:"＋";display:inline-block;margin-right:8px;color:${C.muted};font-weight:700}
  .sx-hbulk[open] .sx-hbsum::before{content:"－"}
  .sx-hbsum:hover{color:${C.fill}}
  .sx-hbbody{padding:2px 14px 14px;border-top:1px solid var(--line);background:var(--card)}
  .sx-hbhint{font-size:11.5px;color:${C.muted};line-height:1.55;padding:12px 0 0}
  .sx-hbrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 0 0}
  .sx-hbprog{font-size:12px;font-weight:700;color:${C.muted};margin:8px 0 0;min-height:14px;display:flex;align-items:center;gap:5px}
  .sx-hbprog.ok{color:${C.free}}
  .sx-hbprog.err{color:${C.over}}

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
  /* 使用件数バッジ（分類） */
  .sx-lbcnt{flex:none;font-size:11px;font-weight:700;color:${C.muted};background:var(--track);
    border:1px solid var(--line);padding:2px 9px;border-radius:999px;white-space:nowrap}
  .sx-lbcnt.zero{opacity:.7;font-weight:600}

  /* 検索・フィルタ行（祝日・分類で共有） */
  .sx-hfilter{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 0 2px}
  .sx-hsearch{position:relative;display:inline-flex;align-items:center;flex:1;min-width:160px}
  .sx-hsearch svg{position:absolute;left:11px;color:${C.muted};pointer-events:none}
  .sx-hsearch .sx-in{width:100%;padding-left:33px}
  .sx-hfilter > .sx-in{flex:0 0 auto}
  .sx-hchk{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:${C.ink};cursor:pointer;white-space:nowrap}
  .sx-hchk input{width:15px;height:15px;cursor:pointer}

  /* メニュー表示（管理者）: 行=メンバー × 列=メニュー のマトリクス表 */
  .sx-mvhint{font-size:12.5px;color:${C.muted};line-height:1.5;margin-bottom:12px}
  .sx-mvbulk{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
  .sx-mvbtn{font:inherit;font-size:12px;font-weight:700;padding:7px 14px;border-radius:8px;
    border:1px solid var(--line-strong);background:var(--card);color:${C.ink};cursor:pointer;transition:border-color .12s,color .12s}
  .sx-mvbtn:hover{border-color:${C.fill};color:${C.fill}}
  .sx-mvtblwrap{overflow:auto;border:1px solid var(--line);border-radius:10px;max-height:60vh}
  .sx-mvtbl{border-collapse:separate;border-spacing:0;font-size:12.5px}
  .sx-mvtbl th,.sx-mvtbl td{border-bottom:1px solid var(--line);border-right:1px solid var(--line)}
  .sx-mvtbl thead th{position:sticky;top:0;z-index:2;background:var(--track);font-weight:700;color:${C.muted}}
  .sx-mvgrph{padding:6px 8px;text-align:center;font-size:10.5px;letter-spacing:.02em;border-bottom:1px solid var(--line)}
  .sx-mvch{padding:7px 6px;text-align:center;vertical-align:bottom;white-space:nowrap;cursor:pointer;user-select:none;min-width:54px}
  .sx-mvch:hover:not(.forced){color:${C.fill}}
  .sx-mvch.forced{cursor:default;opacity:.7}
  .sx-mvchl{display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);max-height:96px;font-size:11px}
  .sx-mvcorner{position:sticky;left:0;top:0;z-index:4;background:var(--track);padding:6px 12px;text-align:left;
    font-size:11px;font-weight:700;color:${C.muted}}
  .sx-mvrh{position:sticky;left:0;z-index:1;background:var(--card);padding:7px 12px;text-align:left;
    font-size:12.5px;font-weight:700;color:${C.ink};white-space:nowrap;cursor:pointer;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  .sx-mvrh:hover{color:${C.fill}}
  .sx-mvtd{padding:0;text-align:center}
  .sx-mvtd input{width:16px;height:16px;cursor:pointer;margin:7px auto;display:block}
  .sx-mvtd input:disabled{cursor:default;opacity:.4}
  /* 既定（全員）行＝最上段。区切り（下線太め）＋淡い面で強調、行見出しは太字 */
  .sx-mvdefrow td,.sx-mvdefrow th{background:var(--track);border-bottom:2px solid var(--line-strong)}
  .sx-mvdefrh{font-weight:800;color:${C.ink}}
  .sx-mvtbl tbody tr.sx-mvdefrow:hover td,.sx-mvtbl tbody tr.sx-mvdefrow:hover .sx-mvrh{background:var(--track)}
  /* 既定で全員非表示の列のメンバーセル＝淡色・変更不可（実効OFFの可視化） */
  .sx-mvtd-defoff input{opacity:.45}
  .sx-mvtbl tbody tr:hover td,.sx-mvtbl tbody tr:hover .sx-mvrh{background:var(--track)}

  /* ダークモード: ハードコードした淡色面/tintを反転（ライト値は不変） */
  html[data-theme="dark"] .sx-chd{background:var(--track)}
  html[data-theme="dark"] .sx-mvtbl thead th,
  html[data-theme="dark"] .sx-mvcorner{background:var(--card)}
  html[data-theme="dark"] .sx-mvrh{background:var(--card)}`;
}
