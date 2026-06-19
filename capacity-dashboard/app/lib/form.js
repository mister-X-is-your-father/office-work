// 共有フォーム部品（taskform / recurrenceform / calendar 共用）。
// - スマート日付入力のパース（数字だけで月日・年は当年補完）
// - 説明/メモへの埋め込み規約: "[資料] URL" 行（複数可・位置不問）＋ "[ゴール]" 行以降ブロック
// - 時間(h)入力: ▲▼ボタン＋↑↓キーで0.25刻み・先頭ドット補完（markup+wireのペア）
// - 資料リンクのチップ入力（Enter/blurで追加・×で除去・httpはリンク）
// UI部品のスタイル（.tf-step/.tf-chips 等）は taskform の ensureStyle が注入する前提（同一モーダル内で使用）。
import { esc } from "./ui.js";

// ── スマート日付 ──────────────────────────────────────────────
//   2桁 "62"→6月2日 / 3桁 "612"→6月12日 / 4桁 "1112"→11月12日 / 8桁 "20261112"
//   "6/12"→当年6/12、"2026/11/12"・"2026-11-12" は年も解釈。返り値 "YYYY-MM-DD"（不正なら null）。
const pad2 = (n) => String(n).padStart(2, "0");
function mkDate(y, mo, da) {
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${y}-${pad2(mo)}-${pad2(da)}`;
}
export function parseSmartDate(raw) {
  if (raw == null) return null;
  // 末尾の曜日表示「（月）/(月)」は表示用サフィックスなので無視してパース
  const s = String(raw).trim().replace(/[（(][日月火水木金土][)）]\s*$/, "").trim();
  if (!s) return null;
  const Y = new Date().getFullYear();
  let m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})$/); // 2026/11/12・2026-11-12
  if (m) return mkDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\D+(\d{1,2})$/); // 11/12（年なし）→当年
  if (m) return mkDate(Y, +m[1], +m[2]);
  const d = s.replace(/\D/g, "");
  if (d.length === 8) return mkDate(+d.slice(0, 4), +d.slice(4, 6), +d.slice(6, 8)); // 20261112
  if (d.length === 4) return mkDate(Y, +d.slice(0, 2), +d.slice(2, 4)); // 1112 → 11/12
  if (d.length === 3) return mkDate(Y, +d.slice(0, 1), +d.slice(1, 3)); // 612 → 6/12
  if (d.length === 2) return mkDate(Y, +d.slice(0, 1), +d.slice(1, 2)); // 62 → 6/2
  return null;
}
export const fmtDisplay = (iso) => { const [y, mo, da] = iso.split("-"); return `${y}/${mo}/${da}`; };
export const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
// 入力欄の表示用: 曜日サフィックス付き "2026/06/15（月）"（parseSmartDate はこの形式を読み戻せる）
export const fmtDisplayDow = (iso) => `${fmtDisplay(iso)}（${DOW_JA[new Date(iso + "T00:00:00Z").getUTCDay()]}）`;

// ── "[資料]"/"[ゴール]"/"[チェック]" 埋め込み規約（description/note は本フォーム群のみが読み書き） ──
// [チェック] ブロックは "- [ ] 項目" / "- [x] 項目" の行列（TickTickのチェックリスト相当。
// プレーンテキストのまま本体UIでも読める）。ブロックは次のマーカーまで。
const DOC_LINE_RE = /^\[資料\]\s*(.+)$/;
const CHECK_LINE_RE = /^- \[( |x)\]\s?(.*)$/;
const GOAL_MARK = "[ゴール]";
const CHECK_MARK = "[チェック]";
export function splitMeta(desc) {
  const links = [], lines = [];
  for (const line of String(desc || "").split("\n")) {
    const m = line.match(DOC_LINE_RE);
    if (m) links.push(m[1].trim()); else lines.push(line);
  }
  const isMark = (l) => l.trim() === GOAL_MARK || l.trim() === CHECK_MARK;
  const gi = lines.findIndex((l) => l.trim() === GOAL_MARK);
  const ci = lines.findIndex((l) => l.trim() === CHECK_MARK);
  const firstMark = [gi, ci].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const until = (from) => { // from の次行から次のマーカー直前まで
    const end = lines.findIndex((l, i) => i > from && isMark(l));
    return lines.slice(from + 1, end < 0 ? lines.length : end);
  };
  const text = (firstMark != null ? lines.slice(0, firstMark) : lines).join("\n").replace(/\n+$/, "");
  const goal = gi >= 0 ? until(gi).join("\n").trim() : "";
  const checks = [];
  if (ci >= 0) for (const l of until(ci)) {
    const m = l.match(CHECK_LINE_RE);
    if (m) checks.push({ text: m[2], done: m[1] === "x" });
    else if (l.trim()) checks.push({ text: l.trim(), done: false }); // 手書き行も拾う（消失防止）
  }
  return { text, goal, links, checks };
}
export function joinMeta(text, goal, links, checks = []) {
  let out = String(text || "").replace(/\s+$/, "");
  if (goal && goal.trim()) out += (out ? "\n\n" : "") + GOAL_MARK + "\n" + goal.trim();
  if (checks.length) out += (out ? "\n\n" : "") + CHECK_MARK + "\n" +
    checks.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
  if (links.length) out += (out ? "\n\n" : "") + links.map((u) => `[資料] ${u}`).join("\n");
  return out;
}

// ── 時間(h)入力（▲▼＋↑↓キー・0.25刻み） ──────────────────────────
export function hourInputHtml(id, { value = "", placeholder = "例: 0.25" } = {}) {
  return `<div class="tf-step">
    <input id="${id}" class="tf-in" type="text" inputmode="decimal" autocomplete="off" value="${esc(String(value))}" placeholder="${esc(placeholder)}">
    <div class="tf-step-btns">
      <button type="button" id="${id}-up" tabindex="-1" aria-label="増やす">▲</button>
      <button type="button" id="${id}-dn" tabindex="-1" aria-label="減らす">▼</button>
    </div>
  </div>`;
}
export function wireHourInput(root, id, { step = 0.25, min = 0 } = {}) {
  const input = root.querySelector("#" + id);
  input.onblur = () => { input.value = input.value.trim().replace(/^\./, "0."); };
  const stepBy = (delta) => {
    const cur = parseFloat(input.value.trim().replace(/^\./, "0."));
    const next = Math.max(min, (isFinite(cur) ? cur : 0) + delta);
    input.value = next ? String(Math.round(next * 100) / 100) : "";
    input.focus();
  };
  input.onkeydown = (ev) => {
    if (ev.key === "ArrowUp") { ev.preventDefault(); stepBy(step); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); stepBy(-step); }
  };
  root.querySelector(`#${id}-up`).onclick = () => stepBy(step);
  root.querySelector(`#${id}-dn`).onclick = () => stepBy(-step);
  return input;
}

