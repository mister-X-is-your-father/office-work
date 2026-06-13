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

// ── 表示スキン カタログ（8種）＋色・透明度カスタム（localStorage 永続・スキーマ変更なし） ──
const DISP_KEY = "ts.pomo.disp";
const SKINS = [
  { key: "card", name: "標準" }, { key: "minimal", name: "ミニマル" },
  { key: "bar", name: "バー" }, { key: "ring", name: "リング" },
  { key: "segments", name: "セグメント" }, { key: "jumbo", name: "特大" },
  { key: "compact", name: "コンパクト" }, { key: "dots", name: "ドット" },
];
function dispCfg() {
  try { return { skin: "card", accent: "#3a86ff", opacity: 1, ...(JSON.parse(localStorage.getItem(DISP_KEY)) || {}) }; }
  catch { return { skin: "card", accent: "#3a86ff", opacity: 1 }; }
}
function saveDispCfg(c) { try { localStorage.setItem(DISP_KEY, JSON.stringify(c)); } catch { /* noop */ } }

// 進捗 0..1（countup は終端なし=null）
const totalMsOf = (s) => s.mode === "focus" ? (s.focusMin || 0) * 60000
  : s.mode === "break" ? (s.breakMin || 0) * 60000
  : s.mode === "countdown" ? (s.durMin || 0) * 60000 : null;
function progressOf(s) {
  const t = totalMsOf(s); if (!t) return null;
  return Math.max(0, Math.min(1, 1 - Math.max(0, dispMs(s)) / t));
}

