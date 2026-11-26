// #93: a desk line starting with "!" is pasted raw into the PO's Claude Code prompt (bash mode) — only when the PO is idle at an empty input box.
// Fakes only: nothing here touches a real terminal, focus or clipboard. Whether a pasted leading "!" really enters bash mode is NOT verified here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const mainSrc = () => fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const methodOf = (src, head, next) => { const a = src.indexOf(head), b = src.indexOf(next, a + 1); assert.ok(a > 0 && b > a, head); return src.slice(a, b); };
const runMethod = (src, head, next, globals) => {
  const m = methodOf(src, head, next);
  globals = { cutHead: I.cutHead, wellFormed: I.wellFormed, initial: I.initial, ...globals }; // the shared text-cut helpers of the chat block (#113)
  const names = Object.keys(globals);
  return new Function(...names, `return ({ ${m.replace(/\n\s*\/\/[^\n]*\s*$/g, "")} });`)(...names.map((k) => globals[k]));
};
// Several methods in a row (they call each other through `this`): the slice is a class body, and the result's methods are copied onto the fake `self`.
const runMethods = (src, head, next, globals) => {
  const m = methodOf(src, head, next).replace(/\n\s*\/\/[^\n]*\s*$/g, "");
  globals = { cutHead: I.cutHead, wellFormed: I.wellFormed, initial: I.initial, ...globals }; // the shared text-cut helpers of the chat block (#113)
  const names = Object.keys(globals);
  const K = new Function(...names, `return (class { ${m} });`)(...names.map((k) => globals[k]));
  return Object.fromEntries(Object.getOwnPropertyNames(K.prototype).filter((n) => n !== "constructor").map((n) => [n, K.prototype[n]]));
};
const tick = () => new Promise((r) => setImmediate(r));

const IDLE = "● Done.\n\n╭────────────────╮\n│ ❯              │\n╰────────────────╯\n  ? for shortcuts\n";
const TYPED = "● Done.\n\n╭────────────────╮\n│ ❯ half a thought │\n╰────────────────╯\n  ? for shortcuts\n";

test("#93 bangCommand: '!' 로 시작하는 한 줄만 명령, '!!' 나 보통 글은 아니다", () => {
  assert.equal(I.bangCommand("!ls -la"), "ls -la");
  assert.equal(I.bangCommand("  ! git status  "), "git status");
  assert.equal(I.bangCommand("!"), "");
  assert.equal(I.bangCommand("!!"), null);
  assert.equal(I.bangCommand("안녕 !ls"), null);
  assert.equal(I.bangCommand(""), null);
  assert.equal(I.bangCommand(undefined), null);
  assert.equal(I.bangCommand("!a\nb"), "a\nb");
});

test("#93 promptInput: 입력창이 비었는지(\"\")·글이 있는지·입력창이 없는지(null)를 화면에서 읽는다", () => {
  assert.equal(I.promptInput(IDLE), "");
  assert.equal(I.promptInput("\n> \n"), "");
  assert.equal(I.promptInput(TYPED), "half a thought");
  assert.equal(I.promptInput("│ ! ls │\n│ ❯ │\n"), "");
  assert.equal(I.promptInput("● working\n  esc to interrupt\n"), null);
  assert.equal(I.promptInput(" Which?\n ❯ 1. Yes\n   2. No\n"), "1. Yes"); // a question is not an empty box
  assert.equal(I.promptInput("[Pasted text #1 +4 lines]".padStart(30) + "\n❯ [Pasted text #1 +4 lines]\n"), "[Pasted text #1 +4 lines]");
});

test("#93 inputHas: 배시 모드가 '!' 를 명령과 떼어 그려도 붙여 넣은 '!ls -la' 가 입력창에 있다고 본다", () => {
  assert.equal(I.inputHas("│ ! ls -la │\n", "!ls -la"), true);
  assert.equal(I.inputHas("│ !ls -la │\n", "!ls -la"), true);
  assert.equal(I.inputHas("│ ❯ │\n", "!ls -la"), false);
});

