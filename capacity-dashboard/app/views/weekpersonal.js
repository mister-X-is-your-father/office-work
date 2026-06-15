// 週プラン（個人/全員）。担当者を1人 or 全員、FROM〜TO（最長3ヶ月）の稼働を「重要度別」に縦積み上げ。
// 期間で粒度自動切替（≤14日=日別 / それ超=週別集計）。容量線は列ごと（=メンバー数×capH×営業日数）。
// 集計は capacity.js を変更せず weekLoadByMember を重要度バケットごとに呼んで再利用。重要度色は kinds.PRIO(SSoT)。
import { load } from "../lib/store.js";
import { weekLoadByMember, shiftISO, isBusinessDay, daysUntil } from "../lib/capacity.js";
import { PRIO, prioBucket } from "../lib/kinds.js";
import { C, fmtH, esc, member_color } from "../lib/ui.js";

const WHO_KEY = "ts.weekpersonal.who", FROM_KEY = "ts.weekpersonal.from", TO_KEY = "ts.weekpersonal.to";
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const BUCKETS = [4, 3, 2, 1, 0]; // 積む順（column-reverse で下から MUST→なし）
const MAX_SPAN = 92;             // 最長3ヶ月
const DAY_GRAIN_MAX = 14;        // この日数以下は日別、超は週別集計
let CAP = 8;

const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let WHO = lsGet(WHO_KEY, "");   // ""=自分既定 / "all"=全員 / memberId
let FROM = lsGet(FROM_KEY, ""), TO = lsGet(TO_KEY, "");

const round1 = (n) => Math.round(n * 10) / 10;
const dowOf = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();
const weekStartOf = (iso) => { const d = dowOf(iso); return shiftISO(iso, d === 0 ? -6 : 1 - d); };

function thisWeek() {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const mon = shiftISO(today, dow === 0 ? -6 : 1 - dow);
  return [mon, shiftISO(mon, 4)];
}
function bizDaysList(from, to, holidays) {
  const out = [];
  for (let cur = from, i = 0; cur <= to && i < 400; cur = shiftISO(cur, 1), i++) {
    if (isBusinessDay(cur, holidays)) out.push(cur);
  }
  return out;
}

