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
  const names = Object.keys(globals);
  return new Function(...names, `return ({ ${m.replace(/\n\s*\/\/[^\n]*\s*$/g, "")} });`)(...names.map((k) => globals[k]));
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

const mk = ({ screen = IDLE, status = "idle", panes = [{ terminal: "t1" }], mained = false, read = null, text = "!ls -la" } = {}) => {
  const log = { hc: [], say: [], deliver: [], set: [], notify: 0 };
  const globals = {
    bangCommand: I.bangCommand, promptInput: I.promptInput, composeChat: (x) => x, PROMPT_LINES: 40,
    isBusy: (t) => /^(working|blocked)$/i.test(String(t?.status ?? "")),
    panes: () => panes,
    hc: async (a) => { log.hc.push(a); return read ?? { code: 0, stdout: screen, stderr: "" }; },
  };
  const m = runMethod(mainSrc(), "  sendBang(c, po, p, pics) {", "  sendChat(c) {", globals);
  const self = {
    mained, bangBusy: false, menu: "x", sentAt2: 0,
    chat: { content: () => text, set_value: (v) => log.set.push(v) },
    liveTerms: () => [{ address: "t1", status }],
    view: () => ({ pick: "po-room" }),
    say: (t, bad) => log.say.push({ t, bad: Boolean(bad) }),
    deliver: (po, line, cx, rec) => { log.deliver.push({ po, line, rec }); return "sent"; },
  };
  const c = { notify() { log.notify++; }, spawn(fn) { Promise.resolve().then(() => fn({ notify() { log.notify++; } })); } };
  const go = async (p = { text, to: [] }, pics = []) => { m.sendBang.call(self, c, "t1", p, pics); await tick(); await tick(); };
  return { self, log, go };
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
  assert.equal(self.bangBusy, false);
  assert.equal(log.say.some((s) => s.bad), false);
});

const refused = async (opts, why, args) => {
  const { self, log, go } = mk(opts);
  await go(...(args ?? []));
  assert.equal(log.deliver.length, 0, "nothing is pasted");
  assert.deepEqual(log.set, [], "the text stays in the box");
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
