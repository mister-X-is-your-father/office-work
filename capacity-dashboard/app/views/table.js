// タスク一覧（表・mock60 相当）。**複数軸の組み合わせソート**＋**個人ごとの並び順**（マイソート＝手動）。
// 並び設定（ソート軸の連なり・手動順・絞り込み）は **見ている本人ごとに localStorage 保存**＝
// 共有データ（DB）は一切変えないので、誰がどう並べても他メンバーの見え方に影響しない（衝突しない）。
import { load, invalidate, isAiUser, patchTask } from "../lib/store.js";
import { savePresets } from "../lib/exec.js";
import { updateTask, deleteTask, addAssignee, removeAssignee, addTaskLabel, removeTaskLabel, createLabel, setTaskWaiting, createTaskInProject, addRelation, removeRelation, getTask } from "../lib/api.js";
import { PRIO, prioBucket, isReviewTask, categoryLabels, categoryColor, REVIEW_LABEL, WAITING_LABEL, statusOf, STATUS } from "../lib/kinds.js";
import { C, fmtH, esc, member_color, todayISO, announce } from "../lib/ui.js";
import { shiftISO, buildTaskTree, projectAncestor } from "../lib/capacity.js";
import { openTaskForm, ensureStyle as ensureFormStyle } from "./taskform.js";
import { summarizeRecurrence, openRecurrenceForm } from "./recurrenceform.js";
import { hourInputHtml, wireHourInput, parseSmartDate } from "../lib/form.js";
import { taskMatches, next7End, EMPTY_FILTER, BUILTIN_VIEWS } from "../lib/smartlist.js";
import { icon } from "../lib/icons.js";
import { startFocusFor } from "./pomodoro.js";
import { statePatchFor } from "../lib/taskstate.js";
import { humanAssignees } from "../lib/users.js";
import { snapshotTask, restoreTask } from "../lib/tasksnapshot.js";
import * as history from "../lib/history.js";

history.initHistoryHotkeys(); // Ctrl/Cmd+Z=取消・Ctrl+Y/Ctrl+Shift+Z=やり直し（入力中/モーダル内は無視）

// 履歴の undo/redo から呼ぶ再描画。最後に描画した一覧 root（lastRoot）へ再適用する。
// 一覧を離れていても render は安全（store から再取得するだけ）。
function historyRerender() { invalidate(); if (lastRoot && lastRoot.isConnected) render(lastRoot); }

// ══ B21: 行パッチ化（patchRow）═══════════════════════════════════════════
// 単一スカラ編集後の「invalidate(); render(root)」（=全タスク再fetch[N+1]＋全DOM再構築）を、
// 「編集した1行だけ差し替える」高速経路に置換する。挙動は完全不変（速くなるだけ）で、
// 失敗・危険時は必ず historyRerender()（従来のフル再描画）へフォールバック＝最悪でも従来動作。
// B22（イベント委譲）済みのため差し替えた <tr> は再結線不要。
//
// canPatchInPlace(col): 1行差替で表示集合・順序・件数が崩れない列だけ true（保守的＝疑わしきは false）。
function canPatchInPlace(col) {
  if (col === "proj") return false;                 // 親子=他行/アウトライン/parent列に波及。初期実装は常にfallback
  if (V.preset) return false;                       // プリセット選択中は全列fallback（taskMatches依存列の列挙は脆い）
  if (!V.manualMode) {                              // 組み合わせソート時のみソート軸を見る（マイソートはV.order固定で順序不変）
    const SORTMAP = { state: "state", prio: "prio", due: "due", est: "est", pct: "pct", who: "who", cat: "cat" };
    const sk = new Set(V.sorts.map((s) => s.key));
    if (SORTMAP[col] && sk.has(SORTMAP[col])) return false;
    if (col === "due" && (V.sorts.length === 0 || sk.has("due"))) return false; // tieBreak/既定期限順がdueを見る
  }
  if (V.doneMode !== "show" && (col === "state" || col === "pct")) return false; // done化で表示集合から外れ得る
  if (V.cat && col === "cat") return false;
  if (V.qaWho && col === "who") return false;
  if (V.qaDue && col === "due") return false;
  const q = (V.q || "").trim();
  if (q && (col === "title" || col === "who" || col === "cat" || col === "proj")) return false; // 検索対象列
  return true;
}

// patchRow: 編集済み1行だけを再fetch→キャッシュ更新→DOM差替し、summary/プリセット件数も再fetchなしで更新。
// 危険・失敗時は historyRerender() へフォールバック（boolean を返すが呼び側は基本 fire-and-forget）。
async function patchRow(taskId, root, opts = {}) {
  const col = opts.col;
  // 1) 表モード専用。アウトライン中・root切断はフォールバック。
  if (!root || !root.isConnected) { historyRerender(); return false; }
  const isOutline = location.hash.includes("outline") || V.mode === "outline";
  if (isOutline) { historyRerender(); return false; }
  // 2) 安全判定（疑わしきはフォールバック）。
  if (!canPatchInPlace(col)) { historyRerender(); return false; }
  // 3) 最新取得＋キャッシュ更新（getTask 1回。失敗/未ロードはフォールバック）。
  let fresh;
  try { fresh = await getTask(taskId); } catch { historyRerender(); return false; }
  if (!patchTask(taskId, fresh)) { historyRerender(); return false; }
  // 4) 対象行 DOM 特定（無ければフォールバック）。
  const tr = root.querySelector(`tr[data-id="${taskId}"]`);
  if (!tr) { historyRerender(); return false; }
  // 5) 行派生→HTML再生成→差し替え（B22委譲済みで再結線不要）。outerHTML 後は tr 参照は無効＝以降使わない。
  const manual = V.manualMode && !isOutline;
  const r = deriveRow(fresh, lastDeriveCtx || { execOk: false, meId: -1, today: todayISO() });
  tr.outerHTML = rowHtml(r, lastMembers || [], 0, manual);   // rowHtml の第3引数 i は本文未使用＝0でよい
  // 6) 集計（summary＋プリセット件数）を「現在表示中の行」を再派生して更新（再fetchなし）。
  try {
    const cache = await load();                 // invalidate していないのでキャッシュ即返（再fetchなし）
    const tById = new Map((cache.tasks || []).map((t) => [t.id, t]));
    const today = (lastDeriveCtx && lastDeriveCtx.today) || todayISO();
    const visIds = [...root.querySelectorAll("table tbody tr[data-id]")].map((el) => +el.dataset.id);
    const visRows = visIds.map((id) => tById.get(id)).filter(Boolean).map((t) => deriveRow(t, lastDeriveCtx || { execOk: false, meId: -1, today }));
    const sumEl = root.querySelector(".tb-summary");
    if (sumEl) sumEl.textContent = listSummaryText(visRows, today);
    // プリセット件数バッジ更新（プリセット未選択=visRows が「他フィルタ後・プリセット前」集合に一致）。
    const slCtx = { today, next7: next7End(today) };
    const setBadge = (key, count) => { const b = root.querySelector(`.tb-ptab[data-preset="${key}"] .tb-ptcnt`); if (b) b.textContent = String(count); };
    setBadge("", visRows.length);                       // 「すべて」タブ
    for (const v of BUILTIN_VIEWS) setBadge(v.key, visRows.filter((rr) => taskMatches(rr.t, { ...EMPTY_FILTER, ...v.filter }, slCtx)).length);
  } catch { /* 集計更新失敗は致命でない（行は差し替え済）。次回 render で整う */ }
  // 7) グリッド/選択/フラッシュ復元。gridHighlight は querySelector で引き直す＝差替後も正しく当たる。
  gridHighlight();
  return true;
}

// ── 一覧のインライン編集を1アクションとして履歴に積む共通ヘルパ ─────────────
// applyPatch(patch) は updateTask 等を呼んで該当値を適用する関数（before/after を渡して逆操作/再操作）。
// 適用は呼び出し側で済ませた後にこれを呼ぶ＝二重適用しない（push のみ）。
function pushScalarEdit(label, taskId, before, after, applyPatch) {
  history.push({
    label,
    undo: async () => { await applyPatch(taskId, before); historyRerender(); },
    redo: async () => { await applyPatch(taskId, after); historyRerender(); },
  });
}

const HOUR = 3600;
const MAX_SORTS = 5; // 組めるソート条件の上限（第1〜第5条件）
const VKEY = (uid) => `ts.list.view.${uid ?? "anon"}`;
function loadView(uid) {
  // doneMode: "show"=完了も表示 / "today"=完了は非表示だが今日の完了は表示 / "hide"=完了を非表示
  // preset: スマートリスト風プリセットタブの選択（""=すべて / BUILTIN_VIEWS の key）。最上位の絞込レイヤー。
  // colOrder: 列の表示順（COLDEF の key 配列）／hiddenCols: 非表示にした列の key 配列。既定は現状の全列・全表示。
  const def = { sorts: [{ key: "due", dir: 1 }], manualMode: false, order: [], doneMode: "today", cat: "", qaWho: "", qaDue: "", mode: "table", q: "", preset: "", colOrder: [], hiddenCols: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(VKEY(uid)) || "null");
    if (!raw) return { ...def };                       // 初回のみ既定（期限）
    const v = { ...def, ...raw };
    if (!Array.isArray(v.sorts)) v.sorts = [];          // 壊れてる時だけ空に（空配列=意図的な「条件なし」は保持）
    // AXES に存在しない軸（廃止した ws 軸など）を保存済みソートから除去（死にチップを残さない）。
    v.sorts = v.sorts.filter((s) => s && AXES[s.key]);
    if (raw.doneMode === undefined) { v.doneMode = raw.hideDone === false ? "show" : "hide"; delete v.hideDone; } // 旧 hideDone(bool) からの移行
    if (!Array.isArray(v.colOrder)) v.colOrder = [];
    if (!Array.isArray(v.hiddenCols)) v.hiddenCols = [];
    return v;
  } catch { return { ...def }; }
}
function saveView(uid, v) { try { localStorage.setItem(VKEY(uid), JSON.stringify(v)); } catch { /* noop */ } }

// 保存したマイソート（手動順）＝本人ごと（手動順は個人の並びなのでローカル保存）。[{name, order:[taskId]}]
const MSKEY = (uid) => `ts.list.mysorts.${uid ?? "anon"}`;
function loadMySorts(uid) { try { return JSON.parse(localStorage.getItem(MSKEY(uid))) || []; } catch { return []; } }
function saveMySorts(uid, list) { try { localStorage.setItem(MSKEY(uid), JSON.stringify(list)); } catch { /* noop */ } }

let V = null, UID = null;
// 階層（アウトライン）表示の折りたたみ状態（task.id）。本人ごとに localStorage 永続化。
const olCollapsed = new Set();
const OLKEY = (uid) => `ts.list.olcollapse.${uid ?? "anon"}`;
function loadOlCollapsed(uid) {
  olCollapsed.clear();
  try { (JSON.parse(localStorage.getItem(OLKEY(uid)) || "[]") || []).forEach((id) => olCollapsed.add(id)); } catch { /* noop */ }
}
function saveOlCollapsed(uid) { try { localStorage.setItem(OLKEY(uid), JSON.stringify([...olCollapsed])); } catch { /* noop */ } }
let flashId = null;          // ドロップ直後にジワっと色が戻る着地ハイライト対象（再描画後に適用）
let selectedIds = new Set(); // まとめて移動用の複数選択（マイソート中のみ・Ctrl/Shiftで操作）
let anchorId = null;         // Shift範囲選択の起点
let lastRoot = null, docDeselectWired = false; // 余白クリック解除（document全体・右側の地まで拾う）
// B21 行パッチ化: patchRow が render と同じ派生コンテキスト／メンバーで1行だけ再生成するための直近スナップ。
let lastDeriveCtx = null, lastMembers = null;
let historyUnsub = null; // Undo/Redo ボタンの活性同期（subscribe 解除関数。再描画ごとに張り替える）

