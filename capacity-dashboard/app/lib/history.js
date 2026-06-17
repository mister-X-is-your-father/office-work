// 操作履歴（Undo/Redo）— アプリ全体で共有するシングルトンの履歴スタック。
// Vanilla ESM・ビルド不要。状態は変えず「逆操作/再操作の関数」を積むだけ＝
// どの画面でも push({label, undo, redo}) すれば Ctrl+Z / Ctrl+Y で取り消し/やり直しできる。
//
// 設計方針:
//  - 各アクションは {label, undo, redo} を持つ。undo()/redo() は async 可（API 呼び出しを内包）。
//  - push すると redo スタックはクリア（分岐した未来は捨てる＝一般的な Undo の挙動）。
//  - 実行中は簡易ロックで多重発火を防ぐ（連打・キーリピート対策）。
//  - subscribe(fn) で状態変化を購読＝UIボタンの活性/非活性を更新できる。
//
// 削除は履歴対象外（このスタックには積まない）。Vikunja は soft delete だが
// 完全復元の保証が難しいため、削除は既存の Undo トースト方式に任せる。

const LIMIT = 50;          // スタック上限（古いものから捨てる）
let undoStack = [];        // [{label, undo, redo}]
let redoStack = [];
let busy = false;          // 実行中ロック（多重発火防止）
const listeners = new Set();

function notify() {
  const st = { canUndo: canUndo(), canRedo: canRedo(), busy };
  listeners.forEach((fn) => { try { fn(st); } catch { /* noop */ } });
}

// 操作を1件積む。redo スタックはクリア。上限を超えたら最古を捨てる。
export function push(action) {
  if (!action || typeof action.undo !== "function" || typeof action.redo !== "function") return;
  undoStack.push({ label: action.label || "操作", undo: action.undo, redo: action.redo });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
  notify();
}

export function canUndo() { return !busy && undoStack.length > 0; }
export function canRedo() { return !busy && redoStack.length > 0; }

// 直近の操作を取り消す。成功したら redo スタックへ移す。
export async function undo() {
  if (busy || !undoStack.length) return;
  const a = undoStack.pop();
  busy = true; notify();
  try { await a.undo(); redoStack.push(a); }
  catch (e) { undoStack.push(a); console.warn("undo 失敗", e); } // 失敗時は戻す（履歴を壊さない）
  finally { busy = false; notify(); }
}

// 直近に取り消した操作をやり直す。成功したら undo スタックへ戻す。
export async function redo() {
  if (busy || !redoStack.length) return;
  const a = redoStack.pop();
  busy = true; notify();
  try { await a.redo(); undoStack.push(a); }
  catch (e) { redoStack.push(a); console.warn("redo 失敗", e); }
  finally { busy = false; notify(); }
}

// 状態変化（push/undo/redo/busy）を購読。即座に現状態でも1回呼ぶ。解除関数を返す。
export function subscribe(fn) {
  listeners.add(fn);
  try { fn({ canUndo: canUndo(), canRedo: canRedo(), busy }); } catch { /* noop */ }
  return () => listeners.delete(fn);
}

// テスト/画面破棄時に履歴を空にする（任意）。
export function clear() { undoStack = []; redoStack = []; notify(); }

// ── グローバルホットキー（Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z / Ctrl+Y = redo）──
// 入力中（input/textarea/contenteditable・select）やモーダル内ではブラウザ標準/IMEを妨げないよう無視。
let hotkeysInited = false;
function isEditingContext(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  // モーダル/小メニュー内のキー入力は素通し（タスク編集モーダル・各種ポップ）
  if (el.closest && el.closest('.tf-modal, .tb-ctx, [role="dialog"], .modal')) return true;
  return false;
}

export function initHistoryHotkeys() {
  if (hotkeysInited || typeof window === "undefined") return;
  hotkeysInited = true;
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = (e.key || "").toLowerCase();
    if (k !== "z" && k !== "y") return;
    if (isEditingContext(e.target)) return;   // 入力中はブラウザ標準の取り消しに任せる
    const isRedo = (k === "y") || (k === "z" && e.shiftKey);
    if (isRedo) {
      if (!canRedo()) return;
      e.preventDefault(); redo();
    } else {
      if (!canUndo()) return;
      e.preventDefault(); undo();
    }
  });
}
