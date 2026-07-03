#!/usr/bin/env python3
"""TaskStation MCP サーバー（stdio・AI×人間協業 v2）。

Claude Code から --mcp-config 経由で起動され、fable アカウントで TaskStation を操作する
ツール群を提供する。人間（森田 id=7）と AI（fable id=8）が協業するためのフル機能版。

既存ツール（fable-runner 使用中・後方互換維持）:
  get_task / add_note / create_subtask / set_progress / set_estimate / complete_task
v2 追加ツール:
  my_agenda / list_tasks / post_comment / start_task / escalate / resume_task /
  create_task / schedule_task（complete_task は optional summary で強化）
v2.1 追加:
  set_due（期日変更の唯一の入口・reason 必須＝相談合意ゲート）
  変更履歴: safe_update の diff / 作成 を exec(:7020) の活動ログへ fire-and-forget 記録（log_activity）
v2.2 追加:
  create_task に priority / blocked_by、担当に taskstation-ai(id=14)、AI担当判定を AI_USERS で一般化
  schedule_task の期間一括登録（end_date / skip_weekends・既定は土日スキップ）
  依存関係: add_dependency / remove_dependency（既存 relations の follows/precedes に乗せる＝
  SPA の依存グラフ・ガント依存線・「先行タスク」欄と同一規約。A が B に follows ＝ B の完了が A の前に必要）
  my_agenda はブロック中（未完了の先行タスクあり）を「⛔ ブロック中」セクションに分離表示
v2.3 追加（#693 運用ルールの MCP 強制＝違反はエラーで正しい道を案内する決定論的ガード）:
  complete_task の summary 必須化 / set_progress(100以上) 拒否→complete_task へ誘導 /
  分類「人間」タスクへの変更系ツール拒否（guard_human）/ resume_task は連絡待ち解除専用 / start_task は完了済み拒否
v2.4 追加:
  #689 safe_update を「タスク更新の唯一の関所（生POST禁止）」として正式化＋消失防波堤（stderr警告）
       ＋回帰テスト test_taskstation_mcp.py（部分更新セマンティクス・ガードを固定）
  #715 move_task（親の付け替え・SPA gRawSet("proj") と同一規約）／get_task に project/group（階層）／
       一覧行末に @プロジェクト/グループ を付記
  バグ修正: all_tasks() をページング化（サーバが per_page を 50 に丸めるため50件頭打ちだった）
v2.5 追加（#729 運用規約の焼き込み＝どの AI セッションも memory 無しで規約どおり操作できる）:
  INSTRUCTIONS に構造規約（階層3層モデル・Vikunja サブプロジェクト禁止・粒度規範・親無し浮きタスク禁止・
  タイトル絵文字禁止・priority 運用 3/2/1・担当3者の区分・生POST禁止）を明記。create_task description にも反映
認証（2資格情報方式）:
  ~/.config/taskstation/fable.env  = 操作の名義（コメント・タスク更新・進捗・作成・担当・plans。
                                     AI発言と人間の区別＝UXの核なので fable 名義を維持）
  ~/.config/taskstation/morita.env = ラベル管理の名義（Vikunja のラベルは作成者のみ操作・閲覧可のため、
                                     ラベル一覧/新規作成/付与/除去だけ森田名義で行う。
                                     fable 名義だと森田作成ラベルの付与が 403、新規作成は森田から不可視の別IDになる）
プロトコル: MCP 2024-11-05 / JSON-RPC 2.0 / 行区切り JSON over stdio。
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

import taskstation_notes as notes

TS_API = "http://localhost:7005/api/v1"
FABLE_ENV = os.path.expanduser("~/.config/taskstation/fable.env")
MORITA_ENV = os.path.expanduser("~/.config/taskstation/morita.env")  # ラベル管理専用（森田名義）
# タスクのスカラ更新は全置換仕様（#9）: 既存値を全部送ってから patch を載せる
# ⚠ タスク更新は safe_update 経由のみ（/tasks/{id} への生POST禁止・#689）。
#   生POSTは未指定フィールドを消失させる（実害あり: 31タスクの description/time_estimate 消失）
# started_at は SPA 拡張フィールド（doing 状態の判定に使う）
TASK_SCALARS = ["title", "description", "done", "due_date", "start_date", "end_date",
                "priority", "percent_done", "repeat_after", "repeat_mode", "hex_color",
                "time_estimate", "is_favorite", "started_at"]

WAIT_LABEL = "連絡待ち"          # エスカレーション（人間待ち）ラベル
CLASS_LABELS = ("AI+人間", "AI", "人間")  # 分類ラベル（表示優先順）
USER_IDS = {"森田": 7, "fable": 8,
            "taskstation-ai": 14, "タスクステーションAI": 14}  # 担当付与用（username/日本語名 → user_id）
AI_USERS = {"fable", "taskstation-ai"}   # AI担当とみなす username（my_agenda の対象判定）
UNSET = "0001-01-01T00:00:00Z"           # 日付「未設定」センチネル

_tokens = {}  # env パス別のトークンキャッシュ（遅延ログイン）


def _ts(env_path, path, method="GET", body=None):
    if env_path not in _tokens:
        env = {}
        with open(env_path) as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    env[k] = v
        _tokens[env_path] = _req("/login", "POST",
                                 {"username": env["TS_USER"], "password": env["TS_PASS"]}, None)["token"]
    return _req(path, method, body, _tokens[env_path])


def ts(path, method="GET", body=None):
    """fable 名義の API 呼び出し（操作の既定名義）。"""
    return _ts(FABLE_ENV, path, method, body)


def ts_m(path, method="GET", body=None):
    """森田名義の API 呼び出し（ラベル関連の読み書き専用）。"""
    return _ts(MORITA_ENV, path, method, body)


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
    """タスク更新の唯一の関所（生POST禁止・#689）。

    GET → TASK_SCALARS を全送 → patch 上書き → POST。バックエンドは全置換仕様のため、
    この経路を通らない生 POST（例: {title, priority} だけ送る）は未指定フィールドを
    消失させる（実害: 別セッションの API 直叩きで31タスクの description/time_estimate 消失）。
    ＝**未指定フィールドは既存値維持**（部分更新セマンティクス）。テストで固定
    （ops/test_taskstation_mcp.py）。
    """
    cur = ts(f"/tasks/{task_id}")
    body = {k: cur[k] for k in TASK_SCALARS if k in cur}
    body.update(patch)
    _warn_silent_loss(task_id, cur, patch)
    res = ts(f"/tasks/{task_id}", "POST", body)
    _log_update_diff(task_id, cur, patch)  # 成功後の fire-and-forget（戻り値・例外挙動は不変）
    return res


def _warn_silent_loss(task_id, cur, patch):
    """#689 消失防波堤: 非空だった値が空になる更新を stderr で検知する（検知のみ・ブロックしない）。

    set_due のクリア等、意図的な空化もあるため更新自体は実行する。diff は既存の
    _log_update_diff が type:"field" で活動ログに記録する（担保）。
    """
    checks = (("description", lambda v: bool((v or "").strip())),
              ("time_estimate", lambda v: (v or 0) > 0))
    for field, nonempty in checks:
        if field in patch and nonempty(cur.get(field)) and not nonempty(patch[field]):
            print(f"[warn] #689 silent-loss-guard: task {task_id} {field} が非空→空に更新されます",
                  file=sys.stderr)


# ---- 変更履歴（exec の活動ログへ追記） ----

EXEC_API = "http://localhost:7020"
# type=field で記録するフィールド whitelist（exec 側と同一。from/to は API 生値の str 化）
# "parent" は move_task の親付け替え記録用（safe_update の patch には現れない）
ACTIVITY_FIELDS = ("title", "due_date", "start_date", "end_date", "time_estimate", "description",
                   "priority", "parent")


def _fable_token():
    """fable の JWT を確実に得る（未ログインなら遅延ログインを 1 回起こす）。"""
    if FABLE_ENV not in _tokens:
        ts("/user")
    return _tokens[FABLE_ENV]


def log_activity(entry):
    """exec の活動ログへ追記（fire-and-forget・失敗は握る）。認証は fable の JWT をそのまま送る。"""
    try:
        r = urllib.request.Request(
            EXEC_API + "/activity", method="POST",
            data=json.dumps(entry, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + _fable_token()})
        with urllib.request.urlopen(r, timeout=5):
            pass
    except Exception:
        pass  # exec 停止時なども本処理を妨げない


def _log_update_diff(task_id, cur, patch):
    """safe_update の差分を変更履歴に記録する。done遷移 > 進捗変化 > whitelist フィールド変更。"""
    try:
        title = cur.get("title") or ""
        if "done" in patch and bool(patch["done"]) and not cur.get("done"):
            log_activity({"task_id": task_id, "type": "done",
                          "from": cur.get("percent_done") or 0, "to": 100, "title": title})
        elif "percent_done" in patch and (patch["percent_done"] or 0) != (cur.get("percent_done") or 0):
            log_activity({"task_id": task_id, "type": "progress",
                          "from": cur.get("percent_done") or 0, "to": patch["percent_done"] or 0,
                          "title": title})
        for f in ACTIVITY_FIELDS:
            if f in patch and patch[f] != cur.get(f):
                log_activity({"task_id": task_id, "type": "field", "field": f,
                              "from": str(cur.get(f) or ""), "to": str(patch[f] or ""),
                              "title": title})
    except Exception:
        pass  # 記録失敗は本処理を妨げない


# ---- 共通ヘルパ（v2） ----

_label_cache = None  # ラベルのタイトル→ID キャッシュ（プロセス内・ID ハードコード禁止のため動的解決）


def label_id(title, create=False):
    """ラベル名を ID に解決する（森田名義）。キャッシュにない場合は再取得、create=True なら新規作成。

    Vikunja のラベルは作成者のみ操作・閲覧可のため、一覧取得・新規作成とも森田名義（ts_m）で行う。
    """
    global _label_cache
    if _label_cache is None or title not in _label_cache:
        _label_cache = {l["title"]: l["id"] for l in (ts_m("/labels") or [])}
    if title in _label_cache:
        return _label_cache[title]
    if create:
        made = ts_m("/labels", "PUT", {"title": title})
        _label_cache[title] = made["id"]
        return made["id"]
    raise Exception(f"ラベル「{title}」が見つかりません")


def add_label(task_id, title, create=False):
    """ラベル付与（森田名義・冪等: 付与済みエラーは握る）。fable 名義だと 403 になる。"""
    lid = label_id(title, create=create)
    try:
        ts_m(f"/tasks/{task_id}/labels", "PUT", {"label_id": lid})
    except urllib.error.HTTPError as e:
        if e.code not in (400, 404, 409):  # 既に付与済み等は冪等に無視
            raise


def remove_label(task_id, title):
    """ラベル除去（森田名義・冪等: 付いていない時は403/404が返る（実測）＝冪等に無視）。"""
    try:
        lid = label_id(title)
    except Exception:
        return  # ラベル自体が存在しなければ何もしない
    try:
        ts_m(f"/tasks/{task_id}/labels/{lid}", "DELETE")
    except urllib.error.HTTPError as e:
        if e.code not in (400, 403, 404, 409):  # 付いていないラベルのDELETEは403/404（実測）
            raise


def guard_human(cur):
    """分類「人間」のタスクへの変更系操作を拒否する共通ガード（#693 運用ルールの強制）。

    適用: start_task / set_progress / set_estimate / set_due / complete_task /
    escalate / resume_task / schedule_task / move_task。
    対象外（許可）: post_comment / add_dependency / remove_dependency /
    create_subtask / get_task / add_note（読み取り・申し送り・構造化は妨げない）。
    """
    if "人間" in task_labels(cur):
        raise Exception("このタスクは分類「人間」＝人間専用です。AIからの変更はできません"
                        "（コメント post_comment と依存 add_dependency は可）")


def comment(task_id, text):
    """本物のタスクコメント（全員閲覧・SPAのタスク編集モーダルに出る）を投稿。"""
    ts(f"/tasks/{task_id}/comments", "PUT", {"comment": text})


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def task_labels(t):
    return [l.get("title") for l in (t.get("labels") or [])]


def task_assignees(t):
    return [u.get("username") for u in (t.get("assignees") or [])]


def has_date(s):
    return bool(s) and not s.startswith("0001")


def status_of(t):
    """SPA の statusOf と同一のステータス判定。"""
    if t.get("done"):
        return "done"
    if WAIT_LABEL in task_labels(t):
        return "waiting"
    if has_date(t.get("started_at") or "") or (t.get("percent_done") or 0) > 0:
        return "doing"
    return "todo"


STATUS_JA = {"todo": "未着手", "doing": "進行中", "waiting": "連絡待ち", "done": "完了"}


def all_tasks():
    """全タスク取得（ページング対応）。サーバは per_page を 50 に丸めるため単発では50件頭打ちになる。"""
    out = []
    for page in range(1, 201):  # フェイルセーフ最大200ページ
        batch = ts(f"/tasks/all?per_page=250&page={page}") or []
        if not batch:
            break
        out.extend(batch)
        if len(batch) < 50:  # サーバ上限(50)未満=最終ページ
            break
    return out


def template_project_ids():
    """テンプレートWS（project title が「テンプレート」）の ID 集合。"""
    return {p["id"] for p in (ts("/projects") or []) if (p.get("title") or "") == "テンプレート"}


def sort_key(t):
    """期限昇順（無期限は末尾）→ priority 降順。"""
    due = t.get("due_date") or ""
    if has_date(due):
        return (0, due, -(t.get("priority") or 0))
    return (1, "", -(t.get("priority") or 0))


def parent_task_of(t):
    """直近親（related_tasks.parenttask[0]）。無ければ None。"""
    pt = (t.get("related_tasks") or {}).get("parenttask") or []
    return pt[0] if pt else None


def project_ancestor(t, by_id):
    """SPA の projectAncestor 相当: (最上位祖先=プロジェクト, 直近親=グループ) を返す（#715）。

    parenttask 鎖を byId で辿る（訪問済みセットで循環ガード・byId に無い id で打ち切り）。
    祖先が無ければ (None, None)。直近親＝最上位（グループ層なし）のときは group=None。
    """
    seen = {t.get("id")}
    chain, cur = [], t
    while True:
        p = parent_task_of(cur)
        if not p:
            break
        node = by_id.get(p.get("id"))
        if node is None or node["id"] in seen:
            break
        seen.add(node["id"])
        chain.append(node)
        cur = node
    if not chain:
        return None, None
    project = chain[-1]
    group = chain[0] if len(chain) >= 2 else None
    return project, group


def _descendant_ids(root_id, by_id):
    """root_id 配下（subtask ツリー）の全タスク id 集合（循環ガード付き）。move_task の循環防止用。"""
    seen, stack = set(), [root_id]
    while stack:
        cur = by_id.get(stack.pop())
        if not cur:
            continue
        for x in ((cur.get("related_tasks") or {}).get("subtask") or []):
            xid = x.get("id")
            if xid and xid not in seen:
                seen.add(xid)
                stack.append(xid)
    return seen


def open_blocker_ids(t, by_id):
    """未完了ブロッカー（related_tasks.follows で done=false）の id リスト。

    related_tasks 内の斜め情報は古い可能性があるため、all_tasks() の byId で引き直して
    done を判定する。byId に無い id（権限外・削除済み等）は無視。
    """
    ids = []
    for x in ((t.get("related_tasks") or {}).get("follows") or []):
        b = by_id.get(x.get("id"))
        if b is not None and not b.get("done"):
            ids.append(b["id"])
    return ids


def fmt_line(t, ref_date=None, by_id=None):
    """一覧の1行: #id [分類] タイトル ・期限 ・見積h ・進捗% ・ステータス"""
    labels = task_labels(t)
    cls = next((c for c in CLASS_LABELS if c in labels), "-")
    due = t.get("due_date") or ""
    due_s = due[:10] if has_date(due) else "期限なし"
    est = round((t.get("time_estimate") or 0) / 3600, 1)
    line = (f"#{t['id']} [{cls}] {t['title']} ・期限{due_s} ・見積{est:g}h"
            f" ・進捗{t.get('percent_done') or 0}% ・{STATUS_JA[status_of(t)]}")
    if ref_date and has_date(due) and due[:10] < ref_date and not t.get("done"):
        line += " ⚠期限超過"
    if by_id is not None and not t.get("done") and open_blocker_ids(t, by_id):
        line += " ⛔ブロック中"
    if by_id is not None:  # 所属（プロジェクト/グループ）を行末に付記（#715）
        proj, grp = project_ancestor(t, by_id)
        if proj:
            line += f" @{proj['title']}" + (f"/{grp['title']}" if grp else "")
    return line


