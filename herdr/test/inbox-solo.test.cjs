// #90 solo mode, part 1: the enable flag, the solo/<terminal id>.jsonl file, the hook writing it, and `install.cjs hook --solo`.
// The desk does not read any of this yet (the screen is unchanged), so there is nothing visual here.
require("./helpers/po-home.cjs"); // a PO machine: a profile without `preset` is "po" (see the helper)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const I = require("../mods/inbox/inbox.cjs");
const HOOK = require("../mods/inbox/po-hook.cjs");
const POSIX = process.platform !== "win32";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "inbox-solo-"));

// run the hook with the inbox folder pointed at `d`
function hook(d, id, term, payload) {
  const prev = process.env.HERDR_INBOX_DIR;
  process.env.HERDR_INBOX_DIR = d;
  try { return HOOK.run({ HC_TERMINAL_ID: id }, { transcript_path: "", ...payload }, I, () => term, Date.UTC(2026, 0, 1), () => {}); }
  finally { if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; }
}
const say = { hook_event_name: "Stop", last_assistant_message: "끝났어요" };
const me = { hook_event_name: "UserPromptSubmit", prompt: "안녕", prompt_id: "p1" };

test("soloFile: only a safe terminal id gets a path, always inside <dir>/solo", () => {
  assert.equal(I.soloFile("/d", "t5"), path.join("/d", "solo", "t5.jsonl"));
  for (const bad of ["", null, undefined, "../x", "a/b", "a\\b", ".hidden", "x\n", "a".repeat(65)]) assert.equal(I.soloFile("/d", bad), null, String(bad));
});

test("setSolo/soloEnabled: off by default, on creates the flag (0600), off removes it, both are repeatable", () => {
  const d = path.join(tmp(), "inbox");
  assert.equal(I.soloEnabled(d), false);
  assert.equal(I.setSolo(d, false), false); // already off: no error
  assert.equal(I.setSolo(d, true), true);
  assert.equal(I.soloEnabled(d), true);
  assert.equal(I.setSolo(d, true), true);
  if (POSIX) assert.equal(fs.statSync(path.join(d, "solo.on")).mode & 0o777, 0o600);
  assert.equal(I.setSolo(d, false), false);
  assert.equal(I.soloEnabled(d), false);
  fs.mkdirSync(path.join(d, "solo.on")); // a folder is not the flag
  assert.equal(I.soloEnabled(d), false);
});

test("hook: a plain terminal is not recorded until solo is on, then its lines go to solo/<id>.jsonl", () => {
  const d = tmp();
  const term = { name: "my-claude", labels: {} };
  hook(d, "t7", term, me);
  assert.equal(fs.existsSync(path.join(d, "solo")), false);
  I.setSolo(d, true);
  hook(d, "t7", term, me);
  hook(d, "t7", term, say);
  const file = I.soloFile(d, "t7");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.kind), ["me", "say"]);
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const all = I.readSolo(d);
  assert.deepEqual(Object.keys(all), ["t7"]);
  assert.equal(all.t7.length, 2);
  assert.equal(fs.existsSync(path.join(d, "po")), false); // nothing leaked into the PO store
});

test("hook: solo on never records a leader, a worker or a terminal with a parent; a PO still goes to its PO file", () => {
  const d = tmp();
  I.setSolo(d, true);
  hook(d, "t1", { name: "lead-x", labels: {} }, me);
  hook(d, "t2", { name: "dev-1", labels: {}, parent: "t1" }, me);
  hook(d, "t3", { name: "plain", labels: { role: "leader" } }, me);
  assert.deepEqual(I.readSolo(d), {});
  hook(d, "t4", { name: "po-a", labels: { role: "po", po: "pa" } }, me);
  assert.deepEqual(I.readSolo(d), {});
  assert.equal(I.readPo(d).pa?.length, 1);
});

