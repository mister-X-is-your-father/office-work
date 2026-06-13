// 集中タイマー（TickTickポモドーロのブラッシュアップ: 集中の終了/中断を実績(time entries)に自動記録
// → 見積りvs実績・予実ガントにそのまま乗る。TickTickは専用統計どまりで実績と繋がらない）。
// モード3種: 🍅ポモドーロ（集中⇄休憩）/ ⏲カウントダウン（任意分・満了で記録）/ ⏱カウントアップ
// （ストップウォッチ・停止時に経過を記録）。タスクは「自分の担当」「その他」の2グループから選択
// （担当未設定のタスクも選べる）。
// 最前面表示: Document Picture-in-Picture（Chrome系）でミニタイマーを常時前面の小窓に表示。
// 状態は localStorage（リロード・タブ閉じでも継続/復元。不在中の満了は復帰時に記録）。タブタイトルに残り時間。
import { load } from "../lib/store.js";
import { logTime } from "../lib/api.js";
import { esc } from "../lib/ui.js";

const KEY = "ts.pomo";            // 実行中状態（下記 st 形）
const CNT = "ts.pomo.count.";     // 本日の完了集中回数（日付キー）
const BASE_TITLE = document.title || "TaskStation";

// st: { taskId, taskTitle, mode: focus|break|countdown|countup, focusMin, breakMin, durMin,
//       endsAt(focus/break/countdown), startedAt(countup), paused, remainMs, elapsedMs }
const st = {
  get: () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
  set: (v) => v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY),
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const countToday = () => +(localStorage.getItem(CNT + today()) || 0);
const bumpCount = () => localStorage.setItem(CNT + today(), String(countToday() + 1));

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
           : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const MODE_ICON = { focus: "🍅", break: "☕", countdown: "⏲", countup: "⏱" };
// 表示用の残り/経過（countup は経過・他は残り）
const dispMs = (s) => s.mode === "countup"
  ? (s.paused ? s.elapsedMs : Date.now() - s.startedAt)
  : (s.paused ? s.remainMs : s.endsAt - Date.now());

function notifyDone(title, body) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(title, { body, tag: "pomo" }); return; } catch { /* fallthrough */ }
  }
  const box = document.getElementById("ts-toasts") || (() => {
    const b = document.createElement("div"); b.id = "ts-toasts";
    b.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;gap:8px";
    document.body.appendChild(b); return b;
  })();
  const el = document.createElement("div");
  el.style.cssText = "background:#1d2430;color:#fff;border-radius:11px;padding:11px 15px;font-size:13px;box-shadow:0 10px 30px rgba(10,18,35,.35);max-width:320px";
  el.innerHTML = `<b style="display:block;font-size:13.5px">${esc(title)}</b><span style="opacity:.85;font-size:12px">${esc(body)}</span>`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

// 実績記録（90秒未満は記録しない＝誤操作ノイズ防止）
async function record(taskId, taskTitle, seconds) {
  if (!taskId || seconds < 90) return false;
  try {
    await logTime(taskId, Math.round(seconds), "🍅 集中タイマー");
    notifyDone("実績を記録しました", `${taskTitle}: ${Math.round(seconds / 60)}分`);
    return true;
  } catch (e) {
    notifyDone("実績の記録に失敗", e.message || "通信エラー");
    return false;
  }
}

