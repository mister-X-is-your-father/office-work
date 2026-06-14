// スマートリスト（TickTick の Smart List 相当・ブラッシュアップ）。純関数＋組み込みビュー定義。
// フィルタはローカル保存（localStorage・スキーマ変更なし）。タスク判定は taskMatches。
import { shiftISO, dateOnly, hasDate, hasStarted } from "./capacity.js";

// フィルタの既定（空＝条件なし）
export const EMPTY_FILTER = { text: "", due: "", prio: "", ws: 0, status: "undone", flag: false };

// 組み込みビュー: TickTick の左レール相当。preset は taskMatches に渡すフィルタ。
// ws=Inbox は呼び出し側で inboxWsId を differ で埋める（id は環境依存のため）。
export const BUILTIN_VIEWS = [
  { key: "inbox", label: "インボックス", icon: "📥", inbox: true, filter: { status: "undone" } },
  { key: "today", label: "今日", icon: "📅", filter: { due: "today", status: "undone" } },
  { key: "next7", label: "次の7日間", icon: "🗓️", filter: { due: "next7", status: "undone" } },
  { key: "overdue", label: "期限切れ", icon: "⚠️", filter: { due: "overdue", status: "undone" } },
  { key: "important", label: "重要", icon: "⭐", filter: { prio: "high", status: "undone" } },
  { key: "flagged", label: "フラグ", icon: "🚩", filter: { flag: true, status: "undone" } },
  { key: "nodate", label: "期限なし", icon: "📭", filter: { due: "none", status: "undone" } },
  { key: "waiting", label: "連絡待ち", icon: "⏳", filter: { status: "waiting" } },
  { key: "completed", label: "完了", icon: "✓", filter: { status: "done" } },
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

  if (f.text) {
    const q = String(f.text).toLowerCase();
    if (!`${t.title || ""} ${t.description || ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}
