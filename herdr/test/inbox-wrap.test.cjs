// Tests of the wrapper tags (<hc from=...>, <pasted_content ...>) and the Markdown prep of the PO desk bubbles (#36, #37, round 14 A/B/C/D).
// What the real app draws (the Markdown look, the thumbnail) cannot be tested here; these cover the text rules and the shape of the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
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

test("#66 mdText: typed list marks become Markdown items with a blank line around the list; the words stay", () => {
  const out = I.mdText("요약입니다\n• 첫째\n• 둘째 **굵게**\n1) 하나\n2) 둘\n마무리");
  assert.equal(out, "요약입니다\n\n- 첫째\n- 둘째 **굵게**\n1. 하나\n2. 둘\n\n마무리");
  // a list written with "-" already: only the blank lines are added
  assert.equal(I.mdText("a\n- x\n- y\nb"), "a\n\n- x\n- y\n\nb");
  // an indented line under an item stays inside it (a break, no blank line)
  assert.equal(I.mdText("- x\n  more\n- y"), "- x  \n  more\n- y");
  // a number that does not start at 1 in the middle of a text is text, not a list
  assert.equal(I.mdText("날짜\n2025. 11. 26 에"), "날짜  \n2025. 11. 26 에");
  // **bold** and *italic* at the start of a line are not bullets
  assert.equal(I.mdText("**a** b\n*c* d"), "**a** b  \n*c* d");
  // fences are never touched, a bullet inside one stays
  assert.equal(I.mdText("```\n• x\n1) y\n```"), "```\n• x\n1) y\n```");
  // the text a person copies is the original: only the drawn source changes
  assert.ok(!I.mdText("• x").includes("•"));
});

test("#66 mdBlocks: a line of only **bold** text is its own bold block (markers removed); the rest stays Markdown", () => {
  assert.deepEqual(I.mdBlocks("**제목**  \n본문  \n끝"), [{ s: "제목", bold: true }, { s: "본문  \n끝", bold: false }]);
  assert.deepEqual(I.mdBlocks(I.mdText("【결과】\nplain **b**")), [{ s: "【결과】", bold: true }, { s: "plain **b**", bold: false }]);
  assert.deepEqual(I.mdBlocks("a **b** c"), [{ s: "a **b** c", bold: false }]);
  assert.deepEqual(I.mdBlocks("**a** and **b**"), [{ s: "**a** and **b**", bold: false }]);
  assert.deepEqual(I.mdBlocks("```\n**in fence**\n```"), [{ s: "```\n**in fence**\n```", bold: false }]);
  assert.deepEqual(I.mdBlocks("**`code` 제목**"), [{ s: "`code` 제목", bold: true }]);
  assert.deepEqual(I.mdBlocks("** lone **"), [{ s: "** lone **", bold: false }]);
  assert.deepEqual(I.mdBlocks(""), []);
  // blank lines around a bold line are dropped (the screen spaces the blocks)
  assert.deepEqual(I.mdBlocks("a\n\n**b**\n\nc"), [{ s: "a", bold: false }, { s: "b", bold: true }, { s: "c", bold: false }]);
});

