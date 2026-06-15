// 稼働プラン（個人/全員）。担当者を1人 or 全員、FROM〜TO（最長3ヶ月）の稼働を「重要度別」に縦積み上げ。
// 「全員」はメンバーを合算せず、各メンバーのチャートを別々に並べる（共通Y軸で比較）。
// 期間で粒度自動切替（≤14日=日別 / それ超=週別集計）。容量線は列ごと（=capH×営業日数）。
// 集計は capacity.js を変更せず weekLoadByMember を重要度バケット×メンバーで呼んで再利用。重要度色は kinds.PRIO(SSoT)。
import { load } from "../lib/store.js";
import { weekLoadByMember, shiftISO, isBusinessDay, daysUntil } from "../lib/capacity.js";
import { PRIO, prioBucket } from "../lib/kinds.js";
import { C, fmtH, esc, member_color } from "../lib/ui.js";

const WHO_KEY = "ts.workplan.who", PRESET_KEY = "ts.workplan.preset", FROM_KEY = "ts.workplan.from", TO_KEY = "ts.workplan.to";
const WD = ["日", "月", "火", "水", "木", "金", "土"];
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
let WHO = lsGet(WHO_KEY, "");   // ""→自分既定 / "all"=全員(メンバー別) / "self"=自分 / memberId
let PRESET = lsGet(PRESET_KEY, "1w");   // 既定=今日から1週間。"custom"=日付指定
let FROM = lsGet(FROM_KEY, ""), TO = lsGet(TO_KEY, "");

const round1 = (n) => Math.round(n * 10) / 10;
const dowOf = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();
const weekStartOf = (iso) => { const d = dowOf(iso); return shiftISO(iso, d === 0 ? -6 : 1 - d); };
const mName = (m) => m.name || m.username || "?";

function bizDaysList(from, to, holidays) {
  const out = [];
  for (let cur = from, i = 0; cur <= to && i < 400; cur = shiftISO(cur, 1), i++) {
    if (isBusinessDay(cur, holidays)) out.push(cur);
  }
  return out;
}

// 1メンバーの期間内 重要度別 列データ（日別 or 週別集計）。cap は列ごと（capH×営業日数）。
function colsForMember(member, bdays, granularity, tasks, plans, holidays) {
  const perBucketDaily = BUCKETS.map((b) => {
    const ts = (tasks || []).filter((t) => prioBucket(t.priority) === b);
    const wl = weekLoadByMember(ts, [member], bdays, CAP, plans, { holidays });
    const days = bdays.map((day, di) => ({ day, h: round1((wl[0] && wl[0].days[di].h) || 0) }));
    return { b, days };
  });
  if (granularity === "day") {
    return bdays.map((day, di) => {
      const segs = perBucketDaily.map((pb) => ({ b: pb.b, h: pb.days[di].h })).filter((s) => s.h > 0);
      const total = round1(segs.reduce((s, x) => s + x.h, 0));
      const cap = CAP;
      return { label: day.slice(5).replace("-", "/"), sub: WD[dowOf(day)], segs, total, cap, free: round1(Math.max(0, cap - total)), over: total > cap + 1e-6 };
    });
  }
  const groups = new Map(); // weekStart -> [dayIndex]
  bdays.forEach((day, di) => { const ws = weekStartOf(day); (groups.get(ws) || groups.set(ws, []).get(ws)).push(di); });
  return [...groups.entries()].map(([ws, idxs]) => {
    const segMap = {};
    for (const di of idxs) for (const pb of perBucketDaily) segMap[pb.b] = (segMap[pb.b] || 0) + pb.days[di].h;
    const segs = BUCKETS.map((b) => ({ b, h: round1(segMap[b] || 0) })).filter((s) => s.h > 0);
    const total = round1(segs.reduce((s, x) => s + x.h, 0));
    const cap = CAP * idxs.length;
    return { label: ws.slice(5).replace("-", "/") + "週", sub: `${idxs.length}日`, segs, total, cap, free: round1(Math.max(0, cap - total)), over: total > cap + 1e-6 };
  });
}

