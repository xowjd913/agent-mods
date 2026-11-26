// #83: Enter in the chat box sends from any cursor position (start, middle, end); Shift+Enter is a line break; an IME's confirming Enter is held once.
// The widget may put its own "\n" at the cursor before or after our key handler runs, anywhere in the text: the real handlers of main.js run here
// against a fake text box that does both.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (a, b) => { const i = MAIN.indexOf(a), j = MAIN.indexOf(b, i + a.length); assert.ok(i > 0 && j > i, a); return MAIN.slice(i, j); };

const changeSrc = grab('    this.chat.on("change", (_e, c) => {', "\n    });\n") + "\n    });\n";
const keysSrc = grab("  // Enter in the box:", "  // Keys the open menu handles");
const make = new Function("I", "Date", "enterIntent", "needsNewline", "strayBreak", "imeHold", "strayHeld", "editCore", "strayAt", "withoutAt", "enterPending", "atTextEnd", `return class Desk {
  constructor(box, clock) {
    this.chat = box; this.sent = []; this.menu = null; this.pickedAt = 0; this.sentAt = -1e6; this.heldAt = 0; this.nlAt = 0; this.changedAt = 0; this.keyAt = 0;
    this.core = ""; this.lastValue = ""; this.enterAt = 0; this.brk = null; this.editAt = 0;
    ${changeSrc}
  }
  guard() { return false; }
  keep() {}
  wipe(_k, box) { box.set_value(""); }
  heldTick() {}
  syncMenu() {}
  notify() {}
  sendChat() { this.sentAt = Date.now(); this.heldAt = 0; this.sent.push(this.chat.value()); this.chat.set_value(""); }
  ${keysSrc}
}`);

// A text box with a cursor: the widget's own Enter puts "\n" at the cursor (replacing the selection) and fires "change".
class Box {
  constructor() { this.v = ""; this.s = { start: 0, end: 0 }; this.h = []; }
  on(ev, f) { if (ev === "change") this.h.push(f); }
  value() { return this.v; }
  content() { return { text: this.v, tokens: [] }; }
  selected_range() { return { ...this.s }; }
  set_selected_range(r) { this.s = { ...r }; }
  fire() { for (const h of this.h) h({}, { notify() {} }); }
  set_value(x) { this.v = String(x); this.s = { start: this.v.length, end: this.v.length }; this.fire(); }
  replace(t) { this.v = this.v.slice(0, this.s.start) + t + this.v.slice(this.s.end); const at = this.s.start + t.length; this.s = { start: at, end: at }; this.fire(); }
}

function room() {
  let clock = 100000;
  const Date_ = { now: () => clock };
  const box = new Box();
  const D = make(I, Date_, I.enterIntent, I.needsNewline, I.strayBreak, I.imeHold, I.strayHeld, I.editCore, I.strayAt, I.withoutAt, I.enterPending, I.atTextEnd);
  const d = new D(box, Date_);
  const timers = [];
  const c = { stop_propagation() {}, notify() {}, timer: { after(ms, f) { timers.push({ at: clock + ms, f }); } } };
  const r = {
    box, d, c,
    wait(ms) { clock += ms; for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.f(c); } },
    type(text) { box.replace(text); r.wait(5); },
    cursor(i) { box.set_selected_range({ start: i, end: i }); r.wait(5); },
    // one Enter press: `order` "key" = our key handler first and the widget's line break after, "widget" = the line break first. The widget's
    // submit event for the same press reaches enterBox too.
    enter(order = "key", shift = false) {
      const press = () => { d.inputKey({ key: "enter", modifiers: { shift } }, c); d.enterBox(shift ? "newline" : "send", c); };
      if (order === "widget") { box.replace("\n"); r.wait(3); press(); } else { press(); r.wait(3); if (!shift || box.v === d.lastValue) box.replace("\n"); }
      r.wait(60);
    },
  };
  return r;
}
// the text was typed and left alone a while (nothing composing, no recent edit)
function settled(text, at) { const r = room(); r.type(text); r.cursor(at ?? text.length); r.wait(2000); return r; }

