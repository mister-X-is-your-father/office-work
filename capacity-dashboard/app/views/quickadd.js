// クイック追加バー（トップバー常設）。1行入力 → 解析チップをプレビュー → Enter で即タスク化。
// 投入先の既定は「インボックス」WS（無ければ初回に自動作成）。>WS名 で明示指定。
// 時刻があれば日別予定(plan)も作る＝時刻カレンダーに即出現。URLは [資料] 行へ。
// ホットキー: 入力欄以外で「/」→ フォーカス。Esc → 解除。
// ※AI担当(fable)はここでは割当不可（taskform の隠しコマンド経由のみ＝仕様）。@は人間のみ解決。
import * as vik from "../lib/api.js";
import { load, invalidate } from "../lib/store.js";
import { parseQuickAdd } from "../lib/quickadd.js";
import { joinMeta } from "../lib/form.js";
import { esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

export const INBOX_WS = "インボックス";
const PROJ_KEY = "ts.quickadd.proj"; // 既定投入先（ワークスペース）の保持キー。"" or 数値ID。

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

function chipsHtml(r, defaultProj) {
  const c = [];
  if (!r.title) c.push(`<span class="qa-chip warn">タイトルを入力</span>`);
  else c.push(`<span class="qa-chip title">${esc(r.title)}</span>`);
  // 認識トークン（適用/テキスト化トグル可）。入力順を保つ。
  for (const t of (r.tokens || [])) c.push(tokenChipHtml(t, r));
  // links は解釈固定（トグル対象外）。
  for (const u of r.links) c.push(`<span class="qa-chip">${icon("link", { size: 13 })} ${esc(u.length > 30 ? u.slice(0, 28) + "…" : u)}</span>`);
  // 投入先（>WS が無い or テキスト化された場合の既定行き先を明示）。
  const wsApplied = (r.tokens || []).some((t) => t.kind === "ws" && t.applied);
  if (!wsApplied) c.push(`<span class="qa-chip ws">${icon("folder", { size: 13 })} ${defaultProj ? esc(defaultProj.title) : INBOX_WS}</span>`);
  return c.join("") +
    `<div class="qa-help">チップをクリックでテキスト扱いに（取り消し線＝適用しない）。構文: 明日15時 / 6/20 / 月曜 / #分類 / !高 / 1.5h / @担当 / &gt;ワークスペース / URL→資料</div>`;
}

// 構文ヘルプの早見表（実際にパーサが解釈する記法のみ）。lib/quickadd.js と整合させること。
const HELP_ROWS = [
  ["#分類", "分類/タグ", "#会議"],
  ["@担当", "担当（人のみ）", "@田中"],
  [">WS名", "投入先ワークスペース", ">チーム作業"],
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

// インボックスWSの取得（無ければ作成）。作成したら store を無効化して名簿を更新。
async function ensureInbox(projects) {
  const found = (projects || []).find((p) => p.title === INBOX_WS);
  if (found) return found;
  const created = await vik.createProject(INBOX_WS);
  invalidate();
  return created;
}

// 投入先の決定: 入力の明示 >WS名 が最優先、無ければセレクタで選んだ既定（defaultProj）、
// それも無ければインボックス（無ければ作成）。
async function createFromParsed(r, data, defaultProj) {
  const proj = r.wsProject || defaultProj || await ensureInbox(data.projects);
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
    <select id="qa-proj" class="qa-proj" title="投入先ワークスペース" aria-label="投入先ワークスペース">
      <option value="">なし（${INBOX_WS}）</option>
    </select>
    <div class="qa-pop" id="qa-pop" hidden></div>
    <div class="qa-tip" id="qa-tip" role="dialog" aria-label="入力構文の早見表" hidden>${helpTipHtml()}</div>`;
  who ? who.after(wrap) : topbar.prepend(wrap);
  const input = wrap.querySelector("#qa-in");
  const sel = wrap.querySelector("#qa-proj");
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

  // セレクタで選んだ既定投入先プロジェクト（無効値はインボックス扱い＝null）。
  const currentDefaultProj = () => {
    const id = +sel.value;
    if (!id) return null;
    return (data && data.projects || []).find((p) => p.id === id) || null;
  };

  // 候補プロジェクトをマウント時に取得して option を生成。保存済み選択を復元（無ければ「なし」）。
  const fillProjects = async () => {
    if (!data) { try { data = await load(); } catch { data = { projects: [], members: [], me: null }; } }
    const saved = localStorage.getItem(PROJ_KEY) || "";
    const opts = ['<option value="">なし（' + esc(INBOX_WS) + '）</option>'];
    for (const p of data.projects || []) opts.push(`<option value="${p.id}">${esc(p.title)}</option>`);
    sel.innerHTML = opts.join("");
    // 保存値が現在の候補に存在すれば復元（プロジェクト消滅・未ログイン時は「なし」へ）
    sel.value = (data.projects || []).some((p) => String(p.id) === saved) ? saved : "";
  };
  fillProjects();
  sel.addEventListener("change", () => {
    localStorage.setItem(PROJ_KEY, sel.value);
    if (resolved) { pop.innerHTML = chipsHtml(resolved, currentDefaultProj()); pop.hidden = false; }
  });

  // 入力に応じてチップ帯を再描画。ignore（テキスト化したトークン）を反映して解析する。
  // 入力本文が変わったら ignore はリセット（同一入力内でのみ有効）。
  const refresh = async () => {
    const v = input.value;
    if (!v.trim()) { pop.hidden = true; resolved = null; ignore = new Set(); ignoreFor = ""; return; }
    if (v !== ignoreFor) { ignore = new Set(); ignoreFor = v; }
    if (!data) { try { data = await load(); } catch { data = { projects: [], members: [], me: null }; } }
    resolved = resolveParsed(parseQuickAdd(v, { ignore }), data);
    pop.innerHTML = chipsHtml(resolved, currentDefaultProj());
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
    pop.innerHTML = chipsHtml(resolved, currentDefaultProj());
    pop.hidden = false;
  });

  const submit = async () => {
    if (busy || !resolved || !resolved.title) return;
    busy = true;
    input.disabled = true;
    pop.innerHTML = `<span class="qa-chip">追加中…</span>`;
    try {
      // 投入先: 明示 >WS名 ＞ セレクタ既定 ＞ インボックス。直前のデータで作成。
      await createFromParsed(resolved, data, currentDefaultProj());
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
  .qa-proj{flex:none;max-width:160px;box-sizing:border-box;font:inherit;font-size:12px;padding:7px 8px;
    border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink);cursor:pointer}
  .qa-proj:focus{outline:none;border-color:var(--fill);box-shadow:0 0 0 3px rgba(58,134,255,.12)}
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
  .qa-tip-eg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink)}`;
  document.head.appendChild(s);
}
