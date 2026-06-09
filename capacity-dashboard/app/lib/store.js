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
  cache = { tasks: tasks || [], projects: projects || [], members: [...mmap.values()] };
  return cache;
}
export function invalidate() { cache = null; }
export function projectName(projects, id) {
  const p = (projects || []).find((p) => p.id === id);
  return p ? p.title : "—";
}