test("readSolo: empty without the folder; skips files with unsafe names and ids that are not lines", () => {
  const d = tmp();
  assert.deepEqual(I.readSolo(d), {});
  I.setSolo(d, true);
  hook(d, "t9", { name: "c", labels: {} }, me);
  fs.writeFileSync(path.join(d, "solo", "..x.jsonl"), "{}\n");
  fs.writeFileSync(path.join(d, "solo", "notes.txt"), "x");
  assert.deepEqual(Object.keys(I.readSolo(d)), ["t9"]);
});

test("the desk code never reads the solo files itself (the collector does) and only reads them as data", () => {
  const main = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.equal(/readSolo|soloFile|solo\.on/.test(main), false);
});

test("install hook --solo turns the flag on (and --remove --solo off); without --solo the flag is left alone", () => {
  const d = tmp();
  const home = path.join(d, "home");
  const settings = path.join(d, "settings.json");
  const inbox = path.join(d, "inbox");
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "install.cjs"), "hook", "--home", home, "--settings", settings, ...a], { encoding: "utf8", env: { ...process.env, HERDR_INBOX_DIR: inbox } });
  fs.mkdirSync(path.join(home, "mods", "inbox"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "mods", "inbox", "po-hook.cjs"), path.join(home, "mods", "inbox", "po-hook.cjs"));
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(I.soloEnabled(inbox), false);
  r = run("--solo");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /혼자 모드 기록을 켰습니다/);
  assert.equal(I.soloEnabled(inbox), true);
  r = run();
  assert.equal(I.soloEnabled(inbox), true); // a plain re-run does not switch it off
  const ours = () => JSON.stringify(JSON.parse(fs.readFileSync(settings, "utf8"))).split("po-hook.cjs").length - 1;
  assert.equal(ours(), 2); // Stop + UserPromptSubmit
  r = run("--remove", "--solo");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /혼자 모드 기록을 껐습니다/);
  assert.equal(I.soloEnabled(inbox), false);
  assert.equal(ours(), 2); // --remove --solo only turns solo off: the PO hook is still there
  r = run("--remove");
  assert.equal(ours(), 0); // a plain --remove still takes the PO hook out
});

// ---- #90 part 2: the solo room view (pure helpers; the screen wiring is pinned by source text below)
const term = (address, o = {}) => ({ address, name: "", title: "", status: "idle", ...o });
const po = (address, id) => term(address, { labels: { role: "po", po: id } });

test("soloMode: only with no live PO and no live lead-* leader; one of either brings the PO structure back", () => {
  assert.equal(I.soloMode([]), true);
  assert.equal(I.soloMode(undefined), true);
  assert.equal(I.soloMode([term("t1"), term("t2", { name: "api" })]), true);
  assert.equal(I.soloMode([term("t1"), po("t2", "mine")]), false);
  assert.equal(I.soloMode([term("t1"), term("t3", { name: "lead-a" })]), false);
});

test("soloRooms: a live plain terminal with a recorded line is a room (name, else title, else address); closed ones, PO/leader/child terminals and empty files are not", () => {
  const list = [term("t1", { name: "작업" }), term("t2", { title: "제목" }), term("t3"), term("t4"), term("t5", { parent: "t1" }), term("t6", { labels: { role: "po" } }), term("t7", { name: "lead-x" })];
  const solo = { t1: ["a"], t2: ["b"], t3: ["c"], t4: [], t5: ["d"], t6: ["e"], t7: ["f"], gone: ["g"] };
  assert.deepEqual(I.soloRooms(list, solo).map((r) => [r.id, r.label]), [["t1", "작업"], ["t2", "제목"], ["t3", "t3"]]);
  assert.deepEqual(I.soloRooms(list, {}), []);
  assert.deepEqual(I.soloRooms(null, null), []);
  assert.equal(I.soloRooms([term("t9", { title: "t9" })], { t9: ["x"] })[0].label, "t9"); // a title that is only the address adds nothing
});

