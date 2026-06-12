#!/usr/bin/env python3
"""TaskStation MCP サーバー（stdio・Fable 実行用）。

Claude Code から --mcp-config 経由で起動され、fable アカウントで TaskStation を操作する
ツール群を提供する。これにより Fable がタスクへの進捗記入・サブタスク分割・完了化を自律で行える。

ツール: get_task / add_comment / create_subtask / set_progress / set_estimate / complete_task
認証: ~/.config/taskstation/fable.env（fable アカウント）。
プロトコル: MCP 2024-11-05 / JSON-RPC 2.0 / 行区切り JSON over stdio。
"""
import json
import os
import sys
import urllib.request

TS_API = "http://localhost:7005/api/v1"
FABLE_ENV = os.path.expanduser("~/.config/taskstation/fable.env")
# タスクのスカラ更新は全置換仕様（#9）: 既存値を全部送ってから patch を載せる
TASK_SCALARS = ["title", "description", "done", "due_date", "start_date", "end_date",
                "priority", "percent_done", "repeat_after", "repeat_mode", "hex_color",
                "time_estimate", "is_favorite"]

_token = None


def ts(path, method="GET", body=None):
    global _token
    if _token is None:
        env = {}
        with open(FABLE_ENV) as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    env[k] = v
        _token = _req("/login", "POST", {"username": env["TS_USER"], "password": env["TS_PASS"]}, None)["token"]
    return _req(path, method, body, _token)


def _req(path, method, body, token):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(TS_API + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=headers)
    with urllib.request.urlopen(r, timeout=30) as resp:
        txt = resp.read().decode()
    return json.loads(txt) if txt else None


def safe_update(task_id, patch):
    cur = ts(f"/tasks/{task_id}")
    body = {k: cur[k] for k in TASK_SCALARS if k in cur}
    body.update(patch)
    return ts(f"/tasks/{task_id}", "POST", body)


# ---- ツール実装 ----

def t_get_task(a):
    t = ts(f"/tasks/{a['task_id']}")
    comments = ts(f"/tasks/{a['task_id']}/comments") or []
    return json.dumps({
        "id": t["id"], "title": t["title"], "description": t.get("description") or "",
        "done": t.get("done"), "percent_done": t.get("percent_done"),
        "estimate_hours": round((t.get("time_estimate") or 0) / 3600, 2),
        "due_date": t.get("due_date"), "project_id": t.get("project_id"),
        "assignees": [u.get("username") for u in (t.get("assignees") or [])],
        "subtasks": [{"id": x["id"], "title": x["title"], "done": x.get("done")}
                     for x in ((t.get("related_tasks") or {}).get("subtask") or [])],
        "comments": [{"author": (c.get("author") or {}).get("username"), "text": c.get("comment", "")[:500]}
                     for c in comments[-10:]],
    }, ensure_ascii=False)


def t_add_comment(a):
    ts(f"/tasks/{a['task_id']}/comments", "PUT", {"comment": a["text"]})
    return "コメントを投稿しました"


def t_create_subtask(a):
    parent = ts(f"/tasks/{a['parent_task_id']}")
    body = {"title": a["title"]}
    if a.get("description"):
        body["description"] = a["description"]
    if a.get("estimate_hours"):
        body["time_estimate"] = int(round(float(a["estimate_hours"]) * 3600))
    child = ts(f"/projects/{parent['project_id']}/tasks", "PUT", body)
    ts(f"/tasks/{a['parent_task_id']}/relations", "PUT",
       {"other_task_id": child["id"], "relation_kind": "subtask"})
    return f"サブタスク #{child['id']} 「{a['title']}」を作成しました（親 #{a['parent_task_id']}）"


def t_set_progress(a):
    pct = max(0, min(100, int(a["percent"])))
    safe_update(a["task_id"], {"percent_done": pct})
    return f"進捗を {pct}% に更新しました"


def t_set_estimate(a):
    sec = int(round(float(a["hours"]) * 3600))
    safe_update(a["task_id"], {"time_estimate": sec})
    return f"見積りを {a['hours']}h に更新しました"


def t_complete_task(a):
    safe_update(a["task_id"], {"done": True, "percent_done": 100})
    return f"タスク #{a['task_id']} を完了にしました"


NUM = {"type": "number"}
STR = {"type": "string"}
TOOLS = [
    ("get_task", "タスクの詳細（説明・進捗・サブタスク・直近コメント）を取得する",
     {"task_id": NUM}, ["task_id"], t_get_task),
    ("add_comment", "タスクに進捗・報告コメントを投稿する（Markdown可）",
     {"task_id": NUM, "text": STR}, ["task_id", "text"], t_add_comment),
    ("create_subtask", "タスクを分割してサブタスクを作る（担当は付けない＝人間が割り振る）",
     {"parent_task_id": NUM, "title": STR, "estimate_hours": NUM, "description": STR},
     ["parent_task_id", "title"], t_create_subtask),
    ("set_progress", "タスクの進捗率(0-100)を更新する",
     {"task_id": NUM, "percent": NUM}, ["task_id", "percent"], t_set_progress),
    ("set_estimate", "タスクの見積り(時間)を更新する",
     {"task_id": NUM, "hours": NUM}, ["task_id", "hours"], t_set_estimate),
    ("complete_task", "タスクを完了にする（本当に完了したときだけ使う）",
     {"task_id": NUM}, ["task_id"], t_complete_task),
]
TOOL_DEFS = [{"name": n, "description": d,
              "inputSchema": {"type": "object", "properties": p, "required": r}}
             for n, d, p, r, _ in TOOLS]
TOOL_FN = {n: f for n, d, p, r, f in TOOLS}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid = msg.get("id")
        method = msg.get("method")
        if method == "initialize":
            resp = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                    "serverInfo": {"name": "taskstation", "version": "1.0.0"}}
        elif method == "tools/list":
            resp = {"tools": TOOL_DEFS}
        elif method == "tools/call":
            name = msg["params"]["name"]
            args = msg["params"].get("arguments") or {}
            try:
                out = TOOL_FN[name](args)
                resp = {"content": [{"type": "text", "text": out}]}
            except Exception as e:
                resp = {"content": [{"type": "text", "text": f"エラー: {e}"}], "isError": True}
        elif mid is None:
            continue  # notification
        else:
            resp = {}
        if mid is not None:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": resp}, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
