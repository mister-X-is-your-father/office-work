// 習慣トラッカー（TickTickの習慣相当・スキーマ変更なし）。
// 習慣=「習慣」WS のタスク（担当=本人・ユーザーごとに自分のWSが自動作成される）。
// チェック=実績エントリ（logged_on の日付・60秒固定）→ 直近7日ストリップ＋🔥ストリーク表示。
// 習慣WSのタスクは store.load が通常タスクから除外（負荷・空き・一覧に混ざらない）。
import { load, invalidate } from "../lib/store.js";
import { createProject, createTaskInProject, addAssignee, getTimes, logTime, deleteTime, deleteTask } from "../lib/api.js";
import { habitStreak, lastDays, HABIT_WS } from "../lib/habits.js";
import { dateOnly } from "../lib/capacity.js";
import { DOW_JA } from "../lib/form.js";
import { C, esc, todayISO } from "../lib/ui.js";

export async function render(root) {
  const { habitTasks, habitProject, me } = await load();
  const today = todayISO();
  const mine = (habitTasks || []).filter((t) => (t.assignees || []).some((a) => a.id === (me && me.id)));

  // チェック履歴（自分のエントリのみ・習慣は少数なので N+1 で十分）
  const hist = await Promise.all(mine.map(async (t) => {
    let entries = [];
    try { entries = (await getTimes(t.id)) || []; } catch { /* noop */ }
    const own = entries.filter((e) => e.user_id === (me && me.id));
    const dates = new Set(own.map((e) => dateOnly(e.logged_on || e.created)));
    const todayEntry = own.find((e) => dateOnly(e.logged_on || e.created) === today) || null;
    return { t, dates, todayEntry, total: dates.size };
  }));

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">習慣 <small>毎日の積み重ね ・ 今日の○をクリックでチェック</small></h1>
    <div class="hb-add card">
      <input id="hb-in" class="hb-input" autocomplete="off" placeholder="新しい習慣（例: 朝のレビュー15分）を入力して Enter">
    </div>
    ${hist.length ? `<div class="card hb-list">
      ${hist.map(({ t, dates, total }) => rowHtml(t, dates, total, today)).join("")}
    </div>` : `<div class="card"><div class="loading">習慣はまだありません。上の欄から追加（自分だけに見える「${esc(HABIT_WS)}」ワークスペースに保存・チーム集計には含まれません）。</div></div>`}`;

  const input = root.querySelector("#hb-in");
  input.onkeydown = async (ev) => {
    if (ev.key !== "Enter") return;
    const name = input.value.trim();
    if (!name || !me) return;
    input.disabled = true;
    try {
      const ws = habitProject || await createProject(HABIT_WS);
      const t = await createTaskInProject(ws.id, { title: name });
      await addAssignee(t.id, me.id);
      invalidate(); await load(); render(root);
    } catch (e) { input.disabled = false; input.value = "× " + e.message; }
  };

  // 今日のチェックをトグル
  root.querySelectorAll("[data-check]").forEach((b) => {
    b.onclick = async () => {
      const { t, todayEntry } = hist.find((h) => h.t.id === +b.dataset.check);
      b.disabled = true;
      try {
        if (todayEntry) await deleteTime(t.id, todayEntry.id);
        else await logTime(t.id, 60, "習慣チェック", today + "T00:00:00Z"); // logged_on はRFC3339必須
        render(root);
      } catch { b.disabled = false; }
    };
  });
  // 習慣の削除（履歴ごと見えなくなる・soft delete）
  root.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("この習慣を削除しますか？（チェック履歴も見えなくなります）")) return;
      try { await deleteTask(+b.dataset.del); invalidate(); await load(); render(root); } catch { /* noop */ }
    };
  });
}

function rowHtml(t, dates, total, today) {
  const streak = habitStreak(dates, today);
  const week = lastDays(dates, today, 7);
  return `<div class="hb-row">
    <div class="hb-name">${esc(t.title)}
      <span class="hb-meta">${streak ? `🔥 ${streak}日連続` : "—"} ・ 計${total}回</span>
    </div>
    <div class="hb-week">
      ${week.map((d, i) => {
        const isToday = i === 6;
        const dow = DOW_JA[new Date(d.iso + "T00:00:00Z").getUTCDay()];
        return `<div class="hb-day">
          <span class="hb-dw">${isToday ? "今日" : dow}</span>
          ${isToday
            ? `<button class="hb-c today${d.done ? " on" : ""}" data-check="${t.id}" title="${d.done ? "チェックを取り消す" : "今日の分をチェック"}">${d.done ? "✓" : "○"}</button>`
            : `<span class="hb-c${d.done ? " on" : ""}">${d.done ? "✓" : "·"}</span>`}
        </div>`;
      }).join("")}
    </div>
    <button class="hb-x" data-del="${t.id}" title="習慣を削除">×</button>
  </div>`;
}

function css() {
  return `
  .hb-add{padding:12px 14px;margin-bottom:14px}
  .hb-input{width:100%;box-sizing:border-box;font:inherit;font-size:13.5px;padding:9px 13px;border:1px solid ${C.line};border-radius:9px;background:#fff}
  .hb-input:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .hb-list{padding:6px 18px}
  .hb-row{display:flex;align-items:center;gap:16px;padding:13px 0;border-bottom:1px solid ${C.line}}
  .hb-row:last-child{border-bottom:0}
  .hb-name{flex:1;min-width:0;font-size:14px;font-weight:600}
  .hb-meta{display:block;font-size:11.5px;color:${C.muted};font-weight:500;margin-top:2px}
  .hb-week{display:flex;gap:7px}
  .hb-day{display:flex;flex-direction:column;align-items:center;gap:3px}
  .hb-dw{font-size:9.5px;color:${C.muted}}
  .hb-c{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;font-size:13px;color:#c3c9d2;background:#f4f6f9;border:0}
  .hb-c.on{background:#2fa66b;color:#fff;font-weight:700}
  .hb-c.today{border:1.5px solid ${C.fill};background:#fff;color:${C.fill};cursor:pointer;font-weight:700}
  .hb-c.today:hover{background:#eef4ff}
  .hb-c.today.on{background:#2fa66b;border-color:#2fa66b;color:#fff}
  .hb-x{border:0;background:transparent;color:${C.muted};font-size:15px;cursor:pointer;opacity:.35;padding:4px;transition:opacity .12s}
  .hb-row:hover .hb-x{opacity:1}
  .hb-x:focus-visible{opacity:1}`;
}
