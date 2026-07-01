// 総合ホーム（実データ）。縦積み: KPI / やること / 今日の稼働予定 / 稼働プラン / 月間ガント。
// 各セクションは折りたたみヘッダ付き。開閉状態は本人ごと localStorage に保存・復元。
import { load } from "../lib/store.js";
import { loadByMember, estimateVsActual, triage, weekLoadByMember, dateOnly, shiftISO, dowOf } from "../lib/capacity.js";
import { humanAssignees, firstHuman } from "../lib/users.js";
import { capacityOn } from "../lib/recurrence.js";
import { statusOf } from "../lib/kinds.js";
import { C, esc, fmtH, todayISO, member_color } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";
import { getPrepScores, getPrep, savePrep, getActivity } from "../lib/exec.js";
import { setTaskStarted, getTimes } from "../lib/api.js";
import { stepDigestion, taskEngagement, stalledTasks } from "../lib/execmetrics.js";
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

// 着手準備バッジ（実行可能性メーター）。score 有り→「準備 N%」＋達成度で色分け、
// score 無し/0→「準備する」プロンプト（未準備＝目立たせて着手準備タブへ誘導）。
// .td-row は <button> なのでネスト不可: <span role="button"> として行クリックと分離する。
function prepBadge(t, scores, urgent) {
  const raw = scores ? scores[t.id] : undefined;
  const has = Number.isFinite(raw) && raw > 0;
  const n = has ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
  // 低=注意(over) / 中=進行(amber) / 高=好調(free)。未準備は控えめ→ただし urgent(超過/今日)は注意色で促す。
  const lvl = !has ? (urgent ? "urgent" : "none") : n < 40 ? "low" : n < 80 ? "mid" : "high";
  const label = has ? `準備 ${n}%` : "準備する";
  const title = has ? `着手準備 ${n}% — クリックで準備タブへ` : "未準備 — クリックで着手準備タブへ";
  return `<span class="td-prep td-prep-${lvl}" role="button" tabindex="0" data-prep="${t.id}" title="${esc(title)}" aria-label="${esc(title)}">
      ${has ? `<span class="td-prep-bar"><span class="td-prep-fill" style="width:${n}%"></span></span>` : `${icon("alarm", { size: 11 }) || ""}`}
      <span class="td-prep-t">${esc(label)}</span>
    </span>`;
}

// 1タスク行（タイトル＋軽いメタ: 担当アバター/期限/プロジェクト名＋準備メーター）。
function todoRow(t, projects, day, scores) {
  const who = firstHuman(t);
  const wn = who ? (who.name || who.username) : "";
  const due = dueISO(t);
  const late = due && due < day;
  const urgent = !!late || due === day; // 超過/今日期限は未準備を強めに促す
  return `<button type="button" class="td-row" data-id="${t.id}">
    <span class="td-row-t">${esc(t.title)}</span>
    <span class="td-row-m">
      ${who ? `<span class="td-ava" style="background:${member_color(who.id)}" title="${esc(wn)}">${esc((wn[0] || "?").toUpperCase())}</span>` : ""}
      ${due ? `<span class="td-due${late ? " late" : ""}">${due.slice(5).replace("-", "/")}${late ? " 超過" : ""}</span>` : ""}
      ${prepBadge(t, scores, urgent)}
    </span>
  </button>`;
}

