#!/usr/bin/env python3
"""keikaku（計画スキル）の CSV 出力を taskstation(Vikunja フォーク) に投入する。

呼称階層（厳守）:
  ワークスペース(=Vikunja project) ＞ プロジェクト(=親タスク) ＞ タスク(=子タスク)
  「プロジェクト」も「タスク」も実体は task。親子は relation `parenttask` で表現する。

CSV を読み、全タスクを生成してから relation(parenttask / precedes) と assignee を貼る
2フェーズ方式で、CSVローカルID 参照の前後関係を回避する。

冪等性:
  ⚠ `--plan-id` 未指定時は非冪等。再実行すると毎回新規タスクを重複作成する。
  ✅ `--plan-id <KEY>` 指定時は冪等。description 末尾に
     `<!--keikaku:plan=<planId>;id=<localId>-->` マーカーを埋め、再投入では投入先WSの既存
     タスクをページング全件取得して検索し、新規生成せず更新(get→merge→post)する。
     relation/assignee の重複追加で重複(400/409)が返っても「(既存)」として握りつぶすが、
     5xx 等の本物のエラーは失敗として表示する。
     ※ マーカー形式は SPA 版(app/views/keikaku.js)と完全一致させること。
     ※ --plan-id 再投入時は本体(title/description/日付/見積)を get→merge→post で更新し、
       計画から外した見積/期日も明示クリア(time_estimate=0 / 日付="0001-01-01T00:00:00Z")
       して反映する。ただし依存/親子/担当の【削除】reconcile は未対応。差分削除が要るときは
       SPA の計画ウィザード(app/views/keikaku.js)を使うこと。

assignee 解決（実HTTPモードのみ。dry-run では名前のまま表示しオフライン維持）:
  - 空                              → なし
  - 整数                            → その user_id
  - "自分"/"me"/自分のusername/name → whoami（GET /user の自分の id）。SPA(keikaku.js)と統一
  - それ以外                        → GET /users?s=<name> で username 完全一致の id。0件/複数/エラーはスキップ＋警告

期間（start_date / end_date）:
  due と est_hours(>0) が両方あるとき、稼働日 cap-hours(既定8h) から所要営業日数 days を逆算し、
  end=due / start=「end から手前へ営業日を days 個カウントした days 個目の営業日」を付与する
  （end が非営業日ならカウントせず手前へ。end 含め営業日を days 個確保。土日＋holidays を非営業日
  とする）。SPA(app/views/keikaku.js)の computeStartBusinessDay と同一意味論。

使い方:
  # オフライン検証（HTTP を一切叩かない・トークン不要）
  python3 tools/keikaku-import.py -p <WS_id> --csv tools/sample-plan.csv --dry-run
  python3 tools/keikaku-import.py -p <WS_id> --csv tools/sample-plan.csv --dry-run \
      --plan-id onboarding --cap-hours 6

  # 実投入（capdemo 等のトークンを /tmp/cap_token に置いて実行）
  TOKEN=$(curl -s -X POST http://leo:7005/api/v1/login -H 'Content-Type: application/json' \
    -d '{"username":"capdemo","password":"CapDemoPass123"}' \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
  echo "$TOKEN" > /tmp/cap_token
  # 非冪等（v1 互換）
  python3 tools/keikaku-import.py -p <WS_id> --csv tools/sample-plan.csv
  # 冪等（再実行で重複作成しない）
  python3 tools/keikaku-import.py -p <WS_id> --csv tools/sample-plan.csv --plan-id onboarding

CSV スキーマ:
  id,parent,task,type,assignee,est_hours,depends_on,due,done_criteria
  - id:            CSVローカルID（文字列。例 P, 1, 2...）
  - parent:        親行のCSVローカルID。空=ワークスペース直下（=プロジェクト親タスク自身）
  - task:          タイトル
  - type:          project(=プロジェクト親タスク) / PJ / 定常
  - assignee:      整数=user_id / "自分"/"me"=whoami / その他=username 完全一致解決
  - est_hours:     空可。数値なら time_estimate=秒(×3600)へ。期間逆算にも使う
  - depends_on:    空可。CSVローカルIDをカンマ区切り（"2,3,4,5" 等）
  - due:           空可。YYYY-MM-DD
  - done_criteria: description に入れる
"""
import argparse
import csv
import datetime
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "http://leo:7005/api/v1"

# SPA(app/views/keikaku.js:186 markerRe)と完全一致。description からマーカーを抽出する。
# plan は sanitize 済み(";" 除去)なので [^;]*? で安全に拾える。id 境界は "-->" 込み。
MARKER_RE = re.compile(r"<!--keikaku:plan=([^;]*?);id=(.*?)-->")

