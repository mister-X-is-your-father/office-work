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
export const todayISO = ()=> new Date().toISOString().slice(0,10);

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
