// タスク一覧（表・mock60 相当）。**複数軸の組み合わせソート**＋**個人ごとの並び順**（マイソート＝手動）。
// 並び設定（ソート軸の連なり・手動順・絞り込み）は **見ている本人ごとに localStorage 保存**＝
// 共有データ（DB）は一切変えないので、誰がどう並べても他メンバーの見え方に影響しない（衝突しない）。
import { load, invalidate, projectName, isAiUser } from "../lib/store.js";
import { savePresets } from "../lib/exec.js";
import { PRIO, prioBucket, kindOf, isReviewTask, categoryLabels, categoryColor } from "../lib/kinds.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const HOUR = 3600;
const MAX_SORTS = 5; // 組めるソート条件の上限（第1〜第5条件）
const VKEY = (uid) => `ts.list.view.${uid ?? "anon"}`;
function loadView(uid) {
  const def = { sorts: [{ key: "due", dir: 1 }], manualMode: false, order: [], hideDone: true, proj: "", cat: "" };
  try {
    const raw = JSON.parse(localStorage.getItem(VKEY(uid)) || "null");
    if (!raw) return { ...def };                       // 初回のみ既定（期日）
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

const stateOf = (t) => (t.done ? "完了" : ((t.percent_done || 0) > 0 ? "進行中" : "未着手"));
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");

// 軸の定義: ラベル＋比較関数（行 r を受ける）＋セレクトで選んだ時の既定の向き。
const AXES = {
  due:     { label: "期日",      cmp: (a, b) => (a.due || "9999").localeCompare(b.due || "9999"), dir: 1 },
  prio:    { label: "優先度",    cmp: (a, b) => a.prio - b.prio, dir: -1 },
  ws:      { label: "WS",        cmp: (a, b) => a.proj.localeCompare(b.proj, "ja"), dir: 1 },
  cat:     { label: "分類",      cmp: (a, b) => ((a.cat && a.cat.title) || "～").localeCompare((b.cat && b.cat.title) || "～", "ja"), dir: 1 },
  who:     { label: "担当",      cmp: (a, b) => ((a.who && (a.who.name || a.who.username)) || "～").localeCompare((b.who && (b.who.name || b.who.username)) || "～", "ja"), dir: 1 },
  state:   { label: "状態",      cmp: (a, b) => stateRank(a) - stateRank(b), dir: 1 },
  pct:     { label: "進捗",      cmp: (a, b) => a.pct - b.pct, dir: -1 },
  est:     { label: "見積",      cmp: (a, b) => a.est - b.est, dir: -1 },
  flag:    { label: "フラグ",    cmp: (a, b) => (a.t.is_favorite ? 1 : 0) - (b.t.is_favorite ? 1 : 0), dir: -1 },
  created: { label: "追加日",    cmp: (a, b) => String(a.t.created || "").localeCompare(String(b.t.created || "")), dir: -1 },
  title:   { label: "タスク名",  cmp: (a, b) => a.title.localeCompare(b.title, "ja"), dir: 1 },
};
const stateRank = (r) => (r.done ? 2 : (r.pct > 0 ? 1 : 0)); // 未着手→進行中→完了
const tieBreak = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.t.id - b.t.id;

export async function render(root) {
  const { tasks, projects, members, me = null, settings = {} } = await load();
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

  const manual = V.manualMode;
  if (manual) {
    const allIds = rows.map((r) => r.t.id);
    const have = new Set(V.order), allSet = new Set(allIds);
    V.order = [...V.order.filter((id) => allSet.has(id)), ...allIds.filter((id) => !have.has(id))];
    saveView(UID, V);
    const pos = new Map(V.order.map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(a.t.id) ?? 1e9) - (pos.get(b.t.id) ?? 1e9));
  } else {
    // 複数軸の組み合わせ（先頭が第1キー…一致したら次の軸へ）。最後に期日→IDで安定化。
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
      <span class="tb-sortwrap${manual ? " dim" : ""}">ソート条件: <span class="tb-chips">${chips || `<span class="tb-sc-none">なし（既定: 期日順）</span>`}</span>
        ${V.sorts.length < MAX_SORTS ? `<select id="tb-addsort" class="tb-addsort">${addOpts}</select>` : `<span class="tb-sc-none">最大${MAX_SORTS}件</span>`}</span>
      <select id="tb-proj">${projOpts}</select>
      <select id="tb-cat">${catOpts}</select>
      <label class="tb-chk"><input type="checkbox" id="tb-hd" ${V.hideDone ? "checked" : ""}> 完了を隠す</label>
    </div>
    ${manual ? `<div class="tb-mynote">「マイソート」はあなただけの順番です（この端末に保存・他のメンバーには影響しません）。組み合わせソートに戻すには「✋ マイソート」をもう一度。</div>
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
  root.querySelector("#tb-hd").onchange = (e) => { V.hideDone = e.target.checked; reRender(); };
  root.querySelector("#tb-add").onclick = () => openTaskForm({ onSaved: () => render(root) });
  // 条件を追加（最大5件・5件到達時はセレクト自体を出さない）。マイソート中なら組み合わせソートに切替
  const addSel = root.querySelector("#tb-addsort");
  if (addSel) addSel.onchange = (e) => {
    const k = e.target.value; if (!k || V.sorts.length >= MAX_SORTS) return;
    V.sorts.push({ key: k, dir: AXES[k].dir }); V.manualMode = false; reRender();
  };
  // チップ: 向き切替 / 削除（最後の1件も外せる＝条件なし=既定の期日順）
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
  });
  root.querySelectorAll(".tb-fable").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation(); b.disabled = true;
      try { const { runAi } = await import("../lib/exec.js"); const j = await runAi(+b.dataset.fable, b.dataset.title); b.textContent = "⏵…"; b.title = `キュー #${j.job.id} に追加済み`; }
      catch { b.disabled = false; }
    };
  });

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
}

