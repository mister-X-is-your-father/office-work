// 計画ウィザード（#/keikaku）。書籍『仕事は計画が10割』の4ステップ計画を taskstation に投入する。
// tools/keikaku-import.py（CSV投入スクリプト）のアプリ内版。keikaku CSV を貼り付け→レビュー→
// ワンクリックで「プロジェクト(親タスク)＋タスク(子)＋依存」を生成する。
//
// 呼称階層（厳守）: ワークスペース(=Vikunja project) ＞ プロジェクト(=親タスク) ＞ タスク(=子タスク)。
//   「プロジェクト」も「タスク」も実体は task。親子は relation `parenttask` で表現する。
//
// 投入セマンティクスは keikaku-import.py と完全一致（2フェーズ＋ID前方参照回避）:
//   (A) 全タスク生成して CSVローカルID→実ID マップ作成
//   (B) parenttask 関連（child を taskId 側）  addRelation(child.id, parent.id, "parenttask")
//   (C) follows 関連（T が follows 側）        addRelation(T.id, D.id, "follows")  ※T が D に依存
//   (D) assignee（数値=addAssignee / 非数値=スキップ＋警告）
//
// ⚠ 非冪等（v1）: 再実行すると毎回新規タスクを重複作成する。投入前に同意チェックを必須にしている。
import { load, invalidate } from "../lib/store.js";
import * as vik from "../lib/api.js";
import { C, esc, fmtH } from "../lib/ui.js";
import { icon } from "../lib/icons.js";

const SAMPLE_CSV = `id,parent,task,type,assignee,est_hours,depends_on,due,done_criteria
P,,新人オンボーディング資料の整備,project,自分,,,2026-07-20,新人1名が資料だけで自走できた
1,P,既存の散在情報を棚卸し・収集,PJ,自分,4,,2026-07-04,情報源が1か所にリスト化
2,P,環境セットアップ手順を書く,PJ,自分,8,1,2026-07-11,新規PCで手順通り構築できた
3,P,チーム業務マップと用語集,PJ,自分,8,1,2026-07-11,主要メンバーと用語を網羅し先輩レビュー済
4,P,初週タスクロードマップ,定常,自分,4,1,2026-07-11,初週5日分のやること表が埋まっている
5,P,FAQと詰まり時の導線,定常,自分,4,1,2026-07-11,想定質問10件と連絡先が載っている
6,P,新人1名で自走テスト,PJ,新人,8,"2,3,4,5",2026-07-17,資料のみで着手まで到達
7,P,テスト結果を反映修正,PJ,自分,4,6,2026-07-18,詰まった箇所が全て改訂済`;

