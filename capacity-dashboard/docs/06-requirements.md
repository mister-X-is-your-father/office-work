# 要件定義 — Capacity Board

> status: **確定 v1**（2026-06-10・ユーザー確認済み6項目）。基盤固め（非UI先行・DB規範まで徹底）の着手要件。
> 次の人が読む前提。前提資料は [00-design-philosophy](00-design-philosophy.md) / [01-decisions](01-decisions.md)(ADR) / [02-screens](02-screens.md) / [03-integration-plan](03-integration-plan.md) / [04-feasibility](04-feasibility.md) / [05-time-tracking-fork](05-time-tracking-fork.md)。
> 本書は「何を・なぜ・どの品質で」を定義する。実装手順ではない（手順は別途プラン）。

---

## 0. 背景と本書の位置づけ

[00-design-philosophy](00-design-philosophy.md) の v0.1 は **「Vikunja本体は触らずAPI越しのオーバーレイ」**（[ADR-002](01-decisions.md)）を前提にしていた。その後 **実績時間トラッキングに限り fork を許可**（[ADR-006](01-decisions.md)）し、見積り/実績/予定を fork の DB にネイティブ実装して本番稼働まで到達した。

本書はそこからの**方針の進化**を確定する：

> **開発モデル＝「Vikunjaをカスタム → フォーク上で動作確認 → オリジナル機能・オリジナルUIへ昇格」**。
> 機能はまずフォーク内で孵化させ、TDD＋e2eで証明できたら自前の製品（SPA）へ巣立たせる。