// プリセット名の候補（軸ラベルを連結）
function presetSuggest(sorts) {
  return (sorts || []).map((s) => (AXES[s.key] ? AXES[s.key].label : s.key) + (s.dir > 0 ? "↑" : "↓")).join("・") || "マイプリセット";
}

// ポインタイベント方式の並べ替え（HTML5 DnDより確実・タッチ対応）。
// マイソート中は**行のどこを掴んでもドラッグ**（かんばん風）。動かさず離せばタップ＝編集モーダル。
function wireDrag(root, rerender) {
  const tbody = root.querySelector("tbody");
  const rowsArr = () => [...tbody.querySelectorAll("tr[data-id]")];
  rowsArr().forEach((dragRow) => {
    dragRow.addEventListener("pointerdown", (e) => {
      if (e.button && e.button !== 0) return;                 // 左クリック/主ポインタのみ
      if (e.target.closest("button, a, input, select")) return; // ▶やリンク等は各自のクリックに任せる
      const dragId = +dragRow.dataset.id;
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      // 移動中はDOMを実際に並べ替える＝「移動後の状態」がそのままライブで見える（よくあるやつ）
      const move = (ev) => {
        if (!moved && (Math.abs(ev.clientY - startY) > 4 || Math.abs(ev.clientX - startX) > 4)) {
          moved = true; dragRow.classList.add("tb-dragging"); document.body.classList.add("tb-dragging-body");
        }
        if (!moved) return;
        // ポインタ位置の直上にある行の前/後ろへ dragRow を実挿入
        let placed = false;
        for (const tr of rowsArr()) {
          if (tr === dragRow) continue;
          const r = tr.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            if (dragRow.nextSibling !== tr) tbody.insertBefore(dragRow, tr); // 既にその位置なら触らない
            placed = true; break;
          }
        }
        if (!placed && tbody.lastElementChild !== dragRow) tbody.appendChild(dragRow); // 一番下
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        dragRow.classList.remove("tb-dragging"); document.body.classList.remove("tb-dragging-body");
        if (!moved) { openTaskForm({ taskId: dragId, onSaved: rerender }); return; } // タップ＝編集
        // 現在のDOM順＝確定順。非表示(フィルタ外)分は元の位置を保持して全体順を再構築
        const vis = rowsArr().map((x) => +x.dataset.id);
        const visSet = new Set(vis); let vi = 0; const next = [];
        for (const id of V.order) next.push(visSet.has(id) ? vis[vi++] : id);
        while (vi < vis.length) next.push(vis[vi++]);
        V.order = [...new Set(next)];
        saveView(UID, V);
        rerender();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  });
}

const cols = () => [
  { k: "title", label: "タスク" }, { k: "who", label: "担当" }, { k: null, label: "種別" },
  { k: "cat", label: "分類" }, { k: "prio", label: "優先度" }, { k: "due", label: "期日" },
  { k: "est", label: "見積" }, { k: "pct", label: "進捗" }, { k: "state", label: "状態" },
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
  const wn = r.who ? (r.who.name || r.who.username) : "—";
  const ava = r.who ? `<span class="tb-ava" style="background:${member_color(r.who.id)}">${esc((wn[0] || "?"))}</span>` : "";
  const kind = r.review ? `<span class="tb-k review">レビュー</span>` : `<span class="tb-k">タスク</span>`;
  const cat = r.cat ? `<span class="tb-cat" style="color:${categoryColor(r.cat)};border-color:${categoryColor(r.cat)}40">${esc(r.cat.title)}</span>` : `<span class="tb-cat none">—</span>`;
  const pc = PRIO[r.prio];
  const prio = `<span class="tb-prio"><i style="background:${pc.c}"></i>${pc.n}</span>`;
  const dueCls = r.due && r.due < todayISO() && !r.done ? "over" : "";
  const st = `<span class="tb-st ${r.done ? "done" : (r.pct > 0 ? "doing" : "todo")}">${r.state}</span>`;
  return `<tr data-id="${r.t.id}" class="${manual ? "tb-draggable" : ""}">
    <td class="tb-title">${esc(r.title)}${r.t.is_favorite ? ` <span class="tb-fav" title="フラグ">🚩</span>` : ""}${r.fable ? ` <button type="button" class="tb-fable" data-fable="${r.t.id}" data-title="${esc(r.title)}" title="Fableに実行させる">▶</button>` : ""}<div class="tb-sub">${esc(r.proj)}</div></td>
    <td>${ava}${esc(wn)}</td>
    <td>${kind}</td>
    <td>${cat}</td>
    <td>${prio}</td>
    <td class="${dueCls}">${r.due ? r.due.slice(5).replace("-", "/") : "—"}</td>
    <td class="tb-num">${r.est ? fmtH(r.est) : "—"}</td>
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
  .tb tbody tr.tb-dragging{opacity:.4}
  .tb tbody tr.tb-over td{box-shadow:inset 0 2px 0 ${C.fill}}
  .tb tbody tr.tb-over-bottom td{box-shadow:inset 0 -2px 0 ${C.fill}}
  .tb tbody tr.tb-draggable{cursor:grab;user-select:none;touch-action:pan-y}
  .tb tbody tr.tb-draggable.tb-dragging{cursor:grabbing;background:#eaf2ff}
  .tb tbody tr.tb-draggable.tb-dragging td{box-shadow:inset 0 1px 0 ${C.fill},inset 0 -1px 0 ${C.fill}}
  .tb tbody tr.tb-draggable.tb-dragging td:first-child{box-shadow:inset 3px 0 0 ${C.fill},inset 0 1px 0 ${C.fill},inset 0 -1px 0 ${C.fill}}
  /* ドラッグ中は他行のホバー背景を消してプレビューを見やすく */
  body.tb-dragging-body .tb tbody tr:hover{background:transparent}
  body.tb-dragging-body{cursor:grabbing}
  body.tb-dragging-body .tb tbody tr.tb-dragging:hover{background:#eaf2ff}
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
  .tb-empty{text-align:center;color:${C.muted};padding:30px}`;
}
