// taskstation-exec（leo:7020）クライアント。Fable ▶実行・直列キュー・スクリプト・SSEコンソール。
// 認証は TaskStation の JWT をそのまま送る（サービス側で許可ユーザーIDを検証＝隠し要素）。
import { token } from "./api.js";

// オリジン適応（api.js と同様）: HTTPS（PWA・tailscale serve で /exec を同居）では相対、
// 平文 HTTP では 7020 を直叩き。mixed content 回避。
export const EXEC_BASE = location.protocol === "https:" ? location.origin + "/exec" : `http://${location.hostname}:7020`;

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
export function runAi(taskId, title, options = null) { return req("/run", { method: "POST", body: { kind: "ai", task_id: taskId, title, options: options || loadRunOpts() } }); }
// 計画モード（--permission-mode plan・読み取り専用）。計画はAIコメント(kind=plan)に保存され、次の実行に自動添付される。
export function planAi(taskId, title) { return req("/run", { method: "POST", body: { kind: "ai", task_id: taskId, title: `計画: ${title}`, options: { ...loadRunOpts(), plan: true } } }); }
// AIコメント（隠しノート・許可ユーザーのみ）
export function getNotes(taskId) { return req(`/notes/${taskId}`); }
// チーム設定（読み取り=全ログインユーザー / 書き込み=許可ユーザーのみ）
export function getSettings() { return req("/settings"); }
export function saveSettings(s) { return req("/settings", { method: "POST", body: s }); }
// 一覧の共有ソートプリセット（グローバル）: [{name, sorts:[{key,dir}]}]。書き込みは許可ユーザーのみ。
export function savePresets(sortPresets) { return req("/settings", { method: "POST", body: { sort_presets: sortPresets } }); }
// メニュー表示制御: {"<userId>": ["hiddenRouteKey",...]}（各人の非表示メニュー集合）。書き込みは許可ユーザー（管理者）のみ。
export function saveMenuVisibility(menuVisibility) { return req("/settings", { method: "POST", body: { menu_visibility: menuVisibility } }); }
// 着手準備パネル（実行サポート）の per-task データ。読み書きとも全ログインユーザー可（タスク単位の作業データ）。
// 戻り値は { prep: {...} }（保存時は保存後の本体）。本体は { [methodId]: data, score } の汎用JSON。
export function getPrep(taskId) { return req(`/prep/${taskId}`); }
export function savePrep(taskId, prep) { return req(`/prep/${taskId}`, { method: "POST", body: prep }); }
// 成果物（Fable作業ディレクトリのファイル）
export function getFiles() { return req("/files"); }
export function fileUrl(relPath) { return `${EXEC_BASE}/file/${encodeURIComponent(relPath)}?token=${encodeURIComponent(token())}`; }
// 実行オプション（モデル/ブラウザ操作/Web検索/追加指示）。localStorage に保存し ▶ 全箇所で共有。
const OPTS_KEY = "ts.fable.runopts";
export function loadRunOpts() {
  try { return { model: "sonnet", browser: false, web: false, extra: "", ...(JSON.parse(localStorage.getItem(OPTS_KEY)) || {}) }; }
  catch { return { model: "sonnet", browser: false, web: false, extra: "" }; }
}
export function saveRunOpts(o) { try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch { /* noop */ } }
export function runScript(script, taskId = null) { return req("/run", { method: "POST", body: { kind: "script", script, task_id: taskId } }); }
export function cancelJob(id) { return req(`/queue/${id}`, { method: "DELETE" }); }
// SSE は EventSource がヘッダを送れないため token をクエリで渡す
export function streamUrl(jobId) { return `${EXEC_BASE}/stream/${jobId}?token=${encodeURIComponent(token())}`; }
