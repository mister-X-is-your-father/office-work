import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSmartDate, fmtDisplay, splitMeta, joinMeta } from "./form.js";

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

test("splitMeta/joinMeta: [資料]・[ゴール] の往復", () => {
  const desc = joinMeta("本文です", "レビュー承認済み", ["https://example.com/spec", "\\\\share\\docs\\手順書.xlsx"]);
  const { text, goal, links } = splitMeta(desc);
  assert.equal(text, "本文です");
  assert.equal(goal, "レビュー承認済み");
  assert.deepEqual(links, ["https://example.com/spec", "\\\\share\\docs\\手順書.xlsx"]);
});

test("splitMeta: 空・資料のみ・本文のみ", () => {
  assert.deepEqual(splitMeta(""), { text: "", goal: "", links: [] });
  const onlyDocs = splitMeta("[資料] https://a.example\n[資料] https://b.example");
  assert.equal(onlyDocs.text, "");
  assert.deepEqual(onlyDocs.links, ["https://a.example", "https://b.example"]);
  assert.deepEqual(splitMeta("メモだけ"), { text: "メモだけ", goal: "", links: [] });
  // links 無しの joinMeta は本文そのまま
  assert.equal(joinMeta("メモだけ", "", []), "メモだけ");
});
