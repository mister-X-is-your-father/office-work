// onApply（捕捉した実行準備 → 物理アクション）の純粋ロジック。
// browser 依存（document/api）を持たないので node でユニットテストできる。
// 実際の副作用（updateTask/logPlan/createTaskInProject 等）は views/exec-support.js の wire 側が担う。

// 最小の HTML エスケープ（description 等へ埋める user 文字列用）。
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 指揮官の意図ブロックの番兵（description 内で upsert する範囲を一意に区切る）。
export const CI_OPEN = "<!--es:ci-->";
export const CI_CLOSE = "<!--es:/ci-->";

// task.description の先頭に「◎意図/終末状態」ブロックを upsert（既存番兵ブロックは置換）。
//   purpose も endState も空なら既存ブロックを除去するだけ（＝意図のクリア）。返り値=新 description。
//   非破壊（元の説明本文は保持）。HTML は番兵コメントで挟むので再適用しても重複しない。
export function upsertIntentBlock(description, { purpose = "", endState = "", mustHold = "", acceptableLoss = "" } = {}) {
  const desc = String(description || "");
  const stripped = desc.replace(new RegExp(CI_OPEN + "[\\s\\S]*?" + CI_CLOSE, "g"), "").replace(/^\s+/, "");
  const p = String(purpose || "").trim(), e = String(endState || "").trim();
  if (!p && !e) return stripped; // 空＝ブロック除去のみ
  const lines = [];
  if (p) lines.push(`<strong>◎ 意図</strong>: ${escHtml(p)}`);
  if (e) lines.push(`<strong>終末状態</strong>: ${escHtml(e)}`);
  const mh = String(mustHold || "").trim(); if (mh) lines.push(`<strong>必須</strong>: ${escHtml(mh)}`);
  const al = String(acceptableLoss || "").trim(); if (al) lines.push(`<strong>削ってよい</strong>: ${escHtml(al)}`);
  const block = `${CI_OPEN}<p>${lines.join("<br>")}</p>${CI_CLOSE}`;
  return stripped ? `${block}\n${stripped}` : block;
}

// eisenhower 象限 → Vikunja priority。重要×緊急=4(緊急) / 重要×非緊急=3(高) / 非重要=null（優先度は上げない）。
export function eisenhowerPriority(important, urgent) {
  if (important && urgent) return 4;
  if (important && !urgent) return 3;
  return null;
}

// "HH:MM" → 0時からの分（logPlan の start_minute 用）。不正は null。
export function hhmmToMinutes(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

// 高影響・未解消の未知 → steps へ挿入する「先行検証」手順（slice=true で今日寄り前方配置）。
//   uid 生成は注入可能（テストで決定論にするため）。impact!=high / resolved / 空 は対象外。
export function unknownsToSteps(items, { uid = () => Math.random().toString(36).slice(2, 9) } = {}) {
  return (items || [])
    .filter((it) => it && it.impact === "high" && !it.resolved && String(it.unknown || "").trim())
    .map((it) => ({ __id: uid(), title: `[先行検証] ${String(it.unknown).trim()}`, est: "", due: it.due || "", slice: true, kind: "自作業" }));
}
