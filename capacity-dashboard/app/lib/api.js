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
export async function register(username, email, password) {
  return req("/register", { method: "POST", auth: false, body: { username, email, password } });
}

// 全タスク（time_estimate / time_spent / assignees / 日付 / priority / done 等を含む）
export async function getTasks() { return req("/tasks/all?per_page=250"); }
export async function getTask(id) { return req(`/tasks/${id}`); }
export async function getProjects() { return req("/projects"); }
export async function createProject(title) { return req("/projects", { method: "PUT", body: { title } }); }
export async function getProjectMembers(projectId) { return req(`/projects/${projectId}/projectusers`); }
// かんばん（0.24 のプロジェクトビュー＋バケット構造）
export async function getProjectDetail(id) { return req(`/projects/${id}`); }                       // views[] を含む
export async function getViewTasks(pid, vid) { return req(`/projects/${pid}/views/${vid}/tasks`); } // kanban=バケット配列(tasks入り)
export async function createBucket(pid, vid, title) { return req(`/projects/${pid}/views/${vid}/buckets`, { method: "PUT", body: { title } }); }
export async function renameBucket(pid, vid, bid, title) { return req(`/projects/${pid}/views/${vid}/buckets/${bid}`, { method: "POST", body: { title } }); }
export async function deleteBucket(pid, vid, bid) { return req(`/projects/${pid}/views/${vid}/buckets/${bid}`, { method: "DELETE" }); }
export async function moveTaskToBucket(pid, vid, bid, taskId) { return req(`/projects/${pid}/views/${vid}/buckets/${bid}/tasks`, { method: "POST", body: { task_id: taskId } }); }
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
export async function logPlan(taskId, seconds, planDateISO, note = "", userId = null, startMinute = null) {
  const body = { seconds, plan_date: planDateISO + "T00:00:00Z", note };
  if (userId) body.user_id = userId;
  if (startMinute != null) body.start_minute = startMinute;
  return req(`/tasks/${taskId}/plans`, { method: "PUT", body });
}
export async function deletePlan(taskId, planId) {
  return req(`/tasks/${taskId}/plans/${planId}`, { method: "DELETE" });
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

// レビュー依頼（ネイティブ機能のみ・スキーマ変更なし）: タスク作成＋ラベル＋担当＋関連リンク。
export async function createTaskInProject(projectId, body) { return req(`/projects/${projectId}/tasks`, { method: "PUT", body }); }
export async function getLabels() { return req("/labels"); }
export async function createLabel(title) { return req("/labels", { method: "PUT", body: { title } }); }
export async function addTaskLabel(taskId, labelId) { return req(`/tasks/${taskId}/labels`, { method: "PUT", body: { label_id: labelId } }); }
export async function removeTaskLabel(taskId, labelId) { return req(`/tasks/${taskId}/labels/${labelId}`, { method: "DELETE" }); }
export async function addAssignee(taskId, userId) { return req(`/tasks/${taskId}/assignees`, { method: "PUT", body: { user_id: userId } }); }
export async function removeAssignee(taskId, userId) { return req(`/tasks/${taskId}/assignees/${userId}`, { method: "DELETE" }); }
export async function addRelation(taskId, otherTaskId, kind = "related") { return req(`/tasks/${taskId}/relations`, { method: "PUT", body: { other_task_id: otherTaskId, relation_kind: kind } }); }
export async function removeRelation(taskId, kind, otherTaskId) { return req(`/tasks/${taskId}/relations/${kind}/${otherTaskId}`, { method: "DELETE" }); }

export const REVIEW_LABEL = "レビュー";
let _reviewLabelId = null;
export async function ensureReviewLabel() {
  if (_reviewLabelId) return _reviewLabelId;
  const labels = await getLabels();
  const found = (labels || []).find((l) => l.title === REVIEW_LABEL);
  _reviewLabelId = found ? found.id : (await createLabel(REVIEW_LABEL)).id;
  return _reviewLabelId;
}
// 元タスクのレビュータスクを生成（レビュアー割当・レビューラベル・関連・期日）。生成した新タスクを返す。
export async function requestReview(srcTask, reviewerId, dueISO, estimateSeconds = 1800) {
  const labelId = await ensureReviewLabel();
  const task = await createTaskInProject(srcTask.project_id, { title: `${srcTask.title} のレビュー`, due_date: dueISO + "T00:00:00Z", time_estimate: estimateSeconds });
  await addAssignee(task.id, reviewerId);
  await addTaskLabel(task.id, labelId);
  await addRelation(task.id, srcTask.id, "related");
  return task;
}
