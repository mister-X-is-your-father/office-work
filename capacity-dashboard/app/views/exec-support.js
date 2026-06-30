// 着手準備パネル（実行リハーサル）= 実行サポート フレームワーク。
// 手法を「プラグイン」として登録し、有効なプラグインを汎用ループで描画する。
// 埋まり具合を実行可能性メーター(0〜100%)で可視化。保存は exec の per-task ストア(/prep/:taskId)。
//
// 設計の肝: PLUGINS レジストリ（自己記述オブジェクトの配列）を filter(enabled) して順に
//   render → wire。後からプラグインを足すだけで増やせる（個別ベタ書きにしない）。
//
// 仕様: docs/exec-support-spec.md。データ形は固定（taskform/将来の一覧が依存）:
//   prep = { next_step, steps, schedule, if_then, prereqs, obstacles, dod, score }
import { getPrep, savePrep, getSettings, saveProtectedWindows } from "../lib/exec.js";
import { updateTask, setTaskStarted, logPlan, getPlans, deletePlan } from "../lib/api.js";
import { load, isAiUser } from "../lib/store.js";
import { shiftISO, committedHoursByDayInRange } from "../lib/capacity.js";
import { backcast, localTodayIso, ccpmPlan, feverStatus, orderStepsForBackcast } from "../lib/ccpm.js";
import { upsertIntentBlock, eisenhowerPriority, hhmmToMinutes, unknownsToSteps, stepsToPlanSpecs, PLAN_NOTE_PREFIX } from "../lib/onapply.js";
import { esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { fmtDisplayDow, parseSmartDate, DOW_JA } from "../lib/form.js";

// ── ユーティリティ ────────────────────────────────────────────────
const nonEmpty = (s) => !!(s != null && String(s).trim());
const clampScore = (n, max) => Math.max(0, Math.min(max, Math.round(n)));
const uid = () => Math.random().toString(36).slice(2, 9);

// fmtDisplayDow は不正な ISO で例外を投げうるので安全に包む。
function dueLabel(iso) {
  if (!iso) return "";
  try { return fmtDisplayDow(iso); } catch { return iso; }
}

// "YYYY/MM/DD（曜）" 等のスマート入力 → "YYYY-MM-DD"（不正は "" ）。
function smartToIso(raw) {
  if (!raw) return "";
  return parseSmartDate(raw) || "";
}

// 逆算に必要なデータをまとめて取得（store.load + exec の保護時間帯）。
//   ctx.task.assignees の非AI先頭を担当に、無ければ me。担当の休暇レンジを引く。
async function loadBackcastCtx(ctx, deadlineIso = null) {
  const { settings, holidaysSet, unavailabilityByMember, me, tasks, plansByTask } = await load();
  // exec の team 設定から保護時間帯とバッファ率を取得（ダウン時は保護枠無し・バッファ0で続行）。
  let windows = [];
  let bufferPct = 0;
  try {
    const s = (await getSettings()).settings || {};
    windows = s.protected_windows || [];
    bufferPct = Math.max(0, Math.min(90, Math.round(Number(s.daily_buffer_pct) || 0)));
  } catch { /* exec ダウン時は保護枠無し・バッファ0で続行 */ }
  const assignees = (ctx && ctx.task && ctx.task.assignees) || [];
  const owner = assignees.find((a) => !isAiUser(a)) || me || null;
  const uid = owner && owner.id;
  const unavailRanges = (uid != null && unavailabilityByMember.get) ? (unavailabilityByMember.get(uid) || []) : [];
  const todayIso = localTodayIso();
  // F1: 担当が他タスクで既に埋めている当日予定(plans)を逆算窓ぶん集計し、実空きから差し引く。
  //   逆算対象タスク自身(ctx.taskId)は二重計上しないよう除外。
  const committedByDay = (uid != null && deadlineIso)
    ? committedHoursByDayInRange(tasks, plansByTask, uid, todayIso, deadlineIso, { excludeTaskId: ctx && ctx.taskId, holidays: holidaysSet })
    : new Map();
  // 床止め用のローカル今日。backcast へ必ず渡す（過去日へ手順を置かないため）。
  // F6: 優先度が高い（priority>=4＝高/緊急）タスクは deep 枠を実空きに使える。
  const taskIsImportant = (((ctx && ctx.task && ctx.task.priority) || 0) >= 4);
  return { capH: settings.capH || 8, windows, holidaysSet, unavailRanges, bufferPct, todayIso, committedByDay, taskIsImportant };
}

// ── プラグイン・レジストリ ─────────────────────────────────────────
// 各要素 = { id, label, icon, max, render(data, ctx), wire(rootEl, data, ctx, save), score(data), symptoms }
//   data = prep[id]（無ければ defaults() で既定）。ctx = { taskId, task }。
//   save = デバウンス保存関数（呼ぶと prep 全体を savePrep）。

// 行リスト（段取り / 必要なもの / 壁＋対策）の汎用配線ヘルパ。
//   cols: [{ key, ph, type }] （type: "text"(既定) | "check" | "h"）
//   各行は { __id, ...keys } を持つ（__id は描画キー用、保存対象外でも害なし）。
function ensureRowIds(items) {
  for (const it of items) if (!it.__id) it.__id = uid();
  return items;
}

// 段取り行の属性チップ（関門/骨格/主努力/種別≠自作業）。render と wire(軽量更新) で共用。
function stepBadgeChips(it) {
  const b = [];
  if (it.is_gate) b.push(`<span class="es-sb es-sb-gate">${icon("flag", { size: 11 })}関門</span>`);
  if (it.slice) b.push(`<span class="es-sb es-sb-slice">骨格</span>`);
  if (it.main_effort) b.push(`<span class="es-sb es-sb-main">★主努力</span>`);
  if (it.kind && it.kind !== "自作業") b.push(`<span class="es-sb es-sb-kind">${esc(it.kind)}</span>`);
  return b.join("");
}

// オーバーコミット早期警告バナー（F3）。逆算後 unplaced>0 のときだけ予定化カード内に残る赤い警告を出す。
//   状態は ctx._overcommit = { unplaced, total, deadlineIso }（transient・prep には保存しない）。
//   逆算前 / unplaced==0 は何も出さない（＝再逆算して全部置けたら自然に消える）。
function overcommitBannerHtml(ctx) {
  const oc = ctx && ctx._overcommit;
  if (!oc || !(oc.unplaced > 0)) return "";
  const dl = oc.deadlineIso ? dueLabel(oc.deadlineIso) : "この締切";
  return `
    <div class="es-oc" role="alert">
      <div class="es-oc-head">
        <span class="es-oc-ic">${icon("alertTriangle", { size: 15 })}</span>
        <span class="es-oc-msg">この締切（${esc(dl)}）は今のキャパでは <b>${oc.unplaced}/${oc.total}</b> 手順が入り切りません。</span>
      </div>
      <div class="es-oc-sub">どれかで空けないと締切に間に合いません。たとえば:</div>
      <ul class="es-oc-opts">
        <li>締切を延ばす（交渉する）</li>
        <li>手順を減らす・各手順を縮小する</li>
        <li>誰かに委譲する</li>
        <li>他タスクの優先度を下げて空ける</li>
        <li>バッファ／保護時間帯を見直す</li>
      </ul>
    </div>`;
}

// CCPM fever バー（バッファ消費率）。状態は ctx._fever（transient・prep には保存しない）。
//   ctx._fever = { consumedPct, tier:"green"|"yellow"|"red", consumedDays, bufferDays, personalDueIso, workDeadlineIso }。
function feverBarHtml(ctx) {
  const f = ctx && ctx._fever;
  if (!f) return "";
  const w = Math.max(0, Math.min(100, f.consumedPct || 0));
  const pdl = f.personalDueIso ? dueLabel(f.personalDueIso) : "—";
  const wdl = f.workDeadlineIso ? dueLabel(f.workDeadlineIso) : "—";
  return `
    <div class="es-fever" data-tier="${esc(f.tier || "green")}">
      <div class="es-fever-h">
        <span class="es-fever-t">${icon("alarm", { size: 13 })} バッファ消費 <b>${f.consumedPct}%</b></span>
        <span class="es-fever-sub">${f.consumedDays}/${f.bufferDays}日 ・ 前倒し締切 ${esc(pdl)} ・ 作業締切 ${esc(wdl)}</span>
      </div>
      <div class="es-fever-bar"><div class="es-fever-fill" style="width:${w}%"></div></div>
      <div class="es-fever-note">${f.squeezed ? "⚠ 前倒し/バッファを確保できません（締切ギリギリ）。締切交渉・手順縮小・委譲を検討。" : f.tier === "red" ? "バッファ超過。今すぐ巻き返し（前倒し締切を死守できるよう手順縮小/委譲/再逆算）。" : f.tier === "yellow" ? "バッファを消費中。ペースに注意。" : "順調（前倒し締切に間に合う見込み）。"}</div>
    </div>`;
}

const PLUGINS = [
  // 1. 次の一歩（最小着手）max=20
  {
    id: "next_step",
    defaultOn: true,
    label: "次の一歩",
    icon: "play",
    max: 20,
    symptoms: ["曖昧", "着手の壁"],
    defaults: () => ({ text: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">2分で始められる最小の物理動作を1つ。「PCを開く」「資料を1ページ読む」など。</div>
          <input class="es-in" data-k="text" type="text" autocomplete="off"
            placeholder="例: 議事録テンプレを新規作成して1行書く" value="${esc(data.text || "")}">
        </div>`;
    },
    wire(root, data, ctx, save) {
      const inp = root.querySelector('[data-k="text"]');
      inp.addEventListener("input", () => { data.text = inp.value; save(); });
    },
    score(data) { return nonEmpty(data.text) ? 20 : 0; },
  },

  // 2. 段取り（手順化）max=15
  {
    id: "steps",
    defaultOn: true,
    label: "段取り",
    icon: "listChecks",
    max: 15,
    symptoms: ["大きすぎ", "曖昧"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const n = data.items.length;
      const KINDS = ["自作業", "承認", "レビュー", "外部待ち"];
      const kindOpts = (cur) => KINDS.map((v) => `<option value="${v}"${(cur || "自作業") === v ? " selected" : ""}>${v}</option>`).join("");
      const rows = data.items.map((it, i) => `
        <div class="es-srow${it.done ? " done" : ""}${it.is_gate ? " es-srow-gate" : ""}${it.slice ? " es-srow-slice" : ""}" data-id="${it.__id}">
          <div class="es-row">
            <span class="es-ord">
              <button type="button" class="es-ordb" data-act="up" aria-label="上へ移動"${i === 0 ? " disabled" : ""}>${icon("arrowUp", { size: 13 })}</button>
              <button type="button" class="es-ordb" data-act="down" aria-label="下へ移動"${i === n - 1 ? " disabled" : ""}>${icon("chevronDown", { size: 13 })}</button>
            </span>
            <input type="checkbox" class="es-step-done" data-k="done"${it.done ? " checked" : ""} aria-label="この手順を完了にする" title="完了にする">
            <input class="es-in es-grow" data-k="title" type="text" placeholder="手順" value="${esc(it.title || "")}">
            <span class="es-sbs">${stepBadgeChips(it)}</span>
            <input class="es-in es-w64" data-k="est" type="text" inputmode="decimal" placeholder="見積h" value="${esc(it.est || "")}">
            <input class="es-in es-w120" data-k="due" type="text" placeholder="期日" value="${esc(it.due ? dueLabel(it.due) : "")}">
            <button type="button" class="es-rowx es-step-detbtn" data-act="detail" aria-label="この手順の詳細" aria-expanded="false" title="詳細（種別/関門/骨格/主努力）">${icon("chevronDown", { size: 14 })}</button>
            <button type="button" class="es-rowx" data-act="del" aria-label="この手順を削除">${icon("x", { size: 14 })}</button>
          </div>
          <div class="es-step-detail" hidden>
            <label class="es-sd-f">種別 <select class="es-in es-w120" data-k="kind" aria-label="種別">${kindOpts(it.kind)}</select></label>
            <label class="es-sd-c"><input type="checkbox" data-k="is_gate"${it.is_gate ? " checked" : ""}> 関門</label>
            <label class="es-sd-c"><input type="checkbox" data-k="slice"${it.slice ? " checked" : ""}> 骨格（最初に通す）</label>
            <label class="es-sd-c"><input type="checkbox" data-k="main_effort"${it.main_effort ? " checked" : ""}> 主努力</label>
            <input class="es-in es-grow es-sd-gate${it.is_gate ? "" : " es-hide"}" data-k="gate_criteria" type="text" placeholder="関門の通過条件（例: レビュー承認が出る）" value="${esc(it.gate_criteria || "")}">
          </div>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">手順を順序付け（見積h・期日は逆算で自動割当）。各手順の「${"▾"}」で 種別（承認/レビュー/外部待ち）・関門・骨格（最初に薄く一本通す）・主努力 を設定できます。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}手順を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const list = root.querySelector(".es-rows");
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      // 配列内で i↔j を入替（端は何もしない）。
      const swap = (i, j) => {
        if (i < 0 || j < 0 || i >= data.items.length || j >= data.items.length) return;
        const t = data.items[i]; data.items[i] = data.items[j]; data.items[j] = t;
        save(); rerender();
      };
      list.querySelectorAll(".es-srow").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        const refreshBadges = () => { const sbs = rowEl.querySelector(".es-sbs"); if (sbs) sbs.innerHTML = stepBadgeChips(it); };
        rowEl.querySelector('[data-k="title"]').addEventListener("input", (e) => { it.title = e.target.value; save(); });
        const doneEl = rowEl.querySelector('[data-k="done"]');
        if (doneEl) doneEl.addEventListener("change", () => {
          it.done = doneEl.checked;
          rowEl.classList.toggle("done", doneEl.checked); // 取り消し線（再描画せず軽量に）
          save();
        });
        rowEl.querySelector('[data-k="est"]').addEventListener("input", (e) => { it.est = e.target.value; save(); });
        const dueEl = rowEl.querySelector('[data-k="due"]');
        dueEl.addEventListener("change", () => {
          const iso = smartToIso(dueEl.value);
          it.due = iso;
          dueEl.value = iso ? dueLabel(iso) : "";
          save();
        });
        // 詳細トグル（再描画せず開閉）
        const detBtn = rowEl.querySelector('[data-act="detail"]');
        const detail = rowEl.querySelector(".es-step-detail");
        if (detBtn && detail) detBtn.addEventListener("click", () => {
          const open = detail.hasAttribute("hidden");
          detail.toggleAttribute("hidden", !open);
          detBtn.setAttribute("aria-expanded", open ? "true" : "false");
          detBtn.classList.toggle("es-open", open);
        });
        // サブフィールド（種別/関門/骨格/主努力/関門条件）— 軽量更新（詳細は開いたまま）
        const kindEl = rowEl.querySelector('[data-k="kind"]');
        if (kindEl) kindEl.addEventListener("change", () => { it.kind = kindEl.value; save(); refreshBadges(); });
        const gateCb = rowEl.querySelector('[data-k="is_gate"]');
        const gateCrit = rowEl.querySelector('[data-k="gate_criteria"]');
        if (gateCb) gateCb.addEventListener("change", () => {
          it.is_gate = gateCb.checked; save(); refreshBadges();
          rowEl.classList.toggle("es-srow-gate", gateCb.checked);
          if (gateCrit) gateCrit.classList.toggle("es-hide", !gateCb.checked);
        });
        const sliceCb = rowEl.querySelector('[data-k="slice"]');
        if (sliceCb) sliceCb.addEventListener("change", () => { it.slice = sliceCb.checked; save(); refreshBadges(); rowEl.classList.toggle("es-srow-slice", sliceCb.checked); });
        const meCb = rowEl.querySelector('[data-k="main_effort"]');
        if (meCb) meCb.addEventListener("change", () => { it.main_effort = meCb.checked; save(); refreshBadges(); });
        if (gateCrit) gateCrit.addEventListener("input", () => { it.gate_criteria = gateCrit.value; save(); });
        // 並べ替え・削除（既存挙動を保持）
        rowEl.querySelector('[data-act="up"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          swap(i, i - 1);
        });
        rowEl.querySelector('[data-act="down"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          swap(i, i + 1);
        });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
          if (ctx && typeof ctx.rerenderCard === "function") ctx.rerenderCard("schedule");
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), title: "", est: "", due: "", kind: "自作業", is_gate: false, gate_criteria: "", slice: false, main_effort: false });
        save(); rerender();
        if (ctx && typeof ctx.rerenderCard === "function") ctx.rerenderCard("schedule");
        const inputs = root.querySelectorAll('.es-srow [data-k="title"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.items || []).some((x) => nonEmpty(x.title)) ? 15 : 0; },
  },

  // 3. 予定化・スケジュール max=15（due 変更時は updateTask で本体期日にも反映）
  {
    id: "schedule",
    defaultOn: true,
    label: "予定化",
    icon: "calendar",
    max: 15,
    symptoms: ["計画が予定に落ちてない"],
    defaults: () => ({ due: "", note: "", ccpm: false, personalDueOffset: 1, aggressivePct: 30, projectBufferDays: "" }),
    render(data, ctx) {
      // 締切＝タスク本体の due_date（"0001" センチネルは無効）。
      const taskDue = (ctx && ctx.task && ctx.task.due_date) || "";
      const deadlineIso = taskDue && !taskDue.startsWith("0001") ? taskDue.slice(0, 10) : "";
      const steps = (ctx && ctx.prep && ctx.prep.steps && ctx.prep.steps.items) || [];
      const hasSteps = steps.length > 0;
      const canBackcast = !!deadlineIso && hasSteps;
      let hint;
      if (!deadlineIso) hint = "先に期日（このカードの「期日」）を設定すると、締切から逆算して各手順に日付を割り当てられます。";
      else if (!hasSteps) hint = "段取りに手順を1つ以上追加すると、締切から逆算して各手順に日付を割り当てられます。";
      else hint = `締切 ${dueLabel(deadlineIso)} から逆算して、各手順に作業日を割り当てます（土日・祝日・休暇・保護時間帯を考慮）。`;
      return `
        <div class="es-field">
          <div class="es-hint">いつやるか日付を決める。設定するとタスク本体の期日にも反映されます。</div>
          <div class="es-pair">
            <input class="es-in es-w160 es-due" data-k="due" type="text" autocomplete="off"
              placeholder="期日（例: 612）" value="${esc(data.due ? dueLabel(data.due) : "")}">
            <input class="es-in es-grow" data-k="note" type="text" autocomplete="off"
              placeholder="メモ（任意・どの枠に入れる等）" value="${esc(data.note || "")}">
          </div>
          <div class="es-back">
            <button type="button" class="es-btn es-backbtn" data-act="backcast"${canBackcast ? "" : " disabled"}>${icon("calendarDays", { size: 15 })}逆算スケジュール</button>
            <span class="es-back-hint">${esc(hint)}</span>
          </div>
          <div class="es-oa">
            <button type="button" class="es-btn es-oa-btn" data-act="apply-plan">${icon("calendar", { size: 14 })}逆算を稼働予定へ反映</button>
            <span class="es-oa-msg" data-oa-msg-plan></span>
          </div>
          <label class="es-check es-ccpm-tg">
            <input type="checkbox" data-k="ccpm"${data.ccpm ? " checked" : ""}>
            <span>CCPM逆算（前倒し締切＋集約バッファ＋fever）</span>
          </label>
          ${data.ccpm ? `
          <div class="es-ccpm-fields">
            <label class="es-ccpm-f">前倒し締切
              <input class="es-in es-w64" data-k="personalDueOffset" type="text" inputmode="numeric" value="${esc(data.personalDueOffset ?? 1)}"> 営業日前</label>
            <label class="es-ccpm-f">安全余裕
              <input class="es-in es-w64" data-k="aggressivePct" type="text" inputmode="numeric" value="${esc(data.aggressivePct ?? 30)}"> ％を抜く</label>
            <label class="es-ccpm-f">バッファ
              <input class="es-in es-w64" data-k="projectBufferDays" type="text" inputmode="numeric" placeholder="自動" value="${esc(data.projectBufferDays ?? "")}"> 日</label>
          </div>
          ${feverBarHtml(ctx)}` : ""}
          ${overcommitBannerHtml(ctx)}
          <button type="button" class="es-pw-link" data-act="pw-toggle" aria-expanded="false">${icon("lock", { size: 12 })} 保護時間帯を編集</button>
          <div class="es-pw-host" data-pw-host></div>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const dueEl = root.querySelector('[data-k="due"]');
      const noteEl = root.querySelector('[data-k="note"]');
      dueEl.addEventListener("change", async () => {
        const iso = smartToIso(dueEl.value);
        data.due = iso;
        dueEl.value = iso ? dueLabel(iso) : "";
        save();
        // タスク本体の期日へ反映（クリア時は Vikunja の零値で期日解除）。
        if (ctx && ctx.taskId != null) {
          try {
            await updateTask(ctx.taskId, { due_date: iso ? iso + "T00:00:00Z" : "0001-01-01T00:00:00Z" });
          } catch { /* exec/API ダウンでも UI は壊さない */ }
        }
      });
      noteEl.addEventListener("input", () => { data.note = noteEl.value; save(); });

      // ── CCPM逆算 トグル＋パラメータ（既定 OFF＝既存 backcast 経路を温存） ──
      const ccpmEl = root.querySelector('[data-k="ccpm"]');
      if (ccpmEl) ccpmEl.addEventListener("change", () => {
        data.ccpm = ccpmEl.checked; save();
        if (ctx && typeof ctx.rerenderCard === "function") ctx.rerenderCard("schedule"); // フィールド表示/非表示
      });
      const pdoEl = root.querySelector('[data-k="personalDueOffset"]');
      if (pdoEl) pdoEl.addEventListener("input", () => { data.personalDueOffset = pdoEl.value; save(); });
      const aggEl = root.querySelector('[data-k="aggressivePct"]');
      if (aggEl) aggEl.addEventListener("input", () => { data.aggressivePct = aggEl.value; save(); });
      const pbdEl = root.querySelector('[data-k="projectBufferDays"]');
      if (pbdEl) pbdEl.addEventListener("input", () => { data.projectBufferDays = pbdEl.value; save(); });

      // ── 逆算スケジュール ──
      const backBtn = root.querySelector('[data-act="backcast"]');
      if (backBtn) backBtn.addEventListener("click", async () => {
        if (backBtn.disabled || backBtn.dataset.busy === "1") return;
        const taskDue = (ctx && ctx.task && ctx.task.due_date) || "";
        const deadlineIso = taskDue && !taskDue.startsWith("0001") ? taskDue.slice(0, 10) : "";
        const stepsData = ctx && ctx.prep && ctx.prep.steps;
        const steps = (stepsData && stepsData.items) || [];
        if (!deadlineIso || !steps.length) return;
        // 完了済み(done)手順は動かさない＝未完了だけを再配置（元 index を保持して結果を戻す）。
        const placeIdx = steps.map((s, i) => (s && s.done) ? -1 : i).filter((i) => i >= 0);
        if (!placeIdx.length) return; // 未完了手順なし＝何もしない
        const placeSteps = placeIdx.map((i) => steps[i]);
        // slice（骨格）を配置上先頭＝今日寄りへ。表示順は不変、配置順だけ変える（元index対応を合成）。
        const { ordered, origByOrdered } = orderStepsForBackcast(placeSteps);
        const placeIdxOrdered = origByOrdered.map((ps) => placeIdx[ps]); // ordered の各位置 → 元 steps index
        const confirmMsg = data.ccpm
          ? `CCPM逆算（前倒し締切 ${Math.max(0, Math.round(Number(data.personalDueOffset ?? 1) || 0))} 営業日前・安全余裕 ${Math.max(0, Math.min(90, Math.round(Number(data.aggressivePct ?? 30) || 0)))}%・バッファ${(data.projectBufferDays != null && String(data.projectBufferDays).trim() !== "") ? String(data.projectBufferDays).trim() + "日" : "自動"}）で、締切 ${dueLabel(deadlineIso)} から未完了の ${placeSteps.length} 手順に作業日を割り当てます（完了済みは動かしません・今日以降に配置）。各手順の既存の期日は上書きされます。実行しますか？`
          : `締切 ${dueLabel(deadlineIso)} から逆算して、未完了の ${placeSteps.length} 手順に作業日を割り当てます（完了済みは動かしません・今日以降に配置）。各手順の既存の期日は上書きされます。実行しますか？`;
        if (typeof confirm === "function" && !confirm(confirmMsg)) return;
        backBtn.dataset.busy = "1"; backBtn.disabled = true;
        try {
          const bctx = await loadBackcastCtx(ctx, deadlineIso);
          if (data.ccpm) {
            // ── CCPM逆算経路（ON のときだけ）: 前倒し締切＋集約バッファ＋fever ──
            const personalDueOffset = Math.max(0, Math.round(Number(data.personalDueOffset ?? 1) || 0));
            const aggressivePct = Math.max(0, Math.min(90, Math.round(Number(data.aggressivePct ?? 30) || 0)));
            const projectBufferDaysOverride = (data.projectBufferDays != null && String(data.projectBufferDays).trim() !== "") ? data.projectBufferDays : null;
            const plan = ccpmPlan({ ...bctx, steps: ordered, deadlineIso, personalDueOffset, aggressivePct, projectBufferDaysOverride });
            placeIdxOrdered.forEach((origIdx, oi) => { if (plan.dueByIndex.has(oi)) steps[origIdx].due = plan.dueByIndex.get(oi); });
            save();
            if (ctx) ctx._overcommit = plan.unplaced > 0 ? { unplaced: plan.unplaced, total: placeSteps.length, deadlineIso } : null;
            const dailyCapH = bctx.capH * (1 - (bctx.bufferPct || 0) / 100);
            const fever = feverStatus({ remainingWorkH: plan.chainWorkH, dailyCapH, todayIso: bctx.todayIso, personalDueIso: plan.personalDueIso, bufferDays: plan.bufferDays, holidaysSet: bctx.holidaysSet, unavailRanges: bctx.unavailRanges, overcommitted: plan.unplaced > 0, squeezed: plan.squeezed });
            if (ctx) ctx._fever = { ...fever, bufferDays: plan.bufferDays, personalDueIso: plan.personalDueIso, workDeadlineIso: plan.workDeadlineIso, squeezed: plan.squeezed };
          } else {
            // ── 既存 backcast 経路（OFF＝現行挙動を1ミリも変えない）。bctx の spread は明示引数版と等価 ──
            const { dueByIndex, unplaced } = backcast({ ...bctx, steps: ordered, deadlineIso });
            // dueByIndex のキーは ordered(配置順) の index → 合成マップで元の steps index へ戻す。
            placeIdxOrdered.forEach((origIdx, oi) => { if (dueByIndex.has(oi)) steps[origIdx].due = dueByIndex.get(oi); });
            save();
            // オーバーコミット早期警告（F3）: 入り切らない未完了手順があれば予定化カードに残る赤いバナー、
            // 全部置けたら解除（＝再逆算で unplaced==0 になればバナーは消える）。
            if (ctx) ctx._overcommit = unplaced > 0 ? { unplaced, total: placeSteps.length, deadlineIso } : null;
            if (ctx) ctx._fever = null;
          }
          // 段取りカードを再描画して新しい期日を表示（タスク本体の due_date は変更しない）。
          if (ctx && typeof ctx.rerenderCard === "function") {
            ctx.rerenderCard("steps");
            // 予定化カード自身も再描画してバナーの表示/非表示を反映。
            ctx.rerenderCard("schedule");
          }
        } finally {
          backBtn.dataset.busy = ""; backBtn.disabled = false;
        }
      });

      // ── 逆算結果を稼働予定(task_time_plans)へ反映（B: 準備の逆算→キャパ予定の橋渡し） ──
      const planBtn = root.querySelector('[data-act="apply-plan"]');
      if (planBtn) planBtn.addEventListener("click", async () => {
        if (planBtn.dataset.busy === "1") return;
        const msg = root.querySelector('[data-oa-msg-plan]');
        const show = (t) => { if (msg) { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ""; }, 3500); } };
        const steps = (ctx && ctx.prep && ctx.prep.steps && ctx.prep.steps.items) || [];
        const specs = stepsToPlanSpecs(steps);
        if (!specs.length) { show("逆算で日付が付いた自作業の手順がありません（先に逆算してください）"); return; }
        if (typeof confirm === "function" && !confirm(`逆算で日付の付いた ${specs.length} 手順を稼働予定（週プランナー/稼働予定）に反映します。前回この方法で入れた予定は置き換えます（手動の予定は残ります）。実行しますか？`)) return;
        planBtn.dataset.busy = "1"; planBtn.disabled = true;
        try {
          const { me } = await load();
          // 前回の［逆算］予定だけ消す（手動・今日のカエル等は note prefix が違うので保護される）
          let prev = [];
          try { prev = await getPlans(ctx.taskId); } catch { prev = []; }
          for (const p of (prev || [])) {
            if (p && String(p.note || "").startsWith(PLAN_NOTE_PREFIX)) { try { await deletePlan(ctx.taskId, p.id); } catch { /* noop */ } }
          }
          // 新規作成
          for (const sp of specs) { try { await logPlan(ctx.taskId, sp.seconds, sp.date, sp.note, me && me.id); } catch { /* noop */ } }
          show(`${specs.length}件を稼働予定に反映しました（週プランナー/稼働予定で確認）`);
        } catch { show("稼働予定への反映に失敗（接続をご確認ください）"); }
        finally { planBtn.dataset.busy = ""; planBtn.disabled = false; }
      });

      // ── 保護時間帯エディタ（逆算が尊重する team 設定） ──
      // コントローラを ctx に保持し、カード再描画をまたいで開閉状態を引き継ぐ。
      const host = root.querySelector("[data-pw-host]");
      const pwLink = root.querySelector('[data-act="pw-toggle"]');
      if (host && pwLink) {
        const pw = mountProtectedEditor(host);
        const syncLink = (open) => pwLink.setAttribute("aria-expanded", open ? "true" : "false");
        pwLink.addEventListener("click", async () => {
          const open = await pw.toggle();
          syncLink(open);
          ctx._pwOpen = open;
        });
        // 再描画前に開いていたなら復元（DOM は作り直されているので toggle で開き直す）。
        if (ctx && ctx._pwOpen) { pw.toggle().then(syncLink); }
      }
    },
    score(data) { return nonEmpty(data.due) ? 15 : 0; },
  },

  // 4. if-then トリガー max=15（両方=15 / 片方=7 / 無し=0）
  {
    id: "if_then",
    defaultOn: true,
    label: "if-then トリガー",
    icon: "repeat",
    max: 15,
    symptoms: ["先延ばし"],
    defaults: () => ({ when: "", then: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">「いつ・どこで」になったら「これをする」を1組決める（実行のきっかけを固定）。</div>
          <div class="es-pair">
            <input class="es-in es-grow" data-k="when" type="text" autocomplete="off"
              placeholder="もし…（いつ・どこで）例: 朝9時に席に着いたら" value="${esc(data.when || "")}">
            <input class="es-in es-grow" data-k="then" type="text" autocomplete="off"
              placeholder="…する（何を）例: まずこのタスクを開く" value="${esc(data.then || "")}">
          </div>
        </div>`;
    },
    wire(root, data, ctx, save) {
      root.querySelector('[data-k="when"]').addEventListener("input", (e) => { data.when = e.target.value; save(); });
      root.querySelector('[data-k="then"]').addEventListener("input", (e) => { data.then = e.target.value; save(); });
    },
    score(data) {
      const w = nonEmpty(data.when), t = nonEmpty(data.then);
      return w && t ? 15 : (w || t) ? 7 : 0;
    },
  },

  // 5. 必要なもの max=15（全✓=15 / partial=floor(15*done率) / 空=0）
  {
    id: "prereqs",
    defaultOn: true,
    label: "必要なもの",
    icon: "paperclip",
    max: 15,
    symptoms: ["準備不足"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const rows = data.items.map((it) => `
        <label class="es-check${it.done ? " done" : ""}" data-id="${it.__id}">
          <input type="checkbox" data-k="done"${it.done ? " checked" : ""}>
          <input class="es-in es-grow es-check-in" data-k="text" type="text" placeholder="物・情報・承認など" value="${esc(it.text || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </label>`).join("");
      return `
        <div class="es-field">
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}必要なものを追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-check").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        const cb = rowEl.querySelector('[data-k="done"]');
        cb.addEventListener("change", () => { it.done = cb.checked; save(); rerender(); });
        rowEl.querySelector('[data-k="text"]').addEventListener("input", (e) => { it.text = e.target.value; save(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", (e) => {
          e.preventDefault();
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), text: "", done: false });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-check [data-k="text"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) {
      const items = data.items || [];
      if (!items.length) return 0;
      const done = items.filter((x) => x.done).length;
      if (done === items.length) return 15;
      return Math.floor(15 * (done / items.length));
    },
  },

  // 6. 想定する壁＋対策（WOOP）max=10（obstacle と plan 両方ある行が1つ以上=10）
  {
    id: "obstacles",
    defaultOn: true,
    label: "想定する壁＋対策",
    icon: "alertTriangle",
    max: 10,
    symptoms: ["不安", "挫折予感"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const rows = data.items.map((it) => `
        <div class="es-row" data-id="${it.__id}">
          <input class="es-in es-grow" data-k="obstacle" type="text" placeholder="想定される壁（例: 資料が見つからない）" value="${esc(it.obstacle || "")}">
          <span class="es-arrow" aria-hidden="true">${icon("chevronRight", { size: 13 })}</span>
          <input class="es-in es-grow" data-k="plan" type="text" placeholder="そのときどうする" value="${esc(it.plan || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}壁と対策を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        rowEl.querySelector('[data-k="obstacle"]').addEventListener("input", (e) => { it.obstacle = e.target.value; save(); });
        rowEl.querySelector('[data-k="plan"]').addEventListener("input", (e) => { it.plan = e.target.value; save(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), obstacle: "", plan: "" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="obstacle"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) {
      return (data.items || []).some((x) => nonEmpty(x.obstacle) && nonEmpty(x.plan)) ? 10 : 0;
    },
  },

  // 7. 完了の定義（DoD）max=10（非空=10）
  {
    id: "dod",
    defaultOn: true,
    label: "完了の定義",
    icon: "flag",
    max: 10,
    symptoms: ["ゴール不明確"],
    defaults: () => ({ text: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">「これができたら終わり」と言える状態を一言で。曖昧な完了を防ぐ。</div>
          <textarea class="es-in es-ta" data-k="text" rows="2"
            placeholder="例: 議事録を共有フォルダに保存し、参加者にリンクを送った">${esc(data.text || "")}</textarea>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const ta = root.querySelector('[data-k="text"]');
      ta.addEventListener("input", () => { data.text = ta.value; save(); });
    },
    score(data) { return nonEmpty(data.text) ? 10 : 0; },
  },

  // ── 実行準備フレームワーク 波1（新規・既定OFF＝セット/手動でONにすると meter に乗る） ──

  // A. 指揮官の意図 max=15（北極星: 上位目的＋終末状態を固定）
  {
    id: "commanders_intent",
    icon: "flag",
    label: "指揮官の意図",
    max: 15,
    symptoms: ["曖昧", "不確実性"],
    defaults: () => ({ purpose: "", endState: "", mustHold: "", acceptableLoss: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">計画が崩れても見失わない“北極星”。上位目的・終末状態・絶対外さない条件を固定。</div>
          <input class="es-in" data-k="purpose" type="text" autocomplete="off"
            placeholder="上位目的＝なぜやるか" value="${esc(data.purpose || "")}">
          <input class="es-in" data-k="endState" type="text" autocomplete="off"
            placeholder="終末状態＝終わったとき何がどうなっているか" value="${esc(data.endState || "")}">
          <input class="es-in" data-k="mustHold" type="text" autocomplete="off"
            placeholder="絶対外さない必須条件（1〜3個・読点区切り可）" value="${esc(data.mustHold || "")}">
          <input class="es-in" data-k="acceptableLoss" type="text" autocomplete="off"
            placeholder="間に合わなければ削ってよい要素（任意）" value="${esc(data.acceptableLoss || "")}">
          <div class="es-oa">
            <button type="button" class="es-btn es-oa-btn" data-act="apply-intent">${icon("flag", { size: 14 })}意図をタスクに記録</button>
            <span class="es-oa-msg" data-oa-msg></span>
          </div>
        </div>`;
    },
    wire(root, data, ctx, save) {
      root.querySelector('[data-k="purpose"]').addEventListener("input", (e) => { data.purpose = e.target.value; save(); });
      root.querySelector('[data-k="endState"]').addEventListener("input", (e) => { data.endState = e.target.value; save(); });
      root.querySelector('[data-k="mustHold"]').addEventListener("input", (e) => { data.mustHold = e.target.value; save(); });
      root.querySelector('[data-k="acceptableLoss"]').addEventListener("input", (e) => { data.acceptableLoss = e.target.value; save(); });
      const intentBtn = root.querySelector('[data-act="apply-intent"]');
      if (intentBtn) intentBtn.addEventListener("click", async () => {
        if (intentBtn.dataset.busy === "1") return;
        const msg = root.querySelector('[data-oa-msg]');
        const show = (t) => { if (msg) { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ""; }, 3000); } };
        intentBtn.dataset.busy = "1"; intentBtn.disabled = true;
        try {
          const newDesc = upsertIntentBlock((ctx && ctx.task && ctx.task.description) || "", data);
          if (ctx && ctx.taskId != null) await updateTask(ctx.taskId, { description: newDesc });
          if (ctx && ctx.task) ctx.task.description = newDesc;
          show("タスクの説明に意図を記録しました");
        } catch { show("記録に失敗（接続をご確認ください）"); }
        finally { intentBtn.dataset.busy = ""; intentBtn.disabled = false; }
      });
    },
    score(data) {
      return nonEmpty(data.purpose) && nonEmpty(data.endState) ? 15 : ((nonEmpty(data.purpose) || nonEmpty(data.endState)) ? 7 : 0);
    },
  },

  // B. 今日のカエル max=15（今日これだけは絶対の1件を朝イチ枠に）
  {
    id: "mit_today",
    icon: "alarm",
    label: "今日のカエル",
    max: 15,
    symptoms: ["先延ばし", "曖昧"],
    defaults: () => ({ isFrog: false, slotStart: "09:00", estMin: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">今日これだけは絶対の1件を、意志力最大の朝イチ枠に置く。</div>
          <label class="es-check">
            <input type="checkbox" data-k="isFrog"${data.isFrog ? " checked" : ""}>
            <span>このタスクを今日のカエルにする</span>
          </label>
          <div class="es-pair">
            <input class="es-in es-w120" data-k="slotStart" type="time" value="${esc(data.slotStart || "09:00")}" aria-label="開始時刻">
            <input class="es-in es-w120" data-k="estMin" type="text" inputmode="numeric"
              placeholder="確保分（既定60）" value="${esc(data.estMin || "")}">
          </div>
          <div class="es-oa">
            <button type="button" class="es-btn es-oa-btn" data-act="apply-frog">${icon("alarm", { size: 14 })}朝イチ枠を確保</button>
            <span class="es-oa-msg" data-oa-msg></span>
          </div>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const frog = root.querySelector('[data-k="isFrog"]');
      frog.addEventListener("change", () => { data.isFrog = frog.checked; save(); });
      const slot = root.querySelector('[data-k="slotStart"]');
      slot.addEventListener("change", () => { data.slotStart = slot.value; save(); });
      slot.addEventListener("input", () => { data.slotStart = slot.value; save(); });
      const est = root.querySelector('[data-k="estMin"]');
      est.addEventListener("input", () => { data.estMin = est.value; save(); });
      est.addEventListener("change", () => { data.estMin = est.value; save(); });
      const frogBtn = root.querySelector('[data-act="apply-frog"]');
      if (frogBtn) frogBtn.addEventListener("click", async () => {
        if (frogBtn.dataset.busy === "1") return;
        const msg = root.querySelector('[data-oa-msg]');
        const show = (t) => { if (msg) { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ""; }, 3000); } };
        if (!data.isFrog) { show("「今日のカエルにする」をONにしてください"); return; }
        frogBtn.dataset.busy = "1"; frogBtn.disabled = true;
        try {
          const { me } = await load();
          const today = localTodayIso();
          const startMin = hhmmToMinutes(data.slotStart || "09:00");
          const estMin = Math.max(15, Math.round(Number(data.estMin) || 60));
          if (ctx && ctx.taskId != null) {
            await logPlan(ctx.taskId, estMin * 60, today, "今日のカエル", me && me.id, startMin);
            await updateTask(ctx.taskId, { start_date: today + "T00:00:00Z" });
          }
          show(`朝イチ枠（${data.slotStart || "09:00"}・${estMin}分）を今日に確保`);
        } catch { show("枠の確保に失敗"); }
        finally { frogBtn.dataset.busy = ""; frogBtn.disabled = false; }
      });
    },
    score(data) { return data.isFrog ? 15 : 0; },
  },

  // C. 緊急×重要 max=10（Do/予定化/委譲/やめる を機械的に確定）
  {
    id: "eisenhower",
    icon: "grid",
    label: "緊急×重要",
    max: 10,
    symptoms: ["曖昧", "割り込み"],
    defaults: () => ({ important: false, urgent: false, decided: false }),
    render(data, ctx) {
      // 未確定なら締切から緊急を自動推定（due が今日以前/3日以内なら true）。
      if (!data.decided) {
        const due = (ctx && ctx.task && ctx.task.due_date) || "";
        const dueIso = due && !due.startsWith("0001") ? due.slice(0, 10) : "";
        if (dueIso) {
          const soon = shiftISO(localTodayIso(), 3);
          data.urgent = dueIso <= soon;
        }
      }
      const label = eisenhowerActionLabel(data);
      return `
        <div class="es-field">
          <div class="es-hint">重要×緊急で Do/予定化/委譲/やめる を機械的に確定。</div>
          <label class="es-check">
            <input type="checkbox" data-k="important"${data.important ? " checked" : ""}>
            <span>重要</span>
          </label>
          <label class="es-check">
            <input type="checkbox" data-k="urgent"${data.urgent ? " checked" : ""}>
            <span>緊急</span>
          </label>
          <div class="es-hint" data-act-label>${esc(label)}</div>
          <div class="es-oa">
            <button type="button" class="es-btn es-oa-btn" data-act="apply-eis">${icon("grid", { size: 14 })}優先度に反映</button>
            <span class="es-oa-msg" data-oa-msg></span>
          </div>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const refresh = () => {
        const el = root.querySelector("[data-act-label]");
        if (el) el.textContent = eisenhowerActionLabel(data);
      };
      const imp = root.querySelector('[data-k="important"]');
      imp.addEventListener("change", () => { data.important = imp.checked; data.decided = true; save(); refresh(); });
      const urg = root.querySelector('[data-k="urgent"]');
      urg.addEventListener("change", () => { data.urgent = urg.checked; data.decided = true; save(); refresh(); });
      const eisBtn = root.querySelector('[data-act="apply-eis"]');
      if (eisBtn) eisBtn.addEventListener("click", async () => {
        if (eisBtn.dataset.busy === "1") return;
        const msg = root.querySelector('[data-oa-msg]');
        const show = (t) => { if (msg) { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ""; }, 3000); } };
        const pr = eisenhowerPriority(data.important, data.urgent);
        if (pr == null) { show(data.urgent ? "委譲を検討（重要でない緊急）" : "後回し/取り下げを検討"); return; }
        eisBtn.dataset.busy = "1"; eisBtn.disabled = true;
        try {
          if (ctx && ctx.taskId != null) await updateTask(ctx.taskId, { priority: pr });
          if (ctx && ctx.task) ctx.task.priority = pr;
          show(pr === 4 ? "優先度=緊急(4) に設定" : "優先度=高(3) に設定");
        } catch { show("優先度の反映に失敗"); }
        finally { eisBtn.dataset.busy = ""; eisBtn.disabled = false; }
      });
    },
    score(data) { return data.decided ? 10 : 0; },
  },

  // D. 復唱確認 max=8（依頼を自分の言葉で要約しズレを着手前に炙り出す）
  {
    id: "backbrief",
    icon: "message",
    label: "復唱確認",
    max: 8,
    symptoms: ["曖昧", "依存"],
    defaults: () => ({ myUnderstanding: "", firstThreeMoves: "", successTest: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">依頼を自分の言葉で要約し直し、理解のズレ・前提の抜けを着手前に炙り出す。</div>
          <textarea class="es-in es-ta" data-k="myUnderstanding" rows="2"
            placeholder="この依頼を自分はこう理解した">${esc(data.myUnderstanding || "")}</textarea>
          <input class="es-in" data-k="firstThreeMoves" type="text" autocomplete="off"
            placeholder="最初の3手を自分の言葉で" value="${esc(data.firstThreeMoves || "")}">
          <input class="es-in" data-k="successTest" type="text" autocomplete="off"
            placeholder="成功と言える判定（DoDと矛盾しないか）" value="${esc(data.successTest || "")}">
        </div>`;
    },
    wire(root, data, ctx, save) {
      // ※ openQuestions→確認子タスク生成は次パス。
      root.querySelector('[data-k="myUnderstanding"]').addEventListener("input", (e) => { data.myUnderstanding = e.target.value; save(); });
      root.querySelector('[data-k="firstThreeMoves"]').addEventListener("input", (e) => { data.firstThreeMoves = e.target.value; save(); });
      root.querySelector('[data-k="successTest"]').addEventListener("input", (e) => { data.successTest = e.target.value; save(); });
    },
    score(data) { return nonEmpty(data.myUnderstanding) ? 8 : 0; },
  },

  // E. 未知を先に潰す max=18（新規・波2・既定OFF）
  //   onApply（impact=high未解消→steps「[先行検証]」自動挿入＋前方配置）は後追い（波1同様データ取得版）。
  {
    id: "unknowns_register",
    icon: "search",
    label: "未知を先に潰す",
    max: 18,
    symptoms: ["不確実性", "依存"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const imp = (v) => (v === "high" || v === "low") ? v : "med";
      const opt = (cur) => ["high", "med", "low"]
        .map((v) => `<option value="${v}"${imp(cur) === v ? " selected" : ""}>${v === "high" ? "高" : v === "med" ? "中" : "低"}</option>`).join("");
      const rows = data.items.map((it) => `
        <div class="es-unk${imp(it.impact) === "high" && !it.resolved ? " es-unk-hot" : ""}${it.resolved ? " done" : ""}" data-id="${it.__id}">
          <div class="es-unk-l1">
            <input type="checkbox" class="es-unk-res" data-k="resolved"${it.resolved ? " checked" : ""} aria-label="解消済み" title="解消済みにする">
            <input class="es-in es-grow" data-k="unknown" type="text" placeholder="まだ分からないこと・崩れたら致命的な前提" value="${esc(it.unknown || "")}">
            <select class="es-in es-w64" data-k="impact" aria-label="影響度">${opt(it.impact)}</select>
            <button type="button" class="es-rowx" data-act="del" aria-label="この未知を削除">${icon("x", { size: 14 })}</button>
          </div>
          <div class="es-unk-l2">
            <input class="es-in es-grow" data-k="resolveBy" type="text" placeholder="解消方法（例: 試しに1件APIを叩く）" value="${esc(it.resolveBy || "")}">
            <input class="es-in es-grow" data-k="evidence" type="text" placeholder="解消の証拠（例: 200が返る）" value="${esc(it.evidence || "")}">
            <input class="es-in es-w120" data-k="due" type="text" placeholder="解消期日" value="${esc(it.due ? dueLabel(it.due) : "")}">
          </div>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">未知・崩れたら致命的な前提を、解消方法・証拠・期日付きで列挙。怖いところを先に潰す（高影響は赤・解消でチェック）。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}未知を追加</button>
          <div class="es-oa">
            <button type="button" class="es-btn es-oa-btn" data-act="apply-unknowns">${icon("search", { size: 14 })}高影響を段取りへ「先行検証」として入れる</button>
            <span class="es-oa-msg" data-oa-msg></span>
          </div>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-unk").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        rowEl.querySelector('[data-k="unknown"]').addEventListener("input", (e) => { it.unknown = e.target.value; save(); });
        rowEl.querySelector('[data-k="resolveBy"]').addEventListener("input", (e) => { it.resolveBy = e.target.value; save(); });
        rowEl.querySelector('[data-k="evidence"]').addEventListener("input", (e) => { it.evidence = e.target.value; save(); });
        const dueEl = rowEl.querySelector('[data-k="due"]');
        dueEl.addEventListener("change", () => { const iso = smartToIso(dueEl.value); it.due = iso; dueEl.value = iso ? dueLabel(iso) : ""; save(); });
        rowEl.querySelector('[data-k="impact"]').addEventListener("change", (e) => { it.impact = e.target.value; save(); rerender(); });
        const res = rowEl.querySelector('[data-k="resolved"]');
        res.addEventListener("change", () => { it.resolved = res.checked; save(); rerender(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), unknown: "", impact: "med", resolveBy: "", evidence: "", due: "", resolved: false });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-unk [data-k="unknown"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
      const unkBtn = root.querySelector('[data-act="apply-unknowns"]');
      if (unkBtn) unkBtn.addEventListener("click", () => {
        const msg = root.querySelector('[data-oa-msg]');
        const show = (t) => { if (msg) { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ""; }, 3000); } };
        const cand = unknownsToSteps(data.items, { uid });
        if (!cand.length) { show("高影響・未解消の未知がありません"); return; }
        const steps = (ctx && ctx.prep && ctx.prep.steps) || null;
        if (!steps) { show("段取りカードが見つかりません"); return; }
        steps.items = steps.items || [];
        const exist = new Set(steps.items.map((s) => s.title));
        const add = cand.filter((s) => !exist.has(s.title));
        if (!add.length) { show("すでに追加済みです"); return; }
        steps.items.unshift(...add);
        save();
        if (ctx && typeof ctx.rerenderCard === "function") { ctx.rerenderCard("steps"); ctx.rerenderCard("schedule"); }
        show(`${add.length}件を段取りに「先行検証」として追加`);
      });
    },
    score(data) {
      const items = (data.items || []).filter((x) => nonEmpty(x.unknown));
      if (!items.length) return 0;
      const w = (im) => im === "high" ? 3 : im === "low" ? 1 : 2;
      let got = 0, max = 0;
      for (const it of items) { const wt = w(it.impact); max += wt; if (it.resolved) got += wt; }
      return max > 0 ? Math.round(18 * got / max) : 0;
    },
  },

  // F. 依存・連絡待ちを先に起動 max=15（新規・波3・既定OFF）
  {
    id: "dependencies",
    icon: "link",
    label: "依存を先に起動",
    max: 15,
    symptoms: ["依存", "不確実性"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap${it.arrived ? " done" : ""}" data-id="${it.__id}">
          <input type="checkbox" class="es-step-done" data-k="arrived"${it.arrived ? " checked" : ""} aria-label="入手済み" title="入手済み">
          <input class="es-in es-grow" data-k="what" type="text" placeholder="必要なもの（例: 部長承認・APIキー）" value="${esc(it.what || "")}">
          <input class="es-in es-w120" data-k="from" type="text" placeholder="相手/出所" value="${esc(it.from || "")}">
          <input class="es-in es-w64" data-k="leadDays" type="text" inputmode="numeric" placeholder="相手日数" value="${esc(it.leadDays || "")}">
          <input class="es-in es-w120" data-k="neededBy" type="text" placeholder="必要期日" value="${esc(it.neededBy ? dueLabel(it.neededBy) : "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">他者・承認・データ・外部納品など自分が制御できない待ちを最前方で起動。相手のリードタイムを逆算に織り込む（真のボトルネック）。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}依存を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        rowEl.querySelector('[data-k="what"]').addEventListener("input", (e) => { it.what = e.target.value; save(); });
        rowEl.querySelector('[data-k="from"]').addEventListener("input", (e) => { it.from = e.target.value; save(); });
        rowEl.querySelector('[data-k="leadDays"]').addEventListener("input", (e) => { it.leadDays = e.target.value; save(); });
        const nb = rowEl.querySelector('[data-k="neededBy"]');
        nb.addEventListener("change", () => { const iso = smartToIso(nb.value); it.neededBy = iso; nb.value = iso ? dueLabel(iso) : ""; save(); });
        const ar = rowEl.querySelector('[data-k="arrived"]');
        ar.addEventListener("change", () => { it.arrived = ar.checked; save(); rerender(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), what: "", from: "", leadDays: "", neededBy: "", arrived: false });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="what"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) {
      const items = (data.items || []).filter((x) => nonEmpty(x.what));
      if (!items.length) return 0;
      const arr = items.filter((x) => x.arrived).length;
      return arr === items.length ? 15 : Math.floor(15 * (arr / items.length));
    },
  },

  // G. 進捗レビュー・中間ゲート max=10（新規・波3・既定OFF）
  {
    id: "review_cadence",
    icon: "calendarDays",
    label: "中間ゲート定例",
    max: 10,
    symptoms: ["先延ばし", "不確実性"],
    defaults: () => ({ interval: "毎週", checkpoints: [] }),
    render(data) {
      ensureRowIds(data.checkpoints || (data.checkpoints = []));
      const intervals = ["毎日", "2日ごと", "毎週"];
      const intOpts = intervals.map((v) => `<option value="${v}"${(data.interval || "毎週") === v ? " selected" : ""}>${v}</option>`).join("");
      const rows = data.checkpoints.map((c) => `
        <div class="es-row es-wrap" data-id="${c.__id}">
          <input class="es-in es-grow" data-k="title" type="text" placeholder="関門名（例: 中間レビュー）" value="${esc(c.title || "")}">
          <input class="es-in es-w120" data-k="date" type="text" placeholder="日付" value="${esc(c.date ? dueLabel(c.date) : "")}">
          <input class="es-in es-w64" data-k="target_pct" type="text" inputmode="numeric" placeholder="目標%" value="${esc(c.target_pct || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">締切までに到達目標%付きの中間チェックポイントを置き、遅延を小刻みに早期検知して巻き返す。</div>
          <label class="es-sd-f">点検頻度 <select class="es-in es-w120" data-k="interval" aria-label="点検頻度">${intOpts}</select></label>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}チェックポイントを追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      const intEl = root.querySelector('[data-k="interval"]');
      if (intEl) intEl.addEventListener("change", () => { data.interval = intEl.value; save(); });
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const c = data.checkpoints.find((x) => x.__id === rowEl.dataset.id);
        if (!c) return;
        rowEl.querySelector('[data-k="title"]').addEventListener("input", (e) => { c.title = e.target.value; save(); });
        rowEl.querySelector('[data-k="target_pct"]').addEventListener("input", (e) => { c.target_pct = e.target.value; save(); });
        const dt = rowEl.querySelector('[data-k="date"]');
        dt.addEventListener("change", () => { const iso = smartToIso(dt.value); c.date = iso; dt.value = iso ? dueLabel(iso) : ""; save(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.checkpoints.findIndex((x) => x.__id === c.__id);
          if (i >= 0) data.checkpoints.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.checkpoints.push({ __id: uid(), title: "", date: "", target_pct: "" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="title"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.checkpoints || []).some((c) => nonEmpty(c.date)) ? 10 : 0; },
  },

  // H. 早期警告サイン（トリップワイヤー）max=10（新規・波3・既定OFF）
  {
    id: "early_warning",
    icon: "bell",
    label: "早期警告サイン",
    max: 10,
    symptoms: ["発覚遅れ", "停滞放置"],
    defaults: () => ({ stallDays: "3", wires: [] }),
    render(data) {
      ensureRowIds(data.wires || (data.wires = []));
      const inds = [
        ["gate_miss", "中間ゲート未達"], ["buffer_over", "バッファ消費超過"], ["no_progress", "着手後N日無進捗"],
        ["est_over", "見積り超過率"], ["dep_open", "依存タスク未完"],
      ];
      const indOpts = (cur) => inds.map(([v, l]) => `<option value="${v}"${cur === v ? " selected" : ""}>${l}</option>`).join("");
      const rows = data.wires.map((w) => `
        <div class="es-row es-wrap" data-id="${w.__id}">
          <select class="es-in es-w160" data-k="indicator" aria-label="先行指標">${indOpts(w.indicator || "no_progress")}</select>
          <input class="es-in es-w64" data-k="threshold" type="text" placeholder="閾値" value="${esc(w.threshold || "")}">
          <input class="es-in es-grow" data-k="action" type="text" placeholder="踏んだらどうする" value="${esc(w.action || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">「この先行指標がこの閾値を踏んだら手を打つ」を登録し、赤信号で能動的に気づく（遂行率の最後の安全網）。</div>
          <label class="es-sd-f">停滞とみなす無進捗 <input class="es-in es-w64" data-k="stallDays" type="text" inputmode="numeric" value="${esc(data.stallDays || "3")}"> 営業日</label>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}トリップワイヤーを追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      const sd = root.querySelector('[data-k="stallDays"]');
      if (sd) sd.addEventListener("input", () => { data.stallDays = sd.value; save(); });
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const w = data.wires.find((x) => x.__id === rowEl.dataset.id);
        if (!w) return;
        rowEl.querySelector('[data-k="indicator"]').addEventListener("change", (e) => { w.indicator = e.target.value; save(); });
        rowEl.querySelector('[data-k="threshold"]').addEventListener("input", (e) => { w.threshold = e.target.value; save(); });
        rowEl.querySelector('[data-k="action"]').addEventListener("input", (e) => { w.action = e.target.value; save(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.wires.findIndex((x) => x.__id === w.__id);
          if (i >= 0) data.wires.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.wires.push({ __id: uid(), indicator: "no_progress", threshold: "", action: "" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="action"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.wires || []).some((w) => w.indicator && nonEmpty(w.action)) ? 10 : 0; },
  },

  // I. 関係者と根回し max=15（新規・波3・既定OFF）
  {
    id: "stakeholders",
    icon: "network",
    label: "関係者と根回し",
    max: 15,
    symptoms: ["依存", "割り込み"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const sel = (cur, opts, k) => opts.map(([v, l]) => `<option value="${v}"${(cur || opts[0][0]) === v ? " selected" : ""}>${l}</option>`).join("");
      const ROLE = [["decide", "意思決定者"], ["approve", "承認"], ["influence", "影響"], ["support", "協力"]];
      const POW = [["high", "影響大"], ["mid", "中"], ["low", "小"]];
      const STANCE = [["unknown", "不明"], ["pro", "賛成"], ["neutral", "中立"], ["con", "反対"]];
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap${it.done ? " done" : ""}" data-id="${it.__id}">
          <input type="checkbox" class="es-step-done" data-k="done"${it.done ? " checked" : ""} aria-label="接触済み" title="接触済み">
          <input class="es-in es-grow" data-k="name" type="text" placeholder="関係者" value="${esc(it.name || "")}">
          <select class="es-in es-w120" data-k="role" aria-label="役割">${sel(it.role, ROLE)}</select>
          <select class="es-in es-w64" data-k="power" aria-label="影響力">${sel(it.power, POW)}</select>
          <select class="es-in es-w64" data-k="stance" aria-label="立場">${sel(it.stance, STANCE)}</select>
          <input class="es-in es-grow" data-k="action" type="text" placeholder="先回りアクション" value="${esc(it.action || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">成否を左右する関係者を権力×立場で捉え、承認者・意思決定者に先回りで合意形成（承認No/未返答を構造的に封じる）。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}関係者を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        rowEl.querySelector('[data-k="name"]').addEventListener("input", (e) => { it.name = e.target.value; save(); });
        rowEl.querySelector('[data-k="action"]').addEventListener("input", (e) => { it.action = e.target.value; save(); });
        rowEl.querySelector('[data-k="role"]').addEventListener("change", (e) => { it.role = e.target.value; save(); });
        rowEl.querySelector('[data-k="power"]').addEventListener("change", (e) => { it.power = e.target.value; save(); });
        rowEl.querySelector('[data-k="stance"]').addEventListener("change", (e) => { it.stance = e.target.value; save(); });
        const dn = rowEl.querySelector('[data-k="done"]');
        dn.addEventListener("change", () => { it.done = dn.checked; save(); rerender(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), name: "", role: "decide", power: "high", stance: "unknown", action: "", done: false });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="name"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) {
      const items = (data.items || []).filter((x) => nonEmpty(x.name));
      if (!items.length) return 0;
      const done = items.filter((x) => x.done).length;
      return done === items.length ? 15 : Math.floor(15 * (done / items.length));
    },
  },

  // J. 役割分担と委譲 max=15（新規・波3・既定OFF）
  {
    id: "raci_delegate",
    icon: "hand",
    label: "役割分担と委譲",
    max: 15,
    symptoms: ["依存", "燃え尽き"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap${it.delegated ? " done" : ""}" data-id="${it.__id}">
          <input type="checkbox" class="es-step-done" data-k="delegated"${it.delegated ? " checked" : ""} aria-label="委譲済み" title="委譲済み">
          <input class="es-in es-grow" data-k="part" type="text" placeholder="作業/成果物" value="${esc(it.part || "")}">
          <input class="es-in es-w120" data-k="r" type="text" placeholder="R 実行者" value="${esc(it.r || "")}">
          <input class="es-in es-w120" data-k="a" type="text" placeholder="A 最終責任" value="${esc(it.a || "")}">
          <input class="es-in es-w120" data-k="dueRaw" type="text" placeholder="相手期日" value="${esc(it.dueRaw || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">作業ごとに実行者(R)・最終責任(A)を割り当て、自分がRでない部分を相手の期日付きで委譲＝抱え込み(確定遅延)を解消。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}作業を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        ["part", "r", "a", "dueRaw"].forEach((k) => rowEl.querySelector(`[data-k="${k}"]`).addEventListener("input", (e) => { it[k] = e.target.value; save(); }));
        const dl = rowEl.querySelector('[data-k="delegated"]');
        dl.addEventListener("change", () => { it.delegated = dl.checked; save(); rerender(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), part: "", r: "", a: "", dueRaw: "", delegated: false });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="part"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) {
      const items = (data.items || []).filter((x) => nonEmpty(x.part));
      if (!items.length) return 0;
      const del = items.filter((x) => x.delegated).length;
      return del === items.length ? 15 : Math.floor(15 * (del / items.length));
    },
  },

  // K. エスカレーション経路 max=10（新規・波3・既定OFF）
  {
    id: "escalation",
    icon: "trendingUp",
    label: "エスカレーション経路",
    max: 10,
    symptoms: ["依存", "先延ばし"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const CH = [["chat", "チャット"], ["meet", "会議"], ["face", "対面"]];
      const chOpts = (cur) => CH.map(([v, l]) => `<option value="${v}"${(cur || "chat") === v ? " selected" : ""}>${l}</option>`).join("");
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap${it.armed ? " done" : ""}" data-id="${it.__id}">
          <input type="checkbox" class="es-step-done" data-k="armed"${it.armed ? " checked" : ""} aria-label="発動監視ON" title="発動監視ON">
          <input class="es-in es-grow" data-k="waitOn" type="text" placeholder="待っている相手/事柄" value="${esc(it.waitOn || "")}">
          <input class="es-in es-w64" data-k="thresholdDays" type="text" inputmode="numeric" placeholder="上限日" value="${esc(it.thresholdDays || "")}">
          <input class="es-in es-grow" data-k="level1" type="text" placeholder="まず誰へ何で" value="${esc(it.level1 || "")}">
          <select class="es-in es-w120" data-k="channel" aria-label="手段">${chOpts(it.channel)}</select>
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">「N営業日返答が無ければ次は誰へ・どの手段で上げるか」を着手前に固定し、催促の心理的摩擦を事前合意済みルールに置換。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}経路を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        ["waitOn", "thresholdDays", "level1"].forEach((k) => rowEl.querySelector(`[data-k="${k}"]`).addEventListener("input", (e) => { it[k] = e.target.value; save(); }));
        rowEl.querySelector('[data-k="channel"]').addEventListener("change", (e) => { it.channel = e.target.value; save(); });
        const am = rowEl.querySelector('[data-k="armed"]');
        am.addEventListener("change", () => { it.armed = am.checked; save(); rerender(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), waitOn: "", thresholdDays: "", level1: "", channel: "chat", armed: false });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="waitOn"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.items || []).some((x) => nonEmpty(x.waitOn) && nonEmpty(x.level1)) ? 10 : 0; },
  },

  // L. 報連相プラン max=10（新規・波3・既定OFF）
  {
    id: "comms_plan",
    icon: "message",
    label: "報連相プラン",
    max: 10,
    symptoms: ["割り込み", "不確実性"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const TYPE = [["report", "報告"], ["inform", "連絡"], ["consult", "相談"]];
      const CAD = [["adhoc", "都度"], ["daily", "日次"], ["weekly", "週次"], ["ms", "節目"]];
      const sel = (cur, opts) => opts.map(([v, l]) => `<option value="${v}"${(cur || opts[0][0]) === v ? " selected" : ""}>${l}</option>`).join("");
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap" data-id="${it.__id}">
          <input class="es-in es-grow" data-k="audience" type="text" placeholder="相手" value="${esc(it.audience || "")}">
          <select class="es-in es-w64" data-k="type" aria-label="種別">${sel(it.type, TYPE)}</select>
          <input class="es-in es-grow" data-k="content" type="text" placeholder="何を" value="${esc(it.content || "")}">
          <select class="es-in es-w120" data-k="cadence" aria-label="頻度">${sel(it.cadence, CAD)}</select>
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">誰に何をどの頻度で報告/連絡/相談するかを定例化し、情報不足由来の横やり・手戻りを軽い定期同期で前倒し。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}報連相を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        ["audience", "content"].forEach((k) => rowEl.querySelector(`[data-k="${k}"]`).addEventListener("input", (e) => { it[k] = e.target.value; save(); }));
        rowEl.querySelector('[data-k="type"]').addEventListener("change", (e) => { it.type = e.target.value; save(); });
        rowEl.querySelector('[data-k="cadence"]').addEventListener("change", (e) => { it.cadence = e.target.value; save(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), audience: "", type: "report", content: "", cadence: "weekly" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="audience"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.items || []).some((x) => nonEmpty(x.audience) && nonEmpty(x.content)) ? 10 : 0; },
  },

  // M. 撤退・方針転換（Plan-B）max=12（新規・波4・既定OFF）
  {
    id: "kill_pivot",
    icon: "redo",
    label: "撤退・方針転換",
    max: 12,
    symptoms: ["不確実性", "燃え尽き"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const KIND = [["shrink", "縮小"], ["delegate", "委譲"], ["alt", "代替"], ["abort", "撤退"]];
      const kOpts = (cur) => KIND.map(([v, l]) => `<option value="${v}"${(cur || "shrink") === v ? " selected" : ""}>${l}</option>`).join("");
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap" data-id="${it.__id}">
          <input class="es-in es-grow" data-k="trigger" type="text" placeholder="発火条件（例: 6/25に結合テスト通らない）" value="${esc(it.trigger || "")}">
          <input class="es-in es-w120" data-k="checkDate" type="text" placeholder="判定日" value="${esc(it.checkDate ? dueLabel(it.checkDate) : "")}">
          <input class="es-in es-grow" data-k="fallback" type="text" placeholder="代替/縮小案" value="${esc(it.fallback || "")}">
          <select class="es-in es-w120" data-k="kind" aria-label="種別">${kOpts(it.kind)}</select>
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">「この条件・期日に達したら別手段に切替/縮小して締切死守」を着手前に固定。サンクコストで沈むのを防ぐ安全弁。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}撤退条件を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        ["trigger", "fallback"].forEach((k) => rowEl.querySelector(`[data-k="${k}"]`).addEventListener("input", (e) => { it[k] = e.target.value; save(); }));
        rowEl.querySelector('[data-k="kind"]').addEventListener("change", (e) => { it.kind = e.target.value; save(); });
        const cd = rowEl.querySelector('[data-k="checkDate"]');
        cd.addEventListener("change", () => { const iso = smartToIso(cd.value); it.checkDate = iso; cd.value = iso ? dueLabel(iso) : ""; save(); });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), trigger: "", checkDate: "", fallback: "", kind: "shrink" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="trigger"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.items || []).some((x) => nonEmpty(x.trigger) && nonEmpty(x.fallback)) ? 12 : 0; },
  },

  // N. 退路を断つ（約束化）max=10（新規・波4・既定OFF・単一）
  {
    id: "commitment",
    icon: "lock",
    label: "退路を断つ",
    max: 10,
    symptoms: ["先延ばし", "忘却"],
    defaults: () => ({ publicPromise: "", partnerName: "", remindLead: "1日前", checkinDate: "", stakeNote: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">締切や宣言を破ると痛い形にして自分に約束させる（公開宣言・監視者・期限前通知）。現在バイアスの逆を作る。</div>
          <input class="es-in" data-k="publicPromise" type="text" autocomplete="off" placeholder="誰に何を宣言したか（例: 課長に金曜提出と言った）" value="${esc(data.publicPromise || "")}">
          <div class="es-pair">
            <input class="es-in es-grow" data-k="partnerName" type="text" placeholder="進捗を報告する相手（任意）" value="${esc(data.partnerName || "")}">
            <input class="es-in es-w120" data-k="remindLead" type="text" placeholder="通知（例: 1日前）" value="${esc(data.remindLead || "")}">
          </div>
          <input class="es-in" data-k="stakeNote" type="text" autocomplete="off" placeholder="破った時の代償（任意）" value="${esc(data.stakeNote || "")}">
        </div>`;
    },
    wire(root, data, ctx, save) {
      ["publicPromise", "partnerName", "remindLead", "stakeNote"].forEach((k) => {
        const el = root.querySelector(`[data-k="${k}"]`);
        if (el) el.addEventListener("input", () => { data[k] = el.value; save(); });
      });
    },
    score(data) { return nonEmpty(data.publicPromise) ? (nonEmpty(data.remindLead) ? 10 : 5) : 0; },
  },

  // O. 探りスパイク max=8（新規・波4・既定OFF・単一）
  {
    id: "spike",
    icon: "flame",
    label: "探りスパイク",
    max: 8,
    symptoms: ["不確実性", "先延ばし"],
    defaults: () => ({ question: "", box: "2", startWhen: "", finding: "", decision: "continue" }),
    render(data) {
      const DEC = [["continue", "続行"], ["pivot", "方針変更"], ["stop", "中止"]];
      const decOpts = DEC.map(([v, l]) => `<option value="${v}"${(data.decision || "continue") === v ? " selected" : ""}>${l}</option>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">本実装前に「判断に必要な答え」だけを得る使い捨て小実験を時間箱固定で。終了時に学びを記録して打ち切る（沼を物理的に止める）。</div>
          <input class="es-in" data-k="question" type="text" autocomplete="off" placeholder="答えたい問い（例: この量をこのライブラリで捌けるか）" value="${esc(data.question || "")}">
          <div class="es-pair">
            <input class="es-in es-w64" data-k="box" type="text" inputmode="decimal" placeholder="時間箱h" value="${esc(data.box || "")}">
            <input class="es-in es-grow" data-k="startWhen" type="text" placeholder="いつやる" value="${esc(data.startWhen || "")}">
            <select class="es-in es-w120" data-k="decision" aria-label="結論">${decOpts}</select>
          </div>
          <input class="es-in" data-k="finding" type="text" autocomplete="off" placeholder="学び/結論（終了後に記入）" value="${esc(data.finding || "")}">
        </div>`;
    },
    wire(root, data, ctx, save) {
      ["question", "box", "startWhen", "finding"].forEach((k) => {
        const el = root.querySelector(`[data-k="${k}"]`);
        if (el) el.addEventListener("input", () => { data[k] = el.value; save(); });
      });
      const dec = root.querySelector('[data-k="decision"]');
      if (dec) dec.addEventListener("change", () => { data.decision = dec.value; save(); });
    },
    score(data) { return nonEmpty(data.question) ? 8 : 0; },
  },

  // P. 事後ふりかえり（AAR）max=6（新規・波4・既定OFF・単一）
  {
    id: "aar",
    icon: "bookmark",
    label: "事後ふりかえり",
    max: 6,
    symptoms: ["不確実性", "曖昧"],
    defaults: () => ({ intended: "", actual: "", variance: "underest", nextTime: "" }),
    render(data) {
      const VAR = [["underest", "見積り過小"], ["interrupt", "割り込み"], ["dep", "依存遅延"], ["other", "その他"]];
      const vOpts = VAR.map(([v, l]) => `<option value="${v}"${(data.variance || "underest") === v ? " selected" : ""}>${l}</option>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">完了直後に 狙い/実際/差分理由/次回改善 を短く検死し、見積り精度と手法の効きを次タスクへ累積学習。</div>
          <input class="es-in" data-k="intended" type="text" autocomplete="off" placeholder="狙い通りだった点" value="${esc(data.intended || "")}">
          <input class="es-in" data-k="actual" type="text" autocomplete="off" placeholder="実際どうだったか" value="${esc(data.actual || "")}">
          <div class="es-pair">
            <label class="es-sd-f">差分理由 <select class="es-in es-w120" data-k="variance" aria-label="差分理由">${vOpts}</select></label>
          </div>
          <input class="es-in" data-k="nextTime" type="text" autocomplete="off" placeholder="次回への具体改善" value="${esc(data.nextTime || "")}">
        </div>`;
    },
    wire(root, data, ctx, save) {
      ["intended", "actual", "nextTime"].forEach((k) => {
        const el = root.querySelector(`[data-k="${k}"]`);
        if (el) el.addEventListener("input", () => { data[k] = el.value; save(); });
      });
      const v = root.querySelector('[data-k="variance"]');
      if (v) v.addEventListener("change", () => { data.variance = v.value; save(); });
    },
    score(data) { return nonEmpty(data.actual) && nonEmpty(data.nextTime) ? 6 : 0; },
  },

  // Q. 再現手順（Runbook）max=10（新規・波4・既定OFF）
  {
    id: "runbook",
    icon: "file",
    label: "再現手順",
    max: 10,
    symptoms: ["忘却", "割り込み"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const rows = data.items.map((it) => `
        <div class="es-row es-wrap" data-id="${it.__id}">
          <input class="es-in es-grow" data-k="command" type="text" placeholder="実行内容/コマンド" value="${esc(it.command || "")}">
          <input class="es-in es-grow" data-k="expected" type="text" placeholder="期待結果（例: テスト緑）" value="${esc(it.expected || "")}">
          <input class="es-in es-w120" data-k="env" type="text" placeholder="前提環境" value="${esc(it.env || "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-hint">誰がいつ動かしても同じ結果になるよう、前提環境・実行内容・期待出力を明記。再開・引き継ぎの立ち上がりコストをゼロに。</div>
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}手順を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      root.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        ["command", "expected", "env"].forEach((k) => rowEl.querySelector(`[data-k="${k}"]`).addEventListener("input", (e) => { it[k] = e.target.value; save(); }));
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), command: "", expected: "", env: "" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="command"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.items || []).some((x) => nonEmpty(x.command) && nonEmpty(x.expected)) ? 10 : 0; },
  },

  // R. 予行（ドライラン）max=8（新規・波4・既定OFF・単一）
  {
    id: "rehearsal",
    icon: "repeatPlay",
    label: "予行（ドライラン）",
    max: 8,
    symptoms: ["準備不足", "着手の壁"],
    defaults: () => ({ walkthroughDone: false, friction: "", firstMoveTried: false }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">本番前に手順を声出し/紙上で一度通し走行し、詰まる箇所・所要時間・抜けを実地で洗い出して見積りを較正。</div>
          <label class="es-check"><input type="checkbox" data-k="walkthroughDone"${data.walkthroughDone ? " checked" : ""}><span>手順を一度通した（口頭/紙）</span></label>
          <label class="es-check"><input type="checkbox" data-k="firstMoveTried"${data.firstMoveTried ? " checked" : ""}><span>最初の一手を1分だけ実際に試した</span></label>
          <input class="es-in" data-k="friction" type="text" autocomplete="off" placeholder="通しで詰まった箇所" value="${esc(data.friction || "")}">
        </div>`;
    },
    wire(root, data, ctx, save) {
      const wd = root.querySelector('[data-k="walkthroughDone"]');
      if (wd) wd.addEventListener("change", () => { data.walkthroughDone = wd.checked; save(); });
      const fm = root.querySelector('[data-k="firstMoveTried"]');
      if (fm) fm.addEventListener("change", () => { data.firstMoveTried = fm.checked; save(); });
      const fr = root.querySelector('[data-k="friction"]');
      if (fr) fr.addEventListener("input", () => { data.friction = fr.value; save(); });
    },
    score(data) { return (data.walkthroughDone || data.firstMoveTried) ? 8 : 0; },
  },

  // S. 進行中を1つに絞る＋持続ペース max=8（新規・波4・既定OFF・単一）
  {
    id: "wip_pace",
    icon: "hourglass",
    label: "WIP＋持続ペース",
    max: 8,
    symptoms: ["割り込み", "燃え尽き"],
    defaults: () => ({ wipLimit: "1", dailyCapH: "", restEvery: "", noWeekend: false }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">同時着手を絞り1件ずつ完遂。1日上限負荷・休憩リズムで容量超過と燃え尽きを着手前に止める。</div>
          <div class="es-pair">
            <label class="es-sd-f">同時着手上限 <input class="es-in es-w64" data-k="wipLimit" type="text" inputmode="numeric" value="${esc(data.wipLimit || "1")}"></label>
            <label class="es-sd-f">1日上限 <input class="es-in es-w64" data-k="dailyCapH" type="text" inputmode="decimal" placeholder="h" value="${esc(data.dailyCapH || "")}"></label>
            <label class="es-sd-f">休憩間隔 <input class="es-in es-w64" data-k="restEvery" type="text" inputmode="numeric" placeholder="分" value="${esc(data.restEvery || "")}"></label>
          </div>
          <label class="es-check"><input type="checkbox" data-k="noWeekend"${data.noWeekend ? " checked" : ""}><span>週末は入れない</span></label>
        </div>`;
    },
    wire(root, data, ctx, save) {
      ["wipLimit", "dailyCapH", "restEvery"].forEach((k) => {
        const el = root.querySelector(`[data-k="${k}"]`);
        if (el) el.addEventListener("input", () => { data[k] = el.value; save(); });
      });
      const nw = root.querySelector('[data-k="noWeekend"]');
      if (nw) nw.addEventListener("change", () => { data.noWeekend = nw.checked; save(); });
    },
    score(data) { return (nonEmpty(data.dailyCapH) || data.noWeekend || nonEmpty(data.restEvery)) ? 8 : 0; },
  },
];

