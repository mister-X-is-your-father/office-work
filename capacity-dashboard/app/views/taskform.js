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
const dueDisplay = (t) => (t && t.due_date && !t.due_date.startsWith("0001") ? fmtDisplay(t.due_date.slice(0, 10)) : "");

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
  const estH = task && task.time_estimate ? Math.round((task.time_estimate / 3600) * 10) / 10 : "";
  // 親タスク候補（自分自身は除外）＝既存タイトルの候補リスト
  const parentOpts = (tasks || []).filter((t) => !task || t.id !== task.id)
    .map((t) => `<option value="${esc(t.title)}"></option>`).join("");
  const curParentTitle = curParent ? curParent.title : "";

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
        <label class="tf-l">プロジェクト <span class="tf-hint">（任意・新しい名前を入れると新規作成）</span></label>
        <input id="tf-parent" class="tf-in" list="tf-parent-list" autocomplete="off" value="${esc(curParentTitle)}" placeholder="既存のプロジェクトを選ぶ / 新しいプロジェクト名を入力">
        <datalist id="tf-parent-list">${parentOpts}</datalist>
        <div class="tf-row">
          <div class="tf-col">
            <label class="tf-l">優先度</label>
            <select id="tf-prio" class="tf-in">${prioOpts}</select>
          </div>
          <div class="tf-col">
            <label class="tf-l">期日</label>
            <input id="tf-due" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${dueDisplay(task)}" placeholder="例: 1112 → 11/12">
          </div>
          <div class="tf-col">
            <label class="tf-l">見積り(h)</label>
            <input id="tf-est" class="tf-in" type="number" min="0" step="0.5" value="${estH}" placeholder="—">
          </div>
        </div>
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

  // 期日: フォーカスを外したら正規表示（YYYY/MM/DD）に整形
  const dueEl = $("#tf-due");
  dueEl.onblur = () => { const iso = parseSmartDate(dueEl.value); if (iso) dueEl.value = fmtDisplay(iso); };

  $("#tf-save").onclick = async () => {
    const err = $("#tf-err");
    const title = $("#tf-title").value.trim();
    if (!title) { err.textContent = "タイトルを入力してください。"; return; }
    const dueRaw = $("#tf-due").value.trim();
    const dueISO = dueRaw ? parseSmartDate(dueRaw) : null;
    if (dueRaw && !dueISO) { err.textContent = "期日の形式が不正です（例: 1112 → 11/12）。"; return; }
    const pid = +$("#tf-proj").value;
    const asg = $("#tf-asg").value ? +$("#tf-asg").value : null;
    const prio = +$("#tf-prio").value;
    const estVal = $("#tf-est").value;
    const estSec = estVal ? Math.round(parseFloat(estVal) * 3600) : 0;
    const desc = $("#tf-desc").value;

    const parentRaw = $("#tf-parent").value.trim();

    const btn = $("#tf-save");
    btn.disabled = true; err.textContent = "";
    try {
      let childId;
      if (!isEdit) {
        const body = { title, description: desc, priority: prio, time_estimate: estSec };
        if (dueISO) body.due_date = dueISO + "T00:00:00Z";
        const created = await createTaskInProject(pid, body);
        childId = created.id;
        if (asg) await addAssignee(childId, asg);
      } else {
        const patch = {
          title, description: desc, priority: prio,
          due_date: dueISO ? dueISO + "T00:00:00Z" : ZERO_DATE,
          time_estimate: estSec,
          done: $("#tf-done").checked,
        };
        await updateTask(task.id, patch);
        childId = task.id;
        // 担当 diff（v1=単一担当）
        for (const a of curAssignees) if (a.id !== asg) await removeAssignee(task.id, a.id);
        if (asg && asg !== curAssigneeId) await addAssignee(task.id, asg);
      }

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
  .tf-err{color:${C.over};font-size:12.5px;min-height:18px;margin:8px 0 2px;font-weight:600}
  .tf-acts{display:flex;justify-content:flex-end;gap:10px;padding:6px 22px 20px}
  .tf-acts button{font:inherit;font-size:13.5px;font-weight:600;padding:9px 18px;border-radius:9px;cursor:pointer;border:1px solid ${C.line}}
  .tf-cancel{background:#fff;color:${C.muted}}.tf-cancel:hover{color:${C.ink}}
  .tf-save{background:${C.fill};color:#fff;border-color:${C.fill}}.tf-save:hover{filter:brightness(1.05)}
  .tf-save:disabled{opacity:.6;cursor:default}
  @media(max-width:560px){.tf-row{flex-direction:column;gap:0}}`;
  document.head.appendChild(s);
}
