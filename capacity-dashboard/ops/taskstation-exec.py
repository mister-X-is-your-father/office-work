#!/usr/bin/env python3
"""TaskStation 実行サービス（Fable ▶実行・キュー・スクリプト・ライブコンソール）。

- POST /run        {kind:"ai"|"script", task_id?, script?, note?} → キュー投入（直列実行）
- GET  /queue      キュー＋実行中＋履歴（直近20）
- DELETE /queue/<id>  待機中ジョブの取消
- GET  /stream/<id>?token=…  SSE コンソール（バッファ再生＋ライブ）
- GET  /scripts    実行可能スクリプト一覧（~/.config/taskstation/scripts/*.sh|*.py）
- GET  /me         認証確認（許可ユーザーなら 200）

認証: Authorization: Bearer <TaskStationのJWT>（SSEは ?token=）。
トークンを TaskStation の /user で検証し、exec.json の allowed_user_ids のみ許可。
AI 実行はローカル Claude Code CLI（MAXサブスク・API課金なし）。完了時にタスクへコメント投稿（fable名義）。
"""
import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys_path_dir = os.path.dirname(os.path.abspath(__file__))
import sys as _sys
if sys_path_dir not in _sys.path:
    _sys.path.insert(0, sys_path_dir)
import taskstation_notes as notes

HOME = os.path.expanduser("~")
CONF_PATH = f"{HOME}/.config/taskstation/exec.json"
FABLE_ENV = f"{HOME}/.config/taskstation/fable.env"
SCRIPTS_DIR = f"{HOME}/.config/taskstation/scripts"
CLAUDE_BIN = f"{HOME}/.local/bin/claude"
TS_API = "http://localhost:7005/api/v1"
PORT = 7020
HISTORY_MAX = 20
AI_TIMEOUT = 1800
SCRIPT_TIMEOUT = 1800

conf = json.load(open(CONF_PATH))
ALLOWED = set(conf.get("allowed_user_ids", []))

# ---- TaskStation API ----