// ── 日付ピッカー（土日祝を色分け・スマート入力と併用） ─────────────────
// 月グリッド: その月の日曜始まり6週分の [{iso, inMonth}] 配列（純関数・テスト対象）。
export function monthMatrix(year, month1) {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay()); // 直前の日曜へ
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + w * 7 + i);
      row.push({ iso: d.toISOString().slice(0, 10), inMonth: d.getUTCMonth() === month1 - 1 });
    }
    weeks.push(row);
  }
  return weeks;
}

// input にカレンダーポップオーバーを付ける。フォーカスで開く・日クリックで選択（曜日付き表示に整形して
// blur イベントを発火＝既存の整形/曜日追従フックがそのまま動く）。土曜=青・日曜/祝日=赤、祝日は名前ツールチップ。
// holidaysByDate: Map<"YYYY-MM-DD", 祝日名>（無ければ週末色のみ）。
export function attachDatePicker(input, { holidaysByDate = null } = {}) {
  ensureDatePickerStyle();
  const wrap = input.parentElement;
  if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
  const pop = document.createElement("div");
  pop.className = "tf-dp";
  pop.hidden = true;
  wrap.appendChild(pop);

  let view = null; // {y, m}（表示中の月）
  const todayIso = new Date().toISOString().slice(0, 10);
  const holName = (iso) => (holidaysByDate && (holidaysByDate.get ? holidaysByDate.get(iso) : holidaysByDate[iso])) || null;
  // ISO "YYYY-MM-DD" を日/月単位でずらす（UTC基準でparse/表示と一致）。
  const shiftIso = (iso, { days = 0, months = 0 } = {}) => {
    const d = new Date(iso + "T00:00:00Z");
    if (months) d.setUTCMonth(d.getUTCMonth() + months);
    if (days) d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const renderCal = () => {
    const sel = parseSmartDate(input.value);
    if (!view) {
      const base = sel || todayIso;
      view = { y: +base.slice(0, 4), m: +base.slice(5, 7) };
    }
    const rows = monthMatrix(view.y, view.m).map((week) => week.map((c) => {
      const dow = new Date(c.iso + "T00:00:00Z").getUTCDay();
      const hol = holName(c.iso);
      const cls = ["tf-dp-d"];
      if (!c.inMonth) cls.push("out");
      if (dow === 6) cls.push("sat");
      if (dow === 0 || hol) cls.push("sun");
      if (c.iso === todayIso) cls.push("today");
      if (sel && c.iso === sel) cls.push("sel");
      return `<button type="button" class="${cls.join(" ")}" data-iso="${c.iso}"${hol ? ` title="${esc(hol)}"` : ""}>${+c.iso.slice(8, 10)}${hol ? `<i></i>` : ""}</button>`;
    }).join("")).join("");
    pop.innerHTML = `
      <div class="tf-dp-h">
        <button type="button" class="tf-dp-nav" data-d="-1">‹</button>
        <span>${view.y}年${view.m}月</span>
        <button type="button" class="tf-dp-nav" data-d="1">›</button>
      </div>
      <div class="tf-dp-w">${DOW_JA.map((n, i) => `<span class="${i === 6 ? "sat" : i === 0 ? "sun" : ""}">${n}</span>`).join("")}</div>
      <div class="tf-dp-g">${rows}</div>`;
    pop.querySelectorAll(".tf-dp-nav").forEach((b) => {
      b.onmousedown = (ev) => ev.preventDefault(); // blur させない
      b.onclick = () => {
        let m = view.m + (+b.dataset.d), y = view.y;
        if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
        view = { y, m };
        renderCal();
      };
    });
    pop.querySelectorAll(".tf-dp-d").forEach((b) => {
      b.onmousedown = (ev) => ev.preventDefault();
      b.onclick = () => {
        input.value = fmtDisplayDow(b.dataset.iso);
        close();
        input.dispatchEvent(new Event("blur")); // 既存の onblur 整形/曜日追従を発火（フォーカスは移動しない）
      };
    });
  };
  const open = () => {
    // 親が .tf-col とは限らない（入力欄の直親に追従して入力欄の直下に出す）
    pop.style.top = (input.offsetTop + input.offsetHeight + 4) + "px";
    pop.style.left = input.offsetLeft + "px";
    pop.hidden = false;
    renderCal();
  };
  const close = () => { pop.hidden = true; view = null; };
  // キーボードで日付を移動: 現在値（無ければ今日）を基準にずらして入力欄へ反映。
  // 既存の input イベント経由でハイライト/月表示が追従する（parseSmartDate がこの表示形式を読み戻せる）。
  const moveBy = (opts) => {
    const cur = parseSmartDate(input.value) || todayIso;
    const next = shiftIso(cur, opts);
    input.value = fmtDisplayDow(next);
    view = { y: +next.slice(0, 4), m: +next.slice(5, 7) }; // 移動先の月へ追従
    if (pop.hidden) open(); else renderCal(); // 開いてなければ開く（=renderCal も走る）
    input.dispatchEvent(new Event("input")); // 他のリスナ（整形/曜日追従）にも変更を通知
  };
  input.addEventListener("focus", open);
  input.addEventListener("click", open); // フォーカス済みの欄を再クリック（Escで閉じた後など）でも開く
  input.addEventListener("input", () => { if (!pop.hidden) renderCal(); }); // タイプ中も選択ハイライト追従
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { close(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); moveBy({ days: -1 }); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); moveBy({ days: 1 }); }
    else if (ev.key === "PageUp") { ev.preventDefault(); moveBy({ months: -1 }); }
    else if (ev.key === "PageDown") { ev.preventDefault(); moveBy({ months: 1 }); }
    else if (ev.key === "Enter") {
      // ピッカーが開いていれば確定（整形して閉じる）。閉じていれば既存のフォーム送信等に委ねる。
      if (!pop.hidden) {
        ev.preventDefault();
        const cur = parseSmartDate(input.value);
        if (cur) input.value = fmtDisplayDow(cur);
        close();
        input.dispatchEvent(new Event("blur")); // 既存の整形/曜日追従を発火
      }
    }
  });
}

