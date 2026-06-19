#!/usr/bin/env python3
"""PreToolUse hook: capacity-dashboard の views/*.js を指示役（メイン）が直接編集するのを禁止し、
サブエージェントへの委譲を強制する。

判定方針（経験的に検証して確定する）:
- file_path が capacity-dashboard/app/views/<name>.js のときだけ対象。
- メインエージェントの編集は deny。サブエージェントの委譲編集は許可。
  サブエージェント判別が確立するまでは PROBE ログに stdin を記録して観察する。
"""
import sys, json, re, os

raw = sys.stdin.read()

try:
    data = json.loads(raw or "{}")
except Exception:
    sys.exit(0)

fp = ((data.get("tool_input") or {}).get("file_path")) or ""
m = re.search(r"capacity-dashboard/app/views/([^/]+\.js)$", fp)
if not m:
    sys.exit(0)  # views/*.js 以外＝対象外＝許可

# views/ 配下だが契約上「共有ファイル＝指示役が中央で直接編集」するものは除外（ブロックしない）。
SHARED_IN_VIEWS = {"taskform.js", "recurrenceform.js"}
if m.group(1) in SHARED_IN_VIEWS:
    sys.exit(0)  # 共有ファイル＝許可

# サブエージェント稼働中（depth>0）なら委譲先の実装編集とみなして許可。
# depth は SubagentStart で +1 / SubagentStop で -1（subagent-depth.py）。
# メインエージェントの直接編集時は depth==0 のはず＝deny される。
def _depth():
    try:
        with open("/tmp/cap-subagent-depth") as f:
            return int((f.read() or "0").strip() or "0")
    except Exception:
        return 0
if _depth() > 0:
    sys.exit(0)  # 委譲中＝許可

reason = (
    "capacity-dashboard の views/*.js は指示役（メイン）が直接編集しない規約です。"
    "Agent ツールに実装スペックを渡してサブエージェントに実装させ、あなたは設計・統合・"
    "検証・コミットに専念してください（capacity-dashboard/CLAUDE.md / orchestration-contract）。"
)
out = {
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }
}
print(json.dumps(out, ensure_ascii=False))
sys.exit(0)