// 緊急×重要 → 推奨アクション文言（render/wire 共用）。
function eisenhowerActionLabel(data) {
  if (data.important && data.urgent) return "→ 今すぐ着手";
  if (data.important && !data.urgent) return "→ 予定化する";
  if (!data.important && data.urgent) return "→ 委譲する";
  return "→ やめる/後回し";
}

const PLUGIN_BY_ID = Object.fromEntries(PLUGINS.map((p) => [p.id, p]));

// シナリオ別の合理的な手法セット（1クリックで有効化）。pluginIds は順序付き。未実装idは適用時に無視。
const PREP_SETS = [
  { id: "deadline_project", label: "重要締切プロジェクト完遂", scenario: "絶対落とせない大型締切。曖昧・他者依存・ペースのズレ・燃え尽きを全方位で潰す総合布陣", pluginIds: ["commanders_intent","dod","steps","unknowns_register","dependencies","schedule","main_effort","review_cadence","early_warning","kill_pivot"] },
  { id: "vague_big", label: "大きく曖昧なタスクの分解着手", scenario: "何から手をつけるか分からない大きく曖昧なタスク。理解のズレを潰し最小の動く一本から弾みをつける", pluginIds: ["commanders_intent","backbrief","next_step","steps","vertical_slice","dod","schedule"] },
  { id: "interrupt_heavy", label: "割り込み多い環境で死守", scenario: "会議・チャット・突発依頼で集中が断片化。重要タスクの時間を会計的に守り中断から速く復帰", pluginIds: ["mit_today","main_effort","schedule","if_then","wip_pace","comms_plan","commitment"] },
  { id: "dependency_heavy", label: "他者依存・承認待ちが多い", scenario: "承認・レビュー・他部署成果・外部入力が律速。待ちを最前方で起動し放置を防ぐ", pluginIds: ["stakeholders","dependencies","raci_delegate","prereqs","schedule","escalation","comms_plan"] },
  { id: "research", label: "研究・探索タスク", scenario: "答えが見えない/技術検証/終盤に未知が爆発しがち。怖いところを先に触り沼で溶かさない", pluginIds: ["commanders_intent","unknowns_register","spike","dod","kill_pivot","schedule","aar"] },
  { id: "routine", label: "ルーティンを淡々と", scenario: "中身が決まった定常作業を確実に消化。軽量に予定化し再開摩擦と忘却だけ潰す", pluginIds: ["next_step","mit_today","schedule","runbook","if_then"] },
  { id: "high_stakes", label: "失敗できないリスク高タスク", scenario: "失敗コストが極端に高い一発勝負。失敗シナリオを先に潰し早期警告と撤退路を完備", pluginIds: ["commanders_intent","obstacles","unknowns_register","rehearsal","review_cadence","early_warning","kill_pivot","commitment"] },
];

