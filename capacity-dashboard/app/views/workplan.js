// 稼働プラン（個人/全員）。担当者を1人 or 全員、FROM〜TO（最長3ヶ月）の稼働を「重要度別」に縦積み上げ。
// 「全員」はメンバーを合算せず、各メンバーのチャートを別々に並べる（共通Y軸で比較）。
// 期間で粒度自動切替（≤14日=日別 / それ超=週別集計）。容量線は列ごと（=capH×営業日数）。
// 集計は capacity.js を変更せず weekLoadByMember を重要度バケット×メンバーで呼んで再利用。重要度色は kinds.PRIO(SSoT)。
import { load, invalidate } from "../lib/store.js";
import { weekLoadByMember, taskPlannedHoursByMemberOn, shiftISO, isBusinessDay, daysUntil, todayISO, dowOf, isContainer } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { PRIO, prioBucket } from "../lib/kinds.js";
import { C, fmtH, esc, member_color } from "../lib/ui.js";
import { DOW_JA } from "../lib/form.js";
import { openTaskForm } from "./taskform.js";

const WHO_KEY = "ts.workplan.who", PRESET_KEY = "ts.workplan.preset", FROM_KEY = "ts.workplan.from", TO_KEY = "ts.workplan.to", GRAIN_KEY = "ts.workplan.grain";
const BUCKETS = [4, 3, 2, 1, 0]; // 積む順（column-reverse で下から MUST→なし）
const MAX_SPAN = 92;             // 最長3ヶ月
const DAY_GRAIN_MAX = 14;        // この日数以下は日別、超は週別集計
// 表示期間プリセット（今日からの相対日数）。既定=1週間。チップで切替・日付指定=custom。
const PRESETS = [
  { key: "1w", label: "1週間", days: 7 },
  { key: "2w", label: "2週間", days: 14 },
  { key: "1m", label: "1ヶ月", days: 30 },
  { key: "3m", label: "3ヶ月", days: 90 },
];
let CAP = 8;

const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// 全画面(#/workplan)用の状態: localStorage を読み書きする。
// 埋め込み(renderInto)用は makeLocalState() で別インスタンスを持ち、ここを汚染しない。
function makeGlobalState() {
  return {
    persistent: true,
    WHO: lsGet(WHO_KEY, ""),       // ""→自分既定 / "all"=全員(メンバー別) / "self"=自分 / memberId
    PRESET: lsGet(PRESET_KEY, "1w"),// 既定=今日から1週間。"custom"=日付指定
    FROM: lsGet(FROM_KEY, ""),
    TO: lsGet(TO_KEY, ""),
    GRAIN: lsGet(GRAIN_KEY, ""),    // ""=自動(期間長で日/週) / "day"=日表示 / "week"=週表示
    save(k, v) { lsSet(k, v); },
  };
}

// 埋め込み用ローカル状態。opts で初期 preset/grain/who を上書き可（任意）。
// localStorage には一切書かない（全画面側の状態を壊さない）。
function makeLocalState(opts = {}) {
  return {
    persistent: false,
    WHO: opts.who != null ? String(opts.who) : "all",      // 既定=全員
    PRESET: opts.preset != null ? String(opts.preset) : "1m", // 既定=1ヶ月
    FROM: "",
    TO: "",
    GRAIN: opts.grain != null ? String(opts.grain) : "",   // ""=自動
    FLUID: !!opts.fluid,   // ホーム埋め込みで固定高(px箱)をやめ可変高にする
    save() { /* no-op: 埋め込みは永続化しない */ },
  };
}

// この単一の共有インスタンスが全画面 render(root) の状態を保持する（従来の挙動を温存）。
const GLOBAL = makeGlobalState();

const round1dp = (n) => Math.round(n * 10) / 10;
const weekStartOf = (iso) => { const d = dowOf(iso); return shiftISO(iso, d === 0 ? -6 : 1 - d); };
const mName = (m) => m.name || m.username || "?";

function bizDaysList(from, to, holidays) {
  const out = [];
  for (let cur = from, i = 0; cur <= to && i < 400; cur = shiftISO(cur, 1), i++) {
    if (isBusinessDay(cur, holidays)) out.push(cur);
  }
  return out;
}

// plansByTask（Map or obj）から該当タスクの plan 配列を引く（capacity.js の内部ヘルパと同形）。
function planEntriesOf(plans, taskId) {
  if (!plans) return null;
  return (plans.get ? plans.get(taskId) : plans[taskId]) || null;
}

