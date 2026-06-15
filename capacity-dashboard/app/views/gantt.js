// 予実ガント（フェーズ3）。予定バー×実績バーを時間軸に重ね、依存矢印・今日線・進捗・超過を描く。
// タスク行モード(mock29型) / 人別レーンモード(mock30型) をトグル切替。取得はフロントN+1（planner.js踏襲）。
import { load, invalidate } from "../lib/store.js";
import * as vik from "../lib/api.js";
import { taskRanges, dependencyEdges, dayScale, toMemberDayEntries, sumByMemberDay, shiftISO, applyBarDrag, dateOnly, hasDate } from "../lib/capacity.js";
import { fmtDisplayDow } from "../lib/form.js";
import { openTaskForm } from "./taskform.js";
import { C, member_color, fmtH, esc, todayISO } from "../lib/ui.js";

let COL_W = 40, WINDOW_DAYS = 21;   // 表示範囲プリセットで render ごとに上書き
const LABEL_W = 280, LABEL_W_P = 320, ROW_H = 42, GRP_H = 56;
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

// 表示範囲プリセット。days=表示日数 / back=今日より前に含める日数 / colW=1日の列幅(px)。
// 長期はピクセルを詰めてヘッダを月バンド＋粗い日付に自動切替（gridHead）。
const RANGE_PRESETS = [
  { key: "2w", label: "2週間", days: 14, back: 3, colW: 42 },
  { key: "1m", label: "1ヶ月", days: 31, back: 5, colW: 27 },
  { key: "3m", label: "3ヶ月", days: 92, back: 10, colW: 12 },
  { key: "6m", label: "6ヶ月", days: 184, back: 18, colW: 7 },
];

const projColor = (id) => ["#3a86ff", "#2fa66b", "#b657d6", "#e5772d", "#0ea5e9", "#f5a623"][((id || 0) % 6 + 6) % 6];
const initial = (name) => (name ? String(name).trim().slice(0, 1) : "?");

// 再描画（編集後の reload 等）をまたいで保持する表示状態。既定はプロジェクト別。
// これが無いと、タスク行/人別で編集→render し直すたびに既定モードへ戻ってしまう。
// 表示範囲の選択は localStorage に記憶（再読込後も維持）。未保存/不正なら既定 3ヶ月。
const RANGE_KEY = "gantt_range";
const savedRange = (() => { try { return localStorage.getItem(RANGE_KEY); } catch { return null; } })();
const gview = {
  mode: "project", collapsed: new Set(),
  range: RANGE_PRESETS.some((p) => p.key === savedRange) ? savedRange : "3m",
};

