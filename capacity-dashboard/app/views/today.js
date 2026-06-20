// 今日の稼働予定。円時計(clock.js)／積み上げ(mock54) を切替表示。
import { load } from "../lib/store.js";
import { todayItemsByMember } from "../lib/today_items.js";
import { KINDS } from "../lib/kinds.js";
import { projectName } from "../lib/store.js";
import { C, fmtH, esc, todayISO, member_color } from "../lib/ui.js";
import { renderClock, openRescheduleMenu } from "./clock.js";

let CAP = 8; // 設定（容量 h/日）で上書き
const PJPAL = ["#3a86ff", "#2fa66b", "#b657d6", "#e5772d", "#0ea5e9", "#f5a623", "#ef476f", "#14b8a6"];
// 表示モードは個人ごとに localStorage で永続化（設定表が無いため・HANDOFF §8）。
// 既定は「積み上げ」。ログインユーザー id ごとにキーを分け、共用ブラウザでも個人別に保持。
const DEFAULT_MODE = "stacked"; // 'clock' | 'stacked'
const modeKey = (uid) => `ts.today.mode.${uid ?? "anon"}`;
let MODE = null;     // 未確定=null。初回 render で localStorage から確定
let MODE_UID = null; // モード保存先のユーザー id

const round1 = (x) => Math.round(x * 100) / 100; // 時間表示=小数2桁（capacity.js と同義）

// モード切替トグル。見た目は従来どおり（on=青塗り/白字＝モードが等価でなく「選択」を強調する既存意匠）。
// 面の色は --card（light=#fff / dark=#1f242c）に統一し、テーマ別2ルールを1本化（描画は両テーマで従来と同一）。
const segCss = () => `<style>.t-seg{display:inline-flex;background:var(--card);border:1px solid ${C.line};border-radius:10px;padding:3px;margin:0 0 16px;box-shadow:0 1px 2px rgba(20,30,50,.04)}
    .t-seg button{border:0;background:transparent;color:${C.muted};font:inherit;font-size:13px;font-weight:600;padding:5px 14px;border-radius:8px;cursor:pointer}
    .t-seg button.on{background:${C.fill};color:#fff}</style>`;

const segHtml = (mode) => `<div class="t-seg">
      <button data-m="stacked" class="${mode === "stacked" ? "on" : ""}">積み上げ</button>
      <button data-m="clock" class="${mode === "clock" ? "on" : ""}">円時計</button>
    </div>`;

// body 要素に指定モードで描画（全画面/埋め込み 共通）。rerender はモード切替/clock 再描画用。
// opts.fluid: ホーム埋め込みで固定高(px箱)をやめ、コンテナ幅に応じた可変高にする（積み上げのみ）。
function paintBody(body, data, day, mode, rerender, opts = {}) {
  if (mode === "clock") renderClock(body, data, day, rerender);
  else renderStacked(body, data, day, rerender, opts);
}

export async function render(root) {
  const data = await load();
  CAP = data.settings.capH;
  const day = todayISO();
  if (MODE === null) {
    MODE_UID = data.me?.id ?? null; // load() がキャッシュ済みの whoami 結果（重複 fetch 回避）
    let saved = null;
    try { saved = localStorage.getItem(modeKey(MODE_UID)); } catch {}
    MODE = saved === "clock" || saved === "stacked" ? saved : DEFAULT_MODE;
  }
  root.innerHTML = `
    ${segCss()}
    <h1 class="vtitle">今日の稼働予定 <small>${day}</small></h1>
    ${segHtml(MODE)}
    <div id="t-body"></div>`;
  root.querySelectorAll(".t-seg button").forEach((b) => {
    b.onclick = () => {
      MODE = b.dataset.m;
      try { localStorage.setItem(modeKey(MODE_UID), MODE); } catch {}
      render(root);
    };
  });
  paintBody(root.querySelector("#t-body"), data, day, MODE, () => render(root));
}

