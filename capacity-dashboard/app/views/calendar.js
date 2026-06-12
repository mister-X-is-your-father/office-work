// 本日の時刻カレンダー（mock49 相当・実データ／ADR-013）。資源タイムライン＋未配置トレイ＋ドラッグ配置。
// task_time_plans.start_minute（時刻）で配置。未配置タスクをドラッグして時刻と担当を確定。
// 会議/定例は recurrences.dtstart の時刻（UTC文字列の HH:MM=壁時計・00:00=時刻なし）で固定ブロック表示。
// ブロック下端のハンドルをドラッグで所要時間を変更（リサイズ）。
import { load, invalidate } from "../lib/store.js";
import { todayItemsByMember } from "../lib/today_items.js";
import { expandRecurrences } from "../lib/recurrence.js";
import { PRIO, NEUTRAL, KINDS } from "../lib/kinds.js";
import { dateOnly } from "../lib/capacity.js";
import { deletePlan, logPlan } from "../lib/api.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { splitMeta } from "../lib/form.js"; // note の "[資料] URL" 行を抽出

const H0 = 8, H1 = 20, HOURH = 46;       // 8:00〜20:00
const GRIDH = (H1 - H0) * HOURH;
const SNAP = 15;
const itemColor = (it) => (it.prio ? PRIO[it.prio].c : NEUTRAL);
const min2top = (m) => ((m - H0 * 60) / 60) * HOURH;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

let _root, _data, _day;

export async function render(root) {
  _root = root;
  _data = await load();
  _day = todayISO();
  paint();
}

function buildModel() {
  const { tasks, members, plansByTask } = _data;
  const memberIds = new Set(members.map((m) => m.id));
  const byTask = new Map((tasks || []).map((t) => [t.id, t]));
  const itemMap = todayItemsByMember(_data, _day, 8);

  // 配置済みブロック（start_minute あり・本日）
  const placed = [];
  const placedKey = new Set();
  for (const t of (tasks || [])) {
    const plans = (plansByTask && plansByTask.get && plansByTask.get(t.id)) || [];
    for (const p of plans) {
      if (dateOnly(p.plan_date) !== _day || p.start_minute == null) continue;
      let mid = p.user_id;
      if (!memberIds.has(mid)) mid = ((t.assignees || [])[0] || {}).id;
      if (!memberIds.has(mid)) continue;
      const prio = bucketFromItem(itemMap, mid, t.id);
      placed.push({ taskId: t.id, planId: p.id, memberId: mid, startMin: p.start_minute, mins: Math.round((p.seconds || 0) / 60), title: t.title, kind: prio.kind, prio: prio.prio });
      placedKey.add(t.id + ":" + mid);
    }
  }
  // 未配置トレイ（本日の負荷があるが start_minute 無し。会議/定例=occurrence は除く）
  const tray = [];
  for (const m of members) {
    const st = itemMap.get(m.id);
    if (!st) continue;
    for (const it of st.items) {
      if (!it.taskId) continue;                       // occurrence(会議/定例)は配置対象外
      if (placedKey.has(it.taskId + ":" + m.id)) continue;
      tray.push({ taskId: it.taskId, memberId: m.id, mins: Math.round(it.h * 60), title: it.title, kind: it.kind, prio: it.prio });
    }
  }
  // 会議/定例の固定ブロック（dtstart の時刻 ≠ 00:00 のみ。00:00=時刻なし→従来どおり積み上げ側だけ）
  const meetings = [];
  for (const { recurrence: rec, dateISO, assignees } of expandRecurrences(_data.recurrences || [], _day, _day)) {
    if (dateISO !== _day) continue;
    const d = new Date(rec.dtstart);
    const startMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (!startMin) continue;
    const mins = Math.max(15, Math.round((rec.duration_seconds || 0) / 60));
    const kind = rec.kind === "meeting" ? "meeting" : "recurring";
    const links = splitMeta(rec.note || "").links; // MTG資料（note 埋め込み）
    for (const uid of assignees || rec.assignee_ids || []) {
      if (!memberIds.has(uid)) continue;
      meetings.push({ memberId: uid, startMin, mins, title: rec.title || "会議", kind, prio: null, fixed: true, links });
    }
  }
  return { members, placed, tray, meetings };
}
function bucketFromItem(itemMap, mid, taskId) {
  const st = itemMap.get(mid);
  const it = st && st.items.find((x) => x.taskId === taskId);
  return it ? { kind: it.kind, prio: it.prio } : { kind: "task", prio: 1 };
}

