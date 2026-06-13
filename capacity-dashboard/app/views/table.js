// タスク一覧（表・mock60 相当）。**複数軸の組み合わせソート**＋**個人ごとの並び順**（マイソート＝手動）。
// 並び設定（ソート軸の連なり・手動順・絞り込み）は **見ている本人ごとに localStorage 保存**＝
// 共有データ（DB）は一切変えないので、誰がどう並べても他メンバーの見え方に影響しない（衝突しない）。
import { load, invalidate, projectName, isAiUser } from "../lib/store.js";
import { savePresets } from "../lib/exec.js";
import { updateTask, deleteTask, addAssignee, removeAssignee, addTaskLabel, removeTaskLabel, createLabel } from "../lib/api.js";
import { PRIO, prioBucket, kindOf, isReviewTask, categoryLabels, categoryColor, REVIEW_LABEL } from "../lib/kinds.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { shiftISO } from "../lib/capacity.js";
import { openTaskForm } from "./taskform.js";

const HOUR = 3600;
const MAX_SORTS = 5; // 組めるソート条件の上限（第1〜第5条件）
const VKEY = (uid) => `ts.list.view.${uid ?? "anon"}`;
function loadView(uid) {
  const def = { sorts: [{ key: "due", dir: 1 }], manualMode: false, order: [], hideDone: true, proj: "", cat: "", qaWho: "", qaDue: "" };
  try {
    const raw = JSON.parse(localStorage.getItem(VKEY(uid)) || "null");
    if (!raw) return { ...def };                       // 初回のみ既定（期限）
    const v = { ...def, ...raw };
    if (!Array.isArray(v.sorts)) v.sorts = [];          // 壊れてる時だけ空に（空配列=意図的な「条件なし」は保持）
    return v;
  } catch { return { ...def }; }
}
function saveView(uid, v) { try { localStorage.setItem(VKEY(uid), JSON.stringify(v)); } catch { /* noop */ } }

// 保存したマイソート（手動順）＝本人ごと（手動順は個人の並びなのでローカル保存）。[{name, order:[taskId]}]
const MSKEY = (uid) => `ts.list.mysorts.${uid ?? "anon"}`;
function loadMySorts(uid) { try { return JSON.parse(localStorage.getItem(MSKEY(uid))) || []; } catch { return []; } }
function saveMySorts(uid, list) { try { localStorage.setItem(MSKEY(uid), JSON.stringify(list)); } catch { /* noop */ } }

let V = null, UID = null;
let flashId = null;          // ドロップ直後にジワっと色が戻る着地ハイライト対象（再描画後に適用）
let selectedIds = new Set(); // まとめて移動用の複数選択（マイソート中のみ・Ctrl/Shiftで操作）
let anchorId = null;         // Shift範囲選択の起点
let lastRoot = null, docDeselectWired = false; // 余白クリック解除（document全体・右側の地まで拾う）

const stateOf = (t) => (t.done ? "完了" : ((t.percent_done || 0) > 0 ? "進行中" : "未着手"));
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");

// 軸の定義: ラベル＋比較関数（行 r を受ける）＋セレクトで選んだ時の既定の向き。
const AXES = {
  due:     { label: "期限",      cmp: (a, b) => (a.due || "9999").localeCompare(b.due || "9999"), dir: 1 },
  prio:    { label: "重要度",    cmp: (a, b) => a.prio - b.prio, dir: -1 },
  ws:      { label: "WS",        cmp: (a, b) => a.proj.localeCompare(b.proj, "ja"), dir: 1 },
  cat:     { label: "分類",      cmp: (a, b) => ((a.cat && a.cat.title) || "～").localeCompare((b.cat && b.cat.title) || "～", "ja"), dir: 1 },
  who:     { label: "担当",      cmp: (a, b) => ((a.who && (a.who.name || a.who.username)) || "～").localeCompare((b.who && (b.who.name || b.who.username)) || "～", "ja"), dir: 1 },
  state:   { label: "ステータス",      cmp: (a, b) => stateRank(a) - stateRank(b), dir: 1 },
  pct:     { label: "進捗",      cmp: (a, b) => a.pct - b.pct, dir: -1 },
  est:     { label: "見積",      cmp: (a, b) => a.est - b.est, dir: -1 },
  flag:    { label: "フラグ",    cmp: (a, b) => (a.t.is_favorite ? 1 : 0) - (b.t.is_favorite ? 1 : 0), dir: -1 },
  created: { label: "追加日",    cmp: (a, b) => String(a.t.created || "").localeCompare(String(b.t.created || "")), dir: -1 },
  title:   { label: "タスク名",  cmp: (a, b) => a.title.localeCompare(b.title, "ja"), dir: 1 },
};
const stateRank = (r) => (r.done ? 2 : (r.pct > 0 ? 1 : 0)); // 未着手→進行中→完了
const tieBreak = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.t.id - b.t.id;

