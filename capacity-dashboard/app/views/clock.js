// 本日の稼働予定 — 円時計ビュー（mock 57 を実データ配線）。
// 色=優先度／模様=種別／外周=超過／空き=薄グレー／カテゴリ別の折りたたみセクション。
import { todayItemsByMember, suggestDays } from "../lib/today_items.js";
import { fmtH, esc, member_color, todayISO } from "../lib/ui.js";
import { dateOnly, hasDate, shiftISO } from "../lib/capacity.js";
import { deletePlan, logPlan, updateTask } from "../lib/api.js";
import { invalidate } from "../lib/store.js";

const CAP = 8;
const PRIO = { 4: { c: "#e5484d", n: "最優先" }, 3: { c: "#f5872e", n: "高" }, 2: { c: "#3a86ff", n: "中" }, 1: { c: "#8a93a0", n: "低" } };
const NEUTRAL = "#8a93a0";   // 会議/定例（優先度なし）
const FREECOL = "#e7ebf0";   // 空き=薄グレー
const CATS = [
  { key: "meeting", label: "会議", pat: "meeting" },
  { key: "recurring", label: "定例", pat: "routine" },
  { key: "planned", label: "予定タスク", pat: "task" },
  { key: "adhoc", label: "当日追加", pat: "adhoc" },
];
const CATMAP = Object.fromEntries(CATS.map((c) => [c.key, c]));
const itemColor = (it) => (it.prio ? PRIO[it.prio].c : NEUTRAL);
const itemPat = (it) => CATMAP[it.cat].pat;

/* ---------- geometry ---------- */
const R = 80, CX = 100, CY = 100, STROKE = 15, OR = 95, OVERW = 7;
function arc(r, f0, f1) {
  const a0 = -Math.PI / 2 + f0 * 2 * Math.PI, a1 = -Math.PI / 2 + f1 * 2 * Math.PI;
  const x0 = CX + r * Math.cos(a0), y0 = CY + r * Math.sin(a0);
  const x1 = CX + r * Math.cos(a1), y1 = CY + r * Math.sin(a1);
  const large = (f1 - f0) > 0.5 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function seg(r, f0, f1, color, pat, width) {
  if (f1 <= f0) return "";
  let s = `<path d="${arc(r, f0, f1)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="butt"/>`;
  if (pat === "meeting") s += `<path d="${arc(r, f0, f1)}" fill="none" stroke="url(#ckHatch)" stroke-width="${width}" stroke-linecap="butt"/>`;
  if (pat === "routine") s += `<path d="${arc(r, f0, f1)}" fill="none" stroke="url(#ckDots)" stroke-width="${width}" stroke-linecap="butt"/>`;
  if (pat === "adhoc") {
    const a = -Math.PI / 2 + ((f0 + f1) / 2) * 2 * Math.PI;
    s += `<circle cx="${(CX + r * Math.cos(a)).toFixed(1)}" cy="${(CY + r * Math.sin(a)).toFixed(1)}" r="3.6" fill="#fff" stroke="${color}" stroke-width="1.8"/>`;
  }
  return s;
}
function clockSVG(m) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (i / 8) * 2 * Math.PI, ir = R - STROKE / 2 - 3, orr = R + STROKE / 2 + 3;
    out.push(`<line x1="${(CX + ir * Math.cos(a)).toFixed(1)}" y1="${(CY + ir * Math.sin(a)).toFixed(1)}" x2="${(CX + orr * Math.cos(a)).toFixed(1)}" y2="${(CY + orr * Math.sin(a)).toFixed(1)}" stroke="${i === 0 ? "#c2c9d4" : "#dde2e9"}" stroke-width="${i === 0 ? 2 : 1}"/>`);
  }
  let acc = 0, accOver = 0;
  for (const it of m.items) {
    const col = itemColor(it), pat = itemPat(it);
    const within = Math.min(it.h, Math.max(0, CAP - acc));
    if (within > 0) out.push(seg(R, acc / CAP, (acc + within) / CAP, col, pat, STROKE));
    const over = it.h - within;
    if (over > 0) { out.push(seg(OR, accOver / CAP, Math.min(1, (accOver + over) / CAP), col, pat, OVERW)); accOver += over; }
    acc += it.h;
  }
  if (m.freeH > 0) out.push(`<path d="${arc(R, m.usedH / CAP, 1)}" fill="none" stroke="${FREECOL}" stroke-width="${STROKE}" stroke-linecap="butt"/>`);
  const capInner = R - STROKE / 2 - 6, capOuter = (m.overH > 0 ? 99 : R + STROKE / 2 + 5);
  out.push(`<line x1="${CX}" y1="${(CY - capInner).toFixed(1)}" x2="${CX}" y2="${(CY - capOuter).toFixed(1)}" stroke="#9aa3af" stroke-width="2"/>`);
  const big = m.overH > 0 ? `+${fmtH(m.overH)}` : (m.freeH > 0 ? fmtH(m.freeH) : "満");
  const bigcol = m.overH > 0 ? "#e5484d" : (m.freeH > 0 ? "#2fa66b" : "#8a93a0");
  const sub = m.overH > 0 ? "超過" : (m.freeH > 0 ? "空き" : "ちょうど");
  return `<svg class="ck-dial" width="200" height="200" viewBox="0 0 200 200" role="img" aria-label="${esc(m.member.name || "")} ${sub} ${big}">
    ${out.join("\n    ")}
    <text x="${CX}" y="${CY - 3}" text-anchor="middle" class="ck-cn" fill="${bigcol}" style="font-variant-numeric:tabular-nums">${big}</text>
    <text x="${CX}" y="${CY + 14}" text-anchor="middle" class="ck-cl" fill="#6b7480">${sub} · ${fmtH(m.usedH)}/${CAP}h</text>
  </svg>`;
}

