// taskstation-exec（leo:7020）クライアント。Fable ▶実行・直列キュー・スクリプト・SSEコンソール。
// 認証は TaskStation の JWT をそのまま送る（サービス側で許可ユーザーIDを検証＝隠し要素）。
import { token } from "./api.js";

export const EXEC_BASE = `http://${location.hostname}:7020`;

async function req(path, { method = "GET", body } = {}) {
  const r = await fetch(EXEC_BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.error) || `HTTP ${r.status}`);
  return d;
}

// 許可ユーザーなら user_id、未許可・サービス停止なら null（=UIを出さない）
export async function execMe() {
  try { return (await req("/me")).user_id; } catch { return null; }
}
export function getQueue() { return req("/queue"); }
export function getScripts() { return req("/scripts"); }
export function runAi(taskId, title) { return req("/run", { method: "POST", body: { kind: "ai", task_id: taskId, title } }); }
export function runScript(script, taskId = null) { return req("/run", { method: "POST", body: { kind: "script", script, task_id: taskId } }); }
export function cancelJob(id) { return req(`/queue/${id}`, { method: "DELETE" }); }
// SSE は EventSource がヘッダを送れないため token をクエリで渡す
export function streamUrl(jobId) { return `${EXEC_BASE}/stream/${jobId}?token=${encodeURIComponent(token())}`; }