const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
// 本文(description)の HTML タグを除去してプレーンテキスト化（検索対象用）。空/未設定は ""。
const descText = (html) => (html ? String(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim() : "");

// 軸の定義: ラベル＋比較関数（行 r を受ける）＋セレクトで選んだ時の既定の向き。
const AXES = {
  due:     { label: "期限",      cmp: (a, b) => (a.due || "9999").localeCompare(b.due || "9999"), dir: 1 },
  prio:    { label: "重要度",    cmp: (a, b) => a.prio - b.prio, dir: -1 },
  cat:     { label: "分類",      cmp: (a, b) => ((a.cat && a.cat.title) || "～").localeCompare((b.cat && b.cat.title) || "～", "ja"), dir: 1 },
  who:     { label: "担当",      cmp: (a, b) => ((a.who && (a.who.name || a.who.username)) || "～").localeCompare((b.who && (b.who.name || b.who.username)) || "～", "ja"), dir: 1 },
  proj:    { label: "プロジェクト", cmp: (a, b) => ((a.parent && a.parent.title) || "～").localeCompare((b.parent && b.parent.title) || "～", "ja"), dir: 1 },
  group:   { label: "タスクグループ", cmp: (a, b) => ((a.group && a.group.title) || "～").localeCompare((b.group && b.group.title) || "～", "ja"), dir: 1 },
  state:   { label: "ステータス",      cmp: (a, b) => stateRank(a) - stateRank(b), dir: 1 },
  pct:     { label: "進捗",      cmp: (a, b) => a.pct - b.pct, dir: -1 },
  est:     { label: "見積",      cmp: (a, b) => a.est - b.est, dir: -1 },
  flag:    { label: "フラグ",    cmp: (a, b) => (a.t.is_favorite ? 1 : 0) - (b.t.is_favorite ? 1 : 0), dir: -1 },
  created: { label: "追加日",    cmp: (a, b) => String(a.t.created || "").localeCompare(String(b.t.created || "")), dir: -1 },
  title:   { label: "タスク名",  cmp: (a, b) => a.title.localeCompare(b.title, "ja"), dir: 1 },
};
const stateRank = (r) => STATUS[r.status].rank; // 未着手→進行中→完了（kinds.js が SSoT）
const tieBreak = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.t.id - b.t.id;

// スマートリスト風プリセットタブ（icon＋ラベル＋件数バッジ＋アクティブ下線）。views/smartlist.js の tabItem と同趣旨。
function presetTabHtml(key, iconHtml, label, count, on) {
  return `<button class="tb-ptab${on ? " on" : ""}" role="tab" aria-selected="${on ? "true" : "false"}" data-preset="${esc(String(key))}">
    <span class="tb-ptic">${iconHtml}</span><span class="tb-ptlbl">${esc(label)}</span>
    ${count != null ? `<span class="tb-ptcnt">${count}</span>` : ""}
  </button>`;
}

// ── B21: 行派生（純関数）。render の rows 構築と patchRow で共用＝1行だけ作り直せる。 ──
// ctx = { execOk, meId, today }。式は render 旧インライン（fable の ((me&&me.id)||-1)=meId）と完全一致。
function deriveRow(t, ctx) {
  const parent = projectAncestor(t, ctx.byId);
  const immRel = (((t.related_tasks || {}).parenttask) || [])[0] || null;
  const immParent = immRel ? ((ctx.byId && ctx.byId.get(immRel.id)) || immRel) : null;
  const group = (immParent && parent && immParent.id !== parent.id) ? immParent : null;
  return {
    t, title: t.title, who: (t.assignees || []).find((a) => !isAiUser(a)) || null,
    fable: ctx.execOk && !t.done && (t.assignees || []).some((a) => isAiUser(a)) && ((t.created_by || {}).id || 0) === ctx.meId,
    parent, group,
    review: isReviewTask(t), prio: prioBucket(t.priority), cat: categoryLabels(t)[0] || null,
    due: dueISO(t), est: (t.time_estimate || 0) / HOUR, pct: t.percent_done || 0,
    done: !!t.done, status: statusOf(t),
  };
}
// ── B21: 件数内訳サマリ（純関数）。render と patchRow で共用（挙動同値）。 ──
function listSummaryText(rows, today) {
  const overdueN = rows.filter((r) => !r.done && r.due && r.due < today).length;
  const estTotal = rows.reduce((s, r) => s + (r.est || 0), 0);
  return `${rows.length}件` + (overdueN ? `・期限切れ${overdueN}` : "") + (estTotal ? `・見積${fmtH(estTotal)}` : "");
}

export async function render(root) {
  const { tasks, members, me = null, settings = {}, labels = [], recurrences = [], holidaysByDate = null } = await load();
  const presets = settings.sortPresets || [];   // グローバル共有プリセット
  const canEditPresets = !!settings.canEdit;     // 保存/削除は許可ユーザーのみ（適用は全員可）
  const today = todayISO();
  UID = (me && me.id) || 0;
  V = loadView(UID);
  loadOlCollapsed(UID); // 階層の折りたたみ状態を本人ごとに復元
  // 後方互換: #/outline で来たら、Vを書き換えずこのロードだけアウトライン表示にする。
  const mode = location.hash.includes("outline") ? "outline" : (V.mode === "outline" ? "outline" : "table");
  const isOutline = mode === "outline";
  const mysorts = loadMySorts(UID); // 保存したマイソート（本人ごと）
  let execOk = false;
  try { const ex = await import("../lib/exec.js"); execOk = !!(await ex.execMe()); } catch { /* noop */ }
  // B21: 行派生は deriveRow（純関数）に集約＝patchRow が1行だけ同じ式で作り直せる。
  // deriveCtx は patchRow 用に最新値をモジュール変数へ退避（下で lastDeriveCtx に保存）。
  const deriveCtx = { execOk, meId: (me && me.id) || -1, today, byId: new Map((tasks || []).map((tt) => [tt.id, tt])) };
  let rows = (tasks || []).map((t) => deriveRow(t, deriveCtx));
  const doneToday = (t) => t.done && t.done_at && !t.done_at.startsWith("0001") && t.done_at.slice(0, 10) === today;
  if (V.doneMode === "hide") rows = rows.filter((r) => !r.done);
  else if (V.doneMode === "today") rows = rows.filter((r) => !r.done || doneToday(r.t));
  if (V.cat) rows = rows.filter((r) => (r.cat ? r.cat.title : "") === V.cat);
  // クイック絞り込み（担当＝自分/担当なし/自分＋担当なし、期限＝今日＋期限なし/1週間以内/1ヶ月以内）。本人ごとに保存。
  if (V.qaWho === "me") rows = rows.filter((r) => humanAssignees(r.t).some((a) => a.id === UID));
  else if (V.qaWho === "none") rows = rows.filter((r) => humanAssignees(r.t).length === 0);
  else if (V.qaWho === "me_none") rows = rows.filter((r) => { const h = humanAssignees(r.t); return h.length === 0 || h.some((a) => a.id === UID); });
  if (V.qaDue === "today_nd") rows = rows.filter((r) => !r.due || r.due === today);
  else if (V.qaDue === "7d") rows = rows.filter((r) => r.due && r.due <= shiftISO(today, 7));
  else if (V.qaDue === "30d") rows = rows.filter((r) => r.due && r.due <= shiftISO(today, 30));

  // フリーワード検索（右上）。タイトル中心＋親(プロジェクト)名/分類/担当名を対象。
  // 他フィルタの後（＝絞り込み済み集合）にAND併用。表/階層どちらも rows 由来なので両モードに効く。
  const q = (V.q || "").trim().toLowerCase();
  if (q) {
    const hit = (r) => {
      const parts = [
        r.title,
        r.parent && r.parent.title,
        r.group && r.group.title,
        r.cat && r.cat.title,
        descText(r.t.description),   // 本文（HTMLタグを除去したテキスト）も検索対象＝smartlist と一致
        ...(r.t.assignees || []).map((a) => a.name || a.username),
      ];
      return parts.some((s) => s && String(s).toLowerCase().includes(q));
    };
    rows = rows.filter(hit);
  }

  // スマートリスト風プリセットタブ（最上位の絞込レイヤー）。lib/smartlist.js の BUILTIN_VIEWS を流用し、
  // その view.filter を lib/smartlist.js applyFilter（=taskMatches）で行に適用＝他の絞込とAND。
  // 件数バッジは「他フィルタ適用後・プリセット適用前」の集合に対して各 view を当てて算出（タブ間で安定）。
  const slCtx = { today, next7: next7End(today) };
  const presetFilterOf = (v) => ({ ...EMPTY_FILTER, ...v.filter });
  const presetCount = (v) => rows.filter((r) => taskMatches(r.t, presetFilterOf(v), slCtx)).length;
  const presetCounts = BUILTIN_VIEWS.map((v) => ({ view: v, count: presetCount(v) }));
  const presetAllCount = rows.length;
  // 選択中プリセットを適用（""=すべて＝プリセット無し）。
  const activePreset = BUILTIN_VIEWS.find((v) => v.key === V.preset) || null;
  if (activePreset) rows = rows.filter((r) => taskMatches(r.t, presetFilterOf(activePreset), slCtx));

  // 絞り込み（分類/担当/期限/完了表示/検索/プリセット）のいずれかがアクティブか。0件時の空状態出し分け用。
  const filtersActive = !!(V.cat || V.qaWho || V.qaDue || V.doneMode !== "today" || q || activePreset);

  const manual = V.manualMode && !isOutline; // アウトライン中はマイソート（手動順）を無効化（階層が順序）
  // 選択は表モード全般で有効（チェックボックス＋一括操作）。マイソート中はドラッグ移動にも併用。
  // アウトライン中は選択を無効化。表示中のタスクに限定（フィルタ/モード変更で掃除）。
  if (isOutline) { selectedIds.clear(); anchorId = null; }
  else { const vis = new Set(rows.map((r) => r.t.id)); selectedIds.forEach((id) => { if (!vis.has(id)) selectedIds.delete(id); }); }
  if (manual) {
    const allIds = rows.map((r) => r.t.id);
    const have = new Set(V.order), allSet = new Set(allIds);
    V.order = [...V.order.filter((id) => allSet.has(id)), ...allIds.filter((id) => !have.has(id))];
    saveView(UID, V);
    const pos = new Map(V.order.map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(a.t.id) ?? 1e9) - (pos.get(b.t.id) ?? 1e9));
  } else {
    // 複数軸の組み合わせ（先頭が第1キー…一致したら次の軸へ）。最後に期限→IDで安定化。
    rows.sort((a, b) => {
      for (const s of V.sorts) { const ax = AXES[s.key]; if (ax) { const c = ax.cmp(a, b) * (s.dir || 1); if (c) return c; } }
      return tieBreak(a, b);
    });
  }

  const usedCats = [...new Map(rows.concat([]).map((r) => r.cat).filter(Boolean).map((c) => [c.title, c])).values()]
    .sort((a, b) => a.title.localeCompare(b.title, "ja"));
  const allCats = V.cat && !usedCats.some((c) => c.title === V.cat) ? usedCats.concat([{ title: V.cat, id: 0 }]) : usedCats;
  const catOpts = `<option value="">全分類</option>` +
    allCats.map((c) => `<option value="${esc(c.title)}"${c.title === V.cat ? " selected" : ""}>${esc(c.title)}</option>`).join("");

  // ソート条件チップ＋「条件を追加」（既に使っている条件は候補から除外・最大5件）
  const usedKeys = new Set(V.sorts.map((s) => s.key));
  const addOpts = `<option value="">＋ 条件を追加</option>` +
    Object.entries(AXES).filter(([k]) => !usedKeys.has(k)).map(([k, ax]) => `<option value="${k}">${esc(ax.label)}</option>`).join("");
  const chips = V.sorts.map((s, i) => {
    const ax = AXES[s.key]; if (!ax) return "";
    return `<span class="tb-sc${manual ? " dim" : ""}" data-i="${i}">
      <span class="tb-sc-n">第${i + 1}</span><button class="tb-sc-k" data-i="${i}" title="クリックで昇順/降順を切替">${esc(ax.label)} ${s.dir > 0 ? "↑" : "↓"}</button>
      <button class="tb-sc-x" data-i="${i}" title="この条件を外す">×</button></span>`;
  }).join("");

  // アウトライン本体（フィルタ後のタスク集合からツリーを構築。親が除外され子が残ったら子をルート扱い）。
  const olBody = isOutline ? buildOutlineHtml(rows.map((r) => r.t)) : "";
  // 最上部の定期帯（recurrences を要約して軽く一覧。両モード共通・0件なら出さない）
  const recBand = recurrenceBandHtml(recurrences, members);

  const subtitle = isOutline
    ? "階層表示（プロジェクト＞タスクグループ＞タスク）・チェックで完了、＋で子タスク追加"
    : (manual ? "・ 行をどこでもドラッグして自分用に並べ替え" : `・ ソート条件を重ねて並べ替え（列ヘッダ: クリック=第1条件 / Shift+クリック=条件を追加・最大${MAX_SORTS}）`);
  // vtitle の件数内訳サマリ（表示中の集合に対して）: 件数・期限切れ（未完了で期限が今日より前）・見積合計h。
  // B21: listSummaryText（純関数）に集約＝patchRow が再fetchなしで同じ式で更新できる。
  const summary = listSummaryText(rows, today);
  // B21: patchRow が render と同じコンテキスト／メンバーで1行だけ作り直せるよう直近値を退避。
  lastDeriveCtx = deriveCtx;
  lastMembers = members;
  root.innerHTML = `
    <style>${css()}</style>
    <div class="tb-head">
      <h1 class="vtitle">タスク一覧 <small><span class="tb-summary">${summary}</span> ${subtitle}</small></h1>
      <span class="tb-search">${icon("search", { size: 15, cls: "tb-search-ic" })}<input id="tb-q" class="tb-search-in" type="text" placeholder="タスクを検索（名前・PJ・分類・担当）" value="${esc(V.q || "")}">${V.q ? `<button id="tb-q-clr" class="tb-search-x" type="button" title="検索をクリア">×</button>` : ""}</span>
    </div>
    <div class="tb-ptabs" role="tablist" aria-label="プリセット">
      ${presetTabHtml("", icon("list", { size: 14 }), "すべて", presetAllCount, !activePreset)}
      ${presetCounts.map((pc) => presetTabHtml(pc.view.key, icon(pc.view.icon, { size: 14 }), pc.view.label, pc.count, V.preset === pc.view.key)).join("")}
    </div>
    ${activePreset && activePreset.desc ? `<div class="tb-pdesc">${esc(activePreset.desc)}</div>` : ""}
    <div class="tb-tools">
      <span class="tb-grp">
        <button id="tb-add" class="tb-add">タスク追加</button>
        <span class="tb-undogrp">
          <button id="tb-undo" class="tb-undobtn" type="button" title="取り消し（Ctrl+Z）" aria-label="取り消し">${icon("undo", { size: 15 })}</button>
          <button id="tb-redo" class="tb-undobtn" type="button" title="やり直し（Ctrl+Y）" aria-label="やり直し">${icon("redo", { size: 15 })}</button>
        </span>
        <span class="tb-seg" role="tablist">
          <button class="tb-seg-b${!isOutline ? " on" : ""}" data-mode="table">表</button>
          <button class="tb-seg-b${isOutline ? " on" : ""}" data-mode="outline">階層</button>
        </span>
        ${isOutline ? `<span class="tb-olexp"><button class="tb-olx" id="tb-ol-expand" title="すべて展開"><span class="tb-olx-car">▾</span> 全展開</button><button class="tb-olx" id="tb-ol-collapse" title="すべて折りたたみ"><span class="tb-olx-car">▸</span> 全折りたたみ</button></span>` : ""}
      </span>
      <span class="tb-grp">
        <span class="tb-glbl">絞込</span>
        <select id="tb-cat">${catOpts}</select>
        <select id="tb-done" title="完了タスクの表示">
          <option value="show" ${V.doneMode === "show" ? "selected" : ""}>完了も表示</option>
          <option value="today" ${V.doneMode === "today" ? "selected" : ""}>完了を非表示（今日の完了は表示）</option>
          <option value="hide" ${V.doneMode === "hide" ? "selected" : ""}>完了を非表示</option>
        </select>
      </span>
      ${isOutline ? "" : `<span class="tb-grp${manual ? " dim" : ""}">
        <span class="tb-glbl">ソート</span>
        <button id="tb-manual" class="tb-manbtn${manual ? " on" : ""}" title="自分だけの手動ソート">${icon("hand")} マイソート</button>
        <span class="tb-sortwrap${manual ? " dim" : ""}"><span class="tb-chips">${chips || `<span class="tb-sc-none">なし（既定: 期限順）</span>`}</span>
          ${V.sorts.length < MAX_SORTS ? `<select id="tb-addsort" class="tb-addsort">${addOpts}</select>` : `<span class="tb-sc-none">最大${MAX_SORTS}件</span>`}</span>
      </span>`}
      ${isOutline ? "" : `<span class="tb-grp">
        <button id="tb-cols" class="tb-colsbtn" type="button" title="列の表示／並べ替え">${icon("settings", { size: 15 })} 列</button>
      </span>`}
    </div>
    <div class="tb-quick">
      <span class="tb-ql">クイック絞り込み</span>
      <button class="tb-qa${V.qaWho === "me" ? " on" : ""}" data-qa="who:me">自分の担当</button>
      <button class="tb-qa${V.qaWho === "none" ? " on" : ""}" data-qa="who:none">担当なし</button>
      <button class="tb-qa${V.qaWho === "me_none" ? " on" : ""}" data-qa="who:me_none">自分＋担当なし</button>
      <span class="tb-qsep"></span>
      <button class="tb-qa${V.qaDue === "today_nd" ? " on" : ""}" data-qa="due:today_nd">今日＋期限なし</button>
      <button class="tb-qa${V.qaDue === "7d" ? " on" : ""}" data-qa="due:7d">1週間以内</button>
      <button class="tb-qa${V.qaDue === "30d" ? " on" : ""}" data-qa="due:30d">1ヶ月以内</button>
      ${(V.qaWho || V.qaDue) ? `<button class="tb-qa tb-qclr" data-qa="clr">解除</button>` : ""}
    </div>
    ${manual ? `<div class="tb-mynote">「マイソート」はあなただけの順番です（この端末に保存・他のメンバーには影響しません）。Ctrl/⌘・Shift＋クリックで複数選択→まとめてドラッグ移動。</div>
    <div class="tb-presets">
      <span class="tb-pl">保存したマイソート<span class="tb-pl-g" title="あなた専用・この端末">${icon("user", { size: 12 })}</span></span>
      ${mysorts.map((m, i) => `<span class="tb-pz"><button class="tb-mz-a" data-mi="${i}" title="この手動順を適用">${esc(m.name)}</button><button class="tb-mz-x" data-mi="${i}" title="削除">×</button></span>`).join("") || `<span class="tb-sc-none">まだありません</span>`}
      <button class="tb-psave" id="tb-msave" title="今の手動のソート順に名前を付けて保存">${icon("save")} 今のソートを保存</button>
    </div>` : ""}
    ${(presets.length || canEditPresets) && !manual && !isOutline ? `<div class="tb-presets">
      <span class="tb-pl">プリセット<span class="tb-pl-g" title="チーム全員で共有">${icon("globe", { size: 12 })}</span></span>
      ${presets.map((p, i) => `<span class="tb-pz" data-pi="${i}"><button class="tb-pz-a" data-pi="${i}" title="このソートを適用">${esc(p.name)}</button>${canEditPresets ? `<button class="tb-pz-x" data-pi="${i}" title="削除（全員に反映）">×</button>` : ""}</span>`).join("") || `<span class="tb-sc-none">まだありません</span>`}
      ${canEditPresets ? `<button class="tb-psave" id="tb-psave" title="今の組み合わせソートを共有プリセットとして保存">${icon("save")} 現在のソートを保存</button>` : ""}
    </div>` : ""}
    ${recBand}
    ${isOutline
      ? `<div class="card ol-card">${olBody || `<div class="ol-empty">${filtersActive ? "条件に一致するタスクがありません。" : "タスクがありません。"}</div>`}</div>`
      : `<div class="card tb-wrap"><table class="tb">
      <thead><tr><th scope="col" class="tb-selcol">${selAllHeadHtml(rows)}</th>${cols().map((c) => th(c, manual)).join("")}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => rowHtml(r, members, i, manual)).join("") : emptyRow(filtersActive)}</tbody>
    </table></div>`}
    ${isOutline ? "" : bulkBarHtml(rows)}`;

  const persist = () => saveView(UID, V);
  const reRender = () => { persist(); render(root); };

  // プリセットタブ選択（最上位の絞込レイヤー）。同じタブ再クリックで「すべて」へ戻す。V.preset を localStorage 保持。
  root.querySelectorAll(".tb-ptab").forEach((b) => {
    b.onclick = () => { const k = b.dataset.preset || ""; V.preset = (V.preset === k) ? "" : k; reRender(); };
  });

  // 表/アウトライン セグメント切替: V.modeを保存。#/outline 経由で来ていても、ここで選んだら #/list 正規へ寄せる。
  root.querySelectorAll(".tb-seg-b").forEach((b) => {
    b.onclick = () => {
      const next = b.dataset.mode === "outline" ? "outline" : "table";
      if (next === mode) return;
      V.mode = next; persist();
      if (location.hash.includes("outline")) { location.hash = "#/list"; } // hash由来の強制を解除→hashchangeで再描画
      else render(root);
    };
  });
  const manBtn = root.querySelector("#tb-manual");
  if (manBtn) manBtn.onclick = () => { V.manualMode = !V.manualMode; reRender(); };
  // 列の表示/非表示・並べ替え（歯車メニュー）。変更は V.colOrder/V.hiddenCols に保存→再描画。
  const colsBtn = root.querySelector("#tb-cols");
  if (colsBtn) colsBtn.onclick = () => openColumnsMenu(colsBtn, () => reRender());
  root.querySelector("#tb-cat").onchange = (e) => { V.cat = e.target.value; reRender(); };
  root.querySelectorAll(".tb-qa").forEach((b) => {
    b.onclick = () => {
      const [g, v] = b.dataset.qa.split(":");
      if (g === "clr") { V.qaWho = ""; V.qaDue = ""; }
      else if (g === "who") V.qaWho = V.qaWho === v ? "" : v;
      else V.qaDue = V.qaDue === v ? "" : v;
      reRender();
    };
  });
  root.querySelector("#tb-done").onchange = (e) => { V.doneMode = e.target.value; reRender(); };
  // 検索（右上）: インクリメンタル絞り込み。再描画後にフォーカス＋キャレット位置を復元（入力が途切れない）。
  const qIn = root.querySelector("#tb-q");
  if (qIn) {
    qIn.oninput = (e) => { V.q = e.target.value; const pos = e.target.selectionStart; reRender(); restoreSearchFocus(root, pos); };
    qIn.onkeydown = (e) => { if (e.key === "Escape" && V.q) { V.q = ""; reRender(); restoreSearchFocus(root, 0); } };
  }
  const qClr = root.querySelector("#tb-q-clr");
  if (qClr) qClr.onclick = () => { V.q = ""; reRender(); restoreSearchFocus(root, 0); };
  // 0件の空状態にある「絞り込みを解除」: 全フィルタをクリア＋完了表示を既定(hide)に戻して再描画
  const emptyClr = root.querySelector("#tb-empty-clr");
  if (emptyClr) emptyClr.onclick = () => { V.cat = ""; V.qaWho = ""; V.qaDue = ""; V.doneMode = "hide"; V.preset = ""; reRender(); };
  root.querySelector("#tb-add").onclick = () => openTaskForm({ onSaved: () => render(root) });
  // 取消/やり直し（履歴）。canUndo/canRedo で活性・非活性を切り替え（subscribe で随時更新）。
  const undoBtn = root.querySelector("#tb-undo"), redoBtn = root.querySelector("#tb-redo");
  if (undoBtn) undoBtn.onclick = () => history.undo();
  if (redoBtn) redoBtn.onclick = () => history.redo();
  if (undoBtn && redoBtn) {
    const sync = (st) => { undoBtn.disabled = !st.canUndo; redoBtn.disabled = !st.canRedo; };
    sync({ canUndo: history.canUndo(), canRedo: history.canRedo() });
    // 直近の subscribe を1つだけ保持（再描画のたびに古い購読を解除して二重通知を防ぐ）。
    if (historyUnsub) historyUnsub();
    historyUnsub = history.subscribe(sync);
  }
  // 条件を追加（最大5件・5件到達時はセレクト自体を出さない）。マイソート中なら組み合わせソートに切替
  const addSel = root.querySelector("#tb-addsort");
  if (addSel) addSel.onchange = (e) => {
    const k = e.target.value; if (!k || V.sorts.length >= MAX_SORTS) return;
    V.sorts.push({ key: k, dir: AXES[k].dir }); V.manualMode = false; reRender();
  };
  // チップ: 向き切替 / 削除（最後の1件も外せる＝条件なし=既定の期限順）
  root.querySelectorAll(".tb-sc-k").forEach((b) => { b.onclick = () => { const s = V.sorts[+b.dataset.i]; if (s) { s.dir = -(s.dir || 1); V.manualMode = false; reRender(); } }; });
  root.querySelectorAll(".tb-sc-x").forEach((b) => { b.onclick = () => { V.sorts.splice(+b.dataset.i, 1); reRender(); }; });
  // ══ B22: イベント委譲 ══════════════════════════════════════════════════
  // 行数・要素数に比例していた per-element 結線（チップ7種・進捗・選択・行クリック・
  // 列ヘッダ・アウトライン行・定期帯行）を、コンテナ少数の委譲リスナ＋closest 分岐に置換。
  // render() スコープ内なので参照する閉包変数（tasks/members/labels/today/rows/V/UID/root/reRender）は
  // 旧 per-element 結線と同一＝挙動同値。render 冒頭で root.innerHTML を総入替するためコンテナは毎回新規
  // ＝onXXX 代入はリーク・二重化しない。
  // ─────────────────────────────────────────────────────────────────────

  // 表モードの選択ロジック（toggle/range/all）。行チェック・全選択ヘッダの委譲から呼ぶ。
  const selH = (!isOutline && rows.length) ? selectionHandlers(rows, () => render(root)) : null;

  // ── 列ヘッダ（thead）: ソート切替＋全選択 ──
  const thead = root.querySelector("table thead");
  if (thead) {
    thead.onclick = (e) => {
      // 全選択チェック（#tb-selall）
      if (e.target.closest("#tb-selall")) { if (selH) selH.onSelectAll(); return; }
      // 列ヘッダ: クリック=第1条件に（単一化）・Shift+クリック=条件として追加/切替（最大5件）
      const h = e.target.closest("th[data-k]"); if (!h) return;
      const k = h.dataset.k;
      V.manualMode = false;
      if (e.shiftKey) {
        const ex = V.sorts.find((s) => s.key === k);
        if (ex) ex.dir = -(ex.dir || 1); else if (V.sorts.length < MAX_SORTS) V.sorts.push({ key: k, dir: AXES[k] ? AXES[k].dir : 1 });
      } else {
        const cur = V.sorts[0];
        V.sorts = [{ key: k, dir: (cur && cur.key === k) ? -(cur.dir || 1) : (AXES[k] ? AXES[k].dir : 1) }];
      }
      reRender();
    };
  }

  // ── 行内（tbody）: チップ7種・fable・進捗・行チェック・グリッド選択・行クリック編集 ──
  const tbody = root.querySelector("table tbody");
  if (tbody) {
    // クリック（bubble）。最も具体的なターゲットから順に判定し、最初に一致したら処理して return。
    // ＝旧チップ群の e.stopPropagation() を「順序return」で等価再現。
    tbody.onclick = (e) => {
      let el;
      if (gSwallowClick) { gSwallowClick = false; return; } // インライン編集を閉じただけのクリック＝何もしない
      if ((el = e.target.closest(".tb-stbtn")))   { openStatusMenu(el, +el.dataset.st, tasks, root); return; }
      if ((el = e.target.closest(".tb-projbtn")))  { openProjectMenu(el, +el.dataset.proj, tasks, root); return; }
      if ((el = e.target.closest(".tb-grpbtn")))   { openGroupMenu(el, +el.dataset.grp, tasks, root); return; }
      if ((el = e.target.closest(".tb-asbtn")))    { openAssigneeMenu(el, +el.dataset.as, tasks, members, root); return; }
      if ((el = e.target.closest(".tb-catbtn")))   { openCategoryMenu(el, +el.dataset.cat, tasks, labels, root); return; }
      if ((el = e.target.closest(".tb-priobtn")))  { openPrioMenu(el, +el.dataset.prio, tasks, root); return; }
      if ((el = e.target.closest(".tb-duebtn")))   { openDueMenu(el, +el.dataset.due, tasks, root, today); return; }
      if ((el = e.target.closest(".tb-estbtn")))   { openEstMenu(el, +el.dataset.est, tasks, root); return; }
      if ((el = e.target.closest(".tb-timer"))) {
        // タスク行から即・集中タイマー開始。行クリック編集と競合しないよう順序return（実質 stopPropagation）。
        e.preventDefault();
        const ok = startFocusFor(+el.dataset.timer, el.dataset.title);
        if (ok === false) { // 既に別タスクで稼働中＝上書きしない。タイトル属性で簡易フィードバック。
          el.classList.add("busy"); el.title = "別のタスクでタイマー稼働中です";
          setTimeout(() => { el.classList.remove("busy"); el.title = "このタスクでタイマー開始"; }, 1600);
        }
        return;
      }
      if ((el = e.target.closest(".tb-fable"))) {
        // 旧 fable: ボタン disabled/innerHTML 書換ありの async 経路（el を b として使う）。
        const b = el; b.disabled = true;
        import("../lib/exec.js").then(async ({ runAi }) => {
          try { const j = await runAi(+b.dataset.fable, b.dataset.title); b.innerHTML = `${icon("play", { size: 11 })}…`; b.title = `キュー #${j.job.id} に追加済み`; }
          catch { b.disabled = false; }
        }).catch(() => { b.disabled = false; });
        return;
      }
      if ((el = e.target.closest(".tb-pctbar"))) { setProgress(el, +el.dataset.pct, root, e.clientX, tasks); return; }
      if ((el = e.target.closest(".tb-rowck[data-ck]"))) {
        // 行チェック: 旧 wireSelection は e.preventDefault() を残していた（現挙動踏襲）。
        e.preventDefault();
        if (selH) selH.onRowCheck(+el.dataset.ck, e.shiftKey);
        return;
      }
      // ここで manualMode をガード（チップ/進捗/チェックより後＝マイソート中もそれらは生きる）。
      // マイソート中はグリッド選択も行クリック編集も無効（原典どおり）。タップ＝編集は wireDrag が担う。
      if (V.manualMode) return;
      // タスク名テキストのワンクリック＝インライン編集（従来はダブルクリック。シングルで直接開く）。
      if ((el = e.target.closest(".tb-tle"))) {
        const cell = el.closest("td.tb-gc");
        if (cell) { gridEditFromEl(cell, root); return; }
      }
      // 余白（セルの padding 等＝td 自身が直接のクリック対象）クリックで編集を開く（要望）。
      // チップ/タイトル文字など「内容」のクリックは e.target が子要素になるため、ここを素通りして従来の挙動へ。
      if (e.target.tagName === "TD") {
        const trEdit = e.target.closest("tr[data-id]");
        if (trEdit) { openTaskForm({ taskId: +trEdit.dataset.id, onSaved: () => render(root) }); return; }
      }
      if ((el = e.target.closest(".tb-gc"))) { gridSelectFromEl(el, root); return; }
      const tr = e.target.closest("tr[data-id]"); if (tr) openTaskForm({ taskId: +tr.dataset.id, onSaved: () => render(root) });
    };
    // ダブルクリック（bubble）: グリッド編集／行ダブルクリック編集。
    tbody.ondblclick = (e) => {
      if (gSwallowClick) { gSwallowClick = false; return; } // 編集を閉じたクリックの連打対策
      // 階段セルの余白（タスク名・ボタン・バッジ以外）ダブルクリック → タスク編集フォーム（要望）。
      // タスク名テキスト自体はシングルクリックでインライン編集が開くので対象外。
      if (e.target.closest(".tb-stair") && !e.target.closest(".tb-tle, .tb-timer, .tb-fable, .tb-projbtn, .tb-grpbtn, .tb-k, .tb-fav, .tb-gedit")) {
        const tr = e.target.closest("tr[data-id]");
        if (tr) { openTaskForm({ taskId: +tr.dataset.id, onSaved: () => render(root) }); return; }
      }
      const gc = e.target.closest(".tb-gc"); if (gc) { gridEditFromEl(gc, root); return; }
      if (e.target.closest(".tb-fable, .tb-timer, .tb-rowck, .tb-pctbar")) return; // 行編集フォームを誤起動させない
      const tr = e.target.closest("tr[data-id]"); if (tr) openTaskForm({ taskId: +tr.dataset.id, onSaved: () => render(root) });
    };
    // 右クリック（bubble）: 行メニュー。
    tbody.oncontextmenu = (e) => {
      const tr = e.target.closest("tr[data-id]"); if (!tr) return;
      e.preventDefault(); openRowMenu(e.clientX, e.clientY, +tr.dataset.id, tasks, root);
    };
    // capture mousedown: 列挙セルのボタン押下時にアクティブセルを同期（旧 wireGrid の per-button capture を集約）。
    // capture は addEventListener でのみ指定可。総入替で tbody は毎回新規＝二重化しない。
    tbody.addEventListener("mousedown", (e) => {
      // インライン編集中の外側 mousedown: blur で編集は閉じるが、その同じクリックで行編集や
      // メニューが誤発火しないよう、直後の click を1回だけ無効化する（編集入力欄内は除く）。
      if (gEditing && !e.target.closest(".tb-gedit")) gSwallowClick = true;
      const btn = e.target.closest("td.tb-gc button"); if (!btn) return;
      const cell = btn.closest("td.tb-gc"); const tr = cell && cell.closest("tr[data-id]");
      if (tr) { gAnchor = null; gActive = { id: +tr.dataset.id, col: cell.dataset.col }; }
    }, true);
    // keydown（bubble）: 進捗バーのキーボード操作（←→/↑↓/Home/End/Space/Enter）。
    tbody.onkeydown = (e) => {
      const bar = e.target.closest(".tb-pctbar"); if (!bar) return;
      const cur = +bar.getAttribute("aria-valuenow") || 0;
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(100, cur + 25);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, cur - 25);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 100;
      else if (e.key === " " || e.key === "Enter") next = (cur + 25) > 100 ? 0 : cur + 25;
      if (next === null) return;
      e.preventDefault(); e.stopPropagation(); // stopPropagation維持＝document グリッドハンドラへ漏らさない
      const rc = bar.getBoundingClientRect();
      setProgress(bar, +bar.dataset.pct, root, rc.left + rc.width * (next / 100), tasks);
    };
  }

  // ── アウトライン（.ol-card）: 折りたたみトグル・チェック完了・＋サブタスク・行クリック編集 ──
  const card = root.querySelector(".ol-card");
  if (card) {
    card.onclick = (e) => {
      // 1. 折りたたみトグル（.ol-tw[data-id]）。子なしプレースホルダ（.ol-tw.none＝data-id無し）は無反応。
      const tw = e.target.closest(".ol-tw");
      if (tw) { if (tw.dataset.id) { const id = +tw.dataset.id; olCollapsed.has(id) ? olCollapsed.delete(id) : olCollapsed.add(id); saveOlCollapsed(UID); render(root); } return; }
      // 2. チェック（.ol-cb）で done を即トグル。
      const cb = e.target.closest(".ol-cb");
      if (cb) {
        const id = +cb.dataset.id, done = cb.dataset.done === "1";
        const t = (tasks || []).find((x) => x.id === id);
        const before = { done: !!(t && t.done), percent_done: (t && t.percent_done) || 0 };
        const after = done ? { done: false, percent_done: before.percent_done } : { done: true, percent_done: 100 };
        const applyDone = (taskId, s) => updateTask(taskId, { done: s.done, percent_done: s.percent_done });
        applyDone(id, after).then(() => { pushScalarEdit("完了切替", id, before, after, applyDone); invalidate(); render(root); }).catch(() => {});
        return;
      }
      // 3. ＋ でインライン入力を開きサブタスク追加。
      const add = e.target.closest(".ol-addsub");
      if (add) {
        const depth = +(add.dataset.depth || 0);
        if (depth === 0) openAddKindMenu(add, +add.dataset.pid, +add.dataset.proj, root);
        else openInlineSubtask(add, +add.dataset.pid, +add.dataset.proj, root, "task");
        return;
      }
      // 4. 行クリックで編集。
      const row = e.target.closest(".ol-row");
      if (row) openTaskForm({ taskId: +row.dataset.id, onSaved: () => render(root) });
    };
  }

  // 全展開／全折りたたみ（階層モードのみ・ツールバー単発）。
  const olExp = root.querySelector("#tb-ol-expand");
  if (olExp) olExp.onclick = () => { olCollapsed.clear(); saveOlCollapsed(UID); render(root); };
  const olCol = root.querySelector("#tb-ol-collapse");
  if (olCol) olCol.onclick = () => {
    olCollapsed.clear();
    buildTaskTree(rows.map((r) => r.t)).forEach(function add(n) { if (n.children.length) { olCollapsed.add(n.task.id); n.children.forEach(add); } });
    saveOlCollapsed(UID); render(root);
  };
  // 階層: ドラッグ＆ドロップで親（プロジェクト＝親タスク）へ付け替え。階層モードのみ（click 委譲と共存）。
  if (isOutline) wireOutlineDnD(root, rows, () => render(root));

  // 最上部の定期帯: ヘッダで折りたたみ（本人ごとに永続）＋ 行クリックで編集モーダル（委譲）。
  const recHead = root.querySelector("#tb-rec-head");
  if (recHead) recHead.onclick = () => { setRecCollapsed(UID, !loadRecCollapsed(UID)); render(root); };
  const recList = root.querySelector(".tb-rec-list");
  if (recList) recList.onclick = (e) => {
    const rowEl = e.target.closest(".tb-rec-row"); if (!rowEl) return;
    const rec = (recurrences || []).find((x) => x.id === +rowEl.dataset.rid);
    if (rec) openRecurrenceForm({ existing: rec, members, holidaysByDate, onSaved: () => { invalidate(); render(root); } });
  };

  // 一括操作バー（sticky・単発）。表モードのみ。
  if (!isOutline) wireBulk(root, rows, tasks, members, today, labels);
  // Excel風グリッド編集（キーボード移動・インライン編集・コピペ・フィルダウン）。表モードのみ。
  // ※ アクティブセル同期の per-button capture mousedown は上の tbody capture 委譲へ移管済み。
  if (!isOutline) wireGrid(root, rows, tasks, members, labels, today);
  // 余白クリックで選択解除（document全体＝コンテンツ右側の地まで拾う）。一覧表示中のみ作動。
  lastRoot = root;
  if (!docDeselectWired) {
    docDeselectWired = true;
    document.addEventListener("pointerdown", (e) => {
      if (e.button && e.button !== 0) return;                 // 右クリックでは解除しない
      if (document.querySelector(".tb-ctx")) return;          // 右クリックメニュー表示中は触らない
      if (!location.hash.startsWith("#/list")) return;        // 一覧ビュー中のみ
      if (!V || !V.manualMode || !selectedIds.size) return;
      if (e.target.closest("tr[data-id], button, select, input, a, label, .tb-chips, .tb-presets, .tb-sortwrap")) return;
      selectedIds.clear(); anchorId = null;
      if (lastRoot && lastRoot.isConnected) render(lastRoot);
    });
  }

  // プリセット: 適用は本人のV.sortsに反映（共有データは変えない）／保存・削除は全員に反映（要許可）
  root.querySelectorAll(".tb-pz-a").forEach((b) => {
    b.onclick = () => {
      const p = presets[+b.dataset.pi]; if (!p) return;
      V.sorts = (p.sorts || []).map((s) => ({ key: s.key, dir: s.dir })); V.manualMode = false; reRender();
    };
  });
  root.querySelectorAll(".tb-pz-x").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const p = presets[+b.dataset.pi]; if (!p || !confirm(`共有プリセット「${p.name}」を削除しますか？（全員に反映）`)) return;
      b.disabled = true;
      try { await savePresets(presets.filter((_, i) => i !== +b.dataset.pi)); invalidate(); render(root); }
      catch (err) { b.disabled = false; alert("削除に失敗: " + err.message); }
    };
  });
  const psave = root.querySelector("#tb-psave");
  if (psave) psave.onclick = async () => {
    const name = (prompt("共有プリセット名（全員が使えます）", presetSuggest(V.sorts)) || "").trim();
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, sorts: V.sorts.map((s) => ({ key: s.key, dir: s.dir })) }];
    psave.disabled = true;
    try { await savePresets(next); invalidate(); render(root); }
    catch (err) { psave.disabled = false; alert("保存に失敗: " + err.message); }
  };

  // マイソート（手動順）の保存・適用・削除＝本人ごと（ローカル）
  root.querySelectorAll(".tb-mz-a").forEach((b) => {
    b.onclick = () => { const m = mysorts[+b.dataset.mi]; if (!m) return; V.order = [...(m.order || [])]; V.manualMode = true; reRender(); };
  });
  root.querySelectorAll(".tb-mz-x").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const m = mysorts[+b.dataset.mi]; if (!m || !confirm(`マイソート「${m.name}」を削除しますか？`)) return;
      saveMySorts(UID, mysorts.filter((_, i) => i !== +b.dataset.mi)); render(root);
    };
  });
  const msave = root.querySelector("#tb-msave");
  if (msave) msave.onclick = () => {
    const name = (prompt("マイソート名（あなた専用）", "やる順") || "").trim();
    if (!name) return;
    const next = [...mysorts.filter((m) => m.name !== name), { name, order: [...(V.order || [])] }];
    saveMySorts(UID, next); render(root);
  };

  if (manual) wireDrag(root, () => render(root));

  // ドロップ直後の着地ハイライト（ジワっと色が戻る＝どこに入ったか見失わない）
  if (flashId != null) {
    const fr = root.querySelector(`tr[data-id="${flashId}"]`);
    if (fr) fr.classList.add("tb-flash");
    flashId = null;
  }
}

