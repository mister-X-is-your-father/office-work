// 習慣トラッカーの純ロジック（TickTickの習慣相当）。
// データはスキーマ変更なし: 習慣=「習慣」WS のタスク（担当=本人）、チェック=実績エントリ(logged_on の日付)。
// ここは日付集合に対する計算のみ（テスト対象）。CRUD は views/habits.js。

export const HABIT_WS = "習慣";

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 連続日数: today から遡って連続チェックを数える。today 未チェックでも昨日まで続いていれば
// ストリーク継続中（今日まだやってないだけ）として昨日起点で数える。
export function habitStreak(dates, todayISO) {
  const has = (iso) => dates.has(iso);
  let cur = has(todayISO) ? todayISO : (has(addDays(todayISO, -1)) ? addDays(todayISO, -1) : null);
  let n = 0;
  while (cur && has(cur)) { n++; cur = addDays(cur, -1); }
  return n;
}

// 直近 n 日の [{iso, done}]（古い→新しい・末尾=today）。週ストリップ表示用。
export function lastDays(dates, todayISO, n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const iso = addDays(todayISO, -i);
    out.push({ iso, done: dates.has(iso) });
  }
  return out;
}

// ── C11: 目標頻度 ───────────────────────────────────────────────
// スキーマ変更なし。習慣タスクの description にメタ記法で保持する:
//   [目標:毎日] / [目標:平日] / [目標:週3]（週N回）
// description 本文（メモ）は壊さず、目標行だけを足し引きする純ロジック。
//
// goal の正規化形: { type: "daily"|"weekdays"|"week_n", n?: number }
//   - daily    … 毎日（週7回相当）
//   - weekdays … 平日のみ（月〜金）
//   - week_n   … 週 n 回（n は 1..7）

const GOAL_RE = /^\s*\[目標:\s*([^\]]+?)\s*\]\s*$/;

const dow = (iso) => new Date(iso + "T00:00:00Z").getUTCDay(); // 0=日 .. 6=土
const isWeekday = (iso) => { const d = dow(iso); return d >= 1 && d <= 5; };

// 目標の中身（"毎日" / "平日" / "週3" / "3" 等）を正規化形に解釈。不明は null。
export function parseGoalToken(token) {
  const s = String(token || "").trim();
  if (!s) return null;
  if (s === "毎日" || s === "daily") return { type: "daily" };
  if (s === "平日" || s === "平日のみ" || s === "weekdays") return { type: "weekdays" };
  // "週3" / "週 3" / "3回" / "3"
  const m = s.match(/(\d+)/);
  if (m) {
    const n = Math.min(7, Math.max(1, parseInt(m[1], 10)));
    if (Number.isFinite(n)) return { type: "week_n", n };
  }
  return null;
}

// description から目標を解釈。無ければ null。
export function parseGoal(desc) {
  for (const line of String(desc || "").split("\n")) {
    const m = line.match(GOAL_RE);
    if (m) { const g = parseGoalToken(m[1]); if (g) return g; }
  }
  return null;
}

// 正規化形 → メタ記法のトークン（"毎日"/"平日"/"週3"）。null は "" 。
function goalToken(goal) {
  if (!goal) return "";
  if (goal.type === "daily") return "毎日";
  if (goal.type === "weekdays") return "平日";
  if (goal.type === "week_n") return "週" + goal.n;
  return "";
}

// 表示用ラベル（"毎日" / "平日のみ" / "週3回"）。null は "" 。
export function goalLabel(goal) {
  if (!goal) return "";
  if (goal.type === "daily") return "毎日";
  if (goal.type === "weekdays") return "平日のみ";
  if (goal.type === "week_n") return "週" + goal.n + "回";
  return "";
}

// description に目標を書き込む（既存の [目標:…] 行は除去してから足す）。
// goal=null で目標解除。本文（その他の行）は順序保持で温存する。
export function setGoalMeta(desc, goal) {
  const kept = String(desc || "").split("\n").filter((l) => !GOAL_RE.test(l));
  // 末尾の余分な空行を畳む
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  const token = goalToken(goal);
  if (!token) return kept.join("\n");
  const body = kept.join("\n").replace(/\s+$/, "");
  return (body ? body + "\n" : "") + "[目標:" + token + "]";
}

// 今週（日曜起点〜today まで）の日付 iso 配列（古い→新しい・today 含む）。
export function weekToDate(todayISO) {
  const back = dow(todayISO); // 日曜起点。0..6
  const out = [];
  for (let i = back; i >= 0; i--) out.push(addDays(todayISO, -i));
  return out;
}

// 目標に対する「今週の達成 N / 目標 M」。
// done   … 今週（日曜〜today）の達成回数（平日目標なら平日のみカウント）
// target … 目標回数（毎日=7 / 平日=5 / 週n=n）
// met    … done >= target
// type   … goal の type（呼び出し側の表示分岐用）
export function weekProgress(dates, todayISO, goal) {
  if (!goal) return null;
  const week = weekToDate(todayISO);
  let target, done;
  if (goal.type === "daily") {
    target = 7;
    done = week.filter((iso) => dates.has(iso)).length;
  } else if (goal.type === "weekdays") {
    target = 5;
    done = week.filter((iso) => isWeekday(iso) && dates.has(iso)).length;
  } else { // week_n
    target = goal.n;
    done = week.filter((iso) => dates.has(iso)).length;
  }
  return { done, target, met: done >= target, type: goal.type, n: goal.n };
}
