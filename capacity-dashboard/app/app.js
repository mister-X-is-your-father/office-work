// SPA シェル: ログイン / サイドナビ / ハッシュルータ
import * as vik from "./lib/vikunja.js";
import * as store from "./lib/store.js";

const ROUTES = {
  home:     { label: "ホーム",        grp: "総合",   mod: "./views/home.js" },
  today:    { label: "空き探し",      grp: "今日",   mod: "./views/today.js" },
  triage:   { label: "トリアージ",    grp: "今日",   mod: "./views/triage.js" },
  week:     { label: "週プラン",      grp: "計画",   mod: "./views/week.js" },
  estactual:{ label: "見積りvs実績",  grp: "実績",   mod: "./views/estactual.js" },
  kanban:   { label: "かんばん",      grp: "仕事",   soon: true },
  list:     { label: "一覧",          grp: "仕事",   soon: true },
  gantt:    { label: "ガント",        grp: "仕事",   soon: true },
  settings: { label: "設定",          grp: "その他", soon: true },
};
const ORDER = ["home", "today", "triage", "week", "estactual", "kanban", "list", "gantt", "settings"];

const app = document.getElementById("app");

function showLogin(msg = "") {
  app.innerHTML = `
    <div class="login">
      <h2>Capacity Board</h2>
      <p>実データ版。Vikunja にログインしてください。</p>
      <label>ユーザー名</label><input id="u" autocomplete="username">
      <label>パスワード</label><input id="p" type="password" autocomplete="current-password">
      <button id="go">接続</button>
      <div class="err" id="err">${msg}</div>
    </div>`;
  const go = async () => {
    const b = document.getElementById("go");
    b.disabled = true; document.getElementById("err").textContent = "接続中…";
    try {
      await vik.login(document.getElementById("u").value.trim(), document.getElementById("p").value);
      store.invalidate(); boot();
    } catch (e) { b.disabled = false; document.getElementById("err").textContent = "× " + e.message; }
  };
  document.getElementById("go").onclick = go;
  document.getElementById("p").onkeydown = e => { if (e.key === "Enter") go(); };
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
        <div class="brand">Capacity Board<small>Vikunja 実データ</small></div>
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