# SPA(keikaku.js:198 EMPTY_DATE)と同値。capacity.js hasDate が "0001" 始まりを空判定＝クリア用。
# 冪等更新(for_update)で計画から外した日付フィールドを明示クリアするのに使う。
EMPTY_DATE = "0001-01-01T00:00:00Z"


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


def fetch_all_project_tasks(token, project_id):
    """投入先WS(=project)のタスクを全件ページング取得して (list, None) を返す。失敗時 (None, err)。

    GET /projects/{id}/tasks?per_page=50&page=N をループ。このエンドポイントは done タスクも
    含み related_tasks/assignees も返す（/tasks/all のような全WS横断＋50件クランプ問題が無い）。
    終了条件: レスポンスヘッダ X-Pagination-Total-Pages を読む。無ければ返り件数<per_page で打ち切り。
    """
    tasks = []
    page = 1
    per_page = 50
    total_pages = None
    guard = 0
    while guard < 1000:
        guard += 1
        path = f"/projects/{project_id}/tasks?per_page={per_page}&page={page}"
        r = urllib.request.Request(
            API + path, method="GET",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(r) as resp:
                t = resp.read().decode()
                body = json.loads(t) if t else []
                tp = resp.headers.get("X-Pagination-Total-Pages")
        except urllib.error.HTTPError as e:
            return None, f"[{e.code}] {e.read().decode()}"
        if not isinstance(body, list):
            return None, f"想定外の応答(page={page}): {body!r}"
        tasks.extend(body)
        if tp is not None:
            try:
                total_pages = int(tp)
            except (TypeError, ValueError):
                total_pages = None
        if total_pages is not None:
            if page >= total_pages:
                break
        elif len(body) < per_page:
            break
        page += 1
    return tasks, None


def dt(d):
    """YYYY-MM-DD -> YYYY-MM-DDT00:00:00Z（空は空のまま）。"""
    return (d + "T00:00:00Z") if d else ""


def is_int(s):
    try:
        int(s)
        return True
    except (TypeError, ValueError):
        return False


def to_hours(s):
    """est_hours を正の float に。空/非数値/0以下は None。"""
    try:
        v = float(s)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


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


def sanitize_plan_id(plan_id):
    """planId を trim ＋ ';' 除去（マーカーのフィールド区切りと衝突させない）。

    SPA(keikaku.js)の sanitizePlanId = (s).trim().replace(/;/g,"") と完全一致させる
    （前後空白入り --plan-id でマーカーが食い違い冪等が破れるのを防ぐ）。
    """
    return plan_id.strip().replace(";", "") if plan_id else plan_id


def marker_for(plan_id, local_id):
    """SPA(keikaku.js)と完全一致のマーカー文字列。planId は sanitize 済み前提。"""
    return f"<!--keikaku:plan={plan_id};id={local_id}-->"


def is_business_day(d, holidays_set):
    """土日でなく holidays_set("YYYY-MM-DD"文字列の set)に無い日 = 営業日。"""
    return d.weekday() < 5 and d.isoformat() not in holidays_set


def back_business_days(end_str, days, holidays_set):
    """end(YYYY-MM-DD)から手前へ営業日を days 個カウントし、days 個目の営業日を返す。

    SPA(keikaku.js)の computeStartBusinessDay と同一意味論:
      - end 自身が営業日ならカウント1から始める（end 含め営業日を days 個確保）。
      - end が非営業日(土日/祝)ならカウントせず手前へ進む。
    例) due=土曜・days=1 → start=直前金曜（keikaku.js と一致）。
    """
    cur = datetime.date.fromisoformat(end_str)
    start = cur
    count = 0
    guard = 0
    while count < days and guard < 4000:
        if is_business_day(cur, holidays_set):
            count += 1
            if count == days:
                start = cur
                break
        cur = cur - datetime.timedelta(days=1)
        guard += 1
    return start.isoformat()


def task_payload(row, cap_hours, holidays_set, plan_id=None, for_update=False):
    """createTaskInProject / updateTask に渡す body を作る（必要なものだけ）。

    plan_id 指定時は description 末尾に冪等マーカーを付与する。
    due と est_hours(>0) が揃えば start_date/end_date/due_date を期間として付与する。

    for_update=True（--plan-id 再投入の更新経路）では、計画から外した見積/期日を明示クリア
    する（SPA app/views/keikaku.js:204 taskBody の forUpdate と同一意味論。改修E）:
      - 見積なし          → time_estimate=0
      - due なし          → due_date/start_date/end_date を EMPTY_DATE
      - due あり見積なし  → start_date/end_date のみ EMPTY_DATE（due 点は残す）
    新規作成（for_update=False）は従来どおりキーを省略する（クリア不要）。
    """
    body = {"title": row["task"]}

    desc = row.get("done_criteria") or ""
    if plan_id:
        mk = marker_for(plan_id, row["id"])
        desc = (desc + "\n\n" + mk) if desc else mk
    if desc:
        body["description"] = desc

    due = row.get("due")
    est = to_hours(row.get("est_hours"))

    # 見積: est>0 のみ time_estimate を送る。更新で外したら 0 でクリア。
    if est is not None:
        body["time_estimate"] = int(round(est * 3600))
    elif for_update:
        body["time_estimate"] = 0

    # 期日/期間: due+est で期間バー。更新で外した分は EMPTY_DATE でクリア（Q26: due_date は一度だけ代入）。
    if due:
        body["due_date"] = dt(due)
        if est is not None:
            days = max(1, math.ceil(est / cap_hours))
            start = back_business_days(due, days, holidays_set)
            body["start_date"] = dt(start)
            body["end_date"] = dt(due)
        elif for_update:
            body["start_date"] = EMPTY_DATE
            body["end_date"] = EMPTY_DATE
    elif for_update:
        body["due_date"] = EMPTY_DATE
        body["start_date"] = EMPTY_DATE
        body["end_date"] = EMPTY_DATE

    return body


def resolve_assignee(req, raw, me_id, self_names, cache, row_id):
    """assignee 文字列を user_id(int) に解決。解決不能は None（警告出力）。実HTTPモード専用。

    self_names = {"自分","me", 自分のusername, 自分のname}（keikaku.js と統一）。
    """
    a = (raw or "").strip()
    if not a:
        return None
    if is_int(a):
        return int(a)
    if a in self_names:
        if me_id is None:
            print(f"⚠ 警告: 行 <id:{row_id}> の assignee '{a}' は whoami 未取得のためスキップ。")
        return me_id
    if a in cache:
        return cache[a]
    code, resp = req("/users?s=" + urllib.parse.quote(a))
    if not isinstance(resp, list):
        print(f"⚠ 警告: 行 <id:{row_id}> の assignee '{a}' の検索に失敗 [{code}] {resp} → スキップ。")
        return None
    matches = [u for u in resp if isinstance(u, dict) and u.get("username") == a]
    if len(matches) == 1:
        uid = matches[0].get("id")
        cache[a] = uid
        return uid
    print(f"⚠ 警告: 行 <id:{row_id}> の assignee '{a}' は username 完全一致が "
          f"{len(matches)} 件（0件/複数）→ スキップ。")
    return None


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
    cap_hours = args.cap_hours
    if cap_hours <= 0:
        print("⚠ --cap-hours は正の値が必要です。8 を使用します。", file=sys.stderr)
        cap_hours = 8.0
    plan_id = sanitize_plan_id(args.plan_id)

    req = None
    me_id = None
    self_names = {"自分", "me"}  # keikaku.js と統一（whoami 取得後に username/name を追加）
    holidays_set = set()
    assignee_cache = {}
    existing = {}  # localId -> 既存 task_id（plan_id 指定 + 実モードのみ）

    if not dry:
        token = load_token(args.token_file)
        req = make_req(token)
        # whoami（"自分"/"me"/自分のusername/name 解決用）
        code, me = req("/user")
        if isinstance(me, dict):
            me_id = me.get("id")
            for k in ("username", "name"):
                v = me.get(k)
                if v:
                    self_names.add(str(v).strip())
        else:
            print(f"⚠ 警告: GET /user 失敗 [{code}] {me}（'自分'/'me' は解決できません）。")
        # 祝日（無ければ空。土日のみ非営業日扱いになる）
        code, hs = req("/holidays")
        if isinstance(hs, list):
            holidays_set = {h["date"][:10] for h in hs if isinstance(h, dict) and h.get("date")}

        if plan_id:
            print("✅ 冪等モード: --plan-id 指定。既存タスクを検索して更新します（重複作成しません）。")
        else:
            print("⚠ 実投入モード: --plan-id 未指定のため非冪等です。再実行するとタスクを重複作成します。")
        print(f"=== 投入先ワークスペース(project) #{args.project} / cap={cap_hours}h ===")

        # ---- フェーズ0: 既存タスク検索（冪等モードのみ）----
        # 投入先WSに限定したページング全件取得でマーカーを拾う。/tasks/all の全WS横断＋
        # 50件クランプで既存を取りこぼし重複作成していたバグの修正。WS内なので project_id
        # フィルタは不要。
        if plan_id:
            tasks, err = fetch_all_project_tasks(token, args.project)
            # B3: 既存取得に失敗したら fail-closed＝1件も作らず中断（重複作成より中断が安全）。
            #     SPA(keikaku.js:668 改修B)のフェーズ0と同方針。--plan-id 無し経路は来ない。
            if tasks is None:
                print(f"⚠ 既存取得失敗のため冪等投入を中断(重複作成を避ける): {err}")
                return 1
            by_lid = {}  # localId -> [task_id, ...]（出現順＝API応答順。重複検出用）
            for t in tasks:
                if not isinstance(t, dict):
                    continue
                # B9: SPA(keikaku.js:189 lastMarker)と一致＝末尾の最後の一致を採用し、その plan で判定。
                ms = list(MARKER_RE.finditer(t.get("description") or ""))
                if not ms:
                    continue
                m = ms[-1]
                if m.group(1) != plan_id:
                    continue
                by_lid.setdefault(m.group(2), []).append(t.get("id"))
            for lid, tids in by_lid.items():
                # B9: 同一 localId が複数タスクに付くときは後勝ち(tids[-1])＝SPA の existing.set 後勝ちと一致。
                existing[lid] = tids[-1]
                if len(tids) > 1:
                    print(f"⚠ 警告: localId '{lid}' が plan='{plan_id}' で {len(tids)} 件重複 "
                          f"{tids} → 末尾 #{tids[-1]} を更新対象にします（他は孤児化）。")
            print(f"--- フェーズ0: 既存検出 {len(existing)} 件 "
                  f"{json.dumps(existing, ensure_ascii=False)}（取得 {len(tasks)} タスク）")
    else:
        suffix = f" / plan={plan_id}" if plan_id else ""
        print(f"=== DRY-RUN（HTTP は叩きません） / 投入先ワークスペース #{args.project}"
              f" / cap={cap_hours}h{suffix} ===")
        if plan_id:
            print("（dry-run は新規前提でマーカーのみ付与して表示します）")

    idmap = {}            # CSVローカルID -> 実ID（dry-run はプレースホルダ文字列）
    project_ids = []      # type=project の実ID
    child_count = 0
    new_count = 0
    update_count = 0

    # ---- フェーズA: 全タスク生成（冪等モードは既存を更新）----
    print("\n--- フェーズA: タスク生成 ---")
    for r in rows:
        lid = r["id"]
        # 更新経路か（dry-run は existing 空＝常に新規扱い＝オフライン維持）。
        # B4: 更新時は for_update=True を渡し、計画から外した見積/期日を明示クリアさせる。
        is_update = bool(plan_id and lid in existing)
        body = task_payload(r, cap_hours, holidays_set, plan_id, for_update=is_update)
        if dry:
            placeholder = f"<id:{lid}>"
            idmap[lid] = placeholder
            new_count += 1
            period = ""
            if body.get("start_date") and body.get("end_date"):
                period = f"  [期間 {body['start_date'][:10]}→{body['end_date'][:10]}]"
            print(f"PUT /projects/{args.project}/tasks {json.dumps(body, ensure_ascii=False)}"
                  f"  -> {placeholder} (type={r['type']}){period}")
        elif is_update:
            # 既存タスク更新: get→merge→post（POST はスカラ全置換のため既存を取得しマージして安全に上書き）
            eid = existing[lid]
            gcode, cur = req(f"/tasks/{eid}")
            # B1: GET 失敗時に空 merged で POST すると既存スカラ(priority/percent_done/done 等)が
            #     全消去される。取得失敗(非dict or >=300)なら更新せずスキップする。
            if not isinstance(cur, dict) or gcode >= 300:
                print(f"⚠ 警告: 既存タスク#{eid} 取得失敗 [{gcode}] {cur} → 更新スキップ（既存値の消去を回避）。")
                continue
            merged = dict(cur)
            merged.update(body)
            code, resp = req(f"/tasks/{eid}", "POST", merged)
            idmap[lid] = eid
            update_count += 1
            extra = "" if code < 300 else f" {resp}"
            print(f"POST /tasks/{eid} (更新) {json.dumps(body, ensure_ascii=False)}"
                  f"  -> #{eid} [{code}]{extra}")
        else:
            code, resp = req(f"/projects/{args.project}/tasks", "PUT", body)
            real = resp.get("id") if isinstance(resp, dict) else None
            idmap[lid] = real
            new_count += 1
            extra = "" if code < 300 else f" {resp}"
            print(f"PUT /projects/{args.project}/tasks {json.dumps(body, ensure_ascii=False)}"
                  f"  -> #{real} [{code}]{extra}")
        if r["type"] == "project":
            project_ids.append(idmap[lid])
        else:
            child_count += 1

    # relation/assignee の結果サフィックス。
    # 冪等モードでは「重複(400/409)」のみ「(既存)」として握り、5xx 等の本物のエラーは
    # 失敗として表示する。サーバが重複 relation に返す status が不確実なため 400/409 を
    # 重複とみなす（重複なら投入済みなので無視してよく、それ以外は本物の異常）。
    # TODO(crossfile): relation/assignee の reconcile（既存依存・親子・担当の差分削除）は未対応。
    #   --plan-id 再投入時、本 import.py は本体(title/desc/日付/見積)の更新＋追加のみ行い、
    #   削除は反映しない。差分削除が要るときは SPA(app/views/keikaku.js)の計画ウィザードを使うこと。
    def rel_extra(code, resp):
        if code < 300:
            return ""
        if plan_id and code in (400, 409):
            return " (既存)"
        return f" ⚠ {resp}"

    # ---- フェーズB: parenttask relation ----
    print("\n--- フェーズB: 親子付け(parenttask) ---")
    parent_rel_count = 0
    for r in rows:
        if not r["parent"]:
            continue
        child = idmap.get(r["id"])
        if child is None:  # B8: 生成失敗/更新スキップで自タスクIDが無い → relation を張らない
            continue
        parent = idmap.get(r["parent"])
        if parent is None:
            continue
        body = {"task_id": child, "other_task_id": parent, "relation_kind": "parenttask"}
        parent_rel_count += 1
        if dry:
            print(f"PUT /tasks/{child}/relations  child {child} parenttask parent {parent}")
        else:
            code, resp = req(f"/tasks/{child}/relations", "PUT", body)
            print(f"PUT /tasks/{child}/relations  #{child} parenttask #{parent} "
                  f"[{code}]{rel_extra(code, resp)}")

    # ---- フェーズC: depends_on -> precedes relation ----
    # 「タスクT が D に依存」= D が先行 = PUT /tasks/{D}/relations precedes T
    print("\n--- フェーズC: 依存(precedes) ---")
    dep_rel_count = 0
    for r in rows:
        t = idmap.get(r["id"])  # 依存する側（後続）
        if t is None:  # B8: 自タスクIDが無い（生成失敗/更新スキップ）→ 依存を張らない
            continue
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
                print(f"PUT /tasks/{d}/relations  #{d} precedes #{t} "
                      f"[{code}]{rel_extra(code, resp)}")

    # ---- assignee ----
    print("\n--- 担当(assignees) ---")
    assignee_count = 0
    for r in rows:
        a = r.get("assignee", "")
        if not a:
            continue
        t = idmap.get(r["id"])
        if t is None:  # B8: 自タスクIDが無い（生成失敗/更新スキップ）→ 担当を張らない（dry-run は placeholder で None にならない）
            continue
        if dry:
            # オフライン維持: 名前解決せずそのまま表示（スキップ判定もしない）
            assignee_count += 1
            print(f"PUT /tasks/{t}/assignees  assignee={a}")
            continue
        uid = resolve_assignee(req, a, me_id, self_names, assignee_cache, r["id"])
        if uid is None:
            continue
        assignee_count += 1
        code, resp = req(f"/tasks/{t}/assignees", "PUT", {"user_id": uid})
        print(f"PUT /tasks/{t}/assignees  #{t} <- user {uid} [{code}]{rel_extra(code, resp)}")

    # ---- サマリ ----
    print("\n=== サマリ ===")
    print(f"CSVローカルID -> 実ID マップ: {json.dumps(idmap, ensure_ascii=False)}")
    print(f"プロジェクト親タスク: {project_ids}")
    print(f"子タスク数: {child_count}")
    print(f"新規 {new_count} / 更新 {update_count}")
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
    p.add_argument("--plan-id", default=None,
                   help="指定すると冪等モード（マーカー埋め込み＋再投入で更新）。"
                        "未指定は非冪等(v1 互換)。")
    p.add_argument("--cap-hours", type=float, default=8.0,
                   help="1営業日あたりの稼働時間。期間(start/end)逆算に使う（既定 8）。")
    p.add_argument("--dry-run", action="store_true",
                   help="書き込みせず実行予定の操作を表示（トークン不要・オフライン）")
    args = p.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
