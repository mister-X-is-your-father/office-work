// かんばん（再設計）。「仕事の状況が一目でわかる道具」＝(1)期限がヤバいタスク (2)案件ごとの進み具合 を即答する。
// 旧式（Vikunja bucket 依存・単一WS固定）をやめ、全タスクをフロントで「ステータス軸」にグルーピングして描画する。
// データは壊さない＝bucket 系 API（getViewTasks/createBucket/moveTaskToBucket 等）はもう呼ばない（呼ばないだけ）。
import { load, invalidate, isAiUser, ensureInbox } from "../lib/store.js";
import { updateTask, getTask, setTaskWaiting, createTaskInProject, createProject, addRelation, removeRelation } from "../lib/api.js";
import { PRIO, prioBucket, STATUS, statusOf } from "../lib/kinds.js";
import { C, fmtH, esc, todayISO, announce, avatar } from "../lib/ui.js";
import { shiftISO } from "../lib/capacity.js";
import { taskMatches, next7End } from "../lib/smartlist.js";
import { icon } from "../lib/icons.js";
import { startFocusFor } from "./pomodoro.js";
import { openTaskForm } from "./taskform.js";
import * as history from "../lib/history.js";

history.initHistoryHotkeys(); // Ctrl/Cmd+Z=取消・Ctrl+Y/Ctrl+Shift+Z=やり直し

// ── ローカル設定（本人ごと・スキーマ変更なし）──
const SWIM_KEY = "ts.kanban.swim";     // 案件スイムレーン ON/OFF（2軸グリッド）
const PRESET_KEY = "ts.kanban.preset"; // 絞り込みプリセット（既定=今週）
const WHO_KEY = "ts.kanban.who";       // 担当フィルタ（""=全員 / メンバーid。既定=全員）
const STATUS_ORDER = ["todo", "doing", "waiting", "done"];

// 絞り込みプリセット（期限重視）。filter は smartlist.taskMatches に渡す形に正確に合わせる。
// 完了タスクは「完了列には出すが、既定では件数を絞る」ため status は触らず due 軸だけで絞る方針
// （完了列の表示制御は filterDoneFor で別途行う）。
const PRESETS = [
  { key: "all",     label: "すべて",   filter: {} },
  { key: "today",   label: "今日",     filter: { due: "today" } },
  { key: "week",    label: "今週",     filter: { due: "next7" } },
  { key: "overdue", label: "期限切れ", filter: { due: "overdue", status: "undone" } },
  { key: "inbox",   label: "未整理",   filter: { unsorted: true, status: "undone" } },
];
const DEFAULT_PRESET = "week";

// WIP（進行中の詰まり）警告のしきい値（妥当な既定）。報告: 件数>8 または 合計見積>24h で ⚠。
const WIP_COUNT = 8;
const WIP_HOURS = 24;
// 停滞しきい値（updated からの経過日数。状態遷移ログが無いので updated 基準で代用）。報告: 既定3日。
const STALE_DAYS = 3;

let _root;
let _today = "";
let _moving = false;

