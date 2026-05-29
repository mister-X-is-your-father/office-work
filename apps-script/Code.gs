/**
 * OfficeOS — 会議OS 自動化 (Phase 1 / Apps Script)
 * 目的: 人手ゼロの閉ループ。会議シートの決定/ToDoを台帳へ自動転記し、
 *       台帳の行を編集したら最終更新日を自動打刻、新会議の複製＋持ち越しを自動化する。
 *
 * 前提: build_template.py が生成する v5 テンプレ（4タブ）に対応。
 *       下の M / L の行・列定数は v5 レイアウト準拠。テンプレを変えたらここも更新する。
 *
 * 導入: 拡張機能→Apps Script に本ファイルを貼り付け→保存→リロード。
 *       メニュー「会議OS」が出る。初回アクション実行時に権限承認。
 */

const SHEET_MTG_PREFIX = '▶';
const LEDGER = '🗂 課題・タスク台帳';
const TEMPLATE = '▶ 会議';

// ▶会議テンプレの行・列（v5準拠）
const M = {
  name: 'B3', date: 'E3',
  issueRows: [20, 25], issueCol: 'B', issueStatusCol: 'D', // 論点リスト
  scribeRows: [38, 57], scribeKind: 'B', scribeContent: 'C', // スクライブ
  todoRows: [68, 71], todoOwner: 'B', todoWhat: 'C', todoDue: 'F' // ③ToDo
};

// 🗂台帳の列（A=1始まり）
const L = {
  dataStart: 6,
  col: { id: 1, area: 2, kind: 3, content: 4, opened: 5, source: 6, owner: 7, due: 8, status: 9, prio: 10, updated: 11, next: 12 }
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('会議OS')
    .addItem('① 新しい会議を始める', 'newMeeting')
    .addItem('② この会議を台帳へ取り込む', 'syncMeetingToLedger')
    .addSeparator()
    .addItem('棚卸し：要対応を表示', 'showRollup')
    .addToUi();
}

function _ss() { return SpreadsheetApp.getActive(); }
function _tz() { return _ss().getSpreadsheetTimeZone(); }
function _todayStr() { return Utilities.formatDate(new Date(), _tz(), 'yyyy-MM-dd'); }
function _ledger() { return _ss().getSheetByName(LEDGER); }
function _activeMtg() {
  const sh = _ss().getActiveSheet();
  if (sh.getName().charAt(0) !== SHEET_MTG_PREFIX) throw new Error('会議シート（▶…）を開いて実行してください');
  return sh;
}

/** ① 新しい会議：テンプレ複製＋日付命名＋前回からの持ち越し論点を自動セット */
function newMeeting() {
  const ss = _ss();
  const tpl = ss.getSheetByName(TEMPLATE);
  if (!tpl) throw new Error('テンプレ「▶ 会議」が見つかりません');
  const name = _uniqueName(ss, '▶ ' + _todayStr());
  const copy = tpl.copyTo(ss).setName(name);
  ss.setActiveSheet(copy); ss.moveActiveSheet(2);
  copy.getRange(M.date).setValue(_todayStr());

  const carry = _openIssues('論点');
  const cap = M.issueRows[1] - M.issueRows[0] + 1;
  let r = M.issueRows[0];
  carry.slice(0, cap).forEach(function (it) {
    copy.getRange(M.issueCol + r).setValue(it.content);
    copy.getRange(M.issueStatusCol + r).setValue('未');
    r++;
  });
  ss.toast('新しい会議を作成。持ち越し論点 ' + carry.length + '件 ／ ' + _rollupText(), '会議OS', 6);
}