const mk = ({ screen = IDLE, status = "idle", panes = [{ terminal: "t1" }], mained = false, read = null, text = "!ls -la", clip = "earlier clipboard", hang = false, deliverRes = "sent" } = {}) => {
  const log = { hc: [], say: [], deliver: [], set: [], notify: 0, clip: [], exec: [], timers: [], marks: [], asks: [] };
  const globals = {
    bangCommand: I.bangCommand, promptInput: I.promptInput, composeChat: (x) => x, PROMPT_LINES: 40, BANG_READ_MS: 6000, HELPER: () => "helper.cjs",
    isBusy: (t) => /^(working|blocked)$/i.test(String(t?.status ?? "")),
    panes: () => panes,
    hc: (a) => { log.hc.push(a); return hang ? new Promise(() => {}) : Promise.resolve(read ?? { code: 0, stdout: screen, stderr: "" }); },
    exec: async (cmd, args) => { log.exec.push([cmd, ...args]); return clip === null ? { code: 1, stdout: "", stderr: "x" } : { code: 0, stdout: JSON.stringify({ text: clip }), stderr: "" }; },
  };
  const bang = runMethods(mainSrc(), "  sendBang(c, po, p, pics) {", "  sendChat(c) {", globals);
  const re = runMethods(mainSrc(), "  // A '!' bubble's resend goes through", "  // The bubble's \"Enter 누르기\"", globals);
  const rec = { id: "r1", text: "!ls -la", line: "!ls -la", status: "failed", kind: "chat", imgs: [], to: "", tos: [], po: "po-room" };
  const self = {
    ...bang, ...re,
    mained, bangBusy: false, menu: "x", sentAt2: 0,
    mirror: new Map([["chat", { text }]]),
    wipe(key, st) { this.mirror.delete(key); try { st.set_value(""); } catch {} },
    chat: { content: () => text, set_value: (v) => log.set.push(v) },
    liveTerms: () => [{ address: "t1", status }],
    view: () => ({ pick: log.pick ?? "po-room" }),
    say: (t, bad) => log.say.push({ t, bad: Boolean(bad) }),
    deliver: (po, line, cx, r) => { log.deliver.push({ po, line, rec: r }); return deliverRes; },
    mark: (id, st) => { log.marks.push([id, st]); rec.status = st; },
    markAsk: (r, how) => log.asks.push(how),
  };
  const cx = { notify() { log.notify++; }, timer: { after(ms, fn) { log.timers.push({ ms, fn }); } }, write_to_clipboard: (s) => log.clip.push(s) };
  const c = { notify() { log.notify++; }, spawn(fn) { Promise.resolve().then(() => fn(cx)); } };
  const go = async (p = { text, to: [] }, pics = []) => { self.sendBang(c, "t1", p, pics); await tick(); await tick(); await tick(); };
  const again = async () => { self.resendBang("r1", c, "t1", rec, rec.status); await tick(); await tick(); await tick(); };
  return { self, log, go, again, rec };
};

test("#93 보내기: PO가 쉬는 중이고 입력창이 비었으면 '!ls -la' 를 가공 없이 그대로 붙여 넣고 입력칸을 비운다", async () => {
  const { self, log, go } = mk();
  await go();
  assert.deepEqual(log.hc, [["read", "t1", "--lines", "40"]]); // only a read: no keys or send from the desk itself
  assert.equal(log.deliver.length, 1);
  assert.equal(log.deliver[0].line, "!ls -la");
  assert.equal(log.deliver[0].po, "t1");
  assert.equal(log.deliver[0].rec.kind, "chat");
  assert.equal(log.deliver[0].rec.text, "!ls -la");
  assert.deepEqual(log.set, [""]);
  assert.equal(self.mirror.has("chat"), false, "draft mirror is dropped, so guard() cannot restore the sent '!cmd'");
  assert.equal(self.bangBusy, false);
  assert.equal(log.say.some((s) => s.bad), false);
});

const refused = async (opts, why, args) => {
  const { self, log, go } = mk(opts);
  await go(...(args ?? []));
  assert.equal(log.deliver.length, 0, "nothing is pasted");
  assert.deepEqual(log.set, [], "the text stays in the box");
  assert.equal(self.mirror.has("chat"), true, "and in the draft mirror");
  assert.equal(log.say.length, 1);
  assert.equal(log.say[0].bad, true);
  assert.match(log.say[0].t, why);
  assert.match(log.say[0].t, /글은 입력칸에 그대로/);
  assert.equal(self.bangBusy, false);
  return log;
};