// 1メンバーの期間内 重要度別 列データ（日別 or 週別集計）。
// cap は **実キャパ**＝Σ capacityOn（週末/祝日に加え、そのメンバーの休暇日も 0 になる）。B17。
// 各列に contrib（その列・その人に寄与するタスク [{id,title,h}] 降順）を付ける（バークリックのドリルダウン用）。B18。
function colsForMember(member, bdays, granularity, tasks, plans, holidays, unavailabilityByMember) {
  const availOpt = { holidays, unavailabilityByMember, capH: CAP };
  const perBucketDaily = BUCKETS.map((b) => {
    const ts = (tasks || []).filter((t) => prioBucket(t.priority) === b);
    const wl = weekLoadByMember(ts, [member], bdays, CAP, plans, { holidays });
    const days = bdays.map((day, di) => ({ day, h: round1dp((wl[0] && wl[0].days[di].h) || 0) }));
    return { b, days };
  });
  // day index -> Map<taskId,{id,title,h}>（その日のこのメンバーへの寄与）。B18 ドリルダウン用。
  const contribDaily = bdays.map((day) => {
    const m = new Map();
    for (const t of tasks || []) {
      const byMember = taskPlannedHoursByMemberOn(t, day, planEntriesOf(plans, t.id), { holidays });
      const h = byMember.get(member.id) || 0;
      if (h > 0) { const prev = m.get(t.id); m.set(t.id, { id: t.id, title: t.title, h: (prev ? prev.h : 0) + h }); }
    }
    return m;
  });
  // 複数 day の寄与 Map を 1 本のタスク配列（h 降順）に畳む。
  const foldContrib = (idxs) => {
    const agg = new Map();
    for (const di of idxs) for (const [id, c] of contribDaily[di]) {
      const prev = agg.get(id);
      agg.set(id, { id, title: c.title, h: (prev ? prev.h : 0) + c.h });
    }
    return [...agg.values()].map((c) => ({ ...c, h: round1dp(c.h) })).sort((a, b) => b.h - a.h);
  };
  if (granularity === "day") {
    return bdays.map((day, di) => {
      const segs = perBucketDaily.map((pb) => ({ b: pb.b, h: pb.days[di].h })).filter((s) => s.h > 0);
      const total = round1dp(segs.reduce((s, x) => s + x.h, 0));
      const cap = round1dp(capacityOn(member, day, availOpt));
      return { label: day.slice(5).replace("-", "/"), sub: DOW_JA[dowOf(day)], segs, total, cap, free: round1dp(Math.max(0, cap - total)), over: total > cap + 1e-6, contrib: foldContrib([di]) };
    });
  }
  const groups = new Map(); // weekStart -> [dayIndex]
  bdays.forEach((day, di) => { const ws = weekStartOf(day); (groups.get(ws) || groups.set(ws, []).get(ws)).push(di); });
  return [...groups.entries()].map(([ws, idxs]) => {
    const segMap = {};
    for (const di of idxs) for (const pb of perBucketDaily) segMap[pb.b] = (segMap[pb.b] || 0) + pb.days[di].h;
    const segs = BUCKETS.map((b) => ({ b, h: round1dp(segMap[b] || 0) })).filter((s) => s.h > 0);
    const total = round1dp(segs.reduce((s, x) => s + x.h, 0));
    const cap = round1dp(idxs.reduce((s, di) => s + capacityOn(member, bdays[di], availOpt), 0));
    return { label: ws.slice(5).replace("-", "/") + "週", sub: `${idxs.length}日`, segs, total, cap, free: round1dp(Math.max(0, cap - total)), over: total > cap + 1e-6, contrib: foldContrib(idxs) };
  });
}

// 全画面エントリ: #/workplan。共有 GLOBAL 状態(=localStorage 連動)で従来通り描画。
export async function render(root) {
  return renderState(root, GLOBAL, () => render(root), { embedded: false });
}

// 埋め込みエントリ: ホームのサブコンテナに「稼働プラン」を描画。
// container=既存DOM要素。opts={ preset, grain, who } で初期表示を上書き可（任意）。
// 全画面側の localStorage 状態は一切触らない（makeLocalState がローカル状態を持つ）。
export async function renderInto(container, opts = {}) {
  const state = makeLocalState(opts);
  const rerender = () => renderState(container, state, rerender, { embedded: true });
  return rerender();
}

