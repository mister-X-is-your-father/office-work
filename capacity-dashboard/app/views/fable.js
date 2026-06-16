// Fable 実行コンソール（隠しビュー・許可ユーザーのみサイドバーに出現）。
// 直列キュー（これが終わったらこれ）・▶実行・ライブコンソール・スクリプトのワンポチ起動。
// スクリプトとAIを同じキューに並べれば「スクリプト→AI→スクリプト」の協業になる。
import { load } from "../lib/store.js";
import { execMe, getQueue, getScripts, runAi, planAi, runScript, cancelJob, streamUrl, loadRunOpts, saveRunOpts, getFiles, fileUrl } from "../lib/exec.js";
import { C, esc } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

let _root, _es = null, _timer = null, _watching = null;

export async function render(root) {
  _root = root;
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_es) { _es.close(); _es = null; _watching = null; }

  const me = await execMe();
  if (!me) {
    root.innerHTML = `<h1 class="vtitle">Fable</h1><div class="card"><div class="loading">この画面を利用する権限がありません。</div></div>`;
    return;
  }
  const [{ tasks, aiMembers }, q, sc] = await Promise.all([load(), getQueue(), getScripts()]);
  const aiIds = new Set((aiMembers || []).map((m) => m.id));
  const fableTasks = (tasks || []).filter((t) => !t.done && (t.assignees || []).some((a) => aiIds.has(a.id)));

  root.innerHTML = `
    <style>${css()}</style>
    <h1 class="vtitle">${icon("bot", { size: 20 })} Fable <small>直列キュー ・ Claude Code（MAXプラン）で実行</small></h1>
    <div class="fb-grid">
      <div>
        <div class="card fb-card">
          <div class="fb-h">実行オプション <span class="fb-hint">（▶に適用・保存される）</span></div>
          <div class="fb-opts">
            <label>モデル
              <select id="fb-opt-model" class="fb-sel">
                <option value="sonnet">標準（Sonnet）</option>
                <option value="opus">高品質（Opus）</option>
                <option value="fable">最高品質（Fable）</option>
              </select></label>
            <label><input type="checkbox" id="fb-opt-browser"> ブラウザ操作</label>
            <label><input type="checkbox" id="fb-opt-web"> Web検索・閲覧</label>
          </div>
          <input id="fb-opt-extra" class="fb-extra" type="text" placeholder="追加指示（任意・毎回プロンプトに添付）">
        </div>
        <div class="card fb-card">
          <div class="fb-h">Fable担当のタスク <span class="fb-hint">（▶でキューに追加）</span></div>
          ${fableTasks.length ? fableTasks.map((t) => `
            <div class="fb-row">
              <span class="fb-t">${esc(t.title)}</span>
              <button class="fb-plan" data-plan-task="${t.id}" data-title="${esc(t.title)}" title="計画だけ立てさせる（読み取り専用・承認してから▶）">${icon("pencil", { size: 14 })}</button>
              <button class="fb-play" data-run-task="${t.id}" data-title="${esc(t.title)}" title="Fableに実行させる（計画があれば沿って実行）">${icon("play", { size: 13 })}</button>
            </div>`).join("") : `<div class="fb-empty">Fableが副担当のタスクはありません（タスクの副担当で fable を検索）</div>`}
        </div>
        <div class="card fb-card">
          <div class="fb-h">スクリプト <span class="fb-hint">（~/.config/taskstation/scripts/・▶でワンポチ起動）</span></div>
          ${(sc.scripts || []).length ? sc.scripts.map((s) => `
            <div class="fb-row"><span class="fb-t">${icon("settings", { size: 14 })} ${esc(s)}</span>
              <button class="fb-play" data-run-script="${esc(s)}" title="実行">${icon("play", { size: 13 })}</button></div>`).join("")
          : `<div class="fb-empty">スクリプトがありません</div>`}
        </div>
        <div class="card fb-card">
          <div class="fb-h">キュー <span class="fb-hint">（上から順に実行）</span></div>
          <div id="fb-queue"></div>
        </div>
        <div class="card fb-card">
          <div class="fb-h">成果物 <span class="fb-hint">（Fableが作ったファイル・クリックで開く）</span></div>
          <div id="fb-files"></div>
        </div>
      </div>
      <div class="card fb-card fb-console-card">
        <div class="fb-h">コンソール <span class="fb-hint" id="fb-con-t">（実行するとここにライブ表示）</span></div>
        <pre class="fb-console" id="fb-console"></pre>
      </div>
    </div>`;

  const refresh = async () => {
    let qq;
    try { qq = await getQueue(); } catch { return; }
    paintQueue(qq);
    paintFiles().catch(() => {});
    // 実行中ジョブのコンソールを自動で追尾
    if (qq.running && _watching !== qq.running.id) watch(qq.running.id, qq.running.title);
  };
  const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : b > 1024 ? `${Math.round(b / 1024)}KB` : `${b}B`);
  const paintFiles = async () => {
    const el = _root.querySelector("#fb-files");
    if (!el) return;
    const { files } = await getFiles();
    el.innerHTML = (files || []).length ? files.slice(0, 30).map((f) => {
      const d = new Date(f.mtime * 1000);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return `<div class="fb-row">
        <a class="fb-t fb-file" href="${fileUrl(f.path)}" target="_blank" rel="noopener">${icon("file", { size: 14 })} ${esc(f.path)}</a>
        <span class="fb-meta">${fmtSize(f.size)} ・ ${when}</span>
      </div>`;
    }).join("") : `<div class="fb-empty">まだありません（▶実行でファイルが作られるとここに出ます）</div>`;
  };
  const paintQueue = (qq) => {
    const el = _root.querySelector("#fb-queue");
    if (!el) return;
    const row = (j, extra = "") => `
      <div class="fb-row fb-${j.status}">
        <span class="fb-st">${{ running: `${icon("play", { size: 11 })} 実行中`, queued: "… 待機", done: icon("check", { size: 13 }), error: icon("x", { size: 13 }), cancelled: "−" }[j.status] || esc(j.status)}</span>
        <span class="fb-t fb-link" data-watch="${j.id}" data-title="${esc(j.title)}">${j.kind === "ai" ? icon("bot", { size: 14 }) : icon("settings", { size: 14 })} ${esc(j.title)}</span>
        ${extra}
      </div>`;
    el.innerHTML = (qq.running ? row(qq.running) : "")
      + qq.pending.map((j) => row(j, `<button class="fb-x" data-cancel="${j.id}" title="取消">×</button>`)).join("")
      + (qq.history || []).slice(0, 8).map((j) => row(j)).join("")
      || `<div class="fb-empty">キューは空です</div>`;
    el.querySelectorAll("[data-cancel]").forEach((b) => { b.onclick = async () => { await cancelJob(+b.dataset.cancel); refresh(); }; });
    el.querySelectorAll("[data-watch]").forEach((s) => { s.onclick = () => watch(+s.dataset.watch, s.dataset.title); });
  };
  const watch = (jobId, title) => {
    if (_es) _es.close();
    _watching = jobId;
    const con = _root.querySelector("#fb-console");
    _root.querySelector("#fb-con-t").textContent = `#${jobId} ${title || ""}`;
    con.textContent = "";
    _es = new EventSource(streamUrl(jobId));
    _es.onmessage = (e) => {
      con.textContent += JSON.parse(e.data) + "\n";
      con.scrollTop = con.scrollHeight;
    };
    _es.addEventListener("end", () => { _es.close(); _es = null; refresh(); });
  };

  // 実行オプション: 表示時に復元、変更で保存。▶はこのオプションで実行。
  const opts = loadRunOpts();
  const optEls = {
    model: _root.querySelector("#fb-opt-model"),
    browser: _root.querySelector("#fb-opt-browser"),
    web: _root.querySelector("#fb-opt-web"),
    extra: _root.querySelector("#fb-opt-extra"),
  };
  optEls.model.value = opts.model;
  optEls.browser.checked = !!opts.browser;
  optEls.web.checked = !!opts.web;
  optEls.extra.value = opts.extra || "";
  const saveOpts = () => saveRunOpts({
    model: optEls.model.value, browser: optEls.browser.checked,
    web: optEls.web.checked, extra: optEls.extra.value.trim(),
  });
  Object.values(optEls).forEach((el) => { el.onchange = saveOpts; });

  _root.querySelectorAll("[data-run-task]").forEach((b) => {
    b.onclick = async () => { saveOpts(); const j = await runAi(+b.dataset.runTask, b.dataset.title); refresh(); watch(j.job.id, j.job.title); };
  });
  _root.querySelectorAll("[data-plan-task]").forEach((b) => {
    b.onclick = async () => { saveOpts(); const j = await planAi(+b.dataset.planTask, b.dataset.title); refresh(); watch(j.job.id, j.job.title); };
  });
  _root.querySelectorAll("[data-run-script]").forEach((b) => {
    b.onclick = async () => { const j = await runScript(b.dataset.runScript); refresh(); watch(j.job.id, j.job.title); };
  });

  await refresh();
  _timer = setInterval(() => {
    if (!document.body.contains(_root)) { clearInterval(_timer); _timer = null; if (_es) { _es.close(); _es = null; } return; }
    refresh();
  }, 5000);
}

