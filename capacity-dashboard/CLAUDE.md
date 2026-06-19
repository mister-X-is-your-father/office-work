# capacity-dashboard — 作業規約（最優先・必読）

このディレクトリ（capacity-dashboard SPA）での作業は、以下の**オーケストレーション契約に必ず従う**。
これは memory ではなく**指示**。毎回守る。SoT memory: `capacity-dashboard-orchestration-contract`。

## 役割分担（ハードルール）

- **指示役（メインの私）はコード実装をしない。小物でも委譲する。**
  - 過去にユーザーから複数回是正済み（2026-06-16「あなたが作業してるのはおかしい」、2026-06-19 再度）。
  - 「1行だから」「すぐ終わるから」は委譲しない理由にならない。**画面内で閉じる実装は必ずサブエージェントへ。**
- **指示役の仕事**＝指示の理解・分割・**精密な実装スペック作成**・サブエージェントへの割当・中央での検証（`node --check`＋ブラウザ playwright 目視）・**git commit/push**・**共有ファイルの最小調整**。
- **サブエージェント（画面エージェント）**＝担当 `views/xxx.js` ＋その `css()` だけ編集。**git/playwright/コミット禁止・共有ファイル編集禁止**。共有変更が要るときは指示役に報告（指示役が中央で直列適用）。並列で同種編集が走るときは worktree 隔離。

## 委譲の判断（実装着手前に必ず自問）

| 対象 | 担当 |
|---|---|
| `views/*.js` 1画面内で閉じる実装（その `css()` 含む） | **サブエージェントへ委譲**（指示役は書かない） |
| 共有＝競合点: `app.js`(ルート)・`index.html`(共通CSS)・`lib/*.js`(kinds/api/store/capacity/ui/form/routes/smartlist/history 等)・`taskform.js`・`recurrence(form).js` | 指示役が中央で直列編集（事前に一言・編集直前に再read） |
| 設計・スペック・統合・検証・commit/push | 指示役 |

実装タスクが来たら、**最初の判断は「これは views/*.js 内で閉じるか？ ならエージェントに渡す」**。スペックを書いて `Agent` で委譲する。

## 検証・コミット規約

- **ブラウザ目視必須**（ユーザー強い要望）。DOM チェックだけでなくスクショ/実操作で確認。console エラー 0。
- 配信 `http://leo:7010/app/`（ESM はフルリロードで反映）。API `http://leo:7005`。`lib` 変更時はユニットテストも回す。
- **指示1つ=1コミット**。検証が通ってから commit（WHY を本文に）。push はユーザー運用に従う。
- 状態変更（commit/push/書込）の成否は必ず実体で検証（`git rev-parse HEAD` / `cat-file` / `origin` 一致 / `ls`）。SoT: `feedback-tool-output-fabrication-and-verify`。複数行コミットは heredoc を使わず `git commit -F ファイル`。

## 呼称・前提

- 階層: **ワークスペース(=API project) ＞ プロジェクト(=親タスク) ＞ タスク**。「プロジェクト」は WS でなく親タスク。
- 実ユーザー=森田(id7)。詳細は memory 群（`capacity-dashboard-*`）。
