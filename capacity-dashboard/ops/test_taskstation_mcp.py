#!/usr/bin/env python3
"""taskstation-mcp.py の回帰テスト（#689 部分更新セマンティクス＋ #693 ガード）。

ネットワーク不要（ts/log_activity をモンキーパッチ）。実行:
    cd ops && python3 -m unittest test_taskstation_mcp -v
ファイル名にハイフンがあるため importlib で読み込む。import 時の副作用なし
（ログインは遅延＝ _tokens が空のまま、env ファイルも読まれない）。
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # taskstation_notes の import 解決用


def _load_mcp():
    spec = importlib.util.spec_from_file_location(
        "taskstation_mcp", os.path.join(HERE, "taskstation-mcp.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mcp = _load_mcp()


def make_cur(**over):
    """TASK_SCALARS を全部持つ現在値タスク（#689 の再現フィクスチャ）。"""
    cur = {"id": 1, "title": "A", "description": "D", "done": False,
           "due_date": "0001-01-01T00:00:00Z", "start_date": "0001-01-01T00:00:00Z",
           "end_date": "0001-01-01T00:00:00Z", "priority": 1, "percent_done": 10,
           "repeat_after": 0, "repeat_mode": 0, "hex_color": "",
           "time_estimate": 3600, "is_favorite": False,
           "started_at": "0001-01-01T00:00:00Z", "labels": [], "assignees": []}
    cur.update(over)
    return cur


class FakeTs:
    """GET は固定の現在値を返し、POST を記録する ts の代役。"""

    def __init__(self, cur):
        self.cur = cur
        self.posts = []

    def __call__(self, path, method="GET", body=None):
        if method == "GET":
            return dict(self.cur)
        if method == "POST":
            self.posts.append((path, body))
            return dict(body)
        return None


class SafeUpdatePartialSemantics(unittest.TestCase):
    """#689: safe_update は「未指定フィールド=既存値維持」の部分更新であること。"""

    def setUp(self):
        self._ts, self._log = mcp.ts, mcp.log_activity
        mcp.log_activity = lambda entry: None  # 活動ログ送信を遮断

    def tearDown(self):
        mcp.ts, mcp.log_activity = self._ts, self._log

    def test_patch_priority_keeps_description_and_estimate(self):
        fake = FakeTs(make_cur())
        mcp.ts = fake
        mcp.safe_update(1, {"priority": 3})
        self.assertEqual(len(fake.posts), 1)
        path, body = fake.posts[0]
        self.assertEqual(path, "/tasks/1")
        self.assertEqual(body["priority"], 3)          # patch は反映
        self.assertEqual(body["description"], "D")     # 未指定は既存値のまま（消えない）
        self.assertEqual(body["time_estimate"], 3600)  # 未指定は既存値のまま（消えない）
        self.assertEqual(body["title"], "A")
        self.assertEqual(body["percent_done"], 10)

    def test_all_scalars_are_sent(self):
        """全置換仕様対策: TASK_SCALARS の全フィールドが body に含まれること。"""
        fake = FakeTs(make_cur())
        mcp.ts = fake
        mcp.safe_update(1, {"priority": 3})
        _, body = fake.posts[0]
        for k in mcp.TASK_SCALARS:
            self.assertIn(k, body)


class GuardRegression(unittest.TestCase):
    """#693 ガードの回帰（API 到達前に拒否されるためモック不要）。"""

    def test_set_progress_100_rejected(self):
        with self.assertRaisesRegex(Exception, "complete_task"):
            mcp.t_set_progress({"task_id": 1, "percent": 100})
        with self.assertRaisesRegex(Exception, "complete_task"):
            mcp.t_set_progress({"task_id": 1, "percent": 150})

    def test_complete_task_requires_summary(self):
        with self.assertRaisesRegex(Exception, "summary"):
            mcp.t_complete_task({"task_id": 1})
        with self.assertRaisesRegex(Exception, "summary"):
            mcp.t_complete_task({"task_id": 1, "summary": "   "})


