// レビュー ／ 承認キュー（mock 66 相当・実データ）。レビューラベル付き未完了タスクを「あなた宛/その他」で一覧。
import { load, projectName, invalidate } from "../lib/store.js";
import { updateTask, createComment, getComments } from "../lib/api.js";
import { isReviewTask } from "../lib/kinds.js";
import { C, esc, member_color, avatar } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";

const WARN_MS = 4 * 3600000; // 半日(4h)以上で要注意

function waitLabel(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + "分";
  if (h < 24) return Math.round(h) + "時間";
  return Math.round(h / 24) + "日";
}

export async function render(root) {
  const data = await load();
  // 自分判定は load() が取得済みの me を使う（この画面で whoami() を別途叩かない）。
  const me = data.me || null;
  const meId = me && me.id;
  const meName = me ? (me.name || me.username) : "あなた";
  const now = Date.now();

  const rows = data.tasks
    .filter((t) => isReviewTask(t) && !t.done)
    .map((t) => {
      const created = Date.parse(t.created) || now;
      const rel = t.related_tasks && (t.related_tasks.related || [])[0];
      const cb = t.created_by || null;
      return {
        id: t.id, title: t.title, proj: projectName(data.projects, t.project_id),
        srcId: rel && rel.id, srcTitle: rel && rel.title,
        reviewer: (t.assignees || [])[0],
        mine: (t.assignees || []).some((a) => a.id === meId),
        createdBy: cb,
        mineRequest: !!(cb && cb.id === meId),
        wait: Math.max(0, now - created),
      };
    })
    .sort((a, b) => b.wait - a.wait);

  const mine = rows.filter((r) => r.mine);
  const others = rows.filter((r) => !r.mine);
  const maxWait = rows.reduce((m, r) => Math.max(m, r.wait), 0);
  const warnRows = rows.filter((r) => r.wait >= WARN_MS);
  const warnN = warnRows.length;
  // KPI「最長待ち」「要注意」からスクロールするためのアンカー（rows は wait 降順）
  const anchors = {};
  if (rows.length) anchors[rows[0].id] = "rq-longest";
  if (warnRows.length) anchors[warnRows[0].id] = "rq-firstwarn";

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">レビュー ／ 承認キュー <small>${esc(meName)} 宛を上に・待ち時間順</small></h1>
    <div class="rq-stats">
      ${kpi(`${esc(meName)}宛・対応待ち`, `${mine.length}<small>件</small>`, "you", mine.length ? "sec-mine" : "")}
      ${kpi("キュー全体", `${rows.length}<small>件</small>`, "", rows.length ? (mine.length ? "sec-mine" : "sec-others") : "")}
      ${kpi("最長待ち", rows.length ? waitLabel(maxWait) : "—", "", rows.length ? "rq-longest" : "")}
      ${kpi("要注意（4h以上）", `${warnN}<small>件</small>`, warnN ? "warn" : "", warnN ? "rq-firstwarn" : "")}
    </div>
    ${rows.length ? "" : `<div class="rq-empty">レビュー待ちはありません。円時計の⋯「レビュー依頼」から作成できます。</div>`}
    ${mine.length ? section(`${esc(meName)} 宛のレビュー待ち`, mine, true, "sec-mine", anchors) : ""}
    ${others.length ? section("その他のレビュー／承認待ち", others, false, "sec-others", anchors) : ""}`;

  const onSaved = async () => { invalidate(); render(root); };

  // KPI/サマリ → 該当セクション／行へスムーズスクロール（クリック・Enter/Space）。
  // data-jump にスクロール先要素の id を持たせ、無ければ何もしない。
  const jumpTo = (targetId) => {
    if (!targetId) return;
    const el = root.querySelector(`#${targetId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("rq-flash");
    setTimeout(() => el.classList.remove("rq-flash"), 1000);
  };
  root.querySelectorAll(".rq-kpi[data-jump]").forEach((k) => {
    k.onclick = () => jumpTo(k.dataset.jump);
    k.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jumpTo(k.dataset.jump); }
    };
  });

  // 元タスクを SPA モーダルで開く（外部ページへ飛ばない）
  root.querySelectorAll(".rq-open").forEach((b) => {
    b.onclick = () => openTaskForm({ taskId: +b.dataset.src, onSaved });
  });

  // レビュータスク自体もタイトルセルクリックで編集
  root.querySelectorAll(".rq-titlecell[data-id]").forEach((el) => {
    el.onclick = () => openTaskForm({ taskId: +el.dataset.id, onSaved });
  });

  // インラインのコメント入力を開く（承認 or 差し戻し）。mode: "approve" | "reject"
  const openInline = (id, mode, title) => {
    const box = root.querySelector(`.rq-inline[data-for="${id}"]`);
    if (!box) return;
    const reject = mode === "reject";
    // M11: 既に入力中のテキストがある状態で再構築すると無警告で破棄される。
    // 入力があるときは破棄確認し、キャンセルされたら現状を維持する。
    const prevTa = !box.hidden && box.querySelector(".rq-inline-ta");
    if (prevTa && prevTa.value.trim()) {
      if (!confirm("入力中の内容があります。破棄してやり直しますか？")) return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="rq-inline-head">${reject ? "差し戻し（理由は必須）" : "承認（コメントは任意）"}</div>
      <textarea class="rq-inline-ta" rows="2" placeholder="${reject ? "修正してほしい点を記入…" : "コメント（任意）…"}"></textarea>
      <div class="rq-inline-err" hidden></div>
      <div class="rq-inline-acts">
        <button class="rq-btn rq-inline-cancel" type="button">キャンセル</button>
        <button class="rq-btn ${reject ? "" : "appr"} rq-inline-ok" type="button">確定</button>
      </div>`;
    const ta = box.querySelector(".rq-inline-ta");
    const err = box.querySelector(".rq-inline-err");
    const ok = box.querySelector(".rq-inline-ok");
    ta.focus();
    box.querySelector(".rq-inline-cancel").onclick = () => { box.hidden = true; box.innerHTML = ""; };
    ok.onclick = async () => {
      const text = ta.value.trim();
      if (reject && !text) {
        err.hidden = false; err.textContent = "差し戻しには理由の記入が必要です。"; ta.focus();
        return;
      }
      ok.disabled = true; ok.textContent = "…";
      try {
        if (reject) {
          await createComment(id, `↩️ 要修正（${meName}）：${text}`);
        } else {
          await createComment(id, `✅ ${meName} が承認しました${text ? "：" + text : ""}`);
          await updateTask(id, { done: true });
        }
      } catch {
        ok.disabled = false; ok.textContent = "確定";
        err.hidden = false; err.textContent = "送信に失敗しました。";
        return;
      }
      invalidate(); render(root);
      if (reject) {
        showUndoToast("差し戻しました（依頼者に表示されます）", null);
      } else {
        showUndoToast(`「${title}」を承認しました`, async () => {
          await updateTask(id, { done: false });
          invalidate(); render(root);
        });
      }
    };
  };

  root.querySelectorAll(".rq-appr").forEach((b) => {
    b.onclick = () => openInline(+b.dataset.id, "approve", b.dataset.title || "タスク");
  });
  root.querySelectorAll(".rq-reject").forEach((b) => {
    b.onclick = () => openInline(+b.dataset.id, "reject", b.dataset.title || "タスク");
  });

  // 💬 履歴トグル: クリックでコメント遅延ロード→その行の下に表示。再クリックで畳む。
  root.querySelectorAll(".rq-hist").forEach((b) => {
    b.onclick = async () => {
      // M9: 連打ガード。読み込み中の同ボタンを再クリックしても二重リード／状態破壊しない。
      if (b.dataset.loading === "1") return;
      const id = +b.dataset.id;
      const box = root.querySelector(`.rq-histbox[data-for="${id}"]`);
      if (!box) return;
      // 既に開いている → 畳む（同期処理なのでガード不要）
      if (!box.hidden) { box.hidden = true; box.innerHTML = ""; return; }
      box.hidden = false;
      box.innerHTML = `<div class="rq-hist-empty">読み込み中…</div>`;
      b.dataset.loading = "1";
      let list = null;
      try { list = await getComments(id); }
      catch {
        // await 中にユーザーが畳んだ／別状態にした場合は上書きしない
        if (b.dataset.loading === "1" && !box.hidden) {
          box.innerHTML = `<div class="rq-hist-empty">コメント取得失敗</div>`;
        }
        return;
      }
      finally { delete b.dataset.loading; }
      // 描画前チェック: await の間に閉じられた／別リードが走った場合はスキップ
      if (box.hidden) return;
      const items = (list || []).slice().sort((a, b) =>
        String(a.created || "").localeCompare(String(b.created || "")));
      if (!items.length) { box.innerHTML = `<div class="rq-hist-empty">コメントはまだありません。</div>`; return; }
      box.innerHTML = items.map((c) => {
        const au = c.author && (c.author.name || c.author.username) || "不明";
        const dt = c.created ? new Date(c.created).toLocaleString("ja-JP") : "";
        return `<div class="rq-hist-item"><div class="rq-hist-meta"><b>${esc(au)}</b> <span>${esc(dt)}</span></div><div class="rq-hist-body">${esc(c.comment || "")}</div></div>`;
      }).join("");
    };
  });
}

// 承認の取り消し（Undo）スナックバー。画面下中央に固定・約6秒で自動消滅・新しい呼び出しで置換。
let _toastTimer = null;
function showUndoToast(message, onUndo, opts = {}) {
  const old = document.getElementById("rq-toast");
  if (old) old.remove();
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  const el = document.createElement("div");
  el.id = "rq-toast";
  el.className = "rq-toast" + (opts.error ? " error" : "");
  el.innerHTML = `<style>${toastCss()}</style>
    <span class="rq-toast-msg">${esc(message)}</span>
    ${onUndo ? `<button class="rq-toast-undo" type="button">元に戻す</button>` : ""}`;
  document.body.appendChild(el);
  // フェードイン
  requestAnimationFrame(() => el.classList.add("show"));

  const close = () => {
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  };
  if (onUndo) {
    const u = el.querySelector(".rq-toast-undo");
    u.onclick = async () => { close(); try { await onUndo(); } catch { /* noop */ } };
  }
  _toastTimer = setTimeout(close, 6000);
}

function toastCss() {
  return `
  .rq-toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,12px);z-index:9999;
    display:flex;align-items:center;gap:14px;max-width:90vw;
    background:${C.card};color:${C.ink};border:1px solid ${C.line};border-radius:12px;
    padding:11px 16px;font-size:13px;font-weight:600;
    box-shadow:0 8px 24px rgba(20,30,50,.22);opacity:0;transition:opacity .2s,transform .2s}
  .rq-toast.show{opacity:1;transform:translate(-50%,0)}
  .rq-toast.error{border-color:${C.over};color:${C.over}}
  .rq-toast-msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rq-toast-undo{flex:none;border:1px solid ${C.line};background:transparent;color:${C.fill};
    border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
  .rq-toast-undo:hover{background:rgba(58,134,255,.1)}
  html[data-theme="dark"] .rq-toast{box-shadow:0 8px 24px rgba(0,0,0,.5)}`;
}

// クリック可能な KPI カード（jumpId があればスクロール用 data-jump とキーボード操作可に）。
function kpi(label, valueHtml, cls, jumpId) {
  const clickable = jumpId ? ` rq-jump" data-jump="${jumpId}" role="button" tabindex="0` : "";
  return `<div class="rq-kpi ${cls}${clickable}"><div class="l">${label}</div><div class="v">${valueHtml}</div></div>`;
}

function section(title, rows, you, id, anchors = {}) {
  const head = `<div class="rq-sechdr"><h2>${title}</h2>${you ? `<span class="rq-pill">MUST</span>` : ""}<span class="rq-cnt">${rows.length} 件</span></div>`;
  return `<div class="rq-section"${id ? ` id="${id}"` : ""}>${head}<div class="rq-queue">${rows.map((r) => rowHtml(r, anchors)).join("")}</div></div>`;
}

// 依頼者（created_by）表示。自分依頼はバッジ、他者は avatar()「依頼:◯◯」。created_by 無しは省略。
function requesterHtml(r) {
  if (r.mineRequest) return `<span class="rq-req mine">自分依頼</span>`;
  if (!r.createdBy) return "";
  const nm = r.createdBy.name || r.createdBy.username || "不明";
  return `<span class="rq-req">${avatar(r.createdBy, { size: 16 })}依頼:${esc(nm)}</span>`;
}

function rowHtml(r, anchors = {}) {
  const rn = r.reviewer ? (r.reviewer.name || r.reviewer.username) : "未割当";
  const warn = r.wait >= WARN_MS;
  const open = r.srcId ? `<button class="rq-btn rq-open" data-src="${r.srcId}" title="元タスクを開く">↗</button>` : "";
  const anchorId = anchors[r.id] ? ` id="${anchors[r.id]}"` : "";
  return `<div class="rq-row ${r.mine ? "you" : ""}"${anchorId}>
    <span class="rq-kind">レビュー</span>
    <div class="rq-titlecell" data-id="${r.id}" title="このレビュータスクを編集">
      <div class="t">${esc(r.title)}</div>
      <div class="meta">
        ${r.srcTitle ? `<span class="src">元: ${esc(r.srcTitle)}</span>` : ""}<span class="proj">${esc(r.proj)}</span>
        <span class="rq-who"><span class="ava" style="background:${r.reviewer ? member_color(r.reviewer.id) : C.full}">${esc(rn[0] || "?")}</span>${esc(rn)}${r.mine ? "（あなた）" : ""}</span>
        ${requesterHtml(r)}
        <span class="rq-wait ${warn ? "warn" : "ok"}"><span class="wdot"></span>${waitLabel(r.wait)}${warn ? " 要対応" : ""}</span>
      </div>
    </div>
    <div class="rq-acts">${open}<button class="rq-btn rq-hist" data-id="${r.id}" title="コメント履歴">${icon("message", { size: 14 })} 履歴</button><button class="rq-btn rq-reject" data-id="${r.id}" data-title="${esc(r.title)}">差し戻し</button><button class="rq-btn appr rq-appr" data-id="${r.id}" data-title="${esc(r.title)}">承認</button></div>
  </div>
  <div class="rq-inline" data-for="${r.id}" hidden></div>
  <div class="rq-histbox" data-for="${r.id}" hidden></div>`;
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
  .rq-kpi.rq-jump{cursor:pointer;transition:box-shadow .12s,transform .12s}
  .rq-kpi.rq-jump:hover{box-shadow:0 4px 12px rgba(20,30,50,.1);transform:translateY(-1px)}
  .rq-kpi.rq-jump:focus-visible{outline:2px solid ${C.fill};outline-offset:2px}
  /* スクロール先のフラッシュハイライト */
  .rq-flash{animation:rq-flash 1s ease-out}
  @keyframes rq-flash{0%{box-shadow:0 0 0 3px rgba(58,134,255,.45)}100%{box-shadow:0 0 0 3px rgba(58,134,255,0)}}
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
  .rq-titlecell[data-id]{cursor:pointer}
  .rq-titlecell[data-id]:hover .t{text-decoration:underline;text-decoration-color:${C.line}}
  .rq-titlecell .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rq-titlecell .meta{font-size:11px;color:${C.muted};margin-top:3px;display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center}
  .rq-titlecell .src{color:${C.ink}}
  .rq-who{display:inline-flex;align-items:center;gap:5px}
  .rq-who .ava{width:18px;height:18px;border-radius:50%;flex:none;display:grid;place-items:center;color:#fff;font-size:10px;font-weight:700}
  .rq-req{display:inline-flex;align-items:center;gap:4px;color:${C.muted}}
  .rq-req.mine{font-weight:700;color:${C.fill};background:#eaf2ff;border:1px solid #d5e6ff;border-radius:6px;padding:1px 7px}
  html[data-theme="dark"] .rq-req.mine{background:rgba(58,134,255,.16);border-color:rgba(58,134,255,.35)}
  .rq-wait{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums;font-weight:600}
  .rq-wait .wdot{width:7px;height:7px;border-radius:50%;background:${C.free}}
  .rq-wait.warn{color:${C.over}}.rq-wait.warn .wdot{background:${C.over}}
  .rq-acts{flex:none;display:flex;gap:7px;justify-content:flex-end}
  .rq-btn{border:1px solid ${C.line};background:#fff;color:${C.ink};border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
  .rq-btn:hover{background:#f3f5f8}
  .rq-btn.appr{background:${C.free};border-color:${C.free};color:#fff}
  .rq-btn.appr:hover{filter:brightness(.95)}
  .rq-empty{padding:30px;text-align:center;color:${C.muted};background:${C.card};border:1px solid ${C.line};border-radius:14px}

  /* インラインのコメント入力（承認/差し戻し） */
  .rq-inline{padding:10px 16px 13px;border-bottom:1px solid ${C.line};background:#fafbfd}
  .rq-inline-head{font-size:11.5px;font-weight:700;color:${C.muted};margin-bottom:6px}
  .rq-inline-ta{width:100%;box-sizing:border-box;resize:vertical;border:1px solid ${C.line};border-radius:8px;
    padding:7px 9px;font:inherit;font-size:12.5px;background:${C.card};color:${C.ink}}
  .rq-inline-ta:focus{outline:none;border-color:${C.fill}}
  .rq-inline-err{color:${C.over};font-size:11.5px;font-weight:600;margin-top:5px}
  .rq-inline-acts{display:flex;gap:7px;justify-content:flex-end;margin-top:8px}

  /* 💬 コメント履歴 */
  .rq-histbox{padding:8px 16px 12px;border-bottom:1px solid ${C.line};background:#fafbfd;display:flex;flex-direction:column;gap:7px}
  .rq-hist-empty{font-size:12px;color:${C.muted}}
  .rq-hist-item{border-left:2px solid ${C.line};padding:2px 0 2px 9px}
  .rq-hist-meta{font-size:11px;color:${C.muted}}
  .rq-hist-meta b{color:${C.ink}}
  .rq-hist-body{font-size:12.5px;color:${C.ink};white-space:pre-wrap;margin-top:1px}

  @media(max-width:760px){.rq-qhead{display:none}.rq-row{grid-template-columns:1fr;gap:6px}}

  /* ダークモード: あなた宛の淡色ハイライトは暗い青tintへ / ボタン面=card / レビューバッジtintも暗系。アクセント色は維持 */
  html[data-theme="dark"] .rq-kpi.you{background:rgba(58,134,255,.12);border-color:rgba(58,134,255,.4)}
  html[data-theme="dark"] .rq-row.you{background:rgba(58,134,255,.08)}
  html[data-theme="dark"] .rq-kind{background:rgba(58,134,255,.16);border-color:rgba(58,134,255,.35)}
  html[data-theme="dark"] .rq-btn{background:var(--card);color:var(--ink)}
  html[data-theme="dark"] .rq-btn:hover{background:var(--track)}
  html[data-theme="dark"] .rq-inline,html[data-theme="dark"] .rq-histbox{background:var(--track)}`;
}
