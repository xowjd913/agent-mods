// #110: the answer box of a decision card is the PO chat's kind of box (multi-line Textarea, Enter sends from any cursor position, Shift+Enter is a
// line break, select-all + delete empties it). Fakes only. Whether the real widget takes Cmd+A / a second line is NOT verified here (no live app).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const cut = (a, b) => { const i = MAIN.indexOf(a), j = MAIN.indexOf(b, i + 1); assert.ok(i > 0 && j > i, a); return MAIN.slice(i, j); };

const helpers = cut("// What an Enter does in the box:", "// The \"@query\" being typed right before");
const drafts = MAIN.slice(MAIN.indexOf("const DRAFT_KEY_MS"), MAIN.indexOf("\n", MAIN.indexOf("const draftWiped")) + 1);
const methods = [
  cut("  keep(key, st, value) {", "  // #66: the chat box holds the draft"),
  cut("  wipe(key, st) {", "  // Every box is looked at once per draw"),
  cut("  cardState(leader) {", "  // ---- PO chat: the text goes"),
].join("\n");
const Desk = new Function("MAX", `${drafts}\n${helpers}\nreturn class Desk {
  constructor() { this.cardK = new Map(); this.inputs = new Map(); this.mirror = new Map(); this.keyAt = 0; this.sent = []; this.asked = [{ s: { leader: "lead-a" } }]; this.diag = () => {}; }
  asks() { return this.asked; }
  send(a, text) { this.sent.push(text); const st = this.inputs.get(a.s.leader); this.wipe(a.s.leader, st); this.cardChange(a.s.leader, st); } // (the real send empties the box, and the widget reports that change)
  ${methods}
}`)();

