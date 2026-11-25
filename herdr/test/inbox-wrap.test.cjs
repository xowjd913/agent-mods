// Tests of the wrapper tags (<hc from=...>, <pasted_content ...>) and the Markdown prep of the PO desk bubbles (#36, #37, round 14 A/B/C/D).
// What the real app draws (the Markdown look, the thumbnail) cannot be tested here; these cover the text rules and the shape of the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
const ROOT = "/app";
const PIC = `${ROOT}/data/inbox/img/ab12.png`;

test("A: unwrapTags removes the <hc from=...> wrapper of a leader report and keeps the words", () => {
  const t = '<hc from="t137 lead-po-inbox">[lead-po-inbox] 설치 완료: 확인해 주세요 </hc>';
  assert.equal(I.unwrapTags(t), "[lead-po-inbox] 설치 완료: 확인해 주세요");
  assert.equal(I.unwrapTags('<hc from="a b">\nline 1\nline 2\n</hc>'), "line 1\nline 2");
  assert.equal(I.unwrapTags("plain text"), "plain text");
});

test("A: a report line with the wrapper reaches the desk without it (parseLines title and body)", () => {
  const line = JSON.stringify({ ts: "2026-01-01T00:00:00Z", leader: "lead-x", kind: "done", title: '<hc from="t1 lead-x">[x] 끝</hc>', body: '<hc from="t1 lead-x">[x] 설치 완료: 본문\n- 하나</hc>' });
  const [it] = I.parseLines(line + "\n");
  assert.ok(it, "the line is kept");
  assert.ok(!/<\/?hc/.test(it.title + it.body));
  assert.match(it.body, /^\[x\] 설치 완료: 본문\n- 하나$/);
});

test("C: unwrapTags removes the pasted_content wrapper in every form (id attribute, backslash, closing with id)", () => {
  assert.equal(I.unwrapTags('<pasted_content id="6f0a">\nhello\n</pasted_content id="6f0a">'), "hello");
  assert.equal(I.unwrapTags('<\\pasted_content id="6f0a">\nhello\n<\\/pasted_content id="6f0a">'), "hello");
  assert.equal(I.unwrapTags('<pasted_content>hello</pasted_content>'), "hello");
  assert.equal(I.unwrapTags('<\\/pasted_content id="1">'), "");
});

test("C: a tag only mentioned in a sentence stays", () => {
  const t = "the <hc from=x> tag and a </hc> mention and <pasted_content id=1> inside a sentence";
  assert.equal(I.unwrapTags(t), t);
  assert.equal(I.unwrapTags("use `<hc>` like this"), "use `<hc>` like this");
});

test("C: parsePoLines drops the wrapper from say and me lines and a wrapper-only line is nothing", () => {
  const l = (o) => JSON.stringify({ ts: "2026-01-01T00:00:10Z", ...o });
  const out = I.parsePoLines([
    l({ kind: "me", text: '<\\pasted_content id="a">\nhi\n<\\/pasted_content id="a">' }),
    l({ kind: "say", text: '<hc from="t1 lead-x">answer</hc>' }),
    l({ kind: "me", text: '<pasted_content id="b"></pasted_content id="b">' }),
  ].join("\n"));
  assert.deepEqual(out.map((x) => x.text), ["hi", "answer"]);
});

test("C: one bubble per sent message - the hook copy with the wrapper is dropped like the clean one", () => {
  const ms = Date.parse("2026-01-01T00:00:00Z");
  const line = `hello\n${I.imgLine(PIC)}\n${I.imgLine(`${ROOT}/data/inbox/img/cd34.png`)}`;
  const mine = [{ id: "1", ms, at: ms, ts: new Date(ms).toISOString(), text: "hello", imgs: [PIC, `${ROOT}/data/inbox/img/cd34.png`], line, to: "", po: "p1", kind: "chat", status: "sent" }];
  const wrapped = `<\\pasted_content id="x1">\n${line}\n<\\/pasted_content id="x1">`;
  const hook = [{ ts: new Date(ms + 2000).toISOString(), ms: ms + 2000, text: wrapped, me: true }];
  const tl = I.timeline("p1", [], hook, mine, [], ms + 5000);
  assert.equal(tl.filter((e) => e.who === "me").length, 1);
  assert.equal(tl.length, 1);
});

test("C: the hook copy that differs only in how the picture lines are written still matches by words and pictures", () => {
  const ms = Date.parse("2026-01-01T00:00:00Z");
  const mine = [{ id: "1", ms, at: ms, ts: new Date(ms).toISOString(), text: "hello", imgs: [PIC], line: `hello\n${I.imgLine(PIC)}`, to: "", po: "p1", kind: "chat", status: "sent" }];
  const hook = [{ ts: new Date(ms + 1000).toISOString(), ms: ms + 1000, text: `<pasted_content id="q">\nhello\n[image: ${PIC}]\n</pasted_content id="q">`, me: true }];
  assert.equal(I.timeline("p1", [], hook, mine, [], ms + 5000).length, 1);
});

test("C: a typed line that is not a desk send stays, and a different text with the same wrapper is not dropped", () => {
  const ms = Date.parse("2026-01-01T00:00:00Z");
  const mine = [{ id: "1", ms, at: ms, ts: new Date(ms).toISOString(), text: "hello", line: "hello", to: "", po: "p1", kind: "chat", status: "sent" }];
  const hook = [{ ts: new Date(ms + 1000).toISOString(), ms: ms + 1000, text: '<pasted_content id="q">\nsomething else\n</pasted_content id="q">', me: true }];
  const tl = I.timeline("p1", [], hook, mine, [], ms + 5000);
  assert.equal(tl.length, 2);
  assert.ok(tl.some((e) => e.typed && e.text === "something else"));
});