// ── 診断「何が止めてる?」→手法サジェスト ───────────────────────────
// 症状ボタン → 効く手法(pluginId) の明示マップ。
//   PLUGINS の symptoms タグから自動逆引きすると粒度がズレるため、判断軸を明示する。
//   ここに無い pluginId は使わない／PLUGINS に新 id を足しても壊れない（描画時に存在チェック）。
const DIAGNOSTICS = [
  { label: "大きすぎ・曖昧で手がつかない", plugins: ["next_step", "steps"] },
  { label: "やる気はあるが先延ばし", plugins: ["if_then", "schedule"] },
  { label: "段取り・予定が立っていない", plugins: ["steps", "schedule"] },
  { label: "準備不足・イメージが湧かない", plugins: ["prereqs", "dod"] },
  { label: "失敗・中断が不安", plugins: ["obstacles"] },
  { label: "ゴールが曖昧", plugins: ["dod"] },
];
// 実在する pluginId のみへ正規化（存在しない id は黙って落とす＝堅牢化）。
const DIAGNOSTIC_ITEMS = DIAGNOSTICS
  .map((d) => ({ label: d.label, plugins: d.plugins.filter((id) => PLUGIN_BY_ID[id]) }))
  .filter((d) => d.plugins.length > 0);

// ── 手法 ON/OFF（個人・localStorage） ──────────────────────────────
const ENABLED_KEY = "ts.execsupport.enabled";
function loadEnabled() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENABLED_KEY));
    if (Array.isArray(raw)) {
      const set = new Set(raw);
      // 既知 id のみ採用（未知 id は無視）。順序は order に従う（loadOrder で正規化）。
      return loadOrder().filter((id) => set.has(id));
    }
  } catch { /* noop */ }
  // 既定 = defaultOn の手法のみ ON（新規手法はセット/手動で有効化＝既定では meter を膨らませない）。
  return loadOrder().filter((id) => PLUGIN_BY_ID[id] && PLUGIN_BY_ID[id].defaultOn);
}
function saveEnabled(ids) {
  try { localStorage.setItem(ENABLED_KEY, JSON.stringify(ids)); } catch { /* noop */ }
}

