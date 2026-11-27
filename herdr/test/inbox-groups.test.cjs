const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");
const main = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");

const TWO = "결정이 필요합니다.\n① 병합 시점\n1안: 지금\n2안(추천): 다음 주\n② 순서\n1안: A 먼저\n2안: B 먼저\n3안: 동시에\n추천: 3안";

test("decisionGroups: ①·② 머리줄로 질문을 나눠 질문별 선택지를 읽는다(#76)", () => {
  assert.deepEqual(I.decisionGroups(TWO), [
    { label: "①", options: [1, 2], recommended: 2 },
    { label: "②", options: [1, 2, 3], recommended: 3 },
  ]);
  assert.deepEqual(I.decisionGroups("**① 가**\n- 1안: x\n- 2안: y\n- ② 나\n- 1안: x\n- 2안: y").map((g) => g.label), ["①", "②"]);
});

test("decisionGroups: 질문이 하나이거나 선택지가 모자라거나 머리 위에 선택지가 있으면 []이고 기존 한 질문으로 읽는다", () => {
  const one = "① 하나뿐\n1안: 가\n2안: 나";
  assert.deepEqual(I.decisionGroups(one), []);
  assert.deepEqual(I.decisionGroups("1안: 가\n2안: 나"), []);
  assert.deepEqual(I.decisionGroups("① 가\n1안: x\n2안: y\n② 나\n1안: 하나뿐"), []);
  assert.deepEqual(I.decisionGroups("1안: 위\n2안: 위\n① 가\n1안: x\n2안: y\n② 나\n1안: x\n2안: y"), []);
  assert.deepEqual(I.decisionGroups("① 가\n1안: x\n2안: y\n① 같은 머리\n1안: x\n2안: y"), []);
  assert.deepEqual(I.decisionGroups(""), []);
  assert.deepEqual(I.decisionGroups(null), []);
  assert.deepEqual(I.decisionOptions(one), { options: [1, 2], recommended: 0 }); // 기존 카드는 그대로
});

test("groupAnswer: 모든 질문에 고른 번호가 있을 때만 '①1안, ②2안'을 만든다", () => {
  const g = I.decisionGroups(TWO);
  assert.equal(I.groupAnswer(g, { "①": 1, "②": 2 }), "①1안, ②2안");
  assert.equal(I.groupAnswer(g, { "①": 1 }), "");
  assert.equal(I.groupAnswer(g, { "①": 3, "②": 2 }), ""); // 그 질문에 없는 번호
  assert.equal(I.groupAnswer(g, {}), "");
});

test("main.js와 inbox.cjs의 decisionGroups·groupAnswer가 같다", () => {
  const cut = (src, name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf("\n}\n", src.indexOf(`function ${name}(`)));
  for (const n of ["decisionGroups", "groupAnswer"]) assert.equal(cut(main, n), cut(fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8"), n));
});

test("pickGroup: 마지막 질문을 고르면 한 번에 보내고, 중간에는 고른 것만 기억한다", () => {
  const body = main.slice(main.indexOf("  pickGroup("), main.indexOf("  // What a waiting leader's message offers"));
  const fn = new Function("groupAnswer", `return {${body.trim().replace(/^pickGroup/, "pickGroup")}}`)(I.groupAnswer).pickGroup;
  const sent = [];
  const me = { askKey: () => "k1", send: (a, text, cx, kind) => sent.push([text, kind]) };
  const cx = { notify() { me.n = (me.n ?? 0) + 1; } };
  const a = { s: { leader: "lead-x" } };
  const g = I.decisionGroups(TWO);
  fn.call(me, a, g, "①", 2, cx);
  assert.deepEqual(sent, []);
  assert.deepEqual(me.gpick.get("lead-x").picks, { "①": 2 });
  fn.call(me, a, g, "①", 1, cx); // 바꿔 고를 수 있다
  fn.call(me, a, g, "②", 3, cx);
  assert.deepEqual(sent, [["①1안, ②3안", "choice"]]);
  assert.equal(me.gpick.has("lead-x"), false);
  me.askKey = () => "k2"; // 새 결정이 오면 예전 고름은 버린다
  me.gpick.set("lead-x", { key: "k1", picks: { "①": 1 } });
  fn.call(me, a, g, "②", 1, cx);
  assert.deepEqual(sent.length, 1);
  assert.deepEqual(me.gpick.get("lead-x").picks, { "②": 1 });
});

test("askActions: 여러 질문 카드는 질문마다 버튼 줄을 그리고 pickGroup 한 길로만 보낸다", () => {
  const a = main.indexOf("  askActions(t, a, cx) {");
  const body = main.slice(a, main.indexOf("    if (!a.po) box.child", a));
  assert.match(body, /decisionGroups\(item\?\.body\)/);
  assert.match(body, /\(view \? \[\] : groups\)\.map\(\(g, gi\)/);
  assert.match(body, /this\.pickGroup\(a, groups, g\.label, n, c\)/);
  assert.match(body, /primary: picks\[g\.label\] === n/);
  assert.match(body, /disabled: a\.po \? "" : NO_PO\(\)/);
  assert.equal((body.match(/this\.send\(/g) ?? []).length >= 1, true);
  assert.ok(!/this\.send\(a, `\$\{n\}안/.test(body.slice(body.indexOf("groups.map"), body.indexOf("hint.lines.map")))); // 묶음 버튼은 바로 보내지 않는다
});
