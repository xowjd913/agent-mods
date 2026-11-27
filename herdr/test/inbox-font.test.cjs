// #80: the UI mode's text follows Herdr's text size (settings().font_size / 13). Pure factor + the source keeps every written size behind fz().
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");

test("fontScale: 13 is today's look (1), others scale linearly", () => {
  assert.equal(I.FONT_BASE, 13);
  assert.equal(I.fontScale({ font_size: 13 }), 1);
  assert.equal(I.fontScale({ font_size: 26 }), 2);
  assert.ok(Math.abs(I.fontScale({ font_size: 14 }) - 14 / 13) < 1e-9);
  assert.ok(Math.abs(I.fontScale({ font_size: "16" }) - 16 / 13) < 1e-9);
});

test("fontScale: missing or odd values give 1, extremes are held within 0.6..2.5", () => {
  for (const st of [undefined, null, {}, { font_size: null }, { font_size: "x" }, { font_size: 0 }, { font_size: -4 }, { font_size: NaN }, { font_size: Infinity }]) {
    assert.equal(I.fontScale(st), 1, String(st?.font_size));
  }
  assert.equal(I.fontScale({ font_size: 2 }), 0.6);
  assert.equal(I.fontScale({ font_size: 100 }), 2.5);
});

test("main.js: no bare text_size(<number>) or fixed text height is left outside fz()", () => {
  assert.deepEqual(MAIN.match(/\.text_size\(\s*\d[^)]*\)/g) ?? [], []);
  assert.deepEqual(MAIN.match(/\.text_size\((?!fz\()[^)]*\)/g) ?? [], []);
  assert.deepEqual(MAIN.match(/\.(h|min_h)\((15|17|20|22|24|26|30|38)\)/g) ?? [], []);
  assert.ok(MAIN.includes("text_size(fz(13))"), "root keeps the 13 base so the body text scales");
});

test("main.js: the factor is read at draw and by a timer that redraws only when it moved", () => {
  assert.match(MAIN, /import \{ settings,/);
  assert.match(MAIN, /full\(cx\) \{\n\s*syncFont\(\);/);
  assert.match(MAIN, /cx\.timer\.every\(FONT_POLL_MS, \(cx\) => \{ if \(syncFont\(true\)\) this\.softNotify\(cx\); \}\);/);
});

test("syncFont: reads settings(), returns true only when the factor moved, a throwing settings() falls back to 1", () => {
  const blk = MAIN.slice(MAIN.indexOf("// chat:begin"), MAIN.indexOf("// chat:end"));
  const st = MAIN.slice(MAIN.indexOf("let FS = 1"), MAIN.indexOf("\n};\n", MAIN.indexOf("const syncFont")) + 4);
  const fontScale = blk.slice(blk.indexOf("const FONT_BASE"), blk.indexOf("\n", blk.indexOf("const fontScale")) + 1);
  let cur = { font_size: 13 };
  const mk = new Function("settings", `${fontScale}${st}; return { fz, sync: syncFont, fs: () => FS };`);
  const f = mk(() => { if (cur === "boom") throw new Error("x"); return cur; });
  assert.equal(f.sync(true), false);
  assert.equal(f.fz(10.5), 10.5);
  cur = { font_size: 26 };
  assert.equal(f.sync(true), true);
  assert.equal(f.fz(10.5), 21);
  assert.equal(f.sync(true), false);
  cur = "boom";
  assert.equal(f.sync(true), true);
  assert.equal(f.fs(), 1);
});
