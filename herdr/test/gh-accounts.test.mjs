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
  "export const exec = (cmd, args) => { const x = h(); x.calls.push([cmd, ...args]); return Promise.resolve(x.reply(args.slice(3))); };";
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
  { owner: "acct-a", rule: null, repos: [{ repo: "acct-a/notes", account: null, by: null, match: null }] },
], error: null };

function fake(over = {}) {
  globalThis.__herdr = {
    calls: [], clicks: {}, texts: [],
    spaces: [{ id: 1, folder: "/w/app", tabs: [{ id: 10 }] }, { id: 2, folder: "/m", machine: true, tabs: [] }],
    panes: [{ tab: 10, cwd: "/w/app" }, { tab: 10, cwd: "/w/notes" }, { tab: 99, cwd: "/elsewhere" }],
    reply: (a) => a[0] === "list" ? { code: 0, stdout: JSON.stringify(LIST), stderr: "" }
      : a[0] === "space" ? { code: 0, stdout: JSON.stringify(SPACE), stderr: "" }
      : { code: 0, stdout: "바꿨습니다", stderr: "" },
    ...over,
  };
  return globalThis.__herdr;
}
// cx.spawn 의 비동기 일을 모아 두었다가 settle 로 끝까지 기다린다.
function cxFake() {
  const jobs = [];
  const cx = { notify() {}, timer: { every() {} }, spawn: (fn) => { jobs.push(fn(cx)); } };
  cx.settle = async () => { while (jobs.length) await jobs.shift(); };
  return cx;
}
const cliArgs = (h) => h.calls.map((c) => { assert.equal(c[0], "env"); assert.equal(c[1], "HERDR_APP_HOME=/app"); assert.equal(c[3], "/app/gh-account/gh-account.cjs"); return c.slice(4); });

test("불러오기: 계정·규칙을 읽고, 기계 스페이스는 빼고 스페이스 폴더와 그 탭의 터미널 폴더만 넘긴다", async () => {
  const h = fake();
  const cx = cxFake();
  const v = new Accounts();
  v.init({}, cx);
  await cx.settle();
  assert.deepEqual(cliArgs(h), [["list", "--json"], ["space", "--json", "/w/app", "/w/notes"]]);
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0].owners.length, 2);
  v.render(cx);
  for (const s of ["app", "example-org/*", "acct-a/*", "매핑 없음 · gh 활성 계정", "acct-a", "acct-b"]) assert.ok(h.texts.includes(s), s);
});

test("바꾸기: 규칙 순서·지우기·스페이스 한 번에 고르기가 gh-account 명령으로 가고, 바꾼 뒤 다시 읽는다", async () => {
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
  h.calls.length = 0;
  v.change(cx, ["assign", "acct-a", "/w/app", "/w/notes"]);
  v.change(cx, ["default", "acct-a"]); // 바꾸는 중에는 두 번째를 받지 않는다.
  await cx.settle();
  assert.deepEqual(cliArgs(h).filter((a) => a[0] !== "list" && a[0] !== "space"), [["assign", "acct-a", "/w/app", "/w/notes"]]);
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
  let h = fake({ reply: (a) => a[0] === "set" ? { code: 0, stdout: "규칙: x/* -> acct-c", stderr: "주의: acct-c 는 로그인돼 있지 않습니다" } : { code: 0, stdout: JSON.stringify(a[0] === "list" ? LIST : SPACE), stderr: "" } });
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
  assert.ok(h.texts.some((s) => s.includes("--gh-account")));
});
