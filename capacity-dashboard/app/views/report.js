// 進捗報告ビュー（実績グループ）。遅れている時に上司へ「どこまで終わらせるか」を
// ぱっと報告するための画面。主役はコピペ用テキストの生成。
//
// 集計バケット（対象に担当が含まれるタスクが母集合。全員選択時は全タスク）:
//   完了    : statusOf==='done'（期間: 今日完了 / 今週完了 / 全部 を小トグルで選択。既定=今週完了）
//   遅延    : 未完了 かつ 期限 < 今日（N日超過を算出）
//   今日中  : 未完了 かつ 期限 == 今日（進行中なら進捗%）
//   今週中  : 未完了 かつ 今日 < 期限 <= 今週末
//   その他  : 未完了 かつ（期限が今週末より先 or 期限なし）＝「以降/期限なし」
//
// UI のアイコンは icon()（絵文字非使用）。コピペテキスト内の ✅⚠ 等は「データ」なので許可。
import { load } from "../lib/store.js";
import { humanAssignees } from "../lib/users.js";
import { shiftISO, dowOf } from "../lib/capacity.js";
import { statusOf } from "../lib/kinds.js";
import { C, esc, fmtH, todayISO } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";
import { getPrepScores } from "../lib/exec.js";

// 期限 ISO（未設定/ゼロ日付＝空）。home.js / 一覧 / quad と同じ判定。
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
// M/D 表示（先頭ゼロ無し）。
const mdOf = (iso) => { const [, m, d] = iso.split("-"); return `${+m}/${+d}`; };

// 今週末（今日を含む週の終端）。settings.weekStart があれば考慮、無ければ日曜終わり。
// weekStart=月(1) なら週末=日(0)、weekStart=日(0) なら週末=土(6)。
function weekEndISO(day, weekStart) {
  // weekStart 指定時はその開始曜日の 6 日後が週末。未指定時は日曜(0)を週末にする（要件: 無ければ日曜終わり）。
  const endDow = Number.isInteger(weekStart) ? (weekStart + 6) % 7 : 0;
  const cur = dowOf(day);
  const add = (endDow - cur + 7) % 7;   // 今日含む週の終端までの日数（今日が終端なら 0）
  return shiftISO(day, add);
}

// 対象セレクタの localStorage キー（本人ごと）。
const targetKey = (uid) => `ts.report.target.${uid ?? "anon"}`;
const doneRangeKey = "ts.report.donerange";
// 報告文ヒアリング回答の localStorage キー（本人ごと・当日キー）。日が変われば別キー＝前日分は残るが参照しない。
const hearingKey = (uid, day) => `ts.report.hearing.${uid ?? "anon"}.${day}`;
// 報告文 / 素データ の表示モード（本人ごと）。
const modeKey = (uid) => `ts.report.mode.${uid ?? "anon"}`;

// 全体の手応えセレクト選択肢（value=保存値, label=報告文に出す文言）。
const FEEL_OPTS = [
  ["", "（未選択）"],
  ["順調", "順調"],
  ["ほぼ順調", "ほぼ順調"],
  ["やや遅れ", "やや遅れ"],
  ["遅れ気味", "遅れ気味"],
];

// バケット定義（見出しメタ）。order が表示順。
const BUCKETS = [
  { id: "done",   title: "完了",          ic: "check",         mark: "✅" },
  { id: "late",   title: "遅延",          ic: "alertTriangle", mark: "⚠" },
  { id: "today",  title: "今日中",        ic: "alarm",         mark: "🔵" },
  { id: "week",   title: "今週中",        ic: "calendarDays",  mark: "📅" },
  { id: "other",  title: "以降/期限なし", ic: "calendar",      mark: "・" },
];

