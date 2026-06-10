// SPA シェル: ログイン / サイドナビ / ハッシュルータ
import * as vik from "./lib/api.js";
import * as store from "./lib/store.js";

const ROUTES = {
  home:     { label: "ホーム",        grp: "総合",   mod: "./views/home.js" },
  today:    { label: "稼働予定",      grp: "本日",   mod: "./views/today.js" },
  triage:   { label: "トリアージ",    grp: "本日",   mod: "./views/triage.js" },
  review:   { label: "レビュー",      grp: "本日",   mod: "./views/review.js" },
  availability:{ label: "残容量",     grp: "本日",   mod: "./views/availability.js" },
  calendar: { label: "時刻カレンダー",grp: "本日",   mod: "./views/calendar.js" },
  week:     { label: "週プラン",      grp: "計画",   mod: "./views/week.js" },
  planner:  { label: "週プランナー",  grp: "計画",   mod: "./views/planner.js" },
  freefinder:{ label: "月次空き",     grp: "計画",   mod: "./views/freefinder.js" },
  weekstack:{ label: "週日別負荷",    grp: "計画",   mod: "./views/weekstack.js" },
  estactual:{ label: "見積りvs実績",  grp: "実績",   mod: "./views/estactual.js" },
  kanban:   { label: "かんばん",      grp: "仕事",   soon: true },
  list:     { label: "一覧",          grp: "仕事",   mod: "./views/table.js" },
  outline:  { label: "アウトライン",  grp: "仕事",   mod: "./views/outline.js" },
  depgraph: { label: "依存グラフ",    grp: "仕事",   mod: "./views/depgraph.js" },
  gantt:    { label: "予実ガント",    grp: "仕事",   mod: "./views/gantt.js" },
  settings: { label: "設定",          grp: "その他", soon: true },
};
const ORDER = ["home", "today", "triage", "review", "availability", "calendar", "week", "planner", "freefinder", "weekstack", "estactual", "kanban", "list", "outline", "depgraph", "gantt", "settings"];

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
      <p>${isReg ? "アカウントを作成" : "ログイン"}</p>
      <label>ユーザー名</label><input id="u" autocomplete="username" placeholder="ユーザー名">
      ${isReg ? `<label>メールアドレス</label><input id="em" type="email" autocomplete="email" placeholder="you@example.com">` : ""}
      <label>パスワード</label><input id="p" type="password" autocomplete="${isReg ? "new-password" : "current-password"}" placeholder="パスワード">
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
}

async function route() {
  const key = (location.hash.replace(/^#\//, "") || "home");
  const r = ROUTES[key] || ROUTES.home;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.k === key));
  const content = document.getElementById("content");
  if (!content) return;
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
