// クイック追加バー（トップバー常設）。1行入力 → 解析チップをプレビュー → Enter で即タスク化。
// 投入先の既定は「インボックス」WS（無ければ初回に自動作成）。>WS名 で明示指定。
// 時刻があれば日別予定(plan)も作る＝時刻カレンダーに即出現。URLは [資料] 行へ。
// ホットキー: 入力欄以外で「/」→ フォーカス。Esc → 解除。
// ※AI担当(fable)はここでは割当不可（taskform の隠しコマンド経由のみ＝仕様）。@は人間のみ解決。
import * as vik from "../lib/api.js";
import { load, invalidate, ensureInbox } from "../lib/store.js";
import { parseQuickAdd } from "../lib/quickadd.js";
import { joinMeta } from "../lib/form.js";
import { esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

// 新規タスクは常に Inbox WS へ投入（WSはUIから排除・project_id はデータとして裏で保持）。
// 投入先WS（INBOX_WS）と取得/作成（ensureInbox）は lib/store.js の共有実装を使う＝重複作成防止のためプロミスをメモ化。

// 解析結果を実データに照合（WS/担当の解決）。store.load はキャッシュ済み前提で軽い。
function resolveParsed(parsed, { projects, members }) {
  const r = { ...parsed, wsProject: null, wsMiss: false, member: null, memberMiss: false };
  if (parsed.ws) {
    const q = parsed.ws.toLowerCase();
    r.wsProject = (projects || []).find((p) => p.title.toLowerCase() === q)
      || (projects || []).find((p) => p.title.toLowerCase().includes(q)) || null;
    r.wsMiss = !r.wsProject;
  }
  if (parsed.assignee) {
    const q = parsed.assignee.toLowerCase();
    r.member = (members || []).find((m) => (m.name || "").toLowerCase() === q || m.username.toLowerCase() === q)
      || (members || []).find((m) => (m.name || "").toLowerCase().includes(q) || m.username.toLowerCase().includes(q)) || null;
    r.memberMiss = !r.member;
  }
  return r;
}

// トークン種別→アイコン名（lib/icons.js）と接頭ラベル。
const TOK_ICON = { date: "calendar", time: "calendar", estimate: "stopwatch", priority: "flag", label: "tag", assignee: "user", ws: "folder" };
const TOK_PREFIX = { priority: "重要度: ", label: "#", assignee: "@" };

// 認識トークンを「適用/テキスト化」トグル可能なチップとして描画。
// data-raw に生トークンを持たせ、クリックで ignore セットを切替える（view 側で処理）。
function tokenChipHtml(t, r) {
  const ic = TOK_ICON[t.kind] ? icon(TOK_ICON[t.kind], { size: 13 }) : "";
  const prefix = TOK_PREFIX[t.kind] || "";
  // ws/assignee は実データ照合の警告を反映（適用時のみ）。
  let label = esc(t.label);
  let extraCls = "";
  if (t.applied && t.kind === "ws" && r.wsMiss) { label = `${esc(t.label)} 不明`; extraCls = " miss"; }
  if (t.applied && t.kind === "assignee") {
    if (r.member) label = esc(r.member.name || r.member.username);
    else { label = `${esc(t.label)} 不在`; extraCls = " miss"; }
  }
  const cls = `qa-chip qa-tok${t.applied ? "" : " text"}${extraCls}`;
  const title = t.applied ? "クリックでテキスト扱いにする" : "クリックで再び認識する";
  return `<button type="button" class="${cls}" data-raw="${esc(t.raw)}" title="${title}" aria-pressed="${t.applied ? "true" : "false"}">${ic}${prefix}${label}</button>`;
}

function chipsHtml(r) {
  const c = [];
  if (!r.title) c.push(`<span class="qa-chip warn">タイトルを入力</span>`);
  else c.push(`<span class="qa-chip title">${esc(r.title)}</span>`);
  // 認識トークン（適用/テキスト化トグル可）。入力順を保つ。WSトークンは投入先UIを出さない（裏でInboxへ）。
  for (const t of (r.tokens || [])) if (t.kind !== "ws") c.push(tokenChipHtml(t, r));
  // links は解釈固定（トグル対象外）。
  for (const u of r.links) c.push(`<span class="qa-chip">${icon("link", { size: 13 })} ${esc(u.length > 30 ? u.slice(0, 28) + "…" : u)}</span>`);
  return c.join("") +
    `<div class="qa-help">チップをクリックでテキスト扱いに（取り消し線＝適用しない）。構文: 明日15時 / 6/20 / 月曜 / #分類 / !高 / 1.5h / @担当 / URL→資料</div>`;
}

// 構文ヘルプの早見表（実際にパーサが解釈する記法のみ）。lib/quickadd.js と整合させること。
const HELP_ROWS = [
  ["#分類", "分類/タグ", "#会議"],
  ["@担当", "担当（人のみ）", "@田中"],
  ["!重要度", "MUST/最優先/最/高/中/低", "!高"],
  ["1h・1.5h・30m", "見積時間（時間/分）", "1.5h"],
  ["明日15時", "日付＋時刻（予定も作成）", "明日15:30"],
  ["今日/明後日/N日後", "相対日付", "3日後"],
  ["月曜/来週金曜", "曜日指定", "来週金曜"],
  ["6/20・6月20日", "日付", "6/20"],
  ["15時・15:30", "時刻（当日扱い）", "15時"],
  ["URL", "貼ると資料へ", "https://…"],
];
function helpTipHtml() {
  const rows = HELP_ROWS.map(([sym, desc, ex]) =>
    `<tr><td class="qa-tip-sym">${esc(sym)}</td><td class="qa-tip-desc">${esc(desc)}</td><td class="qa-tip-ex">${esc(ex)}</td></tr>`
  ).join("");
  return `<div class="qa-tip-head">入力構文の早見表</div>
    <table class="qa-tip-tbl">${rows}</table>
    <div class="qa-tip-eg">例: <code>明日15時 MTG準備 #会議 1h</code></div>`;
}

// 投入先は常にインボックスWS（無ければ作成）。WSはUIから排除＝新規は既定でInboxへ。
async function createFromParsed(r, data) {
  const proj = await ensureInbox();
  const body = { title: r.title };
  if (r.dateISO) body.due_date = r.dateISO + "T00:00:00Z";
  if (r.priority) body.priority = r.priority;
  if (r.estimateH) body.time_estimate = Math.round(r.estimateH * 3600);
  if (r.links.length) body.description = joinMeta("", "", r.links);
  const task = await vik.createTaskInProject(proj.id, body);
  if (r.member) await vik.addAssignee(task.id, r.member.id);
  for (const name of r.labels) {
    const all = await vik.getLabels();
    const found = (all || []).find((l) => l.title === name);
    const label = found || await vik.createLabel(name);
    await vik.addTaskLabel(task.id, label.id);
  }
  // 時刻つき → 日別予定(plan)も作成（時刻カレンダーに出す）。所要は見積、無ければ1h。
  if (r.startMinute != null && r.dateISO) {
    const uid = (r.member && r.member.id) || (data.me && data.me.id) || null;
    await vik.logPlan(task.id, Math.round((r.estimateH || 1) * 3600), r.dateISO, "", uid, r.startMinute);
  }
  invalidate();
  return task;
}

export function mountQuickAdd(topbar, { onCreated } = {}) {
  ensureStyle();
  const who = topbar.querySelector(".who");
  const wrap = document.createElement("div");
  wrap.className = "qa-wrap";
  wrap.innerHTML = `
    <input id="qa-in" autocomplete="off" placeholder="クイック追加（/ でフォーカス）例: 明日15時 MTG準備 #会議 1h" aria-label="クイック追加">
    <button type="button" id="qa-help-btn" class="qa-help-btn" title="入力構文ヘルプ" aria-label="入力構文ヘルプ" aria-expanded="false">${icon("lightbulb", { size: 15 })}</button>
    <div class="qa-pop" id="qa-pop" hidden></div>
    <div class="qa-tip" id="qa-tip" role="dialog" aria-label="入力構文の早見表" hidden>${helpTipHtml()}</div>`;
  who ? who.after(wrap) : topbar.prepend(wrap);
  const input = wrap.querySelector("#qa-in");
  const pop = wrap.querySelector("#qa-pop");
  const helpBtn = wrap.querySelector("#qa-help-btn");
  const tip = wrap.querySelector("#qa-tip");

  // 構文ヘルプのツールチップ: クリックで開閉、外側クリック/Escで閉じる。
  const closeTip = () => { tip.hidden = true; helpBtn.setAttribute("aria-expanded", "false"); };
  const toggleTip = () => {
    const open = tip.hidden;
    tip.hidden = !open;
    helpBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  helpBtn.addEventListener("click", (ev) => { ev.stopPropagation(); toggleTip(); });
  tip.addEventListener("click", (ev) => ev.stopPropagation());
  document.addEventListener("click", () => { if (!tip.hidden) closeTip(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !tip.hidden) closeTip(); });

  let data = null;   // store.load の結果（チップ解決用・遅延）
  let resolved = null;
  let busy = false;
  let ignore = new Set();   // テキスト扱いにした生トークン文字列
  let ignoreFor = "";       // ignore が有効な入力値（変わればリセット）

  // 入力に応じてチップ帯を再描画。ignore（テキスト化したトークン）を反映して解析する。
  // 入力本文が変わったら ignore はリセット（同一入力内でのみ有効）。
  const refresh = async () => {
    const v = input.value;
    if (!v.trim()) { pop.hidden = true; resolved = null; ignore = new Set(); ignoreFor = ""; return; }
    if (v !== ignoreFor) { ignore = new Set(); ignoreFor = v; }
    if (!data) { try { data = await load(); } catch { data = { projects: [], members: [], me: null }; } }
    resolved = resolveParsed(parseQuickAdd(v, { ignore }), data);
    pop.innerHTML = chipsHtml(resolved);
    pop.hidden = false;
  };
  input.addEventListener("input", refresh);
  input.addEventListener("focus", refresh);
  input.addEventListener("blur", () => setTimeout(() => { pop.hidden = true; }, 150));

  // チップ（認識トークン）クリックで 適用⇄テキスト化 をトグル → 再解析・再描画。
  // mousedown で処理する（input.blur の遅延 hide より先に確定させ、フォーカスを奪わない）。
  pop.addEventListener("mousedown", (ev) => {
    const btn = ev.target.closest(".qa-tok");
    if (!btn) return;
    ev.preventDefault(); // input からフォーカスを奪わない
    const raw = btn.getAttribute("data-raw");
    if (raw == null) return;
    if (ignore.has(raw)) ignore.delete(raw); else ignore.add(raw);
    ignoreFor = input.value; // 現入力に紐づけ
    resolved = resolveParsed(parseQuickAdd(input.value, { ignore }), data || { projects: [], members: [], me: null });
    pop.innerHTML = chipsHtml(resolved);
    pop.hidden = false;
  });

  const submit = async () => {
    if (busy || !resolved || !resolved.title) return;
    busy = true;
    input.disabled = true;
    pop.innerHTML = `<span class="qa-chip">追加中…</span>`;
    try {
      // 投入先は常にインボックスWS（無ければ作成）。直前のデータで作成。
      if (!data) { try { data = await load(); } catch { data = { projects: [], members: [], me: null }; } }
      await createFromParsed(resolved, data);
      data = null; resolved = null; ignore = new Set(); ignoreFor = "";
      input.value = "";
      pop.innerHTML = `<span class="qa-chip ok">${icon("check", { size: 13 })} 追加しました</span>`;
      setTimeout(() => { if (!input.value) pop.hidden = true; }, 1200);
      if (onCreated) onCreated();
    } catch (e) {
      pop.innerHTML = `<span class="qa-chip warn">× ${esc(e.message || "失敗")}</span>`;
    } finally {
      busy = false;
      input.disabled = false;
      input.focus(); // 連続捕獲（ダンプ運用）を想定してフォーカス維持
    }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    else if (ev.key === "Escape") { input.blur(); pop.hidden = true; }
  });

  // 「/」でどこからでもフォーカス（入力中の欄は奪わない）
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing) return;
    ev.preventDefault();
    input.focus();
  });
}