def total_est_hours(tasks):
    return round(sum((t.get("time_estimate") or 0) for t in tasks) / 3600, 1)


# ---- ツール実装 ----

def t_get_task(a):
    t = ts(f"/tasks/{a['task_id']}")
    ai_notes = notes.list_for(a["task_id"])
    rel = t.get("related_tasks") or {}
    by_id = {x["id"]: x for x in all_tasks()}
    proj, grp = project_ancestor(t, by_id)
    return json.dumps({
        "id": t["id"], "title": t["title"], "description": t.get("description") or "",
        "done": t.get("done"), "percent_done": t.get("percent_done"),
        "estimate_hours": round((t.get("time_estimate") or 0) / 3600, 2),
        "due_date": t.get("due_date"), "project_id": t.get("project_id"),
        "project": {"id": proj["id"], "title": proj["title"]} if proj else None,
        "group": {"id": grp["id"], "title": grp["title"]} if grp else None,
        "assignees": [u.get("username") for u in (t.get("assignees") or [])],
        "subtasks": [{"id": x["id"], "title": x["title"], "done": x.get("done")}
                     for x in (rel.get("subtask") or [])],
        "blocked_by": [{"id": x["id"], "title": x["title"], "done": x.get("done")}
                       for x in (rel.get("follows") or [])],
        "blocks": [{"id": x["id"], "title": x["title"]}
                   for x in (rel.get("precedes") or [])],
        "ai_notes": [{"kind": n.get("kind"), "text": (n.get("text") or "")[:500]} for n in ai_notes[-10:]],
    }, ensure_ascii=False)


