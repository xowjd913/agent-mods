// node --test herdr/test/gh-accounts.test.mjs
// 계정 패널(main.js)은 Herdr 전용 모듈을 불러오므로, 호출을 기록하는 가짜 모듈로 바꿔 불러오기·그리기·바꾸기를 시험한다. 화면 모양은 보지 않는다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const stub = "const h = () => globalThis.__herdr;" +
  // 어떤 메서드를 불러도 자기를 돌려주는 가짜 요소. when 은 조건이 참이면 함수를 부르고, on_click 은 id 별로 모은다.
  "const el = () => { let id = null; const p = new Proxy({}, { get: (_t, k) => (...a) => {" +
  "  if (k === 'when') { if (a[0]) a[1](p); return p; }" +
  "  if (k === 'id') id = a[0];" +
  "  if (k === 'on_click' && id) h().clicks[id] = a[0];" +
  "  if (k === 'child' || k === 'children') h().texts.push(...[].concat(a[0]).filter((x) => typeof x === 'string'));" +
  "  return p; } }); return p; };" +
  "export const View = class {}; export const div = el; export const svg = el; export const v_flex = el; export const h_flex = el;" +
  "export const Input = { new: el };" +
  "export const Popover = { new: el };" +
  "export const InputState = { new: (o) => { let v = o.value; return { on() {}, value: () => v, set_value: (x) => { v = x; } }; } };" +
  "export const theme = () => ({});" +
  "export const appHome = () => '/app';" +
  "export const checking = () => false;" +
  "export const spaces = () => h().spaces;" +
  "export const panes = () => h().panes;" +
  "export const window = () => ({ platform: 'macos' });" +
  // gh-account 호출이면 cli 경로 뒤의 인자만 reply 에 넘긴다(PATH= 인자가 끼어도 같다). 다른 명령(open, sh)은 기록만 한다.
  "export const exec = (cmd, args) => { const x = h(); x.calls.push([cmd, ...args]);" +
  "  const i = args.indexOf('node'); if (cmd !== 'env' || i < 0) return Promise.resolve({ code: 0, stdout: '', stderr: '' });" +
  "  return Promise.resolve(x.reply(args.slice(i + 2))); };";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { default: Accounts } = await import("../mods/gh-accounts/main.js");

const LIST = { accounts: [{ login: "acct-a", active: true, state: "success" }, { login: "acct-b", active: false, state: "success" }],
  map: { rules: [{ match: "example-org/*", account: "acct-b" }], default: null, accounts: {} }, error: null };
const SPACE = { owners: [
  { owner: "example-org", rule: "acct-b", repos: [{ repo: "example-org/app", account: "acct-b", by: "rule", match: "example-org/*" }] },
  { owner: "acct-a", personal: true, rule: null, repos: [{ repo: "acct-a/notes", account: null, by: null, match: null }] },
], error: null };

const STATUS = { installed: true, binDir: "/h/.local/bin", files: [], filesOk: true, block: true, globalConfig: "/h/.gitconfig", git: "2.45.0", identity: true,
  inPath: true, wrapperFirst: true, firstGh: "/h/.local/bin", app: "/app/gh-account/gh-account.cjs", appCurrent: true,
  map: { path: "/app/gh-accounts.json", ok: true, rules: 1, default: null, error: null } };
const ok = (j) => ({ code: 0, stdout: typeof j === "string" ? j : JSON.stringify(j), stderr: "" });
// 읽기 명령의 기본 답. 없으면 undefined 를 돌려 각 시험이 정한다.
function base(a) {
  if (a[0] === "shell-path") return ok("/h/.local/bin:/usr/bin:/bin");
  if (a[0] === "list") return ok(LIST);
  if (a[0] === "space") return ok(SPACE);
  if (a[0] === "status") return ok(STATUS);
  if (a[0] === "login" && a[1] === "status") return ok({ state: "none" });
  return undefined;
}

