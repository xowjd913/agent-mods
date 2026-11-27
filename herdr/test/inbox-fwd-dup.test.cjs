// #82: a multi-line paste that the PO hook cut inside its closing tag ("…\n</pasted_…") must still match the desk's own record of that send,
// so the person sees ONE bubble, and the "→ x 다듬어 전달" mark moves onto the desk bubble (the hook line is not drawn then).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const T0 = Date.parse("2026-11-27T06:40:19Z");
// real shape: a log paste of many lines, then the person's own sentence, wrapped by the terminal, kept to 2000 characters by the hook
const body = Array.from({ length: 27 }, (_, i) => `UnityEngine.Debug:LogError (object) at Assets/Scripts/Tool.cs:${100 + i}`).join("\n") + "\n\n빌드 피씨에서 메인브랜치에서 어드레서블 뽑는데 왜 저런에러가 나오냐 대체";
const wrapped = `<pasted_content id="5926">\n${body}\n</pasted_content>`;
const hookText = wrapped.slice(0, wrapped.length - "content>".length) + "…"; // the cut lands inside the closing tag, as in the real record
const hookLine = (text) => ({ ts: "2026-11-27T06:40:20.598Z", kind: "me", text, src: "hook", pid: "p-8fe7" });
const fwdLine = { ts: "2026-11-27T06:40:47Z", kind: "fwd", to: "lead-art-hotfix", pid: "p-8fe7", h: "73bcd3d46f9a2ae6" };
const says = (...ls) => I.parsePoLines(ls.map((l) => JSON.stringify(l)).join("\n"));
const desk = (text, over = {}) => ({ id: `${T0}-a`, at: T0, ms: T0, ts: new Date(T0).toISOString(), text, line: text, to: "", po: "demo", kind: "chat", status: "sent", ...over });
const meOf = (tl) => tl.filter((e) => e.who === "me");

test("the real-shaped hook line really is a cut inside the closing tag", () => {
  assert.ok(hookText.length > 500 && hookText.length <= 2000);
  assert.ok(hookText.endsWith("</pasted_…"));
  assert.ok(wrapped.length < 2000);
});

test("tlCut drops a half closing tag before the prefix is compared", () => {
  const k = I.hookProved([{ ms: T0 + 1000, text: hookText }], desk(body));
  assert.equal(k, true);
});

test("desk record + cut hook line draw ONE bubble, with the forward mark on it", () => {
  const tl = I.timeline("demo", [], says(hookLine(hookText), fwdLine), [desk(body)], [], T0 + 60000);
  const m = meOf(tl);
  assert.equal(m.length, 1);
  assert.equal(m[0].typed, undefined);
  assert.equal(m[0].id, `${T0}-a`);
  assert.deepEqual(m[0].fwd, [{ to: "lead-art-hotfix", exact: false }]);
  assert.deepEqual(I.fwdMarks(m[0]), ["→ lead-art-hotfix 다듬어 전달"]);
});

test("the desk bubble counts as a line to the leader it was forwarded to", () => {
  const tl = I.timeline("demo", [], says(hookLine(hookText), fwdLine), [desk(body)], [], T0 + 60000);
  assert.equal(I.leaderEntries(tl, "lead-art-hotfix").filter((e) => e.who === "me").length, 1);
  assert.equal(I.leaderEntries(tl, "lead-other").filter((e) => e.who === "me").length, 0);
});

test("without a forward record the desk bubble carries no fwd key", () => {
  const m = meOf(I.timeline("demo", [], says(hookLine(hookText)), [desk(body)], [], T0 + 60000));
  assert.equal(m.length, 1);
  assert.equal("fwd" in m[0], false);
});

test("a short line ending in a half tag still does not hide a longer, different send", () => {
  const short = "<pasted_content id=\"1\">\n짧은 글\n</pasted_…";
  const m = meOf(I.timeline("demo", [], says(hookLine(short)), [desk(body)], [], T0 + 60000));
  assert.equal(m.length, 2);
});

test("a cut line from a different paste does not match", () => {
  const m = meOf(I.timeline("demo", [], says(hookLine(hookText)), [desk(body.replace("Tool.cs", "Other.cs"))], [], T0 + 60000));
  assert.equal(m.length, 2);
});

test("main.js carries the same half-tag fix and the fwd move as inbox.cjs", () => {
  const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  for (const needle of ["const TL_HALF_TAG", "fwdOf.set(sentBy[i], x.fwd)", "...(fwdOf.get(x)?.length ? { fwd: fwdOf.get(x) } : {})"]) {
    assert.ok(MAIN.includes(needle) && CJS.includes(needle), needle);
  }
});
