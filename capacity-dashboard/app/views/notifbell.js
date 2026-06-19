// レビュー依頼者向けのアプリ内ベル通知（サーバープッシュ無し＝90秒ポーリング・localStorage既読管理）。
// 自分が依頼したレビュー（isReviewTask かつ created_by===me）の「承認」「新着コメント」を拾い、
// 未読バッジ＋ドロップダウンで通知する。項目クリックで元タスク（or レビュータスク）を編集モーダルで開く。
// 既読は { [taskId]: { done, cCount } } のスナップショットで管理。done が新たに true / コメント数増 を未読とする。
import { load } from "../lib/store.js";
import { getComments } from "../lib/api.js";
import { isReviewTask } from "../lib/kinds.js";
import { esc } from "../lib/ui.js";

const SEEN_KEY = (uid) => `ts.reviewbell.${uid}`;
const POLL_MS = 90000;

const readSeen = (uid) => {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY(uid)) || "{}") || {}; }
  catch { return {}; }
};
const writeSeen = (uid, snap) => {
  try { localStorage.setItem(SEEN_KEY(uid), JSON.stringify(snap)); } catch { /* noop */ }
};

const reviewerName = (t) => {
  const r = (t.assignees || [])[0];
  return r ? (r.name || r.username) : "レビュアー";
};
// 元タスク名（related_tasks.related[0]）優先・無ければレビュータスクのタイトル。
const subjectTitle = (t) => {
  const rel = t.related_tasks && (t.related_tasks.related || [])[0];
  return (rel && rel.title) || t.title;
};
const clip = (s, n = 60) => { const x = (s == null ? "" : String(s)).trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
const fmtTime = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; };

// 自分が依頼したレビュー群から通知リストと未読件数を計算する。
// 戻り値: { items:[{taskId, openId, kind, title, what, when, unread}], unread:number, snapshot:{[id]:{done,cCount}} }
async function computeNotifications() {
  const data = await load();
  const me = data.me; // load() が whoami をまとめて取得済み（重複 whoami 呼び出しを避ける）
  if (!me || me.id == null) return { items: [], unread: 0, snapshot: null, uid: null };
  const mine = (data.tasks || []).filter((t) => isReviewTask(t) && t.created_by && t.created_by.id === me.id);
  const seen = readSeen(me.id);
  const snapshot = {};
  const items = [];

  for (const t of mine) {
    const rel = t.related_tasks && (t.related_tasks.related || [])[0];
    const openId = (rel && rel.id) || t.id; // 元タスクがあればそれを、無ければレビュータスクを開く
    const title = subjectTitle(t);
    const prev = seen[t.id] || { done: false, cCount: 0 };

    // コメント取得（自分の依頼ぶんだけ＝通常少数）。失敗してもベルは壊さない。
    let comments = [];
    try { comments = await getComments(t.id); } catch { comments = []; }
    if (!Array.isArray(comments)) comments = [];
    const cCount = comments.length;

    snapshot[t.id] = { done: !!t.done, cCount };

    // 承認通知（done が true）。新たに true になったものは未読。
    if (t.done) {
      const unread = !prev.done;
      items.push({
        taskId: t.id, openId, kind: "approve",
        title, what: `承認されました（${reviewerName(t)}）`,
        when: t.updated || t.done_at || t.created, unread,
      });
    }
    // 新着コメント（最新コメントを通知に。コメント数が増えたら未読）。
    if (cCount > 0) {
      const last = comments[comments.length - 1];
      const unread = cCount > (prev.cCount || 0);
      items.push({
        taskId: t.id, openId, kind: "comment",
        title, what: `新着コメント：${clip(last.comment, 50)}`,
        when: last.created, unread,
      });
    }
  }

  items.sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));
  const unread = items.filter((i) => i.unread).length;
  return { items, unread, snapshot, uid: me.id };
}