export async function render(root) {
  const { tasks, projects, members, me = null, settings = {}, labels = [] } = await load();
  const presets = settings.sortPresets || [];   // グローバル共有プリセット
  const canEditPresets = !!settings.canEdit;     // 保存/削除は許可ユーザーのみ（適用は全員可）
  const today = todayISO();
  UID = (me && me.id) || 0;
  V = loadView(UID);
  const mysorts = loadMySorts(UID); // 保存したマイソート（本人ごと）
  let execOk = false;
  try { const ex = await import("../lib/exec.js"); execOk = !!(await ex.execMe()); } catch { /* noop */ }
  let rows = (tasks || []).map((t) => ({
    t, title: t.title, who: (t.assignees || []).find((a) => !isAiUser(a)) || null,
    fable: execOk && !t.done && (t.assignees || []).some((a) => isAiUser(a))
      && ((t.created_by || {}).id || 0) === ((me && me.id) || -1),
    proj: projectName(projects, t.project_id), pid: t.project_id,
    review: isReviewTask(t), prio: prioBucket(t.priority), cat: categoryLabels(t)[0] || null,
    due: dueISO(t), est: (t.time_estimate || 0) / HOUR, pct: t.percent_done || 0,
    done: !!t.done, state: stateOf(t),
  }));
  if (V.hideDone) rows = rows.filter((r) => !r.done);
  if (V.proj) rows = rows.filter((r) => String(r.pid) === V.proj);
  if (V.cat) rows = rows.filter((r) => (r.cat ? r.cat.title : "") === V.cat);
  // クイック絞り込み（担当＝自分/担当なし/自分＋担当なし、期限＝今日＋期限なし/1週間以内/1ヶ月以内）。本人ごとに保存。
  const humanAssignees = (t) => (t.assignees || []).filter((a) => !isAiUser(a));
  if (V.qaWho === "me") rows = rows.filter((r) => humanAssignees(r.t).some((a) => a.id === UID));
  else if (V.qaWho === "none") rows = rows.filter((r) => humanAssignees(r.t).length === 0);
  else if (V.qaWho === "me_none") rows = rows.filter((r) => { const h = humanAssignees(r.t); return h.length === 0 || h.some((a) => a.id === UID); });
  if (V.qaDue === "today_nd") rows = rows.filter((r) => !r.due || r.due === today);
  else if (V.qaDue === "7d") rows = rows.filter((r) => r.due && r.due <= shiftISO(today, 7));
  else if (V.qaDue === "30d") rows = rows.filter((r) => r.due && r.due <= shiftISO(today, 30));

  const manual = V.manualMode;
  // 選択はマイソート中のみ有効。表示中のタスクに限定（フィルタ/モード変更で掃除）
  if (!manual) { selectedIds.clear(); anchorId = null; }
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

  const projOpts = `<option value="">全ワークスペース</option>` +
    (projects || []).map((p) => `<option value="${p.id}"${String(p.id) === V.proj ? " selected" : ""}>${esc(p.title)}</option>`).join("");
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

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">タスク一覧 <small>${rows.length}件 ${manual ? "・ 行をどこでもドラッグして自分用に並べ替え" : `・ ソート条件を重ねて並べ替え（列ヘッダ: クリック=第1条件 / Shift+クリック=条件を追加・最大${MAX_SORTS}）`}</small></h1>
    <div class="tb-tools">
      <button id="tb-add" class="tb-add">タスク追加</button>
      <button id="tb-manual" class="tb-manbtn${manual ? " on" : ""}" title="自分だけの手動ソート">✋ マイソート</button>
      <span class="tb-sortwrap${manual ? " dim" : ""}">ソート条件: <span class="tb-chips">${chips || `<span class="tb-sc-none">なし（既定: 期限順）</span>`}</span>
        ${V.sorts.length < MAX_SORTS ? `<select id="tb-addsort" class="tb-addsort">${addOpts}</select>` : `<span class="tb-sc-none">最大${MAX_SORTS}件</span>`}</span>
      <select id="tb-proj">${projOpts}</select>
      <select id="tb-cat">${catOpts}</select>
      <label class="tb-chk"><input type="checkbox" id="tb-hd" ${V.hideDone ? "checked" : ""}> 完了を隠す</label>
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
      <span class="tb-pl">保存したマイソート<span class="tb-pl-g" title="あなた専用・この端末">👤</span></span>
      ${mysorts.map((m, i) => `<span class="tb-pz"><button class="tb-mz-a" data-mi="${i}" title="この手動順を適用">${esc(m.name)}</button><button class="tb-mz-x" data-mi="${i}" title="削除">×</button></span>`).join("") || `<span class="tb-sc-none">まだありません</span>`}
      <button class="tb-psave" id="tb-msave" title="今の手動のソート順に名前を付けて保存">💾 今のソートを保存</button>
    </div>` : ""}
    ${(presets.length || canEditPresets) && !manual ? `<div class="tb-presets">
      <span class="tb-pl">プリセット<span class="tb-pl-g" title="チーム全員で共有">🌐</span></span>
      ${presets.map((p, i) => `<span class="tb-pz" data-pi="${i}"><button class="tb-pz-a" data-pi="${i}" title="このソートを適用">${esc(p.name)}</button>${canEditPresets ? `<button class="tb-pz-x" data-pi="${i}" title="削除（全員に反映）">×</button>` : ""}</span>`).join("") || `<span class="tb-sc-none">まだありません</span>`}
      ${canEditPresets ? `<button class="tb-psave" id="tb-psave" title="今の組み合わせソートを共有プリセットとして保存">💾 現在のソートを保存</button>` : ""}
    </div>` : ""}
    <div class="card tb-wrap"><table class="tb">
      <thead><tr>${cols().map((c) => th(c, manual)).join("")}</tr></thead>
      <tbody>${rows.length ? rows.map((r, i) => rowHtml(r, members, i, manual)).join("") : `<tr><td colspan="9" class="tb-empty">該当なし</td></tr>`}</tbody>
    </table></div>`;

  const persist = () => saveView(UID, V);
  const reRender = () => { persist(); render(root); };

  root.querySelector("#tb-manual").onclick = () => { V.manualMode = !V.manualMode; reRender(); };
  root.querySelector("#tb-proj").onchange = (e) => { V.proj = e.target.value; reRender(); };
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
  root.querySelector("#tb-hd").onchange = (e) => { V.hideDone = e.target.checked; reRender(); };
  root.querySelector("#tb-add").onclick = () => openTaskForm({ onSaved: () => render(root) });
  // 条件を追加（最大5件・5件到達時はセレクト自体を出さない）。マイソート中なら組み合わせソートに切替
  const addSel = root.querySelector("#tb-addsort");
  if (addSel) addSel.onchange = (e) => {
    const k = e.target.value; if (!k || V.sorts.length >= MAX_SORTS) return;
    V.sorts.push({ key: k, dir: AXES[k].dir }); V.manualMode = false; reRender();
  };
  // チップ: 向き切替 / 削除（最後の1件も外せる＝条件なし=既定の期限順）
  root.querySelectorAll(".tb-sc-k").forEach((b) => { b.onclick = () => { const s = V.sorts[+b.dataset.i]; if (s) { s.dir = -(s.dir || 1); V.manualMode = false; reRender(); } }; });
  root.querySelectorAll(".tb-sc-x").forEach((b) => { b.onclick = () => { V.sorts.splice(+b.dataset.i, 1); reRender(); }; });
  // 列ヘッダ: クリック=第1条件に（単一化）・Shift+クリック=条件として追加/切替（最大5件）
  root.querySelectorAll("th[data-k]").forEach((h) => {
    h.onclick = (e) => {
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
  });
  root.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.onclick = (e) => { if (V.manualMode || e.target.closest(".tb-fable")) return; openTaskForm({ taskId: +tr.dataset.id, onSaved: () => render(root) }); };
    tr.oncontextmenu = (e) => { e.preventDefault(); openRowMenu(e.clientX, e.clientY, +tr.dataset.id, tasks, root); };
  });
  root.querySelectorAll(".tb-stbtn").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openStatusMenu(b, +b.dataset.st, tasks, root); };
  });
  // 一覧から直接編集（担当/分類/重要度/期限/見積）。各セルはボタン＝行クリック(編集)とは分離。
  root.querySelectorAll(".tb-asbtn").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openAssigneeMenu(b, +b.dataset.as, tasks, members, root); }; });
  root.querySelectorAll(".tb-catbtn").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openCategoryMenu(b, +b.dataset.cat, tasks, labels, root); }; });
  root.querySelectorAll(".tb-priobtn").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openPrioMenu(b, +b.dataset.prio, tasks, root); }; });
  root.querySelectorAll(".tb-duebtn").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openDueMenu(b, +b.dataset.due, tasks, root, today); }; });
  root.querySelectorAll(".tb-estbtn").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openEstMenu(b, +b.dataset.est, tasks, root); }; });
  root.querySelectorAll(".tb-fable").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation(); b.disabled = true;
      try { const { runAi } = await import("../lib/exec.js"); const j = await runAi(+b.dataset.fable, b.dataset.title); b.textContent = "⏵…"; b.title = `キュー #${j.job.id} に追加済み`; }
      catch { b.disabled = false; }
    };
  });
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
  const each = async (fn) => { for (const t of objs) { try { await fn(t); } catch (e) { /* 続行 */ } } reload(); };
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
      if (it.input === "date") return `<label class="tb-ctx-inp">${esc(it.label)}<input type="date" data-i="${i}" value="${it.value || ""}"></label>`;
      return `<button class="tb-ctx-it${it.danger ? " danger" : ""}" data-i="${i}">${it.check !== undefined ? `<span class="tb-ctx-ck">${it.check ? "✓" : ""}</span>` : ""}${esc(it.label)}</button>`;
    }).join("");
    m.querySelectorAll(".tb-ctx-it").forEach((b) => {
      b.onclick = () => {
        const it = its[+b.dataset.i];
        if (opts.keepOpen && it.toggle) { it.on && it.on(); paint(opts.rebuild ? opts.rebuild() : its); }
        else { closeRowMenu(); it.on && it.on(); }
      };
    });
    m.querySelectorAll(".tb-ctx-inp input").forEach((inp) => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => { const it = its[+inp.dataset.i]; closeRowMenu(); it.on && it.on(inp.value); };
    });
  };
  document.body.appendChild(m);
  _ctxEl = m;
  paint(items);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 8)) + "px";
  m.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 8)) + "px";
  const onDown = (ev) => { if (!m.contains(ev.target)) closeRowMenu(); };
  const onKey = (ev) => { if (ev.key === "Escape") closeRowMenu(); };
  const onScroll = () => closeRowMenu();
  setTimeout(() => { document.addEventListener("pointerdown", onDown, true); document.addEventListener("keydown", onKey); window.addEventListener("scroll", onScroll, true); window.addEventListener("resize", onScroll); }, 0);
  _ctxCleanup = () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", onScroll); if (opts.onClose) opts.onClose(); };
}

