// 定期業務・定期MTG の管理（独立ビュー）。
// 旧「予定の基礎データ」(#/manage) の①定期・会議カードを単独画面に抽出したもの。
// 定例MTG・定期タスク・単発MTGを RRULE で管理。新規/編集は recurrenceform の種別タブ付きモーダル。
// データはすべて TaskStation API のグローバルエンティティ（ログインユーザーがCRUD可）。
import { load, invalidate } from "../lib/store.js";
import { deleteRecurrence } from "../lib/api.js";
import { openRecurrenceForm, summarizeRecurrence, recurrenceMode } from "./recurrenceform.js";
import { expandRecurrences } from "../lib/recurrence.js"; // 次回発生日の算出に使用（自前計算しない・読むだけ）
import { C, esc, todayISO } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

const KIND_ICON = { mtg: icon("calendar"), rmtg: icon("repeat"), rtask: icon("repeat") };

// B44: 種別フィルタの選択を個人保存（再読込でも維持）。値=recurrenceMode（all/rtask/rmtg/mtg）。
const MODE_KEY = "ts.recurring.mode";
const HIDE_KEY = "ts.recurring.hideEnded";

// B43: 各定期の「次回発生日」（今日以降の最初の発生日 ISO）。終了済み等で無ければ null。
// expandRecurrences（rrule.js 経由）に委譲。今日〜約3年先の窓で展開し最小の dateISO を取る。
function nextOccurrence(rec, today = todayISO()) {
  if (!rec || !rec.rrule || !rec.dtstart) return null;
  const h = new Date(today + "T00:00:00Z");
  h.setUTCFullYear(h.getUTCFullYear() + 3);
  const toISO = h.toISOString().slice(0, 10);
  let occs;
  try { occs = expandRecurrences([rec], today, toISO); } catch { return null; }
  let min = null;
  for (const o of occs) if (!min || o.dateISO < min) min = o.dateISO;
  return min;
}

// URLハッシュから有効なkindフィルタを判定。
//  ...recurring-task...    → "task"    （定期業務のみ）
//  ...recurring-meeting... → "meeting" （定期MTGのみ）
//  それ以外（素の #/recurring 含む）→ null （全件・後方互換）
function activeKind() {
  const h = location.hash || "";
  if (h.includes("recurring-task")) return "task";
  if (h.includes("recurring-meeting")) return "meeting";
  return null;
}

// フィルタ別の画面テキスト。
const KIND_VIEW = {
  task: { title: "定期業務", sub: "定期タスクの登録・編集", section: "定期業務", empty: "定期業務はまだありません" },
  meeting: { title: "定期MTG", sub: "定例MTG・単発MTGの登録・編集", section: "定期MTG", empty: "定期MTGはまだありません" },
  null: { title: "定期業務・定期MTG", sub: "定例MTG・定期タスク・単発MTGの登録・編集", section: "定期・会議", empty: "まだありません" },
};

export async function render(root) {
  ensureStyle();
  const { members, holidaysByDate, recurrences } = await load();
  const memberName = (id) => { const m = (members || []).find((x) => x.id === id); return m ? (m.name || m.username) : `user${id}`; };

  const kind = activeKind();
  const view = KIND_VIEW[kind];
  const list = kind ? (recurrences || []).filter((r) => r.kind === kind) : (recurrences || []);

  root.innerHTML = `
    <h1 class="vtitle">${esc(view.title)} <small>${esc(view.sub)}</small></h1>
    <div class="rc-grid">
      <div class="card rc-card" id="rc-rec"></div>
    </div>`;

  const reload = () => { invalidate(); render(root); };

  renderRecurrences(root.querySelector("#rc-rec"), list, memberName, { members, holidaysByDate, reload, view, kind });
}

// B44: 種別フィルタの選択肢。URLハッシュで kind が固定されている画面では出さない（all+その種別のみ）。
//   kind=null（全件画面）→ 全タブを出す。kind="task"→定期業務固定。kind="meeting"→MTG系のみ。
const MODE_TABS = {
  null: [["all", "すべて"], ["rtask", "定期業務"], ["rmtg", "定例MTG"], ["mtg", "MTG"]],
  meeting: [["all", "すべて"], ["rmtg", "定例MTG"], ["mtg", "MTG"]],
  task: null, // 定期業務のみ＝種別タブ不要
};