class RenameAndDescription(unittest.TestCase):
    """#791: rename_task / set_description が safe_update 経路（部分更新）で正しく patch すること＋
    タイトル規約の機械ガード（絵文字・空の拒否）。"""

    def setUp(self):
        self._ts, self._log, self._comment = mcp.ts, mcp.log_activity, mcp.comment
        mcp.log_activity = lambda entry: None
        self.comments = []
        mcp.comment = lambda tid, text: self.comments.append((tid, text))

    def tearDown(self):
        mcp.ts, mcp.log_activity, mcp.comment = self._ts, self._log, self._comment

    def test_check_title_rejects_emoji_and_empty(self):
        with self.assertRaisesRegex(Exception, "絵文字"):
            mcp.check_title("🚀 リリース準備")
        with self.assertRaisesRegex(Exception, "絵文字"):
            mcp.check_title("完了 ✅")
        with self.assertRaisesRegex(Exception, "空"):
            mcp.check_title("   ")
        # 矢印・記号など既存タイトルで使う文字は許容
        self.assertEqual(mcp.check_title("審査 → 納付 ▾ (B2)"), "審査 → 納付 ▾ (B2)")

    def test_rename_patches_title_and_keeps_others(self):
        fake = FakeTs(make_cur())
        mcp.ts = fake
        out = mcp.t_rename_task({"task_id": 1, "new_title": "B"})
        _, body = fake.posts[0]
        self.assertEqual(body["title"], "B")
        self.assertEqual(body["description"], "D")     # 未指定は既存値のまま（消えない）
        self.assertEqual(body["time_estimate"], 3600)
        self.assertEqual(len(self.comments), 1)        # 改名はコメントに記録される
        self.assertIn("「A」→「B」", self.comments[0][1])
        self.assertIn("改名しました", out)

    def test_rename_same_title_is_noop(self):
        fake = FakeTs(make_cur())
        mcp.ts = fake
        out = mcp.t_rename_task({"task_id": 1, "new_title": "A"})
        self.assertEqual(fake.posts, [])               # POST しない
        self.assertEqual(self.comments, [])
        self.assertIn("変更なし", out)

    def test_rename_rejects_emoji_before_api(self):
        fake = FakeTs(make_cur())
        mcp.ts = fake
        with self.assertRaisesRegex(Exception, "絵文字"):
            mcp.t_rename_task({"task_id": 1, "new_title": "🔥 A"})
        self.assertEqual(fake.posts, [])

    def test_set_description_patches_description_only(self):
        fake = FakeTs(make_cur())
        mcp.ts = fake
        out = mcp.t_set_description({"task_id": 1, "description": "新しい説明"})
        _, body = fake.posts[0]
        self.assertEqual(body["description"], "新しい説明")
        self.assertEqual(body["title"], "A")            # 未指定は既存値のまま
        self.assertIn("更新しました", out)

    def test_set_description_requires_description(self):
        with self.assertRaisesRegex(Exception, "description"):
            mcp.t_set_description({"task_id": 1})

    def test_create_task_rejects_emoji_title(self):
        with self.assertRaisesRegex(Exception, "絵文字"):
            mcp.t_create_task({"title": "🎉 新機能"})


class RecordingTs:
    """GET は固定タスクを返し、全メソッドの呼び出しを記録する ts の代役（#793 用）。"""

    def __init__(self, cur):
        self.cur = cur
        self.calls = []

    def __call__(self, path, method="GET", body=None):
        self.calls.append((method, path, body))
        if method == "GET":
            return dict(self.cur)
        return {}


class AssigneesAndClass(unittest.TestCase):
    """#793: set_assignees の差分適用と set_class のガード。"""

    def setUp(self):
        self._ts, self._log, self._comment = mcp.ts, mcp.log_activity, mcp.comment
        self._add, self._rm = mcp.add_label, mcp.remove_label
        mcp.log_activity = lambda entry: None
        self.comments, self.added, self.removed = [], [], []
        mcp.comment = lambda tid, text: self.comments.append(text)
        mcp.add_label = lambda tid, title, create=False: self.added.append(title)
        mcp.remove_label = lambda tid, title: self.removed.append(title)

    def tearDown(self):
        mcp.ts, mcp.log_activity, mcp.comment = self._ts, self._log, self._comment
        mcp.add_label, mcp.remove_label = self._add, self._rm

    def test_set_assignees_diff_apply(self):
        """森田(7)のみ → fable(8)＋taskstation-ai(14): 7 を DELETE・8/14 を PUT。"""
        fake = RecordingTs(make_cur(assignees=[{"id": 7, "username": "森田"}]))
        mcp.ts = fake
        out = mcp.t_set_assignees({"task_id": 1, "assignees": ["fable", "taskstation-ai"]})
        puts = [(m, p) for m, p, b in fake.calls if m == "PUT"]
        dels = [(m, p) for m, p, b in fake.calls if m == "DELETE"]
        self.assertEqual(len(puts), 2)
        self.assertIn(("DELETE", "/tasks/1/assignees/7"), dels)
        self.assertEqual(len(self.comments), 1)   # 変更はコメント記録
        self.assertIn("担当を変更しました", out)

    def test_set_assignees_noop_and_unknown(self):
        fake = RecordingTs(make_cur(assignees=[{"id": 7, "username": "森田"}]))
        mcp.ts = fake
        out = mcp.t_set_assignees({"task_id": 1, "assignees": ["森田"]})
        self.assertIn("変更なし", out)
        self.assertEqual(self.comments, [])
        with self.assertRaisesRegex(Exception, "不明な担当"):
            mcp.t_set_assignees({"task_id": 1, "assignees": ["capdemo"]})
        with self.assertRaisesRegex(Exception, "assignees は必須"):
            mcp.t_set_assignees({"task_id": 1})

    def test_set_class_replaces_class_label(self):
        fake = RecordingTs(make_cur(labels=[{"title": "AI"}]))
        mcp.ts = fake
        out = mcp.t_set_class({"task_id": 1, "class": "AI+人間"})
        self.assertIn("AI", self.removed)          # 旧分類を除去
        self.assertIn("AI+人間", self.added)       # 新分類を付与
        self.assertIn("分類を AI → AI+人間 に変更", out)
        self.assertEqual(len(self.comments), 1)

    def test_set_class_guards(self):
        fake = RecordingTs(make_cur(labels=[{"title": "人間"}]))
        mcp.ts = fake
        with self.assertRaisesRegex(Exception, "人間"):   # 分類「人間」は変更不可（引き剥がし禁止）
            mcp.t_set_class({"task_id": 1, "class": "AI"})
        with self.assertRaisesRegex(Exception, "不明な分類"):
            mcp.t_set_class({"task_id": 1, "class": "ロボ"})
        with self.assertRaisesRegex(Exception, "escalate"):
            mcp.t_set_class({"task_id": 1, "add_labels": ["連絡待ち"]})
        with self.assertRaisesRegex(Exception, "class 引数"):
            mcp.t_set_class({"task_id": 1, "remove_labels": ["AI"]})
        with self.assertRaisesRegex(Exception, "いずれか"):
            mcp.t_set_class({"task_id": 1})

    def test_set_class_hand_over_to_human_allowed(self):
        """AI+人間 → 人間（引き渡し方向）は許可される。"""
        fake = RecordingTs(make_cur(labels=[{"title": "AI+人間"}]))
        mcp.ts = fake
        out = mcp.t_set_class({"task_id": 1, "class": "人間"})
        self.assertIn("分類を AI+人間 → 人間 に変更", out)


