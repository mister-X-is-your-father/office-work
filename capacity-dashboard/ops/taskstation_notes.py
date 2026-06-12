"""Fable の AIコメント（隠しストア）。TaskStation のコメントには書かず、ここに溜める。

閲覧は taskstation-exec の GET /notes/<task_id>（許可ユーザーのみ）→ SPA の
「AIコメント」欄（タスク作成者のみ表示）。exec / MCP / runner が共用する。
"""
import fcntl
import json
import os
import time

PATH = os.path.expanduser("~/.local/share/taskstation-fable/notes.json")


def add(task_id, kind, text, job_id=None):
    """kind: plan(計画) / progress(進捗メモ) / result(作業結果) / script(スクリプト出力) / proposal(自動提案)"""
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    with open(PATH, "a+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        try:
            data = json.load(f)
        except ValueError:
            data = {}
        data.setdefault(str(task_id), []).append(
            {"ts": int(time.time()), "kind": kind, "text": text, "job_id": job_id})
        f.seek(0)
        f.truncate()
        json.dump(data, f, ensure_ascii=False)


def list_for(task_id):
    try:
        with open(PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    return data.get(str(task_id), [])