async function renderState(root, state, rerender, view = {}) {
  const embedded = !!view.embedded;
  const { tasks, members, plansByTask, settings, holidaysSet, unavailabilityByMember, me } = await load();
  CAP = settings.capH;

  // 期間: プリセット(今日からの相対)を既定とし、custom のときだけ日付指定を使う。
  const today = todayISO();
  const presetDef = PRESETS.find((p) => p.key === state.PRESET);
  if (presetDef) { state.FROM = today; state.TO = shiftISO(today, presetDef.days - 1); }
  else {
    if (!state.FROM || !state.TO) { state.FROM = today; state.TO = shiftISO(today, 6); }
    if (state.FROM > state.TO) { const t = state.FROM; state.FROM = state.TO; state.TO = t; }
    if (daysUntil(state.FROM, state.TO) > MAX_SPAN) state.TO = shiftISO(state.FROM, MAX_SPAN);
  }
  const FROM = state.FROM, TO = state.TO;

  const meId = me && me.id;
  const activeMembers = members || [];
  // 自分は members に居なくても常に選べる（擬似メンバー）。
  const selfMember = me ? (activeMembers.find((m) => m.id === meId) || { id: meId, name: me.name || me.username, username: me.username }) : null;

  // WHO 既定/正規化
  if (state.WHO === "") state.WHO = (selfMember && activeMembers.some((m) => m.id === selfMember.id)) ? String(selfMember.id) : (activeMembers[0] ? String(activeMembers[0].id) : "all");
  // 後方互換: 旧「自分」タブ(WHO==="self")は自分のmember idへ読み替え（タブ廃止のため）
  if (state.WHO === "self") { state.WHO = (selfMember && activeMembers.some((m) => m.id === selfMember.id)) ? String(selfMember.id) : "all"; state.save(WHO_KEY, state.WHO); }
  const WHO = state.WHO;

  const bdays = bizDaysList(FROM, TO, holidaysSet);
  // 粒度: 保存値 "day"/"week" を優先。未設定("")なら期間長で自動。
  const autoGrain = daysUntil(FROM, TO) <= DAY_GRAIN_MAX ? "day" : "week";
  const granularity = (state.GRAIN === "day" || state.GRAIN === "week") ? state.GRAIN : autoGrain;

  // 対象メンバー（全員=各メンバー別 / self / 指定）
  const mode = WHO === "all" ? "all" : "one";
  let targets;
  if (mode === "all") targets = activeMembers;
  else if (WHO === "self") targets = selfMember ? [selfMember] : [];
  else { const one = activeMembers.find((m) => String(m.id) === String(WHO)) || selfMember; targets = one ? [one] : []; }

  // コンテナ（子持ち親）は作業行に出さない（#732）: 列工数と寄与ポップ行の両方から除外
  const byId = new Map((tasks || []).map((t) => [t.id, t]));
  const workTasks = (tasks || []).filter((t) => !isContainer(t, byId));
  const perMember = targets.map((m) => ({ m, cols: colsForMember(m, bdays, granularity, workTasks, plansByTask, holidaysSet, unavailabilityByMember) }));
  const allCols = perMember.flatMap((x) => x.cols);
  const yMax = Math.max(1, ...allCols.map((c) => Math.max(c.cap, c.total))) * 1.12;
  // 既定の各チャート高（全員=190 / 個人=300）。fluid(ホーム埋め込み)=固定px箱をやめ、
  // ビューポート幅に追従する可変高にする（全画面・全員グリッドの見た目は非回帰）。
  let H = mode === "all" ? 190 : 300;
  if (state.FLUID) {
    const vw = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
    H = mode === "all" ? Math.round(Math.max(150, Math.min(190, vw * 0.16)))
                       : Math.round(Math.max(220, Math.min(300, vw * 0.26)));
  }
  const pxPerH = H / yMax;
  const tickStep = yMax > 80 ? 40 : (yMax > 40 ? 16 : (yMax > 16 ? 8 : 4));
  let ticks = "";
  for (let h = 0; h <= yMax - tickStep / 2; h += tickStep) ticks += `<div class="wp-tick" style="bottom:${h * pxPerH}px">${h}h</div>`;

  // 担当者タブ（全員 / 自分 / 各メンバー）
  const tab = (val, label, color, on) =>
    `<button class="wp-who-b${on ? " on" : ""}" data-who="${esc(String(val))}">${color ? `<i class="wp-who-av" style="background:${color}">${esc(label[0] || "?")}</i>` : ""}${esc(label)}</button>`;
  const whoTabs = tab("all", "全員", "", WHO === "all")
    + activeMembers.map((m) => tab(m.id, mName(m), member_color(m.id), WHO === String(m.id))).join("");

  const granLabel = granularity === "day" ? "日別" : "週別集計";
  const title = mode === "all" ? "全員（メンバー別）" : (targets[0] ? esc(mName(targets[0])) : "個人");

  const chartHtml = (cols, mi) => `<div class="wp-chart" style="height:${H + 44}px">
      <div class="wp-yaxis" style="height:${H}px">${ticks}</div>
      <div class="wp-cols" style="height:${H}px">${cols.map((c, ci) => colHtml(c, pxPerH, mi, ci)).join("") || `<div class="wp-empty">営業日がありません</div>`}</div>
    </div>`;

  let body;
  if (mode === "all") {
    body = `<div class="wp-grid">${perMember.map((x, mi) => {
      const sum = round1dp(x.cols.reduce((s, c) => s + c.total, 0));
      return `<div class="wp-member">
        <div class="wp-mname"><i class="wp-who-av" style="background:${member_color(x.m.id)}">${esc(mName(x.m)[0])}</i>${esc(mName(x.m))}<small>計 ${fmtH(sum)}</small></div>
        ${chartHtml(x.cols, mi)}
      </div>`;
    }).join("") || `<div class="wp-empty">メンバーがいません</div>`}</div>`;
  } else {
    body = `<div class="card wp-card">${chartHtml(perMember[0] ? perMember[0].cols : [], 0)}</div>`;
  }
  const sumH = round1dp(allCols.reduce((s, c) => s + c.total, 0));

  // 見出し: 全画面は h1.vtitle、埋め込みは控えめな h2（100vh前提にせず自然高）。
  const heading = embedded
    ? `<h2 class="wp-embed-title">${title} 稼働プラン <small>${FROM.slice(5)}〜${TO.slice(5)} ・ ${granLabel} ・ 容量 ${CAP}h/日</small></h2>`
    : `<h1 class="vtitle">${title} 稼働プラン <small>${FROM.slice(5)}〜${TO.slice(5)} ・ ${granLabel} ・ 容量 ${CAP}h/日 ・ 重要度別</small></h1>`;

  root.innerHTML = `
    <style>${css()}</style>
    <div class="${embedded ? "wp-embed" : "wp-full"}">
    ${heading}
    <div class="wp-tools">
      <div class="wp-who" id="wp-who">${whoTabs || `<span class="wp-noone">メンバーがいません</span>`}</div>
      <div class="wp-presets" id="wp-presets">${PRESETS.map((p) => `<button class="wp-pchip${state.PRESET === p.key ? " on" : ""}" data-preset="${p.key}">${p.label}</button>`).join("")}</div>
      <div class="wp-grain" id="wp-grain">
        <button class="wp-gseg${granularity === "day" ? " on" : ""}" data-grain="day">日</button>
        <button class="wp-gseg${granularity === "week" ? " on" : ""}" data-grain="week">週</button>
      </div>
      <div class="wp-range">期間
        <input type="date" id="wp-from" value="${FROM}">〜<input type="date" id="wp-to" value="${TO}">
        <span class="wp-hint">最長3ヶ月</span>
      </div>
    </div>
    ${body}
    <div class="wp-legend">
      ${BUCKETS.map((b) => `<span class="it"><i style="background:${PRIO[b].c}"></i>${PRIO[b].n}</span>`).join("")}
      <span class="it"><span class="gap"></span>空き</span>
      <span class="it"><span class="rule"></span>容量線</span>
      <span class="it wp-sum">期間合計 ${fmtH(sumH)}</span>
    </div>
    </div>`;

  // イベントは root(=container) スコープに限定。document/window には漏らさない。
  // 状態変更は state を更新し state.save(...)（全画面=localStorage / 埋め込み=no-op）→ rerender。
  root.querySelectorAll("#wp-who [data-who]").forEach((b) => {
    b.onclick = () => { state.WHO = b.dataset.who; state.save(WHO_KEY, state.WHO); rerender(); };
  });
  root.querySelectorAll("#wp-presets [data-preset]").forEach((b) => {
    b.onclick = () => { state.PRESET = b.dataset.preset; state.save(PRESET_KEY, state.PRESET); rerender(); };
  });
  root.querySelectorAll("#wp-grain [data-grain]").forEach((b) => {
    b.onclick = () => { state.GRAIN = b.dataset.grain; state.save(GRAIN_KEY, state.GRAIN); rerender(); };
  });
  const setCustom = () => { state.PRESET = "custom"; state.save(PRESET_KEY, "custom"); };  // 日付指定したらプリセット解除
  const fromEl = root.querySelector("#wp-from"), toEl = root.querySelector("#wp-to");
  if (fromEl) fromEl.onchange = () => { setCustom(); state.FROM = fromEl.value || state.FROM; state.save(FROM_KEY, state.FROM); rerender(); };
  if (toEl) toEl.onchange = () => { setCustom(); state.TO = toEl.value || state.TO; state.save(TO_KEY, state.TO); rerender(); };

  // B18: バー/列クリック → その人・その列に寄与するタスク一覧ポップオーバー → openTaskForm。
  const openCol = (col) => {
    const mi = +col.dataset.mi, ci = +col.dataset.ci;
    const pm = perMember[mi]; const c = pm && pm.cols[ci];
    if (!pm || !c || !(c.contrib && c.contrib.length)) return;
    openDrill(root, col, pm.m, c, rerender);
  };
  root.querySelectorAll(".wp-col.clickable").forEach((col) => {
    col.onclick = () => openCol(col);
    col.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCol(col); } };
  });
}