test("C/A: chatHtml and bubbleParts never show a wrapper tag", () => {
  const t = `<\\pasted_content id="z">\nwords\n${I.imgLine(PIC)}\n<\\/pasted_content id="z">`;
  assert.ok(!/pasted_content/.test(I.chatHtml(t)));
  const bp = I.bubbleParts(t, [], ROOT);
  assert.equal(bp.text, "words");
  assert.deepEqual(bp.imgs, [PIC]);
  assert.ok(!/<\/?hc/.test(I.chatHtml('<hc from="t1 lead-x">hi</hc>')));
});

test("D: mdText strips wrappers before the Markdown view, bolds a 【...】 line, keeps line breaks, passes no HTML through as HTML", () => {
  const out = I.mdText('<hc from="t1 lead-x">\n【확인 필요】\n첫 줄\n둘째 줄\n\n- 항목 **굵게**\n</hc>');
  assert.ok(!/<hc|<\/hc/.test(out));
  assert.match(out, /^\*\*【확인 필요】\*\*  \n첫 줄  \n둘째 줄\n\n- 항목 \*\*굵게\*\*$/);
  // markup stays markup text for raw_html(false): nothing is converted into tags here
  assert.equal(I.mdText("a <b>x</b> <script>1</script>"), "a <b>x</b> <script>1</script>");
  assert.match(I.mdText("![x](file:///etc/passwd)"), /^!\\\[x\]/); // an image becomes a plain link, never a picture load
});

test("D: mdText leaves code fences as written", () => {
  const out = I.mdText("앞\n```\nline a\nline b\n```\n뒤");
  assert.equal(out, "앞\n```\nline a\nline b\n```\n뒤");
  assert.ok(out.includes("line a\nline b"));
});

test("D: toParts gives each prose part its Markdown source (bold markers kept)", () => {
  const parts = I.toParts(I.parseBody("**중요** 안내\n- 하나\n- 둘 `x`"));
  const prose = parts.find((p) => p.t === "prose");
  assert.ok(prose && typeof prose.md === "string");
  assert.match(prose.md, /\*\*중요\*\* 안내/);
  assert.match(prose.md, /- 하나\n- 둘 `x`/);
});

test("B/D: the code draws a thumbnail from the app-relative path, and bubbles use the Markdown view with raw_html(false)", () => {
  assert.match(MAIN, /thumb\(t, x\) \{[\s\S]*?imgRel\(this\.data\?\.root \?\? "", x\.path\)/);
  assert.ok(!/image\(x\.path\)/.test(MAIN), "the chip must not pass an absolute path to image()");
  assert.match(MAIN, /TextView\.markdown\(id, mdText\(src\)\)\.raw_html\(false\)\.selectable\(true\)\.on_link_click/);
  assert.match(MAIN, /this\.md\(id, e\.text\)/);
});

// ---- E: the "···" rows (round 14)
const tmT = (o) => ({ address: "t1", name: "", labels: {}, status: "idle", parent: "", where: "", title: "", ...o });
const po28 = (o = {}) => tmT({ address: "t28", name: "po-inbox", labels: { role: "po", po: "pa" }, where: "공간 / PO · 데스크", ...o });
const lead137 = (o = {}) => tmT({ address: "t137", name: "lead-po-inbox", parent: "t28", ...o });

test("E: a leader like lead-po-inbox (t137, parent t28) shows in the room of its PO while hc status is working", () => {
  const rows = I.typingNow([po28(), lead137({ status: "working" })], "pa", {});
  assert.deepEqual(rows.map((x) => x.who), ["l:lead-po-inbox"]);
  assert.deepEqual(I.typingNow([po28(), lead137({ status: "idle" })], "pa", {}), []); // gone when the status leaves working
  assert.deepEqual(I.typingNow([po28({ status: "working" }), lead137({ status: "working" })], "pa", {}).map((x) => x.who), ["po", "l:lead-po-inbox"]);
});

test("E: the PO row and a leader row come from hc status only (a terminal title or screen words do not count)", () => {
  const t = [po28({ title: "Working… esc to interrupt" }), lead137({ title: "✻ Working", where: "working" })];
  assert.deepEqual(I.typingNow(t, "pa", {}), []);
});

test("E: statusSig changes when a leader starts and stops working, so the 1.5 s poll redraws", () => {
  const idle = I.statusSig([po28(), lead137({ status: "idle" })]);
  const work = I.statusSig([po28(), lead137({ status: "working" })]);
  assert.notEqual(idle, work);
  assert.equal(I.statusSig([po28(), lead137({ status: "idle" })]), idle);
});

test("E: the typing rows are drawn in every filter (no 'all' gate) and after the last message", () => {
  assert.ok(!/v\.filter === "all"\)\s*for \(const x of typingNow/.test(MAIN), "no filter gate on the typing rows");
  assert.match(MAIN, /for \(const x of typingNow\(v\.terms, v\.pick, namesMemo\(\)\)\) blocks\.push\(this\.typingRow\(t, x\)\)/);
  const i = MAIN.indexOf("typingNow(v.terms, v.pick");
  assert.ok(i > MAIN.indexOf("v.entries.forEach((e) => {"), "typing rows come after the entries");
});
