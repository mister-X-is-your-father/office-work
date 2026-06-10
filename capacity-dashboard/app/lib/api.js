// TaskStation API クライアント（フォーク版: time_estimate / time_spent / /tasks/:task/times 対応）
// JWT は Authorization ヘッダ。CORS は TaskStation 側で有効化済み。
export const API = "http://leo:7005/api/v1";
const TKEY = "taskstation_token";

export function token() { return sessionStorage.getItem(TKEY) || ""; }
export function setToken(t) { sessionStorage.setItem(TKEY, t); }
export function clearToken() { sessionStorage.removeItem(TKEY); }
export function isAuthed() { return !!token(); }

async function req(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = "Bearer " + token();
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && auth) { clearToken(); throw new AuthError("セッション切れ"); }
  const txt = await r.text();
  const data = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error((data && data.message) || `HTTP ${r.status}`);
  return data;
}

export class AuthError extends Error {}

export async function login(username, password) {
  const d = await req("/login", { method: "POST", auth: false, body: { username, password } });
  if (!d || !d.token) throw new Error("ログイン失敗");
  setToken(d.token);
  return d.token;
}

// 全タスク（time_estimate / time_spent / assignees / 日付 / priority / done 等を含む）
export async function getTasks() { return req("/tasks/all?per_page=250"); }
export async function getTask(id) { return req(`/tasks/${id}`); }
export async function getProjects() { return req("/projects"); }
export async function getProjectMembers(projectId) { return req(`/projects/${projectId}/projectusers`); }
export async function whoami() { return req("/user"); }

// 書き込み（任意・P3寄り）
// ── #9 タスクのスカラ更新は必ず updateTask を経由する（生 POST 禁止）。
// TaskStation の POST /tasks/:id はスカラ全置換（payload に無い＝クリア）なので、
// 部分 POST すると start/end/due/priority 等が消える。full-send で非破壊にする。
const TASK_SCALARS = ["title", "description", "done", "due_date", "start_date", "end_date",
  "priority", "percent_done", "repeat_after", "repeat_mode", "hex_color", "time_estimate", "is_favorite"];

// 現タスクを読み、全スカラを保ったまま patch を上書きして POST（非破壊な部分更新）。
// 関連(assignees/reminders/labels)は payload に載せない＝#1(ADR-008)のガードで維持される。
export async function updateTask(taskId, patch) {
  const cur = await getTask(taskId);
  const body = {};
  for (const k of TASK_SCALARS) if (k in cur) body[k] = cur[k];
  Object.assign(body, patch);
  return req(`/tasks/${taskId}`, { method: "POST", body });
}
export async function setEstimate(taskId, seconds) {
  return updateTask(taskId, { time_estimate: seconds });
}
export async function logTime(taskId, seconds, note = "", loggedOn = null) {
  const body = { seconds, note };
  if (loggedOn) body.logged_on = loggedOn;
  return req(`/tasks/${taskId}/times`, { method: "PUT", body });
}
export async function getTimes(taskId) { return req(`/tasks/${taskId}/times`); }

// 日別の予定（フェーズ2: task_time_plans）
export async function getPlans(taskId) { return req(`/tasks/${taskId}/plans`); }
export async function logPlan(taskId, seconds, planDateISO, note = "") {
  return req(`/tasks/${taskId}/plans`, { method: "PUT", body: { seconds, plan_date: planDateISO + "T00:00:00Z", note } });
}

// 定期タスク/会議(RRULE)＋祝日＋個人休暇（フェーズ5・グローバルCRUD）
export async function getRecurrences() { return req("/recurrences"); }
export async function createRecurrence(body) { return req("/recurrences", { method: "PUT", body }); }
export async function updateRecurrence(id, body) { return req(`/recurrences/${id}`, { method: "POST", body }); }
export async function deleteRecurrence(id) { return req(`/recurrences/${id}`, { method: "DELETE" }); }

export async function getHolidays() { return req("/holidays"); }
export async function createHoliday(body) { return req("/holidays", { method: "PUT", body }); }
export async function deleteHoliday(id) { return req(`/holidays/${id}`, { method: "DELETE" }); }

export async function getUnavailability() { return req("/unavailability"); }
export async function createUnavailability(body) { return req("/unavailability", { method: "PUT", body }); }
export async function deleteUnavailability(id) { return req(`/unavailability/${id}`, { method: "DELETE" }); }
