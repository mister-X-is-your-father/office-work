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
//   kind≠自作業（承認/レビュー/外部待ち）の手順は「待ち」＝est を営業日数(ceil(est/capH)・最低1)に換算して丸ごと占有し、自分の作業容量は消費しない（保護枠/他タスク予定に影響されない経過日数）。
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
    const it = list[i];
    // 待ち（kind≠自作業＝承認/レビュー/外部待ち）: リードタイムを営業日で丸ごと占有する。
    //   ＝自分の作業容量は消費しない（保護枠/他タスク予定/バッファに左右されない純粋な経過日数）。
    //   leadDays = ceil(est/capH)（最低1日）。完了日(due)は占有区間のうち最も締切寄りの日。
    if (it && it.kind && it.kind !== "自作業") {
      const leadDays = Math.max(1, Math.ceil((estHours(it.est) || 0) / (capH > 0 ? capH : 8)));
      curDay = null; remain = 0; // 待ちは新しい日から（他作業と同居させない）
      let doneDay = null, ok = true;
      for (let k = 0; k < leadDays; k++) {
        const day = nextWorkDay();
        if (day == null) { ok = false; break; }
        if (k === 0) doneDay = day; // 最初に取れた日＝最も締切寄り＝待ちの完了日
      }
      if (!ok || doneDay == null) { unplaced = i + 1; break; }
      dueByIndex.set(i, doneDay);
      continue;
    }
    const est = estHours(it && it.est); // null=見積り無し（1日1件）
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

// ── CCPM 強化（前倒し締切＋安全余裕の集約バッファ＋fever）─────────────
// 既存 backcast は一切変えず、その前段（締切の前倒し・手順estの圧縮・バッファ予約）と
// 後段（バッファ消費率=fever）を純関数で足す。schedule プラグインから呼ぶ。
//   CCPM の考え方: 各手順の楽観/悲観の安全余裕を抜いて1か所(プロジェクトバッファ)へ集約し、
//   個別締切でなくバッファの食い具合で全体の遅れを早期検知する。
const round2 = (x) => Math.round(x * 100) / 100;

// iso から n 営業日ぶん移動した日付（n<0=前へ/ n>0=後ろへ・土日祝休暇を飛ばす）。n=0 はそのまま。
//   開始日 iso 自体はカウントに含めない（addBusinessDays(金,1)=翌月曜 / addBusinessDays(月,-1)=前金曜）。
export function addBusinessDays(iso, n, { holidaysSet = null, unavailRanges = [] } = {}) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  let k = Math.trunc(Number(n) || 0);
  if (k === 0) return iso;
  const step = k > 0 ? 1 : -1;
  let cur = iso, remaining = Math.abs(k), guard = 0;
  while (remaining > 0 && guard++ < 4000) {
    cur = shiftISO(cur, step);
    if (isWorkDay(cur, holidaysSet, unavailRanges)) remaining--;
  }
  return cur;
}
// iso の n 営業日前。
export function businessDaysBefore(iso, n, opts) {
  return addBusinessDays(iso, -Math.abs(Math.trunc(Number(n) || 0)), opts);
}

// startIso から数えて count 番目（1始まり・start 自身が営業日なら 1 とカウント）の営業日。
function nthWorkDayFrom(startIso, count, { holidaysSet = null, unavailRanges = [] } = {}) {
  if (count <= 0) return startIso;
  let cur = startIso, seen = 0, guard = 0;
  while (guard++ < 4000) {
    if (isWorkDay(cur, holidaysSet, unavailRanges)) { seen++; if (seen >= count) return cur; }
    cur = shiftISO(cur, 1);
  }
  return cur;
}
// [aIso, bIso] inclusive の営業日数（土日祝休暇除く）。a>b は 0。
function countWorkDaysInclusive(aIso, bIso, { holidaysSet = null, unavailRanges = [] } = {}) {
  if (!aIso || !bIso || aIso > bIso) return 0;
  let n = 0, cur = aIso, guard = 0;
  while (cur <= bIso && guard++ < 4000) {
    if (isWorkDay(cur, holidaysSet, unavailRanges)) n++;
    cur = shiftISO(cur, 1);
  }
  return n;
}

