// 集中タイマー（TickTickポモドーロのブラッシュアップ: 集中の終了/中断を実績(time entries)に自動記録
// → 見積りvs実績・予実ガントにそのまま乗る。TickTickは専用統計どまりで実績と繋がらない）。
// トップバー🍅でウィジェット開閉。状態は localStorage（リロード・タブ閉じでも継続/復元。
// 不在中に集中が満了していた場合は復帰時に記録）。タブタイトルに残り時間。
import { load } from "../lib/store.js";
import { logTime } from "../lib/api.js";
import { esc } from "../lib/ui.js";

const KEY = "ts.pomo";            // 実行中状態 {taskId,taskTitle,mode,endsAt,focusMin,breakMin,paused,remainMs,startedAt}
const CNT = "ts.pomo.count.";     // 本日の完了集中回数（日付キー）
const BASE_TITLE = document.title || "TaskStation";

const st = {
  get: () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
  set: (v) => v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY),
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const countToday = () => +(localStorage.getItem(CNT + today()) || 0);
const bumpCount = () => localStorage.setItem(CNT + today(), String(countToday() + 1));

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function notifyDone(title, body) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(title, { body, tag: "pomo" }); return; } catch { /* fallthrough */ }
  }
  // notify.js のトーストと同じ場所（依存させず最小実装）
  import("../lib/notify.js").catch(() => {});
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

// 実績記録（90秒未満は記録しない＝誤操作ノイズ防止。15分単位の運用に対し秒は丸めずそのまま）
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

  let card = null, timer = null;

  // 不在中に集中が満了していた → 復帰時に記録して休憩扱いは破棄
  const stale = st.get();
  if (stale && stale.mode === "focus" && !stale.paused && stale.endsAt <= Date.now()) {
    record(stale.taskId, stale.taskTitle, stale.focusMin * 60).then(() => bumpCount());
    st.set(null);
  } else if (stale && stale.mode === "break" && stale.endsAt <= Date.now()) {
    st.set(null);
  }

  const tickTitle = () => {
    const s = st.get();
    document.title = s && !s.paused ? `(${mmss(s.endsAt - Date.now())}) ${s.mode === "focus" ? "🍅" : "☕"} ${BASE_TITLE}` : BASE_TITLE;
  };

  const loop = () => {
    const s = st.get();
    if (!s) { document.title = BASE_TITLE; paint(); return; }
    if (!s.paused && s.endsAt <= Date.now()) {
      if (s.mode === "focus") {
        bumpCount();
        record(s.taskId, s.taskTitle, s.focusMin * 60);
        notifyDone("🍅 集中おわり", `おつかれさまです。${s.breakMin}分休憩しましょう`);
        st.set({ ...s, mode: "break", endsAt: Date.now() + s.breakMin * 60000 });
      } else {
        notifyDone("☕ 休憩おわり", "次の集中を始めましょう");
        st.set(null);
      }
    }
    tickTitle();
    paint();
  };

  const open = async () => {
    if (card) { card.remove(); card = null; clearInterval(timer); timer = null; document.title = BASE_TITLE; return; }
    card = document.createElement("div");
    card.className = "pm-card";
    document.body.appendChild(card);
    let myTasks = [];
    try {
      const { tasks, me } = await load();
      myTasks = (tasks || []).filter((t) => !t.done && (t.assignees || []).some((a) => a.id === (me && me.id)));
    } catch { /* 未ログイン等 */ }
    card._myTasks = myTasks;
    paint();
    timer = setInterval(loop, 1000);
  };
  btn.onclick = open;

  function paint() {
    if (!card) return;
    const s = st.get();
    const myTasks = card._myTasks || [];
    if (!s) {
      const opts = `<option value="">タスクを選択（実績の記録先）</option>` +
        myTasks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join("");
      const keep = card.querySelector("#pm-task") ? card.querySelector("#pm-task").value : "";
      const keepF = card.querySelector("#pm-focus") ? card.querySelector("#pm-focus").value : "25";
      const keepB = card.querySelector("#pm-break") ? card.querySelector("#pm-break").value : "5";
      if (card._idle) return; // アイドル表示は毎秒再描画しない（select の選択を守る）
      card._idle = true;
      card.innerHTML = `
        <div class="pm-h">🍅 集中タイマー <span class="pm-cnt">本日 ${countToday()} 回</span><button class="pm-x" id="pm-x">×</button></div>
        <select id="pm-task" class="pm-in">${opts}</select>
        <div class="pm-row">
          <label>集中 <select id="pm-focus" class="pm-in">${[15, 25, 45, 50].map((n) => `<option value="${n}"${String(n) === keepF ? " selected" : ""}>${n}分</option>`).join("")}</select></label>
          <label>休憩 <select id="pm-break" class="pm-in">${[5, 10, 15].map((n) => `<option value="${n}"${String(n) === keepB ? " selected" : ""}>${n}分</option>`).join("")}</select></label>
        </div>
        <button class="pm-go" id="pm-go">▶ 集中を開始</button>
        <div class="pm-hint">終了/中断時に選択タスクの実績へ自動記録（90秒未満は記録しません）</div>`;
      if (keep) card.querySelector("#pm-task").value = keep;
      card.querySelector("#pm-x").onclick = open;
      card.querySelector("#pm-go").onclick = () => {
        const sel = card.querySelector("#pm-task");
        const focusMin = +card.querySelector("#pm-focus").value;
        const breakMin = +card.querySelector("#pm-break").value;
        st.set({
          taskId: sel.value ? +sel.value : null,
          taskTitle: sel.value ? sel.options[sel.selectedIndex].text : "",
          mode: "focus", focusMin, breakMin, paused: false,
          endsAt: Date.now() + focusMin * 60000, startedAt: Date.now(),
        });
        card._idle = false;
        loop();
      };
      return;
    }
    card._idle = false;
    const remain = s.paused ? s.remainMs : s.endsAt - Date.now();
    card.innerHTML = `
      <div class="pm-h">${s.mode === "focus" ? "🍅 集中中" : "☕ 休憩中"} <span class="pm-cnt">本日 ${countToday()} 回</span><button class="pm-x" id="pm-x">×</button></div>
      <div class="pm-time${s.mode === "break" ? " brk" : ""}">${mmss(remain)}</div>
      ${s.taskTitle ? `<div class="pm-task">${esc(s.taskTitle)}</div>` : `<div class="pm-task none">実績記録なし</div>`}
      <div class="pm-row">
        <button class="pm-go sub" id="pm-pause">${s.paused ? "▶ 再開" : "⏸ 一時停止"}</button>
        <button class="pm-go sub stop" id="pm-stop">■ ${s.mode === "focus" ? "中断" : "休憩を終わる"}</button>
      </div>`;
    card.querySelector("#pm-x").onclick = open;
    card.querySelector("#pm-pause").onclick = () => {
      const cur = st.get();
      if (!cur) return;
      if (cur.paused) st.set({ ...cur, paused: false, endsAt: Date.now() + cur.remainMs });
      else st.set({ ...cur, paused: true, remainMs: cur.endsAt - Date.now() });
      paint();
    };
    card.querySelector("#pm-stop").onclick = () => {
      const cur = st.get();
      if (!cur) return;
      if (cur.mode === "focus") {
        const elapsed = (cur.focusMin * 60000 - (cur.paused ? cur.remainMs : cur.endsAt - Date.now())) / 1000;
        record(cur.taskId, cur.taskTitle, elapsed);
      }
      st.set(null);
      document.title = BASE_TITLE;
      paint();
    };
  }
}