function fake(over = {}) {
  globalThis.__herdr = {
    calls: [], clicks: {}, texts: [],
    spaces: [{ id: 1, folder: "/w/app", tabs: [{ id: 10 }] }, { id: 2, folder: "/m", machine: true, tabs: [] }],
    panes: [{ tab: 10, cwd: "/w/app" }, { tab: 10, cwd: "/w/notes" }, { tab: 99, cwd: "/elsewhere" }],
    reply: (a) => base(a) ?? { code: 0, stdout: "바꿨습니다", stderr: "" },
    ...over,
  };
  return globalThis.__herdr;
}
// cx.spawn 의 비동기 일을 모아 두었다가 settle 로 끝까지 기다린다.
function cxFake() {
  const jobs = [];
  const timers = [];
  const cx = { notify() {}, timer: { every(ms, fn) { timers.push({ ms, fn }); } }, spawn: (fn) => { jobs.push(fn(cx)); } };
  cx.tick = (ms) => { for (const t of timers) if (t.ms === ms) t.fn(cx); };
  cx.settle = async () => { while (jobs.length) await jobs.shift(); };
  return cx;
}
// gh-account 호출의 인자만 뽑는다. 첫 호출(shell-path) 뒤로는 로그인 셸 PATH 를 함께 넘겨야 한다.
const CLI = "/app/mods/gh-accounts/gh-account.cjs";
const cliArgs = (h) => h.calls.filter((c) => c[0] === "env").map((c) => {
  assert.equal(c[1], "HERDR_APP_HOME=/app");
  const i = c.indexOf("node");
  assert.equal(c[i + 1], CLI);
  if (c[i + 2] !== "shell-path") assert.equal(c[2], "PATH=/h/.local/bin:/usr/bin:/bin");
  return c.slice(i + 2);
});
const changes = (h) => cliArgs(h).filter((a) => !["list", "space", "status", "shell-path"].includes(a[0]) && !(a[0] === "login" && a[1] === "status"));
async function open(over) {
  const h = fake(over);
  const cx = cxFake();
  const v = new Accounts();
  v.init({}, cx);
  await cx.settle();
  return { h, cx, v };
}

test("불러오기: 계정·규칙을 읽고, 기계 스페이스는 빼고 스페이스 폴더와 그 탭의 터미널 폴더만 넘긴다", async () => {
  const h = fake();
  const cx = cxFake();
  const v = new Accounts();
  v.init({}, cx);
  await cx.settle();
  assert.deepEqual(cliArgs(h), [["shell-path"], ["list", "--json"], ["status", "--json"], ["login", "status", "--json"], ["space", "--json", "/w/app", "/w/notes"]]);
  assert.deepEqual(v.owners.map((o) => o.owner), ["example-org", "acct-a"]);
  v.render(cx);
  for (const s of ["example-org/*", "acct-a/*", "저장소 1", "acct-a", "acct-b"]) assert.ok(h.texts.includes(s), s);
  // 저장소 목록은 접혀 있다가 owner 줄을 누르면 펼친다. 다시 누르면 접는다.
  assert.ok(!h.texts.includes("매핑 없음 · gh 활성 계정"));
  h.clicks["own-fold-acct-a"]({}, cx);
  h.texts.length = 0;
  v.render(cx);
  for (const s of ["notes", "매핑 없음 · gh 활성 계정"]) assert.ok(h.texts.includes(s), s);
  assert.ok(!h.texts.includes("app"), "example-org 는 접혀 있다");
  h.clicks["own-fold-acct-a"]({}, cx);
  h.texts.length = 0;
  v.render(cx);
  assert.ok(!h.texts.includes("notes"));
});

test("스페이스: 폴더가 같은 스페이스가 여럿이어도 space 는 한 번, 같은 폴더도 한 번만 넘기고 owner 줄도 한 번만 나온다", async () => {
  const { h, cx, v } = await open({
    spaces: [{ id: 1, folder: "/w/app", tabs: [{ id: 10 }] }, { id: 3, folder: "/w/app", tabs: [{ id: 30 }] }, { id: 2, folder: "/m", machine: true, tabs: [] }],
    panes: [{ tab: 10, cwd: "/w/app" }, { tab: 30, cwd: "/w/notes" }, { tab: 30, cwd: "/w/app" }],
  });
  assert.deepEqual(cliArgs(h).filter((a) => a[0] === "space"), [["space", "--json", "/w/app", "/w/notes"]]);
  v.render(cx);
  assert.deepEqual(v.owners.map((o) => o.owner), ["example-org", "acct-a"]);
  assert.equal(h.texts.filter((s) => s === "저장소 1").length, 2);
  assert.deepEqual(v.targetItems().map((i) => i.label), ["app (스페이스 폴더)", "example-org/app", "acct-a/notes"]);
  // 스페이스마다 있던 "여러 계정" 드롭다운은 없다.
  assert.ok(!Object.keys(h.clicks).some((k) => k.startsWith("sp-")));
});

