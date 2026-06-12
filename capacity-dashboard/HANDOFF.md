# ハンドオフ — Capacity Board

> status: **稼働中**（2026-06-10）。モック72案 → TaskStationフォークで時間管理をDB実装（本番） → 実データSPA（中核＋予実ガント） → **基盤固め完了**（#1-#4,#7,#9）→ **定期/会議＋祝日＋休暇→月次空き完了**（ADR-011）→ **UI全面TaskStationブランド化**（新ロゴ/favicon）→ **本日の稼働予定(円時計)＋リスケ＋レビュー依頼/キュー**（ADR-012 種別2軸）→ **切り口別ビュー群**（一覧/残容量/週日別/アウトライン/依存グラフ）→ **時刻カレンダー**（ADR-013 `start_minute`・ドラッグ配置）→ **種別タブ＋定期入力UI**（タスク/MTG/定例MTG/定期タスク・**持ち回り=recurrences.rotation**）→ **繰り返しUI再設計＋この回だけ変更**（Googleカレンダー型「N単位ごと」・**例外=recurrences.overrides**）。本番イメージ **`leo-taskstation:0.24.6-fix9`**。
> 次の人がコンテキスト無しで読む前提。まず本書 → 要件 [`docs/06-requirements.md`](docs/06-requirements.md) → ADR [`docs/01-decisions.md`](docs/01-decisions.md)（**ADR-006〜013 が現行設計**。012=種別kind×時間属性flagsの2軸／013=plan.start_minuteで時刻配置）→ `docs/00,05`。
> **確定（2026-06-10）**: 容量は当面 **全員 8h/平日 固定で十分**（時刻帯の空き・半日休暇・人別可変キャパ＝時短 は保留。詳細は §8）。

## 0. これは何 / なぜ
少人数チーム(2〜4名)向け **「今日/週/月の空き容量さがし」＋「予定×実績」キャパ可視化**。狙いは **Instagantt の Workload 相当を OSS・自前ホスト（データ主権）** で。タスクの箱は **TaskStation**。素では「時間」概念ゼロ → **TaskStation を fork して時間管理・定期・祝日・休暇を DB ネイティブに足した**（ここが土台）。背景は [`docs/00`](docs/00-design-philosophy.md)、判断は [`docs/01`](docs/01-decisions.md)。

## 1. どこで動いてる / 見る
| 物 | 場所 |
|---|---|
| **実データSPA** | http://leo:7010/app/ （capdemo / CapDemoPass123） |
| モックギャラリー(72案) | http://leo:7010/ ／ Pages: https://mister-x-is-your-father.github.io/office-work/capacity-dashboard/ |
| **TaskStation（フォーク本番）** | http://leo:7005 （image **`leo-taskstation:0.24.6-fix9`**） |
| GitHub | https://github.com/mister-x-is-your-father/office-work → `capacity-dashboard/` |

配信は systemd user service **`taskstation-spa.service`**（`~/.local/bin/taskstation-spa-serve.py` を実行。ThreadingHTTPServer・no-storeヘッダ付きで `capacity-dashboard/` を 7010 で配信。enable済み＝ブート自動起動・落ちたら自動再起動）。状態確認は `systemctl --user status taskstation-spa`。AI副担当の実行系は `systemctl --user list-timers taskstation-fable.timer`／`systemctl --user status taskstation-exec`（▶実行・port7020）／ログは `journalctl --user -u taskstation-fable` / `-u taskstation-exec`。

## 2. ディレクトリ
```
office-work/capacity-dashboard/
├── index.html / mocks/                  # モック72案
├── app/                                 # 実データSPA（Vanilla ESM・ビルド不要）
│   ├── index.html  app.js               # シェル＋ハッシュルータ＋ログイン（ROUTES）
│   ├── lib/ api.js(旧vikunja.js) capacity.js recurrence.js store.js ui.js
│   │        kinds.js(種別/色/模様の単一定義・ADR-012) today_items.js(本日WorkItem整形)
│   ├── lib/vendor/rrule.mjs             # rrule.js を自己完結ESMにベンダリング（#ADR-011）
│   ├── lib/*.test.mjs                    # node --test 計40件(capacity/recurrence/today_items)
│   └── views/ home today(円時計/積み上げ) triage review availability calendar week planner
│              freefinder weekstack estactual gantt list(table) outline depgraph .js
├── docs/ 00..06（06=要件・進捗の正本）
└── backend-patch/                       # ★フォーク差分の再現一式＋apply.md＋seed-*.py
/home/neo/vikunja-fork/vikunja/          # ← TaskStation v0.24.6 clone＋パッチ適用済（ビルド元）
/home/neo/pm-trials/vikunja/docker-compose.yml  # ← 本番compose(image=leo-taskstation:...fix9)
```

