// 一括操作の undo 用「タスクスナップショット」と復元の SSoT。
// table.js / smartlist.js が同一の snapshot/restoreSnap をクロージャ内に再実装していたのを集約（横断監査 Q4）。
// ※ wireBulk 全体の共通化はしない（selectedIds/history のクロージャが view ごとに別フレームで、
//   共通化すると履歴スタックが統一され挙動が変わるため）。ここは「1件分の状態の取得/復元」だけ。
import { EMPTY_DATE } from "./capacity.js";
import { WAITING_LABEL } from "./kinds.js";

// 編集対象になり得るスカラ＋連絡待ち＋担当/分類の集合を1件ぶん取る（純関数・テスト対象）。
export const snapshotTask = (t) => ({
  id: t.id, done: !!t.done, percent_done: t.percent_done || 0, started_at: t.started_at || null,
  priority: t.priority || 0, is_favorite: !!t.is_favorite,
  due_date: (t.due_date && !t.due_date.startsWith("0001")) ? t.due_date : EMPTY_DATE,
  waiting: (t.labels || []).some((l) => (l.title || "") === WAITING_LABEL),
  assignees: (t.assignees || []).map((a) => a.id), labels: (t.labels || []).map((l) => l.id),
});

// スナップショットへ復元（現在 API 状態から差分適用）。担当/分類は add/remove で集合一致させる。
// fallbackTask(id): getTask 失敗時の代替タスク取得（view 側の taskOf を渡す）。
// ※ api.js はブラウザ専用（node 不可）なので動的 import。ブラウザでは既ロード済み＝キャッシュ即解決で挙動同値。
// 返り値: { restored: bool, errors: [] }。呼び出し側は無視しても従来どおり動く（後方互換）が、
// undo の部分失敗を検知したい場合に使える（各 API 失敗は throw せず errors に集約＝挙動同値）。
export async function restoreTask(s, fallbackTask) {
  const { getTask, updateTask, setTaskWaiting, addAssignee, removeAssignee, addTaskLabel, removeTaskLabel } = await import("./api.js");
  const errors = [];
  const guard = (p) => p.catch((e) => { errors.push(e); });
  let cur = null; try { cur = await getTask(s.id); } catch { cur = fallbackTask ? fallbackTask(s.id) : null; }
  await guard(updateTask(s.id, { done: s.done, percent_done: s.percent_done, started_at: s.started_at, priority: s.priority, due_date: s.due_date, is_favorite: s.is_favorite }));
  await guard(setTaskWaiting(cur || { id: s.id, labels: [] }, s.waiting));
  const curAs = ((cur && cur.assignees) || []).map((a) => a.id), tAs = new Set(s.assignees);
  for (const a of curAs) if (!tAs.has(a)) await guard(removeAssignee(s.id, a));
  for (const a of s.assignees) if (!curAs.includes(a)) await guard(addAssignee(s.id, a));
  const curLb = ((cur && cur.labels) || []).filter((l) => (l.title || "") !== WAITING_LABEL).map((l) => l.id), tLb = new Set(s.labels);
  for (const l of curLb) if (!tLb.has(l)) await guard(removeTaskLabel(s.id, l));
  for (const l of s.labels) if (!curLb.includes(l)) await guard(addTaskLabel(s.id, l));
  return { restored: errors.length === 0, errors };
}