test("#66 mdText/mdBlocks are linear on long input", () => {
  const t0 = process.hrtime.bigint();
  I.mdBlocks(I.mdText("• **a** b\n".repeat(5000)));
  I.mdBlocks(I.mdText("**" + "x ".repeat(20000) + "**"));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 800);
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
  assert.match(MAIN, /TextView\.markdown\(vid, s\)\.raw_html\(false\)\.selectable\(true\)\.on_link_click/);
  assert.match(MAIN, /this\.mdFolded\(id, e\.text, t\)/);
  assert.match(MAIN, /this\.md\(id, open \? src : lc\.text\)/); // #47: a long PO message is folded, still through md()
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
    constructor() { this.pics = []; this.picBusy = 0; this.picBusyBy = new Map(); this.draftRoom = null; this.roomDrafts = new Map(); this.replyPics = new Map(); this.replyBusy = new Map(); this.imgd = new Map(); this.msg = "x"; this.said = []; }
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
  const body = [grab("  picsOf(key = null)", "  bumpBusy("), grab("  pruneReply(asks)", "  pruneSent(asks)"), grab("  clearBox(a, how", "  box(leader, cx)"), grab("  // #74: the draft mirror.", "  // A held Enter whose second Enter")].join("\n");
  const make = new Function("shared", "setShared", "SENT_KEY", "staleDrafts", "draftWiped", `return class Desk {
    constructor() { this.pics = []; this.replyPics = new Map(); this.replyBusy = new Map(); this.inputs = new Map(); this.inputSeen = new Map(); this.writing = null; this.mirror = new Map(); this.keyAt = 0; this.chat = null; }
    diag() {}
    askKey(a) { return a.kind + "|" + a.link; }
    ${body}
  }`);
  return new (make((k) => store[k], (k, v) => { store[k] = v; }, "sent", I.staleDrafts, I.draftWiped))();
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
  assert.match(MAIN, /if \(!same\) this\.softNotify\(c2\);/);
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

test("R18: md() paints nothing behind bold (no highlight_range), and a line of only bold text gets the bold weight (#66)", () => {
  assert.match(MAIN, /^const DIAG_FLUSH_MS = \d+/m);
  assert.doesNotMatch(MAIN, /highlight_range|tintHex|boldRanges|BOLD_TINT|HL_ECHO_MS/, "no tint machinery is left");
  const views = [];
  const mk = (id, s) => { const v = { id, s, w: 0, raw_html() { return this; }, selectable() { return this; }, on_link_click() { return this; }, on_selection_change() { return this; }, font_weight(n) { this.w = n; return this; } }; views.push(v); return v; };
  const Inbox = loadInbox({ base: { TextView: { markdown: mk } } });
  const d = new Inbox();
  d.md("x", "plain with **inline bold** only");
  assert.equal(views.length, 1);
  assert.equal(views[0].id, "x");
  assert.equal(views[0].w, 0, "an inline run keeps the normal weight");
  assert.equal(views[0].s, "plain with **inline bold** only");
  views.length = 0;
  d.md("y", "【결과】\nfirst\n- a\n- b\n**끝**");
  assert.deepEqual(views.map((v) => [v.id, v.w, v.s]), [["y-0", 700, "【결과】"], ["y-1", 0, "first\n\n- a\n- b"], ["y-2", 700, "끝"]]);
});

test("R18: pinTick keeps the pin when a scroll is held back, so the view goes to the bottom after the release", () => {
  const Inbox = loadInbox();
  const d = new Inbox();
  const jumps = [];
  let ch = 1000;
  d.scroll = { offset: () => ({ y: 600 }), viewport_size: () => ({ height: 400 }), content_size: () => ({ height: ch }), scroll_to_item: (i) => jumps.push(i) };
  d.drawnAt = 1; d.lastIdx = 7; d.guardAll = () => {};
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
  assert.deepEqual(d.pin, { pinned: true, ct: 1100, vh: 400 });
  // not held and no growth: the pin is stored as before
  d.pinTick({ notify() {} });
  assert.equal(jumps.length, 1);
});

test("#72 pinTick: a go tick (pinned, a long new row) does not flash the jump button; a tick scrolled away shows it once", () => {
  const Inbox = loadInbox();
  const d = new Inbox();
  let y = 900, ch = 1400, notified = 0;
  d.scroll = { offset: () => ({ y }), viewport_size: () => ({ height: 500 }), content_size: () => ({ height: ch }), scroll_to_item: () => { y = ch - 500; } };
  d.drawnAt = 1; d.lastIdx = 7; d.guardAll = () => {}; d.softNotify = () => { notified++; };
  d.pin = { pinned: true, ct: 1400, vh: 500 };
  ch = 1520; // a 120px row arrived while pinned at the bottom: pinStep goes, the old y against the new height would read as "away"
  d.pinTick({ notify() {} });
  assert.equal(Boolean(d.jump), false);
  assert.equal(notified, 0);
  d.pinTick({ notify() {} }); // the next tick sees the real position (bottom): still hidden
  assert.equal(Boolean(d.jump), false);
  assert.equal(notified, 0);
  y = 100; // the person scrolled far up
  d.pinTick({ notify() {} });
  assert.equal(Boolean(d.jump), true);
  assert.equal(notified, 1);
  d.pinTick({ notify() {} });
  assert.equal(notified, 1, "no redraw while the state is unchanged");
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
  assert.match(row, /const width = Math\.min\(Math\.max\(bubbleWidth\(words\), pics, 64\), cap \?\? Infinity\)/, "own width never above the cap (words: the folded text, #47)");
  assert.match(row, /\.w\(width\)\.max_w\(cap \?\? "75%"\)\.min_w\(0\)/);
  assert.match(row, /div\(\)\.flex_1\(\)\.min_w\(0\)\.max_w\(this\.capOf\(\) \?\? "75%"\)\.px\(12\)/, "PO bubble");
  assert.match(row, /div\(\)\.flex_1\(\)\.min_w\(0\)\.max_w\(this\.capOf\(\) \?\? "75%"\)\.child\(this\.bubble\(/, "leader bubble");
  assert.match(MAIN, /capOf\(minInner = 0\) \{[^}]*bubbleCap\(chatColW\(this\.winW, strip, this\.narrow, ROOM_W, SLIM_W\), minInner\)/);
  const sz = MAIN.slice(MAIN.indexOf("on_size_change"), MAIN.indexOf("on_size_change") + 200);
  assert.match(sz, /this\.onSize\(size\.width, c\)/, "the size event goes to onSize");
});

test("R22 layout: the cap sits on the box only; the Markdown given to a TextView is the same string on a resize", () => {
  const seen = [];
  const mk = (id, s) => { const v = { raw_html() { return this; }, selectable() { return this; }, on_link_click() { return this; }, on_selection_change() { return this; }, font_weight() { return this; } }; seen.push([id, s]); return v; };
  const d = new (loadInbox({ base: { TextView: { markdown: mk } } }))();
  d.ui = freshUi();
  d.winW = 400; d.narrow = false; d.windowed = true;
  const src = "a long message with **bold words** that will wrap inside the cap";
  d.md("w", src);
  const first = seen.splice(0);
  d.winW = 1200; // resized: only the box width changes
  d.md("w", src);
  assert.deepEqual(seen, first);
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
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  for (const [name, src] of [["main.js", MAIN], ["inbox.cjs", CJS]]) {
    assert.doesNotMatch(src, /hlSkip|dropHl|mdSeen|ui\.hl\b|HL_ECHO_MS/, `${name}: no overlay state`);
    }
  assert.match(MAIN, /on_mouse_down_out\(\(_e, c\) => \{ this\.ui\.press = false; if \(this\.ui\.sel\) this\.dropSel\(\);/);
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
  assert.match(MAIN, /heldTick\(c\) \{\s*if \(this\.heldAt && !holdShown\(this\.editAt, this\.heldAt\)\) \{ this\.heldAt = 0; this\.softNotify\(c\); \}/);
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
  assert.match(MAIN, /\.when\(!bare && Boolean\(it\?\.linkRef\), \(el\) => el\.child\(div\(\)\.min_w\(0\)\.max_w\(150\)\.truncate\(\)\.text_size\(10\.5\)\.text_color\(t\.dim\)\.child\(it\.linkRef\)\)\)/);
  assert.match(MAIN, /\.child\(shortName\(s\.leader\)\)\)\)/, "the leader name still comes from shortName/leaderName");
});

test("R24: dropSel clears the selection state and the diag mark together; a draw after a local clear logs no 'redraw while a selection is settled'", () => {
  const d = r20Desk([]);
  const cx = { notify() {} };
  d.onSel("w", { text: "abc", range: { start: 0, end: 3 } }, cx); // settled
  assert.ok(d.selMark && d.ui.sel);
  d.noteRedraw(cx);
  assert.match(d.diagQ.at(-1), /redraw #1 while a selection is settled/, "a draw under a live selection is logged");
  d.dropSel(); // a press in the list clears it locally (no on_selection_change(null) is guaranteed)
  assert.equal(d.ui.sel, false);
  assert.equal(d.ui.sels.size, 0);
  assert.equal(d.selMark, null);
  d.diagQ.length = 0;
  d.noteRedraw(cx);
  assert.deepEqual(d.diagQ, [], "nothing logged for a selection that is gone");
  assert.equal(d.renderN, 2, "the draws are still counted");
});

test("R24: every local clear of the list selection goes through dropSel", () => {
  const clears = MAIN.match(/\.sels\.clear\(\)/g) ?? [];
  assert.equal(clears.length, 1, "only dropSel clears the map");
  assert.match(MAIN, /dropSel\(\) \{\s*this\.ui\.sels\.clear\(\);/);
  assert.match(MAIN, /on_mouse_down\("left", \(e, c\) => \{ this\.listDown\(e\);[^\n]*this\.dropSel\(\);/);
  assert.match(MAIN, /on_mouse_down_out\([^\n]*if \(this\.ui\.sel\) this\.dropSel\(\);/);
});

test("R24: under a settled selection a held-Enter tick marks dirty and calls notify 0 times; once the selection is gone the redraw goes out", () => {
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const d = r20Desk([]);
    let n = 0;
    const cx = { notify() { n++; } };
    d.onSel("w", { text: "abc", range: { start: 0, end: 3 } }, cx);
    d.heldAt = now - 500;
    d.editAt = now; // the person typed on after the held Enter: the hint goes away
    d.heldTick(cx);
    assert.equal(n, 0, "no direct notify under a selection");
    assert.equal(d.dirty, true, "the redraw is held back");
    assert.equal(d.heldAt, 0);
    d.dropSel();
    d.heldAt = now - 500;
    d.editAt = now;
    d.heldTick(cx);
    assert.equal(n, 1, "with nothing holding it the redraw goes out");
    assert.equal(d.dirty, false);
    d.heldAt = now; d.editAt = now; // still inside the hold window: nothing to do
    d.heldTick(cx);
    assert.equal(n, 1);
    assert.equal(d.heldAt, now);
  } finally { Date.now = real; }
});

// #47: one very long paste (a whole log) in the chat made every redraw slow enough that the host cut the desk render off.
test("long message: a huge paste is folded to its first lines and the timeline stays fast", () => {
  const I = require("../mods/inbox/inbox.cjs");
  const log = Array.from({ length: 6000 }, (_, i) => `2026-11-25T08:00:${String(i % 60).padStart(2, "0")}Z [info] step ${i} <hc from="t9"> value=${"x".repeat(40)}`).join("\n");
  const pasted = `<pasted_content id="1">\n${log}\n</pasted_content id="1">`;
  const c = I.clipLong(I.unwrapTags(pasted));
  assert.equal(c.cut, true);
  assert.ok(c.text.split("\n").length <= I.LONG_LINES && c.text.length <= I.LONG_CHARS);
  assert.ok(c.more > 0 && c.text.length + c.more <= I.unwrapTags(pasted).length);
  assert.match(I.moreLabel(12345), /^더 보기 · 12,345자 더$/);
  // short texts stay whole
  assert.deepEqual(I.clipLong("짧은 글\n두 줄"), { text: "짧은 글\n두 줄", cut: false, more: 0 });
  // the timeline still pairs the typed paste with its sent record, and repeated renders reuse the work
  const ms = Date.parse("2026-11-25T08:00:00Z");
  const says = [{ me: true, ms, ts: "", text: pasted }];
  const mine = [{ id: "a", po: "mascoz", ms: ms - 1000, at: ms - 1000, line: pasted, text: log, status: "sent" }];
  const first = I.timeline("mascoz", [], says, mine);
  assert.equal(first.filter((e) => e.who === "me").length, 1);
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) I.timeline("mascoz", [], says, mine);
  assert.ok(Date.now() - t0 < 1000, "200 renders of a huge paste must stay under a second");
});

test("long message: main.js folds the person's and the PO's bubbles behind 더 보기", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /clipLong\(bp\.text\)/);
  assert.match(src, /mdFolded\(id, e\.text, t\)/);
  assert.match(src, /moreLabel\(lc\.more\)/);
});

// ---- #74: a draft in the chat box (and the answer boxes) survives every redraw

// A stand-in for the retained text state: text, cursor and tokens are kept; `host` wipes it the way a rebuilt view would.
function fakeBox(text = "", range = null) {
  const b = { v: text, r: range ?? { start: text.length, end: text.length }, sets: 0,
    value() { return this.v; }, content() { return { text: this.v, tokens: [] }; },
    selected_range() { return this.r; }, set_selected_range(x) { this.r = x; },
    set_value(x) { this.sets++; this.v = typeof x === "string" ? x : x.text; if (!this.r || this.r.end > this.v.length) this.r = { start: this.v.length, end: this.v.length }; },
    host() { this.v = ""; this.r = { start: 0, end: 0 }; } };
  return b;
}
function typingDesk(chat) {
  const d = replyDesk();
  d.chat = chat;
  d.mirrorNow = (key, st) => d.keep(key, st, st.value());
  return d;
}

test("#74: draftWiped — empty box, text in the mirror, and no key press of the person's just before", () => {
  const m = { text: "쓰던 글" };
  assert.equal(I.draftWiped(m, "", 0, 10_000), true);
  assert.equal(I.draftWiped(m, "", 9_500, 10_000), false); // the person deleted it (a key within DRAFT_KEY_MS)
  assert.equal(I.draftWiped(m, "쓰던", 0, 10_000), false); // not empty
  assert.equal(I.draftWiped(null, "", 0, 10_000), false); // nothing was written
  assert.equal(I.draftWiped({ text: "" }, "", 0, 10_000), false);
});

// Each path that redraws or rebuilds around the box: new message, room refresh, status/label, counts, typing line, mode switch, pin tick.
// The box is wiped as a rebuilt view would wipe it; whichever path draws next (all of them go through full() or pinTick()) puts the draft back.
for (const path of ["새 메시지(말풍선)", "방 목록 새로고침", "상태·라벨·배지 갱신", "개수 갱신", "입력 중 표시줄", "모드 전환(UI 모드·창·도크)", "pinTick 다시 그리기"]) {
  test(`#74: ${path} 뒤에도 쓰던 글과 커서가 남는다`, () => {
    const chat = fakeBox("회의 전에 이거 확인해줘", { start: 4, end: 4 });
    const d = typingDesk(chat);
    d.keep("chat", chat, chat.value());
    d.keyAt = Date.now() - 60_000; // typed a minute ago
    chat.host(); // the redraw path emptied it
    d.guardAll();
    assert.equal(chat.v, "회의 전에 이거 확인해줘");
    assert.deepEqual(chat.r, { start: 4, end: 4 });
  });
}

test("#74: change 이벤트로 빈 값이 와도 사람 키 입력이 없었으면 되돌리고, 있었으면 지운 것으로 본다", () => {
  const chat = fakeBox("abc");
  const d = typingDesk(chat);
  d.keep("chat", chat, "abc");
  d.keyAt = Date.now() - 5000;
  chat.host();
  assert.equal(d.guard("chat", chat, ""), true);
  assert.equal(chat.v, "abc");
  // the person selects all and deletes: a key press, so the mirror follows the empty box
  d.keyAt = Date.now();
  chat.host();
  assert.equal(d.guard("chat", chat, ""), false);
  d.keep("chat", chat, "");
  assert.equal(d.mirror.has("chat"), false);
  d.keyAt = 0;
  d.guardAll();
  assert.equal(chat.v, ""); // and it stays empty afterwards
});

test("#74: 보내기·낡은 초안 정리는 우리가 비운 것이라 되돌리지 않는다", () => {
  const chat = fakeBox("보낼 글");
  const d = typingDesk(chat);
  d.keep("chat", chat, "보낼 글");
  d.keyAt = 0;
  d.wipe("chat", chat); // sendChat
  d.guardAll();
  assert.equal(chat.v, "");
  // an answer box cleared by pruneReply / clearBox stays cleared
  d.inputs.set("lead-gone", fakeBox("old draft"));
  d.keep("lead-gone", d.inputs.get("lead-gone"), "old draft");
  d.pruneReply([ASK("lead-a")]);
  d.inputSeen.set("lead-gone", 0);
  d.pruneReply([ASK("lead-a")]);
  d.guardAll();
  assert.equal(d.inputs.get("lead-gone").v, "");
});

test("#74: 답변 상자의 글도 같은 방식으로 지켜진다", () => {
  const d = typingDesk(fakeBox(""));
  const box = fakeBox("답: 2안으로");
  d.inputs.set("lead-a", box);
  d.keep("lead-a", box, box.value());
  d.keyAt = 0;
  box.host();
  d.guardAll();
  assert.equal(box.v, "답: 2안으로");
});

test("#74: 소스 — 채팅 상자는 모든 방에서 같은 자리에 그려지고(id 고정), 상태는 한 번만 만들며, 다시 그리기 경로가 상자를 비우지 않는다", () => {
  assert.equal((MAIN.match(/TextareaState\.new\(/g) ?? []).length, 2); // the chat box and, since #110, the answer box of a card (made once per leader in box())
  const box = MAIN.slice(MAIN.indexOf("  chatBox(t, v) {"), MAIN.indexOf("  poHint(t) {"));
  assert.doesNotMatch(box, /chat-none/); // the "PO 모름" room no longer swaps the box out of the tree
  for (const id of ["chat-box", "chat-target", "chat-row", "chat-input"]) assert.match(box, new RegExp(`id\\("${id}"\\)`));
  assert.match(MAIN, /full\(cx\) \{\n    this\.tvN = 0;\n    this\.noteRedraw\(cx\);\n    this\.guardAll\(\);/);
  assert.match(MAIN, /pinTick\(cx\) \{\n    this\.guardAll\(\);/);
  // the only places that write into the box: our own clears (wipe), the guard's restore, the "@" pick, the held / stray line break (dropAt, dropBreak) and the restore of a selection an Enter swapped for a line break (putBack), the room switch (syncRoom, #66)
  const writers = MAIN.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /this\.chat\.(set_value|replace)\(/.test(l));
  const where = (n) => { const head = MAIN.slice(0, MAIN.split("\n").slice(0, n).join("\n").length); return head.slice(head.lastIndexOf("\n  ") + 1).split("\n")[0]; };
  for (const [n] of writers) assert.match(MAIN.split("\n").slice(0, n).reverse().find((l) => /^  [a-zA-Z]+\(.*\) \{$/.test(l)), /pickMenu|enterBox|dropBreak|dropAt|putBack|syncRoom/, `line ${n}`);
});

test("#66 mdText: a numbered list stays compact even when the source has blank lines between its items, like the '-' list", () => {
  assert.equal(I.mdText("앞\n\n1. 하나\n\n2. 둘\n\n3. 셋\n\n뒤"), "앞\n\n1. 하나\n2. 둘\n3. 셋\n\n뒤");
  assert.equal(I.mdText("- a\n\n- b"), "- a\n- b");
  assert.equal(I.mdText("1) 하나\n\n\n2) 둘"), "1. 하나\n2. 둘");
  // a blank line between a list and a real paragraph stays, and so does one between two paragraphs
  assert.equal(I.mdText("- a\n\n문단\n\n다음 문단"), "- a\n\n문단\n\n다음 문단");
  assert.equal(I.mdText("- a\n\n```\nx\n```"), "- a\n\n```\nx\n```");
});

test("#66 mdText: a first line '[이름] 종류' over more text is a bold header; a link, a lone line or a long sentence is not", () => {
  assert.equal(I.mdText("[lead-po-inbox] 최종 확인 요청\n\n본문"), "**[lead-po-inbox] 최종 확인 요청**\n\n본문");
  assert.deepEqual(I.mdBlocks(I.mdText("[lead-po-inbox] 최종 확인 요청\n본문\n\n1. 하나\n\n2. 둘")), [{ s: "[lead-po-inbox] 최종 확인 요청", bold: true }, { s: "본문\n\n1. 하나\n2. 둘", bold: false }]);
  assert.equal(I.mdText("[a] b"), "[a] b"); // nothing under it
  assert.equal(I.mdText("[링크](http://x) 가\n다"), "[링크](http://x) 가  \n다");
  assert.equal(I.mdText("[a] " + "긴 ".repeat(40) + "\n다"), "[a] " + "긴 ".repeat(40) + "  \n다");
  assert.equal(I.mdText("앞 줄\n[a] 둘째 줄\n다"), "앞 줄  \n[a] 둘째 줄  \n다"); // only the first line
  assert.equal(I.mdText("**[a] 이미 굵게**\n다"), "**[a] 이미 굵게**  \n다");
});

test("#66 the person's own bubble draws through the same Markdown path as the PO bubbles (list, `code`, bold header)", () => {
  assert.match(MAIN, /when\(Boolean\(bp\.text\), \(el\) => el\.child\(this\.md\(`\$\{id\}-t`, words\)\)\)/);
  assert.ok(!/chatHtml\(words\)/.test(MAIN));
  assert.match(MAIN, /this\.mdFolded\(id, e\.text, t\)/);
});

test("#66 the recommended option's button says so, and still sends the plain '<N>안 선택'", () => {
  assert.match(MAIN, /`\$\{n\}안 선택\$\{n === opts\.recommended \? " \(추천\)" : ""\}`, \(c\) => this\.send\(a, `\$\{n\}안 선택`, c, "choice"\)/);
});

// ---- #74 R4: a picture read that finishes after a room switch belongs to the room it started in.
test("#74 R4: a picture read that ends after the room changed lands in the room it started in, and the room shown is not blocked meanwhile", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = pictureDesk(async () => { await gate; return { code: 0, stdout: JSON.stringify({ path: "data/inbox/img/late.png", w: 4, h: 5 }), stderr: "" }; });
  d.draftRoom = "lead-a";
  const p = d.addPic(["clipimg"], fakeCx());
  assert.equal(d.picBusy, 1, "room A shows the read");
  d.draftRoom = "lead-b"; // the person clicked room B (syncRoom also sets picBusy from the room's own count)
  d.picBusy = d.picBusyBy.get("lead-b") ?? 0;
  assert.equal(d.picBusy, 0, "room B is not blocked by A's read");
  release();
  await p;
  assert.equal(d.pics.length, 0, "B's picture list stays empty");
  assert.equal(d.picBusy, 0);
  assert.deepEqual(d.roomDrafts.get("lead-a").pics.map((x) => x.path), ["data/inbox/img/late.png"], "the picture is in A's saved draft");
  assert.equal(d.picBusyBy.size, 0, "A's count is released");
});

test("#74 R4: a picture read for the room still shown goes to the box as before", async () => {
  const d = pictureDesk(okExec);
  d.draftRoom = "lead-a";
  await d.addPic(["clipimg"], fakeCx());
  assert.equal(d.pics.length, 1);
  assert.equal(d.roomDrafts.size, 0);
});

test("#74 R4: the file button remembers the room it was pressed in, so a slow picker does not move the picture", async () => {
  const d = pictureDesk(okExec);
  d.draftRoom = "lead-a";
  const p = d.pickPics(fakeCx());
  d.draftRoom = "lead-b";
  await p;
  assert.equal(d.pics.length, 0);
  assert.equal(d.roomDrafts.get("lead-a").pics.length, 1);
});

test("#74 R4: a draft slot made only of a late picture comes back with the room (swapDraft keeps it)", () => {
  const slots = new Map([["lead-a", { text: "", pics: [{ path: "p.png", w: 1, h: 1 }] }]]);
  const r = I.swapDraft(slots, "lead-b", "lead-a", { text: "", content: null, range: null, pics: [] });
  assert.deepEqual(r.load?.pics, [{ path: "p.png", w: 1, h: 1 }]);
});

// ---- #74 R4: a checkbox line is not a [tag] headline.
test("#74 R4 mdText: the first line '[ ] 할 일' / '[x] 끝' is a checkbox line, not a bold [tag] headline; a real [tag] headline still is", () => {
  for (const first of ["[ ] 하나 해야 함", "[x] 다 했음", "[X] 다 했음", "[✓] 확인", "[] 비어 있음"]) {
    const out = I.mdText(`${first}\n본문`);
    assert.ok(!out.startsWith("**"), first);
  }
  assert.ok(I.mdText("[lead-po] 확인 요청\n본문").startsWith("**[lead-po] 확인 요청**"));
  assert.ok(I.mdText("[x1] 확인 요청\n본문").startsWith("**[x1]"), "a tag that merely starts with x is a tag");
  assert.ok(I.mdText("[ok] 완료 보고\n본문").startsWith("**[ok]"));
});

test("#74 sendBang: the box is cleared through wipe() (draft mirror dropped), so guard() cannot restore the sent '!cmd'", () => {
  const body = MAIN.slice(MAIN.indexOf("  sendBang(c, po, p, pics) {"), MAIN.indexOf("  bangGate(po) {"));
  assert.match(body, /this\.wipe\("chat", this\.chat\)/);
  assert.doesNotMatch(body, /this\.chat\.set_value\(/);
});