// ホーム画面のサブコンテナへ埋め込む入口。
// 全画面の MODE/MODE_UID には一切触れず、ローカル変数でモードを保持する（状態衝突回避）。
// opts: { compact?: boolean, showToggle?: boolean, mode?: 'stacked'|'clock', title?: boolean }
//   compact   余白を圧縮（既定 true）
//   showToggle モード切替ボタンを出すか（既定 false＝安定優先・既定モード固定）
//   mode      初期モード（既定 'stacked'）
//   title     見出しを出すか（既定 false）
export async function renderInto(container, opts = {}) {
  if (!container) return;
  const { compact = true, showToggle = false, title = false, fluid = false } = opts;
  let localMode = opts.mode === "clock" ? "clock" : DEFAULT_MODE; // 全画面 MODE と独立
  const data = await load();          // store.js のキャッシュ経由（二重 fetch なし）
  CAP = data.settings.capH;
  const day = todayISO();

  const draw = () => {
    container.innerHTML = `
      ${showToggle ? segCss() : ""}
      ${title ? `<h2 class="vtitle" style="margin-top:0">今日の稼働予定 <small>${day}</small></h2>` : ""}
      ${showToggle ? segHtml(localMode) : ""}
      <div class="t-embed${compact ? " compact" : ""}"></div>`;
    if (showToggle) {
      container.querySelectorAll(".t-seg button").forEach((b) => {
        b.onclick = () => { localMode = b.dataset.m; draw(); };
      });
    }
    const body = container.querySelector(".t-embed");
    // 埋め込み内のモード切替/clock 再描画はサブコンテナ内で完結（全画面に波及しない）。
    paintBody(body, data, day, localMode, draw, { fluid });
  };
  draw();
}

// 会議/定例（taskId 無し＝プロジェクト色を持たない occurrence）の積み木色。
// kind ごとに固定色＝凡例と一致。模様（斜線/ドット）は円時計側のみで、積み上げはベタ色で区別する。
const KINDCOL = { meeting: "#7c8597", recurring: "#9aa3b2" };