test("#93 거절: PO가 일하는 중이거나 질문 중이면 화면도 읽지 않고 이유를 말한다", async () => {
  assert.deepEqual((await refused({ status: "working" }, /일하는 중이거나 질문 중/)).hc, []);
  assert.deepEqual((await refused({ status: "blocked" }, /일하는 중이거나 질문 중/)).hc, []);
});
test("#93 거절: 입력창에 글이 있으면, 입력창을 못 찾으면, 화면을 못 읽으면 보내지 않는다", async () => {
  await refused({ screen: TYPED }, /입력창이 비어 있지 않아/);
  await refused({ screen: "● working…\n" }, /입력창을 화면에서 찾지 못해/);
  await refused({ read: { code: 1, stdout: "", stderr: "x" } }, /화면을 읽지 못해/);
});
test("#93 거절: UI 모드·@멘션·그림·빈 명령·여러 줄·열린 칸 없음", async () => {
  await refused({ mained: true }, /UI 모드/);
  await refused({}, /@멘션/, [{ text: "!ls", to: ["lead"] }]);
  await refused({}, /그림/, [{ text: "!ls", to: [] }, [{ path: "/x.png" }]]);
  await refused({ text: "!" }, /명령이 없어/, [{ text: "!", to: [] }]);
  await refused({}, /한 줄만/, [{ text: "!a\nb", to: [] }]);
  await refused({ panes: [] }, /화면에 열려 있지 않아/);
});

test("#93 '!' 확인 중에 한 번 더 누르면 두 번째는 기다리라고만 하고 한 번만 붙여 넣는다", async () => {
  const { self, log, go } = mk();
  const first = go();
  self.bangBusy = true; // the first one is still reading the screen
  await go();
  assert.equal(log.say.some((s) => /확인하는 중/.test(s.t)), true);
  self.bangBusy = false;
  await first;
  assert.equal(log.deliver.length, 1);
});

test("#93 sendChat: '!' 줄은 sendBang 으로만 가고 바로 deliver 를 부르지 않는다(보통 글은 기존 길)", () => {
  const src = mainSrc();
  const chat = methodOf(src, "  sendChat(c) {", "  // The chat footer");
  assert.match(chat, /if \(bangCommand\(p\.text\) !== null\) \{ this\.sendBang\(c, po, p, pics\); return; \}/);
  assert.ok(chat.indexOf("sendBang") < chat.indexOf("this.deliver("));
});

// --- #96 review fixes: resend guard, read timeout, clipboard restore ---

test("#93 다시 보내기: PO가 쉬는 중이고 입력창이 비었으면 첫 보내기와 같은 확인을 거쳐 붙여 넣는다", async () => {
  const { self, log, again, rec } = mk();
  await again();
  assert.deepEqual(log.hc, [["read", "t1", "--lines", "40"]], "the screen is read before the resend");
  assert.equal(log.deliver.length, 1);
  assert.equal(log.deliver[0].line, "!ls -la");
  assert.deepEqual(log.marks, [["r1", "sending"]]);
  assert.deepEqual(log.asks, ["sent"]);
  assert.equal(self.bangBusy, false);
  assert.equal(rec.status, "sending");
});

const resendRefused = async (opts, why, { read = true } = {}) => {
  const { self, log, again, rec } = mk(opts);
  await again();
  assert.equal(log.deliver.length, 0, "nothing is pasted");
  assert.equal(rec.status, "failed", "the record is as it was");
  assert.equal(self.bangBusy, false);
  assert.equal(log.say.length, 1);
  assert.equal(log.say[0].bad, true);
  assert.match(log.say[0].t, why);
  assert.deepEqual(log.clip, [], "the clipboard is not rewritten");
  if (!read) assert.deepEqual(log.hc, []);
  return log;
};