let _dpStyle = false;
function ensureDatePickerStyle() {
  if (_dpStyle) return; _dpStyle = true;
  const s = document.createElement("style");
  s.textContent = `
  .tf-dp{position:absolute;z-index:6;background:#fff;border:1px solid #e6e9ee;border-radius:12px;box-shadow:0 10px 30px rgba(20,30,50,.16);padding:10px;width:238px}
  .tf-dp-h{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:700;margin-bottom:6px}
  .tf-dp-nav{border:0;background:transparent;font-size:16px;cursor:pointer;color:#6b7480;padding:2px 9px;border-radius:7px}
  .tf-dp-nav:hover{background:#eef4ff;color:#3a86ff}
  .tf-dp-w{display:grid;grid-template-columns:repeat(7,1fr);font-size:10.5px;color:#6b7480;text-align:center;margin-bottom:2px}
  .tf-dp-w .sat{color:#3a86ff}.tf-dp-w .sun{color:#e5484d}
  .tf-dp-g{display:grid;grid-template-columns:repeat(7,1fr);gap:1px}
  .tf-dp-d{position:relative;border:0;background:transparent;font:inherit;font-size:12px;padding:5px 0;border-radius:7px;cursor:pointer;color:#1d2430;text-align:center}
  .tf-dp-d:hover{background:#eef4ff}
  .tf-dp-d.out{color:#c3c9d2}
  .tf-dp-d.sat{color:#3a86ff}.tf-dp-d.sat.out{color:#b9d4ff}
  .tf-dp-d.sun{color:#e5484d}.tf-dp-d.sun.out{color:#f3bfc1}
  .tf-dp-d.today{outline:1px solid #3a86ff;outline-offset:-1px}
  .tf-dp-d.sel{background:#3a86ff;color:#fff}
  .tf-dp-d i{position:absolute;left:50%;bottom:1px;transform:translateX(-50%);width:4px;height:4px;border-radius:50%;background:#e5484d}
  .tf-dp-d.sel i{background:#fff}`;
  document.head.appendChild(s);
}

