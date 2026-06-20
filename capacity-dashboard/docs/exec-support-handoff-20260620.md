# 実行サポート 継続ハンドオフ 2026-06-20

> 「重要タスクを“遂行”するための機能」＝着手準備パネル＋実行可能性メーター＋キャパ保護。
> このファイルは続きをやる人（未来の自分含む）がコンテキスト無しで再開するための正本。
> 設計SoT: `docs/exec-support-spec.md`（フェーズ1）/ `docs/exec-loop-and-capacity-spec.md`（フェーズ2）。
> **並行スレッド（UI・体験改善: table中核リファクタ/モーダル共通化/ダーク/使い勝手）の継続ハンドオフ**: [../HANDOFF-2026-06-20.md](../HANDOFF-2026-06-20.md)。両スレッドは views編集hookのマーカー（`/tmp/cap-view-edit-allow`）を共用＝相手の委譲中は競合に注意。exec/prep系ファイルはこのスレッドの領域（UI側はcommitに含めない）。

## 0. 一言で
タスクの「着手の不確実性」を機械的に削る仕組み。**準備（フェーズ1）＝完成**。**キャパ保護＝第一弾＋F1完成**。
**実行ループ＝E1（今日やる1手の集約）まで完成・E2以降が次**。
正直な体感: 準備75 / 実行40 / 運用35。「計画を絶対に実現」には残りの実行ループ（E2〜E5）が要る。

## 1. 完了済み（コミット済み・全てブラウザE2E検証）
- **MVP**: exec `/prep/:taskId` ストア＋クライアント＋着手準備パネル＋taskform「実行準備」タブ（`3d8e1f8`,`7adfa14`）
- **波A 深さ**: 段取り並べ替え/見積/期日 ＋ 逆算スケジュール（容量capH・祝日・休暇・保護時間帯考慮）＋ 保護時間帯(`protected_windows`)土台（`99d2a45`）
- **波B 診断**: 「何が止めてる?」症状→手法を有効化＆ハイライト（`e8a8534`）
- **波D 磨き**: メーター演出（達成度の色/次の一手ヒント）・手法ON/OFF＆並べ替え・保護時間帯エディタ（`9c2d50a`）
- **バッチ`/prep`**: 全タスクのscore一括 `{scores}`（ホーム用、`1fdd3b6`）
- **波C 誘導**: ホームの「やること」各行に実行可能性バッジ→クリックで着手準備タブへ直行（`dcc4b23`）。taskform に `openTaskForm({tab:"prep"})` deep-link。
- **キャパ保護 第一弾**: バッファ`daily_buffer_pct`(F2)＋オーバーコミット早期警告バナー(F3)＋**逆算の今日床止め**（実バグ修正＝過去に作業を置いていた）（`47600e5`）
- **委譲hookのマーカー堅牢化**: 後述（`b42da45`）
- **波F-F1 横断逆算**（`9cd9bda`）: 逆算が「他タスクの当日予定(plans)＋保護枠＋バッファを引いた実空き」にのみ配置。
  `lib/capacity.js committedHoursByDayInRange`（純関数・テスト3件＝計32）＋ `exec-support.js backcast(committedByDay)`／
  `loadBackcastCtx(ctx, deadlineIso)`。ブラウザ実バンドルで committedByDay 有無の配置差（unplaced 0→2）を決定論検証。
- **波E-E1 今日やる1手**（`6c03a5a`）: prep段取りで `due==today` の未完了手順をホーム最上部に MIT バンドとして集約→
  クリックで `openTaskForm({tab:"prep"})`。`exec.py GET /prep` に `steps_by_task` 追加（要デプロイ＝反映済み）＋ `home.js`。
  capdemo でブラウザ目視（表示・将来期日除外・クリック→準備タブ）確認・console0。

## 2. アーキテクチャ（ファイルと責務）
- `app/views/exec-support.js`（**私=指示役は直接編集不可**・委譲のみ）: プラグイン・レジストリ `PLUGINS`（next_step/steps/schedule/if_then/prereqs/obstacles/dod）、`backcast()`（逆算・今日床止め・容量/祝日/休暇/保護枠/バッファ考慮）、メーター演出、診断、保護時間帯エディタ、F3警告バナー。`renderExecSupport(container,{taskId,task})` / `ensureStyle()` をexport。
- `app/views/taskform.js`（共有=指示役が編集可）: 編集時 `[基本][実行準備]` タブ、`openTaskForm({taskId,onSaved,tab})`（tab:"prep"で準備タブ自動オープン）。
- `app/views/home.js`（ユーザー領域・要事前一言＋re-read）: `getPrepScores()` で各行に準備バッジ＋誘導。
- `app/lib/exec.js`: `getPrep/savePrep/getPrepScores/getSettings/saveProtectedWindows`。
- `ops/taskstation-exec.py`（共有=指示役・**要デプロイ**）: `GET/POST /prep/:id`、`GET /prep`(=scores一括)、settings に `protected_windows`/`daily_buffer_pct`。
  - **デプロイ手順**: repo編集→`cp ops/taskstation-exec.py ~/.local/bin/taskstation-exec.py`→`systemctl --user restart taskstation-exec`→`is-active`確認。repo↔デプロイ先を必ず一致させる。