export async function mountReviewBell(topbar, opts = {}) {
  if (!topbar) return;
  ensureStyle();

  const btn = document.createElement("button");
  btn.className = "nb-btn";
  btn.title = "レビュー通知";
  btn.setAttribute("aria-label", "レビュー通知");
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;pointer-events:none"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="nb-badge" hidden>0</span>`;
  // 🔍検索・↻再読込の近く（refresh の前）に置く＝既存ウィジェットと並ぶ
  const anchor = topbar.querySelector("#refresh");
  anchor ? anchor.before(btn) : topbar.appendChild(btn);
  const badge = btn.querySelector(".nb-badge");

  const panel = document.createElement("div");
  panel.className = "nb-panel";
  panel.hidden = true;
  document.body.appendChild(panel);

  let last = { items: [], unread: 0, snapshot: null, uid: null };

  const setBadge = (n) => {
    if (n > 0) { badge.textContent = n > 99 ? "99+" : String(n); badge.hidden = false; }
    else badge.hidden = true;
    // 未読件数を読み上げに反映（例「レビュー通知 3件」）。0件は件数を付けない。
    btn.setAttribute("aria-label", n > 0 ? `レビュー通知 ${n}件` : "レビュー通知");
  };

  // パネルを開いている間に現れた通知を既読化（スナップショット保存＝バッジクリア）。
  const markSeen = () => {
    if (last.uid != null && last.snapshot) {
      writeSeen(last.uid, last.snapshot);
      last.items = last.items.map((i) => ({ ...i, unread: false }));
      last.unread = 0;
      setBadge(0);
      if (!panel.hidden) renderPanel();
    }
  };

  const renderPanel = () => {
    if (!last.items.length) {
      panel.innerHTML = `<div class="nb-head">レビュー通知</div><div class="nb-empty">新しい通知はありません</div>`;
      return;
    }
    const icon = (k) => (k === "approve" ? "✅" : "💬");
    panel.innerHTML = `<div class="nb-head">レビュー通知</div>` + last.items.map((i, idx) => `
      <button class="nb-item${i.unread ? " unread" : ""}" data-i="${idx}">
        <span class="nb-ic">${icon(i.kind)}</span>
        <span class="nb-body">
          <span class="nb-title">${esc(i.title)}</span>
          <span class="nb-what">${esc(i.what)}</span>
          ${i.when ? `<span class="nb-when">${esc(fmtTime(i.when))}</span>` : ""}
        </span>
      </button>`).join("");
    panel.querySelectorAll(".nb-item").forEach((el) => {
      el.onclick = async () => {
        const it = last.items[+el.dataset.i];
        closePanel();
        if (it) {
          try { const { openTaskForm } = await import("./taskform.js"); openTaskForm({ taskId: it.openId }); }
          catch { /* noop */ }
        }
      };
    });
  };

  const positionPanel = () => {
    const r = btn.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 16);
    let left = r.right - w; // ベル右端に右揃え
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    panel.style.width = w + "px";
    panel.style.left = left + "px";
    panel.style.top = (r.bottom + 8) + "px";
  };

  const openPanel = () => {
    renderPanel();
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    positionPanel();
    markSeen(); // 開いた時点で表示中の通知を既読化
  };
  const closePanel = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const toggle = () => { panel.hidden ? openPanel() : closePanel(); };

  btn.onclick = (e) => { e.stopPropagation(); toggle(); };
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closePanel();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
  window.addEventListener("resize", () => { if (!panel.hidden) positionPanel(); });

  // 再計算（例外は握りつぶす＝ベルを壊さない）。
  const refresh = async (force) => {
    try {
      if (force) { try { await load(true); } catch { /* noop */ } }
      const res = await computeNotifications();
      last = res;
      setBadge(res.unread);
      if (!panel.hidden) renderPanel();
    } catch { /* noop */ }
  };

  // 初回計算 → 90秒ごとにポーリング（多重 setInterval は作らない）。
  await refresh(false);
  if (!window.__tsReviewBellTimer) {
    window.__tsReviewBellTimer = setInterval(() => refresh(true), POLL_MS);
  }
  // 画面遷移時に軽く再計算（force しない＝キャッシュ利用）。
  window.addEventListener("hashchange", () => { refresh(false); });

  return btn;
}

let _style = false;
function ensureStyle() {
  if (_style) return; _style = true;
  const s = document.createElement("style");
  s.textContent = `
  .nb-btn{position:relative;display:inline-flex;align-items:center;justify-content:center}
  .nb-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;box-sizing:border-box;padding:0 4px;
    border-radius:9px;background:var(--over,#e5484d);color:#fff;font-size:10px;line-height:16px;font-weight:700;
    text-align:center;font-variant-numeric:tabular-nums}
  .nb-badge[hidden]{display:none}
  .nb-panel{position:fixed;z-index:55;max-height:70vh;overflow-y:auto;background:var(--card,#fff);
    border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 50px rgba(10,18,35,.25);padding:6px}
  .nb-panel[hidden]{display:none}
  .nb-head{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.03em;padding:8px 10px 6px}
  .nb-empty{font-size:12.5px;color:var(--muted);padding:14px 12px 18px;text-align:center}
  .nb-item{display:flex;gap:9px;align-items:flex-start;width:100%;box-sizing:border-box;text-align:left;
    border:0;background:transparent;border-radius:9px;padding:9px 10px;cursor:pointer;font:inherit;color:var(--ink)}
  .nb-item:hover{background:var(--track,#eef4ff)}
  .nb-item.unread{background:color-mix(in srgb,var(--fill,#3a86ff) 9%,transparent)}
  .nb-item.unread:hover{background:color-mix(in srgb,var(--fill,#3a86ff) 16%,transparent)}
  .nb-ic{flex:none;font-size:14px;line-height:1.4}
  .nb-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
  .nb-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nb-item.unread .nb-title::after{content:"●";color:var(--fill,#3a86ff);font-size:9px;margin-left:6px;vertical-align:middle}
  .nb-what{font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nb-when{font-size:10.5px;color:var(--muted);opacity:.85}`;
  document.head.appendChild(s);
}