// ── チェックリスト編集（checks 配列 [{text,done}] を直接編集する） ─────────
// スタイル(.tf-checks 等)は taskform の ensureStyle が注入する前提（docChips と同様）。
export function checksHtml(id, { placeholder = "項目を入力して Enter" } = {}) {
  return `<div class="tf-checks" id="${id}-list"></div>
    <input id="${id}" class="tf-in" autocomplete="off" placeholder="${esc(placeholder)}">`;
}
export function wireChecks(root, id, checks, { onChange = () => {} } = {}) {
  const input = root.querySelector("#" + id);
  const box = root.querySelector(`#${id}-list`);
  const render = () => {
    box.innerHTML = checks.map((c, i) => `
      <label class="tf-check${c.done ? " done" : ""}">
        <input type="checkbox" data-i="${i}"${c.done ? " checked" : ""}>
        <span>${esc(c.text)}</span>
        <button type="button" class="tf-chip-x" data-i="${i}" aria-label="削除">×</button>
      </label>`).join("");
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.onchange = () => { checks[+cb.dataset.i].done = cb.checked; render(); };
    });
    box.querySelectorAll(".tf-chip-x").forEach((b) => {
      b.onclick = (ev) => { ev.preventDefault(); checks.splice(+b.dataset.i, 1); render(); };
    });
    onChange(checks.filter((c) => c.done).length, checks.length);
  };
  const add = () => {
    const v = input.value.trim();
    if (v) { checks.push({ text: v, done: false }); input.value = ""; render(); }
  };
  input.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
  input.onblur = add; // 入力したまま保存を押しても拾う
  render();
  return { render, add };
}

// ── 資料リンクのチップ入力（links 配列を直接編集する） ─────────────────
export function docChipsHtml(id, { placeholder = "https://… を入力して Enter" } = {}) {
  return `<input id="${id}" class="tf-in" autocomplete="off" placeholder="${esc(placeholder)}">
    <div class="tf-chips" id="${id}-chips"></div>`;
}
export function wireDocChips(root, id, links) {
  const input = root.querySelector("#" + id);
  const box = root.querySelector(`#${id}-chips`);
  const render = () => {
    box.innerHTML = links.map((u, i) => {
      const label = esc(u.length > 46 ? u.slice(0, 44) + "…" : u);
      const body = /^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : label;
      return `<span class="tf-chip" title="${esc(u)}">${body}<button type="button" class="tf-chip-x" data-i="${i}">×</button></span>`;
    }).join("");
    box.querySelectorAll(".tf-chip-x").forEach((b) => { b.onclick = () => { links.splice(+b.dataset.i, 1); render(); }; });
  };
  const add = () => {
    const v = input.value.trim();
    if (v && !links.includes(v)) { links.push(v); render(); }
    if (v) input.value = "";
  };
  input.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
  input.onblur = add; // 入力したまま保存を押しても拾う
  render();
  return { render, add };
}