export function mountPomodoro(topbar) {
  ensureStyle();
  const btn = document.createElement("button");
  btn.id = "pm-btn";
  btn.textContent = "🍅";
  btn.title = "集中タイマー";
  const anchor = topbar.querySelector("#refresh");
  anchor ? anchor.before(btn) : topbar.appendChild(btn);

  let card = null, timer = null, pip = null;

  // 不在中の満了処理（countup は満了が無い＝そのまま継続）
  const stale = st.get();
  if (stale && !stale.paused && stale.endsAt && stale.endsAt <= Date.now()) {
    if (stale.mode === "focus") { record(stale.taskId, stale.taskTitle, stale.focusMin * 60).then(() => bumpCount()); }
    else if (stale.mode === "countdown") { record(stale.taskId, stale.taskTitle, stale.durMin * 60); }
    st.set(null);
  }

  // 共有操作（メインカードと PiP の両方から呼ぶ）
  const doPause = () => {
    const cur = st.get();
    if (!cur) return;
    if (cur.paused) {
      if (cur.mode === "countup") st.set({ ...cur, paused: false, startedAt: Date.now() - cur.elapsedMs });
      else st.set({ ...cur, paused: false, endsAt: Date.now() + cur.remainMs });
    } else {
      if (cur.mode === "countup") st.set({ ...cur, paused: true, elapsedMs: Date.now() - cur.startedAt });
      else st.set({ ...cur, paused: true, remainMs: cur.endsAt - Date.now() });
    }
    paint(); paintPip();
  };
  const doStop = () => {
    const cur = st.get();
    if (!cur) return;
    if (cur.mode === "focus") {
      record(cur.taskId, cur.taskTitle, (cur.focusMin * 60000 - dispMs(cur)) / 1000);
    } else if (cur.mode === "countdown") {
      record(cur.taskId, cur.taskTitle, (cur.durMin * 60000 - dispMs(cur)) / 1000);
    } else if (cur.mode === "countup") {
      record(cur.taskId, cur.taskTitle, dispMs(cur) / 1000);
    }
    st.set(null);
    document.title = BASE_TITLE;
    closePip();
    paint();
  };

  const tickTitle = () => {
    const s = st.get();
    document.title = s && !s.paused ? `(${mmss(dispMs(s))}) ${MODE_ICON[s.mode]} ${BASE_TITLE}` : BASE_TITLE;
  };

  const loop = () => {
    const s = st.get();
    if (!s) { document.title = BASE_TITLE; paint(); paintPip(); return; }
    if (!s.paused && s.endsAt && s.endsAt <= Date.now()) {
      if (s.mode === "focus") {
        bumpCount();
        record(s.taskId, s.taskTitle, s.focusMin * 60);
        notifyDone("🍅 集中おわり", `おつかれさまです。${s.breakMin}分休憩しましょう`);
        st.set({ ...s, mode: "break", endsAt: Date.now() + s.breakMin * 60000 });
      } else if (s.mode === "countdown") {
        record(s.taskId, s.taskTitle, s.durMin * 60);
        notifyDone("⏲ 時間です", s.taskTitle || "カウントダウン終了");
        st.set(null);
        closePip();
      } else {
        notifyDone("☕ 休憩おわり", "次の集中を始めましょう");
        st.set(null);
        closePip();
      }
    }
    tickTitle();
    paint(); paintPip();
  };

  const open = async () => {
    if (card) { card.remove(); card = null; clearInterval(timer); timer = null; if (!st.get()) document.title = BASE_TITLE; return; }
    card = document.createElement("div");
    card.className = "pm-card";
    document.body.appendChild(card);
    // 候補=未完了の全タスク（自分の担当を先頭グループに。担当未設定のタスクも選べる）
    let mine = [], others = [];
    try {
      const { tasks, me } = await load();
      for (const t of (tasks || []).filter((x) => !x.done)) {
        ((t.assignees || []).some((a) => a.id === (me && me.id)) ? mine : others).push(t);
      }
      const byTitle = (a, b) => a.title.localeCompare(b.title, "ja");
      mine.sort(byTitle); others.sort(byTitle);
    } catch { /* 未ログイン等 */ }
    card._mine = mine;
    card._others = others;
    card._mode = "focus"; // アイドル画面のモード選択
    paint();
    timer = setInterval(loop, 1000);
  };
  btn.onclick = open;

  function paint() {
    if (!card) return;
    const s = st.get();
    if (!s) {
      if (card._idle) return; // アイドル表示は毎秒再描画しない（select の選択を守る）
      card._idle = true;
      const og = (label, list) => list.length
        ? `<optgroup label="${label}">${list.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("")}</optgroup>` : "";
      const opts = `<option value="">タスクを選択（実績の記録先）</option>` +
        og("自分の担当", card._mine || []) + og("その他のタスク", card._others || []);
      const m = card._mode;
      card.innerHTML = `
        <div class="pm-h">${MODE_ICON[m === "focus" ? "focus" : m]} 集中タイマー <span class="pm-cnt">本日 ${countToday()} 回</span><button class="pm-x" id="pm-x">×</button></div>
        <div class="pm-tabs">
          <button data-m="focus" class="${m === "focus" ? "on" : ""}">🍅 ポモドーロ</button>
          <button data-m="countdown" class="${m === "countdown" ? "on" : ""}">⏲ ダウン</button>
          <button data-m="countup" class="${m === "countup" ? "on" : ""}">⏱ アップ</button>
        </div>
        <select id="pm-task" class="pm-in">${opts}</select>
        ${m === "focus" ? `<div class="pm-row">
          <label>集中 <select id="pm-focus" class="pm-in">${[5, 10, 15, 25, 45, 50, 60].map((n) => `<option value="${n}"${n === 25 ? " selected" : ""}>${n}分</option>`).join("")}</select></label>
          <label>休憩 <select id="pm-break" class="pm-in">${[5, 10, 15].map((n) => `<option value="${n}">${n}分</option>`).join("")}</select></label>
        </div>` : ""}
        ${m === "countdown" ? `<div class="pm-row">
          <label>時間（分） <input id="pm-dur" class="pm-in" type="number" min="1" max="480" value="30"></label>
        </div>` : ""}
        ${m === "countup" ? `<div class="pm-hint" style="margin:2px 0 0">ストップウォッチ。停止したときの経過時間を実績に記録します。</div>` : ""}
        <button class="pm-go" id="pm-go">▶ 開始</button>
        <div class="pm-hint">終了/中断時に選択タスクの実績へ自動記録（90秒未満は記録しません）</div>`;
      card.querySelector("#pm-x").onclick = open;
      card.querySelectorAll(".pm-tabs button").forEach((b) => {
        b.onclick = () => {
          const sel = card.querySelector("#pm-task").value; // モード切替でも選択タスクは維持
          card._mode = b.dataset.m;
          card._idle = false;
          paint();
          if (sel) card.querySelector("#pm-task").value = sel;
        };
      });
      card.querySelector("#pm-go").onclick = () => {
        const sel = card.querySelector("#pm-task");
        const base = {
          taskId: sel.value ? +sel.value : null,
          taskTitle: sel.value ? sel.options[sel.selectedIndex].text : "",
          paused: false,
        };
        if (card._mode === "focus") {
          const focusMin = +card.querySelector("#pm-focus").value;
          const breakMin = +card.querySelector("#pm-break").value;
          st.set({ ...base, mode: "focus", focusMin, breakMin, endsAt: Date.now() + focusMin * 60000 });
        } else if (card._mode === "countdown") {
          const durMin = Math.max(1, Math.min(480, +card.querySelector("#pm-dur").value || 30));
          st.set({ ...base, mode: "countdown", durMin, endsAt: Date.now() + durMin * 60000 });
        } else {
          st.set({ ...base, mode: "countup", startedAt: Date.now() });
        }
        card._idle = false;
        loop();
      };
      return;
    }
    card._idle = false;
    const label = { focus: "🍅 集中中", break: "☕ 休憩中", countdown: "⏲ カウントダウン", countup: "⏱ 計測中" }[s.mode];
    card.innerHTML = `
      <div class="pm-h">${label} <span class="pm-cnt">本日 ${countToday()} 回</span><button class="pm-x" id="pm-x">×</button></div>
      <div class="pm-time${s.mode === "break" ? " brk" : ""}">${mmss(dispMs(s))}</div>
      ${s.taskTitle ? `<div class="pm-task">${esc(s.taskTitle)}</div>` : `<div class="pm-task none">実績記録なし</div>`}
      <div class="pm-row">
        <button class="pm-go sub" id="pm-pause">${s.paused ? "▶ 再開" : "⏸ 一時停止"}</button>
        <button class="pm-go sub stop" id="pm-stop">■ ${s.mode === "break" ? "休憩を終わる" : "停止"}</button>
      </div>
      <button class="pm-pip" id="pm-pip" title="常に最前面の小窓にタイマーを表示（Chrome系）">⬆ 最前面に表示</button>`;
    card.querySelector("#pm-x").onclick = open;
    card.querySelector("#pm-pause").onclick = doPause;
    card.querySelector("#pm-stop").onclick = doStop;
    card.querySelector("#pm-pip").onclick = openPip;
  }

  // ── 最前面ミニタイマー（Document Picture-in-Picture・Chrome系） ──
  async function openPip() {
    if (pip) { pip.focus(); return; }
    if (!("documentPictureInPicture" in window)) {
      notifyDone("最前面表示は未対応", "このブラウザは Document Picture-in-Picture に未対応です（Chrome/Edge で利用可）");
      return;
    }
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: 230, height: 132 });
    } catch (e) {
      notifyDone("最前面表示を開けません", e.message || "");
      return;
    }
    pip.document.body.style.cssText = "margin:0;font-family:system-ui,sans-serif;background:#1d2430;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:2px;user-select:none";
    pip.document.body.innerHTML = `
      <div id="pp-mode" style="font-size:11px;opacity:.75"></div>
      <div id="pp-time" style="font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px;line-height:1.1"></div>
      <div id="pp-task" style="font-size:10.5px;opacity:.7;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
      <div style="display:flex;gap:8px;margin-top:7px">
        <button id="pp-pause" style="font:inherit;font-size:11px;border:1px solid #5b6470;border-radius:7px;background:transparent;color:#fff;padding:3px 12px;cursor:pointer">⏸</button>
        <button id="pp-stop" style="font:inherit;font-size:11px;border:1px solid #8a5054;border-radius:7px;background:transparent;color:#ff9b9b;padding:3px 12px;cursor:pointer">■</button>
      </div>`;
    pip.document.getElementById("pp-pause").onclick = doPause;
    pip.document.getElementById("pp-stop").onclick = doStop;
    pip.addEventListener("pagehide", () => { pip = null; });
    paintPip();
  }
  function paintPip() {
    if (!pip) return;
    const s = st.get();
    if (!s) { closePip(); return; }
    const d = pip.document;
    const label = { focus: "🍅 集中中", break: "☕ 休憩中", countdown: "⏲ カウントダウン", countup: "⏱ 計測中" }[s.mode];
    d.getElementById("pp-mode").textContent = label + (s.paused ? "（一時停止）" : "");
    d.getElementById("pp-time").textContent = mmss(dispMs(s));
    d.getElementById("pp-task").textContent = s.taskTitle || "実績記録なし";
    d.getElementById("pp-pause").textContent = s.paused ? "▶" : "⏸";
  }
  function closePip() { if (pip) { try { pip.close(); } catch { /* noop */ } pip = null; } }

  // タイマー実行中ならウィジェットを閉じていてもタブタイトル/満了処理を回す（軽量・カード無しでも動く）
  setInterval(() => { if (!card) loop(); }, 1000);
}