## 3. アーキテクチャ（3層）＝ 昇格モデル S1孵化(fork)→S2検証(隔離)→S3製品(SPA)（[ADR-007](docs/01-decisions.md)）
**1. データ（TaskStationフォーク）= 土台。** 自前テーブルは soft delete(deleted_at)・created_by 帰属・bigint・snake_case 準拠。
| 持ち物 | テーブル/カラム | API |
|---|---|---|
| 見積り | `tasks.time_estimate`(秒) | `POST /tasks/:id`（**updateTask 経由**, §7） |
| 実績 | `task_time_entries`(logged_on,seconds,user_id=対象者,created_by) ＋ computed `time_spent` | `PUT/GET/POST/DELETE /tasks/:task/times` |
| 予定 | `task_time_plans`(plan_date,seconds,user_id,created_by, **start_minute**=時刻配置/null可 ADR-013) ＋ computed `time_planned` | `…/plans` |
| スケジュール/依存/サブ | tasks.start_date/end_date/due_date / related_tasks(precedes/follows/subtask) | TaskStation標準 |
| 種別ラベル | `labels`（「レビュー」=レビュー種別。kind判定に使用 ADR-012） | `/tasks/:id/labels`, `/tasks/:id/relations` |
| **定期/会議** | `recurrences`(rrule[RFC5545文字列・dumb storage], dtstart, duration_seconds, kind['task'\|'meeting'], assignee_ids[JSON], **rotation**=持ち回り[順番=配列順・解釈はSPA], project_id) | `PUT/GET/POST/DELETE /recurrences` |
| **祝日** | `holidays`(date, name) | `/holidays` |
| **個人休暇** | `member_unavailability`(user_id, start_date, end_date, reason) | `/unavailability` |

**2. 計算（純関数・TDD・計40テスト）.** `capacity.js`(空き/負荷/予実/ガント/トリアージ/`buildTaskTree`/`depLayers`) ＋ `recurrence.js`(RRULE展開・空き) ＋ `today_items.js`(本日WorkItem) ＋ `kinds.js`(種別定義)。
- 負荷の**単一真実**（[ADR-010](docs/01-decisions.md)/#4）: タスクは **plansあれば plans、無ければ見積り日割り**。**多担当=全員にフル**（按分しない。会議も同様）。`user_id`(対象者)が信頼できれば その1人にフル。
- 月次空き（[ADR-011](docs/01-decisions.md)）: `expandRecurrences`(rrule.js)＋`occurrenceLoadEntries`(全員フル)＋`capacityOn`(週末/祝日/休暇=0)＋`freeByMemberDay`。
- 本日WorkItem（[ADR-012](docs/01-decisions.md)）: `todayItemsByMember` が `{kind, prio, flags:{adhoc,advanced}}` を返す。**kind=種別**(会議/定例/レビュー/タスク=`recurrences.kind`＋ラベル)、**flags=時間属性**(当日追加=created当日/前倒し=plan当日かつ期日先)。表示トークンは `kinds.js`。
- 時刻配置（[ADR-013](docs/01-decisions.md)）: 「本日にやる＝`task_time_plan`」、`start_minute`(0:00からの分・null=終日)でカレンダー配置。移動=delete+create。

**3. UI（`app/views/`）= 描画だけ.** 見た目はモック資産流用。ルータは `app.js` の ROUTES。

