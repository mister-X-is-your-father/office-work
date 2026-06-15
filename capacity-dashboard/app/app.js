// SPA シェル: ログイン / サイドナビ / ハッシュルータ
import * as vik from "./lib/api.js";
import * as store from "./lib/store.js";

const ROUTES = {
  home:     { label: "ホーム",        grp: "総合",   mod: "./views/home.js" },
  smart:    { label: "スマートリスト", grp: "総合",   mod: "./views/smartlist.js" },
  today:    { label: "稼働予定",      grp: "今日",   mod: "./views/today.js" },
  triage:   { label: "トリアージ",    grp: "今日",   mod: "./views/triage.js" },
  quad:     { label: "優先度マトリクス", grp: "今日",   mod: "./views/quad.js" },
  habits:   { label: "習慣",          grp: "今日",   mod: "./views/habits.js" },
  review:   { label: "レビュー",      grp: "今日",   mod: "./views/review.js" },
  calendar: { label: "時刻カレンダー",grp: "今日",   mod: "./views/calendar.js" },
  monthcal: { label: "月カレンダー",  grp: "計画",   mod: "./views/monthcal.js" },
  week:     { label: "週プラン",      grp: "計画",   mod: "./views/week.js" },
  planner:  { label: "週プランナー",  grp: "計画",   mod: "./views/planner.js" },
  freefinder:{ label: "月次空き",     grp: "計画",   mod: "./views/freefinder.js" },
  weekstack:{ label: "週日別負荷",    grp: "計画",   mod: "./views/weekstack.js" },
  weekpersonal:{ label: "個人別週プラン", grp: "計画", mod: "./views/weekpersonal.js" },
  summary:  { label: "概要",          grp: "実績",   mod: "./views/summary.js" },
  estactual:{ label: "見積りvs実績",  grp: "実績",   mod: "./views/estactual.js" },
  kanban:   { label: "かんばん",      grp: "仕事",   mod: "./views/kanban.js" },
  list:     { label: "一覧",          grp: "仕事",   mod: "./views/table.js", wide: true },
  outline:  { label: "アウトライン",  grp: "仕事",   mod: "./views/outline.js" },
  depgraph: { label: "依存グラフ",    grp: "仕事",   mod: "./views/depgraph.js" },
  gantt:    { label: "ガントチャート",    grp: "仕事",   mod: "./views/gantt.js" },
  manage:   { label: "予定の基礎データ", grp: "その他", mod: "./views/manage.js" },
  settings: { label: "設定",          grp: "その他", mod: "./views/settings.js" },
  // 隠しルート: ORDER に載せない＝通常ユーザーのナビには出ない。許可者のみ shell() がリンクを追加。
  fable:    { label: "🤖 Fable",      grp: "AI",     mod: "./views/fable.js" },
};
const ORDER = ["home", "smart", "today", "triage", "quad", "habits", "review", "calendar", "monthcal", "week", "planner", "freefinder", "weekstack", "weekpersonal", "summary", "estactual", "kanban", "list", "outline", "depgraph", "gantt", "manage", "settings"];

const app = document.getElementById("app");

function showLogin(msg = "") { showAuth("login", msg); }

function showAuth(mode = "login", msg = "") {
  const isReg = mode === "register";
  const sw = isReg
    ? `すでにアカウントをお持ちですか？ <a href="#" id="toLogin">ログイン</a>`
    : `アカウントがない場合は <a href="#" id="toReg">新規作成</a>`;
  app.innerHTML = `
    <div class="login">
      <h2>TaskStation</h2>
      <input id="u" autocomplete="username" placeholder="ユーザー名" aria-label="ユーザー名">
      ${isReg ? `<input id="em" type="email" autocomplete="email" placeholder="メールアドレス" aria-label="メールアドレス">` : ""}
      <input id="p" type="password" autocomplete="${isReg ? "new-password" : "current-password"}" placeholder="パスワード" aria-label="パスワード">
      <button id="go">${isReg ? "アカウントを作成" : "ログイン"}</button>
      <div class="err" id="err">${msg}</div>
      <div style="margin-top:14px;font-size:13px;color:var(--muted)">${sw}</div>
    </div>`;
  const go = async () => {
    const b = document.getElementById("go"), err = document.getElementById("err");
    const u = document.getElementById("u").value.trim(), p = document.getElementById("p").value;
    b.disabled = true; err.textContent = isReg ? "作成中…" : "ログイン中…";
    try {
      if (isReg) await vik.register(u, document.getElementById("em").value.trim(), p);
      await vik.login(u, p);
      store.invalidate(); boot();
    } catch (e) { b.disabled = false; err.textContent = "× " + e.message; }
  };
  document.getElementById("go").onclick = go;
  document.getElementById("p").onkeydown = e => { if (e.key === "Enter") go(); };
  const tr = document.getElementById("toReg"); if (tr) tr.onclick = e => { e.preventDefault(); showAuth("register"); };
  const tl = document.getElementById("toLogin"); if (tl) tl.onclick = e => { e.preventDefault(); showAuth("login"); };
}