// 1バケット（見出し「未アサイン (N)」＋行リスト＋他N件リンク）。0件は薄く「なし」。
// danger=true（期限超過）は赤系の枠/見出し/件数バッジで強調。
function bucketHtml(b, projects, day, scores) {
  const n = b.items.length;
  const cls = `td-bk${b.danger ? " td-bk-danger" : ""}`;
  const head = `<div class="td-bk-h">${icon(b.ic, { size: 14 }) || ""}<span>${esc(b.title)}</span><span class="td-bk-n">${n}</span></div>`;
  if (n === 0) return `<div class="${cls}"><div>${head}</div><div class="td-empty">なし</div></div>`;
  const shown = b.items.slice(0, MAX_ROWS);
  const rest = n - shown.length;
  const more = rest > 0
    ? `<a class="td-more" href="${b.link}">他${rest}件 → タスク一覧 ${icon("chevronRight", { size: 12 }) || "›"}</a>` : "";
  return `<div class="${cls}">${head}
    <div class="td-rows">${shown.map((t) => todoRow(t, projects, day, scores)).join("")}</div>${more}</div>`;
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
  // 着手準備スコア（実行可能性メーター）を一括取得。exec 停止時は空で続行＝ホームは壊さない。
  // 戻り値 {scores:{ "<taskId>": number }}。未準備タスクは欠落＝0扱い。
  let prepScores = {};
  let stepsByTask = {};
  try {
    const pr = await getPrepScores();
    prepScores = pr?.scores || {};
    stepsByTask = pr?.steps_by_task || {};
  } catch { prepScores = {}; stepsByTask = {}; }
  // 営業日割り＋人別容量（週末/祝日/休暇=0）で今日KPIを正確に（§土日祝ギャップ）
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH });
  const rows = loadByMember(tasks, members, day, settings.capH, plansByTask, { holidays: holidaysSet, capacityFor });
  const ev = estimateVsActual(tasks);
  const tri = triage(tasks, day);

  // F4 キャパ予算: 自分の「今週（今日〜週末）」の稼働容量合計 − 既コミット負荷 = 残高。
  // 容量は capacityFor（週末/祝日/休暇=0）の合計、負荷は weekLoadByMember の weekH。
  const endDow = Number.isInteger(settings.weekStart) ? (settings.weekStart + 6) % 7 : 0; // 既定=日曜終わり
  const addToEnd = (endDow - dowOf(day) + 7) % 7;
  const weekDays = []; for (let i = 0; i <= addToEnd; i++) weekDays.push(shiftISO(day, i));
  const meMember = members.find((m) => m.id === (me && me.id)) || (me ? { id: me.id, name: me.name || me.username } : null);
  let budget = null;
  if (meMember) {
    const capSum = weekDays.reduce((s, d) => s + capacityFor(meMember, d), 0);
    const wl = weekLoadByMember(tasks, [meMember], weekDays, settings.capH, plansByTask, { holidays: holidaysSet });
    const committed = (wl[0] && wl[0].weekH) || 0;
    const remaining = Math.max(0, capSum - committed);
    const over = Math.max(0, committed - capSum);
    const pct = capSum > 0 ? Math.min(100, Math.round((committed / capSum) * 100)) : (committed > 0 ? 100 : 0);
    budget = { capSum, committed, remaining, over, pct };
  }

  // E4: 着手準備の段取りで「期日が今日以前（=今日＋期日超過）」の手順を MIT として集約。
  // 未完了タスク・未完了手順のみ。遅れ（期日超過）は赤バッジで督促し、古い順に先頭へ。
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  const daysBetween = (fromISO, toISO) => Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86400000);
  const mitItems = [];
  for (const [tidStr, steps] of Object.entries(stepsByTask)) {
    const t = taskById.get(+tidStr);
    if (!t || !isOpen(t)) continue;
    for (const s of steps || []) {
      if (s && s.due && s.due <= day && !s.done && (s.title || "").trim()) {
        const lateDays = s.due < day ? daysBetween(s.due, day) : 0;
        mitItems.push({ taskId: t.id, taskTitle: t.title, stepTitle: s.title, idx: s.idx, due: s.due, lateDays });
      }
    }
  }
  // 遅れ（期日が古い順）を先頭に、同日内は安定
  mitItems.sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  const mitHtml = mitItems.length ? `
    <section class="mit card">
      <div class="mit-h">${icon("play", { size: 15 }) || "▶"}<span>今日やる1手</span><span class="mit-n">${mitItems.length}</span></div>
      <div class="mit-rows">
        ${mitItems.map((it) => `
          <div class="mit-row${it.lateDays > 0 ? " late" : ""}" data-task="${it.taskId}" data-idx="${it.idx}">
            <input type="checkbox" class="mit-check" aria-label="この手順を完了にする" title="完了にする">
            <button type="button" class="mit-open" data-prep="${it.taskId}">
              <span class="mit-step">${esc(it.stepTitle)}</span>
              <span class="mit-task">${esc(it.taskTitle)}</span>
            </button>
            ${it.lateDays > 0 ? `<span class="mit-late" title="期日を${it.lateDays}日超過">遅れ${it.lateDays}日</span>` : ""}
            <button type="button" class="mit-start" data-start="${it.taskId}" title="着手（進行中にしてポモ開始）">${icon("play", { size: 13 }) || "▶"} 着手</button>
          </div>`).join("")}
      </div>
    </section>` : "";

  // F4 キャパ予算バンド: capSum>0（自分が今週に容量を持つ）ときだけ描画。残りわずか/超過は色で警告。
  const budgetHtml = (budget && budget.capSum > 0) ? (() => {
    const b = budget;
    const state = b.over > 0 ? { cls: "over", label: `超過 +${fmtH(b.over)}` }
      : (b.remaining <= b.capSum * 0.15 ? { cls: "tight", label: "残りわずか" }
      : { cls: "ok", label: "計画的に進められます" });
    return `
      <section class="cb card cb-${state.cls}">
        <div class="cb-h">${icon("calendarDays", { size: 15 }) || ""}<span>今週のキャパ予算</span><span class="cb-state ${state.cls}">${esc(state.label)}</span></div>
        <div class="cb-bar"><i class="${state.cls}" style="width:${b.pct}%"></i></div>
        <div class="cb-meta">残り <b>${fmtH(b.remaining)}</b> ／ 今週 ${fmtH(b.capSum)}<small>（コミット ${fmtH(b.committed)}）</small></div>
      </section>`;
  })() : "";

  // 今日の実行 mini: 手順消化率 / タスク着手率 / 停滞件数（ふりかえりと同じ純関数）。
  // 実績(getTimes N+1)＋進捗ログ(getActivity)は失敗時 空で続行＝ホームを壊さない。
  let execActivityLog = [];
  try { execActivityLog = (await getActivity())?.activity || []; } catch { execActivityLog = []; }
  let execTimeEntries = [];
  try {
    const tt = (tasks || []).filter((t) => (t.time_spent || 0) > 0);
    const pairs = await Promise.all(tt.map((t) => getTimes(t.id).then((es) => [t.id, es || []]).catch(() => [t.id, []])));
    for (const [tid, es] of pairs) for (const e of es) if (e && e.logged_on) execTimeEntries.push({ day: dateOnly(e.logged_on), seconds: e.seconds || 0, taskId: tid });
  } catch { execTimeEntries = []; }
  const exStep = stepDigestion(stepsByTask, day);
  const exEng = taskEngagement(tasks, plansByTask, day);
  const exStalled = stalledTasks(tasks, execTimeEntries, execActivityLog, day, { thresholdDays: 7 });

  // 達成度の色クラス（率が低いほど注意）。対象0は "—"。
  const exLvl = (pct, den) => (den <= 0 ? "na" : pct < 40 ? "low" : pct < 80 ? "mid" : "high");
  const exMiniHtml = `
    <button type="button" class="exmini card" id="exmini" title="ふりかえりを開く">
      <span class="exmini-h">${icon("trendingUp", { size: 15 }) || ""}<span>今日の実行</span></span>
      <span class="exmini-stats">
        <span class="exmini-st ex-${exLvl(exStep.pct, exStep.total)}">手順 <b>${exStep.total ? exStep.pct + "%" : "—"}</b></span>
        <span class="exmini-st ex-${exLvl(exEng.pct, exEng.target)}">着手 <b>${exEng.target ? exEng.pct + "%" : "—"}</b></span>
        <span class="exmini-st${exStalled.length ? " ex-stale" : ""}">停滞 <b>${exStalled.length}</b>件</span>
      </span>
      <span class="exmini-go">ふりかえり ${icon("chevronRight", { size: 14 }) || "›"}</span>
    </button>`;

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
    ${mitHtml}
    ${budgetHtml}
    ${exMiniHtml}
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
      .mit{padding:12px 16px;margin-bottom:16px;border-left:3px solid ${C.fill}}
      .mit-h{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:${C.ink};margin-bottom:8px}
      .mit-h .ic{color:${C.fill}}
      .mit-n{margin-left:auto;font-size:11px;font-weight:700;color:#fff;background:${C.fill};border-radius:999px;padding:1px 8px}
      .mit-rows{display:flex;flex-direction:column;gap:5px}
      .mit-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;
        border:1px solid ${C.line};background:${C.bg};border-radius:8px;padding:8px 11px}
      .mit-row:hover{border-color:${C.fill}}
      .mit-check{flex:none;margin:0;cursor:pointer}
      .mit-open{flex:1;min-width:0;display:flex;align-items:center;gap:10px;text-align:left;
        border:0;background:transparent;color:${C.ink};font:inherit;cursor:pointer;padding:0}
      .mit-step{font-size:12.5px;font-weight:600;line-height:1.3;flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mit-task{font-size:11px;color:${C.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
      .mit-open:hover .mit-step{color:${C.fill}}
      .mit-late{flex:none;font-size:10px;font-weight:700;color:#fff;background:${C.over};border-radius:999px;padding:1px 7px;white-space:nowrap}
      .mit-row.late{border-color:${C.over}}
      .mit-start{flex:none;display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;font-weight:700;
        color:#fff;background:${C.fill};border:1px solid ${C.fill};border-radius:7px;padding:5px 10px;cursor:pointer;line-height:1}
      .mit-start:hover{filter:brightness(1.06)}
      .mit-start:disabled{opacity:.6;cursor:default}
      /* F4 キャパ予算バンド: 残高ゲージ。ok=好調 / tight=残りわずか(amber) / over=超過(赤)。 */
      .cb{padding:12px 16px;margin-bottom:16px}
      .cb-h{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:${C.ink};margin-bottom:9px}
      .cb-h .ic{color:${C.fill}}
      .cb-state{margin-left:auto;font-size:11px;font-weight:700;border-radius:999px;padding:2px 10px}
      .cb-state.ok{color:${C.free};background:rgba(47,166,107,.12)}
      .cb-state.tight{color:${C.amber};background:rgba(230,160,30,.14)}
      .cb-state.over{color:${C.over};background:rgba(229,72,77,.12)}
      .cb-bar{position:relative;height:10px;background:${C.track};border-radius:6px;overflow:hidden;margin-bottom:8px}
      .cb-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:${C.fill}}
      .cb-bar i.ok{background:${C.free}}
      .cb-bar i.tight{background:${C.amber}}
      .cb-bar i.over{background:${C.over}}
      .cb-meta{font-size:12px;color:${C.ink}}
      .cb-meta b{font-weight:800;font-variant-numeric:tabular-nums}
      .cb-meta small{font-size:11px;color:${C.muted};margin-left:4px}
      .cb-over{border-left:3px solid ${C.over}}
      /* 今日の実行 mini バンド: 1行コンパクト。クリックでふりかえりへ。率が低いほど注意色。 */
      .exmini{display:flex;align-items:center;gap:14px;width:100%;box-sizing:border-box;text-align:left;
        padding:11px 16px;margin-bottom:16px;border:1px solid ${C.line};background:${C.card};color:${C.ink};
        font:inherit;cursor:pointer;border-radius:12px;transition:border-color .12s,background .12s}
      .exmini:hover{border-color:${C.fill};background:${C.track}}
      .exmini-h{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:${C.ink};flex:none}
      .exmini-h .ic{color:${C.fill}}
      .exmini-stats{display:flex;align-items:center;gap:14px;flex:1;min-width:0;flex-wrap:wrap}
      .exmini-st{font-size:12px;color:${C.muted};font-variant-numeric:tabular-nums}
      .exmini-st b{font-size:13.5px;font-weight:800;color:${C.ink};margin-left:2px}
      .exmini-st.ex-low b{color:${C.over}}
      .exmini-st.ex-mid b{color:${C.amber}}
      .exmini-st.ex-high b{color:${C.free}}
      .exmini-st.ex-na b{color:${C.muted}}
      .exmini-st.ex-stale b{color:${C.over}}
      .exmini-go{margin-left:auto;font-size:11.5px;font-weight:600;color:${C.fill};flex:none;display:inline-flex;align-items:center;gap:2px}
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
      /* 着手準備メーター: 行内の小バッジ。span[role=button] でクリック/Enter/Space 可、行クリックとは別動作。 */
      .td-prep{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex:none;cursor:pointer;
        font-size:10.5px;font-weight:700;line-height:1;border-radius:999px;padding:2px 7px;
        border:1px solid ${C.line};background:${C.track};color:${C.muted};transition:border-color .12s,background .12s,color .12s}
      .td-prep:hover{border-color:${C.fill};color:${C.ink}}
      .td-prep:focus-visible{outline:2px solid ${C.fill};outline-offset:1px}
      .td-prep .ic{flex:none}
      .td-prep-t{white-space:nowrap}
      .td-prep-bar{display:inline-block;width:26px;height:5px;border-radius:999px;background:${C.line};overflow:hidden;flex:none}
      .td-prep-fill{display:block;height:100%;border-radius:999px}
      /* 達成度の色分け: 低=注意 / 中=進行 / 高=好調。未準備は控えめ・urgent は注意色で促す。 */
      .td-prep-low{color:${C.over};border-color:${C.over}}
      .td-prep-low .td-prep-fill{background:${C.over}}
      .td-prep-mid{color:${C.amber};border-color:${C.amber}}
      .td-prep-mid .td-prep-fill{background:${C.amber}}
      .td-prep-high{color:${C.free};border-color:${C.free}}
      .td-prep-high .td-prep-fill{background:${C.free}}
      .td-prep-urgent{color:${C.over};border-color:${C.over};background:transparent}
      .td-prep-urgent .ic{color:${C.over}}
      .td-prep-none{color:${C.muted}}
      .td-prep-none .ic{color:${C.muted}}
      .td-more{display:inline-flex;align-items:center;gap:3px;margin-top:6px;font-size:11.5px;font-weight:600;color:${C.fill};text-decoration:none}
      .td-more:hover{text-decoration:underline}
    </style>`;

  // E1 MIT バンド: 行を「操作できる」3アクションに分割（テキスト＝準備タブ / チェック＝消し込み / ▶＝着手）。
  // テキスト＝準備タブへ（従来動作）
  root.querySelectorAll(".mit-open[data-prep]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.prep, tab: "prep", onSaved: () => render(root) });
  });
  // チェック＝その段取り手順を done にして保存→消し込み（MITから消える）
  root.querySelectorAll(".mit-check").forEach((cb) => {
    cb.onchange = async () => {
      const row = cb.closest(".mit-row");
      const taskId = +row.dataset.task, idx = +row.dataset.idx;
      cb.disabled = true;
      try {
        const d = await getPrep(taskId);
        const prep = (d && d.prep) || {};
        if (prep.steps && Array.isArray(prep.steps.items) && prep.steps.items[idx]) {
          prep.steps.items[idx].done = cb.checked;
          await savePrep(taskId, prep);
        }
        render(root); // MIT を再算出（done になった手順は !done フィルタで消える）
      } catch { cb.disabled = false; cb.checked = false; } // 失敗時は戻す
    };
  });
  // ▶着手＝進行中＋ポモ開始（exec-support の今すぐ着手と同じ E3 アクション）
  root.querySelectorAll(".mit-start[data-start]").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1"; btn.disabled = true;
      const taskId = +btn.dataset.start;
      const t = (tasks || []).find((x) => x.id === taskId) || taskId;
      try { await setTaskStarted(t); } catch { /* API ダウンでも続行 */ }
      try { const pm = await import("./pomodoro.js"); pm.startFocusFor(taskId, (typeof t === "object" ? t.title : "")); } catch { /* noop */ }
      btn.dataset.busy = ""; btn.disabled = false;
    };
  });

  // 今日の実行 mini: クリックでふりかえり（#/retro）へ。
  const exminiEl = root.querySelector("#exmini");
  if (exminiEl) exminiEl.onclick = () => { location.hash = "#/retro"; };

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
      body.innerHTML = `<div class="td-grid">${buckets.map((b) => bucketHtml(b, projects, day, prepScores)).join("")}</div>`;
      // 行クリック=編集モーダル。保存後はホーム全体を再描画（バケット件数を最新化）。
      body.querySelectorAll(".td-row[data-id]").forEach((el) => {
        el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
      });
      // 準備バッジ=着手準備タブへ直行（行クリックの編集とは分離）。span[role=button] なので click + keydown を配線。
      body.querySelectorAll("[data-prep]").forEach((el) => {
        const go = (e) => { e.stopPropagation(); openTaskForm({ taskId: +el.dataset.prep, tab: "prep", onSaved: () => render(root) }); };
        el.onclick = go;
        el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
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