// ── 行の右クリックメニュー（編集/完了↔/フラグ↔/削除）。複数選択中の行ならまとめて適用 ──
let _ctxEl = null, _ctxCleanup = null;
function closeRowMenu() { if (_ctxEl) { _ctxEl.remove(); _ctxEl = null; } if (_ctxCleanup) { _ctxCleanup(); _ctxCleanup = null; } }
function openRowMenu(x, y, id, tasks, root) {
  closeRowMenu();
  // 対象: 選択集合に含まれ複数選択中なら全選択、それ以外はこの行のみ
  const ids = (selectedIds.has(id) && selectedIds.size > 1) ? [...selectedIds] : [id];
  const objs = ids.map((tid) => (tasks || []).find((t) => t.id === tid)).filter(Boolean);
  if (!objs.length) return;
  const n = objs.length, multi = n > 1;
  const allDone = objs.every((t) => t.done);
  const allFav = objs.every((t) => t.is_favorite);
  const reload = () => { invalidate(); render(root); };
  const each = async (fn) => {
    let failed = 0;
    for (const t of objs) { try { await fn(t); } catch (e) { failed++; } }
    if (failed) announce(`${failed}件の操作に失敗しました`, { assertive: true });
    reload();
  };
  const items = [
    ...(multi ? [] : [{ label: "編集", on: () => openTaskForm({ taskId: id, onSaved: () => render(root) }) }]),
    { label: allDone ? (multi ? `${n}件を未完了に` : "未完了に戻す") : (multi ? `${n}件を完了` : "完了にする"),
      on: () => each((t) => updateTask(t.id, allDone ? { done: false } : { done: true, percent_done: 100 })) },
    { label: allFav ? (multi ? `${n}件のフラグを外す` : "フラグを外す") : (multi ? `${n}件にフラグ` : "フラグを付ける"),
      on: () => each((t) => updateTask(t.id, { is_favorite: !allFav })) },
    { sep: true },
    { label: multi ? `${n}件を削除` : "削除", danger: true,
      on: () => { if (!confirm(multi ? `${n}件のタスクを削除しますか？` : `「${objs[0].title}」を削除しますか？`)) return; selectedIds.clear(); anchorId = null; each((t) => deleteTask(t.id)); } },
  ];
  openMenu(x, y, items);
}

// 汎用の小メニュー。items: [{label,danger?,check?,toggle?,input?,value?,on}|{sep:true}]
// opts: {keepOpen, rebuild, onClose} — keepOpen中はtoggle項目で閉じずrebuild()で再描画（担当/分類の複数選択用）。
function openMenu(x, y, items, opts = {}) {
  const m = document.createElement("div");
  m.className = "tb-ctx";
  const paint = (its) => {
    m.innerHTML = its.map((it, i) => {
      if (it.sep) return `<div class="tb-ctx-sep"></div>`;
      if (it.header) return `<div class="tb-ctx-hd">${esc(it.label)}</div>`;
      if (it.input === "date") return `<label class="tb-ctx-inp">${esc(it.label)}<input type="date" data-i="${i}" value="${it.value || ""}"></label>`;
      if (it.input === "text") return `<label class="tb-ctx-inp tb-ctx-txt">${esc(it.label)}<input type="text" data-i="${i}" placeholder="${esc(it.placeholder || "")}"></label>`;
      if (it.input === "hmgrid") return `<div class="tb-hg">`
        + `<div class="tb-hg-cols">`
        + `<div class="tb-hg-col h"><span class="tb-hg-lbl">時間</span><div class="tb-hg-wrap">${it.hOpts.map((v) => `<button class="tb-hg-b${v === it.h ? " on" : ""}" data-i="${i}" data-hk="${v}">${v}</button>`).join("")}</div></div>`
        + `<div class="tb-hg-col"><span class="tb-hg-lbl">分</span><div class="tb-hg-min">${it.mOpts.map((v) => `<button class="tb-hg-b${v === it.m ? " on" : ""}" data-i="${i}" data-mk="${v}">${v}</button>`).join("")}</div></div>`
        + `</div>`
        + `<div class="tb-hg-direct"><span class="tb-hg-lbl">直接(h)</span>${hourInputHtml("tb-est-direct", { value: it.hv ?? "" })}</div>`
        + `<div class="tb-hg-foot"><button class="tb-hg-clear" data-i="${i}">クリア</button><button class="tb-hg-cancel" data-i="${i}">キャンセル</button><button class="tb-hg-apply" data-i="${i}">適用</button></div>`
        + `</div>`;
      return `<button class="tb-ctx-it${it.danger ? " danger" : ""}" data-i="${i}">${it.check !== undefined ? `<span class="tb-ctx-ck">${it.check ? icon("check", { size: 13 }) : ""}</span>` : ""}${esc(it.label)}</button>`;
    }).join("");
    m.querySelectorAll(".tb-ctx-it").forEach((b) => {
      b.onclick = () => {
        const it = its[+b.dataset.i];
        if (opts.keepOpen && it.toggle) { it.on && it.on(); paint(opts.rebuild ? opts.rebuild() : its); }
        else { closeRowMenu(); it.on && it.on(); }
      };
    });
    m.querySelectorAll('.tb-ctx-inp input[type="date"]').forEach((inp) => {   // 日付指定（type=date）
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => { const it = its[+inp.dataset.i]; closeRowMenu(); it.on && it.on(inp.value); };
    });
    // テキスト入力アイテム（input:"text"）: Enter で確定・クリックは伝播停止（メニューを閉じない）。
    m.querySelectorAll('.tb-ctx-inp input[type="text"]').forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); const it = its[+inp.dataset.i]; const v = inp.value; closeRowMenu(); it.on && it.on(v); }
      };
    });
    // 時間/分グリッド: ボタンをワンタップで選択（メニューは開いたまま・即反映）
    const repaint = () => paint(opts.rebuild ? opts.rebuild() : its);
    m.querySelectorAll(".tb-hg-b").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const it = its[+b.dataset.i];
        // 時間は同じボタン再押下でトグル解除（=0時間）。分はそのまま選択。
        if (b.dataset.hk !== undefined) { const v = +b.dataset.hk; it.onPick && it.onPick(v === it.h ? 0 : v, it.m); }
        else it.onPick && it.onPick(it.h, +b.dataset.mk);
        repaint();
      };
    });
    // 直接入力(h)＝編集画面と同じ0.25刻みステッパー。適用 or Enter で反映。
    const dEl = m.querySelector("#tb-est-direct");
    if (dEl) {
      wireHourInput(m, "tb-est-direct");
      const applyEl = m.querySelector(".tb-hg-apply");
      const applyHours = () => { const v = dEl.value.trim().replace(/^\./, "0."); const hf = v ? parseFloat(v) : 0; const it = its[+applyEl.dataset.i]; it.onHours && it.onHours(hf); closeRowMenu(); }; // 適用で閉じる（onClose→同期）
      dEl.addEventListener("click", (e) => e.stopPropagation());
      dEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyHours(); } });
      applyEl.onclick = (e) => { e.stopPropagation(); applyHours(); };
      const clearEl = m.querySelector(".tb-hg-clear");
      if (clearEl) clearEl.onclick = (e) => { e.stopPropagation(); const it = its[+clearEl.dataset.i]; closeRowMenu(); it.onClear && it.onClear(); };
      const cancelEl = m.querySelector(".tb-hg-cancel");
      if (cancelEl) cancelEl.onclick = (e) => { e.stopPropagation(); closeRowMenu(); };
    }
    // 時間カラムは縦スクロール。開いた／再描画時に選択中が見える位置へ寄せる。
    const onH = m.querySelector(".tb-hg-wrap .tb-hg-b.on");
    if (onH) onH.scrollIntoView({ block: "nearest" });
  };
  document.body.appendChild(m);
  _ctxEl = m;
  paint(items);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 8)) + "px";
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 8)) + "px";
  const onDown = (ev) => { if (!m.contains(ev.target)) closeRowMenu(); };
  const onKey = (ev) => { if (ev.key === "Escape") closeRowMenu(); };
  // ページ側スクロールでは閉じるが、メニュー内（時間グリッド等）のスクロールでは閉じない。
  const onScroll = (ev) => { if (ev && ev.target && ev.target.nodeType === 1 && m.contains(ev.target)) return; closeRowMenu(); };
  setTimeout(() => { document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey); window.addEventListener("scroll", onScroll, true); window.addEventListener("resize", onScroll); }, 0);
  _ctxCleanup = () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); if (opts.onClose) opts.onClose(); };
}

// ステータスのワンクリック変更（チップ直下にメニュー）。未着手/進行中/完了。
function openStatusMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const cur = statusOf(t);
  const reload = () => { invalidate(); render(root); };
  // 取消用に変更前のステータス関連フィールドを捕捉（done/percent/started_at/連絡待ちラベル）。
  const wasWaiting = (t.labels || []).some((l) => (l.title || "") === WAITING_LABEL);
  const before = { done: !!t.done, percent_done: t.percent_done || 0, started_at: t.started_at || null, waiting: wasWaiting };
  // status キーに応じたフィールド差分（scalar patch）＋連絡待ちラベルの on/off を組み立てる。
  const stateOf = (key) => {
    if (key === "waiting") return { patch: { done: false, percent_done: t.percent_done || 0, started_at: t.started_at || null }, waiting: true };
    const patch = statePatchFor(key, t);
    return { patch, waiting: false };
  };
  // before/after（{done,percent_done,started_at,waiting}）を実際に適用する。undo/redo で同じ経路。
  // 連絡待ちラベルの付け外しは冪等だが、現在のラベル状態に基づく判定が要るので最新タスクを読む。
  const applyState = async (taskId, s) => {
    await updateTask(taskId, { done: s.done, percent_done: s.percent_done, started_at: s.started_at });
    let tt = null; try { tt = await getTask(taskId); } catch { tt = (tasks || []).find((x) => x.id === taskId) || t; }
    await setTaskWaiting(tt, !!s.waiting);
  };
  // ステータスと進捗%は別軸。状態変更は%を捏造しない。
  // 進行中＝着手時刻(started_at)を立てるだけ／未着手＝下ろすだけ（%には触らない=0のまま）。
  // 完了だけが唯一 %=100 を意味する（その逆＝未完了化で % を 0 に戻す）。
  const set = (key) => {
    const st = stateOf(key);
    const after = { done: !!st.patch.done, percent_done: st.patch.percent_done ?? 0, started_at: st.patch.started_at ?? null, waiting: st.waiting };
    // 連絡待ち（GTD Waiting For）= 予約ラベルで表現。未完了化＋ラベル付与だけ。
    if (key === "waiting") {
      Promise.all([updateTask(id, { done: false }), setTaskWaiting(t, true)]).then(() => {
        pushScalarEdit("ステータス変更", id, before, after, applyState); patchRow(id, root, { col: "state" });
      }).catch(() => {});
      return;
    }
    // 連絡待ち以外に変えるときは待ちラベルを外す。
    Promise.all([updateTask(id, st.patch), setTaskWaiting(t, false)]).then(() => {
      pushScalarEdit("ステータス変更", id, before, after, applyState); patchRow(id, root, { col: "state" });
    }).catch(() => {});
  };
  const it = (key, label) => ({ label, check: cur === key, on: () => set(key) });
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [it("todo", "未着手"), it("doing", "進行中"), it("waiting", "連絡待ち"), it("done", "完了")]);
}

// 重要度のワンクリック変更（なし/低/中/高/MUST）。Vikunja priority を直接更新。
// ※「優先度」＝重要度×緊急度の合成（四象限/トリアージで算出）。この列は素の重要度。
function openPrioMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const cur = t.priority || 0;
  const reload = () => { invalidate(); render(root); };
  const opts = [[0, "なし"], [1, "低"], [2, "中"], [3, "高"], [4, "MUST"]];
  const before = cur;
  const applyPrio = (taskId, p) => updateTask(taskId, { priority: p });
  const items = opts.map(([v, label]) => ({ label, check: (cur >= 4 ? 4 : cur) === v, on: () => updateTask(id, { priority: v }).then(() => { pushScalarEdit("重要度変更", id, before, v, applyPrio); patchRow(id, root, { col: "prio" }); }).catch(() => {}) }));
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

// 期限のワンクリック変更（プリセット＋日付指定＋クリア）。
function openDueMenu(chipEl, id, tasks, root, today) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const reload = () => { invalidate(); render(root); };
  const ZERO = "0001-01-01T00:00:00Z";
  const cur = (t.due_date && !t.due_date.startsWith("0001")) ? t.due_date.slice(0, 10) : "";
  // before/after は "YYYY-MM-DD" or "" を ISO へ。undo/redo で同じ経路。
  const applyDue = (taskId, iso) => updateTask(taskId, { due_date: iso ? iso + "T00:00:00Z" : ZERO });
  const set = (iso) => applyDue(id, iso).then(() => { pushScalarEdit("期限変更", id, cur, iso || "", applyDue); patchRow(id, root, { col: "due" }); }).catch(() => {});
  const dow = new Date(today + "T00:00:00Z").getUTCDay();   // 0=日 … 6=土
  const sat = shiftISO(today, (6 - dow + 7) % 7);           // 今週の土曜（今日以降）
  const items = [
    { label: "今日", check: cur === today, on: () => set(today) },
    { label: "明日", check: cur === shiftISO(today, 1), on: () => set(shiftISO(today, 1)) },
    { label: "今週末（土）", check: cur === sat, on: () => set(sat) },
    { label: "1週間後", on: () => set(shiftISO(today, 7)) },
    { label: "1ヶ月後", on: () => set(shiftISO(today, 30)) },
    { sep: true },
    { label: "日付指定", input: "date", value: cur, on: (v) => set(v || null) },
    { sep: true },
    { label: "クリア（期限なし）", danger: !!cur, on: () => set(null) },
  ];
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

