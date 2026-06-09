#!/usr/bin/env python3
"""予実ガントのデモデータ投入（冪等・再現可能）。

ガントの「スケジュール型バー(start→end)＋依存矢印」を見える化するため、既存タスクに
start_date/end_date と依存関係(precedes)を投入する。

⚠️ GOTCHA（重要）: Vikunja の `POST /tasks/:id` は **payload に含めなかった関連を空で上書きする**。
   特に assignees は task 更新時に payload の Assignees で置換されるため、`{title,start_date,end_date}`
   だけ送ると **担当者が全消去される**（colsToUpdate と同根の「渡さない＝消える」挙動）。
   → 本スクリプトは更新後に **専用エンドポイント `PUT /tasks/:id/assignees` で担当者を必ず復元する**。
   日付/見積りだけ直すときも、このスクリプトの ASSIGNEES を真実として再適用すること。

使い方: capdemo のトークンを /tmp/cap_token に置いて実行。
  TOKEN=$(curl -s -X POST http://leo:7005/api/v1/login -H 'Content-Type: application/json' \
    -d '{"username":"capdemo","password":"CapDemoPass123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
  echo "$TOKEN" > /tmp/cap_token && python3 seed-gantt-demo.py
"""
import json, urllib.request, urllib.error

API = "http://leo:7005/api/v1"
with open("/tmp/cap_token") as f:
    TOKEN = f.read().strip()

def req(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
    try:
        with urllib.request.urlopen(r) as resp:
            t = resp.read().decode()
            return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

dt = lambda d: d + "T00:00:00Z"

# id -> (title, start, end)
DATES = {
    3:  ("API設計",            "2026-06-03", "2026-06-04"),
    4:  ("DBマイグレーション",  "2026-06-05", "2026-06-06"),
    1:  ("認証フロー実装",      "2026-06-08", "2026-06-09"),
    5:  ("ダッシュ画面実装",    "2026-06-10", "2026-06-11"),
    6:  ("ログイン障害対応",    "2026-06-09", "2026-06-09"),
    7:  ("ダッシュ画面実装",    "2026-06-08", "2026-06-09"),
    8:  ("認証フロー実装(本番)", "2026-06-08", "2026-06-09"),
    9:  ("設計レビュー",        "2026-06-09", "2026-06-09"),
    10: ("設計ドキュメント",    "2026-06-08", "2026-06-09"),
    11: ("DBマイグレーション",  "2026-06-10", "2026-06-10"),
    12: ("結合テスト",          "2026-06-10", "2026-06-11"),
    13: ("LP制作",             "2026-06-11", "2026-06-12"),
}

# task_id -> user_id（更新で消えるので毎回復元する真実）。capdemo=1/morita=2/tanaka=3/satou=4/suzuki=5
ASSIGNEES = {6: 2, 7: 3, 8: 4, 9: 4, 10: 5, 11: 2, 12: 4, 13: 3}

# from precedes to（from が時間的に先）。Vikunja は逆 follows も自動付与する。
DEPS = [(3, 4), (4, 1), (1, 5), (8, 12), (11, 12)]

print("=== start/end 投入（※ assignees が消える） ===")
for tid, (title, s, e) in DATES.items():
    code, _ = req(f"/tasks/{tid}", "POST", {"title": title, "start_date": dt(s), "end_date": dt(e)})
    print(f"#{tid} {title}: {s}->{e} [{code}]")

print("=== assignees 復元（専用エンドポイント・必須） ===")
for tid, uid in ASSIGNEES.items():
    code, _ = req(f"/tasks/{tid}/assignees", "PUT", {"user_id": uid})
    print(f"#{tid} <- user {uid}: [{code}]")

print("=== 依存(precedes) 投入 ===")
for frm, to in DEPS:
    code, body = req(f"/tasks/{frm}/relations", "PUT",
                     {"task_id": frm, "other_task_id": to, "relation_kind": "precedes"})
    print(f"#{frm} precedes #{to}: [{code}]" + ("" if code < 300 else f" {body}"))

print("=== 検証 ===")
_, ts = req("/tasks/all?per_page=250")
z = "0001-01-01"
print("assignees有:", sum(1 for t in ts if (t.get("assignees") or [])))
print("start_date有:", sum(1 for t in ts if not t.get("start_date", "").startswith(z)))
print("related非空:", sum(1 for t in ts if t.get("related_tasks")))
