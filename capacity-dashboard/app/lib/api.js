// TaskStation API クライアント（フォーク版: time_estimate / time_spent / /tasks/:task/times 対応）
// JWT は Authorization ヘッダ。
// オリジン適応: HTTPS（PWA・tailscale serve で /api を同一オリジンに同居）では相対 /api/v1 を使い、
// mixed content と CORS を回避。平文 HTTP（http://leo:7010）では従来どおり 7005 を直叩き。
import { REVIEW_LABEL, WAITING_LABEL } from "./kinds.js"; // 予約ラベルの SSoT は kinds.js（旧 api.js 重複定義を解消・Q13）
export { REVIEW_LABEL, WAITING_LABEL }; // settings.js が api.js 経由で取得するため re-export（後方互換）

export const API = location.protocol === "https:" ? location.origin + "/api/v1" : "http://leo:7005/api/v1";
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
  if (!r.ok) { const err = new Error((data && data.message) || `HTTP ${r.status}`); err.status = r.status; throw err; }
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
// 投入先WS内の全タスクを done 込みで全ページ取得する（サーバの per_page 既定は 50 で頭打ちのためページ送り）。
// keikaku 冪等投入の既存検出に使う。/tasks/all は全WS横断＋50件窓で取りこぼすため WS スコープのこちらを使う。
export async function getProjectTasksAll(projectId, perPage = 50) {
  const out = [];
  for (let page = 1; page <= 200; page++) { // 200ページ=最大1万件のフェイルセーフ
    const batch = await req(`/projects/${projectId}/tasks?per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < perPage) break; // 最終ページ（満杯でない）
  }
  return out;
}
export async function getProjects() { return req("/projects"); }
export async function createProject(title) { return req("/projects", { method: "PUT", body: { title } }); }
export async function getProjectMembers(projectId) { return req(`/projects/${projectId}/projectusers`); }
// ユーザー名（username）検索。s が空だと API は null を返すので呼び出し側で空ガードする。keikaku の担当名→user_id 解決に使う。
export async function searchUsers(query) { return req(`/users?s=${encodeURIComponent(query)}`); }
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
  "priority", "percent_done", "repeat_after", "repeat_mode", "hex_color", "time_estimate", "is_favorite", "started_at"];

// 現タスクを読み、全スカラを保ったまま patch を上書きして POST（非破壊な部分更新）。
// 関連(assignees/reminders/labels)は payload に載せない＝#1(ADR-008)のガードで維持される。
export async function updateTask(taskId, patch) {
  const cur = await getTask(taskId);
  const body = {};
  for (const k of TASK_SCALARS) if (k in cur) body[k] = cur[k];
  Object.assign(body, patch);
  const res = await req(`/tasks/${taskId}`, { method: "POST", body });
  logProgressChange(taskId, cur, patch); // 進捗/完了の活動ログ（ベストエフォート・非ブロッキング）
  return res;
}
// updateTask は SPA のスカラ更新の単一の関所（#9）。ここで percent_done/done の変化だけを活動ログ(exec /activity)へ
// 追記＝全編集経路（taskform/一覧グリッド/スマートリスト/かんばん 等）を個別フックせず網羅。fire-and-forget で
// updateTask の戻り/挙動を一切妨げない（exec 未接続でも黙ってスキップ）。
function logProgressChange(taskId, cur, patch) {
  try {
    const oldPct = cur.percent_done || 0;
    const newPct = ("percent_done" in patch) ? (patch.percent_done || 0) : oldPct;
    const doneNow = ("done" in patch) && !!patch.done && !cur.done; // 未完了→完了
    const pctChanged = ("percent_done" in patch) && newPct !== oldPct;
    if (!doneNow && !pctChanged) return;
    import("./exec.js").then((ex) => {
      ex.logActivity({
        task_id: taskId, title: cur.title || "",
        type: doneNow ? "done" : "progress",
        from: oldPct, to: doneNow ? 100 : newPct,
      }).catch(() => {});
    }).catch(() => {});
  } catch { /* noop */ }
}
export async function setEstimate(taskId, seconds) {
  return updateTask(taskId, { time_estimate: seconds });
}
// タスクを「進行中」に（着手）。started_at に現在時刻をセット＝statusOf が doing 判定（capacity.js hasStarted）。
// task がオブジェクトで既に着手済み（started_at あり）なら何もしない＝着手時刻を上書きしない（冪等）。
// 戻り値: 着手をセットしたら true / 既に着手済みで何もしなければ false。
export async function setTaskStarted(task) {
  const id = (task && typeof task === "object") ? task.id : task;
  const cur = (task && typeof task === "object") ? task.started_at : null;
  if (cur && !String(cur).startsWith("0001")) return false; // 既に着手済み（上書きしない）
  await updateTask(id, { started_at: new Date().toISOString() });
  return true;
}
export async function logTime(taskId, seconds, note = "", loggedOn = null) {
  const body = { seconds, note };
  if (loggedOn) body.logged_on = loggedOn;
  return req(`/tasks/${taskId}/times`, { method: "PUT", body });
}
export async function getTimes(taskId) { return req(`/tasks/${taskId}/times`); }
export async function deleteTime(taskId, entryId) { return req(`/tasks/${taskId}/times/${entryId}`, { method: "DELETE" }); }
export async function deleteTask(taskId) { return req(`/tasks/${taskId}`, { method: "DELETE" }); } // soft delete（フォークは deleted_at）

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

// 添付ファイル（ネイティブ機能）。アップロードは multipart のため req() を使わず専用 fetch。
// ダウンロードも Authorization ヘッダが要る（<a href> 直リンク不可）→ blob を返し呼び出し側で保存。
export async function getAttachments(taskId) { return req(`/tasks/${taskId}/attachments`); }
export async function deleteAttachment(taskId, attId) { return req(`/tasks/${taskId}/attachments/${attId}`, { method: "DELETE" }); }
export async function uploadAttachments(taskId, files) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const r = await fetch(`${API}/tasks/${taskId}/attachments`, {
    method: "PUT", headers: { Authorization: "Bearer " + token() }, body: fd,
  });
  if (!r.ok) throw new Error(`アップロード失敗 (HTTP ${r.status})`);
  return r.json();
}
export async function fetchAttachmentBlob(taskId, attId) {
  const r = await fetch(`${API}/tasks/${taskId}/attachments/${attId}`, {
    headers: { Authorization: "Bearer " + token() },
  });
  if (!r.ok) throw new Error(`ダウンロード失敗 (HTTP ${r.status})`);
  return r.blob();
}

// レビュー依頼（ネイティブ機能のみ・スキーマ変更なし）: タスク作成＋ラベル＋担当＋関連リンク。
export async function createTaskInProject(projectId, body) { return req(`/projects/${projectId}/tasks`, { method: "PUT", body }); }
export async function getLabels() { return req("/labels"); }
// 作成: hexColor は任意（#付き/無しどちらでも Vikunja 側で受ける）。互換のため第2引数は省略可。
export async function createLabel(title, hexColor) {
  const body = { title };
  if (hexColor) body.hex_color = hexColor;
  return req("/labels", { method: "PUT", body });
}
// 更新: 改名（{title}）／色変更（{hex_color}）。部分更新（patch のキーのみ送る）。
export async function updateLabel(id, patch) { return req(`/labels/${id}`, { method: "POST", body: patch }); }
// 削除: 使用中タスクからは自動で外れる（Vikunja 標準挙動）。
export async function deleteLabel(id) { return req(`/labels/${id}`, { method: "DELETE" }); }
export async function addTaskLabel(taskId, labelId) { return req(`/tasks/${taskId}/labels`, { method: "PUT", body: { label_id: labelId } }); }
export async function removeTaskLabel(taskId, labelId) { return req(`/tasks/${taskId}/labels/${labelId}`, { method: "DELETE" }); }
export async function addAssignee(taskId, userId) { return req(`/tasks/${taskId}/assignees`, { method: "PUT", body: { user_id: userId } }); }
export async function removeAssignee(taskId, userId) { return req(`/tasks/${taskId}/assignees/${userId}`, { method: "DELETE" }); }
export async function addRelation(taskId, otherTaskId, kind = "related") { return req(`/tasks/${taskId}/relations`, { method: "PUT", body: { other_task_id: otherTaskId, relation_kind: kind } }); }
export async function removeRelation(taskId, kind, otherTaskId) { return req(`/tasks/${taskId}/relations/${kind}/${otherTaskId}`, { method: "DELETE" }); }

// タスクコメント（ネイティブ機能）。一覧は配列（comment/author/created 等）、作成は PUT body {comment}。
export async function getComments(taskId) { return req(`/tasks/${taskId}/comments`); }
export async function createComment(taskId, comment) { return req(`/tasks/${taskId}/comments`, { method: "PUT", body: { comment } }); }

// 連絡待ち（GTD Waiting For）= 予約ラベル。付け外しでステータスを切り替える。WAITING_LABEL の SSoT は kinds.js。
let _waitingLabelId = null;
export async function ensureWaitingLabel() {
  if (_waitingLabelId) return _waitingLabelId;
  const labels = await getLabels();
  const found = (labels || []).find((l) => l.title === WAITING_LABEL);
  _waitingLabelId = found ? found.id : (await createLabel(WAITING_LABEL)).id;
  return _waitingLabelId;
}
// task の「連絡待ち」ラベルを on/off（現在の付与状況は task.labels から判定）。
export async function setTaskWaiting(task, on) {
  const cur = (task.labels || []).find((l) => (l.title || "") === WAITING_LABEL);
  if (on && !cur) { await addTaskLabel(task.id, await ensureWaitingLabel()); }
  else if (!on && cur) { await removeTaskLabel(task.id, cur.id); }
}

// REVIEW_LABEL の SSoT は kinds.js（上で import + re-export 済み）。
let _reviewLabelId = null;
export async function ensureReviewLabel() {
  if (_reviewLabelId) return _reviewLabelId;
  const labels = await getLabels();
  const found = (labels || []).find((l) => l.title === REVIEW_LABEL);
  _reviewLabelId = found ? found.id : (await createLabel(REVIEW_LABEL)).id;
  return _reviewLabelId;
}
// 元タスクのレビュータスクを生成（レビュアー割当・レビューラベル・関連・期限）。生成した新タスクを返す。
export async function requestReview(srcTask, reviewerId, dueISO, estimateSeconds = 1800) {
  const labelId = await ensureReviewLabel();
  const task = await createTaskInProject(srcTask.project_id, { title: `${srcTask.title} のレビュー`, due_date: dueISO + "T00:00:00Z", time_estimate: estimateSeconds });
  await addAssignee(task.id, reviewerId);
  await addTaskLabel(task.id, labelId);
  await addRelation(task.id, srcTask.id, "related");
  return task;
}