test("strayAt·withoutAt: 글 속에 줄바꿈이 정확히 하나 끼어든 자리만 찾고, 그 밖의 바뀜은 -1", () => {
  assert.equal(I.strayAt("안녕 반가워", "안녕\n 반가워"), 2);
  assert.equal(I.strayAt("안녕", "안녕\n"), 2); // 끝
  assert.equal(I.strayAt("안녕", "\n안녕"), 0); // 처음
  assert.equal(I.strayAt("", "\n"), 0);
  assert.equal(I.strayAt("안녕", "안녕!"), -1); // 줄바꿈이 아닌 글자
  assert.equal(I.strayAt("안녕", "안\n\n녕"), -1); // 둘 이상
  assert.equal(I.strayAt("안녕", "안녕"), -1);
  assert.equal(I.strayAt("안녕\n", "안녕"), -1); // 줄어든 것
  assert.equal(I.strayAt(null, "x"), -1);
  assert.equal(I.withoutAt("안녕\n 반가워", 2), "안녕 반가워");
  for (const [a, b] of [["abc", "ab\nc"], ["가나", "\n가나"], ["a\nb", "a\n\nb"]]) assert.equal(I.withoutAt(b, I.strayAt(a, b)), a);
});

test("enterPending·atTextEnd: Enter 직후(또는 25ms 앞선 줄바꿈)만, 커서가 글 끝이거나 모를 때만 끝", () => {
  assert.equal(I.enterPending(1000, 1010), true);
  assert.equal(I.enterPending(1000, 1000 + I.HELD_BREAK_MS), false);
  assert.equal(I.enterPending(1000, 990), true); // 줄바꿈이 키보다 먼저 온 순서
  assert.equal(I.enterPending(1000, 900), false);
  assert.equal(I.enterPending(0, 10), false); // Enter를 누른 적 없다(Shift+Enter 줄바꿈은 건드리지 않는다)
  assert.equal(I.atTextEnd("안녕", 2), true);
  assert.equal(I.atTextEnd("안녕\n", 2), true); // 끝의 줄바꿈은 글이 아니다
  assert.equal(I.atTextEnd("안녕 반가워", 2), false);
  assert.equal(I.atTextEnd("안녕", 0), false);
  assert.equal(I.atTextEnd("안녕", null), true); // 모르면 조심하는 쪽
  assert.equal(I.atTextEnd("안녕", undefined), true);
});

test("imeHold: 커서가 글 안쪽이면 끝 글자(한글)로는 붙들지 않고, 방금 고친 글은 어디서든 붙든다", () => {
  assert.equal(I.imeHold("안녕 반가워", 1000, 0, 5000, false), false);
  assert.equal(I.imeHold("안녕 반가워", 1000, 0, 5000, true), true);
  assert.equal(I.imeHold("안녕 반가워", 1000, 0, 5000), true); // 인자를 안 주면 예전 그대로
  assert.equal(I.imeHold("안녕 반가워", 4800, 0, 5000, false), true); // 방금(500ms 안) 고친 글
  assert.equal(I.imeHold("안녕", 1000, 1000, 1200, false), false);
});

for (const order of ["key", "widget"]) {
  for (const [name, at] of [["처음", 0], ["가운데", 5], ["가운데(한 글자 뒤)", 1]]) {
    test(`#83: 글 ${name}에서 Enter를 치면(줄바꿈이 ${order === "key" ? "키 뒤에" : "키 앞에"} 와도) 줄바꿈 없이 전체 글이 한 번 보내진다`, () => {
      const text = "안녕하세요 반갑습니다";
      const r = settled(text, at);
      r.enter(order);
      assert.deepEqual(r.d.sent, [text]);
      assert.equal(r.box.v, ""); // 보낸 뒤 상자는 비고 위젯의 줄바꿈도 남지 않는다
    });
  }
  test(`#83: 영문 글 가운데(${order})와 끝에서도 한 번에 보낸다`, () => {
    for (const at of [0, 5, 11]) {
      const r = settled("hello world", at);
      r.enter(order);
      assert.deepEqual(r.d.sent, ["hello world"]);
    }
  });
}

test("#83: 한글로 끝난 글의 끝에서는 첫 Enter를 한 번 붙들고(줄바꿈은 남기지 않고), 두 번째 Enter가 보낸다", () => {
  for (const order of ["key", "widget"]) {
    const r = settled("안녕하세요");
    r.enter(order);
    assert.deepEqual(r.d.sent, []); // 조합을 확정하는 Enter일 수 있다
    assert.equal(r.box.v, "안녕하세요"); // 위젯의 줄바꿈이 남지 않는다
    r.wait(300);
    r.enter(order);
    assert.deepEqual(r.d.sent, ["안녕하세요"]); // 이중 전송 없이 한 번
  }
});

