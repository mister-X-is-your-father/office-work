// 総合ホーム（実データ）。縦積み: KPI / やること / 今日の稼働予定 / 稼働プラン / 月間ガント。
// 各セクションは折りたたみヘッダ付き。開閉状態は本人ごと localStorage に保存・復元。
import { load, isAiUser } from "../lib/store.js";
import { loadByMember, estimateVsActual, triage } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { statusOf } from "../lib/kinds.js";
import { C, esc, fmtH, todayISO, member_color } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";
import * as today from "./today.js";
import * as workplan from "./workplan.js";
import * as gantt from "./gantt.js";

// 折りたたみ状態の保存キー（本人ごと）。共用ブラウザでも個人別に保持。
const foldKey = (uid) => `ts.home.fold.${uid ?? "anon"}`;
// 既定（未保存時）: 全セクション開。KPI は折りたたみ対象外（常時表示）。
const DEFAULT_FOLD = { todo: false, today: false, plan: false, gantt: false };

// 期限 ISO（未設定/ゼロ日付＝空）。一覧/quad と同じ判定。
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
// today から n 日後の YYYY-MM-DD。
const shiftISO = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// 人間担当（AI担当 fable は担当とみなさない＝未アサイン扱い。table.js の humanAssignees と同義）。
const humanAssignees = (t) => (t.assignees || []).filter((a) => !isAiUser(a));
// 未完了 = done でない（statusOf が "done" 以外）。連絡待ち/進行中は含む。
const isOpen = (t) => statusOf(t) !== "done";