- データ: 着手準備= `~/.config/taskstation/prep.json`（`{taskId:{...,score}}`・全ログインユーザー読み書き）。保護枠/バッファ= `settings.json`（**書き込みは管理者=exec許可ユーザーのみ**・読みは全員）。

## 3. ★委譲hook（マーカー方式）— 守ること
`.claude/settings.json` の PreToolUse hook（`.claude/hooks/block-view-edits.py`）が、`capacity-dashboard/app/views/<name>.js` の編集を **マーカー `/tmp/cap-view-edit-allow` が在る時のみ許可**（taskform/recurrenceform/lib/app は対象外）。
- **委譲手順**: `touch /tmp/cap-view-edit-allow` → Agent委譲（子がviews編集）→ `rm -f /tmp/cap-view-edit-allow`。閉じ忘れ=fail-open注意。
- 旧 SubagentStart/Stop depthカウンタは発火不安定で撤去済み。SoT: `capacity-dashboard/CLAUDE.md`。

## 4. ★ブラウザE2Eの認証（重要・ハマりどころ）
ユーザーのセッションは切れていることが多い。私（指示役）はE2Eのため**fableサービスアカウントのトークンを注入**して検証している:
1. `~/.config/taskstation/fable.env` の TS_USER/TS_PASS で `POST http://leo:7005/api/v1/login` → token（パスワードは出力しない）。
2. ブラウザの **sessionStorage `taskstation_token`** に注入 → `location.reload()`。
- **ESMはフルリロードで反映**（モジュール変更後は必ず `location.reload()`。動的importはキャッシュされる）。
- fableは**exec許可ユーザーでない**ので `/me` が401（コンソールに出るが**無害**）＋**settings(protected_windows/buffer)の保存は不可**（管理者のみ）。実ユーザー(capdemo/森田)なら可。
- 検証は**読み取り中心＋可逆操作**に限定（過去にfableで実データを壊した事故あり→[[feedback-tool-output-fabrication-and-verify]]系の教訓）。触ったprepは毎回 `savePrep(id,{})` で片付ける。

## 5. 次にやる（フェーズ2の残り・優先順）
※ E1（今日やる1手）と F1（横断逆算）は 2026-06-20 完了（§1）。次の推奨初手＝E3／MIT手順のチェック可能化。
- **波E 実行ループ（本丸・残り）**:
  - ~~E1 今日の手順 自動抽出~~ → 完了（`6c03a5a`）。現状の MIT バンドは手順を**表示するだけ**＝チェック不可。
    **次の自然な一手**＝段取り手順に `done` を足し、MIT バンド＋steps プラグインでチェック可能に（E4 の土台にもなる）。
  - E2 着手日・トリガー通知（`lib/notify.js` 連携・手順の due==today や if-then 時刻で発火）… 指示役管轄寄り
  - E3 今すぐ着手→ステータス進行中＋ポモ開始（`pomodoro.js` 連携）。現状 exec-support フッターの「今すぐ着手」は
    トースト表示のみの no-op＝ここを updateTask(status=進行中)＋ポモ開始に繋ぐ… 指示役管轄寄り
  - E4 未実行検知→自動再逆算 / E5 報告・アカウンタビリティ（report/status・上司対策C=要bot/webhook）
- **波F キャパ保護 残り**: ~~F1 横断逆算~~ 完了（`9cd9bda`）/ F4 キャパ予算可視化 / F5 割り込みゼロサム / F6 ディープワーク枠。
  ※ F1 は他タスクの **plans** を引く（prep の段取り手順の due は未考慮＝将来 materialize 時に拡張余地）。
- **保留**: 一覧(table.js)の列メーター（ユーザーの次タスク B21/B22 と被るので後）。保護時間帯エディタの**保存E2E**（管理者ログインが要る・ユーザー側で確認）。

## 6. 運用・協調メモ
- **ユーザーは並行で Workflow による全画面改善スイープを走らせている**。ホット編集中ファイル（直近: calendar/gantt/kanban/monthcal/quad、次タスク table.js B21/B22）には触らない。**view編集前に必ず `git status` で衝突確認＋re-read**。
- 指示1=1コミット・検証通過後にpush・状態変更は実体検証（reflog/HEAD/origin一致/ls）。
- 関連: `docs/exec-support-spec.md` / `docs/exec-loop-and-capacity-spec.md`。
