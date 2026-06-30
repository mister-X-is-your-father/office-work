// 計画ウィザード（#/keikaku）。書籍『仕事は計画が10割』の4ステップ計画を taskstation に投入する。
// tools/keikaku-import.py（CSV投入スクリプト）のアプリ内版。keikaku CSV を貼り付け→読み込む→
// 編集可能なWBS表で微修正→ワンクリックで「プロジェクト(親タスク)＋タスク(子)＋依存」を生成する。
//
// 呼称階層（厳守）: ワークスペース(=Vikunja project) ＞ プロジェクト(=親タスク) ＞ タスク(=子タスク)。
//   「プロジェクト」も「タスク」も実体は task。親子は relation `parenttask` で表現する。
//
// 投入セマンティクスは keikaku-import.py と同義（2フェーズ＋ID前方参照回避）:
//   (A) 全タスク生成して CSVローカルID→実ID マップ作成
//   (B) parenttask 関連（child を taskId 側）  addRelation(child.id, parent.id, "parenttask")
//   (C) follows 関連（T が follows 側）        addRelation(T.id, D.id, "follows")  ※T が D に依存
//   (D) assignee（数値=addAssignee / 名前=resolveAssigneeInfo で user_id 解決 / 未解決はスキップ＋警告）
//
// 改修（v2）:
//   1. 担当の名前解決（"自分"/"森田" 等 → searchUsers で user_id 化）。
//   2. 期間バー: est_hours と due があれば営業日逆算で start_date/end_date を付与（ガントが期間表示）。
//   3. 冪等化: 計画ID を入れると description 末尾のマーカー <!--keikaku:plan=…;id=…--> で既存を検出し更新（重複作成しない）。
//   4. 手動WBS編集UI: 読み込んだ後はインライン編集（行追加/削除）でき、state.rows が真実のデータ。
import { load, invalidate } from "../lib/store.js";
import * as vik from "../lib/api.js";
import { C, esc, fmtH } from "../lib/ui.js";
import { icon } from "../lib/icons.js";
import { isBusinessDay, shiftISO } from "../lib/capacity.js";

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

const NEED_COLS = ["id", "parent", "task", "type", "assignee", "est_hours", "depends_on", "due", "done_criteria"];

// CSV テキスト → 編集可能な行配列。戻り: { rows, headerError, warnings }。
//   rows[i] = { localId, parent, task, type, assignee, est_hours, depends_on:string[], due, done_criteria }
function parsePlanRows(text) {
  const warnings = [];
  const grid = parseCsvGrid(text);
  if (grid.length === 0) return { rows: [], headerError: "CSV が空です。", warnings };
  const header = grid[0].map((h) => h.trim());
  const missing = NEED_COLS.filter((n) => header.indexOf(n) < 0);
  const headerError = missing.length ? `ヘッダ列が不足: ${missing.join(", ")}` : "";
  const col = (rec, name) => { const i = header.indexOf(name); return i >= 0 ? (rec[i] || "").trim() : ""; };

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const rec = grid[r];
    const localId = col(rec, "id");
    if (!localId) { warnings.push(`${r} 行目: id（CSVローカルID）が空のため取り込みません。`); continue; }
    rows.push({
      localId,
      parent: col(rec, "parent"),
      task: col(rec, "task"),
      type: col(rec, "type") || "PJ",
      assignee: col(rec, "assignee"),
      est_hours: col(rec, "est_hours"),
      depends_on: col(rec, "depends_on").split(",").map((d) => d.trim()).filter(Boolean),
      due: col(rec, "due"),
      done_criteria: col(rec, "done_criteria"),
    });
  }
  return { rows, headerError, warnings };
}

// B7: 冪等マーカー <!--keikaku:plan=..;id=..--> を壊す文字（区切りの ";" / 終端の "-->"）を含むか。
//   これらが localId / planId に入るとマーカーが誤パースされ「更新」でなく「重複作成」になるため投入を止める。
const breaksMarker = (s) => { const v = s == null ? "" : String(s); return v.includes("-->") || v.includes(";"); };

// 編集後の行配列を検証（構造のみ。担当の未解決警告は別途 asgInfo から積む）。
//   planId は冪等モードの計画ID（マーカー破壊チェック用。空なら非冪等モード）。
//   戻り: { errors, warnings }。errors があれば投入不可。
function validateRows(rows, planId = "") {
  const errors = [], warnings = [];
  if (!rows.length) { errors.push("データ行がありません。"); return { errors, warnings }; }
  // B7: 計画ID自体がマーカーを壊す文字を含む場合（";" は sanitize 済みのため主に "-->" を弾く）。
  if (breaksMarker(planId)) errors.push(`計画ID「${planId}」に使えない文字（";" または "-->"）が含まれています。除いてから投入してください。`);
  const ids = new Set(rows.map((r) => r.localId));
  const seen = new Set();
  for (const r of rows) {
    if (!r.task || !r.task.trim()) errors.push(`id「${r.localId}」: タスク名が空です。`);
    // B7: localId がマーカーの区切り/終端を壊すと冪等再投入で重複作成になる。
    if (breaksMarker(r.localId)) errors.push(`id「${r.localId}」に使えない文字（";" または "-->"）が含まれています（冪等マーカーを壊すため変更してください）。`);
    if (seen.has(r.localId)) errors.push(`id「${r.localId}」が重複しています（一意にしてください）。`);
    seen.add(r.localId);
    if (r.parent && !ids.has(r.parent)) warnings.push(`id「${r.localId}」の親「${r.parent}」が表内に存在しません。`);
    for (const d of r.depends_on) if (!ids.has(d)) warnings.push(`id「${r.localId}」の依存先「${d}」が表内に存在しません。`);
    // 改修G: 負の見積は投入時に「見積なし」扱いになる（混乱防止に警告）。
    const estNum = parseFloat(r.est_hours);
    if (r.est_hours != null && r.est_hours !== "" && !Number.isNaN(estNum) && estNum < 0)
      warnings.push(`id「${r.localId}」の見積(${r.est_hours}h)が負の値です。投入時は見積なしとして扱います。`);
  }
  return { errors, warnings };
}

const isProjectRow = (r) => r.type === "project";