// 列ドリルダウンのポップオーバー。寄与タスクを h 降順で並べ、各行クリックで openTaskForm。B18。
function closeDrill(root) {
  const pop = root.querySelector(".wp-pop");
  if (!pop) return;
  if (pop._cleanup) pop._cleanup();
  pop.remove();
}
function openDrill(root, anchor, member, col, rerender) {
  closeDrill(root);
  const pop = document.createElement("div");
  pop.className = "wp-pop";
  const head = `${esc(mName(member))} ・ ${esc(col.label)}${col.sub ? " " + esc(col.sub) : ""}`;
  const capLabel = col.cap > 1e-6 ? `${fmtH(col.total)} / ${fmtH(col.cap)}` : `${fmtH(col.total)}（容量0＝休み）`;
  pop.innerHTML = `
    <div class="wp-pop-hd"><b>${head}</b><span class="wp-pop-cap${col.over ? " over" : ""}">${capLabel}</span><button type="button" class="wp-pop-x" aria-label="閉じる">×</button></div>
    <div class="wp-pop-list">
      ${col.contrib.map((t) => `<button type="button" class="wp-pop-row" data-id="${t.id}"><span class="wp-pop-t">${esc(t.title || "(無題)")}</span><span class="wp-pop-h">${fmtH(t.h)}</span></button>`).join("")}
    </div>`;

  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  root.appendChild(pop);
  const rr = root.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const W = pop.offsetWidth || 240;
  let left = ar.left - rr.left + ar.width / 2 - W / 2;
  left = Math.max(0, Math.min(left, rr.width - W));
  let top = ar.bottom - rr.top + 4;
  if (ar.bottom + (pop.offsetHeight || 0) > window.innerHeight) {
    top = Math.max(0, ar.top - rr.top - (pop.offsetHeight || 0) - 4);
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";

  pop.querySelector(".wp-pop-x").onclick = (e) => { e.stopPropagation(); closeDrill(root); };
  pop.querySelectorAll(".wp-pop-row").forEach((row) => {
    row.onclick = (e) => {
      e.stopPropagation();
      const id = +row.dataset.id;
      closeDrill(root);
      openTaskForm({ taskId: id, onSaved: async () => { invalidate(); await load(); rerender(); } });
    };
  });
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closeDrill(root); };
  const onKey = (e) => { if (e.key === "Escape") closeDrill(root); };
  pop._cleanup = () => { document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onKey, true); };
  setTimeout(() => { document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onKey, true); }, 0);
}

