// #104: UI mode sends through `hc send --json`. Exit 0 + {"started":false} (hc gave up waiting, e.g. a person's draft in the PO's input) used to be shown as
// "붙여 넣기 실패" with only "다시 보내기" even when the text was already in the PO's input. Fakes only: no real terminal, clipboard or focus.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const mainSrc = () => fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const methodOf = (src, head, next) => { const a = src.indexOf(head), b = src.indexOf(next, a + 1); assert.ok(a > 0 && b > a, head); return src.slice(a, b); };
const runMethod = (src, head, next, globals) => {
  const m = methodOf(src, head, next);
  const names = Object.keys(globals);
  return new Function(...names, `return ({ ${m.replace(/\n\s*\/\/[^\n]*\s*$/g, "")} });`)(...names.map((k) => globals[k]));
};
const tick = () => new Promise((r) => setImmediate(r));

const IMG = "/Users/x/.config/herdr-app/data/inbox/img/1422003d2f9da388.png";
const LINE = `이거 왜 안가냐\n켜졌는데 왜 그래\n${I.imgLine(IMG)}\n${I.imgLine(IMG.replace("1422", "ec05"))}`;
const NOT_STARTED = { code: 0, stdout: JSON.stringify({ started: false, status: "done", turn: 1001 }), stderr: "" };
const STARTED = { code: 0, stdout: JSON.stringify({ started: true, status: "done", turn: 1001 }), stderr: "" };
const withText = "● Done.\n╭────────────────╮\n│ ❯ [Pasted text #1 +4 lines] │\n╰────────────────╯\n";
const empty = "● Done.\n╭────────────────╮\n│ ❯ │\n╰────────────────╯\n";

const world = ({ send, screen, blocked = false } = {}) => {
  const log = { hc: [], marks: [], say: [], diag: [], notify: 0 };
  const g = {
    restartSendResult: I.restartSendResult, inputHas: I.inputHas, PROMPT_LINES: 40,
    hc: async (a) => { log.hc.push(a); if (a[0] === "send") return send; if (a[0] === "read") return screen; return { code: 0, stdout: "", stderr: "" }; },
  };
  const self = {
    ...runMethod(mainSrc(), "  deliverByAddress(po, text, c, rec, ok, id) {", "  // Gives the keyboard back after a send", g),
    opening: new Set(), isBlocked: () => blocked,
    mark: (id, st) => log.marks.push(st), say: (t, bad) => log.say.push({ t, bad: Boolean(bad) }), diag: (m) => log.diag.push(m),
  };
  const cx = { notify() { log.notify++; } };
  const c = { spawn(fn) { Promise.resolve().then(() => fn(cx)); } };
  const go = async () => { const r = self.deliverByAddress("t28", LINE, c, null, null, "r1"); for (let i = 0; i < 6; i++) await tick(); return r; };
  return { self, log, go };
};

test("#104 restartSendResult: 종료 코드 0 + started:false 는 notStarted 로 알리고, 이유 글에 '붙여 넣기'가 없다", () => {
  const r = I.restartSendResult(NOT_STARTED);
  assert.equal(r.ok, false);
  assert.equal(r.notStarted, true);
  assert.match(r.why, /시작하지 않았습니다/);
  assert.doesNotMatch(r.why, /붙여 넣기 실패/);
  assert.match(r.detail, /"started":false/); // diag keeps the raw output
  assert.equal(I.restartSendResult({ code: 0, stdout: JSON.stringify({ error: { kind: "blocked" } }) }).notStarted, undefined, "an hc error is not 'not started'");
  assert.equal(I.restartSendResult({ code: 1, stdout: JSON.stringify({ started: false }), stderr: "" }).notStarted, undefined, "a non-zero exit is a plain failure");
  assert.equal(I.restartSendResult(STARTED).ok, true);
});

test("#104 그림이 든 글: hc send 가 시작되지 않았고 글이 PO 입력창에 있으면 'noenter'(Enter 누르기)로 표시하고 다시 붙여 넣지 않는다", async () => {
  const w = world({ send: NOT_STARTED, screen: { code: 0, stdout: withText, stderr: "" } });
  assert.equal(await w.go(), "opening");
  assert.deepEqual(w.log.hc.map((a) => a[0]), ["send", "read"]); // one send only; the screen is read, no key is pressed from here
  assert.deepEqual(w.log.marks, ["sending", "noenter"]);
  assert.equal(w.self.opening.has("t28"), false, "the PO is free for the next send");
  assert.match(w.log.say.at(-1).t, /Enter 누르기/);
  assert.equal(w.log.say.at(-1).bad, true);
  assert.equal(w.log.diag.length, 1);
  assert.match(w.log.diag[0], /started":false/);
});

test("#104 그림이 든 글: 시작되지 않았고 글도 입력창에 없으면 'failed'와 시작하지 않은 이유(붙여 넣기 실패 아님)를 말한다", async () => {
  const w = world({ send: NOT_STARTED, screen: { code: 0, stdout: empty, stderr: "" } });
  await w.go();
  assert.deepEqual(w.log.marks, ["sending", "failed"]);
  assert.match(w.log.say.at(-1).t, /시작하지 않았습니다/);
  assert.doesNotMatch(w.log.say.at(-1).t, /붙여 넣기 실패/);
  assert.equal(w.self.opening.has("t28"), false);
});

test("#104 화면을 못 읽거나 PO가 그 사이 질문 중이 되면 Enter 를 권하지 않고 'failed'", async () => {
  const a = world({ send: NOT_STARTED, screen: { code: 1, stdout: "", stderr: "x" } });
  await a.go();
  assert.deepEqual(a.log.marks, ["sending", "failed"]);
  const b = world({ send: NOT_STARTED, screen: { code: 0, stdout: withText, stderr: "" }, blocked: false });
  b.self.isBlocked = (() => { let n = 0; return () => ++n > 1; })(); // free at the send, on a question after the read
  await b.go();
  assert.deepEqual(b.log.marks, ["sending", "failed"]);
});

test("#104 started:true 는 그대로 'sent' (화면을 읽지 않는다)", async () => {
  const w = world({ send: STARTED, screen: { code: 0, stdout: empty, stderr: "" } });
  await w.go();
  assert.deepEqual(w.log.hc.map((a) => a[0]), ["send"]);
  assert.deepEqual(w.log.marks, ["sending", "sent"]);
});