// ── 手法の表示順（個人・localStorage） ─────────────────────────────
// pluginId 配列。未知 id は捨て、欠落 id は PLUGINS 定義順で末尾に補う（新プラグイン追加に強い）。
const ORDER_KEY = "ts.execsupport.order";
function normalizeOrder(arr) {
  const known = new Set(PLUGINS.map((p) => p.id));
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(arr) ? arr : []) {
    if (known.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  }
  // 欠落（=保存後に追加された新プラグイン）を定義順で末尾に補完。
  for (const p of PLUGINS) if (!seen.has(p.id)) out.push(p.id);
  return out;
}
function loadOrder() {
  try { return normalizeOrder(JSON.parse(localStorage.getItem(ORDER_KEY))); }
  catch { return PLUGINS.map((p) => p.id); }
}
function saveOrder(ids) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(normalizeOrder(ids))); } catch { /* noop */ }
}

// ── スコア計算 ────────────────────────────────────────────────────
// 有効プラグインのみで score 合計 / max 合計 を取る。返り値 { got, max, pct }。
function computeScore(prep, enabledIds) {
  let got = 0, max = 0;
  for (const id of enabledIds) {
    const p = PLUGIN_BY_ID[id];
    if (!p) continue;
    max += p.max;
    got += clampScore(p.score(prep[id] || p.defaults()), p.max);
  }
  const pct = max > 0 ? Math.round((got / max) * 100) : 0;
  return { got, max, pct };
}

