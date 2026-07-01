// 敵対的 回帰テスト: 階層の純関数 buildTaskTree / projectAncestor が病的構造でも
// 無限ループ・クラッシュ・破綻しないことを保証（循環/自己親/多重親/深いネスト/欠落参照）。
// タスクグループ階層機能（プロジェクト＞グループ任意＞タスク）の整合性ガードの回帰。
// 由来: 2026-07-01 の整合性 敵対テスト（28 checks 全合格）を恒久化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskTree, projectAncestor } from "./capacity.js";

const mkSub = (id, subIds) => ({ id, title: "T" + id, related_tasks: { subtask: subIds.map((s) => ({ id: s })) } });
const mkPar = (id, parId) => ({ id, title: "T" + id, related_tasks: parId == null ? {} : { parenttask: [{ id: parId }] } });
const mkParSub = (id, parId, subIds) => ({ id, title: "T" + id, related_tasks: { ...(parId == null ? {} : { parenttask: [{ id: parId }] }), subtask: subIds.map((s) => ({ id: s })) } });
const byIdOf = (list) => new Map(list.map((t) => [t.id, t]));

test("buildTaskTree: 相互/3要素循環でも終了しroot無し=[]", () => {
  assert.equal(buildTaskTree([mkSub(1, [2]), mkSub(2, [1])]).length, 0);
  assert.ok(Array.isArray(buildTaskTree([mkSub(1, [2]), mkSub(2, [3]), mkSub(3, [1])])));
});

test("buildTaskTree: 自己subtaskは子に自分を含めない", () => {
  const r = buildTaskTree([mkSub(1, [1])]);
  assert.equal(r.length, 1);
  assert.equal(r[0].children.length, 0);
});

test("buildTaskTree: 多重親(共有子)は root=[1,2]で終了", () => {
  const r = buildTaskTree([mkSub(1, [3]), mkSub(2, [3]), mkSub(3, [])]);
  assert.deepEqual(r.map((n) => n.task.id).sort(), [1, 2]);
});

test("buildTaskTree: 欠落参照は無視", () => {
  const r = buildTaskTree([mkSub(1, [999])]);
  assert.equal(r.length, 1);
  assert.equal(r[0].children.length, 0);
});

test("buildTaskTree: 深500段でスタック破綻せず全段辿れる", () => {
  const N = 500, list = [];
  for (let i = 1; i <= N; i++) list.push(mkSub(i, i < N ? [i + 1] : []));
  const r = buildTaskTree(list);
  let depth = 0, node = r[0];
  while (node && node.children.length) { depth++; node = node.children[0]; }
  assert.equal(r.length, 1);
  assert.equal(depth, N - 1);
});

test("buildTaskTree: 空/null/undefined/related_tasks欠落に耐える", () => {
  assert.deepEqual(buildTaskTree([]), []);
  assert.deepEqual(buildTaskTree(null), []);
  assert.deepEqual(buildTaskTree(undefined), []);
  assert.equal(buildTaskTree([{ id: 1 }, { id: 2, related_tasks: null }, { id: 3, related_tasks: { subtask: null } }]).length, 3);
});

test("projectAncestor: 親なし→null / 2段3段→最上位", () => {
  assert.equal(projectAncestor(mkPar(1, null), byIdOf([mkPar(1, null)])), null);
  const l2 = [mkPar(1, null), mkPar(2, 1)];
  assert.equal(projectAncestor(l2[1], byIdOf(l2)).id, 1);
  const l3 = [mkPar(1, null), mkPar(2, 1), mkPar(3, 2)];
  assert.equal(projectAncestor(l3[2], byIdOf(l3)).id, 1);
});

test("projectAncestor: 相互循環/自己親でも無限ループせず非null終了", () => {
  const lc = [mkPar(1, 2), mkPar(2, 1)];
  assert.notEqual(projectAncestor(lc[0], byIdOf(lc)), null);
  const t = mkPar(1, 1);
  assert.notEqual(projectAncestor(t, byIdOf([t])), null);
});

test("projectAncestor: 深500段→最上位1 / byId無し・参照切れでも落ちない", () => {
  const N = 500, list = [];
  for (let i = 1; i <= N; i++) list.push(mkPar(i, i > 1 ? i - 1 : null));
  assert.equal(projectAncestor(list[N - 1], byIdOf(list)).id, 1);
  assert.notEqual(projectAncestor(mkPar(2, 1), null), null);
  assert.equal(projectAncestor(mkPar(2, 99), byIdOf([mkPar(2, 99)])).id, 99);
  assert.equal(projectAncestor(null, new Map()), null);
});

test("階層バッジ/チップ規則の整合（P>G>T + 直下T）", () => {
  const list = [mkParSub(1, null, [2, 4]), mkParSub(2, 1, [3]), mkParSub(3, 2, []), mkParSub(4, 1, [])];
  const byId = byIdOf(list);
  const badges = {};
  const walk = (node, depth) => {
    const has = node.children.length > 0;
    badges[node.task.id] = has ? (depth === 0 ? "proj" : "group") : "task";
    node.children.forEach((c) => walk(c, depth + 1));
  };
  buildTaskTree(list).forEach((n) => walk(n, 0));
  assert.deepEqual(badges, { 1: "proj", 2: "group", 3: "task", 4: "task" });
  const chip = (t) => {
    const imm = (((t.related_tasks || {}).parenttask) || [])[0];
    const immP = imm ? (byId.get(imm.id) || imm) : null;
    const proj = projectAncestor(t, byId);
    return (immP && proj && immP.id !== proj.id) ? immP.id : null;
  };
  assert.equal(chip(byId.get(3)), 2); // Task3 の直近親Group2 ≠ 最上位Project1 → チップ=2
  assert.equal(chip(byId.get(4)), null); // 直下Task4 → チップ無し
  assert.equal(chip(byId.get(2)), null); // Group2 の直近親=最上位Project1 → チップ無し
});
