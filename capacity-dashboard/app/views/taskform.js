// タスクの追加・編集モーダル（再利用・どの画面からでも開ける）。
// body 直下に append する自己完結モーダル。clock.js の .ck-modal パターンを踏襲。
// 作成=createTaskInProject / 更新=updateTask(#9 非破壊) / 担当=add|removeAssignee /
// プロジェクト(UI呼称)=親タスク。related_tasks.subtask（親に subtask 関連を張る・名前入力で親を新規作成も可）。
// 階層: ワークスペース(=API project) ＞ プロジェクト(=親タスク) ＞ タスク。
import { load, invalidate, TEMPLATE_WS } from "../lib/store.js";
import { getTask, createTaskInProject, createProject, updateTask, addAssignee, removeAssignee, addRelation, removeRelation } from "../lib/api.js";
import { C, esc } from "../lib/ui.js";
// 共有フォーム部品（スマート日付/[資料][ゴール]規約/時間ステッパー/資料チップ）は lib/form.js に集約
import { parseSmartDate, fmtDisplay, fmtDisplayDow, splitMeta, joinMeta, hourInputHtml, wireHourInput, docChipsHtml, wireDocChips, attachDatePicker } from "../lib/form.js";
import { renderRecurrencePanel, ensureRecurrenceStyle } from "./recurrenceform.js";
// 互換 re-export（既存の import 元を壊さない）
export { parseSmartDate, fmtDisplay, splitMeta, joinMeta };

const ZERO_DATE = "0001-01-01T00:00:00Z"; // Vikunja の「未設定」センチネル
const WS_KEY = "ts.taskform.ws"; // 前回タスクを作ったワークスペース（選択UIの既定値）
// Vikunja priority(0–5)。0=なし。4=最優先までを提示。
const PRIO_OPTS = [[0, "なし"], [1, "低"], [2, "中"], [3, "高"], [4, "最優先"]];

// task の日付フィールド（due_date/start_date/end_date）を YYYY/MM/DD 表示に（未設定=空）
const fieldDisplay = (t, f) => (t && t[f] && !t[f].startsWith("0001") ? fmtDisplayDow(t[f].slice(0, 10)) : "");

let _mounted = false;

