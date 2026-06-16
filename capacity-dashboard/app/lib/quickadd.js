// クイック追加の自然言語パーサ（純関数・DOM非依存）。
// 1行から 日付/時刻/分類/重要度/見積/担当/WS/URL を抽出し、残りをタイトルにする。
//   例: 「明日15時 MTG準備 #会議 !高 1h >チーム作業」
// 規則（予測可能性優先）:
// - 空白区切りのトークンが「パターンに完全一致」したときだけ消費する。
//   部分一致は消費しない（「15時の件」はタイトルのまま）。日本語の文中は壊さない。
// - 数字だけのトークン（612 等）は日付に解釈しない（メモ捕獲を誤爆させない）。
//   日付は明示形のみ: 今日/明日/明後日/N日後/X曜(日)/来週X曜/M\/D/M月D日。
// - URL と [タイトル](URL) は位置不問で抽出して links へ（説明の [資料] 行に格納する想定）。
// - AI担当(fable)の割当はここでは扱わない（taskform の隠しコマンド経由のみ＝仕様）。

const pad2 = (n) => String(n).padStart(2, "0");
const DOW = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6 };

// 全角→半角（数字・記号・空白）。日本語本文には影響しない範囲のみ。
function normalize(s) {
  return String(s || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[！＃＠＞：／．]/g, (c) => ({ "！": "!", "＃": "#", "＠": "@", "＞": ">", "：": ":", "／": "/", "．": "." }[c]))
    .replace(/　/g, " ");
}

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 曜日指定の解決。bare=直近のその曜日（今日を含む）/ 来週=翌週のその曜日。
function resolveWeekday(todayISO, target, nextWeek) {
  const dow = new Date(todayISO + "T00:00:00Z").getUTCDay();
  if (!nextWeek) return addDays(todayISO, (target - dow + 7) % 7);
  const toNextMonday = ((1 - dow + 7) % 7) || 7;
  return addDays(todayISO, toNextMonday + ((target - 1 + 7) % 7));
}

function mkDate(todayISO, mo, da) {
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const y = +todayISO.slice(0, 4);
  const iso = `${y}-${pad2(mo)}-${pad2(da)}`;
  return iso < todayISO ? `${y + 1}-${pad2(mo)}-${pad2(da)}` : iso; // 過去日は翌年に繰上げ
}

const DATE_WORDS = { "今日": 0, "明日": 1, "明後日": 2, "あさって": 2, "あした": 1 };
const PRIO_WORDS = { "MUST": 4, "must": 4, "最優先": 4, "最": 4, "高": 3, "中": 2, "低": 1 };

// "15時"/"15時半"/"15:30" → 分（0..1439）。不正は null。
function parseTime(h, mm, half) {
  const hh = +h;
  if (hh > 23) return null;
  const m = mm != null ? +mm : (half ? 30 : 0);
  if (m > 59) return null;
  return hh * 60 + m;
}

