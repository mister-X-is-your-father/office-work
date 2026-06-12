// 全文検索（純関数・DOM非依存）。タイトル/説明/分類ラベル/WS名を横断して部分一致でランク付け。
// ランク: タイトル先頭一致 > タイトル含む > 分類一致 > WS一致 > 説明含む。完了は同点なら後ろ。
// クエリは空白区切りのAND（全語がどこかに当たれば採用）。大文字小文字は無視。入力タスクは変更しない。

const norm = (s) => String(s || "").toLowerCase();

function fields(t, projName) {
  return {
    title: norm(t.title),
    labels: (t.labels || []).map((l) => norm(l.title)),
    desc: norm(t.description),
    proj: norm(projName),
  };
}

function wordScore(f, w) {
  if (f.title.startsWith(w)) return 100;
  if (f.title.includes(w)) return 80;
  if (f.labels.some((l) => l.includes(w))) return 60;
  if (f.proj.includes(w)) return 50;
  if (f.desc.includes(w)) return 30;
  return 0;
}

// projOf: (task) => WS名（projectName 解決は呼び出し側の関数で）
export function searchTasks(tasks, query, { limit = 20, projOf = () => "" } = {}) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const t of tasks || []) {
    const f = fields(t, projOf(t));
    let score = 0, ok = true;
    for (const w of words) {
      const s = wordScore(f, w);
      if (!s) { ok = false; break; }
      score += s;
    }
    if (ok) hits.push({ t, score: score - (t.done ? 1 : 0) });
  }
  hits.sort((a, b) => b.score - a.score || norm(a.t.title).localeCompare(norm(b.t.title), "ja"));
  return hits.slice(0, limit).map((h) => h.t);
}
