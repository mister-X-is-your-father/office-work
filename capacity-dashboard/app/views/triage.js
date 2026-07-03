// 優先度・トリアージ（mock 46 相当・実データ）
import { load, invalidate } from "../lib/store.js";
import { firstHuman } from "../lib/users.js";
import { triage, shiftISO, projectAncestor, isContainer } from "../lib/capacity.js";
import { updateTask } from "../lib/api.js";
import { C, fmtH, esc, todayISO, avatar, announce } from "../lib/ui.js";
import { categoryLabels, categoryColor } from "../lib/kinds.js";
import { dot } from "../lib/icons.js";
import * as history from "../lib/history.js";
import { openTaskForm } from "./taskform.js";

const COLS = [
  { key: "must", label: "今日必須", color: C.over },
  { key: "should", label: "今日着手", color: C.amber },
  { key: "movable", label: "後日可", color: C.free },
];

// 担当者フィルタ選択を個人保存（再読込でも維持）。quad.js の whoTabs に倣う。
const WHO_KEY = "ts.triage.who";
let FILTER = { who: (() => { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } })() };

// 列→属性: ドロップ先の列に確実に分類されるよう due/priority を書き換える（triage() の判定の逆算）。
//   今日必須 = 期限を今日（slack=0）。今日着手 = 期限を明日（slack=1）かつ優先<4（mustへ昇格させない）。
//   後日可 = 期限を+7日（slack=7）かつ優先<4。優先>=4 は緊急扱いに化けるため、後ろ2列では3に下げる。
function patchForColumn(col, today) {
  const due = (iso) => iso + "T00:00:00Z";
  if (col === "must") return { due_date: due(today) };
  if (col === "should") return { due_date: due(shiftISO(today, 1)), priority: 3 };
  return { due_date: due(shiftISO(today, 7)), priority: 3 }; // movable
}

// triage() の返り値は slim（assignee/project/labels を持たない）ので、生タスクから id→補足情報を引けるようにする。
//   担当=人間アサイニ先頭（AIユーザー除外）、プロジェクト=親タスク（related_tasks.parenttask）、分類=categoryLabels（レビュー/連絡待ち除外）。
function buildMeta(tasks, byId) {
  const meta = new Map();
  for (const t of tasks || []) {
    const who = firstHuman(t);
    // プロジェクト=祖先解決（4層以上でも最上位プロジェクトへ集約。3層では直近親と一致）。
    const parent = projectAncestor(t, byId);
    // 中間グループ（直近親）が最上位プロジェクトと異なるときだけ、グループとして扱う（kanban.js の判定を踏襲）。
    const immRel = (((t.related_tasks || {}).parenttask) || [])[0];
    const immParent = immRel ? (byId.get(immRel.id) || immRel) : null;
    const group = (immParent && parent && immParent.id !== parent.id) ? immParent : null;
    meta.set(t.id, { who, parent, group, cats: categoryLabels(t) });
  }
  return meta;
}