def t_add_note(a):
    notes.add(a["task_id"], "progress", a["text"])
    return "進捗メモを記録しました（設定者のみ閲覧）"


def t_create_subtask(a):
    parent = ts(f"/tasks/{a['parent_task_id']}")
    body = {"title": a["title"]}
    if a.get("description"):
        body["description"] = a["description"]
    if a.get("estimate_hours"):
        body["time_estimate"] = int(round(float(a["estimate_hours"]) * 3600))
    child = ts(f"/projects/{parent['project_id']}/tasks", "PUT", body)
    log_activity({"task_id": child["id"], "type": "created", "title": a["title"]})
    ts(f"/tasks/{a['parent_task_id']}/relations", "PUT",
       {"other_task_id": child["id"], "relation_kind": "subtask"})
    return f"サブタスク #{child['id']} 「{a['title']}」を作成しました（親 #{a['parent_task_id']}）"


def t_set_progress(a):
    pct = int(a["percent"])
    if pct >= 100:  # 「100%なのに未完了」という状態を作らせない（#693）
        raise Exception("進捗100%は complete_task(summary) を使ってください"
                        "（「100%なのに未完了」という状態を作らない運用ルール）")
    guard_human(ts(f"/tasks/{a['task_id']}"))
    pct = max(0, pct)
    safe_update(a["task_id"], {"percent_done": pct})
    return f"進捗を {pct}% に更新しました"