function renderRecurrences(el, recurrences, memberName, { members, holidaysByDate, reload, view, kind }) {
  const today = todayISO();
  // B44: 検索語・種別・終了済み非表示の状態（種別/トグルは個人保存、検索語はセッション中のみ）。
  const modeTabs = MODE_TABS[kind] || null;
  const readMode = () => { try { return localStorage.getItem(MODE_KEY) || "all"; } catch { return "all"; } };
  // 保存済みモードが現在の画面で選べない（kind固定で範囲外）なら "all" に倒す。
  const validModes = modeTabs ? modeTabs.map(([v]) => v) : ["all"];
  const state = {
    q: "",
    mode: validModes.includes(readMode()) ? readMode() : "all",
    hideEnded: (() => { try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; } })(),
  };

  // 全件の母数（フィルタ前）。次回発生日も先に一度だけ算出してキャッシュ。
  const all = [...(recurrences || [])];
  const nextOf = new Map(all.map((r) => [r.id, nextOccurrence(r, today)]));

  // 表示用に絞り込み＋ソート。終了済みは末尾へ、各群内は dtstart 昇順。
  const compute = () => {
    const q = state.q.trim().toLowerCase();
    let rows = all.filter((r) => {
      if (state.hideEnded && isEnded(r, today)) return false;
      if (state.mode !== "all" && recurrenceMode(r) !== state.mode) return false;
      if (q && !String(r.title || "").toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => {
      const ea = isEnded(a, today) ? 1 : 0, eb = isEnded(b, today) ? 1 : 0;
      if (ea !== eb) return ea - eb;
      return String(a.dtstart).localeCompare(String(b.dtstart));
    });
    return rows;
  };

  const modeTabsHtml = modeTabs
    ? `<div class="rc-modes" id="rc-modes">${modeTabs.map(([v, n]) =>
        `<button type="button" class="rc-mode${state.mode === v ? " on" : ""}" data-mode="${v}">${esc(n)}</button>`).join("")}</div>`
    : "";

  el.innerHTML = `
    <div class="rc-h"><span>${esc(view.section)} <span class="rc-cnt" id="rc-cnt">0</span></span>
      <button class="rc-add" id="rec-add">＋ 新規</button></div>
    <div class="rc-hint">定例MTG・定期タスク・単発MTGをRRULEで管理。「持ち回り」は担当が順番に巡回します。</div>
    <div class="rc-filter">
      <input id="rc-q" class="rc-q" type="search" placeholder="タイトルで検索…" autocomplete="off" value="${esc(state.q)}">
      ${modeTabsHtml}
      <label class="rc-hide"><input type="checkbox" id="rc-hide"${state.hideEnded ? " checked" : ""}> 終了済みを隠す</label>
    </div>
    <div class="rc-list" id="rc-list"></div>`;

  const listEl = el.querySelector("#rc-list");
  const cntEl = el.querySelector("#rc-cnt");

  // B45 のため：行ごとの削除/編集ハンドラを listEl のイベント委譲で配線（再描画なしの DOM 除去に対応）。
  const draw = () => {
    const rows = compute();
    cntEl.textContent = String(rows.length);
    if (!rows.length) {
      const noData = !all.length;
      listEl.innerHTML = `<div class="rc-empty">${esc(noData ? view.empty : "条件に一致する項目がありません")}</div>`;
      return;
    }
    listEl.innerHTML = rows.map((r) => recRow(r, memberName, today, nextOf.get(r.id))).join("");
  };

  el.querySelector("#rec-add").onclick = () =>
    openRecurrenceForm({ members, holidaysByDate, onSaved: reload });

  // 検索: 入力のたびに再フィルタ（行の差し替えのみ・全体再描画しない）。
  const qEl = el.querySelector("#rc-q");
  qEl.oninput = () => { state.q = qEl.value; draw(); };
  // 種別タブ: 選択を localStorage に保存し再フィルタ。
  el.querySelectorAll("#rc-modes [data-mode]").forEach((b) => {
    b.onclick = () => {
      state.mode = b.dataset.mode;
      try { localStorage.setItem(MODE_KEY, state.mode); } catch {}
      el.querySelectorAll("#rc-modes .rc-mode").forEach((x) => x.classList.toggle("on", x === b));
      draw();
    };
  });
  // 終了済みを隠す: トグルを保存し再フィルタ。
  const hideEl = el.querySelector("#rc-hide");
  hideEl.onchange = () => {
    state.hideEnded = hideEl.checked;
    try { localStorage.setItem(HIDE_KEY, state.hideEnded ? "1" : "0"); } catch {}
    draw();
  };

  // 行アクションはイベント委譲（B45: 削除時は当該行のみ remove ＋件数デクリメント）。
  listEl.onclick = (ev) => {
    const editBtn = ev.target.closest("[data-edit]");
    if (editBtn) {
      const rec = all.find((r) => r.id === +editBtn.dataset.edit);
      if (rec) openRecurrenceForm({ existing: rec, members, holidaysByDate, onSaved: reload });
      return;
    }
    const delBtn = ev.target.closest("[data-del]");
    if (delBtn) {
      const rec = all.find((r) => r.id === +delBtn.dataset.del);
      if (!rec || !confirm(`「${rec.title}」を削除しますか？`)) return;
      delBtn.disabled = true;
      deleteRecurrence(rec.id).then(() => {
        // B45: フル再描画を避け、対象行だけ DOM から除去＋件数デクリメント。
        const row = delBtn.closest(".rc-row");
        if (row) row.remove();
        cntEl.textContent = String(Math.max(0, (parseInt(cntEl.textContent, 10) || 1) - 1));
        // ローカルのキャッシュからも除去（再フィルタ時の整合・store はリロード時に無効化）。
        const i = all.findIndex((r) => r.id === rec.id);
        if (i >= 0) all.splice(i, 1);
        nextOf.delete(rec.id);
        invalidate(); // 他画面が次に load() する際に最新へ（この画面は再描画しない）
        if (!listEl.querySelector(".rc-row")) draw(); // 全消ししたら空表示に切り替え
      }).catch((e) => { delBtn.disabled = false; alert("削除に失敗: " + e.message); });
    }
  };

  draw();
}

// 終了済み判定: until（終了日・その日を含む）が今日より前なら終了済み。
function isEnded(r, today = todayISO()) {
  const u = summarizeRecurrence(r).untilISO;
  return !!u && u < today;
}

function recRow(r, memberName, today = todayISO(), nextISO = undefined) {
  const s = summarizeRecurrence(r);
  const names = (r.assignee_ids || []).map(memberName);
  const who = r.rotation
    ? `持ち回り: ${names.join(" → ") || "—"}`
    : (names.join("・") || "—");
  const meta = [s.rep, s.time, s.durTxt].filter(Boolean).join(" ・ ");
  const ended = !!s.untilISO && s.untilISO < today;
  const until = s.untilISO
    ? ` <span class="rc-until${ended ? " rc-until-ended" : ""}">${ended ? "終了 " : "〜"}${s.untilISO.replace(/-/g, "/")}</span>`
    : "";
  // B43: 次回発生日（今日以降の最初の発生）。算出値が渡らなければここで補完。終了済み/無しは表示しない。
  const next = nextISO === undefined ? nextOccurrence(r, today) : nextISO;
  const nextTag = (!ended && next)
    ? `<span class="rc-next">${icon("calendar")} 次回 ${next.replace(/-/g, "/")}</span>`
    : "";
  return `<div class="rc-row${ended ? " rc-ended" : ""}">
    <div class="rc-row-main">
      <div class="rc-row-t">${KIND_ICON[recurrenceMode(r)] || icon("repeat")} ${esc(r.title)}${nextTag}</div>
      <div class="rc-row-sub">${esc(meta)}${until} ・ ${esc(who)}</div>
    </div>
    <div class="rc-row-acts">
      <button class="rc-btn" data-edit="${r.id}">編集</button>
      <button class="rc-btn rc-del" data-del="${r.id}">削除</button>
    </div>
  </div>`;
}

let _styled = false;
function ensureStyle() {
  if (_styled) return; _styled = true;
  const s = document.createElement("style");
  s.textContent = `
  .rc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;align-items:start;max-width:640px}
  .rc-card{padding:16px 18px}
  .rc-h{display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:700;margin-bottom:4px}
  .rc-cnt{font-size:12px;color:${C.muted};font-weight:600;background:${C.track};border-radius:10px;padding:1px 8px;margin-left:4px}
  .rc-hint{font-size:11.5px;color:${C.muted};margin-bottom:10px;line-height:1.5}
  .rc-add{font:inherit;font-size:12.5px;font-weight:700;padding:7px 14px;border-radius:8px;border:1px solid ${C.fill};background:${C.fill};color:#fff;cursor:pointer;white-space:nowrap}
  .rc-add:hover{filter:brightness(1.05)}.rc-add:disabled{opacity:.6}
  /* B44: 検索・種別・終了済みトグル */
  .rc-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px}
  .rc-q{font:inherit;font-size:12.5px;padding:6px 10px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};flex:1;min-width:130px}
  .rc-q:focus{outline:none;border-color:${C.fill}}
  .rc-modes{display:flex;gap:4px;flex-wrap:wrap}
  .rc-mode{font:inherit;font-size:11.5px;padding:5px 10px;border:1px solid ${C.line};border-radius:16px;background:#fff;color:${C.muted};cursor:pointer;white-space:nowrap}
  .rc-mode:hover:not(.on){border-color:#cfd9e6;color:${C.ink}}
  .rc-mode.on{background:${C.fill};border-color:${C.fill};color:#fff;font-weight:700}
  .rc-hide{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:${C.muted};cursor:pointer;white-space:nowrap}
  .rc-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}
  .rc-empty{font-size:12.5px;color:${C.muted};padding:10px 2px}
  .rc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 4px;border-top:1px solid ${C.track}}
  .rc-row:first-child{border-top:0}
  .rc-row-t{font-size:13px;font-weight:600;color:${C.ink};display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  /* B43: 次回発生日バッジ */
  .rc-next{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:600;color:${C.fill};background:#f1f7ff;border:1px solid #d6e6ff;border-radius:999px;padding:1px 8px;white-space:nowrap}
  .rc-next svg{width:11px;height:11px}
  .rc-row-sub{font-size:11.5px;color:${C.muted};margin-top:2px}
  .rc-until{color:${C.amber};font-weight:600}
  /* 終了済み（until が過去）: ミュート表示。操作ボタンは押せるように維持 */
  .rc-row.rc-ended .rc-row-main{opacity:.5}
  .rc-row.rc-ended .rc-row-t{text-decoration:line-through;text-decoration-thickness:1px}
  .rc-until-ended{color:${C.muted}!important;font-weight:600}
  .rc-row-acts{display:flex;gap:5px;flex-shrink:0}
  .rc-btn{font:inherit;font-size:11.5px;padding:4px 10px;border-radius:7px;border:1px solid ${C.line};background:#fff;color:${C.muted};cursor:pointer}
  .rc-btn:hover{border-color:${C.fill};color:${C.fill}}
  .rc-del:hover{border-color:${C.over};color:${C.over}}

  /* ダークモード: 白背景ボタンを面色に（ライト値は不変） */
  html[data-theme="dark"] .rc-btn,
  html[data-theme="dark"] .rc-q,
  html[data-theme="dark"] .rc-mode{background:var(--card);color:var(--muted)}
  html[data-theme="dark"] .rc-q{color:var(--ink)}
  html[data-theme="dark"] .rc-next{background:rgba(58,134,255,.14);border-color:rgba(58,134,255,.35)}`;
  document.head.appendChild(s);
}