// 各手順の見積りを aggressivePct% ぶん圧縮（安全余裕を抜く）。見積り無し(null)は据え置き。
//   返り値: { steps: [...est圧縮済みのコピー], removedSlackH: 抜いた余裕の合計h }。
//   元配列は破壊しない（浅いコピー＋est差し替え）。順序・長さは不変＝呼び出し側の index 対応はそのまま。
export function compressSteps(steps, aggressivePct) {
  const pct = Math.max(0, Math.min(90, Math.round(Number(aggressivePct) || 0)));
  let removedSlackH = 0;
  const out = (steps || []).map((s) => {
    const isWait = s && s.kind && s.kind !== "自作業";
    const e = estHours(s && s.est);
    if (e == null || isWait) return { ...s }; // 見積り無し・待ち（外部リードタイム）は圧縮しない
    const ne = round2(e * (1 - pct / 100));
    removedSlackH += (e - ne);
    return { ...s, est: ne };
  });
  return { steps: out, removedSlackH: round2(removedSlackH) };
}

// プロジェクトバッファの日数を決める。既定=抜いた余裕の半分(h)を1日容量で割って切り上げ。
//   override（手入力・空でない）があればそれを優先。返り値 { bufferDays, bufferH, auto }。
export function projectBufferDays(removedSlackH, capH = 8, override = null) {
  const cap = capH > 0 ? capH : 8;
  const auto = Math.max(0, Math.ceil((Math.max(0, removedSlackH) / 2) / cap));
  if (override != null && String(override).trim() !== "") {
    const o = Math.max(0, Math.round(Number(override) || 0));
    return { bufferDays: o, bufferH: round2(o * cap), auto };
  }
  return { bufferDays: auto, bufferH: round2(Math.max(0, removedSlackH) / 2), auto };
}

// CCPM 逆算: 前倒し締切＋集約バッファを差し引いた「作業締切」を求め、est を圧縮した手順を
// 既存 backcast に流す。返り値は backcast の {dueByIndex, unplaced}（手順は与えた配列の index）＋
//   { personalDueIso(前倒し締切), workDeadlineIso(バッファ手前=実作業の締切), bufferDays, bufferH, removedSlackH }。
//   ※ steps は呼び出し側で done 除外済みの placeSteps を渡す前提（backcast と同じ作法）。
export function ccpmPlan({
  steps, deadlineIso, capH = 8, windows = [], holidaysSet = null, unavailRanges = [],
  bufferPct = 0, todayIso = localTodayIso(), committedByDay = null, taskIsImportant = false,
  personalDueOffset = 0, aggressivePct = 0, projectBufferDaysOverride = null,
} = {}) {
  const empty = { dueByIndex: new Map(), unplaced: (steps || []).length, personalDueIso: "", workDeadlineIso: "", bufferDays: 0, bufferH: 0, removedSlackH: 0, chainWorkH: 0, squeezed: false };
  if (!deadlineIso || deadlineIso.startsWith("0001")) return empty;
  const dl = deadlineIso.slice(0, 10);
  const wopts = { holidaysSet, unavailRanges };
  const personalDueIso = businessDaysBefore(dl, personalDueOffset, wopts);
  const { steps: compressed, removedSlackH } = compressSteps(steps, aggressivePct);
  const { bufferDays, bufferH } = projectBufferDays(removedSlackH, capH, projectBufferDaysOverride);
  // 前倒し締切＋バッファを引いた作業締切。これが今日より前＝確保する余地が無い「squeezed」状態。
  //   その場合は手順を空配置にせず本締切(dl)まで使って配置し、squeezed フラグで「バッファ/前倒しを確保できない」と警告する。
  const workDeadlineRaw = businessDaysBefore(personalDueIso, bufferDays, wopts);
  let workDeadlineIso = workDeadlineRaw, squeezed = false;
  if (workDeadlineRaw < todayIso) {
    squeezed = true;
    workDeadlineIso = dl >= todayIso ? dl : todayIso; // 本締切まで戻す（本締切も過去なら今日＝backcastがunplacedで返す）
  }
  const { dueByIndex, unplaced } = backcast({
    steps: compressed, deadlineIso: workDeadlineIso, capH, windows, holidaysSet, unavailRanges,
    bufferPct, todayIso, committedByDay, taskIsImportant,
  });
  // 圧縮後の総作業時間（自分の作業＝kind=自作業 のみ。待ちは自容量を消費しないので fever の残作業から除外）。
  const chainWorkH = round2(compressed.reduce((s, st) => {
    const isWait = st && st.kind && st.kind !== "自作業";
    return s + (isWait ? 0 : (estHours(st && st.est) || 0));
  }, 0));
  return { dueByIndex, unplaced, personalDueIso, workDeadlineIso, bufferDays, bufferH, removedSlackH, chainWorkH, squeezed };
}

