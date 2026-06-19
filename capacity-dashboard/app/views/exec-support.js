// 着手準備パネル（実行リハーサル）= 実行サポート フレームワーク。
// 手法を「プラグイン」として登録し、有効なプラグインを汎用ループで描画する。
// 埋まり具合を実行可能性メーター(0〜100%)で可視化。保存は exec の per-task ストア(/prep/:taskId)。
//
// 設計の肝: PLUGINS レジストリ（自己記述オブジェクトの配列）を filter(enabled) して順に
//   render → wire。後からプラグインを足すだけで増やせる（個別ベタ書きにしない）。
//
// 仕様: docs/exec-support-spec.md。データ形は固定（taskform/将来の一覧が依存）:
//   prep = { next_step, steps, schedule, if_then, prereqs, obstacles, dod, score }
import { getPrep, savePrep } from "../lib/exec.js";
import { updateTask } from "../lib/api.js";
import { esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { fmtDisplayDow, parseSmartDate } from "../lib/form.js";

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

const PLUGINS = [
  // 1. 次の一歩（最小着手）max=20
  {
    id: "next_step",
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
    label: "段取り",
    icon: "listChecks",
    max: 15,
    symptoms: ["大きすぎ", "曖昧"],
    defaults: () => ({ items: [] }),
    render(data) {
      ensureRowIds(data.items || (data.items = []));
      const rows = data.items.map((it) => `
        <div class="es-row" data-id="${it.__id}">
          <span class="es-grip" aria-hidden="true">${icon("list", { size: 13 })}</span>
          <input class="es-in es-grow" data-k="title" type="text" placeholder="手順" value="${esc(it.title || "")}">
          <input class="es-in es-w64" data-k="est" type="text" inputmode="decimal" placeholder="見積h" value="${esc(it.est || "")}">
          <input class="es-in es-w120" data-k="due" type="text" placeholder="期日" value="${esc(it.due ? dueLabel(it.due) : "")}">
          <button type="button" class="es-rowx" data-act="del" aria-label="この手順を削除">${icon("x", { size: 14 })}</button>
        </div>`).join("");
      return `
        <div class="es-field">
          <div class="es-rows">${rows}</div>
          <button type="button" class="es-add" data-act="add">${icon("arrowUp", { size: 13, cls: "es-add-ic" })}手順を追加</button>
        </div>`;
    },
    wire(root, data, ctx, save) {
      const list = root.querySelector(".es-rows");
      const rerender = () => { root.querySelector(".es-field").outerHTML = this.render(data); this.wire(root, data, ctx, save); };
      list.querySelectorAll(".es-row").forEach((rowEl) => {
        const it = data.items.find((x) => x.__id === rowEl.dataset.id);
        if (!it) return;
        rowEl.querySelector('[data-k="title"]').addEventListener("input", (e) => { it.title = e.target.value; save(); });
        rowEl.querySelector('[data-k="est"]').addEventListener("input", (e) => { it.est = e.target.value; save(); });
        const dueEl = rowEl.querySelector('[data-k="due"]');
        dueEl.addEventListener("change", () => {
          const iso = smartToIso(dueEl.value);
          it.due = iso;
          dueEl.value = iso ? dueLabel(iso) : "";
          save();
        });
        rowEl.querySelector('[data-act="del"]').addEventListener("click", () => {
          const i = data.items.findIndex((x) => x.__id === it.__id);
          if (i >= 0) data.items.splice(i, 1);
          save(); rerender();
        });
      });
      root.querySelector('[data-act="add"]').addEventListener("click", () => {
        data.items.push({ __id: uid(), title: "", est: "", due: "" });
        save(); rerender();
        const inputs = root.querySelectorAll('.es-row [data-k="title"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    },
    score(data) { return (data.items || []).some((x) => nonEmpty(x.title)) ? 15 : 0; },
  },

  // 3. 予定化・スケジュール max=15（due 変更時は updateTask で本体期日にも反映）
  {
    id: "schedule",
    label: "予定化",
    icon: "calendar",
    max: 15,
    symptoms: ["計画が予定に落ちてない"],
    defaults: () => ({ due: "", note: "" }),
    render(data) {
      return `
        <div class="es-field">
          <div class="es-hint">いつやるか日付を決める。設定するとタスク本体の期日にも反映されます。</div>
          <div class="es-pair">
            <input class="es-in es-w160 es-due" data-k="due" type="text" autocomplete="off"
              placeholder="期日（例: 612）" value="${esc(data.due ? dueLabel(data.due) : "")}">
            <input class="es-in es-grow" data-k="note" type="text" autocomplete="off"
              placeholder="メモ（任意・どの枠に入れる等）" value="${esc(data.note || "")}">
          </div>
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
    },
    score(data) { return nonEmpty(data.due) ? 15 : 0; },
  },

  // 4. if-then トリガー max=15（両方=15 / 片方=7 / 無し=0）
  {
    id: "if_then",
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
];

const PLUGIN_BY_ID = Object.fromEntries(PLUGINS.map((p) => [p.id, p]));

// ── 手法 ON/OFF（個人・localStorage） ──────────────────────────────
const ENABLED_KEY = "ts.execsupport.enabled";
function loadEnabled() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENABLED_KEY));
    if (Array.isArray(raw)) {
      const set = new Set(raw);
      // 既知 id のみ採用（未知 id は無視）。
      return PLUGINS.filter((p) => set.has(p.id)).map((p) => p.id);
    }
  } catch { /* noop */ }
  return PLUGINS.map((p) => p.id); // 既定 = 全部 ON
}
function saveEnabled(ids) {
  try { localStorage.setItem(ENABLED_KEY, JSON.stringify(ids)); } catch { /* noop */ }
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

function meterLabel(pct) {
  if (pct >= 100) return "実行されるしかない状態";
  if (pct >= 75) return "ほぼ準備完了";
  if (pct >= 40) return "着手の不確実性が下がってきた";
  if (pct > 0) return "まだ埋める余地あり";
  return "まずは「次の一歩」から";
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
  .es-bar-fill.warm{background:#f5a623}
  .es-bar-fill.full{background:#2fa66b}
  .es-gear{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:8px;cursor:pointer;padding:6px 9px;line-height:0}
  .es-gear:hover{color:var(--fill);border-color:#b9d4ff}
  .es-toggles{display:none;flex-wrap:wrap;gap:6px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
  .es-toggles.open{display:flex}
  .es-tg{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 9px;cursor:pointer;user-select:none}
  .es-tg input{margin:0}
  .es-tg.off{opacity:.55}
  .es-card{border:1px solid var(--line);border-radius:11px;background:var(--card);overflow:hidden}
  .es-chd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--track);border-bottom:1px solid var(--line)}
  .es-chd-ic{line-height:0;color:var(--muted)}
  .es-ctitle{font-size:12.5px;font-weight:700;color:var(--ink)}
  .es-cpts{font-size:10.5px;color:var(--muted);margin-left:auto;font-variant-numeric:tabular-nums}
  .es-cpts.met{color:var(--free,#2fa66b);font-weight:700}
  .es-body{padding:11px 12px}
  .es-field{display:flex;flex-direction:column;gap:8px}
  .es-hint{font-size:11px;color:var(--muted);line-height:1.5}
  .es-in{font:inherit;font-size:12.5px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);box-sizing:border-box;width:100%}
  .es-in:focus{outline:none;border-color:var(--fill);box-shadow:0 0 0 2px rgba(58,134,255,.16)}
  .es-ta{resize:vertical;min-height:40px;line-height:1.5}
  .es-pair{display:flex;gap:8px;flex-wrap:wrap}
  .es-rows{display:flex;flex-direction:column;gap:7px}
  .es-row{display:flex;align-items:center;gap:7px}
  .es-grip{color:var(--muted);line-height:0;flex:none}
  .es-arrow{color:var(--muted);line-height:0;flex:none}
  .es-grow{flex:1;min-width:80px}
  .es-w64{width:64px;flex:none}
  .es-w120{width:120px;flex:none}
  .es-w160{width:160px;flex:none}
  .es-rowx{border:0;background:transparent;color:var(--muted);cursor:pointer;padding:3px;border-radius:6px;line-height:0;flex:none}
  .es-rowx:hover{color:var(--over,#e5484d);background:var(--track)}
  .es-check{display:flex;align-items:center;gap:8px}
  .es-check input[type=checkbox]{margin:0;flex:none}
  .es-check.done .es-check-in{text-decoration:line-through;color:var(--muted)}
  .es-add{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;font-weight:600;color:var(--fill);background:transparent;border:1px dashed var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
  .es-add:hover{border-color:#b9d4ff;background:var(--track)}
  .es-add-ic{transform:rotate(90deg)}
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
  html[data-theme="dark"] .es-add:hover,html[data-theme="dark"] .es-gear:hover{background:var(--card)}`;
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

// ── メイン描画 ────────────────────────────────────────────────────
export async function renderExecSupport(container, { taskId, task = null, onChange } = {}) {
  ensureStyle();
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
    const fill = container.querySelector(".es-bar-fill");
    const pctEl = container.querySelector(".es-meter-pct");
    const labEl = container.querySelector(".es-meter-lab");
    const subEl = container.querySelector(".es-meter-sub");
    const footEl = container.querySelector(".es-foot-score b");
    if (fill) {
      fill.style.width = pct + "%";
      fill.classList.toggle("full", pct >= 100);
      fill.classList.toggle("warm", pct >= 40 && pct < 100);
    }
    if (pctEl) pctEl.textContent = pct + "%";
    if (labEl) labEl.textContent = meterLabel(pct);
    if (subEl) subEl.textContent = `${got} / ${max} pt`;
    if (footEl) footEl.textContent = `${got} / ${max} pt（${pct}%）`;
    // 各カードの達成バッジも更新。
    for (const id of enabled) {
      const p = PLUGIN_BY_ID[id];
      const badge = container.querySelector(`.es-card[data-pid="${id}"] .es-cpts`);
      if (!badge || !p) continue;
      const sc = clampScore(p.score(prep[id] || p.defaults()), p.max);
      badge.textContent = `${sc} / ${p.max} pt`;
      badge.classList.toggle("met", sc >= p.max);
    }
  };

  // save をラップして「保存＋メーター即更新」をひとまとめに（各プラグインに渡す save）。
  const saveAndMeter = () => { updateMeter(); save(); };
  saveAndMeter.flushNow = save.flushNow;

  // ── カード群 HTML ──
  const cardsHtml = () => PLUGINS.filter((p) => enabled.includes(p.id)).map((p) => {
    const sc = clampScore(p.score(prep[p.id] || p.defaults()), p.max);
    return `
      <section class="es-card" data-pid="${p.id}">
        <header class="es-chd">
          <span class="es-chd-ic">${icon(p.icon, { size: 16 })}</span>
          <span class="es-ctitle">${esc(p.label)}</span>
          <span class="es-cpts${sc >= p.max ? " met" : ""}">${sc} / ${p.max} pt</span>
        </header>
        <div class="es-body" data-body="${p.id}"></div>
      </section>`;
  }).join("");

  // ── トグル（手法 ON/OFF）HTML ──
  const togglesHtml = () => PLUGINS.map((p) => {
    const on = enabled.includes(p.id);
    return `<label class="es-tg${on ? "" : " off"}">
      <input type="checkbox" data-tg="${p.id}"${on ? " checked" : ""}>
      ${esc(p.label)}
    </label>`;
  }).join("");

  const { got, max, pct } = computeScore(prep, enabled);

  container.innerHTML = `
    <div class="es">
      <div class="es-top">
        <div class="es-meter">
          <div class="es-meter-h">
            <span class="es-meter-pct">${pct}%</span>
            <span class="es-meter-lab">${esc(meterLabel(pct))}</span>
            <span class="es-meter-sub">${got} / ${max} pt</span>
          </div>
          <div class="es-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="実行可能性メーター">
            <div class="es-bar-fill ${pct >= 100 ? "full" : pct >= 40 ? "warm" : ""}" style="width:${pct}%"></div>
          </div>
        </div>
        <button type="button" class="es-gear" id="es-gear" aria-label="手法のON/OFF" title="手法のON/OFF">${icon("settings", { size: 16 })}</button>
      </div>
      <div class="es-toggles" id="es-toggles">${togglesHtml()}</div>
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
  const wireCards = () => {
    for (const p of PLUGINS.filter((x) => enabled.includes(x.id))) {
      const body = container.querySelector(`[data-body="${p.id}"]`);
      if (!body) continue;
      body.innerHTML = p.render(prep[p.id], ctx);
      try { p.wire(body, prep[p.id], ctx, saveAndMeter); } catch { /* 1プラグインの不具合で全体を壊さない */ }
    }
  };
  wireCards();

  // ── 歯車トグルの開閉＋ON/OFF配線 ──
  const gear = container.querySelector("#es-gear");
  const togglesBox = container.querySelector("#es-toggles");
  gear.addEventListener("click", () => togglesBox.classList.toggle("open"));
  togglesBox.querySelectorAll("[data-tg]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.tg;
      if (cb.checked) { if (!enabled.includes(id)) enabled.push(id); }
      else { enabled = enabled.filter((x) => x !== id); }
      // PLUGINS 定義順に正規化して保存。
      enabled = PLUGINS.filter((p) => enabled.includes(p.id)).map((p) => p.id);
      saveEnabled(enabled);
      cb.closest(".es-tg").classList.toggle("off", !cb.checked);
      // カード群を再構築（有効集合が変わったので render/wire/メーター全部）。
      container.querySelector("#es-cards").innerHTML = cardsHtml();
      wireCards();
      updateMeter();
      save(); // score 再計算分を保存
    });
  });

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

  container.querySelector("#es-go").addEventListener("click", () => {
    const next = (prep.next_step && prep.next_step.text || "").trim();
    showToast(next ? `さあ着手: ${next.length > 28 ? next.slice(0, 27) + "…" : next}` : "まずは「次の一歩」を1つ決めましょう");
  });

  // 念のため初期メーターを同期（render とズレないように）。
  updateMeter();
}
