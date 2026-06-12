// クイック追加バー（トップバー常設）。1行入力 → 解析チップをプレビュー → Enter で即タスク化。
// 投入先の既定は「インボックス」WS（無ければ初回に自動作成）。>WS名 で明示指定。
// 時刻があれば日別予定(plan)も作る＝時刻カレンダーに即出現。URLは [資料] 行へ。
// ホットキー: 入力欄以外で「/」→ フォーカス。Esc → 解除。
// ※AI担当(fable)はここでは割当不可（taskform の隠しコマンド経由のみ＝仕様）。@は人間のみ解決。
import * as vik from "../lib/api.js";
import { load, invalidate } from "../lib/store.js";
import { parseQuickAdd } from "../lib/quickadd.js";
import { joinMeta, DOW_JA } from "../lib/form.js";
import { esc, fmtH } from "../lib/ui.js";

export const INBOX_WS = "インボックス";
const PRIO_NAME = { 4: "最優先", 3: "高", 2: "中", 1: "低" };

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

function fmtDateChip(iso, startMinute) {
  const dow = DOW_JA[new Date(iso + "T00:00:00Z").getUTCDay()];
  let s = `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}（${dow}）`;
  if (startMinute != null) s += ` ${Math.floor(startMinute / 60)}:${String(startMinute % 60).padStart(2, "0")}`;
  return s;
}

function chipsHtml(r) {
  const c = [];
  if (!r.title) c.push(`<span class="qa-chip warn">タイトルを入力</span>`);
  else c.push(`<span class="qa-chip title">${esc(r.title)}</span>`);
  if (r.dateISO) c.push(`<span class="qa-chip">📅 ${fmtDateChip(r.dateISO, r.startMinute)}</span>`);
  if (r.estimateH) c.push(`<span class="qa-chip">⏱ ${fmtH(r.estimateH)}</span>`);
  if (r.priority) c.push(`<span class="qa-chip">優先度: ${PRIO_NAME[r.priority]}</span>`);
  for (const l of r.labels) c.push(`<span class="qa-chip">#${esc(l)}</span>`);
  if (r.assignee) c.push(r.member
    ? `<span class="qa-chip">👤 ${esc(r.member.name || r.member.username)}</span>`
    : `<span class="qa-chip warn">@${esc(r.assignee)} 見つかりません</span>`);
  for (const u of r.links) c.push(`<span class="qa-chip">🔗 ${esc(u.length > 30 ? u.slice(0, 28) + "…" : u)}</span>`);
  c.push(r.ws
    ? (r.wsProject ? `<span class="qa-chip ws">📁 ${esc(r.wsProject.title)}</span>`
       : `<span class="qa-chip warn">>${esc(r.ws)} 不明 → ${INBOX_WS}へ</span>`)
    : `<span class="qa-chip ws">📁 ${INBOX_WS}</span>`);
  return c.join("") +
    `<div class="qa-help">構文: 明日15時 / 6/20 / 月曜 / #分類 / !高 / 1.5h / @担当 / &gt;ワークスペース / URL→資料</div>`;
}

// インボックスWSの取得（無ければ作成）。作成したら store を無効化して名簿を更新。
async function ensureInbox(projects) {
  const found = (projects || []).find((p) => p.title === INBOX_WS);
  if (found) return found;
  const created = await vik.createProject(INBOX_WS);
  invalidate();
  return created;
}

async function createFromParsed(r, data) {
  const proj = r.wsProject || await ensureInbox(data.projects);
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
    <div class="qa-pop" id="qa-pop" hidden></div>`;
  who ? who.after(wrap) : topbar.prepend(wrap);
  const input = wrap.querySelector("#qa-in");
  const pop = wrap.querySelector("#qa-pop");

  let data = null;   // store.load の結果（チップ解決用・遅延）
  let resolved = null;
  let busy = false;
  const refresh = async () => {
    const v = input.value;
    if (!v.trim()) { pop.hidden = true; resolved = null; return; }
    if (!data) { try { data = await load(); } catch { data = { projects: [], members: [], me: null }; } }
    resolved = resolveParsed(parseQuickAdd(v), data);
    pop.innerHTML = chipsHtml(resolved);
    pop.hidden = false;
  };
  input.addEventListener("input", refresh);
  input.addEventListener("focus", refresh);
  input.addEventListener("blur", () => setTimeout(() => { pop.hidden = true; }, 150));

  const submit = async () => {
    if (busy || !resolved || !resolved.title) return;
    busy = true;
    input.disabled = true;
    pop.innerHTML = `<span class="qa-chip">追加中…</span>`;
    try {
      // 直前のデータで作成（WS新規作成があり得るので data は作成後に取り直す）
      await createFromParsed(resolved, data);
      data = null; resolved = null;
      input.value = "";
      pop.innerHTML = `<span class="qa-chip ok">✓ 追加しました</span>`;
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
  .qa-wrap{position:relative;flex:1;max-width:560px;margin-right:auto}
  .qa-wrap input{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:7px 12px;
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
  .qa-help{flex-basis:100%;font-size:10.5px;color:var(--muted);margin-top:2px}`;
  document.head.appendChild(s);
}
