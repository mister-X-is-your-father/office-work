// かんばん（mock59 相当・実データ）。Vikunja 0.24 のプロジェクトビュー＋バケットをそのまま使う。
// 列=バケット（追加/名前変更/空なら削除）、カード=タスク（ドラッグで列移動・クリックで編集）。
import { load, invalidate, isAiUser } from "../lib/store.js";
import { getProjectDetail, getViewTasks, createBucket, renameBucket, deleteBucket, moveTaskToBucket } from "../lib/api.js";
import { PRIO, prioBucket } from "../lib/kinds.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";

const WS_KEY = "ts.kanban.ws";
let _root, _pid, _vid;

export async function render(root) {
  _root = root;
  const { projects, templateProject, members } = await load();
  const wsList = (projects || []).filter((p) => !templateProject || p.id !== templateProject.id);
  if (!wsList.length) { root.innerHTML = `<h1 class="vtitle">かんばん</h1><div class="card"><div class="loading">ワークスペースがありません</div></div>`; return; }
  let saved = null; try { saved = +localStorage.getItem(WS_KEY) || null; } catch { /* noop */ }
  _pid = wsList.some((p) => p.id === saved) ? saved : wsList[0].id;

  const detail = await getProjectDetail(_pid);
  const kanban = (detail.views || []).find((v) => v.view_kind === "kanban");
  if (!kanban) { root.innerHTML = `<h1 class="vtitle">かんばん</h1><div class="card"><div class="loading">このワークスペースにかんばんビューがありません</div></div>`; return; }
  _vid = kanban.id;
  const buckets = await getViewTasks(_pid, _vid) || [];
  const memberIdx = new Map((members || []).map((m, i) => [m.id, i]));
  const today = todayISO();

  const wsOpts = wsList.map((p) => `<option value="${p.id}"${p.id === _pid ? " selected" : ""}>${esc(p.title)}</option>`).join("");
  const bucketList = buckets.map((b) => ({ id: b.id, title: b.title }));
  const colHtml = (b) => {
    const tasks = (b.tasks || []);
    const cards = tasks.map((t) => cardHtml(t, memberIdx, today, b.id, bucketList)).join("");
    return `<div class="kb-col" data-bucket="${b.id}">
      <div class="kb-colh">
        <span class="kb-colt" data-rename="${b.id}" role="button" tabindex="0" title="クリックで名前変更">${esc(b.title)}</span>
        <span class="kb-cnt">${tasks.length}</span>
        ${tasks.length === 0 ? `<button class="kb-del" data-del="${b.id}" title="空の列を削除" aria-label="${esc(b.title)} の列を削除">×</button>` : ""}
      </div>
      <div class="kb-cards" data-bucket="${b.id}">${cards}</div>
    </div>`;
  };

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">かんばん <small>ドラッグ／「列▾」で移動 ・ クリックで編集</small></h1>
    <div class="kb-tools">
      <select id="kb-ws" class="kb-sel">${wsOpts}</select>
      <input id="kb-newcol" class="kb-newcol" placeholder="＋ 列を追加（名前を入れて Enter）">
    </div>
    <div class="kb-board">${buckets.map(colHtml).join("")}</div>`;

  root.querySelector("#kb-ws").onchange = (e) => {
    try { localStorage.setItem(WS_KEY, e.target.value); } catch { /* noop */ }
    render(root);
  };
  root.querySelector("#kb-newcol").onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    const title = e.target.value.trim();
    if (!title) return;
    await createBucket(_pid, _vid, title);
    render(root);
  };
  root.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("この空の列を削除しますか？")) return;
      await deleteBucket(_pid, _vid, +b.dataset.del); render(root);
    };
  });
  root.querySelectorAll("[data-rename]").forEach((el) => {
    const startRename = () => {
      const cur = el.textContent;
      const input = document.createElement("input");
      input.className = "kb-renin";
      input.value = cur;
      el.replaceWith(input);
      input.focus(); input.select();
      const commit = async () => {
        const v = input.value.trim();
        if (v && v !== cur) await renameBucket(_pid, _vid, +el.dataset.rename, v);
        render(_root);
      };
      input.onkeydown = (ev) => { if (ev.key === "Enter") commit(); if (ev.key === "Escape") render(_root); };
      input.onblur = commit;
    };
    el.onclick = startRename;
    el.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); startRename(); } };
  });
  root.querySelectorAll(".kb-card").forEach((card) => {
    const edit = () => openTaskForm({ taskId: +card.dataset.id, onSaved: () => { invalidate(); render(_root); } });
    card.onclick = edit;
    card.addEventListener("keydown", (e) => {
      if (e.target !== card) return; // 内部のコントロール由来は無視
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); }
    });
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", card.dataset.id); } catch { /* noop */ }
      card.classList.add("kb-dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("kb-dragging"));
  });
  // 列移動コントロール（ドラッグ以外の手段）: クリック編集と競合させない
  root.querySelectorAll(".kb-move").forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onkeydown = (e) => e.stopPropagation();
    sel.onchange = async (e) => {
      e.stopPropagation();
      const target = +sel.value;
      const taskId = +sel.dataset.task;
      if (!target || !taskId) return;
      await moveTaskToBucket(_pid, _vid, target, taskId);
      render(_root);
    };
  });
  root.querySelectorAll(".kb-cards").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      const taskId = +e.dataTransfer.getData("text/plain");
      if (!taskId) return;
      await moveTaskToBucket(_pid, _vid, +col.dataset.bucket, taskId);
      render(_root);
    });
  });
}

function cardHtml(t, memberIdx, today, curBucketId, bucketList) {
  const who = (t.assignees || []).find((a) => !isAiUser(a)) || null; // AI担当(隠し要素)は出さない
  const pb = prioBucket(t.priority);
  const due = t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : null;
  const overdue = due && due < today && !t.done;
  const est = t.time_estimate ? fmtH(t.time_estimate / 3600) : null;
  const ava = who ? `<span class="kb-ava" style="background:${member_color(memberIdx.get(who.id) ?? 0)}">${esc((who.name || who.username || "?")[0])}</span>` : "";
  const others = (bucketList || []).filter((b) => b.id !== curBucketId);
  const moveSel = others.length
    ? `<select class="kb-move" data-task="${t.id}" title="別の列へ移動" aria-label="${esc(t.title)} を別の列へ移動">
        <option value="" selected>列▾</option>
        ${others.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join("")}
      </select>`
    : "";
  return `<div class="kb-card${t.done ? " done" : ""}" draggable="true" data-id="${t.id}" tabindex="0" role="button" aria-label="${esc(t.title)} を編集">
    <div class="kb-ct"><i class="kb-prio" style="background:${pb ? PRIO[pb].c : "#c6cdd6"}"></i>${esc(t.title)}</div>
    <div class="kb-cm">
      ${ava}
      ${due ? `<span class="kb-due${overdue ? " late" : ""}">${due.slice(5).replace("-", "/")}</span>` : ""}
      ${est ? `<span class="kb-est">${est}</span>` : ""}
      ${t.done ? `<span class="kb-donetag">完了</span>` : ""}
      ${moveSel}
    </div>
  </div>`;
}

function css() {
  return `
  .kb-tools{display:flex;gap:10px;margin-bottom:14px;align-items:center}
  .kb-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid ${C.line};border-radius:9px;background:#fff}
  .kb-newcol{font:inherit;font-size:12.5px;padding:7px 12px;border:1px dashed ${C.line};border-radius:9px;background:transparent;width:240px}
  .kb-newcol:focus{outline:none;border-color:${C.fill};background:#fff}
  .kb-board{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:10px}
  .kb-col{flex:0 0 260px;background:#f0f2f5;border:1px solid ${C.line};border-radius:12px;padding:10px}
  .kb-colh{display:flex;align-items:center;gap:7px;margin-bottom:8px;padding:0 2px}
  .kb-colt{font-size:13px;font-weight:700;cursor:text}
  .kb-cnt{font-size:11px;color:${C.muted};background:#fff;border:1px solid ${C.line};border-radius:10px;padding:1px 8px}
  .kb-del{margin-left:auto;border:0;background:transparent;color:${C.muted};cursor:pointer;font-size:14px;line-height:1;padding:4px 8px;border-radius:6px}
  .kb-del:hover{color:${C.over};background:#fff}
  .kb-renin{font:inherit;font-size:13px;font-weight:700;border:1px solid ${C.fill};border-radius:6px;padding:2px 6px;width:140px}
  .kb-cards{display:flex;flex-direction:column;gap:8px;min-height:60px;border-radius:8px}
  .kb-cards.over{background:#e8f1ff}
  .kb-card{background:#fff;border:1px solid ${C.line};border-radius:10px;padding:10px 12px;cursor:grab;box-shadow:0 1px 2px rgba(20,30,50,.06)}
  .kb-card:hover{border-color:${C.fill}}
  .kb-card:focus-visible{outline:2px solid ${C.fill};outline-offset:2px}
  .kb-colt:focus-visible{outline:2px solid ${C.fill};outline-offset:2px;border-radius:4px}
  .kb-move{margin-left:6px;font:inherit;font-size:11px;color:${C.muted};border:1px solid ${C.line};border-radius:7px;background:#f7f8fa;padding:1px 4px;cursor:pointer;max-width:96px}
  .kb-move:hover{border-color:${C.fill};color:${C.fill}}
  .kb-move:focus-visible{outline:2px solid ${C.fill};outline-offset:1px}
  .kb-card.kb-dragging{opacity:.5}
  .kb-card.done{opacity:.55}
  .kb-ct{font-size:12.5px;font-weight:600;line-height:1.35;display:flex;gap:6px;align-items:baseline}
  .kb-prio{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;transform:translateY(-1px)}
  .kb-cm{display:flex;gap:8px;align-items:center;margin-top:7px;min-height:18px}
  .kb-ava{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:700}
  .kb-due{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums}
  .kb-due.late{color:${C.over};font-weight:700}
  .kb-est{font-size:11px;color:${C.muted};margin-left:auto;font-variant-numeric:tabular-nums}
  .kb-donetag{font-size:10px;color:${C.free};border:1px solid ${C.free};border-radius:8px;padding:0 6px}

  /* ---- ダークモード上書き（ライト値は上で維持。ここでハードコード淡色のみ反転） ---- */
  html[data-theme="dark"] .kb-sel{background:var(--card)}
  html[data-theme="dark"] .kb-newcol:focus{background:var(--card)}
  html[data-theme="dark"] .kb-col{background:var(--track)}
  html[data-theme="dark"] .kb-cnt{background:var(--card);border-color:var(--line)}
  html[data-theme="dark"] .kb-del:hover{background:rgba(255,255,255,.06)}
  html[data-theme="dark"] .kb-cards.over{background:rgba(255,255,255,.06)}
  html[data-theme="dark"] .kb-card{background:var(--card);border-color:var(--line);box-shadow:0 1px 2px rgba(0,0,0,.35)}
  html[data-theme="dark"] .kb-card:hover{border-color:${C.fill}}
  html[data-theme="dark"] .kb-move{background:rgba(255,255,255,.05);border-color:var(--line)}
  html[data-theme="dark"] .kb-move:hover{border-color:${C.fill}}`;
}