// ステータスのワンクリック変更（チップ直下にメニュー）。未着手/進行中/完了。
function openStatusMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const cur = t.done ? "done" : ((t.percent_done || 0) > 0 ? "doing" : "todo");
  const reload = () => { invalidate(); render(root); };
  const set = (key) => {
    const patch = key === "done" ? { done: true, percent_done: 100 }
      : key === "doing" ? { done: false, percent_done: (t.percent_done > 0 && t.percent_done < 100) ? t.percent_done : 50 }
      : { done: false, percent_done: 0 };
    updateTask(id, patch).then(reload).catch(() => {});
  };
  const it = (key, label) => ({ label, check: cur === key, on: () => set(key) });
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [it("todo", "未着手"), it("doing", "進行中"), it("done", "完了")]);
}

// 重要度のワンクリック変更（なし/低/中/高/最優先）。Vikunja priority を直接更新。
// ※「優先度」＝重要度×緊急度の合成（四象限/トリアージで算出）。この列は素の重要度。
function openPrioMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const cur = t.priority || 0;
  const reload = () => { invalidate(); render(root); };
  const opts = [[0, "なし"], [1, "低"], [2, "中"], [3, "高"], [4, "最優先"]];
  const items = opts.map(([v, label]) => ({ label, check: (cur >= 4 ? 4 : cur) === v, on: () => updateTask(id, { priority: v }).then(reload).catch(() => {}) }));
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
  const set = (iso) => updateTask(id, { due_date: iso ? iso + "T00:00:00Z" : ZERO }).then(reload).catch(() => {});
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