function css() {
  return `
  .fb-grid{display:grid;grid-template-columns:minmax(320px,5fr) minmax(380px,7fr);gap:14px;align-items:start}
  @media(max-width:900px){.fb-grid{grid-template-columns:1fr}}
  .fb-card{padding:14px 16px;margin-bottom:14px}
  .fb-h{font-size:13px;font-weight:700;margin-bottom:8px}
  .fb-hint{font-weight:400;color:${C.muted};font-size:11px}
  .fb-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid ${C.track};font-size:13px}
  .fb-row:first-of-type{border-top:0}
  .fb-t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fb-link{cursor:pointer}.fb-link:hover{color:${C.fill}}
  .fb-st{font-size:11px;color:${C.muted};width:54px;flex:none}
  .fb-running .fb-st{color:${C.fill};font-weight:700}
  .fb-error .fb-st{color:${C.over};font-weight:700}
  .fb-done .fb-st{color:${C.free}}
  .fb-play{width:30px;height:30px;border-radius:50%;border:1px solid ${C.fill};background:#fff;color:${C.fill};cursor:pointer;font-size:12px;flex:none}
  .fb-play:hover{background:${C.fill};color:#fff}
  .fb-plan{width:30px;height:30px;border-radius:50%;border:1px solid ${C.line};background:#fff;cursor:pointer;font-size:12px;flex:none}
  .fb-plan:hover{border-color:${C.fill}}
  .fb-x{border:0;background:transparent;color:${C.muted};cursor:pointer;font-size:14px}
  .fb-x:hover{color:${C.over}}
  .fb-empty{font-size:12px;color:${C.muted};padding:6px 0}
  .fb-file{color:${C.ink};text-decoration:none}
  .fb-file:hover{color:${C.fill};text-decoration:underline}
  .fb-meta{font-size:11px;color:${C.muted};flex:none}
  .fb-opts{display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:${C.ink}}
  .fb-opts label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
  .fb-sel{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid ${C.line};border-radius:7px;background:#fff}
  .fb-extra{width:100%;margin-top:8px;font:inherit;font-size:12.5px;padding:7px 10px;border:1px solid ${C.line};border-radius:8px;box-sizing:border-box}
  .fb-extra:focus{outline:none;border-color:${C.fill}}
  .fb-console-card{position:sticky;top:12px}
  .fb-console{background:#101418;color:#cfe3cf;border-radius:10px;padding:12px;font-size:11.5px;line-height:1.5;height:480px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}`;
}
