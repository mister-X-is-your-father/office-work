// 予実ガント（フェーズ3）。予定バー×実績バーを時間軸に重ね、依存矢印・今日線・進捗・超過を描く。
// タスク行モード(mock29型) / 人別レーンモード(mock30型) をトグル切替。取得はフロントN+1（planner.js踏襲）。
import { load, invalidate, isAiUser } from "../lib/store.js";
import { icon } from "../lib/icons.js";
import * as vik from "../lib/api.js";
import { taskRanges, dependencyEdges, depLayers, dayScale, toMemberDayEntries, sumByMemberDay, shiftISO, applyBarDrag, dateOnly, hasDate } from "../lib/capacity.js";
import { capacityOn } from "../lib/recurrence.js";
import { fmtDisplayDow } from "../lib/form.js";
import { openTaskForm } from "./taskform.js";
import { C, member_color, fmtH, esc, todayISO, announce } from "../lib/ui.js";

let COL_W = 40, WINDOW_DAYS = 21;   // 表示範囲プリセットで render ごとに上書き
let COL_W_MIN = 9;                  // プリセット由来の最小列幅（fitColumns で実幅へ伸ばす起点）
const LABEL_W_P = 320, ROW_H = 58, GRP_H = 64;
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

// 表示単位ごとのスパン。days=表示日数 / back=今日より前に含める日数 / colW=1日の列幅(px)。
// 日表示=列を広く日付を1日ずつ／週表示=列を詰めて週(開始曜日)ごとの罫線・ラベルに。
const SPANS = {
  day: [
    { key: "2w", label: "2週間", days: 14, back: 3, colW: 42 },
    { key: "1m", label: "1ヶ月", days: 31, back: 5, colW: 27 },
  ],
  week: [
    { key: "1m", label: "1ヶ月", days: 35, back: 7, colW: 14 },
    { key: "3m", label: "3ヶ月", days: 91, back: 7, colW: 9 },
    { key: "6m", label: "6ヶ月", days: 182, back: 14, colW: 7 },
  ],
};

// B42: plans/times の N+1 取得結果を module キャッシュ化。span/unit/週開始の軸変更は
// render(root) を呼び直すが、データ（store.load の tasks 配列）が同一参照なら再取得せず paint のみ。
// 編集後の reload() は invalidate()→load() で tasks が新配列になる＝キー不一致でキャッシュミス→再取得。
let _ganttFetchCache = null;   // { key, plansById, timesById, plansArr, timesArr }
async function fetchPlansTimes(tasks) {
  // tasks 配列の参照を世代キーに（store.invalidate 後は新配列＝別参照になる）。
  if (_ganttFetchCache && _ganttFetchCache.key === tasks) return _ganttFetchCache;
  const planTasks = tasks.filter((t) => (t.time_planned || 0) > 0);
  const timeTasks = tasks.filter((t) => (t.time_spent || 0) > 0);
  const [plansArr, timesArr] = await Promise.all([
    Promise.all(planTasks.map((t) => vik.getPlans(t.id).then((p) => [t, p || []]).catch(() => [t, []]))),
    Promise.all(timeTasks.map((t) => vik.getTimes(t.id).then((p) => [t, p || []]).catch(() => [t, []]))),
  ]);
  const plansById = new Map(plansArr.map(([t, p]) => [t.id, p]));
  const timesById = new Map(timesArr.map(([t, p]) => [t.id, p]));
  _ganttFetchCache = { key: tasks, plansById, timesById, plansArr, timesArr };
  return _ganttFetchCache;
}

const projColor = (id) => ["#3a86ff", "#2fa66b", "#b657d6", "#e5772d", "#0ea5e9", "#f5a623"][((id || 0) % 6 + 6) % 6];
const initial = (name) => (name ? String(name).trim().slice(0, 1) : "?");
// 人間担当（AI担当 fable は担当とみなさない＝未アサイン扱い。store.js の isAiUser を踏襲）。
const humanAssignees = (t) => (t.assignees || []).filter((a) => !isAiUser(a));

// 再描画（編集後の reload 等）をまたいで保持する表示状態。日表示/週表示・スパン・週開始曜日は
// localStorage に記憶（再読込後も維持）。既定はプロジェクト別 / 週表示 3ヶ月 / 週開始=月。
const GV_KEY = "gantt_view";
const _gv = (() => { try { return JSON.parse(localStorage.getItem(GV_KEY) || "{}") || {}; } catch { return {}; } })();
const gview = {
  // 旧localStorageに mode:"task" が残っていても project にフォールバック（「タスク行」モードは廃止）。
  mode: _gv.mode === "member" ? "member" : "project", collapsed: new Set(),
  unit: _gv.unit === "day" || _gv.unit === "week" ? _gv.unit : "week",
  spanDay: SPANS.day.some((p) => p.key === _gv.spanDay) ? _gv.spanDay : "1m",
  spanWeek: SPANS.week.some((p) => p.key === _gv.spanWeek) ? _gv.spanWeek : "3m",
  weekStart: Number.isInteger(_gv.weekStart) && _gv.weekStart >= 0 && _gv.weekStart <= 6 ? _gv.weekStart : 1,
  // B39: 依存(follows/precedes)矢印の表示。B40: クリティカルパス強調。B41: 人別レーンの未予定タスク行表示。
  withDeps: _gv.withDeps === true,
  critical: _gv.critical === true,
  showUnscheduled: _gv.showUnscheduled === true,
};
function saveGV() {
  try { localStorage.setItem(GV_KEY, JSON.stringify({ unit: gview.unit, spanDay: gview.spanDay, spanWeek: gview.spanWeek, weekStart: gview.weekStart, withDeps: gview.withDeps, critical: gview.critical, showUnscheduled: gview.showUnscheduled })); } catch { /* localStorage 不可でも続行 */ }
}

// 全画面エントリ（#/gantt）。従来どおり root.innerHTML をシェルで差し替え、編集可・全機能。
export async function render(root) {
  return mount(root, {});
}

// 埋め込みエントリ。ホーム等のサブコンテナに「1ヶ月幅・人別レーン」のガントを差し込む。
// 返り値 = cleanup 関数（リスナー/observer を即解除）。container 消滅時の自動解除も併設。
// opts: { months=1, mode='member', editable=false, maxHeight } — 既定で1ヶ月・人別・閲覧主体。
export async function renderInto(container, opts = {}) {
  return mount(container, { embedded: true, mode: opts.mode || "member", months: opts.months || 1,
                            editable: !!opts.editable, maxHeight: opts.maxHeight, ...opts });
}