test("#93 다시 보내기 거절: PO가 일하는 중·질문 중, 칸이 닫힘, UI 모드면 화면을 읽기 전에 막고 기록은 그대로", async () => {
  await resendRefused({ status: "working" }, /일하는 중이거나 질문 중/, { read: false });
  await resendRefused({ status: "blocked" }, /일하는 중이거나 질문 중/, { read: false });
  await resendRefused({ panes: [] }, /화면에 열려 있지 않아/, { read: false });
  await resendRefused({ mained: true }, /UI 모드/, { read: false });
});
test("#93 다시 보내기 거절: 입력창에 글이 있거나 입력창이 없거나 화면을 못 읽으면 붙여 넣지 않고 상태를 되돌린다", async () => {
  const a = await resendRefused({ screen: TYPED }, /입력창이 비어 있지 않아/);
  assert.deepEqual(a.marks, [["r1", "sending"], ["r1", "failed"]]);
  await resendRefused({ screen: "● working…\n" }, /입력창을 화면에서 찾지 못해/);
  await resendRefused({ read: { code: 1, stdout: "", stderr: "x" } }, /화면을 읽지 못해/);
});
test("#93 다시 보내기: 확인 중에 또 누르면 기다리라고만 하고 한 번만 붙여 넣는다", async () => {
  const { self, log, again, rec } = mk();
  const first = again();
  self.resendBang("r1", { notify() {}, spawn() { throw new Error("must not read twice"); } }, "t1", rec, "failed");
  await first;
  assert.equal(log.deliver.length, 1);
  assert.equal(log.say.some((s) => /확인하는 중/.test(s.t)), true);
});
test("#93 resend: '!' 줄이면 resendBang 으로 가고, 보통 글은 기존 길로 간다", () => {
  const src = mainSrc();
  const m = methodOf(src, "  resend(id, c) {", "  // A '!' bubble's resend goes through");
  assert.match(m, /if \(bangCommand\(r\.line \|\| r\.text\) !== null\) \{ this\.resendBang\(id, c, po, r, before\); return; \}/);
  assert.ok(m.indexOf("resendBang") < m.indexOf("this.deliver("));
});

test("#93 화면 읽기가 멈추면 제한 시간 뒤 거절하고 확인 중 표시(bangBusy)를 푼다 — 첫 보내기", async () => {
  const { self, log, go } = mk({ hang: true });
  await go();
  assert.equal(self.bangBusy, true, "still waiting for the read");
  assert.equal(log.timers.length, 1);
  assert.equal(log.timers[0].ms, 6000);
  log.timers[0].fn();
  await tick(); await tick();
  assert.equal(self.bangBusy, false);
  assert.equal(log.deliver.length, 0);
  assert.deepEqual(log.set, []);
  assert.equal(log.say.length, 1);
  assert.match(log.say[0].t, /6초 안에 끝나지 않아/);
  assert.match(log.say[0].t, /글은 입력칸에 그대로/);
});
test("#93 화면 읽기가 멈추면 다시 보내기도 제한 시간 뒤 상태를 되돌리고 확인 중 표시를 푼다", async () => {
  const { self, log, again, rec } = mk({ hang: true });
  await again();
  assert.equal(self.bangBusy, true);
  assert.equal(rec.status, "sending");
  log.timers[0].fn();
  await tick(); await tick();
  assert.equal(self.bangBusy, false);
  assert.equal(rec.status, "failed");
  assert.equal(log.deliver.length, 0);
  assert.match(log.say[0].t, /6초 안에 끝나지 않아/);
});
test("#93 제한 시간이 지난 뒤 늦게 끝난 읽기는 붙여 넣지 않는다", async () => {
  let release;
  const { self, log, go } = mk();
  // a read that answers only after the limit
  const m = runMethods(mainSrc(), "  sendBang(c, po, p, pics) {", "  sendChat(c) {", {
    bangCommand: I.bangCommand, promptInput: I.promptInput, composeChat: (x) => x, PROMPT_LINES: 40, BANG_READ_MS: 6000, HELPER: () => "h",
    isBusy: () => false, panes: () => [{ terminal: "t1" }], exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    hc: () => new Promise((r) => { release = () => r({ code: 0, stdout: IDLE, stderr: "" }); }),
  });
  const said = [], delivered = [], timers = [];
  const s2 = { ...m, mained: false, bangBusy: false, chat: { content: () => "!ls", set_value() {} }, liveTerms: () => [{ address: "t1", status: "idle" }], view: () => ({ pick: "x" }), say: (t) => said.push(t), deliver: (...a) => { delivered.push(a); return "sent"; } };
  const cx = { notify() {}, timer: { after: (ms, fn) => timers.push(fn) }, write_to_clipboard() {} };
  s2.sendBang({ notify() {}, spawn: (fn) => Promise.resolve().then(() => fn(cx)) }, "t1", { text: "!ls", to: [] }, []);
  await tick(); await tick();
  timers[0](); await tick(); await tick();
  assert.equal(s2.bangBusy, false);
  release(); await tick(); await tick(); await tick();
  assert.equal(delivered.length, 0, "the late answer is ignored");
  assert.equal(said.length, 1, "and says nothing more");
  void self; void log; void go;
});

