// タスク追加モーダルの MTG / 定例MTG / 定期タスク タブのパネル（taskform.js から呼ばれる）。
// すべて recurrences（RRULE・dumb storage）として保存。MTG=COUNT=1 の単発 occurrence。
// 定期タスクは「持ち回り」(rotation) 対応: 担当は assignee_ids を配列順に巡回（解釈は recurrence.js）。
import { createRecurrence, updateRecurrence } from "../lib/api.js";
import { invalidate } from "../lib/store.js";
import { C, esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { parseSmartDate, fmtDisplay, fmtDisplayDow, joinMeta, splitMeta, hourInputHtml, wireHourInput, docChipsHtml, wireDocChips, attachDatePicker, DOW_JA } from "../lib/form.js";
import { expandRecurrences } from "../lib/recurrence.js"; // 展開は lib に委譲（rrule.js 経由・自前計算しない）
import { todayISO as currentTodayISO } from "../lib/capacity.js"; // 「今日」はローカル暦日 SSoT

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]; // getUTCDay() の並び

// RRULE 組み立て（Googleカレンダー型: 「N 単位ごと」×単位別の詳細）。
//   unit: "weekly"|"monthly"|"daily" ＋ interval(1..99)
//   weekly → weekdays=[0..6]（日..土・複数可）
//   monthly → monthlyMode "same"(mday=1..31) | "nth"(nth=1..4/-1=最終, nthDow=0..6)
//   untilISO（任意）= 終了日（その日を含む）
//   freq:"once" は MTG タブ用の単発。
export function buildRRule({ freq = null, unit, interval = 1, weekdays = [], monthlyMode = "same", mday = 1, nth = 1, nthDow = 1, untilISO = null } = {}) {
  if (freq === "once") return "FREQ=DAILY;COUNT=1";
  const iv = interval > 1 ? `;INTERVAL=${interval}` : "";
  const until = untilISO ? `;UNTIL=${untilISO.replace(/-/g, "")}T235959Z` : "";
  if (unit === "daily") return `FREQ=DAILY${iv}${until}`;
  if (unit === "weekly") return `FREQ=WEEKLY${iv};BYDAY=${weekdays.map((i) => BYDAY[i]).join(",")}${until}`;
  if (monthlyMode === "nth") return `FREQ=MONTHLY${iv};BYDAY=${nth}${BYDAY[nthDow]}${until}`;
  return `FREQ=MONTHLY${iv};BYMONTHDAY=${mday}${until}`;
}

const UNIT_OPTS = [["weekly", "週間ごと"], ["monthly", "か月ごと"], ["daily", "日ごと"]];
const NTH_OPTS = [[1, "第1"], [2, "第2"], [3, "第3"], [4, "第4"], [-1, "最終"]];
const NTH_LABEL = { 1: "第1", 2: "第2", 3: "第3", 4: "第4", "-1": "最終" };

// 人間が読める繰り返し文（プレビュー）
export function rruleText({ unit, interval, weekdays, monthlyMode, mday, nth, nthDow }) {
  if (unit === "daily") return interval > 1 ? `${interval}日ごと` : "毎日";
  if (unit === "weekly") {
    const pre = interval === 1 ? "毎週" : interval === 2 ? "隔週" : `${interval}週間ごと`;
    const days = weekdays.length ? weekdays.map((i) => DOW_JA[i]).join("・") : "—";
    return `${pre} ${days}曜日`;
  }
  const pre = interval === 1 ? "毎月" : `${interval}か月ごと`;
  return monthlyMode === "nth" ? `${pre} ${NTH_LABEL[nth]}${DOW_JA[nthDow]}曜日` : `${pre} ${mday}日`;
}

