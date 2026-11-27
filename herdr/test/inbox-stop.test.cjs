// #133: Esc / "멈추기" stops the room's PO turn. Fakes only: that a real Esc stops a real Claude Code turn is NOT verified in the running app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
const cut = (a, b) => { const i = MAIN.indexOf(a), j = MAIN.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return MAIN.slice(i, j); };
const c = { notify() {} };
const live = (status) => ({ live: true, status });

test("stopBlock: 읽지 못함·꺼짐·질문 중·일하지 않음은 막고, 일하는 중만 보낸다", () => {
  assert.match(I.stopBlock(null), /읽지 못해/);
  assert.match(I.stopBlock({ live: false, status: "working" }), /실행 중이 아니라/);
  assert.match(I.stopBlock(live("blocked")), /질문 중/);
  assert.match(I.stopBlock(live("idle")), /일하는 중이 아니라/);
  assert.match(I.stopBlock(live("done")), /일하는 중이 아니라/);
  assert.equal(I.stopBlock(live("working")), "");
});

test("stopKey: 빈 입력칸·메뉴 닫힘·PO 작업 중·잠금 없음일 때만 Esc가 멈춤", () => {
  const ok = { menu: false, text: "", working: true, at: 0, now: 10_000 };
  assert.equal(I.stopKey("Escape", ok), true);
  assert.equal(I.stopKey("Enter", ok), false);
  assert.equal(I.stopKey("Escape", { ...ok, text: "쓰던 글" }), false, "text present: unchanged");
  assert.equal(I.stopKey("Escape", { ...ok, text: "  \n" }), true, "blank text counts as empty");
  assert.equal(I.stopKey("Escape", { ...ok, menu: true }), false);
  assert.equal(I.stopKey("Escape", { ...ok, working: false }), false);
  assert.equal(I.stopKey("Escape", { ...ok, at: 9_000 }), false, "locked");
  assert.equal(I.stopKey("Escape", { ...ok, at: 10_000 - I.STOP_LOCK_MS }), true, "lock over");
});

test("stopWorking: 고른 방의 PO 터미널이 working일 때만", () => {
  const terms = (s) => [{ address: "t1", name: "po", status: s, labels: { role: "po", po: "a" } }];
  assert.equal(I.stopWorking(terms("working"), "a"), true);
  assert.equal(I.stopWorking(terms(" Working "), "a"), true);
  assert.equal(I.stopWorking(terms("idle"), "a"), false);
  assert.equal(I.stopWorking(terms("blocked"), "a"), false);
  assert.equal(I.stopWorking(terms("working"), "zzz"), false, "no such room");
  assert.equal(I.stopWorking([], "a"), false);
  assert.equal(I.stopWorking(null, "a"), false);
  assert.equal(I.stopWorking(terms("working"), I.PO_OTHER), false, "PO 모름 room has no PO");
  assert.equal(I.stopWorking(terms("working"), ""), false);
});

const run = async (term, keysCode = 0, po = "t7") => {
  const D = new Function("stopLocked", "stopBlock", "chatTarget", "PO_OTHER", "hc", `return class Desk {
    constructor() { this.stopAt = 0; this.msgs = []; }
    view() { return { pick: ${JSON.stringify(po ? "p1" : "__other__")}, terms: [] }; }
    say(t, bad) { this.msgs.push({ t, bad }); }
    async poTerm() { return ${JSON.stringify(term)}; }
    ${cut("  async stopPo(c) {", "  // Keys the open menu handles stop here")}
  }`);
  const calls = [];
  const d = new (D(I.stopLocked, I.stopBlock, () => ({ po }), "__other__", async (a) => { calls.push(a); return { code: keysCode }; }))();
  await d.stopPo(c);
  return { d, calls };
};

test("stopPo: 일하는 중이면 그 PO 주소로 esc를 한 번만 보내고 잠근다", async () => {
  const { d, calls } = await run(live("working"));
  assert.deepEqual(calls, [["keys", "t7", "esc"]]);
  assert.equal(d.msgs.length, 1);
  assert.equal(d.msgs[0].bad, false);
  assert.ok(d.stopAt > 0);
  await d.stopPo(c); // inside the lock: nothing more is sent
  assert.equal(calls.length, 1);
  assert.equal(d.msgs.length, 1);
});

test("stopPo: 상태를 읽지 못하거나 일하지 않거나 질문 중이면 아무 키도 보내지 않고 안내만, 잠금은 돌려준다", async () => {
  for (const term of [null, { live: false, status: "working" }, live("idle"), live("blocked"), live("done")]) {
    const { d, calls } = await run(term);
    assert.deepEqual(calls, [], JSON.stringify(term));
    assert.equal(d.msgs.length, 1);
    assert.equal(d.msgs[0].bad, true);
    assert.equal(d.stopAt, 0, "a refusal does not lock");
  }
});

test("stopPo: PO를 모르는 방은 보내지 않는다", async () => {
  const { d, calls } = await run(live("working"), 0, null);
  assert.deepEqual(calls, []);
  assert.match(d.msgs[0].t, /찾지 못했습니다/);
});

test("stopPo: hc keys가 실패하면 실패를 알리고 잠금을 돌려준다", async () => {
  const { d, calls } = await run(live("working"), 1);
  assert.deepEqual(calls, [["keys", "t7", "esc"]]);
  assert.equal(d.msgs[0].bad, true);
  assert.equal(d.stopAt, 0);
});

test("배선: 입력칸 Esc와 멈추기 버튼은 같은 stopPo로 가고, 글이 있으면 stopKey가 막는다", () => {
  assert.match(MAIN, /stopKey\(e\?\.key, \{ menu: false, text, working: stopWorking\(v\.terms, v\.pick\)/);
  assert.match(MAIN, /"chat-stop", "멈추기", \(c\) => this\.stopPo\(c\)/);
  assert.match(MAIN, /\.when\(stopWorking\(v\.terms, v\.pick\)/);
  assert.equal((MAIN.match(/hc\(\["keys", po, "esc"\]\)/g) ?? []).length >= 2, true);
});