test("#93 클립보드: 붙여 넣은 뒤 이전 클립보드 글을 되돌려 놓는다(첫 보내기·다시 보내기)", async () => {
  const a = mk({ clip: "my earlier text" });
  await a.go();
  assert.deepEqual(a.log.exec, [["node", "helper.cjs", "cliptext"]]);
  assert.deepEqual(a.log.clip, ["my earlier text"]);
  const b = mk({ clip: "other text" });
  await b.again();
  assert.deepEqual(b.log.clip, ["other text"]);
});
test("#93 클립보드: 'held' 도 되돌리지만, 칸이 열리길 기다리는 'opening'·실패·busy 는 되돌리지 않는다", async () => {
  const held = mk({ deliverRes: "held" });
  await held.go();
  assert.deepEqual(held.log.clip, ["earlier clipboard"]);
  for (const deliverRes of ["opening", "failed", "nopane", "busy"]) {
    const x = mk({ deliverRes });
    await x.go();
    assert.deepEqual(x.log.clip, [], deliverRes);
  }
});
test("#93 클립보드: 글이 아닌 클립보드(그림 등)·읽기 실패·거절된 보내기는 건드리지 않는다", async () => {
  const none = mk({ clip: null });
  await none.go();
  assert.equal(none.log.deliver.length, 1, "the paste still goes");
  assert.deepEqual(none.log.clip, []);
  const empty = mk({ clip: "" });
  await empty.go();
  assert.deepEqual(empty.log.clip, []);
  const refusedRun = mk({ screen: TYPED });
  await refusedRun.go();
  assert.deepEqual(refusedRun.log.clip, []);
});
test("#93 clipText: 헬퍼 호출은 시간 제한이 있고 실패해도 던지지 않는다", async () => {
  const src = mainSrc();
  const m = methodOf(src, "  async clipText() {", "  // After the '!' line was pasted");
  assert.match(m, /timeout: 4000/);
  const bang = runMethods(src, "  sendBang(c, po, p, pics) {", "  sendChat(c) {", {
    bangCommand: I.bangCommand, promptInput: I.promptInput, composeChat: (x) => x, PROMPT_LINES: 40, BANG_READ_MS: 6000, HELPER: () => "h", isBusy: () => false, panes: () => [], hc: async () => null,
    exec: async () => { throw new Error("boom"); },
  });
  assert.equal(await bang.clipText(), null);
});
test("inbox.cjs clipText: 글자를 돌려주거나 null 이고 던지지 않는다(실제 클립보드는 읽지 않고 함수 모양만 확인)", () => {
  assert.equal(typeof I.clipText, "function");
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.match(src, /cmd === "cliptext"/);
  // over the cap the helper hands back NO text (a cut copy would be restored shorter than the original), never a sliced one
  assert.equal(I.CLIP_TEXT_MAX, 200000);
  assert.match(src, /x\.length <= CLIP_TEXT_MAX \? x : null/);
  assert.doesNotMatch(src, /x\.slice\(0, 200000\)/);
});
test("#93 클립보드: 헬퍼가 글 없음(null, 상한 초과 포함)을 돌려주면 되돌리지 않는다", async () => {
  const { go, log } = mk({ clip: null });
  await go();
  assert.equal(log.deliver.length, 1);
  assert.deepEqual(log.clip, []);
});
test("#93 보내기: 화면을 읽는 동안 다른 방으로 바꿔도 말풍선 기록은 보낸 방에 붙는다", async () => {
  const { self, log } = mk();
  log.pick = "room-A";
  self.sendBang({ notify() {}, spawn(fn) { Promise.resolve().then(() => fn({ notify() {}, timer: { after() {} }, write_to_clipboard() {} })); } }, "t1", { text: "!ls -la", to: [] }, []);
  log.pick = "room-B"; // the person switched rooms before the read came back
  await tick(); await tick(); await tick();
  assert.equal(log.deliver.length, 1);
  assert.equal(log.deliver[0].rec.po, "room-A");
});