def ts_req(path, token, method="GET", body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(TS_API + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=headers)
    with urllib.request.urlopen(r, timeout=30) as resp:
        txt = resp.read().decode()
    return json.loads(txt) if txt else None


_auth_cache = {}  # token -> (uid, expires)

def auth_user(token):
    if not token:
        return None
    hit = _auth_cache.get(token)
    if hit and hit[1] > time.time():
        return hit[0]
    try:
        me = ts_req("/user", token)
    except Exception:
        return None
    uid = me and me.get("id")
    if uid not in ALLOWED:
        return None
    _auth_cache[token] = (uid, time.time() + 300)
    return uid


def fable_token():
    env = {}
    with open(FABLE_ENV) as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                env[k] = v
    return ts_req("/login", None, "POST", {"username": env["TS_USER"], "password": env["TS_PASS"]})["token"]


def ts_req_noauth(path, method="POST", body=None):  # /login 用
    return ts_req(path, "", method, body)

# ---- ジョブ・キュー ----

class Job:
    _seq = 0
    _lock = threading.Lock()

    def __init__(self, kind, task_id=None, script=None, user_token=None, title="", options=None):
        with Job._lock:
            Job._seq += 1
            self.id = Job._seq
        self.kind = kind            # "ai" | "script"
        self.task_id = task_id
        self.script = script
        self.user_token = user_token
        self.title = title
        self.options = options or {}  # ai: {model, browser, web, extra}
        self.status = "queued"      # queued | running | done | error | cancelled
        self.created = time.time()
        self.lines = []             # コンソールバッファ
        self.cond = threading.Condition()

    def emit(self, line):
        with self.cond:
            self.lines.append(line)
            self.cond.notify_all()

    def brief(self):
        return {"id": self.id, "kind": self.kind, "task_id": self.task_id, "script": self.script,
                "title": self.title, "status": self.status, "created": int(self.created)}


queue_lock = threading.Lock()
pending = []
history = []
current = None


def enqueue(job):
    with queue_lock:
        pending.append(job)
    worker_wake.set()


worker_wake = threading.Event()


MCP_CONFIG = f"{HOME}/.config/taskstation/mcp.json"
WORK_DIR = f"{HOME}/.local/share/taskstation-fable/work"  # AI実行の作業場（既存リポジトリを汚さない）


def build_ai_prompt(task):
    desc = task.get("description") or ""
    est = task.get("time_estimate") or 0
    p = ["あなたはチームの副担当AI「Fable」です。以下のタスクを実際に進めてください。",
         "taskstation ツールでタスクを直接操作できます。作法:",
         "- 作業の区切りで add_note に進捗を簡潔に記録（設定者がAIコメント欄で追えるように）",
         "- タスクが大きい/複数工程なら create_subtask で分割（担当は付けない＝人間が割り振る）",
         "- 進み具合に応じて set_progress を更新。見積りが明らかにズレていれば set_estimate",
         "- complete_task は成果物まで完全に終わったときだけ",
         "- 最後に、やったこと・残り・人間への引き継ぎ事項を本文として出力（自動でコメント投稿される）",
         "制約: 成果物ファイルはカレント（専用作業ディレクトリ）に作ること。既存のリポジトリや他ディレクトリへの変更は、"
         "タスク本文で場所が明示されている場合のみ。git commit/push は行わない。",
         "出力は日本語Markdown・前置き不要。",
         "", f"# タスク: #{task.get('id')} {task.get('title', '')}"]
    if desc:
        p.append(f"内容:\n{desc}")
    if est:
        p.append(f"見積り: {round(est / 3600, 2)}h")
    return "\n".join(p)


PLAN_MARK = "📝 Fable の実行計画"


def latest_plan(token, task_id):
    """直近の計画ノート（承認待ち→実行時に「承認済みの計画」としてプロンプトに添付）"""
    for n in reversed(notes.list_for(task_id)):
        if n.get("kind") == "plan":
            return n.get("text")
    return None


def run_ai(job):
    token = fable_token()
    task = ts_req(f"/tasks/{job.task_id}", token)
    opt = job.options
    plan_mode = bool(opt.get("plan"))
    model = opt.get("model") if opt.get("model") in ("sonnet", "opus", "fable") else "sonnet"
    browser = bool(opt.get("browser"))
    web = bool(opt.get("web"))
    extra = str(opt.get("extra") or "").strip()[:2000]
    job.emit(f"{'📝 計画モード' if plan_mode else '▶ AI実行'}開始: #{job.task_id} {task.get('title', '')}")
    job.emit(f"  オプション: model={model}" + (" +ブラウザ操作" if browser else "") + (" +Web検索" if web else ""))
    job_dir = f"{WORK_DIR}/task-{job.task_id}"
    os.makedirs(job_dir, exist_ok=True)

    # MCP構成: taskstation 常設＋ブラウザ操作時は playwright(headless) を追加
    mcp_cfg = json.load(open(MCP_CONFIG))
    allowed = "mcp__taskstation"
    if browser:
        mcp_cfg["mcpServers"]["playwright"] = {
            "command": "/usr/bin/npx", "args": ["-y", "@playwright/mcp@latest", "--headless", "--isolated"]}
        allowed += ",mcp__playwright"
    if web:
        allowed += ",WebSearch,WebFetch"
    cfg_path = f"{job_dir}/.mcp-{job.id}.json"
    with open(cfg_path, "w") as f:
        json.dump(mcp_cfg, f)

    if plan_mode:
        # 計画モード: 読み取り専用（--permission-mode plan で変更系は物理的に不可）。計画文だけを出す。
        prompt = ("あなたはチームの副担当AI「Fable」です。以下のタスクの**実行計画だけ**を立ててください。"
                  "実装・ファイル作成・タスク操作は行わない（調査・読み取りは可）。\n"
                  "計画に含めるもの: 1) 手順（番号付き） 2) 成果物 3) 想定時間 4) リスク・注意点 "
                  "5) 人間に確認したいこと。日本語Markdown・前置き不要。\n\n"
                  f"# タスク: #{task.get('id')} {task.get('title', '')}\n内容:\n{task.get('description') or ''}")
    else:
        prompt = build_ai_prompt(task)
        approved = latest_plan(token, job.task_id)
        if approved:
            prompt += f"\n\n# 承認済みの実行計画（これに沿って実行。逸脱が必要ならコメントで理由を残す）\n{approved}"
            job.emit("  📝 承認済みの計画をプロンプトに添付")
    if browser:
        prompt += "\nブラウザ操作（playwright ツール）が許可されています。Webサイトの閲覧・操作が必要なら使ってください。"
    if web:
        prompt += "\nWeb検索・ページ取得（WebSearch/WebFetch）が許可されています。"
    if extra:
        prompt += f"\n\n# 追加指示（依頼者から）\n{extra}"

    cmd = [CLAUDE_BIN, "-p", prompt, "--model", model,
           "--mcp-config", cfg_path, "--allowedTools", allowed,
           "--disallowedTools", "Bash(git commit:*),Bash(git push:*)",
           "--output-format", "stream-json", "--verbose"]
    if plan_mode:
        cmd += ["--permission-mode", "plan"]
    proc = subprocess.Popen(cmd, cwd=job_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    final = []
    result_text = None
    start = time.time()
    for line in proc.stdout:
        if time.time() - start > AI_TIMEOUT:
            proc.kill()
            raise TimeoutError("AI実行タイムアウト")
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            job.emit(line)
            continue
        t = ev.get("type")
        if t == "assistant":
            for c in (ev.get("message") or {}).get("content", []):
                if c.get("type") == "text" and c.get("text"):
                    for ln in c["text"].split("\n"):
                        job.emit(ln)
                    final.append(c["text"])
                elif c.get("type") == "tool_use":
                    nm = (c.get("name") or "?").replace("mcp__taskstation__", "taskstation: ").replace("mcp__playwright__browser_", "browser: ")
                    inp = c.get("input") or {}
                    brief = inp.get("title") or inp.get("percent") or inp.get("hours") or ""
                    job.emit(f"⚙ {nm}{f'（{brief}）' if brief else ''}")
        elif t == "result":
            result_text = ev.get("result") or None  # 最終成果のみ（途中のつなぎ文を除く）
            job.emit(f"✔ 完了（{ev.get('duration_ms', 0) // 1000}秒）")
    proc.wait()
    try:
        os.remove(cfg_path)
    except OSError:
        pass
    out = (result_text or "\n\n".join(final)).strip()
    if out:
        notes.add(job.task_id, "plan" if plan_mode else "result", out, job.id)
        job.emit("💬 AIコメントに保存しました（設定者のみ閲覧）")


def run_script(job):
    path = os.path.join(SCRIPTS_DIR, job.script)
    if not os.path.isfile(path) or "/" in job.script or ".." in job.script:
        raise ValueError("スクリプトが見つかりません")
    job.emit(f"▶ スクリプト実行開始: {job.script}")
    env = dict(os.environ)
    if job.task_id:
        env["TS_TASK_ID"] = str(job.task_id)
    proc = subprocess.Popen(["bash", path] if path.endswith(".sh") else ["python3", path],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    start = time.time()
    tail = []
    for line in proc.stdout:
        if time.time() - start > SCRIPT_TIMEOUT:
            proc.kill()
            raise TimeoutError("スクリプトタイムアウト")
        job.emit(line.rstrip("\n"))
        tail.append(line.rstrip("\n"))
    rc = proc.wait()
    job.emit(f"✔ 終了 (exit {rc})")
    if job.task_id:
        body = "\n".join(tail[-30:])
        notes.add(job.task_id, "script", f"スクリプト `{job.script}`（exit {rc}）\n```\n{body}\n```", job.id)
        job.emit("💬 AIコメントに保存しました（設定者のみ閲覧）")
    if rc != 0:
        raise RuntimeError(f"exit {rc}")


def worker():
    global current
    while True:
        worker_wake.wait(5)
        worker_wake.clear()
        while True:
            with queue_lock:
                if not pending:
                    break
                current = pending.pop(0)
            job = current
            job.status = "running"
            try:
                if job.kind == "ai":
                    run_ai(job)
                else:
                    run_script(job)
                job.status = "done"
            except Exception as e:
                job.status = "error"
                job.emit(f"✖ エラー: {e}")
            with job.cond:
                job.cond.notify_all()
            with queue_lock:
                history.insert(0, job)
                del history[HISTORY_MAX:]
                current = None


threading.Thread(target=worker, daemon=True).start()

# ---- HTTP ----

def find_job(jid):
    with queue_lock:
        if current and current.id == jid:
            return current
        for j in pending + history:
            if j.id == jid:
                return j
    return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        tok = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not tok and "token=" in (self.path or ""):
            tok = re.search(r"[?&]token=([^&]+)", self.path).group(1)
        return auth_user(tok), tok

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        uid, tok = self._auth()
        if not uid:
            return self._json(401, {"error": "unauthorized"})
        if self.path.startswith("/me"):
            return self._json(200, {"user_id": uid})
        if self.path.startswith("/queue"):
            with queue_lock:
                return self._json(200, {
                    "running": current.brief() if current else None,
                    "pending": [j.brief() for j in pending],
                    "history": [j.brief() for j in history],
                })
        if self.path.startswith("/scripts"):
            try:
                names = sorted(f for f in os.listdir(SCRIPTS_DIR) if f.endswith((".sh", ".py")))
            except FileNotFoundError:
                names = []
            return self._json(200, {"scripts": names})
        if self.path.startswith("/files"):
            out = []
            for root, dirs, fs in os.walk(WORK_DIR):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for fn in fs:
                    if fn.startswith(".mcp-"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, WORK_DIR)
                    st = os.stat(full)
                    out.append({"path": rel, "size": st.st_size, "mtime": int(st.st_mtime)})
                    if len(out) >= 500:
                        break
            out.sort(key=lambda x: -x["mtime"])
            return self._json(200, {"files": out})
        mf = re.match(r"^/file/(.+?)(?:\?|$)", self.path)
        if mf:
            import urllib.parse
            rel = urllib.parse.unquote(mf.group(1))
            full = os.path.realpath(os.path.join(WORK_DIR, rel))
            if not full.startswith(os.path.realpath(WORK_DIR) + os.sep) or not os.path.isfile(full):
                return self._json(404, {"error": "not found"})
            import mimetypes
            ctype = mimetypes.guess_type(full)[0] or "text/plain"
            if ctype.startswith("text/") or ctype in ("application/json",):
                ctype += "; charset=utf-8"
            data = open(full, "rb").read()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", "inline")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        mn = re.match(r"^/notes/(\d+)", self.path)
        if mn:
            return self._json(200, {"notes": notes.list_for(int(mn.group(1)))})
        m = re.match(r"^/stream/(\d+)", self.path)
        if m:
            return self._stream(find_job(int(m.group(1))))
        self._json(404, {"error": "not found"})

    def _stream(self, job):
        if not job:
            return self._json(404, {"error": "no job"})
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        i = 0
        try:
            while True:
                with job.cond:
                    while i >= len(job.lines) and job.status in ("queued", "running"):
                        job.cond.wait(15)
                    chunk = job.lines[i:]
                    i = len(job.lines)
                    st = job.status
                for ln in chunk:
                    self.wfile.write(f"data: {json.dumps(ln, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()
                if st not in ("queued", "running") and i >= len(job.lines):
                    self.wfile.write(f"event: end\ndata: {json.dumps(st)}\n\n".encode())
                    self.wfile.flush()
                    return
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self):
        uid, tok = self._auth()
        if not uid:
            return self._json(401, {"error": "unauthorized"})
        if not self.path.startswith("/run"):
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad json"})
        kind = body.get("kind", "ai")
        task_id = body.get("task_id")
        script = body.get("script")
        if kind == "ai" and not task_id:
            return self._json(400, {"error": "task_id required"})
        if kind == "script" and not script:
            return self._json(400, {"error": "script required"})
        title = body.get("title") or (script if kind == "script" else f"task #{task_id}")
        raw_opt = body.get("options") or {}
        options = {k: raw_opt.get(k) for k in ("model", "browser", "web", "extra", "plan") if k in raw_opt}
        job = Job(kind, task_id=task_id, script=script, user_token=tok, title=title, options=options)
        enqueue(job)
        return self._json(200, {"job": job.brief()})

    def do_DELETE(self):
        uid, _ = self._auth()
        if not uid:
            return self._json(401, {"error": "unauthorized"})
        m = re.match(r"^/queue/(\d+)", self.path)
        if not m:
            return self._json(404, {"error": "not found"})
        jid = int(m.group(1))
        with queue_lock:
            for j in list(pending):
                if j.id == jid:
                    pending.remove(j)
                    j.status = "cancelled"
                    history.insert(0, j)
                    return self._json(200, {"cancelled": jid})
        return self._json(409, {"error": "not pending"})


if __name__ == "__main__":
    os.makedirs(SCRIPTS_DIR, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