test("바꾸기: 규칙 지우기·owner 계정 고르기가 gh-account 명령으로 가고, 바꾼 뒤 다시 읽는다", async () => {
  const h = fake();
  const cx = cxFake();
  const v = new Accounts();
  v.init({}, cx);
  await cx.settle();
  v.render(cx);
  h.calls.length = 0;
  h.clicks["rule-del-0"]({}, cx);
  await cx.settle();
  assert.deepEqual(cliArgs(h)[0], ["unset", "example-org/*"]);
  assert.deepEqual(cliArgs(h)[1], ["list", "--json"]);
  assert.deepEqual(v.note, { text: "바꿨습니다", bad: false });
  // owner 드롭다운: 0 = 규칙 없음, 2 = acct-a, 3 = acct-b.
  v.render(cx);
  h.calls.length = 0;
  h.clicks["own-acct-a-i2"]({}, cx);
  await cx.settle();
  v.render(cx);
  h.clicks["own-example-org-i0"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["set", "acct-a/*", "acct-a"], ["unset", "example-org/*"]]);
  h.calls.length = 0;
  v.change(cx, ["set", "acct-a/*", "acct-a"]);
  v.change(cx, ["default", "none"]); // 바꾸는 중에는 두 번째를 받지 않는다.
  await cx.settle();
  assert.deepEqual(changes(h), [["set", "acct-a/*", "acct-a"]]);
});

test("기본 계정: 고르면 바로 바꾸지 않고 쓸 저장소·그대로 둘 저장소를 보여 준 뒤, 바꾸기를 눌러야 바꾼다", async () => {
  let def = null;
  const { h, cx, v } = await open({ reply: (a) => a[0] === "default" ? (def = a[1] === "none" ? null : a[1], ok("바꿨습니다"))
    : a[0] === "list" ? ok({ ...LIST, map: { ...LIST.map, default: def } }) : base(a) });
  v.render(cx);
  h.calls.length = 0;
  // 기본 드롭다운: 3 = acct-b. acct-a/notes 는 로그인된 acct-a 의 저장소라 acct-a 를 그대로 쓴다. example-org/app 은 규칙이 있어 빠진다.
  h.clicks["default-i3"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), []);
  assert.deepEqual(v.defaultAsk, { account: "acct-b", uses: [], keeps: ["acct-a/notes"] });
  h.texts.length = 0;
  v.render(cx);
  for (const s of ["기본 계정을 acct-b 로 바꿀까요?", "로그인된 계정의 저장소라 그 계정을 그대로 씀: acct-a/notes"]) assert.ok(h.texts.includes(s), s);
  h.clicks["default-cancel"]({}, cx);
  await cx.settle();
  assert.equal(v.defaultAsk, null);
  assert.deepEqual(changes(h), []);

  v.render(cx);
  h.clicks["default-i2"]({}, cx);
  assert.deepEqual(v.defaultAsk, { account: "acct-a", uses: ["acct-a/notes"], keeps: [] });
  v.render(cx);
  h.clicks["default-go"]({}, cx);
  await cx.settle();
  assert.equal(v.defaultAsk, null);
  assert.deepEqual(changes(h), [["default", "acct-a"]]);

  // 없음은 확인 없이 바로 바꾼다.
  h.calls.length = 0;
  v.render(cx);
  h.clicks["default-i0"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["default", "none"]]);
});

test("규칙 더하기: 모양이 틀리거나 계정이 없으면 명령을 부르지 않는다", async () => {
  const h = fake();
  const cx = cxFake();
  const v = new Accounts();
  v.init({}, cx);
  await cx.settle();
  h.calls.length = 0;
  v.ruleInput.set_value("not a rule");
  v.newAcct = "acct-b";
  v.addRule(cx);
  assert.equal(v.note.bad, true);
  v.ruleInput.set_value("example-org/tools");
  v.newAcct = null;
  v.addRule(cx);
  assert.equal(h.calls.length, 0);
  v.newAcct = "acct-a";
  v.addRule(cx);
  await cx.settle();
  assert.deepEqual(cliArgs(h)[0], ["set", "example-org/tools", "acct-a"]);
  assert.equal(v.ruleInput.value(), "");
});

test("주의 줄이나 실패는 눈에 띄게, 도구가 없으면 설치 안내를 보여 준다", async () => {
  let h = fake({ reply: (a) => a[0] === "set" ? { code: 0, stdout: "규칙: x/* -> acct-c", stderr: "주의: acct-c 는 로그인돼 있지 않습니다" } : base(a) });
  let cx = cxFake();
  const v = new Accounts();
  v.init({}, cx);
  await cx.settle();
  v.change(cx, ["set", "x/*", "acct-c"]);
  await cx.settle();
  assert.equal(v.note.bad, true);
  assert.match(v.note.text, /주의:/);

  h = fake({ reply: () => ({ code: 1, stdout: "", stderr: "Error: Cannot find module '/app/gh-account/gh-account.cjs'" }) });
  cx = cxFake();
  const w = new Accounts();
  w.init({}, cx);
  await cx.settle();
  assert.equal(w.missing, true);
  assert.equal(h.calls.length, 1);
  w.render(cx);
  assert.ok(h.texts.some((s) => s.includes("--add gh-accounts")));
});

