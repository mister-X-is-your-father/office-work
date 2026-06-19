// 習慣トラッカー（TickTickの習慣相当・スキーマ変更なし）。
// 習慣=「習慣」WS のタスク（担当=本人・ユーザーごとに自分のWSが自動作成される）。
// チェック=実績エントリ（logged_on の日付・60秒固定）→ 直近7日ストリップ＋🔥ストリーク表示。
// 習慣WSのタスクは store.load が通常タスクから除外（負荷・空き・一覧に混ざらない）。
import { load, invalidate } from "../lib/store.js";
import { createProject, createTaskInProject, addAssignee, getTimes, logTime, deleteTime, deleteTask, updateTask } from "../lib/api.js";
import { habitStreak, lastDays, HABIT_WS, parseGoal, goalLabel, setGoalMeta, weekProgress } from "../lib/habits.js";
import { dateOnly } from "../lib/capacity.js";
import { DOW_JA } from "../lib/form.js";
import { C, esc, todayISO } from "../lib/ui.js";
import { push as pushHistory } from "../lib/history.js";
import { icon } from "../lib/icons.js";

const HEATMAP_DAYS = 84; // B47: 直近84日（12週）のコントリビューショングリッド

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
    ${hist.length ? summaryHtml(hist, today) : ""}
    <div class="hb-add card">
      <input id="hb-in" class="hb-input" autocomplete="off" placeholder="新しい習慣（例: 朝のレビュー15分）を入力して Enter">
      <div id="hb-err" class="hb-err" role="alert" hidden></div>
    </div>
    ${hist.length ? `<div class="card hb-list">
      ${hist.map(({ t, dates, total }) => rowHtml(t, dates, total, today)).join("")}
    </div>` : `<div class="card"><div class="loading">習慣はまだありません。上の欄から追加（自分だけに見える「${esc(HABIT_WS)}」ワークスペースに保存・チーム集計には含まれません）。</div></div>`}`;

  const input = root.querySelector("#hb-in");
  const errEl = root.querySelector("#hb-err");
  const showErr = (msg) => { if (!errEl) return; errEl.textContent = msg; errEl.hidden = false; };
  const clearErr = () => { if (errEl) { errEl.hidden = true; errEl.textContent = ""; } };
  input.oninput = clearErr;
  input.onkeydown = async (ev) => {
    if (ev.key !== "Enter") return;
    const name = input.value.trim();
    if (!name || !me) return;
    input.disabled = true;
    clearErr();
    try {
      const ws = habitProject || await createProject(HABIT_WS);
      const t = await createTaskInProject(ws.id, { title: name });
      await addAssignee(t.id, me.id);
      invalidate(); await load(); render(root);
    } catch (e) {
      // 入力テキストは破壊しない（value 保持・エラーは別要素 role=alert に出す）
      input.disabled = false;
      input.focus();
      showErr("追加に失敗しました: " + (e && e.message ? e.message : e));
    }
  };

  // B49: 今日の達成サマリ更新（行のチェック切替後にローカルで再計算して反映）
  const refreshSummary = () => {
    const sumEl = root.querySelector(".hb-sum");
    if (!sumEl || !hist.length) return;
    const fresh = document.createRange().createContextualFragment(summaryHtml(hist, today)).firstElementChild;
    sumEl.replaceWith(fresh);
  };

  // 各行にイベントをバインド（行単位ローカル更新のため再利用可能なヘルパに）
  const bindRow = (rowEl) => {
    // 今日のチェックをトグル（フル再描画/再fetchはせず、該当行だけローカル更新して差し替える）
    const cb = rowEl.querySelector("[data-check]");
    if (cb) cb.onclick = async () => {
      const h = hist.find((x) => x.t.id === +cb.dataset.check);
      if (!h) return;
      cb.disabled = true;
      try {
        if (h.todayEntry) {
          // 取り消し
          await deleteTime(h.t.id, h.todayEntry.id);
          h.dates.delete(today);
          h.todayEntry = null;
        } else {
          // チェック（logged_on はRFC3339必須）
          let entry = await logTime(h.t.id, 60, "習慣チェック", today + "T00:00:00Z");
          // 取り消しに使う id を確保。返値に id が無ければ、その習慣のみ再fetch（フル再描画は避ける）
          if (!entry || entry.id == null) {
            try {
              const own = ((await getTimes(h.t.id)) || []).filter((e) => e.user_id === (me && me.id));
              entry = own.find((e) => dateOnly(e.logged_on || e.created) === today) || entry;
            } catch { /* noop */ }
          }
          h.dates.add(today);
          h.todayEntry = entry || null;
        }
        h.total = h.dates.size;
        invalidate(); // ストア再fetchは次回 render まで遅延（即時の見た目は行差し替えで反映）
        // 該当行だけ作り直して差し替え
        const fresh = document.createRange().createContextualFragment(rowHtml(h.t, h.dates, h.total, today)).firstElementChild;
        rowEl.replaceWith(fresh);
        bindRow(fresh);
        refreshSummary(); // B49: サマリも更新
      } catch { cb.disabled = false; }
    };

    // B48: 習慣名のインライン編集（dblclick→input→updateTask({title})。履歴/データ保持）
    const nameEl = rowEl.querySelector(".hb-name-text");
    if (nameEl) nameEl.ondblclick = () => startInlineEdit(rowEl, nameEl);

    // 習慣の削除（履歴ごと見えなくなる・soft delete）
    const db = rowEl.querySelector("[data-del]");
    if (db) db.onclick = async () => {
      if (!confirm("この習慣を削除しますか？（チェック履歴も見えなくなります）")) return;
      db.disabled = true;
      try { await deleteTask(+db.dataset.del); invalidate(); await load(); render(root); } catch { db.disabled = false; }
    };

    // C11: 目標頻度の設定（毎日/平日/週N/なし）。description のメタ記法に保存し行をローカル差し替え。
    bindGoal(rowEl);
  };

  // C11: 目標ボタン＋ポップオーバーのイベント。description に [目標:…] を書き込む。
  function bindGoal(rowEl) {
    const gb = rowEl.querySelector("[data-goal]");
    const pop = rowEl.querySelector("[data-goal-pop]");
    if (!gb || !pop) return;
    const close = () => { pop.hidden = true; gb.setAttribute("aria-expanded", "false"); };
    gb.onclick = (ev) => {
      ev.stopPropagation();
      const open = pop.hidden;
      // 他の開いているポップを閉じる
      root.querySelectorAll(".hb-goal-pop").forEach((p) => { if (p !== pop) p.hidden = true; });
      root.querySelectorAll(".hb-goal-btn").forEach((b) => { if (b !== gb) b.setAttribute("aria-expanded", "false"); });
      pop.hidden = !open;
      gb.setAttribute("aria-expanded", String(open));
    };
    pop.querySelectorAll("[data-goal-opt]").forEach((opt) => {
      opt.onclick = async (ev) => {
        ev.stopPropagation();
        const h = hist.find((x) => x.t.id === +gb.dataset.goal);
        if (!h) return;
        const choice = GOAL_CHOICES.find((c) => c.key === opt.dataset.goalOpt);
        if (!choice) return;
        const goal = ("goal" in choice) ? choice.goal
          : (choice.key === "daily" ? { type: "daily" }
            : choice.key === "weekdays" ? { type: "weekdays" } : null);
        close();
        pop.querySelectorAll("[data-goal-opt]").forEach((o) => o.classList.add("hb-busy"));
        try {
          const nextDesc = setGoalMeta(h.t.description, goal);
          await updateTask(h.t.id, { description: nextDesc });
          // ローカル反映（store / hist 双方・次 render まで整合）
          h.t.description = nextDesc;
          const ref = (habitTasks || []).find((x) => x.id === h.t.id);
          if (ref) ref.description = nextDesc;
          // 行を作り直して差し替え（今週N/M・目標バッジを更新）
          const fresh = document.createRange().createContextualFragment(rowHtml(h.t, h.dates, h.total, today)).firstElementChild;
          rowEl.replaceWith(fresh);
          bindRow(fresh);
          invalidate();
        } catch (e) {
          pop.querySelectorAll("[data-goal-opt]").forEach((o) => o.classList.remove("hb-busy"));
          showErr("目標の保存に失敗しました: " + (e && e.message ? e.message : e));
        }
      };
    });
  }

  // B48: インライン編集の本体。元タイトルを保持し、保存成功で履歴(Undo/Redo)へ積む。
  function startInlineEdit(rowEl, nameEl) {
    const h = hist.find((x) => x.t.id === +nameEl.dataset.id);
    if (!h) return;
    const orig = h.t.title;
    const ed = document.createElement("input");
    ed.className = "hb-name-edit";
    ed.value = orig;
    ed.setAttribute("aria-label", "習慣名を編集");
    nameEl.replaceWith(ed);
    ed.focus();
    ed.select();

    let settled = false; // commit/cancel の二重発火ガード
    const restore = (title) => {
      // ローカルの title を反映してから名前要素を作り直して差し替える
      h.t.title = title;
      const frag = document.createRange().createContextualFragment(nameHtml(h.t.id, title)).firstElementChild;
      ed.replaceWith(frag);
      frag.ondblclick = () => startInlineEdit(rowEl, frag);
    };
    const applyTitle = async (taskId, title) => {
      await updateTask(taskId, { title });
      // store の habitTasks 上の同一タスクにも反映（次 render まで整合）
      const ref = (habitTasks || []).find((x) => x.id === taskId);
      if (ref) ref.title = title;
      const hh = hist.find((x) => x.t.id === taskId);
      if (hh) hh.t.title = title;
    };
    const commit = async () => {
      if (settled) return;
      const next = ed.value.trim();
      if (!next || next === orig) { settled = true; restore(orig); return; }
      settled = true;
      ed.disabled = true;
      try {
        await applyTitle(h.t.id, next);
        restore(next);
        // 履歴へ（Undo=元に戻す / Redo=やり直す。どちらも updateTask + 表示更新）
        pushHistory({
          label: "習慣名の編集",
          undo: async () => { await applyTitle(h.t.id, orig); reflectName(h.t.id, orig); },
          redo: async () => { await applyTitle(h.t.id, next); reflectName(h.t.id, next); },
        });
      } catch (e) {
        // 失敗時は編集に戻す（入力テキストは保持）
        settled = false;
        ed.disabled = false;
        ed.focus();
        showErr("習慣名の変更に失敗しました: " + (e && e.message ? e.message : e));
      }
    };
    const cancel = () => { if (settled) return; settled = true; restore(orig); };

    ed.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    };
    ed.onblur = commit;
  }

  // Undo/Redo 経由でタイトルが変わったとき、画面上の該当行の名前を更新（再描画なし）。
  function reflectName(taskId, title) {
    const el = root.querySelector(`.hb-name-text[data-id="${taskId}"]`);
    if (!el) return;
    const frag = document.createRange().createContextualFragment(nameHtml(taskId, title)).firstElementChild;
    el.replaceWith(frag);
    const rowEl = frag.closest(".hb-row");
    frag.ondblclick = () => startInlineEdit(rowEl, frag);
  }

  root.querySelectorAll(".hb-row").forEach(bindRow);

  // C11: 外側クリック / Esc で目標ポップを閉じる（行差し替えで重複しないよう毎 render 付け替え）
  const closeGoalPops = () => {
    root.querySelectorAll(".hb-goal-pop").forEach((p) => { p.hidden = true; });
    root.querySelectorAll(".hb-goal-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  };
  root.onclick = (ev) => { if (!ev.target.closest(".hb-goal-wrap")) closeGoalPops(); };
  root.onkeydown = (ev) => { if (ev.key === "Escape") closeGoalPops(); };

  // B47: 月間ヒートマップを開閉（各行の「📈」で展開・閉じる）
  root.querySelectorAll("[data-heat]").forEach((btn) => {
    btn.onclick = () => {
      const wrap = btn.closest(".hb-row").querySelector(".hb-heat");
      if (!wrap) return;
      const open = wrap.hidden;
      wrap.hidden = !open;
      btn.classList.toggle("on", open);
      btn.setAttribute("aria-expanded", String(open));
    };
  });
}

// B49: 今日の達成サマリ（「今日 N/M 達成」＋プログレス・全達成で緑＋祝福）
function summaryHtml(hist, today) {
  const total = hist.length;
  const done = hist.filter((h) => h.dates.has(today)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const all = total > 0 && done === total;
  return `<div class="card hb-sum${all ? " all" : ""}">
    <div class="hb-sum-head">
      <span class="hb-sum-label">今日 <b>${done}</b>/<b>${total}</b> 達成</span>
      ${all ? `<span class="hb-sum-celebrate">${icon("check", { size: 15 })} 今日のぶん、全部できました！</span>` : `<span class="hb-sum-pct">${pct}%</span>`}
    </div>
    <div class="hb-sum-bar"><div class="hb-sum-fill${all ? " all" : ""}" style="width:${pct}%"></div></div>
  </div>`;
}

// 習慣名の表示要素（dblclick で編集に切り替わる）。インライン編集差し替えの単位。
function nameHtml(id, title) {
  return `<span class="hb-name-text" data-id="${id}" title="ダブルクリックで名前を編集">${esc(title)}</span>`;
}

function rowHtml(t, dates, total, today) {
  const streak = habitStreak(dates, today);
  const week = lastDays(dates, today, 7);
  const goal = parseGoal(t.description);
  return `<div class="hb-row">
    <div class="hb-name">${nameHtml(t.id, t.title)}
      <span class="hb-meta">${streak ? `${icon("flame", { size: 14 })} ${streak}日連続` : "—"} ・ 計${total}回${goalMetaHtml(dates, today, goal)}</span>
      <div class="hb-heat" hidden>${heatmapHtml(dates, today)}</div>
    </div>
    <div class="hb-week">
      ${week.map((d, i) => {
        const isToday = i === 6;
        const dow = DOW_JA[new Date(d.iso + "T00:00:00Z").getUTCDay()];
        return `<div class="hb-day">
          <span class="hb-dw">${isToday ? "今日" : dow}</span>
          ${isToday
            ? `<button class="hb-c today${d.done ? " on" : ""}" data-check="${t.id}" title="${d.done ? "チェックを取り消す" : "今日の分をチェック"}">${d.done ? icon("check", { size: 14 }) : "○"}</button>`
            : `<span class="hb-c${d.done ? " on" : ""}">${d.done ? icon("check", { size: 14 }) : "·"}</span>`}
        </div>`;
      }).join("")}
    </div>
    <div class="hb-goal-wrap">
      <button class="hb-goal-btn${goal ? " set" : ""}" data-goal="${t.id}" title="目標頻度を設定" aria-haspopup="true" aria-expanded="false" aria-label="目標頻度を設定">${icon("flag", { size: 15 })}</button>
      ${goalPopHtml(t.id, goal)}
    </div>
    <button class="hb-heat-btn" data-heat="${t.id}" title="月間ヒートマップを表示" aria-expanded="false" aria-label="月間ヒートマップを表示">${icon("trendingUp", { size: 15 })}</button>
    <button class="hb-x" data-del="${t.id}" title="習慣を削除">×</button>
  </div>`;
}

// C11: 「今週 N/M」（目標がある時だけ。達成で緑表示）。
function goalMetaHtml(dates, today, goal) {
  if (!goal) return "";
  const p = weekProgress(dates, today, goal);
  if (!p) return "";
  return ` ・ <span class="hb-goal-prog${p.met ? " met" : ""}" title="目標: ${esc(goalLabel(goal))}">今週 ${p.done}/${p.target}${p.met ? " " + icon("check", { size: 12 }) : ""}</span>`;
}

// C11: 目標設定の簡易ポップオーバー（毎日 / 平日 / 週N / なし）。
const GOAL_CHOICES = [
  { key: "daily", label: "毎日" },
  { key: "weekdays", label: "平日のみ" },
  { key: "w2", label: "週2回", goal: { type: "week_n", n: 2 } },
  { key: "w3", label: "週3回", goal: { type: "week_n", n: 3 } },
  { key: "w5", label: "週5回", goal: { type: "week_n", n: 5 } },
  { key: "none", label: "目標なし", goal: null },
];
function goalKey(goal) {
  if (!goal) return "none";
  if (goal.type === "daily") return "daily";
  if (goal.type === "weekdays") return "weekdays";
  if (goal.type === "week_n") return "w" + goal.n;
  return "none";
}
function goalPopHtml(id, goal) {
  const cur = goalKey(goal);
  return `<div class="hb-goal-pop" data-goal-pop="${id}" hidden role="menu" aria-label="目標頻度">
    <div class="hb-goal-pop-h">目標頻度</div>
    ${GOAL_CHOICES.map((c) =>
      `<button class="hb-goal-opt${c.key === cur ? " on" : ""}" data-goal-opt="${c.key}" role="menuitemradio" aria-checked="${c.key === cur}">${esc(c.label)}</button>`,
    ).join("")}
  </div>`;
}

// B47: 直近HEATMAP_DAYS日のコントリビューショングリッド（GitHub風・週=列／曜日=行）＋達成率。
function heatmapHtml(dates, today) {
  const days = lastDays(dates, today, HEATMAP_DAYS); // 古い→新しい（末尾=today）
  const doneCount = days.filter((d) => d.done).length;
  const rate = Math.round((doneCount / HEATMAP_DAYS) * 100);
  // 先頭の曜日に合わせて空セルでパディング（列=週・行=曜日 日〜土）。
  const firstDow = new Date(days[0].iso + "T00:00:00Z").getUTCDay();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<span class="hb-hm-cell pad" aria-hidden="true"></span>`);
  for (const d of days) {
    const isToday = d.iso === today;
    cells.push(`<span class="hb-hm-cell${d.done ? " on" : ""}${isToday ? " today" : ""}" title="${d.iso}${d.done ? "：達成" : ""}"></span>`);
  }
  return `<div class="hb-hm">
    <div class="hb-hm-head">直近${HEATMAP_DAYS}日 ・ 達成 ${doneCount}/${HEATMAP_DAYS}（<b>${rate}%</b>）</div>
    <div class="hb-hm-grid">${cells.join("")}</div>
  </div>`;
}

