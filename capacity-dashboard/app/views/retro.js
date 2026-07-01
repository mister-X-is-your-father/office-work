// ふりかえり（実行の歩留まり）。「やると決めた → 実際に実行したか」を数字で見せる。
// 森田の本丸＝設計済み未実行を可視化する実績グループの新ビュー。
//   - 今日の実行: 手順消化率 / タスク着手率 / 今日の実働（率カード群）。
//   - まだ着手していない（今日やる予定）: 未着手タスクの拾い上げ（行クリックで編集）。
//   - 今週の勢い（過去14日）: 日別の実働h横バー＋完了数バッジ（今日強調・土日薄め）。
// 純関数（lib/execmetrics.js）は呼ぶだけ。exec/API 失敗は握って空で続行＝画面を壊さない。
import { stepDigestion, taskEngagement, dailyExecSeries, stalledTasks } from "../lib/execmetrics.js";
import { load } from "../lib/store.js";
import { getPrepScores, getActivity } from "../lib/exec.js";
import { getTimes } from "../lib/api.js";
import { C, esc, fmtH, todayISO } from "../lib/ui.js";
import { dateOnly, dowOf } from "../lib/capacity.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";
import { DOW_JA } from "../lib/form.js";

// 率カード（大数字＋進捗バー）。対象0件は「対象なし」を薄く（0%表示にしない）。
//   pct 低=注意(over) / 中=進行(amber) / 高=好調(free)。
function rateCard({ ic, label, num, den, pct, subDone }) {
  const has = den > 0;
  const lvl = !has ? "none" : pct < 40 ? "low" : pct < 80 ? "mid" : "high";
  const head = `<div class="rt-c-h">${icon(ic, { size: 15 }) || ""}<span>${esc(label)}</span></div>`;
  if (!has) {
    return `<div class="rt-c rt-c-none">${head}
      <div class="rt-c-big rt-c-na">対象なし</div>
      <div class="rt-c-sub">今日の対象タスクはありません</div></div>`;
  }
  return `<div class="rt-c rt-c-${lvl}">${head}
    <div class="rt-c-big">${pct}<small>%</small></div>
    <div class="rt-c-bar"><i style="width:${pct}%"></i></div>
    <div class="rt-c-sub">${num}/${den} ${esc(subDone)}</div></div>`;
}

// 実働カード（率でなく実数: 今日の実働h＋今日の完了数）。
function workCard(todayRow) {
  const workedH = todayRow ? todayRow.workedH : 0;
  const completed = todayRow ? todayRow.completed : 0;
  return `<div class="rt-c rt-c-work">
    <div class="rt-c-h">${icon("activity", { size: 15 }) || ""}<span>今日の実働</span></div>
    <div class="rt-c-big">${fmtH(workedH).replace("h", "")}<small>h</small></div>
    <div class="rt-c-sub">完了 ${completed} 件</div></div>`;
}

