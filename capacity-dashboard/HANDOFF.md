# ハンドオフ — Capacity Board

> status: **稼働中**（2026-06-10）。モック72案 → TaskStationフォークで時間管理をDB実装（本番） → 実データSPA（中核＋予実ガント） → **基盤固め完了**（#1-#4,#7,#9）→ **定期/会議＋祝日＋休暇→月次空き完了**（ADR-011）→ **UI全面TaskStationブランド化**（新ロゴ/favicon）→ **本日の稼働予定(円時計)＋リスケ＋レビュー依頼/キュー**（ADR-012 種別2軸）→ **切り口別ビュー群**（一覧/残容量/週日別/アウトライン/依存グラフ）→ **時刻カレンダー**（ADR-013 `start_minute`・ドラッグ配置）→ **種別タブ＋定期入力UI**（タスク/MTG/定例MTG/定期タスク・**持ち回り=recurrences.rotation**）→ **繰り返しUI再設計＋この回だけ変更**（Googleカレンダー型「N単位ごと」・**例外=recurrences.overrides**）→ **予定の基礎データ管理ビュー**（定期/祝日/休暇の登録・編集・削除UI＝seed/API 依存を解消）。本番イメージ **`leo-taskstation:0.24.6-fix9`**。
> 次の人がコンテキスト無しで読む前提。まず本書 → 要件 [`docs/06-requirements.md`](docs/06-requirements.md) → ADR [`docs/01-decisions.md`](docs/01-decisions.md)（**ADR-006〜013 が現行設計**。012=種別kind×時間属性flagsの2軸／013=plan.start_minuteで時刻配置）→ `docs/00,05`。
> **確定（2026-06-10）**: 容量は当面 **全員 8h/平日 固定で十分**（時刻帯の空き・半日休暇・人別可変キャパ＝時短 は保留。詳細は §8）。

## 0. これは何 / なぜ
少人数チーム(2〜4名)向け **「今日/週/月の空き容量さがし」＋「予定×実績」キャパ可視化**。狙いは **Instagantt の Workload 相当を OSS・自前ホスト（データ主権）** で。タスクの箱は **TaskStation**。素では「時間」概念ゼロ → **TaskStation を fork して時間管理・定期・祝日・休暇を DB ネイティブに足した**（ここが土台）。背景は [`docs/00`](docs/00-design-philosophy.md)、判断は [`docs/01`](docs/01-decisions.md)。

## 1. どこで動いてる / 見る
| 物 | 場所 |
|---|---|
| **PWA（インストール可・推奨）** | **https://leo.tail65add4.ts.net:7011/app/** （capdemo / CapDemoPass123） |
| 実データSPA（平文・非PWA） | http://leo:7010/app/ （PWA不可＝secure context外。開発時の素早い確認用） |
| モックギャラリー(72案) | http://leo:7010/ ／ Pages: https://mister-x-is-your-father.github.io/office-work/capacity-dashboard/ |
| **TaskStation（フォーク本番）** | http://leo:7005 （image **`leo-taskstation:0.24.6-fix9`**） |
| GitHub | https://github.com/mister-x-is-your-father/office-work → `capacity-dashboard/` |