function css() {
  return `
  .hb-add{padding:12px 14px;margin-bottom:14px}
  .hb-input{width:100%;box-sizing:border-box;font:inherit;font-size:13.5px;padding:9px 13px;border:1px solid ${C.line};border-radius:9px;background:#fff}
  .hb-input:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .hb-err{margin-top:8px;font-size:12.5px;color:#c0392b;font-weight:600}

  /* B49: 今日の達成サマリ */
  .hb-sum{padding:13px 16px;margin-bottom:14px}
  .hb-sum-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}
  .hb-sum-label{font-size:14px;font-weight:600}
  .hb-sum-label b{font-weight:800}
  .hb-sum-pct{font-size:13px;font-weight:700;color:${C.muted}}
  .hb-sum-celebrate{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:700;color:#2fa66b}
  .hb-sum-bar{height:8px;border-radius:99px;background:#eef1f5;overflow:hidden}
  .hb-sum-fill{height:100%;border-radius:99px;background:${C.fill};transition:width .3s ease}
  .hb-sum-fill.all{background:#2fa66b}
  .hb-sum.all{box-shadow:0 0 0 1.5px rgba(47,166,107,.4) inset}

  .hb-list{padding:6px 18px}
  .hb-row{display:flex;align-items:center;gap:16px;padding:13px 0;border-bottom:1px solid ${C.line}}
  .hb-row:last-child{border-bottom:0}
  .hb-name{flex:1;min-width:0;font-size:14px;font-weight:600}
  .hb-name-text{cursor:text;border-radius:4px;padding:1px 3px;margin:-1px -3px}
  .hb-name-text:hover{background:rgba(58,134,255,.08)}
  .hb-name-edit{font:inherit;font-size:14px;font-weight:600;width:min(100%,360px);box-sizing:border-box;padding:3px 7px;border:1px solid ${C.fill};border-radius:7px;background:#fff;color:inherit}
  .hb-name-edit:focus{outline:none;box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .hb-meta{display:block;font-size:11.5px;color:${C.muted};font-weight:500;margin-top:2px}
  /* C11: 今週 N/M（目標プログレス。達成で緑） */
  .hb-goal-prog{display:inline-flex;align-items:center;gap:2px;font-weight:700;color:${C.fill}}
  .hb-goal-prog.met{color:#2fa66b}
  .hb-week{display:flex;gap:7px}
  .hb-day{display:flex;flex-direction:column;align-items:center;gap:3px}
  .hb-dw{font-size:9.5px;color:${C.muted}}
  .hb-c{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;font-size:13px;color:#c3c9d2;background:#f4f6f9;border:0}
  .hb-c.on{background:#2fa66b;color:#fff;font-weight:700}
  .hb-c.today{border:1.5px solid ${C.fill};background:#fff;color:${C.fill};cursor:pointer;font-weight:700}
  .hb-c.today:hover{background:#eef4ff}
  .hb-c.today.on{background:#2fa66b;border-color:#2fa66b;color:#fff}
  /* C11: 目標頻度ボタン＋ポップオーバー */
  .hb-goal-wrap{position:relative;display:inline-flex}
  .hb-goal-btn{border:0;background:transparent;color:${C.muted};cursor:pointer;opacity:.5;padding:4px;border-radius:6px;display:inline-flex;transition:opacity .12s,background .12s,color .12s}
  .hb-row:hover .hb-goal-btn{opacity:1}
  .hb-goal-btn:hover{background:rgba(58,134,255,.1);color:${C.fill}}
  .hb-goal-btn.set{opacity:1;color:${C.fill}}
  .hb-goal-btn[aria-expanded="true"]{opacity:1;color:${C.fill};background:rgba(58,134,255,.12)}
  .hb-goal-btn:focus-visible{opacity:1}
  .hb-goal-pop{position:absolute;top:calc(100% + 6px);right:0;z-index:30;min-width:128px;background:#fff;border:1px solid ${C.line};border-radius:10px;box-shadow:0 8px 24px rgba(20,30,50,.16);padding:5px}
  .hb-goal-pop-h{font-size:10.5px;color:${C.muted};font-weight:700;padding:4px 8px 5px}
  .hb-goal-opt{display:block;width:100%;text-align:left;border:0;background:transparent;font:inherit;font-size:12.5px;color:inherit;padding:7px 9px;border-radius:7px;cursor:pointer}
  .hb-goal-opt:hover{background:rgba(58,134,255,.1)}
  .hb-goal-opt.on{background:rgba(58,134,255,.14);color:${C.fill};font-weight:700}
  .hb-goal-opt.hb-busy{opacity:.5;pointer-events:none}
  .hb-heat-btn{border:0;background:transparent;color:${C.muted};cursor:pointer;opacity:.5;padding:4px;border-radius:6px;display:inline-flex;transition:opacity .12s,background .12s}
  .hb-row:hover .hb-heat-btn{opacity:1}
  .hb-heat-btn:hover{background:rgba(58,134,255,.1);color:${C.fill}}
  .hb-heat-btn.on{opacity:1;color:${C.fill};background:rgba(58,134,255,.12)}
  .hb-heat-btn:focus-visible{opacity:1}
  .hb-x{border:0;background:transparent;color:${C.muted};font-size:15px;cursor:pointer;opacity:.35;padding:4px;transition:opacity .12s}
  .hb-row:hover .hb-x{opacity:1}
  .hb-x:focus-visible{opacity:1}

  /* B47: 月間ヒートマップ（GitHub風コントリビューショングリッド） */
  .hb-heat{margin-top:10px}
  .hb-hm-head{font-size:11.5px;color:${C.muted};font-weight:500;margin-bottom:6px}
  .hb-hm-head b{color:${C.ink || "inherit"};font-weight:700}
  .hb-hm-grid{display:grid;grid-template-rows:repeat(7,11px);grid-auto-flow:column;grid-auto-columns:11px;gap:3px}
  .hb-hm-cell{width:11px;height:11px;border-radius:3px;background:#eef1f5}
  .hb-hm-cell.pad{background:transparent}
  .hb-hm-cell.on{background:#2fa66b}
  .hb-hm-cell.today{box-shadow:0 0 0 1.5px ${C.fill}}

  /* ダークモード: 入力面=card / 未チェックの○=track / 今日ボタン面=card。済(.on)の緑は維持 */
  html[data-theme="dark"] .hb-input{background:var(--card);color:var(--ink)}
  html[data-theme="dark"] .hb-err{color:#ff8a80}
  html[data-theme="dark"] .hb-c{background:var(--track);color:var(--muted)}
  html[data-theme="dark"] .hb-c.today{background:var(--card);color:${C.fill}}
  html[data-theme="dark"] .hb-c.today:hover{background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .hb-name-text:hover{background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .hb-name-edit{background:var(--card);color:var(--ink)}
  html[data-theme="dark"] .hb-sum-bar{background:var(--track)}
  html[data-theme="dark"] .hb-hm-cell{background:var(--track)}
  html[data-theme="dark"] .hb-goal-pop{background:var(--card);border-color:var(--line);box-shadow:0 8px 24px rgba(0,0,0,.45)}
  html[data-theme="dark"] .hb-goal-btn:hover{background:rgba(58,134,255,.16)}
  html[data-theme="dark"] .hb-goal-opt:hover{background:rgba(58,134,255,.16)}`;
}
