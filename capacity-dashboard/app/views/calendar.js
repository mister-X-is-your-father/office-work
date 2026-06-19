// 今日の時刻カレンダー（mock49 相当・実データ／ADR-013）。資源タイムライン＋未配置トレイ＋ドラッグ配置。
// task_time_plans.start_minute（時刻）で配置。未配置タスクをドラッグして時刻と担当を確定。
// 会議/定例は recurrences.dtstart の時刻（UTC文字列の HH:MM=壁時計・00:00=時刻なし）で固定ブロック表示。
// ブロック下端のハンドルをドラッグで所要時間を変更（リサイズ）。
import { load, invalidate } from "../lib/store.js";
import { todayItemsByMember } from "../lib/today_items.js";
import { expandRecurrences } from "../lib/recurrence.js";
import { PRIO, NEUTRAL, KINDS } from "../lib/kinds.js";
import { dateOnly, shiftISO } from "../lib/capacity.js";
import { deletePlan, logPlan, updateRecurrence } from "../lib/api.js";
import { C, fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { splitMeta } from "../lib/form.js"; // note の "[資料] URL" 行を抽出
import { icon } from "../lib/icons.js";

let H0 = 8, H1 = 20;                      // 営業時間（設定で上書き）
const HOURH = 46;
let GRIDH = (H1 - H0) * HOURH;
const SNAP = 15;
// ドラッグ標準ゴーストを消すための透明1px画像（着地プレビュー cal-ghost に一本化）
const BLANK_IMG = new Image();
BLANK_IMG.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const itemColor = (it) => (it.prio ? PRIO[it.prio].c : NEUTRAL);
const min2top = (m) => ((m - H0 * 60) / 60) * HOURH;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

let _root, _data, _day;
let _calBusy = false; // drop配置(place)の直列化ガード（飛行中の二度目ドロップで plan 重複を防ぐ）

export async function render(root) {
  _root = root;
  _data = await load();
  H0 = _data.settings.calStart; H1 = _data.settings.calEnd;
  GRIDH = (H1 - H0) * HOURH;
  _day = todayISO();
  paint();
}

function buildModel() {
  const { tasks, members, plansByTask } = _data;
  const memberIds = new Set(members.map((m) => m.id));
  const byTask = new Map((tasks || []).map((t) => [t.id, t]));
  const itemMap = todayItemsByMember(_data, _day, _data.settings.capH);

  // 配置済みブロック（start_minute あり・今日）
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
  // 未配置トレイ（今日の負荷があるが start_minute 無し。会議/定例=occurrence は除く）
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
  // 会議/定例の固定ブロック（時刻 ≠ 00:00 のみ。00:00=時刻なし→従来どおり積み上げ側だけ）。
  // この回だけの例外(overrides: 移動/時刻/所要/休止)は expandRecurrences が適用済み。クリックで例外編集。
  const meetings = [];
  for (const { recurrence: rec, dateISO, origISO, assignees, override } of expandRecurrences(_data.recurrences || [], _day, _day)) {
    if (dateISO !== _day) continue;
    const d = new Date(rec.dtstart);
    const baseMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const startMin = override && override.start_minute != null ? override.start_minute : baseMin;
    if (!startMin) continue;
    const durSec = (override && override.duration_seconds) || rec.duration_seconds || 0;
    const mins = Math.max(15, Math.round(durSec / 60));
    const kind = rec.kind === "meeting" ? "meeting" : "recurring";
    const links = splitMeta(rec.note || "").links; // MTG資料（note 埋め込み）
    for (const uid of assignees || rec.assignee_ids || []) {
      if (!memberIds.has(uid)) continue;
      meetings.push({ memberId: uid, startMin, mins, title: rec.title || "会議", kind, prio: null, fixed: true, links, recId: rec.id, origISO, hasOverride: !!override });
    }
  }
  return { members, placed, tray, meetings };
}
function bucketFromItem(itemMap, mid, taskId) {
  const st = itemMap.get(mid);
  const it = st && st.items.find((x) => x.taskId === taskId);
  return it ? { kind: it.kind, prio: it.prio } : { kind: "task", prio: 1 };
}

// B9: 同時刻に重なるブロックをレーン分割。各 item に { lane, lanes } を付与し
// blockHtml で横幅・左位置に反映する（重なると潰れていた破綻を解消）。
// アルゴリズム: 開始時刻順に並べ、重なりが切れたところで「クラスタ」を区切る。
// クラスタ内は空きレーン（終了済み）を再利用し、クラスタの最大同時数を lanes にする。
function layoutLanes(items) {
  const sorted = items.slice().sort((a, b) => a.startMin - b.startMin || a.mins - b.mins);
  let cluster = [];        // 現クラスタの item 群
  let laneEnd = [];        // 各レーンの「現在の終了時刻」
  let clusterMax = 0;      // 現クラスタの同時最大レーン数
  const flush = () => {
    for (const it of cluster) it.lanes = clusterMax;
    cluster = []; laneEnd = []; clusterMax = 0;
  };
  for (const it of sorted) {
    // どのレーンも埋まっていない(=全部 it.startMin 以前に終了)ならクラスタを締める
    if (laneEnd.length && laneEnd.every((end) => end <= it.startMin)) flush();
    // 空きレーンを探す（終了済みを再利用）。無ければ新規レーン。
    let lane = laneEnd.findIndex((end) => end <= it.startMin);
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = it.startMin + it.mins;
    it.lane = lane;
    cluster.push(it);
    if (laneEnd.length > clusterMax) clusterMax = laneEnd.length;
  }
  flush();
  return sorted;
}

function paint() {
  const { members, placed, tray, meetings } = buildModel();
  const nowMin = nowMinutes();

  const hours = [];
  for (let h = H0; h <= H1; h++) hours.push(`<div class="cal-hr" style="top:${(h - H0) * HOURH}px">${h}:00</div>`);
  const grid = [];
  for (let h = H0; h < H1; h++) grid.push(`<div class="cal-line" style="top:${(h - H0) * HOURH}px"></div>`);

  const cols = members.map((m, i) => {
    // B9: 会議＋配置済みを同じレーン空間でまとめて分割（互いの重なりも横並びに）
    const mine = layoutLanes([
      ...meetings.filter((b) => b.memberId === m.id),
      ...placed.filter((b) => b.memberId === m.id),
    ]);
    const blocks = mine.map((b) => blockHtml(b)).join("");
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

  // タスク一覧プール: 今日の負荷を持たない未完了タスクも直接ドラッグして配置できる
  // （所要=見積り・無ければ1h。ドロップで今日の plan＋時刻が付く。配置後はリサイズで調整可）
  const usedIds = new Set([...placed.map((b) => b.taskId), ...tray.map((it) => it.taskId)]);
  const dayMins = (H1 - H0) * 60;
  const pool = (_data.tasks || [])
    .filter((t) => !t.done && !usedIds.has(t.id))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.title.localeCompare(b.title, "ja"));
  const poolHtml = pool.length ? pool.map((t) => {
    const estMin = Math.round((t.time_estimate || 0) / 60);
    const mins = Math.max(SNAP, Math.min(dayMins, estMin || 60)); // 見積り無し=1h
    const asg = (t.assignees || [])[0];
    return `<div class="cal-chip cal-pool-chip" draggable="true" data-task="${t.id}" data-mins="${mins}"
        title="${esc(t.title)}${asg ? `（担当: ${esc(asg.name || asg.username)}）` : ""}">
      <span class="cal-chip-t">${esc(t.title)}</span><span class="cal-chip-h">${fmtH(mins / 60)}</span></div>`;
  }).join("") : `<div class="cal-tray-empty">配置できる未完了タスクはありません</div>`;

  _root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">時刻カレンダー <small>${dayLabel(_day)} ・ ドラッグで時刻・担当を配置</small></h1>
    <div class="cal-nav">
      <button class="cal-nav-btn" id="cal-prev" title="前日" aria-label="前日">‹</button>
      <button class="cal-nav-btn cal-nav-today" id="cal-today" title="今日へ">今日</button>
      <button class="cal-nav-btn" id="cal-next" title="翌日" aria-label="翌日">›</button>
      <input type="date" id="cal-date" class="cal-nav-date" value="${_day}" aria-label="表示日">
    </div>
    <div class="cal-tray"><div class="cal-tray-h">未配置（${tray.length}）</div><div class="cal-tray-list" id="cal-tray">${trayHtml}</div></div>
    <div class="cal-pool">
      <div class="cal-pool-hd">
        <div class="cal-tray-h">タスク一覧から配置（${pool.length}件・ドラッグでカレンダーへ）</div>
        <input id="cal-pool-q" class="cal-pool-q" placeholder="タスク名で絞り込み" autocomplete="off">
      </div>
      <div class="cal-tray-list cal-pool-list" id="cal-pool">${poolHtml}</div>
    </div>
    <div class="card cal-card"><div class="cal-scroll">
      <div class="cal-grid" style="height:${GRIDH + 30}px">
        <div class="cal-gutter" style="height:${GRIDH}px">${hours.join("")}</div>
        <div class="cal-cols">${grid.join("")}${nowLine}${cols}</div>
      </div>
    </div></div>`;

  // プールの絞り込み（タイトル＋担当名でマッチ・再描画なし）
  const q = _root.querySelector("#cal-pool-q");
  if (q) q.oninput = () => {
    const v = q.value.trim().toLowerCase();
    _root.querySelectorAll(".cal-pool-chip").forEach((c) => {
      c.style.display = !v || (c.title || "").toLowerCase().includes(v) ? "" : "none";
    });
  };

  // B10: 日付ナビ（前日/今日/翌日＋ピッカー）。_day を変えて paint するだけ（モデルAPIは無改修）。
  const goto = (iso) => { if (iso && iso !== _day) { _day = iso; paint(); } };
  const prev = _root.querySelector("#cal-prev");
  const next = _root.querySelector("#cal-next");
  const todayBtn = _root.querySelector("#cal-today");
  const picker = _root.querySelector("#cal-date");
  if (prev) prev.onclick = () => goto(shiftISO(_day, -1));
  if (next) next.onclick = () => goto(shiftISO(_day, 1));
  if (todayBtn) todayBtn.onclick = () => goto(todayISO());
  if (picker) picker.onchange = (e) => goto(e.target.value);

  wireDnD();
}

// 表示日ラベル: 今日/明日/昨日は注記を添える（それ以外は曜日付き）。
function dayLabel(iso) {
  const W = ["日", "月", "火", "水", "木", "金", "土"];
  const d = new Date(iso + "T00:00:00Z");
  const wd = W[d.getUTCDay()];
  const t = todayISO();
  const rel = iso === t ? "（今日）" : iso === shiftISO(t, 1) ? "（明日）" : iso === shiftISO(t, -1) ? "（昨日）" : "";
  return `${iso}（${wd}）${rel}`;
}

// B9: レーン情報(lane/lanes)から横位置を算出（3px の左右余白を保ちつつ等分）。
// lanes 未設定（=単独）は従来どおり left:3px;right:3px のまま。
function lanePos(b) {
  const lanes = b.lanes || 1;
  if (lanes <= 1) return "left:3px;right:3px;";
  const GAP = 3;                         // レーン間の隙間(px)
  const wPct = 100 / lanes;
  // calc で「均等割 - 余白」。左 3px・右 3px の外枠は維持。
  return `left:calc(3px + ${(b.lane || 0) * wPct}% );width:calc(${wPct}% - ${GAP + (6 / lanes)}px);right:auto;`;
}
function blockHtml(b) {
  const top = min2top(b.startMin), h = Math.max(18, (b.mins / 60) * HOURH);
  const pat = KINDS[b.kind] ? KINDS[b.kind].pattern : "task";
  const hatch = pat === "meeting" ? "cal-hatch" : (pat === "routine" ? "cal-dots" : "");
  const timeLabel = `${hhmm(b.startMin)}–${hhmm(b.startMin + b.mins)} ・ ${fmtH(b.mins / 60)}`;
  const pos = lanePos(b);
  if (b.fixed) {
    // 会議/定例: ドラッグ移動・リサイズ不可。クリックで「この回だけ変更」。資料リンクは 📎 で開ける。
    const links = (b.links || []).map((u) => /^https?:\/\//i.test(u)
      ? `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}" style="color:#fff;text-decoration:none">${icon("paperclip", { size: 13 })}</a>`
      : `<span title="${esc(u)}">${icon("paperclip", { size: 13 })}</span>`).join(" ");
    return `<div class="cal-block cal-fixed ${hatch}${b.hasOverride ? " cal-ovr" : ""}" data-rec="${b.recId}" data-orig="${b.origISO}"
        style="top:${top}px;height:${h}px;${pos}background:${itemColor(b)}" title="${esc(b.title)}（${KINDS[b.kind] ? KINDS[b.kind].label : "会議"}・クリックでこの回だけ変更）">
      <div class="cal-bt">${b.hasOverride ? "✱ " : ""}${esc(b.title)}${links ? " " + links : ""}</div><div class="cal-bh">${timeLabel}</div>
    </div>`;
  }
  return `<div class="cal-block ${hatch}" draggable="true" data-task="${b.taskId}" data-member="${b.memberId}" data-mins="${b.mins}" data-start="${b.startMin}" data-plan="${b.planId}"
      style="top:${top}px;height:${h}px;${pos}background:${itemColor(b)}">
    <button class="cal-unplace" title="未配置に戻す" aria-label="未配置に戻す">×</button>
    <div class="cal-bt">${esc(b.title)}</div><div class="cal-bh">${timeLabel}</div>
    <div class="cal-rs" draggable="false" title="ドラッグで所要時間を変更"></div>
  </div>`;
}

