# ハンドオフ: God 関数リファクタ（次の重い1本＝keikaku render 等）

> 作成: 2026-07-01。**コンテキスト無しで再開する人（自分含む）用**。対象: `capacity-dashboard` SPA。
> 直前の状態: HEAD=`9c95d97`（origin/main と一致・全 push 済）・lib **217 テスト緑**・作業ツリークリーン。

---

## 0. これは何のためのハンドオフか
「敵対的クリーンコードマン」で SPA の品質負債を掃除した（下記 §1）。**安全かつ高価値な clean-code はやり尽くした**。
残るのは**大きな God 関数の分割**で、これは1本ずつ腰を据えた専用タスクでやるべき（rush 厳禁）。
**次にやるのは keikaku.js の `render`（≈596行）の分割**。本書はその着手ガイド。

---

## 1. 直前セッションで完了済み（この続きで再実装しない）
clean-code 9 commit（`dd75227`→`9c95d97`）で以下を実施・全 push 済:
- **機能バグ F1 修正**（`46b305a`）: アウトラインのプロジェクト直下＋メニュー→入力遷移で外側クリック解除リスナが孤児化し、実クリックの「追加」で入力箱が自滅していた。`_olOnDown` で1つだけ管理し `closeInlineSubtask` で必ず解除。※ synthetic `.click()` は pointerdown が出ず再現しない＝**検証は実 pointer event で**。
- **capStatus 整合化**（`8f3d0cb`・挙動変更）: loadByMember の status を表示(round1)値で判定（today_items と一貫・「割当8/空き0/超過0 なのに over」解消）。
- **失敗の可視化**（`9c7682c`）: restoreTask を `{restored,errors}` 返却化＋table/smartlist の一括操作/undo/createLabel の無言握りつぶしを announce で通知。
- **gantt 936行 mount 分割**（`ed20857`）← **これが手法の実証（§3）**。
- dead-code削除/dowOf集約(5view)/taskHoursOn到達不能else/status・today恒等三項簡約/validate_and_clean抽出/holidayDataStatus配線 等（`ed5b412` `4a9b1fc` `f47ddf4` `19f1c30` `9c95d97`）。
- Python 堅牢化（URLError捕捉・valid_date厳格化・空行/重複localid警告）。
- 回帰テスト恒久化: `app/lib/ssot-equivalence.test.mjs`（SSoT集約=元実装をガード）＋`app/lib/hierarchy-adversarial.test.mjs`。
SoT メモ: `capacity-dashboard-quality-sweep-20260701`（自動メモリ）。

---

