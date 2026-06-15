// 個人別 週プラン（モック19 VIEW A の1人版）。担当者を1人選び、その人の月〜金の稼働を
// 「重要度別」に縦積み上げ。容量線=capH/日・空きは網掛け。重要度色は kinds.PRIO(SSoT)。
// チーム俯瞰の weekstack.js（週日別負荷）に対する個人フォーカス版。
// 集計は capacity.js を変更せず weekLoadByMember を重要度バケットごとに呼んで再利用。
import { load } from "../lib/store.js";
import { weekLoadByMember, shiftISO } from "../lib/capacity.js";
import { PRIO, prioBucket } from "../lib/kinds.js";
import { C, fmtH, esc, member_color } from "../lib/ui.js";

const WHO_KEY = "ts.weekpersonal.who"; // 選択担当者を個人保存（再読込でも維持）
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const BUCKETS = [4, 3, 2, 1, 0]; // 積む順（column-reverse で下から MUST→なし）
let CAP = 8; // 設定（容量 h/日）で上書き
let WHO = (() => { try { return localStorage.getItem(WHO_KEY) || ""; } catch { return ""; } })();

function weekDays() {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  const monday = shiftISO(today, dow === 0 ? -6 : 1 - dow);
  return [0, 1, 2, 3, 4].map((i) => shiftISO(monday, i));
}

