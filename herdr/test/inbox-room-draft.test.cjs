// #66 round: (1) a single "~" stays literal in bubbles, only "~~text~~" strikes; (2) the newest bubble's last line stays in view (end sentinel + pinStep);
// (3) the unsent chat draft is kept per room (switch away and back restores it; sending clears only the room shown).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
const grab = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };

// ---- (1) tilde
test("~: 한 개짜리 ~는 글자 그대로 남는다 (취소선 아님)", () => {
  for (const src of ["3~4.5일", "1.5~2일 + 2~3일", "AI 3~4.5일 + 언니 빌드 PC 작업 1.5~2일", "~시작과 끝~"]) {
    const out = I.mdText(src);
    assert.ok(!/(^|[^\\~])~(?!~)/.test(out), `${src} -> ${out}`); // every single tilde is escaped
    assert.equal(out.replace(/\\~/g, "~"), src);
  }
});
test("~: ~~취소~~ 는 취소선으로 그대로 둔다, 섞인 줄은 한 개짜리만 이스케이프한다", () => {
  assert.equal(I.mdText("~~취소~~"), "~~취소~~");
  assert.equal(I.mdText("~~취소~~ 그리고 3~4일"), "~~취소~~ 그리고 3\\~4일");
});
test("~: 코드 span, 링크 주소, 코드 블록 안은 건드리지 않는다", () => {
  assert.equal(I.mdText("`a~b` 3~4"), "`a~b` 3\\~4");
  assert.equal(I.mdText("[홈](https://x.test/~me/a) ~"), "[홈](https://x.test/~me/a) \\~");
  assert.equal(I.mdText("https://x.test/~me 3~4"), "https://x.test/~me 3\\~4");
  const fenced = I.mdText("```\na~b\n```\n3~4");
  assert.ok(fenced.includes("a~b") && !fenced.includes("a\\~b"), fenced);
  assert.ok(fenced.includes("3\\~4"), fenced);
});
test("~: escTilde는 main.js와 inbox.cjs가 같다", () => {
  const pick = (s) => grab(s, "const TILDE_KEEP", "function mdText(");
  assert.equal(pick(MAIN), pick(CJS));
});