// ── メーター演出（達成感）─────────────────────────────────────────
// pct に応じた段階。tier は CSS クラス suffix（warn/warm/good/full）＝色を切り替える。
//   低(～39)=注意 / 中(40～79)=進行 / 高(80～99)=好調 / 100%=達成（祝祭）。
function meterTier(pct) {
  if (pct >= 100) return "full";
  if (pct >= 80) return "good";
  if (pct >= 40) return "warm";
  return "warn";
}
function meterLabel(pct) {
  if (pct >= 100) return "もう実行されるしかない状態です";
  if (pct >= 80) return "好調・あと少しで満点";
  if (pct >= 40) return "着手の不確実性が下がってきた";
  if (pct > 0) return "まだ埋める余地あり";
  return "まずは「次の一歩」から";
}

// 「次の一手」: 有効プラグインのうち未充足（sc<max）で、埋めると加点が最大（不足 pt が最大）の1つ。
//   全体 max を分母に %換算した加点見込みも返す。100%（=全充足）なら null。
function nextMove(prep, enabledIds) {
  let totalMax = 0;
  for (const id of enabledIds) { const p = PLUGIN_BY_ID[id]; if (p) totalMax += p.max; }
  if (totalMax <= 0) return null;
  let best = null;
  for (const id of enabledIds) {
    const p = PLUGIN_BY_ID[id];
    if (!p) continue;
    const sc = clampScore(p.score(prep[id] || p.defaults()), p.max);
    const gap = p.max - sc;
    if (gap <= 0) continue;
    if (!best || gap > best.gap) best = { id, label: p.label, gap };
  }
  if (!best) return null;
  best.deltaPct = Math.round((best.gap / totalMax) * 100);
  return best;
}

