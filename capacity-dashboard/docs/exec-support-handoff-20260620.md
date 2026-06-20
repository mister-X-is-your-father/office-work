# 実行サポート 継続ハンドオフ 2026-06-20

> 「重要タスクを“遂行”するための機能」＝着手準備パネル＋実行可能性メーター＋キャパ保護。
> このファイルは続きをやる人（未来の自分含む）がコンテキスト無しで再開するための正本。
> 設計SoT: `docs/exec-support-spec.md`（フェーズ1）/ `docs/exec-loop-and-capacity-spec.md`（フェーズ2）。
> **並行スレッド（UI・体験改善: table中核リファクタ/モーダル共通化/ダーク/使い勝手）の継続ハンドオフ**: [../HANDOFF-2026-06-20.md](../HANDOFF-2026-06-20.md)。両スレッドは views編集hookのマーカー（`/tmp/cap-view-edit-allow`）を共用＝相手の委譲中は競合に注意。exec/prep系ファイルはこのスレッドの領域（UI側はcommitに含めない）。

## 0. 一言で
タスクの「着手の不確実性」を機械的に削る仕組み。**準備（フェーズ1）＝完成**。**キャパ保護＝第一弾＋F1完成**。
**実行ループ（波E）＝完成**: E1今日やる1手→E2朝の通知→E3今すぐ着手(進行中＋ポモ)→手順done消し込み→E4検知(遅れ督促)→E4再逆算(残りを今日から組み直し)→E5報告(report/statusに今日やる1手・進行中を反映)。
正直な体感: 準備75 / 実行80 / 運用75。キャパ保護＝第一弾＋F1＋F4(今週予算)＋F5(割り込みゼロサム)完成。残り＝**F6 ディープワーク枠(要設計判断)**のみ。Slack無人送信は不要指示。

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
- **波E-E3 今すぐ着手**（`1d34fe2`）: 着手準備フッターの「今すぐ着手」(#es-go) を実アクションに配線＝
  `api.setTaskStarted`（started_at セット＝進行中・冪等／非破壊#9）＋ `pomodoro.startFocusFor`（集中セッション開始・
  module-level `_ctl` 経由でカード表示）。exec-support は pomodoro を動的 import。
- **波E 手順done化＋MIT操作化**（`e8086cb`）: 段取り手順に `done` を追加＝準備タブ(steps プラグイン)とホーム両方からチェックで
  消し込み（取り消し線・MITからは消える）。`/prep` の steps_by_task に `idx` 追加（done 書き戻しの正確な狙い撃ち）。
  MIT 行を div 化し3アクション＝①チェック消し込み②テキスト→準備タブ③▶着手(setTaskStarted＋startFocusFor)。score は不変。
- **波E-E2 朝の手順通知**（`93d195f`）: `notify.js notifyEvents` に4つ目の通知源＝「今日が期日の段取り手順」を追加し
  営業開始(calStart)にまとめて発火（担当に me を含む未完了タスク・未完了手順）。tick は exec.js を**動的 import**して
  getPrepScores().steps_by_task を渡す（静的依存を純粋に保ち node テスト維持）。既存リマインダー設定(on/lead)に相乗り。テスト+2。
- **波E-E4 検知（督促）**（`e4ebb6e`）: MIT 抽出を due<=today に広げ、期日超過手順を赤「遅れN日」バッジ＋赤枠で先頭表示。
  step-done のおかげで「未完了かつ期日超過」を未実行として検知。home.js のみ。capdemo でブラウザ目視・console0。
- **波E-E4 再逆算**（`1a9ef73`）: 逆算スケジュールが完了済み(done)手順を再配置しない不具合を修正＝未完了手順だけを
  締切から今日以降に再配置（done の期日は保持）。backcast は今日床止め済みなので「逆算ボタン＝残りを今日から組み直す」に。
  schedule プラグインの click ハンドラのみ（!done 抽出＋元 index 戻し）。実ハンドラで done不動・未完了のみ再配置を確認・console0。
- **波E-E5 報告反映**（`030fef6`）: report/status に「今日やる1手（準備済み）」＝prep の due<=today 未完了手順を反映。
  report.js＝報告文「■ 今日やる1手（準備済み）」＋素データ「🎯…」＋サマリチップ（buildText/buildReport に todaySteps 引数・後方互換）。
  status.js＝「今日やる手順（着手準備）」カード（チーム横断・遅れ先頭・担当アバター）＋「進行中」KPI。capdemo でブラウザ目視・console0。
- **波F-F4 キャパ予算**（`e28e451`）: ホームに「今週のキャパ予算」バンド＝自分の今週（今日〜週末）容量合計 − 既コミット負荷 = 残高ゲージ。
  状態3段（ok=緑/tight=残りわずか<=15%琥珀/over=超過赤＋左ボーダー）。`capacityFor`合計＋`weekLoadByMember.weekH`。capSum=0は非表示。
  ※検品で状態色クラス不一致(cb-状態 vs CSS)を発見し修正済み。実lib計算＋計算スタイルで色を検証・console0。
- **波F-F5 割り込みゼロサム**（`5a8ff93`）: taskform で期限を主担当の満杯日(loadByMember>=capH)／非稼働日(capacityOn=0)に
  設定したら期限欄下に警告（別日にするか何かを外す）。#tf-due blur ＋ #tf-asg change で checkDueCapacity。capacity/recurrence を
  import。taskform は共有＝指示役直接編集(hook対象外)。3ブランチ(非稼働日/満杯/空き)を実フォームで検証・console0。
  ※E2E教訓: store を `?t=` でcache-bustすると taskform が使うクリーン store と別インスタンスになり反映されない＝検証時はクリーンimportで load(true)。

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
※ 2026-06-20 完了: F1 横断逆算 / E1 今日やる1手 / 手順done化＋MIT操作化 / E2 朝の手順通知 / E3 今すぐ着手 / E4検知（督促）（§1）。
- **波E 実行ループ → 完成**（E1/E2/E3/手順done/E4検知/E4再逆算/E5報告）。
  - 残り任意の磨き: 再逆算の**自動発火**（現状は手動の逆算ボタン＝安全）／MIT に「遅れを今日から組み直す」ワンポチ導線。
- **波F キャパ保護 残り**:
  - ~~F4 キャパ予算可視化~~ → 完了（`e28e451`・home の今週予算バンド）。
  - ~~F5 割り込みゼロサム~~ → 完了（`5a8ff93`・taskform の期限満杯/非稼働日警告）。
  - **F6 ディープワーク枠（要設計判断・波Fの最後）**: 最重要タスク専用の確保枠（保護枠の逆）。保護時間帯は backcast が「避ける」枠だが、
    deep枠は「重要タスクが使う／他が侵せない」＝per-task のセマンティクスが要る。モデル選択(protected_windows に kind:'deep' を足し、
    重要タスクの逆算だけ deep枠を実空きに含める 等)を**ユーザーと相談してから**。C12 と同じく判断保留扱い。
  ※ F1 は他タスクの **plans** を引く（prep の段取り手順の due は未考慮＝将来 materialize 時に拡張余地）。
- **判断保留（要ユーザー入力）**: C12 定期一時停止のモデル選択 / C5・C6 視覚リデザイン（light変更＝目視パリティ承認前提）。
- **判断保留（要ユーザー入力）**: C12 定期一時停止のモデル選択 / C5・C6 視覚リデザイン（light変更＝目視パリティ承認前提）。
- **保留**: 一覧(table.js)の列メーター（ユーザーの次タスク B21/B22 と被るので後）。保護時間帯エディタの**保存E2E**（管理者ログインが要る・ユーザー側で確認）。

## 6. 運用・協調メモ
- **ユーザーは並行で Workflow による全画面改善スイープを走らせている**。ホット編集中ファイル（直近: calendar/gantt/kanban/monthcal/quad、次タスク table.js B21/B22）には触らない。**view編集前に必ず `git status` で衝突確認＋re-read**。
- 指示1=1コミット・検証通過後にpush・状態変更は実体検証（reflog/HEAD/origin一致/ls）。
- 関連: `docs/exec-support-spec.md` / `docs/exec-loop-and-capacity-spec.md`。