const fake = (text = "") => ({
  v: text, r: { start: text.length, end: text.length },
  value() { return this.v; }, selected_range() { return this.r; }, set_selected_range(x) { this.r = x; },
  set_value(x) { this.v = x; this.r = { start: x.length, end: x.length }; },
  replace(t) { this.v = this.v.slice(0, this.r.start) + t + this.v.slice(this.r.end); const at = this.r.start + t.length; this.r = { start: at, end: at }; },
});
const cx = () => { const c = { timers: [], notified: 0, notify() { c.notified++; }, stop_propagation() {}, timer: { after: (ms, fn) => c.timers.push(fn) } }; return c; };
const setup = (text = "") => { const d = new Desk(); const st = fake(text); d.inputs.set("lead-a", st); return { d, st }; };
// the person edits the text (an IME edit counts as one): the box changes and fires its change event
const edit = (d, st, v, at = 0) => { st.v = v; st.r = { start: v.length, end: v.length }; d.cardChange("lead-a", st); const k = d.cardState("lead-a"); k.editAt = at; k.changedAt = at; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("#110 소스: 카드 답 상자는 PO 채팅과 같은 Textarea(여러 줄, 자동 늘림)이고 한 줄 Input이 아니며, 키·submit·change가 카드용 처리로 이어진다", () => {
  const box = cut("  box(leader, cx) {", "  // #110: the answer box");
  assert.match(box, /TextareaState\.new\(\{ value: "", rows: 1,/);
  assert.match(box, /set_auto_grow\(1, INPUT_MAX_LINES\)/);
  assert.doesNotMatch(box, /InputState\.new/);
  assert.match(box, /s\.on\("submit", \(e, c\) => this\.cardEnter\(leader, e\?\.shift \? "newline" : "send", c\)\)/);
  assert.match(box, /s\.on\("change", \(\) => this\.cardChange\(leader, s\)\)/);
  assert.match(box, /s\.on\("paste_other"/);
  const ask = cut("  askActions(t, a, cx) {", "  // One timeline entry");
  assert.match(ask, /Textarea\.new\(input\)\.min_h\(fz\(30\)\)/);
  assert.doesNotMatch(ask, /Input\.new\(/);
  assert.match(ask, /\.on_key_down\(\(e, c\) => this\.answerKey\(s\.leader, e, c\)\)/);
});

test("#110 Enter: 글 끝에서 한 번 보내고(키+submit은 한 번), 상자에는 줄바꿈이 남지 않는다", async () => {
  const { d, st } = setup();
  edit(d, st, "go with plan 2", Date.now() - 2000); // (a text that ends in Hangul would be held once by the IME rule)
  d.answerKey("lead-a", { key: "Enter", modifiers: {} }, cx());
  d.cardEnter("lead-a", "send", cx()); // the widget's own submit event of the same press
  assert.deepEqual(d.sent, ["go with plan 2"]);
});

test("#110 Enter: 글 가운데에서 쳐도 위젯이 끼운 줄바꿈을 빼고 전체를 보낸다(#83과 같은 규칙)", () => {
  const { d, st } = setup();
  edit(d, st, "앞뒤", Date.now() - 2000);
  st.v = "앞\n뒤"; st.r = { start: 2, end: 2 }; d.cardChange("lead-a", st); // the widget put its break at the cursor
  d.cardEnter("lead-a", "send", cx());
  assert.deepEqual(d.sent, ["앞뒤"]);
  assert.equal(st.v, "", "the box is emptied after the send, with no break left");
});

test("#110 Enter: 글 일부를 고른 채 쳐도 고른 글이 살아서 전체가 간다", () => {
  const { d, st } = setup();
  edit(d, st, "abcd", Date.now() - 2000);
  st.v = "\nd"; st.r = { start: 1, end: 1 }; d.cardChange("lead-a", st); // Enter over the selected "abc": the widget swapped it for a break
  d.cardEnter("lead-a", "send", cx());
  assert.deepEqual(d.sent, ["abcd"]);
});

test("#110 한글 조합 확정 Enter: 방금 고친 글이면 첫 Enter는 붙들고 두 번째가 보낸다", async () => {
  const { d, st } = setup();
  edit(d, st, "안녕하세요", Date.now()); // edited just now
  d.cardEnter("lead-a", "send", cx());
  assert.deepEqual(d.sent, [], "held once");
  await sleep(170);
  d.cardEnter("lead-a", "send", cx());
  assert.deepEqual(d.sent, ["안녕하세요"]);
});

test("#110 Shift+Enter: 위젯이 줄바꿈을 넣지 않으면 40ms 뒤 한 번 넣고, 넣었으면 더 넣지 않으며 보내지 않는다", () => {
  const a = setup();
  edit(a.d, a.st, "한 줄", Date.now() - 2000);
  const c1 = cx();
  a.d.answerKey("lead-a", { key: "Enter", modifiers: { shift: true } }, c1);
  c1.timers.forEach((f) => f());
  assert.equal(a.st.v, "한 줄\n");
  assert.deepEqual(a.d.sent, []);
  const b = setup();
  edit(b.d, b.st, "한 줄", Date.now() - 2000);
  const c2 = cx();
  b.d.answerKey("lead-a", { key: "Enter", modifiers: { shift: true } }, c2);
  b.st.v = "한 줄\n"; b.d.cardChange("lead-a", b.st); // the widget added it itself
  c2.timers.forEach((f) => f());
  assert.equal(b.st.v, "한 줄\n", "no second break");
});

test("#110 두 줄 글은 줄바꿈 그대로 한 번에 간다", () => {
  const { d, st } = setup();
  edit(d, st, "line one\nline two", Date.now() - 2000);
  d.cardEnter("lead-a", "send", cx());
  assert.deepEqual(d.sent, ["line one\nline two"]);
});

test("#110 전체 선택 후 지우기: 상자가 비면 초안 복사본도 비워져 되살아나지 않는다(키 입력 직후든 한참 뒤든)", () => {
  const { d, st } = setup();
  edit(d, st, "지울 글\n두 번째 줄", Date.now() - 2000);
  assert.equal(d.mirror.get("lead-a").text, "지울 글\n두 번째 줄");
  d.keyAt = Date.now(); // the Backspace / Delete key
  st.v = ""; st.r = { start: 0, end: 0 };
  d.cardChange("lead-a", st);
  assert.equal(st.v, "");
  assert.equal(d.mirror.has("lead-a"), false);
  d.keyAt = 0;
  d.guard("lead-a", st); // a later draw/poll look
  assert.equal(st.v, "", "the person's delete stays");
});

test("#110 보낸 뒤 비운 상자에 위젯이 늦게 끼운 줄바꿈 하나는 지운다", () => {
  const { d, st } = setup();
  edit(d, st, "ok", Date.now() - 2000);
  d.cardEnter("lead-a", "send", cx());
  assert.equal(st.v, "");
  st.v = "\n"; d.cardChange("lead-a", st);
  assert.equal(st.v, "");
});
