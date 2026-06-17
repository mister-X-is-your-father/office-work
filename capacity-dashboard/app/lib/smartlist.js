// スマートリスト（TickTick の Smart List 相当・ブラッシュアップ）。純関数＋組み込みビュー定義。
// フィルタはローカル保存（localStorage・スキーマ変更なし）。タスク判定は taskMatches。
import { shiftISO, dateOnly, hasDate, hasStarted } from "./capacity.js";

// フィルタの既定（空＝条件なし）
export const EMPTY_FILTER = { text: "", due: "", prio: "", ws: 0, status: "undone", flag: false, unsorted: false };

// AI（fable）担当の判定。lib/store.js の isAiUser と同義だが、循環 import を避けるため
// ここに最小実装をインライン（AI_USERNAMES=["fable"] と同一基準。増えたら両方更新）。
const isAiAssignee = (u) => !!u && (u.username === "fable");
// 人間担当が1人でもいるか（AI=fable は段取り済み扱いしない）。
const hasHumanAssignee = (t) => (t.assignees || []).some((a) => !isAiAssignee(a));

// 組み込みビュー: TickTick の左レール相当。preset は taskMatches に渡すフィルタ。
// desc は各ビューの1行説明（views/smartlist.js がタイトル直下に表示する）。
// icon は共通アイコン名（views/smartlist.js が icon(name) で SVG 描画する）。
export const BUILTIN_VIEWS = [
  // 未整理＝未完了で「人間担当が未設定 or 期限が未設定」＝まだ段取りされてないタスク（unsorted フラグで判定）。
  { key: "inbox", label: "未整理", icon: "inbox", filter: { status: "undone", unsorted: true },
    desc: "未完了で、担当者 or 期限が未設定。" },
  { key: "today", label: "今日", icon: "calendar", filter: { due: "today", status: "undone" },
    desc: "今日が期限の未完了タスク。" },
  { key: "next7", label: "次の7日間", icon: "calendarDays", filter: { due: "next7", status: "undone" },
    desc: "今日から7日以内が期限の未完了タスク。" },
  { key: "overdue", label: "期限切れ", icon: "alertTriangle", filter: { due: "overdue", status: "undone" },
    desc: "期限を過ぎた未完了タスク。早めに対応。" },
  { key: "important", label: "重要", icon: "star", filter: { prio: "high", status: "undone" },
    desc: "重要度「高」以上の未完了タスク。" },
  { key: "flagged", label: "フラグ", icon: "flag", filter: { flag: true, status: "undone" },
    desc: "フラグを付けた未完了タスク。" },
  { key: "nodate", label: "期限なし", icon: "inbox", filter: { due: "none", status: "undone" },
    desc: "期限が未設定の未完了タスク。" },
  { key: "waiting", label: "連絡待ち", icon: "hourglass", filter: { status: "waiting" },
    desc: "相手の返事・対応を待っているタスク。" },
  { key: "completed", label: "完了", icon: "check", filter: { status: "done" },
    desc: "完了したタスク。" },
];

// 「次の7日間」= 今日を含む7日（today .. today+6）
export const next7End = (todayISO) => shiftISO(todayISO, 6);

// タスクが filter に一致するか（category は呼び出し側で別途・kinds 依存を避ける）。
// ctx: { today, next7 }（next7=next7End(today)）
export function taskMatches(t, f, ctx) {
  const due = hasDate(t.due_date) ? dateOnly(t.due_date) : "";
  const done = !!t.done, started = hasStarted(t), prio = t.priority || 0;
  // 連絡待ち（GTD Waiting For）= 予約ラベル。kinds 非依存方針なので文字列はここでインライン判定。
  const waiting = (t.labels || []).some((l) => (l.title || "") === "連絡待ち");

  if (f.status === "done" && !done) return false;
  if (f.status === "undone" && done) return false;
  if (f.status === "waiting" && (done || !waiting)) return false;
  if (f.status === "todo" && (done || started || waiting)) return false;     // 連絡待ちは todo に含めない
  if (f.status === "doing" && (done || !started || waiting)) return false;    // 連絡待ちは doing に含めない（待ち優先）

  if (f.due === "today" && due !== ctx.today) return false;
  if (f.due === "overdue" && !(due && due < ctx.today && !done)) return false;
  if (f.due === "next7" && !(due && due >= ctx.today && due <= ctx.next7)) return false;
  if (f.due === "none" && due) return false;
  if (f.due === "hasdue" && !due) return false;

  if (f.prio === "top" && prio < 4) return false;
  if (f.prio === "high" && prio < 3) return false;
  if (f.prio === "mid" && prio < 2) return false;
  if (f.prio === "none" && prio > 0) return false;

  if (f.ws && t.project_id !== f.ws) return false;
  if (f.flag && !t.is_favorite) return false;

  // 未整理（unsorted）= まだ段取りされてない＝「人間担当あり かつ 期限あり」を除外（担当なし or 期限なしのみ通す）。
  if (f.unsorted && hasHumanAssignee(t) && due) return false;

  if (f.text) {
    const q = String(f.text).toLowerCase();
    if (!`${t.title || ""} ${t.description || ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}