// slice（骨格＝walking skeleton）を配置上「先頭」へ寄せる。backcast は逆順に詰める
// （配列先頭ほど今日寄り＝最早）ので、slice=true を先頭グループへ安定ソートすると骨格が今日寄りに配置される。
//   表示順は変えず「配置順」だけを変えるため、元 index へ戻すマップを返す。
//   返り値: { ordered: [...slice先頭に並べ替えた手順], origByOrdered: [orderedの各位置→元steps index] }。
//   slice が無ければ恒等（順序不変）＝後方互換。
export function orderStepsForBackcast(steps) {
  const list = steps || [];
  const sliceIdx = [], restIdx = [];
  list.forEach((s, i) => { (s && s.slice ? sliceIdx : restIdx).push(i); });
  const origByOrdered = [...sliceIdx, ...restIdx];
  return { ordered: origByOrdered.map((i) => list[i]), origByOrdered };
}

// fever（バッファ消費率）: 残作業を1日容量で割った投影終了日が、前倒し締切(personalDue)を
// どれだけ超過するか＝プロジェクトバッファを何日消費したか。bufferDays に対する割合で緑/黄/赤。
//   これは plan-vs-actual の厳密なバーンダウンではなく「今のペースで前倒し締切に間に合うか」の前向き推定（ヒューリスティック）。
//   入力: remainingWorkH(未完了手順の圧縮後est合計), dailyCapH(=capH×(1-bufferPct/100) 等の1日実空き),
//        todayIso, personalDueIso, bufferDays, holidaysSet, unavailRanges, alertGreen/alertRed(閾値%)。
//   返り値: { consumedDays, consumedPct, tier:"green"|"yellow"|"red", projectedFinishIso }。
export function feverStatus({
  remainingWorkH, dailyCapH = 8, todayIso = localTodayIso(), personalDueIso = "",
  bufferDays = 0, holidaysSet = null, unavailRanges = [], alertGreen = 50, alertRed = 75,
  overcommitted = false, squeezed = false,
} = {}) {
  // 配置結果との整合: 入り切らない(overcommitted)なら無条件で赤、バッファ確保不可(squeezed)なら最低でも黄。
  //   ＝「赤い過剰コミット警告の真上で fever が緑」のような嘘をつかせない。
  const adjust = (res) => {
    if (overcommitted) { res.tier = "red"; if (res.consumedPct < 100) res.consumedPct = 100; }
    else if (squeezed && res.tier === "green") { res.tier = "yellow"; }
    return res;
  };
  const wopts = { holidaysSet, unavailRanges };
  const remH = Math.max(0, Number(remainingWorkH) || 0);
  if (remH <= 1e-9) return adjust({ consumedDays: 0, consumedPct: 0, tier: "green", projectedFinishIso: todayIso });
  const cap = dailyCapH > 0 ? dailyCapH : 8;
  const workDaysNeeded = Math.ceil(remH / cap);
  const projectedFinishIso = nthWorkDayFrom(todayIso, workDaysNeeded, wopts);
  let consumedDays = 0;
  if (personalDueIso && projectedFinishIso > personalDueIso) {
    consumedDays = countWorkDaysInclusive(shiftISO(personalDueIso, 1), projectedFinishIso, wopts);
  }
  const consumedPct = bufferDays > 0
    ? Math.round((consumedDays / bufferDays) * 100)
    : (consumedDays > 0 ? 100 : 0);
  const tier = consumedPct > alertRed ? "red" : (consumedPct > alertGreen ? "yellow" : "green");
  return adjust({ consumedDays, consumedPct, tier, projectedFinishIso });
}