// 見積のワンクリック変更（プリセット＋カスタム＋クリア）。
function openEstMenu(chipEl, id, tasks, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  const reload = () => { invalidate(); render(root); };
  const cur = t.time_estimate || 0;
  const set = (sec) => updateTask(id, { time_estimate: sec }).then(reload).catch(() => {});
  const opts = [[900, "15分"], [1800, "30分"], [2700, "45分"], [3600, "1時間"], [7200, "2時間"], [14400, "4時間"], [28800, "8時間"]];
  const items = [
    ...opts.map(([sec, label]) => ({ label, check: cur === sec, on: () => set(sec) })),
    { label: "カスタム…", on: () => { const v = prompt("見積（時間。例: 1.5）", cur ? cur / 3600 : ""); if (v === null) return; const h = parseFloat(v); if (isNaN(h) || h < 0) return; set(Math.round(h * 3600)); } },
    { sep: true },
    { label: "クリア", danger: cur > 0, on: () => set(0) },
  ];
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

// 担当のワンクリック変更（メンバーを複数トグル・メニューは開いたまま即反映）。
function openAssigneeMenu(chipEl, id, tasks, members, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  if (!t.assignees) t.assignees = [];
  let dirty = false;
  const build = () => {
    const items = (members || []).map((m) => ({
      label: m.name || m.username,
      check: t.assignees.some((a) => a.id === m.id),
      toggle: true,
      on: () => {
        dirty = true;
        if (t.assignees.some((a) => a.id === m.id)) { t.assignees = t.assignees.filter((a) => a.id !== m.id); removeAssignee(id, m.id).catch(() => {}); }
        else { t.assignees = [...t.assignees, { id: m.id, username: m.username, name: m.name }]; addAssignee(id, m.id).catch(() => {}); }
      },
    }));
    if (t.assignees.length) items.push({ sep: true }, { label: "担当なし（全員外す）", danger: true, on: () => { const cur = [...t.assignees]; t.assignees = []; cur.forEach((a) => removeAssignee(id, a.id).catch(() => {})); invalidate(); render(root); } });
    return items;
  };
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, build(), { keepOpen: true, rebuild: build, onClose: () => { if (dirty) { invalidate(); render(root); } } });
}

