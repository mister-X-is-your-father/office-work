// ルート定義（ナビ＝app.js と 設定のメニュー表示制御＝settings.js で共有）。
// ここはデータのみ（副作用なし）。app.js は ROUTES/ORDER を import して shell()/route() を組み立てる。
// grp=ナビのグループ見出し / mod=動的 import 先 / wide=コンテンツ幅広げ / ic=アイコンキー(icons.js)。
export const ROUTES = {
  home:     { label: "ホーム",        grp: "総合",   mod: "./views/home.js", wide: true, ic: "home" },
  smart:    { label: "スマートリスト", grp: "総合",   mod: "./views/smartlist.js", ic: "listChecks" },
  today:    { label: "稼働予定",      grp: "今日",   mod: "./views/today.js", ic: "timer" },
  triage:   { label: "トリアージ",    grp: "今日",   mod: "./views/triage.js", ic: "filter" },
  quad:     { label: "優先度マトリクス", grp: "今日",   mod: "./views/quad.js", ic: "grid" },
  habits:   { label: "習慣",          grp: "今日",   mod: "./views/habits.js", ic: "flame" },
  review:   { label: "レビュー",      grp: "今日",   mod: "./views/review.js", ic: "eye" },
  calendar: { label: "時刻カレンダー",grp: "今日",   mod: "./views/calendar.js", wide: true, ic: "calendar" },
  monthcal: { label: "月カレンダー",  grp: "計画",   mod: "./views/monthcal.js", wide: true, ic: "calendarDays" },
  planner:  { label: "週プランナー",  grp: "計画",   mod: "./views/planner.js", wide: true, ic: "calendarDays" },
  workplan: { label: "稼働プラン",    grp: "計画",   mod: "./views/workplan.js", wide: true, ic: "hourglass" },
  keikaku:  { label: "計画ウィザード", grp: "計画",   mod: "./views/keikaku.js", wide: true, ic: "lightbulb" },
  summary:  { label: "概要",          grp: "実績",   mod: "./views/summary.js", wide: true, ic: "trendingUp" },
  activity: { label: "アクティビティ", grp: "実績",   mod: "./views/activity.js", wide: true, ic: "activity" },
  retro:    { label: "ふりかえり",    grp: "実績",   mod: "./views/retro.js", wide: true, ic: "trendingUp" },
  estactual:{ label: "見積りvs実績",  grp: "実績",   mod: "./views/estactual.js", wide: true, ic: "ruler" },
  report:   { label: "報告",          grp: "実績",   mod: "./views/report.js", wide: true, ic: "message" },
  status:   { label: "ステータス",    grp: "実績",   mod: "./views/status.js", wide: true, ic: "activity" },
  kanban:   { label: "かんばん",      grp: "仕事",   mod: "./views/kanban.js", wide: true, ic: "columns" },
  list:     { label: "タスク一覧",    grp: "仕事",   mod: "./views/table.js", wide: true, ic: "list" },
  // アウトラインは「タスク一覧」に統合（table.js が V.mode で表/アウトラインを切替）。
  // 後方互換: #/outline で来たら table.js が起動し、ハッシュに "outline" を含むのでアウトライン表示で開く。
  outline:  { label: "アウトライン",  grp: "仕事",   mod: "./views/table.js", wide: true, ic: "list" },
  depgraph: { label: "依存グラフ",    grp: "仕事",   mod: "./views/depgraph.js", wide: true, ic: "network" },
  gantt:    { label: "ガントチャート",    grp: "仕事",   mod: "./views/gantt.js", wide: true, ic: "barChart" },
  // 旧「定期業務・定期MTG」は後方互換ルートとして残す（recurring.js が hash で全件表示）が、ORDER には載せない。
  recurring:{ label: "定期業務・定期MTG", grp: "その他", mod: "./views/recurring.js", ic: "repeat" },
  // 定期を業務 / MTG の2項目に分割。どちらも recurring.js を読み、recurring.js 側が location.hash で出し分ける。
  "recurring-task":    { label: "定期業務", grp: "その他", mod: "./views/recurring.js", ic: "repeat" },
  "recurring-meeting": { label: "定期MTG",  grp: "その他", mod: "./views/recurring.js", ic: "calendar" },
  leave:    { label: "休暇",          grp: "その他", mod: "./views/leave.js", ic: "palmtree" },
  export:   { label: "バックアップ",   grp: "その他", mod: "./views/export.js", ic: "save" },
  // 旧「設定」は後方互換ルートとして残す（settings.js が hash で個人設定モードを描画）が、ORDER には載せない。
  settings: { label: "設定",          grp: "その他", mod: "./views/settings.js", ic: "settings" },
  // 設定を個人 / チームの2項目に分割。どちらも settings.js を読み、settings.js 側が location.hash で出し分ける。
  "settings-personal": { label: "個人設定", grp: "その他", mod: "./views/settings.js", ic: "user" },
  "settings-team":     { label: "チーム設定", grp: "その他", mod: "./views/settings.js", ic: "settings" },
  // 隠しルート: ORDER に載せない＝通常ユーザーのナビには出ない。許可者のみ shell() がリンクを追加。
  fable:    { label: "Fable",         grp: "AI",     mod: "./views/fable.js", ic: "bot" },
};
export const ORDER = ["home", "smart", "today", "triage", "quad", "habits", "review", "calendar", "monthcal", "planner", "workplan", "keikaku", "summary", "activity", "retro", "estactual", "report", "status", "kanban", "list", "depgraph", "gantt", "recurring-task", "recurring-meeting", "leave", "export", "settings-personal", "settings-team"];

// メニュー表示制御で「隠せない」必須ルート（誤って自分や他人を締め出さないための安全網）。
export const ALWAYS_VISIBLE = new Set(["home"]);