function shell() {
  const grps = {};
  for (const k of ORDER) { const r = ROUTES[k]; (grps[r.grp] ||= []).push(k); }
  const nav = Object.entries(grps).map(([g, keys]) =>
    `<div class="navgrp">${g}</div>` + keys.map(k =>
      `<a href="#/${k}" data-k="${k}" class="${ROUTES[k].soon ? "soon" : ""}">${ROUTES[k].label}${ROUTES[k].soon ? " ·準備中" : ""}</a>`).join("")
  ).join("");
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">TaskStation</div>
        <button class="addbtn" id="addtask">タスク追加</button>
        <nav class="nav" id="nav">${nav}</nav>
      </aside>
      <div class="main">
        <div class="topbar">
          <span class="who" id="who"></span>
          <button id="refresh">↻ 再読込</button>
          <button id="logout">ログアウト</button>
        </div>
        <div class="content" id="content"><div class="loading">…</div></div>
      </div>
    </div>`;
  document.getElementById("refresh").onclick = async () => { store.invalidate(); route(); };
  document.getElementById("addtask").onclick = async () => {
    const { openTaskForm } = await import("./views/taskform.js");
    openTaskForm({ onSaved: route });
  };
  document.getElementById("logout").onclick = () => { vik.clearToken(); showLogin(); };
  vik.whoami().then(u => { document.getElementById("who").textContent = u ? (u.name || u.username) : ""; }).catch(() => {});
  // クイック追加バー（1行自然言語 → 即タスク化。既定の投入先=インボックスWS）
  import("./views/quickadd.js").then(({ mountQuickAdd }) => {
    mountQuickAdd(document.querySelector(".topbar"), { onCreated: route });
  }).catch(() => {});
  // 全文検索（Ctrl+K / 🔍）
  import("./views/searchpal.js").then(({ mountSearch }) => {
    mountSearch(document.querySelector(".topbar"));
  }).catch(() => {});
  // 集中タイマー（🍅・終了/中断を実績に自動記録）
  import("./views/pomodoro.js").then(({ mountPomodoro }) => {
    mountPomodoro(document.querySelector(".topbar"));
  }).catch(() => {});
  // リマインダー通知（個人設定でON時のみ発火。多重起動はフラグで防止）
  if (!window.__tsNotify) {
    window.__tsNotify = true;
    import("./lib/notify.js").then(({ startNotifications }) => startNotifications(() => store.load())).catch(() => {});
  }
  // Fable（隠し要素）: 実行サービスが許可したユーザーのときだけナビに出現
  import("./lib/exec.js").then(({ execMe }) => execMe()).then((uid) => {
    if (!uid) return;
    const nav = document.getElementById("nav");
    if (nav) nav.insertAdjacentHTML("beforeend",
      `<div class="navgrp">AI</div><a href="#/fable" data-k="fable">${ROUTES.fable.label}</a>`);
  }).catch(() => {});
}

async function route() {
  const key = (location.hash.replace(/^#\//, "") || "home");
  const r = ROUTES[key] || ROUTES.home;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.k === key));
  const content = document.getElementById("content");
  if (!content) return;
  content.classList.toggle("wide", !!r.wide);   // ワイドな表（一覧など）はコンテンツ幅を広げる

  if (r.soon || !r.mod) { content.innerHTML = `<h1 class="vtitle">${r.label}</h1><div class="card"><div class="loading">この画面は準備中です（モックは <a href="../index.html">ギャラリー</a> 参照）。</div></div>`; return; }
  content.innerHTML = `<div class="loading">読み込み中…</div>`;
  try {
    const mod = await import(r.mod);
    await mod.render(content);
  } catch (e) {
    if (e instanceof vik.AuthError) return showLogin("セッション切れ。再ログインしてください。");
    content.innerHTML = `<div class="card"><div class="loading">エラー: ${e.message}</div></div>`;
    console.error(e);
  }
}

function boot() {
  shell();
  if (!location.hash) location.hash = "#/home";
  route();
}
window.addEventListener("hashchange", route);

if (vik.isAuthed()) boot(); else showLogin();

// ── PWA ──────────────────────────────────────────────────────────────
// Service Worker 登録（アプリシェルのオフライン起動・スタンドアロン化）。
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW登録失敗", e));
  });
}

// オフライン時のバナー（データ保存はオンライン復帰後の注意喚起）。
function ensureNetBanner() {
  let b = document.getElementById("ts-offline");
  if (!b) {
    b = document.createElement("div");
    b.id = "ts-offline";
    b.textContent = "⚠ オフライン — 表示は直近のキャッシュです（追加・編集はオンライン復帰後に）";
    b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9998;background:#e5484d;color:#fff;font:600 12.5px/1.4 system-ui,sans-serif;text-align:center;padding:8px 12px";
    document.body.appendChild(b);
  }
  b.style.display = navigator.onLine ? "none" : "block";
}
window.addEventListener("online", ensureNetBanner);
window.addEventListener("offline", ensureNetBanner);
ensureNetBanner();

// インストール導線（beforeinstallprompt をフックして右下にボタン）。
let _deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredPrompt = e;
  if (document.getElementById("ts-install")) return;
  const b = document.createElement("button");
  b.id = "ts-install";
  b.textContent = "📲 アプリをインストール";
  b.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:9999;background:#3a86ff;color:#fff;border:0;border-radius:24px;padding:11px 18px;font:700 13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(58,134,255,.4);cursor:pointer";
  b.onclick = async () => {
    if (!_deferredPrompt) return;
    _deferredPrompt.prompt();
    try { await _deferredPrompt.userChoice; } catch {}
    _deferredPrompt = null; b.remove();
  };
  document.body.appendChild(b);
});
window.addEventListener("appinstalled", () => {
  _deferredPrompt = null;
  const b = document.getElementById("ts-install"); if (b) b.remove();
});