// 分類（ラベル）のワンクリック変更（複数トグル＋新規作成）。レビューは予約語なので除外。
function openCategoryMenu(chipEl, id, tasks, labels, root) {
  closeRowMenu();
  const t = (tasks || []).find((x) => x.id === id); if (!t) return;
  if (!t.labels) t.labels = [];
  let dirty = false;
  const cats = (labels || []).filter((l) => l.title !== REVIEW_LABEL);
  const build = () => {
    const items = cats.map((l) => ({
      label: l.title,
      check: t.labels.some((x) => x.id === l.id),
      toggle: true,
      on: () => {
        dirty = true;
        if (t.labels.some((x) => x.id === l.id)) { t.labels = t.labels.filter((x) => x.id !== l.id); removeTaskLabel(id, l.id).catch(() => {}); }
        else { t.labels = [...t.labels, l]; addTaskLabel(id, l.id).catch(() => {}); }
      },
    }));
    items.push({ sep: true }, { label: "＋ 新しい分類…", on: async () => { const name = (prompt("新しい分類名") || "").trim(); if (!name) return; try { const lab = await createLabel(name); await addTaskLabel(id, lab.id); } catch (e) { /* noop */ } invalidate(); render(root); } });
    return items;
  };
  const r = chipEl.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, build(), { keepOpen: true, rebuild: build, onClose: () => { if (dirty) { invalidate(); render(root); } } });
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
      if (e.target.closest("button, a, input, select")) return; // ▶やリンク等は各自のクリックに任せる
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