// 見積のワンクリック変更。開いた瞬間に時間(0〜10)と分(0/15/30/45)のボタンが並び、
// ワンタップで選択（メニューは開いたまま即反映・閉じた時にサーバー同期）。
function openEstMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  ensureFormStyle(); // 直接入力(h)のステッパー .tf-step を効かせる
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const cur = t.time_estimate || 0;
  const mBase = [0, 15, 30, 45];
  const hOpts = Array.from({ length: 8 }, (_, k) => k + 1); // 1〜8時間（0/9以上は直接入力で）
  const toHv = (sec) => sec ? Math.round((sec / 3600) * 100) / 100 : "";
  // 秒→グリッドの選択(時間/分)。1〜8時間かつ0.25h刻みに一致する時だけ選択、それ以外は無選択(null)。
  const syncGrid = (sec) => { const hf = sec / 3600; if (sec && hf >= 1 && hf <= 8 && Number.isInteger(hf * 4)) { const hi = Math.floor(hf); return { h: hi, m: Math.round((hf - hi) * 60) }; } return { h: null, m: null }; };
  let g = syncGrid(cur), h = g.h, mn = g.m;
  let hv = toHv(cur);
  const applyEst = (taskId, sec) => updateTask(taskId, { time_estimate: sec });
  // 「適用」するまで保存しない: グリッド選択/直接入力は pending(h/mn/hv)のみ更新。適用・クリアで保存＋履歴記録、キャンセル/外側クリックは破棄。
  const save = (sec) => { applyEst(id, sec).then(() => { if (sec !== cur) pushScalarEdit("見積変更", id, cur, sec, applyEst); patchRow(id, root, { col: "est" }); }).catch(() => {}); };
  const build = () => [
    { input: "hmgrid", h, m: mn, hv, hOpts, mOpts: mBase,
      // グリッド選択は pending 更新のみ（保存しない）。hv に反映し再描画→直接入力欄にも出る＝適用時に拾える。
      onPick: (nh, nm) => { h = (nh == null ? 0 : nh); mn = (nm == null ? 0 : nm); hv = toHv(h * 3600 + mn * 60); },
      // 「適用」= 直接入力欄の値（グリッド選択も hv 経由で反映済み）で保存。
      onHours: (hf) => { if (!isFinite(hf) || hf < 0) return; save(Math.round(hf * 3600)); },
      onClear: () => { save(0); } },
  ];
  const r = chipEl.getBoundingClientRect();
  // onClose は保存しない（適用/クリアのみ保存。キャンセル・外側クリックは破棄）。
  openMenu(r.left, r.bottom + 4, build(), { keepOpen: true, rebuild: build, onClose: () => {} });
}

// 多対多リレーション（担当/分類）の集合編集を1アクションとして履歴へ積む。
// before/after は ID 配列。undo/redo は「現状(API)から見て足りない/余分な分」を add/remove する。
// 単純な集合適用なので途中状態が違っても収束する。getCur は当該タスクの現在ID配列を返す関数。
// 集合の収束適用: getCur()（現状=API側）から target へ、足りない分を add / 余分を remove。
// 途中状態が違っても収束する（pushSetEdit の undo/redo・メニュー onClose の差分適用で共用）。
async function applySetConverge(target, getCur, addFn, removeFn) {
  const ts = new Set(target);
  const cur = getCur();
  for (const x of cur) if (!ts.has(x)) await removeFn(x).catch(() => {});
  for (const x of target) if (!cur.includes(x)) await addFn(x).catch(() => {});
}
function pushSetEdit(label, before, after, getCur, addFn, removeFn) {
  const as = new Set(after);
  if (before.length === after.length && before.every((x) => as.has(x))) return; // 変化なし
  history.push({
    label,
    undo: async () => { await applySetConverge(before, getCur, addFn, removeFn); historyRerender(); },
    redo: async () => { await applySetConverge(after, getCur, addFn, removeFn); historyRerender(); },
  });
}

// 担当のワンクリック変更（メンバーを複数トグル・メニューは開いたまま即反映）。
function openAssigneeMenu(chipEl, id, tasks, members, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  if (!t.assignees) t.assignees = [];
  let dirty = false;
  const before = t.assignees.map((a) => a.id); // 開いた時点の担当ID（履歴の before）
  const curAssignees = () => { const tt = (tasks || []).find((x) => x.id === id); return (tt && tt.assignees ? tt.assignees : t.assignees).map((a) => a.id); };
  const addFn = (uid) => addAssignee(id, uid), removeFn = (uid) => removeAssignee(id, uid);
  const recordAssignees = () => pushSetEdit("担当変更", before, t.assignees.map((a) => a.id), curAssignees, addFn, removeFn);
  // 「適用するまで保存しない」: トグルはローカルの t.assignees を更新するだけ。
  // 閉じた時に onClose で before→最終集合の差分を1回だけ API へ収束適用＋履歴1アクション（順序逆転を防ぐ）。
  const commit = async () => { await applySetConverge(t.assignees.map((a) => a.id), () => before, addFn, removeFn); recordAssignees(); patchRow(id, root, { col: "who" }); };
  const build = () => {
    const items = (members || []).map((m) => ({
      label: m.name || m.username,
      check: t.assignees.some((a) => a.id === m.id),
      toggle: true,
      on: () => {
        dirty = true;
        if (t.assignees.some((a) => a.id === m.id)) { t.assignees = t.assignees.filter((a) => a.id !== m.id); }
        else { t.assignees = [...t.assignees, { id: m.id, username: m.username, name: m.name }]; }
      },
    }));
    if (t.assignees.length) items.push({ sep: true }, { label: "担当なし（全員外す）", danger: true, on: () => { dirty = true; t.assignees = []; commit(); } });
    return items;
  };
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, build(), { keepOpen: true, rebuild: build, onClose: () => { if (dirty) commit(); } });
}

// 分類（ラベル）のワンクリック変更（複数トグル＋新規作成）。レビューは予約語なので除外。
function openCategoryMenu(chipEl, id, tasks, labels, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  if (!t.labels) t.labels = [];
  let dirty = false;
  const before = t.labels.map((x) => x.id); // 開いた時点の分類ラベルID（履歴の before）
  const curLabels = () => { const tt = (tasks || []).find((x) => x.id === id); return (tt && tt.labels ? tt.labels : t.labels).map((x) => x.id); };
  const addFn = (lid) => addTaskLabel(id, lid), removeFn = (lid) => removeTaskLabel(id, lid);
  const recordLabels = () => pushSetEdit("分類変更", before, t.labels.map((x) => x.id), curLabels, addFn, removeFn);
  // 「適用するまで保存しない」: トグルはローカルの t.labels を更新するだけ。
  // 閉じた時に onClose で before→最終集合の差分を1回だけ API へ収束適用＋履歴1アクション（順序逆転を防ぐ）。
  const commit = async () => { await applySetConverge(t.labels.map((x) => x.id), () => before, addFn, removeFn); recordLabels(); patchRow(id, root, { col: "cat" }); };
  const cats = (labels || []).filter((l) => l.title !== REVIEW_LABEL && l.title !== WAITING_LABEL);
  const build = () => {
    const items = cats.map((l) => ({
      label: l.title,
      check: t.labels.some((x) => x.id === l.id),
      toggle: true,
      on: () => {
        dirty = true;
        if (t.labels.some((x) => x.id === l.id)) { t.labels = t.labels.filter((x) => x.id !== l.id); }
        else { t.labels = [...t.labels, l]; }
      },
    }));
    // 新規ラベル作成だけは即時 createLabel（マスタ生成）。付与はローカル＋onClose差分に合わせる。
    items.push({ sep: true }, { label: "＋ 新しい分類…", on: async () => { const name = (prompt("新しい分類名") || "").trim(); if (!name) return; try { const lab = await createLabel(name); t.labels = [...t.labels, lab]; dirty = true; } catch (e) { announce("分類の作成に失敗しました", { assertive: true }); } invalidate(); render(root); } });
    return items;
  };
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, build(), { keepOpen: true, rebuild: build, onClose: () => { if (dirty) commit(); } });
}

// あるタスク（rootId）自身＋その全子孫の id 集合を返す（循環防止に親候補から除外する用）。
function descendantIds(tasks, rootId) {
  const childrenOf = new Map();
  for (const x of tasks) {
    const p = (((x.related_tasks || {}).parenttask) || [])[0];
    if (p) { (childrenOf.get(p.id) || childrenOf.set(p.id, []).get(p.id)).push(x.id); }
  }
  const out = new Set([rootId]); const stack = [rootId];
  while (stack.length) {
    const c = stack.pop();
    for (const k of (childrenOf.get(c) || [])) if (!out.has(k)) { out.add(k); stack.push(k); }
  }
  return out;
}

// プロジェクト（親タスク）のワンクリック変更。候補＝既存の親タスク（自分自身と子孫は循環防止で除外）。
function openProjectMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const cur = (((t.related_tasks || {}).parenttask) || [])[0];
  const curId = cur ? cur.id : null;
  const excluded = descendantIds(tasks, id); // 自分＋子孫（親に選べない）
  // 候補＝親として使われているタスク（distinct）。除外集合のものは弾く。
  const cand = new Map();
  for (const x of tasks || []) {
    const p = (((x.related_tasks || {}).parenttask) || [])[0];
    if (p && !excluded.has(p.id)) cand.set(p.id, p.title || "");
  }
  const apply = (newId) => {
    gActive = { id, col: "proj" };
    gridApply("プロジェクト変更", [{ id, col: "proj", before: curId || "", after: newId || "" }]);
  };
  const items = [...cand.entries()]
    .sort((a, b) => (a[1] || "").localeCompare(b[1] || "", "ja"))
    .map(([pid, title]) => ({ label: title || "(無題)", check: curId === pid, on: () => apply(pid) }));
  items.push({ sep: true });
  items.push({ label: "親タスクを新規/他から選ぶ…", on: () => openTaskForm({ taskId: id, onSaved: () => render(root) }) });
  if (curId) items.push({ label: "プロジェクトから外す", danger: true, on: () => apply(null) });
  const rc = chipEl.getBoundingClientRect();
  openMenu(rc.left, rc.bottom + 4, items);
}

// タスクグループのワンクリック変更。候補＝同じプロジェクト直下の既存グループ（子を持つ直下タスク）。
// 適用は「直近親の付け替え」＝ gRawSet("proj") をそのまま再利用（undo/redo も同経路）。
function openGroupMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const byId = new Map((tasks || []).map((x) => [x.id, x]));
  const project = projectAncestor(t, byId); if (!project) return; // プロジェクトなしはグループ不可（ボタン自体出ない）
  const cur = (((t.related_tasks || {}).parenttask) || [])[0];
  const curId = cur ? cur.id : null;
  const inGroup = !!(curId && curId !== project.id); // 直近親がプロジェクト以外＝グループ所属
  const excluded = descendantIds(tasks, id);          // 自分＋子孫（循環防止）
  const cands = (tasks || []).filter((x) => {
    if (excluded.has(x.id)) return false;
    const p = (((x.related_tasks || {}).parenttask) || [])[0];
    if (!p || p.id !== project.id) return false;                       // プロジェクト直下の子だけ
    return ((((x.related_tasks || {}).subtask) || []).length > 0);     // 子を持つ＝グループ
  });
  const apply = (newParentId) => {
    gridApply("タスクグループ変更", [{ id, col: "proj", before: curId || "", after: newParentId || "" }]);
  };
  const items = cands
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "ja"))
    .map((g) => ({ label: g.title || "(無題)", check: curId === g.id, on: () => apply(g.id) }));
  if (items.length) items.push({ sep: true });
  items.push({ input: "text", label: "＋ 新規グループを作成", placeholder: "グループ名を入力して Enter", on: async (name) => {
    const nm = (name || "").trim(); if (!nm) return;
    try {
      const g = await createTaskInProject(project.project_id, { title: nm }); // グループはプロジェクトと同じWSへ
      await addRelation(project.id, g.id, "subtask");                          // プロジェクト配下に紐付け
      apply(g.id);
    } catch (err) { announce("グループの作成に失敗しました: " + err.message, { assertive: true }); }
  } });
  if (inGroup) items.push({ label: "グループから外す（プロジェクト直下へ）", danger: true, on: () => apply(project.id) });
  const rc = chipEl.getBoundingClientRect();
  openMenu(rc.left, rc.bottom + 4, items);
}

// ── 列の表示/非表示・並べ替えメニュー（歯車）。本人ごと（V.colOrder/V.hiddenCols）に保存。 ──
// チェックで表示/非表示（タスク名は固定＝常に表示）、▲▼で並べ替え。変更ごとに保存＋onApply で再描画。
function openColumnsMenu(anchorEl, onApply) {
  closeRowMenu();
  const m = document.createElement("div");
  m.className = "tb-ctx tb-colsmenu";
  const apply = () => { saveView(UID, V); onApply && onApply(); };
  const paint = () => {
    const order = orderedColKeys(V);
    const hidden = new Set(V.hiddenCols || []);
    const rows = order.map((k, i) => {
      const c = colByKey(k); if (!c) return "";
      const on = c.fixed || !hidden.has(k);
      return `<div class="tb-colrow" data-k="${esc(k)}">
        <button class="tb-colck${on ? " on" : ""}${c.fixed ? " fixed" : ""}" data-ck="${esc(k)}" ${c.fixed ? "disabled title=\"タスク名は常に表示\"" : `title="${on ? "クリックで非表示" : "クリックで表示"}"`}>${on ? icon("check", { size: 12 }) : ""}</button>
        <span class="tb-collbl">${esc(c.label)}</span>
        <span class="tb-colmv">
          <button class="tb-colup" data-up="${esc(k)}" ${i === 0 || STAIR_KEYS.includes(k) ? "disabled" : ""} title="上へ">▲</button>
          <button class="tb-coldn" data-dn="${esc(k)}" ${i === order.length - 1 || STAIR_KEYS.includes(k) ? "disabled" : ""} title="下へ">▼</button>
        </span>
      </div>`;
    }).join("");
    m.innerHTML = `<div class="tb-colhd">列の表示・並べ替え</div>${rows}
      <div class="tb-colft"><button class="tb-colreset" type="button">既定に戻す</button></div>`;
    // 表示/非表示トグル
    m.querySelectorAll(".tb-colck:not(.fixed)").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const k = b.dataset.ck; const h = new Set(V.hiddenCols || []);
        h.has(k) ? h.delete(k) : h.add(k); V.hiddenCols = [...h];
        apply(); paint();
      };
    });
    // 並べ替え（▲▼）。順序は orderedColKeys を起点に隣と入れ替えて保存。
    const reorder = (k, delta) => {
      const ord = orderedColKeys(V); const i = ord.indexOf(k); const j = i + delta;
      if (i < 0 || j < 0 || j >= ord.length) return;
      [ord[i], ord[j]] = [ord[j], ord[i]];
      V.colOrder = ord; apply(); paint();
    };
    m.querySelectorAll(".tb-colup").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); reorder(b.dataset.up, -1); }; });
    m.querySelectorAll(".tb-coldn").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); reorder(b.dataset.dn, +1); }; });
    const reset = m.querySelector(".tb-colreset");
    if (reset) reset.onclick = (e) => { e.stopPropagation(); V.colOrder = []; V.hiddenCols = []; apply(); paint(); };
  };
  document.body.appendChild(m);
  _ctxEl = m;
  paint();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  const r = anchorEl.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(r.left, window.innerWidth - mw - 8)) + "px";
  m.style.top = Math.max(6, Math.min(r.bottom + 4, window.innerHeight - mh - 8)) + "px";
  const onDown = (ev) => { if (!m.contains(ev.target)) closeRowMenu(); };
  const onKey = (ev) => { if (ev.key === "Escape") closeRowMenu(); };
  setTimeout(() => { document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey); }, 0);
  _ctxCleanup = () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
}

// ── 進捗(%)のインライン編集 ──────────────────────────────────────────
// 進捗バーをクリック→押した横位置から 0/25/50/75/100 をクイックセット（クリック位置に最も近い段階）。
// updateTask(percent_done) ＋ history.push（取消/やり直し対応）。完了/未完了の done は自動連動しない
// （ステータス列の責務）が、100%にしたら完了・100%未満から下げたら未完了へ寄せる＝直感に合わせる。
function setProgress(barEl, id, root, clientX, tasks) {
  const t = (tasks || (gCtx && gCtx.tasks) || []).find((x) => x.id === id) || null;
  const beforeT = t || {};
  const before = { percent_done: beforeT.percent_done || 0, done: !!beforeT.done };
  // クリック横位置を 0..100 に量子化（0/25/50/75/100）。位置が取れなければ次段階へ巡回。
  let pct;
  if (typeof clientX === "number") {
    const rc = barEl.getBoundingClientRect();
    const ratio = rc.width ? Math.min(1, Math.max(0, (clientX - rc.left) / rc.width)) : 0;
    pct = Math.round(ratio * 4) * 25;
  } else {
    const steps = [0, 25, 50, 75, 100];
    pct = steps[(steps.indexOf(before.percent_done) + 1) % steps.length] ?? 0;
  }
  const after = { percent_done: pct, done: pct >= 100 };
  if (after.percent_done === before.percent_done && after.done === before.done) return; // 変化なし＝何もしない
  const applyPct = (taskId, s) => updateTask(taskId, { percent_done: s.percent_done, done: s.done });
  applyPct(id, after).then(() => { pushScalarEdit("進捗変更", id, before, after, applyPct); patchRow(id, root, { col: "pct" }); }).catch(() => {});
}

// ══ Excel風グリッド編集 ══════════════════════════════════════════════
// 表モードのタスク一覧を、キーボードでセル移動しながら高速編集する層。
// - 矢印=移動 / Shift+矢印=矩形選択 / Enter=確定して下 / Tab=右 / F2・直接入力=編集 / Esc=取消
// - テキスト系(タイトル/見積/期限)はセル内インライン入力、列挙(担当/分類/重要度/ステータス)は既存ポップアップ
// - Ctrl+C/V=セル値コピペ（列の型ごとにテキスト解釈）/ Ctrl+D=選択範囲を上のセルで下方向フィル
// - 適用は rawSet（履歴なし）＋バッチで history に1エントリ＝コピペ/フィルも1回のUndoで戻る
const GCOLS = ["proj", "title", "who", "cat", "prio", "due", "est", "state"]; // ナビ対象＝編集可能列（描画順）
const GTEXT = new Set(["title", "due", "est"]); // セル内インライン入力する列（他は列挙ポップアップ）
const GLABEL = { proj: "プロジェクト変更", title: "タスク名変更", who: "担当変更", cat: "分類変更", prio: "重要度変更", due: "期限変更", est: "見積変更", state: "ステータス変更" };
const PRIO_NAME = { 0: "なし", 1: "低", 2: "中", 3: "高", 4: "MUST" };
const PRIO_NUM = { "なし": 0, "低": 1, "中": 2, "高": 3, "must": 4, "MUST": 4 };
const STATE_LABEL2KEY = { "未着手": "todo", "進行中": "doing", "連絡待ち": "waiting", "完了": "done" };
const ZERO_DUE = "0001-01-01T00:00:00Z";
let gActive = null;   // {id, col} アクティブセル（タスクID＋列キーで保持＝並べ替えに強い）
let gAnchor = null;   // {id, col} 矩形選択のアンカー（null時はアクティブ＝単一セル）
let gEditing = false; // インライン編集中か（グリッドのキー操作を止める）
let gSwallowClick = false; // 編集中の外側クリック＝閉じるだけ（直後の click/dblclick を1回だけ無効化）
let gClip = null;     // 内部クリップボード {cols:[colKey], rows:[[text,...],...]}
let gKeyWired = false;
let gCtx = null;      // {root, tasks, members, labels, today}
let _gridBusy = false; // gridApply の並行ガード（連続発火時に await が重ならないよう直列化）

function findGTask(id) { return (gCtx && gCtx.tasks || []).find((x) => x.id === id) || null; }
function userCats(t) { return (t.labels || []).filter((l) => (l.title || "") !== REVIEW_LABEL && (l.title || "") !== WAITING_LABEL); }
function orderedIds(root) { return [...root.querySelectorAll("table tr[data-id]")].map((tr) => +tr.dataset.id); }
// グリッドのナビ対象列＝今 DOM に出ている編集可能列を描画順で取得（列の表示/非表示・並べ替えに自動追従）。
// 先頭行の td.tb-gc[data-col] から拾う。行が無ければ GCOLS（全列）にフォールバック。
function gCols(root) {
  const tr = root && root.querySelector("table tbody tr[data-id]");
  if (!tr) return GCOLS;
  const ks = [...tr.querySelectorAll("td.tb-gc[data-col]")].map((td) => td.dataset.col);
  return ks.length ? ks : GCOLS;
}
function gCellEl(root, id, col) { return root.querySelector(`tr[data-id="${id}"] td.tb-gc[data-col="${col}"]`); }

