// レビュー ／ 承認キュー（mock 66 相当・実データ）。レビューラベル付き未完了タスクを「あなた宛/その他」で一覧。
import { load, projectName, invalidate } from "../lib/store.js";
import { updateTask, createComment, getComments } from "../lib/api.js";
import { isReviewTask } from "../lib/kinds.js";
import { C, esc, member_color, avatar, todayISO, announce } from "../lib/ui.js";
import { openTaskForm } from "./taskform.js";
import { icon } from "../lib/icons.js";

const WARN_MS = 4 * 3600000; // 半日(4h)以上で要注意

const PREFETCH_MAX = 14; // B7: 件数チップ先読みの上限（表示分の上位のみ）

// B6: レビュアー絞り込み（self=自分宛 / all=全員）と検索語を個人保存（再読込でも維持）。
const SCOPE_KEY = "ts.review.scope";
const scopeMode = () => { try { const v = localStorage.getItem(SCOPE_KEY); return v === "self" ? "self" : "all"; } catch { return "all"; } };

function waitLabel(ms) {
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + "分";
  if (h < 24) return Math.round(h) + "時間";
  return Math.round(h / 24) + "日";
}

// B5: 期限を必ず拾う。Vikunja の空日付（0001-）は無しとして扱い、ISO 日付(YYYY-MM-DD)を返す。
const dueISO = (t) => (t.due_date && !t.due_date.startsWith("0001") ? t.due_date.slice(0, 10) : "");
// 締切までの残日数（負=超過）。期限なしは null。
function dueDays(due, todayIso) {
  if (!due) return null;
  const a = Date.parse(due + "T00:00:00Z");
  const b = Date.parse(todayIso + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}
// 締切チップの文言（超過 / 今日 / 残N日）。期限なしは空文字。
function dueLabel(days) {
  if (days == null) return "";
  if (days < 0) return `期限超過 ${-days}日`;
  if (days === 0) return "今日締切";
  if (days === 1) return "明日締切";
  return `あと${days}日`;
}

// B6: 検索語は再描画をまたいでメモリ保持（インクリメンタル検索の入力中に full re-render しないが、
// 承認/差戻し後の render では維持したい）。localStorage まで永続させると残りがちなので session 内メモリのみ。
let _query = "";
// B7: コメント一覧のキャッシュ（task id → 配列）。件数チップの先読み・履歴の即時表示・差戻し引用に使い回す。
// 状態が変わった行（承認/差戻し後）は delete してリフレッシュさせる。
const _commentCache = new Map();

export async function render(root) {
  const data = await load();
  // 自分判定は load() が取得済みの me を使う（この画面で whoami() を別途叩かない）。
  const me = data.me || null;
  const meId = me && me.id;
  const meName = me ? (me.name || me.username) : "あなた";
  const now = Date.now();
  const today = todayISO();

  const allRows = data.tasks
    .filter((t) => isReviewTask(t) && !t.done)
    .map((t) => {
      const created = Date.parse(t.created) || now;
      const rel = t.related_tasks && (t.related_tasks.related || [])[0];
      const cb = t.created_by || null;
      const due = dueISO(t);
      const dd = dueDays(due, today);
      return {
        id: t.id, title: t.title, proj: projectName(data.projects, t.project_id),
        srcId: rel && rel.id, srcTitle: rel && rel.title,
        reviewer: (t.assignees || [])[0],
        mine: (t.assignees || []).some((a) => a.id === meId),
        createdBy: cb,
        mineRequest: !!(cb && cb.id === meId),
        wait: Math.max(0, now - created),
        due, dueD: dd, overdue: dd != null && dd < 0,
        commentCount: Array.isArray(t.comments) ? t.comments.length : null,
      };
    })
    // B5: 期限基準の複合キー。①期限あり優先 → ②残日数が小さい（=超過/今日締切）ほど上
    //     → ③待ち時間が長い順（同期限内の従来挙動を保持）→ ④id 安定化。
    .sort((a, b) => {
      const ha = a.dueD != null, hb = b.dueD != null;
      if (ha !== hb) return ha ? -1 : 1;          // 期限ありを上に
      if (ha && a.dueD !== b.dueD) return a.dueD - b.dueD; // 締切が近い/超過を上に
      if (b.wait !== a.wait) return b.wait - a.wait;       // 待ちが長い順
      return a.id - b.id;
    });

  // B6: レビュアー絞り込み（self/all）＋ インクリメンタル検索（タイトル/依頼者）。
  const scope = scopeMode();
  const q = _query.trim().toLowerCase();
  const matchQ = (r) => {
    if (!q) return true;
    const reqName = r.createdBy ? (r.createdBy.name || r.createdBy.username || "") : "";
    return (r.title || "").toLowerCase().includes(q) || reqName.toLowerCase().includes(q);
  };
  const rows = allRows.filter((r) => (scope === "self" ? r.mine : true)).filter(matchQ);

  const mine = rows.filter((r) => r.mine);
  const others = rows.filter((r) => !r.mine);
  // KPI は scope/検索に影響されない全体値（self 表示中でもキュー全体の状況が見えるように）。
  const allMine = allRows.filter((r) => r.mine);
  const maxWait = allRows.reduce((m, r) => Math.max(m, r.wait), 0);
  const warnRows = allRows.filter((r) => r.wait >= WARN_MS);
  const warnN = warnRows.length;
  const overRows = allRows.filter((r) => r.overdue);
  const overN = overRows.length;
  // KPI からスクロールするためのアンカー（表示中の行に対してのみ付与）。
  // rows は期限基準ソートなので「最長待ち」「要注意」は wait で別途特定する。
  const anchors = {};
  const longestShown = rows.reduce((m, r) => (!m || r.wait > m.wait ? r : m), null);
  if (longestShown) anchors[longestShown.id] = "rq-longest";
  const firstWarnShown = rows.filter((r) => r.wait >= WARN_MS).reduce((m, r) => (!m || r.wait > m.wait ? r : m), null);
  if (firstWarnShown) anchors[firstWarnShown.id] = "rq-firstwarn";
  const firstOverShown = rows.find((r) => r.overdue);
  if (firstOverShown) anchors[firstOverShown.id] = "rq-firstover";

  const scopeBtn = (val, label) =>
    `<button class="rq-scope-b${scope === val ? " on" : ""}" data-scope="${val}" type="button">${esc(label)}</button>`;

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">レビュー ／ 承認キュー <small>期限が近い／超過を上に</small></h1>
    <div class="rq-stats">
      ${kpi(`${esc(meName)}宛・対応待ち`, `${allMine.length}<small>件</small>`, "you", allMine.length ? "sec-mine" : "")}
      ${kpi("キュー全体", `${allRows.length}<small>件</small>`, "", allRows.length ? (allMine.length ? "sec-mine" : "sec-others") : "")}
      ${kpi("期限超過", `${overN}<small>件</small>`, overN ? "warn" : "", overN ? "rq-firstover" : "")}
      ${kpi("最長待ち", allRows.length ? waitLabel(maxWait) : "—", "", allRows.length ? "rq-longest" : "")}
      ${kpi("要注意（4h以上）", `${warnN}<small>件</small>`, warnN ? "warn" : "", warnN ? "rq-firstwarn" : "")}
    </div>
    <div class="rq-tools">
      <div class="rq-scope" id="rq-scope">${scopeBtn("self", `${esc(meName)} 宛`)}${scopeBtn("all", "全員")}</div>
      <label class="rq-search">${icon("search", { size: 14 })}
        <input id="rq-q" type="search" placeholder="タイトル・依頼者で検索…" value="${esc(_query)}" autocomplete="off">
      </label>
      <span class="rq-tools-cnt">${rows.length} / ${allRows.length} 件</span>
    </div>
    ${allRows.length ? "" : `<div class="rq-empty">レビュー待ちはありません。円時計の⋯「レビュー依頼」から作成できます。</div>`}
    ${allRows.length && !rows.length ? `<div class="rq-empty">条件に合うレビューはありません。${q ? "検索語" : "絞り込み"}を見直してください。</div>` : ""}
    ${mine.length ? section(`${esc(meName)} 宛のレビュー待ち`, mine, true, "sec-mine", anchors) : ""}
    ${others.length ? section("その他のレビュー／承認待ち", others, false, "sec-others", anchors) : ""}`;

  const onSaved = async () => { invalidate(); render(root); };

  // B6: レビュアー絞り込みセグメント（self/all）。選択は localStorage 永続。
  root.querySelectorAll("#rq-scope [data-scope]").forEach((b) => {
    b.onclick = () => { try { localStorage.setItem(SCOPE_KEY, b.dataset.scope); } catch {} render(root); };
  });

  // B6: インクリメンタル検索。入力ごとに行を絞る。full re-render するとフォーカス／キャレットが
  // 飛ぶので、ここでは DOM の行を直接 show/hide し、件数だけ更新する（軽量・体感ラグなし）。
  const qInput = root.querySelector("#rq-q");
  if (qInput) {
    qInput.oninput = () => {
      _query = qInput.value;
      applySearch(root, allRows.length);
    };
    // 再描画後もカーソルを末尾に保ってインクリメンタル感を維持
    if (_query) { qInput.focus(); const n = qInput.value.length; try { qInput.setSelectionRange(n, n); } catch {} }
  }

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
    // B7: 差し戻し時は前回コメント（最新の1件）を引用として頭に提示。キャッシュにあれば即時、
    //     無ければ非同期取得後に未編集なら差し込む（ユーザー入力は上書きしない）。
    const quoteOf = (list) => {
      const items = (list || []).slice().sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));
      const last = items[items.length - 1];
      if (!last || !last.comment) return "";
      const au = last.author && (last.author.name || last.author.username) || "前回";
      const oneLine = String(last.comment).replace(/\s+/g, " ").trim().slice(0, 120);
      return `> ${au}：${oneLine}\n\n`;
    };
    const seed = reject ? quoteOf(_commentCache.get(id)) : "";
    box.hidden = false;
    box.innerHTML = `
      <div class="rq-inline-head">${reject ? "差し戻し（理由は必須）" : "承認（コメントは任意）"}</div>
      <textarea class="rq-inline-ta" rows="${reject ? 3 : 2}" placeholder="${reject ? "修正してほしい点を記入…" : "コメント（任意）…"}"></textarea>
      <div class="rq-inline-err" hidden></div>
      <div class="rq-inline-acts">
        <button class="rq-btn rq-inline-cancel" type="button">キャンセル</button>
        <button class="rq-btn ${reject ? "" : "appr"} rq-inline-ok" type="button">確定</button>
      </div>`;
    const ta = box.querySelector(".rq-inline-ta");
    const err = box.querySelector(".rq-inline-err");
    const ok = box.querySelector(".rq-inline-ok");
    ta.value = seed;
    ta.focus();
    // キャレットは引用文の後（記入位置）へ
    try { const n = ta.value.length; ta.setSelectionRange(n, n); } catch {}
    // B7: キャッシュ未取得なら差し戻しの引用を遅延補完（ユーザーが書き始めていなければ）。
    if (reject && !_commentCache.has(id)) {
      getComments(id).then((list) => {
        _commentCache.set(id, list || []);
        updateHistChip(root, id, (list || []).length);
        if (!ta.isConnected) return;
        const q = quoteOf(list);
        if (q && !ta.value.trim()) { ta.value = q; try { const n = ta.value.length; ta.setSelectionRange(n, n); } catch {} }
      }).catch(() => {});
    }
    box.querySelector(".rq-inline-cancel").onclick = () => { box.hidden = true; box.innerHTML = ""; };
    ok.onclick = async () => {
      const text = ta.value.trim();
      if (reject && !text) {
        err.hidden = false; err.textContent = "差し戻しには理由の記入が必要です。"; ta.focus();
        return;
      }
      // B8: 楽観更新。確定直後に行を fade で除去 → API。失敗時は行を復元しエラー表示＋announce。
      box.hidden = true; box.innerHTML = "";
      const removed = fadeRemoveRow(root, id);
      announce(reject ? `「${title}」を差し戻しました` : `「${title}」を承認しました`);
      try {
        if (reject) {
          await createComment(id, `↩️ 要修正（${meName}）：${text}`);
        } else {
          await createComment(id, `✅ ${meName} が承認しました${text ? "：" + text : ""}`);
          await updateTask(id, { done: true });
        }
      } catch {
        // 復元: 楽観的に消した行を戻し、入力内容も復元してやり直せるようにする。
        if (removed) removed();
        announce("送信に失敗しました。もう一度お試しください。", { assertive: true });
        showUndoToast("送信に失敗しました。もう一度お試しください。", null, { error: true });
        const box2 = root.querySelector(`.rq-inline[data-for="${id}"]`);
        if (box2) { openInline(id, mode, title); const ta2 = box2.querySelector(".rq-inline-ta"); if (ta2) { ta2.value = text; ta2.focus(); } }
        return;
      }
      _commentCache.delete(id); // 状態が変わったのでコメント数キャッシュは破棄
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
      // B7: キャッシュ済みなら即描画（履歴を開く前に件数チップ先読みで取得済みのことが多い）。
      if (_commentCache.has(id)) { box.innerHTML = histHtml(_commentCache.get(id)); return; }
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
      _commentCache.set(id, list || []);
      updateHistChip(root, id, (list || []).length);
      // 描画前チェック: await の間に閉じられた／別リードが走った場合はスキップ
      if (box.hidden) return;
      box.innerHTML = histHtml(list);
    };
  });

  // B7: 表示中の行のコメント件数を先読みして 💬チップに反映（順次・上から最大 PREFETCH_MAX 件まで＝
  //     API を叩き過ぎない。スクロールしないと見えない下の方は履歴トグル時に遅延取得される）。
  prefetchCounts(root, rows.slice(0, PREFETCH_MAX).map((r) => r.id));
}

// コメント配列 → 履歴 HTML（昇順）。履歴トグルと B7 キャッシュ描画で共有。
function histHtml(list) {
  const items = (list || []).slice().sort((a, b) =>
    String(a.created || "").localeCompare(String(b.created || "")));
  if (!items.length) return `<div class="rq-hist-empty">コメントはまだありません。</div>`;
  return items.map((c) => {
    const au = c.author && (c.author.name || c.author.username) || "不明";
    const dt = c.created ? new Date(c.created).toLocaleString("ja-JP") : "";
    return `<div class="rq-hist-item"><div class="rq-hist-meta"><b>${esc(au)}</b> <span>${esc(dt)}</span></div><div class="rq-hist-body">${esc(c.comment || "")}</div></div>`;
  }).join("");
}

// B6: 検索の絞り込みを DOM 上で適用（full re-render せずフォーカス維持）。行＋付随する inline/histbox を
//     まとめて show/hide し、空セクションは隠す。件数表示も更新する。
function applySearch(root, total) {
  const q = _query.trim().toLowerCase();
  let shown = 0;
  root.querySelectorAll(".rq-section").forEach((sec) => {
    let secShown = 0;
    sec.querySelectorAll(".rq-row").forEach((row) => {
      const title = (row.dataset.title || "").toLowerCase();
      const req = (row.dataset.req || "").toLowerCase();
      const hit = !q || title.includes(q) || req.includes(q);
      row.hidden = !hit;
      // 行に紐づく inline/histbox（次の兄弟2つ）は、ヒットしない行のものだけ隠す。
      // ヒット時は触らない（開いている履歴／入力中の状態を壊さない）。
      if (!hit) {
        let n = row.nextElementSibling;
        for (let i = 0; i < 2 && n; i++) {
          if (n.classList.contains("rq-inline") || n.classList.contains("rq-histbox")) n.hidden = true;
          n = n.nextElementSibling;
        }
      }
      if (hit) { secShown++; shown++; }
    });
    sec.hidden = secShown === 0;
    const cnt = sec.querySelector(".rq-cnt");
    if (cnt) cnt.textContent = `${secShown} 件`;
  });
  const toolsCnt = root.querySelector(".rq-tools-cnt");
  if (toolsCnt) toolsCnt.textContent = `${shown} / ${total} 件`;
  let none = root.querySelector(".rq-search-none");
  if (shown === 0 && total > 0) {
    if (!none) {
      none = document.createElement("div");
      none.className = "rq-empty rq-search-none";
      none.textContent = "条件に合うレビューはありません。検索語を見直してください。";
      const tools = root.querySelector(".rq-tools");
      if (tools && tools.parentNode) tools.parentNode.insertBefore(none, tools.nextSibling);
    }
    none.hidden = false;
  } else if (none) {
    none.hidden = true;
  }
}

// B8: 楽観更新で行を fade 除去。復元用クロージャ（失敗時に戻す）を返す。
function fadeRemoveRow(root, id) {
  const row = root.querySelector(`.rq-row[data-id="${id}"]`);
  if (!row) return null;
  const sibs = [];
  let n = row.nextElementSibling;
  for (let i = 0; i < 2 && n; i++) {
    if (n.classList.contains("rq-inline") || n.classList.contains("rq-histbox")) sibs.push(n);
    n = n.nextElementSibling;
  }
  const prevDisplay = sibs.map((s) => s.style.display);
  row.classList.add("rq-removing");
  sibs.forEach((s) => { s.style.display = "none"; });
  const hideTimer = setTimeout(() => { row.style.display = "none"; }, 280);
  return () => {
    clearTimeout(hideTimer);
    row.classList.remove("rq-removing");
    row.style.display = "";
    sibs.forEach((s, i) => { s.style.display = prevDisplay[i] || ""; });
  };
}

// B7: 💬履歴チップの件数を更新（先読み／取得後に呼ぶ）。0 件は数字を出さず吹き出しのみ。
function updateHistChip(root, id, count) {
  const b = root.querySelector(`.rq-hist[data-id="${id}"]`);
  if (!b) return;
  const chip = b.querySelector(".rq-histcnt");
  if (!chip) return;
  if (count > 0) { chip.textContent = String(count); chip.hidden = false; }
  else { chip.textContent = ""; chip.hidden = true; }
}

// B7: 表示行のコメント件数を順次先読み（同時多発を避け軽く直列化）。キャッシュ済みは飛ばす。
let _prefetchToken = 0;
async function prefetchCounts(root, ids) {
  const token = ++_prefetchToken; // 再描画で古い prefetch を打ち切る
  for (const id of ids) {
    if (token !== _prefetchToken) return;
    if (_commentCache.has(id)) { updateHistChip(root, id, _commentCache.get(id).length); continue; }
    let list = null;
    try { list = await getComments(id); } catch { continue; }
    if (token !== _prefetchToken) return;
    _commentCache.set(id, list || []);
    updateHistChip(root, id, (list || []).length);
  }
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

// B5: 締切チップ。期限超過は C.over（赤）・今日/明日は amber 寄り・それ以外は淡色。期限なしは「期限なし」。
function dueChip(r) {
  if (r.dueD == null) return `<span class="rq-due none" title="締切なし">${icon("calendar", { size: 12 })}期限なし</span>`;
  const cls = r.overdue ? "over" : (r.dueD <= 1 ? "soon" : "ok");
  const ic = r.overdue ? "alarm" : "calendar";
  return `<span class="rq-due ${cls}" title="締切: ${esc(r.due)}">${icon(ic, { size: 12 })}${esc(dueLabel(r.dueD))}</span>`;
}

// B7: 💬履歴チップ（件数）。先読み前は数字非表示で hidden、prefetch/取得で埋める。null=未取得。
function histChipCount(r) {
  const known = typeof r.commentCount === "number";
  const has = known && r.commentCount > 0;
  return `<span class="rq-histcnt"${has ? "" : " hidden"}>${has ? r.commentCount : ""}</span>`;
}

function rowHtml(r, anchors = {}) {
  const rn = r.reviewer ? (r.reviewer.name || r.reviewer.username) : "未割当";
  const warn = r.wait >= WARN_MS;
  const open = r.srcId ? `<button class="rq-btn rq-open" data-src="${r.srcId}" title="元タスクを開く">↗</button>` : "";
  const anchorId = anchors[r.id] ? ` id="${anchors[r.id]}"` : "";
  const reqName = r.createdBy ? (r.createdBy.name || r.createdBy.username || "") : "";
  return `<div class="rq-row ${r.mine ? "you" : ""}${r.overdue ? " over" : ""}"${anchorId} data-id="${r.id}" data-title="${esc(r.title)}" data-req="${esc(reqName)}">
    <span class="rq-kind">レビュー</span>
    <div class="rq-titlecell" data-id="${r.id}" title="このレビュータスクを編集">
      <div class="t">${esc(r.title)}</div>
      <div class="meta">
        ${dueChip(r)}
        ${r.srcTitle ? `<span class="src">元: ${esc(r.srcTitle)}</span>` : ""}<span class="proj">${esc(r.proj)}</span>
        <span class="rq-who"><span class="ava" style="background:${r.reviewer ? member_color(r.reviewer.id) : C.full}">${esc(rn[0] || "?")}</span>${esc(rn)}${r.mine ? "（あなた）" : ""}</span>
        ${requesterHtml(r)}
        <span class="rq-wait ${warn ? "warn" : "ok"}"><span class="wdot"></span>${waitLabel(r.wait)}${warn ? " 要対応" : ""}</span>
      </div>
    </div>
    <div class="rq-acts">${open}<button class="rq-btn rq-hist" data-id="${r.id}" title="コメント履歴">${icon("message", { size: 14 })} 履歴${histChipCount(r)}</button><button class="rq-btn rq-reject" data-id="${r.id}" data-title="${esc(r.title)}">差し戻し</button><button class="rq-btn appr rq-appr" data-id="${r.id}" data-title="${esc(r.title)}">承認</button></div>
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

  /* B6: レビュアー絞り込みセグメント＋検索 */
  .rq-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 16px}
  .rq-scope{display:inline-flex;border:1px solid ${C.line};border-radius:9px;overflow:hidden;background:${C.card}}
  .rq-scope-b{border:0;background:transparent;color:${C.ink};font:inherit;font-size:12.5px;font-weight:600;padding:7px 14px;cursor:pointer}
  .rq-scope-b+.rq-scope-b{border-left:1px solid ${C.line}}
  .rq-scope-b.on{background:${C.fill};color:#fff}
  .rq-scope-b:not(.on):hover{background:#f3f5f8}
  .rq-search{display:inline-flex;align-items:center;gap:6px;border:1px solid ${C.line};border-radius:9px;padding:0 10px;background:${C.card};color:${C.muted}}
  .rq-search:focus-within{border-color:${C.fill}}
  .rq-search input{border:0;outline:none;background:transparent;color:${C.ink};font:inherit;font-size:12.5px;padding:7px 2px;min-width:180px}
  .rq-tools-cnt{font-size:12px;color:${C.muted};margin-left:auto}

  /* B5: 締切チップ（超過=赤 / 近接=橙 / 余裕=淡色 / なし=ミュート） */
  .rq-due{display:inline-flex;align-items:center;gap:4px;font-weight:700;font-size:11px;border-radius:6px;padding:1px 7px;font-variant-numeric:tabular-nums}
  .rq-due svg{flex:none}
  .rq-due.over{color:#fff;background:${C.over}}
  .rq-due.soon{color:${C.over};background:#fdecec;border:1px solid #f7cccc}
  .rq-due.ok{color:${C.ink};background:${C.track};border:1px solid ${C.line}}
  .rq-due.none{color:${C.muted};background:transparent;border:1px dashed ${C.line};font-weight:600}
  html[data-theme="dark"] .rq-due.soon{background:rgba(229,72,77,.16);border-color:rgba(229,72,77,.4)}

  .rq-section{margin-bottom:22px}
  .rq-sechdr{display:flex;align-items:center;gap:10px;margin:0 0 9px}
  .rq-sechdr h2{font-size:14.5px;margin:0;font-weight:700}
  .rq-pill{font-size:10.5px;font-weight:700;color:#fff;background:${C.fill};border-radius:20px;padding:2px 9px}
  .rq-cnt{font-size:12px;color:${C.muted};margin-left:auto}
  .rq-queue{background:${C.card};border:1px solid ${C.line};border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(20,30,50,.04)}
  .rq-row{display:flex;align-items:center;gap:11px;padding:11px 16px;border-bottom:1px solid ${C.line};font-size:13px}
  .rq-row:last-child{border-bottom:0}
  .rq-row.you{background:#f7fbff}
  /* B5: 期限超過の行は左に赤アクセント（一目で分かるように） */
  .rq-row.over{box-shadow:inset 3px 0 0 ${C.over}}
  /* B8: 楽観更新の fade 除去アニメ（確定直後に行を消す→API） */
  .rq-row.rq-removing{opacity:0;transform:translateX(14px);max-height:0;padding-top:0;padding-bottom:0;margin:0;overflow:hidden;
    transition:opacity .25s ease,transform .25s ease,max-height .25s ease,padding .25s ease;pointer-events:none}
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
  /* B7: 💬履歴ボタンのコメント件数チップ */
  .rq-hist{gap:5px}
  .rq-histcnt{display:inline-grid;place-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;
    background:${C.fill};color:#fff;font-size:10px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
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
