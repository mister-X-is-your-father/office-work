// タスクの追加・編集モーダル（再利用・どの画面からでも開ける）。
// body 直下に append する自己完結モーダル。clock.js の .ck-modal パターンを踏襲。
// 作成=createTaskInProject / 更新=updateTask(#9 非破壊) / 担当=add|removeAssignee /
// プロジェクト(UI呼称)=親タスク。related_tasks.subtask（親に subtask 関連を張る・名前入力で親を新規作成も可）。
// 階層: ワークスペース(=API project) ＞ プロジェクト(=親タスク) ＞ タスク。
import { load, invalidate } from "../lib/store.js";
import { getTask, createTaskInProject, updateTask, addAssignee, removeAssignee, addRelation, removeRelation } from "../lib/api.js";
import { C, esc } from "../lib/ui.js";

const ZERO_DATE = "0001-01-01T00:00:00Z"; // Vikunja の「未設定」センチネル
// Vikunja priority(0–5)。0=なし。4=最優先までを提示。
const PRIO_OPTS = [[0, "なし"], [1, "低"], [2, "中"], [3, "高"], [4, "最優先"]];

// 期日のスマート入力: 数字だけで月日を入力（年は当年を自動補完）。
//   2桁 "62"→6月2日（M+D） / 3桁 "612"→6月12日（M+DD） / 4桁 "1112"→11月12日（MM+DD）
//   区切りありの "6/12"→当年6/12 / "2026/11/12"・"2026-11-12" は年も解釈 / 8桁 "20261112" も可。
// 返り値は ISO の日付 "YYYY-MM-DD"（不正なら null）。
const pad2 = (n) => String(n).padStart(2, "0");
function mkDate(y, mo, da) {
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${y}-${pad2(mo)}-${pad2(da)}`;
}
function parseSmartDate(raw) {
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
const fmtDisplay = (iso) => { const [y, mo, da] = iso.split("-"); return `${y}/${mo}/${da}`; };
// task の日付フィールド（due_date/start_date/end_date）を YYYY/MM/DD 表示に（未設定=空）
const fieldDisplay = (t, f) => (t && t[f] && !t[f].startsWith("0001") ? fmtDisplay(t[f].slice(0, 10)) : "");

let _mounted = false;

// taskId 省略=新規 / 指定=編集。保存後 onSaved() を呼ぶ。
export async function openTaskForm({ taskId = null, onSaved } = {}) {
  const { projects, members, tasks } = await load();
  const task = taskId ? await getTask(taskId) : null;
  const isEdit = !!task;
  const curAssignees = (task && task.assignees) || [];
  const curAssigneeId = curAssignees.length ? curAssignees[0].id : "";
  // 現在の親タスク（編集時）= related_tasks.parenttask の先頭
  const curParent = (task && task.related_tasks && (task.related_tasks.parenttask || [])[0]) || null;
  const curParentId = curParent ? curParent.id : null;

  ensureStyle();
  const wrap = document.createElement("div");
  wrap.className = "tf-modal";
  const projOpts = (projects || []).map((p) =>
    `<option value="${p.id}"${task && task.project_id === p.id ? " selected" : ""}>${esc(p.title)}</option>`).join("");
  const memOpts = `<option value="">（なし）</option>` + (members || []).map((m) =>
    `<option value="${m.id}"${m.id === curAssigneeId ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");
  const prioOpts = PRIO_OPTS.map(([v, n]) =>
    `<option value="${v}"${(task ? (task.priority || 0) : 0) === v ? " selected" : ""}>${n}</option>`).join("");
  const estH = task && task.time_estimate ? Math.round((task.time_estimate / 3600) * 100) / 100 : "";
  // 親タスク候補（自分自身は除外）。既存プロジェクト=subtask 子を持つタスク を優先候補に。
  const candidates = (tasks || []).filter((t) => !task || t.id !== task.id);
  const parentCands = candidates.filter((t) => ((((t.related_tasks || {}).subtask) || []).length > 0));
  const parentIds = new Set(parentCands.map((t) => t.id));
  const curParentTitle = curParent ? curParent.title : "";
  // 先行タスク（依存元）= related_tasks.follows（このタスクが follows する＝その前に完了が必要）
  const curPreds = (task && task.related_tasks && (task.related_tasks.follows || [])) || [];
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  for (const p of curPreds) if (!taskById.has(p.id)) taskById.set(p.id, p);
  const predSet = new Set(curPreds.map((p) => p.id)); // 編集中の作業セット（id）

  wrap.innerHTML = `
    <div class="tf-bg"></div>
    <div class="tf-card" role="dialog" aria-modal="true">
      <div class="tf-h"><b>${isEdit ? "タスクを編集" : "タスクを追加"}</b></div>
      <div class="tf-body">
        <label class="tf-l">タイトル <span class="tf-req">*</span></label>
        <input id="tf-title" class="tf-in" type="text" value="${esc(task ? task.title : "")}" placeholder="やること">
        <div class="tf-row">
          <div class="tf-col">
            <label class="tf-l">ワークスペース <span class="tf-hint">（所属グループ）</span></label>
            <select id="tf-proj" class="tf-in"${isEdit ? " disabled" : ""}>${projOpts}</select>
          </div>
          <div class="tf-col">
            <label class="tf-l">担当</label>
            <select id="tf-asg" class="tf-in">${memOpts}</select>
          </div>
        </div>
        <label class="tf-l">プロジェクト <span class="tf-hint">（任意・入力で検索、無い名前は新規作成）</span></label>
        <div class="tf-cbx">
          <input id="tf-parent" class="tf-in" autocomplete="off" value="${esc(curParentTitle)}" placeholder="プロジェクトを選択 / 名前を入力">
          <div class="tf-cbx-dd" hidden></div>
        </div>
        <div class="tf-row">
          <div class="tf-col">
            <label class="tf-l">優先度</label>
            <select id="tf-prio" class="tf-in">${prioOpts}</select>
          </div>
          <div class="tf-col">
            <label class="tf-l">見積り(h) <span class="tf-hint">（0.25刻み可）</span></label>
            <div class="tf-step">
              <input id="tf-est" class="tf-in" type="text" inputmode="decimal" autocomplete="off" value="${estH}" placeholder="例: 0.25">
              <div class="tf-step-btns">
                <button type="button" id="tf-est-up" tabindex="-1" aria-label="0.25増やす">▲</button>
                <button type="button" id="tf-est-dn" tabindex="-1" aria-label="0.25減らす">▼</button>
              </div>
            </div>
          </div>
        </div>
        <div class="tf-row">
          <div class="tf-col">
            <label class="tf-l">開始予定日 <span class="tf-hint">（ガント開始）</span></label>
            <input id="tf-start" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fieldDisplay(task, "start_date")}" placeholder="例: 1112">
          </div>
          <div class="tf-col">
            <label class="tf-l">終了予定日 <span class="tf-hint">（ガント終了）</span></label>
            <input id="tf-end" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fieldDisplay(task, "end_date")}" placeholder="例: 1120">
          </div>
          <div class="tf-col">
            <label class="tf-l">期日</label>
            <input id="tf-due" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fieldDisplay(task, "due_date")}" placeholder="例: 1112 → 11/12">
          </div>
        </div>
        <label class="tf-l">先行タスク <span class="tf-hint">（このタスクの前に完了が必要・複数可）</span></label>
        <div class="tf-cbx">
          <input id="tf-dep" class="tf-in" autocomplete="off" placeholder="先行タスクを検索して追加">
          <div class="tf-cbx-dd" hidden></div>
        </div>
        <div class="tf-chips" id="tf-dep-chips"></div>
        <label class="tf-l">説明</label>
        <textarea id="tf-desc" class="tf-in tf-ta" rows="3" placeholder="任意">${esc(task ? (task.description || "") : "")}</textarea>
        ${isEdit ? `<label class="tf-chk"><input id="tf-done" type="checkbox"${task.done ? " checked" : ""}> 完了にする</label>` : ""}
        <div class="tf-err" id="tf-err"></div>
      </div>
      <div class="tf-acts">
        <button class="tf-cancel" id="tf-cancel">キャンセル</button>
        <button class="tf-save" id="tf-save">${isEdit ? "保存" : "追加"}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const $ = (id) => wrap.querySelector(id);
  const close = () => { wrap.remove(); };
  wrap.querySelector(".tf-bg").onclick = close;
  $("#tf-cancel").onclick = close;
  $("#tf-title").focus();

  // 日付3欄（開始/終了/期日）: フォーカスを外したら正規表示（YYYY/MM/DD）に整形
  for (const id of ["#tf-start", "#tf-end", "#tf-due"]) {
    const el = $(id);
    el.onblur = () => { const iso = parseSmartDate(el.value); if (iso) el.value = fmtDisplay(iso); };
  }

  // 見積り: ".25" はフォーカスを外したら "0.25" 表示に。↑↓キー/▲▼ボタンで0.25刻み増減。
  const estEl = $("#tf-est");
  estEl.onblur = () => { estEl.value = estEl.value.trim().replace(/^\./, "0."); };
  const estStep = (delta) => {
    const cur = parseFloat(estEl.value.trim().replace(/^\./, "0."));
    const next = Math.max(0, (isFinite(cur) ? cur : 0) + delta);
    estEl.value = next ? String(Math.round(next * 100) / 100) : "";
    estEl.focus();
  };
  estEl.onkeydown = (ev) => {
    if (ev.key === "ArrowUp") { ev.preventDefault(); estStep(0.25); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); estStep(-0.25); }
  };
  $("#tf-est-up").onclick = () => estStep(0.25);
  $("#tf-est-dn").onclick = () => estStep(-0.25);

  // 先行タスク: コンボボックスで選択→チップ追加、× で除去（作業セット predSet を更新）
  const renderChips = () => {
    const el = $("#tf-dep-chips");
    el.innerHTML = [...predSet].map((id) => {
      const t = taskById.get(id);
      return `<span class="tf-chip">${esc(t ? t.title : "#" + id)}<button type="button" class="tf-chip-x" data-id="${id}">×</button></span>`;
    }).join("");
    el.querySelectorAll(".tf-chip-x").forEach((b) => { b.onclick = () => { predSet.delete(+b.dataset.id); renderChips(); }; });
  };
  renderChips();
  const depEl = $("#tf-dep");
  attachCombobox(depEl, {
    items: (q) => {
      const ql = q.toLowerCase();
      return candidates.filter((t) => !predSet.has(t.id) && (!ql || t.title.toLowerCase().includes(ql)));
    },
    onPick: (item) => { if (item) { predSet.add(item.id); renderChips(); } depEl.value = ""; },
  });

  // プロジェクト: 空入力=既存プロジェクト一覧（無ければ全タスク）、入力=全タスク検索（プロジェクト優先）、未一致=新規作成を提示
  const parentEl = $("#tf-parent");
  attachCombobox(parentEl, {
    items: (q) => {
      if (!q) return parentCands.length ? parentCands : candidates;
      const ql = q.toLowerCase(), hit = (t) => t.title.toLowerCase().includes(ql);
      return [...parentCands.filter(hit), ...candidates.filter((t) => !parentIds.has(t.id) && hit(t))];
    },
    createText: (q) => `＋ プロジェクト「${q}」を新規作成`,
    onPick: (item, create) => { parentEl.value = item ? item.title : create; },
  });

  $("#tf-save").onclick = async () => {
    const err = $("#tf-err");
    const title = $("#tf-title").value.trim();
    if (!title) { err.textContent = "タイトルを入力してください。"; return; }
    const parseField = (sel, label) => {
      const raw = $(sel).value.trim();
      if (!raw) return { iso: null, ok: true };
      const iso = parseSmartDate(raw);
      if (!iso) { err.textContent = `${label}の形式が不正です（例: 1112 → 11/12）。`; return { iso: null, ok: false }; }
      return { iso, ok: true };
    };
    const startF = parseField("#tf-start", "開始予定日"); if (!startF.ok) return;
    const endF = parseField("#tf-end", "終了予定日"); if (!endF.ok) return;
    const dueF = parseField("#tf-due", "期日"); if (!dueF.ok) return;
    const startISO = startF.iso, endISO = endF.iso, dueISO = dueF.iso;
    if (startISO && endISO && endISO < startISO) { err.textContent = "終了予定日は開始予定日以降にしてください。"; return; }
    const pid = +$("#tf-proj").value;
    const asg = $("#tf-asg").value ? +$("#tf-asg").value : null;
    const prio = +$("#tf-prio").value;
    // 見積り: ".25"→0.25 の先頭ドット補完つき自前パース（0.25h=15分 刻みを許容）
    const estVal = $("#tf-est").value.trim().replace(/^\./, "0.");
    const estNum = estVal ? parseFloat(estVal) : 0;
    if (estVal && (!isFinite(estNum) || estNum < 0)) { err.textContent = "見積りは0以上の数値(h)で入力してください。"; return; }
    const estSec = estVal ? Math.round(estNum * 3600) : 0;
    const desc = $("#tf-desc").value;

    const parentRaw = $("#tf-parent").value.trim();

    const btn = $("#tf-save");
    btn.disabled = true; err.textContent = "";
    try {
      const dt = (iso) => iso + "T00:00:00Z";
      let childId;
      if (!isEdit) {
        const body = { title, description: desc, priority: prio, time_estimate: estSec };
        if (dueISO) body.due_date = dt(dueISO);
        if (startISO) body.start_date = dt(startISO);
        if (endISO) body.end_date = dt(endISO);
        const created = await createTaskInProject(pid, body);
        childId = created.id;
        if (asg) await addAssignee(childId, asg);
      } else {
        const patch = {
          title, description: desc, priority: prio,
          due_date: dueISO ? dt(dueISO) : ZERO_DATE,
          start_date: startISO ? dt(startISO) : ZERO_DATE,
          end_date: endISO ? dt(endISO) : ZERO_DATE,
          time_estimate: estSec,
          done: $("#tf-done").checked,
        };
        await updateTask(task.id, patch);
        childId = task.id;
        // 担当 diff（v1=単一担当）
        for (const a of curAssignees) if (a.id !== asg) await removeAssignee(task.id, a.id);
        if (asg && asg !== curAssigneeId) await addAssignee(task.id, asg);
      }

      // 先行タスク diff（このタスクが follows する＝前に完了が必要）。
      // capacity.js dependencyEdges は follows を rel→t（前→後）に正規化。逆 precedes は自動付与。
      const curPredIds = new Set(curPreds.map((p) => p.id));
      for (const pid2 of predSet) if (pid2 !== childId && !curPredIds.has(pid2)) await addRelation(childId, pid2, "follows");
      for (const pid2 of curPredIds) if (!predSet.has(pid2)) await removeRelation(childId, "follows", pid2);

      // 親タスクの解決（既存タイトル一致=その親 / 新名=同ワークスペースに親を新規作成）と関連 diff。
      // 親が子を持つ＝親側に subtask 関連を張る（capacity.js buildTaskTree と整合）。
      let parentId = null;
      if (parentRaw) {
        const existing = (tasks || []).find((t) => t.title === parentRaw && t.id !== childId);
        parentId = existing ? existing.id : (await createTaskInProject(pid, { title: parentRaw })).id;
      }
      if (parentId !== curParentId) {
        if (curParentId) await removeRelation(curParentId, "subtask", childId);
        if (parentId) await addRelation(parentId, childId, "subtask");
      }

      invalidate();
      close();
      onSaved && onSaved();
    } catch (e) {
      btn.disabled = false;
      err.textContent = "× " + e.message;
    }
  };
}

// 自前コンボボックス（datalist はブラウザ依存で挙動が独特なため自前描画）。
// items(q)=候補配列 / createText(q)=未一致入力の「新規作成」行（省略=作成不可） / onPick(item, createTitle)。
// 矢印キーで選択・Enter確定・Esc/フォーカス外で閉じる。
function attachCombobox(input, { items, createText, onPick }) {
  const dd = input.parentElement.querySelector(".tf-cbx-dd");
  let list = [], idx = -1;
  const close = () => { dd.hidden = true; idx = -1; };
  const paint = () => dd.querySelectorAll(".tf-cbx-it").forEach((el, i) => el.classList.toggle("on", i === idx));
  const open = () => {
    const q = input.value.trim();
    const hits = items(q);
    list = hits.slice(0, 8).map((t) => ({ item: t }));
    if (createText && q && !hits.some((t) => t.title === q)) list.push({ create: q });
    if (!list.length) return close();
    dd.innerHTML = list.map((e, i) => e.item
      ? `<div class="tf-cbx-it" data-i="${i}">${esc(e.item.title)}</div>`
      : `<div class="tf-cbx-it tf-cbx-new" data-i="${i}">${esc(createText(e.create))}</div>`).join("");
    dd.hidden = false; paint();
    dd.querySelectorAll(".tf-cbx-it").forEach((el) => {
      el.onmousedown = (ev) => { ev.preventDefault(); pick(+el.dataset.i); }; // blurより先に確定
      el.onmouseenter = () => { idx = +el.dataset.i; paint(); };
    });
  };
  const pick = (i) => { const e = list[i]; if (!e) return; onPick(e.item || null, e.create || null); close(); input.blur(); };
  input.onfocus = open;
  input.oninput = open;
  input.onblur = () => setTimeout(close, 120);
  input.onkeydown = (ev) => {
    if (ev.key === "Escape") return close();
    if (dd.hidden) { if (ev.key === "ArrowDown") { ev.preventDefault(); open(); } return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); idx = (idx + 1) % list.length; paint(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); idx = (idx - 1 + list.length) % list.length; paint(); }
    else if (ev.key === "Enter") { ev.preventDefault(); pick(idx >= 0 ? idx : 0); }
  };
}

function ensureStyle() {
  if (_mounted) return; _mounted = true;
  const s = document.createElement("style");
  s.textContent = `
  .tf-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center}
  .tf-bg{position:absolute;inset:0;background:rgba(20,30,50,.38)}
  .tf-card{position:relative;width:min(560px,92vw);max-height:90vh;overflow:auto;background:${C.card};border:1px solid ${C.line};border-radius:16px;box-shadow:0 18px 50px rgba(20,30,50,.28)}
  .tf-h{padding:18px 22px 4px;font-size:16px}.tf-h b{font-size:16px}
  .tf-body{padding:8px 22px 4px}
  .tf-l{display:block;font-size:12px;color:${C.muted};font-weight:600;margin:12px 0 5px}
  .tf-req{color:${C.over}}
  .tf-hint{font-weight:400;color:${C.muted};font-size:11px}
  .tf-in{width:100%;font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid ${C.line};border-radius:9px;background:#fff;box-sizing:border-box;color:${C.ink}}
  .tf-in:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .tf-in:disabled{background:#f4f6f9;color:${C.muted}}
  .tf-ta{resize:vertical;line-height:1.45}
  .tf-row{display:flex;gap:12px}.tf-col{flex:1;min-width:0}
  .tf-chk{display:flex;align-items:center;gap:7px;font-size:13px;color:${C.ink};margin:14px 0 4px;cursor:pointer}
  .tf-step{position:relative}
  .tf-step .tf-in{padding-right:30px}
  .tf-step-btns{position:absolute;top:1px;right:1px;bottom:1px;width:24px;display:flex;flex-direction:column;border-left:1px solid ${C.line};border-radius:0 8px 8px 0;overflow:hidden}
  .tf-step-btns button{flex:1;border:0;background:#fff;color:${C.muted};cursor:pointer;font-size:8px;padding:0;line-height:1}
  .tf-step-btns button:hover{background:#eef4ff;color:${C.fill}}
  .tf-cbx{position:relative}
  .tf-cbx-dd{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:5;background:#fff;border:1px solid ${C.line};border-radius:10px;box-shadow:0 10px 30px rgba(20,30,50,.16);max-height:228px;overflow:auto;padding:4px}
  .tf-cbx-it{padding:8px 10px;font-size:13px;border-radius:7px;cursor:pointer;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tf-cbx-it.on{background:#eef4ff}
  .tf-cbx-new{color:${C.fill};font-weight:600}
  .tf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .tf-chip{display:inline-flex;align-items:center;gap:4px;background:#eef2f7;border:1px solid ${C.line};border-radius:20px;padding:3px 5px 3px 11px;font-size:12px;color:${C.ink}}
  .tf-chip-x{border:0;background:transparent;color:${C.muted};cursor:pointer;font-size:14px;line-height:1;padding:0 3px}
  .tf-chip-x:hover{color:${C.over}}
  .tf-err{color:${C.over};font-size:12.5px;min-height:18px;margin:8px 0 2px;font-weight:600}
  .tf-acts{display:flex;justify-content:flex-end;gap:10px;padding:6px 22px 20px}
  .tf-acts button{font:inherit;font-size:13.5px;font-weight:600;padding:9px 18px;border-radius:9px;cursor:pointer;border:1px solid ${C.line}}
  .tf-cancel{background:#fff;color:${C.muted}}.tf-cancel:hover{color:${C.ink}}
  .tf-save{background:${C.fill};color:#fff;border-color:${C.fill}}.tf-save:hover{filter:brightness(1.05)}
  .tf-save:disabled{opacity:.6;cursor:default}
  @media(max-width:560px){.tf-row{flex-direction:column;gap:0}}`;
  document.head.appendChild(s);
}
