// Tests of the picture, bubble-size, scroll-pin and selection rules (PO desk, #36/#37). The visual results (how wide a bubble really draws,
// whether a drag-select survives in the real app, whether image() takes an absolute path) cannot be tested here; these cover the rules
// behind them and the shape of the code that uses them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");
const HOOK = require("../mods/inbox/po-hook.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
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
  assert.deepEqual(r, { pinned: false, ct: 1000, go: false });
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
  assert.ok(out.every((x) => !("pid" in x)));
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
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
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
    for (const p of r) { assert.ok(I.imgOk(d, p)); assert.equal(fs.statSync(p).mode & 0o777, 0o600); }
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
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  } finally { if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; if (prevApp === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = prevApp; fs.rmSync(d, { recursive: true, force: true }); }
});

test("chat block of main.js is identical to inbox.cjs (the pure picture / pin / bubble code included)", () => {
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  const cut = (s) => s.slice(s.indexOf("// chat:begin"), s.indexOf("// chat:end"));
  assert.equal(cut(MAIN), cut(CJS));
  assert.ok(/function bubbleWidth/.test(cut(MAIN)) && /function pinStep/.test(cut(MAIN)) && /const quietNow/.test(cut(MAIN)));
});

test("main.js: the right bubble is sized by bubbleWidth in a full-width row; rows are not overlapped", () => {
  assert.match(MAIN, /h_flex\(\)\.w_full\(\)/);
  assert.match(MAIN, /\.w\(width\)\.max_w\("80%"\)/);
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
  const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
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