function wireDnD() {
  let drag = null;
  let resizing = false;
  let ghost = null; // ドラッグ中の着地プレビュー（SNAP刻みで吸い付く）
  const removeGhost = () => { if (ghost) { ghost.remove(); ghost = null; } };
  // カーソル位置→SNAP(15分=0.25h)刻みの開始時刻（dragover プレビューと drop で同一の計算を使う）
  const snapStartMin = (col, e) => {
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top - (drag.grabY || 0);
    let startMin = H0 * 60 + Math.round((y / HOURH) * 60 / SNAP) * SNAP;
    return Math.max(H0 * 60, Math.min(H1 * 60 - drag.mins, startMin));
  };
  _root.querySelectorAll(".cal-chip, .cal-block:not(.cal-fixed)").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      if (resizing) { e.preventDefault(); return; }
      // grabY=ブロック上端からの掴み位置。drop で差し引いて「ゴーストの見た目どおり」に着地させる
      // （これが無いと カーソル位置=開始時刻 になり、掴んだ場所の分だけ下にズレる）。トレイのチップは 0。
      const grabY = el.classList.contains("cal-block") ? e.clientY - el.getBoundingClientRect().top : 0;
      drag = { taskId: +el.dataset.task, fromMember: +el.dataset.member, mins: +el.dataset.mins, planId: el.dataset.plan ? +el.dataset.plan : null, grabY };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(drag.taskId)); } catch { /* noop */ }
      // ブラウザ標準の追従ゴーストは消し、SNAP刻みの着地プレビュー（cal-ghost）だけにする
      try { e.dataTransfer.setDragImage(BLANK_IMG, 0, 0); } catch { /* noop */ }
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); removeGhost(); _root.querySelectorAll(".cal-colbody.over").forEach((c) => c.classList.remove("over")); });
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
  // B11: × で配置済みブロックを未配置（トレイ）へ戻す。
  // mousedown で drag 開始を止め、click で unplace。block の dragstart は別途 resizing 同様にガード不要だが、
  // ボタン上から掴んだ時に block の dragstart が走らないよう mousedown で stopPropagation する。
  _root.querySelectorAll(".cal-unplace").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    btn.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", async (e) => {
      e.stopPropagation(); e.preventDefault();
      const blk = btn.closest(".cal-block");
      if (!blk) return;
      await unplace(+blk.dataset.task, +blk.dataset.plan, +blk.dataset.member, +blk.dataset.mins);
    });
  });
  // 会議/定例: クリックで「この回だけ変更」（📎リンクは除く）
  _root.querySelectorAll(".cal-block.cal-fixed").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      openOccurrenceEditor(+el.dataset.rec, el.dataset.orig);
    });
  });
  _root.querySelectorAll(".cal-colbody").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault(); col.classList.add("over");
      if (!drag) return;
      // SNAP刻みの着地プレビュー: 15分(0.25h)ごとに段階的に動く
      const startMin = snapStartMin(col, e);
      if (!ghost) { ghost = document.createElement("div"); ghost.className = "cal-ghost"; }
      if (ghost.parentElement !== col) col.appendChild(ghost);
      ghost.style.top = min2top(startMin) + "px";
      ghost.style.height = Math.max(18, (drag.mins / 60) * HOURH) + "px";
      ghost.textContent = `${hhmm(startMin)}–${hhmm(startMin + drag.mins)}`;
    });
    col.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && col.contains(e.relatedTarget)) return; // 子要素間の移動は無視
      col.classList.remove("over");
      if (ghost && ghost.parentElement === col) removeGhost();
    });
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      if (!drag) return;
      const startMin = snapStartMin(col, e);
      removeGhost();
      const toMember = +col.dataset.member;
      await place(drag, toMember, startMin);
      drag = null;
    });
  });
}

