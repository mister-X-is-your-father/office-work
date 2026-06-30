// 概要ダッシュボード（TickTick の「概要/統計」をブラッシュアップ＋§9 のPJ別配分/負荷ヒストリー）。
// store のタスクだけで集計（N+1なし）。完了の推移・PJ別配分・分類別・見積りvs実績。
// B70: 期間切替(14/30/90日・既定14)＋並べ替え(見積vs実績)＋フィルタ(担当/完了含む)。選択は localStorage 永続。
//      集計は期間に追従＝期間内(対象=作成 or 完了が過去N日以内)のタスクだけで再計算する。
import { load, invalidate, projectName } from "../lib/store.js";
import { openTaskForm } from "./taskform.js";
import { dailyThroughput, projectTotals, labelTotals, overallStats } from "../lib/summary.js";
import { estimateVsActual, shiftISO, dateOnly, hasDate } from "../lib/capacity.js";
import { categoryColor } from "../lib/kinds.js";
import { C, esc, fmtH, avatar, todayISO } from "../lib/ui.js";
import { DOW_JA } from "../lib/form.js";

const PERIODS = [14, 30, 90];
const SORTS = [
  { key: "diffAbs", label: "ズレ大きい順" },
  { key: "diffOver", label: "超過大きい順" },
  { key: "diffUnder", label: "短縮大きい順" },
  { key: "actH", label: "実績多い順" },
];
const LS = {
  period: "ts.summary.period",
  sort: "ts.summary.sort",
  who: "ts.summary.who",
  done: "ts.summary.includeDone",
};
const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch { return def; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };

function readPrefs() {
  const period = (() => { const n = +lsGet(LS.period, 14); return PERIODS.includes(n) ? n : 14; })();
  const sort = (() => { const s = lsGet(LS.sort, "diffAbs"); return SORTS.some((o) => o.key === s) ? s : "diffAbs"; })();
  return {
    period,
    sort,
    who: lsGet(LS.who, ""), // ""=全員 / それ以外=メンバーid文字列
    includeDone: lsGet(LS.done, "1") !== "0", // 既定=完了も含む（現状の集計と一致）
  };
}

// 期間内判定: 作成 or 完了 が過去 period 日以内（today を含む末尾 period 日窓）。
// done_at が無い未完了は created で判定＝この窓に入れば対象。
function inPeriod(t, today, period) {
  const start = shiftISO(today, -(period - 1));
  const cr = hasDate(t.created) ? dateOnly(t.created) : "";
  if (cr && cr >= start && cr <= today) return true;
  if (t.done && hasDate(t.done_at)) {
    const d = dateOnly(t.done_at);
    if (d >= start && d <= today) return true;
  }
  return false;
}

function applyFilters(tasks, today, pf) {
  return (tasks || []).filter((t) => {
    if (!pf.includeDone && t.done) return false;
    if (pf.who && !(t.assignees || []).some((a) => String(a.id) === String(pf.who))) return false;
    return inPeriod(t, today, pf.period);
  });
}

function sortEva(rows, key) {
  const arr = rows.slice();
  if (key === "diffOver") arr.sort((a, b) => (b.actH - b.estH) - (a.actH - a.estH));
  else if (key === "diffUnder") arr.sort((a, b) => (a.actH - a.estH) - (b.actH - b.estH));
  else if (key === "actH") arr.sort((a, b) => b.actH - a.actH);
  else arr.sort((a, b) => Math.abs(b.actH - b.estH) - Math.abs(a.actH - a.estH)); // diffAbs
  return arr;
}