export async function render(root) {
  const { tasks, members, me, settings = {} } = await load();
  const capH = (settings && settings.capH) || 8;
  const today = todayISO();

  // 担当者フィルタ（自分/全員/各人）。triage() は assignees を持たない slim なので、生タスクで先に絞ってから分類する。
  // 祖先解決・コンテナ判定には全タスクの id→task が要る（フィルタ後 rows ではなく tasks 全体から構築）。
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  let rows = tasks || [];
  if (FILTER.who) rows = rows.filter((t) => (t.assignees || []).some((a) => String(a.id) === String(FILTER.who)));
  // コンテナ（子持ち親）は作業行に出さない（#732）
  rows = rows.filter((t) => !isContainer(t, byId));
  const meta = buildMeta(rows, byId);
  const items = triage(rows, today)
    .sort((a, b) => (b.priority - a.priority) || ((a.slack ?? 99) - (b.slack ?? 99)));
  // ドロップ時に元の値へ戻せるよう id→生タスクを引けるようにする。
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));

  // 担当者切替=ワンタップのボタンタブ（全員 / 自分 / 各メンバー）。選択は localStorage 永続。
  const meId = me && me.id;
  const meMember = (members || []).find((m) => m.id === meId);
  const others = (members || []).filter((m) => m.id !== meId);
  const whoBtn = (val, label, member) => {
    const on = String(FILTER.who) === String(val) ? " on" : "";
    const av = member ? avatar(member, { size: 16 }) : "";
    return `<button class="tr-who-b${on}" data-who="${esc(String(val))}">${av}<span>${esc(label)}</span></button>`;
  };
  const whoTabs = whoBtn("", "全員", null)
    + (meMember ? whoBtn(meMember.id, "自分", meMember) : "")
    + others.map((m) => whoBtn(m.id, m.name || m.username, m)).join("");

  const col = (c) => {
    const list = items.filter(i => i.cls === c.key);
    const sumH = list.reduce((s, i) => s + (i.estH || 0), 0);
    // 列の見積り合計（Σ estH）。capH 超過は警告色（C.over）で目立たせる。
    const sumColor = sumH > capH + 1e-6 ? C.over : C.muted;
    const sumBadge = `<span title="見積り合計" style="color:${sumColor};font-weight:${sumH > capH + 1e-6 ? 700 : 400}">Σ ${fmtH(sumH)}</span>`;
    return `<div class="card tr-col" data-col="${c.key}" style="flex:1;min-width:220px">
      <div style="padding:11px 14px;border-bottom:1px solid ${C.line};font-weight:700;color:${c.color};display:flex;align-items:center;gap:7px">${dot(c.color, 10)} <span>${esc(c.label)}</span> <span style="color:${C.muted};font-weight:400">${list.length}</span> <span style="margin-left:auto;font-size:12px">${sumBadge}</span></div>
      <div class="tr-drop" data-col="${c.key}">
        ${list.length ? list.map((i) => cardHtml(i, meta.get(i.id))).join("") : `<div style="padding:22px;text-align:center;color:${C.muted};font-size:12px">なし</div>`}
      </div>
    </div>`;
  };
  root.innerHTML = `
    <style>
      .tr-card{cursor:grab;transition:background .12s}.tr-card:hover{background:${C.hover || "rgba(127,127,127,.08)"}}
      .tr-card.dragging{opacity:.45}
      .tr-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:5px}
      .tr-proj{font-size:10.5px;color:${C.muted};border:1px solid ${C.line};border-radius:5px;padding:1px 6px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
      .tr-group{display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;border-radius:5px;padding:1px 6px;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;background:${C.track};color:${C.muted}}
      .tr-cat{font-size:10.5px;border:1px solid;border-radius:5px;padding:1px 6px;white-space:nowrap;font-weight:600}
      .tr-who{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 14px}
      .tr-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:var(--card);color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
      .tr-who-b:hover{border-color:#cfd9e6}
      .tr-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
      .tr-who-b.on .ui-ava{box-shadow:0 0 0 1.5px #fff}
      .tr-drop{min-height:60px;transition:background .12s}
      .tr-col.over .tr-drop{background:color-mix(in srgb, ${C.fill} 10%, transparent);outline:2px dashed ${C.fill};outline-offset:-3px;border-radius:8px}
    </style>
    <h1 class="vtitle">優先度・トリアージ <small>今日の着手優先度（クリックで編集・列間ドラッグで再分類） ${today}</small></h1>
    <div class="tr-who" id="tr-who">${whoTabs}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">${COLS.map(col).join("")}</div>`;

  // 担当者フィルタ切替。選択は localStorage 永続→再描画。
  root.querySelectorAll("#tr-who [data-who]").forEach((b) => {
    b.onclick = () => { FILTER.who = b.dataset.who; try { localStorage.setItem(WHO_KEY, FILTER.who); } catch {} render(root); };
  });

  // カードクリックで編集（イベント委譲）。保存後 再描画。+ DnD のドラッグ元配線。
  root.querySelectorAll(".tr-card[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: async () => { invalidate(); await load(); render(root); } });
    el.draggable = true;
    el.ondragstart = (ev) => { ev.dataTransfer.setData("text/plain", el.dataset.id); ev.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); };
    el.ondragend = () => el.classList.remove("dragging");
  });

  // 列＝ドロップ先。列間ドラッグで due/priority を更新（updateTask + history.push で Undo 可能）。
  root.querySelectorAll(".tr-col[data-col]").forEach((colEl) => {
    const dst = colEl.dataset.col;
    colEl.ondragover = (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; colEl.classList.add("over"); };
    colEl.ondragleave = (ev) => { if (!colEl.contains(ev.relatedTarget)) colEl.classList.remove("over"); };
    colEl.ondrop = async (ev) => {
      ev.preventDefault();
      colEl.classList.remove("over");
      const id = +ev.dataTransfer.getData("text/plain");
      const item = items.find((i) => i.id === id);
      if (!item || item.cls === dst) return; // 同じ列＝何もしない
      const t = taskById.get(id);
      const raw = t || {};
      const prev = { due_date: raw.due_date || "0001-01-01T00:00:00Z", priority: raw.priority || 0 };
      const patch = patchForColumn(dst, today);
      const title = (t && t.title) || item.title;
      const colLabel = (COLS.find((c) => c.key === dst) || {}).label || dst;
      const doMove = async () => { await updateTask(id, patch); invalidate(); await load(); render(root); };
      try {
        await doMove();
        announce(`「${title}」を「${colLabel}」へ移動しました`);
        history.push({
          label: `トリアージ移動: ${title} → ${colLabel}`,
          undo: async () => { await updateTask(id, prev); invalidate(); await load(); render(root); announce(`「${title}」の移動を元に戻しました`); },
          redo: async () => { await doMove(); announce(`「${title}」を「${colLabel}」へ移動しました`); },
        });
      } catch (e) {
        announce(`移動に失敗しました: ${e.message}`, { assertive: true });
      }
    };
  });
}