let _style = false;
function ensureStyle() {
  if (_style) return; _style = true;
  const s = document.createElement("style");
  s.textContent = `
  .pm-card{position:fixed;right:18px;bottom:18px;z-index:50;width:264px;background:#fff;border:1px solid var(--line);
    border-radius:14px;box-shadow:0 18px 50px rgba(10,18,35,.25);padding:14px 16px}
  .pm-h{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;margin-bottom:10px}
  .pm-cnt{font-size:11px;color:var(--muted);font-weight:500;margin-left:auto}
  .pm-x{border:0;background:transparent;font-size:15px;color:var(--muted);cursor:pointer;padding:0 2px}
  .pm-in{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:#fff;margin-bottom:8px}
  .pm-row{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--muted)}
  .pm-row label{flex:1;display:flex;flex-direction:column;gap:3px}
  .pm-row .pm-in{margin-bottom:0}
  .pm-go{width:100%;margin-top:10px;font:inherit;font-size:13.5px;font-weight:700;padding:9px 0;border-radius:9px;border:1px solid var(--fill);background:var(--fill);color:#fff;cursor:pointer}
  .pm-go:hover{filter:brightness(1.05)}
  .pm-go.sub{flex:1;width:auto;font-size:12.5px;padding:7px 0;background:#fff;color:var(--fill)}
  .pm-go.sub.stop{border-color:#e3b3b5;color:#b3261e}
  .pm-time{font-size:42px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:1px;margin:6px 0 2px;color:#1d2430}
  .pm-time.brk{color:#2fa66b}
  .pm-task{font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pm-task.none{opacity:.6}
  .pm-hint{font-size:10.5px;color:var(--muted);margin-top:8px;line-height:1.5}`;
  document.head.appendChild(s);
}
