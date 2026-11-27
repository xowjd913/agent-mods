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

test("main.js: solo mode hides every leader part (chips, @ menu, cards, permission panel) and the PO structure stays as it was", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const view = src.slice(src.indexOf("  view() {"), src.indexOf("  view() {") + 6000);
  assert.match(view, /const solo = soloMode\(terms\)/);
  assert.match(view, /solo \? soloRooms\(/); // rooms come from the solo data only in solo mode
  assert.match(view, /const asks = solo \? \[\] : all/);
  assert.match(src, /q && !soloMode\(this\.liveTerms\(\)\) \? leaderMenu\(/); // no @ menu
  assert.match(src, /if \(v\.solo \|\| !v\.pick \|\| !v\.raw\.length\) return null;/); // the filter chips
  assert.match(src, /if \(v\.solo\) return v\.pick \? this\.soloRow\(t, v\) : null;/); // the restart row: a solo room gets its own (just /clear)
  assert.match(src, /const po = v\.pick && v\.pick !== PO_OTHER \? chatTarget\(v\.terms, \[\], v\.pick\)\.po : \"\";/); // the permission-question panel works in a solo room too (the room is its terminal)
  assert.match(src, /child\(soloWords\(\"PO가 질문 중입니다 — 화면 끝\"\)\)/); // and says 터미널
  assert.match(src, /const rpo = v\.pick && v\.pick !== PO_OTHER \? chatTarget/); // the remote button works in a solo room too (chatTarget gives the room's terminal)
  assert.match(src, /soloWords\(this\.msg\.text\)/); // notices say 터미널, not PO
  assert.equal(/\bsolo\b/.test(src.slice(src.indexOf("  badge() {"), src.indexOf("  // The \"pasted into the PO\""))), false); // the badge counts leaders as before
});

test("soloWords: PO(x) becomes 터미널(x) in notices only while solo", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const fn = src.slice(src.indexOf("const soloWords = "), src.indexOf("// The pending-question card"));
  const make = (solo) => new Function("soloMode", "terminals", `${fn}; return soloWords;`)(() => solo, () => []);
  assert.equal(make(true)("PO(abc)에 붙여넣었어요"), "터미널(abc)에 붙여넣었어요");
  assert.equal(make(false)("PO(abc)에 붙여넣었어요"), "PO(abc)에 붙여넣었어요");
});

test("soloWords: the fixed phrases of the shared blocks read 터미널 in a solo room", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const fn = src.slice(src.indexOf("const soloWords = "), src.indexOf("// The pending-question card"));
  const make = (solo) => new Function("soloMode", "terminals", `${fn}; return soloWords;`)(() => solo, () => []);
  const sw = make(true), po = make(false);
  for (const [a, b] of [["PO 터미널을 찾지 못했습니다", "터미널을 찾지 못했습니다"], ["이 PO를 새로 시작하는 중입니다", "이 터미널을 새로 시작하는 중입니다"], ["PO가 작업 중입니다 — 끝난 뒤에 누르세요", "터미널이 작업 중입니다 — 끝난 뒤에 누르세요"], ["이 PO의 화면을 엽니다", "이 터미널의 화면을 엽니다"], ["PO 화면을 다시 읽습니다", "터미널 화면을 다시 읽습니다"]]) {
    assert.equal(sw(a), b); assert.equal(po(a), a);
  }
});

test("remoteRestore: in a solo room it reads the screens of the solo terminals (the rooms), not the PO list", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const a = src.indexOf("  remoteRestore(cx, force = false) {"), b = src.indexOf("  // The claude process of a PO terminal", a);
  const body = src.slice(a, b);
  const reads = [];
  const make = new Function("soloMode", "soloRooms", "poList", `return { ${body.replace(/^\s+remoteRestore\(/, "remoteRestore(")} };`);
  const self = make(() => true, (terms, solo) => terms.filter((t) => solo[t.address]).map((t) => ({ id: t.address, address: t.address })), () => { throw new Error("no PO list in solo"); });
  const o = { rc: new Map(), rcChecked: new Set(), data: { solo: { t1: [{}] } }, liveTerms: () => [{ address: "t1" }, { address: "t2" }], remoteRead: async (p) => { reads.push(p); return null; } };
  const cxs = []; const cx = { spawn: (fn) => cxs.push(fn(cx)), notify() {} };
  self.remoteRestore.call(o, cx);
  await Promise.all(cxs);
  assert.deepEqual(reads, ["t1"]); // only the terminal with a room
});

test("hook: a solo room records its session transcript (po-session/<terminal id>.json) so its cost shows", () => {
  const d = tmp();
  I.setSolo(d, true);
  const tp = path.join(d, "t.jsonl");
  fs.writeFileSync(tp, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 1000 } } }) + "\n");
  const term = { name: "작업", labels: {}, parent: null };
  assert.ok(hook(d, "t5", term, { ...me, transcript_path: tp, session_id: "s1" }));
  const rec = JSON.parse(fs.readFileSync(path.join(d, "po-session", "t5.json"), "utf8"));
  assert.equal(rec.path, tp);
  assert.ok(I.poCosts(d, d).t5, "the cost of that terminal is summed");
  // solo off: nothing is written at all
  const d2 = tmp();
  assert.equal(hook(d2, "t5", term, { ...me, transcript_path: tp, session_id: "s1" }), null);
  assert.equal(fs.existsSync(path.join(d2, "po-session")), false);
});

