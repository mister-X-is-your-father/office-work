// SPA シェル: ログイン / サイドナビ / ハッシュルータ
import * as vik from "./lib/api.js";
import * as store from "./lib/store.js";
import { icon } from "./lib/icons.js";
import { errorState, withRefresh } from "./lib/ui.js";
import { ROUTES, ORDER, ALWAYS_VISIBLE } from "./lib/routes.js";

const app = document.getElementById("app");

// メニュー表示制御（チーム設定で管理者が各人別に設定）: 現ユーザーの非表示ルート集合。
// shell() でナビを組んだ後 applyMenuVisibility() が非同期解決して隠す＋route() の直URLガードに使う。
let _hidden = new Set();

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
  // 各リンクは「アイコン + ラベル」。折りたたみ時は CSS でラベルを隠しアイコンだけ残す。
  // title 属性で折りたたみ時のネイティブ tooltip を確保。
  const link = (k) => {
    const r = ROUTES[k];
    const ic = `<span class="nav-ic">${icon(r.ic || "file", { size: 17 })}</span>`;
    const lb = `${r.label}${r.soon ? " ·準備中" : ""}`;
    return `<a href="#/${k}" data-k="${k}" class="${r.soon ? "soon" : ""}" title="${r.label}">${ic}<span class="nav-lb">${lb}</span></a>`;
  };
  const nav = Object.entries(grps).map(([g, keys]) =>
    `<div class="navgrp">${g}</div>` + keys.map(k => {
      // 定期MTG の直後に少し余白を入れ、定期(業務/MTG)と後続の休暇/設定等を視覚的に分ける。
      const sep = k === "recurring-meeting" ? `<div class="nav-spacer"></div>` : "";
      // 設定2項目は「その他」最下部に独立配置＝個人設定の直前に区切り線を入れて強調。
      const rule = k === "settings-personal" ? `<div class="nav-rule"></div>` : "";
      return rule + link(k) + sep;
    }).join("")
  ).join("");
  app.innerHTML = `
    <a href="#main" class="skip-link" id="skip-link">本文へスキップ</a>
    <div class="shell">
      <aside class="sidebar">
        <div class="sb-head">
          <div class="brand">TaskStation</div>
          <button class="sb-collapse" id="sb-collapse" type="button" aria-label="サイドバーを折りたたむ" title="サイドバーを折りたたむ">${icon("chevronLeft", { size: 18 })}</button>
        </div>
        <button class="addbtn" id="addtask" title="タスク追加"><span class="nav-lb">タスク追加</span></button>
        <nav class="nav" id="nav">${nav}</nav>
        <button class="theme-tg" id="theme-tg" aria-label="テーマ切替"></button>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="sb-toggle" id="sb-toggle" aria-label="メニューを開閉" aria-expanded="false">${icon("menu", { size: 18 })}</button>
          <span class="who" id="who"></span>
          <button id="refresh">↻ 再読込</button>
          <button id="logout">ログアウト</button>
          <div class="tb-of" id="tb-of">
            <button class="tb-of-btn" id="tb-of-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="その他のメニュー" title="その他">⋮</button>
            <div class="tb-of-menu" id="tb-of-menu" role="menu" hidden>
              <button class="tb-of-item" id="tb-of-refresh" type="button" role="menuitem">↻ 再読込</button>
              <button class="tb-of-item" id="tb-of-logout" type="button" role="menuitem">ログアウト</button>
            </div>
          </div>
          <div id="ts-live" aria-live="polite" class="sr-only"></div>
          <div id="ts-live-alert" aria-live="assertive" role="alert" class="sr-only"></div>
        </div>
        <div class="content" id="content" role="main" tabindex="-1"><div class="loading">…</div></div>
      </div>
      <div class="sb-backdrop" id="sb-backdrop"></div>
    </div>`;
  // モバイル: サイドバーのドロワー開閉（デスクトップは常時表示＝CSSのmedia queryで切替）。
  const _sb = document.querySelector(".sidebar"), _bd = document.getElementById("sb-backdrop"), _tg = document.getElementById("sb-toggle");
  const setDrawer = (o) => { _sb.classList.toggle("open", o); _bd.classList.toggle("open", o); _tg.setAttribute("aria-expanded", o ? "true" : "false"); };
  _bd.onclick = () => setDrawer(false);
  document.getElementById("nav").addEventListener("click", (e) => { if (e.target.closest("a")) setDrawer(false); });

  // スキップリンク: SPA のハッシュルータを汚さずに本文へフォーカス移動（href の #main 遷移は抑止）。
  const _skip = document.getElementById("skip-link");
  if (_skip) _skip.addEventListener("click", (e) => {
    e.preventDefault();
    const c = document.getElementById("content");
    if (c) { c.focus(); c.scrollIntoView({ block: "start" }); }
  });

  // デスクトップ: サイドバーを「アイコンだけの細いレール」に折りたたむ（localStorage 永続）。
  // 狭幅（820px以下）ではこのクラスは CSS 側で無効化し、従来のドロワー挙動を維持する。
  const COLLAPSE_KEY = "ts.sidebar.collapsed";
  const _coBtn = document.getElementById("sb-collapse");
  const isNarrow = () => window.matchMedia("(max-width:820px)").matches;
  const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; } };
  const setCollapsed = (c, persist = true) => {
    document.querySelector(".shell").classList.toggle("sb-collapsed", c);
    if (_coBtn) {
      _coBtn.setAttribute("aria-label", c ? "サイドバーを展開する" : "サイドバーを折りたたむ");
      _coBtn.setAttribute("title", c ? "サイドバーを展開する" : "サイドバーを折りたたむ");
    }
    if (persist) { try { localStorage.setItem(COLLAPSE_KEY, c ? "1" : "0"); } catch { /* noop */ } }
  };
  // 初期反映: 広い画面のみ永続状態を適用（狭幅は常に展開＝ドロワーで開く）。
  setCollapsed(!isNarrow() && readCollapsed(), false);
  if (_coBtn) _coBtn.onclick = () => setCollapsed(!document.querySelector(".shell").classList.contains("sb-collapsed"));
  // ☰ は広い画面では折りたたみトグル、狭幅ではドロワー開閉。
  _tg.onclick = () => {
    if (isNarrow()) setDrawer(!_sb.classList.contains("open"));
    else setCollapsed(!document.querySelector(".shell").classList.contains("sb-collapsed"));
  };
  // ダーク/ライト切替（CSS変数を html[data-theme] で反転＝再描画不要・localStorage永続）
  const themeTg = document.getElementById("theme-tg");
  const curTheme = () => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const paintThemeBtn = () => { themeTg.innerHTML = curTheme() === "dark" ? `${icon("sun", { size: 15 })}<span class="nav-lb">ライト</span>` : `${icon("moon", { size: 15 })}<span class="nav-lb">ダーク</span>`; };
  paintThemeBtn();
  themeTg.onclick = () => {
    const next = curTheme() === "dark" ? "light" : "dark";
    if (next === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("ts.theme", next); } catch { /* noop */ }
    paintThemeBtn();
    route(); // 現在ビューを再描画（SVG等でJS算出した色＝円時計の中央数字などを即反映）
  };
  document.getElementById("refresh").onclick = async () => {
    const content = document.getElementById("content");
    await withRefresh(content, async () => { store.invalidate(); await route(); });
  };
  document.getElementById("addtask").onclick = async () => {
    const { openTaskForm } = await import("./views/taskform.js");
    openTaskForm({ onSaved: route });
  };
  document.getElementById("logout").onclick = () => { vik.clearToken(); showLogin(); };
  // モバイル(≤560px)の⋮オーバーフローメニュー: 再読込/ログアウトを集約。
  // 実処理は既存の #refresh / #logout に委譲（重複配線を避け、挙動を完全一致させる）。
  // #refresh/#logout は DOM に残し CSS で視覚的に隠すだけ（topbar 各部品が #refresh を anchor にしているため）。
  const _ofBtn = document.getElementById("tb-of-btn"), _ofMenu = document.getElementById("tb-of-menu");
  if (_ofBtn && _ofMenu) {
    const closeOf = () => { _ofMenu.hidden = true; _ofBtn.setAttribute("aria-expanded", "false"); };
    const openOf = () => { _ofMenu.hidden = false; _ofBtn.setAttribute("aria-expanded", "true"); };
    _ofBtn.onclick = (e) => { e.stopPropagation(); _ofMenu.hidden ? openOf() : closeOf(); };
    document.getElementById("tb-of-refresh").onclick = () => { closeOf(); document.getElementById("refresh").click(); };
    document.getElementById("tb-of-logout").onclick = () => { closeOf(); document.getElementById("logout").click(); };
    // メニュー外クリック / Esc で閉じる。
    document.addEventListener("click", (e) => { if (!_ofMenu.hidden && !e.target.closest("#tb-of")) closeOf(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !_ofMenu.hidden) { closeOf(); _ofBtn.focus(); } });
  }
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
  // レビュー通知ベル（🔔・依頼者向け。承認/新着コメントを90秒ポーリングで拾い未読バッジ表示）
  import("./views/notifbell.js").then(({ mountReviewBell }) => mountReviewBell(document.querySelector(".topbar"))).catch(() => {});
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
      `<div class="navgrp">AI</div><a href="#/fable" data-k="fable" title="${ROUTES.fable.label}"><span class="nav-ic">${icon("bot", { size: 17 })}</span><span class="nav-lb">${ROUTES.fable.label}</span></a>`);
  }).catch(() => {});
  // メニュー表示制御: 管理者がチーム設定で各人別に隠したメニューを、本人のナビから除去する。
  applyMenuVisibility();
}

