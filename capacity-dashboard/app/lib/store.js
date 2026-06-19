// セッション中のデータキャッシュ（タスク/ワークスペース/メンバー/定期/祝日/休暇）
// ※UI呼称=ワークスペース。API/データモデル上のエンティティは Vikunja の project（project_id 等の識別子はそのまま）。
import * as vik from "./api.js";
import { dateOnly } from "./capacity.js";
import { getSettings } from "./exec.js";
import { HABIT_WS } from "./habits.js";

// チーム設定（実行サービスが落ちていても既定値で動く）
const SETTINGS_DEFAULT = { capH: 8, calStart: 8, calEnd: 20, excludedWs: [] };

// タスク雛形を保存する専用ワークスペース名（taskform のテンプレート機能が使用）
export const TEMPLATE_WS = "テンプレート";

// 新規タスクの既定投入先WS名（UIからは排除・project_id は裏で保持）。taskform/quickadd/kanban で共有。
export const INBOX_WS = "インボックス";
// インボックスWS取得（無ければ作成）。**プロミスをメモ化**して、未作成時に複数経路から
// 同時に呼ばれても createProject が二重に走らない（=「インボックス」WSの重複作成を防ぐ）。
let _inboxPromise = null;
export function ensureInbox() {
  if (_inboxPromise) return _inboxPromise;
  _inboxPromise = (async () => {
    const { projects } = await load();
    const found = (projects || []).find((p) => p.title === INBOX_WS);
    if (found) return found;
    const created = await vik.createProject(INBOX_WS);
    invalidate();
    return created;
  })();
  _inboxPromise.catch(() => { _inboxPromise = null; }); // 失敗時は次回再試行できるようクリア
  return _inboxPromise;
}

// AI 担当アカウント（副担当として選択可）。人間のキャパ計算・メンバー列からは除外する。
// 実行系: taskstation-fable systemd タイマーが fable 担当タスクを巡回し Claude Code(MAXプラン) で提案コメント。
export const AI_USERNAMES = new Set(["fable"]);
export const isAiUser = (u) => !!u && AI_USERNAMES.has(u.username);

let cache = null;

