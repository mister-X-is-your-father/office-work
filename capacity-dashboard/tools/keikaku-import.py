#!/usr/bin/env python3
"""keikaku（計画スキル）の CSV 出力を taskstation(Vikunja フォーク) に投入する。

呼称階層（厳守）:
  ワークスペース(=Vikunja project) ＞ プロジェクト(=親タスク) ＞ タスク(=子タスク)
  「プロジェクト」も「タスク」も実体は task。親子は relation `parenttask` で表現する。

CSV を読み、全タスクを生成してから relation(parenttask / precedes) と assignee を貼る
2フェーズ方式で、CSVローカルID 参照の前後関係を回避する。

⚠ 非冪等（v1）: 再実行すると毎回新規タスクを重複作成する。同じ計画を二度流さないこと。
  冪等な取り込み（既存検索→更新）は v1 では非対応。

使い方:
  # オフライン検証（HTTP を一切叩かない・トークン不要）
  python3 tools/keikaku-import.py -p <WS_id> --csv tools/sample-plan.csv --dry-run

  # 実投入（capdemo 等のトークンを /tmp/cap_token に置いて実行）
  TOKEN=$(curl -s -X POST http://leo:7005/api/v1/login -H 'Content-Type: application/json' \
    -d '{"username":"capdemo","password":"CapDemoPass123"}' \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
  echo "$TOKEN" > /tmp/cap_token
  python3 tools/keikaku-import.py -p <WS_id> --csv tools/sample-plan.csv

CSV スキーマ:
  id,parent,task,type,assignee,est_hours,depends_on,due,done_criteria
  - id:            CSVローカルID（文字列。例 P, 1, 2...）
  - parent:        親行のCSVローカルID。空=ワークスペース直下（=プロジェクト親タスク自身）
  - task:          タイトル
  - type:          project(=プロジェクト親タスク) / PJ / 定常
  - assignee:      整数なら user_id として addAssignee。非整数("自分"等)はスキップ＋警告
  - est_hours:     空可。数値なら time_estimate=秒(×3600)へ
  - depends_on:    空可。CSVローカルIDをカンマ区切り（"2,3,4,5" 等）
  - due:           空可。YYYY-MM-DD
  - done_criteria: description に入れる
"""
import argparse
import csv
import json
import sys
import urllib.error
import urllib.request

API = "http://leo:7005/api/v1"


