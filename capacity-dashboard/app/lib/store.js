// セッション中のデータキャッシュ（タスク/プロジェクト/メンバー）
import * as vik from "./vikunja.js";

let cache = null;

export async function load(force = false) {
  if (cache && !force) return cache;
  const [tasks, projects] = await Promise.all([vik.getTasks(), vik.getProjects()]);
  // メンバー = 全タスクの assignees の和（仕事を持つ人）。重複排除。
  const mmap = new Map();
  for (const t of tasks || []) for (const a of t.assignees || []) {
    if (!mmap.has(a.id)) mmap.set(a.id, { id: a.id, username: a.username, name: a.name || a.username });
  }
  // 日別予定(plans)を持つタスクだけ N+1 で取得し plansByTask に集約（#4 単一真実の負荷源）。
  // today/home/week が共有してキャッシュ（重複取得を避ける）。
  const plannedTasks = (tasks || []).filter((t) => (t.time_planned || 0) > 0);
  const planPairs = await Promise.all(
    plannedTasks.map((t) => vik.getPlans(t.id).then((p) => [t.id, p || []]).catch(() => [t.id, []]))
  );
  cache = { tasks: tasks || [], projects: projects || [], members: [...mmap.values()], plansByTask: new Map(planPairs) };
  return cache;
}
export function invalidate() { cache = null; }
export function projectName(projects, id) {
  const p = (projects || []).find((p) => p.id === id);
  return p ? p.title : "—";
}