// ── 改修1: 担当の名前解決 ─────────────────────────────────────────────────
// resolveAssigneeInfo: 表示にも使える { id, status, label } を返す。
//   status: empty(担当なし) / numeric(数値ID) / self(自分) / resolved(検索一致) / unresolved(未解決) / pending(解決中)
//   - 空/falsy → empty
//   - 数値 → numeric（Number 化）
//   - "自分"・"me"・me.username・me.name のいずれかに一致（trim比較）→ self（me.id）
//   - それ以外 → searchUsers(raw)。username が raw と完全一致する要素が「ちょうど1件」なら resolved、
//     0件/複数/エラーは unresolved（投入時スキップ）。
async function resolveAssigneeInfo(raw, me) {
  const s = (raw == null ? "" : String(raw)).trim();
  if (!s) return { id: null, status: "empty", label: "" };
  if (/^\d+$/.test(s)) return { id: Number(s), status: "numeric", label: `#${s}` };
  const selfNames = ["自分", "me", me && me.username, me && me.name]
    .filter(Boolean).map((x) => String(x).trim());
  if (me && me.id != null && selfNames.includes(s)) {
    return { id: me.id, status: "self", label: `${me.name || me.username || "自分"}(#${me.id})` };
  }
  try {
    const list = await vik.searchUsers(s);
    const matches = (list || []).filter((u) => ((u.username || "").trim() === s));
    if (matches.length === 1) {
      const u = matches[0];
      return { id: u.id, status: "resolved", label: `${u.username}(#${u.id})` };
    }
    return { id: null, status: "unresolved", label: `${s}(未解決)` };
  } catch {
    return { id: null, status: "unresolved", label: `${s}(未解決)` };
  }
}

// ── 改修2: 営業日逆算（Q12: capacity.js の isBusinessDay/shiftISO を再利用し ISO文字列空間で計算）─────
//   営業日判定・日付加減算は capacity.js（lib/capacity.js）に単一実装があるのでそれを使う。
//   capacity.js のシグネチャ: isBusinessDay(iso, holidays=null) / shiftISO(iso, days)。holidays は Set<"YYYY-MM-DD">。
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
// end（YYYY-MM-DD）から手前へ営業日を days 個カウントし、days 個目の営業日（=開始日）を返す。
//   end が非営業日でもそこから手前に向かってカウント（end 含めて days 個の営業日を確保）。
//   ※自前 Date 実装からの移植。振る舞いは厳密に不変（旧実装と全期間で一致を確認済み）。
function computeStartBusinessDay(endYmd, days, holidaysSet) {
  let cur = endYmd;
  let count = 0, guard = 0;
  let start = cur;
  while (count < days && guard < 4000) {
    if (isBusinessDay(cur, holidaysSet)) { count++; if (count === days) { start = cur; break; } }
    cur = shiftISO(cur, -1);
    guard++;
  }
  return start;
}
// 行の期間プレビュー（est_hours>0 かつ due があるときのみ）。戻り: { start, end, days } or null。
function periodInfo(r, capH, holidaysSet) {
  const est = parseFloat(r.est_hours);
  if (!isValidYmd(r.due) || !(r.est_hours !== "" && !Number.isNaN(est) && est > 0)) return null;
  const days = Math.max(1, Math.ceil(est / (capH || 8)));
  return { start: computeStartBusinessDay(r.due, days, holidaysSet), end: r.due, days };
}
const fmtMd = (ymd) => { const p = (ymd || "").split("-"); return p.length === 3 ? `${p[1]}/${p[2]}` : (ymd || ""); };

// ── 改修3: 冪等マーカー（import.py の取り込みと同形式。HTMLコメントなので説明欄に描画されない）──
//   description 末尾に改行2つ＋ <!--keikaku:plan=<planId>;id=<localId>--> を付与。
const sanitizePlanId = (s) => (s == null ? "" : String(s)).trim().replace(/;/g, "");
const markerStr = (planId, localId) => `<!--keikaku:plan=${planId};id=${localId}-->`;
// plan は sanitizePlanId で ";" を除去済み＝ [^;] で安全に拾える。
const markerRe = () => /<!--keikaku:plan=([^;]*?);id=(.*?)-->/g; // 毎回新規（exec の lastIndex 共有を避ける）
// 改修H: マーカーは末尾付与なので、本文中の偽マーカーに惑わされず**最後の一致**を採用する。
//   戻り: { plan, localId } or null。
function lastMarker(desc) {
  const re = markerRe();
  let m, last = null;
  while ((m = re.exec(String(desc || ""))) !== null) last = { plan: m[1], localId: m[2] };
  return last;
}
// 既存マーカーを全除去（冪等更新で多重付与しないため。書込前に必ず通す）。
const stripMarkers = (s) => String(s || "").replace(markerRe(), "");

const EMPTY_DATE = "0001-01-01T00:00:00Z"; // capacity.js hasDate が "0001" 始まりを空判定＝クリア用

// 行 → createTaskInProject / updateTask の body。
//   capH/holidaysSet は期間逆算用。markerInfo={planId,localId} があれば description にマーカー付与（冪等モード）。
//   forUpdate=true（冪等更新の updateTask 経路）では、計画から外した値を**明示クリア**する（改修E）。
//     - 新規作成（createTaskInProject）では従来どおり省略＝クリア不要。
function taskBody(r, capH, holidaysSet, markerInfo, forUpdate = false) {
  const body = { title: r.task };
  // 改修H: done基準から既存マーカーを全除去してから1つだけ付け直す（多重マーカー防止）。
  let desc = stripMarkers(r.done_criteria || "").trimEnd();
  if (markerInfo && markerInfo.planId) {
    const m = markerStr(markerInfo.planId, markerInfo.localId);
    desc = desc ? desc + "\n\n" + m : m;
  }
  if (desc) body.description = desc;
  else if (forUpdate) body.description = ""; // 冪等更新: done基準・マーカーとも空ならクリア

  const est = parseFloat(r.est_hours);
  const estValid = r.est_hours != null && r.est_hours !== "" && !Number.isNaN(est);
  // 改修G: est>0 のときだけ time_estimate を送る（0/負は import.py と同様に「見積なし」）。
  const estPositive = estValid && est > 0;
  if (estPositive) body.time_estimate = Math.round(est * 3600);
  else if (forUpdate) body.time_estimate = 0; // 改修E: 見積を外したら旧見積をクリア

  if (isValidYmd(r.due)) {
    body.due_date = r.due + "T00:00:00Z";
    // Q28: 期間逆算は periodInfo に一本化（est>0 かつ due 妥当のとき非nullを返す＝estPositive と同条件）。
    const pi = periodInfo(r, capH, holidaysSet);
    if (pi) {
      body.start_date = pi.start + "T00:00:00Z"; // ガントが source:"dates" で期間バー表示
      body.end_date = pi.end + "T00:00:00Z";     // pi.end === r.due
    } else if (forUpdate) {
      // 改修E: due はあるが見積なし＝期間バーの根拠が無い → start/end をクリア（due 点は残す）。
      body.start_date = EMPTY_DATE;
      body.end_date = EMPTY_DATE;
    }
  } else if (forUpdate) {
    // 改修E: due を外したら due/期間を全クリア。
    body.due_date = EMPTY_DATE;
    body.start_date = EMPTY_DATE;
    body.end_date = EMPTY_DATE;
  }
  return body;
}