let _style = false;
function ensureStyle() {
  if (_style) return; _style = true;
  const s = document.createElement("style");
  s.textContent = `
  .pm-card{position:fixed;right:18px;bottom:18px;z-index:50;width:272px;background:#fff;border:1px solid var(--line);
    border-radius:14px;box-shadow:0 18px 50px rgba(10,18,35,.25);padding:14px 16px}
  .pm-h{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;margin-bottom:10px}
  .pm-cnt{font-size:11px;color:var(--muted);font-weight:500;margin-left:auto}
  .pm-x{border:0;background:transparent;font-size:15px;color:var(--muted);cursor:pointer;padding:0 2px}
  .pm-tabs{display:flex;gap:4px;margin-bottom:9px}
  .pm-tabs button{flex:1;font:inherit;font-size:11px;padding:5px 0;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;color:var(--muted);white-space:nowrap}
  .pm-tabs button.on{border-color:var(--fill);color:var(--fill);font-weight:700;background:#f3f8ff}
  .pm-in{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;margin-bottom:8px}
  .pm-row{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--muted)}
  .pm-row label{flex:1;display:flex;flex-direction:column;gap:3px}
  .pm-row .pm-in{margin-bottom:0}
  .pm-go{width:100%;margin-top:10px;font:inherit;font-size:13.5px;font-weight:700;padding:9px 0;border-radius:9px;border:1px solid var(--fill);background:var(--fill);color:#fff;cursor:pointer}
  .pm-go:hover{filter:brightness(1.05)}
  .pm-go.sub{flex:1;width:auto;font-size:12.5px;padding:7px 0;background:#fff;color:var(--fill)}
  .pm-go.sub.stop{border-color:#e3b3b5;color:#b3261e}
  .pm-pip{width:100%;margin-top:8px;font:inherit;font-size:11.5px;padding:6px 0;border-radius:8px;border:1px dashed var(--line);background:#fff;color:var(--muted);cursor:pointer}
  .pm-pip:hover{color:var(--fill);border-color:#b9d4ff}
  .pm-time{font-size:42px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:1px;margin:6px 0 2px;color:#1d2430}
  .pm-time.brk{color:#2fa66b}
  .pm-task{font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pm-task.none{opacity:.6}
  .pm-hint{font-size:10.5px;color:var(--muted);margin-top:8px;line-height:1.5}`;
  document.head.appendChild(s);
}