def t_set_estimate(a):
    guard_human(ts(f"/tasks/{a['task_id']}"))
    sec = int(round(float(a["hours"]) * 3600))
    safe_update(a["task_id"], {"time_estimate": sec})
    return f"見積りを {a['hours']}h に更新しました"


def t_complete_task(a):
    if not str(a.get("summary") or "").strip():  # summary 必須（#693。fable-runner は complete_task 未使用）
        raise Exception("完了には summary（何をした・成果物の場所・検証状態）が必須です（運用ルール）")
    guard_human(ts(f"/tasks/{a['task_id']}"))
    comment(a["task_id"], f"🤖 ✅ 完了報告\n\n{a['summary']}")
    safe_update(a["task_id"], {"done": True, "percent_done": 100})
    remove_label(a["task_id"], WAIT_LABEL)
    return f"タスク #{a['task_id']} を完了にし、完了報告コメントを投稿しました"


def t_my_agenda(a):
    ref = a.get("date") or datetime.now().strftime("%Y-%m-%d")
    tmpl = template_project_ids()
    tasks = all_tasks()
    by_id = {t["id"]: t for t in tasks}
    active, waiting, blocked = [], [], []
    for t in tasks:
        if t.get("done") or t.get("project_id") in tmpl:
            continue
        labels = task_labels(t)
        if not (AI_USERS & set(task_assignees(t))) and "AI" not in labels and "AI+人間" not in labels:
            continue
        if WAIT_LABEL in labels:
            waiting.append(t)  # 連絡待ち > ブロック中（両方該当は連絡待ち側）
        elif open_blocker_ids(t, by_id):
            blocked.append(t)
        else:
            active.append(t)
    active.sort(key=sort_key)
    waiting.sort(key=sort_key)
    blocked.sort(key=sort_key)
    out = [f"📋 AIのアジェンダ（基準日 {ref}）: {len(active)}件 / 合計見積 {total_est_hours(active):g}h"]
    out += [fmt_line(t, ref, by_id) for t in active] or ["（今やるべきタスクはありません）"]
    if blocked:
        out.append("")
        out.append(f"⛔ ブロック中（先行タスク待ち）: {len(blocked)}件")
        out += [fmt_line(t, ref, by_id) + " " + " ".join(f"←#{b}" for b in open_blocker_ids(t, by_id))
                for t in blocked]
    if waiting:
        out.append("")
        out.append(f"⏳人間待ち（エスカレーション中）: {len(waiting)}件")
        out += [fmt_line(t, ref, by_id) for t in waiting]
    return "\n".join(out)