async function mount(root, opts) {
  const embedded = !!opts.embedded;
  const editable = embedded ? !!opts.editable : true;   // 全画面=編集可。埋め込み=既定で閲覧主体。
  const { tasks, members, settings, holidaysSet, unavailabilityByMember } = await load();
  const capH = (settings && settings.capH) || 8;
  const today = todayISO();
  // 全画面=gview（保存された表示状態）。埋め込み=固定の日表示・1ヶ月（gview に依存しない）。
  let tier, weekStart, startISO;
  if (embedded) {
    // 埋め込みは「日表示・約1ヶ月（months×31日）」固定。週開始は月曜。
    WINDOW_DAYS = Math.max(7, Math.round((opts.months || 1) * 31));
    COL_W = 24; COL_W_MIN = 9;
    weekStart = 1;
    tier = "day";
    startISO = shiftISO(today, -3);          // 今日の少し手前から
  } else {
    // 表示単位(日/週)＋スパンから 窓日数・列幅・起点 を決める（gview に保持＝再描画をまたぐ）
    const spanList = SPANS[gview.unit];
    const spanKey = gview.unit === "day" ? gview.spanDay : gview.spanWeek;
    const preset = spanList.find((p) => p.key === spanKey) || spanList[0];
    WINDOW_DAYS = preset.days;
    COL_W = preset.colW;
    COL_W_MIN = preset.colW;   // プリセット列幅は「最小」。利用可能幅が広ければ fitColumns で伸ばす
    weekStart = gview.weekStart;                 // 週の開始曜日(0=日..6=土)
    tier = gview.unit === "day" ? "day" : "week"; // 日表示=毎日ラベル / 週表示=週ラベル
    startISO = shiftISO(today, -preset.back);
  }
  const scale = dayScale(startISO, WINDOW_DAYS);

  // N+1: plans/times を持つタスクだけ個別取得（planner.js と同方式）。B42: module キャッシュ経由で
  // 軸変更（span/unit/週開始）の render 再実行時はネットワーク再取得せず paint のみにする。
  const { plansById, timesById, plansArr, timesArr } = await fetchPlansTimes(tasks);
  const rangeByTask = new Map(tasks.map((t) => [t.id, taskRanges(t, plansById.get(t.id) || [], timesById.get(t.id) || [])]));
  const edges = dependencyEdges(tasks);
  // プロジェクト=親タスク（related_tasks.subtask の親）。子→親 / 親集合 を作る（プロジェクト別レーン用）。
  // 階層: ワークスペース(project_id) ＞ プロジェクト(親タスク) ＞ タスク。
  const byIdAll = new Map(tasks.map((t) => [t.id, t]));
  const parentOf = new Map();
  const hasChild = new Set();
  for (const t of tasks) {
    for (const s of (((t.related_tasks || {}).subtask) || [])) {
      if (byIdAll.has(s.id) && s.id !== t.id) { parentOf.set(s.id, t.id); hasChild.add(t.id); }
    }
  }
  const planByMember = sumByMemberDay(toMemberDayEntries(plansArr, "plan"));
  const actByMember = sumByMemberDay(toMemberDayEntries(timesArr, "time"));

  const state = {
    // 全画面=保持／埋め込み=固定。"task"モードは廃止なので member 以外は project に正規化。
    mode: (embedded ? (opts.mode || "member") : gview.mode) === "member" ? "member" : "project",
    hideDone: false,
    members: new Set(members.map((m) => m.id)),
    // 埋め込みは描画ごとに使い捨ての Set（gview の共有状態を汚さない）
    collapsed: embedded ? new Set() : gview.collapsed,
    // B39/B40/B41: 全画面のみ操作可（埋め込みは閲覧主体＝既定 off）。
    withDeps: embedded ? false : gview.withDeps,
    critical: embedded ? false : gview.critical,
    showUnscheduled: embedded ? false : gview.showUnscheduled,
  };
  // B40: クリティカルパス（依存グラフの最長鎖）。窓に依存しないので render 単位で一度だけ算出。
  const critById = depLayers(tasks.map((t) => t.id), edges).critical;
  const memberIdx = new Map(members.map((m, i) => [m.id, i]));
  // 直近の描画で出現した「折りたたみ可能な見出し」の data-toggle キー集合。
  // 全折りたたみボタンはこれを state.collapsed に流し込む（paint 中に各見出しが登録する）。
  let collapsibleKeys = new Set();

  root.innerHTML = shell(members, memberIdx, state.mode, embedded, opts.maxHeight);
  const head = root.querySelector("#gv-head");
  const rowsEl = root.querySelector("#gv-rows");
  const ganttEl = root.querySelector("#gv-gantt");
  const scrollEl = root.querySelector(".gv-scroll");
  ganttEl.classList.toggle("tight", tier === "week");   // 週表示=日罫線を消し週(開始曜日)罫線だけにする

  // 列幅を「実際の表示幅」にフィットさせる。プリセット列幅(COL_W_MIN)を下限に、
  // 余白が出るなら列を広げて右まで使い切る／溢れるならプリセット幅のまま横スクロール。
  // CSS(grid)と JS(バー px 計算)の両方が参照する COL_W を一致させるため --col-w も書き換える。
  function fitColumns() {
    const labelW = LABEL_W_P;   // project/member ともラベル幅は LABEL_W_P（"task"モード廃止）
    // clientWidth = 内側幅(縦スクロールバー除外済み)。利用可能なチャート幅 = 全幅 - ラベル列。
    const avail = scrollEl.clientWidth - labelW;
    if (avail > 0) {
      // 端数切り捨てで整数px化（小数だと罫線がにじむ）。下限はプリセット列幅。
      const fit = Math.floor(avail / WINDOW_DAYS);
      COL_W = Math.max(COL_W_MIN, fit);
    } else {
      COL_W = COL_W_MIN;
    }
    ganttEl.style.setProperty("--col-w", COL_W + "px");
  }

  // ヘッダは2段（月バンド＋日付）。日表示=毎日 dom+曜日 / 週表示=週開始日だけ dom。
  function gridHead(labelW) {
    // 月バンド: 連続する同月をまとめて span
    const months = [];
    for (let i = 0; i < scale.axis.length;) {
      const ym = scale.axis[i].iso.slice(0, 7);
      let j = i; while (j < scale.axis.length && scale.axis[j].iso.slice(0, 7) === ym) j++;
      months.push({ span: j - i, label: `${+ym.slice(0, 4)}年${+ym.slice(5, 7)}月` });
      i = j;
    }
    const monthRow = `<div class="gh-corner gh-mc"></div>` +
      months.map((m) => `<div class="gh-month" style="grid-column:span ${m.span}">${m.label}</div>`).join("");
    const corner = state.mode === "member" ? "人別" : "プロジェクト";
    const dayRow = `<div class="gh-corner">${corner} / 日付</div>` + scale.axis.map((a) => {
      const cls = (a.weekend ? " weekend" : "") + (a.iso === today ? " today" : "");
      const dom = a.iso.slice(8);
      const showNum = tier === "day" || a.dow === weekStart;   // 週表示は週開始日だけ日付
      const numHtml = showNum ? `<div class="dom">${+dom}</div>` : "";
      const dowHtml = tier === "day" ? `<div class="dow">${DOW[a.dow]}</div>` : "";
      return `<div class="gh-day${cls}${tier !== "day" ? " sparse" : ""}${a.dow === weekStart ? " wk" : ""}">${numHtml}${dowHtml}</div>`;
    }).join("");
    return monthRow + dayRow;
  }

  // タスク1行ぶんのバー領域HTML（予定バー＋実績バー）。taskId を data 属性に載せてドラッグで参照。
  function barsHTML(r, taskId) {
    const cells = scale.axis.map((a) => `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === weekStart ? " wk" : ""}"></div>`).join("");
    const tName = (byIdAll.get(taskId) || {}).title || "";
    let bars = "";
    if (r.planned.source) {
      const pg = scale.range(r.planned.start, r.planned.end);
      const left = pg.fromIdx * COL_W + 2, w = pg.span * COL_W - 4;
      const clip = (pg.clippedLeft ? " clipL" : "") + (pg.clippedRight ? " clipR" : "");
      // dates のみ端リサイズ可。plans/dates/due はすべて移動＋クリックで編集（draggable）。
      const resizable = r.planned.source === "dates";
      const handles = resizable ? `<span class="bar-h l"></span><span class="bar-h r"></span>` : "";
      // タップ端末向けの「移動」アフォーダンス（プログレッシブ拡張）。HTML5/pointerドラッグが効かない
      // タッチ環境では (hover:none)/(pointer:coarse) で常時可視。マウス環境ではホバー/フォーカス時のみ
      // 小さく出す控えめなボタン。クリックで日付シフトの小メニューを開く（既存DnDの日付更新を流用）。
      const shiftBtn = `<button class="bar-shift" type="button" data-task="${taskId}" aria-label="${esc((tName ? tName + " " : "") + "の日程をずらす")}" title="日程をずらす">⋮</button>`;
      // スクリーンリーダー向け: タスク名＋予定（時間・由来）。視覚的 title はホバー用に従来どおり保持。
      const planAria = `${tName ? tName + " " : ""}予定 ${fmtH(r.planned.h)}（${srcLabel(r.planned.source)}）`;
      bars += `<div class="bar plan draggable${clip}" role="img" aria-label="${esc(planAria)}" data-task="${taskId}" data-src="${r.planned.source}" style="left:${left}px;width:${w}px" title="予定 ${fmtH(r.planned.h)}（${srcLabel(r.planned.source)}）・ドラッグで移動${resizable ? "／端で伸縮" : ""}・クリックで編集">${handles}${shiftBtn}</div>`;
    }
    if (r.actual.start) {
      const ag = scale.range(r.actual.start, r.actual.end);
      const left = ag.fromIdx * COL_W + 2, w = ag.span * COL_W - 4;
      const pct = Math.min(100, r.percent);
      const fill = r.over ? C.over : (r.percent >= 100 ? C.free : C.fill);
      // スクリーンリーダー向け: タスク名＋実績/見積＋進捗%＋超過フラグ。
      const actAria = `${tName ? tName + " " : ""}実績 ${fmtH(r.actual.h)} / 見積 ${fmtH(r.estH)}・進捗 ${r.percent}%${r.over ? "・超過" : ""}`;
      bars += `<div class="bar act${r.over ? " over" : ""}" role="img" aria-label="${esc(actAria)}" style="left:${left}px;width:${w}px" title="実績 ${fmtH(r.actual.h)} / 見積 ${fmtH(r.estH)}">
        <div class="fill" style="width:${pct}%;background:${fill}"></div>
        <div class="blabel">${r.percent}%</div></div>`;
    }
    return `<div class="r-cells">${cells}</div><div class="bar-area">${bars}</div>`;
  }

  function visibleTasks() {
    return tasks.filter((t) => {
      // WSは常に全表示（UIから消したのでWSでのスコープは行わない）
      const aids = (t.assignees || []).map((a) => a.id);
      if (aids.length && !aids.some((id) => state.members.has(id))) return false;
      const r = rangeByTask.get(t.id);
      if (!r.planned.source) return false;
      if (!scale.intersects(r.planned.start, r.planned.end)) return false;
      if (state.hideDone && r.percent >= 100) return false;
      return true;
    });
  }

  // B41: 当該メンバー担当だが「予定が無い」または「予定が窓外」で visibleTasks に出ないタスク。
  // 完了は除外（hideDone と無関係に未予定リストでは完了を出さない＝行動対象のみ）。
  function memberUnscheduled(m) {
    return tasks.filter((t) => {
      if (t.done) return false;
      if (!(t.assignees || []).some((a) => a.id === m.id)) return false;
      const r = rangeByTask.get(t.id);
      if (r.planned.source && scale.intersects(r.planned.start, r.planned.end)) return false; // 予定あり＝通常行に出る
      return true;
    });
  }

  // 子タスク群（＋親に予定があれば親も）から「集約バー」用の合成レンジを作る。
  // start=最早予定開始 / end=最遅予定終了 / h=予定合計。窓と交差する予定だけ集約。
  function aggRange(tasksForAgg) {
    let start = null, end = null, h = 0, src = null;
    for (const t of tasksForAgg) {
      const r = rangeByTask.get(t.id);
      if (!r || !r.planned.source) continue;
      if (!scale.intersects(r.planned.start, r.planned.end)) continue;
      h += r.planned.h || 0;
      if (!start || r.planned.start < start) start = r.planned.start;
      if (!end || r.planned.end > end) end = r.planned.end;
      src = "agg";
    }
    return { start, end, h, src };
  }

  // 集約バー（読み取り専用の帯。ドラッグ/編集不可＝個別の子タスク行で行う）。
  function aggBarHTML(ar) {
    const cells = scale.axis.map((a) => `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === weekStart ? " wk" : ""}"></div>`).join("");
    let bars = "";
    if (ar.src && ar.start) {
      const pg = scale.range(ar.start, ar.end);
      const left = pg.fromIdx * COL_W + 2, w = pg.span * COL_W - 4;
      const clip = (pg.clippedLeft ? " clipL" : "") + (pg.clippedRight ? " clipR" : "");
      bars += `<div class="bar plan agg${clip}" style="left:${left}px;width:${w}px" title="子タスクの予定をまとめた帯 ・ 予定合計 ${fmtH(ar.h)}"></div>`;
    }
    return `<div class="r-cells">${cells}</div><div class="bar-area">${bars}</div>`;
  }

  // 1タスク行（人別/未アサイン共通）。child=trueでプロジェクト配下のネスト見た目。
  // isLast=最後の子（ツリー縦線をエルボーで止める）／band=親プロジェクト色（ツリー線色）。
  function memberTaskRow(t, child, isLast, band) {
    const r = rangeByTask.get(t.id);
    const treeCls = child ? ` mp-child${isLast ? " last" : ""}` : "";
    const treeStyle = child && band ? ` style="--pj:${band}"` : "";
    return `<div class="row${r.over ? " delayed" : ""}${treeCls}" data-task="${t.id}"${treeStyle}>
      <div class="r-label r-label-sub">
        <span class="r-text"><span class="r-name" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="r-meta"><span>見${fmtH(r.estH)}・実${fmtH(r.spentH)}・予${fmtH(r.planned.h)}</span>
          ${r.over ? `<span class="r-flag">超過</span>` : ""}</span></span>
      </div>
      ${barsHTML(r, t.id)}
    </div>`;
  }

  // 親プロジェクトのサブグループ見出し（集約バー付き・既定展開）と、展開時の子タスク行。
  // toggleKey はメンバー折りたたみ "m"+id と衝突しない "mp"+m.id+"_"+pid。
  // startY/rowYById を渡すと展開中の子タスク行の中央y(px)を記録（B39 依存矢印の終点用）。
  function parentSubgroup(toggleKey, pid, children, includeParentInAgg, startY, rowYById) {
    collapsibleKeys.add(toggleKey);
    const parent = byIdAll.get(pid);
    const title = parent ? parent.title : "（不明なプロジェクト）";
    // サブグループは既定展開＝toggleKey の「存在」が折りたたみフラグ（メンバー/通常グループと同じ向き）。
    // 埋め込みは state.collapsed が毎回新規 Set ＝未登録＝展開で子が見える。
    const collapsed = state.collapsed.has(toggleKey);
    const aggSrc = includeParentInAgg && parent ? [parent, ...children] : children;
    const ar = aggRange(aggSrc);
    const totH = children.reduce((s, t) => s + (rangeByTask.get(t.id).planned.h || 0), 0)
               + (includeParentInAgg && parent ? (rangeByTask.get(pid).planned.h || 0) : 0);
    let h = `<div class="grp mp-sub${collapsed ? " collapsed" : ""}">
      <div class="grp-label mp-sublabel" data-toggle="${toggleKey}">
        <span class="caret">▾</span>
        <span class="pj-band" style="background:${projColor(parent ? parent.project_id : 0)}"></span>
        <span class="grp-text">
          <span class="grp-top"><span class="grp-name" title="${esc(title)}">${esc(title)}</span>
            <span class="grp-sub">${children.length}タスク</span></span>
          <span class="grp-sub">予${fmtH(totH)}</span>
        </span>
      </div>
      ${collapsed ? aggBarHTML(ar) : ""}
    </div>`;
    let rows = GRP_H;
    if (!collapsed) {
      const band = projColor(parent ? parent.project_id : 0);
      children.forEach((t, i) => {
        h += memberTaskRow(t, true, i === children.length - 1, band);
        if (rowYById && startY != null) rowYById.set(t.id, startY + rows + ROW_H / 2);
        rows += ROW_H;
      });
    }
    return { html: h, rows };
  }

  // 担当タスクを「親なし(直下)」と「親ごとの子タスク群」に分ける。
  // 親が当人の担当でなくても、子が担当なら親サブグループ見出しは出す。
  function groupByParent(mtasks) {
    const direct = [], childByParent = new Map();
    for (const t of mtasks) {
      const pid = parentOf.get(t.id);
      if (pid && byIdAll.has(pid)) {
        if (!childByParent.has(pid)) childByParent.set(pid, []);
        childByParent.get(pid).push(t);
      } else {
        direct.push(t);
      }
    }
    // 親自身が当人の担当で direct に入っている場合、その子も同グループにあるなら
    // 親はサブグループ見出しに集約する（直下行と見出しの二重表示を避ける）。
    const childParentIds = new Set(childByParent.keys());
    return { direct: direct.filter((t) => !childParentIds.has(t.id)), childByParent };
  }

  function paintMemberMode() {
    ganttEl.style.setProperty("--label-w", LABEL_W_P + "px");
    head.innerHTML = gridHead(LABEL_W_P);
    collapsibleKeys = new Set();
    let html = "", rowOffset = 0;
    const rowYById = new Map();   // B39: タスクid→バー行中央y(px)。依存矢印の端点に使う。
    const sortByStart = (a, b) => {
      const sa = rangeByTask.get(a.id).planned.start || "9999", sb = rangeByTask.get(b.id).planned.start || "9999";
      return sa < sb ? -1 : sa > sb ? 1 : a.id - b.id;
    };
    for (const m of members.filter((m) => state.members.has(m.id))) {
      const idx = memberIdx.get(m.id);
      const mtasks = visibleTasks().filter((t) => (t.assignees || []).some((a) => a.id === m.id));
      const dayMap = planByMember[m.id] || {};
      // 日別の正確な容量（週末/祝日/休暇=0、平日=capH）。窓内容量は日別の合計。
      const capOf = (iso) => capacityOn(m, iso, { holidays: holidaysSet, unavailabilityByMember, capH });
      const winH = scale.axis.reduce((s, a) => s + (dayMap[a.iso] || 0), 0);
      const cap = scale.axis.reduce((s, a) => s + capOf(a.iso), 0);
      const pct = cap ? Math.round((winH / cap) * 100) : 0;
      const capCol = pct > 100 ? C.over : pct >= 70 ? C.amber : C.free;
      collapsibleKeys.add("m" + m.id);
      const collapsed = state.collapsed.has("m" + m.id);
      // グループ日セル＝日別容量の可視化: 容量0(週末/祝日/休暇)=淡色、予定が容量超過=赤帯、
      // それ以外で予定ありは負荷比に応じた薄い帯。負荷バー(下の各タスク行)と容量を読み比べられる。
      const gcells = scale.axis.map((a) => {
        const c = capOf(a.iso), planH = dayMap[a.iso] || 0;
        let bg = "";
        if (c <= 0) bg = "background:rgba(120,130,150,.10)";                 // 容量0（休み）=淡色
        else if (planH > c + 1e-6) bg = "background:rgba(229,72,77,.16)";    // 容量超過=赤
        else if (planH > 1e-6) bg = `background:rgba(58,134,255,${(0.05 + 0.13 * Math.min(1, planH / c)).toFixed(3)})`; // 負荷比で青みを濃く
        return `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === weekStart ? " wk" : ""}${c <= 0 ? " capoff" : ""}" style="${bg}"></div>`;
      }).join("");
      html += `<div class="grp${collapsed ? " collapsed" : ""}" data-mid="${m.id}">
        <div class="grp-label" data-toggle="m${m.id}">
          <span class="caret">▾</span>
          <span class="avatar" style="background:${member_color(idx)}">${esc(initial(m.name))}</span>
          <span class="grp-text">
            <span class="grp-top"><span class="grp-name" title="${esc(m.name)}">${esc(m.name)}</span>
              <span class="cap-track"><span class="cap-fill" style="width:${Math.min(pct, 100)}%;background:${capCol}"></span></span>
              <span class="grp-sub">${pct}% ・ 予${fmtH(winH)}/${cap}h</span></span>
            <span class="grp-sub">${mtasks.length}タスク</span>
          </span>
        </div>
        <div class="grp-cells">${gcells}</div>
      </div>`;
      rowOffset += GRP_H;
      if (!collapsed) {
        const { direct, childByParent } = groupByParent(mtasks);
        // 親なしタスク（従来どおりメンバー直下の行）
        for (const t of direct.sort(sortByStart)) {
          html += memberTaskRow(t, false);
          rowYById.set(t.id, rowOffset + ROW_H / 2);   // B39: バー行中央y
          rowOffset += ROW_H;
        }
        // 子タスク群（親サブグループ配下にネスト・既定折りたたみ・集約バー）
        const parents = [...childByParent.keys()].sort((a, b) => {
          const ta = (byIdAll.get(a) || {}).title || "", tb = (byIdAll.get(b) || {}).title || "";
          return ta.localeCompare(tb, "ja");
        });
        for (const pid of parents) {
          const kids = childByParent.get(pid).sort(sortByStart);
          // 親自身がこのメンバー担当かつ予定があれば集約に含める（dayMap集計とは別物＝二重計上しない）
          const parent = byIdAll.get(pid);
          const includeParent = !!parent && humanAssignees(parent).some((a) => a.id === m.id);
          const sg = parentSubgroup("mp" + m.id + "_" + pid, pid, kids, includeParent, rowOffset, rowYById);
          html += sg.html; rowOffset += sg.rows;
        }
        // B41: 未予定タスク行をオプション表示。当人担当だが予定（plans/期間/締切）が無い or 窓外で
        // 通常の mtasks(=visibleTasks) に出ないものを、折りたためる小見出しの下にまとめる。
        if (state.showUnscheduled) {
          const us = memberUnscheduled(m).sort((a, b) => a.id - b.id);
          if (us.length) {
            const usKey = "mu" + m.id;
            collapsibleKeys.add(usKey);
            const usCol = state.collapsed.has(usKey);
            html += `<div class="grp mp-sub mp-unsched${usCol ? " collapsed" : ""}">
              <div class="grp-label mp-sublabel" data-toggle="${usKey}">
                <span class="caret">▾</span>
                <span class="pj-band pj-band-none"></span>
                <span class="grp-text"><span class="grp-top"><span class="grp-name">未予定タスク</span>
                  <span class="grp-sub">${us.length}件</span></span>
                  <span class="grp-sub">日程が未設定（クリックで設定）</span></span>
              </div>
            </div>`;
            rowOffset += GRP_H;
            if (!usCol) {
              us.forEach((t, i) => {
                html += memberTaskRow(t, true, i === us.length - 1, C.lineStrong);
                rowOffset += ROW_H;   // 未予定＝バー無しなので依存矢印端点(rowYById)には載せない
              });
            }
          }
        }
      }
    }

    // ── 未アサイン（担当者未定）グループ: 人間担当が居ない未完了タスクをまとめる ──
    // 容量概念なし＝容量線/負荷帯は出さない。タスククリックで担当割当の編集が可能。
    // visibleTasks の「担当が表示中メンバーに含まれるか」ゲートは通さない（人間担当が居ない＝
    // AI担当のみ/完全未割当も拾う）。WS/予定/窓/完了フィルタは同条件で揃える。
    const unassigned = tasks.filter((t) => {
      if (t.done) return false;
      if (humanAssignees(t).length !== 0) return false;       // 人間担当が居るものは各人レーンに出る
      // WSは常に全表示（WSでのスコープは行わない）
      const r = rangeByTask.get(t.id);
      if (!r.planned.source) return false;
      if (!scale.intersects(r.planned.start, r.planned.end)) return false;
      if (state.hideDone && r.percent >= 100) return false;
      return true;
    });
    if (unassigned.length) {
      collapsibleKeys.add("unassigned");
      const uCollapsed = state.collapsed.has("unassigned");
      const ugcells = scale.axis.map((a) => `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === weekStart ? " wk" : ""}"></div>`).join("");
      html += `<div class="grp grp-unassigned${uCollapsed ? " collapsed" : ""}" data-mid="unassigned">
        <div class="grp-label" data-toggle="unassigned">
          <span class="caret">▾</span>
          <span class="avatar avatar-none">${icon("user", { size: 17 })}</span>
          <span class="grp-text">
            <span class="grp-top"><span class="grp-name">未アサイン（担当者未定）</span></span>
            <span class="grp-sub">担当者未定 ・ ${unassigned.length}タスク</span>
          </span>
        </div>
        <div class="grp-cells">${ugcells}</div>
      </div>`;
      rowOffset += GRP_H;
      if (!uCollapsed) {
        const { direct, childByParent } = groupByParent(unassigned);
        for (const t of direct.sort(sortByStart)) {
          html += memberTaskRow(t, false);
          rowYById.set(t.id, rowOffset + ROW_H / 2);   // B39
          rowOffset += ROW_H;
        }
        const parents = [...childByParent.keys()].sort((a, b) => {
          const ta = (byIdAll.get(a) || {}).title || "", tb = (byIdAll.get(b) || {}).title || "";
          return ta.localeCompare(tb, "ja");
        });
        for (const pid of parents) {
          const kids = childByParent.get(pid).sort(sortByStart);
          const parent = byIdAll.get(pid);
          const includeParent = !!parent && humanAssignees(parent).length === 0 && unassigned.includes(parent);
          const sg = parentSubgroup("up_" + pid, pid, kids, includeParent, rowOffset, rowYById);
          html += sg.html; rowOffset += sg.rows;
        }
      }
    }

    rowsEl.innerHTML = html || `<div class="empty">メンバーがいません（担当の付いたタスクが必要）。</div>`;
    // ツリー縦線を、親サブグループ見出しの色四角(.mp-sub .pj-band)の中心に揃える。
    // 四角のx位置は caret/インデントの字幅に依存しフォントで変わるため、実測して --mprail に入れる。
    const mpb = rowsEl.querySelector('.grp.mp-sub .pj-band');
    if (mpb) {
      const lab = mpb.closest('.grp-label');
      const bb = mpb.getBoundingClientRect();
      const off = bb.left + bb.width / 2 - lab.getBoundingClientRect().left; // ラベル左端からの四角中心
      rowsEl.style.setProperty('--mprail', (off - 1) + 'px'); // 2px線の左端＝中心-1
    }
    overlays(rowOffset, rowYById);
  }

  // プロジェクト別レーン（人別レーンと同型）。プロジェクト=親タスク(related_tasks.subtask)。
  // プロジェクト見出し＋配下に子タスク（日付順）。親に属さない単独タスクは「プロジェクトなし」へ。折りたたみ可。
  function paintProjectMode() {
    ganttEl.style.setProperty("--label-w", LABEL_W_P + "px");
    head.innerHTML = gridHead(LABEL_W_P);
    collapsibleKeys = new Set();
    // ベースフィルタ（WS/担当/完了）。予定の有無は問わない＝プロジェクト構造を見せる。
    const passBase = (t) => {
      // WSは常に全表示（WSでのスコープは行わない）
      const aids = (t.assignees || []).map((a) => a.id);
      if (aids.length && !aids.some((id) => state.members.has(id))) return false;
      if (state.hideDone && rangeByTask.get(t.id).percent >= 100) return false;
      return true;
    };
    const isScheduled = (t) => {
      const r = rangeByTask.get(t.id);
      return !!r.planned.source && scale.intersects(r.planned.start, r.planned.end);
    };
    // バケット化: 子→親プロジェクトへ。プロジェクト配下は未予定でも表示／単独は予定ありのみ。
    const buckets = new Map(); // pid(親タスクid or 0) -> [task]
    for (const t of tasks) {
      if (!passBase(t)) continue;
      const pid = parentOf.has(t.id) ? parentOf.get(t.id) : (hasChild.has(t.id) ? t.id : 0);
      if (pid === t.id) continue;            // 親タスク自身は見出し（行にしない）
      if (pid === 0 && !isScheduled(t)) continue; // プロジェクトなしは予定ありのみ（未予定の単独で溢れさせない）
      if (!buckets.has(pid)) buckets.set(pid, []);
      buckets.get(pid).push(t);
    }
    // 並び: 名前付きプロジェクトをタイトル順 → 「プロジェクトなし」(0) は末尾。
    const groups = [...buckets.entries()]
      .map(([pid, items]) => ({ pid, title: pid ? ((byIdAll.get(pid) || {}).title || "（不明なプロジェクト）") : "（プロジェクトなし）", ws: pid ? (byIdAll.get(pid) || {}).project_id : null, items }))
      .sort((a, b) => (a.pid === 0 ? 1 : b.pid === 0 ? -1 : a.title.localeCompare(b.title, "ja")));

    let html = "", rowOffset = 0;
    const rowYById = new Map();   // B39: タスクid→バー行中央y(px)
    for (const g of groups) {
      const items = g.items.slice().sort((a, b) => {
        // 予定ありを開始日順で先頭、未予定は末尾へ。
        const sa = rangeByTask.get(a.id).planned.start || "9999", sb = rangeByTask.get(b.id).planned.start || "9999";
        return sa < sb ? -1 : sa > sb ? 1 : a.id - b.id;
      });
      const agg = items.reduce((s, t) => {
        const r = rangeByTask.get(t.id);
        s.est += r.estH; s.spent += r.spentH; s.plan += r.planned.h; return s;
      }, { est: 0, spent: 0, plan: 0 });
      collapsibleKeys.add("p" + g.pid);
      const collapsed = state.collapsed.has("p" + g.pid);
      const gcells = scale.axis.map((a) => `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === weekStart ? " wk" : ""}"></div>`).join("");
      const band = g.pid ? projColor(g.ws) : C.muted;
      html += `<div class="grp${collapsed ? " collapsed" : ""}" data-pid="${g.pid}" style="--pj:${band}">
        <div class="grp-label" data-toggle="p${g.pid}">
          <span class="caret">▾</span>
          <span class="pj-band" style="background:${band}"></span>
          <span class="grp-text">
            <span class="grp-top"><span class="grp-name" title="${esc(g.title)}">${esc(g.title)}</span>
              <span class="grp-sub">${items.length}タスク</span></span>
            <span class="grp-sub">見${fmtH(agg.est)}・実${fmtH(agg.spent)}・予${fmtH(agg.plan)}</span>
          </span>
        </div>
        <div class="grp-cells">${gcells}</div>
      </div>`;
      rowOffset += GRP_H;
      if (collapsed) continue;
      for (const t of items) {
        const r = rangeByTask.get(t.id);
        const asg = (t.assignees || []);
        const avs = asg.slice(0, 2).map((a) => {
          const idx = memberIdx.get(a.id) ?? a.id;
          return `<span class="ava" style="background:${member_color(idx)}">${esc(initial(a.name || a.username))}</span>`;
        }).join("") + (asg.length > 2 ? `<span class="more">+${asg.length - 2}</span>` : "");
        const noplan = !r.planned.source && !r.actual.start;
        const isLast = t === items[items.length - 1];
        const treeCls = g.pid ? ` pj-child${isLast ? " last" : ""}` : "";  // 実プロジェクト配下のみツリー表示
        html += `<div class="row${r.over ? " delayed" : ""}${noplan ? " noplan" : ""}${treeCls}" data-task="${t.id}"${g.pid ? ` style="--pj:${band}"` : ""}>
          <div class="r-label r-label-sub">
            <span class="r-text"><span class="r-name" title="${esc(t.title)}">${esc(t.title)}</span>
              <span class="r-meta">${avs ? `<span class="av">${avs}</span>` : ""}
                <span class="r-who">${asg[0] ? esc(asg[0].name || asg[0].username) : "未割当"}</span>
                <span>見${fmtH(r.estH)}・実${fmtH(r.spentH)}・予${fmtH(r.planned.h)}</span>
                ${r.over ? `<span class="r-flag">超過</span>` : ""}
                ${noplan ? `<span class="r-noplan">予定なし</span>` : ""}</span></span>
          </div>
          ${barsHTML(r, t.id)}
        </div>`;
        rowYById.set(t.id, rowOffset + ROW_H / 2);   // B39: バー行中央y
        rowOffset += ROW_H;
      }
    }
    rowsEl.innerHTML = html || `<div class="empty">表示できるタスクがありません（窓: ${startISO}〜${scale.axis[WINDOW_DAYS - 1].iso}）。</div>`;
    // 子タスクの縦線を、見出しの色四角(pj-band)の中心に正確に合わせる。
    // 四角のx位置は caret(▾) の字幅に依存しフォントで変わるため、固定pxにせず実測して --pjrail に入れる。
    const pb = rowsEl.querySelector('.grp[data-pid]:not([data-pid="0"]) .pj-band');
    if (pb) {
      const lab = pb.closest('.grp-label');
      const bb = pb.getBoundingClientRect();
      const off = bb.left + bb.width / 2 - lab.getBoundingClientRect().left; // ラベル左端からの四角中心
      rowsEl.style.setProperty('--pjrail', (off - 1) + 'px'); // 2px線の左端＝中心-1
    }
    overlays(rowOffset, rowYById);
  }

  // 今日線（＋B39 依存矢印SVG）。rowYById: タスクid→そのバー行の中央y(px)。行高は見出し(GRP_H)と
  // タスク行(ROW_H)が混在するため uniform index ではなく実測した行中央yで線を引く（人別/プロジェクト両対応）。
  function overlays(totalH, rowYById) {
    // 今日線
    const ti = scale.indexOf(today);
    if (ti >= 0 && ti < WINDOW_DAYS && totalH > 0) {
      const left = LABEL_W_P + ti * COL_W + COL_W / 2;
      rowsEl.insertAdjacentHTML("beforeend",
        `<div class="today-line" style="left:${left}px;height:${totalH}px"><span class="tl-cap">今日</span></div>`);
    }
    if (!state.withDeps || !rowYById || !rowYById.size) return;
    // 依存矢印（予定バー right→left のL字）。両端が「予定あり＆この描画で可視」な辺のみ描く。
    // B40: クリティカルパス上の辺（from/to 両方が critById）は太線・濃色・実線で強調。
    const critOn = state.critical;
    const paths = edges.filter((e) => rowYById.has(e.from) && rowYById.has(e.to)).map((e) => {
      const rf = rangeByTask.get(e.from), rt = rangeByTask.get(e.to);
      if (!rf || !rt || !rf.planned.source || !rt.planned.source) return "";
      const fg = scale.range(rf.planned.start, rf.planned.end), tg = scale.range(rt.planned.start, rt.planned.end);
      const x1 = fg.toIdx * COL_W + COL_W - 2, x2 = tg.fromIdx * COL_W + 2;
      const y1 = rowYById.get(e.from), y2 = rowYById.get(e.to);
      const midX = Math.max(x1 + 14, x2 - 14);
      const isCrit = critOn && critById.has(e.from) && critById.has(e.to);
      const stroke = isCrit ? C.over : C.capline;
      const sw = isCrit ? 2.2 : 1.4;
      const dash = isCrit ? "" : ` stroke-dasharray="3 3"`;
      const marker = isCrit ? "gv-arrow-c" : "gv-arrow";
      return `<path d="M${x1} ${y1} H${midX} V${y2} H${x2}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash} marker-end="url(#${marker})"/>`;
    }).filter(Boolean).join("");
    if (paths) {
      rowsEl.insertAdjacentHTML("beforeend",
        `<svg class="deps" style="width:${WINDOW_DAYS * COL_W}px;height:${totalH}px">
          <defs>
            <marker id="gv-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="${C.capline}"/></marker>
            <marker id="gv-arrow-c" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="${C.over}"/></marker>
          </defs>
          ${paths}</svg>`);
    }
  }

  function paint() {
    fitColumns();   // 表示幅に合わせ列幅を再算出（モードでラベル幅が変わるので毎回）
    if (state.mode === "member") paintMemberMode();
    else paintProjectMode();   // project（"task"廃止＝既定はプロジェクト別）
  }

  // 今日列がチャート領域の中央付近に来るよう横スクロール。窓外（過去/未来に今日が無い）なら何もしない。
  // ラベル列(固定)はスクロール対象外なので、可視チャート幅 = clientWidth - LABEL_W_P で中央寄せを計算。
  function scrollToToday(smooth) {
    const ti = scale.indexOf(today);
    if (ti < 0 || ti >= WINDOW_DAYS) return;        // 今日が表示窓の外（過去/未来）なら据え置き
    const todayCenter = LABEL_W_P + ti * COL_W + COL_W / 2;   // チャート内での今日列の中心x(px)
    const chartW = scrollEl.clientWidth - LABEL_W_P;          // ラベル列を除いた可視チャート幅
    const target = Math.max(0, todayCenter - LABEL_W_P - chartW / 2);
    try { scrollEl.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" }); }
    catch { scrollEl.scrollLeft = target; }         // scrollTo 非対応フォールバック
  }

  // closeDayPop は編集系（日別予定ポップアップ）が editable のとき本体を差し込む。
  // 非 editable（埋め込み閲覧）では no-op のまま＝onResize から安全に呼べる。
  let closeDayPop = () => {};

  // ウィンドウ/サイドバー変化に追従して列幅を再フィット（バー px 位置も含め再描画）。
  // 同一 render 内のみ有効化し、次 render 前に解除してリスナーの多重登録を防ぐ。
  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { closeDayPop(); paint(); });
  };
  window.addEventListener("resize", onResize);
  const ro = new ResizeObserver(onResize);
  ro.observe(scrollEl);
  // 全リスナー/observer を確実に解除する（多重呼び出し安全）。埋め込みは renderInto の返り値から、
  // 全画面は MutationObserver(scrollEl が DOM から外れたら) から呼ぶ。
  let torndown = false;
  const teardown = () => {
    if (torndown) return; torndown = true;
    window.removeEventListener("resize", onResize);
    ro.disconnect();
    try { mo.disconnect(); } catch {}
    closeDayPop();
  };
  // MutationObserver で root の子要素差し替え（＝再描画/画面遷移）を検知して自動 teardown。
  // 埋め込みでもホーム再描画でコンテナが空にされた瞬間に解除＝リスナー漏れ防止。
  const mo = new MutationObserver(() => { if (!root.contains(scrollEl)) teardown(); });
  mo.observe(root, { childList: true });

  // ── ツールバー配線（全画面のみ。埋め込みはツールバー無し＝スキップ） ──
  if (!embedded) {
  root.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => {
      state.mode = gview.mode = b.dataset.mode;   // 選択モードを保持
      root.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === state.mode));
      paint();
    };
  });
  // 表示単位/スパン/週開始: 窓・列幅・グリッドが変わるので全再描画（データは store キャッシュ）。選択は記憶。
  root.querySelectorAll("[data-unit]").forEach((b) => {
    b.onclick = () => { gview.unit = b.dataset.unit; saveGV(); render(root); };
  });
  root.querySelectorAll("[data-span]").forEach((b) => {
    b.onclick = () => { if (gview.unit === "day") gview.spanDay = b.dataset.span; else gview.spanWeek = b.dataset.span; saveGV(); render(root); };
  });
  const wsel = root.querySelector("#gv-weekstart");
  if (wsel) wsel.onchange = () => { gview.weekStart = +wsel.value; saveGV(); render(root); };
  root.querySelectorAll("[data-mem]").forEach((b) => {
    b.onclick = () => { toggleSet(state.members, +b.dataset.mem, b); paint(); };
  });
  root.querySelector("#gv-hidedone").onchange = (e) => { state.hideDone = e.target.checked; paint(); };
  // B39/B40/B41: 依存矢印 / クリティカルパス / 未予定行のトグル。データ再取得は不要＝paint のみ。選択は記憶。
  const depsChk = root.querySelector("#gv-deps");
  const critChk = root.querySelector("#gv-crit");
  if (depsChk) depsChk.onchange = (e) => {
    state.withDeps = gview.withDeps = e.target.checked; saveGV();
    // 依存矢印 off ならクリティカルパス強調は意味がない＝チェックボックスを無効化（状態は保持）。
    if (critChk) critChk.disabled = !e.target.checked;
    paint();
  };
  if (critChk) critChk.onchange = (e) => { state.critical = gview.critical = e.target.checked; saveGV(); paint(); };
  const unschedChk = root.querySelector("#gv-unsched");
  if (unschedChk) unschedChk.onchange = (e) => { state.showUnscheduled = gview.showUnscheduled = e.target.checked; saveGV(); paint(); };
  // 全展開 = collapsed を空に。全折りたたみ = 現モードで描画された全見出しキーを collapsed に流し込む。
  // collapsibleKeys は直近 paint で各見出しが登録済み（mode 切替時も paint が再構築）。
  // 全画面は collapsed=gview.collapsed の参照なので、書き換えがそのまま永続（saveGV 対象外＝意図通り）。
  const expandAllBtn = root.querySelector("#gv-expand-all");
  if (expandAllBtn) expandAllBtn.onclick = () => { state.collapsed.clear(); paint(); };
  const collapseAllBtn = root.querySelector("#gv-collapse-all");
  if (collapseAllBtn) collapseAllBtn.onclick = () => { for (const k of collapsibleKeys) state.collapsed.add(k); paint(); };
  // 「今日へ」: 今日列が見える位置へスムーススクロール。窓外なら scrollToToday 内で何もしない。
  const todayBtn = root.querySelector("#gv-today");
  if (todayBtn) todayBtn.onclick = () => scrollToToday(true);
  } // end if(!embedded) — toolbar wiring
  // 人別ヘッダの折り畳みは再描画後に張り直すのでイベント委譲（埋め込みでも有効）
  rowsEl.addEventListener("click", (e) => {
    const lbl = e.target.closest("[data-toggle]");
    if (!lbl) return;
    // キー: "m{memberId}" / "p{projectId}" / "unassigned" / "mp{mid}_{pid}" / "up_{pid}"。
    // いずれも「存在＝折りたたみ」で統一（未登録＝既定展開。親サブグループも既定展開）。
    const key = lbl.dataset.toggle;
    state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
    paint();
  });

  // 編集系ハンドラ（ラベルクリックで編集／バードラッグ／日別予定ポップアップ）は editable のときだけ配線。
  // 埋め込み(閲覧主体)では一切張らず、リスナーもポップアップ DOM も生成しない＝安定・無副作用。
  let drag = null, dlabel = null;
  const reload = () => { invalidate(); render(root); };
  if (editable) {
  // 左の固定ラベル列（タスク名）クリックで編集モーダル。バーの有無に関わらず全タスク行で編集可能に。
  // グループ見出し(.grp-label)は data-toggle で折り畳み専用なので .r-label のみを対象にし衝突回避。
  rowsEl.addEventListener("click", (e) => {
    if (drag) return;                               // ドラッグ直後のクリックは無視
    const lbl = e.target.closest(".r-label");
    if (!lbl) return;
    const row = lbl.closest(".row[data-task]");
    if (!row) return;
    openTaskForm({ taskId: +row.dataset.task, onSaved: reload });
  });
  const isoZ = (d) => d + "T00:00:00Z";
  const showLabel = (text, x, y) => {
    if (!dlabel) { dlabel = document.createElement("div"); dlabel.className = "gv-draglabel"; document.body.appendChild(dlabel); }
    dlabel.textContent = text; dlabel.style.left = (x + 14) + "px"; dlabel.style.top = (y - 8) + "px"; dlabel.style.display = "block";
  };
  const hideLabel = () => { if (dlabel) dlabel.style.display = "none"; };

  rowsEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".bar-shift")) return;   // 移動メニュー用ボタンはドラッグ開始しない（タップで開く）
    const bar = e.target.closest(".bar.draggable");
    if (!bar) return;
    const taskId = +bar.dataset.task;
    const r = rangeByTask.get(taskId);
    if (!r || !r.planned.source) return;
    const isHandle = e.target.classList.contains("bar-h");
    const edge = isHandle ? (e.target.classList.contains("l") ? "start" : "end") : "move";
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch {}
    drag = { bar, taskId, src: r.planned.source, edge, startX: e.clientX,
             base: { start: r.planned.start, end: r.planned.end }, dayDelta: 0, moved: false };
  });

  rowsEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 4) drag.moved = true;
    drag.dayDelta = Math.round(dx / COL_W);
    const nb = applyBarDrag(drag.base, drag.dayDelta, drag.edge);
    const pg = scale.range(nb.start, nb.end);
    drag.bar.style.left = (pg.fromIdx * COL_W + 2) + "px";
    drag.bar.style.width = (pg.span * COL_W - 4) + "px";
    drag.bar.classList.add("dragging");
    showLabel(drag.src === "due" ? fmtDisplayDow(nb.start) : `${fmtDisplayDow(nb.start)} 〜 ${fmtDisplayDow(nb.end)}`, e.clientX, e.clientY);
  });

  rowsEl.addEventListener("pointerup", async (e) => {
    const d = drag; drag = null; hideLabel();
    if (!d) return;
    d.bar.classList.remove("dragging");
    try { d.bar.releasePointerCapture(e.pointerId); } catch {}
    if (!d.moved) { // クリック＝編集モーダル
      openTaskForm({ taskId: d.taskId, onSaved: reload });
      return;
    }
    if (d.dayDelta === 0) { reload(); return; } // 動かしたが半日未満＝元へ戻す
    const nb = applyBarDrag(d.base, d.dayDelta, d.edge);
    try { await commitDrag(d.taskId, d.src, nb, d.dayDelta); }
    catch (err) { alert("日程の更新に失敗: " + err.message); }
    reload();
  });

  // ソース別のコミット。dates/due=updateTask（非破壊）、plans=全エントリを delta 日ずらす（整合）。
  async function commitDrag(taskId, src, nb, dayDelta) {
    if (src === "due") {
      await vik.updateTask(taskId, { due_date: isoZ(nb.start) });
    } else if (src === "dates") {
      await vik.updateTask(taskId, { start_date: isoZ(nb.start), end_date: isoZ(nb.end) });
    } else if (src === "plans") {
      // 日別予定（別テーブル）を delete→再作成で delta 日ずらす（seconds/user_id/start_minute/note 保持）
      for (const p of (plansById.get(taskId) || [])) {
        const newDay = shiftISO(dateOnly(p.plan_date), dayDelta);
        await vik.deletePlan(taskId, p.id);
        await vik.logPlan(taskId, p.seconds, newDay, p.note || "", p.user_id || null, p.start_minute ?? null);
      }
      // タスク本体に start/end があれば一緒にずらして整合
      const t = tasks.find((x) => x.id === taskId);
      if (t && hasDate(t.start_date) && hasDate(t.end_date)) {
        await vik.updateTask(taskId, {
          start_date: isoZ(shiftISO(dateOnly(t.start_date), dayDelta)),
          end_date: isoZ(shiftISO(dateOnly(t.end_date), dayDelta)),
        });
      }
    }
  }

  // ── タップ端末向け: バーの「⋮」から日程シフトの小メニュー（既存DnDの日付更新を流用） ──
  // タッチではネイティブ pointer ドラッグが効かず操作不能なので、同じ commitDrag を小メニューから呼ぶ。
  // デスクトップの DnD は一切変えず、これは「追加」のみ（マウスでもボタンから使えるが控えめ表示）。
  let shiftMenu = null;
  const closeShiftMenu = () => {
    if (shiftMenu) { shiftMenu.remove(); shiftMenu = null; document.removeEventListener("pointerdown", onShiftDocDown, true); document.removeEventListener("keydown", onShiftKey, true); }
  };
  function onShiftDocDown(e) { if (shiftMenu && !shiftMenu.contains(e.target)) closeShiftMenu(); }
  function onShiftKey(e) { if (e.key === "Escape") closeShiftMenu(); }

  // 指定の edge/delta でバー日付を更新（DnD と同一の applyBarDrag→commitDrag を再利用）。
  async function doShift(taskId, src, edge, dayDelta) {
    const r = rangeByTask.get(taskId);
    if (!r || !r.planned.source) return;
    const base = { start: r.planned.start, end: r.planned.end };
    const nb = applyBarDrag(base, dayDelta, edge);
    closeShiftMenu();
    try {
      await commitDrag(taskId, src, nb, dayDelta);
      const t = byIdAll.get(taskId);
      announce(`${t ? t.title + " " : ""}日程を更新しました（${src === "due" ? fmtDisplayDow(nb.start) : `${fmtDisplayDow(nb.start)} 〜 ${fmtDisplayDow(nb.end)}`}）`);
    } catch (err) { alert("日程の更新に失敗: " + err.message); }
    reload();
  }
  // 開始日を絶対指定（date input）。dates/plans は期間長を保ったまま、due は締切日そのものを移動。
  async function doSetStart(taskId, src, newStartISO) {
    const r = rangeByTask.get(taskId);
    if (!r || !r.planned.source || !newStartISO) return;
    const anchor = src === "due" ? r.planned.end : r.planned.start;   // due は単点（start=end）
    const dayDelta = Math.round((Date.parse(newStartISO + "T00:00:00Z") - Date.parse(anchor + "T00:00:00Z")) / 86400000);
    if (dayDelta === 0) { closeShiftMenu(); return; }
    await doShift(taskId, src, "move", dayDelta);
  }

  function openShiftMenu(btn, taskId) {
    closeShiftMenu();
    const r = rangeByTask.get(taskId);
    if (!r || !r.planned.source) return;
    const t = byIdAll.get(taskId); if (!t) return;
    const src = r.planned.source;
    const resizable = src === "dates";   // 期間のみ開始/終了を個別に動かせる
    const curStart = src === "due" ? r.planned.end : r.planned.start;
    const rangeTxt = src === "due" ? `締切 ${fmtDisplayDow(r.planned.end)}` : `${fmtDisplayDow(r.planned.start)} 〜 ${fmtDisplayDow(r.planned.end)}`;
    // 行: ラベル＋ -1週/-1日/+1日/+1週 の4ボタン。move は全体移動、start/end は端だけ。
    const shiftRow = (label, edge) => `
      <div class="sm-row">
        <span class="sm-rl">${label}</span>
        <span class="sm-btns">
          <button class="sm-b" data-edge="${edge}" data-d="-7">−1週</button>
          <button class="sm-b" data-edge="${edge}" data-d="-1">−1日</button>
          <button class="sm-b" data-edge="${edge}" data-d="1">+1日</button>
          <button class="sm-b" data-edge="${edge}" data-d="7">+1週</button>
        </span>
      </div>`;
    shiftMenu = document.createElement("div");
    shiftMenu.className = "gv-shiftmenu";
    shiftMenu.setAttribute("role", "menu");
    shiftMenu.innerHTML = `
      <div class="sm-h">${esc(t.title)}<small>${rangeTxt}・${srcLabel(src)}</small></div>
      ${shiftRow(resizable ? "全体を移動" : "移動", "move")}
      ${resizable ? shiftRow("開始だけ", "start") + shiftRow("終了だけ", "end") : ""}
      <div class="sm-row sm-date">
        <span class="sm-rl">${src === "due" ? "締切日" : "開始日"}</span>
        <input type="date" id="sm-date" value="${curStart}">
      </div>
      <div class="sm-foot"><button class="sm-edit" id="sm-edit">詳細編集…</button></div>`;
    document.body.appendChild(shiftMenu);
    // ボタン基準で配置（画面端で折り返し）。
    const br = btn.getBoundingClientRect();
    const mw = 252;
    shiftMenu.style.left = Math.max(8, Math.min(br.left, window.innerWidth - mw - 8)) + "px";
    shiftMenu.style.top = Math.min(br.bottom + 6, window.innerHeight - 220) + "px";
    shiftMenu.querySelectorAll(".sm-b").forEach((b) => {
      b.onclick = () => doShift(taskId, src, b.dataset.edge, +b.dataset.d);
    });
    const dIn = shiftMenu.querySelector("#sm-date");
    if (dIn) dIn.onchange = () => doSetStart(taskId, src, dIn.value);
    shiftMenu.querySelector("#sm-edit").onclick = () => { closeShiftMenu(); openTaskForm({ taskId, onSaved: reload }); };
    setTimeout(() => { document.addEventListener("pointerdown", onShiftDocDown, true); document.addEventListener("keydown", onShiftKey, true); }, 0);
    const first = shiftMenu.querySelector(".sm-b");
    if (first) first.focus();
  }

  rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".bar-shift");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openShiftMenu(btn, +btn.dataset.task);
  });
  // ── 日別予定の直接入力: タスク行の「日セル」をクリック→その日の実施予定時間を入力 ──
  let dayPop = null;
  // closeDayPop は onResize→paint（DOM再構築）でポップ系を畳む共通フック。シフトメニューも一緒に閉じる。
  closeDayPop = () => { if (dayPop) { dayPop.remove(); dayPop = null; document.removeEventListener("pointerdown", onDocDown, true); } closeShiftMenu(); };
  function onDocDown(e) { if (dayPop && !dayPop.contains(e.target)) closeDayPop(); }

  function openDayPlanPopup(taskId, dayISO, x, y) {
    closeDayPop();
    const t = byIdAll.get(taskId); if (!t) return;
    const entries = (plansById.get(taskId) || []).filter((p) => dateOnly(p.plan_date) === dayISO);
    const curH = entries.reduce((s, p) => s + (p.seconds || 0), 0) / 3600;
    const asg = (t.assignees || []);
    const dow = DOW[(scale.axis.find((a) => a.iso === dayISO) || {}).dow ?? 0];
    const memCtl = asg.length > 1
      ? `<label class="dp-l">担当 <select id="dp-mem">${asg.map((a, i) => `<option value="${a.id}"${i === 0 ? " selected" : ""}>${esc(a.name || a.username)}</option>`).join("")}</select></label>`
      : `<input type="hidden" id="dp-mem" value="${asg[0] ? asg[0].id : ""}">`;
    dayPop = document.createElement("div");
    dayPop.className = "gv-daypop";
    dayPop.innerHTML = `
      <div class="dp-h">${esc(t.title)}<small>${dayISO.slice(5).replace("-", "/")}（${dow}）にやる予定</small></div>
      ${memCtl}
      <div class="dp-row">
        <button class="dp-q" data-h="0.5">0.5h</button><button class="dp-q" data-h="1">1h</button>
        <button class="dp-q" data-h="2">2h</button><button class="dp-q" data-h="4">4h</button>
        <span class="dp-in"><input id="dp-h" type="number" min="0" step="0.5" value="${curH || 2}">h</span>
      </div>
      <div class="dp-act">
        <button class="dp-clear" id="dp-clear">${curH > 0 ? "クリア" : "閉じる"}</button>
        <button class="dp-save" id="dp-save">保存</button>
      </div>`;
    document.body.appendChild(dayPop);
    dayPop.style.left = Math.max(8, Math.min(x, window.innerWidth - 244)) + "px";
    dayPop.style.top = Math.min(y + 10, window.innerHeight - 150) + "px";
    const hIn = dayPop.querySelector("#dp-h");
    dayPop.querySelectorAll(".dp-q").forEach((b) => b.onclick = () => { hIn.value = b.dataset.h; });
    const commit = async (hours) => {
      const memEl = dayPop.querySelector("#dp-mem");
      const uid = memEl && memEl.value ? +memEl.value : null;
      closeDayPop();
      try {
        for (const en of entries) await vik.deletePlan(taskId, en.id); // 既存の同日予定を消してから入れ直す
        if (hours > 0) await vik.logPlan(taskId, Math.round(hours * 3600), dayISO, "", uid);
        reload();
      } catch (err) { alert("予定の保存に失敗: " + err.message); }
    };
    dayPop.querySelector("#dp-save").onclick = () => commit(parseFloat(hIn.value) || 0);
    dayPop.querySelector("#dp-clear").onclick = () => commit(0);
    hIn.onkeydown = (e) => { if (e.key === "Enter") commit(parseFloat(hIn.value) || 0); };
    setTimeout(() => document.addEventListener("pointerdown", onDocDown, true), 0);
    hIn.focus(); hIn.select();
  }

  rowsEl.addEventListener("click", (e) => {
    if (drag) return;
    if (gview.unit !== "day") return;   // 日別入力は日付が1日ずつ出る「日表示」のときだけ
    if (e.target.closest(".bar") || e.target.closest(".r-label") || e.target.closest("[data-toggle]")) return;
    const row = e.target.closest(".row[data-task]");
    if (!row) return;
    const area = row.querySelector(".bar-area");
    if (!area) return;
    const rect = area.getBoundingClientRect();
    if (e.clientX < rect.left) return; // 左の固定ラベル領域は無視
    const dayIdx = Math.floor((e.clientX - rect.left) / COL_W);
    if (dayIdx < 0 || dayIdx >= WINDOW_DAYS) return;
    openDayPlanPopup(+row.dataset.task, scale.axis[dayIdx].iso, e.clientX, e.clientY);
  });
  } // end if(editable) — 編集系ハンドラ

  paint();
  // 初期描画後、今日線が見える位置へ自動スクロール（中央寄せ）。埋め込みは「今日の少し手前」起点で
  // 既に今日が見えるので対象外＝全画面のみ。レイアウト確定後に実行するため rAF で1フレーム待つ。
  if (!embedded) requestAnimationFrame(() => scrollToToday(false));
  // 埋め込みは cleanup 関数を返す（呼び出し側が破棄時に呼ぶ／呼ばなくても MutationObserver が自動解除）。
  return teardown;
}

