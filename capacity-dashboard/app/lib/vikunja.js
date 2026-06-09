// Vikunja API クライアント（フォーク版: time_estimate / time_spent / /tasks/:task/times 対応）
// JWT は Authorization ヘッダ。CORS は Vikunja 側で有効化済み。
export const API = "http://leo:7005/api/v1";
const TKEY = "vikunja_token";

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
export async function setEstimate(taskId, title, seconds) {
  return req(`/tasks/${taskId}`, { method: "POST", body: { title, time_estimate: seconds } });
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
