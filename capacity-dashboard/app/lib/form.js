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
  const s = String(raw).trim();
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

// ── "[資料]"/"[ゴール]" 埋め込み規約（description/note は本フォーム群のみが読み書き） ──
const DOC_LINE_RE = /^\[資料\]\s*(.+)$/;
const GOAL_MARK = "[ゴール]";
export function splitMeta(desc) {
  const links = [], lines = [];
  for (const line of String(desc || "").split("\n")) {
    const m = line.match(DOC_LINE_RE);
    if (m) links.push(m[1].trim()); else lines.push(line);
  }
  const gi = lines.findIndex((l) => l.trim() === GOAL_MARK);
  const text = (gi >= 0 ? lines.slice(0, gi) : lines).join("\n").replace(/\n+$/, "");
  const goal = gi >= 0 ? lines.slice(gi + 1).join("\n").trim() : "";
  return { text, goal, links };
}
export function joinMeta(text, goal, links) {
  let out = String(text || "").replace(/\s+$/, "");
  if (goal && goal.trim()) out += (out ? "\n\n" : "") + GOAL_MARK + "\n" + goal.trim();
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