// 「この回だけ変更」（Googleカレンダーの「この予定のみ」相当）。
// recurrences.overrides[origISO] に {date, start_minute, duration_seconds} or {skip:true} を保存。
// 基準値と同じ項目は保存しない（差分のみ）。全部基準値どおりなら例外を解除。
function openOccurrenceEditor(recId, origISO) {
  if (document.querySelector(".cal-ovm")) return; // モーダル積層防止（連打対策）
  const rec = (_data.recurrences || []).find((r) => r.id === recId);
  if (!rec) return;
  const ov = (rec.overrides || {})[origISO] || {};
  const d = new Date(rec.dtstart);
  const baseMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const curDate = ov.date || origISO;
  const curMin = ov.start_minute != null ? ov.start_minute : baseMin;
  const curDur = Math.round(((ov.duration_seconds || rec.duration_seconds || 0) / 3600) * 100) / 100;

  const wrap = document.createElement("div");
  wrap.className = "cal-ovm";
  wrap.innerHTML = `
    <div class="cal-ovm-bg"></div>
    <div class="cal-ovm-card">
      <div class="cal-ovm-h"><b>${esc(rec.title)}</b><span>この回だけ変更（${origISO.replace(/-/g, "/")} の回）</span></div>
      <label class="cal-ovm-l">日付</label>
      <input id="ov-date" class="cal-ovm-in" type="text" inputmode="numeric" autocomplete="off" value="${curDate.replace(/-/g, "/")}">
      <div class="cal-ovm-row">
        <div><label class="cal-ovm-l">開始時刻</label>
          <input id="ov-time" class="cal-ovm-in" type="text" inputmode="numeric" autocomplete="off" value="${hhmm(curMin)}"></div>
        <div><label class="cal-ovm-l">所要(h)</label>
          <input id="ov-dur" class="cal-ovm-in" type="text" inputmode="decimal" autocomplete="off" value="${curDur}"></div>
      </div>
      <div class="cal-ovm-err" id="ov-err"></div>
      <div class="cal-ovm-acts">
        <button id="ov-skip" class="cal-ovm-ghost">この回を休止</button>
        ${(rec.overrides || {})[origISO] ? `<button id="ov-reset" class="cal-ovm-ghost">例外を解除</button>` : ""}
        <span style="flex:1"></span>
        <button id="ov-cancel" class="cal-ovm-ghost">キャンセル</button>
        <button id="ov-save" class="cal-ovm-save">この回を変更</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const $ = (s) => wrap.querySelector(s);
  const close = () => wrap.remove();
  wrap.querySelector(".cal-ovm-bg").onclick = close;
  $("#ov-cancel").onclick = close;

  let _ovBusy = false;
  const saveOverrides = async (newOv) => {
    if (_ovBusy) return; // 二重PUT防止（連打対策）
    _ovBusy = true;
    const btns = wrap.querySelectorAll(".cal-ovm-acts button");
    btns.forEach((b) => (b.disabled = true)); // await 前に無効化
    try {
      const overrides = { ...(rec.overrides || {}) };
      if (newOv) overrides[origISO] = newOv; else delete overrides[origISO];
      await updateRecurrence(rec.id, {
        title: rec.title, kind: rec.kind, rrule: rec.rrule, dtstart: rec.dtstart,
        duration_seconds: rec.duration_seconds, project_id: rec.project_id,
        assignee_ids: rec.assignee_ids, rotation: !!rec.rotation, note: rec.note || "",
        overrides,
      });
      invalidate();
      _data = await load();
      close();
      paint();
    } catch (e) {
      _ovBusy = false; // 失敗時のみ復帰（再操作可能に）
      btns.forEach((b) => (b.disabled = false));
      throw e;
    }
  };

  $("#ov-skip").onclick = () => saveOverrides({ skip: true });
  const reset = $("#ov-reset");
  if (reset) reset.onclick = () => saveOverrides(null);
  $("#ov-save").onclick = async () => {
    const err = $("#ov-err");
    const dm = $("#ov-date").value.trim().match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})$/);
    const dateISO = dm ? `${dm[1]}-${String(+dm[2]).padStart(2, "0")}-${String(+dm[3]).padStart(2, "0")}` : null;
    if (!dateISO) { err.textContent = "日付の形式が不正です（例: 2026/06/17）。"; return; }
    const tm = $("#ov-time").value.trim().match(/^(\d{1,2})[:：]?(\d{2})$/);
    const min = tm && +tm[1] < 24 && +tm[2] < 60 ? (+tm[1]) * 60 + (+tm[2]) : null;
    if (min == null) { err.textContent = "開始時刻の形式が不正です（例: 10:00）。"; return; }
    const durNum = parseFloat($("#ov-dur").value.trim().replace(/^\./, "0."));
    if (!isFinite(durNum) || durNum <= 0) { err.textContent = "所要(h)は0より大きい数値で。"; return; }
    const newOv = {};
    if (dateISO !== origISO) newOv.date = dateISO;
    if (min !== baseMin) newOv.start_minute = min;
    const durSec = Math.round(durNum * 3600);
    if (durSec !== rec.duration_seconds) newOv.duration_seconds = durSec;
    await saveOverrides(Object.keys(newOv).length ? newOv : null);
  };
}

// リサイズ確定: 同じ時刻・担当のまま所要だけ変更（plans に更新APIが無いため delete→create）
async function resizePlan(taskId, planId, memberId, startMin, mins) {
  if (_calBusy) return; // 飛行中の二度目の確定を無視（delete→create の重複防止／place と共用ガード）
  _calBusy = true;
  try {
    await deletePlan(taskId, planId);
    await logPlan(taskId, mins * 60, _day, "", memberId, startMin);
    invalidate();
    _data = await load();
    paint();
  } finally {
    _calBusy = false;
  }
}

// B11: 配置済み→未配置。時刻付き plan を消し、start_minute 無しで作り直す（今日の負荷は維持）。
// 担当・所要はそのまま。これで buildModel のトレイ側（start_minute 無し）へ戻る。
async function unplace(taskId, planId, memberId, mins) {
  if (_calBusy) return; // place/resizePlan と共用ガード（delete→create の重複防止）
  _calBusy = true;
  try {
    await deletePlan(taskId, planId);
    await logPlan(taskId, mins * 60, _day, "", memberId, null); // 時刻なし＝未配置
    invalidate();
    _data = await load();
    paint();
  } finally {
    _calBusy = false;
  }
}

async function place(drag, toMember, startMin) {
  if (_calBusy) return; // 飛行中の二度目ドロップを無視（delete→create の重複防止）
  _calBusy = true;
  try {
    const seconds = drag.mins * 60;
    // 既存の今日plan（このタスク×元担当）を削除してから時刻付きで作り直す（移動）。
    const plans = (_data.plansByTask && _data.plansByTask.get && _data.plansByTask.get(drag.taskId)) || [];
    const aids = ((_data.tasks.find((t) => t.id === drag.taskId) || {}).assignees || []).map((a) => a.id);
    const sameDay = plans.filter((p) => dateOnly(p.plan_date) === _day &&
      (p.user_id === drag.fromMember || p.user_id === toMember || !p.user_id || !aids.includes(p.user_id)));
    for (const p of sameDay) await deletePlan(drag.taskId, p.id);
    await logPlan(drag.taskId, seconds, _day, "", toMember, startMin);
    invalidate();
    _data = await load();
    paint();
  } finally {
    _calBusy = false;
  }
}

function nowMinutes() {
  const n = new Date();
  if (n.toISOString().slice(0, 10) !== _day) return -1;
  return n.getHours() * 60 + n.getMinutes();
}

function css() {
  return `
  .cal-nav{display:flex;align-items:center;gap:6px;margin:0 0 12px}
  .cal-nav-btn{font:inherit;font-size:13px;line-height:1;min-width:30px;height:30px;padding:0 8px;border:1px solid ${C.line};background:#fff;color:${C.ink};border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  .cal-nav-btn:hover{border-color:${C.fill};color:${C.fill}}
  .cal-nav-today{font-weight:700}
  .cal-nav-date{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};margin-left:4px}
  .cal-nav-date:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .cal-tray{margin:0 0 14px}
  .cal-tray-h{font-size:11.5px;color:${C.muted};font-weight:600;margin-bottom:6px}
  .cal-tray-list{display:flex;gap:8px;flex-wrap:wrap;min-height:34px;background:#fafbfc;border:1px dashed ${C.line};border-radius:10px;padding:8px}
  .cal-chip{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ${C.line};border-left:3px solid ${C.full};border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:grab;box-shadow:0 1px 2px rgba(20,30,50,.05)}
  .cal-chip:active{cursor:grabbing}
  .cal-chip-t{font-weight:600;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cal-chip-h{color:${C.muted};font-variant-numeric:tabular-nums}
  .cal-tray-empty{font-size:12px;color:${C.muted};padding:4px}
  .cal-pool{margin:0 0 14px}
  .cal-pool-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
  .cal-pool-hd .cal-tray-h{margin-bottom:0}
  .cal-pool-q{font:inherit;font-size:12.5px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff;width:220px}
  .cal-pool-q:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .cal-pool-list{max-height:104px;overflow:auto}
  .cal-pool-chip{border-left-color:${C.fill}}
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
  .cal-block.dragging,.cal-chip.dragging{opacity:.35}
  .cal-ghost{position:absolute;left:3px;right:3px;z-index:4;pointer-events:none;border:1.5px dashed ${C.fill};background:rgba(58,134,255,.13);border-radius:7px;color:${C.fill};font-size:10.5px;font-weight:700;display:flex;align-items:flex-start;justify-content:center;padding-top:2px;font-variant-numeric:tabular-nums}
  .cal-block.cal-hatch{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.85) 0 1.4px,transparent 1.4px 3px)}
  .cal-block.cal-dots{background-image:radial-gradient(rgba(255,255,255,.9) .9px,transparent 1.1px);background-size:3px 3px}
  .cal-bt{font-size:11.5px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cal-bh{font-size:10px;opacity:.92;margin-top:1px;white-space:nowrap}
  .cal-block.cal-fixed{cursor:pointer;opacity:.88;z-index:1}
  .cal-block.cal-fixed:hover{opacity:1}
  .cal-block.cal-ovr{outline:2px dashed rgba(255,255,255,.8);outline-offset:-2px}
  .cal-unplace{position:absolute;top:2px;right:2px;width:16px;height:16px;padding:0;border:none;border-radius:4px;background:rgba(0,0,0,.18);color:#fff;font-size:13px;line-height:14px;cursor:pointer;opacity:0;transition:opacity .12s;z-index:3;display:flex;align-items:center;justify-content:center}
  .cal-block:hover .cal-unplace{opacity:1}
  .cal-unplace:hover{background:rgba(0,0,0,.42)}
  .cal-rs{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize}
  .cal-rs::after{content:"";position:absolute;left:50%;bottom:2px;width:22px;height:3px;margin-left:-11px;border-radius:2px;background:rgba(255,255,255,.65)}
  .cal-ovm{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center}
  .cal-ovm-bg{position:absolute;inset:0;background:rgba(20,30,50,.38)}
  .cal-ovm-card{position:relative;width:min(360px,92vw);background:#fff;border:1px solid ${C.line};border-radius:14px;box-shadow:0 18px 50px rgba(20,30,50,.28);padding:18px 20px}
  .cal-ovm-h b{font-size:14.5px;display:block}
  .cal-ovm-h span{font-size:11.5px;color:${C.muted}}
  .cal-ovm-l{display:block;font-size:11.5px;color:${C.muted};font-weight:600;margin:12px 0 4px}
  .cal-ovm-in{width:100%;font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid ${C.line};border-radius:8px;box-sizing:border-box}
  .cal-ovm-in:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .cal-ovm-row{display:flex;gap:10px}.cal-ovm-row>div{flex:1}
  .cal-ovm-err{color:${C.over};font-size:12px;min-height:16px;margin-top:8px;font-weight:600}
  .cal-ovm-acts{display:flex;gap:8px;margin-top:10px;align-items:center}
  .cal-ovm-ghost{font:inherit;font-size:12.5px;padding:7px 12px;border-radius:8px;border:1px solid ${C.line};background:#fff;color:${C.muted};cursor:pointer}
  .cal-ovm-ghost:hover{color:${C.ink}}
  .cal-ovm-save{font:inherit;font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:8px;border:1px solid ${C.fill};background:${C.fill};color:#fff;cursor:pointer}
  .cal-ovm-save:hover{filter:brightness(1.05)}
  /* ===== ダーク: ハードコード淡色を構造色へ（ライトは非変更・アクセントは維持） ===== */
  html[data-theme="dark"] .cal-tray-list{background:var(--track)}
  html[data-theme="dark"] .cal-chip{background:var(--card)}
  html[data-theme="dark"] .cal-pool-q{background:var(--card);color:var(--ink)}
  html[data-theme="dark"] .cal-colbody.over{background:rgba(58,134,255,.13)}
  html[data-theme="dark"] .cal-ovm-card{background:var(--card)}
  html[data-theme="dark"] .cal-ovm-ghost{background:var(--card)}`;
}