// taskId 省略=新規 / 指定=編集。保存後 onSaved() を呼ぶ。
export async function openTaskForm({ taskId = null, onSaved } = {}) {
  const { projects, members, tasks, templates = [], templateProject = null, holidaysByDate = null, aiMembers = [], me = null } = await load();
  const task = taskId ? await getTask(taskId) : null;
  const isEdit = !!task;
  const curAssignees = (task && task.assignees) || [];
  // AI担当（fable）は隠し要素: タスク作成者本人にしか見えない・触れない
  const isCreator = !task || (((task.created_by || {}).id || 0) === ((me && me.id) || -1));
  const aiIds = new Set((aiMembers || []).map((m) => m.id));
  // 主担当=人間の先頭 / 副担当=AI(優先・作成者のみ可視) or 2人目の人間
  const curHumans = curAssignees.filter((a) => !aiIds.has(a.id));
  const curAi = (isCreator && curAssignees.find((a) => aiIds.has(a.id))) || null;
  const curAssigneeId = curHumans.length ? curHumans[0].id : "";
  const curSubId = curAi ? curAi.id : (curHumans[1] ? curHumans[1].id : "");
  // 現在の親タスク（編集時）= related_tasks.parenttask の先頭
  const curParent = (task && task.related_tasks && (task.related_tasks.parenttask || [])[0]) || null;
  const curParentId = curParent ? curParent.id : null;

  ensureStyle();
  const wrap = document.createElement("div");
  wrap.className = "tf-modal";
  // ワークスペース選択からテンプレートWSは除外（雛形置き場であって作業場所ではない）。
  // 実質1つなら欄ごと非表示（自動選択）、2つ以上で選択UIが出現。既定値は前回使ったWSを記憶。
  const wsList = (projects || []).filter((p) => !templateProject || p.id !== templateProject.id);
  const wsSingle = wsList.length <= 1;
  let lastWs = null; try { lastWs = +localStorage.getItem(WS_KEY) || null; } catch {}
  const defWsId = task ? task.project_id
    : (wsList.some((p) => p.id === lastWs) ? lastWs : (wsList[0] && wsList[0].id));
  const projOpts = wsList.map((p) =>
    `<option value="${p.id}"${p.id === defWsId ? " selected" : ""}>${esc(p.title)}</option>`).join("");
  const memOpts = `<option value="">（なし）</option>` + (members || []).map((m) =>
    `<option value="${m.id}"${m.id === curAssigneeId ? " selected" : ""}>${esc(m.name || m.username)}</option>`).join("");
  const aiLabel = (m) => `🤖 ${m.name || m.username}（AI）`;
  const curSubLabel = curSubId
    ? (curAi ? aiLabel(curAi) : ((curHumans[1] && (curHumans[1].name || curHumans[1].username)) || ""))
    : "";
  const prioOpts = PRIO_OPTS.map(([v, n]) =>
    `<option value="${v}"${(task ? (task.priority || 0) : 0) === v ? " selected" : ""}>${n}</option>`).join("");
  const estH = task && task.time_estimate ? Math.round((task.time_estimate / 3600) * 100) / 100 : "";
  // 親タスク候補（自分自身は除外）。既存プロジェクト=subtask 子を持つタスク を優先候補に。
  const candidates = (tasks || []).filter((t) => !task || t.id !== task.id);
  const parentCands = candidates.filter((t) => ((((t.related_tasks || {}).subtask) || []).length > 0));
  const parentIds = new Set(parentCands.map((t) => t.id));
  const curParentTitle = curParent ? curParent.title : "";
  // 先行タスク（依存元）= related_tasks.follows（このタスクが follows する＝その前に完了が必要）
  const curPreds = (task && task.related_tasks && (task.related_tasks.follows || [])) || [];
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));
  for (const p of curPreds) if (!taskById.has(p.id)) taskById.set(p.id, p);
  const predSet = new Set(curPreds.map((p) => p.id)); // 編集中の作業セット（id）
  // 資料リンク（説明から分離して編集、保存時に再結合）
  const docInit = splitMeta(task ? task.description : "");
  const docLinks = [...docInit.links];

  // テンプレート: テンプレートWS内のタスク。分類=同WS内の親タスク（subtask 子持ち=分類、それ以外=雛形）。
  const tplLeafs = (templates || []).filter((t) => !(((t.related_tasks || {}).subtask) || []).length);
  const tplLabel = (t) => {
    const cat = (((t.related_tasks || {}).parenttask) || [])[0];
    return cat ? `${cat.title} › ${t.title}` : t.title;
  };
  const tplItems = tplLeafs.map((t) => ({ title: tplLabel(t), tpl: t }))
    .sort((a, b) => a.title.localeCompare(b.title, "ja"));

  wrap.innerHTML = `
    <div class="tf-bg"></div>
    <div class="tf-card" role="dialog" aria-modal="true">
      <div class="tf-h"><b>${isEdit ? "タスクを編集" : "タスクを追加"}</b>
        <span style="flex:1"></span>
        ${isEdit && curAi ? `<button type="button" class="tf-fable-run" id="tf-fable-run" title="Fableに実行させる（キューに追加・Fable画面でコンソール表示）">▶ Fable</button>` : ""}
        <button type="button" class="tf-x" id="tf-x" aria-label="閉じる">×</button></div>
      ${!isEdit ? `
      <div class="tf-tabs" id="tf-tabs">
        <button type="button" data-tab="task" class="on">タスク</button>
        <button type="button" data-tab="mtg">MTG</button>
        <button type="button" data-tab="rmtg">定例MTG</button>
        <button type="button" data-tab="rtask">定期タスク</button>
      </div>` : ""}
      <div class="tf-body">
        <div class="tf-main">
          ${!isEdit ? `
          <div class="tf-tplbox">
            <label class="tf-l">テンプレートから作成 <span class="tf-hint">（任意・選ぶと各項目に反映）</span></label>
            <div class="tf-cbx">
              <input id="tf-tpl" class="tf-in" autocomplete="off" placeholder="テンプレートを検索 / 選択">
              <div class="tf-cbx-dd" hidden></div>
            </div>
          </div>` : ""}
          <label class="tf-l">プロジェクト <span class="tf-hint">（無い名前は新規作成）</span></label>
          <div class="tf-cbx">
            <input id="tf-parent" class="tf-in" autocomplete="off" value="${esc(curParentTitle)}" placeholder="選択 / 名前を入力">
            <div class="tf-cbx-dd" hidden></div>
          </div>
          <label class="tf-l">タイトル <span class="tf-req">*</span></label>
          <input id="tf-title" class="tf-in" type="text" value="${esc(task ? task.title : "")}" placeholder="やること">
          <label class="tf-l">説明</label>
          <textarea id="tf-desc" class="tf-in tf-ta" rows="4" placeholder="任意">${esc(docInit.text)}</textarea>
          <label class="tf-l">ゴール <span class="tf-hint">（どうなったら完了か）</span></label>
          <textarea id="tf-goal" class="tf-in tf-ta" rows="3" placeholder="例: レビュー承認済み・本番で動作確認済み">${esc(docInit.goal)}</textarea>
          <label class="tf-l">資料 <span class="tf-hint">（URLやパス・Enterで追加・複数可）</span></label>
          ${docChipsHtml("tf-doc")}
        </div>
        <div class="tf-side">
          <div${wsSingle ? " hidden" : ""}>
            <label class="tf-l">ワークスペース</label>
            <select id="tf-proj" class="tf-in"${isEdit ? " disabled" : ""}>${projOpts}</select>
          </div>
          <div class="tf-row">
            <div class="tf-col">
              <label class="tf-l">担当</label>
              <select id="tf-asg" class="tf-in">${memOpts}</select>
            </div>
            <div class="tf-col">
              <label class="tf-l">優先度</label>
              <select id="tf-prio" class="tf-in">${prioOpts}</select>
            </div>
          </div>
          <div id="tf-sub-row"${curAssigneeId ? "" : " hidden"}>
            <label class="tf-l">副担当 <span class="tf-hint">（任意・名前で検索）</span></label>
            <div class="tf-cbx">
              <input id="tf-asg2" class="tf-in" autocomplete="off" placeholder="検索して選択" value="${esc(curSubLabel)}">
              <div class="tf-cbx-dd" hidden></div>
            </div>
          </div>
          <label class="tf-l">見積り(h) <span class="tf-hint">（0.25刻み）</span></label>
          ${hourInputHtml("tf-est", { value: estH })}
          <div class="tf-row">
            <div class="tf-col">
              <label class="tf-l">開始予定日</label>
              <input id="tf-start" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fieldDisplay(task, "start_date")}" placeholder="1112">
            </div>
            <div class="tf-col">
              <label class="tf-l">終了予定日</label>
              <input id="tf-end" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fieldDisplay(task, "end_date")}" placeholder="1120">
            </div>
          </div>
          <label class="tf-l">期日</label>
          <input id="tf-due" class="tf-in" type="text" inputmode="numeric" autocomplete="off" value="${fieldDisplay(task, "due_date")}" placeholder="1112 → 11/12">
          <label class="tf-l">先行タスク <span class="tf-hint">（前に完了が必要）</span></label>
          <div class="tf-cbx">
            <input id="tf-dep" class="tf-in" autocomplete="off" placeholder="検索して追加">
            <div class="tf-cbx-dd" hidden></div>
          </div>
          <div class="tf-chips" id="tf-dep-chips"></div>
          ${isEdit ? `<label class="tf-chk"><input id="tf-done" type="checkbox"${task.done ? " checked" : ""}> 完了にする</label>` : ""}
        </div>
        <div class="tf-err" id="tf-err"></div>
      </div>
      <div class="tf-body tf-alt" id="tf-alt" hidden></div>
      <div class="tf-acts">
        <button class="tf-tpl-save" id="tf-tpl-save" title="タイトル/優先度/見積り/説明を雛形として保存（プロジェクト欄=分類）">テンプレートとして保存</button>
        <button class="tf-cancel" id="tf-cancel">キャンセル</button>
        <button class="tf-save" id="tf-save">${isEdit ? "保存" : "追加"}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const $ = (id) => wrap.querySelector(id);
  const close = () => { wrap.remove(); };
  // 外側クリックでは閉じない（誤クリックで入力が飛ぶため）。閉じる=×/キャンセルのみ。
  $("#tf-x").onclick = close;
  $("#tf-cancel").onclick = close;
  $("#tf-title").focus();

  // 種別タブ（新規時のみ）: タスク=本フォーム / MTG・定例MTG・定期タスク=recurrenceform のパネル
  const tabs = $("#tf-tabs");
  if (tabs) {
    ensureRecurrenceStyle();
    const paneTask = wrap.querySelector(".tf-body:not(.tf-alt)");
    const paneAlt = $("#tf-alt");
    const acts = wrap.querySelector(".tf-acts");
    // タブ切替でモーダルの高さが変わらないよう、初期（タスクタブ）の高さを最低高に固定
    requestAnimationFrame(() => {
      const c = wrap.querySelector(".tf-card");
      if (c.offsetHeight) c.style.minHeight = c.offsetHeight + "px";
    });
    tabs.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        const mode = b.dataset.tab, isTask = mode === "task";
        paneTask.hidden = !isTask;
        acts.hidden = !isTask;
        paneAlt.hidden = isTask;
        if (!isTask) renderRecurrencePanel(paneAlt, mode, { members, onSaved, close, holidaysByDate });
        else $("#tf-title").focus();
      };
    });
  }

  // ヘッダー掴みでモーダルをドラッグ移動（初回ドラッグで fixed 化、画面外に出ない範囲でクランプ）
  const card = wrap.querySelector(".tf-card");
  wrap.querySelector(".tf-h").onmousedown = (ev) => {
    if (ev.target.closest(".tf-x")) return;
    const r = card.getBoundingClientRect();
    const offX = ev.clientX - r.left, offY = ev.clientY - r.top;
    card.style.position = "fixed"; card.style.margin = "0";
    card.style.left = r.left + "px"; card.style.top = r.top + "px";
    const move = (e) => {
      card.style.left = Math.min(Math.max(e.clientX - offX, 60 - r.width), window.innerWidth - 60) + "px";
      card.style.top = Math.min(Math.max(e.clientY - offY, 0), window.innerHeight - 40) + "px";
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    ev.preventDefault();
  };

  // 日付3欄（開始/終了/期日）: blur で曜日付き表示（YYYY/MM/DD（曜））に整形＋カレンダーピッカー（土日祝色分け）
  for (const id of ["#tf-start", "#tf-end", "#tf-due"]) {
    const el = $(id);
    el.onblur = () => { const iso = parseSmartDate(el.value); if (iso) el.value = fmtDisplayDow(iso); };
    attachDatePicker(el, { holidaysByDate });
  }

  // 見積り: 共有部品（".25"補完・↑↓キー/▲▼ボタンで0.25刻み）
  wireHourInput(wrap, "tf-est");

  // 先行タスク: コンボボックスで選択→チップ追加、× で除去（作業セット predSet を更新）
  const renderChips = () => {
    const el = $("#tf-dep-chips");
    el.innerHTML = [...predSet].map((id) => {
      const t = taskById.get(id);
      return `<span class="tf-chip">${esc(t ? t.title : "#" + id)}<button type="button" class="tf-chip-x" data-id="${id}">×</button></span>`;
    }).join("");
    el.querySelectorAll(".tf-chip-x").forEach((b) => { b.onclick = () => { predSet.delete(+b.dataset.id); renderChips(); }; });
  };
  renderChips();

  // 資料リンク: 共有部品（Enter/blurで追加・×で除去・httpはリンク）
  const docChips = wireDocChips(wrap, "tf-doc", docLinks);

  const depEl = $("#tf-dep");
  attachCombobox(depEl, {
    items: (q) => {
      const ql = q.toLowerCase();
      return candidates.filter((t) => !predSet.has(t.id) && (!ql || t.title.toLowerCase().includes(ql)));
    },
    onPick: (item) => { if (item) { predSet.add(item.id); renderChips(); } depEl.value = ""; },
  });

  // 副担当: 検索式コンボボックス（主担当を選ぶと出現）。人間メンバーは普通に候補に出る。
  // AI（fable）は「隠しコマンド」: 名前を打ったときだけ候補に現れる（一覧には出さない）。
  let subSel = curSubId || null;
  let subSelLabel = curSubLabel;
  const subEl = $("#tf-asg2");
  const subRow = $("#tf-sub-row");
  attachCombobox(subEl, {
    items: (q) => {
      const ql = q.toLowerCase();
      const main = +($("#tf-asg").value || 0);
      const humans = (members || []).filter((m) => m.id !== main &&
        (!ql || (m.name || m.username || "").toLowerCase().includes(ql)));
      const ais = ql && isCreator ? (aiMembers || []).filter((m) =>
        (m.username || "").toLowerCase().startsWith(ql) || (m.name || "").toLowerCase().startsWith(ql)) : [];
      return [...humans.map((m) => ({ title: m.name || m.username, _id: m.id })),
              ...ais.map((m) => ({ title: aiLabel(m), _id: m.id }))];
    },
    onPick: (item) => {
      if (!item) return;
      subSel = item._id; subSelLabel = item.title; subEl.value = item.title;
    },
  });
  subEl.addEventListener("blur", () => { if (!subEl.value.trim()) { subSel = null; subSelLabel = ""; } });

  // AIコメント（隠しノート・作成者のみ）: Fable の計画/進捗/結果。説明の下に遅延ロードで表示。
  if (isEdit && curAi) {
    const KIND_JA = { plan: "📝 計画", progress: "進捗", result: "✔ 結果", script: "⚙ スクリプト", proposal: "💡 提案" };
    const box = document.createElement("div");
    box.innerHTML = `<label class="tf-l">AIコメント <span class="tf-hint">（自分のみ閲覧）</span></label><div class="tf-ainotes" id="tf-ainotes"><span class="tf-hint">読み込み中…</span></div>`;
    wrap.querySelector(".tf-main").appendChild(box);
    import("../lib/exec.js").then(({ getNotes }) => getNotes(task.id)).then((d) => {
      const el = $("#tf-ainotes");
      const list = (d && d.notes) || [];
      el.innerHTML = list.length ? [...list].reverse().map((n) => {
        const dt = new Date(n.ts * 1000);
        const when = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
        return `<div class="tf-ainote"><div class="tf-ainote-h">${KIND_JA[n.kind] || n.kind} ・ ${when}</div><div class="tf-ainote-b">${esc(n.text)}</div></div>`;
      }).join("") : `<span class="tf-hint">まだありません（📝計画 や ▶実行 で溜まります）</span>`;
    }).catch(() => { const el = $("#tf-ainotes"); if (el) el.innerHTML = `<span class="tf-hint">実行サービスに接続できません</span>`; });
  }

  // ▶ Fable 実行（作成者のみ・編集時・Fable副担当タスク）: 実行サービスのキューに追加
  const fableBtn = $("#tf-fable-run");
  if (fableBtn) fableBtn.onclick = async () => {
    const err = $("#tf-err");
    fableBtn.disabled = true;
    try {
      const { runAi } = await import("../lib/exec.js");
      const j = await runAi(task.id, task.title);
      err.className = "tf-err ok";
      err.textContent = `✓ Fableのキューに追加しました（#${j.job.id}）。コンソールは 🤖 Fable 画面で。`;
    } catch (e) {
      err.className = "tf-err";
      err.textContent = "× 実行サービスに接続できません: " + e.message;
    }
    fableBtn.disabled = false;
  };
  $("#tf-asg").onchange = () => {
    const has = !!$("#tf-asg").value;
    subRow.hidden = !has;
    if (!has) { subSel = null; subSelLabel = ""; subEl.value = ""; }
  };

  // テンプレートから作成: 選ぶとタイトル/優先度/見積り/説明をフォームに反映（日付・担当は対象外）
  const tplEl = $("#tf-tpl");
  if (tplEl) attachCombobox(tplEl, {
    items: (q) => {
      const ql = q.toLowerCase();
      return ql ? tplItems.filter((e) => e.title.toLowerCase().includes(ql)) : tplItems;
    },
    onPick: (item) => {
      if (!item) return;
      const t = item.tpl;
      tplEl.value = item.title;
      $("#tf-title").value = t.title;
      $("#tf-prio").value = String(t.priority || 0);
      $("#tf-est").value = t.time_estimate ? String(Math.round((t.time_estimate / 3600) * 100) / 100) : "";
      const d = splitMeta(t.description);
      $("#tf-desc").value = d.text;
      $("#tf-goal").value = d.goal;
      docLinks.length = 0; docLinks.push(...d.links); docChips.render();
    },
  });

  // テンプレートとして保存: 雛形(タイトル/優先度/見積り/説明)をテンプレートWSに保存。プロジェクト欄=分類。
  $("#tf-tpl-save").onclick = async () => {
    const err = $("#tf-err");
    err.className = "tf-err";
    const title = $("#tf-title").value.trim();
    if (!title) { err.textContent = "タイトルを入力してください。"; return; }
    const estRaw = $("#tf-est").value.trim().replace(/^\./, "0.");
    const estNum = estRaw ? parseFloat(estRaw) : 0;
    const btn = $("#tf-tpl-save");
    btn.disabled = true; err.textContent = "";
    try {
      const tplWs = templateProject || await createProject(TEMPLATE_WS);
      const created = await createTaskInProject(tplWs.id, {
        title, description: joinMeta($("#tf-desc").value, $("#tf-goal").value, docLinks), priority: +$("#tf-prio").value,
        time_estimate: isFinite(estNum) && estNum > 0 ? Math.round(estNum * 3600) : 0,
      });
      const catRaw = $("#tf-parent").value.trim();
      if (catRaw) {
        const cat = (templates || []).find((t) => t.title === catRaw)
          || await createTaskInProject(tplWs.id, { title: catRaw });
        await addRelation(cat.id, created.id, "subtask");
      }
      invalidate();
      err.className = "tf-err ok";
      err.textContent = `✓ テンプレートに保存しました${catRaw ? `（分類: ${catRaw}）` : ""}`;
    } catch (e) { err.textContent = "× " + e.message; }
    btn.disabled = false;
  };

  // プロジェクト: 空入力=既存プロジェクト一覧（無ければ全タスク）、入力=全タスク検索（プロジェクト優先）、未一致=新規作成を提示
  const parentEl = $("#tf-parent");
  attachCombobox(parentEl, {
    items: (q) => {
      if (!q) return parentCands.length ? parentCands : candidates;
      const ql = q.toLowerCase(), hit = (t) => t.title.toLowerCase().includes(ql);
      return [...parentCands.filter(hit), ...candidates.filter((t) => !parentIds.has(t.id) && hit(t))];
    },
    createText: (q) => `＋ プロジェクト「${q}」を新規作成`,
    onPick: (item, create) => { parentEl.value = item ? item.title : create; },
  });

  $("#tf-save").onclick = async () => {
    const err = $("#tf-err");
    err.className = "tf-err";
    const title = $("#tf-title").value.trim();
    if (!title) { err.textContent = "タイトルを入力してください。"; return; }
    const parseField = (sel, label) => {
      const raw = $(sel).value.trim();
      if (!raw) return { iso: null, ok: true };
      const iso = parseSmartDate(raw);
      if (!iso) { err.textContent = `${label}の形式が不正です（例: 1112 → 11/12）。`; return { iso: null, ok: false }; }
      return { iso, ok: true };
    };
    const startF = parseField("#tf-start", "開始予定日"); if (!startF.ok) return;
    const endF = parseField("#tf-end", "終了予定日"); if (!endF.ok) return;
    const dueF = parseField("#tf-due", "期日"); if (!dueF.ok) return;
    const startISO = startF.iso, endISO = endF.iso, dueISO = dueF.iso;
    if (startISO && endISO && endISO < startISO) { err.textContent = "終了予定日は開始予定日以降にしてください。"; return; }
    const pid = +$("#tf-proj").value;
    const asg = $("#tf-asg").value ? +$("#tf-asg").value : null;
    // 副担当: 入力欄テキストが選択時のラベルと一致している場合のみ有効（手で消したら解除）
    const sub = subSel && $("#tf-asg2").value.trim() === subSelLabel && subSel !== asg && asg ? subSel : null;
    const wantAsg = [asg, sub].filter(Boolean);
    const prio = +$("#tf-prio").value;
    // 見積り: ".25"→0.25 の先頭ドット補完つき自前パース（0.25h=15分 刻みを許容）
    const estVal = $("#tf-est").value.trim().replace(/^\./, "0.");
    const estNum = estVal ? parseFloat(estVal) : 0;
    if (estVal && (!isFinite(estNum) || estNum < 0)) { err.textContent = "見積りは0以上の数値(h)で入力してください。"; return; }
    const estSec = estVal ? Math.round(estNum * 3600) : 0;
    const desc = joinMeta($("#tf-desc").value, $("#tf-goal").value, docLinks);

    const parentRaw = $("#tf-parent").value.trim();

    const btn = $("#tf-save");
    btn.disabled = true; err.textContent = "";
    try {
      const dt = (iso) => iso + "T00:00:00Z";
      let childId;
      if (!isEdit) {
        const body = { title, description: desc, priority: prio, time_estimate: estSec };
        if (dueISO) body.due_date = dt(dueISO);
        if (startISO) body.start_date = dt(startISO);
        if (endISO) body.end_date = dt(endISO);
        const created = await createTaskInProject(pid, body);
        childId = created.id;
        for (const id of wantAsg) await addAssignee(childId, id);
      } else {
        const patch = {
          title, description: desc, priority: prio,
          due_date: dueISO ? dt(dueISO) : ZERO_DATE,
          start_date: startISO ? dt(startISO) : ZERO_DATE,
          end_date: endISO ? dt(endISO) : ZERO_DATE,
          time_estimate: estSec,
          done: $("#tf-done").checked,
        };
        await updateTask(task.id, patch);
        childId = task.id;
        // 担当 diff（主担当＋副担当。副担当はAI=fable も可）。
        // 非作成者にはAI担当が見えていないため、知らずに剥がさないよう保護する。
        const curIds = new Set(curAssignees.map((a) => a.id));
        for (const a of curAssignees) {
          if (wantAsg.includes(a.id)) continue;
          if (aiIds.has(a.id) && !isCreator) continue; // 隠しAI担当は維持
          await removeAssignee(task.id, a.id);
        }
        for (const id of wantAsg) if (!curIds.has(id)) await addAssignee(task.id, id);
      }

      // 先行タスク diff（このタスクが follows する＝前に完了が必要）。
      // capacity.js dependencyEdges は follows を rel→t（前→後）に正規化。逆 precedes は自動付与。
      const curPredIds = new Set(curPreds.map((p) => p.id));
      for (const pid2 of predSet) if (pid2 !== childId && !curPredIds.has(pid2)) await addRelation(childId, pid2, "follows");
      for (const pid2 of curPredIds) if (!predSet.has(pid2)) await removeRelation(childId, "follows", pid2);

      // 親タスクの解決（既存タイトル一致=その親 / 新名=同ワークスペースに親を新規作成）と関連 diff。
      // 親が子を持つ＝親側に subtask 関連を張る（capacity.js buildTaskTree と整合）。
      let parentId = null;
      if (parentRaw) {
        const existing = (tasks || []).find((t) => t.title === parentRaw && t.id !== childId);
        parentId = existing ? existing.id : (await createTaskInProject(pid, { title: parentRaw })).id;
      }
      if (parentId !== curParentId) {
        if (curParentId) await removeRelation(curParentId, "subtask", childId);
        if (parentId) await addRelation(parentId, childId, "subtask");
      }

      if (!isEdit) try { localStorage.setItem(WS_KEY, String(pid)); } catch {}
      invalidate();
      close();
      onSaved && onSaved();
    } catch (e) {
      btn.disabled = false;
      err.textContent = "× " + e.message;
    }
  };
}

