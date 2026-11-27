"use strict";
// #68: the room list's width can be dragged, is kept within limits and is saved.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");
const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");

test("roomWidth: default, clamp to the limits and to half the window, broken values fall back", () => {
  assert.equal(I.roomWidth(undefined, null), 168);
  assert.equal(I.roomWidth("", 720), 168);
  assert.equal(I.roomWidth(null, 720), 168);
  assert.equal(I.roomWidth("abc", 720), 168);
  assert.equal(I.roomWidth(10, null), I.ROOM_W_MIN);
  assert.equal(I.roomWidth(9999, null), I.ROOM_W_MAX);
  assert.equal(I.roomWidth(300, 720), 300);
  assert.equal(I.roomWidth(300, 520), 260, "never wider than half the window");
  assert.equal(I.roomWidth(300, 200), I.ROOM_W_MIN, "the minimum wins in a tiny window");
  assert.equal(I.roomWidth(200.4, null), 200);
});

test("the helper block is identical in main.js and inbox.cjs", () => {
  const grab = (s) => s.slice(s.indexOf("const ROOM_W_MIN"), s.indexOf("const roomWidth") + 400).split("\n").slice(0, 8).join("\n");
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.equal(grab(MAIN), grab(cjs));
});

test("wiring: grip beside the wide list, drag in the window mouse move, saved on release, saved value read in init", () => {
  assert.match(MAIN, /this\.roomW = roomWidth\(/);
  assert.match(MAIN, /\.when\(!this\.narrow, \(el\) => el\.child\(this\.roomGrip\(t\)\)\)/);
  assert.match(MAIN, /id\("po-rooms-grip"\)[^\n]*cursor_col_resize\(\)/);
  assert.match(MAIN, /pointer\(e, cx\) \{\n    if \(this\.rdrag\) \{ this\.roomDrag\(e, cx\); return; \}/);
  assert.match(MAIN, /pointerUp\(cx, e\) \{\n    if \(this\.rdrag\) \{ this\.roomDragEnd\(cx\); return; \}/);
  assert.match(MAIN, /setShared\(ROOM_W_KEY, this\.roomW\)/);
  assert.match(MAIN, /\.tooltip\(x\.id === PO_OTHER \? OTHER_TIP : `\$\{x\.label\} · po=/);
});

// Run the drag methods against a stub view.
function drive() {
  const grab = (head, next) => { const a = MAIN.indexOf(head); return MAIN.slice(a, MAIN.indexOf(next, a)); };
  const src = `({ ${grab("  roomDrag(e, cx) {", "  roomDragEnd(cx) {")}, ${grab("  roomDragEnd(cx) {", "\n  // The most px a message bubble")} })`;
  const saved = [];
  const g = { roomWidth: I.roomWidth, setShared: (k, v) => saved.push([k, v]), ROOM_W_KEY: I.ROOM_W_KEY };
  const m = new Function(...Object.keys(g), `return ${src};`)(...Object.values(g));
  const v = { rdrag: { x: 200, w: 168 }, roomW: 168, winW: 720, ui: { press: true }, dirty: false, softNotify() {}, ...m };
  let notes = 0; const cx = { notify() { notes++; } };
  return { v, cx, saved, notes: () => notes };
}

test("dragging right widens, left narrows, within the limits; the release saves once and ends the drag", () => {
  const d = drive();
  d.v.roomDrag({ pressed_button: "left", position: { x: 260 } }, d.cx);
  assert.equal(d.v.roomW, 228);
  d.v.roomDrag({ pressed_button: "left", position: { x: 1000 } }, d.cx);
  assert.equal(d.v.roomW, 360, "over the cap it stops at the cap");
  d.v.roomDrag({ pressed_button: "left", position: { x: 0 } }, d.cx);
  assert.equal(d.v.roomW, I.ROOM_W_MIN);
  assert.equal(d.saved.length, 0, "nothing is saved while dragging");
  d.v.roomDragEnd(d.cx);
  assert.equal(d.v.rdrag, null);
  assert.equal(d.v.ui.press, false);
  assert.deepEqual(d.saved, [[I.ROOM_W_KEY, I.ROOM_W_MIN]]);
});

test("a move without the left button ends the drag and saves; a move without a position is ignored", () => {
  const d = drive();
  d.v.roomDrag({ pressed_button: "left" }, d.cx);
  assert.equal(d.v.roomW, 168);
  d.v.roomDrag({ position: { x: 300 } }, d.cx);
  assert.equal(d.v.rdrag, null);
  assert.equal(d.saved.length, 1);
});