export async function render(root) {
  const { tasks, members, projects } = await load();
  const today = todayISO();
  // 表示範囲プリセットから 窓日数・列幅・起点 を決める（gview に保持＝再描画をまたぐ）
  const preset = RANGE_PRESETS.find((p) => p.key === gview.range) || RANGE_PRESETS[1];
  WINDOW_DAYS = preset.days;
  COL_W = preset.colW;
  const startISO = shiftISO(today, -preset.back);
  const scale = dayScale(startISO, WINDOW_DAYS);

  // N+1: plans/times を持つタスクだけ個別取得（planner.js と同方式）
  const planTasks = tasks.filter((t) => (t.time_planned || 0) > 0);
  const timeTasks = tasks.filter((t) => (t.time_spent || 0) > 0);
  const [plansArr, timesArr] = await Promise.all([
    Promise.all(planTasks.map((t) => vik.getPlans(t.id).then((p) => [t, p || []]).catch(() => [t, []]))),
    Promise.all(timeTasks.map((t) => vik.getTimes(t.id).then((p) => [t, p || []]).catch(() => [t, []]))),
  ]);
  const plansById = new Map(plansArr.map(([t, p]) => [t.id, p]));
  const timesById = new Map(timesArr.map(([t, p]) => [t.id, p]));
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
    mode: gview.mode,            // 再描画をまたいで保持（編集後も今のモードを維持）
    hideDone: false,
    projects: new Set(projects.map((p) => p.id)),
    members: new Set(members.map((m) => m.id)),
    collapsed: gview.collapsed,  // 同一参照＝折りたたみも保持
  };
  const memberIdx = new Map(members.map((m, i) => [m.id, i]));

  root.innerHTML = shell(projects, members, memberIdx, state.mode);
  const head = root.querySelector("#gv-head");
  const rowsEl = root.querySelector("#gv-rows");
  const ganttEl = root.querySelector("#gv-gantt");
  ganttEl.classList.toggle("tight", COL_W < 22);   // 長期表示=日罫線を消し週(月曜)罫線だけにする

  // ヘッダは2段（月バンド＋日付）。列幅に応じて日付ラベルの粒度を自動調整。
  // day(≥22px)=毎日 dom+曜日 / week(≥9px)=月曜だけ dom / month(<9px)=月初だけ dom。
  function gridHead(labelW) {
    const tier = COL_W >= 22 ? "day" : COL_W >= 9 ? "week" : "month";
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
    const corner = state.mode === "task" ? "タスク" : state.mode === "member" ? "人別" : "プロジェクト";
    const dayRow = `<div class="gh-corner">${corner} / 日付</div>` + scale.axis.map((a) => {
      const cls = (a.weekend ? " weekend" : "") + (a.iso === today ? " today" : "");
      const dom = a.iso.slice(8);
      const showNum = tier === "day" || (tier === "week" && a.dow === 1) || (tier === "month" && dom === "01");
      const numHtml = showNum ? `<div class="dom">${+dom}</div>` : "";
      const dowHtml = tier === "day" ? `<div class="dow">${DOW[a.dow]}</div>` : "";
      return `<div class="gh-day${cls}${tier !== "day" ? " sparse" : ""}${a.dow === 1 ? " wk" : ""}">${numHtml}${dowHtml}</div>`;
    }).join("");
    return monthRow + dayRow;
  }

  // タスク1行ぶんのバー領域HTML（予定バー＋実績バー）。taskId を data 属性に載せてドラッグで参照。
  function barsHTML(r, taskId) {
    const cells = scale.axis.map((a) => `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === 1 ? " wk" : ""}"></div>`).join("");
    let bars = "";
    if (r.planned.source) {
      const pg = scale.range(r.planned.start, r.planned.end);
      const left = pg.fromIdx * COL_W + 2, w = pg.span * COL_W - 4;
      const clip = (pg.clippedLeft ? " clipL" : "") + (pg.clippedRight ? " clipR" : "");
      // dates のみ端リサイズ可。plans/dates/due はすべて移動＋クリックで編集（draggable）。
      const resizable = r.planned.source === "dates";
      const handles = resizable ? `<span class="bar-h l"></span><span class="bar-h r"></span>` : "";
      bars += `<div class="bar plan draggable${clip}" data-task="${taskId}" data-src="${r.planned.source}" style="left:${left}px;width:${w}px" title="予定 ${fmtH(r.planned.h)}（${srcLabel(r.planned.source)}）・ドラッグで移動${resizable ? "／端で伸縮" : ""}・クリックで編集">${handles}</div>`;
    }
    if (r.actual.start) {
      const ag = scale.range(r.actual.start, r.actual.end);
      const left = ag.fromIdx * COL_W + 2, w = ag.span * COL_W - 4;
      const pct = Math.min(100, r.percent);
      const fill = r.over ? C.over : (r.percent >= 100 ? C.free : C.fill);
      bars += `<div class="bar act${r.over ? " over" : ""}" style="left:${left}px;width:${w}px" title="実績 ${fmtH(r.actual.h)} / 見積 ${fmtH(r.estH)}">
        <div class="fill" style="width:${pct}%;background:${fill}"></div>
        <div class="blabel">${r.percent}%</div></div>`;
    }
    return `<div class="r-cells">${cells}</div><div class="bar-area">${bars}</div>`;
  }

  function visibleTasks() {
    return tasks.filter((t) => {
      if (!state.projects.has(t.project_id)) return false;
      const aids = (t.assignees || []).map((a) => a.id);
      if (aids.length && !aids.some((id) => state.members.has(id))) return false;
      const r = rangeByTask.get(t.id);
      if (!r.planned.source) return false;
      if (!scale.intersects(r.planned.start, r.planned.end)) return false;
      if (state.hideDone && r.percent >= 100) return false;
      return true;
    });
  }

  function paintTaskMode() {
    ganttEl.style.setProperty("--label-w", LABEL_W + "px");
    head.innerHTML = gridHead(LABEL_W);
    const list = visibleTasks().sort((a, b) => {
      const ra = rangeByTask.get(a.id).planned.start, rb = rangeByTask.get(b.id).planned.start;
      return ra < rb ? -1 : ra > rb ? 1 : a.id - b.id;
    });
    const rowIndexById = new Map(list.map((t, i) => [t.id, i]));
    rowsEl.innerHTML = list.map((t) => {
      const r = rangeByTask.get(t.id);
      const asg = (t.assignees || []);
      const avs = asg.slice(0, 2).map((a) => {
        const idx = memberIdx.get(a.id) ?? a.id;
        return `<span class="ava" style="background:${member_color(idx)}">${esc(initial(a.name || a.username))}</span>`;
      }).join("") + (asg.length > 2 ? `<span class="more">+${asg.length - 2}</span>` : "");
      const pjName = (projects.find((p) => p.id === t.project_id) || {}).title || "—";
      return `<div class="row${r.over ? " delayed" : ""}" data-task="${t.id}">
        <div class="r-label">
          <span class="r-pbar" style="background:${projColor(t.project_id)}"></span>
          <span class="r-text">
            <span class="r-name">${esc(t.title)}</span>
            <span class="r-meta">${avs ? `<span class="av">${avs}</span>` : ""}
              <span>見${fmtH(r.estH)}・実${fmtH(r.spentH)}・予${fmtH(r.planned.h)}</span>
              ${r.over ? `<span class="r-flag">超過</span>` : ""}
              <span class="r-pj">${esc(pjName)}</span></span>
          </span>
        </div>
        ${barsHTML(r, t.id)}
      </div>`;
    }).join("") || `<div class="empty">表示できるタスクがありません（窓: ${startISO}〜${scale.axis[WINDOW_DAYS - 1].iso}）。</div>`;

    overlays(list.length, rowIndexById, list, ROW_H, 0, true);
  }

  function paintMemberMode() {
    ganttEl.style.setProperty("--label-w", LABEL_W_P + "px");
    head.innerHTML = gridHead(LABEL_W_P);
    const weekdays = scale.axis.filter((a) => !a.weekend).length;
    let html = "", rowOffset = 0;
    const offsets = []; // {y, taskId} は今回不要（人別は依存矢印なし）
    for (const m of members.filter((m) => state.members.has(m.id))) {
      const idx = memberIdx.get(m.id);
      const mtasks = visibleTasks().filter((t) => (t.assignees || []).some((a) => a.id === m.id));
      const dayMap = planByMember[m.id] || {};
      const winH = scale.axis.reduce((s, a) => s + (dayMap[a.iso] || 0), 0);
      const cap = 8 * Math.max(1, weekdays);
      const pct = cap ? Math.round((winH / cap) * 100) : 0;
      const capCol = pct > 100 ? C.over : pct >= 70 ? C.amber : C.free;
      const collapsed = state.collapsed.has("m" + m.id);
      // グループ日セル: 予定>8hの日を赤帯
      const gcells = scale.axis.map((a) => {
        const over = (dayMap[a.iso] || 0) > 8;
        return `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === 1 ? " wk" : ""}" style="${over ? `background:rgba(229,72,77,.14)` : ""}"></div>`;
      }).join("");
      html += `<div class="grp${collapsed ? " collapsed" : ""}" data-mid="${m.id}">
        <div class="grp-label" data-toggle="m${m.id}">
          <span class="caret">▾</span>
          <span class="avatar" style="background:${member_color(idx)}">${esc(initial(m.name))}</span>
          <span class="grp-text">
            <span class="grp-top"><span class="grp-name">${esc(m.name)}</span>
              <span class="cap-track"><span class="cap-fill" style="width:${Math.min(pct, 100)}%;background:${capCol}"></span></span>
              <span class="grp-sub">${pct}% ・ 予${fmtH(winH)}/${cap}h</span></span>
            <span class="grp-sub">${mtasks.length}タスク</span>
          </span>
        </div>
        <div class="grp-cells">${gcells}</div>
      </div>`;
      rowOffset += GRP_H;
      if (!collapsed) {
        for (const t of mtasks) {
          const r = rangeByTask.get(t.id);
          html += `<div class="row${r.over ? " delayed" : ""}" data-task="${t.id}">
            <div class="r-label r-label-sub">
              <span class="r-pbar" style="background:${projColor(t.project_id)}"></span>
              <span class="r-text"><span class="r-name">${esc(t.title)}</span>
                <span class="r-meta"><span>見${fmtH(r.estH)}・実${fmtH(r.spentH)}・予${fmtH(r.planned.h)}</span>
                ${r.over ? `<span class="r-flag">超過</span>` : ""}</span></span>
            </div>
            ${barsHTML(r, t.id)}
          </div>`;
          rowOffset += ROW_H;
        }
      }
    }
    rowsEl.innerHTML = html || `<div class="empty">メンバーがいません（担当の付いたタスクが必要）。</div>`;
    overlays(0, null, null, ROW_H, rowOffset, false);
  }

  // プロジェクト別レーン（人別レーンと同型）。プロジェクト=親タスク(related_tasks.subtask)。
  // プロジェクト見出し＋配下に子タスク（日付順）。親に属さない単独タスクは「プロジェクトなし」へ。折りたたみ可。
  function paintProjectMode() {
    ganttEl.style.setProperty("--label-w", LABEL_W_P + "px");
    head.innerHTML = gridHead(LABEL_W_P);
    // ベースフィルタ（WS/担当/完了）。予定の有無は問わない＝プロジェクト構造を見せる。
    const passBase = (t) => {
      if (!state.projects.has(t.project_id)) return false;
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
      const collapsed = state.collapsed.has("p" + g.pid);
      const gcells = scale.axis.map((a) => `<div class="cell${a.weekend ? " weekend" : ""}${a.dow === 1 ? " wk" : ""}"></div>`).join("");
      const band = g.pid ? projColor(g.ws) : C.muted;
      html += `<div class="grp${collapsed ? " collapsed" : ""}" data-pid="${g.pid}" style="--pj:${band}">
        <div class="grp-label" data-toggle="p${g.pid}">
          <span class="caret">▾</span>
          <span class="pj-band" style="background:${band}"></span>
          <span class="grp-text">
            <span class="grp-top"><span class="grp-name">${esc(g.title)}</span>
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
            <span class="r-text"><span class="r-name">${esc(t.title)}</span>
              <span class="r-meta">${avs ? `<span class="av">${avs}</span>` : ""}
                <span class="r-who">${asg[0] ? esc(asg[0].name || asg[0].username) : "未割当"}</span>
                <span>見${fmtH(r.estH)}・実${fmtH(r.spentH)}・予${fmtH(r.planned.h)}</span>
                ${r.over ? `<span class="r-flag">超過</span>` : ""}
                ${noplan ? `<span class="r-noplan">予定なし</span>` : ""}</span></span>
          </div>
          ${barsHTML(r, t.id)}
        </div>`;
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
    overlays(0, null, null, ROW_H, rowOffset, false);
  }

  // 今日線（＋タスクモードのみ依存矢印SVG）
  function overlays(rowCount, rowIndexById, list, rowH, totalHeightPx, withDeps) {
    const totalH = totalHeightPx || rowCount * rowH;
    // 今日線
    const ti = scale.indexOf(today);
    if (ti >= 0 && ti < WINDOW_DAYS && totalH > 0) {
      const lw = state.mode === "task" ? LABEL_W : LABEL_W_P;
      const left = lw + ti * COL_W + COL_W / 2;
      rowsEl.insertAdjacentHTML("beforeend",
        `<div class="today-line" style="left:${left}px;height:${totalH}px"><span class="tl-cap">今日</span></div>`);
    }
    if (!withDeps || !rowIndexById) return;
    // 依存矢印（予定バー right→left のL字）
    const paths = edges.filter((e) => rowIndexById.has(e.from) && rowIndexById.has(e.to)).map((e) => {
      const rf = rangeByTask.get(e.from), rt = rangeByTask.get(e.to);
      const fg = scale.range(rf.planned.start, rf.planned.end), tg = scale.range(rt.planned.start, rt.planned.end);
      const x1 = fg.toIdx * COL_W + COL_W - 2, x2 = tg.fromIdx * COL_W + 2;
      const y1 = rowIndexById.get(e.from) * rowH + rowH / 2, y2 = rowIndexById.get(e.to) * rowH + rowH / 2;
      const midX = Math.max(x1 + 14, x2 - 14);
      return `<path d="M${x1} ${y1} H${midX} V${y2} H${x2}" fill="none" stroke="${C.capline}" stroke-width="1.4" stroke-dasharray="3 3" marker-end="url(#gv-arrow)"/>`;
    }).join("");
    if (paths) {
      rowsEl.insertAdjacentHTML("beforeend",
        `<svg class="deps" style="width:${WINDOW_DAYS * COL_W}px;height:${totalH}px">
          <defs><marker id="gv-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="${C.capline}"/></marker></defs>
          ${paths}</svg>`);
    }
  }

  function paint() {
    if (state.mode === "task") paintTaskMode();
    else if (state.mode === "member") paintMemberMode();
    else paintProjectMode();
  }

  // ── ツールバー配線 ──
  root.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => {
      state.mode = gview.mode = b.dataset.mode;   // 選択モードを保持
      root.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === state.mode));
      paint();
    };
  });
  // 表示範囲: 窓日数・列幅・グリッドが変わるので全再描画（データは store キャッシュ）
  root.querySelectorAll("[data-range]").forEach((b) => {
    b.onclick = () => {
      gview.range = b.dataset.range;
      try { localStorage.setItem(RANGE_KEY, gview.range); } catch { /* localStorage 不可でも続行 */ }
      render(root);
    };
  });
  root.querySelectorAll("[data-proj]").forEach((b) => {
    b.onclick = () => { toggleSet(state.projects, +b.dataset.proj, b); paint(); };
  });
  root.querySelectorAll("[data-mem]").forEach((b) => {
    b.onclick = () => { toggleSet(state.members, +b.dataset.mem, b); paint(); };
  });
  root.querySelector("#gv-hidedone").onchange = (e) => { state.hideDone = e.target.checked; paint(); };
  // 人別ヘッダの折り畳みは再描画後に張り直すのでイベント委譲
  rowsEl.addEventListener("click", (e) => {
    const lbl = e.target.closest("[data-toggle]");
    if (!lbl) return;
    const key = lbl.dataset.toggle; // "m{memberId}" / "p{projectId}"（モード間の id 衝突回避）
    state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
    paint();
  });

  // ── バーのドラッグ編集（移動／dates は端で伸縮）＋クリックで編集モーダル ──
  let drag = null, dlabel = null;
  const reload = () => { invalidate(); render(root); };
  const isoZ = (d) => d + "T00:00:00Z";
  const showLabel = (text, x, y) => {
    if (!dlabel) { dlabel = document.createElement("div"); dlabel.className = "gv-draglabel"; document.body.appendChild(dlabel); }
    dlabel.textContent = text; dlabel.style.left = (x + 14) + "px"; dlabel.style.top = (y - 8) + "px"; dlabel.style.display = "block";
  };
  const hideLabel = () => { if (dlabel) dlabel.style.display = "none"; };

  rowsEl.addEventListener("pointerdown", (e) => {
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

  // ── 日別予定の直接入力: タスク行の「日セル」をクリック→その日の実施予定時間を入力 ──
  let dayPop = null;
  const closeDayPop = () => { if (dayPop) { dayPop.remove(); dayPop = null; document.removeEventListener("pointerdown", onDocDown, true); } };
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

  paint();
}

function srcLabel(source) {
  return source === "plans" ? "日別予定" : source === "dates" ? "期間" : source === "due" ? "締切" : "";
}

function toggleSet(set, id, btn) {
  if (set.has(id)) { set.delete(id); btn.setAttribute("aria-pressed", "false"); }
  else { set.add(id); btn.setAttribute("aria-pressed", "true"); }
}

function shell(projects, members, memberIdx, mode) {
  const projChips = projects.map((p) =>
    `<button class="chip" data-proj="${p.id}" aria-pressed="true">${esc(p.title)}</button>`).join("");
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
        ${seg("project", "プロジェクト別")}${seg("task", "タスク行")}${seg("member", "人別")}
      </div>
      <div class="tbg"><span class="tbl">表示範囲</span><div class="seg rangeseg">${RANGE_PRESETS.map((p) => `<button data-range="${p.key}"${gview.range === p.key ? ' class="on"' : ""}>${p.label}</button>`).join("")}</div></div>
      <div class="tbg"><span class="tbl">ワークスペース</span><div class="chips">${projChips}</div></div>
      <div class="tbg"><span class="tbl">担当者</span><div class="chips">${memChips}</div></div>
      <label class="tbg chk"><input type="checkbox" id="gv-hidedone"> 完了を隠す</label>
    </div>
    <div class="gv-scroll"><div class="gantt" id="gv-gantt" style="--label-w:${LABEL_W}px">
      <div class="grid-head" id="gv-head"></div>
      <div class="rows" id="gv-rows"></div>
    </div></div>
    <div class="legend">
      <span class="li"><span class="sw plan"></span>予定（task_time_plans / 期間 / 締切）</span>
      <span class="li"><span class="sw" style="background:${C.fill}"></span>実績進捗</span>
      <span class="li"><span class="sw" style="background:${C.free}"></span>完了</span>
      <span class="li"><span class="sw" style="background:${C.over}"></span>見積超過</span>
      <span class="li"><span style="border-left:2px dashed ${C.over};height:13px;display:inline-block"></span> 今日</span>
      <span class="li"><span style="display:inline-block;width:14px;border-top:1.4px dashed ${C.capline}"></span> 依存</span>
    </div>
  </div>
  </div>
  <style>
  /* ガントを画面高にフィット＝行だけ内側スクロール。タイトル/ツールバー/日付軸/凡例は常時表示。
     高さ控除 = topbar(54) + content 余白上(24)+下(60) = 138px。ページ自体はスクロールさせない */
  .gv-view{display:flex;flex-direction:column;height:calc(100vh - 138px)}
  .gv-view .vtitle{flex:none}
  .gv{padding:0;flex:1;min-height:0;display:flex;flex-direction:column}
  .gv-toolbar{flex:none}
  .gv .legend{flex:none}
  .gv-toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:12px 16px;border-bottom:1px solid ${C.line}}
  .gv .seg{display:inline-flex;border:1px solid ${C.line};border-radius:9px;overflow:hidden}
  .gv .seg button{border:0;background:#fff;color:${C.muted};font-size:12px;font-weight:700;padding:7px 14px;cursor:pointer}
  .gv .seg button.on{background:${C.fill};color:#fff}
  .gv .tbg{display:flex;align-items:center;gap:8px}
  .gv .tbl{font-size:11px;color:${C.muted};font-weight:600}
  .gv .chips{display:flex;flex-wrap:wrap;gap:6px}
  .gv .chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:5px 11px;border-radius:999px;border:1px solid ${C.line};background:#fff;color:${C.ink};cursor:pointer}
  .gv .chip[aria-pressed=false]{opacity:.4;text-decoration:line-through}
  .gv .chip .dot{width:9px;height:9px;border-radius:50%}
  .gv .chk{font-size:12px;color:${C.ink};cursor:pointer}
  .gv-scroll{flex:1;min-height:0;overflow:auto}
  .gv .gantt{min-width:calc(var(--label-w) + ${COL_W}px*${WINDOW_DAYS});position:relative}
  .gv .grid-head{display:grid;grid-template-columns:var(--label-w) repeat(${WINDOW_DAYS}, ${COL_W}px);grid-auto-rows:auto;border-bottom:1px solid ${C.line};position:sticky;top:0;background:#fff;z-index:8}
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
  .gv .row{display:grid;grid-template-columns:var(--label-w) repeat(${WINDOW_DAYS}, ${COL_W}px);border-bottom:1px solid ${C.line};height:${ROW_H}px;position:relative}
  .gv .row:hover{background:#fafbfc}
  .gv .row.delayed{background:rgba(229,72,77,.045)}
  .gv .row:hover .r-label{background:#fafbfc}
  .gv .row.delayed .r-label{background:#fdf2f2}
  .gv .r-label{border-right:1px solid ${C.line};padding:0 12px;display:flex;align-items:center;gap:9px;overflow:hidden;position:sticky;left:0;z-index:7;background:#fff}
  .gv .r-label-sub{padding-left:24px}
  .gv .r-pbar{width:4px;height:22px;border-radius:2px;flex:none}
  .gv .r-text{min-width:0}
  .gv .r-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
  .gv .r-cells{position:absolute;left:var(--label-w);top:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(${WINDOW_DAYS}, ${COL_W}px);pointer-events:none}
  .gv .cell{border-right:1px solid ${C.track}}
  .gv .cell.weekend{background:rgba(0,0,0,.012)}
  /* 長期表示(tight): 日ごとの細罫線を消し、週(月曜)の罫線だけ残す＝1目盛り=1週間で見やすく */
  .gv .gantt.tight .cell{border-right-color:transparent}
  .gv .gantt.tight .cell.wk{border-right:1px solid ${C.line}}
  .gv .gantt.tight .gh-day{border-right-color:transparent}
  .gv .gantt.tight .gh-day.wk{border-right:1px solid ${C.line}}
  .gv .bar-area{position:absolute;left:var(--label-w);top:0;right:0;height:${ROW_H}px}
  .gv .bar{position:absolute;border-radius:5px;overflow:hidden}
  .gv .bar.plan{top:6px;height:11px;background:${C.track};box-shadow:inset 0 0 0 1px rgba(58,134,255,.35)}
  .gv .bar.plan::after{content:"";position:absolute;inset:0;background:rgba(58,134,255,.16)}
  .gv .bar.act{top:20px;height:15px;background:${C.track};box-shadow:inset 0 0 0 1px rgba(0,0,0,.05)}
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
  .gv .grp{display:grid;grid-template-columns:var(--label-w) repeat(${WINDOW_DAYS}, ${COL_W}px);height:${GRP_H}px;position:relative;background:#fbfcfd;border-bottom:1px solid ${C.line}}
  .gv .grp-label{border-right:1px solid ${C.line};padding:0 12px;display:flex;align-items:center;gap:9px;cursor:pointer;overflow:hidden;position:sticky;left:0;z-index:7;background:#fbfcfd}
  .gv .grp-label:hover{background:#f3f5f8}
  .gv .grp .caret{font-size:10px;color:${C.muted};transition:transform .15s}
  .gv .grp.collapsed .caret{transform:rotate(-90deg)}
  .gv .avatar{width:30px;height:30px;border-radius:50%;color:#fff;font-size:13px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
  .gv .pj-band{width:14px;height:30px;border-radius:4px;flex:none}
  .gv .grp-text{min-width:0;display:flex;flex-direction:column;gap:3px;flex:1}
  /* プロジェクト別: 親→子はインデントで表現。縦線はヘッダから伸ばさず、紐づく子タスクの行にだけ引く */
  .gv .grp[data-pid] .grp-name{font-weight:800}
  .gv .row.pj-child .r-label{padding-left:74px}   /* 親名(≈49px)よりはっきり右へ字下げ＝配下と一目で分かる。position は基底の sticky を継承 */
  .gv .row.pj-child .r-name{font-weight:600}
  /* 縦線は子タスク行のみ。色四角の中心(ラベル左から33px)に揃える。最後の子の中央で止める */
  .gv .row.pj-child .r-label::before{content:"";position:absolute;left:var(--pjrail,32px);top:0;bottom:0;width:2px;background:var(--pj);opacity:.5}
  .gv .row.pj-child.last .r-label::before{bottom:auto;height:50%}
  .gv .grp-top{display:flex;align-items:center;gap:8px}
  .gv .grp-name{font-size:14px;font-weight:700;white-space:nowrap}
  .gv .grp-sub{font-size:10.5px;color:${C.muted};white-space:nowrap}
  .gv .cap-track{width:90px;height:7px;border-radius:5px;background:${C.track};overflow:hidden;position:relative;flex:none}
  .gv .cap-fill{position:absolute;left:0;top:0;bottom:0;border-radius:5px}
  .gv .grp-cells{position:absolute;left:var(--label-w);top:0;right:0;bottom:0;display:grid;grid-template-columns:repeat(${WINDOW_DAYS}, ${COL_W}px);pointer-events:none}
  .gv .legend{display:flex;flex-wrap:wrap;gap:14px;padding:11px 16px;border-top:1px solid ${C.line};font-size:11px;color:${C.muted}}
  .gv .legend .li{display:inline-flex;align-items:center;gap:6px}
  .gv .legend .sw{width:20px;height:10px;border-radius:3px}
  .gv .legend .sw.plan{background:rgba(58,134,255,.16);box-shadow:inset 0 0 0 1px rgba(58,134,255,.35)}
  .gv .empty{padding:34px;text-align:center;color:${C.muted};font-size:13px}
  </style>`;
}
