// リマインダー通知（TickTickのリマインダーのブラッシュアップ）。
// 通知源は3系統: ①時刻カレンダーの自分の予定(plan.start_minute) ②自分が出る会議/定例(dtstart時刻)
// ③今日が期限の自分のタスク（時刻なし→営業開始時刻にまとめて）。
// notifyEvents は純関数（テスト対象）。startNotifications がブラウザ側のスケジューラ。
// 設定は個人ごと localStorage（ts.notify.<uid>: {on, lead}）。発火済みは日付キーで永続し再通知しない。
import { expandRecurrences } from "./recurrence.js";
import { dateOnly } from "./capacity.js";

export const NOTIFY_DEFAULT = { on: false, lead: 5 };

export const notifyPrefs = (uid) => {
  try { return { ...NOTIFY_DEFAULT, ...JSON.parse(localStorage.getItem(`ts.notify.${uid}`) || "{}") }; }
  catch { return { ...NOTIFY_DEFAULT }; }
};
export const saveNotifyPrefs = (uid, prefs) => localStorage.setItem(`ts.notify.${uid}`, JSON.stringify(prefs));

const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

// 今日(dayISO)の通知イベント [{key, minute, title, body}]（分=0..1439・対象は meId 本人のみ）
export function notifyEvents({ tasks, plansByTask, recurrences, meId, calStart = 8 }, dayISO) {
  const out = [];
  if (!meId) return out;
  const plannedTaskIds = new Set(); // 時刻つきpredicate（期限通知の重複排除用）
  for (const t of tasks || []) {
    if (t.done) continue;
    for (const p of (plansByTask && plansByTask.get(t.id)) || []) {
      if (p.user_id !== meId || dateOnly(p.plan_date) !== dayISO || p.start_minute == null) continue;
      plannedTaskIds.add(t.id);
      out.push({ key: `plan:${p.id}`, minute: p.start_minute, title: t.title, body: `${hhmm(p.start_minute)} 開始の予定` });
    }
  }
  for (const { recurrence: rec, dateISO, origISO, assignees, override } of expandRecurrences(recurrences || [], dayISO, dayISO)) {
    if (dateISO !== dayISO) continue;
    const d = new Date(rec.dtstart);
    const baseMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    const minute = override && override.start_minute != null ? override.start_minute : baseMin;
    if (!minute) continue; // 00:00=時刻なし
    const ids = assignees || rec.assignee_ids || [];
    if (ids.length && !ids.includes(meId)) continue;
    out.push({ key: `rec:${rec.id}:${origISO}`, minute, title: rec.title || "会議", body: `${hhmm(minute)} 開始（${rec.kind === "meeting" ? "会議" : "定例"}）` });
  }
  // 期限=今日（時刻なし）→ 営業開始にまとめて。時刻つき予定を立て済みのタスクは除外。
  for (const t of tasks || []) {
    if (t.done || plannedTaskIds.has(t.id)) continue;
    if (!t.due_date || t.due_date.startsWith("0001") || dateOnly(t.due_date) !== dayISO) continue;
    if (!(t.assignees || []).some((a) => a.id === meId)) continue;
    out.push({ key: `due:${t.id}:${dayISO}`, minute: calStart * 60, title: t.title, body: "今日が期限" });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

// ── ブラウザ側スケジューラ ──────────────────────────────────────
const FIRED_PREFIX = "ts.notify.fired.";
function firedSet(dayISO) {
  // 古い日の発火記録を掃除
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(FIRED_PREFIX) && k !== FIRED_PREFIX + dayISO) localStorage.removeItem(k);
  }
  try { return new Set(JSON.parse(localStorage.getItem(FIRED_PREFIX + dayISO) || "[]")); } catch { return new Set(); }
}

function show(title, body) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification(title, { body, tag: title }); return; } catch { /* fallthrough */ }
  }
  toast(title, body); // 権限なし/失敗 → アプリ内トースト
}

function toast(title, body) {
  let box = document.getElementById("ts-toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "ts-toasts";
    box.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:60;display:flex;flex-direction:column;gap:8px";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.style.cssText = "background:#1d2430;color:#fff;border-radius:11px;padding:11px 15px;font-size:13px;box-shadow:0 10px 30px rgba(10,18,35,.35);max-width:320px";
  el.innerHTML = `<b style="display:block;font-size:13.5px">🔔 ${title.replace(/</g, "&lt;")}</b><span style="opacity:.85;font-size:12px">${body.replace(/</g, "&lt;")}</span>`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 12000);
}

// getData: () => Promise<store.load() 形> を渡す（キャッシュ済み前提・通知のために強制再取得はしない）
let _notifyTimer = null; // 二重起動防止: 既存タイマーがあれば張り替える（app.js の __tsNotify に加えた多層防御）
export function startNotifications(getData) {
  if (_notifyTimer) { clearInterval(_notifyTimer); _notifyTimer = null; }
  const tick = async () => {
    let data;
    try { data = await getData(); } catch { return; }
    const me = data.me;
    if (!me) return;
    const prefs = notifyPrefs(me.id);
    if (!prefs.on) return;
    const now = new Date();
    const dayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const fired = firedSet(dayISO);
    const events = notifyEvents({
      tasks: data.tasks, plansByTask: data.plansByTask, recurrences: data.recurrences,
      meId: me.id, calStart: (data.settings && data.settings.calStart) || 8,
    }, dayISO);
    let dirty = false;
    for (const ev of events) {
      if (fired.has(ev.key)) continue;
      if (nowMin < ev.minute - prefs.lead || nowMin > ev.minute) continue; // 窓: N分前〜開始時刻
      show(ev.title, ev.body);
      fired.add(ev.key);
      dirty = true;
    }
    if (dirty) localStorage.setItem(FIRED_PREFIX + dayISO, JSON.stringify([...fired]));
  };
  tick();
  _notifyTimer = setInterval(tick, 30000);
  return _notifyTimer;
}