/* ---------- card with collapsible category sections ---------- */
function cardHTML(m, idx) {
  const nm = m.member.name || m.member.username || `#${m.member.id}`;
  const stateCls = m.overH > 0 ? "over" : (m.freeH > 0 ? "free" : "just");
  const stateTxt = m.overH > 0 ? `超過 +${fmtH(m.overH)}` : (m.freeH > 0 ? `空き ${fmtH(m.freeH)}` : "ちょうど");
  let sections = "";
  for (const c of CATS) {
    const items = m.items.filter((it) => it.cat === c.key);
    if (!items.length) continue;
    const sumH = items.reduce((s, it) => s + it.h, 0);
    const cls = c.pat !== "task" ? c.pat : (c.key === "adhoc" ? "adhoc" : "");
    const rows = items.map((it) => {
      const adv = it.advanced ? `<span class="ck-tag">前倒し</span>` : "";
      const canEdit = it.cat === "planned" || it.cat === "adhoc";
      const menu = canEdit ? `<button class="ck-more" data-task="${it.taskId}" data-member="${m.member.id}" data-h="${it.h}" data-title="${esc(it.title)}" title="別日へ移す">⋯</button>` : "";
      return `<div class="ck-row"><i class="ck-dot ${cls}" style="background:${itemColor(it)}"></i><span class="ck-tn">${esc(it.title)}${adv}</span><span class="ck-th">${fmtH(it.h)}</span>${menu}</div>`;
    }).join("");
    sections += `<details class="ck-sec" open>
      <summary><span class="ck-chev">▾</span><i class="ck-kic ${cls}"></i>${c.label}<span class="ck-cnt">${items.length}</span><span class="ck-n">${fmtH(sumH)}</span></summary>
      ${rows}
    </details>`;
  }
  if (m.freeH > 0) sections += `<div class="ck-row free"><i class="ck-dot" style="background:${FREECOL}"></i><span class="ck-tn">空き工数</span><span class="ck-th">${fmtH(m.freeH)}</span></div>`;
  if (!m.items.length) sections = `<div class="ck-empty">本日の予定なし</div>` + sections;

  return `<div class="ck-card ${m.overH > 0 ? "is-over" : ""}">
    <div class="ck-h"><span class="ck-av" style="background:${member_color(idx)}">${esc((nm)[0] || "?")}</span><span class="ck-nm">${esc(nm)}</span><span class="ck-badge ${stateCls}">${stateTxt}</span></div>
    ${clockSVG(m)}
    <div class="ck-list">${sections}</div>
  </div>`;
}