function colHtml(c, pxPerH, mi, ci) {
  const segs = c.segs.map((s) =>
    `<div class="wp-seg" style="height:${s.h * pxPerH}px;background:${PRIO[s.b].c}" title="${PRIO[s.b].n} ${fmtH(s.h)}"><span>${s.h >= 1 ? fmtH(s.h) : ""}</span></div>`).join("");
  const gap = c.free > 0 ? `<div class="wp-seg gap" style="height:${c.free * pxPerH}px"><span>${c.free >= 1 ? "空 " + fmtH(c.free) : ""}</span></div>` : "";
  // cap=0（週末/祝日/休暇）は容量線を描かない（B17：休暇日に空き容量を見せない）。
  const capLine = c.cap > 1e-6 ? `<div class="wp-capline" style="bottom:${c.cap * pxPerH}px"></div>` : "";
  const n = (c.contrib && c.contrib.length) || 0;
  // 寄与タスクがある列だけクリック可（ドリルダウン B18）。off 日（cap=0 かつ負荷0）はバー高0で押せない。
  const clickable = n > 0;
  return `<div class="wp-col${clickable ? " clickable" : ""}${c.cap <= 1e-6 ? " off" : ""}"${clickable ? ` data-mi="${mi}" data-ci="${ci}" role="button" tabindex="0" title="${n}件のタスク（クリックで内訳）"` : ""}>
    <div class="wp-barwrap" style="height:${Math.max(c.cap, c.total) * pxPerH}px">${segs}${gap}${capLine}</div>
    <div class="wp-foot"><div class="wp-dow">${c.label}<small>${c.sub ? " " + c.sub : ""}</small></div><div class="wp-tot ${c.over ? "over" : ""}">${fmtH(c.total)}</div></div>
  </div>`;
}

