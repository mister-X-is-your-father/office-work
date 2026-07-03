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


if __name__ == "__main__":
    unittest.main()