function srcLabel(source) {
  return source === "plans" ? "日別予定" : source === "dates" ? "期間" : source === "due" ? "締切" : "";
}

function toggleSet(set, id, btn) {
  if (set.has(id)) { set.delete(id); btn.setAttribute("aria-pressed", "false"); }
  else { set.add(id); btn.setAttribute("aria-pressed", "true"); }
}

function shell(members, memberIdx, mode, embedded = false, maxHeight) {
  // 埋め込み: ツールバー/凡例/タイトル無し・100vh前提なしの最小シェル。高さはコンテナ駆動
  // （人別レーンの自然高で伸びる）。maxHeight 指定時のみ内側スクロール。
  if (embedded) {
    const scrollStyle = maxHeight ? `style="max-height:${typeof maxHeight === "number" ? maxHeight + "px" : maxHeight};overflow:auto"` : "";
    return `
    <div class="gv-view gv-embed">
    <div class="card gv gv-embed-card">
      <div class="gv-scroll" ${scrollStyle}><div class="gantt" id="gv-gantt" style="--label-w:${LABEL_W_P}px;--col-w:${COL_W}px;--win:${WINDOW_DAYS}">
        <div class="grid-head" id="gv-head"></div>
        <div class="rows" id="gv-rows"></div>
      </div></div>
    </div>
    </div>
    ${ganttStyles()}`;
  }
  const memChips = members.map((m) =>
    `<button class="chip" data-mem="${m.id}" aria-pressed="true"><span class="dot" style="background:${member_color(memberIdx.get(m.id))}"></span>${esc(m.name)}</button>`).join("")
    || `<span style="font-size:11px;color:${C.muted}">担当者なし</span>`;
  const seg = (m, label) => `<button data-mode="${m}"${mode === m ? ' class="on"' : ""}>${label}</button>`;
  return `
  <div class="gv-view">
  <h1 class="vtitle">ガントチャート <small>予定×実績 ・ ${WINDOW_DAYS}日窓</small></h1>
  <div class="card gv">
    <div class="gv-toolbar">
      <div class="seg">
        ${seg("project", "プロジェクト別")}${seg("member", "人別")}
      </div>
      <div class="seg">
        <button id="gv-expand-all" title="すべて展開">${icon("chevronDown", { size: 14 })}全展開</button>
        <button id="gv-collapse-all" title="すべて折りたたみ">${icon("chevronRight", { size: 14 })}全折りたたみ</button>
      </div>
      <div class="seg">
        <button id="gv-today" title="今日が見える位置へスクロール">${icon("calendarDays", { size: 14 })}今日へ</button>
      </div>
      <div class="tbg"><span class="tbl">表示</span>
        <div class="seg">${["day", "week"].map((u) => `<button data-unit="${u}"${gview.unit === u ? ' class="on"' : ""}>${u === "day" ? "日" : "週"}</button>`).join("")}</div>
        <div class="seg">${SPANS[gview.unit].map((p) => { const cur = gview.unit === "day" ? gview.spanDay : gview.spanWeek; return `<button data-span="${p.key}"${p.key === cur ? ' class="on"' : ""}>${p.label}</button>`; }).join("")}</div>
        ${gview.unit === "week" ? `<select class="gv-wsel" id="gv-weekstart" title="週の開始曜日">${DOW.map((d, i) => `<option value="${i}"${i === gview.weekStart ? " selected" : ""}>${d}曜始まり</option>`).join("")}</select>` : ""}
      </div>
      <div class="tbg"><span class="tbl">担当者</span><div class="chips">${memChips}</div></div>
      <label class="tbg chk"><input type="checkbox" id="gv-hidedone"> 完了を非表示</label>
      <label class="tbg chk"><input type="checkbox" id="gv-deps"${gview.withDeps ? " checked" : ""}> 依存矢印</label>
      <label class="tbg chk"><input type="checkbox" id="gv-crit"${gview.critical ? " checked" : ""}${gview.withDeps ? "" : " disabled"}> クリティカルパス</label>
      <label class="tbg chk"><input type="checkbox" id="gv-unsched"${gview.showUnscheduled ? " checked" : ""}> 未予定（人別）</label>
    </div>
    <div class="gv-scroll"><div class="gantt" id="gv-gantt" style="--label-w:${LABEL_W_P}px;--col-w:${COL_W}px;--win:${WINDOW_DAYS}">
      <div class="grid-head" id="gv-head"></div>
      <div class="rows" id="gv-rows"></div>
    </div></div>
    <div class="legend">
      <span class="li"><span class="sw plan"></span>予定（task_time_plans / 期間 / 締切）</span>
      <span class="li"><span class="sw" style="background:${C.fill}"></span>実績進捗</span>
      <span class="li"><span class="sw" style="background:${C.free}"></span>完了</span>
      <span class="li"><span class="sw" style="background:${C.over}"></span>見積超過</span>
      <span class="li"><span style="border-left:2px dashed ${C.over};height:13px;display:inline-block"></span> 今日</span>
    </div>
  </div>
  </div>
  ${ganttStyles()}`;
}