test("설치: 바뀔 것을 먼저 읽어 보여 주고, 확인을 눌러야 설치한다. 다른 파일이 있으면 설치 단추가 듣지 않는다", async () => {
  const PLAN = { supported: true, binDir: "/h/.local/bin", files: [], blocked: [], lines: ["설치 폴더: /h/.local/bin", "  새로 만듦: /h/.local/bin/gh"] };
  let plan = PLAN;
  const { h, cx, v } = await open({ reply: (a) => base(a) ?? (a[1] === "--dry-run" ? ok(plan) : ok("설치: /h/.local/bin 에 gh")) });
  v.render(cx);
  h.calls.length = 0;
  h.clicks["inst-install"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["install", "--dry-run", "--json"]]);
  assert.equal(v.plan.kind, "install");
  h.texts.length = 0;
  v.render(cx);
  assert.ok(h.texts.includes("  새로 만듦: /h/.local/bin/gh"));
  h.clicks["plan-cancel"]({}, cx);
  assert.equal(v.plan, null);
  assert.deepEqual(changes(h), [["install", "--dry-run", "--json"]]);

  plan = { ...PLAN, blocked: ["/h/.local/bin/gh"] };
  v.render(cx);
  h.clicks["inst-install"]({}, cx);
  await cx.settle();
  v.render(cx);
  h.clicks["plan-go"]({}, cx);
  await cx.settle();
  assert.ok(!changes(h).some((a) => a[0] === "install" && a.length === 1), "막힌 계획은 설치하지 않는다");

  plan = PLAN;
  v.plan = null;
  v.render(cx);
  h.clicks["inst-install"]({}, cx);
  await cx.settle();
  v.render(cx);
  h.calls.length = 0;
  h.clicks["plan-go"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["install"]]);
  assert.ok(cliArgs(h).some((a) => a[0] === "status"), "설치 뒤 다시 읽는다");
  assert.equal(v.plan, null);
  assert.equal(v.note.bad, false);

  h.calls.length = 0;
  v.render(cx);
  h.clicks["inst-uninstall"]({}, cx);
  await cx.settle();
  assert.equal(v.plan.kind, "uninstall");
  v.render(cx);
  h.clicks["plan-go"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["uninstall", "--dry-run", "--json"], ["uninstall"]]);
});

test("설치 안 됨: 상태와 설치 단추만 보이고 되돌리기 단추는 없다", async () => {
  const { h, cx, v } = await open({ reply: (a) => a[0] === "status" ? ok({ ...STATUS, installed: false, block: false, binDir: null }) : base(a) });
  v.render(cx);
  assert.ok(h.texts.some((s) => s.startsWith("설치 안 됨")));
  assert.ok(h.clicks["inst-install"]);
  assert.equal(h.clicks["inst-uninstall"], undefined);
});

test("이 저장소는 어느 계정?: 고른 폴더나 적은 owner/repo 를 check 로 보고, 접속 시험은 --test 를 붙인다", async () => {
  const CHECK = { repo: "example-org/app", dir: "/w/app", remote: "https://github.com/example-org/app.git", mapOk: true, error: null,
    account: "acct-b", by: "rule", match: "example-org/*", active: "acct-a", accounts: ["acct-a", "acct-b"], loggedIn: true, installed: true, wrapperFirst: true,
    gh: { account: "acct-b", how: "mapped" }, push: { account: "acct-b", how: "mapped" },
    identity: { name: "Person B", email: "user@example.com", how: "mapped", origin: null }, warn: [], test: null };
  const { h, cx, v } = await open({ reply: (a) => base(a) ?? (a[0] === "check"
    ? ok(a.includes("--test") ? { ...CHECK, test: { ok: true, login: "acct-b", access: "push" } } : CHECK) : undefined) });
  const items = v.targetItems();
  assert.deepEqual(items.map((i) => i.label), ["app (스페이스 폴더)", "example-org/app", "acct-a/notes"]);
  h.calls.length = 0;
  v.pickTarget(cx, items[0]);
  await cx.settle();
  assert.deepEqual(changes(h), [["check", "/w/app", "--json"]]);
  h.texts.length = 0;
  v.render(cx);
  for (const s of ["example-org/app", "acct-b", "Person B <user@example.com>", "매핑 계정 토큰"]) assert.ok(h.texts.includes(s), s);
  h.clicks["chk-test"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h).pop(), ["check", "/w/app", "--json", "--test"]);
  h.texts.length = 0;
  v.render(cx);
  assert.ok(h.texts.some((s) => s.startsWith("접속 시험 성공 · acct-b 계정으로 접속 · push 가능")));

  h.calls.length = 0;
  v.targetInput.set_value("example-org/other");
  v.typedTarget(cx);
  await cx.settle();
  v.targetInput.set_value("~/work/app");
  v.typedTarget(cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["check", "-R", "example-org/other", "--json"], ["check", "~/work/app", "--json"]]);
});

