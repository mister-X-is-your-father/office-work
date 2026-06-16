# ops — TaskStation 運用スクリプト（leo 配備物のマスター）

配備先（leo）:

| ファイル | 配備先 | 役割 |
|---|---|---|
| `taskstation-spa-serve.py` | `~/.local/bin/` | SPA配信（7010・ThreadingHTTPServer・no-store） |
| `taskstation-exec.py` | `~/.local/bin/` | Fable実行サービス（7020・直列キュー/スクリプト/SSE） |
| `taskstation-mcp.py` | `~/.local/bin/` | TaskStation MCP（stdio・Fable自律操作: コメント/分割/進捗） |
| `taskstation-fable-runner.py` | `~/.local/bin/` | 15分巡回の自動提案（タイマー起動） |
| `taskstation-backup.sh` | `~/.local/bin/` | 日次バックアップ（毎日00:00・公式dumpで db+files+env を `~/backups/taskstation/vikunja-YYYYMMDD.zip`・前日ラベル・30日保持） |
| `systemd/*` | `~/.config/systemd/user/` | 上記のユニット（spa/exec=常駐、fable/backup=timer） |

設定（リポジトリ非収録・leo の `~/.config/taskstation/`）:
- `fable.env` — fableアカウント資格情報（chmod 600）
- `exec.json` — `{"allowed_user_ids":[...]}` Fable機能の許可ユーザー（隠し要素の境界）
- `mcp.json` — claude -p に渡す MCP 構成
- `scripts/` — ▶ワンポチ起動できるスクリプト置き場（*.sh / *.py、`TS_TASK_ID` が渡る）

更新手順: ここを編集 → 配備先へ cp → `systemctl --user daemon-reload && systemctl --user restart <unit>`。