export async function render(root) {
  const { tasks, projects, members = [], me, labels = [] } = await load();
  const today = todayISO();
  const pf = readPrefs();
  const scoped = applyFilters(tasks, today, pf);

  const s = overallStats(scoped, today);
  const tp = dailyThroughput(scoped, today, pf.period);
  const pjs = projectTotals(scoped)
    .filter((p) => p.estH > 0 || p.spentH > 0 || p.count > 0)
    .sort((a, b) => (b.estH + b.spentH) - (a.estH + a.spentH)).slice(0, 8);
  const cats = labelTotals(scoped).slice(0, 8);
  const labelById = new Map((labels || []).map((l) => [l.title, l]));
  const eva = sortEva(estimateVsActual(scoped).rows.filter((r) => r.actH > 0), pf.sort).slice(0, 6);

  const accPct = s.accuracy == null ? "—" : Math.round(s.accuracy * 100) + "%";
  const accCls = s.accuracy == null ? "" : (s.accuracy > 1.1 ? "over" : s.accuracy < 0.9 ? "under" : "ok");
  const sortLabel = (SORTS.find((o) => o.key === pf.sort) || SORTS[0]).label;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">概要 <small>${today} 時点 ・ 過去${pf.period}日</small></h1>
    ${toolbar(pf, members, me)}
    <div class="sm-kpis">
      ${kpi("完了（期間内）", `${s.done}`, `件 ・ 今週 ${s.doneThisWeek}`, "free", "#/status")}
      ${kpi("実績 / 見積り", `${fmtH(s.spentH)}`, `/ ${fmtH(s.estH)}`, "", "#/estactual")}
      ${kpi("見積り精度", accPct, "実績÷見積り", accCls, "#/estactual")}
      ${kpi("未完了", `${s.open}`, `件 ・ 期限切れ ${s.overdue}`, s.overdue ? "over" : "", "#/triage")}
    </div>

    <div class="card sm-card">
      <div class="sm-h">完了の推移 <span class="sm-sub">過去${pf.period}日 ・ <i class="lg add"></i>追加 <i class="lg done"></i>完了</span></div>
      ${throughputChart(tp)}
    </div>

    <div class="sm-grid2">
      <div class="card sm-card">
        <div class="sm-h">ワークスペース別の配分 <span class="sm-sub">見積り / 実績</span></div>
        ${pjs.length ? pjBars(pjs, projects) : empty()}
      </div>
      <div class="card sm-card">
        <div class="sm-h">分類別のタスク数</div>
        ${cats.length ? catBars(cats, labelById) : empty()}
      </div>
    </div>

    <div class="card sm-card">
      <div class="sm-h">見積り vs 実績 <span class="sm-sub">${esc(sortLabel)} ・ 実績のあるタスク</span></div>
      ${eva.length ? evaRows(eva) : empty()}
    </div>`;

  // ── ツールバー操作（いずれも localStorage 永続→再描画。集計が追従する） ──
  root.querySelectorAll("#sm-period [data-period]").forEach((b) => {
    b.onclick = () => { lsSet(LS.period, b.dataset.period); render(root); };
  });
  root.querySelectorAll("#sm-who [data-who]").forEach((b) => {
    b.onclick = () => { lsSet(LS.who, b.dataset.who); render(root); };
  });
  const sortSel = root.querySelector("#sm-sort");
  if (sortSel) sortSel.onchange = (e) => { lsSet(LS.sort, e.target.value); render(root); };
  const doneChk = root.querySelector("#sm-done");
  if (doneChk) doneChk.onchange = (e) => { lsSet(LS.done, e.target.checked ? "1" : "0"); render(root); };

  const openRow = (el) => {
    const id = +el.dataset.id;
    if (!id) return;
    openTaskForm({ taskId: id, onSaved: async () => { invalidate(); await render(root); } });
  };
  root.querySelectorAll(".sm-erow[data-id]").forEach((el) => {
    el.addEventListener("click", () => openRow(el));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(el); }
    });
  });
}

// 期間/担当/並べ替え/完了含む のツールバー（quad.js whoTabs の作法を踏襲）。
function toolbar(pf, members, me) {
  const periodBtns = PERIODS.map((n) =>
    `<button class="sm-seg-b${n === pf.period ? " on" : ""}" data-period="${n}">${n}日</button>`).join("");

  const meId = me && me.id;
  const meMember = (members || []).find((m) => m.id === meId);
  const others = (members || []).filter((m) => m.id !== meId);
  // av: avatar() に渡す member（無ければアバター無し＝全員タブ）。色/イニシャルは共有ヘルパに統一。
  const whoBtn = (val, label, av) => {
    const on = String(pf.who) === String(val) ? " on" : "";
    const avHtml = av ? avatar(av, { size: 16 }) : "";
    return `<button class="sm-who-b${on}" data-who="${esc(String(val))}">${avHtml}${esc(label)}</button>`;
  };
  const whoTabs = whoBtn("", "全員", null)
    // 「自分」は表記は固定だが色は本人の member_color、イニシャルは「自」を維持（name=自分）。
    + (meMember ? whoBtn(meMember.id, "自分", { id: meMember.id, name: "自分" }) : "")
    + others.map((m) => whoBtn(m.id, m.name || m.username, m)).join("");

  const sortOpts = SORTS.map((o) =>
    `<option value="${o.key}"${o.key === pf.sort ? " selected" : ""}>${esc(o.label)}</option>`).join("");

  return `
    <div class="sm-tools">
      <div class="sm-seg" id="sm-period" role="group" aria-label="集計期間">${periodBtns}</div>
      <div class="sm-who" id="sm-who">${whoTabs}</div>
      <span class="sm-spacer"></span>
      <label class="sm-done-l"><input type="checkbox" id="sm-done"${pf.includeDone ? " checked" : ""}>完了を含む</label>
      <label class="sm-sort-l">並べ替え <select id="sm-sort">${sortOpts}</select></label>
    </div>`;
}

function kpi(label, big, sub, cls, href) {
  const inner = `<div class="sm-kl">${label}</div>
    <div class="sm-kv">${big}<small>${sub}</small></div>`;
  return href
    ? `<a class="sm-kpi sm-kpi-link ${cls}" href="${href}">${inner}</a>`
    : `<div class="sm-kpi ${cls}">${inner}</div>`;
}

function throughputChart(tp) {
  const max = Math.max(1, ...tp.map((d) => Math.max(d.added, d.done)));
  const H = 84;
  const bars = tp.map((d) => {
    const dt = new Date(d.day + "T00:00:00Z");
    const wd = dt.getUTCDay();
    const ha = Math.round((d.added / max) * H), hd = Math.round((d.done / max) * H);
    const addBar = d.added > 0 ? `<div class="sm-bar add" style="height:${ha}px" title="追加 ${d.added}"></div>` : "";
    const doneBar = d.done > 0 ? `<div class="sm-bar done" style="height:${hd}px" title="完了 ${d.done}"></div>` : "";
    return `<div class="sm-bcol${wd === 0 || wd === 6 ? " wknd" : ""}">
      <div class="sm-bwrap" style="height:${H}px">${addBar}${doneBar}</div>
      <div class="sm-bx">${+d.day.slice(8)}</div>
      <div class="sm-bw">${DOW_JA[wd]}</div>
    </div>`;
  }).join("");
  return `<div class="sm-chart">${bars}</div>`;
}

function pjBars(pjs, projects) {
  const max = Math.max(1, ...pjs.map((p) => Math.max(p.estH, p.spentH)));
  return `<div class="sm-rows">${pjs.map((p) => {
    const name = projectName(projects, p.projectId);
    return `<div class="sm-prow">
      <div class="sm-pname" title="${esc(name)}">${esc(name)} <span class="sm-pmeta">${p.done}/${p.count}件</span></div>
      <div class="sm-pbars">
        <div class="sm-pb"><i class="est" style="width:${(p.estH / max) * 100}%"></i><b>${fmtH(p.estH)}</b></div>
        <div class="sm-pb"><i class="spent" style="width:${(p.spentH / max) * 100}%"></i><b>${fmtH(p.spentH)}</b></div>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function catBars(cats, labelById) {
  const max = Math.max(1, ...cats.map((c) => c.count));
  return `<div class="sm-rows">${cats.map((c) => {
    const col = categoryColor(labelById.get(c.title) || { id: 0 });
    return `<div class="sm-crow">
      <div class="sm-cname">${esc(c.title)}</div>
      <div class="sm-cbar"><i style="width:${(c.count / max) * 100}%;background:${col}"></i></div>
      <div class="sm-cn">${c.count}</div>
    </div>`;
  }).join("")}</div>`;
}

function evaRows(eva) {
  return `<div class="sm-rows">${eva.map((r) => {
    const diff = r.actH - r.estH;
    const cls = diff > 0.05 ? "over" : diff < -0.05 ? "under" : "ok";
    const sign = diff > 0 ? "+" : "";
    return `<div class="sm-erow" data-id="${r.id}" role="button" tabindex="0" title="クリックで編集">
      <div class="sm-etitle" title="${esc(r.title)}">${esc(r.title)}</div>
      <div class="sm-ev">見 ${fmtH(r.estH)} → 実 ${fmtH(r.actH)} <span class="sm-ediff ${cls}">${sign}${fmtH(diff)}</span></div>
    </div>`;
  }).join("")}</div>`;
}

const empty = () => `<div class="sm-empty">データがありません。</div>`;

function css() {
  return `
  .sm-tools{display:flex;align-items:center;gap:12px;margin:0 0 14px;flex-wrap:wrap}
  .sm-spacer{flex:1 1 auto}
  .sm-seg{display:inline-flex;border:1px solid ${C.line};border-radius:9px;overflow:hidden;background:${C.card}}
  .sm-seg-b{font:inherit;font-size:12.5px;padding:6px 13px;border:0;border-left:1px solid ${C.line};background:transparent;color:${C.muted};cursor:pointer;transition:background .12s,color .12s}
  .sm-seg-b:first-child{border-left:0}
  .sm-seg-b:hover{background:${C.track}}
  .sm-seg-b.on{background:${C.fill};color:#fff;font-weight:700}
  .sm-who{display:flex;flex-wrap:wrap;gap:5px}
  .sm-who-b{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12.5px;padding:5px 11px;border:1px solid ${C.line};border-radius:18px;background:${C.card};color:${C.muted};cursor:pointer;transition:border-color .12s,background .12s,color .12s}
  .sm-who-b:hover{border-color:#cfd9e6}
  .sm-who-b.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .sm-who-b.on .ui-ava{box-shadow:0 0 0 1.5px #fff}
  .sm-done-l{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:${C.muted};cursor:pointer}
  .sm-done-l input{cursor:pointer}
  .sm-sort-l{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:${C.muted}}
  .sm-tools select{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid ${C.line};border-radius:7px;background:${C.card};color:${C.ink}}
  .sm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
  .sm-kpi{background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:14px 16px}
  a.sm-kpi-link{display:block;text-decoration:none;color:inherit;transition:border-color .12s,box-shadow .12s,transform .12s}
  a.sm-kpi-link:hover{border-color:${C.fill};box-shadow:0 2px 10px rgba(0,0,0,.06);transform:translateY(-1px)}
  a.sm-kpi-link:focus-visible{outline:2px solid ${C.fill};outline-offset:2px}
  .sm-kl{font-size:11.5px;color:${C.muted};font-weight:600;margin-bottom:6px}
  .sm-kv{font-size:26px;font-weight:800;letter-spacing:-.01em;line-height:1}
  .sm-kv small{font-size:12px;font-weight:600;color:${C.muted};margin-left:6px}
  .sm-kpi.free .sm-kv{color:${C.free}}.sm-kpi.over .sm-kv{color:${C.over}}
  .sm-kpi.under .sm-kv{color:${C.amber}}.sm-kpi.ok .sm-kv{color:${C.free}}
  .sm-card{padding:16px 18px;margin-bottom:14px}
  .sm-h{font-size:13.5px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:10px}
  .sm-sub{font-size:11px;color:${C.muted};font-weight:400;display:inline-flex;align-items:center;gap:5px}
  .sm-h .lg{width:10px;height:10px;border-radius:3px;display:inline-block;margin-left:6px}
  .lg.add{background:${C.fill}}.lg.done{background:${C.free}}
  .sm-chart{display:flex;align-items:flex-end;gap:3px;justify-content:space-between}
  .sm-bcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
  .sm-bcol.wknd .sm-bx,.sm-bcol.wknd .sm-bw{color:#b9c0cb}
  .sm-bwrap{display:flex;align-items:flex-end;justify-content:center;gap:2px;width:100%}
  .sm-bar{width:8px;border-radius:3px 3px 0 0;min-height:2px}
  .sm-bar.add{background:${C.fill}}
  .sm-bar.done{background:${C.free}}
  .sm-bx{font-size:10.5px;color:${C.ink};font-variant-numeric:tabular-nums}
  .sm-bw{font-size:9px;color:${C.muted}}
  .sm-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:760px){.sm-grid2{grid-template-columns:1fr}}
  .sm-rows{display:flex;flex-direction:column;gap:11px}
  .sm-prow{display:grid;grid-template-columns:140px 1fr;gap:10px;align-items:center}
  .sm-pname{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sm-pmeta{font-size:10.5px;color:${C.muted};font-weight:400}
  .sm-pbars{display:flex;flex-direction:column;gap:3px}
  .sm-pb{position:relative;height:15px;background:${C.track};border-radius:5px;overflow:hidden;display:flex;align-items:center}
  .sm-pb i{position:absolute;left:0;top:0;bottom:0;border-radius:5px}
  .sm-pb i.est{background:rgba(58,134,255,.45)}
  .sm-pb i.spent{background:${C.free}}
  .sm-pb b{position:relative;font-size:10px;font-weight:700;color:${C.ink};margin-left:7px;font-variant-numeric:tabular-nums}
  .sm-crow{display:grid;grid-template-columns:90px 1fr 28px;gap:10px;align-items:center}
  .sm-cname{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sm-cbar{height:13px;background:${C.track};border-radius:5px;overflow:hidden}
  .sm-cbar i{display:block;height:100%;border-radius:5px}
  .sm-cn{font-size:12px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;color:${C.muted}}
  .sm-erow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 8px;margin:0 -8px;border-top:1px solid ${C.track};border-radius:8px;cursor:pointer;transition:background .12s}
  .sm-erow:first-child{border-top:0}
  .sm-erow:hover{background:${C.track}}
  .sm-erow:focus-visible{outline:2px solid ${C.fill};outline-offset:-2px}
  .sm-etitle{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .sm-ev{font-size:12px;color:${C.muted};white-space:nowrap;flex:none}
  .sm-ediff{font-weight:700;margin-left:4px}
  .sm-ediff.over{color:${C.over}}.sm-ediff.under{color:${C.amber}}.sm-ediff.ok{color:${C.free}}
  .sm-empty{font-size:12.5px;color:${C.muted};padding:18px 2px;text-align:center}

  /* ── ダーク上書き：css()内のハードコード淡色だけ補正。ライト値は上で維持＝非回帰。
     カード/罫線/track/ink/muted は C.* 経由で var() 参照済＝自動反転するので再指定不要。
     ここで直す対象＝var()を介さず直書きした淡色のみ。アクセント色(青/緑/amber)は据え置き。 */
  html[data-theme="dark"] .sm-bcol.wknd .sm-bx,
  html[data-theme="dark"] .sm-bcol.wknd .sm-bw{color:var(--line-strong)}
  /* B70 ツールバー: 背景は base で var(--card)=C.card 化済＝両テーマ自動反転（旧ダーク上書き不要）。
     select の文字色だけ暗側で muted に寄せる現状を維持（ライト=ink / ダーク=muted）。 */
  html[data-theme="dark"] .sm-tools select{color:var(--muted)}
  html[data-theme="dark"] .sm-who-b:hover{border-color:${C.fill}}`;
}