// 担当の解決状態の表示 HTML（テーブルセル用）。
function asgStatusHtml(info) {
  if (!info || info.status === "empty") return `<span class="k-asg none">担当なし</span>`;
  if (info.status === "pending") return `<span class="k-asg pending">解決中…</span>`;
  if (info.status === "unresolved") return `<span class="k-asg unresolved">${esc(info.label)}・スキップ</span>`;
  return `<span class="k-asg ok">${esc(info.label)}</span>`;
}

export async function render(root) {
  const { projects, me, settings, holidaysSet } = await load();
  const capH = (settings && settings.capH) || 8;
  const holiSet = holidaysSet || new Set();
  const wsList = (projects || []).filter((p) => p && p.id > 0);
  // 既定 WS: 「インボックス」があればそれ、無ければ先頭。
  const defaultWs = (wsList.find((p) => p.title === "インボックス") || wsList[0] || null);

  // 画面ローカル状態（このビュー内で閉じる）。state.rows が読み込み後の真実のデータ。
  const state = {
    wsId: defaultWs ? defaultWs.id : null,
    loaded: false,
    rows: [],                 // 編集可能な行
    asgInfo: new Map(),       // localId → resolveAssigneeInfo の戻り
    headerError: "",
    parseWarnings: [],
    agreed: false,
    importing: false,
    dirty: false,            // 改修M: 読み込み後に表が手編集されたか（再読込の破棄確認用）
    _errors: [],
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
          <div class="keikaku-row">
            <label class="keikaku-lbl" for="keikaku-plan">計画ID（任意）</label>
            <input id="keikaku-plan" class="keikaku-pid" type="text" spellcheck="false"
              placeholder="例: onboarding-2026q3">
          </div>
          <div class="keikaku-hint">再投入時に同じIDを入れると重複作成せず既存を更新します。空欄なら毎回新規作成。</div>

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
            <div class="keikaku-empty">「読み込む」を押すと編集できるWBS表が表示されます。</div>
          </div>
        </section>
      </div>
    </div>`;

  const wsEl = root.querySelector("#keikaku-ws");
  const planEl = root.querySelector("#keikaku-plan");
  const csvEl = root.querySelector("#keikaku-csv");
  const reviewEl = root.querySelector("#keikaku-review");

  // renderReview で生成される永続コンテナ参照（編集中の部分更新に使う）。
  let msgsEl = null, tblEl = null, summaryEl = null, warnboxEl = null, agreeRowEl = null;

  const currentPlanId = () => sanitizePlanId(planEl.value);
  const wsName = () => { const w = wsList.find((p) => p.id === state.wsId); return w ? w.title : "（未選択）"; };

  wsEl.onchange = () => { state.wsId = wsEl.value ? Number(wsEl.value) : null; if (state.loaded) updateDerived(); };
  planEl.oninput = () => { if (state.loaded) updateDerived(); };

  root.querySelector("#keikaku-parse").onclick = () => {
    // 改修M: 手編集後の再読込は無警告で破棄せず、確認してから置換する。
    if (state.loaded && state.dirty && typeof window !== "undefined" && window.confirm) {
      if (!window.confirm("表の編集内容を破棄してCSVから再読込しますか？")) return;
    }
    const parsed = parsePlanRows(csvEl.value);
    state.rows = parsed.rows;
    state.headerError = parsed.headerError;
    state.parseWarnings = parsed.warnings;
    state.agreed = false;
    state.loaded = true;
    state.dirty = false;
    // 担当は一旦「解決中」表示で出し、非同期で解決→反映。
    state.asgInfo = new Map(state.rows.map((r) => [r.localId, { id: null, status: "pending", label: "" }]));
    renderReview();
    // 改修L: 解決完了後に renderTable で全再構築するとフォーカス/IME を壊すので、
    //   担当セルだけ localId 単位で差し替える（refreshAllAsgCells）。
    resolveAllAssignees().then(() => { if (state.loaded) { refreshAllAsgCells(); updateDerived(); } });
  };

  // B6: localId ごとの解決世代トークン。最新の解決だけが asgInfo に書ける（stale write スキップ）。
  //   resolveAllAssignees（一括）と reResolveRow（単行）が同じ localId を並行解決したとき、
  //   古い解決の await 完了が新しい結果を踏み潰すのを防ぐ。単調増加なので reset 不要（再読込後も安全）。
  const asgGen = new Map();
  const bumpAsgGen = (lid) => { const n = (asgGen.get(lid) || 0) + 1; asgGen.set(lid, n); return n; };

  // 全行の担当を解決して asgInfo を更新（改修L）。
  //   await 前に行参照をキャプチャし、await 後に state.rows を再 map しない（行追加/削除と競合させない）。
  //   B6: 各行は解決開始時にトークンを発行し、書き戻し直前に最新トークンと一致する時のみ反映（stale write スキップ）。
  //   await 中に消えた行のエントリは枝刈りする（pending 残留で投入が永久ブロックされるのを防ぐ）。
  async function resolveAllAssignees() {
    const captured = state.rows.slice();
    await Promise.all(captured.map(async (r) => {
      const lid = r.localId, tok = bumpAsgGen(lid);
      const info = await resolveAssigneeInfo(r.assignee, me);
      if (asgGen.get(lid) === tok) state.asgInfo.set(lid, info); // 最新の解決だけが勝つ
    }));
    const live = new Set(state.rows.map((r) => r.localId));
    for (const k of [...state.asgInfo.keys()]) if (!live.has(k)) state.asgInfo.delete(k);
  }

  // 担当ステータスセルを localId で引く（idx 非依存＝行削除でズレない／改修K）。
  function asgCellByLid(lid) {
    if (!tblEl) return null;
    return [...tblEl.querySelectorAll("[data-asg-lid]")].find((el) => el.dataset.asgLid === lid) || null;
  }
  // 全行の担当セルを現在の asgInfo で差し替え（改修L: テーブル全再構築を避ける）。
  function refreshAllAsgCells() {
    if (!tblEl) return;
    for (const r of state.rows) {
      const cell = asgCellByLid(r.localId);
      if (cell) cell.innerHTML = asgStatusHtml(state.asgInfo.get(r.localId));
    }
  }

  // 未使用の一意 localId を採番。
  function genLocalId() {
    const ids = new Set(state.rows.map((r) => r.localId));
    let n = 1; while (ids.has("T" + n)) n++; return "T" + n;
  }

  // ── 描画ヘルパ（クロージャ＝state/refs を参照） ───────────────────────────
  const TYPE_OPTS = [["project", "プロジェクト"], ["PJ", "PJ（子）"], ["定常", "定常（子）"]];

  function periodCellHtml(r) {
    const pi = periodInfo(r, capH, holiSet);
    if (pi) return `<span class="k-period">${fmtMd(pi.start)}〜${fmtMd(pi.end)}<small>${pi.days}営業日</small></span>`;
    if (isValidYmd(r.due)) return `<span class="k-period">〜${fmtMd(r.due)}<small>点</small></span>`;
    return `<span class="k-period none">—</span>`;
  }

  // 改修F: 親列の選択肢（空=WS直下＋他行の localId。自分自身は除外）。ラベルは「localId: タスク名」。
  function parentOptionsHtml(r) {
    const opts = [`<option value=""${!r.parent ? " selected" : ""}>WS直下</option>`];
    for (const o of state.rows) {
      if (o.localId === r.localId) continue;
      opts.push(`<option value="${esc(o.localId)}"${r.parent === o.localId ? " selected" : ""}>${esc(o.localId + ": " + (o.task || "(無題)"))}</option>`);
    }
    // 表内に無い親を指している場合も選択状態を保持（CSVの親が表外＝警告対象だが消さない）。
    if (r.parent && !state.rows.some((o) => o.localId === r.parent))
      opts.push(`<option value="${esc(r.parent)}" selected>${esc(r.parent)}（表内に無し）</option>`);
    return opts.join("");
  }

  function rowHtml(r, idx) {
    const info = state.asgInfo.get(r.localId);
    const typeOpts = TYPE_OPTS.map(([v, l]) => `<option value="${v}"${r.type === v ? " selected" : ""}>${esc(l)}</option>`).join("");
    return `<tr class="${isProjectRow(r) ? "is-project" : "is-child"}">
      <td><select class="k-in k-type" data-idx="${idx}" data-field="type">${typeOpts}</select></td>
      <td class="k-localid">${esc(r.localId)}</td>
      <td><select class="k-in k-parent" data-idx="${idx}" data-field="parent">${parentOptionsHtml(r)}</select></td>
      <td><input class="k-in k-task" data-idx="${idx}" data-field="task" value="${esc(r.task)}" placeholder="タスク名"></td>
      <td><input class="k-in k-asg-in" data-idx="${idx}" data-field="assignee" value="${esc(r.assignee)}" placeholder="自分 / 森田 / 7">
        <div class="k-asg-st" data-asg-lid="${esc(r.localId)}">${asgStatusHtml(info)}</div></td>
      <td><input class="k-in k-est" type="number" min="0" step="0.25" data-idx="${idx}" data-field="est_hours" value="${esc(r.est_hours)}"></td>
      <td><input class="k-in k-due" type="date" data-idx="${idx}" data-field="due" value="${esc(r.due)}"></td>
      <td class="k-period-td" data-period="${idx}">${periodCellHtml(r)}</td>
      <td><input class="k-in k-dep" data-idx="${idx}" data-field="depends_on" value="${esc(r.depends_on.join(","))}" placeholder="例: 2,3"></td>
      <td><input class="k-in k-done" data-idx="${idx}" data-field="done_criteria" value="${esc(r.done_criteria)}" placeholder="Done基準"></td>
      <td class="k-del-td"><button class="k-del" data-act="del" data-idx="${idx}" type="button" title="行を削除" aria-label="行を削除">${icon("x") || "✕"}</button></td>
    </tr>`;
  }

  // テーブルのみ再構築（行の追加・削除時のみ呼ぶ。編集中は呼ばない＝フォーカスを飛ばさない）。
  function renderTable() {
    if (!tblEl) return;
    tblEl.innerHTML = `
      <div class="keikaku-tablewrap">
        <table class="keikaku-table">
          <thead><tr>
            <th>種別</th><th>ID</th><th>親</th><th>タスク名</th><th>担当</th><th>見積(h)</th>
            <th>due</th><th>期間</th><th>依存(先行)</th><th>Done基準</th><th></th>
          </tr></thead>
          <tbody>${state.rows.map((r, i) => rowHtml(r, i)).join("")}</tbody>
        </table>
      </div>
      <div class="keikaku-tbl-actions">
        <button id="keikaku-addrow" class="keikaku-btn k-addbtn" type="button">${icon("plus") || "＋"}行を追加</button>
      </div>`;
    const addBtn = tblEl.querySelector("#keikaku-addrow");
    if (addBtn) addBtn.onclick = addRow;
  }

  function summaryHtml() {
    const projectCount = state.rows.filter(isProjectRow).length;
    const childCount = state.rows.length - projectCount;
    const depCount = state.rows.reduce((s, r) => s + r.depends_on.length, 0);
    const totalEst = state.rows.reduce((s, r) => { const e = parseFloat(r.est_hours); return s + (Number.isNaN(e) ? 0 : e); }, 0);
    return `<span class="k-sum-it"><b>${projectCount}</b> プロジェクト親</span>
      <span class="k-sum-it"><b>${childCount}</b> 子タスク</span>
      <span class="k-sum-it"><b>${depCount}</b> 依存</span>
      <span class="k-sum-it">見積計 <b>${fmtH(totalEst)}</b></span>
      <span class="k-sum-it">投入先 <b>${esc(wsName())}</b></span>`;
  }

  function msgHtml(errors, warnings) {
    const e = errors.length
      ? `<div class="keikaku-msg err">${icon("alertTriangle") || ""}<div>${errors.map(esc).join("<br>")}</div></div>` : "";
    const w = warnings.length
      ? `<div class="keikaku-msg warn">${icon("alertTriangle") || ""}<div>${warnings.map(esc).join("<br>")}</div></div>` : "";
    return e + w;
  }

  const importDisabled = (errors) => {
    if (!state.wsId || state.importing || errors.length || !state.rows.length) return true;
    // 改修J: 担当解決が pending の間は投入不可（解決完了まで＝スキップ予告 warning が出る前に投入させない）。
    for (const r of state.rows) { const info = state.asgInfo.get(r.localId); if (info && info.status === "pending") return true; }
    if (!currentPlanId() && !state.agreed) return true; // 非冪等モードのみ同意必須
    return false;
  };

  // 軽い派生表示のみ部分更新（テーブルは触らない）。
  function updateDerived() {
    if (!state.loaded) return;
    const planId = currentPlanId();
    const val = validateRows(state.rows, planId);
    const asgWarn = [];
    for (const r of state.rows) {
      const info = state.asgInfo.get(r.localId);
      if (info && info.status === "unresolved") asgWarn.push(`id「${r.localId}」の担当「${(r.assignee || "").trim()}」は未解決のため投入時にスキップされます。`);
    }
    const errors = [...(state.headerError ? [state.headerError] : []), ...val.errors];
    const warnings = [...val.warnings, ...asgWarn, ...(state.parseWarnings || [])];
    state._errors = errors;
    if (msgsEl) msgsEl.innerHTML = msgHtml(errors, warnings);
    if (summaryEl) summaryEl.innerHTML = summaryHtml();
    if (warnboxEl) {
      warnboxEl.className = "keikaku-warnbox" + (planId ? " ok" : "");
      warnboxEl.innerHTML = planId
        ? `${icon("check") || ""}<span><b>冪等モード（計画ID: ${esc(planId)}）。</b>同じIDの既存タスクは更新し、重複作成しません。</span>`
        : `${icon("alertTriangle") || ""}<span><b>再実行は重複作成します（冪等性なし）。</b>同じ計画を二度投入しないでください。計画IDを入れると重複を防げます。</span>`;
    }
    if (agreeRowEl) agreeRowEl.style.display = planId ? "none" : "";
    const btn = reviewEl.querySelector("#keikaku-import");
    if (btn) btn.disabled = importDisabled(errors);
  }

  // 1行の担当セルのみ再解決＋更新（assignee の入力確定時）。改修K: idx でなく行参照（localId）で更新＝
  //   await 中に行が削除されてもセルがズレない。raw/localId は await 前に確定させる。
  async function reResolveRow(r) {
    if (!r) return;
    const lid = r.localId, raw = r.assignee, tok = bumpAsgGen(lid); // B6: 解決開始時にトークン発行
    const info = await resolveAssigneeInfo(raw, me);
    if (asgGen.get(lid) !== tok) return; // 後発の解決に追い越された＝stale なので破棄
    state.asgInfo.set(lid, info);
    const cell = asgCellByLid(lid);
    if (cell) cell.innerHTML = asgStatusHtml(info);
    updateDerived();
  }

  function updatePeriodCell(idx) {
    const r = state.rows[idx];
    if (!r) return;
    const cell = tblEl && tblEl.querySelector(`[data-period="${idx}"]`);
    if (cell) cell.innerHTML = periodCellHtml(r);
  }

  // セル編集（input/change 委譲）。該当フィールドだけ state.rows に反映し、軽い派生のみ更新。
  function onEdit(e) {
    if (state.importing) return; // 改修I: 投入中は編集を無視（await 間の index ズレ/誤割当を防ぐ）
    const el = e.target;
    if (!el || el.dataset == null) return;
    const idxRaw = el.dataset.idx, field = el.dataset.field;
    if (idxRaw == null || !field) return;
    const idx = Number(idxRaw);
    const r = state.rows[idx];
    if (!r) return;
    const v = el.value;
    if (field === "depends_on") r.depends_on = v.split(",").map((s) => s.trim()).filter(Boolean);
    else r[field] = v;
    state.dirty = true; // 改修M: 手編集の形跡
    if (field === "est_hours" || field === "due") updatePeriodCell(idx);
    if (field === "assignee") { if (e.type === "change") reResolveRow(r); return; } // 改修K: 行参照で再解決
    updateDerived();
  }

  // 削除ボタン（委譲）。
  function onTblClick(e) {
    if (state.importing) return; // 改修I: 投入中は削除不可
    const btn = e.target.closest && e.target.closest("[data-act='del']");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isNaN(idx)) return;
    const removed = state.rows.splice(idx, 1)[0];
    if (removed) state.asgInfo.delete(removed.localId); // 枝刈り（pending 残留で投入がブロックされるのを防ぐ）
    state.dirty = true; // 改修M
    renderTable();   // 削除はインデックスがずれるので再構築
    updateDerived();
  }

  // 行を追加（空の子=PJ、localId 自動採番）。
  function addRow() {
    if (state.importing) return; // 改修I: 投入中は追加不可
    const id = genLocalId();
    state.rows.push({ localId: id, parent: "", task: "", type: "PJ", assignee: "", est_hours: "", depends_on: [], due: "", done_criteria: "" });
    state.asgInfo.set(id, { id: null, status: "empty", label: "" });
    state.dirty = true; // 改修M
    renderTable();
    updateDerived();
  }

  // レビュー＋編集パネルの骨格を構築（読み込み時 / WS変更では呼ばない＝updateDerived で済む）。
  function renderReview() {
    if (!state.loaded) {
      reviewEl.innerHTML = `<div class="keikaku-empty">「読み込む」を押すと編集できるWBS表が表示されます。</div>`;
      return;
    }
    reviewEl.innerHTML = `
      <div id="keikaku-msgs"></div>
      <div id="keikaku-tbl"></div>
      <div id="keikaku-summary" class="keikaku-summary"></div>
      <div id="keikaku-warnbox" class="keikaku-warnbox"></div>
      <label id="keikaku-agreerow" class="keikaku-agree">
        <input type="checkbox" id="keikaku-agree"${state.agreed ? " checked" : ""}>
        重複作成のリスクを理解し、このワークスペースに投入します
      </label>
      <div class="keikaku-actions">
        <button id="keikaku-import" class="keikaku-btn primary">${icon("save") || ""}taskstation に投入</button>
        <span id="keikaku-progress" class="keikaku-progress"></span>
      </div>
      <div id="keikaku-result"></div>`;

    msgsEl = reviewEl.querySelector("#keikaku-msgs");
    tblEl = reviewEl.querySelector("#keikaku-tbl");
    summaryEl = reviewEl.querySelector("#keikaku-summary");
    warnboxEl = reviewEl.querySelector("#keikaku-warnbox");
    agreeRowEl = reviewEl.querySelector("#keikaku-agreerow");

    // 委譲リスナは永続コンテナ tblEl に 1 度だけ（テーブル再構築は innerHTML 差し替えなので維持）。
    tblEl.addEventListener("input", onEdit);
    tblEl.addEventListener("change", onEdit);
    tblEl.addEventListener("click", onTblClick);

    const agreeEl = reviewEl.querySelector("#keikaku-agree");
    if (agreeEl) agreeEl.onchange = () => { state.agreed = agreeEl.checked; updateDerived(); };
    const importBtn = reviewEl.querySelector("#keikaku-import");
    if (importBtn) importBtn.onclick = () => runImport();

    renderTable();
    updateDerived();
  }

  // ── 投入（フェーズ0=既存検出 / A=生成・更新 / B=親子 / C=依存 / D=担当）。
  //   冪等モード（planId 非空）は既存タスクを差分同期（reconcile）し、重複add/旧リンク残りを防ぐ（改修C/D）。
  async function runImport() {
    if (state.importing || !state.loaded) return;
    const errors = state._errors || [];
    if (!state.rows.length || !state.wsId || errors.length) return;
    const planId = currentPlanId();
    if (!planId && !state.agreed) return;

    if (typeof window !== "undefined" && window.confirm) {
      const msg = planId
        ? `「${wsName()}」に計画ID「${planId}」で投入します。\n同じIDの既存タスクは更新し、表から外した依存/担当/親子は同期（削除）します。\n表から行ごと削除したタスク本体は安全のため自動削除せず残します（それへの関連は除去・本体が要らなければ手動削除）。よろしいですか？`
        : `「${wsName()}」に ${state.rows.length} 件のタスクを新規作成します。\n再実行は重複作成になります。投入してよろしいですか？`;
      if (!window.confirm(msg)) return;
    }

    state.importing = true;
    const importBtn = reviewEl.querySelector("#keikaku-import");
    const progEl = reviewEl.querySelector("#keikaku-progress");
    const resultEl = reviewEl.querySelector("#keikaku-result");
    const agreeEl = reviewEl.querySelector("#keikaku-agree");
    if (importBtn) importBtn.disabled = true;
    if (agreeEl) agreeEl.disabled = true;
    if (resultEl) resultEl.innerHTML = "";
    const setTableLocked = (locked) => { if (tblEl) tblEl.classList.toggle("k-locked", locked); };
    setTableLocked(true); // 改修I: 投入中はテーブルを操作不可に

    // 改修I: 投入直前に行の**スナップショット**を取り、全フェーズ・再解決でこれを使う（state.rows を直接走査しない）。
    const rows = state.rows.slice();

    const failures = [];   // 操作失敗（赤）
    const notes = [];      // 注意（黄・孤児化など）
    const idmap = new Map(); // CSVローカルID → 実ID
    const swallow = !!planId; // 冪等モードは relation/assignee の add 重複(4xx)のみ握る

    // 例外ハンドラ（改修C）: 握ってよいのは「既存重複」(dup=409/400)と削除時の不在(missing=404)だけ。
    //   AuthError（セッション切れ）は絶対に握らず投入を即中断（throw で上流の abort へ）。
    //   status>=500・ネットワークエラー等は failures に積む。
    //   ※重複時の HTTP ステータスはサーバ依存ゆえ 409/400 をまとめて重複とみなす。
    const isDup = (e) => e && (e.status === 409 || e.status === 400);
    const handleErr = (e, msg, { dup = false, missing = false } = {}) => {
      if (e instanceof vik.AuthError) throw e;
      if (dup && isDup(e)) return;
      if (missing && e && e.status === 404) return;
      failures.push(`${msg}: ${esc((e && e.message) || e)}`);
    };
    // 中断クリーンアップ（fail-closed / AuthError 共通）。
    const abort = (htmlMsg) => {
      state.importing = false;
      if (progEl) progEl.textContent = "";
      if (importBtn) importBtn.disabled = false;
      if (agreeEl) agreeEl.disabled = false;
      setTableLocked(false);
      if (resultEl) resultEl.innerHTML = `<div class="keikaku-msg err"><div>${htmlMsg}</div></div>`;
      updateDerived();
    };

    // 投入直前に担当を必ず再解決（スナップショット rows ベース）。
    let asgResolved;
    try { asgResolved = await Promise.all(rows.map((r) => resolveAssigneeInfo(r.assignee, me))); }
    catch { asgResolved = rows.map(() => ({ id: null, status: "unresolved", label: "" })); }

    // ── フェーズ0: 冪等モードの既存検出（WS内・done込み・全ページ）。改修A/B/H ──
    //   localId → 既存タスクオブジェクト（related_tasks/assignees 入り＝reconcile に使う）。
    const existing = new Map();
    const orphanPlanIds = new Set(); // B2: 計画から外した（現rowsに無い）既存タスクの実ID。関連除去のため計画管理IDに含める。
    if (planId) {
      let all;
      try {
        all = await vik.getProjectTasksAll(state.wsId); // 改修A: WSスコープ・全ページ（getTasks の全WS横断+50件頭打ちを回避）
      } catch (e) {
        // 改修B: 既存検出に失敗したら fail-closed＝1件も作らず中断（重複作成より中断が安全）。
        return abort(e instanceof vik.AuthError
          ? esc("セッションが切れました。再ログインしてから投入し直してください（何も作成していません）。")
          : `既存タスクの検出に失敗したため投入を中止しました（重複作成を防ぐため何も作成していません）: ${esc((e && e.message) || e)}`);
      }
      const dupLids = [];
      for (const t of all || []) {
        const lm = lastMarker(t.description); // 改修H: 末尾の最後の一致を採用
        if (lm && lm.plan === planId) {
          if (existing.has(lm.localId)) dupLids.push(lm.localId); // 改修A: 同一localIdマーカーが複数
          existing.set(lm.localId, t); // 後勝ち
        }
      }
      if (dupLids.length) {
        const uniq = [...new Set(dupLids)];
        notes.push(`計画ID「${esc(planId)}」で同一マーカーを持つ既存タスクが重複している localId: ${uniq.map(esc).join("、")}（最後の1件のみ更新対象。他は孤児化するので手動で整理してください）。`);
      }
      // B2: 既存マーカー付きタスクのうち、現在の表（rows）に無い localId ＝ 計画から外したタスク。
      //   本体は破壊回避で自動削除しないが、その実IDを計画管理ID集合に含め（後段 planIds へ）、
      //   他行から削除タスクへ向く依存/親子の stale リンクを除去ループで掃除させる。
      //   （孤児本体の担当は phase D が rows しか回さないため触らない＝本体と共に残る。）
      const rowLids = new Set(rows.map((r) => r.localId));
      for (const [lid, t] of existing) {
        if (!rowLids.has(lid) && t && t.id != null) orphanPlanIds.add(t.id);
      }
      if (orphanPlanIds.size)
        notes.push(`計画から外したタスク ${orphanPlanIds.size} 件が「${esc(wsName())}」に残存しています（他タスクからそれらへ向いていた依存/親子は同期削除しましたが、タスク本体は安全のため自動削除していません。不要なら手動で削除してください）。`);
    }

    const parentOps = rows.filter((r) => r.parent).length;
    const depOps = rows.reduce((s, r) => s + r.depends_on.length, 0);
    const asgOps = asgResolved.filter((a) => a.id != null).length;
    const totalOps = rows.length + parentOps + depOps + asgOps;
    let done = 0;
    const tick = (label) => { done++; if (progEl) progEl.textContent = `${label}… ${Math.min(done, totalOps)}/${totalOps}`; };

    // 集計（改修N）
    let created = 0, updated = 0;
    let parentAdd = 0, parentDel = 0, parentKeep = 0;
    let depAdd = 0, depDel = 0, depKeep = 0;
    let asgAdd = 0, asgDel = 0, asgKeep = 0;
    const skippedAssignees = [];

    try {
      // ── フェーズA: 生成 or 更新（冪等更新は forUpdate=true で旧値クリア・改修E）──
      for (const r of rows) {
        const isUpdate = !!(planId && existing.has(r.localId));
        const body = taskBody(r, capH, holiSet, planId ? { planId, localId: r.localId } : null, isUpdate);
        try {
          if (isUpdate) {
            const tid = existing.get(r.localId).id;
            await vik.updateTask(tid, body);
            idmap.set(r.localId, tid); updated++;
          } else {
            const res = await vik.createTaskInProject(state.wsId, body);
            if (res && res.id != null) { idmap.set(r.localId, res.id); created++; }
            else failures.push(`id「${r.localId}」生成: 応答に id がありません`);
          }
        } catch (e) {
          handleErr(e, `id「${r.localId}」(${esc(r.task)}) ${isUpdate ? "更新" : "生成"}失敗`);
        }
        tick("投入中");
      }

      // 既存リンク削除は「この計画が管理する実ID」内に限定＝外部で手動付与した関連を巻き込まない（安全策）。
      // B2: create/update した実ID ＋ 計画から外した孤児タスクの実ID。孤児を含めることで、
      //   削除行へ向く stale な依存/親子が下の除去ループの planIds ガードを通過し、確実に掃除される。
      const planIds = new Set(idmap.values());
      for (const id of orphanPlanIds) planIds.add(id);
      const relIds = (obj, kind) => new Set((((obj && obj.related_tasks) || {})[kind] || []).map((x) => x && x.id).filter((id) => id != null));

      // ── フェーズB: parenttask（child を taskId 側）。冪等モードは差分同期（改修D）──
      for (const r of rows) {
        const child = idmap.get(r.localId);
        const have = relIds(existing.get(r.localId), "parenttask");
        const tp = r.parent ? idmap.get(r.parent) : null;
        const want = new Set(tp != null ? [tp] : []);
        if (child != null) {
          for (const p of want) {
            if (have.has(p)) parentKeep++;
            else { try { await vik.addRelation(child, p, "parenttask"); parentAdd++; } catch (e) { handleErr(e, `id「${r.localId}」親子付け失敗`, { dup: swallow }); } }
          }
          for (const p of have) {
            if (want.has(p) || !planIds.has(p)) continue; // 計画管理外の親は触らない
            try { await vik.removeRelation(child, "parenttask", p); parentDel++; } catch (e) { handleErr(e, `id「${r.localId}」親子解除失敗`, { missing: true }); }
          }
        }
        if (r.parent) tick("親子付け中");
      }

      // ── フェーズC: follows（T が D に依存 → T が follows 側）。冪等モードは差分同期（改修D）──
      for (const r of rows) {
        const t = idmap.get(r.localId);
        const have = relIds(existing.get(r.localId), "follows");
        const want = new Set();
        for (const dep of r.depends_on) { const d = idmap.get(dep); if (d != null) want.add(d); }
        if (t != null) {
          for (const d of want) {
            if (have.has(d)) depKeep++;
            else { try { await vik.addRelation(t, d, "follows"); depAdd++; } catch (e) { handleErr(e, `id「${r.localId}」依存付け失敗`, { dup: swallow }); } }
          }
          for (const d of have) {
            if (want.has(d) || !planIds.has(d)) continue; // 計画管理外の依存は触らない
            try { await vik.removeRelation(t, "follows", d); depDel++; } catch (e) { handleErr(e, `id「${r.localId}」依存解除失敗`, { missing: true }); }
          }
        }
        for (let k = 0; k < r.depends_on.length; k++) tick("依存付け中");
      }

      // ── フェーズD: assignee。計画が担当を**明示**した行のみ単一担当へ reconcile（改修D）──
      //   担当欄が空/未解決の行は既存担当に触れない（手動付与の担当を巻き込まない安全策）。
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], info = asgResolved[i];
        const t = idmap.get(r.localId);
        if (t == null) continue;
        const have = new Set(((existing.get(r.localId) && existing.get(r.localId).assignees) || []).map((a) => a && a.id).filter((id) => id != null));
        if (!info || info.status === "empty") continue; // 担当未指定＝既存に触れない
        if (info.id == null) { skippedAssignees.push(`id「${r.localId}」担当「${(r.assignee || "").trim()}」`); continue; } // 未解決＝スキップ
        if (have.has(info.id)) asgKeep++;
        else { try { await vik.addAssignee(t, info.id); asgAdd++; } catch (e) { handleErr(e, `id「${r.localId}」担当割当失敗`, { dup: swallow }); } }
        for (const aid of have) {
          if (aid === info.id) continue; // 目標担当へ単一化＝他担当は外す
          try { await vik.removeAssignee(t, aid); asgDel++; } catch (e) { handleErr(e, `id「${r.localId}」担当解除失敗`, { missing: true }); }
        }
        tick("担当割当中");
      }
    } catch (e) {
      // AuthError＝途中中断（改修C）。それ以外で try を抜けた予期せぬ例外も拾う。
      invalidate();
      return abort(e instanceof vik.AuthError
        ? esc("セッションが切れたため投入を中断しました。再ログイン後にやり直してください（途中まで投入済みの可能性があります）。")
        : `予期しないエラーで投入を中断しました: ${esc((e && e.message) || e)}`);
    }

    state.importing = false;
    if (progEl) progEl.textContent = "";
    if (agreeEl) agreeEl.disabled = false;
    setTableLocked(false);
    invalidate();

    // 結果パネル（改修N: 新規/更新・関連の +追加/-削除/維持 を区別表示）
    const failHtml = failures.length
      ? `<div class="keikaku-msg err"><div><b>${failures.length} 件の失敗:</b><br>${failures.join("<br>")}</div></div>` : "";
    const skipHtml = skippedAssignees.length
      ? `<div class="keikaku-msg warn"><div>担当をスキップ（未解決）: ${skippedAssignees.map(esc).join("、")}</div></div>` : "";
    const noteHtml = notes.length
      ? `<div class="keikaku-msg warn"><div>${notes.join("<br>")}</div></div>` : "";
    const relStat = (label, add, del, keep) =>
      `<span>${label} <b>+${add}</b>${del ? ` <b>-${del}</b>` : ""}${keep ? `（維持 ${keep}）` : ""}</span>`;
    if (resultEl) resultEl.innerHTML = `
      <div class="keikaku-done">
        <div class="keikaku-done-hd">${icon("check") || ""}投入完了</div>
        <div class="keikaku-done-stats">
          <span>新規 <b>${created}</b> 件</span>
          <span>更新 <b>${updated}</b> 件</span>
          ${relStat("親子", parentAdd, parentDel, parentKeep)}
          ${relStat("依存", depAdd, depDel, depKeep)}
          ${relStat("担当", asgAdd, asgDel, asgKeep)}
        </div>
        ${failHtml}${skipHtml}${noteHtml}
        <div class="keikaku-done-links">
          <a href="#/gantt" class="keikaku-link">${icon("calendar") || ""}ガントで見る</a>
          <a href="#/depgraph" class="keikaku-link">${icon("link") || ""}依存グラフで見る</a>
        </div>
      </div>`;
    updateDerived(); // ボタン活性を戻す
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
  .keikaku-pid{flex:1;font:inherit;font-size:13px;padding:7px 9px;border:1px solid ${C.line};border-radius:8px;background:${C.card};color:${C.ink}}
  .keikaku-pid:focus{outline:none;border-color:${C.fill}}
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
  .keikaku-table th{text-align:left;font-size:11px;font-weight:700;color:${C.muted};padding:8px 8px;border-bottom:1px solid ${C.line};white-space:nowrap;background:${C.track};position:sticky;top:0}
  .keikaku-table td{padding:6px 8px;border-bottom:1px solid ${C.line};vertical-align:top}
  .keikaku-table tr:last-child td{border-bottom:0}
  .keikaku-table tr.is-project{background:color-mix(in srgb,${C.fill} 7%,transparent)}
  .k-in{font:inherit;font-size:12px;padding:5px 7px;border:1px solid ${C.line};border-radius:7px;background:${C.card};color:${C.ink};width:100%;box-sizing:border-box}
  .k-in:focus{outline:none;border-color:${C.fill}}
  .k-type{min-width:104px}
  .k-parent{min-width:120px;max-width:170px}
  .k-task{min-width:150px}
  .k-asg-in{min-width:120px}
  .k-est{width:74px}
  .k-due{width:148px}
  .k-dep{min-width:90px}
  .k-done{min-width:150px}
  .k-localid{font-variant-numeric:tabular-nums;color:${C.muted};font-size:11.5px;white-space:nowrap;padding-top:11px}
  .k-asg-st{margin-top:4px}
  .k-asg{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:6px;display:inline-block;white-space:nowrap}
  .k-asg.ok{color:${C.free};background:color-mix(in srgb,${C.free} 13%,transparent)}
  .k-asg.unresolved{color:${C.over};background:color-mix(in srgb,${C.over} 13%,transparent)}
  .k-asg.none,.k-asg.pending{color:${C.muted};background:transparent;font-weight:400}
  .k-period{font-size:11px;color:${C.ink};white-space:nowrap;display:inline-block;padding-top:6px}
  .k-period small{display:block;color:${C.muted};font-size:10px;font-weight:400}
  .k-period.none{color:${C.muted}}
  .k-del{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid ${C.line};border-radius:7px;background:${C.card};color:${C.muted};cursor:pointer;margin-top:3px}
  .k-del:hover{border-color:${C.over};color:${C.over}}
  .k-del svg{width:14px;height:14px}
  .keikaku-tbl-actions{margin:10px 0 4px}
  .k-addbtn{font-size:12px;padding:6px 12px}
  .k-locked{opacity:.55;pointer-events:none}
  .k-locked .k-in,.k-locked .k-del,.k-locked .k-addbtn{cursor:not-allowed}
  .keikaku-summary{display:flex;flex-wrap:wrap;gap:8px 16px;margin:14px 0 10px;font-size:12.5px;color:${C.muted}}
  .keikaku-summary b{color:${C.ink};font-size:14px;font-variant-numeric:tabular-nums}
  .keikaku-warnbox{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.6;color:#9a6a00;background:color-mix(in srgb,${C.amber} 12%,transparent);border:1px solid color-mix(in srgb,${C.amber} 30%,transparent);border-radius:9px;padding:9px 11px;margin-bottom:12px}
  html[data-theme="dark"] .keikaku-warnbox{color:${C.amber}}
  .keikaku-warnbox.ok{color:${C.free};background:color-mix(in srgb,${C.free} 10%,transparent);border-color:color-mix(in srgb,${C.free} 30%,transparent)}
  html[data-theme="dark"] .keikaku-warnbox.ok{color:${C.free}}
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