// 「やること」4バケットを tasks から算出。重複を避けるため 1W は「明日〜7日」。
// 先頭=期限超過（due<today の未完了）。今日期限/1W は超過を含まない（===day / >=明日）ので重複なし。
function todoBuckets(tasks, day) {
  const open = (tasks || []).filter(isOpen);
  const tomorrow = shiftISO(day, 1), in7 = shiftISO(day, 7);
  const overdue = open.filter((t) => { const d = dueISO(t); return d && d < day; });
  const unassigned = open.filter((t) => humanAssignees(t).length === 0);
  const dueToday = open.filter((t) => dueISO(t) === day);
  const within1w = open.filter((t) => { const d = dueISO(t); return d && d >= tomorrow && d <= in7; });
  const byDue = (a, b) => (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999") || a.id - b.id;
  return [
    { id: "overdue",    title: "期限超過",   ic: "alarm",        link: "#/list", danger: true, items: overdue.sort(byDue) },
    { id: "unassigned", title: "未アサイン", ic: "user",         link: "#/list", items: unassigned.sort(byDue) },
    { id: "today",      title: "今日期限",   ic: "alarm",        link: "#/list", items: dueToday.sort(byDue) },
    { id: "next7",      title: "1週間以内（明日〜7日）", ic: "calendarDays", link: "#/list", items: within1w.sort(byDue) },
  ];
}

const MAX_ROWS = 6; // 各バケットで先頭表示する件数。超過分は「他N件」リンク。

// 1タスク行（タイトル＋軽いメタ: 担当アバター/期限/プロジェクト名）。
function todoRow(t, projects, day) {
  const who = humanAssignees(t)[0] || null;
  const wn = who ? (who.name || who.username) : "";
  const due = dueISO(t);
  const late = due && due < day;
  return `<button type="button" class="td-row" data-id="${t.id}">
    <span class="td-row-t">${esc(t.title)}</span>
    <span class="td-row-m">
      ${who ? `<span class="td-ava" style="background:${member_color(who.id)}" title="${esc(wn)}">${esc((wn[0] || "?").toUpperCase())}</span>` : ""}
      ${due ? `<span class="td-due${late ? " late" : ""}">${due.slice(5).replace("-", "/")}${late ? " 超過" : ""}</span>` : ""}
    </span>
  </button>`;
}

// 1バケット（見出し「未アサイン (N)」＋行リスト＋他N件リンク）。0件は薄く「なし」。
// danger=true（期限超過）は赤系の枠/見出し/件数バッジで強調。
function bucketHtml(b, projects, day) {
  const n = b.items.length;
  const cls = `td-bk${b.danger ? " td-bk-danger" : ""}`;
  const head = `<div class="td-bk-h">${icon(b.ic, { size: 14 }) || ""}<span>${esc(b.title)}</span><span class="td-bk-n">${n}</span></div>`;
  if (n === 0) return `<div class="${cls}"><div>${head}</div><div class="td-empty">なし</div></div>`;
  const shown = b.items.slice(0, MAX_ROWS);
  const rest = n - shown.length;
  const more = rest > 0
    ? `<a class="td-more" href="${b.link}">他${rest}件 → タスク一覧 ${icon("chevronRight", { size: 12 }) || "›"}</a>` : "";
  return `<div class="${cls}">${head}
    <div class="td-rows">${shown.map((t) => todoRow(t, projects, day)).join("")}</div>${more}</div>`;
}

function readFold(uid) {
  try {
    const raw = JSON.parse(localStorage.getItem(foldKey(uid)) || "{}") || {};
    return { ...DEFAULT_FOLD, ...raw };
  } catch { return { ...DEFAULT_FOLD }; }
}
function writeFold(uid, fold) {
  try { localStorage.setItem(foldKey(uid), JSON.stringify(fold)); } catch { /* localStorage 不可でも続行 */ }
}

export async function render(root) {
  const { tasks, projects, members, plansByTask, holidaysSet, unavailabilityByMember, settings, me } = await load();
  const day = todayISO();
  // 営業日割り＋人別容量（週末/祝日/休暇=0）で今日KPIを正確に（§土日祝ギャップ）
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH });
  const rows = loadByMember(tasks, members, day, settings.capH, plansByTask, { holidays: holidaysSet, capacityFor });
  const ev = estimateVsActual(tasks);
  const tri = triage(tasks, day);

  const totCap = rows.reduce((s, r) => s + r.capH, 0), totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const over = rows.filter(r => r.status === "over");
  const must = tri.filter(t => t.cls === "must");
  // 過負荷者の名前（KPI過負荷カードの title=ツールチップ用）。0名なら空。
  const overNames = over.map(r => r.name).filter(Boolean).join("、");
  const overTitle = over.length ? `過負荷: ${esc(overNames)}（→ 今日の稼働予定）` : "今日の稼働予定へ";

  // 折りたたみ状態（本人ごと localStorage）。uid は load() の me から（往復削減）。未取得時は anon キーへ。
  const uid = me?.id ?? null;
  const fold = readFold(uid);

  // 折りたたみ可能なセクション。id は fold 状態のキー、loader は中身を描く非同期関数。
  const section = (id, title) => {
    const open = !fold[id];
    return `
      <section class="home-sec card" data-sec="${id}">
        <button type="button" class="home-sec-head" data-toggle="${id}" aria-expanded="${open}">
          <span class="home-chevron">${icon(open ? "chevronDown" : "chevronRight", { size: 20 }) || (open ? "▾" : "▸")}</span>
          <span class="home-sec-title">${title}</span>
        </button>
        <div class="home-sec-body" data-body="${id}" ${open ? "" : "hidden"}></div>
      </section>`;
  };

  root.innerHTML = `
    <h1 class="vtitle">ホーム <small>${day}</small></h1>
    <div class="kpis">
      <a class="kpi" href="#/today" title="今日の稼働予定へ"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></a>
      <a class="kpi free" href="#/workplan" title="稼働プランへ"><div class="l">空き工数</div><div class="v">${fmtH(Math.max(0, totCap - totAsg))}</div></a>
      <a class="kpi ${over.length ? "over" : ""}" href="#/today" title="${overTitle}"><div class="l">過負荷</div><div class="v">${over.length}<small>名</small></div></a>
      <a class="kpi" href="#/triage" title="トリアージへ"><div class="l">今日必須</div><div class="v">${must.length}<small>件</small></div></a>
    </div>
    <div class="home-stack">
      ${section("todo", "やること")}
      ${section("today", "今日の稼働予定")}
      ${section("plan", "稼働プラン（1ヶ月）")}
      ${section("gantt", "月間ガント（人別レーン）")}
    </div>
    <style>
      /* KPIカードをリンク化: anchor 既定（色/下線）を打ち消し、見た目は div 時代と同一＋hover で押せると分かる。 */
      a.kpi{color:inherit;text-decoration:none;display:block;cursor:pointer;transition:box-shadow .12s,border-color .12s,transform .12s}
      a.kpi:hover{border-color:${C.fill};box-shadow:0 2px 8px rgba(20,30,50,.12);transform:translateY(-1px)}
      a.kpi:focus-visible{outline:2px solid ${C.fill};outline-offset:2px}
      .home-stack{display:flex;flex-direction:column;gap:16px}
      .home-sec{padding:0;overflow:hidden}
      .home-sec-head{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;
        padding:12px 16px;border:0;background:transparent;color:${C.ink};font:inherit;font-weight:700;font-size:13px;
        text-align:left;cursor:pointer;border-bottom:1px solid ${C.line}}
      .home-sec-head:hover{background:${C.track}}
      .home-sec-head[aria-expanded="false"]{border-bottom:0}
      .home-chevron{display:inline-flex;align-items:center;color:${C.muted};line-height:0}
      .home-sec-title{flex:1;min-width:0}
      .home-sec-body{padding:12px 16px}
      .home-sec-body[hidden]{display:none}
      /* やること: 4バケットを横並び（中幅2列・狭幅で縦積み）。可変高・トークン配色でテーマ追従。 */
      .td-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
      @media(max-width:980px){.td-grid{grid-template-columns:repeat(2,1fr)}}
      @media(max-width:560px){.td-grid{grid-template-columns:1fr}}
      .td-bk{border:1px solid ${C.line};border-radius:10px;padding:10px 12px;background:${C.bg};display:flex;flex-direction:column;min-width:0}
      .td-bk-h{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:${C.ink};margin-bottom:8px}
      .td-bk-h .ic{color:${C.muted}}
      .td-bk-n{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;padding:1px 8px}
      /* 期限超過バケット: 赤系で強調（枠/見出し/件数バッジ）。0件時は薄い「なし」のまま。 */
      .td-bk-danger{border-color:${C.over}}
      .td-bk-danger .td-bk-h{color:${C.over}}
      .td-bk-danger .td-bk-h .ic{color:${C.over}}
      .td-bk-danger .td-bk-n{color:#fff;background:${C.over}}
      .td-empty{font-size:12px;color:${C.muted};padding:6px 2px}
      .td-rows{display:flex;flex-direction:column;gap:4px}
      .td-row{display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;text-align:left;
        border:0;background:transparent;color:${C.ink};font:inherit;cursor:pointer;border-radius:7px;padding:6px 8px}
      .td-row:hover{background:${C.track}}
      .td-row-t{font-size:12.5px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .td-row-m{display:flex;align-items:center;gap:7px;font-size:11px;color:${C.muted};min-width:0}
      .td-ava{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#fff;font-size:9px;font-weight:700;flex:none}
      .td-due.late{color:${C.over};font-weight:700}
      .td-more{display:inline-flex;align-items:center;gap:3px;margin-top:6px;font-size:11.5px;font-weight:600;color:${C.fill};text-decoration:none}
      .td-more:hover{text-decoration:underline}
    </style>`;

  // 各埋め込みは load() の共有キャッシュ経由（二重 fetch なし）。
  // 開いているセクションのみ描画。teardown を保持し、再描画/折りたたみ時に解除。
  const teardowns = new Map();   // sec id -> teardown fn（gantt のみ）

  async function fill(id) {
    const body = root.querySelector(`[data-body="${id}"]`);
    if (!body || body.hidden || body.dataset.filled === "1") return;
    body.dataset.filled = "1";
    if (id === "todo") {
      // 「やること」3バケット。データは load() の tasks から算出（追加 fetch なし）。
      const buckets = todoBuckets(tasks, day);
      body.innerHTML = `<div class="td-grid">${buckets.map((b) => bucketHtml(b, projects, day)).join("")}</div>`;
      // 行クリック=編集モーダル。保存後はホーム全体を再描画（バケット件数を最新化）。
      body.querySelectorAll(".td-row[data-id]").forEach((el) => {
        el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
      });
    } else if (id === "today") {
      // fluid: ホーム埋め込みは固定高(px箱)をやめ可変高に（コンテナ幅に追従）。
      await today.renderInto(body, { compact: true, showToggle: false, mode: "stacked", title: false, fluid: true });
    } else if (id === "plan") {
      await workplan.renderInto(body, { preset: "1m", who: "all", fluid: true });
    } else if (id === "gantt") {
      // ガントは teardown を返す。折りたたみ/再描画で確実に解除（リスナー漏れ防止）。
      const td = await gantt.renderInto(body, { months: 1, mode: "member", fluid: true, editable: true });
      if (typeof td === "function") teardowns.set(id, td);
    }
  }

  // 折りたたみ開閉。開いたら（未描画なら）遅延描画、閉じたら中身を破棄して軽量化。
  root.querySelectorAll(".home-sec-head[data-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.toggle;
      const body = root.querySelector(`[data-body="${id}"]`);
      const open = body.hidden;            // 現在 hidden→これから開く
      fold[id] = !open;                    // fold=折りたたみ中か。open のとき false
      writeFold(uid, fold);
      btn.setAttribute("aria-expanded", String(open));
      const chev = btn.querySelector(".home-chevron");
      if (chev) chev.innerHTML = icon(open ? "chevronDown" : "chevronRight", { size: 20 }) || (open ? "▾" : "▸");
      if (open) {
        body.hidden = false;
        fill(id);                          // 初回 or 破棄後の再描画
      } else {
        const td = teardowns.get(id);
        if (td) { try { td(); } catch {} teardowns.delete(id); }
        body.hidden = true;
        body.innerHTML = "";
        body.dataset.filled = "";
      }
    };
  });

  // 初期表示: 開いているセクションを順に描画（gantt は最後）。
  await fill("todo");
  await fill("today");
  await fill("plan");
  await fill("gantt");
}