// --- P1 fix: parseMention no longer strips the person's own leading "!" (it ran before bangCommand, so a '!' line never took the bang path) ---

test("#93 parseMention: 처음의 '!' 는 글 그대로 남고, @멘션을 뺀 자리에 남은 문장부호만 걷힌다", () => {
  assert.equal(I.parseMention("! gh pr merge 1").text, "! gh pr merge 1");
  assert.equal(I.parseMention("!ls -la").text, "!ls -la");
  assert.equal(I.parseMention("  !ls\n").text, "!ls");
  assert.equal(I.parseMention("!!안녕").text, "!!안녕");
  assert.equal(I.parseMention("@here, 안녕").text, "안녕"); // the old cleanup still works after a removed mention
  assert.equal(I.parseMention("@here ! 안녕").text, "안녕");
  assert.equal(I.parseMention("? 안녕").text, "안녕");
});

const realSend = (raw, { known = [] } = {}) => {
  const log = { bang: [], deliver: [], say: [] };
  const src = mainSrc();
  const globals = {
    parseMention: I.parseMention, composeChat: I.composeChat, bangCommand: I.bangCommand, chatTarget: () => ({ po: "t1" }), imgLine: () => "", MAX_IMGS: 4, PO_OTHER: "__other", isAgentName: () => true, leaderOwner: () => "po-room",
  };
  const m = runMethod(src, "  sendChat(c) {", "  // The chat footer", globals);
  const self = {
    ...m, pics: [], menu: null,
    chat: { content: () => ({ text: raw, tokens: [] }), set_value() {} },
    view: () => ({ pick: "po-room", terms: [] }),
    say: (t) => log.say.push(t),
    sendBang: (c, po, p, pics) => log.bang.push({ po, p, pics }),
    deliver: (po, line, c, rec) => { log.deliver.push({ po, line, rec }); return "sent"; },
  };
  self.sendChat({ notify() {} });
  return { log, known };
};

test("#93 sendChat(실제 순서): '!cmd' 는 parseMention 을 거친 뒤에도 sendBang 으로 가고, 보통 글은 deliver 로 간다", () => {
  for (const raw of ["!ls -la", "! gh pr merge 1", "  !git status "]) {
    const { log } = realSend(raw);
    assert.equal(log.bang.length, 1, raw);
    assert.equal(log.deliver.length, 0, raw);
    assert.equal(I.bangCommand(log.bang[0].p.text), I.bangCommand(raw));
    assert.match(log.bang[0].p.text, /^!/);
  }
  const plain = realSend("안녕 !ls");
  assert.equal(plain.log.bang.length, 0);
  assert.equal(plain.log.deliver.length, 1);
  assert.equal(plain.log.deliver[0].line, "안녕 !ls");
  const dbl = realSend("!!안녕");
  assert.equal(dbl.log.bang.length, 0); // "!!" is a plain line, and it keeps both "!"
  assert.equal(dbl.log.deliver[0].line, "!!안녕");
});

test("#93 다시 보내기(실제 resend): '!' 기록은 resendBang 으로만 가고 deliver 를 직접 부르지 않으며, 보통 글은 deliver 로 간다", () => {
  const run = (text, line) => {
    const log = { bang: [], deliver: [] };
    const m = runMethod(mainSrc(), "  resend(id, c) {", "  // A '!' bubble's resend goes through", { bangCommand: I.bangCommand });
    const r = { id: "r1", text, line, status: "failed", po: "po-room" };
    const self = {
      ...m, recordOf: () => r, recordPo: () => "t1", recordActs: () => ["resend"], say() {}, mark() {}, markAsk() {},
      resendBang: (id, c, po, rr) => log.bang.push(rr), deliver: (po, l) => { log.deliver.push(l); return "sent"; },
    };
    self.resend("r1", { notify() {} });
    return log;
  };
  const bang = run("!ls -la", "!ls -la");
  assert.equal(bang.bang.length, 1);
  assert.equal(bang.deliver.length, 0);
  assert.equal(run("! gh pr merge 1", undefined).bang.length, 1); // text only, no line
  const plain = run("안녕", "안녕");
  assert.equal(plain.bang.length, 0);
  assert.deepEqual(plain.deliver, ["안녕"]);
});