const cols = () => [
  { k: "title", label: "タスク" }, { k: "who", label: "担当" }, { k: null, label: "種別" },
  { k: "cat", label: "分類" }, { k: "prio", label: "重要度" }, { k: "due", label: "期限" },
  { k: "est", label: "見積" }, { k: "pct", label: "進捗" }, { k: "state", label: "ステータス" },
];
// ヘッダに何番目のソート軸かを小さく表示（組み合わせの見える化）
const th = (c, manual) => {
  if (!c.k) return `<th>${c.label}</th>`;
  let badge = "";
  if (!manual) {
    const i = V.sorts.findIndex((s) => s.key === c.k);
    if (i >= 0) badge = ` <span class="tb-thord">${i + 1}${V.sorts[i].dir > 0 ? "↑" : "↓"}</span>`;
  }
  return `<th data-k="${c.k}" class="sortable">${c.label}${badge}</th>`;
};

function rowHtml(r, members, i, manual) {
  const id = r.t.id;
  const wn = r.who ? (r.who.name || r.who.username) : "";
  const ava = r.who ? `<span class="tb-ava" style="background:${member_color(r.who.id)}">${esc((wn[0] || "?"))}</span>` : "";
  const whoBtn = `<button class="tb-cell tb-asbtn" data-as="${id}" title="クリックで担当を変更">${ava}${esc(wn || "未設定")}<span class="tb-cell-car">▾</span></button>`;
  const kind = r.review ? `<span class="tb-k review">レビュー</span>` : `<span class="tb-k">タスク</span>`;
  const cats = categoryLabels(r.t);
  const catInner = cats.length ? cats.map((c) => `<span class="tb-cat" style="color:${categoryColor(c)};border-color:${categoryColor(c)}40">${esc(c.title)}</span>`).join(" ") : `<span class="tb-cat none">—</span>`;
  const catBtn = `<button class="tb-cell tb-catbtn" data-cat="${id}" title="クリックで分類を変更">${catInner}<span class="tb-cell-car">▾</span></button>`;
  const pr = r.t.priority || 0;
  const prioInner = pr >= 1 ? `<span class="tb-prio"><i style="background:${PRIO[prioBucket(pr)].c}"></i>${PRIO[prioBucket(pr)].n}</span>` : `<span class="tb-prio-none">なし</span>`;
  const prioBtn = `<button class="tb-cell tb-priobtn" data-prio="${id}" title="クリックで重要度を変更">${prioInner}<span class="tb-cell-car">▾</span></button>`;
  const dueCls = r.due && r.due < todayISO() && !r.done ? "over" : "";
  const dueBtn = `<button class="tb-cell tb-duebtn ${dueCls}" data-due="${id}" title="クリックで期限を変更">${r.due ? r.due.slice(5).replace("-", "/") : "—"}<span class="tb-cell-car">▾</span></button>`;
  const estBtn = `<button class="tb-cell tb-num tb-estbtn" data-est="${id}" title="クリックで見積を変更">${r.est ? fmtH(r.est) : "—"}<span class="tb-cell-car">▾</span></button>`;
  const st = `<button class="tb-st tb-stbtn ${r.done ? "done" : (r.pct > 0 ? "doing" : "todo")}" data-st="${id}" title="クリックでステータス変更">${r.state}<span class="tb-st-car">▾</span></button>`;
  return `<tr data-id="${id}" class="${manual ? "tb-draggable" : ""}${manual && selectedIds.has(id) ? " tb-sel" : ""}">
    <td class="tb-title">${esc(r.title)}${r.t.is_favorite ? ` <span class="tb-fav" title="フラグ">🚩</span>` : ""}${r.fable ? ` <button type="button" class="tb-fable" data-fable="${id}" data-title="${esc(r.title)}" title="Fableに実行させる">▶</button>` : ""}<div class="tb-sub">${esc(r.proj)}</div></td>
    <td>${whoBtn}</td>
    <td>${kind}</td>
    <td>${catBtn}</td>
    <td>${prioBtn}</td>
    <td>${dueBtn}</td>
    <td>${estBtn}</td>
    <td><div class="tb-bar"><i style="width:${r.pct}%"></i></div><span class="tb-pct">${r.pct}%</span></td>
    <td>${st}</td>
  </tr>`;
}

