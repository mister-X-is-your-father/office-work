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
import { icon } from "../lib/icons.js";
import { todayISO } from "../lib/capacity.js";

const KEY = "ts.pomo";            // 実行中状態（下記 st 形）
const CNT = "ts.pomo.count.";     // 今日の完了集中回数（日付キー）
const BASE_TITLE = document.title || "TaskStation";
let _pomoTimer = null;            // 冪等マウント用: 軽量ループのタイマーは常に1本
let _ctl = null;                  // 外部開始用: mountPomodoro 内のクロージャ(open/loop/card)への橋渡し

// st: { taskId, taskTitle, mode: focus|break|countdown|countup, focusMin, breakMin, durMin,
//       endsAt(focus/break/countdown), startedAt(countup), paused, remainMs, elapsedMs }
const st = {
  get: () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
  set: (v) => v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY),
};
const countToday = () => +(localStorage.getItem(CNT + todayISO()) || 0);
const bumpCount = () => localStorage.setItem(CNT + todayISO(), String(countToday() + 1));

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
           : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const MODE_ICON = { focus: "timer", break: "coffee", countdown: "alarm", countup: "stopwatch" };
const modeIcon = (m, size = 15) => icon(MODE_ICON[m] || "timer", { size });
// タブタイトル用（document.title は文字列＝SVG不可なので絵文字のまま残す）
const MODE_TITLE_EMOJI = { focus: "🍅", break: "☕", countdown: "⏲", countup: "⏱" };
const MODE_TEXT = { focus: "集中中", break: "休憩中", countdown: "カウントダウン", countup: "計測中" };
// 表示エリア用ラベルHTML（アイコンSVG＋テキスト）。size 12、テキストとの間に隙間。
const modeLabel = (m, suffix = "") =>
  `${icon(MODE_ICON[m] || "timer", { size: 12 })} <span style="vertical-align:middle">${esc(MODE_TEXT[m] || "")}${esc(suffix)}</span>`;
// 表示用の残り/経過（countup は経過・他は残り）
const dispMs = (s) => s.mode === "countup"
  ? (s.paused ? s.elapsedMs : Date.now() - s.startedAt)
  : (s.paused ? s.remainMs : s.endsAt - Date.now());

