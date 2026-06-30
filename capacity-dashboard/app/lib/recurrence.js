// 定期タスク/会議(RRULE) の展開＋可用性（祝日/休暇/週末）→ 空き計算（#4 多源マージ）。
// 展開は rrule.js（自前計算しない）。occurrence は仮想（実タスク非生成）。日付は "YYYY-MM-DD" UTC統一。
import { rrulestr } from "../vendor/rrule.mjs";
import { toH, round1, dowOf } from "./capacity.js"; // 自前の重複定義を解消し SSoT を再利用（Q30）

// API の dtstart(ISO) → RRULE の DTSTART 形式 "YYYYMMDDTHHMMSSZ"
function dtstartLine(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// recurrences をウィンドウ [fromISO, toISO]（両端 inclusive）に展開。
// 返り値: [{ recurrence, dateISO, origISO, assignees, override }]
//   assignees = その occurrence の対象者。通常は assignee_ids 全員、
//   持ち回り(rotation)は dtstart からの通し番号で assignee_ids を巡回した1名（順序=配列順）。
//   override = recurrences.overrides[origISO]（この回だけの例外: skip/date/start_minute/duration_seconds）。
//     skip=休止（出力しない）/ date=別日へ移動（dateISO が変わる・origISO は元の日のまま）。
//     移動が窓をまたぐケースを拾うため、展開は±31日広げて最終的な dateISO でフィルタする。
//     持ち回りの巡回番号は「元の日」基準＝1回ずらしても順番は崩れない。
export function expandRecurrences(recurrences, fromISO, toISO) {
  const PAD_MS = 31 * 86400000; // 例外の移動は最大±31日想定
  const after = new Date(new Date(fromISO + "T00:00:00Z").getTime() - PAD_MS);
  // 日単位 inclusive: dtstart が時刻を持つ occurrence（例 11:00）も toISO 当日分まで含める
  const before = new Date(new Date(toISO + "T23:59:59Z").getTime() + PAD_MS);
  const out = [];
  for (const rec of recurrences || []) {
    if (!rec.rrule || !rec.dtstart) continue;
    let rule;
    try {
      rule = rrulestr(`DTSTART:${dtstartLine(rec.dtstart)}\nRRULE:${rec.rrule}`);
    } catch {
      continue; // 不正RRULEはスキップ（落とさない）
    }
    const occs = rule.between(after, before, true);
    if (!occs.length) continue;
    const ids = rec.assignee_ids || [];
    const rotating = !!rec.rotation && ids.length > 0;
    // 持ち回りの通し番号: ウィンドウ内の最初の occurrence が dtstart から数えて何番目か
    let base = 0;
    if (rotating) {
      const start = new Date(rec.dtstart);
      if (start.getTime() < after.getTime()) {
        base = rule.between(start, after, true).filter((d) => d.getTime() < after.getTime()).length;
      }
    }
    const overrides = rec.overrides || {};
    occs.forEach((d, i) => {
      const origISO = d.toISOString().slice(0, 10);
      const ov = overrides[origISO] || null;
      if (ov && ov.skip) return;
      const dateISO = (ov && ov.date) || origISO;
      if (dateISO < fromISO || dateISO > toISO) return; // 窓外（パディング分や窓外へ移動した回）
      const assignees = rotating ? [ids[(base + i) % ids.length]] : ids;
      out.push({ recurrence: rec, dateISO, origISO, assignees, override: ov });
    });
  }
  return out;
}

// occurrence → 負荷源 [{memberId, day, h}]。対象者全員にフル（ADR-010・按分しない）。
// 持ち回りは expandRecurrences が assignees を1名に解決済み。所要は例外(override)があればその値。
export function occurrenceLoadEntries(occurrences) {
  const out = [];
  for (const { recurrence, dateISO, assignees, override } of occurrences || []) {
    const h = toH((override && override.duration_seconds) || recurrence.duration_seconds);
    if (h <= 0) continue;
    for (const uid of assignees || recurrence.assignee_ids || []) out.push({ memberId: uid, day: dateISO, h });
  }
  return out;
}

// 祝日データの鮮度: 登録済み祝日の最終日が today+horizonDays に届いていなければ stale。
// 同期ジョブ（systemd taskstation-holiday-sync）が止まった検知用（ホームのアラートが表示）。
// 健全なら内閣府CSVは常に「来年末」まで供給する＝最終日は約10ヶ月以上先にあるため、90日で安全に検知できる。
export function holidayDataStatus(holidaysSet, todayISO, horizonDays = 90) {
  let latest = null;
  for (const d of holidaysSet || []) if (!latest || d > latest) latest = d;
  const h = new Date(todayISO + "T00:00:00Z");
  h.setUTCDate(h.getUTCDate() + horizonDays);
  const horizon = h.toISOString().slice(0, 10);
  return { latest, stale: !latest || latest < horizon };
}

// その日のメンバー容量。週末/祝日/休暇=0、それ以外=capH。
// holidays: Set<"YYYY-MM-DD">, unavailabilityByMember: Map<memberId, [{start,end}]>（end inclusive）
export function capacityOn(member, isoDay, { holidays, unavailabilityByMember, capH = 8 } = {}) {
  const dow = dowOf(isoDay);
  if (dow === 0 || dow === 6) return 0;
  if (holidays && holidays.has(isoDay)) return 0;
  const un = unavailabilityByMember && unavailabilityByMember.get(member.id);
  if (un) for (const r of un) if (r.start <= isoDay && isoDay <= r.end) return 0;
  return capH;
}

// 月次 空き = capacity − load（複数負荷源を合算）。
// loadSources: [{memberId,day,h}] の配列の配列（occurrence由来 ＋ 既存task由来をマージ）。
// 返り値: Map<memberId, Map<dayISO, {capH, loadH, freeH, status}>>
//   status: 'off'(容量0=週末/祝日/休暇) / 'over'(load>cap) / 'full'(空き≈0) / 'free'
export function freeByMemberDay(members, isoDays, loadSources, availability = {}) {
  const load = new Map(); // memberId -> day -> h
  for (const src of loadSources || []) {
    for (const e of src || []) {
      if (!load.has(e.memberId)) load.set(e.memberId, new Map());
      const dm = load.get(e.memberId);
      dm.set(e.day, (dm.get(e.day) || 0) + e.h);
    }
  }
  const res = new Map();
  for (const m of members || []) {
    const dm = new Map();
    for (const day of isoDays) {
      const capH = capacityOn(m, day, availability);
      const loadH = round1((load.get(m.id) && load.get(m.id).get(day)) || 0);
      const freeH = round1(capH - loadH);
      // capH=0(週末/祝日/休暇)に予定がある＝「非稼働日に予定」(offplan)。平日の過負荷('over')と区別する
      // （解決は再配分でなく稼働日へ移動）。
      const status = capH === 0
        ? (loadH > 1e-6 ? "offplan" : "off")
        : (loadH > capH + 1e-6 ? "over" : (freeH <= 1e-6 ? "full" : "free"));
      dm.set(day, { capH, loadH, freeH, status });
    }
    res.set(m.id, dm);
  }
  return res;
}
