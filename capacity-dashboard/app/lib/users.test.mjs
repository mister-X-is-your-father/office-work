import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_USERNAMES, isAiUser, humanAssignees, firstHuman } from "./users.js";

test("isAiUser: fable は AI、人間は false、null安全", () => {
  assert.equal(isAiUser({ username: "fable" }), true);
  assert.equal(isAiUser({ username: "morita" }), false);
  assert.equal(isAiUser(null), false);
  assert.equal(isAiUser(undefined), false);
  assert.equal(isAiUser({}), false); // username 無し
  assert.ok(AI_USERNAMES.has("fable"));
});

test("humanAssignees: AI(fable)を除外、assignees欠落は空配列", () => {
  const t = { assignees: [{ id: 1, username: "morita" }, { id: 9, username: "fable" }, { id: 2, username: "sato" }] };
  assert.deepEqual(humanAssignees(t).map((a) => a.id), [1, 2]);
  assert.deepEqual(humanAssignees({}), []);
  assert.deepEqual(humanAssignees({ assignees: [{ id: 9, username: "fable" }] }), []);
});

test("firstHuman: 人間担当の先頭、居なければ null", () => {
  assert.equal(firstHuman({ assignees: [{ id: 9, username: "fable" }, { id: 1, username: "morita" }] }).id, 1);
  assert.equal(firstHuman({ assignees: [{ id: 9, username: "fable" }] }), null);
  assert.equal(firstHuman({}), null);
});
