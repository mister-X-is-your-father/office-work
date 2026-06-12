#!/usr/bin/env python3
"""TaskStation の AI 副担当「Fable」ランナー。

fable が担当（副担当）のタスクを巡回し、まだ提案していないタスクに
Claude Code CLI（ローカルの MAX サブスクリプションで実行・API課金なし）で
「段取り・注意点・たたき台」を生成してタスクコメントに投稿する。

- 資格情報: ~/.config/taskstation/fable.env (TS_API/TS_USER/TS_PASS)
- 重複防止: 自分(fable)のコメントが既に付いているタスクはスキップ
- systemd timer (taskstation-fable.timer) から15分おきに起動される想定
"""
import json
import os
import subprocess
import sys
import urllib.request

ENV_PATH = os.path.expanduser("~/.config/taskstation/fable.env")
CLAUDE_BIN = os.path.expanduser("~/.local/bin/claude")  # systemd の PATH に依存しない
MARKER = "🤖 Fable"
MAX_TASKS_PER_RUN = 3
CLAUDE_TIMEOUT = 600  # 秒/タスク


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k] = v
    return env


def req(api, path, token=None, method="GET", body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(api + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers=headers)
    with urllib.request.urlopen(r, timeout=30) as resp:
        txt = resp.read().decode()
    return json.loads(txt) if txt else None


def split_meta(desc):
    """taskform.js splitMeta と同じ規約: [資料] 行と [ゴール] ブロックを分離。"""
    links, lines = [], []
    for line in (desc or "").split("\n"):
        if line.startswith("[資料]"):
            links.append(line[len("[資料]"):].strip())
        else:
            lines.append(line)
    goal = ""
    if "[ゴール]" in [l.strip() for l in lines]:
        gi = [l.strip() for l in lines].index("[ゴール]")
        goal = "\n".join(lines[gi + 1:]).strip()
        lines = lines[:gi]
    return "\n".join(lines).strip(), goal, links


def build_prompt(task):
    text, goal, links = split_meta(task.get("description") or "")
    est = task.get("time_estimate") or 0
    parts = [
        "あなたはチームの副担当AI「Fable」です。以下のタスクについて、主担当がすぐ動けるように:",
        "1. 作業の段取り（手順 3〜7 個）",
        "2. 注意点・落とし穴",
        "3. 可能なら成果物のたたき台（下書き・雛形）",
        "を簡潔な日本語 Markdown で出してください。前置き・後置きは不要。",
        "",
        f"# タスク: {task.get('title', '')}",
    ]
    if text:
        parts.append(f"説明: {text}")
    if goal:
        parts.append(f"ゴール（完了条件）: {goal}")
    if links:
        parts.append("資料: " + " / ".join(links))
    if est:
        parts.append(f"見積り: {round(est / 3600, 2)}h")
    return "\n".join(parts)


def main():
    env = load_env(ENV_PATH)
    api = env["TS_API"]
    login = req(api, "/login", method="POST", body={"username": env["TS_USER"], "password": env["TS_PASS"]})
    token = login["token"]
    me = req(api, "/user", token)
    my_id = me["id"]

    tasks = req(api, "/tasks/all?per_page=250", token) or []
    targets = [t for t in tasks
               if not t.get("done") and any(a.get("id") == my_id for a in (t.get("assignees") or []))]

    done_count = 0
    for t in targets:
        if done_count >= MAX_TASKS_PER_RUN:
            break
        comments = req(api, f"/tasks/{t['id']}/comments", token) or []
        if any((c.get("author") or {}).get("id") == my_id for c in comments):
            continue  # 提案済み
        prompt = build_prompt(t)
        print(f"[fable] task #{t['id']} {t['title']!r} へ提案を生成中…", flush=True)
        try:
            out = subprocess.run(
                [CLAUDE_BIN, "-p", prompt, "--model", "sonnet"],
                capture_output=True, text=True, timeout=CLAUDE_TIMEOUT, check=True,
            ).stdout.strip()
        except subprocess.TimeoutExpired:
            print(f"[fable] task #{t['id']}: claude タイムアウト（スキップ）", file=sys.stderr)
            continue
        except subprocess.CalledProcessError as e:
            print(f"[fable] task #{t['id']}: claude 失敗: {e.stderr[:300]}", file=sys.stderr)
            continue
        if not out:
            continue
        comment = f"{MARKER} の提案（副担当AI・自動生成）\n\n{out}"
        req(api, f"/tasks/{t['id']}/comments", token, method="PUT", body={"comment": comment})
        print(f"[fable] task #{t['id']}: コメント投稿済み", flush=True)
        done_count += 1

    print(f"[fable] 完了: 対象 {len(targets)} 件中 {done_count} 件に投稿", flush=True)


if __name__ == "__main__":
    main()
