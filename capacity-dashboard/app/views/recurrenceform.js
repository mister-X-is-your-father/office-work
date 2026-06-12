// タスク追加モーダルの MTG / 定例MTG / 定期タスク タブのパネル（taskform.js から呼ばれる）。
// すべて recurrences（RRULE・dumb storage）として保存。MTG=COUNT=1 の単発 occurrence。
// 定期タスクは「持ち回り」(rotation) 対応: 担当は assignee_ids を配列順に巡回（解釈は recurrence.js）。
import { createRecurrence } from "../lib/api.js";
import { invalidate } from "../lib/store.js";
import { C, esc } from "../lib/ui.js";
import { parseSmartDate, fmtDisplay } from "./taskform.js";

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]; // getUTCDay() の並び
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];

// 開始日(anchor)と頻度から RRULE 文字列を組み立てる。weekdays=[0..6](日..土)。
export function buildRRule({ freq, anchorISO, weekdays = [] }) {
  const d = new Date(anchorISO + "T00:00:00Z");
  const dow = d.getUTCDay();
  const days = (weekdays.length ? weekdays : [dow]).map((i) => BYDAY[i]).join(",");
  if (freq === "once") return "FREQ=DAILY;COUNT=1";
  if (freq === "daily") return "FREQ=DAILY";
  if (freq === "weekly") return `FREQ=WEEKLY;BYDAY=${days}`;
  if (freq === "biweekly") return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${days}`;
  if (freq === "monthly_nth") {
    const nth = Math.ceil(d.getUTCDate() / 7); // 第N（anchor の日から導出）
    return `FREQ=MONTHLY;BYDAY=${nth}${BYDAY[dow]}`;
  }
  return "FREQ=MONTHLY"; // monthly_same: 毎月同じ日（dtstart の日）
}

// 頻度の選択肢（mode により絞る）
const FREQ_OPTS = [
  ["weekly", "毎週（曜日指定）"],
  ["biweekly", "隔週（曜日指定）"],
  ["monthly_nth", "毎月 第N曜日（開始日から）"],
  ["monthly_same", "毎月 同じ日"],
  ["daily", "毎日"],
];

// パネル描画。mode: "mtg"(単発会議) | "rmtg"(定例MTG) | "rtask"(定期タスク)
// ctx: { members, onSaved, close, $err } — $err は親モーダルのエラー表示要素。
export function renderRecurrencePanel(el, mode, { members, onSaved, close }) {
  const isMtg = mode === "mtg";
  const isTask = mode === "rtask";
  const kind = isTask ? "task" : "meeting";
  const todayISO = new Date().toISOString().slice(0, 10);
  const sel = []; // 選択済みメンバー（順序が持ち回りの順番）

  el.innerHTML = `
    <label class="tf-l">タイトル <span class="tf-req">*</span></label>
    <input id="rf-title" class="tf-in" type="text" placeholder="${isMtg ? "例: 顧客定例キックオフ" : isTask ? "例: 週次バックアップ確認" : "例: チーム定例"}">
    ${isMtg ? `
    <label class="tf-l">日付 <span class="tf-req">*</span></label>
    <input id="rf-date" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fmtDisplay(todayISO)}" placeholder="例: 1112">
    ` : `
    <div class="tf-row">
      <div class="tf-col">
        <label class="tf-l">繰り返し</label>
        <select id="rf-freq" class="tf-in">${FREQ_OPTS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>
      </div>
      <div class="tf-col">
        <label class="tf-l">開始日 <span class="tf-hint">（起点）</span></label>
        <input id="rf-date" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fmtDisplay(todayISO)}" placeholder="例: 1112">
      </div>
    </div>
    <div id="rf-dows" class="rf-dows">${DOW_JA.map((n, i) =>
      `<label class="rf-dow"><input type="checkbox" data-dow="${i}"> ${n}</label>`).join("")}</div>
    `}
    <label class="tf-l">所要(h) <span class="tf-hint">（1回あたり・0.25刻み）</span></label>
    <input id="rf-dur" class="tf-in" type="text" inputmode="decimal" autocomplete="off" value="${isTask ? "0.5" : "1"}" placeholder="例: 0.5">
    <label class="tf-l">${isTask ? "担当" : "参加者"} <span class="tf-req">*</span>${isTask ? ` <span class="tf-hint">（持ち回り時はこの順番で巡回）</span>` : ""}</label>
    <div id="rf-members" class="rf-members">${(members || []).map((m) =>
      `<label class="rf-mem"><input type="checkbox" data-mid="${m.id}"> ${esc(m.name || m.username)}</label>`).join("")}</div>
    ${isTask ? `
    <label class="tf-chk"><input id="rf-rot" type="checkbox"> 持ち回り <span class="tf-hint">（毎回1名が順番に担当。オフ=毎回全員）</span></label>
    <div id="rf-order" class="rf-order" hidden></div>
    ` : ""}
    <label class="tf-l">メモ</label>
    <input id="rf-note" class="tf-in" type="text" placeholder="任意">
    <div class="tf-err" id="rf-err"></div>
    <div class="rf-acts">
      <button class="tf-save" id="rf-save">追加</button>
    </div>`;

  const $ = (s) => el.querySelector(s);

  // 開始日: blur で整形。曜日チェックの既定=開始日の曜日（ユーザーが触るまでは日付変更に追従）。
  const dateEl = $("#rf-date");
  let autoDow = null; // 自動チェックした曜日 index（ユーザーが手で触ったら null=追従停止）
  const syncDefaultDow = () => {
    const boxes = [...el.querySelectorAll("#rf-dows input")];
    if (!boxes.length) return;
    const iso = parseSmartDate(dateEl.value);
    if (!iso) return;
    const dow = new Date(iso + "T00:00:00Z").getUTCDay();
    const checked = boxes.filter((b) => b.checked);
    if (!checked.length || (autoDow != null && checked.length === 1 && checked[0] === boxes[autoDow])) {
      boxes.forEach((b, i) => { b.checked = i === dow; });
      autoDow = dow;
    }
  };
  el.querySelectorAll("#rf-dows input").forEach((b) => {
    b.addEventListener("change", () => { autoDow = null; }); // 手動変更で追従停止
  });
  dateEl.onblur = () => { const iso = parseSmartDate(dateEl.value); if (iso) dateEl.value = fmtDisplay(iso); syncDefaultDow(); };

  // 曜日チェックは 毎週/隔週 のときだけ表示
  const freqEl = $("#rf-freq");
  const syncDows = () => {
    const dows = $("#rf-dows");
    if (dows) dows.hidden = !(freqEl && (freqEl.value === "weekly" || freqEl.value === "biweekly"));
  };
  if (freqEl) { freqEl.onchange = syncDows; syncDows(); syncDefaultDow(); }

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
    const weekdays = [...el.querySelectorAll("#rf-dows input")].filter((b) => b.checked).map((b) => +b.dataset.dow);
    const freq = isMtg ? "once" : freqEl.value;
    if ((freq === "weekly" || freq === "biweekly") && !weekdays.length) { err.textContent = "曜日を選んでください。"; return; }
    const rotation = !!(rotEl && rotEl.checked);

    const btn = $("#rf-save");
    btn.disabled = true;
    try {
      await createRecurrence({
        title, kind,
        rrule: buildRRule({ freq, anchorISO: iso, weekdays }),
        dtstart: iso + "T00:00:00Z",
        duration_seconds: Math.round(durNum * 3600),
        assignee_ids: sel,
        rotation,
        note: $("#rf-note").value.trim(),
      });
      invalidate();
      close();
      onSaved && onSaved();
    } catch (e) {
      btn.disabled = false;
      err.textContent = "× " + e.message;
    }
  };
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
  .rf-dows{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
  .rf-dow{font-size:13px;color:${C.ink};display:inline-flex;align-items:center;gap:4px;cursor:pointer}
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
  .rf-acts .tf-save:disabled{opacity:.6;cursor:default}`;
  document.head.appendChild(s);
}