// ---- (2) cut-off: the last line of the newest bubble stays visible
test("잘림: 맨 아래에 붙어 있을 때 아주 큰 새 말풍선이 와도 끝으로 다시 간다", () => {
  // viewport 400, was at the very end of 1000; a 700px numbered-list bubble arrives (content 1700, handle y still old)
  const r = I.pinStep({ pinned: true, ct: 1000, vh: 400 }, { y: 600, vh: 400, ch: 1700 });
  assert.equal(r.go, true);
  assert.equal(r.pinned, true);
  // after the scroll the layout settles at the end: no further call
  assert.equal(I.pinStep(r, { y: 1300, vh: 400, ch: 1700 }).go, false);
});
test("잘림: 입력칸이 늘어 목록이 짧아져도 끝이 보인다", () => {
  const r = I.pinStep({ pinned: true, ct: 1000, vh: 400 }, { y: 600, vh: 340, ch: 1000 });
  assert.equal(r.go, true);
});
test("잘림: 위로 올려 읽는 중이면 새 말풍선이 와도 제자리", () => {
  const r = I.pinStep({ pinned: true, ct: 1000, vh: 400 }, { y: 200, vh: 400, ch: 1700 });
  assert.equal(r.go, false);
  assert.equal(r.pinned, false);
});
test("잘림: 끝 8px 막대가 목록의 마지막 자식이고, 모든 '맨 아래로'가 그것을 가리킨다", () => {
  const body = grab(MAIN, 'blocks.push(div().id("inbox-end")', "this.lastIdx =");
  assert.ok(!/blocks\.push\(/.test(body.slice(body.indexOf("\n"))), "nothing is pushed after the sentinel");
  assert.match(MAIN, /this\.lastIdx = Math\.max\(0, blocks\.length - 1\)/);
  assert.match(MAIN, /id\("inbox-end"\)\.flex_none\(\)\.h\(8\)/);
  assert.match(MAIN, /const last = blocks\.length - 1; \/\/ the end sentinel/);
});

// ---- (3) per-room draft
test("swapDraft: 떠나는 방의 글이 저장되고 도착한 방의 글이 나온다", () => {
  const a = { text: "A 글", content: { text: "A 글", tokens: [] }, range: { start: 1, end: 1 }, pics: [{ path: "x.png" }] };
  let r = I.swapDraft(new Map(), "A", "B", a);
  assert.equal(r.load, null);
  assert.equal(r.map.get("A"), a);
  const b = { text: "B 글", pics: [] };
  r = I.swapDraft(r.map, "B", "A", b);
  assert.equal(r.load, a);
  assert.equal(r.map.has("A"), false); // it is the box again
  assert.equal(r.map.get("B"), b);
});
test("swapDraft: 빈 상자는 항목을 남기지 않고, 같은 방이면 아무것도 안 한다, 상한이 있다", () => {
  let r = I.swapDraft(new Map([["A", { text: "x" }]]), "B", "A", { text: "", pics: [] });
  assert.equal(r.map.has("B"), false);
  r = I.swapDraft(new Map(), "A", "A", { text: "x", pics: [] });
  assert.equal(r.load, null);
  r = I.swapDraft(new Map(), "A", "B", { text: "", pics: [{ path: "p.png" }] }); // only a picture counts as a draft
  assert.equal(r.map.has("A"), true);
  let m = new Map();
  for (let i = 0; i < I.ROOM_DRAFTS_MAX + 5; i++) m = I.swapDraft(m, `r${i}`, `r${i + 1}`, { text: `t${i}`, pics: [] }).map;
  assert.ok(m.size <= I.ROOM_DRAFTS_MAX);
  assert.equal(m.has("r0"), false); // the oldest went
});
test("swapDraft는 main.js와 inbox.cjs가 같다", () => {
  const pick = (s) => grab(s, "const ROOM_DRAFTS_MAX", "\n}\n");
  assert.equal(pick(MAIN), pick(CJS));
});

// The real syncRoom / keep / wipe of main.js against a fake box.
const keepSrc = grab(MAIN, "  keep(key, st, value) {", "  // #66: the chat box holds");
const syncSrc = grab(MAIN, "  syncRoom(pick) {", "  wipe(key, st) {");
const wipeSrc = grab(MAIN, "  wipe(key, st) {", "  guard(key, st, value) {");
const DeskClass = new Function("swapDraft", "editCore", `return class Desk {
  constructor(box) { this.chat = box; this.mirror = new Map(); this.roomDrafts = new Map(); this.draftRoom = null; this.pics = []; this.menu = null; this.heldAt = 0; this.lastValue = ""; this.core = ""; this.brk = null; this.log = []; }
  diag(m) { this.log.push(m); }
  ${keepSrc}
  ${syncSrc}
  ${wipeSrc}
  type(text) { this.chat.set_value(text); this.keep("chat", this.chat, text); }
  send() { this.wipe("chat", this.chat); this.pics = []; this.menu = null; }
}`);
const Desk = DeskClass(I.swapDraft, I.editCore);
function box(text = "") {
  return { v: text, r: { start: text.length, end: text.length }, tokens: [],
    value() { return this.v; }, content() { return { text: this.v, tokens: this.tokens.slice() }; }, selected_range() { return this.r; }, set_selected_range(x) { this.r = x; },
    set_value(x) { this.v = typeof x === "string" ? x : x.text; this.tokens = typeof x === "string" ? [] : (x.tokens ?? []).slice(); this.r = { start: this.v.length, end: this.v.length }; } };
}

test("방 전환: A에서 쓰던 글이 B를 다녀와도 그대로 돌아온다(글, 커서, 멘션 칩, 그림)", () => {
  const d = new Desk(box());
  d.syncRoom("A"); // first look
  d.type("A에 쓰는 글");
  d.chat.tokens = [{ id: "lead-1", text: "@lead-1 " }];
  d.chat.r = { start: 2, end: 2 };
  d.pics = [{ path: "img/a.png", w: 10, h: 10 }];
  d.keep("chat", d.chat);
  d.syncRoom("B");
  assert.equal(d.chat.v, ""); // B has no draft yet
  assert.deepEqual(d.pics, []);
  d.syncRoom("A");
  assert.equal(d.chat.v, "A에 쓰는 글");
  assert.deepEqual(d.chat.r, { start: 2, end: 2 });
  assert.deepEqual(d.chat.tokens, [{ id: "lead-1", text: "@lead-1 " }]);
  assert.deepEqual(d.pics, [{ path: "img/a.png", w: 10, h: 10 }]);
});
test("방 전환: B는 제 글을 따로 가진다", () => {
  const d = new Desk(box());
  d.syncRoom("A"); d.type("A 글");
  d.syncRoom("B"); d.type("B 글");
  d.syncRoom("A");
  assert.equal(d.chat.v, "A 글");
  d.syncRoom("B");
  assert.equal(d.chat.v, "B 글");
});
test("방 전환: 보내면 그 방의 글만 지워진다", () => {
  const d = new Desk(box());
  d.syncRoom("A"); d.type("A 글");
  d.syncRoom("B"); d.type("B 글");
  d.send(); // B sent
  assert.equal(d.chat.v, "");
  d.syncRoom("A");
  assert.equal(d.chat.v, "A 글"); // A untouched
  d.syncRoom("B");
  assert.equal(d.chat.v, ""); // B stays cleared (and keeps no ghost draft)
  assert.equal(d.roomDrafts.has("B"), false);
});
test("방 전환: 되돌린 글은 '사라진 글'로 오인되지 않는다(미러가 새 방의 것으로 바뀐다)", () => {
  const d = new Desk(box());
  d.syncRoom("A"); d.type("A 글");
  d.syncRoom("B");
  assert.equal(d.mirror.has("chat"), false); // B's box is empty: nothing for the guard to restore from A
  d.type("B 글");
  d.syncRoom("A");
  assert.equal(d.mirror.get("chat").text, "A 글");
});
test("방 전환: 같은 방을 다시 알려도(그리기마다) 아무 일도 없다", () => {
  const d = new Desk(box());
  d.syncRoom("A"); d.type("쓰는 중");
  d.syncRoom("A"); d.syncRoom("A");
  assert.equal(d.chat.v, "쓰는 중");
  assert.equal(d.roomDrafts.size, 0);
  d.syncRoom(null);
  assert.equal(d.chat.v, "쓰는 중");
});
test("방 전환은 pickPo와 그리기(view의 자동 방)에서 호출된다", () => {
  assert.match(grab(MAIN, "  pickPo(id, c) {", "setShared(PICK_KEY, id)"), /this\.syncRoom\(id\)/);
  assert.match(MAIN, /const v = this\.view\(\);\n    this\.syncRoom\(v\.pick\);/);
});