function css() {
  return `
  .wp-embed{display:block}   /* 埋め込みは自然高（100vh前提にしない） */
  .wp-embed-title{margin:0 0 12px;font-size:15px;font-weight:700;color:${C.ink}}
  .wp-embed-title small{margin-left:8px;font-weight:600;color:${C.muted};font-size:11.5px}
  .wp-tools{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:14px}
  .wp-who{display:flex;flex-wrap:wrap;gap:5px}
  .wp-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:#fff;color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .wp-who-b:hover{border-color:#cfd9e6}
  .wp-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .wp-who-av{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#fff;font-size:9px;font-weight:700;flex:none}
  .wp-who-b.on .wp-who-av{box-shadow:0 0 0 1.5px #fff}
  .wp-noone{color:${C.muted};font-size:12px}
  .wp-presets{display:flex;gap:5px;flex-wrap:wrap}
  .wp-pchip{font:inherit;font-size:12px;padding:5px 12px;border:1px solid ${C.line};border-radius:18px;background:#fff;color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .wp-pchip:hover{border-color:#cfd9e6;color:${C.ink}}
  .wp-pchip.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .wp-grain{display:inline-flex;border:1px solid ${C.line};border-radius:18px;overflow:hidden;background:#fff}
  .wp-gseg{font:inherit;font-size:12px;padding:5px 14px;border:0;border-left:1px solid ${C.line};background:transparent;color:${C.muted};cursor:pointer;transition:background .12s,color .12s}
  .wp-gseg:first-child{border-left:0}
  .wp-gseg:hover{color:${C.ink}}
  .wp-gseg.on{background:${C.fill};color:#fff;font-weight:700}
  .wp-range{display:flex;align-items:center;gap:6px;font-size:12.5px;color:${C.muted};margin-left:auto}
  .wp-range input{font:inherit;font-size:12.5px;padding:4px 7px;border:1px solid ${C.line};border-radius:7px;background:#fff;color:${C.ink}}
  .wp-hint{font-size:11px;color:${C.muted}}
  .wp-card{padding:18px 20px 14px}
  .wp-grid{display:grid;grid-template-columns:1fr;gap:16px}   /* 全員=メンバー別チャートを縦1列に積む */
  .wp-member{background:#fff;border:1px solid ${C.line};border-radius:14px;padding:14px 16px 10px}
  .wp-mname{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;margin-bottom:6px}
  .wp-mname small{margin-left:auto;font-weight:600;color:${C.muted};font-size:11px}
  .wp-chart{position:relative;padding-left:34px}
  .wp-yaxis{position:absolute;left:0;bottom:44px;width:34px}
  .wp-tick{position:absolute;right:6px;font-size:10px;color:${C.muted};transform:translateY(50%)}
  .wp-cols{display:flex;gap:10px;align-items:flex-end}
  .wp-col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center}
  .wp-barwrap{position:relative;width:100%;max-width:60px;display:flex;flex-direction:column-reverse;border:1px solid ${C.line};border-bottom:0;border-radius:7px 7px 0 0;overflow:hidden}
  .wp-seg{display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.5);min-height:2px}
  .wp-seg span{text-shadow:0 1px 1px rgba(0,0,0,.15)}
  .wp-seg.gap{background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 5px,#eef1f5 5px,#eef1f5 10px);color:#b3bac4;border-bottom:0}
  .wp-seg.gap span{text-shadow:none}
  .wp-capline{position:absolute;left:0;right:0;border-top:2px dashed ${C.capline};z-index:4;pointer-events:none}
  .wp-foot{margin-top:8px;text-align:center}
  .wp-dow{font-size:11px;font-weight:600}.wp-dow small{color:${C.muted};font-weight:400}
  .wp-tot{font-size:10.5px;color:${C.muted};font-variant-numeric:tabular-nums;margin-top:1px}.wp-tot.over{color:${C.over};font-weight:700}
  .wp-empty{margin:auto;color:${C.muted};font-size:12px}
  .wp-col.clickable{cursor:pointer}
  .wp-col.clickable .wp-barwrap{transition:filter .12s,box-shadow .12s}
  .wp-col.clickable:hover .wp-barwrap{filter:brightness(1.04);box-shadow:0 2px 8px rgba(31,45,61,.14)}
  .wp-col.clickable:focus-visible{outline:none}
  .wp-col.clickable:focus-visible .wp-barwrap{box-shadow:0 0 0 2px ${C.fill}}
  .wp-col.off .wp-dow{color:${C.muted}}
  /* B18 ドリルダウン ポップオーバー */
  .wp-pop{position:absolute;z-index:50;width:240px;max-width:86vw;background:#fff;border:1px solid ${C.line};border-radius:12px;box-shadow:0 10px 32px rgba(31,45,61,.22);overflow:hidden;animation:wp-pop-in .1s ease-out}
  @keyframes wp-pop-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
  .wp-pop-hd{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;border-bottom:1px solid ${C.line};font-size:12.5px}
  .wp-pop-hd b{font-weight:700;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wp-pop-cap{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};font-variant-numeric:tabular-nums;white-space:nowrap}
  .wp-pop-cap.over{color:${C.over}}
  .wp-pop-x{flex:none;border:0;background:transparent;color:${C.muted};font-size:16px;line-height:1;cursor:pointer;padding:0 2px}
  .wp-pop-x:hover{color:${C.ink}}
  .wp-pop-list{max-height:300px;overflow:auto;padding:5px}
  .wp-pop-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;font-size:12.5px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:${C.ink};cursor:pointer}
  .wp-pop-row:hover{background:#f1f5fb}
  .wp-pop-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wp-pop-h{flex:none;font-size:11px;font-weight:700;color:${C.muted};font-variant-numeric:tabular-nums}
  .wp-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:${C.muted};align-items:center}
  .wp-legend .it{display:inline-flex;align-items:center;gap:6px}
  .wp-legend .it i{width:11px;height:11px;border-radius:3px;display:inline-block}
  .wp-legend .gap{width:13px;height:11px;border-radius:3px;display:inline-block;background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 4px,#eef1f5 4px,#eef1f5 8px);border:1px solid ${C.line}}
  .wp-legend .rule{width:18px;border-top:2px dashed ${C.capline};display:inline-block}
  .wp-legend .wp-sum{margin-left:auto;font-weight:700;color:${C.ink}}
  html[data-theme="dark"] .wp-who-b,html[data-theme="dark"] .wp-pchip,html[data-theme="dark"] .wp-grain,html[data-theme="dark"] .wp-range input{background:var(--card)}
  html[data-theme="dark"] .wp-who-b:hover,html[data-theme="dark"] .wp-pchip:hover{border-color:var(--line-strong)}
  html[data-theme="dark"] .wp-member{background:var(--card)}
  html[data-theme="dark"] .wp-seg.gap{background:repeating-linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.04) 5px,rgba(255,255,255,.08) 5px,rgba(255,255,255,.08) 10px);color:var(--muted)}
  html[data-theme="dark"] .wp-legend .gap{background:repeating-linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.04) 4px,rgba(255,255,255,.08) 4px,rgba(255,255,255,.08) 8px)}
  html[data-theme="dark"] .wp-pop{background:var(--card)}
  html[data-theme="dark"] .wp-pop-row:hover{background:rgba(255,255,255,.06)}`;
}