let _style = false;
function ensureStyle() {
  if (_style) return; _style = true;
  const s = document.createElement("style");
  s.textContent = `
  .topbar .who{margin-right:12px}
  .qa-wrap{position:relative;flex:1;max-width:640px;margin-right:auto;display:flex;gap:6px;align-items:center}
  .qa-wrap input{flex:1;min-width:0;box-sizing:border-box;font:inherit;font-size:12.5px;padding:7px 12px;
    border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink)}
  .qa-wrap input:focus{outline:none;border-color:var(--fill);box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .qa-wrap input::placeholder{color:#a8b0bb}
  .qa-pop{position:absolute;z-index:8;top:calc(100% + 6px);left:0;right:0;background:#fff;
    border:1px solid var(--line);border-radius:11px;box-shadow:0 10px 30px rgba(20,30,50,.14);
    padding:10px 12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  .qa-pop[hidden]{display:none}
  .qa-chip{font-size:11.5px;border:1px solid var(--line);border-radius:20px;padding:2.5px 10px;
    background:#fafbfc;color:var(--ink);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .qa-chip.title{font-weight:700;background:#eef4ff;border-color:#cfe0ff}
  .qa-chip.ws{color:var(--muted)}
  .qa-chip.warn{color:#b3261e;background:#fdf0ef;border-color:#f3c9c6}
  .qa-chip.ok{color:#1d7a46;background:#eaf7ef;border-color:#bfe5cd;font-weight:700}
  /* 認識トークン（適用/テキスト化トグル）。button なので見た目を chip に揃える。 */
  .qa-tok{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11.5px;line-height:1.4;
    cursor:pointer;background:#eef4ff;border:1px solid #cfe0ff;color:var(--ink)}
  .qa-tok:hover{border-color:var(--fill)}
  .qa-tok:focus-visible{outline:none;border-color:var(--fill);box-shadow:0 0 0 3px rgba(58,134,255,.18)}
  .qa-tok .ic{color:var(--fill)}
  /* テキスト扱い（適用しない）: 取り消し線＋淡色 */
  .qa-tok.text{background:#f4f5f7;border-color:var(--line);color:var(--muted);text-decoration:line-through;
    text-decoration-thickness:1px}
  .qa-tok.text .ic{color:var(--muted)}
  /* WS/担当の未照合（適用中だが見つからない） */
  .qa-tok.miss{background:#fdf0ef;border-color:#f3c9c6;color:#b3261e}
  .qa-tok.miss .ic{color:#b3261e}
  .qa-tok.text.miss{background:#f4f5f7;border-color:var(--line);color:var(--muted)}
  .qa-tok.text.miss .ic{color:var(--muted)}
  .qa-help{flex-basis:100%;font-size:10.5px;color:var(--muted);margin-top:2px}
  .qa-help-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;
    width:30px;height:30px;padding:0;box-sizing:border-box;cursor:pointer;
    border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--muted)}
  .qa-help-btn:hover{color:var(--ink);border-color:var(--fill)}
  .qa-help-btn:focus{outline:none;border-color:var(--fill);box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .qa-help-btn[aria-expanded="true"]{color:var(--fill);border-color:var(--fill)}
  .qa-tip{position:absolute;z-index:9;top:calc(100% + 6px);right:0;max-width:340px;
    background:var(--card);border:1px solid var(--line);border-radius:11px;
    box-shadow:0 10px 30px rgba(20,30,50,.18);padding:11px 13px;color:var(--ink);text-align:left}
  .qa-tip[hidden]{display:none}
  .qa-tip-head{font-size:11.5px;font-weight:700;color:var(--ink);margin-bottom:7px}
  .qa-tip-tbl{border-collapse:collapse;width:100%;font-size:11.5px}
  .qa-tip-tbl td{padding:2.5px 0;vertical-align:top}
  .qa-tip-sym{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;
    color:var(--ink);white-space:nowrap;padding-right:10px}
  .qa-tip-desc{color:var(--ink);padding-right:10px}
  .qa-tip-ex{color:var(--muted);white-space:nowrap}
  .qa-tip-eg{margin-top:9px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
  .qa-tip-eg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}

  /* ===== ダークモード上書き（light非破壊・末尾追加） ===== */
  /* 白入力欄 → カード面。placeholder も淡色を muted 寄せに。 */
  html[data-theme="dark"] .qa-wrap input{background:var(--card)}
  html[data-theme="dark"] .qa-wrap input::placeholder{color:var(--muted)}
  /* 白ポップ → カード面＋影を黒系に。 */
  html[data-theme="dark"] .qa-pop{background:var(--card);border-color:var(--line);box-shadow:0 10px 30px rgba(0,0,0,.45)}
  /* 近白チップ → 沈んだ面。 */
  html[data-theme="dark"] .qa-chip{background:var(--surface-2)}
  /* タイトルチップ（淡青）→ 半透明アクセント青。 */
  html[data-theme="dark"] .qa-chip.title{background:rgba(58,134,255,.16);border-color:rgba(58,134,255,.4)}
  /* 警告（淡赤）→ 半透明赤＋明るい赤文字。 */
  html[data-theme="dark"] .qa-chip.warn{background:rgba(229,72,77,.16);border-color:rgba(229,72,77,.4);color:#ff9b96}
  /* 成功（淡緑）→ 半透明緑＋明るい緑文字。 */
  html[data-theme="dark"] .qa-chip.ok{background:rgba(47,166,107,.16);border-color:rgba(47,166,107,.4);color:#7fd6a6}
  /* 認識トークン（淡青）→ 半透明アクセント青。 */
  html[data-theme="dark"] .qa-tok{background:rgba(58,134,255,.16);border-color:rgba(58,134,255,.4)}
  /* テキスト扱い（淡灰）→ 沈んだ面。 */
  html[data-theme="dark"] .qa-tok.text{background:var(--surface-2);border-color:var(--line)}
  /* 未照合（淡赤）→ 半透明赤＋明るい赤文字。 */
  html[data-theme="dark"] .qa-tok.miss{background:rgba(229,72,77,.16);border-color:rgba(229,72,77,.4);color:#ff9b96}
  html[data-theme="dark"] .qa-tok.miss .ic{color:#ff9b96}
  /* テキスト化済みの未照合 → 沈んだ面。 */
  html[data-theme="dark"] .qa-tok.text.miss{background:var(--surface-2);border-color:var(--line)}
  /* 早見表ポップの影を黒系に。 */
  html[data-theme="dark"] .qa-tip{box-shadow:0 10px 30px rgba(0,0,0,.5)}`;
  document.head.appendChild(s);
}