// ── スタイル（1回だけ body/head へ注入） ───────────────────────────
let _mounted = false;
export function ensureStyle() {
  if (_mounted) return;
  if (typeof document === "undefined" || !document.head) return;
  _mounted = true;
  const s = document.createElement("style");
  s.id = "es-style";
  s.textContent = `
  .es{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--ink)}
  .es-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .es-meter{flex:1;min-width:180px}
  .es-meter-h{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
  .es-meter-pct{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--ink);line-height:1}
  .es-meter-lab{font-size:11.5px;color:var(--muted);font-weight:600}
  .es-meter-sub{font-size:10.5px;color:var(--muted);margin-left:auto}
  .es-bar{position:relative;height:10px;background:var(--track);border-radius:6px;overflow:hidden}
  .es-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:#3a86ff;transition:width .25s ease,background .25s ease}
  .es-bar-fill.warn{background:#e5793a}
  .es-bar-fill.warm{background:#3a86ff}
  .es-bar-fill.good{background:#2f9e6b}
  .es-bar-fill.full{background:linear-gradient(90deg,#2fa66b,#37c98a);box-shadow:0 0 0 1px rgba(47,166,107,.45) inset}
  .es-meter-pct.full{color:#2fa66b}
  .es-meter-lab.full{color:#2fa66b}
  .es-meter-done{display:none;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:#2fa66b}
  .es-meter-done.show{display:inline-flex}
  .es-meter-done svg{width:14px;height:14px}
  /* 次の一手ヒント */
  .es-next{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--ink);background:var(--track);border:1px solid var(--line);border-radius:9px;padding:7px 11px}
  .es-next.hide{display:none}
  .es-next-ic{line-height:0;color:var(--fill);flex:none}
  .es-next b{font-weight:700}
  .es-next .es-next-go{margin-left:auto;font:inherit;font-size:11px;font-weight:600;color:var(--fill);background:var(--card);border:1px solid var(--line);border-radius:7px;padding:4px 9px;cursor:pointer;flex:none}
  .es-next .es-next-go:hover{border-color:#b9d4ff}
  .es-gear{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:8px;cursor:pointer;padding:6px 9px;line-height:0}
  .es-gear:hover{color:var(--fill);border-color:#b9d4ff}
  .es-toggles{display:none;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
  .es-toggles.open{display:flex}
  .es-card{border:1px solid var(--line);border-radius:11px;background:var(--card);overflow:hidden}
  .es-chd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--track);border-bottom:1px solid var(--line)}
  .es-chd-ic{line-height:0;color:var(--muted)}
  .es-ctitle{font-size:12.5px;font-weight:700;color:var(--ink)}
  .es-cpts{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--muted);margin-left:auto;font-variant-numeric:tabular-nums}
  .es-cpts.met{color:var(--free,#2fa66b);font-weight:700}
  .es-cpts .es-cpts-ck{display:none;line-height:0}
  .es-cpts.met .es-cpts-ck{display:inline-flex;color:var(--free,#2fa66b)}
  .es-body{padding:11px 12px}
  .es-field{display:flex;flex-direction:column;gap:8px}
  .es-hint{font-size:11px;color:var(--muted);line-height:1.5}
  .es-in{font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);box-sizing:border-box;width:100%}
  .es-in:focus{outline:none;border-color:var(--fill);box-shadow:0 0 0 2px rgba(58,134,255,.16)}
  .es-ta{resize:vertical;min-height:40px;line-height:1.5}
  .es-pair{display:flex;gap:8px;flex-wrap:wrap}
  .es-rows{display:flex;flex-direction:column;gap:7px}
  .es-row{display:flex;align-items:center;gap:7px}
  .es-ord{display:inline-flex;flex-direction:column;gap:2px;flex:none}
  .es-ordb{border:1px solid var(--line);background:var(--card);color:var(--muted);cursor:pointer;padding:1px 3px;border-radius:5px;line-height:0}
  .es-ordb:hover:not(:disabled){color:var(--fill);border-color:#b9d4ff}
  .es-ordb:disabled{opacity:.35;cursor:default}
  .es-grip{color:var(--muted);line-height:0;flex:none}
  .es-arrow{color:var(--muted);line-height:0;flex:none}
  .es-grow{flex:1;min-width:80px}
  .es-w64{width:64px;flex:none}
  .es-w120{width:120px;flex:none}
  .es-w160{width:160px;flex:none}
  .es-row.es-wrap{flex-wrap:wrap}
  .es-rowx{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:3px;border-radius:6px;line-height:0;flex:none}
  .es-rowx:hover{color:var(--over,#e5484d);background:var(--track)}
  .es-row .es-step-done{flex:none;margin:0;cursor:pointer}
  .es-row.done [data-k="title"]{text-decoration:line-through;color:var(--muted)}
  .es-check{display:flex;align-items:center;gap:8px}
  .es-check input[type=checkbox]{margin:0;flex:none}
  .es-check.done .es-check-in{text-decoration:line-through;color:var(--muted)}
  .es-add{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;font-weight:600;color:var(--fill);background:transparent;border:1px dashed var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
  .es-add:hover{border-color:#b9d4ff;background:var(--track)}
  .es-add-ic{transform:rotate(90deg)}
  .es-back{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:2px}
  .es-backbtn{font-size:12px;padding:7px 11px}
  .es-back-hint{font-size:10.5px;color:var(--muted);line-height:1.4;flex:1;min-width:140px}
  /* オーバーコミット早期警告バナー（F3） */
  .es-oc{display:flex;flex-direction:column;gap:6px;border:1px solid var(--over,#e5484d);border-radius:10px;background:rgba(229,72,77,.08);padding:10px 12px;margin-top:4px}
  .es-oc-head{display:flex;align-items:flex-start;gap:7px}
  .es-oc-ic{line-height:0;color:var(--over,#e5484d);flex:none;margin-top:1px}
  .es-oc-msg{font-size:12px;color:var(--ink);line-height:1.5}
  .es-oc-msg b{color:var(--over,#e5484d);font-weight:800;font-variant-numeric:tabular-nums}
  .es-oc-sub{font-size:11px;color:var(--muted);line-height:1.5}
  .es-oc-opts{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
  .es-oc-opts li{font-size:11.5px;color:var(--ink);line-height:1.5}
  html[data-theme="dark"] .es-oc{background:rgba(229,72,77,.14)}
  /* CCPM逆算トグル＋パラメータ＋fever バー */
  .es-ccpm-tg{margin-top:2px}
  .es-ccpm-fields{display:flex;flex-wrap:wrap;gap:10px;margin-top:2px}
  .es-ccpm-f{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted)}
  .es-ccpm-f .es-in{width:56px;flex:none}
  .es-fever{margin-top:6px;border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:var(--track);display:flex;flex-direction:column;gap:5px}
  .es-fever-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .es-fever-t{font-size:12px;color:var(--ink);display:inline-flex;align-items:center;gap:5px}
  .es-fever-t b{font-variant-numeric:tabular-nums}
  .es-fever-sub{font-size:10.5px;color:var(--muted);margin-left:auto}
  .es-fever-bar{position:relative;height:8px;background:var(--line);border-radius:5px;overflow:hidden}
  .es-fever-fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px;transition:width .25s ease,background .25s ease;background:#2f9e6b}
  .es-fever[data-tier="yellow"] .es-fever-fill{background:#e5b73a}
  .es-fever[data-tier="red"] .es-fever-fill{background:#e5484d}
  .es-fever-note{font-size:10.5px;color:var(--muted);line-height:1.45}
  .es-fever[data-tier="red"] .es-fever-note{color:var(--over,#e5484d);font-weight:600}
  .es-unk{display:flex;flex-direction:column;gap:6px;border:1px solid var(--line);border-radius:9px;padding:8px 9px;background:var(--card)}
  .es-unk-hot{border-color:var(--over,#e5484d)}
  .es-unk.done{opacity:.6}
  .es-unk.done [data-k="unknown"]{text-decoration:line-through;color:var(--muted)}
  .es-unk-l1{display:flex;align-items:center;gap:7px}
  .es-unk-l2{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding-left:24px}
  .es-unk .es-unk-res{flex:none;margin:0;cursor:pointer}
  .es-unk-l2 .es-w120{width:120px;flex:none}
  .es-oa{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}
  .es-oa-btn{font-size:12px;padding:6px 11px}
  .es-oa-msg{font-size:11px;color:var(--free,#2fa66b);font-weight:600}
  .es-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px}
  .es-foot-score{font-size:11.5px;color:var(--muted)}
  .es-foot-score b{color:var(--ink);font-variant-numeric:tabular-nums}
  .es-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 13px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink)}
  .es-btn:hover{border-color:#b9d4ff;color:var(--fill)}
  .es-btn.primary{border-color:var(--fill);background:var(--fill);color:#fff}
  .es-btn.primary:hover{filter:brightness(1.05);color:#fff}
  .es-btn:disabled{opacity:.5;cursor:default;filter:none}
  .es-toast{font-size:11.5px;color:var(--free,#2fa66b);font-weight:600}
  .es-down{font-size:11.5px;color:var(--muted);padding:6px 0}
  .es-dx{border:1px solid var(--line);border-radius:11px;background:var(--track);overflow:hidden}
  .es-dx-h{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:transparent;border:0;cursor:pointer;font:inherit;color:var(--ink);text-align:left}
  .es-dx-h:hover{color:var(--fill)}
  .es-dx-ic{line-height:0;color:var(--muted);flex:none}
  .es-dx-h:hover .es-dx-ic{color:var(--fill)}
  .es-dx-t{font-size:12.5px;font-weight:700}
  .es-dx-sub{font-size:10.5px;color:var(--muted);font-weight:500}
  .es-dx-chev{margin-left:auto;line-height:0;color:var(--muted);transition:transform .2s ease}
  .es-dx.open .es-dx-chev{transform:rotate(180deg)}
  .es-dx-body{display:none;flex-wrap:wrap;gap:7px;padding:0 12px 11px}
  .es-dx.open .es-dx-body{display:flex}
  .es-dx-b{font:inherit;font-size:11.5px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;cursor:pointer;line-height:1.3;text-align:left}
  .es-dx-b:hover{border-color:#b9d4ff;color:var(--fill)}
  .es-dx-b:active{transform:translateY(1px)}
  @keyframes es-flash{0%{box-shadow:0 0 0 0 rgba(58,134,255,.55);border-color:var(--fill)}100%{box-shadow:0 0 0 6px rgba(58,134,255,0);border-color:var(--line)}}
  .es-card.es-flash{animation:es-flash 1.4s ease-out;border-color:var(--fill)}
  /* 手法セクション（ON/OFF＋並べ替え） */
  .es-tgl-head{display:flex;align-items:center;gap:6px;width:100%;font-size:11px;font-weight:700;color:var(--muted);margin-bottom:8px;letter-spacing:.02em}
  .es-set-rows{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px}
  .es-set-b{font:inherit;font-size:11.5px;font-weight:600;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;cursor:pointer;text-align:left}
  .es-set-b:hover{border-color:var(--fill);color:var(--fill);background:var(--track)}
  .es-set-b:active{transform:translateY(1px)}
  .es-tgl-rows{display:flex;flex-direction:column;gap:6px}
  .es-tgrow{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 8px}
  .es-tgrow.off{opacity:.6}
  .es-tgrow .es-tg-name{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink);cursor:pointer;user-select:none;flex:1;min-width:0}
  .es-tgrow .es-tg-name input{margin:0;flex:none}
  .es-tgrow .es-tg-ic{line-height:0;color:var(--muted);flex:none}
  .es-tg-ord{display:inline-flex;gap:3px;flex:none}
  .es-tg-ordb{border:1px solid var(--line);background:var(--track);color:var(--muted);cursor:pointer;padding:3px 5px;border-radius:6px;line-height:0}
  .es-tg-ordb:hover:not(:disabled){color:var(--fill);border-color:#b9d4ff}
  .es-tg-ordb:disabled{opacity:.3;cursor:default}
  /* 保護時間帯エディタ */
  .es-pw{border:1px dashed var(--line);border-radius:10px;background:var(--track);padding:11px 12px;display:none;flex-direction:column;gap:9px;margin-top:8px}
  .es-pw.open{display:flex}
  .es-pw-intro{font-size:11px;color:var(--muted);line-height:1.5}
  .es-pw-deny{font-size:11px;color:var(--over,#e5484d);font-weight:600;display:flex;align-items:center;gap:5px}
  .es-pw-deny svg{flex:none}
  .es-pwrows{display:flex;flex-direction:column;gap:9px}
  .es-pwrow{display:flex;flex-direction:column;gap:7px;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:9px 10px}
  .es-pw-top{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .es-pw-dows{display:flex;gap:4px;flex-wrap:wrap}
  .es-pw-dow{font:inherit;font-size:11px;min-width:26px;text-align:center;border:1px solid var(--line);background:var(--track);color:var(--muted);border-radius:6px;padding:4px 6px;cursor:pointer;user-select:none}
  .es-pw-dow.on{background:var(--fill);border-color:var(--fill);color:#fff;font-weight:700}
  .es-pw-dow:disabled{cursor:default}
  .es-pw-time{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted)}
  .es-pw-time input{font:inherit;font-size:12px;padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--ink);box-sizing:border-box}
  .es-pw-kind{font:inherit;font-size:12px;padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--ink)}
  .es-pwx{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:3px;border-radius:6px;line-height:0;margin-left:auto;flex:none}
  .es-pwx:hover:not(:disabled){color:var(--over,#e5484d);background:var(--track)}
  .es-pwx:disabled{opacity:.4;cursor:default}
  .es-pw-empty{font-size:11px;color:var(--muted);padding:4px 0}
  .es-pw-foot{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .es-pw-msg{font-size:11px;font-weight:600}
  .es-pw-msg.ok{color:var(--free,#2fa66b)}
  .es-pw-msg.err{color:var(--over,#e5484d)}
  .es-pw-link{font:inherit;font-size:11.5px;font-weight:600;color:var(--fill);background:transparent;border:0;border-bottom:1px dashed currentColor;padding:0 0 1px;cursor:pointer;align-self:flex-start}
  .es-pw-link:hover{filter:brightness(1.1)}
  html[data-theme="dark"] .es-add:hover,html[data-theme="dark"] .es-gear:hover{background:var(--card)}
  .es-srow{display:flex;flex-direction:column;gap:4px}
  .es-srow.done [data-k="title"]{text-decoration:line-through;color:var(--muted)}
  .es-srow-gate .es-row{box-shadow:-2px 0 0 0 var(--over,#e5484d) inset}
  .es-srow-slice .es-row{box-shadow:-2px 0 0 0 var(--fill,#3a86ff) inset}
  .es-sbs{display:inline-flex;gap:4px;flex:none}
  .es-sbs:empty{display:none}
  .es-sb{display:inline-flex;align-items:center;gap:2px;font-size:10px;font-weight:700;border-radius:5px;padding:1px 5px;line-height:1.6;white-space:nowrap}
  .es-sb-gate{background:rgba(229,72,77,.12);color:var(--over,#e5484d)}
  .es-sb-slice{background:rgba(58,134,255,.12);color:var(--fill,#3a86ff)}
  .es-sb-main{background:rgba(229,183,58,.18);color:#b5860b}
  .es-sb-kind{background:var(--track);color:var(--muted)}
  .es-step-detbtn.es-open{color:var(--fill);transform:rotate(180deg)}
  .es-step-detail{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:4px 8px 4px 30px}
  .es-step-detail[hidden]{display:none}
  .es-step-detail .es-sd-f{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)}
  .es-step-detail .es-sd-c{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ink);cursor:pointer;user-select:none}
  .es-step-detail .es-sd-c input{margin:0}
  .es-sd-gate{min-width:180px}
  .es-hide{display:none !important}`;
  document.head.appendChild(s);
}

