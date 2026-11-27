// #138: the unsent chat draft survives a re-init of the mod, and the box gets the keyboard back only when it had it right before.
// The file helpers of inbox.cjs run against a throwaway app home; the Desk methods of main.js (draftDirty, draftTick, saveDraft, loadDraft, applyDraft,
// wipe, syncRoom) run for real against a fake box, a fake clock and the real `inbox.cjs draft-read / draft-write` command (as the mod calls it).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const I = require("../mods/inbox/inbox.cjs");

const HELPER_PATH = path.join(__dirname, "../mods/inbox/inbox.cjs");
const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const grab = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "draft138-"));

// ---- the file helpers
test("chatDraftSnap: 빈 글은 빼고, 방마다·전체 글자 수에 상한이 있고, 먼저 온 방이 이긴다", () => {
  const s = I.chatDraftSnap(new Map([["A", { text: "가나다", range: { start: 1, end: 2 } }], ["B", { text: "" }], ["C", { text: "c", range: { start: -1, end: 0 } }]]), true, 5);
  assert.deepEqual(s, { v: 1, at: 5, focus: true, rooms: { A: { text: "가나다", range: { start: 1, end: 2 } }, C: { text: "c", range: null } } });
  const big = I.chatDraftSnap([["A", { text: "x".repeat(50000) }], ["B", { text: "y".repeat(15000) }], ["C", { text: "z".repeat(5000) }]], false, 1);
  assert.equal(big.rooms.A.text.length, 6000);
  assert.equal(big.rooms.B.text.length, 6000);
  assert.equal(big.rooms.C.text.length, 5000);
  const four = I.chatDraftSnap([["A", { text: "x".repeat(9000) }], ["B", { text: "y".repeat(9000) }], ["C", { text: "z".repeat(9000) }], ["D", { text: "w".repeat(9000) }]], false, 1);
  assert.deepEqual(Object.keys(four.rooms), ["A", "B", "C"]); // 3 x 6000 fits in 20000, a fourth room does not: the first rooms win
});
test("chatDraftWrite / chatDraftRead: 쓰고 읽고, 글도 포커스도 없으면 파일을 지운다, 파일은 0600", () => {
  const root = tmpRoot();
  assert.equal(I.chatDraftRead(root, 1000), null); // cold start: nothing
  assert.equal(I.chatDraftWrite(I.chatDraftSnap([["A", { text: "초안", range: { start: 1, end: 1 } }]], false, 1000), root), "written");
  assert.deepEqual(I.chatDraftRead(root, 2000), { rooms: { A: { text: "초안", range: { start: 1, end: 1 } } }, focus: false });
  if (process.platform !== "win32") assert.equal(fs.statSync(I.chatDraftPath(root)).mode & 0o777, 0o600);
  assert.equal(I.chatDraftPath(root), path.join(root, "data", "inbox", "chat-draft.json"));
  assert.equal(I.chatDraftWrite(I.chatDraftSnap([], false, 3000), root), "cleared");
  assert.equal(fs.existsSync(I.chatDraftPath(root)), false);
  assert.equal(I.chatDraftWrite(I.chatDraftSnap([], false, 3000), root), "none");
  assert.equal(I.chatDraftWrite(I.chatDraftSnap([], true, 3000), root), "written"); // focus alone is kept (nothing typed yet)
  assert.deepEqual(I.chatDraftRead(root, 3500), { rooms: {}, focus: true });
});
test("chatDraftRead: 포커스는 true이고 30초 안일 때만, 파일은 12시간이 지나거나 깨지면 없는 것", () => {
  const root = tmpRoot();
  I.chatDraftWrite(I.chatDraftSnap([["A", { text: "x" }]], true, 1000), root);
  assert.equal(I.chatDraftRead(root, 1000 + I.DRAFT_FOCUS_MS - 1).focus, true);
  assert.equal(I.chatDraftRead(root, 1000 + I.DRAFT_FOCUS_MS).focus, false); // stale: the text stays, the keyboard is not taken
  assert.equal(I.chatDraftRead(root, 1000 + I.DRAFT_FOCUS_MS).rooms.A.text, "x");
  assert.equal(I.chatDraftRead(root, 1000 + I.DRAFT_KEEP_MS + 1), null);
  assert.equal(I.chatDraftRead(root, 1000 - 5 * 60 * 1000), null); // a file from the future (clock jump) is not trusted
  fs.writeFileSync(I.chatDraftPath(root), "{not json");
  assert.equal(I.chatDraftRead(root, 1000), null);
  fs.writeFileSync(I.chatDraftPath(root), JSON.stringify({ v: 2, at: 1000, focus: true, rooms: {} }));
  assert.equal(I.chatDraftRead(root, 1000), null);
});
test("명령줄 draft-write / draft-read는 HERDR_APP_HOME 아래 data/inbox에 쓰고 읽는다", () => {
  const root = tmpRoot();
  const env = { ...process.env, HERDR_APP_HOME: root, HOME: root, USERPROFILE: root };
  const out = execFileSync(process.execPath, [HELPER_PATH, "draft-write", JSON.stringify({ rooms: { A: { text: "한글 초안", range: { start: 2, end: 2 } } }, focus: true })], { env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), { r: "written" });
  assert.ok(fs.existsSync(path.join(root, "data", "inbox", "chat-draft.json")));
  const back = JSON.parse(execFileSync(process.execPath, [HELPER_PATH, "draft-read"], { env, encoding: "utf8" }));
  assert.deepEqual(back, { rooms: { A: { text: "한글 초안", range: { start: 2, end: 2 } } }, focus: true });
  execFileSync(process.execPath, [HELPER_PATH, "draft-write", JSON.stringify({ rooms: {}, focus: false })], { env });
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [HELPER_PATH, "draft-read"], { env, encoding: "utf8" })), { rooms: {}, focus: false });
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [HELPER_PATH, "draft-write", "not json"], { env, encoding: "utf8" })), { r: "none" });
});