/** ② この会議を台帳へ取り込む：スクライブの「決定」＋③ToDo を🗂台帳へ追記（重複防止） */
function syncMeetingToLedger() {
  const sh = _activeMtg();
  const led = _ledger();
  if (!led) throw new Error('台帳「' + LEDGER + '」が見つかりません');
  const src = sh.getRange(M.name).getValue() || sh.getName();
  const existing = _existingKeys(led);
  let added = 0;

  for (let r = M.scribeRows[0]; r <= M.scribeRows[1]; r++) {
    if (sh.getRange(M.scribeKind + r).getValue() === '決定') {
      const c = sh.getRange(M.scribeContent + r).getValue();
      if (c && _append(led, existing, { kind: '決定', content: c, source: src })) added++;
    }
  }
  for (let r = M.todoRows[0]; r <= M.todoRows[1]; r++) {
    const what = sh.getRange(M.todoWhat + r).getValue();
    if (what && _append(led, existing, {
      kind: 'タスク', content: what, source: src,
      owner: sh.getRange(M.todoOwner + r).getValue(),
      due: sh.getRange(M.todoDue + r).getValue()
    })) added++;
  }
  _ss().toast(added + ' 件を台帳へ取り込みました。 ' + _rollupText(), '会議OS', 6);
}

function _append(led, existing, o) {
  const key = o.source + '|' + o.content;
  if (existing[key]) return false;
  existing[key] = true;
  const r = Math.max(L.dataStart - 1, led.getLastRow()) + 1;
  const t = _todayStr();
  led.getRange(r, L.col.id).setValue(r - L.dataStart + 1);
  led.getRange(r, L.col.kind).setValue(o.kind);
  led.getRange(r, L.col.content).setValue(o.content);
  led.getRange(r, L.col.opened).setValue(t);
  led.getRange(r, L.col.source).setValue(o.source);
  if (o.owner) led.getRange(r, L.col.owner).setValue(o.owner);
  if (o.due) led.getRange(r, L.col.due).setValue(o.due);
  led.getRange(r, L.col.status).setValue('未着手');
  led.getRange(r, L.col.updated).setValue(t);
  return true;
}

function _existingKeys(led) {
  const keys = {};
  const last = led.getLastRow();
  if (last < L.dataStart) return keys;
  const n = last - L.dataStart + 1;
  const contents = led.getRange(L.dataStart, L.col.content, n, 1).getValues();
  const sources = led.getRange(L.dataStart, L.col.source, n, 1).getValues();
  for (let i = 0; i < n; i++) if (contents[i][0]) keys[sources[i][0] + '|' + contents[i][0]] = true;
  return keys;
}

function _openIssues(kind) {
  const led = _ledger();
  const out = [];
  const last = led.getLastRow();
  if (last < L.dataStart) return out;
  const rng = led.getRange(L.dataStart, 1, last - L.dataStart + 1, L.col.status).getValues();
  rng.forEach(function (row) {
    const k = row[L.col.kind - 1], c = row[L.col.content - 1], st = row[L.col.status - 1];
    if (c && (!kind || k === kind) && st !== '完了') out.push({ content: c, status: st });
  });
  return out;
}

function showRollup() { _ss().toast(_rollupText(), '棚卸し（要対応）', 8); }

function _rollupText() {
  const led = _ledger();
  if (!led) return '';
  const last = led.getLastRow();
  if (last < L.dataStart) return '台帳は空です';
  const rng = led.getRange(L.dataStart, 1, last - L.dataStart + 1, L.col.updated).getValues();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let open = 0, over = 0, stale = 0, noown = 0;
  rng.forEach(function (r) {
    const content = r[L.col.content - 1];
    if (!content) return;
    const status = r[L.col.status - 1], due = r[L.col.due - 1], owner = r[L.col.owner - 1], upd = r[L.col.updated - 1];
    if (status !== '完了') {
      open++;
      if (due instanceof Date && due < today) over++;
      if (upd instanceof Date && (today - upd) / 86400000 > 14) stale++;
      if (!owner) noown++;
    }
  });
  return '未完' + open + ' / 期限超過' + over + ' / 停滞' + stale + ' / 担当なし' + noown;
}

/** 台帳の行を編集したら最終更新日を自動打刻（simple trigger） */
function onEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== LEDGER) return;
    const row = e.range.getRow(), col = e.range.getColumn();
    if (row < L.dataStart || col === L.col.updated) return;
    sh.getRange(row, L.col.updated).setValue(_todayStr());
  } catch (err) { /* no-op */ }
}

function _uniqueName(ss, name) {
  let n = name, i = 2;
  while (ss.getSheetByName(n)) { n = name + ' (' + i + ')'; i++; }
  return n;
}