function kpiStrip(states) {
  const cap = states.length * CAP;
  const usedAll = states.reduce((s, m) => s + Math.min(m.usedH, CAP), 0);
  const rate = cap > 0 ? Math.round(usedAll / cap * 100) : 0;
  const overMembers = states.filter((m) => m.overH > 0);
  const overH = states.reduce((s, m) => s + m.overH, 0);
  let mustN = 0, mustH = 0, fixedH = 0, mtgH = 0, rtnH = 0, adhocN = 0;
  for (const m of states) for (const it of m.items) {
    if (it.prio === 4) { mustN++; mustH += it.h; }
    if (it.cat === "meeting") { fixedH += it.h; mtgH += it.h; }
    if (it.cat === "recurring") { fixedH += it.h; rtnH += it.h; }
    if (it.cat === "adhoc") adhocN++;
  }
  const realH = Math.round((usedAll - Math.min(fixedH, usedAll)) * 10) / 10;
  return `<div class="ck-strip">
    <div class="ck-kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(usedAll)}<small>/ ${cap}h ・ ${rate}%</small></div><div class="ck-bar"><i style="width:${rate}%;background:#3a86ff"></i><i style="flex:1;background:#eef1f5"></i></div></div>
    <div class="ck-kpi over ${overH > 0 ? "" : "zero"}"><div class="l">要再配分（超過）</div><div class="v">${overH > 0 ? "+" + fmtH(overH) : "なし"}</div><div class="s">${overMembers.length ? esc(overMembers.map((m) => m.member.name || m.member.username).join("・")) + " → 移し先を検討" : "全員が容量内"}</div></div>
    <div class="ck-kpi"><div class="l">本日の最優先</div><div class="v">${mustN}<small>件 ・ ${fmtH(mustH)}</small></div><div class="s">落とせない最優先（赤）。当日追加 ${adhocN}件</div></div>
    <div class="ck-kpi"><div class="l">固定枠（会議・定例）</div><div class="v">${fmtH(fixedH)}</div><div class="s">会議${fmtH(mtgH)}・定例${fmtH(rtnH)}／実作業に使えるのは ${fmtH(realH)}</div></div>
  </div>`;
}

function legend() {
  return `<div class="ck-legend">
    <span class="grp"><span class="glbl">優先度</span>
      <span class="it"><i class="sw" style="background:${PRIO[4].c}"></i>最優先</span>
      <span class="it"><i class="sw" style="background:${PRIO[3].c}"></i>高</span>
      <span class="it"><i class="sw" style="background:${PRIO[2].c}"></i>中</span>
      <span class="it"><i class="sw" style="background:${PRIO[1].c}"></i>低</span></span>
    <span class="sep"></span>
    <span class="grp"><span class="glbl">種別</span>
      <span class="it"><i class="sw"></i>タスク</span>
      <span class="it"><i class="sw hatch"></i>会議</span>
      <span class="it"><i class="sw dots"></i>定例</span>
      <span class="it"><i class="sw adhoc"></i>当日追加</span></span>
    <span class="sep"></span>
    <span class="grp">
      <span class="it"><i class="sw" style="background:${FREECOL}"></i>空き工数</span>
      <span class="it"><i class="sw" style="background:linear-gradient(90deg,${PRIO[4].c},${PRIO[2].c})"></i>外周=超過（そのタスク色）</span></span>
  </div>`;
}

const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <pattern id="ckHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="3" y1="0" x2="3" y2="6" stroke="#fff" stroke-width="2.4" stroke-opacity="0.55"/></pattern>
  <pattern id="ckDots" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1.15" fill="#fff" fill-opacity="0.62"/></pattern>