const cli = (d, ...args) => spawnSync(process.execPath, [path.join(__dirname, "../mods/inbox/inbox.cjs"), ...args], { env: { ...process.env, HERDR_INBOX_DIR: d }, encoding: "utf8" });

test("collect: soloOn follows the flag file (also in the early return of a missing folder)", () => {
  const d = tmp();
  assert.equal(I.collect(path.join(d, "none")).soloOn, false);
  assert.equal(I.collect(d).soloOn, false);
  I.setSolo(d, true);
  assert.equal(I.collect(d).soloOn, true);
  assert.equal(I.collect(path.join(d, "none")).soloOn, false);
});

test("CLI solo-on sets the same flag as `hook --solo`; solo-me returns the last 'me' records of one terminal", () => {
  const d = tmp();
  const r = cli(d, "solo-on");
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { on: true, error: "" });
  assert.equal(I.soloEnabled(d), true);
  fs.mkdirSync(path.join(d, "solo"), { recursive: true });
  const lines = [{ ts: "2026-01-01T00:00:00Z", kind: "me", text: "하나" }, { ts: "2026-01-01T00:00:01Z", kind: "say", text: "답" }, { ts: "2026-01-01T00:00:02Z", kind: "me", text: "/clear" }];
  fs.writeFileSync(path.join(d, "solo", "t4.jsonl"), lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const me = JSON.parse(cli(d, "solo-me", "t4").stdout);
  assert.deepEqual(me.map((x) => x.text), ["하나", "/clear"]);
  assert.ok(me.every((x) => Number.isFinite(x.ms)));
  assert.deepEqual(JSON.parse(cli(d, "solo-me", "t9").stdout), []); // no file
  assert.deepEqual(JSON.parse(cli(d, "solo-me", "../x").stdout), []); // never a path outside <dir>/solo
});

test("main.js: the solo 새로 시작 sends only /clear, the enable button confirms with the stored-prompts warning and sets only the flag", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const flow = src.slice(src.indexOf("  async soloFlow("), src.indexOf("  soloOpen("));
  assert.match(flow, /sendLine\(po, "\/clear"/);
  assert.equal(/\/PO|RESTART_MARK|handoff/.test(flow), false, "no note, no /PO");
  assert.match(flow, /restartClearState\(/);
  assert.match(flow, /restartClearCheck\(await this\.soloMe\(room\), clr\.at\) === "text"/);
  const row = src.slice(src.indexOf("  soloRow(t, v) {"), src.indexOf("  // ---- \"원격 연결 켜기\""));
  assert.match(row, /restartBlock\(\{ po, status: st, running: r\?\.phase === "run" \}\)/); // greyed with a reason while working / blocked
  assert.match(row, /disabled: why/);
  assert.match(row, /"ss-go", "비우기"/);
  const hint = src.slice(src.indexOf("  poHint(t, v = null) {"), src.indexOf("  // #69: the \"working\" dot"));
  assert.match(hint, /모든 Claude 터미널의 프롬프트가 이 컴퓨터에 저장됩니다/);
  assert.match(hint, /"solo-go", "켜기", \(c\) => this\.soloEnable\(c\)/);
  const en = src.slice(src.indexOf("  soloEnable(c) {"), src.indexOf("  // ---- #90 solo \"새로 시작\""));
  assert.match(en, /"solo-on"/);
  assert.equal(/hook|install/.test(en.replace(/\/\/.*$/gm, "").replace(/"[^"]*"/g, '""')), false, "the button never installs the hook");
});