// セルの論理値（before/after・rawSet で使う型）
function gReadVal(col, t) {
  if (col === "proj") return (((t.related_tasks || {}).parenttask) || [])[0]?.id || "";
  if (col === "title") return t.title || "";
  if (col === "who") return humanAssignees(t).map((a) => a.id).sort((a, b) => a - b);
  if (col === "cat") return userCats(t).map((l) => l.id).sort((a, b) => a - b);
  if (col === "prio") return t.priority || 0;
  if (col === "due") return dueISO(t);
  if (col === "est") return t.time_estimate || 0;
  if (col === "state") return statusOf(t);
  return null;
}
// セルの表示テキスト（コピー時のシリアライズ）
function gValToText(col, t) {
  if (col === "proj") { const p = (((t.related_tasks || {}).parenttask) || [])[0]; return p ? (p.title || "") : ""; }
  if (col === "title") return t.title || "";
  if (col === "who") return humanAssignees(t).map((a) => a.name || a.username).join(", ");
  if (col === "cat") return userCats(t).map((l) => l.title).join(", ");
  if (col === "prio") return PRIO_NAME[Math.min(t.priority || 0, 4)] ?? "なし";
  if (col === "due") return dueISO(t);
  if (col === "est") return t.time_estimate ? String(Math.round((t.time_estimate / 3600) * 100) / 100) : "";
  if (col === "state") return STATUS[statusOf(t)].label;
  return "";
}
// テキスト → 論理値（ペースト時の型別解釈）。無効は null（=そのセルはスキップ）。
function gParseText(col, text) {
  const s = (text == null ? "" : String(text)).trim();
  if (col === "proj") {
    if (!s) return "";
    const key = s.toLowerCase();
    const hit = (gCtx.tasks || []).find((x) => (x.title || "").trim().toLowerCase() === key);
    return hit ? hit.id : null;
  }
  if (col === "title") return s ? s : null;
  if (col === "due") { if (!s) return ""; const iso = parseSmartDate(s); return iso || null; }
  if (col === "est") { if (!s) return 0; const hf = parseFloat(s.replace(/[hH時間\s]/g, "")); return isFinite(hf) && hf >= 0 ? Math.round(hf * 3600) : null; }
  if (col === "prio") { if (/^[0-4]$/.test(s)) return +s; const v = PRIO_NUM[s] ?? PRIO_NUM[s.toLowerCase()]; return v == null ? null : v; }
  if (col === "state") { const k = STATE_LABEL2KEY[s] || (["todo", "doing", "waiting", "done"].includes(s) ? s : null); return k; }
  if (col === "who") {
    if (!s) return [];
    const names = s.split(/[,、]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const ids = (gCtx.members || []).filter((m) => names.includes((m.name || "").toLowerCase()) || names.includes((m.username || "").toLowerCase())).map((m) => m.id);
    return ids.sort((a, b) => a - b);
  }
  if (col === "cat") {
    if (!s) return [];
    const titles = s.split(/[,、]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const ids = (gCtx.labels || []).filter((l) => (l.title || "") !== REVIEW_LABEL && (l.title || "") !== WAITING_LABEL && titles.includes((l.title || "").toLowerCase())).map((l) => l.id);
    return ids.sort((a, b) => a - b);
  }
  return null;
}
function gEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 論理値をサーバへ適用（履歴は積まない）。set系(担当/分類)は現状から収束、state は正準フィールドへ。
async function gRawSet(col, id, value) {
  if (col === "proj") {
    // 値=親タスクID（""=親なし）。現在の親をライブに読み、現状→目標へ差分適用（undo/redo 両方向に効く）。
    const t = findGTask(id) || {};
    const cur = (((t.related_tasks || {}).parenttask) || [])[0];
    const curId = cur ? cur.id : null;
    if (curId && curId !== value) await removeRelation(curId, "subtask", id).catch(() => {});
    if (value && value !== curId) await addRelation(+value, id, "subtask").catch(() => {});
    return;
  }
  if (col === "title") return updateTask(id, { title: value });
  if (col === "prio") return updateTask(id, { priority: value });
  if (col === "due") return updateTask(id, { due_date: value ? value + "T00:00:00Z" : ZERO_DUE });
  if (col === "est") return updateTask(id, { time_estimate: value });
  if (col === "who") {
    const t = findGTask(id) || { assignees: [] };
    const cur = humanAssignees(t).map((a) => a.id);
    for (const x of cur) if (!value.includes(x)) await removeAssignee(id, x).catch(() => {});
    for (const x of value) if (!cur.includes(x)) await addAssignee(id, x).catch(() => {});
    return;
  }
  if (col === "cat") {
    const t = findGTask(id) || { labels: [] };
    const cur = userCats(t).map((l) => l.id);
    for (const x of cur) if (!value.includes(x)) await removeTaskLabel(id, x).catch(() => {});
    for (const x of value) if (!cur.includes(x)) await addTaskLabel(id, x).catch(() => {});
    return;
  }
  if (col === "state") {
    const t = findGTask(id) || {};
    if (value === "waiting") { await updateTask(id, { done: false }); await setTaskWaiting(t, true); return; }
    const patch = statePatchFor(value, t);
    await updateTask(id, patch); await setTaskWaiting(t, false);
    return;
  }
}
// 複数セル編集をまとめて適用＋履歴1エントリ。edits=[{id,col,before,after}]。適用後に再描画。
async function gridApply(label, edits) {
  // 並行ガード: paste/fill/単一編集すべてこの経路。連続発火時に await が重なって順序逆転しないよう直列化。
  if (_gridBusy) return;
  _gridBusy = true;
  try {
    const real = edits.filter((e) => !gEqual(e.before, e.after));
    if (!real.length) { historyRerender(); return; }
    for (const e of real) await gRawSet(e.col, e.id, e.after);
    history.push({
      label: real.length > 1 ? `${label}（${real.length}件）` : label,
      undo: async () => { for (const e of real) await gRawSet(e.col, e.id, e.before); historyRerender(); },
      redo: async () => { for (const e of real) await gRawSet(e.col, e.id, e.after); historyRerender(); },
    });
    historyRerender();
  } finally {
    _gridBusy = false;
  }
}

// アクティブ/選択ハイライトの再適用（再描画ごと）。アクティブIDが消えていたら解除。
function gridHighlight() {
  const root = gCtx && gCtx.root; if (!root) return;
  root.querySelectorAll(".tb-gc-active, .tb-gc-insel").forEach((el) => el.classList.remove("tb-gc-active", "tb-gc-insel"));
  if (!gActive) return;
  const order = orderedIds(root);
  const COLS = gCols(root);
  // アクティブ列が今は非表示なら選択を解除（列を隠したら宙に浮かない）。
  if (!order.includes(gActive.id) || !COLS.includes(gActive.col)) { gActive = null; gAnchor = null; return; }
  const anc = gAnchor || gActive;
  const r0 = order.indexOf(gActive.id), r1 = order.indexOf(anc.id);
  const c0 = COLS.indexOf(gActive.col), c1 = COLS.indexOf(anc.col);
  if (order.includes(anc.id) && COLS.includes(anc.col) && (r0 !== r1 || c0 !== c1)) {
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        const el = gCellEl(root, order[r], COLS[c]); if (el) el.classList.add("tb-gc-insel");
      }
  }
  const act = gCellEl(root, gActive.id, gActive.col);
  if (act) { act.classList.add("tb-gc-active"); act.scrollIntoView({ block: "nearest", inline: "nearest" }); }
}

// 移動: dir=up/down/left/right。extend=trueで選択を伸ばす（アンカー保持）。
function gridMove(dir, extend) {
  const root = gCtx && gCtx.root; if (!root || !gActive) return;
  const order = orderedIds(root);
  const COLS = gCols(root);
  let r = order.indexOf(gActive.id), c = COLS.indexOf(gActive.col);
  if (r < 0 || c < 0) return;
  if (dir === "up") r = Math.max(0, r - 1);
  else if (dir === "down") r = Math.min(order.length - 1, r + 1);
  else if (dir === "left") c = Math.max(0, c - 1);
  else if (dir === "right") c = Math.min(COLS.length - 1, c + 1);
  if (extend) { if (!gAnchor) gAnchor = { ...gActive }; } else { gAnchor = null; }
  gActive = { id: order[r], col: COLS[c] };
  gridHighlight();
}

// アクティブセルを編集開始。テキスト系=インライン入力 / 列挙=既存ポップアップ（セル内ボタンをクリック）。
function gridEditActive(initial) {
  const root = gCtx && gCtx.root; if (!root || !gActive) return;
  const cell = gCellEl(root, gActive.id, gActive.col); if (!cell) return;
  if (GTEXT.has(gActive.col)) { gridInline(cell, gActive.id, gActive.col, initial); return; }
  const btn = cell.querySelector("button"); if (btn) btn.click(); // 列挙はポップアップ
}

function gridInline(cell, id, col, initial) {
  const t = findGTask(id); if (!t) return;
  gEditing = true;
  // 階段セルのタスク名編集は .tb-st-title 行内だけを置換（プロジェクト/グループ段と padding を保つ＝入力欄が左に飛ばない）
  const host = (col === "title" && cell.classList.contains("tb-stair")) ? (cell.querySelector(".tb-st-title") || cell) : cell;
  const prev = host.innerHTML;
  const cur = gValToText(col, t);
  const input = document.createElement("input");
  input.className = "tb-gedit";
  input.value = initial != null ? initial : cur;
  if (col === "est") { input.inputMode = "decimal"; input.placeholder = "時間"; }
  if (col === "due") input.placeholder = "例: 明日 / 6/20";
  cell.classList.add("tb-gc-editing");
  host.replaceChildren(input);
  input.focus();
  if (initial == null) input.select();
  let done = false;
  const finish = async (commit, move) => {
    if (done) return; done = true; gEditing = false;
    const after = commit ? gParseText(col, input.value) : null;
    const before = gReadVal(col, t);
    if (move) { const order = orderedIds(gCtx.root); const COLS = gCols(gCtx.root); let r = order.indexOf(id), c = COLS.indexOf(col); if (c < 0) c = 0;
      if (move === "down") r = Math.min(order.length - 1, r + 1); else if (move === "right") c = Math.min(COLS.length - 1, c + 1); else if (move === "left") c = Math.max(0, c - 1);
      gAnchor = null; gActive = { id: order[r] ?? id, col: COLS[c] }; }
  if (commit && after !== null && !gEqual(after, before)) { await gridApply(GLABEL[col], [{ id, col, before, after }]); return; } // 再描画＋ハイライト済
    cell.classList.remove("tb-gc-editing"); host.innerHTML = prev; gridHighlight();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true, "down"); }
    else if (e.key === "Tab") { e.preventDefault(); finish(true, e.shiftKey ? "left" : "right"); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false, null); }
  };
  input.onblur = () => finish(true, null);
}

// 矩形選択の範囲（[{id,col}...] の2次元）を返す。
function gridRange(root) {
  const order = orderedIds(root);
  const COLS = gCols(root);
  const anc = gAnchor || gActive;
  const r0 = order.indexOf(gActive.id), r1 = order.indexOf(anc.id);
  const c0 = COLS.indexOf(gActive.col), c1 = COLS.indexOf(anc.col);
  const rows = [];
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    const cells = [];
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) cells.push({ id: order[r], col: COLS[c] });
    rows.push(cells);
  }
  return rows;
}
function gridCopy(root) {
  if (!gActive) return;
  const range = gridRange(root);
  gClip = { cols: range[0].map((c) => c.col), rows: range.map((row) => row.map((c) => gValToText(c.col, findGTask(c.id)))) };
  try { navigator.clipboard && navigator.clipboard.writeText(gClip.rows.map((r) => r.join("\t")).join("\n")); } catch { /* noop */ }
  flashGrid(root, range);
}
async function gridPaste(root) {
  if (!gActive || !gClip) return;
  const order = orderedIds(root);
  const COLS = gCols(root);
  const baseR = order.indexOf(gActive.id), baseC = COLS.indexOf(gActive.col);
  if (baseC < 0) return;
  // 選択範囲があればその大きさまでタイル、無ければクリップそのままのサイズ。
  const sel = gridRange(root);
  const spanR = Math.max(sel.length, gClip.rows.length);
  const spanC = Math.max(sel[0].length, gClip.cols.length);
  const edits = [];
  for (let i = 0; i < spanR; i++) for (let j = 0; j < spanC; j++) {
    const rr = baseR + i, cc = baseC + j;
    if (rr >= order.length || cc >= COLS.length) continue;
    const col = COLS[cc];
    const text = gClip.rows[i % gClip.rows.length][j % gClip.cols.length];
    const after = gParseText(col, text);
    if (after === null) continue;
    const t = findGTask(order[rr]); if (!t) continue;
    edits.push({ id: order[rr], col, before: gReadVal(col, t), after });
  }
  await gridApply("貼り付け", edits);
}
async function gridFillDown(root) {
  if (!gActive) return;
  const range = gridRange(root);
  if (range.length < 2) return; // 1行だけなら何もしない（範囲を下に広げてから）
  const edits = [];
  const top = range[0];
  for (let ci = 0; ci < top.length; ci++) {
    const col = top[ci].col;
    const srcT = findGTask(top[ci].id); if (!srcT) continue;
    const val = gReadVal(col, srcT);
    for (let ri = 1; ri < range.length; ri++) {
      const cell = range[ri][ci]; const t = findGTask(cell.id); if (!t) continue;
      edits.push({ id: cell.id, col, before: gReadVal(col, t), after: val });
    }
  }
  await gridApply("フィルダウン", edits);
}
function flashGrid(root, range) {
  for (const row of range) for (const c of row) { const el = gCellEl(root, c.id, c.col); if (el) { el.classList.add("tb-gc-flash"); setTimeout(() => el.classList.remove("tb-gc-flash"), 400); } }
}

// クリック/ダブルクリックから呼ぶ入口（tr ハンドラが使用）。
function gridSelectFromEl(cell, root) { const tr = cell.closest("tr[data-id]"); if (!tr) return; gAnchor = null; gActive = { id: +tr.dataset.id, col: cell.dataset.col }; gridHighlight(); }
function gridEditFromEl(cell, root) { gridSelectFromEl(cell, root); gridEditActive(null); }

function wireGrid(root, rows, tasks, members, labels, today) {
  gCtx = { root, tasks, members, labels, today };
  // ※ 列挙セルのボタン mousedown でのアクティブセル同期は render() の tbody capture 委譲（B22）に移管済み。
  gridHighlight();
  if (gKeyWired) return;
  gKeyWired = true;
  document.addEventListener("keydown", (e) => {
    if (!location.hash.startsWith("#/list")) return;
    if (gEditing) return;                          // インライン入力中はそちらが処理
    if (!gActive) return;                          // セル未選択時はグリッド不作動
    if (document.querySelector(".tb-ctx")) return; // ポップアップ表示中は触らない
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return; // 検索欄等の入力中は無視
    const root = gCtx && gCtx.root; if (!root || !root.isConnected) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); gridCopy(root); return; }
    if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); gridPaste(root); return; }
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); gridFillDown(root); return; }
    if (mod) return; // Ctrl+Z/Y 等は history のグローバルハンドラに委ねる
    switch (e.key) {
      case "ArrowUp": e.preventDefault(); gridMove("up", e.shiftKey); return;
      case "ArrowDown": e.preventDefault(); gridMove("down", e.shiftKey); return;
      case "ArrowLeft": e.preventDefault(); gridMove("left", e.shiftKey); return;
      case "ArrowRight": e.preventDefault(); gridMove("right", e.shiftKey); return;
      case "Tab": e.preventDefault(); gridMove(e.shiftKey ? "left" : "right", false); return;
      case "Enter": e.preventDefault(); gridMove(e.shiftKey ? "up" : "down", false); return;
      case "F2": e.preventDefault(); gridEditActive(null); return;
      case "Escape": e.preventDefault(); if (gAnchor) { gAnchor = null; gridHighlight(); } else { gActive = null; gridHighlight(); } return;
      case "Delete": case "Backspace": {
        // テキスト/見積/期限/担当/分類はクリア（重要度=なし, ステータスは対象外）。
        e.preventDefault();
        const t = findGTask(gActive.id); if (!t) return;
        const col = gActive.col; if (col === "state") return;
        const empty = col === "who" || col === "cat" ? [] : col === "prio" ? 0 : col === "est" ? 0 : "";
        gridApply(GLABEL[col], [{ id: gActive.id, col, before: gReadVal(col, t), after: empty }]);
        return;
      }
      default:
        // 印字可能な1文字＝その文字で編集開始（テキスト列のみ。列挙はポップアップを開く）。
        if (e.key.length === 1 && !e.altKey) {
          e.preventDefault();
          if (GTEXT.has(gActive.col)) gridEditActive(e.key);
          else gridEditActive(null);
        }
    }
  });
}

// ── 複数選択（チェックボックス＋全選択＋Shift範囲）。既存 selectedIds/anchorId を活用。 ──
// B22: per-element 結線をやめ、ロジック（toggle/range/all）だけを返すファクトリにした。
// render() 側の tbody.onclick / thead.onclick 委譲がこのハンドラを行チェック・全選択ヘッダで呼ぶ。
// 挙動は不変（旧 .tb-rowck[data-ck].onclick / #tb-selall.onclick と同一）。
function selectionHandlers(rows, rerender) {
  const ids = rows.map((r) => r.t.id);
  const toggle = (id) => { selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id); anchorId = id; };
  const range = (id) => {
    const a = ids.indexOf(anchorId), b = ids.indexOf(id);
    if (a < 0) { selectedIds.add(id); anchorId = id; return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selectedIds.add(ids[i]);
  };
  // 行チェック（.tb-rowck[data-ck]）クリック相当。旧: e.stopPropagation/e.preventDefault は委譲側が行う。
  const onRowCheck = (id, shiftKey) => {
    if (shiftKey && anchorId != null) range(id); else toggle(id);
    rerender();
  };
  // 全選択ヘッダ（#tb-selall）クリック相当。
  const onSelectAll = () => {
    const allSel = ids.length && ids.every((id) => selectedIds.has(id));
    if (allSel) { ids.forEach((id) => selectedIds.delete(id)); anchorId = null; }
    else { ids.forEach((id) => selectedIds.add(id)); anchorId = ids[ids.length - 1] ?? null; }
    rerender();
  };
  return { onRowCheck, onSelectAll };
}

// ── 一括操作バー（選択タスク全件に適用）。各アクションは既存の単体ロジック/APIを流用。 ──
function wireBulk(root, rows, tasks, members, today, labels) {
  const bar = root.querySelector("#tb-bulk");
  if (!bar) return;
  const busy = root.querySelector("#tb-bk-busy");
  const targetIds = () => [...selectedIds];
  const rerender = () => render(root);
  const reload = () => { invalidate(); render(root); };
  // 選択全件に fn を直列適用（失敗は握って続行）→ 完了後リロード。処理中は簡易表示。
  const runAll = async (label, fn, idsOverride) => {
    const ids = idsOverride || targetIds(); if (!ids.length) return;
    let ok = 0, fail = 0;
    bar.querySelectorAll(".tb-bk-a, .tb-bk-clr").forEach((b) => (b.disabled = true));
    if (busy) busy.textContent = `${label}中… 0/${ids.length}`;
    for (const id of ids) {
      try { await fn(id); ok++; } catch { fail++; }
      if (busy) busy.textContent = `${label}中… ${ok + fail}/${ids.length}`;
    }
    if (fail && busy) busy.textContent = `${fail}件失敗（${ok}件成功）`;
    reload();
  };
  const taskOf = (id) => (tasks || []).find((t) => t.id === id);

  const clr = root.querySelector("#tb-bk-clr");
  if (clr) clr.onclick = () => { selectedIds.clear(); anchorId = null; rerender(); };

  // 一括操作も1アクションとして履歴へ。適用前に対象全件のスナップショット（編集対象になり得る
  // スカラ＋連絡待ち＋担当/分類の集合）を取り、undo で全件をその状態へ戻す（redo は同じ fn を再実行）。
  const ZERO = "0001-01-01T00:00:00Z";
  // ↑ snapshot/restoreSnap は ../lib/tasksnapshot.js（snapshotTask/restoreTask）へ集約済み（横断監査 Q4）。
  // runAll のラッパ: 適用前に全件スナップショット→適用→履歴 push（undo=全件復元・redo=fn 再実行）。
  const runAllH = async (label, fn) => {
    const ids = targetIds(); if (!ids.length) return;
    const snaps = ids.map((id) => taskOf(id)).filter(Boolean).map(snapshotTask);
    await runAll(label, fn);
    history.push({
      label: `${label}（${ids.length}件）`,
      undo: async () => {
        let failed = 0;
        for (const s of snaps) { const r = await restoreTask(s, taskOf); if (r && !r.restored) failed++; }
        if (failed) announce(`取り消しで${failed}件が完全には戻りませんでした`, { assertive: true });
        historyRerender();
      },
      redo: async () => { for (const id of ids) await fn(id).catch(() => {}); historyRerender(); },
    });
  };

  const setDue = (id, iso) => updateTask(id, { due_date: iso ? iso + "T00:00:00Z" : ZERO });
  // 各タスクの現在期限を相対シフト（期限なしは今日起点）。
  const slide = (days) => runAllH("期限変更", (id) => {
    const t = taskOf(id);
    const cur = (t && t.due_date && !t.due_date.startsWith("0001")) ? t.due_date.slice(0, 10) : today;
    return setDue(id, shiftISO(cur, days));
  });

  bar.querySelectorAll(".tb-bk-a").forEach((b) => {
    b.onclick = () => {
      const r = b.getBoundingClientRect();
      switch (b.dataset.bk) {
        case "del": {
          const ids = targetIds();
          if (!confirm(`${ids.length}件のタスクを削除しますか？（元に戻せません）`)) return;
          selectedIds.clear(); anchorId = null;
          runAll("削除", (id) => deleteTask(id), ids); // clear 後も対象を保持（clear が先だと targetIds() が空になる既存バグの修正）
          break;
        }
        case "due":
          openMenu(r.left, r.bottom + 4, [
            { label: "−1日", on: () => slide(-1) },
            { label: "+1日", on: () => slide(1) },
            { label: "+1週間", on: () => slide(7) },
            { sep: true },
            { label: "日付指定（全件）", input: "date", value: "", on: (v) => { if (v) runAllH("期限変更", (id) => setDue(id, v)); } },
            { sep: true },
            { label: "クリア（期限なし）", danger: true, on: () => runAllH("期限変更", (id) => setDue(id, null)) },
          ]);
          break;
        case "who": {
          // 追加（既存担当に足す）／置換（既存を外してその人だけ）／全員外す。
          const addOne = (uid) => runAllH("担当変更", (id) => addAssignee(id, uid));
          const replaceOne = (uid) => runAllH("担当変更", async (id) => {
            const t = taskOf(id); const cur = ((t && t.assignees) || []).filter((a) => !isAiUser(a)).map((a) => a.id);
            for (const x of cur) if (x !== uid) await removeAssignee(id, x).catch(() => {});
            if (!cur.includes(uid)) await addAssignee(id, uid).catch(() => {});
          });
          const removeAll = () => runAllH("担当変更", async (id) => {
            const t = taskOf(id); const cur = ((t && t.assignees) || []).filter((a) => !isAiUser(a)).map((a) => a.id);
            for (const x of cur) await removeAssignee(id, x).catch(() => {});
          });
          const ms = (members || []).filter((m) => !isAiUser(m));
          openMenu(r.left, r.bottom + 4, [
            { header: true, label: "追加（足す）" },
            ...ms.map((m) => ({ label: m.name || m.username, on: () => addOne(m.id) })),
            { sep: true },
            { header: true, label: "置換（この人だけに）" },
            ...ms.map((m) => ({ label: m.name || m.username, on: () => replaceOne(m.id) })),
            { sep: true },
            { label: "全員外す（担当なし）", danger: true, on: removeAll },
          ]);
          break;
        }
        case "cat": {
          // 分類（ラベル）一括: 追加／削除。レビュー/連絡待ちは予約語なので候補から除外。
          const cats = (labels || []).filter((l) => (l.title || "") !== REVIEW_LABEL && (l.title || "") !== WAITING_LABEL);
          const addCat = (lid) => runAllH("分類変更", async (id) => {
            const t = taskOf(id); const cur = ((t && t.labels) || []).map((l) => l.id);
            if (!cur.includes(lid)) await addTaskLabel(id, lid);
          });
          const removeCat = (lid) => runAllH("分類変更", async (id) => {
            const t = taskOf(id); const cur = ((t && t.labels) || []).map((l) => l.id);
            if (cur.includes(lid)) await removeTaskLabel(id, lid);
          });
          const items = [{ header: true, label: "追加" }];
          cats.forEach((l) => items.push({ label: l.title, on: () => addCat(l.id) }));
          if (cats.length) {
            items.push({ sep: true }, { header: true, label: "外す" });
            cats.forEach((l) => items.push({ label: l.title, danger: true, on: () => removeCat(l.id) }));
          } else { items.push({ header: true, label: "（分類がありません）" }); }
          openMenu(r.left, r.bottom + 4, items);
          break;
        }
        case "flag":
          openMenu(r.left, r.bottom + 4, [
            { label: "フラグを付ける", on: () => runAllH("フラグ変更", (id) => updateTask(id, { is_favorite: true })) },
            { label: "フラグを外す", danger: true, on: () => runAllH("フラグ変更", (id) => updateTask(id, { is_favorite: false })) },
          ]);
          break;
        case "status":
          openMenu(r.left, r.bottom + 4, [
            { label: "未着手", on: () => runAllH("ステータス変更", (id) => Promise.all([updateTask(id, statePatchFor("todo", taskOf(id))), setTaskWaiting(taskOf(id), false)])) },
            { label: "進行中", on: () => runAllH("ステータス変更", (id) => { const t = taskOf(id); return Promise.all([updateTask(id, statePatchFor("doing", t)), setTaskWaiting(t, false)]); }) },
            { label: "完了", on: () => runAllH("ステータス変更", (id) => Promise.all([updateTask(id, statePatchFor("done", taskOf(id))), setTaskWaiting(taskOf(id), false)])) },
          ]);
          break;
        case "prio":
          openMenu(r.left, r.bottom + 4, [[0, "なし"], [1, "低"], [2, "中"], [3, "高"], [4, "MUST"]].map(([v, label]) => ({
            label, on: () => runAllH("重要度変更", (id) => updateTask(id, { priority: v })),
          })));
          break;
      }
    };
  });
}