function css() {
  return `
  .tb-tools{display:flex;gap:10px;align-items:center;margin:0 0 14px;flex-wrap:wrap}
  .tb-tools select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff}
  .tb-add{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:600;padding:6px 13px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};cursor:pointer}
  .tb-add::before{content:"+";font-size:15px;color:${C.fill};line-height:1}
  .tb-add:hover{background:${C.track};border-color:#d7dde6}
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
  .tb-ghost-badge{position:absolute;top:-8px;right:-8px;min-width:20px;height:20px;border-radius:10px;background:${C.over};color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 2px 6px rgba(0,0,0,.3)}
  /* 元の場所＝ギャップ: 文字も枠も無く、ただ柔らかい影が落ちているだけに見せる */
  /* 落下ギャップ＝フラットな薄いグレーの空き帯（グラデ無し・継ぎ目無し） */
  .tb tbody tr.tb-ph td{color:transparent!important;border-bottom-color:transparent!important;background:rgba(20,30,50,.08)!important}
  .tb tbody tr.tb-ph td *{visibility:hidden}
  /* カーソル追従の浮きカード（ゴースト） */
  .tb-ghost{filter:drop-shadow(0 10px 24px rgba(20,30,50,.22));transform:scale(1.01);opacity:.45}
  .tb-ghost-tbl{border-collapse:collapse;table-layout:fixed;background:#fff;border:1px solid ${C.line};border-radius:9px;overflow:hidden}
  .tb-ghost-tbl td{padding:10px 12px;border-bottom:0;font-size:13px;vertical-align:middle}
  .tb-ghost-tbl tr + tr td{border-top:1px solid ${C.line}}
  .tb-ctx{position:fixed;z-index:10000;min-width:170px;max-height:340px;overflow-y:auto;background:#fff;border:1px solid ${C.line};border-radius:10px;box-shadow:0 12px 34px rgba(20,30,50,.22);padding:5px;display:flex;flex-direction:column}
  .tb-ctx-inp{font:inherit;font-size:13px;display:flex;align-items:center;gap:8px;justify-content:space-between;padding:7px 12px;color:${C.ink}}
  .tb-ctx-inp input{font:inherit;font-size:12px;border:1px solid ${C.line};border-radius:6px;padding:3px 6px}
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
  .tb th{font-size:11px;color:${C.muted};font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid ${C.line};white-space:nowrap;background:#fafbfc}
  .tb th.sortable{cursor:pointer;user-select:none}.tb th.sortable:hover{color:${C.ink}}
  .tb-thord{font-size:9.5px;color:${C.fill};font-weight:700;background:#eaf2ff;border-radius:5px;padding:0 4px;vertical-align:1px}
  .tb td{padding:10px 12px;border-bottom:1px solid ${C.line};vertical-align:middle}
  .tb tbody tr:hover{background:#f7fbff}
  .tb-title{font-weight:600;min-width:180px}
  .tb-sub{font-size:11px;color:${C.muted};font-weight:400;margin-top:2px}
  .tb-ava{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#fff;font-size:10px;font-weight:700;margin-right:6px;vertical-align:-5px}
  .tb-k{font-size:10.5px;color:${C.muted};border:1px solid ${C.line};border-radius:5px;padding:1px 6px}
  .tb-k.review{color:${C.fill};border-color:#cfe0ff}
  .tb-cat{font-size:10.5px;border:1px solid;border-radius:5px;padding:1px 7px;white-space:nowrap;font-weight:600}
  .tb-cat.none{color:${C.muted};border:0}
  .tb-prio{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.tb-prio i{width:9px;height:9px;border-radius:3px;display:inline-block}
  .tb-num{font-variant-numeric:tabular-nums;white-space:nowrap}
  td.over{color:${C.over};font-weight:600}
  .tb-bar{display:inline-block;width:64px;height:7px;border-radius:5px;background:${C.track};overflow:hidden;vertical-align:middle;margin-right:7px}
  .tb-bar i{display:block;height:100%;background:${C.fill}}
  .tb-pct{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .tb-st{font-size:11px;font-weight:600;border-radius:20px;padding:2px 9px}
  .tb-st.todo{color:${C.muted};background:#f0f1f4}.tb-st.doing{color:${C.fill};background:#eaf2ff}.tb-st.done{color:${C.free};background:#eaf7ef}
  /* ステータスはワンクリックで変更（押せる見た目＝枠＋▾＋hover） */
  .tb-stbtn{font-family:inherit;cursor:pointer;border:1px solid rgba(20,30,50,.12);display:inline-flex;align-items:center;gap:4px;transition:box-shadow .12s,border-color .12s}
  .tb-stbtn:hover{border-color:rgba(20,30,50,.24);box-shadow:0 1px 4px rgba(20,30,50,.16)}
  .tb-st-car{font-size:8px;opacity:.6;margin-right:-1px}
  .tb-ctx-ck{display:inline-block;width:13px;color:${C.fill};font-weight:700}
  /* 一覧から直接編集できるセル＝普段は素／hoverで枠＋▾が出て「押せる」と分かる */
  .tb-cell{font-family:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid transparent;border-radius:7px;padding:3px 7px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;max-width:100%;text-align:left;line-height:1.5}
  .tb-cell:hover{background:#eef4ff;border-color:#dbe7ff}
  .tb-cell.tb-num{font-variant-numeric:tabular-nums}
  .tb-cell.over{color:${C.over};font-weight:600}
  .tb-cell-car{font-size:8px;opacity:0;color:${C.muted};transition:opacity .1s;margin-left:auto;padding-left:2px}
  .tb-cell:hover .tb-cell-car{opacity:.6}
  .tb-prio-none{color:${C.muted}}
  /* クイック絞り込みのチップ列 */
  .tb-quick{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:-4px 0 14px}
  .tb-ql{font-size:11px;color:${C.muted};font-weight:600;margin-right:2px}
  .tb-qsep{width:1px;height:16px;background:${C.line};margin:0 3px}
  .tb-qa{font:inherit;font-size:12px;padding:4px 11px;border:1px solid ${C.line};border-radius:16px;background:#fff;color:${C.ink};cursor:pointer;transition:all .12s}
  .tb-qa:hover{border-color:${C.fill};color:${C.fill}}
  .tb-qa.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:600}
  .tb-qclr{color:${C.muted}}.tb-qclr:hover{color:${C.over};border-color:${C.over}}
  .tb-empty{text-align:center;color:${C.muted};padding:30px}`;
}
