// タスクのステータス遷移（未着手 todo / 進行中 doing / 完了 done）の scalar patch SSoT。
// table.js・kanban.js・smartlist.js が同一の patch 生成を再実装していたのを集約（横断監査 Q9）。
//
// 設計（現挙動を1pxも変えない）:
// - keepPct: 完了済 or 進捗100%以上のタスクを再オープンするときは % を 0 に戻し、それ以外は現 % を温存。
// - doing: 着手時刻(started_at)を「今」立てる。% は keepPct（捏造しない）。
// - done: %=100。started_at は view により扱いが異なるため keepStartedOnDone で吸収
//     （kanban=温存 t.started_at||null / table・smartlist=patch に started_at を含めない）。
// - todo: 未完了化＋ % 0 ＋ started_at を下ろす。
//
// ⚠️ waiting（連絡待ち）は含めない。各 view 固有（updateTask を呼ぶ/呼ばない・ラベル on/off・
//    保持する % が異なる）ため、waiting 分岐は各 view 側に残す。
// ⚠️ taskform.js はフォーム編集中の値（stPct/stStartedAt）を使う別系統のため対象外。

// key: "todo" | "doing" | "done"
// task: 現タスク（done / percent_done / started_at を参照）
// opts.keepStartedOnDone: 完了時に started_at を温存するか（kanban=true、table/smartlist=false）
// opts.now: 進行中の started_at に使う現在時刻関数（テスト用に注入可。既定= new Date().toISOString()）
export function statePatchFor(key, task, { keepStartedOnDone = false, now = () => new Date().toISOString() } = {}) {
  const t = task || {};
  const keepPct = (t.done || (t.percent_done || 0) >= 100) ? 0 : (t.percent_done || 0);
  if (key === "done") {
    return keepStartedOnDone
      ? { done: true, percent_done: 100, started_at: t.started_at || null }
      : { done: true, percent_done: 100 };
  }
  if (key === "doing") return { done: false, percent_done: keepPct, started_at: now() };
  return { done: false, percent_done: 0, started_at: null }; // todo
}
