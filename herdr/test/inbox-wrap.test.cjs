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
  assert.match(MAIN, /TextView\.markdown\(id, m\)\.raw_html\(false\)\.selectable\(true\)\.on_link_click/);
  assert.match(MAIN, /this\.md\(id, e\.text, t\)/);
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
  assert.ok(!/v\.filter === "all"\)\s*for \(const x of this\.typing/.test(MAIN), "no filter gate on the typing rows");
  assert.match(MAIN, /for \(const x of this\.typing\(v\)\) blocks\.push\(this\.typingRow\(t, x\)\)/);
  const i = MAIN.indexOf("this.typing(v)");
  assert.ok(i > MAIN.indexOf("v.entries.forEach((e) => {"), "typing rows come after the entries");
});

// ---- Round 15 F: the answer box of a 결정 필요 card takes pictures like the PO box (same code, per-leader list).
// The picture methods are cut out of main.js and run against a fake exec, so the shared code is what is tested.
function pictureDesk(execImpl) {
  const a = MAIN.indexOf("  picsOf(key = null)");
  const b = MAIN.indexOf("  // The thumbnail chips of a box");
  assert.ok(a > 0 && b > a, "the picture methods are found");
  const body = MAIN.slice(a, b);
  const make = new Function("exec", "HELPER", "MAX_IMGS", "pickFiles", `return class Desk {
    constructor() { this.pics = []; this.picBusy = 0; this.replyPics = new Map(); this.replyBusy = new Map(); this.imgd = new Map(); this.msg = "x"; this.said = []; }
    say(m, bad) { this.said.push([m, Boolean(bad)]); }
    ${body}
  }`);
  return new (make(execImpl, () => "helper.cjs", 4, async () => ["/f/a.png"]))();
}
const fakeCx = () => ({ notify() {} });
const okExec = async (_cmd, args) => ({ code: 0, stdout: JSON.stringify({ path: `data/inbox/img/${args[args.length - 1].replace(/\W/g, "")}.png`, w: 10, h: 20 }), stderr: "" });

test("F: a picture added for a leader lands in that leader's list only, and the PO box list is untouched", async () => {
  const d = pictureDesk(okExec);
  await d.addPic(["clipimg"], fakeCx(), "lead-a");
  assert.equal(d.picsOf("lead-a").length, 1);
  assert.equal(d.picsOf("lead-b").length, 0);
  assert.equal(d.pics.length, 0);
  assert.equal(d.busyOf("lead-a"), 0, "busy is released");
  assert.equal(d.replyBusy.size, 0);
});

test("F: the PO box still uses this.pics (key null)", async () => {
  const d = pictureDesk(okExec);
  await d.pastePic(fakeCx());
  assert.equal(d.pics.length, 1);
  assert.equal(d.replyPics.size, 0);
});

test("F: the leader list is capped at MAX_IMGS, skips a duplicate path, and can drop one picture", async () => {
  let n = 0;
  const d = pictureDesk(async () => ({ code: 0, stdout: JSON.stringify({ path: `data/inbox/img/p${n++}.png`, w: 1, h: 1 }), stderr: "" }));
  for (let i = 0; i < 6; i++) await d.addPic(["clipimg"], fakeCx(), "lead-a");
  assert.equal(d.picsOf("lead-a").length, 4);
  assert.ok(d.said.some(([m, bad]) => /4장/.test(m) && bad));
  d.removePic(1, fakeCx(), "lead-a");
  assert.deepEqual(d.picsOf("lead-a").map((x) => x.path), ["data/inbox/img/p0.png", "data/inbox/img/p2.png", "data/inbox/img/p3.png"]);
  const same = pictureDesk(async () => ({ code: 0, stdout: JSON.stringify({ path: "data/inbox/img/same.png" }), stderr: "" }));
  await same.addPic(["clipimg"], fakeCx(), "lead-a");
  await same.addPic(["clipimg"], fakeCx(), "lead-a");
  assert.equal(same.picsOf("lead-a").length, 1);
});

test("F: a failed read says so and leaves the leader's list as it was", async () => {
  const d = pictureDesk(async () => ({ code: 1, stdout: "", stderr: "no picture on the clipboard" }));
  await d.pastePic(fakeCx(), "lead-a");
  assert.equal(d.picsOf("lead-a").length, 0);
  assert.ok(d.said.some(([m, bad]) => /그림을 붙이지 못했습니다/.test(m) && bad));
  assert.equal(d.busyOf("lead-a"), 0);
});

test("F: the file button and a drop add to the leader's list", async () => {
  const d = pictureDesk(okExec);
  await d.pickPics(fakeCx(), "lead-a");
  assert.equal(d.picsOf("lead-a").length, 1);
  d.dropPics(["/x/b.png"], fakeCx(), "lead-b");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.picsOf("lead-b").length, 1);
  assert.equal(d.pics.length, 0);
});

test("F: the answer box wires paste_other, the 그림 button, drop and the chip row for its leader", () => {
  const box = MAIN.slice(MAIN.indexOf("  box(leader, cx) {"), MAIN.indexOf("// ---- PO chat"));
  assert.match(box, /s\.on\("paste_other", \(_e, c\) => this\.pastePic\(c, leader\)\)/);
  const ask = MAIN.slice(MAIN.indexOf("  askActions(t, a, cx) {"), MAIN.indexOf("  // One timeline entry"));
  assert.match(ask, /this\.picRow\(t, s\.leader\)/);
  assert.match(ask, /attach-\$\{s\.leader\}/);
  assert.match(ask, /this\.pickPics\(c, s\.leader\)/);
  assert.match(ask, /this\.dropPics\(ev\?\.paths, c, s\.leader\)/);
  assert.match(MAIN, /this\.picRow\(t, null\)/, "the PO box draws the same chip row");
  // the decision option buttons and 확인 완료 are unchanged
  assert.match(ask, /this\.send\(a, `\$\{n\}안 선택`, c, "choice"\)/);
  assert.match(ask, /this\.send\(a, "확인 완료", c, "verify"\)/);
});