// ── CSV パーサ（クォート対応・自前実装）──────────────────────────────────
//   ダブルクォートで囲まれたフィールド内のカンマ／改行は 1 セル扱い。"" は " のエスケープ。
//   戻り: string[][]（レコードの配列。各レコードはセルの配列）。
function parseCsvGrid(text) {
  const rows = [];
  let field = "", record = [], inQ = false;
  const pushField = () => { record.push(field); field = ""; };
  const pushRecord = () => { pushField(); rows.push(record); record = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // エスケープされた "
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") pushField();
    else if (c === "\n") pushRecord();
    else if (c === "\r") { /* CRLF の CR は無視 */ }
    else field += c;
  }
  if (field.length || record.length) pushRecord(); // 末尾レコード
  // 全セル空のレコード（末尾改行由来など）は捨てる
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// CSV テキスト → { rows, errors, warnings }。
//   rows[i] = { localId, parent, task, type, assignee, est_hours, depends_on:string[], due, done_criteria }
function parsePlan(text) {
  const errors = [], warnings = [];
  const grid = parseCsvGrid(text);
  if (grid.length === 0) return { rows: [], errors: ["CSV が空です。"], warnings };
  const header = grid[0].map((h) => h.trim());
  const need = ["id", "parent", "task", "type", "assignee", "est_hours", "depends_on", "due", "done_criteria"];
  const missing = need.filter((n) => header.indexOf(n) < 0);
  if (missing.length) errors.push(`ヘッダ列が不足: ${missing.join(", ")}`);
  const col = (rec, name) => { const i = header.indexOf(name); return i >= 0 ? (rec[i] || "").trim() : ""; };

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const rec = grid[r];
    const localId = col(rec, "id");
    const task = col(rec, "task");
    if (!localId) { errors.push(`${r} 行目: id（CSVローカルID）が空です。`); continue; }
    if (!task) errors.push(`${r} 行目（id:${localId}）: task（タスク名）が空です。`);
    const depRaw = col(rec, "depends_on");
    rows.push({
      localId,
      parent: col(rec, "parent"),
      task,
      type: col(rec, "type") || "PJ",
      assignee: col(rec, "assignee"),
      est_hours: col(rec, "est_hours"),
      depends_on: depRaw.split(",").map((d) => d.trim()).filter(Boolean),
      due: col(rec, "due"),
      done_criteria: col(rec, "done_criteria"),
    });
  }
  if (rows.length === 0 && errors.length === 0) errors.push("データ行がありません。");

  // 参照整合チェック（parent / depends_on が CSV 内に存在するか）→ 警告
  const ids = new Set(rows.map((r) => r.localId));
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.localId)) warnings.push(`id「${r.localId}」が重複しています。`);
    seen.add(r.localId);
    if (r.parent && !ids.has(r.parent)) warnings.push(`id「${r.localId}」の parent「${r.parent}」が CSV 内に存在しません。`);
    for (const d of r.depends_on) if (!ids.has(d)) warnings.push(`id「${r.localId}」の依存先「${d}」が CSV 内に存在しません。`);
    if (r.assignee && !/^\d+$/.test(r.assignee)) warnings.push(`id「${r.localId}」の担当「${r.assignee}」は数値の user_id でないため投入時にスキップされます（v1 は名前解決しません）。`);
  }
  return { rows, errors, warnings };
}

const isProjectRow = (r) => r.type === "project";
const kindLabel = (r) => isProjectRow(r) ? "プロジェクト親" : (r.type === "定常" ? "子（定常）" : "子（PJ）");

// CSV1行 → createTaskInProject の body（必要なものだけ。py の task_payload と一致）。
function taskBody(r) {
  const body = { title: r.task };
  if (r.done_criteria) body.description = r.done_criteria;
  if (r.due) body.due_date = r.due + "T00:00:00Z";
  if (r.est_hours && !Number.isNaN(parseFloat(r.est_hours))) body.time_estimate = Math.round(parseFloat(r.est_hours) * 3600);
  return body;
}

