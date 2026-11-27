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

test("the desk code does not read solo data yet (the screen stays unchanged)", () => {
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