def t_list_tasks(a):
    tmpl = template_project_ids()
    tasks = all_tasks()
    by_id = {t["id"]: t for t in tasks}
    hits = []
    for t in tasks:
        if t.get("project_id") in tmpl:
            continue
        if a.get("label") and a["label"] not in task_labels(t):
            continue
        if a.get("assignee") and a["assignee"] not in task_assignees(t):
            continue
        sf = a.get("status")
        if sf == "undone":
            if t.get("done"):
                continue
        elif sf and status_of(t) != sf:
            continue
        if a.get("query") and a["query"] not in (t.get("title") or ""):
            continue
        if a.get("due_before"):
            due = t.get("due_date") or ""
            if not has_date(due) or due[:10] > a["due_before"]:
                continue
        hits.append(t)
    hits.sort(key=sort_key)
    out = [f"🔎 該当 {len(hits)}件 / 合計見積 {total_est_hours(hits):g}h"]
    out += [fmt_line(t, by_id=by_id) for t in hits] or ["（該当タスクなし）"]
    return "\n".join(out)


def t_post_comment(a):
    comment(a["task_id"], "🤖 " + a["text"])
    return f"#{a['task_id']} にコメントを投稿しました（全員閲覧）"


def t_start_task(a):
    cur = ts(f"/tasks/{a['task_id']}")
    guard_human(cur)
    if cur.get("done"):  # 完了済みの再開は不可（#693）
        raise Exception(f"#{a['task_id']} は完了済みです。完了済みタスクの再開はできません"
                        "（必要なら人間がUIで戻してください）")
    # doing化: percent は safe_update が既存値を維持。連絡待ちラベルは外す
    safe_update(a["task_id"], {"done": False, "started_at": now_iso()})
    remove_label(a["task_id"], WAIT_LABEL)
    if a.get("plan"):
        comment(a["task_id"], f"🤖 ▶ 着手します\n\n{a['plan']}")
    return f"タスク #{a['task_id']} に着手しました（進行中）"


def t_escalate(a):
    guard_human(ts(f"/tasks/{a['task_id']}"))
    # waiting化: percent/started は維持
    safe_update(a["task_id"], {"done": False})
    add_label(a["task_id"], WAIT_LABEL)
    msg = f"🚨 エスカレーション（人間の判断が必要です）\n\n■ 状況\n{a['reason']}"
    if a.get("options"):
        msg += f"\n\n■ 提案・選択肢\n{a['options']}"
    comment(a["task_id"], msg)
    return f"タスク #{a['task_id']} をエスカレーションしました（連絡待ち＝人間の一覧に浮き上がります）"


def t_resume_task(a):
    cur = ts(f"/tasks/{a['task_id']}")
    guard_human(cur)
    if WAIT_LABEL not in task_labels(cur):  # 連絡待ち解除専用（#693）
        raise Exception(f"#{a['task_id']} は連絡待ちではありません。着手は start_task を使ってください")
    remove_label(a["task_id"], WAIT_LABEL)
    safe_update(a["task_id"], {"done": False, "started_at": now_iso()})
    if a.get("note"):
        comment(a["task_id"], f"🤖 ▶ 再開します\n\n{a['note']}")
    return f"タスク #{a['task_id']} を再開しました（進行中）"


def t_create_task(a):
    body = {"title": a["title"]}
    desc = a.get("description") or ""
    if a.get("goal"):  # SPA の [ゴール] 規約: 説明末尾に結合
        desc = f"{desc}\n\n[ゴール]\n{a['goal']}" if desc else f"[ゴール]\n{a['goal']}"
    if desc:
        body["description"] = desc
    if a.get("estimate_hours"):
        body["time_estimate"] = int(round(float(a["estimate_hours"]) * 3600))
    if a.get("due_date"):
        body["due_date"] = a["due_date"] + "T00:00:00Z"
    if a.get("priority") is not None:
        body["priority"] = max(0, min(4, int(a["priority"])))  # 0=なし〜4=MUST
    if a.get("parent_task_id"):
        parent = ts(f"/tasks/{a['parent_task_id']}")
        pid = parent["project_id"]
    else:
        projects = ts("/projects") or []
        pid = next((p["id"] for p in projects if p.get("title") == "インボックス"),
                   next((p["id"] for p in projects if p.get("title") == "Inbox"), None))
        if pid is None:
            raise Exception("作成先WS（インボックス/Inbox）が見つかりません")
    task = ts(f"/projects/{pid}/tasks", "PUT", body)
    log_activity({"task_id": task["id"], "type": "created", "title": a["title"]})
    if a.get("parent_task_id"):
        ts(f"/tasks/{a['parent_task_id']}/relations", "PUT",
           {"other_task_id": task["id"], "relation_kind": "subtask"})
    for name in a.get("labels") or []:
        add_label(task["id"], name, create=True)  # 無いラベルは新規作成して付与
    for uname in a.get("assignees") or []:
        uid = USER_IDS.get(uname)
        if uid is None:
            raise Exception(f"不明な担当: {uname}（森田 / fable / taskstation-ai のみ）")
        ts(f"/tasks/{task['id']}/assignees", "PUT", {"user_id": uid})
    for bid in a.get("blocked_by") or []:  # 先行タスクへの依存（follows）を張る
        ts(f"/tasks/{task['id']}/relations", "PUT",
           {"other_task_id": int(bid), "relation_kind": "follows"})
    where = f"親 #{a['parent_task_id']} 配下" if a.get("parent_task_id") else f"WS {pid}"
    return f"タスク #{task['id']} 「{a['title']}」を作成しました（{where}）"