// ---- the Desk methods of main.js
const keepSrc = grab(MAIN, "  keep(key, st, value) {", "  // #66: the chat box holds");
const syncSrc = grab(MAIN, "  syncRoom(pick) {", "  wipe(key, st) {");
const wipeSrc = grab(MAIN, "  wipe(key, st) {", "  guard(key, st, value) {");
const draftSrc = grab(MAIN, "  draftDirty() {", "  // Every box is looked at once per draw");
const consts = grab(MAIN, "const DRAFT_TICK_MS", "const PIN_TICK_MS");
const DeskClass = new Function("swapDraft", "editCore", "exec", "HELPER", "Date", `${consts}
return class Desk {
  constructor(box) { this.chat = box; this.mirror = new Map(); this.roomDrafts = new Map(); this.picBusyBy = new Map(); this.picBusy = 0; this.draftRoom = null; this.pics = []; this.menu = null; this.heldAt = 0; this.lastValue = ""; this.core = ""; this.brk = null; this.log = [];
    this.chatFocus = false; this.draftDue = 0; this.draftSince = 0; this.draftSig = ""; this.draftWroteAt = 0; this.draftBusy = false; this.draftOwn = false; this.draftLoaded = false; this.draftReady = false; this.draftSaved = null; this.focusWant = 0; this.drawnAt = 0;
    box.on("focus", () => { this.chatFocus = true; this.draftDirty(); }); box.on("blur", () => { this.chatFocus = false; this.draftDirty(); }); box.on("change", () => this.draftDirty()); }
  diag(m) { this.log.push(m); }
  ${keepSrc}
  ${syncSrc}
  ${wipeSrc}
  ${draftSrc}
  type(text) { this.chat.set_value(text); this.keep("chat", this.chat, text); this.chat.fire("change"); }
  draw(pick) { this.syncRoom(pick); this.drawnAt = Date.now(); }
}`);

