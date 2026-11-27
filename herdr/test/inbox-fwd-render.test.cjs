// #82 render: the person's typed line that the PO passed on shows a quiet "→ x 그대로/다듬어 전달" mark, and it counts as a line to that leader.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
const NOW = Date.parse("2026-01-01T09:05:00Z");
const me = (text, pid) => ({ ts: "2026-01-01T09:00:00Z", kind: "me", text, src: "hook", pid });
const fwd = (to, pid, extra = {}) => ({ ts: "2026-01-01T09:01:00Z", kind: "fwd", to, pid, ...extra });
const says = (...lines) => I.parsePoLines(lines.map((l) => JSON.stringify(l)).join("\n"));
const tlOf = (...lines) => I.timeline("demo", [], says(...lines), [], [], NOW);

test("timeline carries fwd onto the typed me entry", () => {
  const tl = tlOf(me("배포 막아 줘", "p1"), fwd("lead-a", "p1", { h: I.fwdHash("배포 막아 줘") }), fwd("lead-b", "p1"));
  const m = tl.filter((e) => e.who === "me");
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].fwd, [{ to: "lead-a", exact: true }, { to: "lead-b", exact: false }]);
  assert.equal(m[0].to, "");
});

test("a typed line without a fwd carries no fwd key", () => {
  const m = tlOf(me("그냥 말", "p1")).filter((e) => e.who === "me");
  assert.equal("fwd" in m[0], false);
});

test("leaderEntries keeps the line only for the leaders it was passed to", () => {
  const tl = tlOf(me("배포 막아 줘", "p1"), fwd("lead-a", "p1"));
  assert.equal(I.leaderEntries(tl, "lead-a").filter((e) => e.who === "me").length, 1);
  assert.equal(I.leaderEntries(tl, "lead-b").filter((e) => e.who === "me").length, 0);
});

test("fwdMarks: exact or reworded wording, only the picked leader in a 1:1 view, nothing on other bubbles", () => {
  const e = { who: "me", fwd: [{ to: "lead-a", exact: true }, { to: "lead-b", exact: false }] };
  assert.deepEqual(I.fwdMarks(e), ["→ lead-a 그대로 전달", "→ lead-b 다듬어 전달"]);
  assert.deepEqual(I.fwdMarks(e, "lead-b"), ["→ lead-b 다듬어 전달"]);
  assert.deepEqual(I.fwdMarks(e, "lead-c"), []);
  assert.deepEqual(I.fwdMarks(e, "", (n) => n.toUpperCase()), ["→ LEAD-A 그대로 전달", "→ LEAD-B 다듬어 전달"]);
  assert.deepEqual(I.fwdMarks({ who: "po", fwd: e.fwd }), []);
  assert.deepEqual(I.fwdMarks({ who: "me" }), []);
});

test("entryRow draws the marks in the me branch, below the → to line and above the bubble", () => {
  const row = MAIN.slice(MAIN.indexOf("  entryRow(t, e, v, cx) {"), MAIN.indexOf("  render(cx) {"));
  const to = row.indexOf("→ ${shortName(e.to)}");
  const marks = row.indexOf("fwdMarks(e, v.who");
  const bubble = row.indexOf("always the right edge");
  assert.ok(to > 0 && marks > to && bubble > marks);
});

test("main.js and inbox.cjs define fwdMarks the same", () => {
  const take = (s) => s.slice(s.indexOf("const fwdMarks ="), s.indexOf("\n", s.indexOf("const fwdMarks =")));
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.ok(take(MAIN).length > 50);
  assert.equal(take(MAIN), take(cjs));
});