// ── デバウンス＋直列保存 ──────────────────────────────────────────
// 400ms デバウンス。保存は直列化（前の保存を待ってから次）＝連打で順序逆転しない。
// prep に score(計算値) を毎回含めて保存。onChange があれば保存後に呼ぶ。
function makeSaver(taskId, getPrepObj, getEnabled, onChange) {
  let timer = null;
  let chain = Promise.resolve();
  let pendingResolve = null;

  const flush = () => {
    timer = null;
    const prep = getPrepObj();
    prep.score = computeScore(prep, getEnabled()).pct;
    const snapshot = JSON.parse(JSON.stringify(prep));
    chain = chain.then(async () => {
      try {
        await savePrep(taskId, snapshot);
        if (typeof onChange === "function") { try { onChange(snapshot); } catch { /* noop */ } }
      } catch { /* exec ダウン時は黙ってスキップ（次の入力で再試行される） */ }
    });
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; chain.then(r); }
  };

  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 400);
  };
  // 即時 flush（フッターのボタン等から「最後の状態を確実に保存」したいとき）。
  save.flushNow = () => new Promise((res) => { pendingResolve = res; if (timer) clearTimeout(timer); flush(); });
  return save;
}

// ── 保護時間帯エディタ（exec の team 設定・prep とは別系統） ─────────
// トラブル想定枠（バッファ/ブロック）の編集 UI。逆算スケジュールがこの枠を尊重する。
// 書き込みは管理者のみ（can_edit=false なら閲覧専用）。exec ダウン時は優しく失敗を握る。
const PW_KINDS = [
  { v: "buffer", label: "バッファ（緩衝）" },
  { v: "block", label: "ブロック（固定）" },
  { v: "deep", label: "ディープワーク（重要専用）" },
];
// 保護枠の正規化（保存・逆算に渡す形）。__id 等の内部キーは落とす。
function pwClean(w) {
  const days = Array.isArray(w.days) ? w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  const kind = (w.kind === "block" || w.kind === "deep") ? w.kind : "buffer";
  const out = { label: String(w.label || "").trim(), days, start: w.start || "", end: w.end || "", kind };
  if (w.id != null && w.id !== "") out.id = w.id;
  return out;
}

// 保護時間帯エディタを host 要素にマウントする。toggle ボタンで開閉。
//   host = エディタを差し込むコンテナ要素。初回オープン時に getSettings を遅延ロード。
function mountProtectedEditor(host) {
  let state = null;     // { windows:[{__id,...}], canEdit } ロード済みか null
  let loading = false;
  let opened = false;

  host.innerHTML = `<div class="es-pw" hidden></div>`;
  const box = host.querySelector(".es-pw");

  const setMsg = (el, text, ok) => {
    el.textContent = text || "";
    el.className = "es-pw-msg" + (text ? (ok ? " ok" : " err") : "");
  };

  const rowHtml = (w, dis) => {
    const dows = DOW_JA.map((lab, d) =>
      `<button type="button" class="es-pw-dow${w.days.includes(d) ? " on" : ""}" data-dow="${d}"
        aria-label="${esc(lab)}曜" aria-pressed="${w.days.includes(d) ? "true" : "false"}"${dis ? " disabled" : ""}>${esc(lab)}</button>`
    ).join("");
    const kinds = PW_KINDS.map((k) =>
      `<option value="${k.v}"${w.kind === k.v ? " selected" : ""}>${esc(k.label)}</option>`
    ).join("");
    return `
      <div class="es-pwrow" data-id="${w.__id}">
        <div class="es-pw-top">
          <input class="es-in es-grow" data-k="label" type="text" placeholder="名称（例: 昼の対応枠）" value="${esc(w.label || "")}"${dis ? " disabled" : ""}>
          <select class="es-pw-kind" data-k="kind" aria-label="種別"${dis ? " disabled" : ""}>${kinds}</select>
          <button type="button" class="es-pwx" data-act="del" aria-label="この保護枠を削除"${dis ? " disabled" : ""}>${icon("x", { size: 15 })}</button>
        </div>
        <div class="es-pw-dows" role="group" aria-label="曜日">${dows}</div>
        <div class="es-pw-time">
          <input data-k="start" type="time" value="${esc(w.start || "")}" aria-label="開始時刻"${dis ? " disabled" : ""}>
          <span aria-hidden="true">〜</span>
          <input data-k="end" type="time" value="${esc(w.end || "")}" aria-label="終了時刻"${dis ? " disabled" : ""}>
        </div>
      </div>`;
  };

  const render = () => {
    if (loading) { box.innerHTML = `<div class="es-pw-intro">読み込み中…</div>`; return; }
    if (!state) {
      box.innerHTML = `<div class="es-pw-deny">${icon("alertTriangle", { size: 14 })} 保護時間帯を読み込めませんでした（保存サービスに接続できません）。</div>`;
      return;
    }
    const dis = !state.canEdit;
    const rows = state.windows.length
      ? state.windows.map((w) => rowHtml(w, dis)).join("")
      : `<div class="es-pw-empty">保護時間帯はまだありません。${dis ? "" : "「追加」で作成できます。"}</div>`;
    box.innerHTML = `
      <div class="es-pw-intro">トラブルが来やすい時間帯（例: 昼の対応）を保護し、重要タスクをそこに置かない／バッファを確保します。逆算スケジュールがこの枠を避けて作業日を割り当てます。ディープワーク枠は逆に、優先度の高い重要タスクの逆算だけが使える集中時間です。</div>
      ${dis ? `<div class="es-pw-deny">${icon("lock", { size: 14 })} 保護時間帯の編集は管理者のみです（閲覧のみ可能）。</div>` : ""}
      <div class="es-pwrows">${rows}</div>
      <div class="es-pw-foot">
        ${dis ? "" : `<button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}保護時間帯を追加</button>`}
        ${dis ? "" : `<button type="button" class="es-btn primary" data-act="save">${icon("save", { size: 14 })}保存</button>`}
        <span class="es-pw-msg" data-msg></span>
      </div>`;
    if (!dis) wireRows();
  };

  const wireRows = () => {
    const msg = box.querySelector("[data-msg]");
    box.querySelectorAll(".es-pwrow").forEach((rowEl) => {
      const w = state.windows.find((x) => x.__id === rowEl.dataset.id);
      if (!w) return;
      rowEl.querySelector('[data-k="label"]').addEventListener("input", (e) => { w.label = e.target.value; setMsg(msg, ""); });
      rowEl.querySelector('[data-k="kind"]').addEventListener("change", (e) => { w.kind = e.target.value; setMsg(msg, ""); });
      rowEl.querySelector('[data-k="start"]').addEventListener("change", (e) => { w.start = e.target.value; setMsg(msg, ""); });
      rowEl.querySelector('[data-k="end"]').addEventListener("change", (e) => { w.end = e.target.value; setMsg(msg, ""); });
      rowEl.querySelectorAll(".es-pw-dow").forEach((db) => {
        db.addEventListener("click", () => {
          const d = +db.dataset.dow;
          const on = w.days.includes(d);
          if (on) w.days = w.days.filter((x) => x !== d); else w.days.push(d);
          db.classList.toggle("on", !on);
          db.setAttribute("aria-pressed", !on ? "true" : "false");
          setMsg(msg, "");
        });
      });
      rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
        const i = state.windows.findIndex((x) => x.__id === w.__id);
        if (i >= 0) state.windows.splice(i, 1);
        render();
      });
    });
    const addBtn = box.querySelector('[data-act="add"]');
    if (addBtn) addBtn.addEventListener("click", () => {
      state.windows.push({ __id: uid(), label: "", days: [], start: "12:00", end: "13:00", kind: "buffer" });
      render();
      const last = box.querySelectorAll('.es-pwrow [data-k="label"]');
      if (last.length) last[last.length - 1].focus();
    });
    const saveBtn = box.querySelector('[data-act="save"]');
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      if (saveBtn.dataset.busy === "1") return;
      saveBtn.dataset.busy = "1"; saveBtn.disabled = true;
      setMsg(msg, "保存中…", true);
      try {
        const payload = state.windows.map(pwClean);
        const res = await saveProtectedWindows(payload);
        const saved = (res && res.settings && res.settings.protected_windows) || payload;
        state.windows = saved.map((w) => ({ __id: uid(), ...pwClean(w) }));
        render();
        const m2 = box.querySelector("[data-msg]");
        setMsg(m2, "保存しました。逆算スケジュールに反映されます。", true);
      } catch {
        setMsg(msg, "保存に失敗しました（権限または接続をご確認ください）。", false);
      } finally {
        saveBtn.dataset.busy = ""; saveBtn.disabled = false;
      }
    });
  };

  const ensureLoaded = async () => {
    if (state || loading) return;
    loading = true; render();
    try {
      const d = await getSettings();
      const windows = ((d && d.settings) || {}).protected_windows || [];
      state = {
        windows: windows.map((w) => ({ __id: uid(), ...pwClean(w) })),
        canEdit: !!(d && d.can_edit),
      };
    } catch {
      state = null;
    } finally {
      loading = false; render();
    }
  };

  return {
    toggle: async () => {
      opened = !opened;
      box.toggleAttribute("hidden", !opened);
      box.classList.toggle("open", opened);
      if (opened) await ensureLoaded();
      return opened;
    },
    isOpen: () => opened,
  };
}

