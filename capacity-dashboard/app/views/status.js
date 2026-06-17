// ステータス（共有・閲覧向けの一枚ダッシュボード）。
// URL を渡せば誰でもチームの現況を把握できる、中立的な状況サマリー。
// 状況把握に効く順で 1 枚に集約: KPI / 遅延 / 今日のメンバー状況 / 今週の締切 / 直近の完了。
// データは load() の共有キャッシュから算出（追加 fetch なし）。ロジックは home/report/capacity から再利用。
import { load, isAiUser } from "../lib/store.js";
import { loadByMember, triage } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { statusOf } from "../lib/kinds.js";
import { C, esc, fmtH, todayISO, member_color } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { openTaskForm } from "./taskform.js";

// today から n 日後の YYYY-MM-DD（home/report と同じ式）。
const shiftISO = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (iso) => new Date(iso + "T00:00:00Z").getUTCDay();
// 今週末（今日を含む週の終端）。report.js の weekEndISO と同じ計算で整合。
// weekStart 指定時はその開始曜日の 6 日後が週末、未指定時は日曜(0)終わり。
function weekEndISO(day, weekStart) {
  const endDow = Number.isInteger(weekStart) ? (weekStart + 6) % 7 : 0;
  const add = (endDow - dowOf(day) + 7) % 7;
  return shiftISO(day, add);
}
// 期限 ISO（未設定/ゼロ日付＝空）。home.js dueISO と同義。
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
// 完了日 ISO（done_at、ゼロ日付/未設定は null）。report.js と同義。
const doneAtISO = (t) => (t.done_at && !t.done_at.startsWith("0001") ? t.done_at.slice(0, 10) : null);
// 人間担当（AI担当 fable は担当とみなさない＝未アサイン扱い）。home.js humanAssignees と同義。
const humanAssignees = (t) => (t.assignees || []).filter((a) => !isAiUser(a));
// 未完了 = done でない（連絡待ち/進行中は含む）。home.js isOpen と同義。
const isOpen = (t) => statusOf(t) !== "done";
// 期限昇順→ID（home.js byDue と同義）。
const byDue = (a, b) => (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999") || a.id - b.id;
const mdOf = (iso) => { const [, m, d] = iso.split("-"); return `${+m}/${+d}`; };
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

const MAX_ROWS = 8; // 各リストの先頭表示件数。超過分は「他N件」。

// 担当アバター（home.js td-ava と同じ意匠）。
function avatar(who) {
  if (!who) return "";
  const wn = who.name || who.username || "";
  return `<span class="st-ava" style="background:${member_color(who.id)}" title="${esc(wn)}">${esc((wn[0] || "?").toUpperCase())}</span>`;
}

// 1タスク行（クリックで編集モーダル）。meta はビュー側が右側に添える HTML。
function taskRow(t, meta) {
  const who = humanAssignees(t)[0] || null;
  return `<button type="button" class="st-row" data-id="${t.id}">
    <span class="st-row-t">${esc(t.title)}</span>
    <span class="st-row-m">${avatar(who)}${meta || ""}</span>
  </button>`;
}

// 「他N件」表示（リストが MAX_ROWS を超えたとき）。
function moreLine(total, shown) {
  const rest = total - shown;
  return rest > 0 ? `<div class="st-more">他 ${rest} 件</div>` : "";
}

const empty = (msg) => `<div class="st-empty">${esc(msg)}</div>`;

export async function render(root) {
  const { tasks, members, plansByTask, holidaysSet, unavailabilityByMember, settings } = await load();
  const day = todayISO();
  const weekStart = settings && Number.isInteger(settings.weekStart) ? settings.weekStart : null;
  const weekEnd = weekEndISO(day, weekStart);

  // 今日の人別負荷（営業日割り＋人別容量＝週末/祝日/休暇=0）。home.js と同じ計算。
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH });
  const rows = loadByMember(tasks, members, day, settings.capH, plansByTask, { holidays: holidaysSet, capacityFor });
  const tri = triage(tasks, day);

  // ── 集計 ──
  const totCap = rows.reduce((s, r) => s + r.capH, 0);
  const totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const over = rows.filter((r) => r.status === "over");
  const must = tri.filter((t) => t.cls === "must");

  // 遅延（期限超過）: 未完了 かつ 期限 < 今日。期限の古い順（超過日数の大きい順）。
  const open = (tasks || []).filter(isOpen);
  const late = open.filter((t) => { const d = dueISO(t); return d && d < day; })
    .sort((a, b) => (dueISO(a)).localeCompare(dueISO(b)) || a.id - b.id);
  const overdueDays = (t) => Math.round((Date.parse(day) - Date.parse(dueISO(t))) / 86400000);

  // 今週の締切: 未完了 かつ 今日 <= 期限 <= 今週末（report の today+week 相当）。日付順。
  const thisWeek = open.filter((t) => { const d = dueISO(t); return d && d >= day && d <= weekEnd; }).sort(byDue);

  // 直近の完了: 過去 7 日（今日含む）に done 化したもの。done_at 新しい順、不明は末尾。
  const weekStartISO = shiftISO(day, -6);
  const recentDone = (tasks || [])
    .filter((t) => statusOf(t) === "done")
    .filter((t) => { const d = doneAtISO(t); return d == null || d >= weekStartISO; })
    .sort((a, b) => (doneAtISO(b) || "").localeCompare(doneAtISO(a) || "") || b.id - a.id);

  // メンバー: 今日の負荷が多い順→空きが少ない順。AI 担当は members に含まれない（store で除外済み）。
  const memberRows = [...rows].sort((a, b) => b.assignedH - a.assignedH || a.name.localeCompare(b.name));

  // ── 各セクション HTML ──
  const lateSection = late.length === 0
    ? empty("遅延なし")
    : `<div class="st-rows">${late.slice(0, MAX_ROWS).map((t) => {
        const n = overdueDays(t);
        const meta = `<span class="st-late">${mdOf(dueISO(t))}・${n}日超過</span>`;
        return taskRow(t, meta);
      }).join("")}</div>${moreLine(late.length, Math.min(MAX_ROWS, late.length))}`;

  const memberSection = memberRows.length === 0
    ? empty("メンバーがいません")
    : `<div class="st-mgrid">${memberRows.map((r) => {
        const pct = r.capH > 0 ? Math.min(100, Math.round((r.assignedH / r.capH) * 100)) : (r.assignedH > 0 ? 100 : 0);
        const stCls = r.status === "over" ? "over" : (r.status === "off" ? "off" : (r.status === "full" ? "full" : "free"));
        const stLbl = r.status === "over" ? "過負荷" : (r.status === "off" ? "休み" : (r.status === "full" ? "ちょうど" : (r.assignedH > 1e-6 ? "稼働中" : "空き")));
        return `<div class="st-mcard">
          <div class="st-mtop">
            <span class="st-ava" style="background:${member_color(r.id)}" title="${esc(r.name)}">${esc((r.name[0] || "?").toUpperCase())}</span>
            <span class="st-mname" title="${esc(r.name)}">${esc(r.name)}</span>
            <span class="st-badge ${stCls}">${stLbl}</span>
          </div>
          <div class="st-mbar"><i class="${stCls}" style="width:${pct}%"></i></div>
          <div class="st-mmeta">${fmtH(r.assignedH)} <small>/ ${fmtH(r.capH)}</small></div>
        </div>`;
      }).join("")}</div>`;

  const weekSection = thisWeek.length === 0
    ? empty("今週の締切なし")
    : `<div class="st-rows">${thisWeek.slice(0, MAX_ROWS).map((t) => {
        const d = dueISO(t);
        const meta = `<span class="st-due${d === day ? " today" : ""}">${mdOf(d)}（${DOW[dowOf(d)]}）</span>`;
        return taskRow(t, meta);
      }).join("")}</div>${moreLine(thisWeek.length, Math.min(MAX_ROWS, thisWeek.length))}`;

  const doneSection = recentDone.length === 0
    ? empty("直近の完了なし")
    : `<div class="st-rows">${recentDone.slice(0, MAX_ROWS).map((t) => {
        const d = doneAtISO(t);
        const meta = d ? `<span class="st-doneat">${mdOf(d)} 完了</span>` : "";
        return taskRow(t, meta);
      }).join("")}</div>${moreLine(recentDone.length, Math.min(MAX_ROWS, recentDone.length))}`;

  // 各セクションの見出し（アイコン＋件数バッジ）。
  const head = (ic, title, n, accent) =>
    `<div class="st-h${accent ? " " + accent : ""}">${icon(ic, { size: 16 }) || ""}<span>${esc(title)}</span>${n != null ? `<span class="st-hn">${n}</span>` : ""}</div>`;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">ステータス <small>${day} 時点</small></h1>
    <div class="st-kpis">
      <div class="st-kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></div>
      <div class="st-kpi free"><div class="l">空き工数</div><div class="v">${fmtH(Math.max(0, totCap - totAsg))}</div></div>
      <div class="st-kpi ${over.length ? "over" : ""}"><div class="l">過負荷</div><div class="v">${over.length}<small>名</small></div></div>
      <div class="st-kpi"><div class="l">今日必須</div><div class="v">${must.length}<small>件</small></div></div>
      <div class="st-kpi ${late.length ? "over" : ""}"><div class="l">遅延</div><div class="v">${late.length}<small>件</small></div></div>
    </div>

    <div class="card st-card st-late-card">
      ${head("alertTriangle", "遅延（期限超過）", late.length, "danger")}
      ${lateSection}
    </div>

    <div class="card st-card">
      ${head("user", "今日の各メンバー状況", null)}
      ${memberSection}
    </div>

    <div class="st-grid2">
      <div class="card st-card">
        ${head("calendarDays", "今週の予定/締切", thisWeek.length)}
        ${weekSection}
      </div>
      <div class="card st-card">
        ${head("check", "直近の完了", recentDone.length)}
        ${doneSection}
      </div>
    </div>`;

  // 行クリック=編集モーダル。保存後はステータス全体を再描画（件数を最新化）。
  root.querySelectorAll(".st-row[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
  });
}

function css() {
  return `
  .st-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
  .st-kpi{background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:14px 16px}
  .st-kpi .l{font-size:11.5px;color:${C.muted};font-weight:600;margin-bottom:6px}
  .st-kpi .v{font-size:26px;font-weight:800;letter-spacing:-.01em;line-height:1}
  .st-kpi .v small{font-size:12px;font-weight:600;color:${C.muted};margin-left:5px}
  .st-kpi.free .v{color:${C.free}}
  .st-kpi.over .v{color:${C.over}}

  .st-card{padding:14px 18px;margin-bottom:14px}
  .st-late-card{border-left:3px solid ${C.over}}
  .st-h{font-size:13.5px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px;color:${C.ink}}
  .st-h .ic{color:${C.muted}}
  .st-h.danger .ic{color:${C.over}}
  .st-hn{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;padding:1px 9px}
  .st-empty{font-size:12.5px;color:${C.muted};padding:8px 2px}

  .st-rows{display:flex;flex-direction:column;gap:3px}
  .st-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;
    text-align:left;border:0;background:transparent;color:${C.ink};font:inherit;cursor:pointer;border-radius:8px;padding:7px 9px}
  .st-row:hover{background:${C.track}}
  .st-row-t{font-size:13px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .st-row-m{display:flex;align-items:center;gap:8px;font-size:11.5px;color:${C.muted};flex:none}
  .st-ava{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:#fff;font-size:9.5px;font-weight:700;flex:none}
  .st-late{color:${C.over};font-weight:700;font-variant-numeric:tabular-nums}
  .st-due{font-variant-numeric:tabular-nums}
  .st-due.today{color:${C.over};font-weight:700}
  .st-doneat{color:${C.free};font-weight:600;font-variant-numeric:tabular-nums}
  .st-more{font-size:11.5px;color:${C.muted};padding:6px 9px 2px}

  /* 今日の各メンバー状況: カードを並べる（可変幅・狭幅で 1 列）。 */
  .st-mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
  .st-mcard{border:1px solid ${C.line};border-radius:10px;padding:10px 12px;background:${C.bg};display:flex;flex-direction:column;gap:7px;min-width:0}
  .st-mtop{display:flex;align-items:center;gap:8px;min-width:0}
  .st-mname{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .st-badge{font-size:10px;font-weight:700;border-radius:999px;padding:1px 8px;flex:none}
  .st-badge.over{color:#fff;background:${C.over}}
  .st-badge.full{color:#fff;background:${C.full}}
  .st-badge.free{color:${C.free};background:transparent;border:1px solid ${C.free}}
  .st-badge.off{color:${C.muted};background:${C.track}}
  .st-mbar{position:relative;height:8px;background:${C.track};border-radius:5px;overflow:hidden}
  .st-mbar i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:${C.fill}}
  .st-mbar i.over{background:${C.over}}
  .st-mbar i.full{background:${C.full}}
  .st-mbar i.free{background:${C.free}}
  .st-mbar i.off{background:${C.muted};opacity:.4}
  .st-mmeta{font-size:12px;font-weight:700;color:${C.ink};font-variant-numeric:tabular-nums}
  .st-mmeta small{font-size:11px;font-weight:600;color:${C.muted}}

  .st-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:820px){.st-grid2{grid-template-columns:1fr}}`;
}