function setup() {
  const root = tmpRoot();
  const env = { ...process.env, HERDR_APP_HOME: root, HOME: root, USERPROFILE: root };
  const clock = { t: 1_000_000 };
  const fakeDate = { now: () => clock.t };
  // The same calls the CLI makes (`inbox.cjs draft-read / draft-write`), but in this process with the fake clock, so ages can be tested.
  const calls = [];
  const exec = (_cmd, args) => {
    calls.push(args.slice(1));
    try {
      // the pieces of a long snapshot go through the REAL command line (its own clock; the file is checked as it lies on disk)
      if (args[1] === "draft-part") return Promise.resolve({ code: 0, stdout: execFileSync(process.execPath, [HELPER_PATH, ...args.slice(1)], { env, encoding: "utf8" }) });
      if (args[1] === "draft-read") return Promise.resolve({ code: 0, stdout: JSON.stringify(I.chatDraftRead(root, clock.t) ?? { rooms: {}, focus: false }) });
      if (args[1] === "draft-write") { const j = JSON.parse(args[2]); return Promise.resolve({ code: 0, stdout: JSON.stringify({ r: I.chatDraftWrite(I.chatDraftSnap(Object.entries(j.rooms ?? {}), j.focus === true, clock.t), root) }) }); }
    } catch {}
    return Promise.resolve({ code: 1, stdout: "" });
  };
  const Desk = DeskClass(I.swapDraft, I.editCore, exec, () => HELPER_PATH, fakeDate);
  const file = path.join(root, "data", "inbox", "chat-draft.json");
  const stamp = () => {};
  return { root, clock, Desk, file, stamp, env, calls };
}
function box(text = "") {
  const h = {};
  return { v: text, r: { start: text.length, end: text.length }, focusCalls: 0, h,
    on(ev, f) { (h[ev] ??= []).push(f); }, fire(ev) { for (const f of h[ev] ?? []) f({}, {}); },
    value() { return this.v; }, content() { return { text: this.v, tokens: [] }; }, selected_range() { return this.r; }, set_selected_range(x) { this.r = x; },
    set_value(x) { this.v = typeof x === "string" ? x : x.text; this.r = { start: this.v.length, end: this.v.length }; },
    focus() { this.focusCalls++; } };
}
const flush = () => new Promise((r) => setImmediate(r));
// One 250ms tick, then wait for the helper call (it ran synchronously; its promise settles on the next turns).
async function tick(s, d, ms = 250) { s.clock.t += ms; d.draftTick(); await flush(); await flush(); s.stamp(); }
// A fresh copy of the desk (a re-init): reads the file, then draws.
async function start(s, d, room) {
  d.loadDraft();
  await flush(); await flush();
  if (room) d.draw(room);
  await tick(s, d);
}