def t_set_due(a):
    """期日変更の唯一の入口（「相談の上」ゲート）。reason 必須＝合意内容を履歴とコメントに残す。"""
    cur = ts(f"/tasks/{a['task_id']}")
    guard_human(cur)
    old = cur.get("due_date") or ""
    old_s = old[:10] if has_date(old) else "期日なし"
    safe_update(a["task_id"], {"due_date": a["date"] + "T00:00:00Z"})  # diff は safe_update が type:field で自動記録
    comment(a["task_id"], f"🤖 📅 期日変更: {old_s} → {a['date']}\n\n■ 理由（相談済み）\n{a['reason']}")
    return f"#{a['task_id']} の期日を {old_s} → {a['date']} に変更しました（コメントに理由を記録）"


def t_schedule_task(a):
    guard_human(ts(f"/tasks/{a['task_id']}"))
    sec = int(round(float(a["hours"]) * 3600))
    if not a.get("end_date"):  # 単日登録（従来互換）
        ts(f"/tasks/{a['task_id']}/plans", "PUT",
           {"seconds": sec, "plan_date": a["date"] + "T00:00:00Z", "note": ""})
        return f"タスク #{a['task_id']} に {a['date']} {a['hours']}h の日別予定を登録しました（週プランナー/ガントに表示）"
    # 期間一括登録: date〜end_date の各日に hours/日（既定は土日スキップ）
    start = date.fromisoformat(a["date"])
    end = date.fromisoformat(a["end_date"])
    if end < start:
        raise Exception("end_date は date 以降にしてください")
    skip = a.get("skip_weekends", True)
    days, d = [], start
    while d <= end:
        if not (skip and d.weekday() >= 5):
            days.append(d)
        d += timedelta(days=1)
    if not days:
        raise Exception("登録対象日がありません（期間が全て土日です。skip_weekends=false を検討）")
    for d in days:
        ts(f"/tasks/{a['task_id']}/plans", "PUT",
           {"seconds": sec, "plan_date": d.isoformat() + "T00:00:00Z", "note": ""})
    total = round(sec * len(days) / 3600, 1)
    skip_s = "土日除く・" if skip else ""
    return (f"タスク #{a['task_id']} に {start.month}/{start.day}〜{end.month}/{end.day} の"
            f"{len(days)}日分（{skip_s}計{total:g}h）の日別予定を登録しました（週プランナー/ガントに表示）")


def t_move_task(a):
    """親（プロジェクト/タスクグループ）の付け替え。SPA の gRawSet("proj") と同一規約（#715）:
    subtask relation は**親側に**張る/消す（addRelation(parentId, id, "subtask") と同じ向き）。"""
    tid = int(a["task_id"])
    cur = ts(f"/tasks/{tid}")
    guard_human(cur)
    raw = a.get("new_parent_task_id")
    npid = int(raw) if raw else None  # 省略/null = 最上位化
    if npid == tid:
        raise Exception("自分自身を親にはできません")
    by_id = {t["id"]: t for t in all_tasks()}
    if npid is not None:
        if npid not in by_id:
            raise Exception(f"新しい親 #{npid} が見つかりません")
        if npid in _descendant_ids(tid, by_id):
            raise Exception(f"#{npid} は #{tid} の子孫のため親にできません（循環）")
    old = parent_task_of(cur)
    old_id = old.get("id") if old else None
    if old_id is None and npid is None:
        return f"タスク #{tid} は既に最上位です（変更なし）"
    if old_id is not None:  # 旧親から subtask relation を消す（親側から・SPAと同じ向き）
        try:
            ts(f"/tasks/{old_id}/relations/subtask/{tid}", "DELETE")
        except urllib.error.HTTPError as e:
            if e.code not in (400, 403, 404, 409):  # 既に外れている等は冪等に無視
                raise
    if npid is not None:  # 新親に subtask relation を張る（親側に）
        ts(f"/tasks/{npid}/relations", "PUT", {"other_task_id": tid, "relation_kind": "subtask"})
    old_title = ((by_id.get(old_id) or old or {}).get("title") or "") if old_id is not None else ""
    new_title = (by_id[npid].get("title") or "") if npid is not None else ""
    log_activity({"task_id": tid, "type": "field", "field": "parent",
                  "from": old_title, "to": new_title, "title": cur.get("title") or ""})
    if npid is not None:
        return f"タスク #{tid} を #{npid} 「{new_title}」配下へ移動しました"
    return f"タスク #{tid} を最上位化しました（親から外しました）"