export async function render(root) {
  closeMoveMenu(); // 再描画前にタッチ移動メニューを閉じる（body 直下のポップが孤立しないように）
  _root = root;
  _today = todayISO();
  // B20: getTasks() 直叩きをやめ store 共有の rawTasks（除外WS等でフィルタ前の全タスク＝全WS横断）を使う。
  // invalidate→load で再取得される。getTasks は _loadImpl 内で Promise.all され、失敗時は load() が reject。
  let members, me, tasks;
  try {
    ({ members, me, rawTasks: tasks } = await load());
    tasks = tasks || [];
  } catch (e) { tasks = []; root.innerHTML = errHtml(e); return; }

  const memberIdx = new Map((members || []).map((m, i) => [m.id, i]));
  const preset = loadPreset();
  const swim = loadSwim();
  const who = loadWho(); // ""=全員 / メンバーid文字列

  // 絞り込み（完了は status を触らず別制御）。preset.filter を taskMatches へ。
  const ctx = { today: _today, next7: next7End(_today) };
  const presetDef = PRESETS.find((p) => p.key === preset) || PRESETS[0];
  let filtered = (tasks || []).filter((t) => taskMatches(t, presetDef.filter, ctx));

  // B4: 担当フィルタ（自分/全員/各人）。選択した担当者がアサインされたタスクのみ。
  if (who) filtered = filtered.filter((t) => (t.assignees || []).some((a) => String(a.id) === who));

  // 完了列の絞り: 既定（すべて/今日/今週/未整理）では「今日完了 or 直近7日で更新」のみ。
  // 「期限切れ」プリセットは完了を出さない（status:undone で既に除外済み）。多すぎる完了で画面が埋まらないように。
  const showAllDone = preset === "all";
  const doneVisible = (t) => {
    if (!t.done) return true;
    if (showAllDone) return true;
    const u = (t.updated && !t.updated.startsWith("0001")) ? t.updated.slice(0, 10) : "";
    const doneToday = t.done_at && !t.done_at.startsWith("0001") && t.done_at.slice(0, 10) === _today;
    return doneToday || (u && u >= shiftISO(_today, -7));
  };
  const visible = filtered.filter(doneVisible);

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">かんばん <small>状況が一目でわかる ・ ドラッグ／Ctrl+左右で列移動 ・ クリックで編集</small></h1>
    ${toolbarHtml(preset, swim, who, members, me)}
    <div class="kb-wrap">${swim ? swimHtml(visible, memberIdx) : boardHtml(visible, memberIdx)}</div>`;

  wireToolbar(root);
  wireCards(root, tasks, memberIdx);
  wireColumns(root, tasks);
  wireAdd(root);
}

// ── ツールバー（プリセットタブ＋担当フィルタ＋スイムレーントグル）──
function toolbarHtml(preset, swim, who, members, me) {
  // 共有セグメント(.seg/.seg-b)に寄せる。サイズ据え置きの微差は .kb-tabs 側で最小上書き（視覚パリティ維持）。
  const tabs = PRESETS.map((p) =>
    `<button class="seg-b kb-tab${p.key === preset ? " on" : ""}" data-preset="${p.key}">${esc(p.label)}</button>`).join("");
  return `<div class="kb-tools">
    <div class="seg kb-tabs" role="tablist">${tabs}</div>
    ${whoTabsHtml(who, members, me)}
    <button class="kb-swim${swim ? " on" : ""}" data-swim title="案件（親タスク）ごとに行を分けて進み具合を見る">
      ${icon("folders", { size: 14 })}<span>案件レーン</span>
    </button>
  </div>`;
}

// 担当フィルタ（全員 / 自分 / 各メンバー）。quad.js の whoTabs と同じ作法。選択は localStorage 永続。
function whoTabsHtml(who, members, me) {
  const meId = me && me.id;
  const meMember = (members || []).find((m) => m.id === meId);
  const others = (members || []).filter((m) => m.id !== meId);
  // アバターは共有 avatar() に置換（色は従来どおり member id 基準＝colorIndex:m.id。サイズ16px据え置き）。
  // 表示ラベルは label を別途出す（avatar はイニシャルのみ）。「全員」はアバター無し。
  const btn = (val, label, member) => {
    const on = String(who) === String(val) ? " on" : "";
    const av = member ? avatar({ ...member, colorIndex: member.id }, { size: 16 }) : "";
    return `<button class="kb-who-b${on}" data-who="${esc(String(val))}">${av}${esc(label)}</button>`;
  };
  const tabs = btn("", "全員", null)
    + (meMember ? btn(meMember.id, "自分", meMember) : "")
    + others.map((m) => btn(m.id, m.name || m.username, m)).join("");
  return `<div class="kb-who" role="group" aria-label="担当フィルタ">${tabs}</div>`;
}

function wireToolbar(root) {
  root.querySelectorAll("[data-preset]").forEach((b) => {
    b.onclick = () => { savePreset(b.dataset.preset); render(_root); };
  });
  root.querySelectorAll("[data-who]").forEach((b) => {
    b.onclick = () => { saveWho(b.dataset.who); render(_root); };
  });
  const sw = root.querySelector("[data-swim]");
  if (sw) sw.onclick = () => { saveSwim(!loadSwim()); render(_root); };
}

// ── 通常ボード（ステータス列のみ）──
function boardHtml(tasks, memberIdx) {
  const cols = STATUS_ORDER.map((key) => {
    const list = sortByDue(tasks.filter((t) => statusOf(t) === key));
    return columnHtml(key, list, memberIdx, null);
  });
  return `<div class="kb-board">${cols.join("")}</div>`;
}

// ── 案件スイムレーン（2軸グリッド: 行=親タスク × 列=ステータス）──
// 親なしは「その他」行。各セルは期限昇順。行は「ヤバい度」（期限切れ/今日を含む行を上）で並べる。
function swimHtml(tasks, memberIdx) {
  // 親（案件）でグルーピング。親 = related_tasks.parenttask[0]（title/id を持つ）。
  const lanes = new Map(); // key(parentId|"_none") -> { id, title, tasks:[] }
  for (const t of tasks) {
    const p = (((t.related_tasks || {}).parenttask) || [])[0] || null;
    const key = p ? String(p.id) : "_none";
    if (!lanes.has(key)) lanes.set(key, { id: p ? p.id : 0, title: p ? p.title : "その他（案件なし）", tasks: [] });
    lanes.get(key).tasks.push(t);
  }
  // 行の並び: ヤバいタスク（期限切れ/今日）を含む案件を上へ。次に未完了件数の多い順。「その他」は末尾。
  const urgency = (lane) => lane.tasks.reduce((s, t) => {
    const d = dueOf(t);
    if (!t.done && d && d < _today) return s + 100;
    if (!t.done && d === _today) return s + 10;
    return s;
  }, 0);
  const rows = [...lanes.values()].sort((a, b) => {
    if (a.id === 0) return 1; if (b.id === 0) return -1; // その他は末尾
    const u = urgency(b) - urgency(a); if (u) return u;
    return b.tasks.length - a.tasks.length;
  });

  const headerCells = STATUS_ORDER.map((k) => `<div class="kb-shead">${esc(STATUS[k].label)}</div>`).join("");
  const laneRows = rows.map((lane) => {
    const cells = STATUS_ORDER.map((key) => {
      const list = sortByDue(lane.tasks.filter((t) => statusOf(t) === key));
      const cards = list.map((t) => cardHtml(t, memberIdx)).join("");
      return `<div class="kb-scell kb-cards" data-status="${key}" data-lane="${lane.id}">${cards}</div>`;
    }).join("");
    const cnt = lane.tasks.filter((t) => !t.done).length;
    const laneLabel = `<div class="kb-lanehd" title="${esc(lane.title)}">
      ${icon("folder", { size: 13 })}<span class="kb-lanet">${esc(lane.title)}</span>
      <span class="kb-lanecnt">${cnt}</span>
    </div>`;
    return `<div class="kb-lanegrid">${laneLabel}${cells}</div>`;
  });
  return `<div class="kb-swimboard">
    <div class="kb-swimhd"><div class="kb-shead-corner"></div>${headerCells}</div>
    ${laneRows.join("")}
  </div>`;
}

// ── 1ステータス列（通常ボード用。ヘッダにキャパ集計＋WIP警告、フッタに＋追加）──
function columnHtml(key, list, memberIdx, _laneId) {
  const undone = list.filter((t) => !t.done);
  const totH = undone.reduce((s, t) => s + (t.time_estimate || 0) / 3600, 0);
  const warn = key === "doing" && (undone.length > WIP_COUNT || totH > WIP_HOURS);
  const cards = list.map((t) => cardHtml(t, memberIdx)).join("");
  return `<div class="kb-col" data-status="${key}">
    <div class="kb-colh${warn ? " warn" : ""}">
      <span class="kb-colt">${esc(STATUS[key].label)}</span>
      <span class="kb-cnt">${list.length}</span>
      ${totH > 0 ? `<span class="kb-sum">${fmtH(totH)}</span>` : ""}
      ${warn ? `<span class="kb-wip" title="進行中が詰まっています（WIP過多）">${icon("alertTriangle", { size: 13 })}</span>` : ""}
    </div>
    <div class="kb-cards" data-status="${key}">${cards}</div>
    <div class="kb-add" data-status="${key}">
      <button class="kb-addbtn" data-addbtn="${key}" title="この列にタスクを追加">${icon("inbox", { size: 13 })} 追加</button>
    </div>
  </div>`;
}

// ── カード（本機能の肝: 期限ヒート / 停滞 / 案件 / 担当 / 見積）──
function cardHtml(t, memberIdx) {
  const due = dueOf(t);
  const heat = heatOf(due, t.done);          // overdue|today|week|""
  const pb = prioBucket(t.priority);
  const est = t.time_estimate ? fmtH(t.time_estimate / 3600) : null;
  const who = (t.assignees || []).find((a) => !isAiUser(a)) || null;
  // 共有 avatar() に置換（色は従来どおり members 配列内 index 基準＝colorIndex で固定。サイズ18px据え置き）。
  const ava = who ? avatar({ ...who, colorIndex: memberIdx.get(who.id) ?? 0 }, { size: 18 }) : "";
  const parent = (((t.related_tasks || {}).parenttask) || [])[0] || null;
  const projBadge = parent
    ? `<span class="kb-proj" style="border-color:${projColor(parent.id)};color:${projColor(parent.id)}" title="案件: ${esc(parent.title)}">${esc(parent.title)}</span>`
    : "";

  // 期限バッジ（SVG＋文字。絵文字は使わない）。期限なしは無印。
  const dueBadge = due
    ? `<span class="kb-due heat-${heat || "none"}">${icon("calendar", { size: 11 })}${dueLabel(due)}</span>`
    : "";

  // 停滞バッジ: updated からの経過日数（状態遷移ログが無いので updated で代用）。
  const stale = staleDays(t);
  const isWaiting = statusOf(t) === "waiting";
  let staleBadge = "";
  if (!t.done && stale != null) {
    if (isWaiting) {
      staleBadge = `<span class="kb-stale wait" title="連絡待ちの経過日数">${icon("hourglass", { size: 11 })}${stale}日待ち</span>`;
    } else if (stale >= STALE_DAYS) {
      staleBadge = `<span class="kb-stale" title="${STALE_DAYS}日以上更新がありません（停滞）">${icon("alertTriangle", { size: 11 })}停滞${stale}日</span>`;
    }
  }

  return `<div class="kb-card${t.done ? " done" : ""}${heat ? " h-" + heat : ""}" draggable="true" data-id="${t.id}" tabindex="0" role="button" aria-label="${esc(t.title)} を編集（Enterで編集 / Ctrl+左右で列移動）">
    <button type="button" class="kb-move" data-move aria-haspopup="menu" aria-expanded="false" title="移動（タップで移動先を選ぶ）" aria-label="「${esc(t.title)}」を移動">${icon("chevronRight", { size: 14 })}</button>
    <div class="kb-ct"><i class="kb-prio" style="background:${pb ? PRIO[pb].c : "#c6cdd6"}"></i>${esc(t.title)}</div>
    ${projBadge ? `<div class="kb-cr">${projBadge}</div>` : ""}
    <div class="kb-cm">
      ${ava}
      ${dueBadge}
      ${staleBadge}
      ${est ? `<span class="kb-est">${icon("timer", { size: 11 })}${est}</span>` : ""}
      ${t.done ? `<span class="kb-donetag">${icon("check", { size: 11 })}完了</span>` : ""}
      <button type="button" class="kb-timer" data-timer title="このタスクでタイマー開始" aria-label="このタスクでタイマー開始">${icon("timer", { size: 13 })}</button>
    </div>
  </div>`;
}

// ── カードの操作（クリックで編集・ドラッグ開始・キーボード移動）──
// tasks/memberIdx を各カードに紐付け、楽観移動後に差し替えるカードも wireOneCard で同じ配線にする。
function wireCards(root, tasks, memberIdx) {
  root.querySelectorAll(".kb-card").forEach((card) => {
    card._tasks = tasks;
    wireOneCard(card, memberIdx);
  });
}

// 1枚のカードへ全配線（render 時と、楽観移動後の差し替えカードの両方で使う）。
function wireOneCard(card, memberIdx) {
  card._memberIdx = memberIdx;
  // 差し替え時は元カードの _tasks を引き継ぐ（差し替え呼び出し側で設定済みでなければ既存参照を保持）。
  const tasks = card._tasks || (card._tasks = []);
  const taskOf = () => (tasks || []).find((x) => x.id === +card.dataset.id);
  const edit = () => openTaskForm({ taskId: +card.dataset.id, onSaved: () => { invalidate(); render(_root); } });
  card.onclick = edit;
  // タッチ用「移動」: ネイティブHTML5 DnD が効かない端末向けの代替。タップで移動先メニューを開く。
  // 既存の DnD・クリック編集は温存（このボタンは編集と競合しないよう stopPropagation）。
  const moveBtn = card.querySelector("[data-move]");
  if (moveBtn) {
    moveBtn.draggable = false;
    moveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = taskOf();
      if (!t) return;
      openMoveMenu(moveBtn, card, t, memberIdx);
    });
    // mousedown/touchstart も止めてカードの dragstart / click 編集を誘発しない。
    moveBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    moveBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
  // 「タイマー起動」: このカードのタスクで即・集中タイマー開始。カードの編集/ドラッグと競合させない。
  const timerBtn = card.querySelector(".kb-timer");
  if (timerBtn) {
    timerBtn.draggable = false;
    timerBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = taskOf();
      if (!t) return;
      const ok = startFocusFor(t.id, t.title);
      if (ok === false) { // 既に別タスクで稼働中＝上書きしない。title で簡易フィードバック。
        timerBtn.classList.add("busy"); timerBtn.title = "別のタスクでタイマー稼働中です";
        setTimeout(() => { timerBtn.classList.remove("busy"); timerBtn.title = "このタスクでタイマー開始"; }, 1600);
      }
    });
    timerBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    timerBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
  card.addEventListener("keydown", (e) => {
    if (e.target !== card) return;
    // B67: Ctrl+←/→ で前/次ステータスへ移動（フォーカス中カード）。クリック編集(Enter/Space)とは競合させない。
    if ((e.ctrlKey || e.metaKey) && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      if (_moving) return;
      const t = taskOf();
      if (!t) return;
      const idx = STATUS_ORDER.indexOf(statusOf(t));
      if (idx < 0) return;
      const next = idx + (e.key === "ArrowRight" ? 1 : -1);
      if (next < 0 || next >= STATUS_ORDER.length) return; // 端では何もしない
      moveStatus(card, t, STATUS_ORDER[next]);
      return;
    }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); }
  });
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", card.dataset.id); } catch { /* noop */ }
    card.classList.add("kb-dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("kb-dragging"));
}

// ── タッチ用「移動先メニュー」（ネイティブDnDが効かない端末の代替。tb-ctx 風の軽量ポップ）──
// 既存の移動関数をそのまま呼ぶ: ステータス=moveStatus(card,t,key)（楽観更新＋history＋announce）、
// レーン(案件)=moveLane(t,parentId)（drop と同じ全再描画パス）。同時に1つだけ開く。
let _menuEl = null;
let _menuCleanup = null;
function closeMoveMenu() {
  if (_menuCleanup) { try { _menuCleanup(); } catch { /* noop */ } _menuCleanup = null; }
  if (_menuEl) { _menuEl.remove(); _menuEl = null; }
}
function openMoveMenu(anchor, card, t, memberIdx) {
  if (_menuEl) { const same = _menuEl._anchor === anchor; closeMoveMenu(); if (same) return; }
  const curStatus = statusOf(t);
  // スイムレーン表示中なら、このカードが属するレーン(=現在の親案件)も把握。
  const curCol = card.closest(".kb-cards");
  const inSwim = !!(curCol && curCol.dataset && curCol.dataset.lane != null);
  const curLane = inSwim ? curCol.dataset.lane : null;

  let rows = "";
  // ステータス移動（現在の列は disabled＋✓）。
  rows += `<div class="kb-mm-h">移動先（状況）</div>`;
  rows += STATUS_ORDER.map((key) => {
    const on = key === curStatus;
    return `<button type="button" class="kb-mm-i${on ? " on" : ""}" data-st="${key}"${on ? " disabled" : ""}>
      <span class="kb-mm-chk">${on ? icon("check", { size: 13 }) : ""}</span>${esc((STATUS[key] || {}).label || key)}
    </button>`;
  }).join("");

  // スイムレーン時のみ: 案件（レーン）移動。表示中の全レーンを DOM から収集（現在のレーンは disabled）。
  const lanes = [];
  if (inSwim) {
    _root.querySelectorAll(".kb-lanegrid").forEach((g) => {
      const cell = g.querySelector(".kb-scell[data-lane]");
      const hd = g.querySelector(".kb-lanet");
      if (!cell || !hd) return;
      const id = cell.dataset.lane;
      lanes.push({ id, title: hd.textContent || "" });
    });
    if (lanes.length) {
      rows += `<div class="kb-mm-h">移動先（案件）</div>`;
      rows += lanes.map((ln) => {
        const on = String(ln.id) === String(curLane);
        return `<button type="button" class="kb-mm-i${on ? " on" : ""}" data-lane="${esc(ln.id)}"${on ? " disabled" : ""}>
          <span class="kb-mm-chk">${on ? icon("check", { size: 13 }) : ""}</span>${icon("folder", { size: 12 })}<span class="kb-mm-lt">${esc(ln.title)}</span>
        </button>`;
      }).join("");
    }
  }

  const menu = document.createElement("div");
  menu.className = "kb-mm";
  menu.setAttribute("role", "menu");
  menu._anchor = anchor;
  menu.innerHTML = rows;
  document.body.appendChild(menu);
  _menuEl = menu;
  anchor.setAttribute("aria-expanded", "true");

  // 位置決め: アンカー右下基準。画面外にはみ出すなら左/上へ寄せる。
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  menu.querySelectorAll("[data-st]").forEach((b) => {
    b.addEventListener("click", async () => {
      const key = b.dataset.st;
      closeMoveMenu();
      if (key && key !== curStatus) await moveStatus(card, t, key);
    });
  });
  menu.querySelectorAll("[data-lane]").forEach((b) => {
    b.addEventListener("click", async () => {
      const pid = +b.dataset.lane;
      closeMoveMenu();
      if (String(pid) !== String(curLane)) await moveToLane(t, pid);
    });
  });

  // 外側クリック / Esc / スクロール / リサイズで閉じる。
  const onDoc = (e) => { if (_menuEl && !_menuEl.contains(e.target) && e.target !== anchor) closeMoveMenu(); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeMoveMenu(); try { anchor.focus(); } catch { /* noop */ } } };
  const onScroll = () => closeMoveMenu();
  setTimeout(() => document.addEventListener("click", onDoc, true), 0);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onScroll, true);
  window.addEventListener("scroll", onScroll, true);
  _menuCleanup = () => {
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onScroll, true);
    window.removeEventListener("scroll", onScroll, true);
  };
  // 最初の選択可能項目へフォーカス（キーボード操作の足がかり）。
  const first = menu.querySelector(".kb-mm-i:not([disabled])");
  if (first) try { first.focus(); } catch { /* noop */ }
}

// メニューからの案件（レーン）移動。drop のレーン跨ぎパスと同じ副作用（moveLane→全再描画）。
async function moveToLane(t, newParentId) {
  if (_moving) return;
  _moving = true;
  try { await moveLane(t, newParentId); } finally { _moving = false; }
  rerender();
}

// ── 列（ドロップ先）: drop でステータス更新＋Undo/Redo（table.js の applyState と同じ副作用セット）──
// B19: ステータスのみの変更は楽観更新（drop直後に即移動＋「保存中」薄表示→成功で該当カードだけ反映／失敗で元へ戻す）。
// レーン跨ぎ（案件付け替え）は行グルーピングが変わるため従来どおり全再描画。
function wireColumns(root, tasks) {
  root.querySelectorAll(".kb-cards").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      if (_moving) return;
      const taskId = +e.dataTransfer.getData("text/plain");
      const target = col.dataset.status;
      if (!taskId || !target) return;
      const t = (tasks || []).find((x) => x.id === taskId);
      if (!t) return;
      const laneAttr = col.dataset.lane;
      const newParentId = laneAttr != null ? +laneAttr : null;
      const cur = (((t.related_tasks || {}).parenttask) || [])[0]?.id || 0;
      const needLane = newParentId != null && cur !== newParentId;
      const needStatus = statusOf(t) !== target;
      if (!needLane && !needStatus) return;

      // レーン跨ぎを伴う場合は従来の全再描画パス（楽観更新は使わない）。
      if (needLane) {
        _moving = true;
        try {
          await moveLane(t, newParentId);
          if (needStatus) await applyStatusChange(t, target);
        } finally { _moving = false; }
        rerender();
        return;
      }

      // ステータスのみ: 楽観更新。
      const card = root.querySelector(`.kb-card[data-id="${taskId}"]`);
      if (!card) { _moving = true; try { await applyStatusChange(t, target); } finally { _moving = false; } rerender(); return; }
      await optimisticStatusMove(card, col, t, target);
    });
  });
}

// 楽観的ステータス移動の共通経路（drop / キーボード 両方から使う）。
// card を target 列へ即移動＋「保存中」薄表示→ applyStatusChange 成功なら該当カードだけ再描画、
// 失敗なら元の位置へ戻し announce。既存の _moving ガード／history.push（applyStatusChange 内）は維持。
async function optimisticStatusMove(card, targetCol, t, target) {
  if (_moving) return;
  _moving = true;
  // 戻し用に元の位置を記録（同一親内の DOM 位置）。
  const origParent = card.parentNode;
  const origNext = card.nextSibling;
  const memberIdx = card._memberIdx;
  // 楽観移動＋保存中表示。
  targetCol.appendChild(card);
  card.classList.add("kb-saving");
  card.setAttribute("aria-busy", "true");
  try {
    const res = await applyStatusChange(t, target);
    if (res.ok) {
      // 該当タスクのみ反映: 最新タスクでカードを差し替え（全再取得しない）。
      if (res.fresh && memberIdx) {
        Object.assign(t, res.fresh); // ローカルの tasks 配列の参照も更新（次の操作の整合のため）
        const tmp = document.createElement("div");
        tmp.innerHTML = cardHtml(res.fresh, memberIdx);
        const fresh = tmp.firstElementChild;
        fresh._tasks = card._tasks; // tasks 参照を引き継ぐ（差し替え後もキーボード移動が効くように）
        card.replaceWith(fresh);
        wireOneCard(fresh, memberIdx);
        try { fresh.focus(); } catch { /* noop */ }
      } else {
        card.classList.remove("kb-saving");
        card.removeAttribute("aria-busy");
      }
      announce(`「${t.title}」を「${(STATUS[target] || {}).label || target}」へ移動しました`);
    } else {
      // 失敗: 元の位置へ戻す。
      if (origNext) origParent.insertBefore(card, origNext); else origParent.appendChild(card);
      card.classList.remove("kb-saving");
      card.removeAttribute("aria-busy");
      announce(`移動に失敗しました: ${res.err && res.err.message ? res.err.message : ""}`, { assertive: true });
    }
  } finally {
    _moving = false;
  }
}

// キーボードからのステータス移動（B67）: 前/次ステータスへ。フォーカス中カードに対して。
async function moveStatus(card, t, key) {
  if (_moving) return;
  // スイムレーン時は同じレーン行内の対象セルへ（親は変えない＝同 data-lane）。通常ボードは唯一の列。
  const curCol = card.closest(".kb-cards");
  const lane = curCol && curCol.dataset ? curCol.dataset.lane : null;
  let col = null;
  if (lane != null) col = _root && _root.querySelector(`.kb-cards[data-status="${key}"][data-lane="${lane}"]`);
  if (!col) col = _root && _root.querySelector(`.kb-cards[data-status="${key}"]`);
  if (col) { await optimisticStatusMove(card, col, t, key); return; }
  // 列DOMが見つからない（万一）の保険: 従来パス。
  _moving = true;
  try { await applyStatusChange(t, key); } finally { _moving = false; }
  rerender();
}

// ステータス変更の本体（_moving ガードは呼び出し側で管理）。
// まず最新タスクを取得（fresh-before スナップショット）してから before/after を組み立てる。
// 戻り値: { ok, fresh } — ok=API成功可否、fresh=適用後の最新タスク（楽観UIの再描画に使う）。
// rerender は呼ばない（呼び出し側が楽観UIで反映 or rerender する）。alert もしない（失敗は ok=false で返す）。
async function applyStatusChange(t, key) {
  let fresh = t;
  try { fresh = await getTask(t.id); } catch { /* keep t */ }
  const wasWaiting = statusOf(fresh) === "waiting";
  const before = { done: !!fresh.done, percent_done: fresh.percent_done || 0, started_at: fresh.started_at || null, waiting: wasWaiting };
  const after = stateFor(fresh, key);

  const applyState = async (taskId, s) => {
    await updateTask(taskId, { done: s.done, percent_done: s.percent_done, started_at: s.started_at });
    let tt = null; try { tt = await getTask(taskId); } catch { tt = t; }
    await setTaskWaiting(tt, !!s.waiting);
  };

  try {
    await applyState(t.id, after);
    history.push({
      label: "ステータス変更",
      undo: async () => { await applyState(t.id, before); rerender(); },
      redo: async () => { await applyState(t.id, after); rerender(); },
    });
    let updated = null; try { updated = await getTask(t.id); } catch { updated = null; }
    return { ok: true, fresh: updated };
  } catch (e) {
    return { ok: false, err: e };
  }
}

// スイムレーンのレーン跨ぎ＝親（案件＝親タスク）の付け替え。_moving ガードは呼び出し側(drop)で管理。
async function moveLane(t, newParentId) {
  const cur = (((t.related_tasks || {}).parenttask) || [])[0]?.id || 0;
  if (cur === newParentId) return;
  try {
    if (cur) await removeRelation(cur, "subtask", t.id);
    if (newParentId) await addRelation(newParentId, t.id, "subtask");
  } catch (e) {
    alert("案件の付け替えに失敗しました: " + (e && e.message ? e.message : ""));
  }
}

// status キー → {done, percent_done, started_at, waiting}（table.js stateOf と同義）。
function stateFor(t, key) {
  if (key === "waiting") {
    return { done: false, percent_done: t.percent_done || 0, started_at: t.started_at || null, waiting: true };
  }
  const keepPct = (t.done || (t.percent_done || 0) >= 100) ? 0 : (t.percent_done || 0);
  if (key === "done") return { done: true, percent_done: 100, started_at: t.started_at || null, waiting: false };
  if (key === "doing") return { done: false, percent_done: keepPct, started_at: new Date().toISOString(), waiting: false };
  return { done: false, percent_done: 0, started_at: null, waiting: false }; // todo
}

function rerender() { invalidate(); if (_root && _root.isConnected) render(_root); }

// ── 列内「＋」インライン追加: input→Enter で createTaskInProject(inbox, {title})＋ステータス付与 ──
function wireAdd(root) {
  root.querySelectorAll("[data-addbtn]").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.addbtn;
      const box = btn.closest(".kb-add");
      const input = document.createElement("input");
      input.className = "kb-addin";
      input.placeholder = "タスク名を入力して Enter";
      box.replaceChildren(input);
      input.focus();
      const restore = () => { box.replaceChildren(makeAddBtn(key)); wireAdd(root); };
      input.onkeydown = async (e) => {
        if (e.key === "Escape") { restore(); return; }
        if (e.key !== "Enter") return;
        const title = input.value.trim();
        if (!title) { restore(); return; }
        input.disabled = true;
        try {
          const inbox = await ensureInbox();
          const created = await createTaskInProject(inbox.id, { title });
          // 作成後、その列のステータスを付与（todo は素のまま）。
          if (key !== "todo") {
            const after = stateFor(created, key);
            await updateTask(created.id, { done: after.done, percent_done: after.percent_done, started_at: after.started_at });
            if (after.waiting) await setTaskWaiting({ id: created.id, labels: [] }, true);
          }
          rerender();
        } catch (err) {
          alert("追加に失敗しました: " + (err && err.message ? err.message : ""));
          restore();
        }
      };
      input.onblur = () => setTimeout(restore, 120);
    };
  });
}
function makeAddBtn(key) {
  const b = document.createElement("button");
  b.className = "kb-addbtn"; b.dataset.addbtn = key; b.title = "この列にタスクを追加";
  b.innerHTML = `${icon("inbox", { size: 13 })} 追加`;
  return b;
}

// ── 純ヘルパ ──
function dueOf(t) { return (t.due_date && !t.due_date.startsWith("0001")) ? t.due_date.slice(0, 10) : ""; }
// 期限ヒート: 過去=overdue(赤) / 今日=today(橙) / 7日内=week(黄) / それ以降=無色。完了は無色。
function heatOf(due, done) {
  if (!due || done) return "";
  if (due < _today) return "overdue";
  if (due === _today) return "today";
  if (due <= shiftISO(_today, 7)) return "week";
  return "";
}
// 期限ラベル: 期限切れ/今日/明日/曜日 or M/D。せっかちな上司に「いつまで」を即答。
function dueLabel(due) {
  if (due < _today) { const d = -daysBetween(_today, due); return `期限切れ${d > 0 ? d + "日" : ""}`; }
  if (due === _today) return "今日";
  if (due === shiftISO(_today, 1)) return "明日";
  const diff = daysBetween(_today, due);
  if (diff <= 6) return ["日", "月", "火", "水", "木", "金", "土"][new Date(due + "T00:00:00Z").getUTCDay()] + "曜";
  return due.slice(5).replace("-", "/");
}
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
// 停滞日数 = updated（最終更新）からの経過日数。updated 無しは null。
function staleDays(t) {
  const u = (t.updated && !t.updated.startsWith("0001")) ? t.updated.slice(0, 10) : "";
  if (!u) return null;
  const d = daysBetween(u, _today);
  return d >= 0 ? d : 0;
}
// 列内ソート: 期限昇順（ヤバい順に上）、期限なしは末尾。完了列は完了日時の新しい順。
function sortByDue(list) {
  return [...list].sort((a, b) => {
    const da = dueOf(a), db = dueOf(b);
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });
}
// 案件バッジ色: 親IDをパレットに割り当て（kinds.categoryColor と同じ発想の固定パレット）。
const PROJ_PAL = ["#3a86ff", "#2fa66b", "#b657d6", "#e5772d", "#0ea5e9", "#f5a623", "#ef476f", "#14b8a6"];
function projColor(id) { return PROJ_PAL[(id || 0) % PROJ_PAL.length]; }

// ── localStorage ──
function loadPreset() { try { const v = localStorage.getItem(PRESET_KEY); return PRESETS.some((p) => p.key === v) ? v : DEFAULT_PRESET; } catch { return DEFAULT_PRESET; } }
function savePreset(v) { try { localStorage.setItem(PRESET_KEY, v); } catch { /* noop */ } }
function loadSwim() { try { return localStorage.getItem(SWIM_KEY) === "1"; } catch { return false; } }
function saveSwim(on) { try { localStorage.setItem(SWIM_KEY, on ? "1" : "0"); } catch { /* noop */ } }
function loadWho() { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } }
function saveWho(v) { try { localStorage.setItem(WHO_KEY, v || ""); } catch { /* noop */ } }

function errHtml(e) {
  return `<h1 class="vtitle">かんばん</h1><div class="card"><div class="loading">タスクの取得に失敗しました：${esc(e && e.message ? e.message : "")}</div></div>`;
}

function css() {
  return `
  .kb-tools{display:flex;gap:12px;margin-bottom:14px;align-items:center;flex-wrap:wrap}
  /* プリセットタブ＝共有 .seg/.seg-b。従来のサイズ感（gap4・font12.5・縦5px・line-height従来）だけ最小上書きして視覚パリティ維持。 */
  .kb-tabs{gap:4px}
  .kb-tab{font-size:12.5px;padding:5px 12px;border-radius:7px;line-height:normal}
  .kb-swim{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;padding:6px 12px;border:1px solid ${C.line};border-radius:9px;background:var(--card);color:${C.muted};cursor:pointer}
  .kb-swim:hover{border-color:${C.fill};color:${C.fill}}
  .kb-swim.on{background:${C.fill};border-color:${C.fill};color:#fff}

  .kb-who{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
  .kb-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;font-weight:600;padding:5px 10px;border:1px solid ${C.line};border-radius:9px;background:var(--card);color:${C.muted};cursor:pointer}
  .kb-who-b:hover{border-color:${C.fill};color:${C.fill}}
  .kb-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff}

  .kb-board{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:10px}
  .kb-col{flex:0 0 270px;background:#f0f2f5;border:1px solid ${C.line};border-radius:12px;padding:10px;display:flex;flex-direction:column}
  .kb-colh{display:flex;align-items:center;gap:7px;margin-bottom:9px;padding:0 2px}
  .kb-colh.warn{color:${C.over}}
  .kb-colt{font-size:13px;font-weight:700}
  .kb-cnt{font-size:11px;color:${C.muted};background:var(--card);border:1px solid ${C.line};border-radius:10px;padding:1px 8px;font-variant-numeric:tabular-nums}
  .kb-sum{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums}
  .kb-colh.warn .kb-sum{color:${C.over};font-weight:700}
  .kb-wip{margin-left:auto;color:${C.over};display:inline-flex;align-items:center}
  .kb-cards{display:flex;flex-direction:column;gap:8px;min-height:48px;border-radius:8px;padding:2px}
  .kb-cards.over{background:#e8f1ff;outline:2px dashed ${C.fill};outline-offset:-2px}
  .kb-add{margin-top:8px}
  .kb-addbtn{width:100%;font:inherit;font-size:12px;color:${C.muted};border:1px dashed ${C.line};border-radius:9px;background:transparent;padding:6px 8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px}
  .kb-addbtn:hover{border-color:${C.fill};color:${C.fill};background:var(--card)}
  .kb-addin{width:100%;font:inherit;font-size:12.5px;padding:7px 10px;border:1px solid ${C.fill};border-radius:9px;background:var(--card);box-sizing:border-box}
  .kb-addin:focus{outline:none}

  .kb-card{position:relative;background:var(--card);border:1px solid ${C.line};border-radius:10px;padding:9px 11px;cursor:grab;box-shadow:0 1px 2px rgba(20,30,50,.06);border-left:3px solid transparent}
  .kb-card:hover{border-color:${C.fill}}
  .kb-card:focus-visible{outline:2px solid ${C.fill};outline-offset:2px}
  .kb-card.kb-dragging{opacity:.5}
  .kb-card.kb-saving{opacity:.55;position:relative;pointer-events:none}
  .kb-card.kb-saving::after{content:"保存中…";position:absolute;top:6px;right:8px;font-size:9.5px;font-weight:700;color:${C.muted};background:rgba(255,255,255,.85);border-radius:6px;padding:0 5px}
  .kb-card.done{opacity:.6}
  .kb-card.h-overdue{border-left-color:${C.over}}
  .kb-card.h-today{border-left-color:${C.amber}}
  .kb-card.h-week{border-left-color:#e8c14a}
  .kb-ct{font-size:12.5px;font-weight:600;line-height:1.35;display:flex;gap:6px;align-items:baseline;padding-right:20px}

  /* ── タッチ用「移動」トリガ（マウス環境では控えめ・hover/focusで可視。タッチでは常時可視）── */
  .kb-move{position:absolute;top:5px;right:5px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid ${C.line};border-radius:7px;background:var(--card);color:${C.muted};cursor:pointer;opacity:0;transition:opacity .12s;z-index:1}
  .kb-move:hover{color:${C.fill};border-color:${C.fill}}
  .kb-move:focus-visible{outline:2px solid ${C.fill};outline-offset:1px;opacity:1}
  .kb-card:hover .kb-move,.kb-card:focus-within .kb-move{opacity:1}
  /* タッチ端末（hoverできない/粗いポインタ）では常時表示＝操作不能を解消 */
  @media (hover:none),(pointer:coarse){ .kb-move{opacity:1} }

  /* ── 移動先メニュー（tb-ctx 風の軽量ポップ。body 直下に固定配置）── */
  .kb-mm{position:fixed;z-index:1000;min-width:160px;max-width:240px;background:var(--card);border:1px solid ${C.line};border-radius:10px;box-shadow:0 8px 28px rgba(20,30,50,.18);padding:5px;max-height:70vh;overflow:auto}
  .kb-mm-h{font-size:10.5px;font-weight:700;color:${C.muted};padding:6px 8px 3px;letter-spacing:.02em}
  .kb-mm-i{display:flex;align-items:center;gap:6px;width:100%;font:inherit;font-size:12.5px;font-weight:600;color:${C.ink};text-align:left;border:0;background:transparent;border-radius:7px;padding:7px 8px;cursor:pointer}
  .kb-mm-i:hover:not([disabled]){background:#eef2f8;color:${C.fill}}
  .kb-mm-i:focus-visible{outline:2px solid ${C.fill};outline-offset:-2px}
  .kb-mm-i[disabled]{color:${C.muted};cursor:default}
  .kb-mm-i.on{color:${C.fill}}
  .kb-mm-chk{width:14px;display:inline-flex;align-items:center;justify-content:center;flex:none;color:${C.fill}}
  .kb-mm-lt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .kb-prio{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;transform:translateY(-1px)}
  .kb-cr{margin-top:6px}
  .kb-proj{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;font-weight:600;border:1px solid;border-radius:7px;padding:0 6px;vertical-align:middle}
  .kb-cm{display:flex;gap:7px;align-items:center;margin-top:8px;min-height:18px;flex-wrap:wrap}
  .kb-due{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:${C.muted};font-weight:600;font-variant-numeric:tabular-nums;border-radius:7px;padding:0 6px}
  .kb-due.heat-overdue{color:#fff;background:${C.over}}
  .kb-due.heat-today{color:#fff;background:${C.amber}}
  .kb-due.heat-week{color:#7a5d00;background:#fbe6a8}
  .kb-due.heat-none{color:${C.muted}}
  .kb-stale{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:700;color:${C.over};border:1px solid ${C.over};border-radius:7px;padding:0 5px}
  .kb-stale.wait{color:${C.amber};border-color:${C.amber}}
  .kb-est{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:${C.muted};margin-left:auto;font-variant-numeric:tabular-nums}
  .kb-timer{margin-left:auto;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid ${C.line};border-radius:7px;background:var(--card);color:${C.muted};cursor:pointer;opacity:0;transition:opacity .12s}
  .kb-est ~ .kb-timer,.kb-donetag ~ .kb-timer{margin-left:6px}
  .kb-timer:hover{color:${C.fill};border-color:${C.fill}}
  .kb-timer:focus-visible{outline:2px solid ${C.fill};outline-offset:1px;opacity:1}
  .kb-timer.busy{color:${C.over};border-color:${C.over};opacity:1}
  .kb-card:hover .kb-timer,.kb-card:focus-within .kb-timer{opacity:1}
  @media (hover:none),(pointer:coarse){ .kb-timer{opacity:1} }
  .kb-donetag{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:${C.free};border:1px solid ${C.free};border-radius:8px;padding:0 6px}

  /* ── 案件スイムレーン（2軸グリッド: 行=案件 × 列=ステータス）── */
  .kb-swimboard{overflow-x:auto;padding-bottom:10px}
  .kb-swimhd{display:grid;grid-template-columns:190px repeat(4,minmax(210px,1fr));gap:10px;padding:2px 0 6px}
  .kb-shead{font-size:12px;font-weight:700;color:${C.muted};padding:5px 6px;background:#f0f2f5;border:1px solid ${C.line};border-radius:8px;text-align:center}
  .kb-shead-corner{min-width:190px}
  .kb-lanegrid{display:grid;grid-template-columns:190px repeat(4,minmax(210px,1fr));gap:10px;margin-bottom:10px;align-items:start}
  .kb-lanehd{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:${C.ink};padding:8px 6px;background:#f0f2f5;border:1px solid ${C.line};border-radius:10px;align-self:stretch}
  .kb-lanet{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .kb-lanecnt{margin-left:auto;font-size:10.5px;color:${C.muted};background:var(--card);border:1px solid ${C.line};border-radius:9px;padding:0 7px;flex:none}
  .kb-scell{background:#f6f7f9;border:1px solid ${C.line};border-radius:10px;padding:6px;min-height:44px}

  /* ---- ダークモード上書き（淡色のみ反転） ---- */
  /* var(--card)/var(--line) に寄せた淡色面（.kb-swim/.kb-who-b/.kb-cnt/.kb-addbtn:hover/.kb-addin/
     .kb-move/.kb-lanecnt 等）は明側で既に変数化済み＝個別のダーク上書き不要になり削除した。 */
  /* プリセットタブ track/on は共有 .seg が --surface-2/--surface-raised を使うが、従来のダーク色
     （track=#262c34 / on=#1f242c）を維持するため明示的に上書きして視覚パリティを保つ。 */
  html[data-theme="dark"] .kb-tabs{background:var(--track)}
  html[data-theme="dark"] .kb-tab.on{background:var(--card)}
  html[data-theme="dark"] .kb-swim.on{background:${C.fill};border-color:${C.fill};color:#fff}
  html[data-theme="dark"] .kb-who-b:hover{border-color:${C.fill};color:${C.fill}}
  html[data-theme="dark"] .kb-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff}
  html[data-theme="dark"] .kb-col{background:var(--track)}
  html[data-theme="dark"] .kb-cards.over{background:rgba(255,255,255,.06)}
  html[data-theme="dark"] .kb-card{box-shadow:0 1px 2px rgba(0,0,0,.35)}
  html[data-theme="dark"] .kb-mm{box-shadow:0 8px 28px rgba(0,0,0,.5)}
  html[data-theme="dark"] .kb-mm-i:hover:not([disabled]){background:rgba(255,255,255,.08)}
  html[data-theme="dark"] .kb-card.kb-saving::after{background:rgba(0,0,0,.6)}
  html[data-theme="dark"] .kb-card:hover{border-color:${C.fill}}
  html[data-theme="dark"] .kb-shead{background:var(--track);border-color:var(--line)}
  html[data-theme="dark"] .kb-lanehd{background:var(--track);border-color:var(--line)}
  html[data-theme="dark"] .kb-scell{background:var(--track);border-color:var(--line)}
  html[data-theme="dark"] .kb-due.heat-week{color:#1a1400;background:#d8b94a}`;
}
