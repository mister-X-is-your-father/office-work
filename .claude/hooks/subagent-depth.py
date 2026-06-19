#!/usr/bin/env python3
"""SubagentStart/SubagentStop hook: 稼働中サブエージェント数（depth）をカウントする。
depth>0 の間だけ views/*.js の編集を許可する（=委譲中だけ窓が開く）。
使い方: subagent-depth.py inc  (SubagentStart) / subagent-depth.py dec (SubagentStop)
"""
import sys, os

PATH = "/tmp/cap-subagent-depth"

def read():
    try:
        with open(PATH) as f:
            return int((f.read() or "0").strip() or "0")
    except Exception:
        return 0

def write(n):
    try:
        with open(PATH, "w") as f:
            f.write(str(max(0, n)))
    except Exception:
        pass

# stdin は使わないが、フックは渡してくるので読み捨てる
try:
    sys.stdin.read()
except Exception:
    pass

op = sys.argv[1] if len(sys.argv) > 1 else ""
n = read()
if op == "inc":
    write(n + 1)
elif op == "dec":
    write(n - 1)
sys.exit(0)