test("재시작해도 초안이 남는다: 쓰던 글과 커서가 새 복사본의 상자로 돌아온다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("쓰다 만 글");
  a.chat.r = { start: 2, end: 2 };
  a.chat.fire("change");
  await tick(s, a, 700);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, "utf8")).rooms, { "room-a": { text: "쓰다 만 글", range: { start: 2, end: 2 } } });
  const b = new s.Desk(box()); // the re-init: a new box, nothing in it
  await start(s, b, "room-a");
  assert.equal(b.chat.v, "쓰다 만 글");
  assert.deepEqual(b.chat.r, { start: 2, end: 2 });
  assert.equal(b.mirror.get("chat").text, "쓰다 만 글"); // the guard knows it: not taken for a loss
  assert.equal(b.lastValue, "쓰다 만 글");
});
test("재시작해도 다른 방의 초안이 남는다(방을 옮기면 나온다)", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("A 글");
  a.draw("room-b");
  a.type("B 글");
  await tick(s, a, 700);
  const b = new s.Desk(box());
  await start(s, b, "room-b");
  assert.equal(b.chat.v, "B 글");
  b.draw("room-a");
  assert.equal(b.chat.v, "A 글");
});
test("복원은 첫 그리기에서 방이 정해진 뒤에 한 번만 한다(방이 정해지기 전에는 아무것도 쓰지 않는다)", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("지키는 글");
  await tick(s, a, 700);
  const before = fs.readFileSync(s.file, "utf8");
  const b = new s.Desk(box());
  b.loadDraft();
  await flush(); await flush();
  b.draftDirty();
  await tick(s, b, 5000); // never drawn: the room is unknown, the saved draft must not be replaced by the empty box
  assert.equal(fs.readFileSync(s.file, "utf8"), before);
  assert.equal(b.chat.v, "");
  b.draw("room-a");
  await tick(s, b);
  assert.equal(b.chat.v, "지키는 글");
  b.chat.v = "내가 고친 글"; // later ticks do not restore again
  await tick(s, b, 1000);
  assert.equal(b.chat.v, "내가 고친 글");
});
test("그 사이 이미 쓰기 시작한 상자는 저장된 글로 덮어쓰지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("옛 글");
  await tick(s, a, 700);
  const b = new s.Desk(box("새로 친 글"));
  await start(s, b, "room-a");
  assert.equal(b.chat.v, "새로 친 글");
});
test("보내거나 지우면 초안 파일이 사라지고, 다시 시작해도 되살아나지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("보낼 글");
  await tick(s, a, 700);
  assert.ok(fs.existsSync(s.file));
  a.wipe("chat", a.chat); // what sendChat does after the send
  assert.equal(a.draftDue, 1); // written at the very next tick, not after the 600ms of quiet
  await tick(s, a, 250);
  assert.equal(fs.existsSync(s.file), false);
  const b = new s.Desk(box());
  await start(s, b, "room-a");
  assert.equal(b.chat.v, "");
  assert.equal(b.chat.focusCalls, 0);
});
test("답칸(chat이 아닌 상자)을 비워도 채팅 초안은 건드리지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("채팅 글");
  await tick(s, a, 700);
  a.wipe("lead-1", box("답"));
  assert.equal(a.draftDue, 0);
  assert.ok(fs.existsSync(s.file));
});
test("다른 방에서 보내면 그 방 초안만 사라진다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("A 글");
  a.draw("room-b");
  a.type("B 글");
  await tick(s, a, 700);
  a.wipe("chat", a.chat);
  await tick(s, a, 250);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.file, "utf8")).rooms), ["room-a"]);
});
test("글을 쓴 적 없는 복사본(빈 상자)은 다른 복사본의 초안 파일을 지우지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.type("A 복사본의 글");
  await tick(s, a, 700);
  const c = new s.Desk(box()); // e.g. the dock next to the window
  c.loadDraft();
  await flush(); await flush();
  c.draftReady = true; c.draftLoaded = true; c.draftSaved = null; c.draftRoom = "room-z"; c.draftOwn = false; // a copy that did not restore anything
  c.draftDirty();
  await tick(s, c, 1000);
  assert.ok(fs.existsSync(s.file));
  assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).rooms["room-a"].text, "A 복사본의 글");
});