// プリセット名の候補（軸ラベルを連結）
function presetSuggest(sorts) {
  return (sorts || []).map((s) => (AXES[s.key] ? AXES[s.key].label : s.key) + (s.dir > 0 ? "↑" : "↓")).join("・") || "マイプリセット";
}

// TickTick風ドラッグ並べ替え＋まとめて移動。
// Ctrl/⌘・Shift＋クリックで複数選択 → 1つを掴むと選択行をまとめてドラッグ。
// 掴んだ行群はゴーストで浮き、元の場所は影のギャップになり落下位置へ移動。動かさず離せばタップ＝編集。
function wireDrag(root, rerender) {
  const tbody = root.querySelector("tbody");
  const rowsArr = () => [...tbody.querySelectorAll("tr[data-id]")];
  const orderedSelected = () => rowsArr().filter((tr) => selectedIds.has(+tr.dataset.id)); // DOM順の選択行
  const toggleSel = (id) => { selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id); anchorId = id; rerender(); };
  const rangeSel = (id) => {
    const ids = rowsArr().map((tr) => +tr.dataset.id);
    const a = ids.indexOf(anchorId), b = ids.indexOf(id);
    if (a < 0) { selectedIds.add(id); anchorId = id; rerender(); return; }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selectedIds.add(ids[i]);
    rerender();
  };

  rowsArr().forEach((dragRow) => {
    dragRow.addEventListener("pointerdown", (e) => {
      if (e.button && e.button !== 0) return;
      if (e.target.closest("button, a, input, select, .tb-rowck, .tb-pctbar")) return; // ▶やリンク・チェック・進捗バー等は各自のクリックに任せる
      const dragId = +dragRow.dataset.id;
      // 修飾キー＝選択操作（ドラッグしない）
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSel(dragId); return; }
      if (e.shiftKey) { e.preventDefault(); rangeSel(dragId); return; }

      const startX = e.clientX, startY = e.clientY;
      // 掴んだ行が選択集合に含まれ複数あるなら、その全部をまとめて移動
      const groupSet = (selectedIds.has(dragId) && selectedIds.size > 1) ? new Set(selectedIds) : new Set([dragId]);
      let moved = false, ghost = null, grabY = 0, groupOffset = 0;

      const begin = () => {
        const groupRows = groupSet.size > 1 ? orderedSelected() : [dragRow];
        const rect = dragRow.getBoundingClientRect();
        const rowH = rect.height;
        grabY = startY - rect.top;
        groupOffset = Math.max(0, groupRows.indexOf(dragRow)) * rowH; // 掴んだ行がスタック内の何番目か
        const widths = [...dragRow.children].map((td) => td.getBoundingClientRect().width);
        ghost = document.createElement("div");
        ghost.className = "tb-ghost";
        ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:9999;pointer-events:none`;
        const badge = groupRows.length > 1 ? `<span class="tb-ghost-badge">${groupRows.length}</span>` : "";
        ghost.innerHTML = `<table class="tb tb-ghost-tbl"><tbody></tbody></table>${badge}`;
        const gtb = ghost.querySelector("tbody");
        // 選択行を全部重ねて表示＝「複数掴んでる」のが分かる（多すぎる時は12行まで）
        groupRows.slice(0, 12).forEach((r) => {
          const c = r.cloneNode(true);
          c.classList.remove("tb-ph", "tb-sel");
          [...c.children].forEach((td, i) => { td.style.width = widths[i] + "px"; });
          gtb.appendChild(c);
        });
        document.body.appendChild(ghost);
        groupRows.forEach((r) => r.classList.add("tb-ph")); // 選択行＝影ギャップ
        document.body.classList.add("tb-dragging-body");
      };
      // 掴んでる塊（選択行群 or 単行）と、その前後の非選択行を取るヘルパ
      const inGroup = (tr) => groupSet.has(+tr.dataset.id);
      const groupRowsNow = () => { const g = rowsArr().filter(inGroup); return g.length ? g : [dragRow]; };
      const prevNon = (row) => { let p = row.previousElementSibling; while (p && (!p.dataset.id || inGroup(p))) p = p.previousElementSibling; return p; };
      const nextNon = (row) => { let n = row.nextElementSibling; while (n && (!n.dataset.id || inGroup(n))) n = n.nextElementSibling; return n; };
      const placeBefore = (node) => { for (const tr of groupRowsNow()) tbody.insertBefore(tr, node); };
      const move = (ev) => {
        if (!moved) {
          if (Math.abs(ev.clientY - startY) <= 4 && Math.abs(ev.clientX - startX) <= 4) return;
          moved = true; begin();
        }
        ghost.style.top = (ev.clientY - grabY - groupOffset) + "px"; // 掴んだ行がカーソル下に来るよう調整
        const gr = ghost.getBoundingClientRect();
        // 入れ替え判定＝塊の“外側の端”が隣カードの中心を越えたら（上端=上方向 / 下端=下方向）。
        let guard = 0;
        while (guard++ < 60) { // 上方向: 先頭の上端が、すぐ上の行の中心より上に出たら入れ替え
          const prev = prevNon(groupRowsNow()[0]);
          if (!prev) break;
          const pr = prev.getBoundingClientRect();
          if (gr.top < pr.top + pr.height / 2) placeBefore(prev); else break;
        }
        guard = 0;
        while (guard++ < 60) { // 下方向: 末尾の下端が、すぐ下の行の中心より下に出たら入れ替え
          const g = groupRowsNow();
          const next = nextNon(g[g.length - 1]);
          if (!next) break;
          const nr = next.getBoundingClientRect();
          if (gr.bottom > nr.top + nr.height / 2) placeBefore(next.nextElementSibling); else break;
        }
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (ghost) ghost.remove();
        rowsArr().forEach((tr) => tr.classList.remove("tb-ph"));
        document.body.classList.remove("tb-dragging-body");
        if (!moved) { selectedIds.clear(); anchorId = null; openTaskForm({ taskId: dragId, onSaved: rerender }); return; } // タップ＝編集
        const vis = rowsArr().map((x) => +x.dataset.id);   // 現DOM順＝確定順
        const visSet = new Set(vis); let vi = 0; const next = [];
        for (const id of V.order) next.push(visSet.has(id) ? vis[vi++] : id);
        while (vi < vis.length) next.push(vis[vi++]);
        V.order = [...new Set(next)];
        saveView(UID, V);
        flashId = dragId; // 着地した先頭行をハイライト
        rerender();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  });
}

// 階層モードのドラッグ＆ドロップ＝タスクを別の親（プロジェクト＝親タスク）の配下へ付け替える。
// HTML5 DnD（draggable/dragstart/dragover/drop）。表モードの pointer ベースのマイソート移動とは別系統で混線しない。
// 付け替え: 旧親から subtask を外し（removeRelation(oldParent,"subtask",child)）、新親に subtask を追加（addRelation(newParent,child,"subtask")）。
// 向きは taskform.js:552-553 / openInlineSubtask と一致＝buildTaskTree が読む related_tasks.subtask（親→子）。
function wireOutlineDnD(root, rows, rerender) {
  const card = root.querySelector(".ol-card");
  if (!card) return;
  // 循環防止用の子孫集合: 各ノードID → その配下（自分自身＋全子孫）のIDセット。
  const descend = new Map();
  const collect = (node) => {
    const set = new Set([node.task.id]);
    for (const c of node.children) { collect(c); descend.get(c.task.id).forEach((id) => set.add(id)); }
    descend.set(node.task.id, set);
    return set;
  };
  buildTaskTree(rows.map((r) => r.t)).forEach(collect);

  let dragId = null;       // 掴んでいるタスクID
  let dragParent = null;   // 掴んでいるタスクの現在の親ID（"" or 数値）
  const clearHints = () => card.querySelectorAll(".ol-drop-into, .ol-drop-root").forEach((el) => el.classList.remove("ol-drop-into", "ol-drop-root"));

  card.querySelectorAll(".ol-row").forEach((rowEl) => {
    rowEl.addEventListener("dragstart", (e) => {
      // トグル/チェック/＋の上から掴んだら無効（各自のハンドラに任せる）
      if (e.target.closest(".ol-tw:not(.none), .ol-cb, .ol-addsub")) { e.preventDefault(); return; }
      dragId = +rowEl.dataset.id;
      dragParent = rowEl.dataset.parent || "";
      rowEl.classList.add("ol-dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(dragId)); } catch { /* noop */ } }
    });
    rowEl.addEventListener("dragend", () => { rowEl.classList.remove("ol-dragging"); clearHints(); dragId = null; });

    rowEl.addEventListener("dragover", (e) => {
      if (dragId == null) return;
      const targetId = +rowEl.dataset.id;
      // 自分自身・自分の子孫への移動は禁止（循環防止）。既に同じ親（このターゲット）配下なら無視。
      if (targetId === dragId || (descend.get(dragId) || new Set()).has(targetId)) return;
      if (String(targetId) === String(dragParent)) return; // 既にこの行の子なら無視
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (!rowEl.classList.contains("ol-drop-into")) { clearHints(); rowEl.classList.add("ol-drop-into"); }
    });
    rowEl.addEventListener("dragleave", (e) => { if (!rowEl.contains(e.relatedTarget)) rowEl.classList.remove("ol-drop-into"); });

    rowEl.addEventListener("drop", (e) => {
      if (dragId == null) return;
      const newParent = +rowEl.dataset.id;
      e.preventDefault(); e.stopPropagation();
      clearHints();
      if (newParent === dragId || (descend.get(dragId) || new Set()).has(newParent)) return; // 循環ガード（保険）
      if (String(newParent) === String(dragParent)) return; // 同じ親へは何もしない
      reparent(dragId, dragParent, newParent, rerender);
    });
  });

  // ルート化ドロップ領域（カード余白＝最上位へ）。既存親があるタスクだけ受け付ける。
  card.addEventListener("dragover", (e) => {
    if (dragId == null || !dragParent) return;        // 既にルートなら無視
    if (e.target.closest(".ol-row")) return;          // 行の上は各行が処理
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!card.classList.contains("ol-drop-root")) { clearHints(); card.classList.add("ol-drop-root"); }
  });
  card.addEventListener("dragleave", (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove("ol-drop-root"); });
  card.addEventListener("drop", (e) => {
    if (dragId == null || !dragParent) return;
    if (e.target.closest(".ol-row")) return;          // 行ドロップは各行が処理済み
    e.preventDefault();
    clearHints();
    reparent(dragId, dragParent, null, rerender);     // newParent=null＝ルート化（付与なし）
  });
}

// 付け替えの実体: 旧親(あれば)から外し、新親(あれば)へ subtask 追加。完了後 invalidate→再描画、新親を自動展開。
let _olReparentBusy = false;
async function reparent(childId, oldParentId, newParentId, rerender) {
  if (_olReparentBusy) return;
  _olReparentBusy = true;
  try {
    if (oldParentId) await removeRelation(+oldParentId, "subtask", childId);
    if (newParentId) {
      await addRelation(+newParentId, childId, "subtask"); // 親→子（buildTaskTree が読む向き）
      olCollapsed.delete(+newParentId); saveOlCollapsed(UID); // 新親を開いて移動先を見せる
    }
    invalidate();
  } catch (e) {
    alert("移動に失敗しました: " + (e && e.message ? e.message : ""));
  } finally {
    _olReparentBusy = false;
    rerender();
  }
}

// 列マスタ（既定の表示順）。fixed=非表示/移動不可（タスク名は表の主軸なので固定）。
// stair=「階段」3列（プロジェクト＞タスクグループ＞タスク）。行本文では1つの colspan セルに統合し、
// 各段を Excel の A/B/C 列位置から右へ突き抜けて表示する（列幅が横に伸びない）。並べ替え不可・先頭固定。
// 列の表示/非表示・並べ替えは本人ごと（V.colOrder / V.hiddenCols）に localStorage 永続。共有データは変えない。
const COLDEF = [
  { k: "proj", label: "プロジェクト", stair: true },
  { k: "group", label: "タスクグループ", stair: true },
  { k: "title", label: "タスク", fixed: true, stair: true },
  { k: "who", label: "担当" },
  { k: "cat", label: "分類" }, { k: "prio", label: "重要度" }, { k: "due", label: "期限" },
  { k: "est", label: "見積" }, { k: "pct", label: "進捗" }, { k: "state", label: "ステータス" },
];
const COLDEF_KEYS = COLDEF.map((c) => c.k);
const STAIR_KEYS = ["proj", "group", "title"]; // 階段3列＝常にこの順で先頭固定（並べ替え対象外）
const colByKey = (k) => COLDEF.find((c) => c.k === k);
// V.colOrder（保存済みの並び）を起点に、未知キー除去＋新規列を末尾補完して正規の順序配列を返す。
// 階段3列は保存済み順に関係なく常に先頭へ固定（段の開始位置＝ヘッダー位置の対応を崩さない）。
function orderedColKeys(v) {
  const saved = (v && Array.isArray(v.colOrder) ? v.colOrder : []).filter((k) => COLDEF_KEYS.includes(k) && !STAIR_KEYS.includes(k));
  const rest = COLDEF_KEYS.filter((k) => !saved.includes(k) && !STAIR_KEYS.includes(k));
  return [...STAIR_KEYS, ...saved, ...rest];
}
// 実際に描画する列（順序適用＋非表示除外）。タスク名(fixed)は常に表示。
const cols = (v = V) => {
  const hidden = new Set((v && v.hiddenCols) || []);
  return orderedColKeys(v).filter((k) => { const c = colByKey(k); return c && (c.fixed || !hidden.has(k)); }).map(colByKey);
};
// 0件時の空状態行。フィルタがアクティブなら「条件に一致するタスクがありません」＋解除ボタン、無ければ「タスクがありません」のみ。
const emptyRow = (filtersActive) => `<tr><td colspan="${cols().length + 1}" class="tb-empty">`
  + (filtersActive
    ? `条件に一致するタスクがありません <button id="tb-empty-clr" class="tb-qa tb-qclr" type="button">絞り込みを解除</button>`
    : `タスクがありません`)
  + `</td></tr>`;
// 検索ボックスのフォーカス＋キャレットを再描画後に復元（入力中に集中が外れないように）。
function restoreSearchFocus(root, pos) {
  const el = root.querySelector("#tb-q");
  if (!el) return;
  el.focus();
  try { const p = Math.min(pos ?? el.value.length, el.value.length); el.setSelectionRange(p, p); } catch { /* noop */ }
}
// ヘッダに何番目のソート軸かを小さく表示（組み合わせの見える化）
// aria-sort: 現在のソート軸に連動（昇順=ascending / 降順=descending / それ以外=none）＝スクリーンリーダーで並び状態が伝わる。
const th = (c, manual) => {
  if (!c.k) return `<th scope="col">${c.label}</th>`;
  let badge = "", ariaSort = "none";
  if (!manual) {
    const i = V.sorts.findIndex((s) => s.key === c.k);
    if (i >= 0) { badge = ` <span class="tb-thord">${i + 1}${V.sorts[i].dir > 0 ? "↑" : "↓"}</span>`; ariaSort = V.sorts[i].dir > 0 ? "ascending" : "descending"; }
  }
  return `<th scope="col" data-k="${c.k}" class="sortable" aria-sort="${ariaSort}">${c.label}${badge}</th>`;
};

// ヘッダの全選択チェック（現在の絞り込み結果＝表示中の全行が選択済みかで状態を出し分け）
function selAllHeadHtml(rows) {
  const total = rows.length;
  const sel = rows.filter((r) => selectedIds.has(r.t.id)).length;
  const state = total && sel === total ? "on" : (sel ? "part" : "");
  const ic = state === "on" ? icon("check", { size: 12 }) : (state === "part" ? "–" : "");
  return `<span class="tb-rowck tb-allck ${state}" id="tb-selall" role="checkbox" aria-checked="${state === "on"}" title="全選択（現在の絞り込み結果）">${ic}</span>`;
}

// 一括操作バー（sticky）。選択0件なら出さない。各アクションは下のwireBulkで配線。
function bulkBarHtml(rows) {
  const n = selectedIds.size;
  if (!n) return "";
  const btn = (act, label) => `<button class="tb-bk-a${act === "del" ? " danger" : ""}" data-bk="${act}">${esc(label)}</button>`;
  return `<div class="tb-bulk" id="tb-bulk">
    <span class="tb-bk-n">${n}件選択中</span>
    <span class="tb-bk-acts">
      ${btn("due", "期限")}
      ${btn("who", "担当者")}
      ${btn("cat", "分類")}
      ${btn("status", "ステータス")}
      ${btn("prio", "重要度")}
      ${btn("flag", "フラグ")}
      ${btn("del", "削除")}
    </span>
    <span class="tb-bk-busy" id="tb-bk-busy"></span>
    <button class="tb-bk-clr" id="tb-bk-clr">選択解除</button>
  </div>`;
}

function rowHtml(r, members, i, manual) {
  const id = r.t.id;
  const wn = r.who ? (r.who.name || r.who.username) : "";
  // 担当: 丸チップ廃止＝名前テキスト（メンバー色）を4文字程度は横に見えるよう表示（要望）。
  const whoBtn = `<button class="tb-cell tb-asbtn" data-as="${id}" title="クリックで担当を変更">${r.who ? `<span class="tb-who-nm" style="color:${member_color(r.who.id)}">${esc(wn)}</span>` : "未設定"}<span class="tb-cell-car">▾</span></button>`;
  const cats = categoryLabels(r.t);
  const catInner = cats.length ? cats.map((c) => `<span class="tb-cat" style="color:${categoryColor(c)};border-color:${categoryColor(c)}40">${esc(c.title)}</span>`).join(" ") : `<span class="tb-cat none">—</span>`;
  const catBtn = `<button class="tb-cell tb-catbtn" data-cat="${id}" title="クリックで分類を変更">${catInner}<span class="tb-cell-car">▾</span></button>`;
  const pr = r.t.priority || 0;
  const prioInner = pr >= 1 ? `<span class="tb-prio"><i style="background:${PRIO[prioBucket(pr)].c}"></i>${PRIO[prioBucket(pr)].n}</span>` : `<span class="tb-prio-none">なし</span>`;
  const prioBtn = `<button class="tb-cell tb-priobtn" data-prio="${id}" title="クリックで重要度を変更">${prioInner}<span class="tb-cell-car">▾</span></button>`;
  const dueCls = r.due && r.due < todayISO() && !r.done ? "over" : "";
  const dueBtn = `<button class="tb-cell tb-duebtn ${dueCls}" data-due="${id}" title="クリックで期限を変更">${r.due ? r.due.slice(5).replace("-", "/") : "—"}<span class="tb-cell-car">▾</span></button>`;
  const estBtn = `<button class="tb-cell tb-num tb-estbtn" data-est="${id}" title="クリックで見積を変更">${r.est ? fmtH(r.est) : "—"}<span class="tb-cell-car">▾</span></button>`;
  const st = `<button class="tb-st tb-stbtn ${r.status}" data-st="${id}" title="クリックでステータス変更">${STATUS[r.status].label}<span class="tb-st-car">▾</span></button>`;
  const sel = selectedIds.has(id);
  // ── 階段セル: プロジェクト（上段）＞タスクグループ（中段）＞タスク名（下段）を1つの colspan セルに。
  // 各段は表示中の階段列の位置（ヘッダー th と同じ STAIR_W 刻み）から始まり、右へ突き抜けて表示＝列幅が伸びない。
  // 毎行にプロジェクト/グループを繰り返し表示（各行が自己完結＝どの列でソートしても成立）。
  const stairCols = cols().filter((c) => c.stair);            // 表示中の階段列（1〜3個）
  const STAIR_W = 110;                                         // th幅と一致させる定数（css() の width:110px と同値）
  const sIdx = (k) => stairCols.findIndex((c) => c.k === k);
  const stLines = [];
  if (sIdx("proj") >= 0) stLines.push(`<div class="tb-st-line tb-st-proj" style="padding-left:${sIdx("proj") * STAIR_W}px"><button class="tb-cell tb-projbtn" data-proj="${id}" title="クリックでプロジェクト（親タスク）を変更">${r.parent ? esc(r.parent.title) : "—"}<span class="tb-cell-car">▾</span></button></div>`);
  // グループ段: プロジェクトがある行は常に表示（未所属は「—」）。クリックでグループ変更メニュー。
  // プロジェクトなしのタスクはグループを持てないので段自体を出さない（従来どおり）。
  if (sIdx("group") >= 0 && r.parent) stLines.push(`<div class="tb-st-line tb-st-group" style="padding-left:${sIdx("group") * STAIR_W}px"><button class="tb-cell tb-grpbtn" data-grp="${id}" title="クリックでタスクグループを変更">${r.group ? esc(r.group.title) : "—"}<span class="tb-cell-car">▾</span></button></div>`);
  stLines.push(`<div class="tb-st-line tb-st-title" style="padding-left:${sIdx("title") * STAIR_W}px"><span class="tb-tle">${esc(r.title)}</span>${r.review ? ` <span class="tb-k review">レビュー</span>` : ""}${r.t.is_favorite ? ` <span class="tb-fav" title="フラグ">${icon("flag", { size: 12 })}</span>` : ""} <button type="button" class="tb-timer" data-timer="${id}" data-title="${esc(r.title)}" title="このタスクでタイマー開始" aria-label="このタスクでタイマー開始">${icon("timer", { size: 13 })}</button>${r.fable ? ` <button type="button" class="tb-fable" data-fable="${id}" data-title="${esc(r.title)}" title="Fableに実行させる">${icon("play", { size: 11 })}</button>` : ""}</div>`);
  const stairTd = `<td class="tb-stair tb-gc" data-col="title" colspan="${stairCols.length}">${stLines.join("")}</td>`;
  // 列ごとの <td> をマップで持ち、cols() の順序（表示/非表示・並べ替え反映）で出力する（階段3列は stairTd に統合済み）。
  const cellOf = {
    who: `<td class="tb-gc" data-col="who">${whoBtn}</td>`,
    cat: `<td class="tb-gc" data-col="cat">${catBtn}</td>`,
    prio: `<td class="tb-gc" data-col="prio">${prioBtn}</td>`,
    due: `<td class="tb-gc" data-col="due">${dueBtn}</td>`,
    est: `<td class="tb-gc" data-col="est">${estBtn}</td>`,
    pct: `<td><div class="tb-bar tb-pctbar" data-pct="${id}" role="slider" tabindex="0" aria-valuenow="${r.pct}" aria-valuemin="0" aria-valuemax="100" title="クリックで進捗を変更（0/25/50/75/100）"><i style="width:${r.pct}%"></i></div><span class="tb-pct">${r.pct}%</span></td>`,
    state: `<td class="tb-gc" data-col="state">${st}</td>`,
  };
  const body = stairTd + cols().filter((c) => !c.stair).map((c) => cellOf[c.k] || "").join("");
  return `<tr data-id="${id}" class="${manual ? "tb-draggable" : ""}${sel ? " tb-sel" : ""}">
    <td class="tb-selcol"><span class="tb-rowck${sel ? " on" : ""}" data-ck="${id}" role="checkbox" aria-checked="${sel}" title="選択">${sel ? icon("check", { size: 12 }) : ""}</span></td>
    ${body}
  </tr>`;
}

// ── アウトライン（階層）表示。outline.js から移植。フィルタ後のタスク集合からツリーを作る。 ──
// 親が除外され子が残る場合、buildTaskTree は「どの subtask にもならないタスク」をルートにするので、
// フィルタ後集合だけ渡せば残った子は自動的にルート扱いになり表示落ちしない。
const olDueLabel = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(5, 10).replace("-", "/") : "");
// アウトライン行のインデント: 基準 padding と深さ1段あたりの増分（px）。
const OL_INDENT_BASE = 12, OL_INDENT_STEP = 22;
function buildOutlineHtml(tasks) {
  const forest = buildTaskTree(tasks);
  const counts = olCountChildren(forest);
  const out = [];
  const walk = (node, depth) => {
    out.push(olRowHtml(node, depth, counts));
    if (!olCollapsed.has(node.task.id)) for (const c of node.children) walk(c, depth + 1);
  };
  forest.forEach((n) => walk(n, 0));
  return out.join("");
}
function olCountChildren(forest) {
  const m = new Map();
  const visit = (n) => { let done = 0; for (const c of n.children) { if (c.task.done) done++; visit(c); } m.set(n.task.id, { done, total: n.children.length }); };
  forest.forEach(visit);
  return m;
}
function olRowHtml(node, depth, counts) {
  const t = node.task;
  const has = node.children.length > 0;
  // 3層運用の見分け: 子を持つ親だけにバッジ。depth0の親=プロジェクト / 中間の親=タスクグループ / 葉=バッジ無し。
  const olKind = has ? (depth === 0 ? "proj" : "group") : "";
  const kindBadge = olKind === "proj" ? `<span class="ol-kind ol-kind-proj">プロジェクト</span>`
    : olKind === "group" ? `<span class="ol-kind ol-kind-group">タスクグループ</span>` : "";
  const open = !olCollapsed.has(t.id);
  const st = statusOf(t);
  const who = (t.assignees || [])[0];
  const wn = who ? (who.name || who.username) : "";
  const cc = counts.get(t.id);
  const childInfo = has ? `<span class="ol-cc">${cc.done}/${cc.total}</span>` : "";
  const tw = has ? `<span class="ol-tw" data-id="${t.id}">${open ? "▾" : "▸"}</span>` : `<span class="ol-tw none"></span>`;
  const due = olDueLabel(t);
  // 親付け替え用: 現在の親(プロジェクト=親タスク)のID。related_tasks.parenttask の先頭。ルートなら空。
  const parentId = ((((t.related_tasks || {}).parenttask) || [])[0] || {}).id || "";
  return `<div class="ol-row" data-id="${t.id}" data-parent="${parentId}" draggable="true" style="padding-left:${OL_INDENT_BASE + depth * OL_INDENT_STEP}px">
    ${tw}
    <span class="ol-cb ${st}" data-id="${t.id}" data-done="${t.done ? 1 : 0}" title="クリックで完了を切替"></span>
    <span class="ol-name ${t.done ? "done" : ""}">${esc(t.title)}</span>
    ${kindBadge}
    ${childInfo}
    <span class="ol-meta">
      <button type="button" class="ol-addsub" data-pid="${t.id}" data-proj="${t.project_id || 0}" data-depth="${depth}" title="子タスクを追加">＋</button>
      ${who ? `<span class="ol-who" style="color:${member_color(who.id)}">${esc(wn)}</span>` : ""}
      ${due ? `<span class="ol-due">${due}</span>` : ""}
      <span class="ol-st ${st}">${STATUS[st].label}</span>
    </span>
  </div>`;
}

// 階層: ＋ボタン直下にインライン入力を開き、確定で親タスクのサブタスクを新規作成。
// 親と同じ project_id に作り、addRelation(parentId, childId, "subtask") で関連付け（buildTaskTree と整合）。
let _olInlineEl = null;
// 外側クリック解除リスナ（document capture）は同時に1つだけ。閉じる時にここで必ず外す＝孤児化防止。
let _olOnDown = null;
function closeInlineSubtask() {
  if (_olOnDown) { document.removeEventListener("pointerdown", _olOnDown, true); _olOnDown = null; }
  if (_olInlineEl) { _olInlineEl.remove(); _olInlineEl = null; }
}
// depth0(プロジェクト)の＋は「タスクグループ／タスク」の2択メニューを出す。選ぶと openInlineSubtask へ。
function openAddKindMenu(btn, parentId, projId, root) {
  closeInlineSubtask();
  closeRowMenu();
  const box = document.createElement("div");
  box.className = "tb-ctx ol-kindmenu";
  box.innerHTML = `<button type="button" class="ol-kindbtn" data-kind="group">＋ タスクグループ</button>`
    + `<button type="button" class="ol-kindbtn" data-kind="task">＋ タスク</button>`;
  document.body.appendChild(box);
  _olInlineEl = box; // closeInlineSubtask が片付けられるよう同じホルダを使う
  const r = btn.getBoundingClientRect();
  const bw = box.offsetWidth;
  box.style.left = Math.max(6, Math.min(r.left, window.innerWidth - bw - 8)) + "px";
  box.style.top = Math.min(r.bottom + 4, window.innerHeight - box.offsetHeight - 8) + "px";
  box.querySelectorAll(".ol-kindbtn").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openInlineSubtask(btn, parentId, projId, root, b.dataset.kind); };
  });
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  setTimeout(() => {
    _olOnDown = (ev) => { if (!box.contains(ev.target)) closeInlineSubtask(); };
    document.addEventListener("pointerdown", _olOnDown, true);
  }, 0);
}
function openInlineSubtask(btn, parentId, projId, root, kind = "task") {
  closeInlineSubtask();
  closeRowMenu();
  const box = document.createElement("div");
  box.className = "tb-ctx ol-addbox";
  // kind は placeholder の文言だけに影響。作成挙動(createTaskInProject＋addRelation)はグループ/タスクとも同一
  // ＝「タスクグループ＝子を持つ親タスク」の創発モデル（子が付くとバッジが付く）。type/kind フィールドは持たせない。
  const ph = kind === "group" ? "タスクグループ名を入力（Enterで追加・あとで中にタスクを足す）" : "タスク名を入力（Enterで追加）";
  box.innerHTML = `<textarea class="ol-addinp" rows="2" placeholder="${ph}"></textarea>
    <div class="ol-addbtns"><button class="ol-addok">追加</button><button class="ol-addng">キャンセル</button><span class="ol-adderr"></span></div>`;
  document.body.appendChild(box);
  _olInlineEl = box;
  const r = btn.getBoundingClientRect();
  const bw = box.offsetWidth;
  box.style.left = Math.max(6, Math.min(r.left, window.innerWidth - bw - 8)) + "px";
  box.style.top = Math.min(r.bottom + 4, window.innerHeight - box.offsetHeight - 8) + "px";
  const ta = box.querySelector(".ol-addinp");
  const err = box.querySelector(".ol-adderr");
  ta.focus();
  let submitting = false; // 高速ダブルEnter等での submit() 再入を防ぐ（子タスク重複作成バグ対策）
  const submit = async () => {
    if (submitting) return; submitting = true; // 再入ガード（成功時は closeInlineSubtask で DOM 消滅）
    const title = ta.value.trim();
    if (!title) { submitting = false; closeInlineSubtask(); return; }
    const ok = box.querySelector(".ol-addok");
    ok.disabled = true; err.textContent = "";
    try {
      const child = await createTaskInProject(projId || 0, { title });
      await addRelation(parentId, child.id, "subtask"); // 親→子（subtask）= buildTaskTree が読む向き
      olCollapsed.delete(parentId); saveOlCollapsed(UID); // 追加後は親を開いて子を見せる
      closeInlineSubtask(); invalidate(); render(root);
    } catch (e) { submitting = false; ok.disabled = false; err.textContent = "追加に失敗しました"; }
  };
  box.querySelector(".ol-addok").onclick = (e) => { e.stopPropagation(); submit(); };
  box.querySelector(".ol-addng").onclick = (e) => { e.stopPropagation(); closeInlineSubtask(); };
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); closeInlineSubtask(); }
  };
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  setTimeout(() => {
    _olOnDown = (ev) => { if (!box.contains(ev.target)) closeInlineSubtask(); };
    document.addEventListener("pointerdown", _olOnDown, true);
  }, 0);
}

// ── 最上部の定期帯（定例業務・定期MTG）。recurrences を軽く要約して表示。折りたたみ可。0件なら出さない。 ──
const RECKEY = (uid) => `ts.list.reccol.${uid ?? "anon"}`;
function loadRecCollapsed(uid) { try { return localStorage.getItem(RECKEY(uid)) === "1"; } catch { return false; } }
function setRecCollapsed(uid, v) { try { localStorage.setItem(RECKEY(uid), v ? "1" : "0"); } catch { /* noop */ } }
function recurrenceBandHtml(recurrences, members) {
  const list = recurrences || [];
  if (!list.length) return "";
  const collapsed = loadRecCollapsed(UID);
  const nameOf = (id) => { const m = (members || []).find((x) => x.id === id); return m ? (m.name || m.username) : `user${id}`; };
  const rows = list.map((rec) => {
    const s = summarizeRecurrence(rec);
    const ic = rec.kind === "task" ? icon("repeat", { size: 13 }) : icon("calendar", { size: 13 });
    const names = (rec.assignee_ids || []).map(nameOf);
    const who = rec.rotation ? `持ち回り: ${names.join(" → ") || "—"}` : (names.join("・") || "—");
    const meta = [s.rep, s.time, s.durTxt].filter(Boolean).join(" ・ ");
    return `<div class="tb-rec-row" data-rid="${rec.id}" title="クリックで編集">
      <span class="tb-rec-ic">${ic}</span>
      <span class="tb-rec-t">${esc(rec.title)}</span>
      <span class="tb-rec-m">${esc(meta)}</span>
      <span class="tb-rec-w">${esc(who)}</span>
    </div>`;
  }).join("");
  return `<div class="tb-rec">
    <button type="button" id="tb-rec-head" class="tb-rec-head">${icon("repeat", { size: 12 })} 定例業務・定期MTG <span class="tb-rec-cnt">${list.length}件</span><span class="tb-rec-car">${collapsed ? "▸" : "▾"}</span></button>
    ${collapsed ? "" : `<div class="tb-rec-list">${rows}</div>`}
  </div>`;
}

function css() {
  return `
  /* タイトル行＝左に見出し・右に検索ボックス */
  .tb-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 14px}
  .tb-head .vtitle{margin:0;flex:1 1 auto;min-width:200px}
  .tb-search{position:relative;display:inline-flex;align-items:center;margin-left:auto;flex:0 1 320px;min-width:200px}
  .tb-search-ic{position:absolute;left:11px;color:${C.muted};pointer-events:none}
  .tb-search-in{font:inherit;font-size:13px;width:100%;padding:7px 30px 7px 32px;border:1px solid ${C.line};border-radius:9px;background:#fff;color:${C.ink}}
  .tb-search-in:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.14)}
  .tb-search-in::placeholder{color:${C.muted}}
  .tb-search-x{position:absolute;right:7px;font:inherit;font-size:15px;line-height:1;color:${C.muted};background:transparent;border:0;padding:2px 5px;border-radius:6px;cursor:pointer}
  .tb-search-x:hover{color:${C.ink};background:${C.track}}
  /* スマートリスト風プリセットタブ（最上位の絞込レイヤー）。views/smartlist.js の .sl-tabs と同趣旨 */
  .tb-ptabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border-bottom:1px solid ${C.line};padding:0 0 2px;margin:0 0 14px;overflow-x:auto}
  .tb-ptab{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;font:inherit;font-size:12.5px;color:${C.muted};padding:7px 11px;border-radius:9px 9px 0 0;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-3px}
  .tb-ptab:hover{background:${C.track};color:${C.ink}}
  .tb-ptab.on{color:${C.fill};font-weight:700;border-bottom-color:${C.fill}}
  .tb-ptic{flex:none;display:inline-flex}
  .tb-ptlbl{flex:none}
  .tb-ptcnt{font-size:10.5px;font-variant-numeric:tabular-nums;background:${C.track};border-radius:9px;padding:0 6px;color:${C.muted};font-weight:600}
  .tb-ptab.on .tb-ptcnt{background:${C.fill};color:#fff}
  .tb-pdesc{font-size:12px;color:${C.muted};margin:-8px 2px 12px;line-height:1.4}
  @media(max-width:720px){.tb-ptabs{flex-wrap:nowrap}}
  /* ツールバー＝関連コントロールを見出し付きグループにまとめ、区切りで整頓 */
  .tb-tools{display:flex;gap:10px;align-items:center;margin:0 0 14px;flex-wrap:wrap}
  .tb-grp{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:12px;border-right:1px solid ${C.line}}
  .tb-grp:last-child{border-right:0;padding-right:0}
  .tb-grp.dim .tb-glbl{opacity:.55}
  .tb-glbl{font-size:10.5px;font-weight:700;letter-spacing:.04em;color:${C.muted};text-transform:none;white-space:nowrap}
  .tb-tools select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff}
  .tb-add{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;padding:6px 13px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};cursor:pointer}
  .tb-add::before{content:"+";font-size:15px;color:${C.fill};line-height:1}
  .tb-add:hover{background:${C.track};border-color:#d7dde6}
  .tb-undogrp{display:inline-flex;gap:2px}
  .tb-undobtn{display:inline-grid;place-items:center;width:32px;height:32px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.muted};cursor:pointer}
  .tb-undobtn:hover:not(:disabled){background:${C.track};border-color:#d7dde6;color:${C.ink}}
  .tb-undobtn:disabled{opacity:.4;cursor:default}
  .tb-manbtn{font:inherit;font-size:12.5px;font-weight:600;padding:6px 12px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.muted};cursor:pointer}
  .tb-manbtn:hover,.tb-manbtn:hover{border-color:#d7dde6;color:${C.ink}}
  .tb-manbtn.on{border-color:${C.fill};background:#eaf2ff;color:${C.fill}}
  .tb-sortwrap{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${C.muted}}
  .tb-sortwrap.dim{opacity:.45}
  .tb-chips{display:inline-flex;gap:5px;flex-wrap:wrap}
  .tb-sc{display:inline-flex;align-items:center;border:1px solid #cfe0ff;background:#f3f8ff;border-radius:7px;overflow:hidden}
  .tb-sc-n{font-size:9.5px;font-weight:700;color:#fff;background:${C.fill};padding:4px 5px;align-self:stretch;display:flex;align-items:center}
  .tb-sc-k{font:inherit;font-size:11.5px;font-weight:700;color:${C.fill};background:transparent;border:0;padding:4px 8px;cursor:pointer;white-space:nowrap}
  .tb-sc-k:hover{background:#e4eeff}
  .tb-sc-x{font:inherit;font-size:12px;color:${C.muted};background:transparent;border:0;border-left:1px solid #cfe0ff;padding:4px 7px;cursor:pointer}
  .tb-sc-x:hover{color:${C.over};background:#fdecec}
  .tb-sc-none{font-size:11.5px;color:${C.muted}}
  .tb-addsort{font-size:12px!important;padding:5px 8px!important;color:${C.muted}}
  .tb-chk{font-size:13px;color:${C.muted};display:flex;align-items:center;gap:6px}
  .tb-mynote{font-size:11.5px;color:${C.muted};margin:-6px 0 12px;background:#f3f8ff;border:1px solid #dce9ff;border-radius:8px;padding:7px 11px}
  .tb-presets{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:-6px 0 12px}
  .tb-pl{font-size:11.5px;color:${C.muted};font-weight:600;display:inline-flex;align-items:center;gap:3px}
  .tb-pl-g{font-size:10px}
  .tb-pz{display:inline-flex;align-items:center;border:1px solid ${C.line};background:#fff;border-radius:999px;overflow:hidden}
  .tb-pz-a{font:inherit;font-size:11.5px;font-weight:600;color:${C.ink};background:transparent;border:0;padding:4px 11px;cursor:pointer;white-space:nowrap}
  .tb-pz-a:hover{background:${C.track};color:${C.fill}}
  .tb-pz-x{font:inherit;font-size:12px;color:${C.muted};background:transparent;border:0;border-left:1px solid ${C.line};padding:4px 7px;cursor:pointer}
  .tb-pz-x:hover{color:${C.over};background:#fdecec}
  .tb-psave{font:inherit;font-size:11.5px;font-weight:600;padding:4px 11px;border:1px dashed ${C.line};border-radius:999px;background:#fff;color:${C.muted};cursor:pointer}
  .tb-psave:hover{border-color:${C.fill};color:${C.fill}}.tb-psave:disabled{opacity:.6}
  .tb-wrap{overflow-x:auto}
  table.tb{width:100%;border-collapse:collapse;font-size:13px}
  .tb tbody tr[data-id]{cursor:pointer}
  .tb tbody tr.tb-draggable{cursor:grab;user-select:none;touch-action:pan-y}
  .tb tbody tr.tb-sel td{background:#e6f0ff}
  .tb tbody tr.tb-sel td:first-child{box-shadow:inset 3px 0 0 ${C.fill}}
  /* Excel風グリッド編集: アクティブセル/矩形選択/インライン入力 */
  .tb td.tb-gc{position:relative}
  .tb td.tb-gc-insel{background:rgba(58,134,255,.10)}
  .tb td.tb-gc-active{box-shadow:inset 0 0 0 2px ${C.fill};border-radius:3px}
  .tb td.tb-gc-flash{animation:tb-flash-fade .5s ease-out}
  .tb-gedit{width:100%;box-sizing:border-box;font:inherit;font-size:13px;border:0;outline:2px solid ${C.fill};border-radius:3px;padding:4px 6px;background:#fff;color:${C.ink}}
  html[data-theme="dark"] .tb td.tb-gc-insel{background:rgba(58,134,255,.18)}
  html[data-theme="dark"] .tb-gedit{background:var(--card);color:var(--ink)}
  /* 選択チェックボックス列 */
  .tb th.tb-selcol,.tb td.tb-selcol{width:34px;padding-left:14px;padding-right:4px}
  .tb-rowck{display:inline-grid;place-items:center;width:17px;height:17px;border-radius:5px;border:1.5px solid ${C.line};background:#fff;color:#fff;cursor:pointer;font-weight:700;line-height:1}
  .tb-rowck:hover{border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .tb-rowck.on{background:${C.fill};border-color:${C.fill}}
  .tb-rowck.part{background:${C.fill};border-color:${C.fill};color:#fff;font-size:12px}
  /* 一括操作バー（sticky・選択時のみ） */
  .tb-bulk{position:sticky;bottom:14px;z-index:20;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 4px;padding:9px 14px;border:1px solid #cfe0ff;border-radius:12px;background:#fff;box-shadow:0 8px 26px rgba(20,30,50,.16)}
  .tb-bk-n{font-size:12.5px;font-weight:700;color:${C.fill};white-space:nowrap}
  .tb-bk-acts{display:inline-flex;gap:6px;flex-wrap:wrap}
  .tb-bk-a{font:inherit;font-size:12.5px;font-weight:600;padding:6px 13px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};cursor:pointer}
  .tb-bk-a:hover{border-color:${C.fill};color:${C.fill};background:#eef4ff}
  .tb-bk-a.danger{color:${C.over}}.tb-bk-a.danger:hover{border-color:${C.over};color:${C.over};background:#fdecec}
  .tb-bk-a:disabled,.tb-bk-clr:disabled{opacity:.5;cursor:default}
  .tb-bk-busy{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .tb-bk-clr{font:inherit;font-size:12px;font-weight:600;margin-left:auto;padding:6px 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:${C.muted};cursor:pointer}
  .tb-bk-clr:hover{color:${C.ink};background:${C.track}}
  /* 列の表示・並べ替え（歯車）ボタン＋メニュー */
  .tb-colsbtn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;padding:6px 12px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.muted};cursor:pointer}
  .tb-colsbtn:hover{border-color:#d7dde6;color:${C.ink}}
  .tb-colsmenu{min-width:236px;padding:6px}
  .tb-colhd{font-size:10.5px;font-weight:700;letter-spacing:.04em;color:${C.muted};padding:5px 8px 6px}
  .tb-colrow{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:7px}
  .tb-colrow:hover{background:${C.track}}
  .tb-colck{display:inline-grid;place-items:center;width:18px;height:18px;flex:none;border-radius:5px;border:1.5px solid ${C.line};background:#fff;color:#fff;cursor:pointer;padding:0}
  .tb-colck:hover:not(:disabled){border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .tb-colck.on{background:${C.fill};border-color:${C.fill}}
  .tb-colck.fixed{opacity:.45;cursor:default}
  .tb-collbl{flex:1 1 auto;font-size:13px;color:${C.ink}}
  .tb-colmv{display:inline-flex;gap:3px;flex:none}
  .tb-colup,.tb-coldn{font:inherit;font-size:11px;line-height:1;width:24px;height:24px;border:1px solid ${C.line};border-radius:6px;background:#fff;color:${C.muted};cursor:pointer;padding:0}
  .tb-colup:hover:not(:disabled),.tb-coldn:hover:not(:disabled){border-color:${C.fill};color:${C.fill}}
  .tb-colup:disabled,.tb-coldn:disabled{opacity:.3;cursor:default}
  .tb-colft{margin-top:4px;border-top:1px solid ${C.line};padding-top:6px;display:flex}
  .tb-colreset{font:inherit;font-size:12px;font-weight:600;color:${C.muted};background:transparent;border:0;border-radius:7px;padding:6px 8px;cursor:pointer;margin-left:auto}
  .tb-colreset:hover{color:${C.fill};background:${C.track}}
  /* メニュー内の小見出し（一括: 追加/置換/外す 等） */
  .tb-ctx-hd{font-size:10px;font-weight:700;letter-spacing:.04em;color:${C.muted};padding:6px 12px 3px}
  /* 進捗バー＝クリック/キーで 0/25/50/75/100 のクイックセット */
  .tb-pctbar{cursor:pointer;transition:box-shadow .12s}
  .tb-pctbar:hover{box-shadow:0 0 0 2px rgba(58,134,255,.25)}
  .tb-pctbar:focus-visible{outline:none;box-shadow:0 0 0 2px ${C.fill}}
  html[data-theme="dark"] .tb-colsbtn{background:var(--card)}
  html[data-theme="dark"] .tb-colsmenu .tb-colck{background:var(--card)}
  html[data-theme="dark"] .tb-colsmenu .tb-colck.on{background:${C.fill}}
  html[data-theme="dark"] .tb-colup,html[data-theme="dark"] .tb-coldn{background:var(--card)}
  .tb-ghost-badge{position:absolute;top:-8px;right:-8px;min-width:20px;height:20px;border-radius:10px;background:${C.over};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 2px 6px rgba(0,0,0,.3)}
  /* 元の場所＝ギャップ: 文字も枠も無く、ただ柔らかい影が落ちているだけに見せる */
  /* 落下ギャップ＝フラットな薄いグレーの空き帯（グラデ無し・継ぎ目無し） */
  .tb tbody tr.tb-ph td{color:transparent!important;border-bottom-color:transparent!important;background:rgba(20,30,50,.08)!important}
  .tb tbody tr.tb-ph td *{visibility:hidden}
  /* カーソル追従の浮きカード（ゴースト） */
  .tb-ghost{filter:drop-shadow(0 10px 24px rgba(20,30,50,.22));transform:scale(1.01);opacity:.45}
  .tb-ghost-tbl{border-collapse:collapse;table-layout:fixed;background:#fff;border:1px solid ${C.line};border-radius:9px;overflow:hidden}
  .tb-ghost-tbl td{padding:15px 12px;border-bottom:0;font-size:13px;vertical-align:middle}
  .tb-ghost-tbl tr + tr td{border-top:1px solid ${C.line}}
  .tb-ctx{position:fixed;z-index:10000;min-width:170px;max-height:340px;overflow-y:auto;background:#fff;border:1px solid ${C.line};border-radius:10px;box-shadow:0 12px 34px rgba(20,30,50,.22);padding:5px;display:flex;flex-direction:column}
  .tb-ctx-inp{font:inherit;font-size:13px;display:flex;align-items:center;gap:8px;justify-content:space-between;padding:7px 12px;color:${C.ink}}
  .tb-ctx-inp input{font:inherit;font-size:12px;border:1px solid ${C.line};border-radius:6px;padding:3px 6px}
  .tb-ctx-txt{flex-direction:column;align-items:stretch;gap:4px}
  .tb-ctx-txt input{width:100%;box-sizing:border-box}
  .tb-ctx-unit{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:${C.muted}}
  .tb-ctx-unit input{width:66px;text-align:right}
  .tb-hg{display:flex;flex-direction:column;gap:8px;padding:8px 9px;min-width:0}
  .tb-hg-cols{display:flex;gap:0;align-items:stretch}
  .tb-hg-col{display:flex;flex-direction:column;gap:6px}
  .tb-hg-col.h{padding-right:14px;border-right:1px solid ${C.line};margin-right:14px}
  .tb-hg-lbl{font-size:11px;color:${C.muted};font-weight:600}
  .tb-hg-wrap{display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto;padding-right:6px;scrollbar-width:thin}
  .tb-hg-min{display:flex;flex-direction:column;gap:4px}
  .tb-hg-b{font:inherit;font-size:12px;width:30px;padding:4px 0;border:1px solid ${C.line};border-radius:6px;background:#fff;color:${C.ink};cursor:pointer;text-align:center}
  .tb-hg-b:hover{border-color:${C.fill};color:${C.fill}}
  .tb-hg-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .tb-hg-direct{display:flex;align-items:center;gap:6px;margin-top:2px;padding-top:8px;border-top:1px solid ${C.line};font-size:12px;color:${C.muted}}
  .tb-hg-direct .tf-step{flex:none;width:96px}
  .tb-hg-apply{font:inherit;font-size:12px;font-weight:600;color:${C.fill};background:#eaf2ff;border:1px solid #cfe0ff;border-radius:6px;padding:5px 12px;cursor:pointer;flex:none}
  .tb-hg-apply:hover{background:#dbe9ff}
  /* 見積フッター: クリア(左)・キャンセル(中)・適用(右) */
  .tb-hg-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
  .tb-hg-clear,.tb-hg-cancel{font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:5px 12px;cursor:pointer;background:#fff;border:1px solid ${C.line}}
  .tb-hg-clear{color:${C.over}}
  .tb-hg-cancel{color:${C.muted}}
  .tb-hg-clear:hover,.tb-hg-cancel:hover{background:${C.track}}
  html[data-theme="dark"] .tb-hg-clear,html[data-theme="dark"] .tb-hg-cancel{background:${C.card}}
  html[data-theme="dark"] .tb-hg-apply{background:rgba(58,134,255,.18);border-color:rgba(58,134,255,.4)}
  .tb-ctx-it{font:inherit;font-size:13px;text-align:left;border:0;background:transparent;color:${C.ink};padding:8px 12px;border-radius:7px;cursor:pointer;white-space:nowrap}
  .tb-ctx-it:hover{background:${C.track}}
  .tb-ctx-it.danger{color:${C.over}}
  .tb-ctx-it.danger:hover{background:#fdecec}
  .tb-ctx-sep{height:1px;background:${C.line};margin:5px 6px}
  body.tb-dragging-body{cursor:grabbing}
  body.tb-dragging-body .tb tbody tr:hover{background:transparent}
  /* 着地ハイライト: ドロップ直後にジワっと色が戻る（落ちた先を見失わない） */
  @keyframes tb-flash-fade{from{background-color:rgba(58,134,255,.32)}to{background-color:rgba(58,134,255,0)}}
  .tb tbody tr.tb-flash td{animation:tb-flash-fade 1.1s ease-out}
  .tb-fav{font-size:11px;vertical-align:1px}
  .tb-fable{width:22px;height:22px;border-radius:50%;border:1px solid ${C.fill};background:#fff;color:${C.fill};cursor:pointer;font-size:9px;padding:0;vertical-align:1px;margin-left:4px}
  .tb-fable:hover{background:${C.fill};color:#fff}.tb-fable:disabled{opacity:.5;cursor:default}
  .tb-timer{width:22px;height:22px;border-radius:50%;border:1px solid ${C.line};background:#fff;color:${C.muted};cursor:pointer;padding:0;vertical-align:1px;display:inline-flex;align-items:center;justify-content:center;opacity:.55}
  .tb tbody tr:hover .tb-timer{opacity:1}
  .tb-timer:hover{background:${C.fill};color:#fff;border-color:${C.fill}}
  .tb-timer.busy{color:${C.over};border-color:${C.over};opacity:1}
  .tb th{font-size:11px;color:${C.muted};font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid ${C.line};white-space:nowrap;background:#fafbfc}
  .tb th.sortable{cursor:pointer;user-select:none}.tb th.sortable:hover{color:${C.ink}}
  .tb-thord{font-size:9.5px;color:${C.fill};font-weight:700;background:#eaf2ff;border-radius:5px;padding:0 4px;vertical-align:1px}
  .tb td{padding:15px 12px;border-bottom:1px solid ${C.line};vertical-align:middle}
  .tb th:last-child,.tb td:last-child{padding-right:20px}
  .tb tbody tr:hover{background:#f7fbff}
  /* 階段セル（プロジェクト＞タスクグループ＞タスク）。110px は rowHtml の STAIR_W と同値＝th幅と揃える */
  .tb th[data-k="proj"],.tb th[data-k="group"]{width:110px;min-width:110px}
  .tb-stair{min-width:300px}
  .tb-st-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}
  .tb-st-proj .tb-cell{font-size:12px;color:${C.muted};padding-top:1px;padding-bottom:1px}
  .tb-st-group .tb-cell{font-size:12px;color:${C.muted};padding-top:1px;padding-bottom:1px}
  .tb-st-title{font-weight:600}
  .tb-sub{font-size:11px;color:${C.muted};font-weight:400;margin-top:2px}
  .tb-who-nm{font-weight:700;white-space:nowrap}
  .tb-asbtn{white-space:nowrap;min-width:5.5em}  /* 4文字＋▾が確実に収まる幅 */
  .tb-k{font-size:10.5px;color:${C.muted};border:1px solid ${C.line};border-radius:5px;padding:1px 6px;white-space:nowrap}
  .tb-k.review{color:${C.fill};border-color:#cfe0ff}
  .tb-cat{font-size:10.5px;border:1px solid;border-radius:5px;padding:1px 7px;white-space:nowrap;font-weight:600}
  .tb-cat.none{color:${C.muted};border:0}
  .tb-prio{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.tb-prio i{width:9px;height:9px;border-radius:3px;display:inline-block}
  .tb-num{font-variant-numeric:tabular-nums;white-space:nowrap}
  td.over{color:${C.over};font-weight:600}
  .tb-bar{display:inline-block;width:64px;height:7px;border-radius:5px;background:${C.track};overflow:hidden;vertical-align:middle;margin-right:7px}
  .tb-bar i{display:block;height:100%;background:${C.fill}}
  .tb-pct{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .tb-st{font-size:11px;font-weight:600;border-radius:20px;padding:2px 9px;white-space:nowrap}
  .tb-st.todo{color:${C.muted};background:#f0f1f4}.tb-st.doing{color:${C.fill};background:#eaf2ff}.tb-st.waiting{color:#9a6a00;background:#fbf0d6}.tb-st.done{color:${C.free};background:#eaf7ef}
  /* ステータスはワンクリックで変更（押せる見た目＝枠＋▾＋hover） */
  .tb-stbtn{font-family:inherit;cursor:pointer;border:1px solid rgba(20,30,50,.12);display:inline-flex;align-items:center;gap:4px;transition:box-shadow .12s,border-color .12s}
  .tb-stbtn:hover{border-color:rgba(20,30,50,.24);box-shadow:0 1px 4px rgba(20,30,50,.16)}
  .tb-st-car{font-size:11px;opacity:.6;margin-right:-1px}
  .tb-ctx-ck{display:inline-block;width:13px;color:${C.fill};font-weight:700}
  /* 一覧から直接編集できるセル＝普段は素／hoverで枠＋▾が出て「押せる」と分かる */
  .tb-cell{font-family:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid transparent;border-radius:7px;padding:3px 7px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;max-width:100%;text-align:left;line-height:1.5}
  .tb-cell:hover{background:#eef4ff;border-color:#dbe7ff}
  .tb-cell.tb-num{font-variant-numeric:tabular-nums}
  .tb-cell.over{color:${C.over};font-weight:600}
  .tb-cell-car{font-size:11px;opacity:0;color:${C.muted};transition:opacity .1s;margin-left:auto;padding-left:2px}
  .tb-cell:hover .tb-cell-car{opacity:.6}
  @media (hover:none){.tb-cell-car{opacity:.45}}  /* タッチ端末はhoverが無いので▾を常時薄く表示＝編集可能と分かる */
  .tb-prio-none{color:${C.muted}}
  /* クイック絞り込みのチップ列 */
  .tb-quick{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:-4px 0 14px}
  .tb-ql{font-size:11px;color:${C.muted};font-weight:600;margin-right:2px}
  .tb-qsep{width:1px;height:16px;background:${C.line};margin:0 3px}
  .tb-qa{font:inherit;font-size:12px;padding:4px 11px;border:1px solid ${C.line};border-radius:16px;background:#fff;color:${C.ink};cursor:pointer;transition:all .12s}
  .tb-qa:hover{border-color:${C.fill};color:${C.fill}}
  .tb-qa.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:600}
  .tb-qclr{color:${C.muted}}.tb-qclr:hover{color:${C.over};border-color:${C.over}}
  .tb-empty{text-align:center;color:${C.muted};padding:30px}
  /* 表/アウトライン セグメント切替 */
  .tb-seg{display:inline-flex;border:1px solid ${C.line};border-radius:8px;overflow:hidden;background:#fff}
  .tb-seg-b{font:inherit;font-size:12.5px;font-weight:600;padding:6px 13px;border:0;background:transparent;color:${C.muted};cursor:pointer}
  .tb-seg-b + .tb-seg-b{border-left:1px solid ${C.line}}
  .tb-seg-b:hover:not(.on){color:${C.ink}}
  .tb-seg-b.on{background:#eaf2ff;color:${C.fill}}
  /* 最上部の定期帯（軽く・控えめ） */
  .tb-rec{margin:-4px 0 14px;border:1px solid ${C.line};border-radius:10px;background:#fbfcfe;overflow:hidden}
  .tb-rec-head{display:flex;align-items:center;gap:6px;width:100%;font:inherit;font-size:11.5px;font-weight:700;color:${C.muted};background:transparent;border:0;padding:8px 12px;cursor:pointer;text-align:left}
  .tb-rec-head:hover{color:${C.ink}}
  .tb-rec-cnt{font-size:10.5px;font-weight:600;color:${C.muted};background:${C.track};border-radius:10px;padding:1px 7px}
  .tb-rec-car{margin-left:auto;font-size:10px;opacity:.7}
  .tb-rec-list{border-top:1px solid ${C.line}}
  .tb-rec-row{display:flex;align-items:center;gap:10px;padding:6px 12px;font-size:12px;color:${C.ink};cursor:pointer;border-top:1px solid ${C.track}}
  .tb-rec-row:first-child{border-top:0}
  .tb-rec-row:hover{background:#f3f8ff}
  .tb-rec-ic{flex:none;color:${C.fill};display:inline-flex}
  .tb-rec-t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}
  .tb-rec-m{color:${C.muted};font-size:11.5px;white-space:nowrap}
  .tb-rec-w{margin-left:auto;color:${C.muted};font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:30%;flex:none}
  /* アウトライン（階層）= outline.js から移植 */
  .ol-card{padding:6px 0}
  .ol-row{display:flex;align-items:center;gap:8px;padding:7px 14px 7px 0;border-bottom:1px solid ${C.line};font-size:13.5px;cursor:pointer}
  .ol-row:last-child{border-bottom:0}
  .ol-row:hover{background:#f7fbff}
  .ol-tw{width:28px;height:28px;margin:-6px 0;flex:none;display:grid;place-items:center;color:${C.muted};cursor:pointer;font-size:16px;line-height:1;user-select:none;border-radius:6px}
  .ol-tw:not(.none):hover{background:#e7eef7;color:${C.fill}}
  .ol-tw.none{cursor:pointer;visibility:hidden}
  .ol-cb{width:15px;height:15px;border-radius:4px;flex:none;border:1.5px solid ${C.line};cursor:pointer;display:grid;place-items:center}
  .ol-cb:hover{border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .ol-cb.done{background:${C.free};border-color:${C.free}}
  .ol-cb.doing{background:#eaf2ff;border-color:${C.fill}}
  /* 親付け替えDnD: 掴んだ行を薄く／ドロップ先（親候補）をハイライト／余白=最上位へ */
  .ol-row[draggable="true"]{cursor:grab}
  .ol-row.ol-dragging{opacity:.4}
  .ol-row.ol-drop-into{background:#e7f0ff;box-shadow:inset 3px 0 0 ${C.fill};border-radius:6px}
  .ol-card.ol-drop-root{box-shadow:inset 0 0 0 2px ${C.fill};border-radius:12px}
  /* 全展開/全折りたたみ（セグメント付近の小ボタン） */
  .tb-olexp{display:inline-flex;gap:5px}
  .tb-olx{font:inherit;font-size:11.5px;font-weight:600;padding:5px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.muted};cursor:pointer;display:inline-flex;align-items:center;gap:4px}
  .tb-olx:hover{border-color:${C.fill};color:${C.fill}}
  .tb-olx-car{font-size:10px;opacity:.7}
  /* 行内サブタスク追加（＋） */
  .ol-addsub{font:inherit;font-size:13px;font-weight:700;width:20px;height:20px;line-height:1;border:1px solid ${C.line};border-radius:6px;background:#fff;color:${C.muted};cursor:pointer;opacity:0;transition:opacity .1s;display:grid;place-items:center;padding:0}
  .ol-row:hover .ol-addsub{opacity:1}
  .ol-addsub:hover{border-color:${C.fill};color:${C.fill};background:#eef4ff}
  @media (hover:none){.ol-addsub{opacity:.55}}
  .ol-kind{font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;margin-left:6px;vertical-align:middle;white-space:nowrap;display:inline-block}
  .ol-kind-proj{background:rgba(58,134,255,.13);color:#2f6fd6;border:1px solid rgba(58,134,255,.32)}
  .ol-kind-group{background:${C.track};color:${C.muted};border:1px solid ${C.line}}
  .ol-kindmenu{display:flex;flex-direction:column;gap:2px;padding:4px;min-width:160px}
  .ol-kindbtn{font:inherit;font-size:13px;text-align:left;padding:7px 10px;border:none;border-radius:7px;background:transparent;color:${C.ink};cursor:pointer}
  .ol-kindbtn:hover{background:${C.track}}
  .ol-addbox{padding:8px;min-width:240px;gap:7px}
  .ol-addinp{font:inherit;font-size:13px;width:100%;box-sizing:border-box;border:1px solid ${C.line};border-radius:7px;padding:6px 8px;resize:vertical;color:${C.ink};background:#fff}
  .ol-addinp:focus{outline:none;border-color:${C.fill}}
  .ol-addbtns{display:flex;align-items:center;gap:7px}
  .ol-addok{font:inherit;font-size:12px;font-weight:600;color:#fff;background:${C.fill};border:1px solid ${C.fill};border-radius:6px;padding:5px 14px;cursor:pointer}
  .ol-addok:disabled{opacity:.6}
  .ol-addng{font:inherit;font-size:12px;color:${C.muted};background:transparent;border:1px solid ${C.line};border-radius:6px;padding:5px 11px;cursor:pointer}
  .ol-adderr{font-size:11px;color:${C.over}}
  .ol-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ol-name.done{color:${C.muted};text-decoration:line-through}
  .ol-cc{font-size:10.5px;color:${C.muted};background:#f0f1f4;border-radius:10px;padding:1px 7px;flex:none}
  .ol-meta{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}
  .ol-who{font-size:11.5px;font-weight:700;white-space:nowrap;max-width:6em;overflow:hidden;text-overflow:ellipsis}
  .ol-due{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .ol-st{font-size:10.5px;font-weight:600;border-radius:20px;padding:1px 8px}
  .ol-st.todo{color:${C.muted};background:#f0f1f4}.ol-st.doing{color:${C.fill};background:#eaf2ff}.ol-st.waiting{color:#9a6a00;background:#fbf0d6}.ol-st.done{color:${C.free};background:#eaf7ef}
  .ol-empty{padding:30px;text-align:center;color:${C.muted}}
  /* ===== ダークモード（淡色直書きをダーク側へ上書き。ライト不変） ===== */
  html[data-theme="dark"] .tb-search-in{background:var(--card)}
  html[data-theme="dark"] .tb-seg{background:var(--card)}
  html[data-theme="dark"] .tb-seg-b.on{background:rgba(58,134,255,.18)}
  html[data-theme="dark"] .tb-rec{background:rgba(255,255,255,.03)}
  html[data-theme="dark"] .tb-rec-row:hover{background:rgba(255,255,255,.05)}
  html[data-theme="dark"] .tb-rec-cnt{background:rgba(255,255,255,.08)}
  html[data-theme="dark"] .ol-row:hover{background:rgba(255,255,255,.05)}
  html[data-theme="dark"] .ol-row.ol-drop-into{background:rgba(58,134,255,.18)}
  html[data-theme="dark"] .ol-tw:not(.none):hover{background:${C.track};color:${C.fill}}
  html[data-theme="dark"] .ol-cb.doing{background:rgba(58,134,255,.25);border-color:${C.fill}}
  html[data-theme="dark"] .ol-cc{background:rgba(255,255,255,.08)}
  html[data-theme="dark"] .tb-olx{background:var(--card)}
  html[data-theme="dark"] .ol-addsub{background:var(--card)}
  html[data-theme="dark"] .ol-addsub:hover{background:rgba(58,134,255,.18)}
  html[data-theme="dark"] .ol-addinp{background:var(--card)}
  html[data-theme="dark"] .ol-addng{background:transparent}
  html[data-theme="dark"] .tb tbody tr.tb-sel td{background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .tb-rowck{background:var(--card)}
  html[data-theme="dark"] .tb-rowck.on,html[data-theme="dark"] .tb-rowck.part{background:${C.fill};border-color:${C.fill}}
  html[data-theme="dark"] .tb-bulk{background:var(--card);border-color:rgba(58,134,255,.4)}
  html[data-theme="dark"] .tb-bk-a{background:var(--card)}
  html[data-theme="dark"] .tb-bk-a:hover{background:rgba(58,134,255,.18)}`;
}