## 2. ⛔ やってはいけない（検証で判明・再挑戦禁止）
- **アクセント色(#3a86ff/#e5484d/#2fa66b)の CSS 変数(:root)化はしない**。`lib/ui.js:3-4` に設計理由が明記: これらは
  **SVG の stroke/fill 属性**で使われ（`depgraph.js:106/146` の依存辺・矢印、`gantt.js:549/553/559/560` の依存矢印）、
  **SVG 属性は `var()` を解決しない**＝変数化すると依存矢印の色が壊れる。かつ両テーマ共通でテーマ恩恵ゼロ。hex 据え置きが正しい。
- **keikaku-import.py `run()` のフェーズA/B/C分割は低価値**。全て HTTP orchestration で node 単体テスト不可・idmap を A→B→C で受け渡す密結合。清潔な部分(`validate_and_clean`)は抽出済（`19f1c30`）。ROI 低。

---

## 3. 実証済みの手法（gantt で成功したパターン）— これを踏襲する
巨大 `render`/`mount` から**純粋な文字列ビルダー（HTML を返すだけ・DOM 変異や onclick を持たない関数）**を
**モジュールスコープの独立関数へ持ち上げ**、クロージャで参照していた共有状態を **`ctx` オブジェクト1つに束ねて第1引数**で渡す。

gantt での具体（`app/views/gantt.js` の diff `ed20857` 参照）:
1. mount 内で共有状態が全部確定した後に `const ctx = { scale, byIdAll, today, tier, weekStart, rangeByTask, mode: state.mode };` を1度作る。
2. `gridHead/barsHTML/aggRange/aggBarHTML/memberTaskRow` を mount の外へ移動し、シグネチャ先頭に `ctx` を足し、本体の裸参照 `scale`→`ctx.scale` 等へ機械置換。**モジュールレベル参照(COL_W/DOW_JA/C/fmtH/esc 等)は触らない**（外でも見える）。
3. 全 call site を `ctx` 付きに更新。
4. **落とし穴（重要）**: `state.mode` はモード切替で **remount 無しに変異**する。1度きり snapshot だと切替後に陳腐化する→ `paint()` 冒頭で `ctx.mode = state.mode;` を毎回最新化して解決。**「再描画時に変わる状態」を ctx に入れる場合は、再描画の頭で更新する**のが鉄則。
5. **検証**: 裸参照残存を grep で0確認（残ると module スコープで `undefined` 実行時エラー）→ node --check → ブラウザで**全モード/全状態を網羅目視**（gantt は member/project 両モード・日/週単位・依存矢印まで）→ console エラー0。

---

## 4. 次の対象: `app/views/keikaku.js` の `render`（253-849・≈596行・総932行）
「計画の4ステップ」投入ウィザード（CSV/貼付→編集WBS表→投入）。gantt より **state と event 配線が重い**が、純ビルダーはある。

### 純ビルダー候補（HTML を返すだけ＝抽出しやすい）
`asgStatusHtml` / `msgHtml` / `summaryHtml` / `periodCellHtml`、および `renderTable`(433) と `renderReview`(571) が組む
テーブル/レビュー HTML の中の**純粋な行/セル生成部**。これらを `ctx`（下記候補）付きでモジュールへ。

### 混在して残すべきもの（painter/wire＝抽出しない or 別扱い）
`root.innerHTML = ...`（275）、各 `xxxEl.innerHTML = ...`（435/493/494/515/523/573/576/634/664/831 等）、
`.onclick`/`addEventListener`（329/449/598-600/605 等）、`runImport`(≈634)・進捗 `tick`(716) 等の副作用。
＝**imperative な配線と state 更新は render に残し、純ビルダーだけ持ち上げる**。

### ctx 候補（keikaku の共有状態。着手時に render 冒頭を Read して正確に確定すること）
`state`（asgInfo/rows 等）・`projects`・`day`・`prepScores`・`planId` 等。gantt 同様、**再描画で変わる state を ctx に入れるなら
再描画の頭で更新**（§3-4）。

### 着手手順（推奨）
1. `render` 全体（253-849）と `renderTable`/`renderReview` を Read し、**各内部関数を「純ビルダー / painter / wire」に3分類**。
2. 純ビルダーの**クロージャ依存を列挙**（gantt でやったように）→ ctx を設計。
3. **1つずつ**持ち上げ→ node --check→ ブラウザ検証→（区切りで）commit。一気にやらない。
4. keikaku は **capdemo 使い捨て WS で実機検証**（§6）。CSV 貼付→読込→WBS表編集→（dry-run 相当の）投入プレビューまで通す。

---

## 5. その他の God 関数の在庫（優先度/可否）
| 関数 | 行 | 可否 |
|---|---|---|
| `keikaku.js render` | 596 | **次これ**。純ビルダーあり・state重い |
| `table.js render` | 500 | timer 並行編集の激戦区＝worktree隔離/小rebase必須・慎重に |
| `pomodoro.js mountPomodoro` | 465 | timer 激戦区 |
| `home.js render` | 371 | **既に module scope に分解済**（todoBuckets/todoRow/bucketHtml 等）＝抽出余地小 |
| `report.js render` | 289 | 内部が `paintBuckets`/`paintText`＝**painter(DOM変異)**中心で純ビルダー少＝gantt手法が効きにくい |
| 些細: `heatLevel(pct)` | - | home:56/205, retro:21 の `pct<40?"low":pct<80?"mid":"high"` を共通化（ガードは各所別）。効果僅少 |

---

## 6. 検証・運用（必読・capacity-dashboard 固有）
- **委譲hook**: `views/*.js` はメイン(指示役)が直接編集禁止。`touch /tmp/cap-view-edit-allow` → `Agent` 委譲(子が編集) → 戻ったら `rm -f`。`lib/*.js`・`taskform.js`・`recurrenceform.js` は指示役が中央編集可。SoT: `capacity-dashboard/CLAUDE.md`。
- **lib テスト**: `cd capacity-dashboard && node --test app/lib/*.test.mjs`（現 217 緑）。lib 変更時必須。
- **ブラウザ検証**: 配信 `http://leo:7010/app/`、API `http://leo:7005`。ローカル playwright `mcp__playwright__*`（常駐 HTTP・落ちたら `systemctl --user restart playwright-mcp.service` → `/mcp`）。
  認証: `browser_evaluate` で `fetch(leo:7005/api/v1/login {capdemo/CapDemoPass123})`→`sessionStorage.setItem('taskstation_token',token)`→**`http://leo:7010/app/` にフルナビゲート**(ハッシュ変更だけだとログイン画面のまま)→ `#/keikaku` 等へ。
- **capdemo**: 使い捨て WS は `PUT /projects` で作り、検証後 `DELETE /projects/{id}` で必ず掃除。森田(id7)は capdemo WS 非所属＝`addAssignee(..,7)` は 403(正常)。assignee は capdemo(id1)=「自分」で。
- **commit**: 1論理変更=1commit。複数行メッセージは heredoc 可だが `git commit -F ファイル` が安全。状態変更は必ず実体検証（`git rev-parse HEAD`==origin）。捏造厳禁（メモリ `feedback-tool-output-fabrication-and-verify`）。
- **キーワード安全網**: keikaku.js を触るときは**マーカー正規表現/format が import.py と一致**していること（`keikaku-import.py:79 MARKER_RE` ↔ `keikaku.js markerRe()`／sanitizePlanId／EMPTY_DATE がバイト一致・2投入経路の冪等の生命線）。

---

## 7. 完了の定義（次タスク）
keikaku render の純ビルダーがモジュールスコープに出て、render が実質スリム化。**capdemo でウィザード全ステップ
（CSV/貼付→WBS表編集→投入プレビュー）が挙動不変・console0**。裸参照残存0・217+テスト緑。段階ごとに commit＋push。
