#!/usr/bin/env python3
"""定期タスク/会議(RRULE)＋祝日＋個人休暇のデモ投入（冪等）。月次空き(freefinder)の動作確認用。
使い方: capdemo トークンを /tmp/cap_token に置いて実行（seed-gantt-demo.py と同様）。
メンバー: capdemo=1 / morita=2 / tanaka=3 / satou=4 / suzuki=5。"""
import json, urllib.request, urllib.error

API = "http://leo:7005/api/v1"
with open("/tmp/cap_token") as f:
    TK = f.read().strip()

def req(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + TK})
    try:
        with urllib.request.urlopen(r) as resp:
            t = resp.read().decode(); return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

# 冪等: 既存をクリア
for ep, key in [("/recurrences", "recurrence"), ("/holidays", "holiday"), ("/unavailability", "unavailability")]:
    _, cur = req(ep)
    for x in (cur or []):
        req(f"{ep}/{x['id']}", "DELETE")

RECS = [
    {"title": "毎週月の定例会議", "kind": "meeting", "rrule": "FREQ=WEEKLY;BYDAY=MO",
     "dtstart": "2026-06-01T00:00:00Z", "duration_seconds": 3600, "assignee_ids": [2, 3]},
    {"title": "毎月第2火レビュー", "kind": "meeting", "rrule": "FREQ=MONTHLY;BYDAY=2TU",
     "dtstart": "2026-06-01T00:00:00Z", "duration_seconds": 3600, "assignee_ids": [4]},
    {"title": "隔週水の棚卸し", "kind": "task", "rrule": "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
     "dtstart": "2026-06-03T00:00:00Z", "duration_seconds": 7200, "assignee_ids": [5]},
]
for r in RECS:
    print("recurrence", r["title"], req("/recurrences", "PUT", r)[0])
print("holiday", req("/holidays", "PUT", {"date": "2026-06-22T00:00:00Z", "name": "テスト祝日(月)"})[0])
print("unavailability(morita 6/29-7/1)",
      req("/unavailability", "PUT", {"user_id": 2, "start_date": "2026-06-29T00:00:00Z",
                                     "end_date": "2026-07-01T00:00:00Z", "reason": "有給"})[0])

_, rr = req("/recurrences"); _, hh = req("/holidays"); _, uu = req("/unavailability")
print(f"=> recurrences {len(rr or [])} / holidays {len(hh or [])} / unavailability {len(uu or [])}")