function renderStacked(body, data, day, rerender, opts = {}) {
  const { tasks, members, projects } = data;
  const canEdit = !!(data.settings && data.settings.canEdit);
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  const pjIdx = new Map();
  const pjColor = (pid) => {
    if (pid == null) return C.full;
    if (!pjIdx.has(pid)) pjIdx.set(pid, pjIdx.size);
    return PJPAL[pjIdx.get(pid) % PJPAL.length];
  };
  // メンバー色は members の安定 index で member_color に引く（kanban/gantt と同じ規約＝全画面で色一致）。
  // rows は freeH 降順ソートされるため行 index は不安定。id→配列位置の固定マップを使う。
  const memberIdx = new Map((members || []).map((m, i) => [m.id, i]));
  const memberColor = (mid) => member_color(memberIdx.get(mid) ?? 0);
  // 【単一データ源】円時計と同じ todayItemsByMember を使う（タスク見積/予定＋会議/定例 occurrence を統合、
  // 人別容量＝週末/祝日/休暇=0 も内包）。これでモード間（積み上げ⇔円時計）と KPI の数値が必ず一致する。
  // items: [{taskId?, title, h, kind, prio, flags}]、usedH/freeH/overH/capH/status はメンバー集計済み。
  const stateMap = todayItemsByMember(data, day, CAP);
  const rows = members
    .map((m) => stateMap.get(m.id))
    .filter(Boolean)
    .map((s) => ({
      id: s.member.id,
      name: s.member.name || s.member.username,
      capH: s.capH,
      assignedH: s.usedH,
      freeH: s.freeH,
      overH: s.overH,
      status: s.status,
      tasks: s.items, // 会議/定例 occurrence もここに含まれる（kind で色分け）
    }))
    .sort((a, b) => b.freeH - a.freeH);
  // チーム集計は円時計 KPI(kpiStrip)と「同じ算式」で出す＝モードを切り替えても数値が一致する。
  //   稼働率 = Σmin(使用, CAP) / Σ容量（超過者が率を 100% 超に押し上げない・分母は人別容量＝週末/祝日0）
  //   超過   = Σ各人 overH（ある人の余りが別人の超過を相殺しない＝per-member 合算）
  //   空き   = Σ各人 freeH（同上）
  const totCap = rows.reduce((s, r) => s + r.capH, 0);
  const free = round1(rows.reduce((s, r) => s + r.freeH, 0));
  const over = round1(rows.reduce((s, r) => s + r.overH, 0));
  const usedCapped = rows.reduce((s, r) => s + Math.min(r.assignedH, CAP), 0); // 円時計 usedAll と同式（global CAP 頭打ち）
  const rate = totCap > 0 ? Math.round((usedCapped / totCap) * 100) : 0;
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.assignedH), 0);
  const yMax = Math.max(11, Math.ceil(maxTotal) + 1);
  // 全画面=固定 400px（従来どおり・非回帰）。fluid(ホーム埋め込み)=固定px箱をやめ、
  // ビューポート幅に追従する可変高（clamp 260〜400px）に。SVGではなく px レイアウトのため、
  // 描画時点の幅から高さを算出して箱を固定値に縛らない。
  const fluid = !!opts.fluid;
  const vw = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
  const CHART_H = fluid ? Math.round(Math.max(260, Math.min(400, vw * 0.32))) : 400;
  const FOOT_H = 54, PLOT_H = CHART_H - FOOT_H;
  const pxPerH = PLOT_H / yMax;
  // 会議/定例 occurrence が今日どれか1人にでも載っているか（凡例の出し分け用）。
  const usedKinds = new Set();
  for (const r of rows) for (const t of r.tasks) if (t.kind === "meeting" || t.kind === "recurring") usedKinds.add(t.kind);
  // 先に chart を生成して pjIdx を埋める（colHtml 内の pjColor 呼び出しで使用プロジェクトが確定）→
  // その後で usedPjs スナップショットを取り、凡例に正しく反映させる。
  const chart = rows.length ? chartHtml(rows, { yMax, PLOT_H, FOOT_H, pxPerH, taskById, pjColor, memberColor, canEdit }) : empty();
  const usedPjs = [...pjIdx.keys()];

  body.innerHTML = `
    <style>${css()}</style>
    <div class="t54-sub">メンバー別の予定工数と空き（容量 ${CAP}h/人・タスク見積/予定＋会議・定例）</div>
    <div class="kpis">
      <div class="kpi"><div class="l">チーム稼働</div><div class="v">${fmtH(round1(usedCapped))}<small>/${fmtH(totCap)}</small></div></div>
      <div class="kpi"><div class="l">稼働率</div><div class="v">${rate}<small>%</small></div></div>
      <div class="kpi free"><div class="l">空き工数</div><div class="v">${fmtH(free)}</div></div>
      <div class="kpi over"><div class="l">超過</div><div class="v">${over > 0 ? "+" + fmtH(over) : "0h"}</div></div>
    </div>
    <div class="t54-card">
      ${chart}
      ${rows.length ? legendHtml(usedPjs, projects, pjColor, usedKinds) : ""}
    </div>
    ${rows.length ? `<div class="t54-hint">タイル＝今日のタスク・会議・定例（高さ＝工数）。容量線(${CAP}h)を超えた分が赤、線の下の点線が空き工数。</div>` : ""}`;

  // 積み上げのタスクタイル(.t54-seg-act)クリック → 円時計と同じ再スケジュールメニュー。
  // occurrence(会議/定例)と非canEdit には data 属性を付けていないので配線されない。
  if (canEdit) {
    const freeBy = new Map(rows.map((r) => [r.id, r.freeH]));
    body.querySelectorAll(".t54-seg-act[data-task]").forEach((seg) => {
      seg.onclick = (e) => {
        e.stopPropagation();
        const taskId = +seg.dataset.task, memberId = +seg.dataset.member;
        const t = taskById.get(taskId) || {};
        openRescheduleMenu(
          { taskId, memberId, neededH: +seg.dataset.h, title: seg.dataset.title, t, aids: (t.assignees || []).map((a) => a.id) },
          { data, day, rerender, freeBy }
        );
      };
    });
  }
}

