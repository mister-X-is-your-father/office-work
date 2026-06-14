import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd } from "./quickadd.js";

// 2026-06-12 = 金曜
const T = { today: "2026-06-12" };
const p = (s) => parseQuickAdd(s, T);

test("基本: タイトルのみ", () => {
  const r = p("MTG準備");
  assert.equal(r.title, "MTG準備");
  assert.equal(r.dateISO, null);
  assert.equal(r.startMinute, null);
});

test("TickTick実例: 明日15時 MTG準備 #仕事", () => {
  const r = p("明日15時 MTG準備 #仕事");
  assert.equal(r.title, "MTG準備");
  assert.equal(r.dateISO, "2026-06-13");
  assert.equal(r.startMinute, 15 * 60);
  assert.deepEqual(r.labels, ["仕事"]);
});

test("フル構文: 日付 時刻 分類 優先度 見積 WS 担当", () => {
  const r = p("6/20 10:30 リリース判定 #c運用 !高 1.5h >チーム作業 @森田");
  assert.equal(r.title, "リリース判定");
  assert.equal(r.dateISO, "2026-06-20");
  assert.equal(r.startMinute, 10 * 60 + 30);
  assert.deepEqual(r.labels, ["c運用"]);
  assert.equal(r.priority, 3);
  assert.equal(r.estimateH, 1.5);
  assert.equal(r.ws, "チーム作業");
  assert.equal(r.assignee, "森田");
});

test("日付語: 今日/明後日/N日後/過去M\\/Dは翌年", () => {
  assert.equal(p("今日 x").dateISO, "2026-06-12");
  assert.equal(p("明後日 x").dateISO, "2026-06-14");
  assert.equal(p("3日後 x").dateISO, "2026-06-15");
  assert.equal(p("1/15 x").dateISO, "2027-01-15"); // 過去日→翌年繰上げ
});

test("曜日: 直近（今日含む）と来週", () => {
  assert.equal(p("金曜 x").dateISO, "2026-06-12");  // 今日が金曜→今日
  assert.equal(p("月曜日 x").dateISO, "2026-06-15"); // 次の月曜
  assert.equal(p("来週金曜 x").dateISO, "2026-06-19"); // 翌週の金曜
  assert.equal(p("来週日曜 x").dateISO, "2026-06-21"); // 週は月曜始まり→翌週末
});

test("時刻のみ→今日 / 15時半 / 不正時刻は消費しない", () => {
  const r = p("15時半 振り返り");
  assert.equal(r.dateISO, "2026-06-12");
  assert.equal(r.startMinute, 15 * 60 + 30);
  assert.equal(p("99時 x").title, "99時 x"); // 不正→タイトル残留
});

test("見積: 30m / 2時間半 / 異常値は無視", () => {
  assert.equal(p("30m x").estimateH, 0.5);
  assert.equal(p("2時間半 x").estimateH, 2.5);
  assert.equal(p("99h x").estimateH, 0); // 上限超→タイトル扱い
});

test("優先度: !MUST / !最優先 と 全角！低", () => {
  assert.equal(p("!MUST x").priority, 4);
  assert.equal(p("!最優先 x").priority, 4); // 旧表記も後方互換で受理
  assert.equal(p("！低 x").priority, 1);
});

test("部分一致は消費しない（予測可能性）", () => {
  assert.equal(p("15時の件を相談").title, "15時の件を相談");
  assert.equal(p("612 メモ").title, "612 メモ"); // 数字だけは日付にしない
  assert.equal(p("明日の会議メモ").title, "明日の会議メモ"); // 文中の明日は温存
});

test("URL: 裸URLとMarkdownリンクは資料へ", () => {
  const r = p("[設計資料](https://example.com/doc) 確認 https://example.com/2");
  assert.equal(r.title, "設計資料 確認");
  assert.deepEqual(r.links, ["https://example.com/doc", "https://example.com/2"]);
});

test("全角正規化: ＃タグ・１５：３０", () => {
  const r = p("＃会議 １５：３０ 準備");
  assert.deepEqual(r.labels, ["会議"]);
  assert.equal(r.startMinute, 15 * 60 + 30);
  assert.equal(r.title, "準備");
});

test("複数ラベル", () => {
  assert.deepEqual(p("#a #b x").labels, ["a", "b"]);
});