// ---- the keyboard
test("포커스: 입력칸이 포커스를 갖고 있던 직후의 재시작이면 첫 그리기 뒤 한 번만 되돌린다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  a.type("치는 중");
  await tick(s, a, 700);
  assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).focus, true);
  s.clock.t += 3000;
  const b = new s.Desk(box());
  b.loadDraft();
  await flush(); await flush();
  await tick(s, b); // not drawn yet: no keyboard grab before the first draw
  assert.equal(b.chat.focusCalls, 0);
  b.draw("room-a");
  await tick(s, b);
  assert.equal(b.chat.focusCalls, 1);
  assert.equal(b.chat.v, "치는 중");
  await tick(s, b, 1000); await tick(s, b, 1000);
  b.draw("room-a");
  await tick(s, b, 1000);
  assert.equal(b.chat.focusCalls, 1); // once
});
test("포커스: 글이 없어도 포커스만 있었으면 되돌린다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  await tick(s, a, 700);
  const b = new s.Desk(box());
  await start(s, b, "room-a");
  assert.equal(b.chat.focusCalls, 1);
  assert.equal(b.chat.v, "");
});
test("포커스: 오래된 표시(30초 넘음)는 글만 돌려주고 포커스는 가져오지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  a.type("글");
  a.draftDue = 1; a.draftBusy = false;
  s.clock.t += 250; a.draftTick(); await flush(); await flush(); s.stamp();
  a.chatFocus = false; // (its timers died with the old copy: no beat, no blur written)
  s.clock.t += 31000;
  const b = new s.Desk(box());
  await start(s, b, "room-a");
  assert.equal(b.chat.v, "글");
  assert.equal(b.chat.focusCalls, 0);
});
test("포커스: 입력칸이 포커스를 잃었으면(터미널에서 치던 중) 가져오지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  a.type("글");
  await tick(s, a, 700);
  a.chat.fire("blur"); // the person went to the terminal
  await tick(s, a, 700);
  assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).focus, false);
  const b = new s.Desk(box());
  await start(s, b, "room-a");
  assert.equal(b.chat.v, "글");
  assert.equal(b.chat.focusCalls, 0);
});
test("포커스: 처음 켠 데스크(파일 없음)는 포커스를 가져오지 않는다", async () => {
  const s = setup();
  const b = new s.Desk(box());
  await start(s, b, "room-a");
  await tick(s, b, 6000);
  assert.equal(b.chat.focusCalls, 0);
  assert.equal(fs.existsSync(s.file), false); // and an untouched box writes nothing
});
test("포커스: 첫 그리기가 5초 안에 오지 않으면 나중에도 가져오지 않는다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  await tick(s, a, 700);
  const b = new s.Desk(box());
  b.loadDraft();
  await flush(); await flush();
  b.draftRoom = "room-a"; // (room known, but the view is not on screen)
  await tick(s, b);
  await tick(s, b, 6000);
  b.draw("room-a");
  await tick(s, b);
  assert.equal(b.chat.focusCalls, 0);
});
test("포커스: 쓰는 동안 10초마다 파일을 다시 써서 표시가 늘 신선하다", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  a.type("가만히 있는 글");
  await tick(s, a, 700);
  for (let i = 0; i < 12; i++) await tick(s, a, 5000); // 60 s with no change at all
  const b = new s.Desk(box());
  await start(s, b, "room-a");
  assert.equal(b.chat.focusCalls, 1);
  const wrote = JSON.parse(fs.readFileSync(s.file, "utf8"));
  assert.ok(s.clock.t - wrote.at < I.DRAFT_FOCUS_MS);
});
test("포커스를 잃으면 600ms 뒤에야 쓴다(재시작이 보낸 blur 하나로 표시가 지워지지 않는다)", async () => {
  const s = setup();
  const a = new s.Desk(box());
  await start(s, a, "room-a");
  a.chat.fire("focus");
  await tick(s, a, 700);
  a.chat.fire("blur"); // e.g. the teardown of the old copy
  await tick(s, a, 250);
  assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).focus, true); // still the old one: the debounce has not run out
});

// ---- wiring in main.js
test("main.js: init이 focus/blur/change를 듣고 초안을 읽고 틱을 돌린다, 보내기는 wipe로 비운다", () => {
  assert.match(MAIN, /this\.chat\.on\("focus", \(\) => \{ this\.chatFocus = true; this\.draftDirty\(\); \}\)/);
  assert.match(MAIN, /this\.chat\.on\("blur", \(\) => \{ this\.chatFocus = false; this\.draftDirty\(\); \}\)/);
  assert.match(MAIN, /this\.chat\.on\("change", \(\) => this\.draftDirty\(\)\)/);
  assert.match(MAIN, /this\.load\(cx\);\n    this\.loadDraft\(\);\n    cx\.timer\.every\(DRAFT_TICK_MS, \(\) => this\.draftTick\(\)\);/);
  assert.match(grab(MAIN, "  wipe(key, st) {", "  guard(key, st, value) {"), /if \(key === "chat"\) this\.draftDue = 1;/);
  assert.match(grab(MAIN, "  sendChat(c) {", "  chatBox(t, v) {"), /this\.wipe\("chat", this\.chat\)/);
  // the keyboard is taken in exactly one place besides the older ones (after a send, an "@" pick)
  assert.equal(MAIN.split("\n").filter((l) => /this\.chat\.focus\(\)/.test(l)).length, 3);
  assert.equal(grab(MAIN, "  draftTick() {", "  saveDraft(").split("this.chat.focus()").length - 1, 1);
});
test("main.js: 필드 초기화(init)와 이 테스트의 가짜 Desk가 같다", () => {
  const init = grab(MAIN, "  init(_props, cx) {", "    this.load(cx);");
  for (const f of ["chatFocus = false", "draftDue = 0", "draftSince = 0", 'draftSig = ""', "draftWroteAt = 0", "draftBusy = false", "draftOwn = false", "draftLoaded = false", "draftReady = false", "draftSaved = null", "focusWant = 0"]) assert.ok(init.includes(`this.${f};`), f);
});

