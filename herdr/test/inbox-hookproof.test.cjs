// #111: "보내지 못함 — 붙여 넣기 실패" was shown for a line the PO had received. `hc send` ended with {"started":false} (the PO was busy: Claude Code queued the
// pasted line and submitted it when the turn ended), the desk read the PO's screen, found the line neither in the input nor started, and marked it failed.
// The PO's hook (UserPromptSubmit -> kind "me" lines) is the proof of what was submitted; these tests drive the send path with fakes only.
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

const TEXT = "음 원격을 켰던 PO인데 여전히 헐더 재실행 하니까 원격 연결 켜짐으로 안되어";
const NOT_STARTED = { code: 0, stdout: JSON.stringify({ started: false, status: "done", turn: 1029 }), stderr: "" };
const empty = "● Done.\n╭────────────────╮\n│ ❯ │\n╰────────────────╯\n";

const world = ({ me = [], rec = { text: TEXT, po: "devnotes", kind: "chat" } } = {}) => {
  const log = { marks: [], say: [], diag: [], oks: [], hc: [], poMe: 0 };
  const g = {
    restartSendResult: I.restartSendResult, inputHas: I.inputHas, PROMPT_LINES: 40, RESTART_REC_MS: 30, hookProved: I.hookProved,
    hc: async (a) => { log.hc.push(a[0]); if (a[0] === "send") return NOT_STARTED; if (a[0] === "read") return { code: 0, stdout: empty, stderr: "" }; return { code: 0, stdout: "", stderr: "" }; },
  };
  const self = {
    ...runMethod(mainSrc(), "  deliverByAddress(po, text, c, rec, ok, id) {", "  // Gives the keyboard back after a send", g),
    ...runMethod(mainSrc(), "  async poSeen(cx, room, m, since) {", "  // One line of the person's own history per desk send", g),
    opening: new Set(), isBlocked: () => false,
    sleepOn: () => tick(),
    poMe: async () => { log.poMe++; return typeof me === "function" ? me(log.poMe) : me; },
    mark: (id, st) => log.marks.push(st), say: (t, bad) => log.say.push({ t, bad: Boolean(bad) }), diag: (m) => log.diag.push(m),
  };
  const cx = { notify() {} };
  const c = { spawn(fn) { Promise.resolve().then(() => fn(cx)); } };
  const go = async () => {
    const r = self.deliverByAddress("t28", TEXT, c, rec, (x) => log.oks.push(x), "r1");
    for (let i = 0; i < 80; i++) await tick();
    await new Promise((res) => setTimeout(res, 60));
    for (let i = 0; i < 20; i++) await tick();
    return r;
  };
  return { self, log, go };
};

test("#111 hc send가 시작을 못 봤어도 PO 훅이 같은 글을 제출로 기록했으면 failed가 아니라 sent", async () => {
  const w = world({ me: () => [{ ms: Date.now() + 5, text: TEXT }] });
  assert.equal(await w.go(), "opening");
  assert.deepEqual(w.log.marks, ["sending", "sent"]);
  assert.deepEqual(w.log.oks, ["sent"]);
  assert.equal(w.self.opening.has("t28"), false);
  assert.match(w.log.say.at(-1).t, /보냈습니다/);
  assert.equal(w.log.say.at(-1).bad, false);
  assert.ok(w.log.diag.some((d) => /hook saw the line/.test(d)));
  assert.deepEqual(w.log.hc, ["send", "read"], "no second send: a resend would deliver a duplicate");
});

test("#111 훅 기록이 늦게(재시도 도중) 오면 그때 sent", async () => {
  const w = world({ me: (n) => (n >= 3 ? [{ ms: Date.now() + 5, text: TEXT }] : []) });
  await w.go();
  assert.deepEqual(w.log.marks, ["sending", "sent"]);
  assert.ok(w.log.poMe >= 3);
});

test("#111 훅 기록이 끝내 없으면 이전처럼 failed(시작하지 않은 이유와 함께)", async () => {
  const w = world({ me: [] });
  await w.go();
  assert.deepEqual(w.log.marks, ["sending", "failed"]);
  assert.match(w.log.say.at(-1).t, /시작하지 않았습니다/);
  assert.equal(w.log.say.at(-1).bad, true);
  assert.deepEqual(w.log.oks, []);
});

test("#111 다른 글의 훅 기록, 보내기 전의 훅 기록은 증거가 아니다", async () => {
  const w = world({ me: [{ ms: Date.now() + 5, text: "전혀 다른 글" }, { ms: Date.now() - 5 * 60000, text: TEXT }] });
  await w.go();
  assert.deepEqual(w.log.marks, ["sending", "failed"]);
});

test("#111 기록(rec)이 없으면 훅을 확인하지 않고 곧바로 failed(기존 동작)", async () => {
  const w = world({ me: [{ ms: Date.now() + 5, text: TEXT }], rec: null });
  await w.go();
  assert.equal(w.log.poMe, 0);
  assert.deepEqual(w.log.marks, ["sending", "failed"]);
});

test("#111 main.js: 훅 확인은 시작하지 않은 경우(notStarted)에만 기다린다 — 차단·거절 같은 명확한 실패는 바로 알린다", () => {
  const src = methodOf(mainSrc(), "  deliverByAddress(po, text, c, rec, ok, id) {", "  // Gives the keyboard back after a send");
  assert.match(src, /res\.notStarted && rec\?\.po && await this\.poSeen\(/);
  assert.equal((src.match(/poSeen\(/g) ?? []).length, 1);
});