配信は systemd user service **`taskstation-spa.service`**（`~/.local/bin/taskstation-spa-serve.py` を実行。ThreadingHTTPServer・no-storeヘッダ付きで `capacity-dashboard/` を 7010 で配信。enable済み＝ブート自動起動・落ちたら自動再起動）。状態確認は `systemctl --user status taskstation-spa`。AI副担当の実行系は `systemctl --user list-timers taskstation-fable.timer`／`systemctl --user status taskstation-exec`（▶実行・port7020）／ログは `journalctl --user -u taskstation-fable` / `-u taskstation-exec`。
**PWA/HTTPS（2026-06-13）**: PWA は secure context 必須なので **`tailscale serve`（tailnet内HTTPS・7011）で SPA(/)＋API(/api→7005)＋exec(/exec→7020) を1オリジンに同居**（mixed content/CORS回避）。`api.js`/`exec.js` は **`location.protocol==="https:"` で同一オリジン相対**、平文httpでは従来の 7005/7020 直叩き（両アクセス維持）。serve確認=`tailscale serve status`、解除=`tailscale serve --https=7011 off`。SW=`app/sw.js`（network-first・同一オリジンのみ介入・APIは素通し）／manifest=`app/manifest.webmanifest`／アイコン=`app/icons/`。

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
/home/neo/vendor/vikunja-fork/vikunja/          # ← TaskStation v0.24.6 clone＋パッチ適用済（ビルド元）
/home/neo/apps/pm-trials/vikunja/docker-compose.yml  # ← 本番compose(image=leo-taskstation:...fix9)
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
- 負荷の**単一真実**（[ADR-010](docs/01-decisions.md)/#4）: タスクは **plansあれば plans、無ければ見積りの営業日割り**（2026-06-13〜・土日祝に負荷を載せず平日のみ等分。`taskHoursOn`/`businessDays`・holidays Set 任意）。**多担当=全員にフル**（按分しない。会議も同様）。`user_id`(対象者)が信頼できれば その1人にフル。本日系KPIの容量は `capacityOn` で週末/祝日/休暇=0（ステータス `off`）。
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
- **タスクの分類**（2026-06-13）: 分類=ユーザー定義ラベル（`kinds.js categoryLabels`。「レビュー」ラベルは kind 軸の予約語として分類から除外＝**レビュー×分類が共存**）。taskform に分類コンボボックス（選択/新規作成/空=なし・単一運用・保存はdiff付け替え）、一覧に分類列＋フィルタ。初期分類=エンジニア依頼/定常業務。
- **TickTick機能パリティ一式**（2026-06-13・機能の洗い出し→TaskStation流にブラッシュアップして移植。全テスト80件グリーン・全20ルート巡回エラー0で確認）:
  - **全文検索**（`lib/search.js`＋`views/searchpal.js`・テスト6件）: **Ctrl+K / トップバー🔍** でコマンドパレット。タイトル/説明/分類/WS名を横断・空白区切りAND・ランク付け（タイトル先頭一致>含む>分類>WS>説明・完了は同点で後ろ）。↑↓選択・Enterで編集モーダル。
  - **チェックリスト**（form.js の `[チェック]` メタ規約拡張・テスト3件）: `- [ ]`/`- [x]` 行ブロック。[ゴール][資料]と共存・順序不問・ブロック内の手書き行も未完項目として拾う（消失防止）。taskform に編集UI（トグル/削除/進捗カウント・テンプレ保存込み・テンプレ適用時は未完リセット）。splitMeta は `checks` を返す（4値に）・joinMeta は第4引数（後方互換）。
  - **リマインダー通知**（`lib/notify.js`・テスト4件）: 通知源3系統=①自分のplan(start_minute) ②出席する会議/定例（dtstart時刻・override適用）③期日=今日のタスク（営業開始時刻にまとめて・時刻つき予定があるタスクは二重通知しない）。Web Notification（権限なければアプリ内トースト）。**N分前は個人設定**＝設定ビューに「リマインダー通知」カード新設（localStorage `ts.notify.<uid>`・exec停止時も設定可）。発火済みは `ts.notify.fired.<日付>` で記録し再通知しない。スケジューラは app.js が30秒間隔で起動。
  - **集中タイマー（ポモドーロ）**（`views/pomodoro.js`・トップバー🍅）: 集中**5/10/15/25/45/50/60分**・休憩5/10/15分・一時停止/中断。**カードはヘッダ掴みでドラッグ移動**（位置localStorage永続）・モード切替で高さ固定（`.pm-modebox`）。**表示スキン カタログ6種＝形(進捗メタファ)で差別化**（リング/数字/バー/ドット/ゲージ/ブルーム＝`renderDisplay`・進捗`progressOf`。色違いでなく円/数字/直線/離散/面積/成長と形そのものを変える＝一目で区別可。旧8種から統合し保存設定は自動移行 `SKIN_MIGRATE`）＋**色・透明度カスタム**（🎨設定パネル＝「スタイル」見出し＋**ライブプレビュー2列カード**[各スキンの形をミニ描画`skinThumb`・選択は枠線/色/✓の三重表示`role=radiogroup`]＋色スウォッチ＋透明度%・`ts.pomo.disp`）。実行カードは「表示エリアのみ毎秒更新・操作部/ピッカーは永続」構造でチラつき/入力消失なし。スキン/色はPiPにも反映。**最前面表示=Document PiP は secure context 専用**＝PWA(https://leo…:7011/app/)でのみ動作（平文httpは案内表示）。**終了/中断時に選択タスクの実績(time entries)へ自動記録**（90秒未満は記録しない）→見積りvs実績・予実ガントに直結（TickTickは専用統計どまり＝ここがブラッシュアップ）。状態は localStorage `ts.pomo`（リロード/タブ閉じ継続・不在中の満了は復帰時に記録）。タブタイトルに残り時間。
  - **四象限**（`views/quad.js`・本日グループ）: アイゼンハワー・マトリクス。重要=優先度高以上 / 緊急=期日3日以内・超過。ドラッグで再分類（優先度・期日書き換え・8秒undoトースト）・クリックで編集・担当フィルタ。
  - **添付ファイル**（api.js: get/upload/delete/fetchBlob・taskform編集時のみ）: ネイティブ添付API流用（multipart・スキーマ変更なし）。一覧チップ・複数アップ・×削除・クリックDL（要AuthヘッダのためblobでDL）。
  - **月カレンダー**（`views/monthcal.js`・計画グループ）: monthMatrix流用の月グリッドに期日タスク（担当ドット・完了は薄く）＋会議/定例（展開済み・時刻表示）＋祝日。**チップをドラッグで期日移動**（updateTask #9非破壊）・担当フィルタ・月ナビ。
  - **習慣トラッカー**（`lib/habits.js`＋`views/habits.js`・本日グループ・テスト5件）: 習慣=**「習慣」WS** のタスク（担当=本人・ユーザーごと自動作成・store.load が通常タスクから除外）。チェック=実績エントリ（`logged_on`・**RFC3339必須**・60秒固定）。直近7日ストリップ・🔥連続日数（今日未チェックでも昨日まで連続なら継続扱い）・トグル=logTime/deleteTime。api.js に deleteTime/deleteTask 追加。
  - 対象外と判断: 位置リマインダー・音声入力・メールtoタスク（モバイル/インフラ専用思想）。カレンダー同期(Google/CalDAV)・モバイルPWAは未着手の大物として残り。
- **クイック追加バー**（2026-06-13・`lib/quickadd.js`＋`views/quickadd.js`・トップバー常設）: TickTick実アカウント調査の結論=利用実態は**瞬間メモ捕獲**（リマインダー/繰り返し/ポモドーロ/習慣はほぼ未使用・完了388件の大半がメモとURLのダンプ）→ 最重要ギャップは**1行自然言語→即タスク化**と判断。構文=`明日15時 MTG準備 #分類 !高 1.5h @担当 >WS URL`（日付=今日/明日/明後日/N日後/X曜/来週X曜/M\/D/M月D日・過去M\/Dは翌年繰上げ。URLとMarkdownリンクは説明の`[資料]`行へ）。**完全一致トークンのみ消費**＝「15時の件」「明日の会議メモ」等の日本語文中は壊さない（純関数パーサ・テスト12件 `quickadd.test.mjs`）。解析結果はチップでライブプレビュー→Enterで作成、`/`キーでどこからでもフォーカス・連続入力でフォーカス維持（ダンプ運用）。既定投入先=**「インボックス」WS（無ければ自動作成・ユーザーごと）**、`>WS名`で明示指定（不明WSはインボックスへフォールバック表示）。**時刻指定があれば日別予定(plan/start_minute)も作成**＝時刻カレンダーに即出現（所要=見積、無ければ1h）。@担当は人間のみ解決（**AI(fable)割当は taskform の隠しコマンド経由のみ＝仕様維持**）。
- **マイソートの名前付き保存**（2026-06-14・`views/table.js`）: 手動ドラッグ順（マイソート＝`✋ マイソート`）に名前を付けて複数保存・適用・削除。**本人ごと（localStorage `ts.list.mysorts.<uid>`＝[{name,order:[id]}]）**＝手動順は個人の並びなのでローカル（共有ソートプリセットはチーム共有とは別物）。マイソート中に👤バーで保存/適用/削除。手動並べ替えは**ポインタイベント方式**（HTML5 DnDの不安定を解消・grip の draggable除去・上下半分インジケータ・タッチ対応）。UI表記は「並び」→「ソート」に統一。検証: Playwright実マウスで ドラッグ→保存→崩す→適用で復元→削除・エラー0。
- **共有ソートプリセット**（2026-06-13・`views/table.js`＋exec `/settings`）: 組み合わせソートを**名前付きで保存→チーム全員で共有（グローバル）**。保存先=exec の team-settings（`~/.config/taskstation/settings.json` の `sort_presets`・**exec.py の POST /settings に sort_presets マージ処理を追加＋SETTINGS_DEFAULT**・GET読み取りは `auth_any` で全ユーザー可・書き込みは ALLOWED のみ）。`store.js settings.sortPresets`／`exec.js savePresets`。**適用は本人の `V.sorts` に反映（共有データ不変＝衝突しない）／保存・削除は全員に反映（許可ユーザーのみ＝🌐チップ＋💾保存＋×削除）**。これで「手動順＝個人」「ソートプリセット＝共有」を両立。検証: Playwrightで 保存→settings.json永続→適用で組み合わせ復元→削除 を確認・エラー0。※exec.py は repo 外（`~/.local/bin`）＝再現は HANDOFF 記載のとおり手当て。
- **一覧の個人別並び順＋組み合わせソート**（2026-06-13・`views/table.js`）: 並び設定（**複数軸の連なり sorts[]**＋手動順 order[]＋絞り込み）を**見ている本人ごとに localStorage 保存**（`ts.list.view.<uid>`・**DB共有データは不変＝他メンバーに影響しない＝衝突しない**）。**組み合わせソート**＝軸チップを重ねて第1キー→第2キー…（例 WS→優先度→期日。`AXES` 定義・各軸に既定の向き）。チップで向き切替/削除、「＋軸を追加」で追加、列ヘッダ=クリックで主キー化・**Shift+クリックで軸追加**、ヘッダに軸順バッジ（2↓等）。**「✋ マイ並び」**＝⠿グリップでドラッグ手動並べ替え（HTML5 DnD・上下半分で挿入判定・フィルタ中は非表示分の順序保持で全体再構築・新規末尾・欠番除去）。フラグ(is_favorite)行に🚩。「やる順／PJ順／優先度順／好み」を各自独立。※端末ごと（localStorage）＝クロスデバイス同期は将来（user_preferences表）。検証: Playwrightで WS→優先度の組み合わせ（WS内で優先度降順）・チップ操作・手動ドラッグ・永続・エラー0。
- **PWA化**（2026-06-13・インストール可能＋オフラインのアプリシェル＋スタンドアロン起動。**レスポンシブ改修は対象外＝ユーザー指示**）: `manifest.webmanifest`（standalone/theme_color/アイコン192・512・maskable=`app/icons/`、rsvg-convert生成）＋`sw.js`（network-first・同一オリジンのみキャッシュ・API素通し・ナビはindex.htmlフォールバック）＋`index.html` head（manifest/theme-color/apple-touch-icon）＋`app.js`（SW登録・オフラインバナー・beforeinstallpromptでインストールボタン）。**secure context 必須**のため `tailscale serve`（7011・tailnet内HTTPS）で SPA/API/exec を1オリジン同居（§1参照）、`api.js`/`exec.js` をオリジン適応に。検証: Playwrightで https://leo.tail65add4.ts.net:7011/app/ にて isSecureContext=true・SW登録&制御・cache生成・beforeinstallprompt発火（インストールボタン表示）・API同一オリジン200・全アプリ描画をサーバー往復で確認。**未対応（任意）**: データのオフライン同期（現状オフライン時はシェル起動のみ・APIは素通しで失敗→バナー表示）。
- **概要ダッシュボード**（2026-06-13・`views/summary.js`＋`lib/summary.js`・実績グループ・テスト5件）: TickTick の「概要/統計」＋§9 の PJ別配分/負荷ヒストリーを統合。store のタスクのみで集計（**N+1なし**）。KPI（今週完了/累計・実績÷見積り・見積り精度%・未完了＋期限切れ）＋**完了の推移**（過去14日・追加vs完了の日別バー＝`dailyThroughput`・done_at/created由来）＋**WS別の配分**（見積り/実績の横棒＝`projectTotals`）＋**分類別タスク数**（`labelTotals`）＋**見積りvs実績**（ズレ大きい順・`estimateVsActual` 流用）。純関数＋テスト（`overallStats`/`dailyThroughput`/`projectTotals`/`labelTotals`/`weekStartISO`）。
- **スマートリスト**（2026-06-13・`views/smartlist.js`＋`lib/smartlist.js`・総合グループ・テスト7件）: TickTick の Smart List をブラッシュアップ。左レール=**組み込みビュー**（インボックス/今日/次の7日間/期限切れ/重要/フラグ/期日なし/完了済み・各**件数バッジ**）＋**保存したカスタムフィルタ**（localStorage `ts.smartlists.<uid>`・スキーマ変更なし）。右=フィルタバー（テキスト/期日/優先度/分類/WS/状態/フラグ）→ 触ると「カスタム条件」化し**＋保存**で命名保存。結果は**インライン完了**（丸チェック→`updateTask{done,percent_done}` 非破壊・楽観アニメ）・**フラグ**（`is_favorite` トグル）・クリックで編集モーダル。判定は純関数 `taskMatches`／`next7End`（分類のみ kinds 依存で view 側）。テキスト/ソートは結果のみ再描画でフォーカス保持。検証: Playwrightで件数・完了往復(task15・サーバー確認)・カスタム保存/削除・優先度フィルタを確認、エラー0。
- **ガント ドラッグ編集**（2026-06-13・`views/gantt.js`）: 予定バーを直接つかんで日程変更。**ソース別に整合**（`taskRanges` は plans＞dates＞due で根拠を1つだけ選ぶ＝事故が起きない不変条件）: **dates バー**=本体ドラッグで移動＋左右端ハンドルで伸縮→`updateTask(start_date/end_date)`、**due バー**=移動→`updateTask(due_date)`、**plans バー**=移動のみ＝全 plan_date を delta 日ずらす（`deletePlan`→`logPlan` で seconds/user_id/**start_minute**/note 保持・start/end があれば併せてずらす）。pointer events 委譲＋delta方式（`dayDelta=round(dx/COL_W)`）＋プレビュー（`scale.range` 再計算）＋日付ラベル。**バークリック（無移動）で編集モーダル**（`openTaskForm`）。ピクセル→日付の純関数 `capacity.js applyBarDrag(bar,dayDelta,edge)`（move/start/end・最小1日クランプ）＋テスト3件（計86）。検証: Playwrightで dates移動±3/端伸縮±2/plans移動±2（時刻9:00保持）/クリック編集をサーバー往復で確認・デモデータ復元済・エラー0。
- **予定の基礎データ管理ビュー**（2026-06-13・`views/manage.js`・ROUTES「その他」グループ）: 定期/祝日/休暇の登録・編集・削除を1画面に集約＝**seed/API 依存を解消**（HANDOFF §9 最優先を消化）。3カード構成: ①**定期・会議**=一覧（RRULE→人間可読要約＝`recurrenceform.js summarizeRecurrence`／持ち回りは「A→B→C」表示）＋新規（種別タブ）＋編集＋削除。②**祝日**=スマート日付＋名称で追加・日付順一覧（過去は淡色）・削除（国民の祝日は別途週1自動同期、ここは会社独自休業日向け）。③**個人休暇**=メンバー/開始/終了/理由で追加・一覧・削除（期間は両端含む＝capacityOn が容量0に）。**定期の編集**=`recurrenceform.js` を拡張: `parseRRuleToState`（RRULE文字列→buildRRule状態の逆写像）・`recurrenceMode`（mtg/rmtg/rtask判定）でモーダルをプレフィル→`updateRecurrence`（overrides保持＝この回だけ変更を消さない）。新規/編集とも独立モーダル `openRecurrenceForm`（taskform の `ensureStyle` を動的importで流用＝循環依存回避）。taskform 側のタブ作成UIは非破壊（`renderRecurrencePanel` は `existing` 既定null）。全80テストグリーン・Playwright で編集往復(10:00↔11:00)・祝日追加/削除往復・taskform定期タブ回帰なしを確認。
- **土日祝の考慮ギャップ修正**（2026-06-13）: 見積りの暦日割り→**営業日割り**（週末に負荷が漏れない）＋本日系KPI（home/today/availability）の容量を `capacityOn` 配線で週末/祝日/休暇=0（ステータス `off`=「休」表示）に。詳細は §4 残り。capacity.js 純関数＋テスト83件グリーン。
- **GTD「連絡待ち」ステータス**（2026-06-14・`lib/kinds.js`/`lib/api.js`/`views/table.js`ほか）: ステータスは done/started_at 由来の状態とは別軸なので、連絡待ち(Waiting For)は**予約ラベル方式**（レビューラベルと同パターン）で表現。`statusOf` の優先順=**done→連絡待ち→進行中→未着手**（`STATUS` に `waiting` 追加・SSoT）。`api.js ensureWaitingLabel`/`setTaskWaiting`。一覧のステータスメニュー・スマートリスト（組み込みビュー「⏳連絡待ち」＋絞り込み・`lib/smartlist.js taskMatches`は kinds 非依存方針でラベル文字列インライン判定）・アウトライン/依存グラフの表示色に反映。予約ラベル（レビュー/連絡待ち）は分類候補からは常に除外（`categoryLabels` ほか各 picker）。
- **一覧の表示改善**（2026-06-14〜15・`views/table.js`/`app.js`/`index.html`）: ①**完了表示3択**＝「完了も表示／完了を隠す(今日の完了は残す)／完了を隠す」（`V.doneMode`、旧 `hideDone` bool は自動移行・`today` は `done_at`が今日のみ残す）。②**プロジェクト列を先頭に追加**＝色付きドットチップ（`projColor(pid)`）＋ヘッダクリック/Shift+クリックでソート（既存 `ws` 軸に紐付け・ラベルを「WS」→「プロジェクト」に。キーは `ws` のまま＝保存済みソート互換）。重複していたタスク名下のサブ表示は廃止。③列が多い一覧は `app.js` のルート `wide:true`＋`.content.wide{max-width:1280px}` で横スクロール解消。④見積メニューは時間グリッドの内部スクロールでは閉じない（`onScroll` の発生元判定）。
- 基盤固め: #1 書き込み破壊性根治(ADR-008) / #2 soft delete / #3 帰属(ADR-009) / #4 負荷の単一真実(ADR-010) / #7 回帰網 / #9 スカラ更新安全化(client updateTask)。

**残り**
- **入力UI(残)**: 定期/祝日/休暇の登録・編集・削除は **`views/manage.js` で完了**（2026-06-13）。**#3 対象者選択UI も完了**（2026-06-13・週プランナーの予定追加に対象者セレクタ＝選択タスクの人間担当に追従・`logPlan` に user_id 送信＝対象者に帰属）。残るは祝日/休暇の**編集**（現状は削除→再追加で代替・需要薄）。
- 残ビュー: なし（2026-06-13 時点で全20ルート稼働: 16＋四象限・習慣・月カレンダー、＋隠しFable）。
- カレンダー作り込み(残): 営業時間/容量の可変化・複数日（週タイムライン）。※リサイズ・会議/定例の時刻ブロック表示は 2026-06-12 完了。
- ~~**土日祝の考慮ギャップ**（2026-06-12 監査）~~ → **2026-06-13 修正済**: ①`capacity.js taskHoursOn` を**営業日割り**化（`isBusinessDay`/`businessDays`・土日祝には負荷を載せず平日のみ等分・holidays Set 任意・全期間休日のみ暦割りフォールバック）。`loadByMember`/`weekLoadByMember`/`taskPlannedHoursByMemberOn` に `{holidays}` opt 追加（テスト+3=83件）。②本日系ビュー（home/today/availability）に `capacityFor=capacityOn(...)` を配線＝週末/祝日/休暇は容量0→新ステータス **`off`**（loadByMember が返す・「休/非稼働日」表示・availの0除算NaN解消）。week/weekstack は holidays 営業日割りのみ配線（週Mon-Fri表示のため per-day 容量0化は将来）。
- 据え置き(ADRで明記): 「本日=plan」完全一本化(due/範囲の暫定表示廃止・ADR-012)/定期occurrenceのmaterialize(ADR-011)/人別可変キャパ(時短)/AI Q&A(53)。
- TickTick関連(2026-06-13): 実測では通知/ポモ/習慣の利用ほぼゼロだったが、**ユーザー方針=「機能パリティ」**につき上記一式を実装済み。残る大物は **カレンダー同期(Google/CalDAV)** と **モバイル/PWA**。生データは `~/.local/share/ticktick-export/`（個人情報につきリポジトリ外）。

## 5. 運用 runbook
### フォークを直して再デプロイ（fixN 系の作り方）
ホストに Go 無し。**xgo不使用**＝docker golang:1.22 でネイティブビルド。frontend は `frontend/dist`（go:embed）。
**ブランド化はソース側**（`frontend/src` の大文字"Vikunja"→"TaskStation"・`src/assets/logo*.svg`/`public/favicon.*`・`src/urls.ts`）→ frontend再ビルドで dist に反映。
```bash
cd /home/neo/vendor/vikunja-fork/vikunja
# (ブランディング変更時のみ) frontend再ビルド: pnpm build → dist再生成 → 下のgo buildでembed
#   ※dist/が過去のdocker由来でroot所有なら先に: docker run --rm -v "$PWD/frontend":/w -w /w alpine rm -rf dist stats.html
docker run --rm -v "$PWD":/app -v vikunja-gocache:/go -w /app -e CGO_ENABLED=1 \
  golang:1.22 sh -c 'go build -buildvcs=false -ldflags "-s -w" -o vikunja .'
docker build -f Dockerfile.deploy -t leo-taskstation:0.24.6-fixN .   # 次は fix10
# 本番反映（必ず backup → image差し替え → recreate。migrationは起動時自動）
docker run --rm -v vikunja_vikunja-db:/from -v vikunja_vikunja-db-backup-fixN:/to alpine sh -c 'cp -a /from/. /to/'
# pm-trials/vikunja/docker-compose.yml の image: を新タグに編集
cd /home/neo/apps/pm-trials/vikunja && docker compose up -d --force-recreate
```
### テスト
```bash
cd /home/neo/vendor/vikunja-fork/vikunja
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
- **ガント**: 予定バー範囲は plans→start/end→due の階層(`taskRanges`)。依存は TaskStation が precedes 作成時に逆 follows も自動付与→`dependencyEdges` で前向き正規化＋重複除去。**ドラッグ編集**（2026-06-13）はこの source 階層を不変条件に使う＝plans があれば必ず plans バーが表示されるので「dates を動かして裏の plans がズレる」事故は起きない。plans バー移動は実エントリ(`task_time_plans`)を delta 日ずらす（start_minute/担当保持）。座標↔日付変換は純関数 `applyBarDrag`。
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
1. P2清掃: #8 日別バッチ取得(N+1)。（#5 members×projectusers・#6 est:Nh ラベル掃除 は 2026-06-12/13 消化済み）
2. AI Q&A(53) を別API化するか判断。
3. ガント追加（任意）: 依存違反の赤警告（dependencyEdges 流用）・21日窓の前後スクロール。※ドラッグ編集本体は 2026-06-13 完了。
4. TickTick差分の残り（任意）: アジェンダ日別グルーピング（スマートリストの日付ビュー）・手動ドラッグ並べ替え・カレンダー同期(Google/CalDAV)・PWA。※スマートリスト/概要/お気に入り(flag)は 2026-06-13 完了。
※入力UI(定期/祝日/休暇)＝`views/manage.js`・**#3 対象者選択(planner)＝logPlan に user_id**・土日祝の営業日割り＋本日系容量0 は 2026-06-13 完了。
