// #92: a multi-tab AskUserQuestion on a PO (tabs + Submit) left the desk question box on "화면을 읽는 중…". Fake screens only: nothing here talks to a real terminal.
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

const QUESTION_TAB = `
 ← ☒ Scope  ☐ Priority  ✔ Submit →

 Which scope should the first release cover?

 ❯ 1. Core only
      Ship the inbox and nothing else
   2. Core + docs
      Also write the docs
   3. Type something.
   4. Chat about this

 Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
const SUBMIT_TAB = `
 ← ☒ Scope  ☒ Priority  ✔ Submit →

 Review your answers

  ● Which scope? → Core only

 Ready to submit your answers?

 ❯ 1. Submit answers
   2. Cancel
`;

test("#92 promptParse: 탭이 있는 질문 화면(선택지 아래 설명 줄)도 1..N 선택지와 탭 줄을 읽는다", () => {
  const p = I.promptParse(QUESTION_TAB);
  assert.deepEqual(p.options.map((o) => [o.key, o.label, o.on]), [["1", "Core only", true], ["2", "Core + docs", false], ["3", "Type something.", false], ["4", "Chat about this", false]]);
  assert.equal(p.tabs, "← ☒ Scope ☐ Priority ✔ Submit →");
  assert.match(p.head.join("\n"), /Which scope/);
  assert.deepEqual(I.promptOptions(QUESTION_TAB).map((o) => o.key), ["1", "2", "3", "4"]);
});

test("#92 promptParse: 마지막 탭(Submit·Cancel)은 2개 선택지, 설명 줄이 마지막 선택지 뒤에 와도 읽는다", () => {
  const p = I.promptParse(SUBMIT_TAB);
  assert.deepEqual(p.options.map((o) => o.key), ["1", "2"]);
  assert.equal(p.options[0].label, "Submit answers");
  assert.ok(p.tabs.includes("Submit"));
  const tail = I.promptParse(" Pick one\n\n ❯ 1. A\n      about A\n   2. B\n      about B\n      more about B\n\n Esc to cancel\n");
  assert.deepEqual(tail.options.map((o) => o.label), ["A", "B"]);
  assert.equal(tail.tabs, "");
});

test("#92 promptParse: 들여쓰지 않은 보통 글이나 먼 옛 목록은 선택지로 읽지 않는다", () => {
  assert.deepEqual(I.promptOptions("Proceed?\n 1. a\n 2. b\nnote about it"), []);
  assert.deepEqual(I.promptOptions("1. old\n2. old\n      desc\n" + "text\n".repeat(12) + "tail"), []);
  assert.deepEqual(I.promptOptions("Q?\n 1. a\n      d\n      d\n      d\n      d\n      d\n 2. b"), []); // 설명이 4줄을 넘으면 이어진 선택지가 아니다
  assert.deepEqual(I.promptOptions("  ❯ 1. Yes\n    2. No\n"), [{ key: "1", label: "Yes", on: true }, { key: "2", label: "No", on: false }]);
});

test("#92 promptSig: 같은 질문 탭이면 강조 위치가 달라도 같고, 다른 탭이면 다르다", () => {
  assert.equal(I.promptSig(QUESTION_TAB), I.promptSig(QUESTION_TAB.replace("❯ 1. Core only", "  1. Core only").replace("   2. Core + docs", " ❯ 2. Core + docs")));
  assert.notEqual(I.promptSig(QUESTION_TAB), I.promptSig(SUBMIT_TAB));
});

// A fake cx: spawn runs the async function with a fresh spawn cx; timers are kept and fired by hand. A render cx (`stale`) throws on notify/spawn-less use.
const mkCx = (name, log, opts = {}) => {
  const cx = { name, timers: [], notify() { if (opts.stale) throw new Error("stale cx"); log.push(`notify:${name}`); }, timer: { after(ms, f) { if (opts.stale) throw new Error("stale cx"); cx.timers.push({ ms, f }); } } };
  cx.spawn = (fn) => { const c2 = mkCx(`${name}>spawn`, log); cx.spawned = c2; Promise.resolve().then(() => fn(c2)); };
  return cx;
};
const mkSelf = (log) => ({
  prompt: null, promptBusy: false, promptBusyAt: 0, promptGen: 0, promptChain: 0,
  isBlocked: () => true,
  softNotify(c) { log.push(`soft:${c.name}`); c.notify(); },
});
const load = (hcImpl) => runMethod(mainSrc(), "  readPrompt(po, cx) {", "  // A key press from the question panel", {
  hc: hcImpl, promptSame: I.promptSame, PROMPT_TIMEOUT_MS: 5000, PROMPT_RETRY_MS: 2000, PROMPT_REFRESH_MS: 3000, PROMPT_LINES: 40,
}).readPrompt;

test("#92 readPrompt: 탭 화면을 읽으면 prompt가 채워지고, 다시 그리기·다음 읽기는 await 뒤에도 쓸 수 있는 spawn의 cx로 한다(렌더 cx는 이미 못 씀)", async () => {
  const log = [];
  const readPrompt = load(() => ({ code: 0, stdout: QUESTION_TAB }));
  const self = mkSelf(log);
  const render = mkCx("render", log, { stale: true }); // 렌더 cx는 await 뒤에 쓰면 던진다
  render.timer.after = (ms, f) => render.timers.push({ ms, f }); // 렌더 안에서 곧바로 거는 시간 제한은 된다
  readPrompt.call(self, "t9", render);
  assert.equal(self.prompt, null);
  await tick(); await tick();
  assert.equal(self.prompt.po, "t9");
  assert.equal(self.prompt.failed, false);
  assert.equal(I.promptParse(self.prompt.text).options.length, 4);
  assert.deepEqual(log, ["soft:render>spawn", "notify:render>spawn"]); // 다시 그리기는 spawn cx
  assert.equal(render.spawned.timers.length, 1); // 다음 읽기도 spawn cx에 건다
  assert.equal(render.spawned.timers[0].ms, 3100);
});

test("#92 readPrompt: 읽기가 끝내 안 돌아오면 시간 제한에서 '읽지 못함'으로 끝나고 다시 읽는다(읽는 중에 멈추지 않는다)", async () => {
  const log = [];
  let hang = true;
  const readPrompt = load(() => (hang ? new Promise(() => {}) : { code: 0, stdout: QUESTION_TAB }));
  const self = mkSelf(log);
  self.readPrompt = readPrompt; // 다시 읽기 타이머가 this.readPrompt를 부른다
  const render = mkCx("render", log);
  readPrompt.call(self, "t9", render);
  await tick();
  assert.equal(self.prompt, null);
  assert.equal(render.timers[0].ms, 5000);
  const t = mkCx("timer", log);
  render.timers[0].f(t); // 5초가 지남
  assert.equal(self.prompt.failed, true);
  assert.equal(self.prompt.text, "");
  assert.equal(self.promptBusy, false);
  assert.equal(t.timers[0].ms, 2100); // 2초 뒤에 다시 읽는다
  hang = false;
  const t2 = mkCx("retry", log);
  self.prompt.at -= 2100; // 가짜 타이머라 실제 시간이 안 흘렀으니 2초가 지난 것으로 한다
  t.timers[0].f(t2);
  await tick(); await tick();
  assert.equal(self.prompt.failed, false);
  assert.equal(I.promptOptions(self.prompt.text).length, 4);
});

test("#92 readPrompt: 실패 코드나 빈 화면도 prompt를 채우고(읽는 중으로 남지 않음), 실패는 2초 안에는 다시 읽지 않는다", async () => {
  for (const out of [{ code: 1, stdout: "" }, { code: 0, stdout: "   \n" }, null]) {
    const log = [];
    const readPrompt = load(() => out);
    const self = mkSelf(log);
    const render = mkCx("render", log);
    readPrompt.call(self, "t9", render);
    await tick(); await tick();
    assert.equal(self.prompt?.failed, true);
    const gen = self.promptGen;
    readPrompt.call(self, "t9", render); // 곧바로 또 그려도(2초 전) 읽기를 새로 시작하지 않는다
    assert.equal(self.promptGen, gen);
  }
  const log = [];
  const readPrompt = load(() => { throw new Error("boom"); });
  const self = mkSelf(log);
  readPrompt.call(self, "t9", mkCx("render", log));
  await tick(); await tick();
  assert.equal(self.prompt?.failed, true);
});

test("#92 readPrompt: 같은 화면이면 다시 그리지 않는다(바뀐 화면만 softNotify)", async () => {
  const log = [];
  const readPrompt = load(() => ({ code: 0, stdout: QUESTION_TAB }));
  const self = mkSelf(log);
  readPrompt.call(self, "t9", mkCx("r1", log));
  await tick(); await tick();
  const n = log.filter((x) => x.startsWith("soft:")).length;
  self.prompt.at = 0;
  readPrompt.call(self, "t9", mkCx("r2", log));
  await tick(); await tick();
  assert.equal(log.filter((x) => x.startsWith("soft:")).length, n);
});

test("#92 promptPanel: 막다른 길이 없다 — 터미널 열기(terminal.peek)와 다시 읽기가 늘 있고, 선택지를 못 찾으면 안내와 화면 원본, 탭이 있으면 ←/→ 키", () => {
  const src = mainSrc();
  const panel = methodOf(src, "  promptPanel(t, v, cx) {", "  // ---- \"PO 새로 시작\"");
  assert.match(panel, /"pp-term", "터미널 열기"/);
  assert.match(panel, /run\("terminal\.peek", \{ terminal: po \}\)/);
  assert.match(panel, /"pp-reread", "다시 읽기"/);
  assert.match(panel, /선택지를 찾지 못했습니다/);
  assert.match(panel, /화면을 읽지 못했습니다/);
  assert.match(panel, /key\("left", "← 이전 질문"/);
  assert.match(panel, /key\("right", "다음 질문 →"/);
  assert.match(panel, /try \{ this\.readPrompt\(po, cx\); \} catch/); // 읽기 시작이 던져도 패널은 그려진다
  assert.ok(!/hc\(\["keys"/.test(panel)); // 패널을 그리는 것만으로는 키를 보내지 않는다
  const rp = methodOf(src, "  readPrompt(po, cx) {", "  // A key press from the question panel");
  assert.ok(!/"keys"/.test(rp));
});

// ---- review round 1
test("#92 promptParse: 선택지 사이에 구분선(글자·숫자 없는 줄)이 끼어도 선택지와 탭 줄을 읽는다(│ 테두리가 있어도)", () => {
  const rule = "────────────────────────────────";
  const screen = (wrap) => [" ← ☒ Scope  ☐ Priority  ✔ Submit →", "", " Which scope?", "", " ❯ 1. A", "      about A", "   2. B", "      about B", "   3. Type something.", `   ${rule}`, "   4. Chat about this", "", " Enter to select · Esc to cancel"].map(wrap).join("\n");
  for (const wrap of [(l) => l, (l) => `│${l}│`]) {
    const p = I.promptParse(screen(wrap));
    assert.deepEqual(p.options.map((o) => o.key), ["1", "2", "3", "4"]);
    assert.equal(p.tabs, "← ☒ Scope ☐ Priority ✔ Submit →");
  }
  assert.equal(I.promptOptions(" Q?\n 1. a\n 2. b\n").length, 2); // without a rule line nothing changed
});

test("#92 promptParse: 질문 위 먼 곳의 화살표·체크 글자 줄은 탭 줄이 아니고, ←와 →가 함께 있어야 탭 줄이다", () => {
  const perm = (top) => `${top}\nout 1\nout 2\nout 3\nout 4\nDo you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n`;
  assert.equal(I.promptParse(perm("✔ tests pass → deploying")).tabs, "");
  assert.equal(I.promptParse(perm("Done ✔ → next")).tabs, "");
  assert.equal(I.promptParse("Done ✔ → next\nout\nout\nout\nout\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\n").tabs, "");
  assert.equal(I.promptParse(" ✔ Scope → Submit\n\n Which?\n ❯ 1. A\n   2. B\n").tabs, ""); // one arrow only
  assert.equal(I.promptParse(" ← ☒ Scope ✔ Submit →\n\n Which?\n ❯ 1. A\n   2. B\n").tabs, "← ☒ Scope ✔ Submit →");
});

test("#92 pressPrompt: 화면을 한 번도 못 본 상태(읽기 실패·빈 화면)에서는 빈 재읽기가 같아 보여도 키를 보내지 않는다", async () => {
  for (const shown of [{ po: "t9", at: 0, text: "", failed: true }, { po: "t9", at: 0, text: "", failed: false }]) {
    const calls = [];
    const say = [];
    const m = runMethod(mainSrc(), "  pressPrompt(po, key, c) {", "  promptPanel(t, v, cx) {", {
      hc: (a) => { calls.push(a); return { code: 0, stdout: "" }; }, promptSig: I.promptSig, PROMPT_LINES: 40,
    });
    const self = { prompt: shown, isBlocked: () => true, say: (t, bad) => say.push({ t, bad }) };
    for (const key of ["enter", "esc", "left", "right", "1"]) m.pressPrompt.call(self, "t9", key, { notify() {} });
    await tick(); await tick();
    assert.deepEqual(calls, [], "no read and no key");
    assert.equal(say.length, 5);
    assert.ok(say.every((s) => s.bad && /읽지 못해/.test(s.t)));
  }
});
