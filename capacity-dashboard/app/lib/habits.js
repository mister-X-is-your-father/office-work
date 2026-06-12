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