def t_add_dependency(a):
    tid, bid = int(a["task_id"]), int(a["blocker_task_id"])
    if tid == bid:
        raise Exception("自己依存は張れません（task_id と blocker_task_id が同一）")
    # A が B に follows ＝ B の完了が A の前に必要。逆向き precedes はバックエンドが自動付与
    ts(f"/tasks/{tid}/relations", "PUT", {"other_task_id": bid, "relation_kind": "follows"})
    return f"依存関係を登録しました: #{tid} は #{bid} の完了待ち（ガント/依存グラフに線が出ます）"


def t_remove_dependency(a):
    tid, bid = int(a["task_id"]), int(a["blocker_task_id"])
    try:
        ts(f"/tasks/{tid}/relations/follows/{bid}", "DELETE")
    except urllib.error.HTTPError as e:
        if e.code not in (400, 403, 404, 409):  # 張られていない等は冪等に無視
            raise
    return f"依存関係を解除しました: #{tid} は #{bid} の完了待ちではなくなりました"


NUM = {"type": "number"}
STR = {"type": "string"}
BOOL = {"type": "boolean"}
ARR_STR = {"type": "array", "items": {"type": "string"}}
ARR_NUM = {"type": "array", "items": {"type": "number"}}
TOOLS = [
    ("get_task", "タスクの詳細（説明・進捗・サブタスク・直近メモ）を取得する",
     {"task_id": NUM}, ["task_id"], t_get_task),
    ("add_note", "下書きメモを記録する（作成者のみ閲覧のAIコメント・Markdown可）。全員閲覧の報告は post_comment を使う",
     {"task_id": NUM, "text": STR}, ["task_id", "text"], t_add_note),
    ("create_subtask", "タスクを分割してサブタスクを作る（担当は付けない＝人間が割り振る）",
     {"parent_task_id": NUM, "title": STR, "estimate_hours": NUM, "description": STR},
     ["parent_task_id", "title"], t_create_subtask),
    ("set_progress", "タスクの進捗率(0-99)を更新する。100にするのは complete_task（summary必須）を使う",
     {"task_id": NUM, "percent": NUM}, ["task_id", "percent"], t_set_progress),
    ("set_estimate", "タスクの見積り(時間)を更新する",
     {"task_id": NUM, "hours": NUM}, ["task_id", "hours"], t_set_estimate),
    ("complete_task", "タスクを完了にする（本当に完了したときだけ使う）。summary 必須（何をした・成果物の場所・検証状態）＝完了報告コメントを投稿してから完了化する",
     {"task_id": NUM, "summary": STR}, ["task_id", "summary"], t_complete_task),
    ("my_agenda", "AIが今やるべきタスク一覧（未完了で fable 担当 or ラベルAI/AI+人間）。連絡待ち＝人間待ちは末尾に分離表示。date は基準日(YYYY-MM-DD・省略=今日、期限超過判定に使う)",
     {"date": STR}, [], t_my_agenda),
    ("list_tasks", "全タスクから絞り込み一覧（テンプレートWSは除外）。label=ラベル名 / assignee=username / status=todo・doing・waiting・done・undone / query=タイトル部分一致 / due_before=YYYY-MM-DD(この日以前が期限)",
     {"label": STR, "assignee": STR, "status": STR, "query": STR, "due_before": STR}, [], t_list_tasks),
    ("post_comment", "本物のタスクコメントに投稿する。進捗報告・作業ログ・人間への申し送りに使う（全員閲覧・SPAのコメント欄に出る）",
     {"task_id": NUM, "text": STR}, ["task_id", "text"], t_post_comment),
    ("start_task", "タスクに着手宣言する（進行中化）。plan に着手時の作業計画テキストを渡すとコメントで共有される",
     {"task_id": NUM, "plan": STR}, ["task_id"], t_start_task),
    ("escalate", "人間の判断が必要になったら迷わず使う。reason=何に詰まったか、options=人間への選択肢提示。連絡待ち化して人間の一覧に『連絡待ち』として浮き上がる",
     {"task_id": NUM, "reason": STR, "options": STR}, ["task_id", "reason"], t_escalate),
    ("resume_task", "エスカレーション解除後の再開専用（連絡待ちのタスクにのみ使える）。連絡待ちを外して進行中に戻す。note があればコメント投稿。通常の着手は start_task",
     {"task_id": NUM, "note": STR}, ["task_id"], t_resume_task),
    ("create_task", "タスクを新規作成する。原則 parent_task_id で適切なプロジェクト/タスクグループ配下に作る（親無しの浮きタスクを作らない・無指定はインボックスWS＝一時置き場行き。付け替えは move_task）。タイトルは絵文字禁止・端的に。goal は説明末尾に[ゴール]として結合。labels は無ければ新規作成して付与。assignees は 森田(人間) / fable(作業AI) / taskstation-ai(TaskStation改善)。priority は 3=必須 / 2=推奨 / 1=後回し可。blocked_by=先行タスクid配列（依存関係を張る）",
     {"title": STR, "description": STR, "goal": STR, "estimate_hours": NUM, "due_date": STR,
      "priority": NUM, "labels": ARR_STR, "assignees": ARR_STR, "parent_task_id": NUM,
      "blocked_by": ARR_NUM},
     ["title"], t_create_task),
    ("schedule_task", "日別予定（task_time_plans）を登録する＝週プランナー/ガント/稼働プランに表示される。金3h/土3h/日3h のような日次計画に使う。end_date（YYYY-MM-DD）指定で date〜end_date の各日に hours/日 を一括登録（skip_weekends=true 既定＝土日を飛ばす）",
     {"task_id": NUM, "date": STR, "hours": NUM, "end_date": STR, "skip_weekends": BOOL},
     ["task_id", "date", "hours"], t_schedule_task),
    ("move_task", "タスクを別の親（プロジェクト/タスクグループ）配下へ移動する。new_parent_task_id 省略で最上位化（親から外す）。自分自身・自分の子孫への移動はエラー",
     {"task_id": NUM, "new_parent_task_id": NUM}, ["task_id"], t_move_task),
    ("add_dependency", "依存関係を張る（blocker が完了するまで task は着手不可の意味）。ガント/依存グラフにも自動で線が出る。依存は説明文に手書きせずこのツールで構造化する",
     {"task_id": NUM, "blocker_task_id": NUM}, ["task_id", "blocker_task_id"], t_add_dependency),
    ("remove_dependency", "依存関係を解除する（task が blocker の完了待ちでなくなる）。張られていない場合も冪等に成功する",
     {"task_id": NUM, "blocker_task_id": NUM}, ["task_id", "blocker_task_id"], t_remove_dependency),
    ("set_due", "タスクの期日を変更する（唯一の期日変更手段）。reason 必須＝事前に人間と相談・合意した内容を書く。無断変更は禁止。変更は履歴に記録され、タスクコメントにも旧→新と理由が投稿される",
     {"task_id": NUM, "date": STR, "reason": STR}, ["task_id", "date", "reason"], t_set_due),
]
TOOL_DEFS = [{"name": n, "description": d,
              "inputSchema": {"type": "object", "properties": p, "required": r}}
             for n, d, p, r, _ in TOOLS]