// 表示エリアのHTML（インラインstyle＝PiPの別ドキュメントでもそのまま使える）。
// c: { timeText, label, taskTitle, progress(0..1|null), accent }
function renderDisplay(skin, c) {
  const ac = c.accent || "#3a86ff", t = esc(c.timeText), lbl = esc(c.label || "");
  const pr = c.progress;
  const pct = pr == null ? 100 : Math.round(pr * 100);
  const num = (px, col) => `<div style="font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px;line-height:1;font-size:${px}px${col ? `;color:${col}` : ""}">${t}</div>`;
  const task = c.taskTitle ? `<div style="font-size:11px;opacity:.65;max-width:96%;margin:5px auto 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.taskTitle)}</div>` : "";
  const track = "rgba(127,135,150,.22)";
  switch (skin) {
    case "minimal":
      return `<div style="text-align:center;padding:8px 0">${num(48)}</div>`;
    case "jumbo":
      return `<div style="text-align:center;padding:10px 0">${num(66, ac)}${task}</div>`;
    case "bar":
      return `<div style="padding:4px 0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px"><span style="font-size:11px;opacity:.65">${lbl}</span>${num(30)}</div>
        <div style="height:9px;border-radius:6px;background:${track};overflow:hidden"><div style="height:100%;width:${pct}%;background:${ac};border-radius:6px;transition:width .5s"></div></div>${task}</div>`;
    case "compact":
      return `<div style="display:flex;align-items:center;gap:11px;padding:2px 0">${num(26)}
        <div style="flex:1"><div style="font-size:10px;opacity:.65;margin-bottom:4px">${lbl}</div>
        <div style="height:6px;border-radius:5px;background:${track};overflow:hidden"><div style="height:100%;width:${pct}%;background:${ac};border-radius:5px;transition:width .5s"></div></div></div></div>`;
    case "segments": {
      const n = 12, on = pr == null ? n : Math.round(pr * n);
      const segs = Array.from({ length: n }, (_, i) => `<div style="flex:1;height:11px;border-radius:2px;background:${i < on ? ac : track}"></div>`).join("");
      return `<div style="padding:4px 0"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px"><span style="font-size:11px;opacity:.65">${lbl}</span>${num(28)}</div><div style="display:flex;gap:3px">${segs}</div>${task}</div>`;
    }
    case "dots": {
      const n = 10, on = pr == null ? n : Math.round(pr * n);
      const dots = Array.from({ length: n }, (_, i) => `<span style="width:9px;height:9px;border-radius:50%;background:${i < on ? ac : track}"></span>`).join("");
      return `<div style="text-align:center;padding:4px 0">${num(32)}<div style="display:flex;gap:6px;justify-content:center;margin-top:9px">${dots}</div>${task}</div>`;
    }
    case "ring": {
      const R = 46, CIRC = 2 * Math.PI * R, off = pr == null ? 0 : CIRC * (1 - pr);
      const prog = pr == null
        ? `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${ac}" stroke-width="9" stroke-linecap="round" stroke-dasharray="5 9"/>`
        : `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${ac}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${off}" style="transition:stroke-dashoffset .5s"/>`;
      return `<div style="display:flex;flex-direction:column;align-items:center;padding:4px 0">
        <div style="position:relative;width:120px;height:120px">
          <svg width="120" height="120" viewBox="0 0 120 120" style="transform:rotate(-90deg)"><circle cx="60" cy="60" r="${R}" fill="none" stroke="${track}" stroke-width="9"/>${prog}</svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">${num(24)}<div style="font-size:10px;opacity:.65;margin-top:3px">${lbl}</div></div>
        </div>${task}</div>`;
    }
    case "card":
    default:
      return `<div style="text-align:center;padding:6px 0">${num(40, ac)}${task}</div>`;
  }
}

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

  // ── ドラッグ移動（ヘッダ掴み・位置は localStorage に保持） ──
  const POS_KEY = "ts.pomo.pos";
  function restorePos(c) {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && typeof p.left === "number") {
        c.style.left = p.left + "px"; c.style.top = p.top + "px";
        c.style.right = "auto"; c.style.bottom = "auto";
      }
    } catch { /* noop */ }
  }
  function wireDrag(c) {
    c.addEventListener("pointerdown", (e) => {
      const h = e.target.closest(".pm-h");
      if (!h || e.target.closest("button")) return; // ヘッダのみ・ヘッダ内ボタン(×/🎨)は除外
      const r = c.getBoundingClientRect();
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      c.style.right = "auto"; c.style.bottom = "auto";
      const move = (ev) => {
        const l = Math.max(4, Math.min(window.innerWidth - r.width - 4, ev.clientX - offX));
        const t = Math.max(4, Math.min(window.innerHeight - r.height - 4, ev.clientY - offY));
        c.style.left = l + "px"; c.style.top = t + "px";
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: parseFloat(c.style.left), top: parseFloat(c.style.top) })); } catch { /* noop */ }
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      e.preventDefault();
    });
  }

  const open = async () => {
    if (card) { card.remove(); card = null; clearInterval(timer); timer = null; if (!st.get()) document.title = BASE_TITLE; return; }
    card = document.createElement("div");
    card.className = "pm-card";
    document.body.appendChild(card);
    restorePos(card);  // 前回ドラッグした位置を復元
    wireDrag(card);    // ヘッダをドラッグで移動（card は再描画をまたいで永続＝1回配線でOK）
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

  // カード全体に色/透明度を適用（半透明＝背景rgba＋ぼかし。文字は不透明のまま）
  function applyCardStyle(c, cfg) {
    const op = Math.max(0.3, Math.min(1, cfg.opacity ?? 1));
    c.style.background = `rgba(255,255,255,${op})`;
    c.style.backdropFilter = op < 1 ? "blur(7px)" : "";
    c.style.webkitBackdropFilter = op < 1 ? "blur(7px)" : "";
    c.style.setProperty("--pm-accent", cfg.accent || "#3a86ff");
  }

  // 表示カスタムのピッカー（スキン8種＋色＋透明度）。実行カード下にトグル表示。
  function buildPicker(panel) {
    const cfg = dispCfg();
    panel.innerHTML = `
      <div class="pm-pk-grid">
        ${SKINS.map((sk) => `<button class="pm-pk-chip${cfg.skin === sk.key ? " on" : ""}" data-skin="${sk.key}">${esc(sk.name)}</button>`).join("")}
      </div>
      <div class="pm-pk-row">
        <label>色 <input type="color" id="pm-pk-color" value="${esc(cfg.accent)}"></label>
        <label class="pm-pk-op">透明度 <input type="range" id="pm-pk-op" min="0.3" max="1" step="0.05" value="${cfg.opacity}"></label>
      </div>`;
    const apply = (patch) => {
      const next = { ...dispCfg(), ...patch };
      saveDispCfg(next);
      applyCardStyle(card, next);
      // 即時プレビュー（次tickでも更新されるが待たずに反映）
      const s = st.get(); const disp = card.querySelector("#pm-disp");
      if (s && disp) {
        const label = { focus: "🍅 集中中", break: "☕ 休憩中", countdown: "⏲ カウントダウン", countup: "⏱ 計測中" }[s.mode];
        disp.innerHTML = renderDisplay(next.skin, { timeText: mmss(dispMs(s)), label, taskTitle: s.taskTitle, progress: progressOf(s), accent: next.accent });
      }
      panel.querySelectorAll(".pm-pk-chip").forEach((b) => b.classList.toggle("on", b.dataset.skin === next.skin));
    };
    panel.querySelectorAll(".pm-pk-chip").forEach((b) => { b.onclick = () => apply({ skin: b.dataset.skin }); });
    panel.querySelector("#pm-pk-color").oninput = (e) => apply({ accent: e.target.value });
    panel.querySelector("#pm-pk-op").oninput = (e) => apply({ opacity: +e.target.value });
  }

  function paint() {
    if (!card) return;
    const s = st.get();
    if (!s) {
      card._running = false; // 次に開始したとき実行シェルを作り直す
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
        <div class="pm-modebox">
        ${m === "focus" ? `<div class="pm-row">
          <label>集中 <select id="pm-focus" class="pm-in">${[5, 10, 15, 25, 45, 50, 60].map((n) => `<option value="${n}"${n === 25 ? " selected" : ""}>${n}分</option>`).join("")}</select></label>
          <label>休憩 <select id="pm-break" class="pm-in">${[5, 10, 15].map((n) => `<option value="${n}">${n}分</option>`).join("")}</select></label>
        </div>` : ""}
        ${m === "countdown" ? `<div class="pm-row">
          <label>時間（分） <input id="pm-dur" class="pm-in" type="number" min="1" max="480" value="30"></label>
        </div>` : ""}
        ${m === "countup" ? `<div class="pm-hint" style="margin:0">ストップウォッチ。停止したときの経過時間を実績に記録します。</div>` : ""}
        </div>
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
    // シェルは1回だけ構築（毎秒は表示エリアのみ更新＝ピッカー入力やフォーカスが消えない・チラつかない）
    if (!card._running || card._runMode !== s.mode) {
      card._running = true; card._runMode = s.mode;
      card.innerHTML = `
        <div class="pm-h">${label} <span class="pm-cnt">本日 ${countToday()} 回</span>
          <button class="pm-gear" id="pm-gear" title="表示をカスタム">🎨</button>
          <button class="pm-x" id="pm-x">×</button></div>
        <div class="pm-disp" id="pm-disp"></div>
        <div class="pm-row">
          <button class="pm-go sub" id="pm-pause"></button>
          <button class="pm-go sub stop" id="pm-stop">■ ${s.mode === "break" ? "休憩を終わる" : "停止"}</button>
        </div>
        <button class="pm-pip" id="pm-pip" title="常に最前面の小窓にタイマーを表示（Chrome系・PWA/HTTPS）">⬆ 最前面に表示</button>
        <div class="pm-picker" id="pm-picker" hidden></div>`;
      card.querySelector("#pm-x").onclick = open;
      card.querySelector("#pm-pause").onclick = doPause;
      card.querySelector("#pm-stop").onclick = doStop;
      card.querySelector("#pm-pip").onclick = openPip;
      card.querySelector("#pm-gear").onclick = () => {
        const p = card.querySelector("#pm-picker");
        p.hidden = !p.hidden;
        if (!p.hidden) buildPicker(p);
      };
      applyCardStyle(card, dispCfg());
    }
    // 毎秒: 表示エリア＋一時停止ラベルだけ更新
    const cfg = dispCfg();
    const disp = card.querySelector("#pm-disp");
    if (disp) disp.innerHTML = renderDisplay(cfg.skin, { timeText: mmss(dispMs(s)), label, taskTitle: s.taskTitle, progress: progressOf(s), accent: cfg.accent });
    const pb = card.querySelector("#pm-pause"); if (pb) pb.textContent = s.paused ? "▶ 再開" : "⏸ 一時停止";
    return;
  }

  // ── 最前面ミニタイマー（Document Picture-in-Picture・Chrome系） ──
  async function openPip() {
    if (pip) { pip.focus(); return; }
    if (!("documentPictureInPicture" in window)) {
      // Document PiP は secure context(HTTPS) 専用。平文 http だと Chrome でも未露出になる。
      if (!window.isSecureContext) notifyDone("最前面表示には HTTPS が必要", "PWA版（https://leo.tail65add4.ts.net:7011/app/）で開くと最前面の小窓が使えます。");
      else notifyDone("最前面表示は未対応", "このブラウザは Document Picture-in-Picture に未対応です（Chrome/Edge で利用可）");
      return;
    }
    try {
      // ring/jumbo も収まるサイズ。スキンは選択中のものを反映。
      pip = await window.documentPictureInPicture.requestWindow({ width: 248, height: 210 });
    } catch (e) {
      notifyDone("最前面表示を開けません", e.message || "");
      return;
    }
    pip.document.body.style.cssText = "margin:0;font-family:system-ui,sans-serif;background:#1d2430;color:#fff;display:flex;flex-direction:column;align-items:stretch;justify-content:center;height:100vh;gap:6px;padding:10px 14px;box-sizing:border-box;user-select:none";
    pip.document.body.innerHTML = `
      <div id="pp-disp"></div>
      <div style="display:flex;gap:8px;margin-top:2px;justify-content:center">
        <button id="pp-pause" style="font:inherit;font-size:11px;border:1px solid #5b6470;border-radius:7px;background:transparent;color:#fff;padding:4px 14px;cursor:pointer">⏸</button>
        <button id="pp-stop" style="font:inherit;font-size:11px;border:1px solid #8a5054;border-radius:7px;background:transparent;color:#ff9b9b;padding:4px 14px;cursor:pointer">■</button>
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
    const d = pip.document, cfg = dispCfg();
    const label = { focus: "🍅 集中中", break: "☕ 休憩中", countdown: "⏲ カウントダウン", countup: "⏱ 計測中" }[s.mode] + (s.paused ? "（一時停止）" : "");
    const disp = d.getElementById("pp-disp");
    if (disp) disp.innerHTML = renderDisplay(cfg.skin, { timeText: mmss(dispMs(s)), label, taskTitle: s.taskTitle, progress: progressOf(s), accent: cfg.accent });
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
  .pm-h{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;margin-bottom:10px;cursor:move;user-select:none;touch-action:none}
  .pm-modebox{min-height:50px}
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
  .pm-disp{margin:4px 0 2px}
  .pm-gear{border:0;background:transparent;font-size:13px;cursor:pointer;padding:0 2px;line-height:1;opacity:.7}
  .pm-gear:hover{opacity:1}
  .pm-picker{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
  .pm-picker[hidden]{display:none}
  .pm-pk-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
  .pm-pk-chip{font:inherit;font-size:10.5px;padding:6px 0;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--muted);cursor:pointer;white-space:nowrap}
  .pm-pk-chip:hover{border-color:#b9d4ff;color:var(--ink)}
  .pm-pk-chip.on{border-color:var(--fill);background:#f3f8ff;color:var(--fill);font-weight:700}
  .pm-pk-row{display:flex;align-items:center;gap:14px;margin-top:10px;font-size:11px;color:var(--muted)}
  .pm-pk-row label{display:flex;align-items:center;gap:6px}
  .pm-pk-row input[type=color]{width:30px;height:24px;border:1px solid var(--line);border-radius:6px;background:#fff;padding:0;cursor:pointer}
  .pm-pk-op{flex:1}
  .pm-pk-op input[type=range]{flex:1;width:100%;accent-color:var(--fill)}
  .pm-time{font-size:42px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:1px;margin:6px 0 2px;color:#1d2430}
  .pm-time.brk{color:#2fa66b}
  .pm-task{font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pm-task.none{opacity:.6}
  .pm-hint{font-size:10.5px;color:var(--muted);margin-top:8px;line-height:1.5}`;
  document.head.appendChild(s);
}