test("chatTarget: in solo mode the picked room id (a terminal address) is the target; with a PO around it is not", () => {
  const list = [term("t1"), term("t2", { parent: "t1" })];
  assert.deepEqual(I.chatTarget(list, [], "t1"), { po: "t1" });
  assert.deepEqual(I.chatTarget(list, [], "t2"), { po: null, why: "none" }); // a child terminal is not a room
  assert.deepEqual(I.chatTarget(list, [], "zz"), { po: null, why: "none" });
  assert.deepEqual(I.chatTarget([...list, po("t3", "mine")], [], "t1"), { po: null, why: "none" }); // PO structure: unchanged
  assert.deepEqual(I.chatTarget([...list, po("t3", "mine")], [], "mine"), { po: "t3" });
});

test("typingNow: solo shows one working line only while that terminal works; the PO structure keeps its own lines", () => {
  const idle = [term("t1", { name: "a" })], busy = [term("t1", { name: "a", status: "working" })];
  assert.deepEqual(I.typingNow(idle, "t1", {}, null, 0), []);
  const rows = I.typingNow(busy, "t1", {}, null, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].who, rows[0].name, rows[0].label], ["po", "a", I.LABEL_WORKING]);
  assert.deepEqual(I.typingNow(busy, "t2", {}, null, 0), []); // another room
  const withPo = [...busy, term("t3", { labels: { role: "po", po: "mine" }, status: "working" })];
  assert.equal(I.typingNow(withPo, "t1", {}, null, 0).length, 0); // not a PO room, not solo mode
  assert.equal(I.typingNow(withPo, "mine", {}, null, 0).length, 1);
});

test("collect: returns the solo lines per terminal (empty without the folder)", () => {
  const d = tmp();
  assert.deepEqual(I.collect(d).solo, {});
  fs.mkdirSync(path.join(d, "solo"));
  fs.writeFileSync(path.join(d, "solo", "t4.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00Z", kind: "say", text: "hi" }) + "\n");
  assert.deepEqual(Object.keys(I.collect(d).solo), ["t4"]);
});

test("main.js: solo mode hides every leader part (chips, @ menu, cards, restart, remote, permission panel) and the PO structure stays as it was", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const view = src.slice(src.indexOf("  view() {"), src.indexOf("  view() {") + 6000);
  assert.match(view, /const solo = soloMode\(terms\)/);
  assert.match(view, /solo \? soloRooms\(/); // rooms come from the solo data only in solo mode
  assert.match(view, /const asks = solo \? \[\] : all/);
  assert.match(src, /q && !soloMode\(this\.liveTerms\(\)\) \? leaderMenu\(/); // no @ menu
  assert.match(src, /if \(v\.solo \|\| !v\.pick \|\| !v\.raw\.length\) return null;/); // the filter chips
  assert.match(src, /if \(v\.solo \|\| !v\.pick \|\| v\.pick === PO_OTHER\) return null;/); // the restart row
  assert.match(src, /const po = !v\.solo && v\.pick && v\.pick !== PO_OTHER \? chatTarget/); // the permission-question panel
  assert.match(src, /const rpo = !v\.solo && v\.pick/); // the remote button
  assert.match(src, /soloWords\(this\.msg\.text\)/); // notices say 터미널, not PO
  assert.equal(/\bsolo\b/.test(src.slice(src.indexOf("  badge() {"), src.indexOf("  // The \"pasted into the PO\""))), false); // the badge counts leaders as before
});

test("soloWords: PO(x) becomes 터미널(x) in notices only while solo", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const fn = src.match(/^const soloWords = .*$/m)[0];
  const make = (solo) => new Function("soloMode", "terminals", `${fn}; return soloWords;`)(() => solo, () => []);
  assert.equal(make(true)("PO(abc)에 붙여넣었어요"), "터미널(abc)에 붙여넣었어요");
  assert.equal(make(false)("PO(abc)에 붙여넣었어요"), "PO(abc)에 붙여넣었어요");
});
