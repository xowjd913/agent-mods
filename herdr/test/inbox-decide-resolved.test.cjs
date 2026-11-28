// #140: a decision answered in chat leaves the 결정 필요 chip (and its count). The rule: its own `answered` flag, or a LATER line of the person to that
// leader (a chat line or a PO-forwarded `fwd`). A later report, a PO line without `fwd`, an earlier line, or a line to another leader do not close it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
const NOW = Date.parse("2026-01-01T10:00:00Z");
const T = (min) => `2026-01-01T09:${String(min).padStart(2, "0")}:00Z`;
const rec = (leader, kind, min, extra = {}) => ({ ts: T(min), leader, kind, title: `[${leader}] ${kind} ${min}`, body: "본문", ...extra });
const jsonl = (...ls) => ls.map((l) => JSON.stringify(l)).join("\n") + "\n";
const says = (...lines) => I.parsePoLines(lines.map((l) => JSON.stringify(l)).join("\n"));
const me = (text, min, extra = {}) => ({ ts: T(min), kind: "me", text, src: "hook", pid: `p${min}`, ...extra });
const fwd = (to, min, pid) => ({ ts: T(min), kind: "fwd", to, pid });
// The room's timeline as the desk builds it: leader reports (real `summarize`), the PO hook lines (`poLines`) and the desk's own sends (`mine`, from
// deliver(): a chat @leader or an answer button, `to` = the leader).
function tlOf(reports, ...poLines) {
  const leaders = Object.entries(reports).map(([leader, lines]) => ({ s: I.summarize(leader, jsonl(...lines)), owner: "demo" }));
  const mine = poLines.filter((l) => l.kind === "desk").map((l) => ({ id: `d${l.min}`, ts: T(l.min), ms: Date.parse(T(l.min)), text: l.text, line: l.text, to: l.to, ...(l.tos ? { tos: l.tos } : {}), po: "demo", kind: l.how || "chat", status: "sent" }));
  return I.timeline("demo", leaders, says(...poLines.filter((l) => l.kind !== "desk")), mine, [], NOW);
}
const desk = (text, min, extra = {}) => ({ kind: "desk", text, min, ...extra });
const open = (tl) => I.filterEntries(tl, "decision", 0);
const reportsOf = (tl) => tl.filter((e) => e.who.startsWith("l:"));

test("answered: a later answered line of the leader closes the decision (it.answered)", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1), rec("lead-a", "decision", 2), rec("lead-a", "answered", 3)] });
  const dec = reportsOf(tl).filter((e) => e.it.kind === "decision");
  assert.equal(dec.length, 2);
  assert.deepEqual(dec.map((e) => e.it.answered), [false, true], "markAnswered flags the decision the answered line closed");
  assert.deepEqual(open(tl).map((e) => e.it.title), ["[lead-a] decision 1"]);
});

test("later me -> leader line closes the decision", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1)] }, desk("1안으로 가", 2, { to: "lead-a" }));
  assert.equal(reportsOf(tl).filter((e) => e.it.kind === "decision").length, 1);
  assert.equal(open(tl).length, 0);
  const tos = tlOf({ "lead-a": [rec("lead-a", "decision", 1)] }, desk("둘 다 1안", 2, { to: "lead-b", tos: ["lead-b", "lead-a"] }));
  assert.equal(open(tos).length, 0);
});

test("later fwd -> leader (PO forwarded the person's words) closes the decision", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1)] }, me("1안으로 가줘", 2, { pid: "p1" }), fwd("lead-a", 3, "p1"));
  assert.deepEqual(tl.find((e) => e.who === "me").fwd, [{ to: "lead-a", exact: false }]);
  assert.equal(open(tl).length, 0);
});

test("an earlier me / fwd line (before the decision) is ignored", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 5)] }, desk("전에 한 말", 1, { to: "lead-a" }), me("전달된 말", 2, { pid: "p2" }), fwd("lead-a", 3, "p2"));
  assert.equal(open(tl).length, 1);
});

