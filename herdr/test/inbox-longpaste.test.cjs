// A long paste sent from the desk must show once (#49): the PO hook keeps at most 2000 characters of a typed line and ends a longer one in
// "…", so the hook's copy of the send no longer equals the desk record, and both used to be drawn as two of the person's bubbles.
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../mods/inbox/inbox.cjs");

const ROOM = "devnotes";
const T0 = Date.parse("2026-11-25T08:11:30.000Z");
const LOG = Array.from({ length: 60 }, (_, i) => `Assets/Mascoz/Scripts/Panel${i}.cs(${i + 10},20): warning CS0414: The field 'Panel${i}.x' is assigned but its value is never used`).join("\n");

const mineOf = (text, extra = {}) => I.chatRecord({ text, po: ROOM, ...extra }, "sent", T0, 1);
function saysOf(prompt, at = T0 + 7000) {
  const line = I.hookLine({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: "p1" }, at);
  return I.parsePoLines(JSON.stringify(line));
}
const meBubbles = (tl) => tl.filter((e) => e.who === "me");

test("the hook cuts a long paste to 2000 characters with an ellipsis", () => {
  assert.ok(LOG.length > 5000);
  const line = I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: `<pasted_content id="79f3">\n${LOG}` }, T0);
  assert.equal(line.text.length, 2000);
  assert.ok(line.text.endsWith("…"));
});

test("a long desk send cut by the hook shows one bubble (wrapped paste)", () => {
  const says = saysOf(`<pasted_content id="79f3">\n${LOG}\n</pasted_content id="79f3">`);
  const tl = I.timeline(ROOM, [], says, [mineOf(LOG)], [], T0 + 8000);
  const me = meBubbles(tl);
  assert.equal(me.length, 1);
  assert.equal(me[0].text, LOG); // the desk record (the whole text) is the one kept
  assert.ok(!me[0].typed);
});

test("a long desk send cut by the hook shows one bubble (plain text)", () => {
  const tl = I.timeline(ROOM, [], saysOf(LOG), [mineOf(LOG)], [], T0 + 8000);
  assert.equal(meBubbles(tl).length, 1);
});

test("a cut typed line whose start differs from every desk send still shows", () => {
  const other = LOG.replace("Panel0.cs", "Other0.cs");
  const tl = I.timeline(ROOM, [], saysOf(other), [mineOf(LOG)], [], T0 + 8000);
  assert.equal(meBubbles(tl).length, 2);
});

test("a short typed line that merely ends in an ellipsis does not swallow a longer send", () => {
  const tl = I.timeline(ROOM, [], saysOf("Assets/Mascoz…"), [mineOf(LOG)], [], T0 + 8000);
  assert.equal(meBubbles(tl).length, 2);
});

test("a cut line outside the send window still shows", () => {
  const tl = I.timeline(ROOM, [], saysOf(LOG, T0 + 12 * 60000), [mineOf(LOG)], [], T0 + 12 * 60000);
  assert.equal(meBubbles(tl).length, 2);
});