これは ADR-002 の「fork しない」から、**「fork を“孵化器”として積極利用し、抽象境界越しに自前製品へ昇格させる」**への転換であり、[§5 昇格モデル](#5-昇格モデル成熟度パイプライン) で定義する。ADR-002 を更新する **ADR-007 候補**（[§8](#8-未決事項adr候補)）。

**本書の狙い（このフェーズの要望）**：UIより先に**非UI基盤（フォークのデータモデル＋API＋計算層）を、CLAUDE.md の DB 規範まで含めて徹底的に固める**。堅牢に。TDD＋e2e で。

### 0.1 確定事項（2026-06-10・一問一答で確認）

| # | 論点 | 確定 |
|---|---|---|
| 1 | フェーズスコープ | **データ基盤(FR-D)＋計算層(FR-C)＋§7監査のみ**。ビュー(FR-V7/8/9)は本フェーズ非スコープ |
| 2 | 品質ゲート | **§5 フルゲート採用**（S1 schema-first+契約+unit+rollback／S2 隔離e2e+PWモンキー+回帰ゼロ／S3 純関数TDD+snapshot+SPA e2e） |
| 3 | 着手順 | **P0=#1 → P1=#2,#3,#4,#7 → P2=#5,#6,#8** |
| 4 | 自前テーブルID | **bigint autoincr（Vikunja踏襲）**。UUID v7 は本fork適用外として記録 |
| 5 | #1 書き込み破壊性 | **まず深掘り調査（`pkg/models/tasks.go` の Update）→ ADR-008 を根拠つきで確定**。決め打ちしない |
| 6 | #3 帰属 | **`user_id`=対象者（誰の予定/実績）＋ `created_by`=記録者** を明示的に持つ（代理入力でも正確） |

---

## 1. 解きたい課題（不変）

少人数チーム（2〜4名）で、市販OSSのPM/タスクツールが苦手とする一点を埋める：

> **「今日、誰にどれだけ空きがあるか／誰に振れるか」＋「予定と実績がどれだけ合っているか」を一目で。**

Instagantt の Workload 相当を **OSS・自前ホスト（データ主権）** で。タスクの箱は Vikunja、不在の「人別・日別キャパ可視化」を自前で足す（[ADR-001](01-decisions.md)）。

---

## 2. 利用者・体制・スコープ

| 項目 | 内容 |
|---|---|
| 利用者 | チーム2〜4名。差配する人（PM/リーダー）が主、各メンバーが従 |
| 規模前提 | タスク数〜数百、メンバー〜10。大規模同時実行は非要件 |
| データ主権 | 自前ホスト必須。外部SaaSにタスク実体を預けない |

**スコープ内**：見積り/実績/予定の管理（fork）、人別・日別キャパ可視化、予実、ガント、トリアージ、設定。
**スコープ外（当面）**：マルチテナント本格運用、休暇/祝日/勤務時間帯の精緻なカレンダー、外部認証連携、Vikunja UI そのものの作り込み（昇格後はオリジナルUIに寄せるため）。

---

## 3. 機能要件（FR）

> 状態凡例：✅稼働 / 🟡部分 / ⬜未着手。各FRは最終的に「どのステージまで昇格済みか」（[§5](#5-昇格モデル成熟度パイプライン)）を持つ。

### 3.1 データ基盤（fork が持つべき能力）
| ID | 要件 | 状態 | 備考 |
|---|---|---|---|
| FR-D1 | タスクに**見積り**を実カラムで持つ（`tasks.time_estimate`） | ✅ | ADR-006。`est:Nh`ラベルは卒業（[§6](#6-データモデル要件)で残存ラベルの掃除） |
| FR-D2 | **実績**を日別worklogで持ち合計をcomputed（`task_time_entries`/`time_spent`） | ✅ | フルCRUD API |
| FR-D3 | **予定**を日別で持ち合計をcomputed（`task_time_plans`/`time_planned`） | ✅ | フルCRUD API（GET/PUT/POST/DELETE） |
| FR-D4 | 予定/実績を **(task, user, day)** 粒度で集計できる | 🟡 | 帰属の真実が未確立（[§6](#6-データモデル要件)・FR-D5） |
| FR-D5 | 予定/実績に**「誰の」**を正しく持つ：`user_id`=対象者・`created_by`=記録者 | ✅ | **完了(#3, ADR-009)**: fork に created_by 追加・user_id を対象者として API 設定可。SPA 配線は次パス |
| FR-D6 | タスクの**スケジュール枠**（start/end）と**依存**（related_tasks）を持つ | ✅ | Vikunja標準。デモ投入済（`seed-gantt-demo.py`） |
| FR-D7 | 上記すべてが **soft delete・created/updated/deleted_at** を備える | ✅ | **完了(#2)**: times/plans に `deleted_at`、Delete soft化、SUM除外。`leo-vikunja:0.24.6-timetracking-fix2` |
| FR-D8 | 書き込みが**非破壊**（部分更新で無関係データを消さない） | ⬜ | `POST /tasks/:id` がassignees等を空上書き＝**最重要バグ**（ADR候補） |

### 3.2 計算層（capacity.js・純関数・単一真実）
| ID | 要件 | 状態 | 備考 |
|---|---|---|---|
| FR-C1 | 空き/超過/満（人別・指定日の負荷） | ✅ | `loadByMember` |
| FR-C2 | 週の人別×日 負荷 | ✅ | `weekLoadByMember` |
| FR-C3 | 見積り vs 実績 | ✅ | `estimateVsActual` |
| FR-C4 | トリアージ分類（must/should/movable） | ✅ | `triage` |
| FR-C5 | 予定/実績の人別日別集計 | ✅ | `sumByMemberDay`/`toMemberDayEntries` |
| FR-C6 | ガントの範囲・依存・日付軸 | ✅ | `taskRanges`/`dependencyEdges`/`dayScale` |
| FR-C7 | **負荷計算の単一真実** — 予定(plans)があればそれを、無ければ見積り日割りを使う、を全ビューで統一 | ✅ | **完了(#4)**: `taskPlannedHoursByMemberOn` で plans 優先・全員フル。today/home/week が plansByTask を共有。多担当(会議含む)は全員にフル |

### 3.3 製品ビュー（SPA・オリジナルUI）
| ID | 要件 | 状態 | 代表モック |
|---|---|---|---|
| FR-V1 | 総合ホーム | ✅ | — |
| FR-V2 | 今日の空き探し | ✅ | 54 |
| FR-V3 | トリアージ | ✅ | 46 |
| FR-V4 | 週プラン / 週プランナー（予定×実績・読み書き） | ✅ | 18 |
| FR-V5 | 見積りvs実績 | ✅ | 23 |
| FR-V6 | **予実ガント**（タスク行＋人別レーン） | ✅ | 29/30 |
| FR-V7 | かんばん / 一覧 / 設定 | ⬜ | 59/60/17 |
| FR-V8 | 容量・対象プロジェクトの**設定**（8h/日のハードコード解消） | ⬜ | 17。これが入るまで全ビューが「デモ専用」 |
| FR-V9 | AI Q&A（自然文要約） | ⬜ | 53。別API要・保留 |

---

## 4. 非機能要件（NFR）— 堅牢性が最優先

| ID | 要件 | 基準 |
|---|---|---|
| NFR-1 **堅牢性/データ整合** | 書き込みは非破壊・冪等。制約/インデックス/外部キーで不正状態を作らせない | DB規範（[§6](#6-データモデル要件)）準拠。破壊的更新ゼロ |
| NFR-2 **テスト** | テストピラミッド Unit80 / Integration15 / E2E5。純関数はTDD、schemaはschema-first＋契約テスト、e2eは探索的 | [§5](#5-昇格モデル成熟度パイプライン)の品質ゲートを全昇格で通す |
| NFR-3 **可搬性/データ主権** | 重要依存（Vikunja＝Storage/Task）は**抽象境界越し**（`vikunja.js`）。将来差し替え可能性を確保 | CLAUDE.md「abstraction越し」 |
| NFR-4 **追従性** | fork は小差分・1機能単位に閉じ、本家rebaseを殺さない | 新規ファイル＋最小編集。rollback経路必須 |
| NFR-5 **可観測性** | 本番差し替えは volume バックアップ＋rollback手順つき。migrationは起動時自動かつ可逆 | HANDOFF §5 runbook |
| NFR-6 **性能** | 数百タスク規模で実用速度。N+1は許容するが、肥大化したらバッチ取得を足す | 体感即時。閾値超過で `GET /projects/:id/timeline` 等を検討 |

---

## 5. 昇格モデル（成熟度パイプライン）

機能は3ステージを通って「フォークの実験」から「自前製品」へ昇格する。各ステージは**品質ゲート（通過条件）**を持ち、満たさなければ次へ進めない。

| ステージ | やること | 成果物 | 品質ゲート（TDD＋e2e） | 場所 |
|---|---|---|---|---|
| **S1 孵化** | Vikunjaフォークに能力を足す（DBスキーマ＋API） | migration / model / route / fixture | schema-first＋契約テスト・`pkg/models`ユニット全green・**rollback経路**・DB規範準拠 | `/home/neo/vikunja-fork/` |
| **S2 検証** | フォーク上で動作確認（本番に触れず） | 隔離検証ログ | 使い捨てsqlite別ポートでe2e・**Playwrightモンキー(Vikunja UI)**・`pkg/models`回帰ゼロ | leo:7011等 |
| **S3 昇格** | 自前機能・自前UI(SPA)へ巣立つ。Vikunjaを抽象境界越しに使う | `capacity.js`/`views/*`/`vikunja.js` | **純関数TDD**・view snapshot・**SPA Playwright e2e**・回帰ゼロ | `capacity-dashboard/app/` |

**原則**：
- S1→S2→S3 を飛ばさない。S2を通らない能力をUIに出さない。
- S3の昇格時、Vikunja依存は必ず `vikunja.js`（クライアント）と `capacity.js`（計算）の境界に閉じる（NFR-3）。
- 「オリジナルUIへ昇格」＝最終的にユーザーは Vikunja UI ではなく SPA を触る。Vikunja UI は S2 検証の道具。

> この昇格モデルは ADR-002（fork しない）を更新する。**ADR-007 として正式化**する（[§8](#8-未決事項adr候補)）。

---

## 6. データモデル要件（fork を DB 規範まで固める）

CLAUDE.md の DB conventions を fork の自前テーブルに適用する。Vikunja由来の制約（ID=bigint autoincr 等）は踏襲しつつ、**自前で足した部分は規範に寄せる**。

| 規範 | 現状 | 充足 | 対応方針 |
|---|---|---|---|
| 全tableに `created_at`/`updated_at`/`deleted_at`(soft delete) | times/plans に `deleted_at` 追加済（#2・ADR後）。Delete はsoft化、SUMは `deleted_at IS NULL` 除外 | ✅ | **完了(#2)**。tasks 本体等は upstream 管轄 |
| 帰属（誰のデータか） | plans/timesの`UserID`は作成者。代理入力で全部capdemoに | ✅ | **完了(#3)**: `user_id`=対象者・`created_by`=記録者（ADR-009/A）。SPA 送信は次パス |
| 書き込みの非破壊性 | `POST /tasks/:id`が無関係列(assignees)を空上書き | ❌ | 部分更新の安全化。FR-D8（ADR候補） |
| 負荷の単一真実 | today/week=見積り日割り、planner/gantt=plans の二系統 | ✅ | **完了(#4)**: plans優先・無ければ見積り・全員フルで統一。多担当(会議)=全員フル |
| データの二重表現の排除 | `time_estimate`カラムと`est:Nh`ラベルが併存 | 🟡 | 残存ラベルを掃除（移行で一括変換済みのはずの取りこぼし） |
| ID=UUID v7 | Vikunjaはbigint autoincr | — | **確定**: Vikunja踏襲（bigint autoincr）。JOIN/idiom一貫・rebase追従のためUUID v7は本fork適用外 |
| snake_case / 命名 | 準拠 | ✅ | — |
| Enum=CHECK制約 | 該当なし（relation_kind等はVikunja側） | — | 新規enumを足す時はCHECK |

---

## 7. 現状監査（基盤の穴・優先度）

実ファイル確認済み。深刻度＝🔴高/🟠中/🟡低。

| # | 穴 | 深刻度 | 対応FR | 種類 |
|---|---|---|---|---|
| 1 | ~~`POST /tasks/:id` がassignees/reminders を空上書き~~ **完了(ADR-008 nilガード)** | ✅ | FR-D8 | fork |
| 2 | ~~times/plans に soft delete 無し~~ **完了** | ✅ | FR-D7 | fork schema |
| 3 | ~~予定/実績の帰属が作成者依存~~ **完了** | ✅ | FR-D5 | model設計 |
| 4 | ~~負荷計算が二系統（見積り/plans）~~ **完了** | ✅ | FR-C7 | 計算層 |
| 7 | ~~assignees消去を捕まえるテストが無い~~ **完了(#1で回帰テスト追加)** | ✅ | NFR-2 | テスト |
| 9 | ~~`POST /tasks/:id` がスカラを空上書き~~ **完了(client: `updateTask` full-send)**。fork のスカラ全置換は意図仕様として維持、SPA を非破壊な full-send に。`setEstimate` を載せ替え | ✅ | — | client |
| 5 | members=assigneesの和（projectusers未統合） | 🟡 | — | データソース |
| 6 | `est:Nh`ラベルが`time_estimate`と二重残存 | 🟡 | — | データ整合 |
| 8 | 日別内訳のバッチ取得が無い（N+1） | 🟡 | NFR-6 | API |

**推奨着手順（DB規範まで徹底の前提）**：~~P0=#1 → P1=#2,#3,#4,#7 → #9~~ 完了 → **残り P2=#5,#6,#8**。
各対応は [§5](#5-昇格モデル成熟度パイプライン) のステージを通す（特にfork変更 は S1→S2 を必ず経由）。

---

## 8. 未決事項（ADR候補）

| 候補 | 論点 | 状態 |
|---|---|---|
| **ADR-007 昇格モデル** | ADR-002「forkしない」を「forkを孵化器に→昇格」へ更新 | **方向確定（A=本書§5を正式化）**。残作業=ADR化のみ |
| **ADR-008 書き込み安全化(#1)** | assignees消去をどう根治するか | **未確定**。(A)forkで`Task.Update`を部分更新化（根治） / (B)client側復元ラッパ（対症） → **まず`pkg/models/tasks.go`を深掘り調査→根拠つきで確定** |
| **ADR-009 予定/実績の帰属(#3)** | 「誰の予定/実績か」をどう持つか | **実装済み（#3）**: `user_id`=対象者・`created_by`=記録者。fork＋計算層 完了、SPA配線は次パス |

---

## 9. 次アクション

1. ~~本書 v0 をレビュー・赤入れ~~ → **完了（§0.1 で6項目確定）**。
2. **ADR-007（昇格モデル）** を `01-decisions.md` に正式化（ADR-002 を更新）。同時に **ADR-009（帰属/A）** も確定記録。
3. **P0=#1 の深掘り調査**：`pkg/models/tasks.go` の `Task.Update`（assignees/labels/reminders 更新処理）を読み、部分更新化の影響範囲を把握 → **ADR-008 を根拠つきで確定**。
4. 以降は §7 推奨順（#1 → #2,#3,#4,#7 → #5,#6,#8）に、各々 §5 のステージ＋フルゲートを通して進める。fork変更(#1,#2,#3)は S1→S2 必須。