function chartHtml(rows, g) {
  const { yMax, PLOT_H, FOOT_H, pxPerH, taskById, pjColor, memberColor } = g;
  // Y目盛り＋グリッド
  let yaxis = "", grids = "";
  const step = yMax > 14 ? 4 : 2;
  for (let hh = 0; hh <= yMax - 1; hh += step) {
    const topY = PLOT_H - hh * pxPerH;
    yaxis += `<div class="t54-ytick" style="top:${topY}px">${hh}h</div>`;
    grids += `<div class="t54-ygrid" style="top:${topY}px"></div>`;
  }
  // 容量線
  const capTop = PLOT_H - CAP * pxPerH;
  const capline = `<div class="t54-capline" style="top:${capTop}px"></div><div class="t54-caplabel" style="top:${capTop}px">容量 ${CAP}h</div>`;

  const cols = rows.map((r, i) => colHtml(r, i, g)).join("");
  return `<div class="t54-chart" style="height:${PLOT_H + FOOT_H}px">
      <div class="t54-yaxis">${yaxis}</div>${grids}${capline}${cols}
    </div>`;
}

function colHtml(r, i, g) {
  const { PLOT_H, FOOT_H, pxPerH, taskById, pjColor, memberColor } = g;
  const total = r.assignedH, over = r.overH, free = r.freeH;
  let inner = "";

  // 空きゾーン（容量線の下・スタック上端まで）
  if (free > 0) {
    inner += `<div class="t54-freezone" style="bottom:${FOOT_H + total * pxPerH}px;height:${free * pxPerH}px"><span>空き ${fmtH(free)}</span></div>`;
  }
  // タスク積み木。会議/定例(occurrence)は taskId を持たない＝kind 固定色、それ以外はプロジェクト色。
  let segs = "";
  for (const t of r.tasks) {
    const hpx = t.h * pxPerH;
    const isOcc = t.kind === "meeting" || t.kind === "recurring";
    const col = isOcc ? (KINDCOL[t.kind] || C.full) : pjColor(taskById.get(t.taskId)?.project_id);
    const small = hpx < 40 ? " small" : "";
    const kindLabel = isOcc ? `${KINDS[t.kind].label}・` : "";
    // タスク(!isOcc)かつ canEdit のときだけ、再スケジュール用の data 属性＋クリック可クラスを付ける。
    // occurrence(会議/定例)や非canEdit は従来どおり（data 属性なし・クリック不可）。
    const act = (!isOcc && g.canEdit) ? ` t54-seg-act" data-task="${t.taskId}" data-member="${r.id}" data-h="${t.h}" data-title="${esc(t.title)}` : "";
    segs += `<div class="t54-seg${small}${act}" style="height:${hpx}px;background:${col}" title="${kindLabel}${esc(t.title)} ・ ${fmtH(t.h)}">
        <div class="t54-tname">${esc(t.title)}</div><div class="t54-thrs"><b>${fmtH(t.h)}</b></div></div>`;
  }
  if (!r.tasks.length) {
    inner += `<div class="t54-none" style="bottom:${FOOT_H}px">今日の予定なし</div>`;
  } else {
    inner += `<div class="t54-stack" style="bottom:${FOOT_H}px;height:${total * pxPerH}px">${segs}</div>`;
  }
  // 超過オーバーレイ
  if (over > 0) {
    inner += `<div class="t54-overlay" style="bottom:${FOOT_H + CAP * pxPerH}px;height:${over * pxPerH}px"></div>`;
    inner += `<div class="t54-overbadge" style="bottom:${FOOT_H + total * pxPerH + 8}px">超過 +${fmtH(over)}</div>`;
  }
  // フッター
  const cls = r.status === "over" ? "over" : (r.status === "full" ? "full" : (r.status === "off" ? "off" : "free"));
  const txt = r.status === "over" ? "超過 +" + fmtH(over) : (r.status === "full" ? "満稼働" : (r.status === "off" ? "休 (非稼働日)" : "空き " + fmtH(free)));
  const dot = memberColor(r.id); // members の安定 index 由来（全画面で色一致）。行 index i ではなく member id で引く
  inner += `<div class="t54-foot">
      <div class="t54-nm"><span class="t54-dot" style="background:${dot}"></span>${esc(r.name)}</div>
      <div class="t54-status ${cls}">${txt}</div>
      <div class="t54-total">${fmtH(total)} / ${r.capH}h</div>
    </div>`;

  return `<div class="t54-col"><div class="t54-area">${inner}</div></div>`;
}