function ganttStyles() {
  return `
  <style>
  /* 埋め込み(gv-embed): 100vh前提を外しコンテナ駆動の自然高に。ツールバー/凡例/タイトルは無し。 */
  .gv-view.gv-embed{display:block;height:auto;margin-bottom:0}
  .gv-embed .gv-embed-card{padding:0;display:block}
  .gv-embed .gv-scroll{overflow:auto}
  .gv-embed .gantt{min-width:calc(var(--label-w) + var(--col-w)*var(--win))}
  /* ガントを画面高にフィット＝行だけ内側スクロール。タイトル/ツールバー/日付軸/凡例は常時表示。
     高さ控除 = topbar(54) + content 余白上(24)。content 下 padding(60) は負 margin で食い込み、
     行エリアをビューポート下端ぎりぎりまで使う（共有 content の padding は触らない）。
     実効高 = 100dvh - 78(=54+24) - 12(下の余白) = 100dvh - 90px。
     iOS Safari 等のアドレスバー出没で 100vh が過大になる問題を避けるため dvh を使う。
     dvh 非対応ブラウザ向けに 100vh を先に置きフォールバックする。 */
  .gv-view{display:flex;flex-direction:column;height:calc(100vh - 90px);height:calc(100dvh - 90px);margin-bottom:-48px}
  .gv-view .vtitle{flex:none;margin:0 0 10px}
  .gv{padding:0;flex:1;min-height:0;display:flex;flex-direction:column}
  .gv-toolbar{flex:none}
  .gv .legend{flex:none}
  .gv-toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:12px 16px;border-bottom:1px solid ${C.line}}
  .gv .seg{display:inline-flex;border:1px solid ${C.line};border-radius:9px;overflow:hidden}
  .gv .seg button{border:0;background:#fff;color:${C.muted};font-size:12px;font-weight:700;padding:7px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
  .gv .seg button:hover{background:${C.track}}
  .gv .seg button.on{background:${C.fill};color:#fff}
  .gv .tbg{display:flex;align-items:center;gap:8px}
  .gv .tbl{font-size:11px;color:${C.muted};font-weight:600}
  .gv .gv-wsel{font:inherit;font-size:12px;font-weight:600;padding:6px 8px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.ink};cursor:pointer}
  .gv .chips{display:flex;flex-wrap:wrap;gap:6px}
  .gv .chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:5px 11px;border-radius:999px;border:1px solid ${C.line};background:#fff;color:${C.ink};cursor:pointer}
  .gv .chip[aria-pressed=false]{opacity:.4;text-decoration:line-through}
  .gv .chip .dot{width:9px;height:9px;border-radius:50%}
  .gv .chk{font-size:12px;color:${C.ink};cursor:pointer}
  .gv-scroll{flex:1;min-height:0;overflow:auto}
  .gv .gantt{min-width:calc(var(--label-w) + var(--col-w)*var(--win));width:100%;position:relative}
  .gv .grid-head{display:grid;grid-template-columns:var(--label-w) repeat(var(--win), var(--col-w));grid-auto-rows:auto;border-bottom:1px solid ${C.line};position:sticky;top:0;background:#fff;z-index:8}
  /* 左端のラベル列は横スクロールしても固定（フリーズ）。角は最前面 */
  .gv .gh-corner{padding:9px 14px;font-size:11px;color:${C.muted};font-weight:600;border-right:1px solid ${C.line};display:flex;align-items:center;position:sticky;left:0;z-index:2;background:#fff}
  .gv .gh-mc{padding:0;border-bottom:1px solid ${C.line};position:sticky;left:0;z-index:2;background:#fff}
  .gv .gh-month{font-size:10.5px;font-weight:700;color:${C.ink};padding:3px 8px;border-right:1px solid ${C.line};border-bottom:1px solid ${C.line};white-space:nowrap;overflow:hidden;background:#f7f9fc}
  .gv .gh-day{text-align:center;padding:6px 1px;border-right:1px solid ${C.line};font-size:11px;color:${C.muted}}
  .gv .gh-day .dom{font-size:12px;color:${C.ink};font-weight:600}
  .gv .gh-day .dow{font-size:9px}
  .gv .gh-day.sparse{overflow:visible;position:relative}
  .gv .gh-day.sparse .dom{font-size:10.5px;position:absolute;top:5px;left:50%;transform:translateX(-50%);white-space:nowrap;z-index:1}
  .gv .gh-day.weekend{background:#fafbfc}
  .gv .gh-day.today{background:rgba(229,72,77,.07)}
  .gv .gh-day.today .dom{color:${C.over};font-weight:700}
  .gv .rows{position:relative}
  .gv .row{display:grid;grid-template-columns:var(--label-w) repeat(var(--win), var(--col-w));border-bottom:1px solid ${C.line};height:${ROW_H}px;position:relative}
  .gv .row:hover{background:#fafbfc}
  .gv .row.delayed{background:rgba(229,72,77,.045)}
  .gv .row:hover .r-label{background:#fafbfc}
  .gv .row.delayed .r-label{background:#fdf2f2}
  .gv .r-label{border-right:1px solid ${C.line};padding:0 12px;display:flex;align-items:center;gap:9px;overflow:hidden;position:sticky;left:0;z-index:7;background:#fff;cursor:pointer}
  .gv .row:hover .r-name{text-decoration:underline;text-decoration-color:${C.line}}
  .gv .r-label-sub{padding-left:24px}
  .gv .r-text{min-width:0}
  .gv .r-name{font-size:13.5px;font-weight:600;color:${C.ink};letter-spacing:.01em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;line-height:1.25;word-break:break-word}
  .gv .r-meta{font-size:10.5px;color:${C.muted};display:flex;align-items:center;gap:6px;margin-top:1px;white-space:nowrap}
  .gv .r-meta .av{display:inline-flex;gap:3px}
  .gv .r-meta .ava{width:14px;height:14px;border-radius:50%;color:#fff;font-size:8px;display:inline-flex;align-items:center;justify-content:center;font-weight:700}
  .gv .r-who{color:${C.ink};font-weight:600}
  .gv .row.noplan .r-who{color:${C.muted}}
  .gv .r-meta .more{font-size:9px}
  .gv .r-meta .r-pj{padding:0 5px;border-radius:4px;background:${C.track}}
  .gv .r-flag{font-size:9px;font-weight:700;color:#fff;background:${C.over};padding:1px 5px;border-radius:4px}
  .gv .r-noplan{font-size:9px;color:${C.muted};border:1px dashed ${C.line};padding:0 5px;border-radius:4px}
  .gv .row.noplan .r-name{color:${C.muted};font-weight:500}
  .gv .r-cells{position:absolute;left:var(--label-w);top:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(var(--win), var(--col-w));pointer-events:none}
  .gv .cell{border-right:1px solid ${C.track}}
  .gv .cell.weekend{background:rgba(0,0,0,.012)}
  /* 長期表示(tight): 日ごとの細罫線を消し、週(月曜)の罫線だけ残す＝1目盛り=1週間で見やすく */
  .gv .gantt.tight .cell{border-right-color:transparent}
  .gv .gantt.tight .cell.wk{border-right:1px solid ${C.line}}
  .gv .gantt.tight .gh-day{border-right-color:transparent}
  .gv .gantt.tight .gh-day.wk{border-right:1px solid ${C.line}}
  .gv .bar-area{position:absolute;left:var(--label-w);top:0;right:0;height:${ROW_H}px}
  .gv .bar{position:absolute;border-radius:5px;overflow:hidden}
  .gv .bar.plan{top:14px;height:11px;background:${C.track};box-shadow:inset 0 0 0 1px rgba(58,134,255,.35)}
  .gv .bar.plan::after{content:"";position:absolute;inset:0;background:rgba(58,134,255,.16)}
  .gv .bar.act{top:28px;height:15px;background:${C.track};box-shadow:inset 0 0 0 1px rgba(0,0,0,.05)}
  .gv .bar.act.over{box-shadow:inset 0 0 0 1.5px ${C.over}}
  .gv .bar.clipL{border-radius:0 5px 5px 0}
  .gv .bar.clipR{border-radius:5px 0 0 5px}
  .gv .bar .fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px 0 0 5px}
  .gv .bar .blabel{position:absolute;right:6px;top:0;bottom:0;display:flex;align-items:center;font-size:9.5px;font-weight:700;color:${C.ink}}
  .gv .bar.plan.draggable{cursor:grab;touch-action:none}
  .gv .bar.plan.draggable:hover{box-shadow:inset 0 0 0 1.5px ${C.fill}}
  .gv .bar.plan.dragging{cursor:grabbing;opacity:.9;z-index:7;box-shadow:inset 0 0 0 1.5px ${C.fill}}
  .gv .bar-h{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize;z-index:1}
  .gv .bar-h.l{left:0}.gv .bar-h.r{right:0}
  /* タップ端末向け「⋮」日程シフトボタン（プログレッシブ拡張）。バー右端に小さく重ねる。
     マウス環境では既定 非表示で、行/バーのホバー or フォーカス時のみ控えめに出す（DnD の邪魔をしない）。
     タッチ環境（hover:none / pointer:coarse）では常時可視＝唯一の操作手段になる。 */
  .gv .bar.plan.draggable{position:absolute}
  .gv .bar-shift{position:absolute;top:50%;right:1px;transform:translateY(-50%);width:15px;height:15px;padding:0;
    display:none;align-items:center;justify-content:center;border:0;border-radius:4px;cursor:pointer;
    background:rgba(255,255,255,.92);color:${C.fill};font-size:13px;font-weight:900;line-height:1;
    box-shadow:0 1px 3px rgba(20,30,50,.28);z-index:3}
  .gv .bar-shift:hover{background:#fff;color:${C.ink}}
  .gv .bar-shift:focus-visible{outline:2px solid ${C.fill};outline-offset:1px;display:inline-flex}
  .gv .row:hover .bar.plan.draggable .bar-shift,
  .gv .bar.plan.draggable:hover .bar-shift{display:inline-flex}
  /* タッチ/粗いポインタ環境＝ネイティブDnDが効かないので常時表示（少し大きめでタップしやすく） */
  @media (hover:none),(pointer:coarse){
    .gv .bar-shift{display:inline-flex;width:18px;height:18px;font-size:15px;right:0}
  }
  /* 日程シフトの小メニュー（⋮ から開く）。tb-ctx 風の軽量ポップ。 */
  .gv-shiftmenu{position:fixed;z-index:10001;width:252px;background:#fff;border:1px solid ${C.line};border-radius:12px;
    box-shadow:0 14px 38px rgba(20,30,50,.24);padding:11px 12px;font-size:13px}
  .gv-shiftmenu .sm-h{font-weight:700;font-size:13px;line-height:1.3;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gv-shiftmenu .sm-h small{display:block;font-weight:500;color:${C.muted};font-size:11px;margin-top:2px;white-space:normal}
  .gv-shiftmenu .sm-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .gv-shiftmenu .sm-rl{flex:none;width:64px;font-size:11px;color:${C.muted};font-weight:600}
  .gv-shiftmenu .sm-btns{display:flex;gap:4px;flex:1}
  .gv-shiftmenu .sm-b{flex:1;font:inherit;font-size:11.5px;font-weight:700;padding:6px 0;border:1px solid ${C.line};border-radius:7px;background:#fff;color:${C.ink};cursor:pointer}
  .gv-shiftmenu .sm-b:hover{background:${C.track};border-color:#d7dde6}
  .gv-shiftmenu .sm-date input{flex:1;font:inherit;font-size:12.5px;padding:5px 7px;border:1px solid ${C.line};border-radius:7px}
  .gv-shiftmenu .sm-foot{margin-top:2px;border-top:1px solid ${C.line};padding-top:8px}
  .gv-shiftmenu .sm-edit{width:100%;font:inherit;font-size:12px;font-weight:700;padding:7px 0;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.fill};cursor:pointer}
  .gv-shiftmenu .sm-edit:hover{background:${C.track}}
  /* 集約バー（人別: 親プロジェクト見出しの子まとめ帯）。読み取り専用＝点線枠で個別バーと区別 */
  .gv .bar.plan.agg{top:18px;height:9px;background:rgba(58,134,255,.10);box-shadow:inset 0 0 0 1px rgba(58,134,255,.30);border-radius:5px}
  .gv .bar.plan.agg::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(58,134,255,.16) 0 6px,transparent 6px 10px)}
  /* 人別: 親プロジェクトのサブグループ見出し（メンバー見出しより1段インデント＝階層が分かる） */
  .gv .grp.mp-sub{background:#f8fafc}
  .gv .grp.mp-sub .grp-label{background:#f8fafc;padding-left:30px}
  .gv .grp.mp-sub .grp-label:hover{background:#eef2f7}
  .gv .grp.mp-sub .grp-name{font-size:12.5px;font-weight:700}
  .gv .grp.mp-sub .pj-band{width:11px;height:22px}
  /* B41: 人別レーンの「未予定タスク」サブグループ。日程未設定＝点線枠の中立バンドで通常PJと区別 */
  .gv .grp.mp-unsched .grp-name{color:${C.muted}}
  .gv .pj-band.pj-band-none{background:transparent;border:1.5px dashed ${C.line}}
  /* 人別: サブグループ配下の子タスク行はさらに字下げ＝親の下に畳まれていると分かる。
     ツリー接続線: 親見出し直下から伸びる縦線＋各子へのエルボー(┗)。色は中立的な淡いグレー
     (--line-strong)＝構造ガイドに徹する（プロジェクト色は見出しの .pj-band 四角で伝える）。
     縦線xは見出しの色四角(.mp-sub .pj-band)中心を実測した --mprail に揃える。実測不能時の
     フォールバックは padding-left=30px(grp-label) + caret/gap/四角半分 ≒ 41px の妥当値。 */
  .gv .row.mp-child .r-label{padding-left:calc(var(--mprail,41px) + 18px)}  /* 名前開始をレール基準で右へ＝エルボー(レール+11px)と被らない */
  .gv .row.mp-child .r-label::before{content:"";position:absolute;left:var(--mprail,41px);top:0;bottom:0;width:2px;background:var(--pj,${C.lineStrong});opacity:.5}
  .gv .row.mp-child.last .r-label::before{bottom:auto;height:50%}
  /* エルボーの横線: 縦線から子ラベルへ向かう短い水平線（行の中央高さ） */
  .gv .row.mp-child .r-label::after{content:"";position:absolute;left:var(--mprail,41px);top:50%;width:11px;height:2px;background:var(--pj,${C.lineStrong});opacity:.5}
  /* 未アサイングループ: 容量線/負荷帯なしの中立アバター */
  .gv .grp.grp-unassigned .avatar.avatar-none{background:${C.track};color:${C.muted};box-shadow:inset 0 0 0 1px ${C.line}}
  .gv-draglabel{position:fixed;z-index:9999;background:${C.ink};color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:6px;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.25);display:none}
  /* 日別予定 入力ポップアップ（日セルをクリックで出る） */
  .gv-daypop{position:fixed;z-index:10000;width:228px;background:#fff;border:1px solid ${C.line};border-radius:12px;box-shadow:0 12px 34px rgba(20,30,50,.22);padding:12px;font-size:13px}
  .gv-daypop .dp-h{font-weight:700;font-size:13px;line-height:1.3;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gv-daypop .dp-h small{display:block;font-weight:500;color:${C.muted};font-size:11px;margin-top:2px}
  .gv-daypop .dp-l{display:flex;align-items:center;gap:6px;font-size:11.5px;color:${C.muted};margin-bottom:9px}
  .gv-daypop .dp-l select{flex:1;font:inherit;font-size:12.5px;padding:5px 7px;border:1px solid ${C.line};border-radius:7px}
  .gv-daypop .dp-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:11px}
  .gv-daypop .dp-q{font:inherit;font-size:12px;font-weight:600;padding:5px 9px;border:1px solid ${C.line};border-radius:7px;background:#fff;color:${C.ink};cursor:pointer}
  .gv-daypop .dp-q:hover{background:${C.track};border-color:#d7dde6}
  .gv-daypop .dp-in{display:inline-flex;align-items:center;gap:3px;margin-left:auto;font-size:12px;color:${C.muted}}
  .gv-daypop .dp-in input{width:56px;font:inherit;font-size:13px;font-weight:600;text-align:right;padding:5px 7px;border:1px solid ${C.line};border-radius:7px}
  .gv-daypop .dp-act{display:flex;justify-content:space-between;gap:8px}
  .gv-daypop .dp-clear{font:inherit;font-size:12px;font-weight:600;padding:7px 12px;border:1px solid ${C.line};border-radius:8px;background:#fff;color:${C.muted};cursor:pointer}
  .gv-daypop .dp-save{font:inherit;font-size:12.5px;font-weight:700;padding:7px 18px;border:0;border-radius:8px;background:${C.fill};color:#fff;cursor:pointer}
  .gv-daypop .dp-save:hover{filter:brightness(1.06)}
  .gv .today-line{position:absolute;top:0;width:0;border-left:2px dashed ${C.over};z-index:6;pointer-events:none}
  .gv .today-line .tl-cap{position:absolute;top:-1px;left:-15px;font-size:9px;color:#fff;background:${C.over};padding:1px 5px;border-radius:4px}
  .gv svg.deps{position:absolute;left:var(--label-w);top:0;pointer-events:none;z-index:4;overflow:visible}
  .gv .grp{display:grid;grid-template-columns:var(--label-w) repeat(var(--win), var(--col-w));height:${GRP_H}px;position:relative;background:#fbfcfd;border-bottom:1px solid ${C.line}}
  .gv .grp-label{border-right:1px solid ${C.line};padding:0 12px;display:flex;align-items:center;gap:9px;cursor:pointer;overflow:hidden;position:sticky;left:0;z-index:7;background:#fbfcfd}
  .gv .grp-label:hover{background:#f3f5f8}
  .gv .grp .caret{font-size:15px;color:${C.muted};transition:transform .15s}
  .gv .grp.collapsed .caret{transform:rotate(-90deg)}
  .gv .avatar{width:30px;height:30px;border-radius:50%;color:#fff;font-size:13px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
  .gv .pj-band{width:14px;height:30px;border-radius:4px;flex:none}
  .gv .grp-text{min-width:0;display:flex;flex-direction:column;gap:3px;flex:1}
  /* プロジェクト別: 親→子はインデントで表現。縦線はヘッダから伸ばさず、紐づく子タスクの行にだけ引く */
  .gv .grp[data-pid] .grp-name{font-weight:800}
  .gv .row.pj-child .r-label{padding-left:74px}   /* 親名(≈49px)よりはっきり右へ字下げ＝配下と一目で分かる。position は基底の sticky を継承 */
  .gv .row.pj-child .r-name{font-weight:600}
  /* 縦線は子タスク行のみ。色四角(pj-band)の中心を実測した --pjrail に揃える。最後の子の中央で止める。
     色は人別と統一して中立グレー(--line-strong)＝構造ガイドに徹する。フォールバックは
     grp-label padding(12px)+caret(≈18px)+四角半分(7px) ≒ 33px の妥当値。 */
  .gv .row.pj-child .r-label::before{content:"";position:absolute;left:var(--pjrail,33px);top:0;bottom:0;width:2px;background:var(--pj,${C.lineStrong});opacity:.5}
  .gv .row.pj-child.last .r-label::before{bottom:auto;height:50%}
  /* エルボーの横線: 縦線から子ラベルへ向かう短い水平線（人別と同一スタイル） */
  .gv .row.pj-child .r-label::after{content:"";position:absolute;left:var(--pjrail,33px);top:50%;width:11px;height:2px;background:var(--pj,${C.lineStrong});opacity:.5}
  .gv .grp-top{display:flex;align-items:center;gap:8px;min-width:0}
  .gv .grp-name{font-size:14px;font-weight:700;color:${C.ink};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;line-height:1.25;word-break:break-word;min-width:0}
  .gv .grp-sub{font-size:10.5px;color:${C.muted};white-space:nowrap}
  .gv .cap-track{width:90px;height:7px;border-radius:5px;background:${C.track};overflow:hidden;position:relative;flex:none}
  .gv .cap-fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px}
  .gv .grp-cells{position:absolute;left:var(--label-w);top:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(var(--win), var(--col-w));pointer-events:none}
  .gv .legend{display:flex;flex-wrap:wrap;gap:14px;padding:11px 16px;border-top:1px solid ${C.line};font-size:11px;color:${C.muted}}
  .gv .legend .li{display:inline-flex;align-items:center;gap:6px}
  .gv .legend .sw{width:20px;height:10px;border-radius:3px}
  .gv .legend .sw.plan{background:rgba(58,134,255,.16);box-shadow:inset 0 0 0 1px rgba(58,134,255,.35)}
  .gv .empty{padding:34px;text-align:center;color:${C.muted};font-size:13px}

  /* ===== ダークモード上書き（lightは不変・末尾で html[data-theme="dark"] のみ追加） ===== */
  /* ツールバー: セグメントボタン/週select/担当chip の白面を card 面へ（.on の青塗りは反転不要＝触らない） */
  html[data-theme="dark"] .gv .seg button{background:var(--card)}
  html[data-theme="dark"] .gv .gv-wsel{background:var(--card)}
  html[data-theme="dark"] .gv .chip{background:var(--card)}
  /* sticky 日付ヘッダ（角/月コーナー/グリッド）と月バンドの白/淡灰面 */
  html[data-theme="dark"] .gv .grid-head{background:var(--card)}
  html[data-theme="dark"] .gv .gh-corner{background:var(--card)}
  html[data-theme="dark"] .gv .gh-mc{background:var(--card)}
  html[data-theme="dark"] .gv .gh-month{background:var(--surface-2)}
  /* 週末日付ヘッダの淡灰（白オーバーレイで暗面でも微差を出す） */
  html[data-theme="dark"] .gv .gh-day.weekend{background:rgba(255,255,255,.03)}
  /* 行 hover / 超過行 と左固定ラベルの白・赤淡面 */
  html[data-theme="dark"] .gv .row:hover{background:rgba(255,255,255,.04)}
  html[data-theme="dark"] .gv .row:hover .r-label{background:rgba(255,255,255,.04)}
  html[data-theme="dark"] .gv .row.delayed .r-label{background:rgba(229,72,77,.16)}
  html[data-theme="dark"] .gv .r-label{background:var(--card)}
  /* 週末セルの薄い黒オーバーレイ→暗面では白オーバーレイへ */
  html[data-theme="dark"] .gv .cell.weekend{background:rgba(255,255,255,.025)}
  /* バーの「⋮」シフトボタン: 白面+影→浮いた面+暗い影 */
  html[data-theme="dark"] .gv .bar-shift{background:var(--surface-raised);box-shadow:0 1px 3px rgba(0,0,0,.5)}
  html[data-theme="dark"] .gv .bar-shift:hover{background:var(--surface-raised)}
  /* 日程シフトの小メニュー（浮いたポップ）: 白面/白ボタン/淡borderを暗面へ */
  html[data-theme="dark"] .gv-shiftmenu{background:var(--card);box-shadow:0 14px 38px rgba(0,0,0,.5)}
  html[data-theme="dark"] .gv-shiftmenu .sm-b{background:var(--card)}
  html[data-theme="dark"] .gv-shiftmenu .sm-b:hover{border-color:var(--line-strong)}
  html[data-theme="dark"] .gv-shiftmenu .sm-edit{background:var(--card)}
  /* 人別: 親プロジェクトのサブグループ見出しの淡青灰面 */
  html[data-theme="dark"] .gv .grp.mp-sub{background:var(--surface-2)}
  html[data-theme="dark"] .gv .grp.mp-sub .grp-label{background:var(--surface-2)}
  html[data-theme="dark"] .gv .grp.mp-sub .grp-label:hover{background:var(--surface-raised)}
  /* ドラッグ中の浮遊ラベル: light は ink面+白字。dark は ink が明色＝白on白で読めない→暗い浮面+明文字へ反転 */
  html[data-theme="dark"] .gv-draglabel{background:var(--surface-raised);color:var(--ink);box-shadow:0 4px 12px rgba(0,0,0,.5)}
  /* 日別予定ポップ（浮いたポップ）: 白面/白ボタン/淡borderを暗面へ（.dp-save の青塗り白字は触らない） */
  html[data-theme="dark"] .gv-daypop{background:var(--card);box-shadow:0 12px 34px rgba(0,0,0,.5)}
  html[data-theme="dark"] .gv-daypop .dp-q{background:var(--card)}
  html[data-theme="dark"] .gv-daypop .dp-q:hover{border-color:var(--line-strong)}
  html[data-theme="dark"] .gv-daypop .dp-clear{background:var(--card)}
  /* 見出し行（grp / grp-label）の淡白面とその hover */
  html[data-theme="dark"] .gv .grp{background:var(--surface-2)}
  html[data-theme="dark"] .gv .grp-label{background:var(--surface-2)}
  html[data-theme="dark"] .gv .grp-label:hover{background:var(--surface-raised)}
  </style>`;
}