// ── メイン描画 ────────────────────────────────────────────────────
export async function renderExecSupport(container, { taskId, task = null, onChange } = {}) {
  ensureStyle();
  // ctx は各プラグインへ渡る共有文脈。逆算スケジュールが steps を読み書き＋再描画するため
  // prep 参照と単一カードの再描画フックを載せる（他プラグインは無視＝後方互換）。
  const ctx = { taskId, task };

  // 既存 prep を取得（失敗＝exec ダウンでも空状態で続行）。
  let prep = {};
  let execDown = false;
  try {
    const d = await getPrep(taskId);
    prep = (d && d.prep) ? d.prep : {};
  } catch {
    execDown = true;
    prep = {};
  }
  if (!prep || typeof prep !== "object") prep = {};

  // 各プラグインの data を既定で穴埋め（未定義キーを安全に）。
  for (const p of PLUGINS) {
    if (prep[p.id] == null || typeof prep[p.id] !== "object") prep[p.id] = p.defaults();
  }

  let enabled = loadEnabled();
  const getEnabled = () => enabled;
  const save = makeSaver(taskId, () => prep, getEnabled, onChange);

  // ── メーター更新（プラグイン値が変わるたび即時） ──
  const updateMeter = () => {
    const { got, max, pct } = computeScore(prep, enabled);
    const tier = meterTier(pct);
    const isFull = pct >= 100;
    const fill = container.querySelector(".es-bar-fill");
    const bar = container.querySelector(".es-bar");
    const pctEl = container.querySelector(".es-meter-pct");
    const labEl = container.querySelector(".es-meter-lab");
    const subEl = container.querySelector(".es-meter-sub");
    const doneEl = container.querySelector(".es-meter-done");
    const footEl = container.querySelector(".es-foot-score b");
    if (fill) {
      fill.style.width = pct + "%";
      // 段階クラスを排他更新（warn/warm/good/full）。
      fill.classList.remove("warn", "warm", "good", "full");
      fill.classList.add(tier);
    }
    if (bar) bar.setAttribute("aria-valuenow", String(pct));
    if (pctEl) { pctEl.textContent = pct + "%"; pctEl.classList.toggle("full", isFull); }
    if (labEl) { labEl.textContent = meterLabel(pct); labEl.classList.toggle("full", isFull); }
    if (subEl) subEl.textContent = `${got} / ${max} pt`;
    if (doneEl) { doneEl.classList.toggle("show", isFull); doneEl.setAttribute("aria-hidden", isFull ? "false" : "true"); }
    if (footEl) footEl.textContent = `${got} / ${max} pt（${pct}%）`;
    // 各カードの達成バッジも更新（pt 数だけ差し替え・check アイコン span は残す）。
    for (const id of enabled) {
      const p = PLUGIN_BY_ID[id];
      const badge = container.querySelector(`.es-card[data-pid="${id}"] .es-cpts`);
      if (!badge || !p) continue;
      const sc = clampScore(p.score(prep[id] || p.defaults()), p.max);
      const ck = badge.querySelector(".es-cpts-ck");
      badge.textContent = `${sc} / ${p.max} pt`;
      if (ck) badge.appendChild(ck); // textContent でクリアされた check を戻す
      badge.classList.toggle("met", sc >= p.max);
    }
    // 「次の一手」ヒントを更新。
    refreshNext();
  };

  // 次の一手ヒントを再計算して描き替える（100%＝未充足なし なら隠す）。
  const refreshNext = () => {
    const nextEl = container.querySelector("#es-next");
    if (!nextEl) return;
    const nm = nextMove(prep, enabled);
    if (!nm) { nextEl.classList.add("hide"); return; }
    nextEl.classList.remove("hide");
    const txt = nextEl.querySelector(".es-next-txt");
    if (txt) txt.innerHTML = `次の一手: <b>${esc(nm.label)}</b> を埋めると +${nm.deltaPct}%`;
    const go = nextEl.querySelector(".es-next-go");
    if (go) go.dataset.next = nm.id;
  };

  // save をラップして「保存＋メーター即更新」をひとまとめに（各プラグインに渡す save）。
  const saveAndMeter = () => { updateMeter(); save(); };
  saveAndMeter.flushNow = save.flushNow;

  // 有効プラグインを表示順（order→enabled）で返す。
  const orderedEnabled = () => loadOrder().filter((id) => enabled.includes(id));

  // ── カード群 HTML ──（order→enabled の順で並べる）
  const cardsHtml = () => orderedEnabled().map((id) => {
    const p = PLUGIN_BY_ID[id];
    if (!p) return "";
    const sc = clampScore(p.score(prep[id] || p.defaults()), p.max);
    return `
      <section class="es-card" data-pid="${p.id}">
        <header class="es-chd">
          <span class="es-chd-ic">${icon(p.icon, { size: 16 })}</span>
          <span class="es-ctitle">${esc(p.label)}</span>
          <span class="es-cpts${sc >= p.max ? " met" : ""}">${sc} / ${p.max} pt<span class="es-cpts-ck">${icon("check", { size: 13 })}</span></span>
        </header>
        <div class="es-body" data-body="${p.id}"></div>
      </section>`;
  }).join("");

  // ── 診断「何が止めてる?」HTML ──
  // 折りたたみ可能。症状ボタンを押すと該当手法を有効化＋スクロール＋ハイライト。
  const diagnosticsHtml = () => {
    if (!DIAGNOSTIC_ITEMS.length) return "";
    const btns = DIAGNOSTIC_ITEMS.map((d, i) =>
      `<button type="button" class="es-dx-b" data-dx="${i}">${esc(d.label)}</button>`
    ).join("");
    return `
      <div class="es-dx" id="es-dx">
        <button type="button" class="es-dx-h" id="es-dx-h" aria-expanded="false" aria-controls="es-dx-body">
          <span class="es-dx-ic">${icon("lightbulb", { size: 16 })}</span>
          <span class="es-dx-t">何が止めてる?</span>
          <span class="es-dx-sub">症状を選ぶと、効く手法に案内します</span>
          <span class="es-dx-chev">${icon("chevronDown", { size: 15 })}</span>
        </button>
        <div class="es-dx-body" id="es-dx-body">${btns}</div>
      </div>`;
  };

  // ── 手法セクション（ON/OFF＋並べ替え）HTML ──
  // 並び＝表示順（order）。↑↓で順序入替（localStorage ts.execsupport.order に保存）。
  const togglesHtml = () => {
    const ord = loadOrder();
    const n = ord.length;
    const rows = ord.map((id, i) => {
      const p = PLUGIN_BY_ID[id];
      if (!p) return "";
      const on = enabled.includes(id);
      return `<div class="es-tgrow${on ? "" : " off"}" data-pid="${id}">
        <span class="es-tg-ord">
          <button type="button" class="es-tg-ordb" data-ord="up" aria-label="${esc(p.label)}を上へ"${i === 0 ? " disabled" : ""}>${icon("arrowUp", { size: 12 })}</button>
          <button type="button" class="es-tg-ordb" data-ord="down" aria-label="${esc(p.label)}を下へ"${i === n - 1 ? " disabled" : ""}>${icon("chevronDown", { size: 12 })}</button>
        </span>
        <label class="es-tg-name">
          <input type="checkbox" data-tg="${id}"${on ? " checked" : ""} aria-label="${esc(p.label)}を有効にする">
          <span class="es-tg-ic">${icon(p.icon, { size: 14 })}</span>
          ${esc(p.label)}
        </label>
      </div>`;
    }).join("");
    const setBtns = PREP_SETS
      .filter((s) => s.pluginIds.some((id) => PLUGIN_BY_ID[id]))
      .map((s) => `<button type="button" class="es-set-b" data-set="${esc(s.id)}" title="${esc(s.scenario)}">${esc(s.label)}</button>`)
      .join("");
    return `<div class="es-tgl-head">${icon("listChecks", { size: 13 })} シナリオ別セット（1クリックで布陣）</div>
      <div class="es-set-rows">${setBtns}</div>
      <div class="es-tgl-head" style="margin-top:12px">${icon("settings", { size: 13 })} 手法の取捨と表示順</div>
      <div class="es-tgl-rows">${rows}</div>`;
  };

  const { got, max, pct } = computeScore(prep, enabled);
  const tier0 = meterTier(pct);
  const nm0 = nextMove(prep, enabled);

  container.innerHTML = `
    <div class="es">
      <div class="es-top">
        <div class="es-meter">
          <div class="es-meter-h">
            <span class="es-meter-pct${pct >= 100 ? " full" : ""}">${pct}%</span>
            <span class="es-meter-lab${pct >= 100 ? " full" : ""}">${esc(meterLabel(pct))}</span>
            <span class="es-meter-done${pct >= 100 ? " show" : ""}" aria-hidden="${pct >= 100 ? "false" : "true"}">${icon("check", { size: 14 })}達成</span>
            <span class="es-meter-sub">${got} / ${max} pt</span>
          </div>
          <div class="es-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="実行可能性メーター">
            <div class="es-bar-fill ${tier0}" style="width:${pct}%"></div>
          </div>
        </div>
        <button type="button" class="es-gear" id="es-gear" aria-label="手法のON/OFF" title="手法のON/OFF">${icon("settings", { size: 16 })}</button>
      </div>
      <div class="es-next${nm0 ? "" : " hide"}" id="es-next">
        <span class="es-next-ic">${icon("lightbulb", { size: 14 })}</span>
        <span class="es-next-txt">${nm0 ? `次の一手: <b>${esc(nm0.label)}</b> を埋めると +${nm0.deltaPct}%` : ""}</span>
        ${nm0 ? `<button type="button" class="es-next-go" data-next="${esc(nm0.id)}">ここへ</button>` : ""}
      </div>
      <div class="es-toggles" id="es-toggles">${togglesHtml()}</div>
      ${diagnosticsHtml()}
      ${execDown ? `<div class="es-down">${icon("alertTriangle", { size: 13 })} 保存サービスに接続できません。入力はこの画面では反映されますが、保存されない可能性があります。</div>` : ""}
      <div class="es-cards" id="es-cards">${cardsHtml()}</div>
      <div class="es-foot">
        <span class="es-foot-score"><b>${got} / ${max} pt（${pct}%）</b></span>
        <button type="button" class="es-btn" id="es-book">${icon("calendar", { size: 15 })}カレンダーに予約</button>
        <button type="button" class="es-btn primary" id="es-go">${icon("play", { size: 15 })}今すぐ着手</button>
        <span class="es-toast" id="es-toast"></span>
      </div>
    </div>`;

  // ── 各プラグインを汎用ループで render → wire ──
  const wireCard = (p) => {
    const body = container.querySelector(`[data-body="${p.id}"]`);
    if (!body) return;
    body.innerHTML = p.render(prep[p.id], ctx);
    try { p.wire(body, prep[p.id], ctx, saveAndMeter); } catch { /* 1プラグインの不具合で全体を壊さない */ }
  };
  const wireCards = () => {
    for (const p of PLUGINS.filter((x) => enabled.includes(x.id))) wireCard(p);
  };
  // 逆算スケジュール → steps[].due 反映後に段取りカードだけ再描画させるフック。
  ctx.prep = prep;
  ctx.rerenderCard = (id) => {
    const p = PLUGIN_BY_ID[id];
    if (p && enabled.includes(id)) wireCard(p);
  };
  wireCards();

  // ── 手法セクション（歯車で開閉・ON/OFF・並べ替え）配線 ──
  const gear = container.querySelector("#es-gear");
  const togglesBox = container.querySelector("#es-toggles");
  gear.addEventListener("click", () => togglesBox.classList.toggle("open"));

  // 有効集合を「表示順」で正規化（order に従い enabled を並べ替え）。
  const normEnabled = () => { enabled = loadOrder().filter((id) => enabled.includes(id)); };

  // カード群を再構築（有効集合・順序が変わったとき）。
  const rebuildCards = () => {
    container.querySelector("#es-cards").innerHTML = cardsHtml();
    wireCards();
    updateMeter();
  };
  // 手法パネルを再描画＋再配線（順序変更で↑↓の disabled も更新するため作り直す）。
  const rebuildToggles = () => {
    togglesBox.innerHTML = togglesHtml();
    wireToggles();
  };

  function wireToggles() {
    togglesBox.querySelectorAll("[data-tg]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.tg;
        if (cb.checked) { if (!enabled.includes(id)) enabled.push(id); }
        else { enabled = enabled.filter((x) => x !== id); }
        normEnabled();
        saveEnabled(enabled);
        const row = cb.closest(".es-tgrow");
        if (row) row.classList.toggle("off", !cb.checked);
        rebuildCards();
        save(); // score 再計算分を保存
      });
    });
    // 並べ替え（↑↓）: order を入替えて保存 → 両パネル＋カードを再構築。
    togglesBox.querySelectorAll("[data-ord]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const row = btn.closest(".es-tgrow");
        const id = row && row.dataset.pid;
        if (!id) return;
        const ord = loadOrder();
        const i = ord.indexOf(id);
        const j = btn.dataset.ord === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= ord.length) return;
        const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
        saveOrder(ord);
        normEnabled();
        rebuildToggles();
        rebuildCards();
      });
    });
    // シナリオ別セット: 押すと該当手法だけを順序付きで有効化（未実装idは無視）。順序も配列順に整える。
    togglesBox.querySelectorAll("[data-set]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const set = PREP_SETS.find((s) => s.id === btn.dataset.set);
        if (!set) return;
        const ids = set.pluginIds.filter((id) => PLUGIN_BY_ID[id]); // 実在のみ
        if (!ids.length) return;
        // 並び順: セットの手法を先頭に（セット順）、残りの既知手法を従来順で後ろに。
        const rest = loadOrder().filter((id) => !ids.includes(id));
        const newOrder = [...ids, ...rest];
        saveOrder(newOrder);
        enabled = ids.slice();          // 有効集合 = セットの手法に置き換え
        normEnabled();                  // order に従い正規化（既存ヘルパ）
        saveEnabled(enabled);
        rebuildToggles();               // トグルパネル再描画（チェック状態・順序反映）
        rebuildCards();                 // カード群再構築＋updateMeter（既存）
        save();                         // score 再計算分を保存（既存と同様）
      });
    });
  }
  wireToggles();

  // ── 「次の一手」ヒントの「ここへ」配線（委譲・ボタンは更新で差し替わるため） ──
  const nextEl = container.querySelector("#es-next");
  if (nextEl) {
    nextEl.addEventListener("click", (e) => {
      const go = e.target.closest && e.target.closest(".es-next-go");
      if (!go) return;
      const id = go.dataset.next;
      if (!id) return;
      const card = container.querySelector(`.es-card[data-pid="${id}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.remove("es-flash"); void card.offsetWidth; card.classList.add("es-flash");
      setTimeout(() => card.classList.remove("es-flash"), 1500);
      const main = card.querySelector(".es-body input, .es-body textarea");
      if (main) { try { main.focus({ preventScroll: true }); } catch { main.focus(); } }
    });
  }

  // ── 診断「何が止めてる?」配線 ──
  // 折りたたみトグル＋症状ボタン（症状→手法を有効化＆スクロール＆ハイライト）。
  const dxBox = container.querySelector("#es-dx");
  if (dxBox) {
    const dxHead = container.querySelector("#es-dx-h");
    dxHead.addEventListener("click", () => {
      const open = dxBox.classList.toggle("open");
      dxHead.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // pluginId を必要なら有効化（トグルの change を発火＝カード再構築・保存まで一括）。
    const ensureEnabled = (id) => {
      if (enabled.includes(id)) return false;
      const cb = container.querySelector(`[data-tg="${id}"]`);
      if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change")); return true; }
      return false;
    };

    dxBox.querySelectorAll("[data-dx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = DIAGNOSTIC_ITEMS[+btn.dataset.dx];
        if (!item) return;
        // 1) 無効な手法を有効化（複数該当ならすべて）。enabled に残るものだけ対象に。
        const targets = item.plugins.filter((id) => PLUGIN_BY_ID[id]);
        let activated = false;
        for (const id of targets) { if (ensureEnabled(id)) activated = true; }

        // 2) 対応カードへスクロール（先頭）＋ハイライト（全該当）。
        //    有効化直後は #es-cards が再構築されるので、反映を待ってから DOM を引く。
        const flash = () => {
          const cards = targets
            .map((id) => container.querySelector(`.es-card[data-pid="${id}"]`))
            .filter(Boolean);
          if (!cards.length) return;
          cards[0].scrollIntoView({ block: "center", behavior: "smooth" });
          for (const c of cards) {
            c.classList.remove("es-flash");
            // reflow を挟んで再度アニメ発火（連打でも毎回光るように）。
            void c.offsetWidth;
            c.classList.add("es-flash");
            setTimeout(() => c.classList.remove("es-flash"), 1500);
          }
          // 3) 先頭カードの主入力へフォーカス（任意・あれば）。
          const main = cards[0].querySelector(".es-body input, .es-body textarea");
          if (main) { try { main.focus({ preventScroll: true }); } catch { main.focus(); } }
        };
        if (activated) requestAnimationFrame(flash); else flash();
      });
    });
  }

  // ── フッター ──
  const toast = container.querySelector("#es-toast");
  const showToast = (msg) => {
    toast.textContent = msg;
    setTimeout(() => { if (toast.textContent === msg) toast.textContent = ""; }, 2400);
  };

  container.querySelector("#es-book").addEventListener("click", () => {
    // 予定化プラグインが OFF なら ON にしてから due へフォーカス。
    if (!enabled.includes("schedule")) {
      const cb = container.querySelector('[data-tg="schedule"]');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
    }
    const due = container.querySelector('.es-card[data-pid="schedule"] .es-due');
    if (due) { due.focus(); due.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  });

  const goBtn = container.querySelector("#es-go");
  goBtn.addEventListener("click", async () => {
    if (goBtn.dataset.busy === "1") return;
    goBtn.dataset.busy = "1"; goBtn.disabled = true;
    try {
      // 1) ステータスを「進行中」に（着手時刻セット・既に着手済みなら冪等で何もしない）。
      if (ctx.taskId != null) { try { await setTaskStarted(ctx.task || ctx.taskId); } catch { /* API ダウンでも続行 */ } }
      // 2) 集中タイマー（ポモドーロ）を開始（動的 import で遅延ロード・循環回避）。
      try { const pm = await import("./pomodoro.js"); pm.startFocusFor(ctx.taskId, ctx.task && ctx.task.title); } catch { /* ポモ未マウント等は無視 */ }
      const next = (prep.next_step && prep.next_step.text || "").trim();
      showToast(next
        ? `着手しました（進行中・ポモ開始）: ${next.length > 22 ? next.slice(0, 21) + "…" : next}`
        : "着手しました（進行中・ポモ開始）");
    } finally {
      goBtn.dataset.busy = ""; goBtn.disabled = false;
    }
  });

  // 念のため初期メーターを同期（render とズレないように）。
  updateMeter();
}