// ── 表示スキン カタログ（6種・各々が別の進捗メタファ＝形で差別化）＋色・透明度カスタム（localStorage 永続） ──
// 円(ring)/数字(giant)/直線(bar)/離散(dots)/面積(fill)/成長(bloom) — 形そのものが違うので一目で区別できる。
const DISP_KEY = "ts.pomo.disp";
const SKINS = [
  { key: "ring",  name: "リング" },   // 円周がほどける
  { key: "giant", name: "数字" },     // 巨大数字のみ（小窓で最強の視認性）
  { key: "bar",   name: "バー" },     // 直線が伸びる
  { key: "dots",  name: "ドット" },   // 粒で表す
  { key: "fill",  name: "ゲージ" },   // 下から満ちる（面積）
  { key: "bloom", name: "ブルーム" }, // 中心の円が育つ
];
const SKIN_KEYS = new Set(SKINS.map((s) => s.key));
// 旧8スキン → 新6スキンへの移行（保存済み設定を壊さない）
const SKIN_MIGRATE = { card: "giant", minimal: "giant", jumbo: "giant", compact: "bar", segments: "dots" };
function dispCfg() {
  let c;
  try { c = { skin: "ring", accent: "#3a86ff", opacity: 1, ...(JSON.parse(localStorage.getItem(DISP_KEY)) || {}) }; }
  catch { c = { skin: "ring", accent: "#3a86ff", opacity: 1 }; }
  if (!SKIN_KEYS.has(c.skin)) c.skin = SKIN_MIGRATE[c.skin] || "ring";
  return c;
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
// label は modeLabel() が組むHTML（アイコンSVG＋esc済みテキスト）＝そのまま差す。
// progress: 0=開始 … 1=満了（経過の割合・どのスキンも「満ちていく」向き）／countup は null=非確定。
function renderDisplay(skin, c) {
  const ac = c.accent || "#3a86ff", t = esc(c.timeText), lbl = c.label || "";
  const pr = c.progress;
  const pct = pr == null ? 100 : Math.round(pr * 100);
  const num = (px, col) => `<div style="font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px;line-height:1;font-size:${px}px${col ? `;color:${col}` : ""}">${t}</div>`;
  const cap = (txt, mt = 5) => txt ? `<div style="font-size:10.5px;opacity:.6;margin-top:${mt}px">${txt}</div>` : "";
  const task = c.taskTitle ? `<div style="font-size:11px;opacity:.6;max-width:96%;margin:6px auto 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.taskTitle)}</div>` : "";
  const track = "rgba(127,135,150,.22)";
  switch (skin) {
    // 巨大数字: 進捗バー無し・テキスト主体（小窓でも一番読める）
    case "giant":
      return `<div style="text-align:center;padding:10px 0">${num(60, ac)}${cap(lbl, 7)}${task}</div>`;
    // 線形バー: 太い直線が伸びる（円と直交＝混同しない）
    case "bar":
      return `<div style="padding:6px 0">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px"><span style="font-size:11px;opacity:.6">${lbl}</span>${num(30)}</div>
        <div style="height:14px;border-radius:8px;background:${track};overflow:hidden"><div style="height:100%;width:${pct}%;background:${ac};border-radius:8px;transition:width .5s"></div></div>${task}</div>`;
    // 離散ドット: 粒が点いていく（連続リングと別物に見える）
    case "dots": {
      const n = 12, on = pr == null ? n : Math.round(pr * n);
      const dots = Array.from({ length: n }, (_, i) => `<span style="width:11px;height:11px;border-radius:50%;background:${i < on ? ac : track};transition:background .4s"></span>`).join("");
      return `<div style="text-align:center;padding:6px 0">${num(30)}<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:184px;margin:12px auto 0">${dots}</div>${cap(lbl, 8)}${task}</div>`;
    }
    // ゲージ: バッテリー型・下から満ちる（面積メタファ・残り減少系と逆向きで識別容易）
    case "fill": {
      const h = pr == null ? 100 : Math.max(0, Math.min(100, pct));
      return `<div style="display:flex;align-items:center;gap:15px;padding:6px 4px">
        <div style="position:relative;width:48px;height:84px;border:3px solid ${track};border-radius:11px;overflow:hidden;flex:none;background:rgba(127,135,150,.06)">
          <div style="position:absolute;left:0;right:0;bottom:0;height:${h}%;background:${ac};transition:height .5s"></div>
        </div>
        <div style="flex:1;text-align:left;min-width:0">${num(32)}${cap(lbl)}</div>
      </div>${task}`;
    }
    // ブルーム: 中心の円が育つ（面積比＝√で半径を出す。唯一の"絵"的スキン）
    case "bloom": {
      const R = 47, r = pr == null ? R * 0.55 : Math.max(4, R * Math.sqrt(Math.max(0, Math.min(1, pr))));
      return `<div style="text-align:center;padding:2px 0">
        <svg width="120" height="96" viewBox="0 0 120 96">
          <circle cx="60" cy="48" r="${R}" fill="none" stroke="${track}" stroke-width="2" stroke-dasharray="3 5"/>
          <circle cx="60" cy="48" r="${r.toFixed(1)}" fill="${ac}" style="transition:r .6s ease-out"/>
        </svg>
        ${num(26)}${cap(lbl, 4)}${task}</div>`;
    }
    // リング: 円周がほどける（王道）
    case "ring":
    default: {
      const R = 46, CIRC = 2 * Math.PI * R, off = pr == null ? 0 : CIRC * (1 - pr);
      const prog = pr == null
        ? `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${ac}" stroke-width="9" stroke-linecap="round" stroke-dasharray="5 9"/>`
        : `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${ac}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${off}" style="transition:stroke-dashoffset .5s"/>`;
      return `<div style="display:flex;flex-direction:column;align-items:center;padding:4px 0">
        <div style="position:relative;width:120px;height:120px">
          <svg width="120" height="120" viewBox="0 0 120 120" style="transform:rotate(-90deg)"><circle cx="60" cy="60" r="${R}" fill="none" stroke="${track}" stroke-width="9"/>${prog}</svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">${num(24)}<div style="font-size:10px;opacity:.6;margin-top:3px">${lbl}</div></div>
        </div>${task}</div>`;
    }
  }
}

// 設定パネルのカード用ミニサムネ（各スキンの"形"を小さく再現・アクセント色は即反映）。サンプル進捗62%。
function skinThumb(skin, ac) {
  const tr = "rgba(127,135,150,.28)";
  switch (skin) {
    case "giant":
      return `<div style="font-weight:800;font-variant-numeric:tabular-nums;font-size:21px;letter-spacing:.5px;color:${ac}">12:34</div>`;
    case "bar":
      return `<div style="width:80px"><div style="font-size:11px;font-weight:700;text-align:center;margin-bottom:6px">12:34</div><div style="height:9px;border-radius:5px;background:${tr};overflow:hidden"><div style="height:100%;width:62%;background:${ac};border-radius:5px"></div></div></div>`;
    case "dots": {
      const dots = Array.from({ length: 8 }, (_, i) => `<span style="width:7px;height:7px;border-radius:50%;background:${i < 5 ? ac : tr}"></span>`).join("");
      return `<div style="text-align:center"><div style="font-size:11px;font-weight:700;margin-bottom:6px">12:34</div><div style="display:flex;gap:5px;justify-content:center">${dots}</div></div>`;
    }
    case "fill":
      return `<div style="display:flex;align-items:center;gap:8px"><div style="position:relative;width:20px;height:34px;border:2px solid ${tr};border-radius:5px;overflow:hidden"><div style="position:absolute;left:0;right:0;bottom:0;height:62%;background:${ac}"></div></div><span style="font-size:13px;font-weight:800;font-variant-numeric:tabular-nums">12:34</span></div>`;
    case "bloom":
      return `<svg width="46" height="38" viewBox="0 0 46 38"><circle cx="23" cy="19" r="16" fill="none" stroke="${tr}" stroke-width="1.5" stroke-dasharray="2 4"/><circle cx="23" cy="19" r="11" fill="${ac}"/></svg>`;
    case "ring":
    default: {
      const R = 15, C = 2 * Math.PI * R, off = C * (1 - 0.62);
      return `<svg width="42" height="42" viewBox="0 0 42 42" style="transform:rotate(-90deg)"><circle cx="21" cy="21" r="${R}" fill="none" stroke="${tr}" stroke-width="4"/><circle cx="21" cy="21" r="${R}" fill="none" stroke="${ac}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
    }
  }
}

// タスク検索結果のHTML。語=タスク名の部分一致・大小無視（空なら全件）。
// グルーピング=「WS名 / プロジェクト(親タスク)名」。mineを含むグループを上、以降グループ名昇順、各グループ内タスク名昇順。
// 見出しにWS/プロジェクト名は出すが、選択・記録・表示に使うのはタスク名(data-title)だけ。
function taskResHtml(cands, q) {
  const needle = (q || "").trim().toLowerCase();
  const hits = (cands || []).filter((c) => !needle || c.title.toLowerCase().includes(needle));
  if (!hits.length) return `<div class="pm-res-none">該当なし</div>`;
  const groups = new Map(); // key="ws / parent" -> { hasMine, items[] }
  for (const c of hits) {
    const key = `${c.wsTitle} / ${c.parentTitle}`;
    let g = groups.get(key);
    if (!g) { g = { hasMine: false, items: [] }; groups.set(key, g); }
    if (c.mine) g.hasMine = true;
    g.items.push(c);
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title, "ja");
  const order = [...groups.entries()].sort((a, b) =>
    a[1].hasMine !== b[1].hasMine ? (a[1].hasMine ? -1 : 1) : a[0].localeCompare(b[0], "ja"));
  return order.map(([key, g]) => {
    const items = g.items.slice().sort(byTitle).map((c) =>
      `<button type="button" class="pm-res-i" data-id="${c.id}" data-title="${esc(c.title)}">${esc(c.title)}</button>`).join("");
    return `<div class="pm-res-h">${esc(key)}</div>${items}`;
  }).join("");
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

// 外部（実行サポートの「今すぐ着手」等）から集中セッションを開始する。
//   稼働中のセッションがあれば壊さない（記録漏れ防止）＝カードを開いて見せるだけで false を返す。
//   セッションが無ければ focus 状態を st に積み、マウント済みなら即カード表示＋計測開始。
export function startFocusFor(taskId, taskTitle, focusMin = 25, breakMin = 5) {
  const cur = st.get();
  if (cur) { if (_ctl) _ctl.show(); return false; } // 既に何か走っている→上書きしない
  st.set({ taskId: taskId != null ? taskId : null, taskTitle: taskTitle || "", paused: false,
           mode: "focus", focusMin, breakMin, endsAt: Date.now() + focusMin * 60000 });
  if (_ctl) _ctl.show();
  return true;
}

export function mountPomodoro(topbar) {
  if (_pomoTimer) { clearInterval(_pomoTimer); _pomoTimer = null; }
  ensureStyle();
  const btn = document.createElement("button");
  btn.id = "pm-btn";
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;pointer-events:none"><line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/></svg>`;
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.title = "集中タイマー";
  btn.setAttribute("aria-label", "集中タイマー");
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

  // タスク選択の一元化（idle・実行中カード・PiP からの選択は必ずここを通す）。
  const selectTask = (id, title) => {
    if (!card) return;
    card._taskId = id;
    card._taskTitle = title || "";
    const cur = st.get();
    if (cur) { // タイマー実行中＝実行中状態を差し替え、カード表示と PiP を即更新
      st.set({ ...cur, taskId: id, taskTitle: title || "" });
      const nm = card.querySelector("#pm-rtask-name");
      if (nm) nm.textContent = title || "（未選択）";
      paint();     // 表示エリア内のタスク名も即反映
      paintPip();  // 最前面ミニ窓も即反映
    }
  };

  // タスク検索ピッカーの配線（idle と実行中カードで共通）。scope 内の
  // #pm-task-q / #pm-task-res / #pm-task-clr を使い、行選択は onSelect(id,title) へ流す。
  function wireTaskPicker(scope, onSelect) {
    const qIn = scope.querySelector("#pm-task-q");
    const res = scope.querySelector("#pm-task-res");
    const clr = scope.querySelector("#pm-task-clr");
    if (!qIn || !res) return null;
    const renderRes = () => { res.innerHTML = taskResHtml((card && card._cands) || [], qIn.value); };
    const openRes = () => { renderRes(); res.hidden = false; };
    const closeRes = () => { res.hidden = true; };
    qIn.oninput = openRes;
    qIn.onfocus = openRes;
    qIn.onblur = () => setTimeout(closeRes, 150); // 行クリック(mousedown)を拾えるよう遅延
    // mousedown で選択（blur より先に発火＝行クリックが確実に効く）
    res.onmousedown = (e) => {
      const it = e.target.closest(".pm-res-i");
      if (!it) return;
      e.preventDefault(); // 入力のフォーカスを奪わない
      const title = it.dataset.title || "";
      qIn.value = title;
      if (clr) clr.hidden = !title;
      closeRes();
      onSelect(+it.dataset.id, title);
    };
    if (clr) clr.onclick = () => {
      qIn.value = ""; clr.hidden = true;
      qIn.focus(); renderRes(); res.hidden = false;
      onSelect(null, "");
    };
    return { qIn, res, openRes, closeRes };
  }

  // PiP のタスク名タップ等から呼ぶ: 実行中カードを前面化し、タスク変更ピッカーを開く。
  async function revealRunningTaskPicker() {
    const cur = st.get();
    if (!cur) return;
    if (!card) await open(); else { card._idle = false; loop(); }
    if (!card) return;
    const rsel = card.querySelector("#pm-rtask-sel");
    const rpick = card._rpick;
    if (rsel && rpick) {
      rsel.hidden = false;
      rpick.qIn.value = card._taskTitle || cur.taskTitle || "";
      const c = card.querySelector("#pm-task-clr"); if (c) c.hidden = !rpick.qIn.value;
      rpick.qIn.focus();
      rpick.openRes();
    }
  }

  const tickTitle = () => {
    const s = st.get();
    document.title = s && !s.paused ? `(${mmss(dispMs(s))}) ${MODE_TITLE_EMOJI[s.mode]} ${BASE_TITLE}` : BASE_TITLE;
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
    // 候補=未完了の全タスク。各候補に「WS名/プロジェクト(親タスク)名/自分の担当か」を注釈付与し
    // 検索＋階層グループのドリルダウンUIで選ばせる（記録/表示はタスク名だけ＝大分類/中分類は出さない）。
    let cands = [];
    try {
      const { tasks, projects, me } = await load();
      const wsName = new Map((projects || []).map((p) => [p.id, p.title]));
      for (const t of (tasks || []).filter((x) => !x.done)) {
        const mine = (t.assignees || []).some((a) => a.id === (me && me.id));
        const wsTitle = wsName.get(t.project_id) || "WS";
        const parentTitle = t.related_tasks?.parenttask?.[0]?.title || "(直下)";
        cands.push({ id: t.id, title: t.title, wsTitle, parentTitle, mine });
      }
    } catch { /* 未ログイン等 */ }
    card._cands = cands;
    card._mode = "focus"; // アイドル画面のモード選択
    paint();
    timer = setInterval(loop, 1000);
  };
  btn.onclick = open;

  // 外部（startFocusFor）からカードを開いて/再描画して計測表示を反映させるための橋渡し。
  _ctl = { show: () => { if (!card) open(); else { card._idle = false; loop(); } } };

  // カード全体に色/透明度を適用（半透明＝背景rgba＋ぼかし。文字は不透明のまま）
  // 背景はインラインで効く＝CSSのダーク上書きより強いので、ここでテーマ判定して暗面rgbaを使う。
  function applyCardStyle(c, cfg) {
    const op = Math.max(0.3, Math.min(1, cfg.opacity ?? 1));
    const dark = document.documentElement.dataset.theme === "dark";
    c.style.background = dark ? `rgba(31,36,44,${op})` : `rgba(255,255,255,${op})`;
    c.style.backdropFilter = op < 1 ? "blur(7px)" : "";
    c.style.webkitBackdropFilter = op < 1 ? "blur(7px)" : "";
    c.style.setProperty("--pm-accent", cfg.accent || "#3a86ff");
  }

  // 表示カスタムのピッカー（スキン6種＝ライブプレビュー・カード／色スウォッチ／透明度）。実行カード下にトグル表示。
  const PRESET_COLORS = ["#3a86ff", "#2fa66b", "#e5484d", "#f5a524", "#8b5cf6", "#1d2430"];
  function buildPicker(panel) {
    const cfg = dispCfg();
    const eqc = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
    panel.innerHTML = `
      <div class="pm-pk-sec">スタイル</div>
      <div class="pm-pk-grid" role="radiogroup" aria-label="表示スタイル">
        ${SKINS.map((sk) => `<button class="pm-pk-card${cfg.skin === sk.key ? " on" : ""}" role="radio" aria-checked="${cfg.skin === sk.key}" data-skin="${sk.key}">
          <span class="pm-pk-ck">${icon("check", { size: 12 })}</span>
          <span class="pm-pk-th">${skinThumb(sk.key, cfg.accent)}</span>
          <span class="pm-pk-nm">${esc(sk.name)}</span>
        </button>`).join("")}
      </div>
      <div class="pm-pk-sec">色</div>
      <div class="pm-pk-sw">
        ${PRESET_COLORS.map((col) => `<button class="pm-pk-swatch${eqc(cfg.accent, col) ? " on" : ""}" data-color="${col}" style="background:${col}" title="${col}"></button>`).join("")}
        <label class="pm-pk-cust" title="自由な色を選ぶ">＋<input type="color" id="pm-pk-color" value="${esc(cfg.accent)}"></label>
      </div>
      <div class="pm-pk-sec">透明度 <span class="pm-pk-opval" id="pm-pk-opval">${Math.round((cfg.opacity ?? 1) * 100)}%</span></div>
      <input type="range" id="pm-pk-op" class="pm-pk-range" min="0.3" max="1" step="0.05" value="${cfg.opacity}">`;
    const apply = (patch) => {
      const next = { ...dispCfg(), ...patch };
      saveDispCfg(next);
      applyCardStyle(card, next);
      // 本体ウィジェットへ即時プレビュー（次tickを待たずに反映）
      const s = st.get(); const disp = card.querySelector("#pm-disp");
      if (s && disp) {
        const label = modeLabel(s.mode);
        disp.innerHTML = renderDisplay(next.skin, { timeText: mmss(dispMs(s)), label, taskTitle: s.taskTitle, progress: progressOf(s), accent: next.accent });
      }
      panel.querySelectorAll(".pm-pk-card").forEach((b) => { const on = b.dataset.skin === next.skin; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
      if (patch.accent != null) {                       // 色変更はサムネとスウォッチ選択も更新
        panel.querySelectorAll(".pm-pk-card").forEach((b) => { b.querySelector(".pm-pk-th").innerHTML = skinThumb(b.dataset.skin, next.accent); });
        panel.querySelectorAll(".pm-pk-swatch").forEach((b) => b.classList.toggle("on", eqc(b.dataset.color, next.accent)));
        const ci = panel.querySelector("#pm-pk-color"); if (ci) ci.value = next.accent;
      }
      if (patch.opacity != null) { const ov = panel.querySelector("#pm-pk-opval"); if (ov) ov.textContent = Math.round(next.opacity * 100) + "%"; }
    };
    panel.querySelectorAll(".pm-pk-card").forEach((b) => { b.onclick = () => apply({ skin: b.dataset.skin }); });
    panel.querySelectorAll(".pm-pk-swatch").forEach((b) => { b.onclick = () => apply({ accent: b.dataset.color }); });
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
      const m = card._mode;
      const selTitle = card._taskTitle || ""; // 選択中タスク名（検索欄に反映・WS/親名は出さない）
      card.innerHTML = `
        <div class="pm-h">${modeIcon(m === "focus" ? "focus" : m)} 集中タイマー <span class="pm-cnt">今日 ${countToday()} 回</span><button class="pm-x" id="pm-x">×</button></div>
        <div class="pm-tabs">
          <button data-m="focus" class="${m === "focus" ? "on" : ""}">${icon("timer", { size: 12 })} ポモドーロ</button>
          <button data-m="countdown" class="${m === "countdown" ? "on" : ""}">${icon("alarm", { size: 12 })} ダウン</button>
          <button data-m="countup" class="${m === "countup" ? "on" : ""}">${icon("stopwatch", { size: 12 })} アップ</button>
        </div>
        <div class="pm-task-sel">
          <input id="pm-task-q" class="pm-in" type="text" placeholder="タスクを検索（実績の記録先）" autocomplete="off" value="${esc(selTitle)}">
          <button class="pm-task-clr" id="pm-task-clr" title="選択を解除"${selTitle ? "" : " hidden"}>×</button>
          <div class="pm-res" id="pm-task-res" hidden></div>
        </div>
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
        <button class="pm-go" id="pm-go">${icon("play", { size: 14 })} 開始</button>
        <div class="pm-hint">終了/中断時に選択タスクの実績へ自動記録（90秒未満は記録しません）</div>`;
      card.querySelector("#pm-x").onclick = open;
      card.querySelectorAll(".pm-tabs button").forEach((b) => {
        b.onclick = () => {
          // 選択は card._taskId/_taskTitle に持つので、モード切替で再paintしても保持される
          card._mode = b.dataset.m;
          card._idle = false;
          paint();
        };
      });
      // ── タスク検索ドロップダウン（共通ピッカー配線・選択は selectTask に一元化）──
      wireTaskPicker(card, selectTask);
      card.querySelector("#pm-go").onclick = () => {
        const base = {
          taskId: card._taskId ?? null,
          taskTitle: card._taskTitle || "",
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
    const label = modeLabel(s.mode);
    // シェルは1回だけ構築（毎秒は表示エリアのみ更新＝ピッカー入力やフォーカスが消えない・チラつかない）
    if (!card._running || card._runMode !== s.mode) {
      card._running = true; card._runMode = s.mode;
      card.innerHTML = `
        <div class="pm-h">${label} <span class="pm-cnt">今日 ${countToday()} 回</span>
          <button class="pm-gear" id="pm-gear" title="表示をカスタム">${icon("palette", { size: 14 })}</button>
          <button class="pm-x" id="pm-x">×</button></div>
        <div class="pm-disp" id="pm-disp"></div>
        <div class="pm-rtask"><span class="pm-rtask-lbl">タスク</span>
          <span class="pm-rtask-name" id="pm-rtask-name"></span>
          <button class="pm-rtask-edit" id="pm-rtask-edit">変更</button></div>
        <div class="pm-task-sel" id="pm-rtask-sel" hidden>
          <input id="pm-task-q" class="pm-in" type="text" placeholder="タスクを検索（実績の記録先）" autocomplete="off">
          <button class="pm-task-clr" id="pm-task-clr" title="選択を解除" hidden>×</button>
          <div class="pm-res" id="pm-task-res" hidden></div>
        </div>
        <div class="pm-row">
          <button class="pm-go sub" id="pm-pause"></button>
          <button class="pm-go sub stop" id="pm-stop">■ ${s.mode === "break" ? "休憩を終わる" : "停止"}</button>
        </div>
        <button class="pm-pip" id="pm-pip" title="常に最前面の小窓にタイマーを表示（Chrome系・PWA/HTTPS）">${icon("arrowUp", { size: 13 })} 最前面に表示</button>
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
      // 実行中のタスク変更導線: タスク行＋[変更]で idle と同じ検索ピッカーをその場に開く。
      const rname = card.querySelector("#pm-rtask-name");
      if (rname) rname.textContent = s.taskTitle || "（未選択）";
      const rsel = card.querySelector("#pm-rtask-sel");
      const redit = card.querySelector("#pm-rtask-edit");
      const rpick = wireTaskPicker(card, (id, title) => { selectTask(id, title); if (rsel) rsel.hidden = true; });
      card._rpick = rpick;
      if (redit && rsel && rpick) {
        redit.onclick = () => {
          rsel.hidden = !rsel.hidden;
          if (!rsel.hidden) {
            rpick.qIn.value = card._taskTitle || s.taskTitle || "";
            const c = card.querySelector("#pm-task-clr"); if (c) c.hidden = !rpick.qIn.value;
            rpick.qIn.focus(); rpick.openRes();
          }
        };
      }
      applyCardStyle(card, dispCfg());
    }
    // 毎秒: 表示エリア＋一時停止ラベルだけ更新
    const cfg = dispCfg();
    const disp = card.querySelector("#pm-disp");
    if (disp) disp.innerHTML = renderDisplay(cfg.skin, { timeText: mmss(dispMs(s)), label, taskTitle: s.taskTitle, progress: progressOf(s), accent: cfg.accent });
    const pb = card.querySelector("#pm-pause"); if (pb) pb.innerHTML = s.paused ? `${icon("play", { size: 13 })} 再開` : `${icon("pause", { size: 13 })} 一時停止`;
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
      // 時間＋タスク名＋細い進捗下線だけの極小レイアウト。スキンは使わない。
      // ※ Chrome は Document PiP に最小サイズを課す場合があり、指定より大きくクランプされ得る。
      pip = await window.documentPictureInPicture.requestWindow({ width: 168, height: 68 });
    } catch (e) {
      notifyDone("最前面表示を開けません", e.message || "");
      return;
    }
    // inline では :hover が書けないので <style> を1つ注入する。
    const ppStyle = pip.document.createElement("style");
    ppStyle.textContent = `
      body{margin:0;background:#1d2430;color:#fff;font-family:system-ui,sans-serif;height:100vh;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:6px 10px;box-sizing:border-box;user-select:none;position:relative;overflow:hidden}
      .pp-time{font-variant-numeric:tabular-nums;font-weight:800;line-height:1;font-size:26px;letter-spacing:.5px;color:#fff;text-align:center}
      .pp-task{font-size:10px;opacity:.6;margin-top:3px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
      .pp-bar{margin-top:5px;width:100%;height:2px;border-radius:2px;background:rgba(255,255,255,.16);overflow:hidden}
      .pp-bar>i{display:block;height:100%;border-radius:2px;transition:width .5s}
      .pp-ctrl{opacity:0;pointer-events:none;position:absolute;top:3px;right:4px;display:flex;gap:5px;transition:opacity .12s}
      body:hover .pp-ctrl{opacity:1;pointer-events:auto}
      .pp-ctrl button{font:inherit;font-size:10px;line-height:1;border:1px solid #5b6470;border-radius:6px;background:rgba(29,36,48,.9);color:#fff;padding:3px 7px;cursor:pointer}
      .pp-ctrl button#pp-stop{border-color:#8a5054;color:#ff9b9b}`;
    pip.document.head.appendChild(ppStyle);
    pip.document.body.innerHTML = `
      <div class="pp-ctrl">
        <button id="pp-pause">${icon("pause", { size: 12 })}</button>
        <button id="pp-stop">■</button>
      </div>
      <div class="pp-time" id="pp-time">--:--</div>
      <div class="pp-task" id="pp-task"></div>
      <div class="pp-bar"><i id="pp-fill"></i></div>`;
    pip.document.getElementById("pp-pause").onclick = doPause;
    pip.document.getElementById("pp-stop").onclick = doStop;
    // タスク名タップ → メインウィンドウ前面化＋実行中カードのタスク変更ピッカーを開く。
    const ppTask = pip.document.getElementById("pp-task");
    if (ppTask) {
      ppTask.style.cursor = "pointer";
      ppTask.title = "クリックでタスクを選択";
      ppTask.onclick = () => { try { window.focus(); } catch { /* noop */ } revealRunningTaskPicker(); };
    }
    pip.addEventListener("pagehide", () => { pip = null; });
    paintPip();
  }
  function paintPip() {
    if (!pip) return;
    const s = st.get();
    if (!s) { closePip(); return; }
    const d = pip.document, cfg = dispCfg();
    const timeEl = d.getElementById("pp-time");
    if (timeEl) { timeEl.textContent = mmss(dispMs(s)); timeEl.style.opacity = s.paused ? ".55" : "1"; }
    const taskEl = d.getElementById("pp-task");
    if (taskEl) { // textContent で安全に（XSS 防止）。未選択時はタップ導線の薄字を出す
      if (s.taskTitle) { taskEl.textContent = s.taskTitle; taskEl.style.fontStyle = ""; taskEl.style.opacity = ""; }
      else { taskEl.textContent = "＋ タスクを選択"; taskEl.style.fontStyle = "italic"; taskEl.style.opacity = ".5"; }
    }
    const fill = d.getElementById("pp-fill");
    if (fill) { fill.style.width = (progressOf(s) * 100).toFixed(1) + "%"; fill.style.background = cfg.accent; }
    const pb = d.getElementById("pp-pause");
    if (pb) pb.innerHTML = s.paused ? icon("play", { size: 12 }) : icon("pause", { size: 12 });
  }
  function closePip() { if (pip) { try { pip.close(); } catch { /* noop */ } pip = null; } }

  // タイマー実行中ならウィジェットを閉じていてもタブタイトル/満了処理を回す（軽量・カード無しでも動く）
  _pomoTimer = setInterval(() => { if (!card) loop(); }, 1000);
}

let _style = false;
function ensureStyle() {
  if (_style) return; _style = true;
  const s = document.createElement("style");
  s.textContent = `
  .pm-card{position:fixed;right:18px;bottom:18px;z-index:50;width:272px;background:#fff;border:1px solid var(--line);
    border-radius:14px;box-shadow:0 18px 50px rgba(10,18,35,.25);padding:14px 16px}
  .pm-h{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;margin-bottom:10px;cursor:move;user-select:none;touch-action:none}
  .pm-modebox{min-height:52px}
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
  .pm-rtask{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);margin:2px 0 6px;min-width:0}
  .pm-rtask-lbl{flex:none;opacity:.8}
  .pm-rtask-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
  .pm-rtask-edit{flex:none;font:inherit;font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--fill);cursor:pointer}
  .pm-rtask-edit:hover{border-color:#b9d4ff}
  .pm-gear{border:0;background:transparent;font-size:13px;cursor:pointer;padding:0 2px;line-height:1;opacity:.7}
  .pm-gear:hover{opacity:1}
  .pm-picker{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
  .pm-picker[hidden]{display:none}
  .pm-pk-sec{font-size:10.5px;font-weight:700;color:var(--muted);letter-spacing:.03em;margin:0 0 7px;display:flex;align-items:center;justify-content:space-between}
  .pm-pk-grid + .pm-pk-sec,.pm-pk-sw + .pm-pk-sec,.pm-pk-range + .pm-pk-sec{margin-top:14px}
  .pm-pk-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
  .pm-pk-card{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;min-height:76px;padding:10px 6px;border:1.5px solid var(--line);border-radius:10px;background:#fff;cursor:pointer;transition:border-color .12s,background .12s}
  .pm-pk-card:hover{border-color:#b9d4ff}
  .pm-pk-card.on{border-color:var(--pm-accent,var(--fill));background:#f6faff}
  .pm-pk-th{display:flex;align-items:center;justify-content:center;height:42px}
  .pm-pk-nm{font-size:10.5px;color:var(--muted);font-weight:600}
  .pm-pk-card.on .pm-pk-nm{color:var(--ink)}
  .pm-pk-ck{position:absolute;top:5px;right:7px;font-size:10px;font-weight:800;color:var(--pm-accent,var(--fill));opacity:0;transition:opacity .12s}
  .pm-pk-card.on .pm-pk-ck{opacity:1}
  .pm-pk-sw{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .pm-pk-swatch{width:24px;height:24px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px var(--line);cursor:pointer;padding:0}
  .pm-pk-swatch:hover{box-shadow:0 0 0 1px var(--line-strong,#cad1dc)}
  .pm-pk-swatch.on{box-shadow:0 0 0 2px var(--pm-accent,var(--fill))}
  .pm-pk-cust{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;border:1px dashed var(--line-strong,#cad1dc);color:var(--muted);font-size:13px;line-height:1;cursor:pointer}
  .pm-pk-cust input[type=color]{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;padding:0;cursor:pointer}
  .pm-pk-range{width:100%;margin:0;accent-color:var(--pm-accent,var(--fill))}
  .pm-pk-opval{font-weight:700;color:var(--ink)}
  .pm-time{font-size:42px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:1px;margin:6px 0 2px;color:#1d2430}
  .pm-time.brk{color:#2fa66b}
  .pm-task{font-size:12px;color:var(--muted);text-align:center;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pm-task.none{opacity:.6}
  .pm-hint{font-size:10.5px;color:var(--muted);margin-top:8px;line-height:1.5}

  /* ── タスク検索＋階層グループのドリルダウン ── */
  .pm-task-sel{position:relative}
  .pm-task-clr{position:absolute;top:5px;right:6px;width:20px;height:20px;border:0;background:transparent;
    color:var(--muted);font-size:15px;line-height:1;cursor:pointer;padding:0}
  .pm-task-clr:hover{color:var(--ink)}
  .pm-task-clr[hidden]{display:none}
  .pm-res{position:absolute;left:0;right:0;top:32px;z-index:5;max-height:190px;overflow:auto;
    background:#fff;border:1px solid var(--line);border-radius:9px;box-shadow:0 10px 26px rgba(10,18,35,.18);padding:4px 0}
  .pm-res[hidden]{display:none}
  .pm-res-h{position:sticky;top:0;background:#fff;font-size:10px;font-weight:700;color:var(--muted);
    letter-spacing:.02em;padding:5px 10px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pm-res-i{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:12.5px;
    color:var(--ink);padding:6px 10px 6px 16px;border:0;background:transparent;cursor:pointer;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pm-res-i:hover{background:#f3f8ff}
  .pm-res-none{font-size:12px;color:var(--muted);padding:8px 10px}

  /* ===== ダークモード上書き（lightは不変。<button>はglobalのinput/select規則の対象外＝明示が必要） ===== */
  /* カード面: background はJS(applyCardStyle)がテーマ判定でinline上書きするので、ここでは枠/影のみ */
  html[data-theme="dark"] .pm-card{border-color:var(--line);box-shadow:0 18px 50px rgba(0,0,0,.5)}
  html[data-theme="dark"] .pm-tabs button{background:var(--card);border-color:var(--line);color:var(--muted)}
  html[data-theme="dark"] .pm-tabs button.on{border-color:var(--fill);color:#8db8ff;background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .pm-in{background:var(--card);color:var(--ink);border-color:var(--line)}
  html[data-theme="dark"] .pm-res{background:var(--card);border-color:var(--line);box-shadow:0 10px 26px rgba(0,0,0,.5)}
  html[data-theme="dark"] .pm-res-h{background:var(--card)}
  html[data-theme="dark"] .pm-res-i{color:var(--ink)}
  html[data-theme="dark"] .pm-res-i:hover{background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .pm-task-clr:hover{color:var(--ink)}
  html[data-theme="dark"] .pm-go.sub{background:var(--card);color:#8db8ff}
  html[data-theme="dark"] .pm-go.sub.stop{background:var(--card);border-color:rgba(229,72,77,.45);color:#ff9b96}
  html[data-theme="dark"] .pm-pip{background:var(--card);border-color:var(--line);color:var(--muted)}
  html[data-theme="dark"] .pm-pip:hover{color:#8db8ff;border-color:rgba(58,134,255,.45)}
  html[data-theme="dark"] .pm-picker{border-top-color:var(--line)}
  html[data-theme="dark"] .pm-pk-card{background:var(--card);border-color:var(--line)}
  html[data-theme="dark"] .pm-pk-card:hover{border-color:rgba(58,134,255,.45)}
  html[data-theme="dark"] .pm-pk-card.on{border-color:var(--pm-accent,var(--fill));background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .pm-pk-swatch{border-color:var(--card)}
  html[data-theme="dark"] .pm-time{color:var(--ink)}
  html[data-theme="dark"] .pm-time.brk{color:#7fd6a6}
  html[data-theme="dark"] .pm-rtask-name{color:var(--ink)}
  html[data-theme="dark"] .pm-rtask-edit{background:var(--card);border-color:var(--line);color:#8db8ff}
  html[data-theme="dark"] .pm-rtask-edit:hover{border-color:rgba(58,134,255,.45)}`;
  document.head.appendChild(s);
}
