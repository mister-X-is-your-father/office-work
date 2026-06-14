import { hasStarted } from "./capacity.js"; // capacity.js は import 0 の末端＝循環なし

// 種別(kind)の単一定義（ADR-012）。kind＝「どんな仕事か」の単一軸。
// 当日追加・前倒しは kind ではなく「時間属性(flags)」として別軸で持つ（today_items.js）。
// 表示トークン（色/模様/ラベル/並び順）をここに一元化し、clock/review/将来ビューで共有する。

export const REVIEW_LABEL = "レビュー";
export const isReviewTask = (t) => (t.labels || []).some((l) => (l.title || "") === REVIEW_LABEL);

// 分類 = ユーザー定義のラベル（例: エンジニア依頼/定常業務）。kind 軸とは独立。
// 「レビュー」ラベルだけは kind 判定（上）に使う予約語なので分類からは除外する。
export const categoryLabels = (t) => (t.labels || []).filter((l) => (l.title || "") !== REVIEW_LABEL);
const CAT_PAL = ["#3a86ff", "#2fa66b", "#b657d6", "#e5772d", "#0ea5e9", "#f5a623", "#ef476f", "#14b8a6"];
export const categoryColor = (label) => CAT_PAL[(label && label.id ? label.id : 0) % CAT_PAL.length];

// kind: meeting | recurring | review | task
// pattern はクロックの模様（ベタ/斜線/ドット/リング）。並び順＝定義順（会議→定例→レビュー→タスク）。
export const KINDS = {
  meeting:   { label: "会議",       pattern: "meeting" },
  recurring: { label: "定例",       pattern: "routine" },
  review:    { label: "レビュー",   pattern: "review" },
  task:      { label: "予定タスク", pattern: "task" },
};
export const KIND_ORDER = ["meeting", "recurring", "review", "task"];
export const kindRank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };

// タスク側の kind 判定（会議/定例は recurrences 由来なのでここでは扱わない）。
export const kindOf = (task) => (isReviewTask(task) ? "review" : "task");

export const NEUTRAL = "#8a93a0"; // 重要度なし／会議・定例の中立色（PRIO_LEVELS より前に宣言）

// 重要度の単一定義（SSoT）。0=なし(中立) .. 4=MUST。色/ラベル/順序をここだけで持つ。
// 色: MUST=赤 / 高=橙 / 中=青 / 低=灰 / なし=中立。
export const PRIO_LEVELS = [
  { v: 0, n: "なし",  c: NEUTRAL },
  { v: 1, n: "低",    c: "#8a93a0" },
  { v: 2, n: "中",    c: "#3a86ff" },
  { v: 3, n: "高",    c: "#f5872e" },
  { v: 4, n: "MUST",  c: "#e5484d" },
];
// 添字参照用 map（既存の PRIO[x].c / .n と完全互換。0キーが増えるだけ）。
export const PRIO = Object.fromEntries(PRIO_LEVELS.map((p) => [p.v, { c: p.c, n: p.n }]));
// 重要度の選択肢 [v, label]（taskform / table の編集UIで共有）。
export const PRIO_OPTS = PRIO_LEVELS.map((p) => [p.v, p.n]);

// Vikunja priority(0–5) → 0(なし)/1/2/3/4(MUST)。5 は MUST に丸める。0/undefined は 0。
export function prioBucket(p) { const n = p || 0; return n >= 4 ? 4 : n; }

// ステータスの単一定義（SSoT）。キー=todo/doing/done、label=表示、rank=並び順（未着手<進行中<完了）。
export const STATUS = {
  todo:  { label: "未着手", rank: 0 },
  doing: { label: "進行中", rank: 1 },
  done:  { label: "完了",   rank: 2 },
};
// task → ステータスキー（done 優先 → 着手済み(hasStarted) → todo）。判定ロジックの SSoT。
// hasStarted = started_at あり or percent_done>0（capacity.js）。
export const statusOf = (t) => (t.done ? "done" : (hasStarted(t) ? "doing" : "todo"));