function legendHtml(usedPjs, projects, pjColor, usedKinds = new Set()) {
  const pj = usedPjs.map((pid) =>
    `<span class="item"><span class="sw" style="background:${pjColor(pid)}"></span>${esc(projectName(projects, pid))}</span>`).join("");
  // 会議/定例 occurrence は taskId を持たずプロジェクト色に乗らないので、kind 固定色で別途凡例を出す。
  const occ = ["meeting", "recurring"].filter((k) => usedKinds.has(k)).map((k) =>
    `<span class="item"><span class="sw" style="background:${KINDCOL[k]}"></span>${esc(KINDS[k].label)}</span>`).join("");
  return `<div class="t54-legend">
      ${pj}${occ}
      <span class="item"><span class="rule"></span>容量線 ${CAP}h</span>
      <span class="item"><span class="oversw"></span>容量超過</span>
      <span class="item"><span class="sw freesw" style="background:var(--card);border:1.5px dashed #c4d6c9"></span>空き工数</span>
    </div>`;
}

const empty = () => `<div class="t54-empty">今日の予定工数を持つ担当タスクがありません。<br>タスクに担当・期限・見積り、または日別予定を設定してください。</div>`;

function css() {
  return `
  .t54-sub{font-size:12.5px;color:${C.muted};margin:-4px 0 14px}
  .t54-card{background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:30px 26px 16px;box-shadow:0 4px 16px rgba(20,30,50,.06)}
  .t54-chart{display:flex;align-items:flex-end;gap:30px;position:relative;padding:0 6px 0 42px}
  .t54-yaxis{position:absolute;left:0;top:0;bottom:0;width:38px;pointer-events:none}
  .t54-ytick{position:absolute;right:7px;font-size:10.5px;color:${C.muted};transform:translateY(-50%)}
  .t54-ygrid{position:absolute;left:42px;right:6px;border-top:1px solid ${C.track};pointer-events:none}
  .t54-capline{position:absolute;left:42px;right:6px;border-top:2px dashed ${C.capline};z-index:6;pointer-events:none}
  .t54-caplabel{position:absolute;right:6px;font-size:10px;color:${C.muted};background:${C.card};padding:1px 6px;border:1px solid ${C.line};border-radius:20px;transform:translateY(-50%);font-weight:700;z-index:7}
  .t54-col{flex:1;display:flex;justify-content:center;height:100%;position:relative;min-width:0}
  .t54-area{position:relative;width:100%;max-width:124px;height:100%}
  .t54-stack{position:absolute;left:0;right:0;display:flex;flex-direction:column-reverse;filter:drop-shadow(0 2px 5px rgba(20,30,50,.10))}
  .t54-seg{position:relative;display:flex;flex-direction:column;justify-content:center;padding:0 11px;color:#fff;overflow:hidden;border-bottom:2px solid ${C.card}}
  .t54-stack .t54-seg:first-child{border-bottom:0;border-radius:0 0 9px 9px}
  .t54-stack .t54-seg:last-child{border-radius:9px 9px 0 0}
  .t54-seg::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(0,0,0,.06))}
  .t54-seg:hover{filter:brightness(1.05)}
  .t54-seg-act{cursor:pointer}
  .t54-seg-act:hover{outline:2px solid rgba(255,255,255,.5);outline-offset:-2px}
  .t54-tname{font-size:12px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative;z-index:1}
  .t54-thrs{font-size:10.5px;line-height:1.2;margin-top:2px;opacity:.92;position:relative;z-index:1}
  .t54-seg.small{justify-content:center}.t54-seg.small .t54-thrs{display:none}.t54-seg.small .t54-tname{font-size:11px}
  .t54-overlay{position:absolute;left:0;right:0;z-index:5;pointer-events:none;background:rgba(229,72,77,.20);border-radius:9px 9px 0 0;border-top:2px solid ${C.over};box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
  .t54-overbadge{position:absolute;left:50%;transform:translateX(-50%);background:${C.over};color:#fff;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;box-shadow:0 3px 8px rgba(229,72,77,.35);z-index:9}
  .t54-freezone{position:absolute;left:0;right:0;z-index:3;pointer-events:none;border:1.5px dashed #c4d6c9;border-radius:9px;display:flex;align-items:center;justify-content:center}
  .t54-freezone span{font-size:11px;color:${C.free};font-weight:700;background:${C.card};padding:2px 9px;border-radius:20px;border:1px solid #d7ecdf}
  .t54-none{position:absolute;left:0;right:0;height:24px;text-align:center;font-size:11px;color:${C.muted}}
  .t54-foot{position:absolute;bottom:0;left:0;right:0;text-align:center;height:50px}
  .t54-nm{font-size:14.5px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px}
  .t54-dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .t54-status{font-size:11.5px;margin-top:3px;font-weight:700}
  .t54-status.free{color:${C.free}}.t54-status.over{color:${C.over}}.t54-status.full{color:${C.full}}.t54-status.off{color:${C.muted}}
  .t54-total{font-size:10.5px;color:${C.muted};margin-top:2px}
  .t54-legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:18px 2px 0;font-size:11.5px;color:${C.muted}}
  .t54-legend .item{display:flex;align-items:center;gap:6px}
  .t54-legend .sw{width:11px;height:11px;border-radius:3px;display:inline-block}
  .t54-legend .rule{width:20px;height:0;border-top:2px dashed ${C.capline}}
  .t54-legend .oversw{width:11px;height:11px;border-radius:3px;display:inline-block;background:rgba(229,72,77,.22);border:1.5px solid ${C.over}}
  .t54-hint{font-size:11px;color:${C.muted};text-align:right;margin-top:10px}
  .t54-empty{padding:34px;text-align:center;color:${C.muted}}
  @media(max-width:760px){.t54-chart{gap:14px;padding-left:38px}.t54-tname{font-size:10.5px}.t54-area{max-width:none}}
  /* ===== 埋め込み(compact)：余白を圧縮。高さは固定 chart 高に依存し 100vh 不使用 ===== */
  .t-embed.compact .t54-sub{margin:-2px 0 10px}
  .t-embed.compact .t54-card{padding:20px 18px 12px}
  .t-embed.compact .kpis{margin-bottom:12px}
  .t-embed.compact .t54-hint{margin-top:8px}
  /* ===== ダーク上書き（ライト値は上で維持＝非回帰）。淡色の面/ボーダーのみ暗側へ ===== */
  html[data-theme="dark"] .t54-freezone{border-color:rgba(47,166,107,.45)}
  html[data-theme="dark"] .t54-freezone span{border-color:rgba(47,166,107,.40)}
  html[data-theme="dark"] .t54-legend .sw.freesw{background:var(--track)!important;border-color:rgba(47,166,107,.45)!important}`;
}
