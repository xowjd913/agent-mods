// #113: a plain UTF-16 slice through an emoji leaves a lone surrogate; that is not valid UTF-8, so TextView.markdown / an element id built from it
// throws and the whole timeline view dies. Everything here is synthetic (no real PO text): same structure as the line that crashed the desk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const FIRE = "🔥"; // 2 UTF-16 units
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const ok = (s) => assert.ok(!LONE.test(s), `lone surrogate in ${JSON.stringify(s)}`);
const utf8Ok = (s) => assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(s, "utf8")));
// Text whose first FIRE sits at `at` (UTF-16 index) of a longer string.
const padTo = (at, tail = " 🔥 끝") => "가".repeat(at) + FIRE + tail;

test("cutPoint / cutHead never split a pair, at every edge", () => {
  const s = "ab" + FIRE + "cd"; // indexes: a0 b1 hi2 lo3 c4 d5
  assert.equal(I.cutPoint(s, 3), 2);
  assert.equal(I.cutPoint(s, 2), 2);
  assert.equal(I.cutPoint(s, 4), 4);
  assert.equal(I.cutPoint(s, 0), 0);
  assert.equal(I.cutPoint(s, 99), 99);
  assert.equal(I.cutHead(s, 3), "ab");
  assert.equal(I.cutHead(s, 4), "ab" + FIRE);
  assert.equal(I.cutHead(s, 0), "");
  assert.equal(I.cutHead(null, 5), "");
  for (let n = 0; n <= s.length + 1; n++) { ok(I.cutHead(s, n)); utf8Ok(I.cutHead(s, n)); }
});

test("cutTail never starts in the middle of a pair", () => {
  const s = "ab" + FIRE + "cd";
  assert.equal(I.cutTail(s, 2), "cd");
  assert.equal(I.cutTail(s, 3), "cd"); // would start at the low half
  assert.equal(I.cutTail(s, 4), FIRE + "cd");
  assert.equal(I.cutTail(s, 99), s);
  assert.equal(I.cutTail(s, 0), "");
  for (let n = 0; n <= s.length + 1; n++) { ok(I.cutTail(s, n)); utf8Ok(I.cutTail(s, n)); }
});

test("wellFormed keeps pairs and turns lone halves into U+FFFD", () => {
  assert.equal(I.wellFormed("a" + FIRE + "b"), "a" + FIRE + "b");
  assert.equal(I.wellFormed("a\ud83d"), "a�");
  assert.equal(I.wellFormed("\udd25b"), "�b");
  assert.equal(I.wellFormed("\ud83dx\ud83d" + "\udd25"), "�x" + FIRE);
  assert.equal(I.wellFormed(undefined), "");
  assert.equal(I.wellFormed(12), "12");
  utf8Ok(I.wellFormed("x\ud83d"));
});

test("initial takes a whole character, not half an emoji", () => {
  assert.equal(I.initial(FIRE + "팀"), FIRE);
  assert.equal(I.initial("abc"), "A");
  assert.equal(I.initial(""), "");
  assert.equal(I.initial(null), "");
});

// The line that crashed the desk: a PO reply whose emoji sat at index 63 of its timeline key (`po|<ms>|<text>`).
test("tlId of the crashing PO bubble key is well-formed (full path through timeline)", () => {
  const ts = "2026-11-26T08:05:50.917Z", ms = Date.parse(ts);
  const prefix = `po|${ms}|`;
  assert.equal(prefix.length, 17);
  const text = padTo(63 - prefix.length, " 로 머지 커밋은 **ce0ee19** 입니다 — 확인 부탁드립니다 ".repeat(2));
  const key = prefix + text;
  assert.equal(key.indexOf(FIRE), 63); // the emoji straddles the 64-char cut
  assert.ok(key.length > 80);
  // the old cut: key.slice(0, 64) ends in a lone high surrogate
  assert.match(key.slice(0, 64), LONE);
  const tl = I.timeline("p1", [], [{ ms, ts, text, kind: "say", to: "", pid: "" }], []);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].key, key);
  const id = I.tlId(tl[0].key);
  ok(id);
  utf8Ok(id);
  assert.ok(id.length <= 3 + 64 + 1 + 8);
  assert.match(id, /^tl-.*~[0-9a-f]{8}$/);
  // a different tail still gives a different id (the hash is over the whole key)
  assert.notEqual(id, I.tlId(key + "x"));
  assert.equal(I.tlId(key), id);
});

