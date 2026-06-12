import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSmartDate, fmtDisplay, fmtDisplayDow, splitMeta, joinMeta, monthMatrix } from "./form.js";

const Y = new Date().getFullYear();

test("parseSmartDate: 数字スマート入力", () => {
  assert.equal(parseSmartDate("62"), `${Y}-06-02`);
  assert.equal(parseSmartDate("612"), `${Y}-06-12`);
  assert.equal(parseSmartDate("1112"), `${Y}-11-12`);
  assert.equal(parseSmartDate("6/12"), `${Y}-06-12`);
  assert.equal(parseSmartDate("2026/11/12"), "2026-11-12");
  assert.equal(parseSmartDate("2026-11-12"), "2026-11-12");
  assert.equal(parseSmartDate("20261112"), "2026-11-12");
});

test("parseSmartDate: 不正値は null", () => {
  assert.equal(parseSmartDate(""), null);
  assert.equal(parseSmartDate("abc"), null);
  assert.equal(parseSmartDate("1340"), null); // 13月
  assert.equal(parseSmartDate("232"), null);  // 2月32日
});

test("fmtDisplay: ISO → YYYY/MM/DD", () => {
  assert.equal(fmtDisplay("2026-06-12"), "2026/06/12");
});

test("fmtDisplayDow: 曜日付き表示 ⇄ parseSmartDate で読み戻せる", () => {
  assert.equal(fmtDisplayDow("2026-06-15"), "2026/06/15（月）");
  assert.equal(fmtDisplayDow("2026-06-14"), "2026/06/14（日）");
  assert.equal(parseSmartDate("2026/06/15（月）"), "2026-06-15");
  assert.equal(parseSmartDate("2026/06/15(月)"), "2026-06-15"); // 半角括弧も許容
});

test("monthMatrix: 日曜始まり6週・月内フラグ", () => {
  const m = monthMatrix(2026, 6); // 2026年6月: 6/1=月曜
  assert.equal(m.length, 6);
  assert.equal(m[0][0].iso, "2026-05-31"); // 先頭=直前の日曜
  assert.equal(m[0][0].inMonth, false);
  assert.equal(m[0][1].iso, "2026-06-01");
  assert.equal(m[0][1].inMonth, true);
  // 全行7日・6/30 が月内最後
  assert.ok(m.every((w) => w.length === 7));
  assert.ok(m.flat().some((c) => c.iso === "2026-06-30" && c.inMonth));
  assert.ok(!m.flat().some((c) => c.iso === "2026-07-01" && c.inMonth));
});

test("splitMeta/joinMeta: [資料]・[ゴール] の往復", () => {
  const desc = joinMeta("本文です", "レビュー承認済み", ["https://example.com/spec", "\\\\share\\docs\\手順書.xlsx"]);
  const { text, goal, links } = splitMeta(desc);
  assert.equal(text, "本文です");
  assert.equal(goal, "レビュー承認済み");
  assert.deepEqual(links, ["https://example.com/spec", "\\\\share\\docs\\手順書.xlsx"]);
});

test("splitMeta: 空・資料のみ・本文のみ", () => {
  assert.deepEqual(splitMeta(""), { text: "", goal: "", links: [], checks: [] });
  const onlyDocs = splitMeta("[資料] https://a.example\n[資料] https://b.example");
  assert.equal(onlyDocs.text, "");
  assert.deepEqual(onlyDocs.links, ["https://a.example", "https://b.example"]);
  assert.deepEqual(splitMeta("メモだけ"), { text: "メモだけ", goal: "", links: [], checks: [] });
  // links 無しの joinMeta は本文そのまま
  assert.equal(joinMeta("メモだけ", "", []), "メモだけ");
});

test("splitMeta/joinMeta: [チェック] の往復（ゴール/資料と共存・順序不問）", () => {
  const checks = [{ text: "設計レビュー", done: true }, { text: "テスト追加", done: false }];
  const desc = joinMeta("本文", "完了条件", ["https://a.example"], checks);
  const r = splitMeta(desc);
  assert.equal(r.text, "本文");
  assert.equal(r.goal, "完了条件");
  assert.deepEqual(r.links, ["https://a.example"]);
  assert.deepEqual(r.checks, checks);
  // マーカー順が逆でも読める（チェック→ゴール）
  const rev = splitMeta("[チェック]\n- [x] a\n[ゴール]\nゴール文");
  assert.deepEqual(rev.checks, [{ text: "a", done: true }]);
  assert.equal(rev.goal, "ゴール文");
});

test("splitMeta: [チェック] 内の手書き行は未完項目として拾う（消失防止）", () => {
  const r = splitMeta("[チェック]\n- [ ] 正規\n手書きの行");
  assert.deepEqual(r.checks, [{ text: "正規", done: false }, { text: "手書きの行", done: false }]);
});
