// #112: the first character of the chat box could not be deleted with Backspace (typing Korean). The draft mirror (#74) takes a box that comes back
// empty with no key press of the person's just before it for a wipe and puts the text back. An IME that is composing takes the Backspace itself (no key
// event reaches the box's key handler), so deleting the one composed character looked like a wipe and the character was restored.
// Fakes only: whether the real widget / IME routes the key this way is NOT verified in the running app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
const cut = (a, b) => { const i = MAIN.indexOf(a), j = MAIN.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return MAIN.slice(i, j); };
const Desk = new Function("draftWiped", "DRAFT_KEY_MS", `return class Desk {
  constructor() { this.mirror = new Map(); this.keyAt = 0; this.diag = () => {}; }
  ${cut("  keep(key, st, value) {", "  // #66: the chat box holds the draft")}
  ${cut("  wipe(key, st) {", "  // Every box is looked at once per draw")}
}`)(I.draftWiped, I.DRAFT_KEY_MS);
const fake = (text) => ({ v: text, value() { return this.v; }, content() { return this.v; }, selected_range() { return { start: this.v.length, end: this.v.length }; }, set_selected_range() {}, set_value(x) { this.v = x; } });

test("#112 draftWiped: 한 글자짜리 복사본은 비워져도 지워진 것으로 보지 않는다(키 없이 와도)", () => {
  assert.equal(I.draftWiped({ text: "ㅎ" }, "", 0, 10_000), false);
  assert.equal(I.draftWiped({ text: "한" }, "", 0, 10_000), false);
  assert.equal(I.draftWiped({ text: "😀" }, "", 0, 10_000), false, "one code point, not one UTF-16 unit");
  assert.equal(I.draftWiped({ text: "한글" }, "", 0, 10_000), true, "a longer draft that vanishes without a key is still mended (#74)");
});

test("#112 재현: 한글 한 글자를 치고 조합 중인 글자를 Backspace(키 이벤트 없음)로 지우면 지워진 채로 남는다", () => {
  const d = new Desk(), st = fake("");
  d.keyAt = Date.now() - 60_000; // no key press of the person's for a minute (the IME took the keys)
  st.v = "ㅎ"; d.keep("chat", st, "ㅎ");
  st.v = ""; // the IME removed the composed character
  assert.equal(d.guard("chat", st, ""), false, "no restore");
  assert.equal(st.v, "");
  d.keep("chat", st, "");
  d.guard("chat", st); // the next draw / poll look
  assert.equal(st.v, "", "stays empty");
});

test("#112 회귀: 두 글자 이상 쓰던 글이 키 없이 비워지면 여전히 되돌린다(#74)", () => {
  const d = new Desk(), st = fake("");
  d.keyAt = Date.now() - 60_000;
  st.v = "쓰던 글"; d.keep("chat", st, "쓰던 글");
  st.v = "";
  assert.equal(d.guard("chat", st, ""), true);
  assert.equal(st.v, "쓰던 글");
});