// 同時実行数を制限しながら map する（N+1 取得のバースト緩和）。結果は入力と同じ順序の配列で返す
// ＝ Promise.all を置き換えても戻り値の形・順序・値は不変。失敗ハンドリングは各 fn 内（.catch）に委ねる。
async function mapLimit(items, limit, fn) {
  const arr = items || [];
  const out = new Array(arr.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, arr.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

let _loadInflight = null; // 飛行中の load() を合流させ、invalidate直後の並行呼び出しで N+1 取得が多重実行されるのを防ぐ
export async function load(force = false) {
  if (cache && !force) return cache;
  if (_loadInflight) return _loadInflight;          // 既に取得中なら同じ結果を共有（重複fetchを合流）
  _loadInflight = _loadImpl();
  try { return await _loadInflight; } finally { _loadInflight = null; }
}
async function _loadImpl() {
  const [tasksAll, projectsRaw, recurrences, holidays, unavailability, me, settingsRaw, labels] = await Promise.all([
    vik.getTasks(), vik.getProjects(),
    vik.getRecurrences().catch(() => []),
    vik.getHolidays().catch(() => []),
    vik.getUnavailability().catch(() => []),
    vik.whoami().catch(() => null),
    getSettings().catch(() => null),
    vik.getLabels().catch(() => []), // 分類（ラベル）の選択肢用
  ]);
  // Vikunja の仮想プロジェクト（お気に入り=-1 等の負ID）は実WSではないので除外
  // （projectusers が無く 404 になる・WS一覧に幻の「お気に入り」が出るのを防ぐ）
  const projects = (projectsRaw || []).filter((p) => (p.id || 0) > 0);
  const st = (settingsRaw && settingsRaw.settings) || {};
  const settings = {
    capH: st.cap_hours || SETTINGS_DEFAULT.capH,
    calStart: st.cal_start ?? SETTINGS_DEFAULT.calStart,
    calEnd: st.cal_end ?? SETTINGS_DEFAULT.calEnd,
    excludedWs: st.excluded_project_ids || [],
    sortPresets: st.sort_presets || [], // 一覧の共有ソートプリセット（グローバル）
    menuVisibility: st.menu_visibility || {}, // {"<userId>": ["hiddenRouteKey",...]} 各人の非表示メニュー（管理者設定）
    canEdit: !!(settingsRaw && settingsRaw.can_edit),
  };
  // テンプレートWS（雛形置き場）＋習慣WS（習慣トラッカー）＋設定で除外されたWSは通常タスクから分離
  // — 負荷・空き・一覧に混ぜない
  const templateProject = (projects || []).find((p) => p.title === TEMPLATE_WS) || null;
  const habitProject = (projects || []).find((p) => p.title === HABIT_WS) || null;
  const excluded = new Set(settings.excludedWs);
  if (templateProject) excluded.add(templateProject.id);
  if (habitProject) excluded.add(habitProject.id);
  const tasks = (tasksAll || []).filter((t) => !excluded.has(t.project_id));
  const templates = templateProject ? (tasksAll || []).filter((t) => t.project_id === templateProject.id) : [];
  const habitTasks = habitProject ? (tasksAll || []).filter((t) => t.project_id === habitProject.id && !t.done) : [];
  // ID→ユーザー名の名簿（全ワークスペースの projectusers ∪）。assignees に出ない人の名前解決用（P2 #5）。
  const dir = new Map();
  // 同時実行数を 8 に制限（実WSのみ・project_id は既に一意なので重複 fetch は無い）。
  const dirLists = await mapLimit(
    projects || [], 8,
    (p) => vik.getProjectMembers(p.id).catch(() => [])
  );
  for (const list of dirLists) for (const u of list || []) {
    if (!dir.has(u.id)) dir.set(u.id, { id: u.id, username: u.username, name: u.name || u.username });
  }
  // メンバー = タスク assignees ∪ 定期 assignee_ids ∪ 休暇対象者（仕事/予定/休みを持つ人）。
  // AI 担当（fable）は人間のキャパに混ぜない＝members から除外し aiMembers として別出し。
  const mmap = new Map();
  for (const t of tasks || []) for (const a of t.assignees || []) {
    if (!isAiUser(a) && !mmap.has(a.id)) mmap.set(a.id, { id: a.id, username: a.username, name: a.name || a.username });
  }
  const addId = (id) => {
    if (!id || mmap.has(id)) return;
    const u = dir.get(id);
    if (isAiUser(u)) return;
    mmap.set(id, u || { id, username: `user${id}`, name: `user${id}` });
  };
  for (const r of recurrences || []) for (const id of r.assignee_ids || []) addId(id);
  for (const u of unavailability || []) addId(u.user_id);
  const aiMembers = [...dir.values()].filter(isAiUser);

  // 祝日 Set / 休暇 Map（capacityOn 用）
  const holidaysSet = new Set((holidays || []).map((h) => dateOnly(h.date)));
  const holidaysByDate = new Map((holidays || []).map((h) => [dateOnly(h.date), h.name])); // 日付→祝日名（ピッカー表示用）
  const unavailabilityByMember = new Map();
  for (const u of unavailability || []) {
    const arr = unavailabilityByMember.get(u.user_id) || [];
    arr.push({ start: dateOnly(u.start_date), end: dateOnly(u.end_date) });
    unavailabilityByMember.set(u.user_id, arr);
  }

  // 日別予定(plans)を持つタスクだけ N+1 で取得し plansByTask に集約（#4 単一真実の負荷源）。
  const plannedTasks = (tasks || []).filter((t) => (t.time_planned || 0) > 0);
  // 同時実行数を 8 に制限（task.id は一意＝重複 fetch は無い／現状踏襲で time_planned>0 のみ）。
  const planPairs = await mapLimit(
    plannedTasks, 8,
    (t) => vik.getPlans(t.id).then((p) => [t.id, p || []]).catch(() => [t.id, []])
  );
  cache = {
    tasks: tasks || [], projects: projects || [], members: [...mmap.values()], aiMembers, me, settings,
    labels: labels || [],
    templates, templateProject,
    habitTasks, habitProject,
    plansByTask: new Map(planPairs),
    recurrences: recurrences || [], holidaysSet, holidaysByDate, unavailabilityByMember,
  };
  return cache;
}
export function invalidate() { cache = null; }
export function projectName(projects, id) {
  const p = (projects || []).find((p) => p.id === id);
  return p ? p.title : "—";
}