export async function render(root) {
  const { projects, me } = await load();
  const wsList = (projects || []).filter((p) => p && p.id > 0);
  // 既定 WS: 「インボックス」があればそれ、無ければ先頭。
  const defaultWs = (wsList.find((p) => p.title === "インボックス") || wsList[0] || null);

  // 画面ローカル状態（このビュー内で閉じる）。
  const state = {
    wsId: defaultWs ? defaultWs.id : null,
    parsed: null,     // parsePlan の戻り
    agreed: false,
    importing: false,
  };

  root.innerHTML = `
    <style>${css()}</style>
    <div class="keikaku-view">
      <h1 class="vtitle">${icon("listChecks") || icon("check") || ""}計画ウィザード
        <small>『仕事は計画が10割』の4ステップ計画を taskstation に投入</small></h1>

      <div class="keikaku-grid">
        <section class="card keikaku-input">
          <div class="keikaku-row">
            <label class="keikaku-lbl" for="keikaku-ws">投入先ワークスペース</label>
            <select id="keikaku-ws" class="keikaku-sel">
              ${wsList.length
                ? wsList.map((p) => `<option value="${p.id}"${defaultWs && p.id === defaultWs.id ? " selected" : ""}>${esc(p.title)}</option>`).join("")
                : `<option value="">（ワークスペースがありません）</option>`}
            </select>
          </div>

          <label class="keikaku-lbl" for="keikaku-csv">keikaku CSV を貼り付け</label>
          <textarea id="keikaku-csv" class="keikaku-ta" spellcheck="false" rows="12">${esc(SAMPLE_CSV)}</textarea>
          <div class="keikaku-hint">ヘッダ: <code>id,parent,task,type,assignee,est_hours,depends_on,due,done_criteria</code>
            ・ <code>type</code> = <b>project</b>（プロジェクト親）/ <b>PJ・定常</b>（子）</div>
          <div class="keikaku-actions">
            <button id="keikaku-parse" class="keikaku-btn">${icon("eye") || ""}読み込む</button>
          </div>
        </section>

        <section class="card keikaku-review-wrap">
          <div id="keikaku-review" class="keikaku-review">
            <div class="keikaku-empty">「読み込む」を押すとレビュー表が表示されます。</div>
          </div>
        </section>
      </div>
    </div>`;

  const wsEl = root.querySelector("#keikaku-ws");
  const csvEl = root.querySelector("#keikaku-csv");
  const reviewEl = root.querySelector("#keikaku-review");

  wsEl.onchange = () => { state.wsId = wsEl.value ? Number(wsEl.value) : null; };
  root.querySelector("#keikaku-parse").onclick = () => {
    state.parsed = parsePlan(csvEl.value);
    state.agreed = false;
    renderReview();
  };

  function wsName() {
    const w = wsList.find((p) => p.id === state.wsId);
    return w ? w.title : "（未選択）";
  }

  // レビュー表＋要約＋投入ボタン（または結果パネル）を描画。
  function renderReview() {
    const p = state.parsed;
    if (!p) { reviewEl.innerHTML = `<div class="keikaku-empty">「読み込む」を押すとレビュー表が表示されます。</div>`; return; }

    const errHtml = p.errors.length
      ? `<div class="keikaku-msg err">${icon("alertTriangle") || ""}<div>${p.errors.map((e) => esc(e)).join("<br>")}</div></div>` : "";
    const warnHtml = p.warnings.length
      ? `<div class="keikaku-msg warn">${icon("alertTriangle") || ""}<div>${p.warnings.map((w) => esc(w)).join("<br>")}</div></div>` : "";

    if (p.rows.length === 0) { reviewEl.innerHTML = errHtml || `<div class="keikaku-empty">データ行がありません。</div>`; return; }

    const nameById = new Map(p.rows.map((r) => [r.localId, r.task]));
    const projectCount = p.rows.filter(isProjectRow).length;
    const childCount = p.rows.length - projectCount;
    const depCount = p.rows.reduce((s, r) => s + r.depends_on.length, 0);

    const rowsHtml = p.rows.map((r) => {
      const depTxt = r.depends_on.length
        ? r.depends_on.map((d) => esc(nameById.get(d) || d)).join("、") : "—";
      const est = (r.est_hours && !Number.isNaN(parseFloat(r.est_hours))) ? fmtH(parseFloat(r.est_hours)) : "—";
      return `<tr class="${isProjectRow(r) ? "is-project" : "is-child"}">
        <td class="k-kind"><span class="k-badge${isProjectRow(r) ? " proj" : ""}">${esc(kindLabel(r))}</span></td>
        <td class="k-name">${esc(r.task)}${r.done_criteria ? `<small>${esc(r.done_criteria)}</small>` : ""}</td>
        <td class="k-est">${est}</td>
        <td class="k-dep">${depTxt}</td>
      </tr>`;
    }).join("");

    reviewEl.innerHTML = `
      ${errHtml}${warnHtml}
      <div class="keikaku-tablewrap">
        <table class="keikaku-table">
          <thead><tr><th>種別</th><th>タスク名 / Done基準</th><th>見積</th><th>依存（先行）</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="keikaku-summary">
        <span class="k-sum-it"><b>${projectCount}</b> プロジェクト親</span>
        <span class="k-sum-it"><b>${childCount}</b> 子タスク</span>
        <span class="k-sum-it"><b>${depCount}</b> 依存</span>
        <span class="k-sum-it">投入先 <b>${esc(wsName())}</b></span>
      </div>
      <div class="keikaku-warnbox">
        ${icon("alertTriangle") || ""}
        <span><b>再実行は重複作成します（冪等性なし）。</b>同じ計画を二度投入しないでください。</span>
      </div>
      <label class="keikaku-agree">
        <input type="checkbox" id="keikaku-agree"${state.agreed ? " checked" : ""}>
        重複作成のリスクを理解し、このワークスペースに投入します
      </label>
      <div class="keikaku-actions">
        <button id="keikaku-import" class="keikaku-btn primary"${(!state.agreed || !state.wsId || state.importing || p.errors.length) ? " disabled" : ""}>
          ${icon("save") || ""}taskstation に投入
        </button>
        <span id="keikaku-progress" class="keikaku-progress"></span>
      </div>
      <div id="keikaku-result"></div>`;

    const agreeEl = reviewEl.querySelector("#keikaku-agree");
    if (agreeEl) agreeEl.onchange = () => {
      state.agreed = agreeEl.checked;
      const btn = reviewEl.querySelector("#keikaku-import");
      if (btn) btn.disabled = !(state.agreed && state.wsId && !state.importing && !p.errors.length);
    };
    const importBtn = reviewEl.querySelector("#keikaku-import");
    if (importBtn) importBtn.onclick = () => runImport();
  }

  // 2フェーズ投入。py の run() と同セマンティクス。各 API は try/catch して失敗を集約表示。
  async function runImport() {
    const p = state.parsed;
    if (!p || !p.rows.length || !state.wsId || state.importing) return;
    if (p.errors.length) return;
    if (typeof window !== "undefined" && window.confirm
      && !window.confirm(`「${wsName()}」に ${p.rows.length} 件のタスクを新規作成します。\n再実行は重複作成になります。投入してよろしいですか？`)) return;

    state.importing = true;
    const importBtn = reviewEl.querySelector("#keikaku-import");
    const progEl = reviewEl.querySelector("#keikaku-progress");
    const resultEl = reviewEl.querySelector("#keikaku-result");
    const agreeEl = reviewEl.querySelector("#keikaku-agree");
    if (importBtn) importBtn.disabled = true;
    if (agreeEl) agreeEl.disabled = true;
    if (resultEl) resultEl.innerHTML = "";

    const failures = [];
    const idmap = new Map(); // CSVローカルID → 実ID
    // 進捗の総ステップ数 = 生成 + parenttask + follows + assignee(数値のみ)
    const parentOps = p.rows.filter((r) => r.parent).length;
    const depOps = p.rows.reduce((s, r) => s + r.depends_on.length, 0);
    const asgOps = p.rows.filter((r) => /^\d+$/.test(r.assignee)).length;
    const totalOps = p.rows.length + parentOps + depOps + asgOps;
    let done = 0;
    const tick = (label) => { done++; if (progEl) progEl.textContent = `${label}… ${done}/${totalOps}`; };

    // ── フェーズA: 全タスク生成 ──
    let created = 0;
    for (const r of p.rows) {
      try {
        const res = await vik.createTaskInProject(state.wsId, taskBody(r));
        if (res && res.id != null) { idmap.set(r.localId, res.id); created++; }
        else failures.push(`id「${r.localId}」生成: 応答に id がありません`);
      } catch (e) {
        failures.push(`id「${r.localId}」(${esc(r.task)}) 生成失敗: ${esc(e && e.message || e)}`);
      }
      tick("生成中");
    }

    // ── フェーズB: parenttask（child を taskId 側、kind="parenttask"）──
    let parentRels = 0;
    for (const r of p.rows) {
      if (!r.parent) continue;
      const child = idmap.get(r.localId), parent = idmap.get(r.parent);
      if (child == null || parent == null) { tick("親子付け中"); continue; }
      try { await vik.addRelation(child, parent, "parenttask"); parentRels++; }
      catch (e) { failures.push(`id「${r.localId}」親子付け失敗: ${esc(e && e.message || e)}`); }
      tick("親子付け中");
    }

    // ── フェーズC: follows（T が D に依存 → T が follows 側）──
    let depRels = 0;
    for (const r of p.rows) {
      const t = idmap.get(r.localId);
      for (const dep of r.depends_on) {
        const d = idmap.get(dep);
        if (t == null || d == null) { tick("依存付け中"); continue; }
        try { await vik.addRelation(t, d, "follows"); depRels++; }
        catch (e) { failures.push(`id「${r.localId}」依存「${dep}」失敗: ${esc(e && e.message || e)}`); }
        tick("依存付け中");
      }
    }

    // ── フェーズD: assignee（数値=addAssignee / 非数値=スキップ＋警告）──
    let assignees = 0;
    const skippedAssignees = [];
    for (const r of p.rows) {
      if (!r.assignee) continue;
      if (!/^\d+$/.test(r.assignee)) { skippedAssignees.push(`id「${r.localId}」担当「${r.assignee}」`); continue; }
      const t = idmap.get(r.localId);
      if (t == null) continue;
      try { await vik.addAssignee(t, Number(r.assignee)); assignees++; }
      catch (e) { failures.push(`id「${r.localId}」担当割当失敗: ${esc(e && e.message || e)}`); }
      tick("担当割当中");
    }

    state.importing = false;
    if (progEl) progEl.textContent = "";
    invalidate();

    // 結果パネル
    const failHtml = failures.length
      ? `<div class="keikaku-msg err"><div><b>${failures.length} 件の失敗:</b><br>${failures.join("<br>")}</div></div>` : "";
    const skipHtml = skippedAssignees.length
      ? `<div class="keikaku-msg warn"><div>担当をスキップ（非数値）: ${skippedAssignees.map(esc).join("、")}</div></div>` : "";
    if (resultEl) resultEl.innerHTML = `
      <div class="keikaku-done">
        <div class="keikaku-done-hd">${icon("check") || ""}投入完了</div>
        <div class="keikaku-done-stats">
          <span>タスク <b>${created}</b> 件生成</span>
          <span>親子 <b>${parentRels}</b> 本</span>
          <span>依存 <b>${depRels}</b> 本</span>
          <span>担当 <b>${assignees}</b> 件</span>
        </div>
        ${failHtml}${skipHtml}
        <div class="keikaku-done-links">
          <a href="#/gantt" class="keikaku-link">${icon("calendar") || ""}ガントで見る</a>
          <a href="#/depgraph" class="keikaku-link">${icon("link") || ""}依存グラフで見る</a>
        </div>
      </div>`;
  }
}