export async function render(root) {
  const { tasks, members, plansByTask, settings, holidaysSet, me } = await load();
  CAP = settings.capH;
  const isoDays = weekDays();

  // 選択メンバー（既定=自分／無ければ先頭）。
  const sel = (members || []).find((m) => String(m.id) === String(WHO))
    || (members || []).find((m) => m.id === (me && me.id))
    || (members || [])[0];
  if (sel) WHO = String(sel.id);

  // 重要度バケットごとに week 集計（capacity.js は変更せず weekLoadByMember を再利用）。
  const perBucket = BUCKETS.map((b) => {
    const ts = (tasks || []).filter((t) => prioBucket(t.priority) === b);
    const wl = sel ? weekLoadByMember(ts, [sel], isoDays, CAP, plansByTask, { holidays: holidaysSet }) : [];
    return { b, days: (wl[0] && wl[0].days) || isoDays.map((d) => ({ day: d, h: 0 })) };
  });

  // 日 → {segs:[{b,h}], total, free, over}
  const byDay = isoDays.map((day, di) => {
    const segs = perBucket.map((pb) => ({ b: pb.b, h: pb.days[di].h })).filter((s) => s.h > 0);
    const total = round1(segs.reduce((s, x) => s + x.h, 0));
    return { day, di, segs, total, free: round1(Math.max(0, CAP - total)), over: total > CAP + 1e-6 };
  });

  const maxTotal = byDay.reduce((m, d) => Math.max(m, d.total), 0);
  const yMax = Math.max(Math.ceil(CAP * 1.15), Math.ceil(maxTotal) + 1);
  const H = 300, pxPerH = H / yMax;
  const step = yMax > 16 ? 8 : 4;
  let ticks = "";
  for (let h = 0; h <= yMax - step / 2; h += step) ticks += `<div class="wp-tick" style="bottom:${h * pxPerH}px">${h}h</div>`;

  // 担当者タブ（自分を先頭 / 各メンバー・アバター色）。
  const meId = me && me.id;
  const meMember = (members || []).find((m) => m.id === meId);
  const others = (members || []).filter((m) => m.id !== meId);
  const whoBtn = (m) => {
    const on = String(WHO) === String(m.id) ? " on" : "";
    const label = m.id === meId ? "自分" : (m.name || m.username);
    return `<button class="wp-who-b${on}" data-who="${m.id}"><i class="wp-who-av" style="background:${member_color(m.id)}">${esc((m.name || m.username || "?")[0])}</i>${esc(label)}</button>`;
  };
  const whoTabs = (meMember ? whoBtn(meMember) : "") + others.map(whoBtn).join("");
  const weekH = round1(byDay.reduce((s, d) => s + d.total, 0));

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">個人別 週プラン <small>${isoDays[0].slice(5)}〜${isoDays[4].slice(5)} ・ 容量 ${CAP}h/日 ・ 重要度別</small></h1>
    <div class="wp-who" id="wp-who">${whoTabs || `<span class="wp-noone">メンバーがいません</span>`}</div>
    <div class="card wp-card">
      <div class="wp-chart" style="height:${H + 40}px">
        <div class="wp-yaxis" style="height:${H}px">${ticks}</div>
        <div class="wp-cap" style="bottom:${CAP * pxPerH + 40}px"><span>容量 ${CAP}h</span></div>
        <div class="wp-cols" style="height:${H}px">${byDay.map((d) => colHtml(d, pxPerH)).join("")}</div>
      </div>
    </div>
    <div class="wp-legend">
      ${BUCKETS.map((b) => `<span class="it"><i style="background:${PRIO[b].c}"></i>${PRIO[b].n}</span>`).join("")}
      <span class="it"><span class="gap"></span>空き</span>
      <span class="it"><span class="rule"></span>容量線</span>
      <span class="it wp-sum">週合計 ${fmtH(weekH)}</span>
    </div>`;

  root.querySelectorAll("#wp-who [data-who]").forEach((b) => {
    b.onclick = () => { WHO = b.dataset.who; try { localStorage.setItem(WHO_KEY, WHO); } catch {} render(root); };
  });
}

const round1 = (n) => Math.round(n * 10) / 10;

function colHtml(d, pxPerH) {
  const dow = WD[new Date(d.day + "T00:00:00Z").getUTCDay()];
  const segs = d.segs.map((s) =>
    `<div class="wp-seg" style="height:${s.h * pxPerH}px;background:${PRIO[s.b].c}" title="${PRIO[s.b].n} ${fmtH(s.h)}"><span>${s.h >= 1 ? fmtH(s.h) : ""}</span></div>`).join("");
  const gap = d.free > 0 ? `<div class="wp-seg gap" style="height:${d.free * pxPerH}px"><span>空 ${fmtH(d.free)}</span></div>` : "";
  return `<div class="wp-col">
    <div class="wp-bar" style="height:${Math.max(d.total, CAP) * pxPerH}px">${segs}${gap}</div>
    <div class="wp-foot"><div class="wp-dow">${d.day.slice(5).replace("-", "/")}<small>(${dow})</small></div><div class="wp-tot ${d.over ? "over" : ""}">${fmtH(d.total)}</div></div>
  </div>`;
}

function css() {
  return `
  .wp-who{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px}
  .wp-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:#fff;color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .wp-who-b:hover{border-color:#cfd9e6}
  .wp-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .wp-who-av{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#fff;font-size:9px;font-weight:700}
  .wp-who-b.on .wp-who-av{box-shadow:0 0 0 1.5px #fff}
  .wp-noone{color:${C.muted};font-size:12px}
  .wp-card{padding:18px 20px 14px}
  .wp-chart{position:relative;padding-left:34px}
  .wp-yaxis{position:absolute;left:0;bottom:40px;width:34px}
  .wp-tick{position:absolute;right:6px;font-size:10px;color:${C.muted};transform:translateY(50%)}
  .wp-cap{position:absolute;left:34px;right:0;border-top:2px dashed ${C.capline};z-index:3;pointer-events:none}
  .wp-cap span{position:absolute;right:0;top:-9px;font-size:10px;color:${C.muted};background:#fff;padding:0 5px;border:1px solid ${C.line};border-radius:10px}
  .wp-cols{display:flex;gap:14px;align-items:flex-end}
  .wp-col{flex:1;display:flex;flex-direction:column;align-items:center}
  .wp-bar{width:100%;max-width:70px;display:flex;flex-direction:column-reverse;border-radius:7px 7px 0 0;overflow:hidden;border:1px solid ${C.line};border-bottom:0}
  .wp-seg{display:flex;align-items:center;justify-content:center;color:#fff;font-size:10.5px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.5);min-height:2px}
  .wp-seg span{text-shadow:0 1px 1px rgba(0,0,0,.15)}
  .wp-seg.gap{background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 5px,#eef1f5 5px,#eef1f5 10px);color:#b3bac4}
  .wp-seg.gap span{text-shadow:none}
  .wp-foot{margin-top:8px;text-align:center}
  .wp-dow{font-size:12px;font-weight:600}.wp-dow small{color:${C.muted};font-weight:400;margin-left:2px}
  .wp-tot{font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;margin-top:1px}.wp-tot.over{color:${C.over};font-weight:700}
  .wp-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:${C.muted};align-items:center}
  .wp-legend .it{display:inline-flex;align-items:center;gap:6px}
  .wp-legend .it i{width:11px;height:11px;border-radius:3px;display:inline-block}
  .wp-legend .gap{width:13px;height:11px;border-radius:3px;display:inline-block;background:repeating-linear-gradient(135deg,#fbfcfd,#fbfcfd 4px,#eef1f5 4px,#eef1f5 8px);border:1px solid ${C.line}}
  .wp-legend .rule{width:18px;border-top:2px dashed ${C.capline};display:inline-block}
  .wp-legend .wp-sum{margin-left:auto;font-weight:700;color:${C.ink}}`;
}