// ---- #147: a failed write leaves no .tmp behind; a long quote-heavy snapshot does not travel as one command-line argument
test("chatDraftWrite: 이름 바꾸기가 실패하면 임시 파일을 지우고 던지지 않는다", () => {
  const root = tmpRoot();
  const f = I.chatDraftPath(root);
  fs.mkdirSync(f, { recursive: true }); // a directory where the file belongs: the rename must fail
  fs.writeFileSync(path.join(f, "keep"), "x");
  let r;
  assert.doesNotThrow(() => { r = I.chatDraftWrite(I.chatDraftSnap([["A", { text: "글" }]], true), root); });
  assert.equal(r, "failed");
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith(".tmp")), []);
  // the folder itself cannot be made (a file in its way): also "failed", also no throw
  const root2 = tmpRoot();
  fs.writeFileSync(path.join(root2, "data"), "file, not folder");
  assert.doesNotThrow(() => { r = I.chatDraftWrite(I.chatDraftSnap([["A", { text: "글" }]], true), root2); });
  assert.equal(r, "failed");
});
test("draft-part: 조각을 순서대로 보내면 하나로 이어 쓰고 조각 파일은 남지 않는다", () => {
  const root = tmpRoot();
  const env = { ...process.env, HERDR_APP_HOME: root, HOME: root, USERPROFILE: root };
  const run = (...a) => JSON.parse(execFileSync(process.execPath, [HELPER_PATH, "draft-part", ...a], { env, encoding: "utf8" })).r;
  const json = JSON.stringify({ rooms: { A: { text: "조각 \"글\"\n둘째 줄", range: { start: 1, end: 1 } } }, focus: true });
  const cut = [json.slice(0, 20), json.slice(20, 41), json.slice(41)];
  assert.equal(run("abcdef12", "0/3", cut[0]), "part");
  assert.equal(run("abcdef12", "1/3", cut[1]), "part");
  assert.equal(run("abcdef12", "2/3", cut[2]), "written");
  assert.equal(I.chatDraftRead(root).rooms.A.text, "조각 \"글\"\n둘째 줄");
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "inbox")).filter((n) => n.endsWith(".part")), []);
  // bad calls change nothing; a broken earlier try is swept by piece 0
  assert.equal(run("../evil", "0/1", "{}"), "none");
  assert.equal(run("abcdef12", "3/3", "x"), "none");
  assert.equal(run("abcdef12", "0/2", "{\"rooms\":"), "part");
  assert.equal(run("zzzzzz99", "0/1", JSON.stringify({ rooms: {}, focus: false })), "cleared"); // nothing to keep: the file goes, like draft-write
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "inbox")).filter((n) => n.endsWith(".part")), []);
});
test("긴 초안(따옴표·줄바꿈 가득, 2만 자 남짓)도 명령줄 인자 하나로 보내지 않고 그대로 저장된다", async () => {
  const s = setup();
  const d = new s.Desk(box());
  await start(s, d, "room-a");
  const text = (tag) => Array.from({ length: 700 }, (_, i) => `"${tag}${i}" said 'x' \\ "q"\n`).join("").slice(0, 6000);
  const texts = { "room-a": text("a"), "room-b": text("b"), "room-c": text("c") };
  assert.ok(Object.values(texts).join("").length > 17000 && /"/.test(texts["room-a"]) && /\n/.test(texts["room-a"]));
  for (const [k, v] of Object.entries(texts)) d.roomDrafts.set(k, { text: v, range: { start: 0, end: 0 } });
  d.type(texts["room-a"]);
  s.calls.length = 0;
  await tick(s, d, 700);
  await flush(); await flush();
  const longest = Math.max(...s.calls.map((c) => c.reduce((n, a) => n + a.length, 0)));
  assert.ok(s.calls.some((c) => c[0] === "draft-part"), "sent in pieces");
  assert.ok(longest < 4000, `no call carries more than a few K (longest ${longest})`);
  const saved = JSON.parse(fs.readFileSync(s.file, "utf8"));
  assert.equal(saved.rooms["room-a"].text, texts["room-a"]);
  assert.equal(saved.rooms["room-b"]?.text, texts["room-b"]);
  assert.deepEqual(fs.readdirSync(path.dirname(s.file)).filter((n) => /\.(part|tmp)$/.test(n)), []);
  assert.equal(d.draftBusy, false);
});