function css() {
  return `
  .keikaku-view .vtitle{display:flex;align-items:center;gap:8px}
  .keikaku-view .vtitle svg{width:22px;height:22px;color:${C.fill}}
  .keikaku-grid{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:16px;align-items:start}
  @media (max-width:880px){.keikaku-grid{grid-template-columns:1fr}}
  .keikaku-input{padding:16px 18px;display:flex;flex-direction:column;gap:10px}
  .keikaku-row{display:flex;align-items:center;gap:10px}
  .keikaku-lbl{font-size:12.5px;font-weight:700;color:${C.ink}}
  .keikaku-sel{flex:1;font:inherit;font-size:13px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px;background:${C.card};color:${C.ink}}
  .keikaku-ta{width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;padding:10px 11px;border:1px solid ${C.line};border-radius:8px;background:${C.card};color:${C.ink};resize:vertical;min-height:180px}
  .keikaku-ta:focus{outline:none;border-color:${C.fill}}
  .keikaku-hint{font-size:11px;color:${C.muted};line-height:1.6}
  .keikaku-hint code{background:${C.track};padding:1px 5px;border-radius:5px;font-size:10.5px}
  .keikaku-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .keikaku-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:700;padding:8px 16px;border:1px solid ${C.line};border-radius:9px;background:${C.card};color:${C.ink};cursor:pointer;transition:border-color .12s,background .12s}
  .keikaku-btn:hover{border-color:#cfd9e6}
  .keikaku-btn svg{width:15px;height:15px}
  .keikaku-btn.primary{background:${C.fill};border-color:${C.fill};color:#fff}
  .keikaku-btn.primary:hover{filter:brightness(1.05)}
  .keikaku-btn:disabled,.keikaku-btn.primary:disabled{opacity:.45;cursor:not-allowed;filter:none}
  .keikaku-review-wrap{padding:16px 18px;min-height:120px}
  .keikaku-empty{color:${C.muted};font-size:13px;text-align:center;padding:32px 0}
  .keikaku-msg{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.6;padding:9px 11px;border-radius:9px;margin-bottom:12px}
  .keikaku-msg svg{width:16px;height:16px;flex:none;margin-top:1px}
  .keikaku-msg.err{background:color-mix(in srgb,${C.over} 12%,transparent);color:${C.over};border:1px solid color-mix(in srgb,${C.over} 35%,transparent)}
  .keikaku-msg.warn{background:color-mix(in srgb,${C.amber} 14%,transparent);color:#9a6a00;border:1px solid color-mix(in srgb,${C.amber} 35%,transparent)}
  html[data-theme="dark"] .keikaku-msg.warn{color:${C.amber}}
  .keikaku-tablewrap{overflow:auto;border:1px solid ${C.line};border-radius:10px}
  .keikaku-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .keikaku-table th{text-align:left;font-size:11px;font-weight:700;color:${C.muted};padding:8px 10px;border-bottom:1px solid ${C.line};white-space:nowrap;background:${C.track}}
  .keikaku-table td{padding:8px 10px;border-bottom:1px solid ${C.line};vertical-align:top}
  .keikaku-table tr:last-child td{border-bottom:0}
  .keikaku-table tr.is-project{background:color-mix(in srgb,${C.fill} 7%,transparent)}
  .keikaku-table tr.is-child .k-name{padding-left:18px}
  .k-badge{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;background:${C.track};color:${C.muted};white-space:nowrap}
  .k-badge.proj{background:${C.fill};color:#fff}
  .k-name{font-weight:600;color:${C.ink}}
  .k-name small{display:block;font-weight:400;color:${C.muted};font-size:11px;margin-top:2px}
  .k-est{font-variant-numeric:tabular-nums;color:${C.ink};white-space:nowrap}
  .k-dep{color:${C.muted};font-size:11.5px}
  .keikaku-summary{display:flex;flex-wrap:wrap;gap:8px 16px;margin:14px 0 10px;font-size:12.5px;color:${C.muted}}
  .keikaku-summary b{color:${C.ink};font-size:14px;font-variant-numeric:tabular-nums}
  .keikaku-warnbox{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6;color:#9a6a00;background:color-mix(in srgb,${C.amber} 12%,transparent);border:1px solid color-mix(in srgb,${C.amber} 30%,transparent);border-radius:9px;padding:9px 11px;margin-bottom:12px}
  html[data-theme="dark"] .keikaku-warnbox{color:${C.amber}}
  .keikaku-warnbox svg{width:16px;height:16px;flex:none;margin-top:1px}
  .keikaku-agree{display:flex;align-items:center;gap:8px;font-size:12.5px;color:${C.ink};margin-bottom:12px;cursor:pointer}
  .keikaku-agree input{width:16px;height:16px;cursor:pointer}
  .keikaku-progress{font-size:12.5px;color:${C.muted};font-variant-numeric:tabular-nums}
  .keikaku-done{margin-top:14px;border:1px solid color-mix(in srgb,${C.free} 35%,transparent);background:color-mix(in srgb,${C.free} 9%,transparent);border-radius:11px;padding:14px 16px}
  .keikaku-done-hd{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:700;color:${C.free};margin-bottom:8px}
  .keikaku-done-hd svg{width:18px;height:18px}
  .keikaku-done-stats{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:${C.muted};margin-bottom:10px}
  .keikaku-done-stats b{color:${C.ink};font-variant-numeric:tabular-nums}
  .keikaku-done-links{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
  .keikaku-link{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;text-decoration:none;color:${C.fill};border:1px solid ${C.line};border-radius:8px;padding:7px 13px;background:${C.card};transition:border-color .12s}
  .keikaku-link:hover{border-color:${C.fill}}
  .keikaku-link svg{width:15px;height:15px}`;
}
