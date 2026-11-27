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

test("fontScale: the settings window's fixed size (#126) wins over Herdr's value, follow (no value) falls back to Herdr's", () => {
  assert.equal(I.FONT_KEY, "settings.uiFontSize");
  assert.equal(I.fontScale({ font_size: 26 }, 13), 1);
  assert.equal(I.fontScale({ font_size: 13 }, 20), 20 / 13);
  assert.equal(I.fontScale({ font_size: 13 }, 10), 10 / 13);
  assert.equal(I.fontScale({ font_size: 13 }, 24), 24 / 13);
  assert.equal(I.fontScale({ font_size: 20 }, 16.4), 16 / 13); // a fraction is rounded to whole px
  for (const v of [undefined, null]) assert.equal(I.fontScale({ font_size: 26 }, v), 2, `follow: ${v}`);
  assert.equal(I.fontScale(undefined, 18), 18 / 13); // an override needs no Herdr value at all
});

test("fontScale: a bad override is ignored (the UI mode follows Herdr), nothing throws", () => {
  for (const v of ["16", "x", "", NaN, Infinity, -Infinity, 0, -5, 9.4, 9, 24.6, 25, 100, {}, [], [16], true, false]) {
    assert.equal(I.fontScale({ font_size: 26 }, v), 2, `bad: ${JSON.stringify(v)}`);
    assert.equal(I.fontOverride(v), null, `bad: ${JSON.stringify(v)}`);
  }
  assert.equal(I.fontOverride(10), 10);
  assert.equal(I.fontOverride(24), 24);
  assert.equal(I.fontOverride(9.6), null); // below the limit before rounding
});

test("syncFont: reads settings() and the shared override, returns true only when the factor moved, a throwing read falls back to 1", () => {
  const blk = MAIN.slice(MAIN.indexOf("// chat:begin"), MAIN.indexOf("// chat:end"));
  const st = MAIN.slice(MAIN.indexOf("let FS = 1"), MAIN.indexOf("\n};\n", MAIN.indexOf("const syncFont")) + 4);
  const fontCode = blk.slice(blk.indexOf("const FONT_BASE"), blk.indexOf("\n};\n", blk.indexOf("const fontScale")) + 4);
  let cur = { font_size: 13 }, over;
  const mk = new Function("settings", "shared", `${fontCode}${st}; return { fz, sync: syncFont, fs: () => FS };`);
  const f = mk(() => { if (cur === "boom") throw new Error("x"); return cur; }, (k) => (k === "settings.uiFontSize" ? over : undefined));
  assert.equal(f.sync(true), false);
  assert.equal(f.fz(10.5), 10.5);
  cur = { font_size: 26 };
  assert.equal(f.sync(true), true);
  assert.equal(f.fz(10.5), 21);
  assert.equal(f.sync(true), false);
  over = 13; // the settings window fixes 13 px: wins over Herdr's 26, no restart (the next read picks it up)
  assert.equal(f.sync(true), true);
  assert.equal(f.fz(10.5), 10.5);
  over = "junk"; // a bad value: follow Herdr again
  assert.equal(f.sync(true), true);
  assert.equal(f.fz(10.5), 21);
  over = null;
  assert.equal(f.sync(true), false);
  cur = "boom";
  assert.equal(f.sync(true), true);
  assert.equal(f.fs(), 1);
});

test("inbox.cjs and the main.js chat block hold the same font code", () => {
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  const cut = (t) => t.slice(t.indexOf("const FONT_BASE"), t.indexOf("\n};\n", t.indexOf("const fontScale")) + 4);
  assert.equal(cut(MAIN), cut(cjs));
});