test("a fwd to another leader is ignored (and so is a chat line to another leader)", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1)] }, me("b에게만", 2, { pid: "p1" }), fwd("lead-b", 3, "p1"), desk("b 채팅", 4, { to: "lead-b" }));
  assert.equal(open(tl).length, 1);
});

test("a PO line without fwd does not close it (even one that mentions the leader)", () => {
  const po = { ts: T(2), kind: "say", text: "lead-a 결정 필요한 건 확인해 보세요", about: "" };
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1)] }, po, { ts: T(3), kind: "say", text: "ok", to: "lead-a" });
  assert.equal(tl.filter((e) => e.who === "po").length, 2, "both lines are drawn as PO lines");
  assert.equal(open(tl).length, 1);
});

test("a later report (done / resume / stop) of the leader does not close it", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1), rec("lead-a", "done", 2), rec("lead-a", "resume", 3), rec("lead-a", "stop", 4)] });
  assert.equal(open(tl).length, 1);
});

test("only the decisions of the leader the line went to close; the other leader's stays open", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1)], "lead-b": [rec("lead-b", "decision", 1)] }, desk("a 1안", 2, { to: "lead-a", how: "answer" }));
  const o = open(tl);
  assert.equal(o.length, 1);
  assert.equal(o[0].leader, "lead-b");
});

test("count and the 결정 필요 filter share one open set; 전체 keeps the closed decision; other chips are unchanged", () => {
  const tl = tlOf({ "lead-a": [rec("lead-a", "decision", 1), rec("lead-a", "decision", 6), rec("lead-a", "verify", 2), rec("lead-a", "done", 3)] },
    desk("1안으로 가", 4, { to: "lead-a" }));
  const counts = I.filterCounts(tl, 0);
  assert.equal(counts.decision, open(tl).length);
  assert.equal(counts.decision, 1, "only the decision after the chat line stays open");
  assert.equal(counts.all, tl.length);
  assert.equal(I.filterEntries(tl, "all", 0).filter((e) => e.it?.kind === "decision").length, 2);
  assert.equal(counts.verify, 1);
  assert.equal(counts.done, 1);
});

test("a waiting leader is never closed: the waiting entry stays under 결정 필요", () => {
  const e = { who: "l:lead-a", ms: 1000, waiting: "decision", it: { kind: "decision", answered: true } };
  const later = { who: "me", ms: 2000, to: "lead-a" };
  assert.equal(I.decisionClosed(e, [e, later]), false);
  assert.deepEqual(I.filterEntries([e, later], "decision", 0), [e]);
  const wait = { who: "l:lead-a", ms: 1000, wait: true, waiting: "decision" };
  assert.equal(I.decisionClosed(wait, [wait, later]), false);
});

test("decisionClosed ignores non-decision entries and malformed input", () => {
  assert.equal(I.decisionClosed({ who: "l:a", ms: 1, it: { kind: "done" } }, []), false);
  assert.equal(I.decisionClosed({ who: "me", ms: 1, to: "a" }, []), false);
  assert.equal(I.decisionClosed({ who: "po", ms: 1 }, []), false);
  assert.equal(I.decisionClosed(null, null), false);
  assert.equal(I.decisionClosed({ who: "l:a", ms: 1, it: { kind: "decision" } }, null), false);
  assert.equal(I.decisionClosed({ who: "l:a", ms: 5, it: { kind: "decision" } }, [{ who: "me", ms: 5, to: "a" }]), false, "the same ms is not later");
});

test("main.js and inbox.cjs define decisionClosed and filterEntries the same", () => {
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  const take = (s) => s.slice(s.indexOf("function decisionClosed("), s.indexOf("// What the timeline draws under a filter"));
  assert.ok(take(MAIN).length > 400);
  assert.equal(take(MAIN), take(cjs));
});