function cardHtml(t, m) {
  const due = t.due ? `期限 ${t.due.slice(5)}${t.slack != null ? `（${t.slack <= 0 ? "超過/今日" : "あと" + t.slack + "日"}）` : ""}` : "期限なし";
  const pr = t.priority >= 4 ? `<span style="color:${C.over};font-weight:700">優先${t.priority}</span>` : `優先${t.priority}`;
  const who = m && m.who;
  const parent = m && m.parent;
  const group = m && m.group;
  const cats = (m && m.cats) || [];
  const ava = who ? avatar(who, { size: 18 }) : "";
  const projChip = parent ? `<span class="tr-proj" title="プロジェクト: ${esc(parent.title)}">${esc(parent.title)}</span>` : "";
  const groupChip = group ? `<span class="tr-group" title="タスクグループ: ${esc(group.title)}">${esc(group.title)}</span>` : "";
  const catChips = cats.map((c) => `<span class="tr-cat" style="color:${categoryColor(c)};border-color:${categoryColor(c)}40">${esc(c.title)}</span>`).join("");
  const metaRow = (ava || projChip || groupChip || catChips)
    ? `<div class="tr-meta">${ava}${projChip}${groupChip}${catChips}</div>` : "";
  return `<div class="tr-card" data-id="${t.id}" style="padding:11px 14px;border-bottom:1px solid ${C.line}">
    <div style="font-weight:600;font-size:13.5px">${esc(t.title)}</div>
    <div style="font-size:11.5px;color:${C.muted};margin-top:3px">${pr} ・ ${due} ・ ${fmtH(t.estH)}</div>
    ${metaRow}
  </div>`;
}