// 自前コンボボックス（datalist はブラウザ依存で挙動が独特なため自前描画）。
// items(q)=候補配列 / createText(q)=未一致入力の「新規作成」行（省略=作成不可） / onPick(item, createTitle)。
// 矢印キーで選択・Enter確定・Esc/フォーカス外で閉じる。
function attachCombobox(input, { items, createText, onPick }) {
  const dd = input.parentElement.querySelector(".tf-cbx-dd");
  let list = [], idx = -1, typed = false; // typed=このフォーカス中に入力したか。選択済み文言での再フォーカスは全候補を出す（選び直し可能に）
  const close = () => { dd.hidden = true; idx = -1; };
  const paint = () => dd.querySelectorAll(".tf-cbx-it").forEach((el, i) => el.classList.toggle("on", i === idx));
  const open = () => {
    const q = typed ? input.value.trim() : "";
    const hits = items(q);
    list = hits.slice(0, 8).map((t) => ({ item: t }));
    if (createText && q && !hits.some((t) => t.title === q)) list.push({ create: q });
    if (!list.length) return close();
    dd.innerHTML = list.map((e, i) => e.item
      ? `<div class="tf-cbx-it" data-i="${i}">${esc(e.item.title)}</div>`
      : `<div class="tf-cbx-it tf-cbx-new" data-i="${i}">${esc(createText(e.create))}</div>`).join("");
    dd.hidden = false; paint();
    dd.querySelectorAll(".tf-cbx-it").forEach((el) => {
      el.onmousedown = (ev) => { ev.preventDefault(); pick(+el.dataset.i); }; // blurより先に確定
      el.onmouseenter = () => { idx = +el.dataset.i; paint(); };
    });
  };
  const pick = (i) => { const e = list[i]; if (!e) return; onPick(e.item || null, e.create || null); close(); input.blur(); };
  input.onfocus = () => { typed = false; open(); };
  input.oninput = () => { typed = true; open(); };
  input.onblur = () => setTimeout(close, 120);
  input.onkeydown = (ev) => {
    if (ev.key === "Escape") return close();
    if (dd.hidden) { if (ev.key === "ArrowDown") { ev.preventDefault(); open(); } return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); idx = (idx + 1) % list.length; paint(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); idx = (idx - 1 + list.length) % list.length; paint(); }
    else if (ev.key === "Enter") { ev.preventDefault(); pick(idx >= 0 ? idx : 0); }
  };
}