TOOL_FN = {n: f for n, d, p, r, f in TOOLS}

INSTRUCTIONS = (
    "TaskStation は人間(森田)とAI(fable)の協業タスクボード。"
    "分類ラベル: AI=AIが自走 / 人間=人間専用(触らない) / AI+人間=AIが下準備して人間に申し送り。"
    "作業ループ: (1) my_agenda で対象確認 → (2) start_task で着手宣言(計画コメント付き) → "
    "(3) 節目ごとに set_progress + post_comment で進捗を記録 → "
    "(4) 判断が必要になったら即 escalate(選択肢付き) → "
    "(5) 完了は complete_task に summary 必須(何をした・成果物の場所・検証状態)。"
    "進捗・報告はすべて post_comment(全員閲覧)へ。add_note は下書きメモ(作成者のみ閲覧)。"
    "期日の変更は set_due のみ・reason 必須(事前に相談か escalate で合意してから。無断変更は禁止)。"
    "タスク間の依存関係は add_dependency で構造化する(説明文への手書き禁止)。"
    "my_agenda の⛔ブロック中(先行タスク待ち)のタスクには着手しない。"
    "人間のタスク(分類=人間)は読み取り以外触らない。"
    "\n\n【構造規約（違反すると人間の画面が壊れる・厳守）】"
    "階層は「タスクの親子関係」だけで表現する3層モデル: "
    "プロジェクト=最上位の親タスク ＞ タスクグループ=中間の親タスク(任意) ＞ 作業=葉タスク"
    "（実体はすべてタスク・related_tasks.parenttask 鎖）。"
    "Vikunja のサブプロジェクトは階層に使わない(SPA が解釈しない)。ワークスペース(API project)はただの箱。"
    "粒度: 事業・取り組みの塊=プロジェクト / 機能・テーマの塊=タスクグループ / 実作業=タスク。"
    "機能単位を最上位に置かない。新規タスクは必ず適切なプロジェクト/グループ配下に作る"
    "(create_task の parent_task_id 指定。親無しの浮きタスクを作らない。付け替えは move_task)。"
    "タイトル規約: 絵文字を使わない・端的に(構造や経緯の説明をタイトルに詰めない)。"
    "重要度は priority フィールドで表現: 3=必須 / 2=推奨 / 1=後回し可。"
    "「ローンチ必須」ラベル=ローンチ判定ゲート対象の意味。"
    "担当者は3者: 森田=人間 / fable=作業AI(manademia 等の実作業) / taskstation-ai=TaskStation 自体の改善担当。"
    "\n\n【更新の安全】タスク更新 API は全置換仕様。更新は必ずこの MCP のツール経由で行う"
    "(内部で GET→merge→POST する safe_update を通り、未指定フィールドは既存値維持)。"
    "API への生 POST は未指定フィールドを消失させるため禁止。"
    "\n\n【運用ルール（ツールが強制）】ステータスは 未着手→進行中(start_task)→連絡待ち(escalate)→完了(complete_task) "
    "の4値でツール経由のみ遷移。完了は complete_task+summary 必須（set_progress 100 は不可）。"
    "resume_task は連絡待ち解除専用。分類「人間」のタスクはAIから変更不可。"
)


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
                    "serverInfo": {"name": "taskstation", "version": "2.0.0"},
                    "instructions": INSTRUCTIONS}
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