// RRULE 文字列 → buildRRule が受け取る state（編集時のプレフィル用・buildRRule の逆写像）。
// 解釈できない要素は既定値に倒す（落とさない）。COUNT=1 の DAILY は単発(MTG)＝isOnce。
export function parseRRuleToState(rrule) {
  const p = {};
  for (const kv of String(rrule || "").split(";")) {
    const [k, v] = kv.split("=");
    if (k) p[k.toUpperCase()] = v;
  }
  const freq = p.FREQ;
  const interval = Math.max(1, Math.min(99, parseInt(p.INTERVAL, 10) || 1));
  const isOnce = freq === "DAILY" && p.COUNT === "1";
  let unit = "weekly", weekdays = [], monthlyMode = "same", mday = 1, nth = 1, nthDow = 1;
  if (freq === "DAILY") unit = "daily";
  else if (freq === "WEEKLY") {
    unit = "weekly";
    weekdays = String(p.BYDAY || "").split(",").map((d) => BYDAY.indexOf(d)).filter((i) => i >= 0);
  } else if (freq === "MONTHLY") {
    unit = "monthly";
    if (p.BYMONTHDAY) { monthlyMode = "same"; mday = Math.max(1, Math.min(31, parseInt(p.BYMONTHDAY, 10) || 1)); }
    else if (p.BYDAY) {
      monthlyMode = "nth";
      const m = String(p.BYDAY).match(/(-?\d+)([A-Z]{2})/);
      if (m) { nth = parseInt(m[1], 10); const di = BYDAY.indexOf(m[2]); if (di >= 0) nthDow = di; }
    }
  }
  let untilISO = null;
  const um = String(p.UNTIL || "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (um) untilISO = `${um[1]}-${um[2]}-${um[3]}`;
  return { isOnce, unit, interval, weekdays, monthlyMode, mday, nth, nthDow, untilISO };
}

// 既存 recurrence のUI種別（mtg=単発会議 / rmtg=定例MTG / rtask=定期タスク）を判定。
export function recurrenceMode(rec) {
  const st = parseRRuleToState(rec.rrule);
  if (rec.kind === "task") return "rtask";
  return st.isOnce ? "mtg" : "rmtg";
}

// 一覧表示用の要約（繰り返し文・開始時刻・所要・終了日）。
export function summarizeRecurrence(rec) {
  const st = parseRRuleToState(rec.rrule);
  const time = String(rec.dtstart || "").slice(11, 16);
  const hasTime = !!time && time !== "00:00";
  const durH = (rec.duration_seconds || 0) / 3600;
  const rep = st.isOnce
    ? "単発 " + fmtDisplay(String(rec.dtstart || "").slice(0, 10))
    : rruleText(st);
  return { rep, time: hasTime ? time : "", durTxt: durH ? `${Math.round(durH * 100) / 100}h` : "", untilISO: st.untilISO };
}

// "10:00"・"1000"・"930" → 0:00 からの分（不正は null。空は -1=時刻なし）
export function parseTimeOfDay(raw) {
  const s = String(raw || "").trim();
  if (!s) return -1;
  const m = s.match(/^(\d{1,2})[:：]?(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// パネル描画。mode: "mtg"(単発会議) | "rmtg"(定例MTG) | "rtask"(定期タスク)
// ctx: { members, onSaved, close, $err } — $err は親モーダルのエラー表示要素。
export function renderRecurrencePanel(el, mode, { members, onSaved, close, holidaysByDate = null, existing = null }) {
  const isMtg = mode === "mtg";
  const isTask = mode === "rtask";
  const kind = isTask ? "task" : "meeting";
  const isEdit = !!existing;
  const todayISO = currentTodayISO(); // ローカル暦日（UTCだとJST早朝に前日へズレる＝B5と一貫）
  // 編集時のプレフィル元
  const exMeta = existing ? splitMeta(existing.note) : null;
  const exState = existing ? parseRRuleToState(existing.rrule) : null;
  const exDateISO = existing ? String(existing.dtstart || "").slice(0, 10) : todayISO;
  const exTime = existing ? String(existing.dtstart || "").slice(11, 16) : "";
  const exHasTime = !!exTime && exTime !== "00:00";
  const sel = isEdit ? [...(existing.assignee_ids || [])] : []; // 選択済みメンバー（順序が持ち回りの順番）

  el.innerHTML = `
    <label class="tf-l">タイトル <span class="tf-req">*</span></label>
    <input id="rf-title" class="tf-in" type="text" value="${esc(existing ? existing.title : "")}" placeholder="${isMtg ? "例: 顧客定例キックオフ" : isTask ? "例: 週次バックアップ確認" : "例: チーム定例"}">
    ${isMtg ? `
    <div class="tf-row">
      <div class="tf-col">
        <label class="tf-l">日付 <span class="tf-req">*</span></label>
        <input id="rf-date" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fmtDisplayDow(todayISO)}" placeholder="例: 1112">
      </div>
      <div class="tf-col">
        <label class="tf-l">開始時刻 <span class="tf-hint">（任意・時刻カレンダーに表示）</span></label>
        <input id="rf-time" class="tf-in" type="text" inputmode="numeric" autocomplete="off" placeholder="例: 10:00">
      </div>
    </div>
    ` : `
    <label class="tf-l">繰り返し</label>
    <div class="rf-iv">
      <input id="rf-int" class="tf-in rf-int" type="text" inputmode="numeric" autocomplete="off" value="1">
      <select id="rf-unit" class="tf-in rf-unit">${UNIT_OPTS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>
      <div id="rf-dows" class="rf-dows">${DOW_JA.map((n, i) =>
        `<button type="button" class="rf-dowbtn" data-dow="${i}">${n}</button>`).join("")}</div>
      <div id="rf-monthly" class="rf-monthly" hidden>
        <label class="rf-radio"><input type="radio" name="rf-mm" value="same" checked>
          <select id="rf-mday" class="tf-in rf-mini">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select> 日</label>
        <label class="rf-radio"><input type="radio" name="rf-mm" value="nth">
          <select id="rf-nth-n" class="tf-in rf-mini">${NTH_OPTS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>
          <select id="rf-nth-dow" class="tf-in rf-mini">${DOW_JA.map((n, i) => `<option value="${i}">${n}曜日</option>`).join("")}</select></label>
      </div>
    </div>
    <div class="rf-prev" id="rf-prev"></div>
    <div class="rf-occ" id="rf-occ" hidden></div>
    <div class="tf-row">
      <div class="tf-col">
        <label class="tf-l">開始日 <span class="tf-hint">（起点）</span></label>
        <input id="rf-date" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fmtDisplayDow(todayISO)}" placeholder="例: 1112">
      </div>
      <div class="tf-col">
        <label class="tf-l">開始時刻 <span class="tf-hint">（任意）</span></label>
        <input id="rf-time" class="tf-in" type="text" inputmode="numeric" autocomplete="off" placeholder="例: 10:00">
      </div>
      <div class="tf-col">
        <label class="tf-l">終了日 <span class="tf-hint">（任意・空=ずっと）</span></label>
        <input id="rf-until" class="tf-in" type="text" inputmode="numeric" autocomplete="off" placeholder="例: 1231">
      </div>
    </div>
    `}
    <label class="tf-l">所要(h) <span class="tf-hint">（1回あたり・0.25刻み）</span></label>
    ${hourInputHtml("rf-dur", { value: isTask ? "0.5" : "1", placeholder: "例: 0.5" })}
    <label class="tf-l">${isTask ? "担当" : "参加者"} <span class="tf-req">*</span>${isTask ? ` <span class="tf-hint">（持ち回り時はこの順番で巡回）</span>` : ""}</label>
    <div id="rf-members" class="rf-members">${(members || []).map((m) =>
      `<label class="rf-mem"><input type="checkbox" data-mid="${m.id}"> ${esc(m.name || m.username)}</label>`).join("")}</div>
    ${isTask ? `
    <label class="tf-chk"><input id="rf-rot" type="checkbox"> 持ち回り <span class="tf-hint">（毎回1名が順番に担当。オフ=毎回全員）</span></label>
    <div id="rf-order" class="rf-order" hidden></div>
    ` : ""}
    <label class="tf-l">資料 <span class="tf-hint">（${isMtg || !isTask ? "MTG資料・アジェンダ等の" : ""}URLやパス・Enterで追加・複数可）</span></label>
    ${docChipsHtml("rf-doc")}
    <label class="tf-l">メモ</label>
    <input id="rf-note" class="tf-in" type="text" placeholder="任意">
    <div class="tf-err" id="rf-err"></div>
    <div class="rf-acts">
      <button class="tf-save" id="rf-save">追加</button>
    </div>`;

  const $ = (s) => el.querySelector(s);

  // ===== 繰り返し設定（Googleカレンダー型）=====
  // 単位に応じた詳細だけを表示: 週→曜日トグル / 月→「N日 or 第N曜日」ラジオ / 日→なし。
  // 既定値は開始日から提案し（曜日・日にち・第N曜）、ユーザーが触ったら追従を止める。
  const dateEl = $("#rf-date");
  const untilEl = $("#rf-until"); // 発生日プレビュー(updateOccPreview)が参照するため早期に取得（TDZ回避）
  const unitEl = $("#rf-unit"), intEl = $("#rf-int");
  const dowBtns = [...el.querySelectorAll(".rf-dowbtn")];
  let touchedDow = false, touchedMonthly = false;

  const startISO = () => parseSmartDate(dateEl.value);
  const readState = () => ({
    unit: unitEl ? unitEl.value : "weekly",
    interval: Math.max(1, Math.min(99, parseInt(intEl && intEl.value, 10) || 1)),
    weekdays: dowBtns.filter((b) => b.classList.contains("on")).map((b) => +b.dataset.dow),
    monthlyMode: el.querySelector('input[name="rf-mm"]:checked') ? el.querySelector('input[name="rf-mm"]:checked').value : "same",
    mday: +($("#rf-mday") && $("#rf-mday").value || 1),
    nth: +($("#rf-nth-n") && $("#rf-nth-n").value || 1),
    nthDow: +($("#rf-nth-dow") && $("#rf-nth-dow").value || 1),
  });

  const syncDefaults = () => {
    const iso = startISO();
    if (!iso) return;
    const d = new Date(iso + "T00:00:00Z");
    if (!touchedDow) {
      dowBtns.forEach((b) => b.classList.toggle("on", +b.dataset.dow === d.getUTCDay()));
    }
    if (!touchedMonthly && $("#rf-mday")) {
      $("#rf-mday").value = String(d.getUTCDate());
      $("#rf-nth-n").value = String(Math.min(4, Math.ceil(d.getUTCDate() / 7)));
      $("#rf-nth-dow").value = String(d.getUTCDay());
    }
  };

  // 今後の発生日プレビュー（B46）: 現在の設定値から先頭5件を算出してチップ表示。
  // 展開は expandRecurrences（lib・rrule.js）に委譲。開始日を起点に、終了日(任意)も考慮した
  // 仮の recurrence を組み、開始日〜十分先までの窓で展開して先頭5件を取り出す。
  const PREVIEW_N = 5;
  const updateOccPreview = () => {
    const box = $("#rf-occ");
    if (!box || !unitEl) return;
    const st = readState();
    const iso = startISO();
    if (!iso) { box.hidden = true; box.innerHTML = ""; return; }
    // 週次で曜日未選択など、展開不能な状態はプレビュー非表示（保存時バリデーションに委ねる）
    if (st.unit === "weekly" && !st.weekdays.length) { box.hidden = true; box.innerHTML = ""; return; }
    // 終了日: 入力欄が空なら無制限。窓上限は終了日 or 開始から約3年先（十分に5件拾える範囲）。
    let untilISO = null;
    if (untilEl && untilEl.value.trim()) {
      const u = parseSmartDate(untilEl.value);
      if (u && u >= iso) untilISO = u;
    }
    let rrule;
    try { rrule = buildRRule({ ...st, untilISO }); } catch { box.hidden = true; box.innerHTML = ""; return; }
    const horizon = new Date(iso + "T00:00:00Z");
    horizon.setUTCFullYear(horizon.getUTCFullYear() + 3);
    const toISO = untilISO && untilISO < horizon.toISOString().slice(0, 10) ? untilISO : horizon.toISOString().slice(0, 10);
    let occs = [];
    try {
      occs = expandRecurrences([{ rrule, dtstart: `${iso}T00:00:00Z`, assignee_ids: [] }], iso, toISO);
    } catch { box.hidden = true; box.innerHTML = ""; return; }
    const days = occs.map((o) => o.dateISO).sort().slice(0, PREVIEW_N);
    if (!days.length) { box.hidden = true; box.innerHTML = ""; return; }
    const more = occs.length > days.length ? `<span class="rf-occ-more">…</span>` : "";
    box.hidden = false;
    box.innerHTML = `<span class="rf-occ-lbl">今後の発生日</span>` +
      days.map((d) => `<span class="rf-occ-chip">${esc(fmtDisplayDow(d))}</span>`).join("") + more;
  };

  const syncFreqUI = () => {
    if (!unitEl) return;
    const st = readState();
    $("#rf-dows").hidden = st.unit !== "weekly";
    $("#rf-monthly").hidden = st.unit !== "monthly";
    const prev = $("#rf-prev");
    if (prev) prev.innerHTML = icon("repeat") + " " + esc(rruleText(st));
    updateOccPreview();
  };

  if (unitEl) {
    unitEl.onchange = syncFreqUI;
    intEl.oninput = syncFreqUI;
    dowBtns.forEach((b) => { b.onclick = () => { touchedDow = true; b.classList.toggle("on"); syncFreqUI(); }; });
    el.querySelectorAll('input[name="rf-mm"]').forEach((r) => { r.onchange = () => { touchedMonthly = true; syncFreqUI(); }; });
    ["#rf-mday", "#rf-nth-n", "#rf-nth-dow"].forEach((s) => {
      const x = $(s);
      if (x) x.onchange = () => {
        touchedMonthly = true;
        // セレクタを触ったら対応するラジオも選択（同じ日系 or 第N曜系）
        const radio = el.querySelector(`input[name="rf-mm"][value="${s === "#rf-mday" ? "same" : "nth"}"]`);
        if (radio) radio.checked = true;
        syncFreqUI();
      };
    });
    syncDefaults();
    syncFreqUI();
  }
  dateEl.onblur = () => {
    const iso = parseSmartDate(dateEl.value);
    if (iso) dateEl.value = fmtDisplayDow(iso);
    syncDefaults();
    syncFreqUI();
  };
  if (untilEl) untilEl.onblur = () => { const iso = parseSmartDate(untilEl.value); if (iso) untilEl.value = fmtDisplayDow(iso); syncFreqUI(); };
  // カレンダーピッカー（土日祝色分け・祝日名ツールチップ）
  attachDatePicker(dateEl, { holidaysByDate });
  if (untilEl) attachDatePicker(untilEl, { holidaysByDate });

  // メンバー選択: チェック順 = sel の順序 = 持ち回りの順番
  const orderBox = $("#rf-order");
  const renderOrder = () => {
    if (!orderBox) return;
    const rot = $("#rf-rot");
    orderBox.hidden = !(rot && rot.checked) || !sel.length;
    if (orderBox.hidden) { orderBox.innerHTML = ""; return; }
    const nameOf = (id) => { const m = (members || []).find((x) => x.id === id); return m ? (m.name || m.username) : `user${id}`; };
    orderBox.innerHTML = `<div class="rf-order-t">巡回の順番</div>` + sel.map((id, i) => `
      <div class="rf-ord">
        <span class="rf-ord-n">${i + 1}</span><span class="rf-ord-name">${esc(nameOf(id))}</span>
        <button type="button" class="rf-mv" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="rf-mv" data-i="${i}" data-d="1" ${i === sel.length - 1 ? "disabled" : ""}>↓</button>
      </div>`).join("");
    orderBox.querySelectorAll(".rf-mv").forEach((b) => {
      b.onclick = () => {
        const i = +b.dataset.i, j = i + (+b.dataset.d);
        [sel[i], sel[j]] = [sel[j], sel[i]];
        renderOrder();
      };
    });
  };
  el.querySelectorAll("#rf-members input").forEach((cb) => {
    cb.onchange = () => {
      const id = +cb.dataset.mid;
      if (cb.checked) { if (!sel.includes(id)) sel.push(id); }
      else { const i = sel.indexOf(id); if (i >= 0) sel.splice(i, 1); }
      renderOrder();
    };
  });
  const rotEl = $("#rf-rot");
  if (rotEl) rotEl.onchange = renderOrder;

  // 資料リンク: 共有部品。taskform と同じ規約（note に "[資料] URL" 行として保存）。
  const docLinks = exMeta ? [...exMeta.links] : [];
  wireDocChips(el, "rf-doc", docLinks);
  // 所要(h): 共有部品（".25"補完・↑↓キー/▲▼ボタンで0.25刻み）
  wireHourInput(el, "rf-dur");

  // ===== 編集時のプレフィル =====（新規は既定値のまま）
  if (isEdit) {
    dateEl.value = fmtDisplayDow(exDateISO);
    if (exHasTime && $("#rf-time")) $("#rf-time").value = exTime;
    if (exMeta && $("#rf-note")) $("#rf-note").value = exMeta.text;
    if (existing.duration_seconds) $("#rf-dur").value = String(Math.round((existing.duration_seconds / 3600) * 100) / 100);
    if (untilEl && exState.untilISO) untilEl.value = fmtDisplayDow(exState.untilISO);
    if (unitEl) {
      touchedDow = true; touchedMonthly = true;
      intEl.value = String(exState.interval);
      unitEl.value = exState.unit;
      dowBtns.forEach((b) => b.classList.toggle("on", exState.weekdays.includes(+b.dataset.dow)));
      if ($("#rf-mday")) $("#rf-mday").value = String(exState.mday);
      if ($("#rf-nth-n")) $("#rf-nth-n").value = String(exState.nth);
      if ($("#rf-nth-dow")) $("#rf-nth-dow").value = String(exState.nthDow);
      const radio = el.querySelector(`input[name="rf-mm"][value="${exState.monthlyMode}"]`);
      if (radio) radio.checked = true;
      syncFreqUI();
    }
    // メンバーのチェック（sel は assignee_ids の順＝持ち回り順を保持済み）
    el.querySelectorAll("#rf-members input").forEach((cb) => { cb.checked = sel.includes(+cb.dataset.mid); });
    if (rotEl) rotEl.checked = !!existing.rotation;
    renderOrder();
    const sv = $("#rf-save");
    if (sv) sv.textContent = "保存";
  }

  $("#rf-save").onclick = async () => {
    const err = $("#rf-err");
    err.textContent = "";
    const title = $("#rf-title").value.trim();
    if (!title) { err.textContent = "タイトルを入力してください。"; return; }
    const iso = parseSmartDate(dateEl.value);
    if (!iso) { err.textContent = `${isMtg ? "日付" : "開始日"}の形式が不正です（例: 1112 → 11/12）。`; return; }
    const durRaw = $("#rf-dur").value.trim().replace(/^\./, "0.");
    const durNum = parseFloat(durRaw);
    if (!durRaw || !isFinite(durNum) || durNum <= 0) { err.textContent = "所要(h)は0より大きい数値で入力してください。"; return; }
    if (!sel.length) { err.textContent = `${isTask ? "担当" : "参加者"}を選んでください。`; return; }
    const timeMin = parseTimeOfDay($("#rf-time") ? $("#rf-time").value : "");
    if (timeMin == null) { err.textContent = "開始時刻の形式が不正です（例: 10:00）。"; return; }
    const st = unitEl ? readState() : null;
    if (st && st.unit === "weekly" && !st.weekdays.length) { err.textContent = "曜日を選んでください。"; return; }
    let untilISO = null;
    if (untilEl && untilEl.value.trim()) {
      untilISO = parseSmartDate(untilEl.value);
      if (!untilISO) { err.textContent = "終了日の形式が不正です（例: 1231）。"; return; }
      if (untilISO < iso) { err.textContent = "終了日は開始日以降にしてください。"; return; }
    }
    const rotation = !!(rotEl && rotEl.checked);

    const btn = $("#rf-save");
    btn.disabled = true;
    try {
      const hh = timeMin >= 0 ? `${String(Math.floor(timeMin / 60)).padStart(2, "0")}:${String(timeMin % 60).padStart(2, "0")}:00` : "00:00:00";
      const body = {
        title, kind,
        rrule: isMtg ? buildRRule({ freq: "once" }) : buildRRule({ ...st, untilISO }),
        dtstart: `${iso}T${hh}Z`,
        duration_seconds: Math.round(durNum * 3600),
        assignee_ids: sel,
        rotation,
        note: joinMeta($("#rf-note").value.trim(), "", docLinks),
      };
      // 編集時は overrides（この回だけ変更）を保持＝RRULE/dtstart 変更で既存例外を消さない
      if (isEdit) { body.overrides = existing.overrides || {}; await updateRecurrence(existing.id, body); }
      else await createRecurrence(body);
      invalidate();
      close();
      onSaved && onSaved();
    } catch (e) {
      btn.disabled = false;
      err.textContent = "× " + e.message;
    }
  };
}

// 独立モーダル（管理ビューから定期/会議を新規作成・編集）。taskform のタブUIとは別に、
// 単体で開ける軽量シェル。新規=種別タブ（定例MTG/定期タスク/MTG）、編集=種別を判定して単一パネル。
let _rfOpening = false; // 多重起動ガード（taskform と同様。.tf-modal は taskform と共有）

export async function openRecurrenceForm({ existing = null, members = [], holidaysByDate = null, onSaved } = {}) {
  // 既に何かのモーダルが開いている / 開く処理中なら無視（モーダルは常に1枚）。
  if (_rfOpening || document.querySelector(".tf-modal")) return;
  _rfOpening = true;
  let ensureStyle;
  try { ({ ensureStyle } = await import("./taskform.js")); } // 基本スタイル(.tf-modal/.tf-in 等)を流用
  catch (e) { _rfOpening = false; throw e; }
  ensureStyle();
  ensureRecurrenceStyle();
  const isEdit = !!existing;
  const TABS = [["rmtg", "定例MTG"], ["rtask", "定期タスク"], ["mtg", "MTG"]];

  const wrap = document.createElement("div");
  wrap.className = "tf-modal";
  wrap.innerHTML = `
    <div class="tf-bg"></div>
    <div class="tf-card">
      <div class="tf-h"><b>${isEdit ? "定期・会議を編集" : "定期・会議を追加"}</b><button class="tf-x" id="rf-x" aria-label="閉じる">${icon("x")}</button></div>
      ${isEdit ? "" : `<div class="tf-tabs" id="rf-tabs">${TABS.map(([v, n], i) =>
        `<button type="button" data-tab="${v}" class="${i === 0 ? "on" : ""}">${n}</button>`).join("")}</div>`}
      <div class="tf-body tf-alt" id="rf-pane" style="padding:14px 22px 18px"></div>
    </div>`;
  document.body.appendChild(wrap);
  _rfOpening = false; // DOMに載った＝以後の連打は上の .tf-modal チェックで弾ける
  const close = () => wrap.remove();
  wrap.querySelector("#rf-x").onclick = close;
  wrap.querySelector(".tf-bg").onclick = close;

  const pane = wrap.querySelector("#rf-pane");
  const mount = (mode) => renderRecurrencePanel(pane, mode, { members, onSaved, close, holidaysByDate, existing });

  if (isEdit) {
    mount(recurrenceMode(existing));
  } else {
    const tabs = wrap.querySelector("#rf-tabs");
    tabs.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        mount(b.dataset.tab);
      };
    });
    mount(TABS[0][0]);
  }
}

// パネル用の追加スタイル（taskform の ensureStyle とは独立に1回だけ注入）
let _rfStyle = false;
export function ensureRecurrenceStyle() {
  if (_rfStyle) return; _rfStyle = true;
  const s = document.createElement("style");
  s.textContent = `
  .tf-tabs{display:flex;gap:4px;padding:10px 22px 0;border-bottom:1px solid ${C.line};margin:0 0 2px}
  .tf-tabs button{border:0;background:transparent;font:inherit;font-size:13px;font-weight:600;color:${C.muted};padding:8px 14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .tf-tabs button.on{color:${C.fill};border-bottom-color:${C.fill}}
  .tf-tabs button:hover:not(.on){color:${C.ink}}
  .tf-body[hidden],.tf-acts[hidden]{display:none}
  .tf-alt{display:block;padding-bottom:16px}
  .rf-iv{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .rf-int{width:56px;text-align:center}
  .rf-unit{width:auto}
  .rf-dows{display:flex;gap:5px}
  .rf-dows[hidden],.rf-monthly[hidden]{display:none}
  .rf-dowbtn{width:30px;height:30px;border-radius:50%;border:1px solid ${C.line};background:#fff;color:${C.muted};font:inherit;font-size:12px;cursor:pointer;padding:0}
  .rf-dowbtn.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .rf-dowbtn:hover:not(.on){border-color:${C.fill};color:${C.fill}}
  .rf-monthly{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
  .rf-radio{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:${C.ink};cursor:pointer}
  .rf-mini{width:auto;padding:7px 8px}
  .rf-prev{margin-top:8px;font-size:12.5px;color:${C.fill};font-weight:600}
  .rf-occ{margin-top:7px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .rf-occ[hidden]{display:none}
  .rf-occ-lbl{font-size:11.5px;color:${C.muted};font-weight:600;margin-right:2px}
  .rf-occ-chip{font-size:11.5px;color:${C.ink};background:#f1f4f8;border:1px solid ${C.line};border-radius:999px;padding:2px 9px;white-space:nowrap}
  .rf-occ-more{font-size:12px;color:${C.muted};font-weight:700}
  .rf-members{display:flex;gap:14px;margin-top:6px;flex-wrap:wrap}
  .rf-mem{font-size:13px;color:${C.ink};display:inline-flex;align-items:center;gap:5px;cursor:pointer}
  .rf-order{margin-top:8px;border:1px solid ${C.line};border-radius:10px;padding:8px 10px;background:#fafbfc}
  .rf-order-t{font-size:11.5px;color:${C.muted};font-weight:600;margin-bottom:6px}
  .rf-ord{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px}
  .rf-ord-n{width:18px;height:18px;border-radius:50%;background:${C.fill};color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
  .rf-ord-name{flex:1}
  .rf-mv{border:1px solid ${C.line};background:#fff;border-radius:6px;cursor:pointer;font-size:11px;padding:2px 7px;color:${C.muted}}
  .rf-mv:hover:not(:disabled){color:${C.fill};border-color:${C.fill}}
  .rf-mv:disabled{opacity:.35;cursor:default}
  .rf-acts{display:flex;justify-content:flex-end;margin:6px 0 2px}
  .rf-acts .tf-save{font:inherit;font-size:13.5px;font-weight:600;padding:9px 18px;border-radius:9px;cursor:pointer;border:1px solid ${C.fill};background:${C.fill};color:#fff}
  .rf-acts .tf-save:hover{filter:brightness(1.05)}
  .rf-acts .tf-save:disabled{opacity:.6;cursor:default}
  /* ===== ダークモード上書き（lightは不変・生の明色のみ暗側へ。.on の青塗り+白字＝アクセントは触らない） ===== */
  html[data-theme="dark"] .rf-dowbtn{background:var(--card)}
  html[data-theme="dark"] .rf-occ-chip{background:var(--surface-2)}
  html[data-theme="dark"] .rf-order{background:var(--surface-2)}
  html[data-theme="dark"] .rf-mv{background:var(--card)}`;
  document.head.appendChild(s);
}