// 1トークンを分類して認識結果を返す。認識できなければ null（＝タイトル行き）。
// 戻り: { kind, apply(out) } — kind は date/time/estimate/priority/label/assignee/ws。
// apply は out（parse結果）へ副作用で書き込む純粋な反映関数。
function classifyToken(tok, today) {
  let m;
  if ((m = tok.match(/^>(.+)$/))) return { kind: "ws", apply: (o) => { o.ws = m[1]; } };
  if ((m = tok.match(/^#(.+)$/))) return { kind: "label", apply: (o) => { o.labels.push(m[1]); } };
  if ((m = tok.match(/^@(.+)$/))) return { kind: "assignee", apply: (o) => { o.assignee = m[1]; } };
  if ((m = tok.match(/^!(MUST|must|最優先|最|高|中|低)$/))) return { kind: "priority", apply: (o) => { o.priority = PRIO_WORDS[m[1]]; } };
  if ((m = tok.match(/^(\d+(?:\.\d+)?)(h|時間)(半)?$/))) {
    const h = +m[1] + (m[3] ? 0.5 : 0);
    if (h > 0 && h <= 24) return { kind: "estimate", apply: (o) => { o.estimateH = h; } };
  }
  if ((m = tok.match(/^(\d+)(m|分)$/)) && +m[1] > 0 && +m[1] < 600) {
    const h = +m[1] / 60;
    return { kind: "estimate", apply: (o) => { o.estimateH = h; } };
  }
  // 日付語（単独 or 時刻直結: 明日15時 / 明日15:30）
  if ((m = tok.match(/^(今日|明日|明後日|あさって|あした)(?:(\d{1,2})(?::(\d{2})|時(半)?))?$/))) {
    const t = m[2] != null ? parseTime(m[2], m[3], m[4]) : null;
    if (m[2] == null || t != null) {
      const iso = addDays(today, DATE_WORDS[m[1]]);
      return { kind: "date", apply: (o) => { o.dateISO = iso; if (t != null) o.startMinute = t; } };
    }
  }
  if ((m = tok.match(/^(\d+)日後$/))) { const iso = addDays(today, +m[1]); return { kind: "date", apply: (o) => { o.dateISO = iso; } }; }
  if ((m = tok.match(/^(来週)?([日月火水木金土])曜日?$/))) { const iso = resolveWeekday(today, DOW[m[2]], !!m[1]); return { kind: "date", apply: (o) => { o.dateISO = iso; } }; }
  if ((m = tok.match(/^(\d{1,2})\/(\d{1,2})$/)) || (m = tok.match(/^(\d{1,2})月(\d{1,2})日$/))) {
    const iso = mkDate(today, +m[1], +m[2]);
    if (iso) return { kind: "date", apply: (o) => { o.dateISO = iso; } };
  }
  if ((m = tok.match(/^(\d{1,2})(?::(\d{2})|時(半)?)$/))) {
    const t = parseTime(m[1], m[2], m[3]);
    if (t != null) return { kind: "time", apply: (o) => { o.startMinute = t; } };
  }
  return null;
}

// parse結果(out)から、トークン種別ごとの表示ラベルを作る（チップ用の素ラベル）。
function tokenLabel(kind, scratch) {
  switch (kind) {
    case "date": {
      let s = "";
      if (scratch.dateISO) {
        const mo = +scratch.dateISO.slice(5, 7), da = +scratch.dateISO.slice(8, 10);
        s = `${mo}/${da}`;
      }
      if (scratch.startMinute != null) s += (s ? " " : "") + `${Math.floor(scratch.startMinute / 60)}:${pad2(scratch.startMinute % 60)}`;
      return s;
    }
    case "time":
      return scratch.startMinute != null ? `${Math.floor(scratch.startMinute / 60)}:${pad2(scratch.startMinute % 60)}` : "";
    case "estimate":
      return scratch.estimateH ? (Number.isInteger(scratch.estimateH) ? `${scratch.estimateH}h` : `${scratch.estimateH}h`) : "";
    case "priority":
      return { 4: "MUST", 3: "高", 2: "中", 1: "低" }[scratch.priority] || "";
    case "label":
      return scratch.labels[scratch.labels.length - 1] || "";
    case "assignee":
      return scratch.assignee || "";
    case "ws":
      return scratch.ws || "";
    default:
      return "";
  }
}

// ignore: テキスト扱いにする生トークン文字列の Set（同一なら全出現を無視）。
// 戻り値に out.tokens（認識トークンのメタ列）を付与する以外、既存の戻り値・挙動は不変。
export function parseQuickAdd(raw, { today, ignore } = {}) {
  if (!today) today = new Date().toISOString().slice(0, 10);
  const ignoreSet = ignore instanceof Set ? ignore : new Set(ignore || []);
  let s = normalize(raw);
  const out = { title: "", dateISO: null, startMinute: null, priority: 0, estimateH: 0, labels: [], links: [], ws: null, assignee: null, tokens: [] };

  // 位置不問の抽出: [タイトル](URL) → タイトルを残して URL を links へ / 裸URLは丸ごと links へ
  s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => { out.links.push(u); return t; });
  s = s.replace(/https?:\/\/[^\s）)]+/g, (u) => { out.links.push(u); return " "; });

  const rest = [];
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    const c = classifyToken(tok, today);
    if (!c) { rest.push(tok); continue; }
    const applied = !ignoreSet.has(tok);
    if (applied) {
      // ラベル算出のため、反映後の差分を見るスクラッチに適用してから本体へ。
      c.apply(out);
      out.tokens.push({ kind: c.kind, raw: tok, label: tokenLabel(c.kind, out), applied: true });
    } else {
      // テキスト扱い: 解釈せずタイトルへ。ラベルは別スクラッチで算出（本体は汚さない）。
      const scratch = { dateISO: null, startMinute: null, priority: 0, estimateH: 0, labels: [], ws: null, assignee: null };
      c.apply(scratch);
      out.tokens.push({ kind: c.kind, raw: tok, label: tokenLabel(c.kind, scratch), applied: false });
      rest.push(tok);
    }
  }
  out.title = rest.join(" ").trim();
  // 時刻だけ指定（日付なし）→ 今日扱い
  if (out.startMinute != null && !out.dateISO) out.dateISO = today;
  return out;
}