// タスクを各バケットに振り分け。done のみ doneRange（today/week/all）で更にフィルタ。
function bucketize(tasks, day, weekEnd, doneRange) {
  const out = { done: [], late: [], today: [], week: [], other: [] };
  const weekStartISO = shiftISO(day, -6); // 「今週完了」= 過去 7 日（今日含む）に done 化したもの
  for (const t of tasks) {
    const st = statusOf(t);
    const due = dueISO(t);
    if (st === "done") {
      const doneAt = (t.done_at && !t.done_at.startsWith("0001")) ? t.done_at.slice(0, 10) : null;
      if (doneRange === "today") { if (doneAt && doneAt !== day) continue; if (!doneAt) continue; }
      else if (doneRange === "week") { if (doneAt && doneAt < weekStartISO) continue; }
      // "all" は無条件で含む。done_at 不明（null）の場合: today では除外、week/all では含む。
      out.done.push(t);
      continue;
    }
    // 未完了
    if (!due) { out.other.push(t); continue; }
    if (due < day) out.late.push(t);
    else if (due === day) out.today.push(t);
    else if (due <= weekEnd) out.week.push(t);
    else out.other.push(t);
  }
  // 並び: 期限昇順 → id。
  const byDue = (a, b) => (dueISO(a) || "9999").localeCompare(dueISO(b) || "9999") || a.id - b.id;
  for (const k of Object.keys(out)) out[k].sort(byDue);
  return out;
}