</defs></svg>`;

export function renderClock(container, data, day, rerender) {
  const map = todayItemsByMember(data, day, CAP);
  const states = data.members.map((m) => map.get(m.id)).filter(Boolean)
    .sort((a, b) => (b.freeH - a.freeH) || (a.overH - b.overH));
  container.innerHTML = `<style>${css()}</style>${DEFS}
    <div class="ck-subtitle">並び=会議→定例→優先度（12時起点）／色=優先度／模様=種別／外周=超過</div>
    ${states.length ? kpiStrip(states) : ""}
    <div class="ck-grid">${states.map((m, i) => cardHTML(m, i)).join("")}</div>
    ${states.length ? legend() : `<div class="ck-empty">本日のメンバー負荷がありません。</div>`}
    <div class="ck-modal" id="ck-modal" hidden><div class="ck-modal-bg"></div><div class="ck-modal-card" id="ck-modal-card"></div></div>`;
  wireInteractions(container, data, day, rerender);
  return container;
}

/* ---------- 別日へ移す / 本日から外す ---------- */
const WDOW = ["日", "月", "火", "水", "木", "金", "土"];
const mdw = (iso) => { const d = new Date(iso + "T00:00:00Z"); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WDOW[d.getUTCDay()]})`; };
const plansOf = (data, taskId) => (data.plansByTask && data.plansByTask.get ? data.plansByTask.get(taskId) : null) || [];
// このメンバーの本日負荷に効くplan: 自分指定 or 未指定 or「担当外user_id＝全担当へ配分」。
const todayPlans = (data, taskId, memberId, day, aids = []) =>
  plansOf(data, taskId).filter((p) => dateOnly(p.plan_date) === day && (p.user_id === memberId || !p.user_id || !aids.includes(p.user_id)));
const aidsOf = (data, taskId) => ((data.tasks.find((x) => x.id === taskId) || {}).assignees || []).map((a) => a.id);

function wireInteractions(container, data, day, rerender) {
  const modal = container.querySelector("#ck-modal");
  const card = container.querySelector("#ck-modal-card");
  const close = () => { modal.hidden = true; card.innerHTML = ""; };
  modal.querySelector(".ck-modal-bg").onclick = close;

  const move = async (taskId, memberId, neededH, targetDay) => {
    const todays = todayPlans(data, taskId, memberId, day, aidsOf(data, taskId));
    if (todays.length) {
      const secs = todays.reduce((s, p) => s + (p.seconds || 0), 0) || Math.round(neededH * 3600);
      for (const p of todays) await deletePlan(taskId, p.id);
      await logPlan(taskId, secs, targetDay, "", memberId);
    } else {
      await updateTask(taskId, { due_date: targetDay + "T00:00:00Z" }); // 見積り/期日ベース → 期日を移動
    }
    invalidate(); close(); await rerender();
  };
  const dropToday = async (taskId, memberId) => {
    for (const p of todayPlans(data, taskId, memberId, day, aidsOf(data, taskId))) await deletePlan(taskId, p.id);
    invalidate(); close(); await rerender();
  };

  container.querySelectorAll(".ck-more").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const taskId = +btn.dataset.task, memberId = +btn.dataset.member, neededH = +btn.dataset.h;
      const t = data.tasks.find((x) => x.id === taskId) || {};
      const tomorrow = shiftISO(day, 1);
      let toISO = shiftISO(day, 14), overDue = false, dueLabel = "";
      if (hasDate(t.due_date)) {
        const due = dateOnly(t.due_date); dueLabel = `期日 ${mdw(due)}`;
        if (due >= tomorrow) toISO = due; else { overDue = true; }
      }
      const sugg = suggestDays(data, memberId, tomorrow, toISO, neededH, CAP);
      const planBased = todayPlans(data, taskId, memberId, day, (t.assignees || []).map((a) => a.id)).length > 0;
      const list = sugg.length
        ? sugg.slice(0, 8).map((s) => `<button class="ck-day ${s.fits ? "fit" : "part"}" data-day="${s.day}">${mdw(s.day)}<span class="fh">空き ${fmtH(s.freeH)}${s.fits ? "" : "（部分）"}</span></button>`).join("")
        : `<div class="ck-none">${overDue ? "期日を過ぎています。" : ""}候補の空き日がありません。</div>`;
      card.innerHTML = `
        <div class="ck-mh"><b>${esc(btn.dataset.title)}</b><span class="ck-msub">${fmtH(neededH)}${dueLabel ? " ・ " + dueLabel : ""}</span></div>
        <div class="ck-mlbl">別日へ移す（${overDue ? "直近14日" : "期日まで"}・収まる日優先）</div>
        <div class="ck-days">${list}</div>
        <div class="ck-macts">${planBased ? `<button class="ck-drop">本日から外す（予定削除）</button>` : ""}<button class="ck-cancel">キャンセル</button></div>`;
      card.querySelectorAll(".ck-day").forEach((d) => { d.onclick = () => move(taskId, memberId, neededH, d.dataset.day); });
      const drop = card.querySelector(".ck-drop"); if (drop) drop.onclick = () => dropToday(taskId, memberId);
      card.querySelector(".ck-cancel").onclick = close;
      modal.hidden = false;
    };
  });
}

