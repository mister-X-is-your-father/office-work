// 定期タスク/会議(RRULE) の展開＋可用性（祝日/休暇/週末）→ 空き計算（#4 多源マージ）。
// 展開は rrule.js（自前計算しない）。occurrence は仮想（実タスク非生成）。日付は "YYYY-MM-DD" UTC統一。
import { rrulestr } from "./vendor/rrule.mjs";

const toH = (s) => (s || 0) / 3600;
const round1 = (x) => Math.round(x * 10) / 10;
const dowOf = (isoDay) => new Date(isoDay + "T00:00:00Z").getUTCDay(); // 0=日,6=土

// API の dtstart(ISO) → RRULE の DTSTART 形式 "YYYYMMDDTHHMMSSZ"
function dtstartLine(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// recurrences をウィンドウ [fromISO, toISO]（両端 inclusive）に展開。
// 返り値: [{ recurrence, dateISO }]
export function expandRecurrences(recurrences, fromISO, toISO) {
  const after = new Date(fromISO + "T00:00:00Z");
  const before = new Date(toISO + "T00:00:00Z");
  const out = [];
  for (const rec of recurrences || []) {
    if (!rec.rrule || !rec.dtstart) continue;
    let rule;
    try {
      rule = rrulestr(`DTSTART:${dtstartLine(rec.dtstart)}\nRRULE:${rec.rrule}`);
    } catch {
      continue; // 不正RRULEはスキップ（落とさない）
    }
    for (const d of rule.between(after, before, true)) {
      out.push({ recurrence: rec, dateISO: d.toISOString().slice(0, 10) });
    }
  }
  return out;
}

// occurrence → 負荷源 [{memberId, day, h}]。assignee 全員にフル（ADR-010・按分しない）。
export function occurrenceLoadEntries(occurrences) {
  const out = [];
  for (const { recurrence, dateISO } of occurrences || []) {
    const h = toH(recurrence.duration_seconds);
    if (h <= 0) continue;
    for (const uid of recurrence.assignee_ids || []) out.push({ memberId: uid, day: dateISO, h });
  }
  return out;
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
      // capH=0(週末/祝日/休暇): 予定が重なれば衝突='over'、無ければ'off'。
      const status = capH === 0
        ? (loadH > 1e-6 ? "over" : "off")
        : (loadH > capH + 1e-6 ? "over" : (freeH <= 1e-6 ? "full" : "free"));
      dm.set(day, { capH, loadH, freeH, status });
    }
    res.set(m.id, dm);
  }
  return res;
}
