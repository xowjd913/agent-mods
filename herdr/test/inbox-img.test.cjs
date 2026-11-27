// Tests of the picture, bubble-size, scroll-pin and selection rules (PO desk, #36/#37). The visual results (how wide a bubble really draws,
// whether a drag-select survives in the real app, whether image() takes an absolute path) cannot be tested here; these cover the rules
// behind them and the shape of the code that uses them.
require("./helpers/po-home.cjs"); // a PO machine: a profile without `preset` is "po" (see the helper)
const test = require("node:test");
const POSIX = process.platform !== "win32"; // Windows has no POSIX file modes: only the mode asserts are skipped there
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");
const HOOK = require("../mods/inbox/po-hook.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "inbox-img-"));
// a fake but sniffable PNG: signature, IHDR with w x h, padded
const png = (w = 30, h = 20, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = pad & 0xff; // makes different pads different files
  return b;
};

test("imgOk: only a picture directly inside <app root>/data/inbox/img/ (what image() can load)", () => {
  const d = "/home/u/.config/herdr-app";
  const img = `${d}/data/inbox/img`;
  assert.equal(I.imgOk(d, `${img}/ab12.png`), true);
  assert.equal(I.imgOk(d, `${img}/ab12.JPG`), true);
  assert.equal(I.imgOk(d, `${img}/../x.png`), false);
  assert.equal(I.imgOk(d, `${img}/sub/x.png`), false);
  assert.equal(I.imgOk(d, `${img}/x.txt`), false);
  assert.equal(I.imgOk(d, `/etc/passwd.png`), false);
  assert.equal(I.imgOk(d, `${img}/x\n.png`), false);
  assert.equal(I.imgOk(d, `${img}/.png`), true);
  assert.equal(I.imgOk(d, `${d}/po/img/x.png`), false); // the old store (outside the app folder's data/) is not drawn
  assert.equal(I.imgOk(d, `/home/u/.herdr-inbox/po/img/x.png`), false);
  assert.equal(I.imgOk(d, ""), false);
  assert.equal(I.imgOk("", `/data/inbox/img/x.png`), false);
});

test("imgRel: the app-root-relative path image() loads, '' when the picture may not be drawn; appRoot follows HERDR_APP_HOME", () => {
  const d = "/home/u/.config/herdr-app";
  assert.equal(I.imgRel(d, `${d}/data/inbox/img/ab12.png`), "data/inbox/img/ab12.png");
  assert.equal(I.imgRel(d + "/", `${d}/data/inbox/img/ab12.png`), "data/inbox/img/ab12.png");
  assert.equal(I.imgRel(d, `${d}/po/img/ab12.png`), "");
  assert.equal(I.imgRel(d, `${d}/data/inbox/img/../../x.png`), "");
  const prev = process.env.HERDR_APP_HOME;
  process.env.HERDR_APP_HOME = "/x/app";
  try { assert.equal(I.appRoot(), "/x/app"); } finally { if (prev === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = prev; }
  delete process.env.HERDR_APP_HOME;
  try {
    // run from <root>/mods/inbox, the app root is <root>
    assert.equal(I.appRoot(), path.resolve(__dirname, ".."));
  } finally { if (prev !== undefined) process.env.HERDR_APP_HOME = prev; }
});

test("splitImgs / imgLine: the message line round-trips and is cut from the text", () => {
  const p = "/d/data/inbox/img/a.png";
  const { text, imgs } = I.splitImgs(`안녕\n${I.imgLine(p)}\n끝`);
  assert.equal(text, "안녕\n끝");
  assert.deepEqual(imgs, [p]);
  const many = Array.from({ length: 6 }, (_, i) => I.imgLine(`/d/data/inbox/img/${i}.png`)).join("\n");
  assert.equal(I.splitImgs(many).imgs.length, I.MAX_IMGS);
});

test("bubbleParts: pictures that may be drawn, placeholders / legacy pictures without a drawable file become chips, no raw '[Image #N]'", () => {
  const d = "/d";
  const a = "/d/data/inbox/img/a.png";
  let r = I.bubbleParts(`[Image #30] 이거 봐줘`, [a], d);
  assert.equal(r.text, "이거 봐줘");
  assert.deepEqual(r.imgs, [a]);
  assert.deepEqual(r.chips, []);
  r = I.bubbleParts(`[Image #30] [Image #31] 이거`, [], d);
  assert.equal(r.text, "이거");
  assert.deepEqual(r.imgs, []);
  assert.deepEqual(r.chips, [30, 31]);
  r = I.bubbleParts(`[Image #7]`, ["/etc/x.png"], d); // a path outside the folder is never drawn
  assert.deepEqual(r.imgs, []);
  assert.deepEqual(r.chips, [7]);
  r = I.bubbleParts(`[Image #1] [Image #2]`, [a], d); // one picture covers the first placeholder only
  assert.deepEqual(r.chips, [2]);
  assert.ok(!/Image #/.test(r.text));
  // a picture saved by an older version (outside data/inbox/img) is a small chip, not lost silently
  r = I.bubbleParts(`그림`, ["/home/u/.herdr-inbox/po/img/old.png"], d);
  assert.deepEqual(r.imgs, []);
  assert.equal(r.chips.length, 1);
  assert.equal(r.text, "그림");
});

test("fitImg keeps proportions, never enlarges, and has a size for an unknown picture", () => {
  assert.deepEqual(I.fitImg(100, 50), { w: 100, h: 50 });
  const big = I.fitImg(1920, 1080);
  assert.ok(big.w <= 240 && big.h <= 200);
  assert.ok(Math.abs(big.w / big.h - 1920 / 1080) < 0.03);
  const tall = I.fitImg(100, 2000);
  assert.ok(tall.h <= 200 && tall.w >= 24);
  const unk = I.fitImg(0, 0);
  assert.ok(unk.w > 0 && unk.h > 0);
});

test("bubbleWidth: hugs a short Korean line, grows with a long one, has a minimum", () => {
  const short = I.bubbleWidth("확인");
  const mid = I.bubbleWidth("이 내용은 한 줄로 쓴 조금 긴 한국어 문장입니다");
  const long = I.bubbleWidth("가".repeat(80));
  assert.ok(short >= 64);
  assert.ok(short < 120, `short ${short}`); // not a 3-character sliver, not wide either
  assert.ok(mid > short && long > mid);
  assert.ok(I.bubbleWidth("확인", 100) === 100);
  assert.equal(I.bubbleWidth(""), 64);
  // the widest line decides
  assert.equal(I.bubbleWidth("가\n" + "가".repeat(10)), I.bubbleWidth("가".repeat(10)));
  // 3 Korean characters never fit in less than their own width
  assert.ok(I.bubbleWidth("가나다", 0) >= 3 * 13.5);
  // Latin is narrower than Korean for the same count
  assert.ok(I.bubbleWidth("a".repeat(20)) < I.bubbleWidth("가".repeat(20)));
});

test("pinCall: no re-pin call unless the content grew and the view is not at its end, so a row taller than the viewport cannot flip it (#54)", () => {
  assert.equal(I.pinCall({ y: 8600, vh: 400, ch: 9000 }, 0), false); // at the end
  assert.equal(I.pinCall({ y: 8599.5, vh: 400, ch: 9000 }, 0), false); // within the 1px of atBottom
  assert.equal(I.pinCall({ y: 8000, vh: 400, ch: 9000 }, 9000), false); // not at the end, but nothing grew since the last call
  assert.equal(I.pinCall({ y: 8000, vh: 400, ch: 9000 }, 8000), true); // grew, not at the end yet
  assert.equal(I.pinCall({ y: 8000, vh: 400, ch: 9000 }, 8999.5), false); // within the 1px of "same height"
  assert.equal(I.pinCall(null, 0), false); // no numbers (before the first frame): nothing to do
  // A fake handle with scroll_to_item's "smallest scroll" rule on ONE row that is taller than the viewport (top above the view -> its top,
  // else bottom below the view -> its bottom): each unguarded call flips the view between the row's top and its bottom.
  const VH = 400, ROW_TOP = 500, ROW_H = 9000, CH = ROW_TOP + ROW_H;
  const mk = (y) => ({ y, calls: 0, seen: 0, toItem() { this.calls++; if (ROW_TOP < this.y) this.y = ROW_TOP; else if (ROW_TOP + ROW_H > this.y + VH) this.y = CH - VH; } });
  // pinGo's logic: look, remember the height, call only when pinCall says so
  const look = (h, ch) => { const go = I.pinCall({ y: h.y, vh: VH, ch }, h.seen); h.seen = ch; if (go) h.toItem(); };
  const draws = (h, guarded) => { // each draw makes the two catch-up calls (60ms, 220ms)
    const tops = [];
    for (let d = 0; d < 6; d++) for (let c = 0; c < 2; c++) { if (guarded) look(h, CH); else h.toItem(); tops.push(h.y); }
    return tops;
  };
  const a = mk(CH - VH); const unguarded = draws(a, false);
  assert.ok(new Set(unguarded).size > 1 && a.calls === 12, "unguarded calls flip the view"); // the old behaviour
  const b = mk(CH - VH); b.seen = CH; const guarded = draws(b, true);
  assert.equal(new Set(guarded).size, 1); // stays where it was
  assert.equal(b.calls, 0);
  // 1-40px above the end (inside PIN_SLACK, not atBottom), nothing grew: no call at all (review R1 P2)
  const n = mk(CH - VH - 20); n.seen = CH; const near = draws(n, true);
  assert.equal(n.calls, 0);
  assert.equal(new Set(near).size, 1);
  // the same spot but the content grew (a new row): still follows, once, and stops at the end
  const g = mk(CH - VH - 20); g.seen = CH - 300; // the new last row is 300px high, below the old end: its bottom is the end
  g.toItem = function () { this.calls++; if (CH - 300 + 300 > this.y + VH) this.y = CH - VH; };
  const tops = draws(g, true);
  assert.equal(tops[tops.length - 1], CH - VH);
  assert.equal(g.calls, 1);
  // not at the end (the bubble just grew a lot): the calls still catch up, and stop once the end is reached
  const c = mk(300);
  const tops2 = draws(c, true);
  assert.equal(tops2[tops2.length - 1], CH - VH);
  assert.ok(c.calls <= 1, `calls ${c.calls}`);
});

test("main.js (#54): the draw-time re-pin goes through pinGo/pinCall, and 더 보기 lets go of the bottom pin", () => {
  assert.match(MAIN, /pinGo\(last, "draw"\)/);
  assert.match(MAIN, /pinGo\(last, "follow"\)/);
  assert.match(MAIN, /pinCall\(m, this\.pinCh\)/);
  assert.match(MAIN, /if \(this\.reading\) \{/); // the poll right after a 더 보기 click does not restore the pin from the old layout...
  assert.match(MAIN, /Math\.abs\(ct\.height - this\.reading\.ch\) <= 1/); // ...until the new layout has landed (a different content height)
  assert.match(MAIN, /this\.reading = \{ ch:/);
  // no bare scroll_to_item(last) left in a timer
  assert.equal(/cx\.timer\.after\([^\n]*scroll_to_item/.test(MAIN), false);
  const more = MAIN.slice(MAIN.indexOf("moreToggle(t, id, lc, open) {"));
  assert.match(more.slice(0, 900), /this\.pin = \{ pinned: false/);
});

test("pinStep: re-pin when pinned and content grew; keep the place when the user scrolled up", () => {
  let st = { pinned: true, ct: 1000 };
  // grew while at the bottom -> go
  let r = I.pinStep(st, { y: 600, vh: 400, ch: 1100 }); // was exactly at the bottom of 1000, now 100 short
  assert.equal(r.pinned, true);
  assert.equal(r.go, true);
  // already at the new bottom -> nothing to do
  r = I.pinStep({ pinned: true, ct: 1000 }, { y: 700, vh: 400, ch: 1100 });
  assert.equal(r.pinned, true);
  assert.equal(r.go, false);
  // within the slack counts as the bottom
  r = I.pinStep({ pinned: true, ct: 1000 }, { y: 670, vh: 400, ch: 1100 });
  assert.equal(r.pinned, true);
  // the user scrolled up (content unchanged, far from the bottom) -> unpinned, no jump
  r = I.pinStep({ pinned: true, ct: 1000 }, { y: 100, vh: 400, ch: 1000 });
  assert.deepEqual(r, { pinned: false, ct: 1000, vh: 400, go: false });
  // unpinned and content grew (a late image) -> still keeps the place
  r = I.pinStep({ pinned: false, ct: 1000 }, { y: 100, vh: 400, ch: 1200 });
  assert.equal(r.go, false);
  assert.equal(r.pinned, false);
  // scrolling back to the bottom pins again
  r = I.pinStep({ pinned: false, ct: 1000 }, { y: 600, vh: 400, ch: 1000 });
  assert.equal(r.pinned, true);
  // a first look (no state) at a short list does nothing
  r = I.pinStep(null, { y: 0, vh: 400, ch: 300 });
  assert.equal(r.go, false);
  assert.equal(I.PIN_SLACK, 40);
});

test("quietNow: a settled selection or a pointer press holds background redraws, and lets go after a while", () => {
  const now = 1_000_000;
  assert.equal(I.quietNow(null, now), false);
  assert.equal(I.quietNow({}, now), false);
  assert.equal(I.quietNow({ sel: true, selAt: now - 1000 }, now), true);
  assert.equal(I.quietNow({ sel: true, selAt: now - 10 * 60000 }, now), false);
  assert.equal(I.quietNow({ press: true, pressAt: now - 500 }, now), true);
  assert.equal(I.quietNow({ press: true, pressAt: now - 60000 }, now), false);
  assert.equal(I.quietNow({ sel: false, press: false, selAt: now, pressAt: now }, now), false);
});

test("parsePoLines: an img line goes to the 'me' line with the same prompt id, else the latest one just before it", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const iso = (s) => new Date(t0 + s * 1000).toISOString();
  const L = (o) => JSON.stringify(o);
  const a = "/d/data/inbox/img/a.png", b = "/d/data/inbox/img/b.png";
  const text = [
    L({ ts: iso(0), kind: "me", text: "[Image #1] 첫째", pid: "p1" }),
    L({ ts: iso(5), kind: "me", text: "[Image #2] 둘째", pid: "p2" }),
    L({ ts: iso(9), kind: "img", pid: "p1", imgs: [a] }),
    L({ ts: iso(10), kind: "img", pid: "", imgs: [b, 5, ""] }),
    "not json",
  ].join("\n");
  const out = I.parsePoLines(text);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].imgs, [a]);
  assert.deepEqual(out[1].imgs, [b]);
  assert.deepEqual(out.map((x) => x.pid), ["p1", "p2"]); // the prompt id stays on the line (the 1:1 view pairs a reply with its prompt, #58); a line without one has no pid
  assert.ok(!("pid" in I.parsePoLines(L({ ts: iso(0), kind: "say", text: "x" }))[0]));
  // an img line with nothing to attach to is dropped silently
  assert.deepEqual(I.parsePoLines(L({ ts: iso(0), kind: "img", pid: "zz", imgs: [a] })), []);
  // too old to belong to the prompt without an id
  const old = [L({ ts: iso(0), kind: "me", text: "x", pid: "p1" }), L({ ts: iso(600), kind: "img", imgs: [a] })].join("\n");
  assert.equal(I.parsePoLines(old)[0].imgs, undefined);
});

test("sniffExt / imgSize read the type and size from the first bytes", () => {
  assert.equal(I.sniffExt(png()), ".png");
  assert.deepEqual(I.imgSize(png(123, 45)), [123, 45]);
  assert.equal(I.sniffExt(Buffer.from("hello world, not a picture")), "");
  assert.equal(I.imgSize(Buffer.alloc(30)), null);
  const gif = Buffer.alloc(30);
  gif.write("GIF89a", 0, "latin1");
  gif.writeUInt16LE(64, 6);
  gif.writeUInt16LE(32, 8);
  assert.equal(I.sniffExt(gif), ".gif");
  assert.deepEqual(I.imgSize(gif), [64, 32]);
});

test("saveImage: 0600 file in a 0700 folder under <root>/data/inbox/img, same bytes -> same file, not a picture / too big -> null", () => {
  const d = tmp();
  try {
    const p = I.saveImage(png(10, 10), d, Date.now());
    assert.ok(p && I.imgOk(d, p), p);
    if (POSIX) assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    if (POSIX) assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
    assert.equal(I.saveImage(png(10, 10), d, Date.now()), p);
    assert.notEqual(I.saveImage(png(10, 10, 1), d, Date.now()), p);
    assert.equal(I.saveImage(Buffer.from("plain text, not an image at all"), d), null);
    const big = png(10, 10, I.MAX_IMG_BYTES);
    assert.equal(I.saveImage(big, d), null);
    assert.equal(fs.readdirSync(path.dirname(p)).length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("importImage: copies a picked picture into the folder; a text file, a missing file or an oversize file is refused", () => {
  const d = tmp();
  try {
    const src = path.join(d, "x.png");
    fs.writeFileSync(src, png(8, 8));
    const p = I.importImage(src, d);
    assert.ok(p && I.imgOk(d, p));
    fs.writeFileSync(path.join(d, "n.png"), "not a picture at all, just text");
    assert.equal(I.importImage(path.join(d, "n.png"), d), null);
    assert.equal(I.importImage(path.join(d, "none.png"), d), null);
    assert.equal(I.importImage(path.join(d, "x.txt"), d), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// a transcript line of a user turn with images
const tline = (o) => JSON.stringify(o) + "\n";
const userTurn = (promptId, text, imgs) => tline({ type: "user", promptId, message: { role: "user", content: [...imgs.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b.toString("base64") } })), { type: "text", text }] } });

test("transcriptImages: the images of the prompt with this id (else of the text), saved as 0600 files; the cap is kept", () => {
  const d = tmp();
  try {
    const tr = path.join(d, "t.jsonl");
    fs.writeFileSync(tr, userTurn("p1", "첫 질문", [png(5, 5, 1)]) + tline({ type: "assistant", message: { content: [{ type: "text", text: "네" }] } }) + userTurn("p2", "이거 봐줘", [png(6, 6, 2), png(7, 7, 3)]) + "garbage line\n");
    const r = I.transcriptImages(tr, "p2", "이거 봐줘", d, Date.now());
    assert.equal(r.length, 2);
    for (const p of r) { assert.ok(I.imgOk(d, p)); if (POSIX) assert.equal(fs.statSync(p).mode & 0o777, 0o600); }
    const r1 = I.transcriptImages(tr, "p1", "", d, Date.now());
    assert.equal(r1.length, 1);
    assert.deepEqual(I.transcriptImages(tr, "nope", "", d), []); // no id and no text -> nothing guessed
    assert.equal(I.transcriptImages(tr, "", "이거 봐줘", d).length, 2); // by text when there is no id
    assert.deepEqual(I.transcriptImages(path.join(d, "missing.jsonl"), "p1", "", d), []);
    // more than the cap -> only MAX_IMGS
    const five = Array.from({ length: 6 }, (_, i) => png(4, 4, 10 + i));
    fs.writeFileSync(tr, userTurn("p9", "많다", five));
    assert.equal(I.transcriptImages(tr, "p9", "많다", d).length, I.MAX_IMGS);
    // an image that is not a picture is skipped
    fs.writeFileSync(tr, userTurn("p8", "가짜", [Buffer.from("this is certainly not an image file")]));
    assert.deepEqual(I.transcriptImages(tr, "p8", "가짜", d), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("pendingImagePids: prompts with a placeholder and no img line yet", () => {
  const d = tmp();
  try {
    const f = path.join(d, "pa.jsonl");
    const L = (o) => JSON.stringify(o) + "\n";
    fs.writeFileSync(f, L({ ts: "2026-01-01T00:00:00Z", kind: "me", text: "[Image #1] a", pid: "p1" }) + L({ ts: "2026-01-01T00:00:01Z", kind: "me", text: "[Image #2] b", pid: "p2" }) + L({ ts: "2026-01-01T00:00:02Z", kind: "me", text: "no picture", pid: "p3" }) + L({ ts: "2026-01-01T00:00:03Z", kind: "img", pid: "p1", imgs: ["/x"] }));
    assert.deepEqual(I.pendingImagePids(f), [{ pid: "p2", text: "[Image #2] b" }]);
    assert.deepEqual(I.pendingImagePids(path.join(d, "none.jsonl")), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("fillImages: appends an img line (0600 file) for a pending prompt, returns how many are still without", () => {
  const d = tmp();
  const prev = process.env.HERDR_INBOX_DIR;
  const prevApp = process.env.HERDR_APP_HOME;
  process.env.HERDR_INBOX_DIR = d;
  process.env.HERDR_APP_HOME = d;
  try {
    fs.mkdirSync(path.join(d, "po"), { recursive: true });
    const f = path.join(d, "po", "pa.jsonl");
    const tr = path.join(d, "t.jsonl");
    fs.writeFileSync(f, JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", kind: "me", text: "[Image #4] 이거 봐줘", pid: "p1" }) + "\n");
    fs.writeFileSync(tr, "");
    assert.equal(HOOK.fillImages(f, tr, I, Date.UTC(2026, 0, 1)), 1); // the transcript has no such turn yet
    fs.writeFileSync(tr, userTurn("p1", "이거 봐줘", [png(9, 9, 77)]));
    assert.equal(HOOK.fillImages(f, tr, I, Date.UTC(2026, 0, 1, 0, 0, 5)), 0);
    const lines = fs.readFileSync(f, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    const img = lines.find((x) => x.kind === "img");
    assert.ok(img && img.pid === "p1" && img.imgs.length === 1 && I.imgOk(d, img.imgs[0]));
    assert.equal(HOOK.fillImages(f, tr, I, Date.UTC(2026, 0, 1, 0, 0, 6)), 0); // nothing pending any more, nothing appended twice
    assert.equal(fs.readFileSync(f, "utf8").trim().split("\n").length, 2);
    // and the desk reads it back onto the bubble
    const out = I.parsePoLines(fs.readFileSync(f, "utf8"));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].imgs, img.imgs);
  } finally { if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; if (prevApp === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = prevApp; fs.rmSync(d, { recursive: true, force: true }); }
});

test("hook run: a prompt with '[Image #N]' spawns the image worker; one without does not; Stop reads the transcript once", () => {
  const d = tmp();
  const prev = process.env.HERDR_INBOX_DIR;
  const prevApp = process.env.HERDR_APP_HOME;
  process.env.HERDR_INBOX_DIR = d;
  process.env.HERDR_APP_HOME = d;
  try {
    const term = { labels: { role: "po", po: "pa" }, name: "po-a" };
    const spawned = [];
    const env = { HC_TERMINAL_ID: "t5" };
    const tr = path.join(d, "t.jsonl");
    fs.writeFileSync(tr, userTurn("p1", "그림 봐줘", [png(12, 12, 5)]));
    const base = { transcript_path: tr, prompt_id: "p1" };
    let r = HOOK.run(env, { ...base, hook_event_name: "UserPromptSubmit", prompt: "[Image #1] 그림 봐줘" }, I, () => term, Date.UTC(2026, 0, 1), (...a) => spawned.push(a));
    assert.ok(r);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][0], r.file);
    assert.equal(spawned[0][1], tr);
    r = HOOK.run(env, { ...base, prompt_id: "p2", hook_event_name: "UserPromptSubmit", prompt: "그림 없음" }, I, () => term, Date.UTC(2026, 0, 1, 0, 1), (...a) => spawned.push(a));
    assert.ok(r);
    assert.equal(spawned.length, 1);
    // Stop: the pending prompt gets its picture right away
    HOOK.run(env, { ...base, hook_event_name: "Stop", last_assistant_message: "봤어요" }, I, () => term, Date.UTC(2026, 0, 1, 0, 2), (...a) => spawned.push(a));
    const lines = fs.readFileSync(r.file, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.ok(lines.some((x) => x.kind === "img" && x.pid === "p1" && x.imgs.length === 1));
    assert.equal(spawned.length, 1);
    if (POSIX) assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  } finally { if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; if (prevApp === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = prevApp; fs.rmSync(d, { recursive: true, force: true }); }
});

test("chat block of main.js is identical to inbox.cjs (the pure picture / pin / bubble code included)", () => {
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  const cut = (s) => s.slice(s.indexOf("// chat:begin"), s.indexOf("// chat:end"));
  assert.equal(cut(MAIN), cut(CJS));
  assert.ok(/function bubbleWidth/.test(cut(MAIN)) && /function pinStep/.test(cut(MAIN)) && /const quietNow/.test(cut(MAIN)));
});

test("main.js: the right bubble is sized by bubbleWidth in a full-width row; rows are not overlapped", () => {
  assert.match(MAIN, /h_flex\(\)\.w_full\(\)/);
  assert.match(MAIN, /\.w\(width\)\.max_w\(cap \?\? "75%"\)/);
  assert.match(MAIN, /bubbleWidth\(/);
  assert.match(MAIN, /bubbleParts\(/);
});

test("main.js: image paste, attach button, drop and the pending-image chips are wired", () => {
  assert.match(MAIN, /on\("paste_other"/);
  assert.match(MAIN, /pickFiles/);
  assert.match(MAIN, /on_drop/);
  assert.match(MAIN, /addimg/);
  assert.match(MAIN, /clipimg/);
  assert.match(MAIN, /imgLine/);
});

test("main.js: scroll pin runs on a timer and after each draw", () => {
  assert.match(MAIN, /PIN_TICK_MS/);
  assert.match(MAIN, /pinStep\(/);
  assert.match(MAIN, /scroll_to_item\(/);
  assert.match(MAIN, /track_scroll\(/);
});

test("main.js: selection survives background redraws (quiet gate, unchanged data does not notify)", () => {
  assert.match(MAIN, /on_selection_change\(/);
  assert.match(MAIN, /quietNow\(/);
  assert.match(MAIN, /LOAD_REDRAW_MS/);
  assert.match(MAIN, /selectable\(true\)/);
  assert.match(MAIN, /on_mouse_down\(/);
  assert.match(MAIN, /on_mouse_up\(/);
});

test("the pure chat block never reaches for Node modules (a mod cannot require them)", () => {
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  const blk = CJS.slice(CJS.indexOf("// chat:begin"), CJS.indexOf("// chat:end"));
  assert.ok(!/require\(/.test(blk));
});

test("main.js: the picture is drawn from the app-root-relative path as a small thumbnail that opens full on click", () => {
  assert.match(MAIN, /image\(imgRel\(root, /);
  assert.match(MAIN, /fitImg\([^)]*240, 180\)/);
  assert.match(MAIN, /openFile\(/);
});

test("main.js: the pending-question card scrolls inside a max height; the pointer is tracked at the window; selection events are logged", () => {
  assert.match(MAIN, /PROMPT_MAX_H/);
  assert.match(MAIN, /id\("po-prompt-lines"\)[^\n]*overflow_y_scrollbar\(\)/);
  assert.match(MAIN, /\.on_window_mouse_move\(/);
  assert.match(MAIN, /\.on_window_mouse_up\("left"/);
  assert.match(MAIN, /console\.log\(`\[inbox\] selection/);
});

test("main.js: spacing between chat rows (same sender 8, new sender 18) and bubble padding 12x9", () => {
  assert.match(MAIN, /const top = e\.head \? 18 : 8/);
  assert.ok((MAIN.match(/px\(12\)\.py\(9\)\.gap\(6\)\.rounded\(12\)/g) || []).length >= 2);
});

// diag.log: a small capped 0600 file of selection/pointer events for the leader (ids and lengths only).
test("diagAppend: 0600 file, one line each, cut long lines, rotates past the cap", () => {
  const root = tmp();
  const f = I.diagAppend(["a one", "b\ntwo", "x".repeat(1000)], root);
  assert.equal(f, path.join(root, "data", "inbox", "diag.log"));
  if (POSIX) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const lines = fs.readFileSync(f, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "b two");
  assert.ok(lines[2].length <= 300);
  fs.writeFileSync(f, "y".repeat(I.DIAG_MAX + 10), { mode: 0o600 });
  I.diagAppend(["fresh"], root);
  assert.equal(fs.readFileSync(f, "utf8"), "fresh\n");
  assert.equal(fs.statSync(f + ".1").size, I.DIAG_MAX + 10);
});

test("diag CLI appends to <HERDR_APP_HOME>/data/inbox/diag.log", () => {
  const root = tmp();
  const { execFileSync } = require("node:child_process");
  execFileSync("node", [path.join(__dirname, "../mods/inbox/inbox.cjs"), "diag", JSON.stringify(["hello"])], { env: { ...process.env, HERDR_APP_HOME: root } });
  assert.equal(fs.readFileSync(path.join(root, "data", "inbox", "diag.log"), "utf8"), "hello\n");
});

test("main.js logs selection, press/release and the per-draw TextView count to diag, never text content", () => {
  assert.match(MAIN, /`selection settled in \$\{did\} id=/);
  assert.match(MAIN, /`selection cleared in \$\{did\} id=/);
  assert.match(MAIN, /this\.diag\("press /);
  assert.match(MAIN, /this\.diag\("release /);
  assert.match(MAIN, /selectable TextView\(s\)/);
  assert.match(MAIN, /settled in \$\{did\}: \$\{String\(sel\.text \?\? ""\)\.length\} chars/); // the length only
});

test("saveImage never writes through a link, and the picture folder is capped (oldest go first)", () => {
  const root = tmp();
  const b = png(30, 20, 10);
  const f = I.saveImage(b, root);
  fs.unlinkSync(f);
  const victim = path.join(root, "victim.txt");
  fs.writeFileSync(victim, "keep");
  fs.symlinkSync(victim, f);
  const g = I.saveImage(b, root);
  assert.equal(g, f);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.ok(fs.lstatSync(f).isFile());
  // total cap: three 40-byte pictures, cap 130 with the saved 43-byte one -> only the oldest is pruned
  const dir = I.imgDir(root);
  const mk = (n, at) => { const p = path.join(dir, `${n.repeat(16)}.png`); fs.writeFileSync(p, Buffer.alloc(40)); fs.utimesSync(p, new Date(at), new Date(at)); return p; };
  const now = Date.now();
  const a = mk("a", now - 3000), c = mk("c", now - 2000), d = mk("d", now - 1000);
  I.pruneImages(dir, now, 130);
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(c) && fs.existsSync(d));
});

test("diag never logs a view id (a timeline id holds the message text): kind + hash only", () => {
  assert.match(MAIN, /diagId\(id\)/);
  assert.doesNotMatch(MAIN, /settled in \$\{id\}|cleared in \$\{id\}/);
});

test("#54 re-fix: a view reading higher up is never dragged by growth; the end sentinel is the last child and the target of every go", () => {
  // (a) an expanded tall bubble: the view sits ~4000px above the bottom and a new bubble arrives (content grows): no go, however often it grows
  let st = { pinned: false, ct: 17130 }; // 더 보기 released the pin
  for (const ch of [17508, 17567, 17700, 18000]) { const r = I.pinStep(st, { y: 11411, vh: 2127, ch }); assert.equal(r.go, false); assert.equal(r.pinned, false); st = { pinned: r.pinned, ct: r.ct }; }
  // even a pin that is still "engaged" (a stale true) does not go when the view was far from the end of what it showed
  const stale = I.pinStep({ pinned: true, ct: 17130 }, { y: 11157, vh: 2003, ch: 17508 }); // 3970px above the old end
  assert.deepEqual(stale, { pinned: false, ct: 17508, vh: 2003, go: false });
  // (c) at the true bottom + growth: go (and keep following a stream of growth while each go lands)
  let at = I.pinStep({ pinned: true, ct: 17130 }, { y: 17130 - 2127, vh: 2127, ch: 17508 });
  assert.equal(at.go, true);
  at = I.pinStep({ pinned: at.pinned, ct: at.ct }, { y: 17508 - 2127, vh: 2127, ch: 17900 }); // the first go landed at 17508, more came
  assert.equal(at.go, true);
  // (b) the person's own send follows once, from wherever they read, only for the first draw with a new last entry, and only shortly after the send
  const k1 = I.tlKey("r~all", [{ ms: 1, key: "a" }]), k2 = I.tlKey("r~all", [{ ms: 1, key: "a" }, { ms: 2, key: "b" }]);
  assert.equal(I.sendFollow(1000, 2000, k2, k1), true);
  assert.equal(I.sendFollow(1000, 2000, k1, k1), false); // nothing new drawn
  assert.equal(I.sendFollow(0, 2000, k2, k1), false); // no send
  assert.equal(I.sendFollow(1000, 1000 + I.SEND_FOLLOW_MS + 1, k2, k1), false); // too late: someone else's bubble
  assert.equal(I.tlFollow(k1, k2, false), false); // a bubble of someone else, reading higher up: no follow
  assert.equal(I.tlFollow(k1, k2, true), true); // at the end: follows
  // (d) wiring: the sentinel is pushed after the typing rows, lastIdx points at it, every go targets it, own send arms sendFollow once
  const iTyping = MAIN.indexOf("for (const x of this.typing(v)) blocks.push(this.typingRow(t, x));");
  const iEnd = MAIN.indexOf('blocks.push(div().id("inbox-end").flex_none().h(8));');
  const iLast = MAIN.indexOf("this.lastIdx = Math.max(0, blocks.length - 1);");
  assert.ok(iTyping > 0 && iEnd > iTyping && iLast > iEnd, "sentinel after the typing rows, before lastIdx");
  assert.equal(/\.pb\(8\)\.overflow_y_scrollbar\(\)/.test(MAIN), false); // the 8px moved into the sentinel
  assert.match(MAIN, /const last = blocks\.length - 1; \/\/ the end sentinel/);
  assert.match(MAIN, /scroll_to_item\(this\.lastIdx\)/);
  assert.equal((MAIN.match(/scroll_to_item\(/g) ?? []).length, 7); // 2 doc comments, pinTick, pinGo, follow, reveal(), jumpToEnd(): none aimed at a bubble
  assert.match(MAIN, /this\.sentAt2 = Date\.now\(\);/);
  assert.match(MAIN, /if \(mine\) \{ this\.sentAt2 = 0;/); // once
});

// ---- #67: the input box grows -> the list viewport shrinks; #72: jump-to-newest button
test("#67 pinStep: a viewport shrink while pinned at the bottom goes to the end; reading above or unpinned does not", () => {
  // pinned at the bottom (y 600 + vh 400 = ch 1000); the input box grew, the viewport is now 300 tall: the end is cut off -> go
  let r = I.pinStep({ pinned: true, ct: 1000, vh: 400 }, { y: 600, vh: 300, ch: 1000 });
  assert.equal(r.pinned, true);
  assert.equal(r.go, true);
  assert.equal(r.vh, 300);
  // same size: no go, and the viewport is remembered for the next look
  r = I.pinStep({ pinned: true, ct: 1000, vh: 400 }, { y: 600, vh: 400, ch: 1000 });
  assert.equal(r.go, false);
  assert.equal(r.vh, 400);
  // the viewport grew back (box emptied after a send): sitting at the bottom needs no go
  r = I.pinStep({ pinned: true, ct: 1000, vh: 300 }, { y: 700, vh: 400, ch: 1000 });
  assert.equal(r.go, false);
  assert.equal(r.pinned, true);
  // reading higher up (far from the bottom): a shrink never drags the view
  r = I.pinStep({ pinned: true, ct: 1000, vh: 400 }, { y: 100, vh: 300, ch: 1000 });
  assert.equal(r.go, false);
  assert.equal(r.pinned, false);
  // already unpinned: a shrink does nothing
  r = I.pinStep({ pinned: false, ct: 1000, vh: 400 }, { y: 100, vh: 300, ch: 1000 });
  assert.equal(r.go, false);
  assert.equal(r.pinned, false);
  // the old state without vh (first look) behaves as before
  r = I.pinStep({ pinned: true, ct: 1000 }, { y: 600, vh: 400, ch: 1000 });
  assert.equal(r.go, false);
});

test("#72 jumpShown: only when scrolled away from the bottom (beyond JUMP_MIN), never when the content fits", () => {
  assert.equal(I.JUMP_MIN, 80);
  assert.equal(I.jumpShown(600, 400, 1000), false); // at the bottom
  assert.equal(I.jumpShown(540, 400, 1000), false); // 60px above: still counts as the bottom (< JUMP_MIN)
  assert.equal(I.jumpShown(500, 400, 1000), true); // 100px above
  assert.equal(I.jumpShown(0, 400, 5000), true); // at the top of a long list
  assert.equal(I.jumpShown(0, 400, 300), false); // the content fits: nothing to jump to
  assert.equal(I.jumpShown(0, 400, 400), false);
  assert.equal(I.jumpShown(undefined, undefined, undefined), false);
  assert.equal(I.jumpShown(NaN, 400, 1000), true); // an unreadable offset reads as the top
});

test("#67/#72 wiring: the box has a max height (scrolls inside), the list sits in a relative box with the corner button, the jump re-enables follow", () => {
  assert.ok(I.INPUT_MAX_LINES >= 2 && I.INPUT_MAX_LINES <= 5);
  assert.match(MAIN, /this\.chat\.set_auto_grow\(1, INPUT_MAX_LINES\)/);
  // the button is an overlay in the list's own corner (inside the list box, not the chat box), so it cannot cover the input
  assert.match(MAIN, /const listBox = v_flex\(\)\.id\("inbox-listbox"\)\.relative\(\)\.flex_1\(\)\.min_h\(0\)\.child\(lines\)\.when\(Boolean\(jump\), \(el\) => el\.child\(jump\)\)/);
  assert.match(MAIN, /h_flex\(\)\.id\("inbox-jump"\)\.absolute\(\)\.bottom\(12\)\.right\(18\)/);
  assert.match(MAIN, /\.on_click\(\(_e, c\) => this\.jumpToEnd\(c\)\)/);
  // shown only from the pinTick reading of the scroll position, and redrawn only on a change
  assert.match(MAIN, /this\.syncJump\(cx, jumpShown\(o\.y, vp\.height, ct\.height\)\)/);
  const sync = MAIN.slice(MAIN.indexOf("  syncJump("), MAIN.indexOf("  jumpToEnd("));
  assert.match(sync, /if \(on === Boolean\(this\.jump\)\) return;/);
  // the jump drops the 더 보기 hold, re-pins, and goes to the end sentinel (lastIdx)
  const jump = MAIN.slice(MAIN.indexOf("  jumpToEnd("), MAIN.indexOf("  jumpToEnd(") + 900);
  assert.match(jump, /this\.reading = null;/);
  assert.match(jump, /this\.pin = \{ pinned: true,/);
  assert.match(jump, /this\.jump = false;/);
  assert.match(jump, /scroll_to_item\(this\.lastIdx\)/);
});

test("#66/#67/#72 shared pure helpers are identical in main.js and inbox.cjs", () => {
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  const line = (src, re) => (src.match(re) ?? [])[0];
  for (const re of [/^const JUMP_MIN = .*$/m, /^const jumpShown = .*$/m, /^const INPUT_MAX_LINES = .*$/m]) {
    const a = line(MAIN, re), b = line(CJS, re);
    assert.ok(a, `main.js has ${re}`);
    assert.equal(a, b);
  }
});
