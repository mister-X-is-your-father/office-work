// セッション中のデータキャッシュ（タスク/ワークスペース/メンバー/定期/祝日/休暇）
// ※UI呼称=ワークスペース。API/データモデル上のエンティティは Vikunja の project（project_id 等の識別子はそのまま）。
import * as vik from "./api.js";
import { dateOnly } from "./capacity.js";

// タスク雛形を保存する専用ワークスペース名（taskform のテンプレート機能が使用）
export const TEMPLATE_WS = "テンプレート";

// AI 担当アカウント（副担当として選択可）。人間のキャパ計算・メンバー列からは除外する。
// 実行系: taskstation-fable systemd タイマーが fable 担当タスクを巡回し Claude Code(MAXプラン) で提案コメント。
export const AI_USERNAMES = new Set(["fable"]);
export const isAiUser = (u) => !!u && AI_USERNAMES.has(u.username);

let cache = null;

export async function load(force = false) {
  if (cache && !force) return cache;
  const [tasksAll, projects, recurrences, holidays, unavailability, me] = await Promise.all([
    vik.getTasks(), vik.getProjects(),
    vik.getRecurrences().catch(() => []),
    vik.getHolidays().catch(() => []),
    vik.getUnavailability().catch(() => []),
    vik.whoami().catch(() => null),
  ]);
  // テンプレートWS（タスク雛形の置き場）は通常タスクから分離 — 負荷・空き・一覧に混ぜない
  const templateProject = (projects || []).find((p) => p.title === TEMPLATE_WS) || null;
  const tasks = templateProject ? (tasksAll || []).filter((t) => t.project_id !== templateProject.id) : (tasksAll || []);
  const templates = templateProject ? (tasksAll || []).filter((t) => t.project_id === templateProject.id) : [];
  // ID→ユーザー名の名簿（全ワークスペースの projectusers ∪）。assignees に出ない人の名前解決用（P2 #5）。
  const dir = new Map();
  const dirLists = await Promise.all(
    (projects || []).map((p) => vik.getProjectMembers(p.id).catch(() => []))
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
  const planPairs = await Promise.all(
    plannedTasks.map((t) => vik.getPlans(t.id).then((p) => [t.id, p || []]).catch(() => [t.id, []]))
  );
  cache = {
    tasks: tasks || [], projects: projects || [], members: [...mmap.values()], aiMembers, me,
    templates, templateProject,
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
