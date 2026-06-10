// レビュー ／ 承認キュー（mock 66 相当・実データ）。レビューラベル付き未完了タスクを「あなた宛/その他」で一覧。
import { load, projectName, invalidate } from "../lib/store.js";
import { whoami, updateTask } from "../lib/api.js";
import { isReviewTask } from "../lib/kinds.js";
import { C, esc, member_color } from "../lib/ui.js";

const TS_BASE = "http://leo:7005";
const WARN_MS = 4 * 3600000; // 半日(4h)以上で要注意

function waitLabel(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + "分";
  if (h < 24) return Math.round(h) + "時間";
  return Math.round(h / 24) + "日";
}

export async function render(root) {
  const data = await load();
  let me = null;
  try { me = await whoami(); } catch { /* 未取得でも表示はする */ }
  const meId = me && me.id;
  const meName = me ? (me.name || me.username) : "あなた";
  const now = Date.now();

  const rows = data.tasks
    .filter((t) => isReviewTask(t) && !t.done)
    .map((t) => {
      const created = Date.parse(t.created) || now;
      const rel = t.related_tasks && (t.related_tasks.related || [])[0];
      return {
        id: t.id, title: t.title, proj: projectName(data.projects, t.project_id),
        srcId: rel && rel.id, srcTitle: rel && rel.title,
        reviewer: (t.assignees || [])[0],
        mine: (t.assignees || []).some((a) => a.id === meId),
        wait: Math.max(0, now - created),
      };
    })
    .sort((a, b) => b.wait - a.wait);

  const mine = rows.filter((r) => r.mine);
  const others = rows.filter((r) => !r.mine);
  const maxWait = rows.reduce((m, r) => Math.max(m, r.wait), 0);
  const warnN = rows.filter((r) => r.wait >= WARN_MS).length;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">レビュー ／ 承認キュー <small>${esc(meName)} 宛を上に・待ち時間順</small></h1>
    <div class="rq-stats">
      <div class="rq-kpi you"><div class="l">${esc(meName)}宛・対応待ち</div><div class="v">${mine.length}<small>件</small></div></div>
      <div class="rq-kpi"><div class="l">キュー全体</div><div class="v">${rows.length}<small>件</small></div></div>
      <div class="rq-kpi"><div class="l">最長待ち</div><div class="v">${rows.length ? waitLabel(maxWait) : "—"}</div></div>
      <div class="rq-kpi ${warnN ? "warn" : ""}"><div class="l">要注意（4h以上）</div><div class="v">${warnN}<small>件</small></div></div>
    </div>
    ${rows.length ? "" : `<div class="rq-empty">レビュー待ちはありません。円時計の⋯「レビュー依頼」から作成できます。</div>`}
    ${mine.length ? section(`${esc(meName)} 宛のレビュー待ち`, mine, true) : ""}
    ${others.length ? section("その他のレビュー／承認待ち", others, false) : ""}`;

  root.querySelectorAll(".rq-appr").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.textContent = "…";
      await updateTask(+b.dataset.id, { done: true });
      invalidate(); render(root);
    };
  });
}

function section(title, rows, you) {
  const head = `<div class="rq-sechdr"><h2>${title}</h2>${you ? `<span class="rq-pill">最優先</span>` : ""}<span class="rq-cnt">${rows.length} 件</span></div>`;
  return `<div class="rq-section">${head}<div class="rq-queue">${rows.map(rowHtml).join("")}</div></div>`;
}

function rowHtml(r) {
  const rn = r.reviewer ? (r.reviewer.name || r.reviewer.username) : "未割当";
  const warn = r.wait >= WARN_MS;
  const open = r.srcId ? `<a class="rq-btn" href="${TS_BASE}/tasks/${r.srcId}" target="_blank" rel="noopener" title="元タスクを開く">↗</a>` : "";
  return `<div class="rq-row ${r.mine ? "you" : ""}">
    <span class="rq-kind">レビュー</span>
    <div class="rq-titlecell">
      <div class="t">${esc(r.title)}</div>
      <div class="meta">
        ${r.srcTitle ? `<span class="src">元: ${esc(r.srcTitle)}</span>` : ""}<span class="proj">${esc(r.proj)}</span>
        <span class="rq-who"><span class="ava" style="background:${r.reviewer ? member_color(r.reviewer.id) : C.full}">${esc(rn[0] || "?")}</span>${esc(rn)}${r.mine ? "（あなた）" : ""}</span>
        <span class="rq-wait ${warn ? "warn" : "ok"}"><span class="wdot"></span>${waitLabel(r.wait)}${warn ? " 要対応" : ""}</span>
      </div>
    </div>
    <div class="rq-acts">${open}<button class="rq-btn appr rq-appr" data-id="${r.id}">承認</button></div>
  </div>`;
}

function css() {
  return `
  .rq-stats{display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 22px}
  .rq-kpi{background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:14px 18px;box-shadow:0 1px 2px rgba(20,30,50,.04);flex:1 1 170px}
  .rq-kpi .l{font-size:11.5px;color:${C.muted};margin-bottom:3px}
  .rq-kpi .v{font-size:23px;font-weight:700}
  .rq-kpi .v small{font-size:13px;color:${C.muted};font-weight:600;margin-left:2px}
  .rq-kpi.you{border-color:#cfe0ff;background:#f5f9ff}
  .rq-kpi.warn .v{color:${C.over}}
  .rq-section{margin-bottom:22px}
  .rq-sechdr{display:flex;align-items:center;gap:10px;margin:0 0 9px}
  .rq-sechdr h2{font-size:14.5px;margin:0;font-weight:700}
  .rq-pill{font-size:10.5px;font-weight:700;color:#fff;background:${C.fill};border-radius:20px;padding:2px 9px}
  .rq-cnt{font-size:12px;color:${C.muted};margin-left:auto}
  .rq-queue{background:${C.card};border:1px solid ${C.line};border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(20,30,50,.04)}
  .rq-row{display:flex;align-items:center;gap:11px;padding:11px 16px;border-bottom:1px solid ${C.line};font-size:13px}
  .rq-row:last-child{border-bottom:0}
  .rq-row.you{background:#f7fbff}
  .rq-kind{flex:none;font-size:10.5px;font-weight:700;color:${C.fill};background:#eaf2ff;border:1px solid #d5e6ff;border-radius:6px;padding:2px 8px;align-self:flex-start;margin-top:1px}
  .rq-titlecell{flex:1;min-width:0}
  .rq-titlecell .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rq-titlecell .meta{font-size:11px;color:${C.muted};margin-top:3px;display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center}
  .rq-titlecell .src{color:${C.ink}}
  .rq-who{display:inline-flex;align-items:center;gap:5px}
  .rq-who .ava{width:18px;height:18px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:700}
  .rq-wait{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums;font-weight:600}
  .rq-wait .wdot{width:7px;height:7px;border-radius:50%;background:${C.free}}
  .rq-wait.warn{color:${C.over}}.rq-wait.warn .wdot{background:${C.over}}
  .rq-acts{flex:none;display:flex;gap:7px;justify-content:flex-end}
  .rq-btn{border:1px solid ${C.line};background:#fff;color:${C.ink};border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
  .rq-btn:hover{background:#f3f5f8}
  .rq-btn.appr{background:${C.free};border-color:${C.free};color:#fff}
  .rq-btn.appr:hover{filter:brightness(.95)}
  .rq-empty{padding:30px;text-align:center;color:${C.muted};background:${C.card};border:1px solid ${C.line};border-radius:14px}
  @media(max-width:760px){.rq-qhead{display:none}.rq-row{grid-template-columns:1fr;gap:6px}}`;
}