export async function render(root) {
  const { tasks, members, plansByTask, settings, holidaysSet, me } = await load();
  CAP = settings.capH;

  // 期間の既定=今週／正規化（from<=to、span<=92）
  if (!FROM || !TO) { const [a, b] = thisWeek(); FROM = FROM || a; TO = TO || b; }
  if (FROM > TO) { const t = FROM; FROM = TO; TO = t; }
  if (daysUntil(FROM, TO) > MAX_SPAN) TO = shiftISO(FROM, MAX_SPAN);

  // 担当者（全員 / 自分 / 指定メンバー）
  const meId = me && me.id;
  const activeMembers = members || [];
  let sel = null;
  if (WHO !== "all") {
    sel = activeMembers.find((m) => String(m.id) === String(WHO))
      || activeMembers.find((m) => m.id === meId) || activeMembers[0];
    if (sel) WHO = String(sel.id);
  }
  const modeMembers = WHO === "all" ? activeMembers : (sel ? [sel] : []);
  const nMem = modeMembers.length || 1;

  const bdays = bizDaysList(FROM, TO, holidaysSet);
  const granularity = daysUntil(FROM, TO) <= DAY_GRAIN_MAX ? "day" : "week";

  // 重要度バケット × 営業日（modeMembers 合算）。capacity.js は変更せず weekLoadByMember 再利用。
  const perBucketDaily = BUCKETS.map((b) => {
    const ts = (tasks || []).filter((t) => prioBucket(t.priority) === b);
    const wl = modeMembers.length ? weekLoadByMember(ts, modeMembers, bdays, CAP, plansByTask, { holidays: holidaysSet }) : [];
    const days = bdays.map((day, di) => ({ day, h: round1(wl.reduce((s, mm) => s + (mm.days[di].h || 0), 0)) }));
    return { b, days };
  });

  // 列生成（日別 or 週別集計）。容量は列ごと（人数×capH×営業日数）。
  let cols;
  if (granularity === "day") {
    cols = bdays.map((day, di) => {
      const segs = perBucketDaily.map((pb) => ({ b: pb.b, h: pb.days[di].h })).filter((s) => s.h > 0);
      const total = round1(segs.reduce((s, x) => s + x.h, 0));
      const cap = nMem * CAP;
      return { label: day.slice(5).replace("-", "/"), sub: WD[dowOf(day)], segs, total, cap, free: round1(Math.max(0, cap - total)), over: total > cap + 1e-6 };
    });
  } else {
    const groups = new Map(); // weekStart -> [dayIndex]
    bdays.forEach((day, di) => { const ws = weekStartOf(day); (groups.get(ws) || groups.set(ws, []).get(ws)).push(di); });
    cols = [...groups.entries()].map(([ws, idxs]) => {
      const segMap = {};
      for (const di of idxs) for (const pb of perBucketDaily) segMap[pb.b] = (segMap[pb.b] || 0) + pb.days[di].h;
      const segs = BUCKETS.map((b) => ({ b, h: round1(segMap[b] || 0) })).filter((s) => s.h > 0);
      const total = round1(segs.reduce((s, x) => s + x.h, 0));
      const cap = nMem * CAP * idxs.length;
      return { label: ws.slice(5).replace("-", "/") + "週", sub: `${idxs.length}日`, segs, total, cap, free: round1(Math.max(0, cap - total)), over: total > cap + 1e-6 };
    });
  }

  const yMax = Math.max(1, ...cols.map((c) => Math.max(c.cap, c.total))) * 1.12;
  const H = 300, pxPerH = H / yMax;
  const tickStep = yMax > 80 ? 40 : (yMax > 40 ? 16 : (yMax > 16 ? 8 : 4));
  let ticks = "";
  for (let h = 0; h <= yMax - tickStep / 2; h += tickStep) ticks += `<div class="wp-tick" style="bottom:${h * pxPerH}px">${h}h</div>`;

  // 担当者タブ（全員 / 自分 / 各メンバー）
  const meMember = activeMembers.find((m) => m.id === meId);
  const others = activeMembers.filter((m) => m.id !== meId);
  const tab = (val, label, color, on) =>
    `<button class="wp-who-b${on ? " on" : ""}" data-who="${esc(String(val))}">${color ? `<i class="wp-who-av" style="background:${color}">${esc(label[0] || "?")}</i>` : ""}${esc(label)}</button>`;
  const whoTabs = tab("all", "全員", "", WHO === "all")
    + (meMember ? tab(meMember.id, "自分", member_color(meMember.id), String(WHO) === String(meMember.id)) : "")
    + others.map((m) => tab(m.id, m.name || m.username, member_color(m.id), String(WHO) === String(m.id))).join("");

  const sumH = round1(cols.reduce((s, c) => s + c.total, 0));
  const capDesc = WHO === "all" ? `全員${nMem}名・容量 ${CAP * nMem}h/日` : `容量 ${CAP}h/日`;
  const granLabel = granularity === "day" ? "日別" : "週別集計";

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">${WHO === "all" ? "全員" : "個人別"} 週プラン <small>${FROM.slice(5)}〜${TO.slice(5)} ・ ${granLabel} ・ ${capDesc} ・ 重要度別</small></h1>
    <div class="wp-tools">
      <div class="wp-who" id="wp-who">${whoTabs || `<span class="wp-noone">メンバーがいません</span>`}</div>
      <div class="wp-range">期間
        <input type="date" id="wp-from" value="${FROM}">〜<input type="date" id="wp-to" value="${TO}">
        <span class="wp-hint">最長3ヶ月</span>
      </div>
    </div>
    <div class="card wp-card">
      <div class="wp-chart" style="height:${H + 44}px">
        <div class="wp-yaxis" style="height:${H}px">${ticks}</div>
        <div class="wp-cols" style="height:${H}px">${cols.map((c) => colHtml(c, pxPerH)).join("") || `<div class="wp-empty">表示できる営業日がありません</div>`}</div>
      </div>
    </div>
    <div class="wp-legend">
      ${BUCKETS.map((b) => `<span class="it"><i style="background:${PRIO[b].c}"></i>${PRIO[b].n}</span>`).join("")}
      <span class="it"><span class="gap"></span>空き</span>
      <span class="it"><span class="rule"></span>容量線</span>
      <span class="it wp-sum">期間合計 ${fmtH(sumH)}</span>
    </div>`;

  root.querySelectorAll("#wp-who [data-who]").forEach((b) => {
    b.onclick = () => { WHO = b.dataset.who; lsSet(WHO_KEY, WHO); render(root); };
  });
  const fromEl = root.querySelector("#wp-from"), toEl = root.querySelector("#wp-to");
  if (fromEl) fromEl.onchange = () => { FROM = fromEl.value || FROM; lsSet(FROM_KEY, FROM); render(root); };
  if (toEl) toEl.onchange = () => { TO = toEl.value || TO; lsSet(TO_KEY, TO); render(root); };
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
  .wp-who-av{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#fff;font-size:9px;font-weight:700}
  .wp-who-b.on .wp-who-av{box-shadow:0 0 0 1.5px #fff}
  .wp-noone{color:${C.muted};font-size:12px}
  .wp-range{display:flex;align-items:center;gap:6px;font-size:12.5px;color:${C.muted};margin-left:auto}
  .wp-range input{font:inherit;font-size:12.5px;padding:4px 7px;border:1px solid ${C.line};border-radius:7px;background:#fff;color:${C.ink}}
  .wp-hint{font-size:11px;color:${C.muted}}
  .wp-card{padding:18px 20px 14px}
  .wp-chart{position:relative;padding-left:34px}
  .wp-yaxis{position:absolute;left:0;bottom:44px;width:34px}
  .wp-tick{position:absolute;right:6px;font-size:10px;color:${C.muted};transform:translateY(50%)}
  .wp-cols{display:flex;gap:12px;align-items:flex-end}
  .wp-col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center}
  .wp-barwrap{position:relative;width:100%;max-width:64px;display:flex;flex-direction:column-reverse;border:1px solid ${C.line};border-bottom:0;border-radius:7px 7px 0 0;overflow:hidden}
  .wp-seg{display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.5);min-height:2px}
  .wp-seg span{text-shadow:0 1px 1px rgba(0,0,0,.15)}
  .wp-seg.gap{background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 5px,#eef1f5 5px,#eef1f5 10px);color:#b3bac4;border-bottom:0}
  .wp-seg.gap span{text-shadow:none}
  .wp-capline{position:absolute;left:0;right:0;border-top:2px dashed ${C.capline};z-index:4;pointer-events:none}
  .wp-foot{margin-top:8px;text-align:center}
  .wp-dow{font-size:11.5px;font-weight:600}.wp-dow small{color:${C.muted};font-weight:400}
  .wp-tot{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;margin-top:1px}.wp-tot.over{color:${C.over};font-weight:700}
  .wp-empty{margin:auto;color:${C.muted};font-size:12px}
  .wp-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:${C.muted};align-items:center}
  .wp-legend .it{display:inline-flex;align-items:center;gap:6px}
  .wp-legend .it i{width:11px;height:11px;border-radius:3px;display:inline-block}
  .wp-legend .gap{width:13px;height:11px;border-radius:3px;display:inline-block;background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 4px,#eef1f5 4px,#eef1f5 8px);border:1px solid ${C.line}}
  .wp-legend .rule{width:18px;border-top:2px dashed ${C.capline};display:inline-block}
  .wp-legend .wp-sum{margin-left:auto;font-weight:700;color:${C.ink}}`;
}