export async function render(root) {
  const { tasks, members, plansByTask, settings, holidaysSet, me } = await load();
  CAP = settings.capH;

  // 期間: プリセット(今日からの相対)を既定とし、custom のときだけ日付指定を使う。
  const today = new Date().toISOString().slice(0, 10);
  const presetDef = PRESETS.find((p) => p.key === PRESET);
  if (presetDef) { FROM = today; TO = shiftISO(today, presetDef.days - 1); }
  else {
    if (!FROM || !TO) { FROM = today; TO = shiftISO(today, 6); }
    if (FROM > TO) { const t = FROM; FROM = TO; TO = t; }
    if (daysUntil(FROM, TO) > MAX_SPAN) TO = shiftISO(FROM, MAX_SPAN);
  }

  const meId = me && me.id;
  const activeMembers = members || [];
  // 自分は members に居なくても常に選べる（擬似メンバー）。
  const selfMember = me ? (activeMembers.find((m) => m.id === meId) || { id: meId, name: me.name || me.username, username: me.username }) : null;

  // WHO 既定/正規化
  if (WHO === "") WHO = selfMember ? "self" : (activeMembers[0] ? String(activeMembers[0].id) : "all");

  const bdays = bizDaysList(FROM, TO, holidaysSet);
  const granularity = daysUntil(FROM, TO) <= DAY_GRAIN_MAX ? "day" : "week";

  // 対象メンバー（全員=各メンバー別 / self / 指定）
  const mode = WHO === "all" ? "all" : "one";
  let targets;
  if (mode === "all") targets = activeMembers;
  else if (WHO === "self") targets = selfMember ? [selfMember] : [];
  else { const one = activeMembers.find((m) => String(m.id) === String(WHO)) || selfMember; targets = one ? [one] : []; }

  const perMember = targets.map((m) => ({ m, cols: colsForMember(m, bdays, granularity, tasks, plansByTask, holidaysSet) }));
  const allCols = perMember.flatMap((x) => x.cols);
  const yMax = Math.max(1, ...allCols.map((c) => Math.max(c.cap, c.total))) * 1.12;
  const H = mode === "all" ? 190 : 300, pxPerH = H / yMax;
  const tickStep = yMax > 80 ? 40 : (yMax > 40 ? 16 : (yMax > 16 ? 8 : 4));
  let ticks = "";
  for (let h = 0; h <= yMax - tickStep / 2; h += tickStep) ticks += `<div class="wp-tick" style="bottom:${h * pxPerH}px">${h}h</div>`;

  // 担当者タブ（全員 / 自分 / 各メンバー）
  const tab = (val, label, color, on) =>
    `<button class="wp-who-b${on ? " on" : ""}" data-who="${esc(String(val))}">${color ? `<i class="wp-who-av" style="background:${color}">${esc(label[0] || "?")}</i>` : ""}${esc(label)}</button>`;
  const whoTabs = tab("all", "全員", "", WHO === "all")
    + (selfMember ? tab("self", "自分", "", WHO === "self") : "")
    + activeMembers.map((m) => tab(m.id, mName(m), member_color(m.id), WHO === String(m.id))).join("");

  const granLabel = granularity === "day" ? "日別" : "週別集計";
  const title = mode === "all" ? "全員（メンバー別）" : (targets[0] ? esc(mName(targets[0])) : "個人");

  const chartHtml = (cols) => `<div class="wp-chart" style="height:${H + 44}px">
      <div class="wp-yaxis" style="height:${H}px">${ticks}</div>
      <div class="wp-cols" style="height:${H}px">${cols.map((c) => colHtml(c, pxPerH)).join("") || `<div class="wp-empty">営業日がありません</div>`}</div>
    </div>`;

  let body;
  if (mode === "all") {
    body = `<div class="wp-grid">${perMember.map((x) => {
      const sum = round1(x.cols.reduce((s, c) => s + c.total, 0));
      return `<div class="wp-member">
        <div class="wp-mname"><i class="wp-who-av" style="background:${member_color(x.m.id)}">${esc(mName(x.m)[0])}</i>${esc(mName(x.m))}<small>計 ${fmtH(sum)}</small></div>
        ${chartHtml(x.cols)}
      </div>`;
    }).join("") || `<div class="wp-empty">メンバーがいません</div>`}</div>`;
  } else {
    body = `<div class="card wp-card">${chartHtml(perMember[0] ? perMember[0].cols : [])}</div>`;
  }
  const sumH = round1(allCols.reduce((s, c) => s + c.total, 0));

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">${title} 稼働プラン <small>${FROM.slice(5)}〜${TO.slice(5)} ・ ${granLabel} ・ 容量 ${CAP}h/日 ・ 重要度別</small></h1>
    <div class="wp-tools">
      <div class="wp-who" id="wp-who">${whoTabs || `<span class="wp-noone">メンバーがいません</span>`}</div>
      <div class="wp-presets" id="wp-presets">${PRESETS.map((p) => `<button class="wp-pchip${PRESET === p.key ? " on" : ""}" data-preset="${p.key}">${p.label}</button>`).join("")}</div>
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
    </div>`;

  root.querySelectorAll("#wp-who [data-who]").forEach((b) => {
    b.onclick = () => { WHO = b.dataset.who; lsSet(WHO_KEY, WHO); render(root); };
  });
  root.querySelectorAll("#wp-presets [data-preset]").forEach((b) => {
    b.onclick = () => { PRESET = b.dataset.preset; lsSet(PRESET_KEY, PRESET); render(root); };
  });
  const setCustom = () => { PRESET = "custom"; lsSet(PRESET_KEY, "custom"); };  // 日付指定したらプリセット解除
  const fromEl = root.querySelector("#wp-from"), toEl = root.querySelector("#wp-to");
  if (fromEl) fromEl.onchange = () => { setCustom(); FROM = fromEl.value || FROM; lsSet(FROM_KEY, FROM); render(root); };
  if (toEl) toEl.onchange = () => { setCustom(); TO = toEl.value || TO; lsSet(TO_KEY, TO); render(root); };
}

function colHtml(c, pxPerH) {
  const segs = c.segs.map((s) =>
    `<div class="wp-seg" style="height:${s.h * pxPerH}px;background:${PRIO[s.b].c}" title="${PRIO[s.b].n} ${fmtH(s.h)}"><span>${s.h >= 1 ? fmtH(s.h) : ""}</span></div>`).join("");
  const gap = c.free > 0 ? `<div class="wp-seg gap" style="height:${c.free * pxPerH}px"><span>${c.free >= 1 ? "空 " + fmtH(c.free) : ""}</span></div>` : "";
  const capLine = `<div class="wp-capline" style="bottom:${c.cap * pxPerH}px"></div>`;
  return `<div class="wp-col">
    <div class="wp-barwrap" style="height:${Math.max(c.cap, c.total) * pxPerH}px">${segs}${gap}${capLine}</div>
    <div class="wp-foot"><div class="wp-dow">${c.label}<small>${c.sub ? " " + c.sub : ""}</small></div><div class="wp-tot ${c.over ? "over" : ""}">${fmtH(c.total)}</div></div>
  </div>`;
}

function css() {
  return `
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
  .wp-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:${C.muted};align-items:center}
  .wp-legend .it{display:inline-flex;align-items:center;gap:6px}
  .wp-legend .it i{width:11px;height:11px;border-radius:3px;display:inline-block}
  .wp-legend .gap{width:13px;height:11px;border-radius:3px;display:inline-block;background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 4px,#eef1f5 4px,#eef1f5 8px);border:1px solid ${C.line}}
  .wp-legend .rule{width:18px;border-top:2px dashed ${C.capline};display:inline-block}
  .wp-legend .wp-sum{margin-left:auto;font-weight:700;color:${C.ink}}`;
}