test("계정 추가: 확인 카드를 거쳐 시작하고, 코드를 보여 준 뒤 끝나면 더한 계정과 되돌린 결과를 알린다", async () => {
  let st = { state: "none" };
  const { h, cx, v } = await open({ reply: (a) => a[0] === "login" && a[1] === "status" ? ok(st)
    : a[0] === "login" && a[1] === "start" ? (st = { state: "starting", prev: "acct-a" }, ok({ ok: true, login: st }))
    : base(a) ?? ok("") });
  v.render(cx);
  h.calls.length = 0;
  h.clicks["login-add"]({}, cx);
  assert.equal(v.loginAsk, true);
  assert.equal(changes(h).length, 0, "확인 전에는 아무것도 부르지 않는다");
  h.texts.length = 0;
  v.render(cx);
  assert.ok(h.texts.some((s) => s.includes("원래 활성 계정(acct-a)으로 한 번 되돌립니다")));
  assert.ok(h.texts.some((s) => s.includes("다른 세션이 gh 명령이나 git push 를 하는 중이면 누르지 마세요")));
  h.clicks["login-go"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["login", "start", "--json"]]);
  assert.equal(v.login.state, "starting");

  st = { state: "waiting", prev: "acct-a", pid: 42, code: "ABCD-1234", url: "https://github.com/login/device" };
  cx.tick(2000);
  await cx.settle();
  assert.equal(v.login.code, "ABCD-1234");
  h.texts.length = 0;
  v.render(cx);
  assert.ok(h.texts.includes("ABCD-1234"));
  h.calls.length = 0;
  h.clicks["login-copy"]({}, cx);
  h.clicks["login-open"]({}, cx);
  assert.deepEqual(h.calls.map((c) => c[0]), ["sh", "open"]);
  assert.equal(h.calls[0][4], "ABCD-1234");
  assert.deepEqual(h.calls[1], ["open", "https://github.com/login/device"]);

  st = { state: "done", prev: "acct-a", added: "acct-c", restored: true, switched: true, message: null };
  h.calls.length = 0;
  cx.tick(2000);
  await cx.settle();
  assert.equal(v.login, null);
  assert.deepEqual(v.note, { text: "acct-c 계정을 더했습니다. gh 활성 계정은 acct-a 그대로입니다.", bad: false });
  assert.ok(cliArgs(h).some((a) => a[0] === "list"), "끝나면 계정 목록을 다시 읽는다");
  h.calls.length = 0;
  cx.tick(2000);
  await cx.settle();
  assert.equal(h.calls.length, 0, "진행 중이 아니면 상태를 묻지 않는다");
});

test("계정 추가: 되돌리기 실패·로그인 실패는 붉게 알리고, 패널을 다시 열면 진행 중인 추가를 이어 보여 준다", async () => {
  let st = { state: "waiting", prev: "acct-a", pid: 42, code: "WXYZ-9876", url: null };
  const { h, cx, v } = await open({ reply: (a) => a[0] === "login" && a[1] === "status" ? ok(st) : base(a) ?? ok("") });
  assert.equal(v.login.code, "WXYZ-9876");
  v.render(cx);
  h.calls.length = 0;
  h.clicks["login-cancel"]({}, cx);
  await cx.settle();
  assert.deepEqual(changes(h), [["login", "cancel"]]);
  st = { state: "done", prev: "acct-a", added: "acct-c", restored: false, switched: false, message: "gh 활성 계정을 acct-a(으)로 되돌리지 못했습니다." };
  cx.tick(2000);
  await cx.settle();
  assert.equal(v.note.bad, true);
  assert.match(v.note.text, /되돌리지 못했습니다/);

  st = { state: "waiting", prev: "acct-a", pid: 42, code: "WXYZ-9876" };
  v.login = st;
  st = { state: "failed", message: "gh auth login 이 실패했습니다: denied" };
  cx.tick(2000);
  await cx.settle();
  assert.deepEqual(v.note, { text: "gh auth login 이 실패했습니다: denied", bad: true });
});