class PriorityAndDates(unittest.TestCase):
    """#794: set_priority のクランプと set_dates の検証・クリア・整合ガード。"""

    def setUp(self):
        self._ts, self._log = mcp.ts, mcp.log_activity
        mcp.log_activity = lambda entry: None

    def tearDown(self):
        mcp.ts, mcp.log_activity = self._ts, self._log

    def test_set_priority_patches_and_clamps(self):
        fake = FakeTs(make_cur(priority=1))
        mcp.ts = fake
        out = mcp.t_set_priority({"task_id": 1, "priority": 9})   # 9 → 4 にクランプ
        _, body = fake.posts[0]
        self.assertEqual(body["priority"], 4)
        self.assertEqual(body["description"], "D")                # 未指定は既存値のまま
        self.assertIn("低(1) → MUST(4)", out)

    def test_set_priority_noop_and_required(self):
        fake = FakeTs(make_cur(priority=3))
        mcp.ts = fake
        out = mcp.t_set_priority({"task_id": 1, "priority": 3})
        self.assertEqual(fake.posts, [])
        self.assertIn("変更なし", out)
        with self.assertRaisesRegex(Exception, "必須"):
            mcp.t_set_priority({"task_id": 1})

    def test_set_dates_partial_update_and_clear(self):
        fake = FakeTs(make_cur(start_date="2026-07-01T00:00:00Z", end_date="2026-07-10T00:00:00Z"))
        mcp.ts = fake
        out = mcp.t_set_dates({"task_id": 1, "start_date": "2026-07-03"})  # start のみ更新
        _, body = fake.posts[0]
        self.assertEqual(body["start_date"], "2026-07-03T00:00:00Z")
        self.assertEqual(body["end_date"], "2026-07-10T00:00:00Z")        # end は既存値維持
        self.assertIn("開始 2026-07-03 / 終了 2026-07-10", out)
        out2 = mcp.t_set_dates({"task_id": 1, "end_date": ""})            # 空文字=クリア
        _, body2 = fake.posts[1]
        self.assertEqual(body2["end_date"], mcp.UNSET)
        self.assertIn("終了 なし", out2)

    def test_set_dates_guards(self):
        fake = FakeTs(make_cur(start_date="0001-01-01T00:00:00Z", end_date="2026-07-05T00:00:00Z"))
        mcp.ts = fake
        with self.assertRaisesRegex(Exception, "少なくとも一方"):
            mcp.t_set_dates({"task_id": 1})
        with self.assertRaisesRegex(Exception, "YYYY-MM-DD"):
            mcp.t_set_dates({"task_id": 1, "start_date": "7月3日"})
        with self.assertRaisesRegex(Exception, "より後"):                 # 既存 end(7/5) より後の start は拒否
            mcp.t_set_dates({"task_id": 1, "start_date": "2026-07-06"})
        self.assertEqual(fake.posts, [])                                  # いずれも API 到達前に拒否


if __name__ == "__main__":
    unittest.main()
