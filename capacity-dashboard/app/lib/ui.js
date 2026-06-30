// 共有UIヘルパ（モックのデザイントークンを踏襲）
// 構造色は CSS変数(index.html :root / [data-theme=dark])参照＝テーマで反転。
// アクセント色(fill/over/free/full/amber/capline)とpj/memberは両テーマ共通のためhex据え置き
// （SVGの stroke/fill 属性は var() が効かないが、SVGで使うのは over/capline のみ＝hexなので無事）。
import { icon } from "./icons.js";
export const C = {
  bg:"var(--bg)", card:"var(--card)", ink:"var(--ink)", muted:"var(--muted)", line:"var(--line)", lineStrong:"var(--line-strong)", track:"var(--track)",
  fill:"#3a86ff", over:"#e5484d", free:"#2fa66b", full:"#8a93a0", amber:"#f5a623", capline:"#9aa3af",
  pj:{ Backend:"#3a86ff", Frontend:"#2fa66b", QA:"#b657d6", "共通":"#8a93a0" },
};
export const member_color = (i)=> ["#e5772d","#3a86ff","#2fa66b","#b657d6","#0ea5e9","#f5a623"][i%6];

// 時間表示は小数2桁まで（15分=0.25 を 0.3 に潰さない）。末尾の0は省く（1.50→1.5 / 4→4）。
export const fmtH = (h)=> { const r = Math.round(h*100)/100; return (Number.isInteger(r) ? r : +r.toFixed(2)) + "h"; };
export const esc = (s)=> (s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
export { todayISO } from "./capacity.js"; // 「今日」の SSoT は capacity.js（ローカル暦日。UTC だと JST 早朝に前日ズレ）

// 最小 hyperscript
export function h(tag, attrs, ...kids){
  const e = document.createElement(tag);
  if(attrs) for(const [k,v] of Object.entries(attrs)){
    if(k==="class") e.className=v;
    else if(k==="html") e.innerHTML=v;
    else if(k.startsWith("on") && typeof v==="function") e.addEventListener(k.slice(2),v);
    else if(v!=null) e.setAttribute(k,v);
  }
  for(const k of kids.flat()){ if(k==null) continue; e.append(k.nodeType?k:document.createTextNode(k)); }
  return e;
}
export const clear = (el)=>{ el.innerHTML=""; return el; };

// 容量バー（assignedH / capH, 超過は赤）
export function capacityBar(assignedH, capH, scaleMaxH){
  const max = scaleMaxH || Math.max(capH*1.3, assignedH);
  const inCap = Math.min(assignedH, capH), over = Math.max(0, assignedH-capH);
  return `<div style="position:relative;height:24px;background:${C.track};border-radius:7px;overflow:hidden">
    <div style="position:absolute;left:${capH/max*100}%;top:0;bottom:0;width:2px;background:${C.capline}"></div>
    <div style="position:absolute;left:0;top:0;bottom:0;width:${inCap/max*100}%;background:${C.fill};border-radius:7px 0 0 7px"></div>
    ${over>0?`<div style="position:absolute;left:${capH/max*100}%;top:0;bottom:0;width:${over/max*100}%;background:${C.over}"></div>`:""}
  </div>`;
}

// ── 共通UI部品（HTML文字列を返す純関数。announce のみ DOM 操作） ───────────
// CSS は index.html のグローバル <style>（.ui-empty / .ui-error / .ui-skel / .ui-ava 等）側に置く。

// スクリーンリーダ向けライブリージョンへ読み上げ依頼。
//   assertive 真 → #ts-live-alert（role=alert）、偽 → #ts-live（polite）。
//   連続同一文言でも読み上がるよう、一旦空にして次フレームでセットする。
//   対象要素が無ければ何もしない（安全）。
export function announce(msg, opts = {}) {
  if (typeof document === "undefined") return;
  const id = opts.assertive ? "ts-live-alert" : "ts-live";
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = "";
  const set = () => { el.textContent = msg == null ? "" : String(msg); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(set);
  else setTimeout(set, 16);
}

// 空状態の中央寄せカード（HTML文字列）。
//   opts: { icon, title, desc, actionLabel, actionHref }
//   icon は icons.js のキー名（任意）。action があれば <a class="ui-empty-act"> を出す。
export function emptyState(opts = {}) {
  const ic = opts.icon ? `<div class="ui-empty-ic">${icon(opts.icon, { size: 30 })}</div>` : "";
  const title = opts.title ? `<div class="ui-empty-title">${esc(opts.title)}</div>` : "";
  const desc = opts.desc ? `<div class="ui-empty-desc">${esc(opts.desc)}</div>` : "";
  const act = (opts.actionLabel && opts.actionHref)
    ? `<a class="ui-empty-act" href="${esc(opts.actionHref)}">${esc(opts.actionLabel)}</a>` : "";
  return `<div class="ui-empty">${ic}${title}${desc}${act}</div>`;
}

// エラーカード（HTML文字列）。message は esc 済みで埋め込む。
//   opts: { title = "読み込みに失敗しました", retryId }
//   retryId 指定時は <button id="${retryId}" class="ui-retry">再試行</button> を含める（onclick は呼び出し側で配線）。
export function errorState(message, opts = {}) {
  const title = opts.title == null ? "読み込みに失敗しました" : opts.title;
  const retry = opts.retryId
    ? `<button id="${esc(opts.retryId)}" class="ui-retry" type="button">再試行</button>` : "";
  return `<div class="card ui-error">
    <div class="ui-error-ic">${icon("alertTriangle", { size: 24 })}</div>
    <div class="ui-error-title">${esc(title)}</div>
    ${message ? `<div class="ui-error-msg">${esc(message)}</div>` : ""}
    ${retry}
  </div>`;
}

// スケルトン（読み込み中のプレースホルダ行。shimmer は CSS 側）。
//   opts: { rows = 5 }
export function skeleton(opts = {}) {
  const rows = Math.max(1, opts.rows || 5);
  let out = `<div class="ui-skel" aria-hidden="true">`;
  for (let i = 0; i < rows; i++) out += `<div class="ui-skel-row"></div>`;
  out += `</div>`;
  return out;
}

// ── 再取得オーバーレイ／フォーカストラップ ───────────────────────────────
// CSS は index.html ではなく ここから 1 度だけ <style id="ui-overlay-style"> を注入する（冪等）。
//   色は CSS 変数（--card/--line/--fill 等）参照＝ダーク対応。
let _overlayStyleInjected = false;
function ensureOverlayStyle() {
  if (_overlayStyleInjected) return;
  if (typeof document === "undefined" || !document.head) return;
  _overlayStyleInjected = true;
  const s = document.createElement("style");
  s.id = "ui-overlay-style";
  s.textContent = `
  .ui-refresh-ov{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--card) 55%, transparent);backdrop-filter:saturate(120%) blur(.5px);
    -webkit-backdrop-filter:saturate(120%) blur(.5px);animation:ui-ov-in .12s ease-out}
  @keyframes ui-ov-in{from{opacity:0}to{opacity:1}}
  .ui-refresh-spin{width:30px;height:30px;border-radius:50%;
    border:3px solid var(--line);border-top-color:var(--fill);animation:ui-ov-rot .7s linear infinite}
  @keyframes ui-ov-rot{to{transform:rotate(360deg)}}
  /* 中央モーダルの共有バックドロップ（openOverlay）。カード本体は各呼び出し側が既存CSSで描画＝視覚不変。 */
  .ov-bg{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
    background:rgba(15,22,36,.42);animation:ui-ov-in .12s ease-out;padding:16px;box-sizing:border-box}
  .ov-bg.ov-top{align-items:flex-start;padding-top:11vh}
  @media (prefers-reduced-motion:reduce){
    .ui-refresh-ov{animation:none}
    .ui-refresh-spin{animation-duration:1.6s}
    .ov-bg{animation:none}
  }`;
  document.head.appendChild(s);
}

// ── 中央モーダルの共有プリミティブ openOverlay ───────────────────────────
// 各画面のバラバラなモーダル開閉（バックドロップ生成/Escape/背景クリック/フォーカストラップ/スクロールロック）を統一。
//   card: 呼び出し側が作るカード要素（.tf-card / .sp-box / .cal-ovm-card 等。既存クラス・CSSのまま＝視覚パリティ維持）。
//   opts: { onClose?, align?('center'|'top'), closeOnBackdrop?(=true), initialFocus?(HTMLElement) }
//   戻り値: { bg, card, close }。close() で keydown/背景/trapFocus 解除＋スクロール復帰＋bg除去＋onClose。多重closeは無害。
// ＝ caller は「カードを作って openOverlay に渡す」だけ。背景・Escape・背景クリック・Tab閉じ込め・body固定が自動で付く。
export function openOverlay(card, opts = {}) {
  ensureOverlayStyle();
  const bg = document.createElement("div");
  bg.className = "ov-bg" + (opts.align === "top" ? " ov-top" : "");
  if (card) bg.appendChild(card);
  document.body.appendChild(bg);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden"; // 背面スクロールロック
  let closed = false;
  const release = trapFocus(card);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const onDown = (e) => { if (e.target === bg && opts.closeOnBackdrop !== false) close(); };
  function close() {
    if (closed) return; closed = true;
    document.removeEventListener("keydown", onKey, true);
    bg.removeEventListener("mousedown", onDown);
    release();
    document.body.style.overflow = prevOverflow;
    bg.remove();
    if (typeof opts.onClose === "function") opts.onClose();
  }
  bg.addEventListener("mousedown", onDown);
  document.addEventListener("keydown", onKey, true); // capture＝内部入力の stopPropagation でも Esc を拾える
  if (opts.initialFocus && typeof opts.initialFocus.focus === "function") opts.initialFocus.focus();
  return { bg, card, close };
}

// 再取得オーバーレイ: rootEl に薄い半透明オーバーレイ＋スピナーを出し、await fn() の間表示。
//   終了で必ず除去（finally）。rootEl が position:static のときだけ一時的に relative を当て、復帰させる。
//   戻り値は fn() の解決値。fn が無ければ何もせず undefined。
export async function withRefresh(rootEl, fn) {
  if (typeof fn !== "function") return undefined;
  if (!rootEl || typeof document === "undefined") return await fn();
  ensureOverlayStyle();
  const cs = (typeof getComputedStyle === "function") ? getComputedStyle(rootEl) : null;
  const needsRel = cs && cs.position === "static";
  const prevInlinePos = rootEl.style.position;
  if (needsRel) rootEl.style.position = "relative";
  const ov = document.createElement("div");
  ov.className = "ui-refresh-ov";
  ov.setAttribute("aria-hidden", "true");
  ov.innerHTML = `<div class="ui-refresh-spin"></div>`;
  rootEl.appendChild(ov);
  try {
    return await fn();
  } finally {
    ov.remove();
    if (needsRel) {
      if (prevInlinePos) rootEl.style.position = prevInlinePos;
      else rootEl.style.removeProperty("position");
    }
  }
}

// フォーカストラップ: containerEl 内に Tab/Shift+Tab を閉じ込める。
//   戻り値は解除関数（呼び出し側が閉じる時に必ず呼ぶ）。containerEl が無ければ no-op を返す。
//   フォーカス可能要素は標準セレクタで都度収集（動的な内容にも追従）。
export function trapFocus(containerEl) {
  if (!containerEl || typeof document === "undefined") return () => {};
  const SEL = [
    "a[href]", "button:not([disabled])", "textarea:not([disabled])",
    "input:not([disabled])", "select:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  const focusables = () => Array.prototype.filter.call(
    containerEl.querySelectorAll(SEL),
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
  );
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) { e.preventDefault(); containerEl.focus(); return; }
    const first = list[0], last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !containerEl.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !containerEl.contains(active)) { e.preventDefault(); first.focus(); }
    }
  };
  containerEl.addEventListener("keydown", onKey);
  return () => containerEl.removeEventListener("keydown", onKey);
}

// メンバーのイニシャル・アバター（HTML文字列）。
//   member: { id, name, username [, colorIndex] }、opts: { size = 18 }
//   背景は member_color（colorIndex 優先、無ければ id ベース）。member が falsy なら空文字。
export function avatar(member, opts = {}) {
  if (!member) return "";
  const size = opts.size || 18;
  const label = member.name || member.username || "";
  const initial = label ? String(label).trim().charAt(0).toUpperCase() : "?";
  const idx = Number.isInteger(member.colorIndex) ? member.colorIndex : ((member.id || 0) % 6);
  const bg = member_color(idx);
  const fs = Math.max(9, Math.round(size * 0.52));
  return `<span class="ui-ava" title="${esc(label)}" aria-hidden="true" style="width:${size}px;height:${size}px;background:${bg};font-size:${fs}px">${esc(initial)}</span>`;
}