test("#83: 방금 친 글 가운데에서 Enter를 치면(조합 중일 수 있다) 한 번 붙들되, 위젯이 가운데에 넣은 줄바꿈은 걷어 글과 커서가 그대로다", () => {
  for (const order of ["key", "widget"]) {
    const r = room();
    r.type("안녕하세요 반갑습니다");
    r.cursor(5);
    r.wait(100); // 0.5초가 안 지났다
    r.d.editAt = 100000 + 105; // (마지막으로 글이 바뀐 때: 방금)
    r.enter(order);
    assert.deepEqual(r.d.sent, []);
    assert.equal(r.box.v, "안녕하세요 반갑습니다");
    assert.deepEqual(r.box.s, { start: 5, end: 5 }); // 커서는 줄바꿈이 들어온 자리
    r.wait(300);
    r.enter(order);
    assert.deepEqual(r.d.sent, ["안녕하세요 반갑습니다"]);
  }
});

test("#83: 같은 Enter의 key와 submit 이벤트는 한 번만 보낸다", () => {
  const r = settled("hello world", 5);
  r.d.inputKey({ key: "enter", modifiers: {} }, r.c);
  r.d.enterBox("send", r.c);
  r.d.enterBox("send", r.c);
  assert.equal(r.d.sent.length, 1);
});

test("#83: Shift+Enter는 처음·가운데·끝 어디서든 보내지 않고 줄바꿈 하나만 넣는다", () => {
  for (const at of [0, 5, 11]) {
    for (const widgetAdds of [true, false]) {
      const r = settled("hello world", at);
      r.d.inputKey({ key: "enter", modifiers: { shift: true } }, r.c);
      if (widgetAdds) r.box.replace("\n"); // 위젯이 스스로 줄바꿈을 넣는 경우와, 안 넣어 우리가 넣는 경우
      r.wait(100);
      assert.deepEqual(r.d.sent, []);
      assert.equal(r.box.v, "hello world".slice(0, at) + "\n" + "hello world".slice(at), `at ${at}, widget ${widgetAdds}`);
    }
  }
});

test("#83: Shift+Enter 줄바꿈을 넣은 직후의 Enter는 그 줄바꿈을 글로 남기고 보낸다", () => {
  const r = settled("hello world", 5);
  r.d.inputKey({ key: "enter", modifiers: { shift: true } }, r.c);
  r.box.replace("\n");
  r.wait(2000); // 방금 고친 글은 붙들리므로(조합 중일 수 있다) 잠시 둔 뒤
  r.enter("key");
  assert.equal(r.d.sent.length, 1);
  assert.equal(r.d.sent[0], "hello\n world");
});

test("#83: 선택한 글이 없고 한글 조합이 끝난 글 가운데에서 이어 쓰던 글도 끝 Enter 규칙은 그대로(끝=붙듦)", () => {
  const r = settled("안녕하세요 반갑습니다", 5);
  r.cursor(11); // 글 끝으로 옮기면 조합 규칙이 다시 적용된다
  r.enter("key");
  assert.deepEqual(r.d.sent, []);
});

test("main.js 배선(#83): Enter는 커서 위치를 읽어 imeHold에 넘기고, 위젯이 가운데에 넣은 줄바꿈은 dropAt으로 걷는다", () => {
  assert.match(MAIN, /imeHold\(value, this\.editAt, this\.heldAt, now, atTextEnd\(value, cur\)\)/);
  assert.match(MAIN, /this\.chat\.selected_range\(\)\.end/);
  assert.match(MAIN, /if \(brk >= 0 && enterPending\(this\.enterAt, this\.changedAt\)\) \{ this\.dropAt\(value, brk, this\.editAt\); return; \}/);
  assert.match(MAIN, /this\.enterAt = now;/);
  // 걷을 때 글 칩이 사라지지 않게 그 한 글자만 지운다(set_value는 바탕 글만 쓰는 마지막 수단)
  const drop = grab("  dropAt(value, idx, editAt) {", "  // Takes the one trailing line break");
  assert.ok(drop.indexOf("replace(\"\")") > 0 && drop.indexOf("replace(\"\")") < drop.indexOf("set_value"));
  // 순수 함수는 mod 쪽과 시험 쪽 사본이 같다
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  for (const name of ["strayAt", "withoutAt", "enterPending", "atTextEnd", "imeHold"]) {
    const a = MAIN.match(new RegExp(`const ${name} = [\\s\\S]*?\\n\\};?\\n|const ${name} = [^\\n]*\\n`))[0];
    assert.ok(cjs.includes(a), name);
  }
});