function css() {
  return `
  .ck-subtitle{font-size:12.5px;color:#6b7480;margin:-2px 0 16px}
  .ck-strip{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:22px}
  .ck-kpi{background:#fff;border:1px solid #e6e9ee;border-radius:14px;padding:14px 18px;box-shadow:0 1px 2px rgba(20,30,50,.04);flex:1 1 200px}
  .ck-kpi .l{font-size:11.5px;color:#6b7480;margin-bottom:3px}
  .ck-kpi .v{font-size:23px;font-weight:700}
  .ck-kpi .v small{font-size:13px;color:#6b7480;font-weight:600;margin-left:3px}
  .ck-kpi .s{font-size:10.5px;color:#6b7480;margin-top:6px;min-height:13px}
  .ck-kpi.over .v{color:#e5484d}.ck-kpi.over.zero .v{color:#2fa66b}
  .ck-bar{height:8px;border-radius:6px;background:#eef1f5;overflow:hidden;margin-top:9px;display:flex}
  .ck-bar i{display:block;height:100%}
  .ck-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:18px}
  .ck-card{background:#fff;border:1px solid #e6e9ee;border-radius:16px;padding:18px 16px 16px;box-shadow:0 1px 3px rgba(20,30,50,.05);position:relative}
  .ck-card.is-over{border-color:#f3c9cb}
  .ck-h{display:flex;align-items:center;gap:10px;margin-bottom:2px}
  .ck-av{width:30px;height:30px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font-size:13px;font-weight:700}
  .ck-nm{font-size:15px;font-weight:600}
  .ck-badge{margin-left:auto;font-size:11px;font-weight:600;border-radius:999px;padding:3px 9px}
  .ck-badge.free{color:#2fa66b;background:#eaf7ef}.ck-badge.over{color:#e5484d;background:#fdecec}.ck-badge.just{color:#8a93a0;background:#f0f1f4}
  .ck-dial{display:block;margin:6px auto 4px}
  .ck-cn{font-size:23px;font-weight:700}.ck-cl{font-size:10.5px}
  .ck-list{margin-top:8px;border-top:1px solid #e6e9ee;padding-top:8px}
  details.ck-sec{margin-top:7px}details.ck-sec:first-of-type{margin-top:1px}
  details.ck-sec>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;padding:4px 9px;background:#eef1f5;border-radius:7px;font-size:10.5px;font-weight:700;color:#54606e;user-select:none}
  details.ck-sec>summary::-webkit-details-marker{display:none}
  details.ck-sec>summary:hover{background:#e6eaf0}
  .ck-chev{font-size:8px;color:#6b7480;transition:transform .15s;transform:rotate(90deg)}
  details.ck-sec[open] .ck-chev{transform:rotate(180deg)}
  .ck-kic{width:11px;height:11px;border-radius:3px;flex:none;background:#8a93a0}
  .ck-kic.meeting,.ck-dot.meeting{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.85) 0 1.4px,transparent 1.4px 3px)}
  .ck-kic.routine,.ck-dot.routine{background-image:radial-gradient(rgba(255,255,255,.9) .9px,transparent 1.1px);background-size:3px 3px}
  .ck-kic.adhoc,.ck-dot.adhoc{box-shadow:inset 0 0 0 1.4px #fff}
  .ck-cnt{color:#6b7480;font-weight:600}
  .ck-n{margin-left:auto;font-weight:700;color:#54606e;font-variant-numeric:tabular-nums}
  .ck-row{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 4px 3px 12px}
  .ck-dot{width:10px;height:10px;border-radius:3px;flex:none}
  .ck-tn{color:#1d2430;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ck-tag{font-size:9.5px;color:#f5872e;border:1px solid #f6d4ad;border-radius:5px;padding:0 4px;margin-left:6px;vertical-align:1px}
  .ck-th{margin-left:auto;color:#6b7480;font-variant-numeric:tabular-nums}
  .ck-more{border:0;background:transparent;color:#9aa3af;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;border-radius:5px}
  .ck-more:hover{background:#eef1f5;color:#1d2430}
  .ck-row.free{padding:6px 4px 0 4px;font-weight:600}.ck-row.free .ck-tn{color:#2fa66b}
  .ck-empty{padding:20px;text-align:center;color:#6b7480;font-size:12px}
  .ck-legend{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:26px;padding-top:16px;border-top:1px solid #e6e9ee;font-size:12px;color:#6b7480;align-items:center}
  .ck-legend .grp{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ck-legend .glbl{font-weight:600;color:#1d2430}
  .ck-legend .it{display:inline-flex;align-items:center;gap:6px}
  .ck-legend .sw{width:13px;height:13px;border-radius:3px;display:inline-block;background:#8a93a0}
  .ck-legend .sw.hatch{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.85) 0 1.6px,transparent 1.6px 3.4px)}
  .ck-legend .sw.dots{background-image:radial-gradient(rgba(255,255,255,.85) 1px,transparent 1.3px);background-size:4px 4px}
  .ck-legend .sw.adhoc{box-shadow:inset 0 0 0 1.6px #fff}
  .ck-legend .sep{width:1px;height:14px;background:#e6e9ee}
  .ck-modal{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center}
  .ck-modal[hidden]{display:none}
  .ck-modal-bg{position:absolute;inset:0;background:rgba(20,30,50,.32)}
  .ck-modal-card{position:relative;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(20,30,50,.25);padding:18px 18px 16px;width:min(360px,92vw);max-height:80vh;overflow:auto}
  .ck-mh{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px}
  .ck-mh b{font-size:15px}.ck-msub{font-size:11.5px;color:#6b7480}
  .ck-mlbl{font-size:11px;color:#6b7480;margin:10px 0 7px}
  .ck-days{display:flex;flex-direction:column;gap:6px}
  .ck-day{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #e6e9ee;background:#fff;border-radius:9px;padding:9px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-align:left}
  .ck-day:hover{border-color:#cfe0ff;background:#f3f8ff}
  .ck-day .fh{font-size:11.5px;font-weight:600;color:#2fa66b}
  .ck-day.part .fh{color:#f5872e}
  .ck-none{font-size:12px;color:#6b7480;padding:8px 2px}
  .ck-macts{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
  .ck-macts button{border:1px solid #e6e9ee;background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:12.5px;cursor:pointer}
  .ck-drop{color:#e5484d;border-color:#f3c9cb!important}
  .ck-drop:hover{background:#fdecec}
  .ck-cancel:hover{background:#f3f5f8}`;
}