export async function render(root) {
  const { tasks, plansByTask, me } = await load(); // me は将来拡張用（純関数は担当を見ない）
  void me;
  const today = todayISO();

  // 着手準備の段取り手順（消化率の母数）。exec 停止時は空で続行。
  let sbt = {};
  try { sbt = (await getPrepScores())?.steps_by_task || {}; } catch { sbt = {}; }

  // 実績エントリ（N+1・ガント同方式）→ 平坦化。API 失敗は各タスク空で握る。
  const timeTasks = (tasks || []).filter((t) => (t.time_spent || 0) > 0);
  let timeEntries = [];
  try {
    const pairs = await Promise.all(
      timeTasks.map((t) => getTimes(t.id).then((es) => [t.id, es || []]).catch(() => [t.id, []]))
    );
    for (const [tid, es] of pairs) {
      for (const e of es) {
        if (e && e.logged_on) timeEntries.push({ day: dateOnly(e.logged_on), seconds: e.seconds || 0, taskId: tid });
      }
    }
  } catch { timeEntries = []; }

  // メトリクス計算（純関数）。空入力でも 0/[] で落ちない。
  const step = stepDigestion(sbt, today);
  const eng = taskEngagement(tasks, plansByTask, today);
  const series = dailyExecSeries(tasks, timeEntries, today, 14);
  const todayRow = series.length ? series[series.length - 1] : null;

  // 未着手（今日やる予定）の拾い上げ。eng.items の engaged=false のみ。
  const notEngaged = (eng.items || []).filter((it) => !it.engaged);

  // 停滞検知: 進捗ログ（exec）を取得し、N日以上 動きの無い未完了タスクを炙り出す。
  // getActivity 失敗は握って空＝停滞は created/started/time だけで算出継続。
  let activityLog = [];
  try { activityLog = (await getActivity())?.activity || []; } catch { activityLog = []; }
  const stalled = stalledTasks(tasks, timeEntries, activityLog, today, { thresholdDays: 7 });

  // 週バーの正規化最大値（実働h）。0除算/空回避で必ず >0。
  const maxWorkedH = Math.max(1, ...series.map((d) => d.workedH || 0));
  const md = (iso) => iso.slice(5).replace("-", "/");

  const cardsHtml = `
    <div class="rt-cards">
      ${rateCard({ ic: "listChecks", label: "手順消化率", num: step.done, den: step.total, pct: step.pct, subDone: "手順" })}
      ${rateCard({ ic: "play", label: "タスク着手率", num: eng.engaged, den: eng.target, pct: eng.pct, subDone: "着手" })}
      ${workCard(todayRow)}
    </div>`;

  const unstartedHtml = `
    <section class="rt-sec">
      <div class="rt-sec-h">${icon("alarm", { size: 14 }) || ""}<span>まだ着手していない（今日やる予定）</span><span class="rt-sec-n">${notEngaged.length}</span></div>
      ${notEngaged.length
        ? `<div class="rt-rows">${notEngaged.map((it) => `
            <button type="button" class="rt-row" data-id="${it.id}">
              <span class="rt-row-t">${esc(it.title)}</span>
              <span class="rt-row-m">${it.due ? `<span class="rt-tag rt-tag-due">今日期日</span>` : `<span class="rt-tag">今日plan</span>`}</span>
            </button>`).join("")}</div>`
        : `<div class="rt-empty">今日の対象はすべて着手済み 👍</div>`}
    </section>`;

  // 停滞セクション（7日以上 動きなし）。多すぎ防止で先頭 MAX_STALE 件＋「他N件」。
  const MAX_STALE = 12;
  const staleShown = stalled.slice(0, MAX_STALE);
  const staleMore = stalled.length - staleShown.length;
  const stalledHtml = `
    <section class="rt-sec">
      <div class="rt-sec-h">${icon("alertTriangle", { size: 14 }) || ""}<span>止まっているタスク（7日以上 動きなし）</span><span class="rt-sec-n">${stalled.length}</span></div>
      ${stalled.length
        ? `<div class="rt-rows">${staleShown.map((s) => `
            <button type="button" class="rt-row${s.overdue ? " rt-row-over" : ""}" data-id="${s.id}">
              <span class="rt-row-t">${esc(s.title)}</span>
              <span class="rt-row-m">
                ${s.overdue ? `<span class="rt-tag rt-tag-due">期日超過</span>` : ""}
                <span class="rt-tag rt-stale-d">停滞${s.days}日</span>
              </span>
            </button>`).join("")}</div>${staleMore > 0 ? `<div class="rt-empty">他 ${staleMore} 件</div>` : ""}`
        : `<div class="rt-empty">7日以上止まっているタスクはありません 👍</div>`}
    </section>`;

  const weekHtml = `
    <section class="rt-sec">
      <div class="rt-sec-h">${icon("trendingUp", { size: 14 }) || ""}<span>今週の勢い（過去14日）</span></div>
      <div class="rt-week">
        ${series.map((d) => {
          const isToday = d.day === today;
          const dow = dowOf(d.day);
          const weekend = dow === 0 || dow === 6;
          const w = Math.round(((d.workedH || 0) / maxWorkedH) * 100);
          return `<div class="rt-wd${isToday ? " today" : ""}${weekend ? " weekend" : ""}">
            <span class="rt-wd-lbl">${md(d.day)}<small>${DOW_JA[dow]}</small></span>
            <span class="rt-wd-bar"><i style="width:${w}%"></i></span>
            <span class="rt-wd-h">${d.workedH ? fmtH(d.workedH) : "—"}</span>
            ${d.completed > 0 ? `<span class="rt-wd-done">${icon("check", { size: 10 }) || ""}${d.completed}</span>` : `<span class="rt-wd-done rt-wd-done-0">0</span>`}
          </div>`;
        }).join("")}
      </div>
    </section>`;

  root.innerHTML = `
    <h1 class="vtitle">ふりかえり <small>${today}</small></h1>
    ${cardsHtml}
    ${unstartedHtml}
    ${stalledHtml}
    ${weekHtml}
    <style>
      .rt-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
      @media(max-width:720px){.rt-cards{grid-template-columns:1fr}}
      .rt-c{border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:14px 16px;display:flex;flex-direction:column;min-width:0}
      .rt-c-h{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:${C.muted};margin-bottom:8px}
      .rt-c-h .ic{color:${C.muted}}
      .rt-c-big{font-size:34px;font-weight:800;line-height:1;color:${C.ink};font-variant-numeric:tabular-nums}
      .rt-c-big small{font-size:16px;font-weight:700;color:${C.muted};margin-left:2px}
      .rt-c-na{font-size:20px;font-weight:700;color:${C.muted}}
      .rt-c-bar{position:relative;height:8px;background:${C.track};border-radius:6px;overflow:hidden;margin:10px 0 7px}
      .rt-c-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:${C.fill}}
      .rt-c-sub{font-size:11.5px;color:${C.muted};font-variant-numeric:tabular-nums}
      /* 達成度の色分け（バー＋見出しアイコン）。低=注意 / 中=進行 / 高=好調。 */
      .rt-c-low .rt-c-bar i{background:${C.over}}
      .rt-c-low .rt-c-h .ic{color:${C.over}}
      .rt-c-mid .rt-c-bar i{background:${C.amber}}
      .rt-c-mid .rt-c-h .ic{color:${C.amber}}
      .rt-c-high .rt-c-bar i{background:${C.free}}
      .rt-c-high .rt-c-h .ic{color:${C.free}}
      .rt-c-none{opacity:.72}
      .rt-c-work .rt-c-h .ic{color:${C.fill}}
      /* セクション */
      .rt-sec{border:1px solid ${C.line};border-radius:12px;background:${C.card};padding:14px 16px;margin-bottom:16px}
      .rt-sec-h{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:700;color:${C.ink};margin-bottom:11px}
      .rt-sec-h .ic{color:${C.muted}}
      .rt-sec-n{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;padding:1px 8px}
      .rt-empty{font-size:12.5px;color:${C.muted};padding:4px 2px}
      /* 未着手の行（クリックで編集モーダル） */
      .rt-rows{display:flex;flex-direction:column;gap:5px}
      .rt-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;
        border:1px solid ${C.line};background:${C.bg};color:${C.ink};font:inherit;cursor:pointer;border-radius:8px;padding:8px 11px}
      .rt-row:hover{border-color:${C.fill}}
      .rt-row-t{flex:1;min-width:0;font-size:12.5px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .rt-row-m{flex:none;display:flex;align-items:center;gap:6px}
      .rt-tag{font-size:10.5px;font-weight:700;line-height:1;border-radius:999px;padding:2px 8px;color:${C.muted};background:${C.track}}
      .rt-tag-due{color:${C.over};background:rgba(229,72,77,.12)}
      .rt-stale-d{color:${C.amber};background:rgba(230,160,30,.13)}
      .rt-row-over{border-color:rgba(229,72,77,.45)}
      /* 週バー（1日=横行: 日付ラベル＋実働h横バー＋完了数バッジ） */
      .rt-week{display:flex;flex-direction:column;gap:3px}
      .rt-wd{display:flex;align-items:center;gap:10px;padding:3px 4px;border-radius:7px}
      .rt-wd.weekend{opacity:.62}
      .rt-wd.today{background:${C.track};opacity:1}
      .rt-wd-lbl{flex:none;width:62px;font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:4px}
      .rt-wd-lbl small{font-size:10px}
      .rt-wd.today .rt-wd-lbl{color:${C.ink};font-weight:700}
      .rt-wd-bar{flex:1;min-width:0;position:relative;height:12px;background:${C.track};border-radius:6px;overflow:hidden}
      .rt-wd.today .rt-wd-bar{background:${C.line}}
      .rt-wd-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:${C.fill}}
      .rt-wd.today .rt-wd-bar i{background:${C.fill}}
      .rt-wd-h{flex:none;width:52px;text-align:right;font-size:11px;color:${C.muted};font-variant-numeric:tabular-nums}
      .rt-wd.today .rt-wd-h{color:${C.ink};font-weight:700}
      .rt-wd-done{flex:none;display:inline-flex;align-items:center;gap:2px;min-width:34px;justify-content:center;
        font-size:10.5px;font-weight:700;color:#fff;background:${C.free};border-radius:999px;padding:1px 7px}
      .rt-wd-done .ic{flex:none}
      .rt-wd-done-0{color:${C.muted};background:${C.track}}
    </style>`;

  // 未着手タスク行クリック＝編集モーダル。保存後はビュー全体を再描画（着手率を最新化）。
  root.querySelectorAll(".rt-row[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
  });
}