test("tlId: short keys are kept and a lone half in the key is replaced", () => {
  assert.equal(I.tlId("me|1|hi"), "tl-me|1|hi");
  const bad = I.tlId("po|1|\ud83d");
  ok(bad);
  assert.equal(bad, "tl-po|1|�");
  for (let at = 55; at <= 66; at++) { const id = I.tlId("k".repeat(at) + FIRE + "z".repeat(40)); ok(id); utf8Ok(id); }
});

test("clipLong cuts on a whole character at the char limit", () => {
  const s = "가".repeat(I.LONG_CHARS - 1) + FIRE + "tail text";
  const r = I.clipLong(s);
  assert.equal(r.cut, true);
  ok(r.text);
  assert.equal(r.text + s.slice(r.text.length), s);
  for (const edge of [I.LONG_CHARS - 2, I.LONG_CHARS - 1, I.LONG_CHARS]) { const x = I.clipLong("a".repeat(edge) + FIRE + "b".repeat(20)); ok(x.text); }
});

test("promptTail shortens a long line on a whole character", () => {
  for (const at of [137, 138, 139, 140]) {
    const out = I.promptTail("a".repeat(at) + FIRE + "b".repeat(30));
    assert.equal(out.length, 1);
    ok(out[0]);
    utf8Ok(out[0]);
  }
});

test("decisionHints shortens recommendation and answer lines on a whole character", () => {
  for (const at of [150, 151, 152, 153, 154, 155]) {
    const h = I.decisionHints(`추천: ${"가".repeat(at - 4)}${FIRE}${"나".repeat(30)}`);
    assert.equal(h.lines.length, 1);
    ok(h.lines[0]);
    utf8Ok(h.lines[0]);
  }
});

test("inputHas compares 24-char head/tail without splitting an emoji", () => {
  for (let k = 20; k <= 26; k++) {
    const line = "x".repeat(k) + FIRE + "y".repeat(40) + "z".repeat(k) + FIRE;
    assert.equal(I.inputHas(`│ ${line} │`, line), true);
    assert.equal(I.inputHas("│ nothing like it │", line), false);
  }
});

test("linkLabel, lead, hookLine and parsePoLines never leave half an emoji", () => {
  for (const at of [25, 26, 27, 28, 29]) {
    const url = "https://example.com/" + "p".repeat(at - 12) + FIRE + "q".repeat(30); // a URL percent-encodes the emoji; the label is still bounded
    const l = I.linkLabel(url);
    ok(l);
    const bad = I.linkLabel("not a url " + "a".repeat(at - 10) + FIRE + "b".repeat(30));
    ok(bad);
  }
  const MAX = 2000; // MAX_PO_TEXT: the PO hook keeps this many characters of a line
  for (const at of [MAX - 3, MAX - 2, MAX - 1, MAX]) {
    const text = "a".repeat(at) + FIRE + "b".repeat(50);
    const h = I.hookLine({ hook_event_name: "Stop", last_assistant_message: text });
    ok(h.text);
    utf8Ok(h.text);
    assert.ok(h.text.endsWith("…") && h.text.length >= MAX - 2);
    const body = JSON.stringify({ ts: "2026-11-26T08:05:50.917Z", kind: "say", text });
    const p = I.parsePoLines(body);
    assert.equal(p.length, 1);
    ok(p[0].text);
    utf8Ok(p[0].text);
    assert.ok(p[0].text.length >= MAX - 3);
  }
});

test("chatRecord keeps the pasted line whole at its 4000-char cut", () => {
  for (const at of [3998, 3999, 4000]) {
    const r = I.chatRecord({ text: "hi", line: "a".repeat(at) + FIRE + "b", po: "p1" }, "sent", 1);
    ok(r.line);
    utf8Ok(r.line);
  }
});

// main.js: the view must survive one bad entry, and what reaches TextView must be well-formed.
test("main.js sanitizes ids/text and falls back to plain text when markdown throws", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /const vid = wellFormed\(vid0\), s = wellFormed\(s0\)/);
  assert.match(src, /id = wellFormed\(id\); html = wellFormed\(html\);/);
  const at = src.indexOf("const vid = wellFormed(vid0)");
  const near = src.slice(at, at + 1500);
  assert.match(near, /try \{[\s\S]*TextView\.markdown\(/);
  assert.match(near, /catch[\s\S]*this\.diag\(/);
  assert.match(near, /this\.text\(vid, /);
  // no UTF-16 slice of an error message / text is left outside the shared helpers
  assert.equal((src.match(/String\(e\?\.message \?\? e\)\.slice\(/g) || []).length, 0);
});