// 現ユーザーの非表示メニューをナビから除去し、空になったグループ見出しも片付ける。
// 直URLで隠しルートに来ていたらホームへフォールバック。設定/データ取得失敗時は何もしない（全表示で安全側）。
async function applyMenuVisibility() {
  try {
    const { me, settings } = await store.load();
    const mv = (settings && settings.menuVisibility) || {};
    const hidden = new Set((me && mv[String(me.id)]) || []);
    for (const k of ALWAYS_VISIBLE) hidden.delete(k); // 必須メニューは常時表示
    _hidden = hidden;
    const nav = document.getElementById("nav");
    if (nav) {
      nav.querySelectorAll("a[data-k]").forEach((a) => { if (hidden.has(a.dataset.k)) a.remove(); });
      // リンクが1つも残っていないグループ見出し（と直後の区切り/余白）を除去。
      nav.querySelectorAll(".navgrp").forEach((hd) => {
        let hasLink = false;
        for (let n = hd.nextElementSibling; n && !n.classList.contains("navgrp"); n = n.nextElementSibling) {
          if (n.matches("a[data-k]")) { hasLink = true; break; }
        }
        if (!hasLink) {
          let n = hd.nextElementSibling;
          while (n && !n.classList.contains("navgrp")) { const next = n.nextElementSibling; n.remove(); n = next; }
          hd.remove();
        }
      });
    }
    // 隠しルートを直URL/リロードで開いていたらホームへ。
    const cur = location.hash.replace(/^#\//, "") || "home";
    if (hidden.has(cur)) location.hash = "#/home";
  } catch { /* 取得失敗時は全表示のまま（締め出さない） */ }
}

async function route() {
  const key = (location.hash.replace(/^#\//, "") || "home");
  // 管理者に隠されたメニューへ直接遷移してきたらホームへ戻す（ナビからは既に消えている）。
  if (_hidden.has(key)) { if (location.hash !== "#/home") { location.hash = "#/home"; return; } }
  const r = ROUTES[key] || ROUTES.home;
  document.querySelectorAll("#nav a").forEach(a => {
    const on = a.dataset.k === key;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
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
    content.innerHTML = errorState(e.message, { retryId: "route-retry" });
    const rb = document.getElementById("route-retry");
    if (rb) rb.onclick = () => { store.invalidate(); route(); };
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
    b.innerHTML = `${icon("alertTriangle", { size: 14 })} オフライン — 表示は直近のキャッシュです（追加・編集はオンライン復帰後に）`;
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
  b.innerHTML = `${icon("download", { size: 15 })} アプリをインストール`;
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
