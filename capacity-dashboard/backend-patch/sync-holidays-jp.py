#!/usr/bin/env python3
# 日本の祝日を TaskStation の /holidays へ冪等同期する。
# ソース: 内閣府の公式CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv・cp932）。
# 方針: 今日以降の祝日を「追加のみ」（既存は触らない・削除しない）。過去分も触らない。
# 認証: 環境変数 TS_URL（既定 http://localhost:7005/api/v1）/ TS_USER / TS_PASS。
# 運用: systemd user timer `taskstation-holiday-sync.timer`（週1）から実行。
#       止まった検知は SPA 側（ホームのアラート・holidayDataStatus）が担う。
import csv
import io
import json
import os
import sys
import urllib.request
from datetime import date

CAO_CSV = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"


def req(base, path, method="GET", body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(
        base + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers)
    with urllib.request.urlopen(r, timeout=30) as res:
        return json.load(res)


def main():
    base = os.environ.get("TS_URL", "http://localhost:7005/api/v1")
    user, pw = os.environ.get("TS_USER"), os.environ.get("TS_PASS")
    if not user or not pw:
        print("TS_USER/TS_PASS が未設定です", file=sys.stderr)
        return 2

    raw = urllib.request.urlopen(CAO_CSV, timeout=30).read()
    rows = list(csv.reader(io.StringIO(raw.decode("cp932"))))[1:]  # 先頭行=ヘッダ
    today = date.today().isoformat()
    wanted = {}
    for r in rows:
        if len(r) < 2 or "/" not in r[0]:
            continue
        y, m, d = r[0].split("/")
        iso = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
        if iso >= today:
            wanted[iso] = r[1].strip()
    if not wanted:
        print("CSVから今日以降の祝日が取得できませんでした（フォーマット変更?）", file=sys.stderr)
        return 1

    token = req(base, "/login", "POST", {"username": user, "password": pw})["token"]
    existing = {h["date"][:10] for h in (req(base, "/holidays", token=token) or [])}
    added = 0
    for iso, name in sorted(wanted.items()):
        if iso in existing:
            continue
        req(base, "/holidays", "PUT", {"date": iso + "T00:00:00Z", "name": name}, token)
        added += 1
    print(f"holidays: 追加 {added} 件（CSV今日以降 {len(wanted)} 件・既存 {len(existing)} 件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