// 超過日数（期限 < 今日 のとき正の整数）。
const overdueDays = (due, day) => {
  const a = new Date(due + "T00:00:00Z").getTime(), b = new Date(day + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
};

// 1 タスクのコピペ用ラベル（バケットごとに付帯情報を変える）。
function copyLabel(t, bk, day) {
  const due = dueISO(t);
  if (bk === "today") {
    const p = t.percent_done || 0;
    return p > 0 ? `${t.title}（${p}%）` : t.title;
  }
  if (bk === "week") return due ? `${t.title}（期限${mdOf(due)}）` : t.title;
  if (bk === "late") return due ? `${t.title}（期限${overdueDays(due, day)}日超過）` : t.title;
  return t.title;
}

// コピペ用テキスト全体を生成。0 件バケットは行ごと省略。代表は先頭 MAX_COPY 件＋「他n件」。
const MAX_COPY = 5;
function buildText(buckets, targetName, day, comment, todaySteps) {
  const lines = [`【進捗報告 ${mdOf(day)}】${targetName}`];
  if ((todaySteps || []).length) {
    const shown = todaySteps.slice(0, MAX_COPY).map((s) => s.late ? `${s.stepTitle}（遅れ）` : s.stepTitle);
    const rest = todaySteps.length - shown.length;
    lines.push(`🎯 今日やる1手(${todaySteps.length}): ${shown.join(" / ")}${rest > 0 ? ` …他${rest}件` : ""}`);
  }
  const seg = (id) => {
    const arr = buckets[id];
    if (!arr.length) return null;
    const meta = BUCKETS.find((b) => b.id === id);
    const shown = arr.slice(0, MAX_COPY).map((t) => copyLabel(t, id, day));
    const rest = arr.length - shown.length;
    if (id === "other") return `（以降/期限なし: ${arr.length}件）`;
    const tail = rest > 0 ? ` …他${rest}件` : "";
    return `${meta.mark} ${meta.title}(${arr.length}): ${shown.join(" / ")}${tail}`;
  };
  for (const b of BUCKETS) { const s = seg(b.id); if (s) lines.push(s); }
  let text = lines.join("\n");
  const c = (comment || "").trim();
  if (c) text += `\n→ ${c}`;
  return text;
}

// 報告文ジェネレーター（純粋関数）: ヒアリング回答 hr＋バケット buckets を合体し、
// 上司に伝わる噛みやすい箇条書き文字列を返す。AI 接続なしのテンプレ組み立て。
// 0 件 / 未回答の行は省略。件数が多い項目は代表 MAX_REPORT 件＋「他n件」。
// hr = { feel, doneNote, nextNote, lateNote, shareNote }（各文字列・任意）。
const MAX_REPORT = 3;
// バケットから代表タイトル列を「A / B / 他n件」形に。labeler は各タスクのラベル化関数。
function repList(arr, labeler) {
  if (!arr.length) return "";
  const shown = arr.slice(0, MAX_REPORT).map(labeler);
  const rest = arr.length - shown.length;
  return shown.join(" / ") + (rest > 0 ? ` 他${rest}件` : "");
}
function buildReport(buckets, hr, day, todaySteps) {
  const h = hr || {};
  const trim = (s) => (s || "").trim();
  const lines = [`お疲れさまです。本日(${mdOf(day)})の進捗です。`];

  // 全体感: 回答があれば反映。無ければ省略。
  const feel = trim(h.feel);
  if (feel) lines.push(`■ 全体感: ${feel}`);

  // 今日やる1手（準備済みの計画）: あれば必ず提示＝「準備して今日これをやる」を上司に見せる。
  if ((todaySteps || []).length) {
    const lbl = (s) => s.late ? `${s.stepTitle}（遅れ）` : s.stepTitle;
    lines.push(`■ 今日やる1手（準備済み）: ${repList(todaySteps, lbl)}`);
  }

  // 完了: 回答優先。未入力なら done バケットから自動補完。
  const doneNote = trim(h.doneNote);
  if (doneNote) lines.push(`■ 完了: ${doneNote}`);
  else if (buckets.done.length) lines.push(`■ 完了: ${repList(buckets.done, (t) => t.title)}`);

  // 本日対応中（今日中バケット）: 進捗% を添える。回答(これからやること)は別行で優先表示。
  if (buckets.today.length) {
    const lbl = (t) => { const p = t.percent_done || 0; return p > 0 ? `${t.title}（${p}%）` : t.title; };
    lines.push(`■ 本日対応中: ${repList(buckets.today, lbl)}`);
  }

  // これからやること: 回答があれば反映。未入力時は今日中バケットを既に上で出しているので、
  // 今日中が空かつ回答も空のときだけ「今週中」から軽く補完する。
  const nextNote = trim(h.nextNote);
  if (nextNote) lines.push(`■ これから: ${nextNote}`);

  // 今週中: 期限を添えて。
  if (buckets.week.length) {
    const lbl = (t) => { const due = dueISO(t); return due ? `${t.title}（〜${mdOf(due)}）` : t.title; };
    lines.push(`■ 今週中に: ${repList(buckets.week, lbl)}`);
  }

  // 遅延: データがあれば必ず出す。超過日数を添え、見通し(lateNote)があれば「→」で付ける。
  if (buckets.late.length) {
    const lbl = (t) => { const due = dueISO(t); return due ? `${t.title}（${overdueDays(due, day)}日遅れ）` : t.title; };
    let line = `■ 遅延: ${repList(buckets.late, lbl)}`;
    const lateNote = trim(h.lateNote);
    if (lateNote) line += ` → ${lateNote}`;
    lines.push(line);
  }

  // 共有/相談事項: 回答があれば反映。
  const shareNote = trim(h.shareNote);
  if (shareNote) lines.push(`■ 共有事項: ${shareNote}`);

  return lines.join("\n");
}

export async function render(root) {
  const { tasks, members, settings, me } = await load();
  const day = todayISO();
  const uid = me?.id ?? null;

  // 対象セレクタ: 自分 / 各メンバー / 全員。localStorage 保持。
  let target = "self";
  try { target = localStorage.getItem(targetKey(uid)) || "self"; } catch { /* noop */ }
  // 保存値が現メンバーに無ければ self に戻す。
  if (target !== "self" && target !== "all" && !members.some((m) => String(m.id) === target)) target = "self";

  // 完了の期間トグル。
  let doneRange = "week";
  try { doneRange = localStorage.getItem(doneRangeKey) || "week"; } catch { /* noop */ }
  if (!["today", "week", "all"].includes(doneRange)) doneRange = "week";

  const weekStart = settings && Number.isInteger(settings.weekStart) ? settings.weekStart : null;
  const weekEnd = weekEndISO(day, weekStart);

  // 対象 id（self→自分の id、メンバー→その id、all→null）と表示名。
  const targetId = target === "self" ? uid : (target === "all" ? null : +target);
  const targetMember = members.find((m) => m.id === targetId) || null;
  const targetName = target === "all" ? "全員"
    : (target === "self" ? (me ? (me.name || me.username) : "自分") : (targetMember ? (targetMember.name || targetMember.username) : `user${targetId}`));

  // 母集合: 全員=全タスク、個人=対象が人間担当に含まれるタスク。
  const scoped = (target === "all" || targetId == null)
    ? tasks
    : tasks.filter((t) => humanAssignees(t).some((a) => a.id === targetId));

  let buckets = bucketize(scoped, day, weekEnd, doneRange);

  // E5: 今日やる1手（着手準備の段取りで due<=today の未完了手順・遅れ含む）を対象タスクから集約。
  let stepsByTask = {};
  try { stepsByTask = (await getPrepScores())?.steps_by_task || {}; } catch { stepsByTask = {}; }
  const scopedTitle = new Map(scoped.map((t) => [t.id, t.title]));
  const todaySteps = [];
  for (const [tidStr, steps] of Object.entries(stepsByTask)) {
    const tid = +tidStr;
    if (!scopedTitle.has(tid)) continue;
    for (const s of steps || []) {
      if (s && s.due && s.due <= day && !s.done && (s.title || "").trim()) {
        todaySteps.push({ taskTitle: scopedTitle.get(tid), stepTitle: s.title, late: s.due < day, due: s.due });
      }
    }
  }
  todaySteps.sort((a, b) => (a.due || "").localeCompare(b.due || ""));

  // 報告文ヒアリング回答（本人ごと・当日キー）を復元。壊れた JSON は無視。
  // comment（素データ用の見通し/コメント）も hearing に載せ、当日中は永続化する。
  let hearing = { feel: "", doneNote: "", nextNote: "", lateNote: "", shareNote: "", comment: "" };
  try { const raw = localStorage.getItem(hearingKey(uid, day)); if (raw) hearing = { ...hearing, ...JSON.parse(raw) }; } catch { /* noop */ }
  let comment = hearing.comment || "";

  // 表示モード: report（報告文・既定）/ raw（素データ）。
  let mode = "report";
  try { mode = localStorage.getItem(modeKey(uid)) || "report"; } catch { /* noop */ }
  if (!["report", "raw"].includes(mode)) mode = "report";

  const hasLate = buckets.late.length > 0;

  // サマリチップ（バケット集計後）: 完了 / 遅延 / 今日中(計Xh)。遅延0は緑・1+は赤で注意喚起。
  const todayHours = buckets.today.reduce((s, t) => s + (t.time_estimate || 0) / 3600, 0);
  const lateN = buckets.late.length;
  const summaryChips = `
    <div class="rp-sum">
      <span class="rp-chip"><b>${buckets.done.length}</b> 完了</span>
      <span class="rp-chip ${lateN > 0 ? "bad" : "ok"}"><b>${lateN}</b> 遅延</span>
      <span class="rp-chip"><b>${buckets.today.length}</b> 今日中<small>計${fmtH(todayHours)}</small></span>
      <span class="rp-chip"><b>${todaySteps.length}</b> 今日やる手順</span>
    </div>`;

  const targetOpts = [
    `<option value="self"${target === "self" ? " selected" : ""}>自分${me ? `（${esc(me.name || me.username)}）` : ""}</option>`,
    `<option value="all"${target === "all" ? " selected" : ""}>全員</option>`,
    ...members.map((m) => `<option value="${m.id}"${target === String(m.id) ? " selected" : ""}>${esc(m.name || m.username)}</option>`),
  ].join("");

  const rangeOpts = [["today", "今日完了"], ["week", "今週完了"], ["all", "全部"]]
    .map(([v, l]) => `<option value="${v}"${doneRange === v ? " selected" : ""}>${l}</option>`).join("");

  const feelOpts = FEEL_OPTS
    .map(([v, l]) => `<option value="${esc(v)}"${hearing.feel === v ? " selected" : ""}>${esc(l)}</option>`).join("");

  root.innerHTML = `
    <h1 class="vtitle">報告 <small>${day}</small></h1>
    <div class="rp-bar card">
      <label class="rp-fld">${icon("user", { size: 14 })}<span>対象</span>
        <select id="rp-target">${targetOpts}</select>
      </label>
      <label class="rp-fld">${icon("check", { size: 14 })}<span>完了の範囲</span>
        <select id="rp-range">${rangeOpts}</select>
      </label>
      <span class="rp-weekend">今週末まで: ${mdOf(weekEnd)}</span>
    </div>
    ${summaryChips}
    <div class="rp-grid">
      <div class="rp-buckets" id="rp-buckets"></div>
      <div class="rp-copy card">
        <div class="rp-hear">
          <div class="rp-hear-h">${icon("message", { size: 14 })} 状況ヒアリング<span class="rp-hear-sub">任意・空欄は自動補完/省略</span></div>
          <label class="rp-h-fld"><span>全体の手応え</span>
            <select id="rp-feel">${feelOpts}</select>
          </label>
          <label class="rp-h-fld"><span>今日の成果（やったこと）</span>
            <input id="rp-done" type="text" placeholder="未入力なら「完了」から自動補完" value="${esc(hearing.doneNote)}">
          </label>
          <label class="rp-h-fld"><span>これからやること</span>
            <input id="rp-next" type="text" placeholder="例: 結合テストを進めます" value="${esc(hearing.nextNote)}">
          </label>
          <label class="rp-h-fld${hasLate ? "" : " rp-hide"}" id="rp-late-fld"><span>遅延の理由・挽回見通し</span>
            <input id="rp-late" type="text" placeholder="例: 仕様確認待ち。6/20までに挽回予定" value="${esc(hearing.lateNote)}">
          </label>
          <label class="rp-h-fld"><span>共有 / 相談事項</span>
            <input id="rp-share" type="text" placeholder="例: ◯◯のレビューをお願いしたいです" value="${esc(hearing.shareNote)}">
          </label>
        </div>
        <div class="rp-copy-h">
          <div class="rp-mode" role="tablist">
            <button type="button" class="rp-mode-b${mode === "report" ? " on" : ""}" data-mode="report">報告文</button>
            <button type="button" class="rp-mode-b${mode === "raw" ? " on" : ""}" data-mode="raw">素データ</button>
          </div>
          <button id="rp-copybtn" class="rp-copybtn">${icon("save", { size: 14 })} コピー</button>
        </div>
        <textarea id="rp-text" class="rp-text" readonly></textarea>
        <label class="rp-comment-l${mode === "raw" ? "" : " rp-hide"}" id="rp-comment-l">見通し / コメント（素データの末尾に「→」で付きます）</label>
        <textarea id="rp-comment" class="rp-comment${mode === "raw" ? "" : " rp-hide"}" placeholder="例: 遅延分は◯日までに完了予定">${esc(comment)}</textarea>
      </div>
    </div>
    <style>
      .rp-bar{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:12px 16px;margin-bottom:16px}
      .rp-fld{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:${C.ink}}
      .rp-fld .ic{color:${C.muted}}
      .rp-fld select{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid ${C.line};border-radius:7px;background:${C.bg};color:${C.ink}}
      .rp-weekend{margin-left:auto;font-size:12px;color:${C.muted}}
      .rp-sum{display:flex;flex-wrap:wrap;gap:8px;margin:-6px 0 16px}
      .rp-chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:${C.ink};
        background:${C.card};border:1px solid ${C.line};border-radius:999px;padding:4px 12px}
      .rp-chip b{font-size:13.5px;font-weight:800}
      .rp-chip small{font-size:11px;font-weight:600;color:${C.muted}}
      .rp-chip.ok{background:rgba(47,166,107,.12);border-color:rgba(47,166,107,.4);color:${C.free}}
      .rp-chip.ok b{color:${C.free}}
      .rp-chip.bad{background:rgba(229,72,77,.12);border-color:rgba(229,72,77,.4);color:${C.over}}
      .rp-chip.bad b{color:${C.over}}
      .rp-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:16px;align-items:start}
      @media(max-width:900px){.rp-grid{grid-template-columns:1fr}}
      .rp-buckets{display:flex;flex-direction:column;gap:12px}
      .rp-bk{border:1px solid ${C.line};border-radius:10px;background:${C.card};overflow:hidden}
      .rp-bk-h{display:flex;align-items:center;gap:7px;padding:9px 12px;font-size:12.5px;font-weight:700;color:${C.ink};border-bottom:1px solid ${C.line}}
      .rp-bk-h .ic{color:${C.muted}}
      .rp-bk-n{margin-left:auto;font-size:11px;font-weight:700;color:${C.muted};background:${C.track};border-radius:999px;padding:1px 8px}
      .rp-bk.late .rp-bk-h{color:${C.over}}
      .rp-bk.late .rp-bk-h .ic{color:${C.over}}
      .rp-rows{display:flex;flex-direction:column}
      .rp-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;
        border:0;border-top:1px solid ${C.line};background:transparent;color:${C.ink};font:inherit;cursor:pointer;padding:8px 12px}
      .rp-row:first-child{border-top:0}
      .rp-row:hover{background:${C.track}}
      .rp-row-t{flex:1;min-width:0;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .rp-row-m{display:flex;align-items:center;gap:8px;font-size:11px;color:${C.muted};flex:none}
      .rp-tag{font-size:10.5px;font-weight:700;border-radius:999px;padding:1px 7px;background:${C.track};color:${C.muted}}
      .rp-tag.late{background:rgba(229,72,77,.14);color:${C.over}}
      .rp-empty{padding:10px 12px;font-size:12px;color:${C.muted}}
      .rp-copy{padding:12px 16px;position:sticky;top:8px}
      .rp-copy-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      .rp-copy-t{flex:1;font-size:12.5px;font-weight:700;color:${C.ink};display:inline-flex;align-items:center;gap:6px}
      .rp-copy-t .ic{color:${C.muted}}
      .rp-copybtn{display:inline-flex;align-items:center;gap:5px;border:1px solid ${C.line};background:${C.bg};color:${C.ink};
        font:inherit;font-size:12px;font-weight:600;border-radius:7px;padding:6px 12px;cursor:pointer}
      .rp-copybtn:hover{background:${C.track}}
      .rp-copybtn.ok{background:${C.free};border-color:${C.free};color:#fff}
      .rp-text{width:100%;box-sizing:border-box;min-height:160px;resize:vertical;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
        border:1px solid ${C.line};border-radius:8px;background:${C.bg};color:${C.ink};padding:10px 12px}
      .rp-comment-l{display:block;margin:12px 0 5px;font-size:11.5px;font-weight:600;color:${C.muted}}
      .rp-comment{width:100%;box-sizing:border-box;min-height:54px;resize:vertical;font:inherit;font-size:12.5px;
        border:1px solid ${C.line};border-radius:8px;background:${C.bg};color:${C.ink};padding:8px 12px}
      .rp-hide{display:none!important}
      .rp-hear{display:flex;flex-direction:column;gap:9px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid ${C.line}}
      .rp-hear-h{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:${C.ink}}
      .rp-hear-h .ic{color:${C.muted}}
      .rp-hear-sub{margin-left:auto;font-size:10.5px;font-weight:600;color:${C.muted}}
      .rp-h-fld{display:flex;flex-direction:column;gap:4px}
      .rp-h-fld>span{font-size:11px;font-weight:600;color:${C.muted}}
      .rp-h-fld select,.rp-h-fld input{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:6px 9px;
        border:1px solid ${C.line};border-radius:7px;background:${C.bg};color:${C.ink}}
      .rp-mode{flex:1;display:inline-flex;gap:0;border:1px solid ${C.line};border-radius:8px;overflow:hidden}
      .rp-mode-b{font:inherit;font-size:12px;font-weight:600;border:0;background:${C.bg};color:${C.muted};padding:5px 12px;cursor:pointer}
      .rp-mode-b+.rp-mode-b{border-left:1px solid ${C.line}}
      .rp-mode-b.on{background:${C.track};color:${C.ink};font-weight:700}
    </style>`;

  const bucketsEl = root.querySelector("#rp-buckets");
  const textEl = root.querySelector("#rp-text");

  // バケット一覧（画面表示）を描画。各行クリックで編集モーダル。
  function paintBuckets() {
    bucketsEl.innerHTML = BUCKETS.map((b) => {
      const arr = buckets[b.id];
      const head = `<div class="rp-bk-h">${icon(b.ic, { size: 14 })}<span>${esc(b.title)}</span><span class="rp-bk-n">${arr.length}</span></div>`;
      if (!arr.length) return `<div class="rp-bk ${b.id}">${head}<div class="rp-empty">なし</div></div>`;
      const rows = arr.map((t) => {
        const due = dueISO(t);
        let meta = "";
        if (b.id === "late" && due) meta = `<span class="rp-tag late">${overdueDays(due, day)}日超過</span>`;
        else if (b.id === "today") { const p = t.percent_done || 0; meta = p > 0 ? `<span class="rp-tag">${p}%</span>` : ""; }
        else if (b.id === "week" && due) meta = `<span class="rp-tag">期限${mdOf(due)}</span>`;
        else if (b.id === "other" && due) meta = `<span class="rp-tag">期限${mdOf(due)}</span>`;
        const est = (t.time_estimate || 0) > 0 ? `<span>${fmtH(t.time_estimate / 3600)}</span>` : "";
        return `<button type="button" class="rp-row" data-id="${t.id}">
          <span class="rp-row-t">${esc(t.title)}</span>
          <span class="rp-row-m">${meta}${est}</span>
        </button>`;
      }).join("");
      return `<div class="rp-bk ${b.id}">${head}<div class="rp-rows">${rows}</div></div>`;
    }).join("");
    bucketsEl.querySelectorAll(".rp-row[data-id]").forEach((el) => {
      el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved: () => render(root) });
    });
  }

  // 表示テキスト: report=報告文ジェネレーター / raw=従来の素データ列挙。
  function paintText() {
    textEl.value = mode === "raw"
      ? buildText(buckets, targetName, day, comment, todaySteps)
      : buildReport(buckets, hearing, day, todaySteps);
  }

  // ヒアリング回答を localStorage（本人ごと・当日キー）へ保存。
  function saveHearing() {
    try { localStorage.setItem(hearingKey(uid, day), JSON.stringify(hearing)); } catch { /* noop */ }
  }

  paintBuckets();
  paintText();

  // ヒアリング入力 → hearing 更新 → 即再生成＋保存（再集計不要のためその場更新）。
  const bindHear = (sel, field) => {
    const el = root.querySelector(sel);
    if (!el) return;
    const ev = el.tagName === "SELECT" ? "onchange" : "oninput";
    el[ev] = (e) => { hearing[field] = e.target.value; saveHearing(); paintText(); };
  };
  bindHear("#rp-feel", "feel");
  bindHear("#rp-done", "doneNote");
  bindHear("#rp-next", "nextNote");
  bindHear("#rp-late", "lateNote");
  bindHear("#rp-share", "shareNote");

  // モード切替（報告文 / 素データ）。コメント欄は素データ時のみ表示。
  root.querySelectorAll(".rp-mode-b[data-mode]").forEach((btn) => {
    btn.onclick = () => {
      mode = btn.dataset.mode;
      try { localStorage.setItem(modeKey(uid), mode); } catch { /* noop */ }
      root.querySelectorAll(".rp-mode-b").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
      const cl = root.querySelector("#rp-comment-l"), cm = root.querySelector("#rp-comment");
      cl.classList.toggle("rp-hide", mode !== "raw");
      cm.classList.toggle("rp-hide", mode !== "raw");
      paintText();
    };
  });

  // 対象変更 → 再描画（render 全体を呼ぶと localStorage 反映＋再集計が最も簡単で副作用も少ない）。
  root.querySelector("#rp-target").onchange = (e) => {
    try { localStorage.setItem(targetKey(uid), e.target.value); } catch { /* noop */ }
    render(root);
  };
  root.querySelector("#rp-range").onchange = (e) => {
    try { localStorage.setItem(doneRangeKey, e.target.value); } catch { /* noop */ }
    render(root);
  };

  // コメント入力 → コピーテキスト末尾に反映＋hearing に載せて当日永続化（再集計不要なのでその場更新）。
  root.querySelector("#rp-comment").oninput = (e) => { comment = e.target.value; hearing.comment = comment; saveHearing(); paintText(); };

  // コピー: clipboard API → 失敗時は textarea を select() してフォールバック。
  const copyBtn = root.querySelector("#rp-copybtn");
  copyBtn.onclick = async () => {
    const txt = textEl.value;
    const done = () => { copyBtn.classList.add("ok"); copyBtn.innerHTML = `${icon("check", { size: 14 })} コピー済`; setTimeout(() => { copyBtn.classList.remove("ok"); copyBtn.innerHTML = `${icon("save", { size: 14 })} コピー`; }, 1600); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(txt); done(); return; }
      throw new Error("no clipboard");
    } catch {
      // フォールバック: 選択 → execCommand（古環境/非セキュアコンテキスト用）。
      textEl.focus(); textEl.select();
      try { document.execCommand("copy"); done(); } catch { /* 最終手段: 選択状態のまま手動コピーを促す */ }
    }
  };
}