function paint() {
  const { members, placed, tray, meetings } = buildModel();
  const nowMin = nowMinutes();

  const hours = [];
  for (let h = H0; h <= H1; h++) hours.push(`<div class="cal-hr" style="top:${(h - H0) * HOURH}px">${h}:00</div>`);
  const grid = [];
  for (let h = H0; h < H1; h++) grid.push(`<div class="cal-line" style="top:${(h - H0) * HOURH}px"></div>`);

  const cols = members.map((m, i) => {
    const blocks = meetings.filter((b) => b.memberId === m.id).map((b) => blockHtml(b)).join("")
      + placed.filter((b) => b.memberId === m.id).map((b) => blockHtml(b)).join("");
    return `<div class="cal-col" data-member="${m.id}">
      <div class="cal-colh"><span class="cal-ava" style="background:${member_color(i)}">${esc((m.name || m.username || "?")[0])}</span>${esc(m.name || m.username)}</div>
      <div class="cal-colbody" data-member="${m.id}" style="height:${GRIDH}px">${blocks}</div>
    </div>`;
  }).join("");

  const nowLine = (nowMin >= H0 * 60 && nowMin <= H1 * 60)
    ? `<div class="cal-now" style="top:${min2top(nowMin)}px"><span>${hhmm(nowMin)}</span></div>` : "";

  const trayHtml = tray.length
    ? tray.map((it) => `<div class="cal-chip" draggable="true" data-task="${it.taskId}" data-member="${it.memberId}" data-mins="${it.mins}" style="border-left-color:${itemColor(it)}">
        <span class="cal-chip-t">${esc(it.title)}</span><span class="cal-chip-h">${fmtH(it.mins / 60)}</span></div>`).join("")
    : `<div class="cal-tray-empty">未配置のタスクはありません</div>`;

  _root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">本日の時刻カレンダー <small>${_day} ・ ドラッグで時刻・担当を配置</small></h1>
    <div class="cal-tray"><div class="cal-tray-h">未配置（${tray.length}）</div><div class="cal-tray-list" id="cal-tray">${trayHtml}</div></div>
    <div class="card cal-card"><div class="cal-scroll">
      <div class="cal-grid" style="height:${GRIDH + 30}px">
        <div class="cal-gutter" style="height:${GRIDH}px">${hours.join("")}</div>
        <div class="cal-cols">${grid.join("")}${nowLine}${cols}</div>
      </div>
    </div></div>`;

  wireDnD();
}

function blockHtml(b) {
  const top = min2top(b.startMin), h = Math.max(18, (b.mins / 60) * HOURH);
  const pat = KINDS[b.kind] ? KINDS[b.kind].pattern : "task";
  const hatch = pat === "meeting" ? "cal-hatch" : (pat === "routine" ? "cal-dots" : "");
  const timeLabel = `${hhmm(b.startMin)}–${hhmm(b.startMin + b.mins)} ・ ${fmtH(b.mins / 60)}`;
  if (b.fixed) {
    // 会議/定例: 移動・リサイズ不可の固定枠。資料リンク（note の [資料] 行）は 📎 で開ける。
    const links = (b.links || []).map((u) => /^https?:\/\//i.test(u)
      ? `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}" style="color:#fff;text-decoration:none">📎</a>`
      : `<span title="${esc(u)}">📎</span>`).join(" ");
    return `<div class="cal-block cal-fixed ${hatch}" style="top:${top}px;height:${h}px;background:${itemColor(b)}" title="${esc(b.title)}（${KINDS[b.kind] ? KINDS[b.kind].label : "会議"}・固定）">
      <div class="cal-bt">${esc(b.title)}${links ? " " + links : ""}</div><div class="cal-bh">${timeLabel}</div>
    </div>`;
  }
  return `<div class="cal-block ${hatch}" draggable="true" data-task="${b.taskId}" data-member="${b.memberId}" data-mins="${b.mins}" data-start="${b.startMin}" data-plan="${b.planId}"
      style="top:${top}px;height:${h}px;background:${itemColor(b)}">
    <div class="cal-bt">${esc(b.title)}</div><div class="cal-bh">${timeLabel}</div>
    <div class="cal-rs" draggable="false" title="ドラッグで所要時間を変更"></div>
  </div>`;
}

function wireDnD() {
  let drag = null;
  let resizing = false;
  _root.querySelectorAll(".cal-chip, .cal-block:not(.cal-fixed)").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      if (resizing) { e.preventDefault(); return; }
      drag = { taskId: +el.dataset.task, fromMember: +el.dataset.member, mins: +el.dataset.mins, planId: el.dataset.plan ? +el.dataset.plan : null };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(drag.taskId)); } catch { /* noop */ }
    });
  });
  // リサイズ: 下端ハンドルをドラッグ → plan の所要(seconds)を更新
  _root.querySelectorAll(".cal-rs").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      resizing = true;
      const blk = handle.parentElement;
      const startY = e.clientY, origMins = +blk.dataset.mins, startMin = +blk.dataset.start;
      const maxMins = H1 * 60 - startMin;
      let mins = origMins;
      const move = (ev) => {
        const dm = Math.round(((ev.clientY - startY) / HOURH) * 60 / SNAP) * SNAP;
        mins = Math.max(SNAP, Math.min(maxMins, origMins + dm));
        blk.style.height = Math.max(18, (mins / 60) * HOURH) + "px";
        blk.querySelector(".cal-bh").textContent = `${hhmm(startMin)}–${hhmm(startMin + mins)} ・ ${fmtH(mins / 60)}`;
      };
      const up = async () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        setTimeout(() => { resizing = false; }, 0);
        if (mins === origMins) return;
        await resizePlan(+blk.dataset.task, +blk.dataset.plan, +blk.dataset.member, startMin, mins);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
  _root.querySelectorAll(".cal-colbody").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      if (!drag) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let startMin = H0 * 60 + Math.round((y / HOURH) * 60 / SNAP) * SNAP;
      startMin = Math.max(H0 * 60, Math.min(H1 * 60 - drag.mins, startMin));
      const toMember = +col.dataset.member;
      await place(drag, toMember, startMin);
      drag = null;
    });
  });
}

