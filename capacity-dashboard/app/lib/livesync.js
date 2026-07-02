// ライブ同期（ポーリング＋フォーカス時即時）: 他者/AI(MCP)による変更をリロード無しで自動反映する。
// 仕組み: タブ表示中のみ一定間隔で /tasks/all を取得し、キャッシュ(rawTasks)との署名差分が
// あるときだけ invalidate + onChange（現在ルートの再描画）。自分の編集はキャッシュが既に
// 最新＝署名一致なので再描画しない（無駄な点滅なし）。ユーザーの編集コンテキストを壊さない
// よう、モーダル/メニュー/インライン編集/入力フォーカス/ドラッグ中は見送り、次ティックで再試行。
import * as vik from "./api.js";
import { load, invalidate } from "./store.js";

const INTERVAL_MS = 12000; // ローカルAPI前提の体感重視（/tasks/all 1本＝軽量）
let _timer = null;
let _onChange = null;
let _busy = false;

// タスク集合の変更署名。id/updated/done で「見た目に効く変更」を概ね捕捉する
// （タイトル・進捗・期限・ラベル・担当・親子関連の変更は updated が進む）。
const sigOf = (tasks) => {
  const arr = tasks || [];
  let s = String(arr.length);
  for (const t of arr) s += `|${t.id}:${t.updated || ""}:${t.done ? 1 : 0}`;
  return s;
};

// 今すぐ再描画してよいか（ユーザーの操作・入力を壊さない）。
function safeToRender() {
  if (document.visibilityState !== "visible") return false;
  // モーダル（タスク編集/クロック）・コンテキストメニュー・グリッドのインライン編集・DnD 中は見送り
  if (document.querySelector(".tf-modal, .ck-modal, .tb-ctx, .tb-gedit, .ol-dragging, .tb-dragging")) return false;
  // 何かの入力欄にフォーカス中（クイック追加・検索・インライン入力等）も見送り
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return false;
  return true;
}

async function tick() {
  if (_busy || document.visibilityState !== "visible") return;
  _busy = true;
  try {
    const cur = await load();             // キャッシュ（未ロードなら取得）
    const fresh = await vik.getTasks();   // サーバの現況（/tasks/all 1本）
    if (sigOf(fresh) !== sigOf(cur.rawTasks)) {
      if (!safeToRender()) return;        // 編集中＝見送り（差分は残るので次ティックで再試行）
      invalidate();
      if (_onChange) await _onChange();
    }
  } catch { /* オフライン・認証前などは静かに見送り（次ティックで再試行） */ }
  finally { _busy = false; }
}

// ライブ同期を開始する（多重呼び出しは無視＝タイマーは常に1本）。
// onChange には「現在ルートを再描画する関数」を渡す（app.js の route）。
export function startLiveSync(onChange) {
  _onChange = onChange;
  if (_timer) return;
  _timer = setInterval(tick, INTERVAL_MS);
  // タブ復帰・ウィンドウフォーカスで即時チェック＝「戻ってきたら最新」の体感を作る
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
  window.addEventListener("focus", () => tick());
}