## 4. 状態（done / 残り）
**Done（本番稼働）**
- モック72案（Pages）。
- フォーク: 実績/予定/見積り（3軸）＋ **定期(RRULE)/祝日/休暇**。S1→S2→本番フルゲート通過。
- SPAビュー(本番稼働・全15ルート描画OK・コンソールエラー0):
  - **本日**: 稼働予定(円時計57/積み上げ54・色=優先度/模様=種別/外周=超過、別日へ移す=空き日提案リスケ/本日から外す)・トリアージ(46)・**レビュー(キュー66＋⋯からレビュー依頼ワンポチ=タスク生成)**・**残容量(04)**・**時刻カレンダー(49・start_minuteドラッグ配置)**。
  - **計画**: 週プラン(18)・週プランナー(予定×実績・読み書き)・月次空き(freefinder)・**週日別負荷(33・担当別/合算)**。
  - **実績/仕事**: 見積りvs実績(23)・予実ガント(29/30)・**一覧(60・ソート/絞り込み)**・**アウトライン(68・サブタスク階層)**・**依存グラフ(65・クリティカルパス)**。
- SPAクローム: 名称=**TaskStation**(タブtitle/ログイン/ブランド・「実データ」表記は排除)。ログイン画面は一般的な体裁＋**ログイン⇔新規作成**(本番で登録有効)。円時計の中央=**稼働予定(used)**を大表示・空き/超過はサブ(予定ゼロ=大きく0h)。サイドバーに常設「タスク追加」ボタン。
- **タスク追加・編集UI**（2026-06-11・`views/taskform.js` 再利用モーダル）: サイドバー常設ボタン＋一覧の行クリックで起動。項目=タイトル/ワークスペース(所属グループ)/担当(単一)/**プロジェクト**(=親タスク)/優先度/**開始日・終了日**(start/end・ガント期間バー)/期日/見積り(h)/**先行タスク**(依存・複数チップ)/説明/完了。**依存**=related_tasks.follows でこのタスクの先行を指定（`addRelation(t,p,"follows")`・編集時diff・capacity.js dependencyEdges/依存グラフ/ガント依存線と整合）。開始/終了/期日は数字スマート入力共通。**UI呼称の階層=ワークスペース(=API project)＞プロジェクト(=親タスク)＞タスク**。作成=`createTaskInProject`、更新=`updateTask`(#9非破壊)、担当=`add|removeAssignee`(差し替えdiff)。**プロジェクト(親タスク)**=datalistで既存選択 or 名前入力で同WSに親を新規作成→親側に `subtask` 関連を張る(`add|removeRelation`・編集時は現親とdiff、`related_tasks.parenttask` で現親判定。capacity.js buildTaskTree/アウトラインと整合)。期日は**数字スマート入力**(`62`→6/2・`612`→6/12・`1112`→11/12・年は当年自動、`2026-11-12`等は年も解釈)。フロントのみ・スキーマ変更なし。
- 本日(稼働予定): 既定=**積み上げ**、円時計/積み上げの選択は**個人ごとに localStorage 永続化**(ユーザーidキー・`today.js`)。
- **タスクテンプレート**（2026-06-12）: 雛形は専用WS **「テンプレート」** に保存（分類=同WS内の親タスク・subtask機構流用）。taskform に「テンプレートから作成」コンボボックス（新規時・選択でタイトル/優先度/見積り/説明を反映）＋「テンプレートとして保存」ボタン（プロジェクト欄=分類名）。**store.load がテンプレートWSを tasks から分離**（負荷・空き・一覧に混ざらない。`cache.templates`/`templateProject`、WS名定数=`store.js TEMPLATE_WS`）。テンプレートWSは全メンバー共有済み・taskform のWS選択からは除外。
- **種別タブ＋定期入力UI**（2026-06-12・fix8）: タスク追加モーダルにタブ **タスク/MTG/定例MTG/定期タスク**（新規時のみ・`views/recurrenceform.js`、タブ切替でも高さ固定）。MTG=単発（RRULE `FREQ=DAILY;COUNT=1`）/定例MTG・定期タスク=毎週(曜日)・隔週・毎月第N曜・毎月同日・毎日（`buildRRule`、曜日既定=開始日に追従）。**持ち回り(rotation)**=定期タスクで「毎回1名が順番に担当」: fork に `recurrences.rotation` 列追加（migration 20260612220000・S1→S2→fix8 デプロイ済）、順番=assignee_ids 配列順（↑↓で並べ替えUI）、巡回の解釈は `recurrence.js expandRecurrences`（occurrence に `assignees` を解決・dtstartからの通し番号%人数。本日/月次空き両対応）。再現は backend-patch/apply.md フェーズ6。
- **繰り返しUI再設計＋「この回だけ変更」**（2026-06-13・fix9）: 繰り返しは Googleカレンダー型 **「[N] [週間/か月/日]ごと」**（隔週=2週間ごと）＋単位別の詳細のみ表示（週=曜日トグル/月=「N日 or 第N曜日(最終可)」ラジオ・明示選択）＋**プレビュー文**（🔁 毎月 第1火曜日）＋**開始時刻**（dtstart に時刻が乗る→時刻カレンダーに表示）＋**終了日(UNTIL)**。**この回だけ変更**=Googleカレンダーの「この予定のみ」相当: fork に `recurrences.overrides` JSON列追加（migration 20260613000000・S2→fix9 デプロイ済）。`overrides[元の日付]={skip:true | date/start_minute/duration_seconds}`（差分のみ保存・解釈は `recurrence.js expandRecurrences`、移動が窓をまたぐ場合に備え±31日パディング展開→最終日付でフィルタ。**持ち回りの巡回番号は元の日基準＝休止/移動で順番が崩れない**）。UI=時刻カレンダーの会議ブロックをクリック→日付/開始時刻/所要の変更・この回を休止・例外を解除（例外中ブロックは ✱＋破線枠）。
- **祝日の自動同期**（2026-06-12）: 内閣府公式CSV→`/holidays` を冪等更新する `backend-patch/sync-holidays-jp.py`（追加のみ・過去/既存は触らない）。systemd user timer **`taskstation-holiday-sync.timer`**（毎週月 6:30・Persistent）で自走、認証は `~/.config/taskstation/holiday-sync.env`(600)。**止まった検知はSPA側**: `recurrence.js holidayDataStatus`（登録最終日が today+90日 に届かなければ stale）→ ホームのアラートに「祝日カレンダーが更新されていません」を表示。2026-06-12 に実行済み（実祝日25件投入・デモ用テスト祝日6/22は削除）。
- **AI副担当 Fable**（2026-06-13）: TaskStation に AI ユーザー **fable(id=8)**（WS共有済・資格情報=`~/.config/taskstation/fable.env`）。taskform は **主担当（人間のみ）→選ぶと副担当欄が出現**。副担当は検索式で、人間は普通に候補表示・**AI(fable) は隠しコマンド＝名前を打ったときだけ候補に出る**（`store.js AI_USERNAMES`）。**AIは人間のキャパ計算から除外**（members から分離・`cache.aiMembers`）。実行系=**`taskstation-fable.timer`**（systemd user・15分おき）: fable 担当の未完了タスクを巡回し、**ローカル Claude Code CLI（MAXサブスク・API課金なし）** で段取り/注意点/たたき台を生成して**タスクコメントに投稿**（重複防止=自コメント有無、1回の実行で最大3件、`~/.local/bin/taskstation-fable-runner.py`）。コメントは本体(7005)のタスク画面で閲覧（SPAコメント表示は未実装）。
- **Fable ▶実行・直列キュー・スクリプト**（2026-06-13・Phase1）: 実行サービス **`taskstation-exec.service`**（`~/.local/bin/taskstation-exec.py`・**leo:7020**・systemd常駐）。認証=TaskStation JWT を `/user` で検証し **`~/.config/taskstation/exec.json` の allowed_user_ids のみ**（現在 capdemo=1・森田=7）＝**隠し要素**: 許可者だけ SPA サイドバーに **🤖 Fable** が出現（`app.js` が exec `/me` を probe・ルートは ORDER 外）。ビュー=`views/fable.js`: Fable担当タスクの **▶**（AI実行をキューへ）・**スクリプト一覧の▶ワンポチ起動**（`~/.config/taskstation/scripts/*.sh|*.py`・`TS_TASK_ID` 環境変数）・**直列キュー**（これが終わったらこれ。スクリプト→AI→スクリプトの協業も並べるだけ）・**ライブコンソール**（SSE `/stream/:id`・claude は stream-json をパースして逐次表示）。AI実行=`claude -p`（sonnet・MAXサブスク）→ 結果をタスクコメントに投稿。タスク編集モーダルにも **▶ Fable** ボタン（作成者のみ）。**可視性**: AI担当は作成者(created_by)本人にしか見えない＝taskform は非作成者に副担当を出さず保存時も剥がさない・一覧の担当は先頭の人間を表示・副担当検索の fable 出現も作成者のみ。
- **Fable Phase2: TaskStation MCP（自律操作）**（2026-06-13）: 自作 stdio MCPサーバー **`~/.local/bin/taskstation-mcp.py`**（fable名義・`~/.config/taskstation/mcp.json` 経由で `claude -p --mcp-config` に接続・`--allowedTools mcp__taskstation`）。ツール=get_task/add_comment/**create_subtask**(担当は付けない=人間が割り振る)/set_progress/set_estimate/complete_task（スカラ更新は#9の全置換対策済み）。▶実行のFableは**進捗コメント・タスク分割・進捗率更新を自律で実施**（実証: 5サブタスク作成・75%更新・段階コメント）。**封じ込め**: 実行cwd=`~/.local/share/taskstation-fable/work`（既存リポジトリを汚さない・プロンプト制約＋git commit/push は disallowedTools で禁止）。最終コメントは stream-json の result（最終成果のみ）。
- **Fable Phase3: 実行オプション（スキル選択）**（2026-06-13）: Fable画面に実行オプションパネル（localStorage `ts.fable.runopts`・タスク編集の▶にも適用）。**モデル**=標準Sonnet/高品質Opus、**ブラウザ操作**=playwright MCP(headless/isolated)を実行時に接続＋`mcp__playwright`許可、**Web検索・閲覧**=WebSearch/WebFetch許可、**追加指示**=毎回プロンプトに添付。exec `/run` の `options{model,browser,web,extra}`。MCP構成はジョブごとに `.mcp-<id>.json` を生成→終了時削除。
- **Fable: 計画モード＋AIコメントの完全秘匿**（2026-06-13）: **📝計画ボタン**=`--permission-mode plan`（読み取り専用・変更系は物理的に不可）で実行計画だけ生成→人間がレビュー→**▶実行時に直近の計画を「承認済み計画」としてプロンプトへ自動添付**（管理ゲート）。**FableのテキストはTaskStationコメントに一切書かない**: 全て隠しストア `~/.local/share/taskstation-fable/notes.json`（`taskstation_notes.py`・exec/MCP/runner共用・MCPツールは add_comment→**add_note** に変更）。閲覧は exec `GET /notes/<task_id>`（許可ユーザーのみ）→ タスク編集モーダルの **「AIコメント（自分のみ）」欄**（作成者＋Fable副担当時のみ表示）。サブタスク・進捗率はチームに見える通常データのまま（AI由来とは判らない）。
- **Fable: モデル3択＋成果物ブラウザ**（2026-06-13）: モデル=Sonnet/Opus/**Fable**（`claude --model fable` 動作確認済み）。AI実行の cwd は **`work/task-<id>/`**（タスク別整理）。Fable画面に**成果物カード**（exec `GET /files`=作業dir走査・`GET /file/<rel>`=配信。パストラバーサル拒否・許可ユーザーのみ）→ クリックでブラウザ閲覧。成果物の確認動線=①AIコメント欄（テキスト報告）②コンソール（ログ）③成果物カード（ファイル）。
- **設定ビュー**（2026-06-13・`views/settings.js`・ROUTES有効化）: **チーム共有設定**＝容量(h/日)・時刻カレンダーの営業時間・**集計対象WS**（除外WSのタスクは負荷/空き/一覧から外れる・テンプレートWSは常に除外）。保存先= taskstation-exec `GET/POST /settings`（`~/.config/taskstation/settings.json`・**読み取り=全ログインユーザー/書き込み=許可ユーザーのみ**＝管理者）。SPAは store.load が settings を取得し全ビューに配線（today/clock/availability/weekstack/home/week/freefinder/calendar の 8h と H0/H1 ハードコード解消。exec停止時は既定値で劣化動作）。
- **かんばんビュー**（2026-06-13・`views/kanban.js`・ROUTES有効化）: Vikunja 0.24 の**プロジェクトビュー＋バケット**をそのまま使用（API: `GET /projects/:p`(views)→kanban view id→`GET/PUT/POST/DELETE /projects/:p/views/:v/buckets[...]`・移動=`POST .../buckets/:b/tasks {task_id}`）。WS選択(localStorage記憶)・列=バケット（Enterで追加/タイトルクリックで名前変更/空なら×削除）・カード=タスク（優先度ドット/担当アバター[AI非表示]/期日[超過赤]/見積り/完了タグ・**ドラッグで列移動・クリックで編集モーダル**）。
- 基盤固め: #1 書き込み破壊性根治(ADR-008) / #2 soft delete / #3 帰属(ADR-009) / #4 負荷の単一真実(ADR-010) / #7 回帰網 / #9 スカラ更新安全化(client updateTask)。

**残り**
- **入力UI(残)**: **祝日/休暇**の登録・編集（今は seed/API のみ）と**定期の編集・削除**（登録はタブUIで可能に。編集/削除は API のみ）。#3 対象者選択UI（planner フォーム）。※タスク本体・定期/MTG の追加は完了（上記）。
- 残ビュー: なし（かんばん・設定とも 2026-06-13 実装済み＝全16ルート稼働）。
- カレンダー作り込み(残): 営業時間/容量の可変化・複数日（週タイムライン）。※リサイズ・会議/定例の時刻ブロック表示は 2026-06-12 完了。
- **土日祝の考慮ギャップ**（2026-06-12 監査）: ①見積りの**日割りが暦日割り**（`capacity.js taskHoursOn` が土日祝込みの inclusiveDays で割る→週末に負荷が落ち平日が薄まる。営業日割りにすべき）②**本日系ビュー（today/home KPI）の capH=8 固定**（祝日・週末でも空き8hと表示。`capacityOn` 未使用）。月次空き/リスケ提案/週次freeWindow は `capacityOn` 経由で正しい。
- 据え置き(ADRで明記): 「本日=plan」完全一本化(due/範囲の暫定表示廃止・ADR-012)/定期occurrenceのmaterialize(ADR-011)/人別可変キャパ(時短)/AI Q&A(53)。

## 5. 運用 runbook
### フォークを直して再デプロイ（fixN 系の作り方）
ホストに Go 無し。**xgo不使用**＝docker golang:1.22 でネイティブビルド。frontend は `frontend/dist`（go:embed）。
**ブランド化はソース側**（`frontend/src` の大文字"Vikunja"→"TaskStation"・`src/assets/logo*.svg`/`public/favicon.*`・`src/urls.ts`）→ frontend再ビルドで dist に反映。
```bash
cd /home/neo/vikunja-fork/vikunja
# (ブランディング変更時のみ) frontend再ビルド: pnpm build → dist再生成 → 下のgo buildでembed
#   ※dist/が過去のdocker由来でroot所有なら先に: docker run --rm -v "$PWD/frontend":/w -w /w alpine rm -rf dist stats.html
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app -e CGO_ENABLED=1 \
  golang:1.22 sh -c 'go build -buildvcs=false -ldflags "-s -w" -o vikunja .'
docker build -f Dockerfile.deploy -t leo-taskstation:0.24.6-fixN .   # 次は fix10
# 本番反映（必ず backup → image差し替え → recreate。migrationは起動時自動）
docker run --rm -v vikunja_vikunja-db:/from -v vikunja_vikunja-db-backup-fixN:/to alpine sh -c 'cp -a /from/. /to/'
# pm-trials/vikunja/docker-compose.yml の image: を新タグに編集
cd /home/neo/pm-trials/vikunja && docker compose up -d --force-recreate
```
### テスト
```bash
cd /home/neo/vikunja-fork/vikunja
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app -e CGO_ENABLED=1 -e VIKUNJA_SERVICE_ROOTPATH=/app \
  golang:1.22 go test ./pkg/models/ ./pkg/integrations/ -count=1     # フォーク回帰（必須）
cd capacity-dashboard/app/lib && docker run --rm -v "$PWD":/w -w /w node:20-alpine node --test  # capacity21+recurrence8
```
### 隔離検証（S2・本番に触れず）
新imageを使い捨てsqlite・別ポート7011で起動（fresh volume は `chown 1000:0`）→ API/Playwright。手順は git log（fix1〜4 の S2）参照。
### ロールバック
image を一つ前のタグ（fix3 等）に戻して recreate。DB は migration が**追加のみ**なので image 戻しで互換。破損時は `vikunja_vikunja-db-backup-fix*` から復元。
### rrule.js の再ベンダリング（依存更新時のみ）
```bash
cd capacity-dashboard/app/lib/vendor && docker run --rm -v "$PWD":/out node:20-alpine sh -c \
 'cd /tmp && npm init -y >/dev/null && npm i rrule esbuild >/dev/null && printf "export { RRule, RRuleSet, rrulestr } from \"rrule\";\n" > e.mjs && ./node_modules/.bin/esbuild e.mjs --bundle --format=esm --platform=neutral --main-fields=module,main --legal-comments=none --outfile=/out/rrule.mjs'
```
### SPAを直す
`app/` を編集 → leo:7010 は作業ツリー直配信＝即反映、push で Pages 更新。**ブラウザはESモジュールをキャッシュ**するので強制リロード（Playwright は about:blank 経由で再ナビ）。

## 6. 認証・デモデータ
- **capdemo / CapDemoPass123**（SPAログイン・id=1）。メンバー **morita(2)/tanaka(3)/satou(4)/suzuki(5)**（各 TeamPass123）。**森田(7)**=ユーザー本人が新規作成画面から登録した実アカウント（チーム作業・実績デモを共有済み）。
- **新規アカウントは作成だけではワークスペースが見えない**（タスク0件・メンバー名が user{ID} 表示になる）。本体(7005)かAPIで `PUT /projects/:id/users {"user_id":"<ユーザー名>","right":1}` の共有が必須。SPAに共有UIは未実装。
- CORS は compose で許可済（別オリジンSPA用）。**`VIKUNJA_SERVICE_ENABLEREGISTRATION: "true"`**（本番compose・SPAのアカウント作成画面用）。SPAログイン画面は ログイン⇔新規作成 を相互遷移（`app.js showAuth`、登録は `api.register`→`/register`）。
- seed（冪等・`/tmp/cap_token` に capdemo トークンを置いて実行）:
  - `backend-patch/seed-gantt-demo.py` … タスクの start/end/依存/担当（**⚠️ POST はスカラ全置換なので assignees も再適用、§7**）。
  - `backend-patch/seed-recurrence-demo.py` … 定期(毎週月会議/毎月第2火/隔週水)・祝日(6/22)・morita休暇(6/29-7/1)。

## 7. gotcha（現行・重要）
- **書き込みの非破壊（2系統）**:
  - 関連(assignees/reminders): **fork で根治済**（#1/ADR-008。`Task.Update` を nil ガード。不在/null=維持・[]=クリア）。
  - **スカラ(start/end/due/priority/percent_done等)は TaskStation が意図的に全置換**（payload に無い=クリア。upstream仕様）。→ **SPA は必ず `vikunja.js updateTask(taskId, patch)`**（GET→全スカラ保持→patch→POST）。生POSTで部分更新するとスカラが消える（#9）。将来のガント・ドラッグ編集も updateTask 必須。
- **フォークに新エンティティを足す時**（time系/recurrence系が手本・`backend-patch/apply.md` §3-5/フェーズ5）:
  - 4箇所登録: `models.go GetTables` ＋ `unit_tests.go InitTestFixtures` ＋ `pkg/db/fixtures/<table>.yml`(空[]) ＋ `routes.go`。
  - soft delete: `DeletedAt time.Time xorm:"deleted_at deleted"`。**SUM等の生SQL集計は `Where("deleted_at IS NULL")` 必須**（structクエリは自動除外）。
  - **GonicMapper の列名ズレ**: `DTStart→d_t_start`/`RRule→r_rule`/`AssigneeIDs→assignee_i_ds`。連続大文字や複数形は **`xorm:"... 'dtstart'"` で列名を明示**（model と migration の両方）。`UserID/ProjectID/CreatedBy` は正しく user_id/… になる。
  - JSON列: `xorm:"json not null 'assignee_ids'"`（前例 api_tokens）。多担当=全員フル。
  - error code は未使用帯（15001=times,15002=plans,15003=recurrence,15004=holiday,15005=unavailability）。次は 15006〜。
  - グローバル設定エンティティの権限は `label_rights.go` 流（LinkSharing 以外 true）。
- **定期は仮想 occurrence**: `recurrences` は RRULE 文字列を保存するだけ。展開・空き計算は **SPA(recurrence.js/rrule.js)**。実タスク/plans は生成しない＝計画用（実績追跡は将来 materialize）。
- **定期の開催時刻＝dtstart の時刻**（2026-06-12 規約化）: UTC文字列の HH:MM をそのまま壁時計として扱う（TZ変換しない・`00:00`=時刻なし）。時刻カレンダーが固定ブロック表示に使用。`expandRecurrences` の窓は日単位 inclusive（`toISO T23:59:59Z`）— `T00:00` 締めだと時刻付き occurrence が落ちる。
- **ガント**: 予定バー範囲は plans→start/end→due の階層(`taskRanges`)。依存は TaskStation が precedes 作成時に逆 follows も自動付与→`dependencyEdges` で前向き正規化＋重複除去。
- TaskStation: username≥3文字 / 共有の `user_id` は文字列(ユーザー名)。bash の `UID` は予約変数。

## 8. データ構造の到達点（“UIだけ” vs “schema変更が要る”）
**今のデータ構造で実現可能（＝UI/計算の結線だけ）**: 月次まで空き / 予実・ガント / **負荷ヒストリー・バーンダウン**(time_entries.logged_on) / **見積り精度**(estimate vs spent) / **PJ別配分**(project_id×時間) / **依存考慮の並び**(related_tasks) / **かんばん**(bucket)・**WBS**(subtask) / 代理入力の監査(created_by) / 定期・祝日・休暇の**登録UI**・対象者指定入力・ガントのドラッグ編集（書き込みは安全）。

**データ構造の変更が要る（保留）**:
| 要望 | 不足 |
|---|---|
| 時刻帯の空き・半日休暇 | 全部**日次粒度**。時刻フィールドが無い |
| 人別の可変稼働（時短=1日6h・曜日別） | 容量 **8h/平日 固定**。member_capacity 表が無い |
| 設定の永続化（容量/対象PJ/解析ルール） | settings 表が無い（コード固定） |
| 定期の実績/完了追跡 | occurrence は仮想（materialize 要） |
| 外部カレンダー(Google)同期 | 連携＋マッピング要 |

→ **ユーザー確定（2026-06-10）: 当面 全員8h/平日で十分**。上の保留は要件化したら再ADR（時刻帯/人別キャパは ADR-011/§可用性 で一度見送り済）。

## 9. 次の一手（おすすめ順）
1. **入力UI(残)**（定期/祝日/休暇の登録・編集。せっかくのデータが seed 経由でしか入らない＝実運用に乗らない）。設定画面(17)と一体化も可。※タスク本体の追加・編集UIは完了（`views/taskform.js`）。同モーダル流用で定期/祝日/休暇フォームも作れる。
2. **#3 SPA配線**（planner の対象者選択＋logTime/logPlan の user_id 送信）。
3. **負荷ヒストリー/バーンダウン or PJ別配分**（データ即可・新ビュー）。
4. かんばん(bucket)/一覧。ガント作り込み（updateTask 使用）。
5. P2清掃: #6 est:Nh ラベル掃除 / #8 日別バッチ取得(N+1)。（#5 members×projectusers は 2026-06-12 消化済み＝store.js が全WSの projectusers で ID→名前を解決）
6. AI Q&A(53) を別API化するか判断。
