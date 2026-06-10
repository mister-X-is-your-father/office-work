// 種別(kind)の単一定義（ADR-012）。kind＝「どんな仕事か」の単一軸。
// 当日追加・前倒しは kind ではなく「時間属性(flags)」として別軸で持つ（today_items.js）。
// 表示トークン（色/模様/ラベル/並び順）をここに一元化し、clock/review/将来ビューで共有する。

export const REVIEW_LABEL = "レビュー";
export const isReviewTask = (t) => (t.labels || []).some((l) => (l.title || "") === REVIEW_LABEL);

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

// 優先度→色（最優先=赤 / 高=橙 / 中=青 / 低=灰）。会議/定例は優先度なし→中立色。
export const PRIO = { 4: { c: "#e5484d", n: "最優先" }, 3: { c: "#f5872e", n: "高" }, 2: { c: "#3a86ff", n: "中" }, 1: { c: "#8a93a0", n: "低" } };
export const NEUTRAL = "#8a93a0";

// Vikunja priority(0–5) → 4段バケット
export function prioBucket(p) {
  const n = p || 0;
  return n >= 4 ? 4 : (n === 3 ? 3 : (n === 2 ? 2 : 1));
}