function ensureStyle() {
  if (_mounted) return; _mounted = true;
  const s = document.createElement("style");
  s.textContent = `
  .tf-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center}
  .tf-bg{position:absolute;inset:0;background:rgba(20,30,50,.38)}
  .tf-card{position:relative;width:min(780px,94vw);max-height:90vh;overflow:auto;background:${C.card};border:1px solid ${C.line};border-radius:16px;box-shadow:0 18px 50px rgba(20,30,50,.28)}
  .tf-h{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 4px 22px;font-size:16px;cursor:move;user-select:none}.tf-h b{font-size:16px}
  .tf-ainotes{max-height:220px;overflow:auto;border:1px solid ${C.line};border-radius:10px;padding:4px 10px;background:#fafbfc}
  .tf-ainote{padding:8px 0;border-top:1px solid ${C.track}}
  .tf-ainote:first-child{border-top:0}
  .tf-ainote-h{font-size:11px;color:${C.muted};font-weight:700;margin-bottom:3px}
  .tf-ainote-b{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:${C.ink}}
  .tf-fable-run{border:1px solid ${C.fill};background:#fff;color:${C.fill};font:inherit;font-size:12px;font-weight:700;padding:5px 12px;border-radius:16px;cursor:pointer;margin-right:6px}
  .tf-fable-run:hover{background:${C.fill};color:#fff}
  .tf-fable-run:disabled{opacity:.5}
  .tf-x{border:0;background:transparent;color:${C.muted};font-size:20px;line-height:1;padding:4px 9px;border-radius:8px;cursor:pointer}
  .tf-x:hover{background:#f1f4f8;color:${C.ink}}
  .tf-body{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:0 26px;padding:8px 22px 4px;align-items:start}
  .tf-main{min-width:0}
  .tf-side{min-width:0;border-left:1px solid ${C.line};padding-left:24px}
  .tf-body > .tf-err{grid-column:1/-1}
  @media(max-width:680px){.tf-body{grid-template-columns:1fr}.tf-side{border-left:0;padding-left:0}}
  .tf-l{display:block;font-size:12px;color:${C.muted};font-weight:600;margin:12px 0 5px}
  .tf-tplbox{background:#f4f8ff;border:1px solid #dbe7ff;border-radius:10px;padding:2px 12px 12px;margin:6px 0 14px}
  .tf-tplbox .tf-l{margin-top:8px}
  .tf-req{color:${C.over}}
  .tf-hint{font-weight:400;color:${C.muted};font-size:11px}
  .tf-in{width:100%;font:inherit;font-size:13.5px;padding:8px 10px;border:1px solid ${C.line};border-radius:9px;background:#fff;box-sizing:border-box;color:${C.ink}}
  .tf-in:focus{outline:none;border-color:${C.fill};box-shadow:0 0 0 3px rgba(58,134,255,.12)}
  .tf-in:disabled{background:#f4f6f9;color:${C.muted}}
  .tf-ta{resize:vertical;line-height:1.45}
  .tf-row{display:flex;gap:12px}.tf-col{flex:1;min-width:0}
  .tf-chk{display:flex;align-items:center;gap:7px;font-size:13px;color:${C.ink};margin:14px 0 4px;cursor:pointer}
  .tf-step{position:relative}
  .tf-step .tf-in{padding-right:30px}
  .tf-step-btns{position:absolute;top:1px;right:1px;bottom:1px;width:24px;display:flex;flex-direction:column;border-left:1px solid ${C.line};border-radius:0 8px 8px 0;overflow:hidden}
  .tf-step-btns button{flex:1;border:0;background:#fff;color:${C.muted};cursor:pointer;font-size:8px;padding:0;line-height:1}
  .tf-step-btns button:hover{background:#eef4ff;color:${C.fill}}
  .tf-cbx{position:relative}
  .tf-cbx-dd{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:5;background:#fff;border:1px solid ${C.line};border-radius:10px;box-shadow:0 10px 30px rgba(20,30,50,.16);max-height:228px;overflow:auto;padding:4px}
  .tf-cbx-it{padding:8px 10px;font-size:13px;border-radius:7px;cursor:pointer;color:${C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tf-cbx-it.on{background:#eef4ff}
  .tf-cbx-new{color:${C.fill};font-weight:600}
  .tf-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;min-height:26px} /* チップ1行分を予約（追加時のモーダル急伸防止） */
  .tf-chip{display:inline-flex;align-items:center;gap:4px;background:#eef2f7;border:1px solid ${C.line};border-radius:20px;padding:3px 5px 3px 11px;font-size:12px;color:${C.ink}}
  .tf-chip a{color:${C.fill};text-decoration:none}
  .tf-chip a:hover{text-decoration:underline}
  .tf-chip-x{border:0;background:transparent;color:${C.muted};cursor:pointer;font-size:14px;line-height:1;padding:0 3px}
  .tf-chip-x:hover{color:${C.over}}
  .tf-err{color:${C.over};font-size:12.5px;min-height:18px;margin:8px 0 2px;font-weight:600}
  .tf-err.ok{color:${C.free}}
  .tf-acts{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px 18px;border-top:1px solid ${C.line};margin-top:10px}
  .tf-acts .tf-tpl-save{margin-right:auto;background:#fff;color:${C.muted}}
  .tf-acts .tf-tpl-save:hover{color:${C.ink}}
  .tf-acts .tf-tpl-save:disabled{opacity:.6;cursor:default}
  .tf-acts button{font:inherit;font-size:13.5px;font-weight:600;padding:9px 18px;border-radius:9px;cursor:pointer;border:1px solid ${C.line}}
  .tf-cancel{background:#fff;color:${C.muted}}.tf-cancel:hover{color:${C.ink}}
  .tf-save{background:${C.fill};color:#fff;border-color:${C.fill}}.tf-save:hover{filter:brightness(1.05)}
  .tf-save:disabled{opacity:.6;cursor:default}
  @media(max-width:560px){.tf-row{flex-direction:column;gap:0}}`;
  document.head.appendChild(s);
}