// リサイズ確定: 同じ時刻・担当のまま所要だけ変更（plans に更新APIが無いため delete→create）
async function resizePlan(taskId, planId, memberId, startMin, mins) {
  await deletePlan(taskId, planId);
  await logPlan(taskId, mins * 60, _day, "", memberId, startMin);
  invalidate();
  _data = await load();
  paint();
}

async function place(drag, toMember, startMin) {
  const seconds = drag.mins * 60;
  // 既存の本日plan（このタスク×元担当）を削除してから時刻付きで作り直す（移動）。
  const plans = (_data.plansByTask && _data.plansByTask.get && _data.plansByTask.get(drag.taskId)) || [];
  const aids = ((_data.tasks.find((t) => t.id === drag.taskId) || {}).assignees || []).map((a) => a.id);
  const sameDay = plans.filter((p) => dateOnly(p.plan_date) === _day &&
    (p.user_id === drag.fromMember || p.user_id === toMember || !p.user_id || !aids.includes(p.user_id)));
  for (const p of sameDay) await deletePlan(drag.taskId, p.id);
  await logPlan(drag.taskId, seconds, _day, "", toMember, startMin);
  invalidate();
  _data = await load();
  paint();
}

function nowMinutes() {
  const n = new Date();
  if (n.toISOString().slice(0, 10) !== _day) return -1;
  return n.getHours() * 60 + n.getMinutes();
}

function css() {
  return `
  .cal-tray{margin:0 0 14px}
  .cal-tray-h{font-size:11.5px;color:${C.muted};font-weight:600;margin-bottom:6px}
  .cal-tray-list{display:flex;gap:8px;flex-wrap:wrap;min-height:34px;background:#fafbfc;border:1px dashed ${C.line};border-radius:10px;padding:8px}
  .cal-chip{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ${C.line};border-left:3px solid ${C.full};border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:grab;box-shadow:0 1px 2px rgba(20,30,50,.05)}
  .cal-chip:active{cursor:grabbing}
  .cal-chip-t{font-weight:600;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cal-chip-h{color:${C.muted};font-variant-numeric:tabular-nums}
  .cal-tray-empty{font-size:12px;color:${C.muted};padding:4px}
  .cal-card{padding:0}.cal-scroll{overflow:auto;padding:8px 12px 12px}
  .cal-grid{display:flex;position:relative;min-width:560px}
  .cal-gutter{position:relative;width:46px;flex:none;margin-top:30px}
  .cal-hr{position:absolute;right:6px;font-size:10.5px;color:${C.muted};transform:translateY(-50%)}
  .cal-cols{display:flex;flex:1;gap:8px;position:relative}
  .cal-line{position:absolute;left:0;right:0;border-top:1px solid ${C.track};z-index:0;margin-top:30px}
  .cal-now{position:absolute;left:0;right:0;border-top:2px solid ${C.over};z-index:5;margin-top:30px;pointer-events:none}
  .cal-now span{position:absolute;left:-2px;top:-8px;font-size:9px;font-weight:700;color:#fff;background:${C.over};border-radius:3px;padding:0 4px}
  .cal-col{flex:1;min-width:120px;display:flex;flex-direction:column}
  .cal-colh{height:30px;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;justify-content:center;border-bottom:1px solid ${C.line}}
  .cal-ava{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:700}
  .cal-colbody{position:relative;border-left:1px solid ${C.track}}
  .cal-colbody.over{background:#f3f8ff}
  .cal-block{position:absolute;left:3px;right:3px;border-radius:7px;color:#fff;padding:4px 7px;overflow:hidden;cursor:grab;box-shadow:0 1px 3px rgba(20,30,50,.18);z-index:2}
  .cal-block:active{cursor:grabbing}
  .cal-block.cal-hatch{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.85) 0 1.4px,transparent 1.4px 3px)}
  .cal-block.cal-dots{background-image:radial-gradient(rgba(255,255,255,.9) .9px,transparent 1.1px);background-size:3px 3px}
  .cal-bt{font-size:11.5px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cal-bh{font-size:10px;opacity:.92;margin-top:1px;white-space:nowrap}
  .cal-block.cal-fixed{cursor:default;opacity:.88;z-index:1}
  .cal-rs{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize}
  .cal-rs::after{content:"";position:absolute;left:50%;bottom:2px;width:22px;height:3px;margin-left:-11px;border-radius:2px;background:rgba(255,255,255,.65)}`;
}
