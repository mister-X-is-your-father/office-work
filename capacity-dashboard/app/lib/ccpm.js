// 逆算スケジューリング（CCPM）の純関数コア。
// もともと views/exec-support.js 内に閉じていた backcast とその純ヘルパを lib に切り出した
//   ＝ browser 依存（document/location/store/api）を一切持たないので node でユニットテストできる。
// exec-support.js はここから import して使う（committedHoursByDayInRange と同じ作法）。
//
// ⚠️ 既存機能の不変条件（テストで pin 済み・改修時に壊さないこと）:
//   - F1 横断逆算: committedByDay（他タスクの当日予定）を実空きから差し引く。
//   - E4 再逆算 床止め: todayIso より前（過去日）には絶対に手順を置かない。
//   - F6 ディープワーク枠: taskIsImportant（priority>=4）なら deep 枠を実空きに含める（避けない）。
import { shiftISO } from "./capacity.js";

// 見積り(h) を数値化。空・不正は null（＝「1日1件」扱いの目印）。
export function estHours(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "HH:MM" → 時間(h, 小数)。不正は null。
export function hhmmToH(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return +m[1] + +m[2] / 60;
}

// その曜日(0=日)に重なる保護時間帯の合計時間(h)。windows=[{days,start,end,kind}]。
// includeDeep=false のとき deep 枠は集計しない（重要タスクの逆算が deep 枠を実空きに使えるように）。
export function protectedHoursOnDow(windows, dow, { includeDeep = true } = {}) {
  let total = 0;
  for (const w of windows || []) {
    if (!w || !Array.isArray(w.days) || !w.days.includes(dow)) continue;
    if (w.kind === "deep" && !includeDeep) continue; // 重要タスクは deep 枠を差し引かない（=使える）
    const s = hhmmToH(w.start), e = hhmmToH(w.end);
    if (s == null || e == null || e <= s) continue;
    total += e - s;
  }
  return total;
}

// その日(iso)が担当の休暇日か（unavailRanges=[{start,end}] 日付のみ・両端含む）。
export function isUnavailable(iso, unavailRanges) {
  for (const r of unavailRanges || []) {
    if (r && r.start && r.end && r.start <= iso && iso <= r.end) return true;
  }
  return false;
}

// その日に作業できるか（営業日＝土日除外・祝日除外・休暇除外）。
export function isWorkDay(iso, holidaysSet, unavailRanges) {
  const dow = new Date(iso + "T00:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (holidaysSet && holidaysSet.has && holidaysSet.has(iso)) return false;
  if (isUnavailable(iso, unavailRanges)) return false;
  return true;
}

// ローカル今日の "YYYY-MM-DD"（床止め用）。iso 比較は文字列の辞書順で行えるよう zero-pad。
export function localTodayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── 逆算スケジュール（純関数・TDD対象） ─────────────────────────────
// 締切日から後ろ向きに営業日（土日/祝日/担当の休暇を除外）を辿り、
// 手順を逆順（最後の手順が締切寄り）に各日の作業可能時間へ詰める。
//   1日の作業可能時間 = capH×(1 − bufferPct/100) − その曜日に重なる保護時間帯の合計（下限0）。
//     ＝1日バッファ（容量を食いつぶさない）を確保したうえで保護枠も差し引く。
//   見積り無しの手順は「1日1件」扱い（その日の残量を使い切る＝1日1件で次の日へ）。
// 引数: { steps:[{est}], deadlineIso, capH, windows, holidaysSet, unavailRanges, bufferPct, todayIso }
//   bufferPct=各日の容量から差し引くバッファ率（0〜90 整数・省略時0＝後方互換）。
//   todayIso=ローカル今日の "YYYY-MM-DD"。後ろ向きに辿る際、この日より前へは配置しない（床止め）。
//     省略時は内部でローカル今日を算出（後方互換・呼び出し側からは必ず渡す）。
//     ＝配置可能区間は [todayIso 〜 deadlineIso] の営業日のみ。締切が過去なら 0 日→全手順 unplaced。
//   committedByDay=Map<"YYYY-MM-DD", h>（他タスクが既にその日に入れている予定負荷・F1）。省略時は0扱い。
//   taskIsImportant=true（優先度高 priority>=4）なら deep 枠を実空きに含める（F6 ディープワーク枠）。既定 false＝通常どおり deep も避ける。
// 返り値: { dueByIndex: Map<stepIndex, iso>, unplaced: number }
export function backcast({ steps, deadlineIso, capH = 8, windows = [], holidaysSet = null, unavailRanges = [], bufferPct = 0, todayIso = localTodayIso(), committedByDay = null, taskIsImportant = false }) {
  const dueByIndex = new Map();
  const list = steps || [];
  if (!list.length || !deadlineIso || deadlineIso.startsWith("0001")) {
    return { dueByIndex, unplaced: list.length };
  }
  // 床止め: 過去（昨日以前）には配置しない。todayIso が不正なら床止め無し（後方互換）。
  const floorIso = (typeof todayIso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(todayIso)) ? todayIso : null;
  // 締切日から後ろ向きに営業日を生成するイテレータ。
  let cursor = deadlineIso;
  let guard = 0;
  const nextWorkDay = () => {
    // 現在の cursor 以前で最初の作業可能日を返し、cursor をその前日へ進める。
    while (guard++ < 4000) {
      // 床止め: cursor が今日より前まで遡ったら、以降は配置不可（過去には置かない）。
      if (floorIso && cursor < floorIso) return null;
      if (isWorkDay(cursor, holidaysSet, unavailRanges)) {
        const day = cursor;
        cursor = shiftISO(cursor, -1);
        return day;
      }
      cursor = shiftISO(cursor, -1);
    }
    return null;
  };
  // バッファ率を 0〜90 の整数へ正規化（不正・範囲外は安全側へ丸め）。
  const buf = Math.max(0, Math.min(90, Math.round(Number(bufferPct) || 0)));
  const committedOn = (iso) => (committedByDay && committedByDay.get) ? (committedByDay.get(iso) || 0) : 0;
  const capOf = (iso) => {
    const dow = new Date(iso + "T00:00:00Z").getUTCDay();
    // capH からバッファ分を引いた「実空き」、保護時間帯＋他タスクの当日予定(F1)を差し引く（下限0）。
    return Math.max(0, capH * (1 - buf / 100) - protectedHoursOnDow(windows, dow, { includeDeep: !taskIsImportant }) - committedOn(iso));
  };

  // 手順を逆順（末尾＝締切寄り）に詰める。
  let curDay = null, remain = 0;
  let unplaced = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const est = estHours(list[i] && list[i].est); // null=見積り無し（1日1件）
    if (curDay == null) {
      curDay = nextWorkDay();
      if (curDay == null) { unplaced = i + 1; break; }
      remain = capOf(curDay);
    }
    if (est == null) {
      // 見積り無し: その日に置いて翌（前）営業日へ送る（1日1件）。
      dueByIndex.set(i, curDay);
      curDay = null; remain = 0;
      continue;
    }
    // 見積りがその日の残量に収まらなければ前の作業日へ送る。
    if (est > remain + 1e-9) {
      // 残量0の日に1日丸ごと使っても収まらない巨大手順も、1日に置く（無限ループ回避）。
      const fresh = nextWorkDay();
      if (fresh == null) { unplaced = i + 1; break; }
      curDay = fresh; remain = capOf(curDay);
      // 新しい日でも収まらない（est > 1日容量）場合はその日に置いて消費しきる。
      if (est > remain + 1e-9) {
        dueByIndex.set(i, curDay);
        curDay = null; remain = 0;
        continue;
      }
    }
    dueByIndex.set(i, curDay);
    remain -= est;
    if (remain <= 1e-9) { curDay = null; remain = 0; }
  }
  return { dueByIndex, unplaced };
}