def make_req(token):
    """seed-gantt-demo.py の req() と同方針: (status, body) を返す。HTTPError も握る。"""
    def req(path, method="GET", body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(
            API + path, data=data, method=method,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(r) as resp:
                t = resp.read().decode()
                return resp.status, (json.loads(t) if t else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
    return req


def dt(d):
    """YYYY-MM-DD -> YYYY-MM-DDT00:00:00Z（空は空のまま）。"""
    return (d + "T00:00:00Z") if d else ""


def is_int(s):
    try:
        int(s)
        return True
    except (TypeError, ValueError):
        return False


def load_token(path):
    with open(path) as f:
        return f.read().strip()


def parse_csv(path):
    """行を dict のリストで返す。depends_on は list[str] に正規化。"""
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {k: (v.strip() if isinstance(v, str) else v) for k, v in raw.items()}
            dep = row.get("depends_on", "") or ""
            row["depends_on"] = [d.strip() for d in dep.split(",") if d.strip()]
            rows.append(row)
    return rows


def task_payload(row):
    """createTaskInProject に渡す body を作る（必要なものだけ）。"""
    body = {"title": row["task"]}
    if row.get("done_criteria"):
        body["description"] = row["done_criteria"]
    if row.get("due"):
        body["due_date"] = dt(row["due"])
    if row.get("est_hours"):
        body["time_estimate"] = int(round(float(row["est_hours"]) * 3600))
    return body


def run(args):
    rows = parse_csv(args.csv)
    if not rows:
        print("CSV に行がありません。", file=sys.stderr)
        return 1

    ids = {r["id"] for r in rows}
    # 参照整合チェック（parent / depends_on が CSV 内に存在するか）
    for r in rows:
        if r["parent"] and r["parent"] not in ids:
            print(f"⚠ 警告: 行 <id:{r['id']}> の parent '{r['parent']}' が CSV 内に存在しません。",
                  file=sys.stderr)
        for d in r["depends_on"]:
            if d not in ids:
                print(f"⚠ 警告: 行 <id:{r['id']}> の depends_on '{d}' が CSV 内に存在しません。",
                      file=sys.stderr)

    dry = args.dry_run
    req = None
    if not dry:
        token = load_token(args.token_file)
        req = make_req(token)
        print("⚠ 実投入モード: このスクリプトは非冪等です。再実行するとタスクを重複作成します。")
        print(f"=== 投入先ワークスペース(project) #{args.project} ===")
    else:
        print(f"=== DRY-RUN（HTTP は叩きません） / 投入先ワークスペース #{args.project} ===")

    idmap = {}            # CSVローカルID -> 実ID（dry-run はプレースホルダ文字列）
    project_ids = []      # type=project の実ID
    child_count = 0

    # ---- フェーズA: 全タスク生成 ----
    print("\n--- フェーズA: タスク生成 ---")
    for r in rows:
        body = task_payload(r)
        if dry:
            placeholder = f"<id:{r['id']}>"
            idmap[r["id"]] = placeholder
            print(f"PUT /projects/{args.project}/tasks {json.dumps(body, ensure_ascii=False)}"
                  f"  -> {placeholder} (type={r['type']})")
        else:
            code, resp = req(f"/projects/{args.project}/tasks", "PUT", body)
            real = resp.get("id") if isinstance(resp, dict) else None
            idmap[r["id"]] = real
            extra = "" if code < 300 else f" {resp}"
            print(f"PUT /projects/{args.project}/tasks {json.dumps(body, ensure_ascii=False)}"
                  f"  -> #{real} [{code}]{extra}")
        if r["type"] == "project":
            project_ids.append(idmap[r["id"]])
        else:
            child_count += 1

    # ---- フェーズB: parenttask relation ----
    print("\n--- フェーズB: 親子付け(parenttask) ---")
    parent_rel_count = 0
    for r in rows:
        if not r["parent"]:
            continue
        child = idmap.get(r["id"])
        parent = idmap.get(r["parent"])
        if parent is None:
            continue
        body = {"task_id": child, "other_task_id": parent, "relation_kind": "parenttask"}
        parent_rel_count += 1
        if dry:
            print(f"PUT /tasks/{child}/relations  child {child} parenttask parent {parent}")
        else:
            code, resp = req(f"/tasks/{child}/relations", "PUT", body)
            extra = "" if code < 300 else f" {resp}"
            print(f"PUT /tasks/{child}/relations  #{child} parenttask #{parent} [{code}]{extra}")

    # ---- フェーズC: depends_on -> precedes relation ----
    # 「タスクT が D に依存」= D が先行 = PUT /tasks/{D}/relations precedes T
    print("\n--- フェーズC: 依存(precedes) ---")
    dep_rel_count = 0
    for r in rows:
        t = idmap.get(r["id"])  # 依存する側（後続）
        for dep in r["depends_on"]:
            d = idmap.get(dep)  # 依存される側（先行）
            if d is None:
                continue
            body = {"task_id": d, "other_task_id": t, "relation_kind": "precedes"}
            dep_rel_count += 1
            if dry:
                print(f"PUT /tasks/{d}/relations  {d} precedes {t}   "
                      f"(<id:{r['id']}> depends_on <id:{dep}>)")
            else:
                code, resp = req(f"/tasks/{d}/relations", "PUT", body)
                extra = "" if code < 300 else f" {resp}"
                print(f"PUT /tasks/{d}/relations  #{d} precedes #{t} [{code}]{extra}")

    # ---- assignee ----
    print("\n--- 担当(assignees) ---")
    assignee_count = 0
    for r in rows:
        a = r.get("assignee", "")
        if not a:
            continue
        if not is_int(a):
            print(f"⚠ 警告: 行 <id:{r['id']}> の assignee '{a}' は user_id でないためスキップ"
                  f"（v1 は名前解決しません）。")
            continue
        t = idmap.get(r["id"])
        uid = int(a)
        assignee_count += 1
        if dry:
            print(f"PUT /tasks/{t}/assignees  user_id={uid}")
        else:
            code, resp = req(f"/tasks/{t}/assignees", "PUT", {"user_id": uid})
            extra = "" if code < 300 else f" {resp}"
            print(f"PUT /tasks/{t}/assignees  #{t} <- user {uid} [{code}]{extra}")

    # ---- サマリ ----
    print("\n=== サマリ ===")
    print(f"CSVローカルID -> 実ID マップ: {json.dumps(idmap, ensure_ascii=False)}")
    print(f"プロジェクト親タスク: {project_ids}")
    print(f"子タスク数: {child_count}")
    print(f"parenttask relation: {parent_rel_count} 本")
    print(f"precedes relation: {dep_rel_count} 本")
    print(f"assignee 設定: {assignee_count} 件")

    # ---- 実モードのみ検証 ----
    if not dry:
        print("\n=== 検証 (GET /tasks/all) ===")
        code, ts = req("/tasks/all?per_page=250")
        if isinstance(ts, list):
            print(f"related_tasks 非空: {sum(1 for t in ts if t.get('related_tasks'))} 件 [{code}]")
        else:
            print(f"検証取得失敗 [{code}] {ts}")

    return 0


def main():
    p = argparse.ArgumentParser(description="keikaku CSV を taskstation に投入する。")
    p.add_argument("--project", "-p", required=True,
                   help="投入先ワークスペース(=Vikunja project) ID")
    p.add_argument("--csv", required=True, help="入力 CSV のパス")
    p.add_argument("--token-file", default="/tmp/cap_token",
                   help="Bearer トークンファイル（デフォルト /tmp/cap_token）")
    p.add_argument("--dry-run", action="store_true",
                   help="書き込みせず実行予定の操作を表示（トークン不要・オフライン）")
    args = p.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
