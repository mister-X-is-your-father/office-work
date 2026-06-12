import { test } from "node:test";
import assert from "node:assert/strict";
import { searchTasks } from "./search.js";

const T = [
  { id: 1, title: "DBマイグレーション", description: "本番のスキーマ更新", labels: [], done: false },
  { id: 2, title: "結合テスト", description: "DB含む", labels: [{ title: "c運用" }], done: false },
  { id: 3, title: "テスト計画レビュー", description: "", labels: [], done: true },
  { id: 4, title: "週次MTG", description: "", labels: [{ title: "会議" }], done: false },
];
const projOf = (t) => (t.id === 4 ? "チーム作業" : "開発");

test("タイトル先頭一致が最上位（完了減点より強い）", () => {
  const r = searchTasks(T, "テスト", { projOf });
  assert.deepEqual(r.map((t) => t.id), [3, 2]); // 先頭一致100-1=99 > 含む80
});

test("説明・分類・WS名にも当たる", () => {
  assert.equal(searchTasks(T, "スキーマ", { projOf })[0].id, 1);
  assert.equal(searchTasks(T, "会議", { projOf })[0].id, 4);
  assert.equal(searchTasks(T, "チーム", { projOf })[0].id, 4);
});

test("AND検索: 全語ヒットのみ", () => {
  const r = searchTasks(T, "テスト 計画", { projOf });
  assert.deepEqual(r.map((t) => t.id), [3]);
});

test("完了タスクは同点なら後ろ・空クエリは空配列", () => {
  assert.deepEqual(searchTasks(T, "", { projOf }), []);
  const r = searchTasks(T, "テスト", { projOf });
  assert.ok(r.findIndex((t) => t.id === 3) > r.findIndex((t) => t.id === 2) || r[0].id === 3);
});

test("入力タスクを変更しない", () => {
  const before = JSON.stringify(T);
  searchTasks(T, "テスト", { projOf });
  assert.equal(JSON.stringify(T), before);
});

test("limit", () => {
  assert.equal(searchTasks(T, "テスト", { projOf, limit: 1 }).length, 1);
});