test("F: the answer carries the pictures as Read-tool lines and in the bubble record; the option buttons carry none", () => {
  const send = MAIN.slice(MAIN.indexOf("  send(a, text, cx"), MAIN.indexOf("  clearBox(a, how"));
  assert.match(send, /kind === "answer" \? this\.picsOf\(a\.s\.leader\)/);
  assert.match(send, /pics\.map\(\(x\) => imgLine\(x\.path\)\)/);
  assert.match(send, /imgs: pics\.map\(\(x\) => x\.path\)/);
  assert.match(send, /!body && !pics\.length/, "a picture alone is an answer");
  const clear = MAIN.slice(MAIN.indexOf("  clearBox("), MAIN.indexOf("  box(leader, cx)"));
  assert.match(clear, /this\.setPics\(leader, /);
});

test("F: the answer line plus image lines is the same shape the PO box sends", () => {
  const line = [I.answerLine("decision", "lead-a", "1안으로", ""), I.imgLine(PIC)].join("\n");
  const [first, second, ...rest] = line.split("\n");
  assert.match(first, /^Panel answer \(decision\) for lead-a: "1안으로"\.$/);
  assert.match(second, /^\[image: .*ab12\.png/);
  assert.equal(rest.length, 0);
});

// ---- round 16
test("R16: unwrapTags stays fast on a long run of blanks (no quadratic closing-tag scan)", () => {
  for (const ch of [" ", "\t", " \t"]) {
    const run = ch.repeat(80000);
    for (const t of [`a${run}b <`, `<${run}x`, `a${run}</hc`, `${run}<\\/pasted_content id=1>`, `x${run}<b>`]) {
      const t0 = process.hrtime.bigint();
      I.unwrapTags(t);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 100, `${JSON.stringify(t.slice(0, 12))}… took ${ms} ms`);
    }
  }
  // the lookbehind changes nothing for normal text
  assert.equal(I.unwrapTags("a  </hc>\nb \t<\\/pasted_content id=1>"), "a\nb");
  assert.equal(I.unwrapTags('<hc from="x">\n  hi  \n</hc>'), "hi");
});

test("R16: the same closing-tag regex is in the mod copy, and the terminal-line trims are linear", () => {
  assert.match(MAIN, /const WRAP_CLOSE = \/\(\?<!\[ \\t\]\)\[ \\t\]\*<\\\\\?\\\/\(\?:hc\|pasted_content\)\\b\[\^<>\\n\]\*>\[ \\t\]\*\$\/gim;/);
  const t0 = process.hrtime.bigint();
  I.promptTail(`a${" ".repeat(80000)}b`);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100);
  assert.doesNotMatch(MAIN, /replace\(\/\\s\+\$\//);
});

function replyDesk(store = {}) {
  const grab = (name, end) => { const a = MAIN.indexOf(name), b = MAIN.indexOf(end, a); assert.ok(a > 0 && b > a, name); return MAIN.slice(a, b); };
  const body = [grab("  picsOf(key = null)", "  bumpBusy("), grab("  pruneReply(asks)", "  pruneSent(asks)"), grab("  clearBox(a, how", "  box(leader, cx)")].join("\n");
  const make = new Function("shared", "setShared", "SENT_KEY", `return class Desk {
    constructor() { this.pics = []; this.replyPics = new Map(); this.replyBusy = new Map(); this.inputs = new Map(); this.writing = null; }
    askKey(a) { return a.kind + "|" + a.link; }
    ${body}
  }`);
  return new (make((k) => store[k], (k, v) => { store[k] = v; }, "sent"))();
}
const ASK = (leader) => ({ kind: "decision", link: "l", s: { leader } });
const fakeInput = (v) => ({ v, value() { return this.v; }, set_value(x) { this.v = x; } });

test("R16: a text-only answer waits while a picture of that box is still being read", () => {
  const send = MAIN.slice(MAIN.indexOf("  send(a, text, cx"), MAIN.indexOf("  // clearBox") > 0 ? MAIN.indexOf("  // clearBox") : MAIN.indexOf("  clearBox(a, how"));
  assert.match(send, /kind === "answer" && this\.busyOf\(a\.s\.leader\)/);
  assert.doesNotMatch(send, /pics\.length && this\.busyOf/);
  assert.ok(send.indexOf("this.busyOf") < send.indexOf("!body && !pics.length"), "the busy check comes first");
});

test("R16: answer boxes of leaders that are gone lose their pictures and reads", () => {
  const d = replyDesk();
  d.replyPics.set("lead-a", [{ path: "p1" }]); d.replyPics.set("lead-gone", [{ path: "p2" }]);
  d.replyBusy.set("lead-gone", 1); d.replyBusy.set("lead-a", 1);
  d.pruneReply([ASK("lead-a")]);
  assert.deepEqual([...d.replyPics.keys()], ["lead-a"]);
  assert.deepEqual([...d.replyBusy.keys()], ["lead-a"]);
  d.pruneReply([]);
  assert.equal(d.replyPics.size + d.replyBusy.size, 0);
  assert.match(MAIN, /const all = this\.asks\(\);\n\s*this\.pruneReply\(all\);/, "view() prunes on every draw");
});

test("R16: a late clear removes only what was sent, not words or pictures added meanwhile", () => {
  const store = {};
  const d = replyDesk(store);
  const a = ASK("lead-a");
  d.inputs.set("lead-a", fakeInput("new words"));
  d.setPics("lead-a", [{ path: "sent.png" }, { path: "later.png" }]);
  d.clearBox(a, "held", { text: "the answer", imgs: ["sent.png"] });
  assert.equal(d.inputs.get("lead-a").v, "new words", "words typed meanwhile stay");
  assert.deepEqual(d.picsOf("lead-a").map((x) => x.path), ["later.png"]);
  assert.equal(store.sent["lead-a"], "decision|l|held", "the ask is still marked");
  // the box still holding what was sent is emptied
  d.inputs.get("lead-a").v = "the answer ";
  d.clearBox(a, "sent", { text: "the answer", imgs: ["later.png"] });
  assert.equal(d.inputs.get("lead-a").v, "");
  assert.equal(d.picsOf("lead-a").length, 0);
  assert.equal(store.sent["lead-a"], "decision|l");
  // an option button sends its fixed word: a draft stays; a call without `sent` clears everything
  d.inputs.get("lead-a").v = "draft"; d.setPics("lead-a", [{ path: "x.png" }]);
  d.clearBox(a, "sent", { text: "1안 선택", imgs: [] });
  assert.equal(d.inputs.get("lead-a").v, "draft");
  assert.equal(d.picsOf("lead-a").length, 1);
  d.clearBox(a, "sent");
  assert.equal(d.inputs.get("lead-a").v, "");
  assert.equal(d.picsOf("lead-a").length, 0);
});

// ---- Round 17: bold that shows, diag that is always flushed, copy fallback, drag hardening
const ranges = (s) => I.boldRanges(s).map((r) => s.slice(r.start, r.end));

test("R17: boldRanges finds **bold** runs as UTF-16 source offsets, skipping code, fences and escapes", () => {
  assert.deepEqual(ranges("a **b** c **d e** end"), ["**b**", "**d e**"]);
  assert.deepEqual(ranges("`**x**` and ``**y** ` **z**`` then **w**"), ["**w**"]);
  assert.deepEqual(ranges("```\n**in fence**\n```\n**out**"), ["**out**"]);
  assert.deepEqual(ranges("\\**not** and **yes**"), ["**yes**"]);
  assert.deepEqual(ranges("** lone ** and **w **"), []);
  assert.deepEqual(ranges("**unterminated"), []);
  // offsets count UTF-16 units: Korean is one unit, an emoji two - the slice above is the proof, and so is the exact number here
  const s = "😀한글 **굵게😀** 끝";
  const [r] = I.boldRanges(s);
  assert.deepEqual([r.start, r.end], [s.indexOf("**"), s.lastIndexOf("**") + 2]);
  assert.equal(s.slice(r.start, r.end), "**굵게😀**");
  // the ranges are computed on the very string given to markdown (a 【...】 line is made bold by mdText)
  assert.deepEqual(ranges(I.mdText("【결과】\nplain **b**")), ["**【결과】**", "**b**"]);
});

test("R17: boldRanges is bounded (long lines, many markers)", () => {
  const t0 = process.hrtime.bigint();
  assert.deepEqual(I.boldRanges("**a** ".repeat(5000)).length <= 100, true);
  I.boldRanges("`".repeat(1999) + "**x**");
  I.boldRanges("** ".repeat(600));
  I.boldRanges(("`a ".repeat(600) + "\n").repeat(20));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 500);
});

test("R17: the mod copy of boldRanges is the same code, and md() paints a tint behind each run of the same string", () => {
  const grab = (src) => src.slice(src.indexOf("function boldRanges(md)"), src.indexOf("// A message text as Markdown for a TextView"));
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.equal(grab(MAIN), grab(CJS));
  const md = MAIN.slice(MAIN.indexOf("  md(id, src, t) {"), MAIN.indexOf("  text(id, html) {"));
  assert.match(md, /const m = mdText\(src\);/);
  assert.match(md, /TextView\.markdown\(id, m\)/);
  assert.match(md, /const bc = tintHex\(t, "bold"\)/);
  assert.match(md, /for \(const r of boldRanges\(m\)\) tv = tv\.highlight_range\(r\.start, r\.end, bc\)/);
  assert.match(MAIN, /this\.md\(key, p\.md, t\)/);
});

test("R17: md() really calls highlight_range once per bold run (stub TextView)", () => {
  const body = MAIN.slice(MAIN.indexOf("  md(id, src, t) {"), MAIN.indexOf("  text(id, html) {"));
  const calls = [];
  const tv = { raw_html() { return this; }, selectable() { return this; }, on_link_click() { return this; }, on_selection_change() { return this; }, highlight_range(a, b, c) { calls.push([a, b, c]); return this; } };
  const make = new Function("TextView", "mdText", "boldRanges", "openUrl", "tintHex", "selRangeOf", `return class D { ${body} }`);
  const d = new (make({ markdown: () => tv }, I.mdText, I.boldRanges, () => {}, I.tintHex, I.selRangeOf))();
  const th = { foreground: "#aabbcc", background: "#101010", accent: "#3366ff" };
  const bc = I.tintHex(th, "bold");
  d.md("x", "a **b** c **d**", th);
  assert.deepEqual(calls, [[2, 7, bc], [10, 15, bc]]);
  calls.length = 0;
  d.md("x", "a **b**"); // no theme: nothing painted
  assert.equal(calls.length, 0);
});

test("R17: pruneReply also empties the reply text of a leader that is gone", () => {
  const d = replyDesk();
  d.inputs.set("lead-a", fakeInput("keep me")); d.inputs.set("lead-gone", fakeInput("old draft"));
  d.pruneReply([ASK("lead-a")]);
  assert.equal(d.inputs.get("lead-a").v, "keep me");
  assert.equal(d.inputs.get("lead-gone").v, "");
});

function diagDesk(exec) {
  const body = MAIN.slice(MAIN.indexOf("  diag(msg, _cx) {"), MAIN.indexOf("  // A press the list itself got"));
  const make = new Function("exec", "HELPER", `return class D { ${body} }`);
  return new (make(exec, () => "inbox.cjs"))();
}

test("R17: diag() needs no timer: a line queued with a cx that has no .timer is still written by flushDiag", async () => {
  const written = [];
  const d = diagDesk((cmd, args) => { written.push(JSON.parse(args[2])); return Promise.resolve({ code: 0 }); });
  d.diag("render line", {}); d.diag("selection line", { notify() {} }); d.diag("no cx at all");
  assert.equal(written.length, 0, "diag itself only queues");
  d.flushDiag();
  assert.equal(written.length, 1);
  assert.equal(written[0].length, 3);
  assert.match(written[0][0], / render line$/);
  d.flushDiag(); // nothing queued: no call
  assert.equal(written.length, 1);
});

test("R17: diagBusy cannot stick: a failing or hanging write does not stop later flushes", async () => {
  let n = 0;
  const d = diagDesk(() => { n++; return n === 1 ? Promise.reject(new Error("boom")) : n === 2 ? new Promise(() => {}) : Promise.resolve({}); });
  d.diag("a"); d.flushDiag();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(d.diagBusy, false, "a rejected write frees the flag");
  d.diag("b"); d.flushDiag(); // hangs
  d.diag("c"); d.flushDiag();
  assert.equal(n, 2, "while a write is in flight the next flush waits");
  d.diagBusyAt -= 20000; // the hung write is given up after 15s
  d.flushDiag();
  assert.equal(n, 3);
  const full = diagDesk(() => Promise.resolve({}));
  for (let i = 0; i < 100; i++) full.diag("x");
  assert.equal(full.diagQ.length, 40, "the queue is capped");
});

test("R17: init starts the flush timer on the view's own cx and logs one init line; callers never need cx.timer", () => {
  assert.match(MAIN, /cx\.timer\.every\(DIAG_FLUSH_MS, \(\) => this\.flushDiag\(\)\);/);
  assert.match(MAIN, /this\.diag\(`init: /);
  const diag = MAIN.slice(MAIN.indexOf("  diag(msg, _cx) {"), MAIN.indexOf("  // A press the list itself got"));
  assert.doesNotMatch(diag, /cx\.timer|cx\?\.timer/);
});

test("R17: each bubble has a 복사 chip that copies the unwrapped text; background redraws and the pin wait for a drag", () => {
  const side = MAIN.slice(MAIN.indexOf("  sideTools(t, id, text, ms) {"), MAIN.indexOf("  codeBlock("));
  assert.match(side, /this\.copy\(key, unwrapTags\(text\), cx\)/);
  assert.match(side, /on_mouse_down\("left", stop\)/);
  assert.equal((MAIN.match(/this\.sideTools\(t, id, e\.text, e\.ms\)/g) ?? []).length, 2, "mine and the PO's");
  // every background source goes through softNotify or the quiet check
  assert.match(MAIN, /if \(!same\) this\.softNotify\(cx\);/);
  assert.match(MAIN, /this\.narrow = n; this\.softNotify\(cx\)/, "a resize redraw goes through softNotify (onSize)");
  assert.match(MAIN, /if \(r\.go && quietNow\(this\.ui, Date\.now\(\)\)\) return;/);
  assert.doesNotMatch(MAIN, /!this\.ui\.press\) this\.scroll/);
  // TextView ids are the content-keyed timeline ids (or the same id + part index): they do not change between draws
  assert.match(MAIN, /const id = tlId\(e\.key\);/);
  assert.match(MAIN, /const key = `\$\{id\}-\$\{i\}`;/);
});

// ---- Round 18: main.js is run for real (nothing is injected), so a name that is used but never defined fails here
// (R17 used DIAG_FLUSH_MS and BOLD_TINT without defining them: init threw, and md() swallowed the error)
function loadInbox(over = {}) {
  const chain = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : chain),
    apply: () => chain,
    construct: () => chain,
  });
  class View {}
  const mods = {
    "gpui-kit": { View, div: chain, svg: chain, image: chain },
    "gpui-base": { v_flex: chain, h_flex: chain, InputState: chain, Input: chain, TextareaState: chain, Textarea: chain, TextView: chain, ScrollHandle: chain, ...over.base },
    herdr: { theme: () => ({}), exec: () => Promise.resolve({ code: 0, stdout: "" }), appHome: () => "/nonexistent-app-home", checking: () => false, window: chain, run: chain, hc: () => Promise.resolve({}),
      terminals: () => [], panes: () => [], focused: () => null, setBadge: () => {}, shared: () => undefined, setShared: () => {}, props: () => ({ mode: "window" }),
      openOverlay: () => {}, closeOverlay: () => {}, watchFolder: () => {}, pickFiles: () => Promise.resolve([]), ...over.herdr },
  };
  let src = MAIN.replace(/^import \{([^}]*)\} from "([^"]+)";/gm, (_m, names, mod) => `const {${names}} = __mods[${JSON.stringify(mod)}];`);
  src = src.replace("export default class Inbox", "class Inbox") + "\nreturn Inbox;";
  return new Function("__mods", `"use strict";\n${src}`)(mods);
}
function initCx() {
  const timers = [];
  const base = { timers, notify() {}, write_to_clipboard() {}, timer: { every: (ms, fn) => timers.push({ ms, fn }), after: () => {} } };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : anyOf) }); // any other cx method is a no-op
}
const anyOf = new Proxy(function () {}, { get: () => anyOf, apply: () => anyOf });

test("R18: main.js loads and init() runs to the end: the flush timer is set and the init line is queued", () => {
  const Inbox = loadInbox();
  const d = new Inbox();
  const cx = initCx();
  d.init({}, cx);
  assert.ok(cx.timers.some((t) => t.ms === 2000), "the diag flush timer (2000 ms) is set");
  assert.ok(cx.timers.some((t) => t.ms === 250), "the pin tick is set");
  assert.equal(d.diagQ.length, 1);
  assert.match(d.diagQ[0], /init: window$/);
});

test("R18: the tint constants are defined as numbers/hex alpha, and md() paints with them (no stub injects them)", () => {
  assert.match(MAIN, /^const DIAG_FLUSH_MS = \d+/m);
  assert.doesNotMatch(MAIN, /BOLD_TINT/, "the fixed 20% foreground tint is gone");
  assert.doesNotMatch(MAIN, /HL_ECHO_MS/, "R21: the echo guard is gone");
  const calls = [];
  const tv = { raw_html() { return this; }, selectable() { return this; }, on_link_click() { return this; }, on_selection_change() { return this; }, highlight_range(a, b, c) { calls.push([a, b, c]); return this; } };
  const Inbox = loadInbox({ base: { TextView: { markdown: () => tv } } });
  const d = new Inbox();
  d.md("x", "a **b** c", { foreground: "#112233", background: "#ffffff", accent: "#2255cc" });
  assert.equal(calls.length, 1, "a ReferenceError inside md() would have been swallowed and painted nothing");
  assert.deepEqual(calls[0].slice(0, 2), [2, 7]);
  assert.match(calls[0][2], /^#2255cc[0-9a-f]{2}$/);
});

test("R18: pinTick keeps the pin when a scroll is held back, so the view goes to the bottom after the release", () => {
  const Inbox = loadInbox();
  const d = new Inbox();
  const jumps = [];
  let ch = 1000;
  d.scroll = { offset: () => ({ y: 600 }), viewport_size: () => ({ height: 400 }), content_size: () => ({ height: ch }), scroll_to_item: (i) => jumps.push(i) };
  d.drawnAt = 1; d.lastIdx = 7;
  d.pin = { pinned: true, ct: 1000 };
  d.ui = { sels: new Map(), sel: true, selAt: Date.now(), press: false, pressAt: 0 }; // a settled selection holds the scroll
  ch = 1100; // the content grew without a redraw (a late picture, a narrower window)
  d.pinTick({ notify() {} });
  assert.deepEqual(d.pin, { pinned: true, ct: 1000 }, "held: pinned and the old height stay");
  d.pinTick({ notify() {} });
  d.pinTick({ notify() {} });
  assert.deepEqual(d.pin, { pinned: true, ct: 1000 });
  assert.equal(jumps.length, 0);
  d.ui.sel = false; // released
  d.pinTick({ notify() {} });
  assert.deepEqual(jumps, [7], "the next tick after the release still sees the growth and goes to the bottom");
  assert.deepEqual(d.pin, { pinned: true, ct: 1100 });
  // not held and no growth: the pin is stored as before
  d.pinTick({ notify() {} });
  assert.equal(jumps.length, 1);
});

test("R18: pruneReply clears only a leader's non-empty draft; copy() redraws through softNotify", () => {
  const d = replyDesk();
  let sets = 0;
  const empty = fakeInput(""); const set0 = empty.set_value.bind(empty); empty.set_value = (x) => { sets++; set0(x); };
  d.inputs.set("lead-gone", empty); d.pruneReply([ASK("lead-a")]);
  assert.equal(sets, 0, "an empty box of a gone leader is not touched on every draw");
  d.inputs.set("lead-gone2", fakeInput("draft")); d.pruneReply([ASK("lead-a")]);
  assert.equal(d.inputs.get("lead-gone2").v, "");
  const copy = MAIN.slice(MAIN.indexOf("  copy(key, text, cx)"), MAIN.indexOf("  // \"옆에 열기\":"));
  assert.doesNotMatch(copy, /cx\.notify\(\)|c\.notify\(\)/);
  assert.equal((copy.match(/softNotify/g) ?? []).length, 3);
});

// ---- Round 19: the "···" bubble stays while a leader is on a task (its own turns AND its team members' work), with a 30 s grace
const worker = (o = {}) => tmT({ address: "t500", name: "dev-36", parent: "t137", ...o });
const who = (terms, track = null, now = 0) => I.typingNow(terms, "pa", {}, track, now).map((x) => x.who);

test("R19: a leader counts as working when a terminal below it (parent chain) works; unrelated terminals do not", () => {
  const idleLead = lead137({ status: "done" });
  assert.deepEqual(who([po28(), idleLead]), []);
  assert.deepEqual(who([po28(), idleLead, worker({ status: "working" })]), ["l:lead-po-inbox"]); // a team member works for it
  const deep = worker({ address: "t501", name: "rev", parent: "t500", status: "working" }); // a grandchild
  assert.deepEqual(who([po28(), idleLead, worker({ status: "idle" }), deep]), ["l:lead-po-inbox"]);
  assert.deepEqual(who([po28(), idleLead, worker({ parent: "t999", status: "working" })]), []); // another parent
  assert.deepEqual(who([po28(), idleLead, worker({ parent: "", status: "working" })]), []); // no parent
  // the PO is not "writing" because a leader below it works
  assert.deepEqual(I.typingNow([po28(), idleLead, worker({ status: "working" })], "pa", {}).map((x) => x.who), ["l:lead-po-inbox"]);
  // a parent loop does not hang and marks only what is on it
  assert.deepEqual(who([po28(), idleLead, worker({ parent: "t501", status: "working" }), worker({ address: "t501", parent: "t500", status: "idle" })]), []);
  assert.ok(I.busyAddrs([worker({ address: "a", parent: "b", status: "working" }), worker({ address: "b", parent: "a" })]).size === 2);
});

test("R19: blocked (waiting for a permission) counts like working, for the leader and for a team member", () => {
  assert.deepEqual(who([po28(), lead137({ status: "blocked" })]), ["l:lead-po-inbox"]);
  assert.deepEqual(who([po28(), lead137({ status: "done" }), worker({ status: " Blocked " })]), ["l:lead-po-inbox"]);
  assert.deepEqual(who([po28(), lead137({ status: "idle" }), worker({ status: "idle" })]), []);
});

test("R19: after the last working moment the bubble stays for TYPING_GRACE_MS and then goes (the poll sees it through graceKey)", () => {
  assert.equal(I.TYPING_GRACE_MS, 30000);
  const track = new Map();
  const busy = [po28(), lead137({ status: "done" }), worker({ status: "working" })];
  const quiet = [po28(), lead137({ status: "done" }), worker({ status: "done" })];
  I.typingSync(track, busy, new Map(), 1000);
  assert.deepEqual(who(busy, track, 1000), ["l:lead-po-inbox"]);
  assert.equal(I.graceKey(track, 1000), "", "working now: not in grace");
  I.typingSync(track, quiet, new Map(), 6000); // it stopped
  assert.deepEqual(who(quiet, track, 6000), ["l:lead-po-inbox"], "5 s of quiet: still shown");
  assert.equal(I.graceKey(track, 6000), "lead-po-inbox");
  I.typingSync(track, quiet, new Map(), 31000);
  assert.deepEqual(who(quiet, track, 31000), ["l:lead-po-inbox"], "exactly 30 s after the last working moment: still shown");
  assert.equal(I.graceKey(track, 31000), "lead-po-inbox");
  I.typingSync(track, quiet, new Map(), 31001);
  assert.deepEqual(who(quiet, track, 31001), [], "past the grace: gone");
  assert.equal(I.graceKey(track, 31001), "");
  assert.equal(track.size, 0, "and forgotten");
  // work again before the grace ends keeps it going and starts a fresh grace
  I.typingSync(track, busy, new Map(), 40000);
  I.typingSync(track, quiet, new Map(), 50000);
  I.typingSync(track, busy, new Map(), 60000);
  I.typingSync(track, quiet, new Map(), 61000);
  assert.deepEqual(who(quiet, track, 80000), ["l:lead-po-inbox"], "20 s after the last working moment (60 s)");
  // a leader that never worked has no grace
  assert.deepEqual(who(quiet, new Map(), 5), []);
});

test("R19: a report of the leader ends the grace at once; an older report does not; a report while busy keeps the dots only while busy", () => {
  const busy = [po28(), lead137({ status: "working" })];
  const quiet = [po28(), lead137({ status: "done" })];
  // the report that was there before the work does not clear anything
  let track = new Map();
  I.typingSync(track, busy, new Map([["lead-po-inbox", 500]]), 1000);
  I.typingSync(track, quiet, new Map([["lead-po-inbox", 500]]), 3000);
  assert.deepEqual(who(quiet, track, 3000), ["l:lead-po-inbox"]);
  // a report after the work: the bubble goes at once
  I.typingSync(track, quiet, new Map([["lead-po-inbox", 3500]]), 4000);
  assert.deepEqual(who(quiet, track, 4000), []);
  assert.equal(track.size, 0);
  // a report while it still works: the dots stay while it works, and there is no grace once it stops
  track = new Map();
  I.typingSync(track, busy, new Map([["lead-po-inbox", 500]]), 1000);
  I.typingSync(track, busy, new Map([["lead-po-inbox", 1500]]), 2000);
  assert.deepEqual(who(busy, track, 2000), ["l:lead-po-inbox"]);
  I.typingSync(track, quiet, new Map([["lead-po-inbox", 1500]]), 3000);
  assert.deepEqual(who(quiet, track, 3000), []);
  // leaderSaid takes the newest shown report of each leader (an "answered"/"start" item is not a bubble)
  const said = I.leaderSaid([{ leader: "lead-a", items: [{ ms: 10, kind: "done" }, { ms: 30, kind: "progress" }, { ms: 99, kind: "answered" }, { ms: 98, kind: "start" }] }, { leader: "lead-b", items: [] }]);
  assert.deepEqual([...said], [["lead-a", 30]]);
});

test("R19: a terminal that is gone loses its bubble at once, even inside the grace", () => {
  const track = new Map();
  I.typingSync(track, [po28(), lead137({ status: "working" })], new Map(), 1000);
  I.typingSync(track, [po28(), lead137({ status: "done" })], new Map(), 2000);
  assert.equal(track.size, 1);
  const gone = [po28(), worker({ status: "done" })]; // the leader's terminal closed
  assert.deepEqual(who(gone, track, 2500), []);
  I.typingSync(track, gone, new Map(), 2500);
  assert.equal(track.size, 0);
  assert.equal(I.graceKey(track, 2500), "");
});

test("R19: statusSig changes when a team member starts working (the poll redraws), and not for unrelated terminals", () => {
  const base = I.statusSig([po28(), lead137({ status: "done" }), worker({ status: "done" })]);
  assert.notEqual(I.statusSig([po28(), lead137({ status: "done" }), worker({ status: "working" })]), base);
  assert.equal(I.statusSig([po28(), lead137({ status: "done" }), worker({ status: "done", title: "x" })]), base);
  assert.equal(I.statusSig([po28(), lead137({ status: "done" }), worker({ parent: "t999", status: "working" })]), base);
  assert.equal(I.statusSig([po28(), lead137({ status: "done" }), worker({ status: "working" })]), I.statusSig([worker({ status: "working" }), lead137({ status: "done" }), po28()]));
});

test("R19: main.js polls for real: a working team member and the end of the grace each redraw once; a quiet poll does not", () => {
  let terms = [po28(), lead137({ status: "done" }), worker({ status: "done" })];
  const Inbox = loadInbox({ herdr: { terminals: () => terms } });
  const d = new Inbox();
  d.startWatch = () => {};
  d.sig = null; d.typingAt = new Map(); // (init() sets these)
  let n = 0;
  d.softNotify = () => { n++; };
  d.badge = () => {};
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    d.pollStatus({}); // first poll only stores
    assert.equal(n, 0);
    now += 1500; d.pollStatus({});
    assert.equal(n, 0, "a quiet second");
    terms = [po28(), lead137({ status: "done" }), worker({ status: "working" })];
    now += 1500; d.pollStatus({});
    assert.equal(n, 1, "the team member started");
    now += 1500; d.pollStatus({});
    assert.equal(n, 1);
    terms = [po28(), lead137({ status: "done" }), worker({ status: "done" })];
    now += 1500; d.pollStatus({});
    assert.equal(n, 2, "it stopped: grace begins, statusSig changed");
    now += 1500; d.pollStatus({});
    assert.equal(n, 2, "inside the grace nothing changes");
    assert.deepEqual(d.typing({ terms, pick: "pa" }).map((x) => x.who), ["l:lead-po-inbox"]);
    now += 31000; d.pollStatus({});
    assert.equal(n, 3, "the grace ran out: one more redraw takes the dots away");
    assert.deepEqual(d.typing({ terms, pick: "pa" }).map((x) => x.who), []);
    now += 1500; d.pollStatus({});
    assert.equal(n, 3);
  } finally { Date.now = real; }
});

// ---- R20: clearly visible bold band (R22: the selection overlay is gone)
const DARK = { foreground: "#e6e6e6", background: "#1e1e1e", accent: "#3b82f6", working: "#22c55e" };
const LIGHT = { foreground: "#1f1f1f", background: "#ffffff", accent: "#2563eb", working: "#16a34a" };
const alphaOf = (c) => parseInt(c.slice(7, 9), 16);
function recTv(calls) {
  const tv = { raw_html() { return this; }, selectable() { return this; }, on_link_click() { return this; }, on_selection_change() { return this; }, highlight_range(a, b, c) { calls.push([a, b, c]); return this; } };
  return { markdown: () => tv, html: () => tv };
}
const freshUi = () => ({ sels: new Map(), sel: false, selAt: 0, press: false, pressAt: 0 });
const r20Desk = (calls) => { const d = new (loadInbox({ base: { TextView: recTv(calls) } }))(); d.ui = freshUi(); return d; };

test("R20: tintHex takes the theme accent at a strong alpha on a dark and a light theme, and the text stays readable on it", () => {
  for (const th of [DARK, LIGHT]) {
    const bold = I.tintHex(th, "bold");
    assert.match(bold, /^#[0-9a-f]{6}[0-9a-f]{2}$/);
    assert.equal(bold.slice(0, 7), th.accent, "the accent token, no hard-coded colour");
    assert.ok(alphaOf(bold) >= 0x40, "not fainter than 25% (the old tint was 20%)");
    for (const c of [bold]) {
      const under = (() => { const a = alphaOf(c) / 255; const u = [1, 3, 5].map((i) => parseInt(th.background.slice(i, i + 2), 16)); return "#" + [1, 3, 5].map((i, k) => Math.round(parseInt(c.slice(i, i + 2), 16) * a + u[k] * (1 - a)).toString(16).padStart(2, "0")).join(""); })();
      const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const x = lum(th.foreground), y = lum(under);
      assert.ok((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) >= I.HL_MIN_CONTRAST - 0.05, `text readable on ${c}`);
    }
  }
});

test("R20: tintHex lowers the alpha when a bright accent would hide the text, and falls back / gives up cleanly", () => {
  const bright = { foreground: "#f0f0f0", background: "#202020", accent: "#ffff00" }; // light text on strong yellow would be unreadable
  assert.ok(alphaOf(I.tintHex(bright, "bold")) < 0x73, "stepped down");
  assert.ok(alphaOf(I.tintHex(bright, "bold")) >= 0x40, "but not below the floor");
  assert.equal(I.tintHex({ foreground: "#e6e6e6", background: "#1e1e1e" }, "bold").slice(0, 7), "#e6e6e6", "no accent: the foreground colour");
  assert.match(I.tintHex({ accent: "#3b82f680", foreground: "#e6e6e6" }, "bold"), /^#3b82f6[0-9a-f]{2}$/, "R21: #rrggbbaa is normalized (its own alpha dropped)");
  assert.equal(I.tintHex({ accent: "oops", foreground: "#e6e6e6" }, "bold").slice(0, 7), "#e6e6e6", "an unusable accent falls to the next token");
  assert.equal(I.tintHex({ accent: "#3b82f6" }, "sel"), null, "R22: the selection tint is gone");
  assert.equal(I.tintHex({}, "bold"), null);
  assert.equal(I.tintHex(undefined, "bold"), null);
  assert.match(I.tintHex({ accent: "#3b82f6" }, "bold"), /^#3b82f673$/, "no background known: the starting alpha");
});

test("R20: selRangeOf accepts sel.range or a bare range and refuses nonsense", () => {
  assert.deepEqual(I.selRangeOf({ range: { start: 1, end: 4 }, text: "x" }, 10), { start: 1, end: 4 });
  assert.deepEqual(I.selRangeOf({ start: 0, end: 3 }, 10), { start: 0, end: 3 });
  for (const bad of [null, undefined, {}, { range: null }, { range: { start: 4, end: 4 } }, { range: { start: 5, end: 2 } }, { range: { start: -1, end: 2 } }, { range: { start: 1, end: 11 } }, { range: { start: 1.5, end: 3 } }, { range: { start: "a", end: 3 } }])
    assert.equal(I.selRangeOf(bad, 10), null, JSON.stringify(bad));
});

function selDesk() {
  const calls = [];
  const d = r20Desk(calls);
  let notes = 0;
  const cx = { notify() { notes++; } };
  d.md("m1", "hello **world** again", DARK); // drawn as Markdown
  d.text("h1", "<p>plain</p>");
  return { d, cx, calls, notes: () => notes };
}

test("R21: bold alpha never drops below its floor, even for white text on white", () => {
  for (const c of ["#ffffff", "#000000", "#808080"]) {
    const a = alphaOf(I.tintHex({ foreground: c, background: c, accent: c }, "bold"));
    assert.ok(a >= 0x40, `${c}: ${a.toString(16)}`);
  }
});

test("R21: hex6 / tintHex normalize #rgb and #rrggbbaa; tintMiss and tintWarn say once when no token is usable", () => {
  assert.equal(I.tintHex({ accent: "#38f" }, "bold").slice(0, 7), "#3388ff");
  assert.equal(I.tintHex({ accent: "#3B82F6CC" }, "bold").slice(0, 7), "#3b82f6");
  assert.equal(I.tintHex({ accent: "blue", ansi4: "rgb(1,2,3)", foreground: 5 }, "bold"), null);
  assert.match(I.tintMiss({ accent: "blue" }, "bold"), /^highlight bold: no usable theme token \(accent="blue" ansi4=null foreground=null\); nothing painted$/);
  const calls = [];
  const d = r20Desk(calls);
  d.md("x", "a **b**", { accent: "blue" });
  d.md("x", "a **b**", { accent: "blue" });
  assert.equal(calls.length, 0);
  assert.equal(d.diagQ.filter((l) => /highlight bold: no usable theme token/.test(l)).length, 1, "one line, not one per redraw");
});

// ---- R21: a short status label (5 chars at most) beside the "···" bubble, from hc status only
const labelOf = (terms, track = null, now = 0) => I.typingNow(terms, "pa", {}, track, now).find((x) => x.who === "l:lead-po-inbox")?.label;

test("R21 label: its own work -> 작업중; a team member's work -> 팀원 작업; any blocked -> 승인 대기", () => {
  assert.equal(labelOf([po28(), lead137({ status: "working" })]), "작업중");
  assert.equal(labelOf([po28(), lead137({ status: "done" }), worker({ status: "working" })]), "팀원 작업");
  assert.equal(labelOf([po28(), lead137({ status: "blocked" })]), "승인 대기");
  assert.equal(labelOf([po28(), lead137({ status: "done" }), worker({ status: "blocked" })]), "승인 대기");
  assert.equal(labelOf([po28(), lead137({ status: "done" }), worker({ status: " Working " })]), "팀원 작업", "case and spaces ignored");
});

test("R21 label: priority 승인 대기 > 작업중 > 팀원 작업 > grace", () => {
  const deep = (o) => tmT({ address: "t600", name: "rev-36", parent: "t500", ...o }); // a member of a member: the chain counts
  assert.equal(labelOf([po28(), lead137({ status: "working" }), worker({ status: "blocked" })]), "승인 대기", "blocked beats its own work");
  assert.equal(labelOf([po28(), lead137({ status: "blocked" }), worker({ status: "working" })]), "승인 대기");
  assert.equal(labelOf([po28(), lead137({ status: "working" }), worker({ status: "working" })]), "작업중", "own work beats a member's");
  assert.equal(labelOf([po28(), lead137({ status: "done" }), worker({ status: "done" }), deep({ status: "working" })]), "팀원 작업", "two levels down");
  assert.equal(labelOf([po28(), lead137({ status: "done" }), worker({ status: "working" }), deep({ status: "blocked" })]), "승인 대기");
  assert.equal(labelOf([po28(), lead137({ status: "done" }), worker({ parent: "t999", status: "working" })]), undefined, "an unrelated terminal gives nothing");
});

test("R21 label: only the 30 s grace left -> 잠시 대기 (nobody works now); gone after the grace; the PO's own dots say 작업중", () => {
  const track = new Map();
  I.typingSync(track, [po28(), lead137({ status: "working" })], new Map(), 1000);
  const idle = [po28(), lead137({ status: "done" })];
  I.typingSync(track, idle, new Map(), 5000);
  assert.equal(labelOf(idle, track, 5000), "잠시 대기");
  assert.equal(labelOf(idle, track, 1000 + I.TYPING_GRACE_MS + 1), undefined, "grace over: no dots, no label");
  assert.equal(I.typingNow([po28({ status: "working" })], "pa", {}).find((x) => x.who === "po").label, "작업중");
});

test("R21 label: every label fits in 5 characters and the labels are the only states shown (no invented 생각중/리뷰중)", () => {
  for (const l of [I.LABEL_BLOCKED, I.LABEL_WORKING, I.LABEL_TEAM, I.LABEL_GRACE]) assert.ok([...l].length <= 5, l);
  assert.deepEqual([I.LABEL_BLOCKED, I.LABEL_WORKING, I.LABEL_TEAM, I.LABEL_GRACE], ["승인 대기", "작업중", "팀원 작업", "잠시 대기"]);
  assert.doesNotMatch(MAIN, /생각중|리뷰중/);
});

test("R21 label: statusSig changes with the label (member working -> blocked, own work -> member's) and not otherwise", () => {
  const sig = (...xs) => I.statusSig([po28(), lead137({ status: "done" }), ...xs]);
  const w = sig(worker({ status: "working" })), b = sig(worker({ status: "blocked" }));
  assert.notEqual(w, b, "팀원 작업 -> 승인 대기 redraws");
  assert.equal(sig(worker({ status: "working", title: "x" })), w, "unrelated change: same sig, no storm");
  assert.notEqual(I.statusSig([po28(), lead137({ status: "working" }), worker({ status: "working" })]), I.statusSig([po28(), lead137({ status: "working" }), worker({ status: "blocked" })]), "label 작업중 -> 승인 대기 while the leader's own status stays working");
  assert.notEqual(I.statusSig([po28(), lead137({ status: "done" }), worker({ status: "working" })]), I.statusSig([po28(), lead137({ status: "working" }), worker({ status: "done" })]));
});

test("R21 label: typingRow draws the label next to the dots (source) and nothing when the label is empty", () => {
  const row = MAIN.slice(MAIN.indexOf("  typingRow(t, x) {"), MAIN.indexOf("  render(cx) {"));
  assert.match(row, /\.child\("···"\)/);
  assert.match(row, /x\.label \? div\(\)\.flex_none\(\)\.text_size\(11\)[^\n]*\.child\(x\.label\) : div\(\)/);
  assert.match(row, /x\.label === LABEL_BLOCKED \? t\.blocked : t\.dim/);
});

// ---- R21: the right-pinned, width-capped bubbles
test("R21 layout: chatColW leaves out the room list (none in a strip) and says null when the width is unknown", () => {
  assert.equal(I.chatColW(720, false, false, 168, 58), 552);
  assert.equal(I.chatColW(500, false, true, 168, 58), 442, "narrow: the slim column");
  assert.equal(I.chatColW(500, true, true, 168, 58), 500, "a strip on top takes no width");
  assert.equal(I.chatColW(100, false, false, 168, 58), 0, "never negative");
  for (const bad of [undefined, null, 0, -5, NaN, "x"]) assert.equal(I.chatColW(bad, false, false, 168, 58), null);
});

test("R22 layout: bubbleCap is 75% of the column but never leaves less than 90px beside it (chip and time); tiny columns get a small floor", () => {
  assert.equal(I.bubbleCap(552), 414, "75% of 552");
  assert.equal(I.bubbleCap(1200), 900);
  assert.equal(I.bubbleCap(300), 210);
  assert.equal(I.bubbleCap(260), 170, "narrow dock: column - 90");
  assert.equal(I.bubbleCap(200), 110);
  assert.equal(I.bubbleCap(150), 60);
  assert.equal(I.bubbleCap(100), 40, "the floor");
  assert.equal(I.bubbleCap(42), 40);
  assert.equal(I.bubbleCap(30), 30, "never above the column itself");
  assert.equal(I.bubbleCap(null), null);
  assert.equal(I.bubbleCap(0), null);
  let last = 0;
  for (let w = 40; w <= 1600; w += 8) {
    const c = I.bubbleCap(w);
    assert.ok(c >= last, `grows with the window at ${w}`);
    assert.ok(c <= w, `never above the column at ${w}`);
    assert.ok(c <= Math.max(40, w * 0.75), `<= 75% at ${w}`);
    if (w >= 130) assert.ok(c + 90 <= w, `the chip and time still fit beside it at ${w} (cap ${c})`);
    last = c;
  }
});

test("R22 layout: a picture raises the cap only when it still fits beside the chip; wider than that, the cap stays (the picture is scaled)", () => {
  assert.equal(I.bubbleCap(552, 440), 440, "fits in the room (552-90=462)");
  assert.equal(I.bubbleCap(552, 462), 462);
  assert.equal(I.bubbleCap(552, 500), 414, "does not fit beside the chip: keep the cap");
  assert.equal(I.bubbleCap(552, 100), 414);
  assert.equal(I.bubbleCap(200, 180), 110, "a narrow column: the picture does not push past it");
  assert.equal(I.bubbleCap(260, 240), 170);
  assert.equal(I.bubbleCap(260, 170), 170);
  for (const col of [150, 200, 260, 552]) for (const pic of [0, 50, 150, 240, 600]) {
    const c = I.bubbleCap(col, pic);
    assert.ok(c <= col, `col ${col} pic ${pic}: cap ${c} within the column`);
    if (col >= 130) assert.ok(c + 90 <= col, `col ${col} pic ${pic}: cap ${c} leaves 90px`);
  }
});

test("R21 layout: my bubble is pinned right and capped; the PO and leader bubbles are capped on the left; the cap follows resizes", () => {
  const row = MAIN.slice(MAIN.indexOf("  entryRow(t, e, v, cx) {"), MAIN.indexOf("  render(cx) {"));
  assert.match(row, /h_flex\(\)\.w_full\(\)\.min_w\(0\)\.gap\(6\)\.items_end\(\)\.justify_end\(\)/, "own row: flush right");
  assert.match(row, /const width = Math\.min\(Math\.max\(bubbleWidth\(bp\.text\), pics, 64\), cap \?\? Infinity\)/, "own width never above the cap");
  assert.match(row, /\.w\(width\)\.max_w\(cap \?\? "75%"\)\.min_w\(0\)/);
  assert.match(row, /div\(\)\.flex_1\(\)\.min_w\(0\)\.max_w\(this\.capOf\(\) \?\? "75%"\)\.px\(12\)/, "PO bubble");
  assert.match(row, /div\(\)\.flex_1\(\)\.min_w\(0\)\.max_w\(this\.capOf\(\) \?\? "75%"\)\.child\(this\.bubble\(/, "leader bubble");
  assert.match(MAIN, /capOf\(minInner = 0\) \{[^}]*bubbleCap\(chatColW\(this\.winW, strip, this\.narrow, ROOM_W, SLIM_W\), minInner\)/);
  const sz = MAIN.slice(MAIN.indexOf("on_size_change"), MAIN.indexOf("on_size_change") + 200);
  assert.match(sz, /this\.onSize\(size\.width, c\)/, "the size event goes to onSize");
});

test("R22 layout: the cap sits on the box only; the Markdown given to a TextView is the same string, so the bold band offsets do not move on a resize", () => {
  const calls = [];
  const d = r20Desk(calls);
  d.winW = 400; d.narrow = false; d.windowed = true;
  const src = "a long message with **bold words** that will wrap inside the cap";
  const before = I.boldRanges(I.mdText(src));
  d.md("w", src, DARK);
  d.winW = 1200; // resized: only the box width changes
  const calls2 = calls.splice(0);
  d.md("w", src, DARK);
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), calls2.map((c) => [c[0], c[1]]));
  assert.deepEqual(calls2.map((c) => [c[0], c[1]]), before.map((r) => [r.start, r.end]));
});

// ---- R22: the resize redraw path (onSize) is tested directly
const sizeDesk = () => {
  const d = new (loadInbox())();
  d.ui = freshUi();
  let n = 0;
  const cx = { notify: () => { n++; } };
  return { d, cx, count: () => n };
};

test("R22 resize: the first size redraws; the same 16px step does not; a new step, or crossing 360 / WIDE_MIN, does", () => {
  const { d, cx, count } = sizeDesk();
  d.onSize(800, cx);
  assert.equal(count(), 1, "first report");
  assert.equal(d.winW, 800);
  d.onSize(803, cx);
  assert.equal(count(), 1, "same 16px step: remembered but no redraw");
  assert.equal(d.winW, 803, "the width is still remembered");
  d.onSize(840, cx);
  assert.equal(count(), 2, "moved to another step: the bubble cap follows");
  d.onSize(700, cx);
  assert.equal(count(), 3);
  d.onSize(519, cx);
  assert.ok(count() >= 4, "crossing WIDE_MIN redraws");
  assert.equal(d.narrow, true);
  const c = count();
  d.onSize(340, cx);
  assert.ok(count() > c, "crossing 360 redraws");
  assert.equal(d.compact, true);
});

test("R22 resize: a redraw held by a selection waits (dirty) and goes out when nothing holds it", () => {
  const { d, cx, count } = sizeDesk();
  d.onSize(800, cx);
  const c = count();
  d.ui.sel = true; d.ui.selAt = Date.now();
  d.onSize(900, cx);
  assert.equal(count(), c, "held while selecting");
  assert.equal(d.dirty, true);
  assert.equal(d.winW, 900, "the width is taken at once, so the next redraw uses it");
});

test("R22 resize: the redraw only comes from a width-step change (without `|| grew` a drag across steps would never redraw)", () => {
  const body = MAIN.slice(MAIN.indexOf("  onSize(width, cx) {"), MAIN.indexOf("  capOf("));
  assert.match(body, /n !== this\.narrow \|\| grew\)/);
});


// ---- R22: the selection overlay is gone; the diag lines for a drag-copy stay
test("R22 diag: a settled selection logs its length, range and bubble id (never the text); a clear logs its age; selection state follows", () => {
  const d = r20Desk([]);
  d.onSel("w~abc", { text: "SECRET words", range: { start: 2, end: 9 } }, { notify() {} });
  assert.equal(d.diagQ.length, 1);
  assert.match(d.diagQ[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z selection settled in w~[0-9a-f]{8} id=w~abc: 12 chars, range 2-9 \(#1\)$/);
  assert.doesNotMatch(d.diagQ[0], /SECRET/, "no text content in the log");
  assert.equal(d.ui.sel, true);
  assert.ok(d.ui.selAt > 0);
  d.onSel("w~abc", { text: "x" }, { notify() {} });
  assert.match(d.diagQ[1], /range missing \(#2\)$/, "a selection without a usable range says so");
  d.onSel("w~abc", null, { notify() {} });
  assert.match(d.diagQ[2], /selection cleared in w~[0-9a-f]{8} id=w~abc, \d+ms after the last settle; since the settle: 0 redraws, 0 mouse ups, 0 list presses \(#3\)$/);
  assert.equal(d.ui.sel, false);
  assert.equal(d.ui.sels.size, 0);
  const none = r20Desk([]);
  none.onSel("p~1", null, { notify() {} });
  assert.match(none.diagQ[0], /selection cleared in p~[0-9a-f]{8} id=p~1 \(#1\)$/, "no earlier settle: no age");
});

test("R22 diag: a settle or clear paints nothing and never calls notify; only a held redraw goes out once nothing holds it", () => {
  const calls = [];
  const d = r20Desk(calls);
  let n = 0;
  const cx = { notify: () => { n++; } };
  d.onSel("w", { text: "abc", range: { start: 0, end: 3 } }, cx);
  assert.equal(n, 0, "no redraw on a settle (the native selection is left alone)");
  assert.equal(calls.length, 0, "no TextView highlight call");
  d.dirty = true; // a redraw was held back
  d.onSel("w", null, cx);
  assert.equal(n, 1, "the held redraw goes out after the clear");
  assert.equal(d.dirty, false);
});

test("R22: no selection overlay machinery is left in main.js or inbox.cjs; the pointer and list handlers still clear selections", () => {
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  for (const [name, src] of [["main.js", MAIN], ["inbox.cjs", CJS]]) {
    assert.doesNotMatch(src, /hlSkip|dropHl|mdSeen|ui\.hl\b|HL_ECHO_MS/, `${name}: no overlay state`);
    assert.doesNotMatch(src, /tintHex\([^)]*"sel"\)|tintWarn\([^)]*"sel"\)/, `${name}: no selection tint call`);
  }
  assert.equal(I.tintHex(DARK, "sel"), null, "the selection tint kind is gone");
  assert.ok(I.tintHex(DARK, "bold"), "the bold band stays");
  assert.match(MAIN, /on_mouse_down_out\(\(_e, c\) => \{ this\.ui\.press = false; if \(this\.ui\.sel\) \{ this\.ui\.sels\.clear\(\); this\.ui\.sel = false; \}/);
});


// ---- R23: what cleared a finished selection ~250-370ms after the settle (live diag.log)
test("R23 diag: a clear says how many redraws, mouse ups and list presses came since the settle, and the release line carries click count and age", () => {
  const d = r20Desk([]);
  const cx = { notify() {} };
  d.onSel("w~abc", { text: "SECRET", range: { start: 0, end: 6 } }, cx);
  d.pointerUp(cx, { click_count: 2 });
  d.listDown({ click_count: 2 });
  d.onSel("w~abc", null, cx);
  const q = d.diagQ.join("\n");
  assert.match(q, /release \(window mouse up\), click 2, \d+ms after the last settle/);
  assert.match(q, /press \(list mouse down\), click 2, \d+ms after the last settle/);
  assert.match(q, /since the settle: 0 redraws, 1 mouse ups, 1 list presses, last click 2 \(#2\)$/m);
  assert.doesNotMatch(q, /SECRET/);
  d.diagQ.length = 0;
  d.pointerUp(cx, { click_count: 1 });
  assert.match(d.diagQ[0], /release \(window mouse up\), click 1$/, "no settled selection: no age");
});

test("R23 diag: a redraw while a selection is settled is counted and logged", () => {
  const d = r20Desk([]);
  const cx = { notify() {} };
  d.renderN = 4;
  d.onSel("w", { text: "abc", range: { start: 0, end: 3 } }, cx);
  assert.equal(d.selMark.renders, 4);
  d.renderN = 6; // two redraws happened under the selection
  d.diagQ.length = 0;
  d.onSel("w", null, cx);
  assert.match(d.diagQ[0], /since the settle: 2 redraws, 0 mouse ups, 0 list presses \(#2\)$/);
  assert.equal(d.selMark, null, "the mark is gone with the selection");
  assert.match(MAIN, /redraw #\$\{this\.renderN\} while a selection is settled/, "full() logs a redraw under a settled selection");
});

test("R23: the held-Enter redraw timer respects the selection hold (it used to call notify directly under a selection)", () => {
  assert.doesNotMatch(MAIN, /this\.heldAt = 0; try \{ c\.notify\(\); \} catch \{\} \}/);
  assert.match(MAIN, /!holdShown\(this\.editAt, this\.heldAt\)\) \{ this\.heldAt = 0; this\.softNotify\(c\); \}/);
  assert.match(MAIN, /on_window_mouse_up\("left", \(e, c\) => this\.pointerUp\(c, e\)\)/);
});

test("R23: linkRef gives repo#N from a GitHub PR or issue link (owner left out), empty for anything else", () => {
  assert.equal(I.linkRef("https://github.com/xowjd913/agent-mods/pull/39"), "agent-mods#39");
  assert.equal(I.linkRef("https://github.com/xowjd913/agent-playbook/issues/380#issuecomment-1"), "agent-playbook#380");
  assert.equal(I.linkRef("https://github.com/xowjd913/agent-mods/pull/39/files"), "agent-mods#39");
  assert.equal(I.linkRef("https://github.com/xowjd913/agent-mods"), "");
  assert.equal(I.linkRef("https://example.com/a/b/pull/3"), "");
  assert.equal(I.linkRef("not a url"), "");
  assert.equal(I.linkRef(undefined), "");
});

test("R23: a report card carries linkRef next to the leader name; the name itself is unchanged", () => {
  const line = JSON.stringify({ ts: "2026-01-01T00:00:00Z", leader: "lead-x", kind: "verify", title: "[x] PO 보고 정리 방안", body: "본문", link: "https://github.com/xowjd913/agent-mods/pull/39" });
  const [it] = I.parseLines(line + "\n").map(I.enrich);
  assert.equal(it.linkRef, "agent-mods#39");
  const [none] = I.parseLines(JSON.stringify({ ts: "2026-01-01T00:00:01Z", leader: "lead-x", kind: "done", title: "[x] 끝", body: "b" }) + "\n").map(I.enrich);
  assert.equal(none.linkRef, "");
  assert.match(MAIN, /\.when\(!bare && Boolean\(it\?\.linkRef\), \(el\) => el\.child\(div\(\)\.flex_none\(\)\.text_size\(10\.5\)\.text_color\(t\.dim\)\.child\(it\.linkRef\)\)\)/);
  assert.match(MAIN, /\.child\(shortName\(s\.leader\)\)\)\)/, "the leader name still comes from shortName/leaderName");
});
