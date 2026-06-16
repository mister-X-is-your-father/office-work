// 総合ホーム（実データ）。縦積み: KPI / 今日の稼働予定 / 稼働プラン / 月間ガント。
// 各セクションは折りたたみヘッダ付き。開閉状態は本人ごと localStorage に保存・復元。
import { load } from "../lib/store.js";
import { loadByMember, estimateVsActual, triage } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { whoami } from "../lib/api.js";
import { C, fmtH, todayISO } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import * as today from "./today.js";
import * as workplan from "./workplan.js";
import * as gantt from "./gantt.js";

// 折りたたみ状態の保存キー（本人ごと）。共用ブラウザでも個人別に保持。
const foldKey = (uid) => `ts.home.fold.${uid ?? "anon"}`;
// 既定（未保存時）: 全セクション開。KPI は折りたたみ対象外（常時表示）。
const DEFAULT_FOLD = { today: false, plan: false, gantt: false };

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
  const { tasks, members, plansByTask, holidaysSet, unavailabilityByMember, settings } = await load();
  const day = todayISO();
  // 営業日割り＋人別容量（週末/祝日/休暇=0）で今日KPIを正確に（§土日祝ギャップ）
  const capacityFor = (m, d) => capacityOn(m, d, { holidays: holidaysSet, unavailabilityByMember, capH: settings.capH });
  const rows = loadByMember(tasks, members, day, settings.capH, plansByTask, { holidays: holidaysSet, capacityFor });
  const ev = estimateVsActual(tasks);
  const tri = triage(tasks, day);

  const totCap = rows.reduce((s, r) => s + r.capH, 0), totAsg = rows.reduce((s, r) => s + r.assignedH, 0);
  const over = rows.filter(r => r.status === "over");
  const must = tri.filter(t => t.cls === "must");

  // 折りたたみ状態（本人ごと localStorage）。uid 取得失敗時は anon キーへ。
  let uid = null;
  try { uid = (await whoami())?.id ?? null; } catch { uid = null; }
  const fold = readFold(uid);

  // 折りたたみ可能なセクション。id は fold 状態のキー、loader は中身を描く非同期関数。
  const section = (id, title) => {
    const open = !fold[id];
    return `
      <section class="home-sec card" data-sec="${id}">
        <button type="button" class="home-sec-head" data-toggle="${id}" aria-expanded="${open}">
          <span class="home-chevron">${icon(open ? "chevronDown" : "chevronRight", { size: 16 }) || (open ? "▾" : "▸")}</span>
          <span class="home-sec-title">${title}</span>
        </button>
        <div class="home-sec-body" data-body="${id}" ${open ? "" : "hidden"}></div>
      </section>`;
  };

  root.innerHTML = `
    <h1 class="vtitle">ホーム <small>${day}</small></h1>
    <div class="kpis">
      <div class="kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(totAsg)}<small>/${fmtH(totCap)}</small></div></div>
      <div class="kpi free"><div class="l">空き工数</div><div class="v">${fmtH(Math.max(0, totCap - totAsg))}</div></div>
      <div class="kpi ${over.length ? "over" : ""}"><div class="l">過負荷</div><div class="v">${over.length}<small>名</small></div></div>
      <div class="kpi"><div class="l">今日必須</div><div class="v">${must.length}<small>件</small></div></div>
    </div>
    <div class="home-stack">
      ${section("today", "今日の稼働予定")}
      ${section("plan", "稼働プラン（1ヶ月）")}
      ${section("gantt", "月間ガント（人別レーン）")}
    </div>
    <style>
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
    </style>`;

  // 各埋め込みは load() の共有キャッシュ経由（二重 fetch なし）。
  // 開いているセクションのみ描画。teardown を保持し、再描画/折りたたみ時に解除。
  const teardowns = new Map();   // sec id -> teardown fn（gantt のみ）

  async function fill(id) {
    const body = root.querySelector(`[data-body="${id}"]`);
    if (!body || body.hidden || body.dataset.filled === "1") return;
    body.dataset.filled = "1";
    if (id === "today") {
      // fluid: ホーム埋め込みは固定高(px箱)をやめ可変高に（コンテナ幅に追従）。
      await today.renderInto(body, { compact: true, showToggle: false, mode: "stacked", title: false, fluid: true });
    } else if (id === "plan") {
      await workplan.renderInto(body, { preset: "1m", who: "all", fluid: true });
    } else if (id === "gantt") {
      // ガントは teardown を返す。折りたたみ/再描画で確実に解除（リスナー漏れ防止）。
      const td = await gantt.renderInto(body, { months: 1, mode: "member", fluid: true });
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
      if (chev) chev.innerHTML = icon(open ? "chevronDown" : "chevronRight", { size: 16 }) || (open ? "▾" : "▸");
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
  await fill("today");
  await fill("plan");
  await fill("gantt");
}
