// node --test herdr/test/settings.test.mjs
// 설정 창(settings/main.js)은 Herdr 전용 모듈을 불러오므로 호출을 기록하는 가짜 모듈로 바꿔 불러오기·그리기·누르기를 시험한다. 화면 모양은 보지 않는다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const stub = "const h = () => globalThis.__herdr;" +
  "const el = () => { let id = null; const p = new Proxy({}, { get: (_t, k) => (...a) => {" +
  "  if (k === 'when') { if (a[0]) a[1](p); return p; }" +
  "  if (k === 'id') id = a[0];" +
  "  if (k === 'on_click' && id) h().clicks[id] = a[0];" +
  "  if (k === 'child' || k === 'children') h().texts.push(...[].concat(a[0]).filter((x) => typeof x === 'string'));" +
  "  return p; } }); return p; };" +
  "export const View = class {}; export const div = el; export const svg = el; export const v_flex = el; export const h_flex = el;" +
  "export const theme = () => ({});" +
  "export const props = () => h().props;" +
  "export const appHome = () => '/app';" +
  "export const setShared = (k, v) => { h().shared[k] = v; };" +
  "export const openOverlay = (o) => { h().opened.push(o); };" +
  "export const closeOverlay = (id) => { h().closed.push(id); };" +
  "export const readTextFile = async (p) => (h().files[p] ?? null);" +
  "export const exec = async (c, a, o) => { h().execs.push({ c, a, o }); const r = h().execResult; return typeof r === 'function' ? r(c, a) : (r ?? { code: 0, stdout: '', stderr: '' }); };" +
  "export const window = () => ({ platform: h().platform ?? 'macos' });";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { default: Settings } = await import("../mods/settings/main.js");
const inst = createRequire(import.meta.url)("../install.cjs");

const SRC = { settings: fs.readFileSync(new URL("../mods/settings/main.js", import.meta.url), "utf8"), tabs: fs.readFileSync(new URL("../mods/tabs-mine/main.js", import.meta.url), "utf8") };
const block = (s) => s.match(/\/\/ settings-window:begin\n[\s\S]*?\/\/ settings-window:end/)?.[0];

function fake(over = {}) {
  globalThis.__herdr = { props: {}, shared: {}, opened: [], closed: [], clicks: {}, texts: [], files: {}, execs: [], ...over };
  return globalThis.__herdr;
}
const cx = () => ({ notified: 0, clip: [], notify() { this.notified++; }, write_to_clipboard(t) { this.clip.push(t); }, stop_propagation() {} });
const make = (part, extra = {}, over = {}) => {
  const h = fake({ props: { part, ...extra }, ...over });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  v.render(c);
  return { h, v, c };
};

test("설정 창 모양 블록은 tabs-mine과 settings에 똑같이 들어 있다", () => {
  assert.ok(block(SRC.settings), "settings");
  assert.equal(block(SRC.tabs), block(SRC.settings));
});

test("설정 창은 키 하나, 제목 줄·칸 목록·내용 블록으로 이뤄지고 모르는 칸은 GitHub로 간다", () => {
  // 블록 안의 settingsWindow를 꺼내 쓴다.
  const code = block(SRC.settings).replace(/^\/\/.*$/gm, "");
  const settingsWindow = new Function(`${code}\nreturn settingsWindow;`)();
  for (const [section, body] of [["accounts", { mod: "gh-accounts" }], ["github", { mod: "gh-accounts" }], ["mods", { mod: "settings", props: { part: "mods" } }], ["nope", { mod: "gh-accounts" }], [undefined, { mod: "gh-accounts" }]]) {
    const w = settingsWindow(section);
    assert.equal(w.kind, "window");
    assert.equal(w.key, "settings");
    const [bar, main] = w.layout.children;
    assert.deepEqual(bar.content, { mod: "settings", props: { part: "bar" } });
    assert.equal(bar.window_drag, true);
    const [nav, wrap] = main.children;
    assert.equal(nav.content.props.part, "nav");
    // 내용 칸 아래에 여백 칸이 있어 마지막 줄이 창 아래에 붙지 않는다
    const [content, pad] = wrap.children;
    assert.deepEqual(content.content, body);
    assert.deepEqual(pad.content, { mod: "settings", props: { part: "pad" } });
    assert.ok(pad.size.px >= 16);
    assert.ok(w.height >= 700);
  }
});

test("제목 줄의 닫기는 이 창의 overlay로 closeOverlay를 부른다", () => {
  const { h, c } = make("bar", { overlay: "ov-1" });
  h.clicks["settings-close"]({}, c);
  assert.deepEqual(h.closed, ["ov-1"]);
});

test("칸 목록: 계정·모드는 눌러지고, 규칙·Claude 계정·UI 모드 글자 크기는 준비 중이라 눌러지지 않는다", () => {
  const { h } = make("nav", { section: "accounts" });
  assert.deepEqual(Object.keys(h.clicks).sort(), ["settings-nav-accounts", "settings-nav-mods"]);
  for (const s of ["규칙", "Claude 계정", "UI 모드 글자 크기", "계정", "모드"]) assert.ok(h.texts.includes(s), s);
  assert.equal(h.texts.filter((x) => x === "준비 중").length, 3);
});

test("칸을 누르면 마지막 칸을 기억하고 같은 키의 창을 그 칸으로 다시 연다", () => {
  const { h, c } = make("nav", { section: "accounts" });
  h.clicks["settings-nav-mods"]({}, c);
  assert.equal(h.shared["settings.section"], "mods");
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].key, "settings");
  assert.deepEqual(h.opened[0].layout.children[1].children[1].children[0].content, { mod: "settings", props: { part: "mods" } });
});

test("준비 중인 칸은 직접 불러도 창을 열지 않는다", () => {
  const { h, v } = make("nav", { section: "accounts" });
  for (const id of ["rules", "claude", "fontsize", "없는칸"]) v.open(id);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.shared, {});
});

test("MODS 목록은 install.cjs의 모드·설명·기본 여부와 같다", () => {
  const h = fake();
  const v = new Settings();
  // MODS는 모듈 안에 있으므로 소스에서 꺼낸다.
  const code = SRC.settings.match(/const MODS = \[[\s\S]*?\n\];/)[0];
  const MODS = new Function(`${code}\nreturn MODS;`)();
  assert.deepEqual(MODS.map((m) => m.name), inst.ALL);
  for (const m of MODS) {
    assert.equal(m.desc, inst.MODS[m.name].desc, m.name);
    assert.equal(Boolean(m.core), inst.CORE.includes(m.name), m.name);
  }
  assert.ok(h && v);
});

const files = { "/app/mods/tabs-mine/mod.json": "{}", "/app/mods/work/mod.json": "{}", "/app/mods/inbox/mod.json": "{}" };
const RAW = "https://raw.githubusercontent.com/xowjd913/agent-mods/main/herdr";
async function mods(over = {}) {
  const h = fake({ props: { part: "mods" }, files: { ...files }, ...over });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  await new Promise((r) => setTimeout(r, 5));
  h.texts.length = 0;
  v.render(c);
  return { h, v, c };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("모드 칸: 모드 폴더의 mod.json 유무로 설치 여부를 보여 주고, 기본 모드에는 제거 버튼이 없다", async () => {
  const { h, v } = await mods();
  assert.equal(v.installed["tabs-mine"], true);
  assert.equal(v.installed.usage, undefined);
  assert.equal(v.installed["usage-status"], false);
  assert.ok(h.texts.includes("설치됨") && h.texts.includes("설치 안 됨"));
  // 설치 안 된 모드는 설치, 설치된 추가 모드는 제거, 설치된 기본 모드(settings 포함)는 제거 불가
  assert.ok(h.clicks["mod-add-usage-status"]);
  assert.ok(h.clicks["mod-remove-inbox"]);
  assert.ok(!h.clicks["mod-remove-tabs-mine"] && !h.clicks["mod-remove-work"]);
  assert.ok(!h.clicks["mod-remove-settings"]);
  assert.ok(h.texts.includes("기본 모드라 제거하지 않습니다"));
  assert.deepEqual(h.execs, []);
});

test("제거는 확인을 한 번 거친 뒤에야 설치기를 돌리고, 취소하면 아무것도 돌리지 않는다", async () => {
  const { h, v, c } = await mods();
  h.clicks["mod-remove-inbox"]({}, c);
  assert.equal(v.confirm, "inbox");
  assert.deepEqual(h.execs, []);
  h.texts.length = 0; v.render(c);
  assert.ok(h.clicks["mod-remove-yes-inbox"] && h.clicks["mod-remove-no-inbox"]);
  h.clicks["mod-remove-no-inbox"]({}, c);
  assert.equal(v.confirm, null);
  assert.deepEqual(h.execs, []);
  h.clicks["mod-remove-inbox"]({}, c);
  h.texts.length = 0; v.render(c);
  delete h.files["/app/mods/inbox/mod.json"]; // 설치기가 지운 것처럼
  h.clicks["mod-remove-yes-inbox"]({}, c);
  assert.equal(v.busy?.name, "inbox");
  await tick();
  assert.equal(h.execs.length, 1);
  assert.equal(h.execs[0].c, "env");
  assert.deepEqual(h.execs[0].a, ["HERDR_APP_HOME=/app", "sh", "-c", `curl -fsSL ${RAW}/install.sh | sh -s -- --remove inbox`]);
  assert.equal(v.busy, null);
  assert.equal(v.result.inbox.ok, true);
  assert.match(v.result.inbox.text, /다시 시작/);
  assert.equal(v.installed.inbox, false, "끝나면 설치 여부를 다시 읽는다");
});

test("설치 안 된 모드는 설치 버튼으로 --add를 돌리고, 도는 동안 다른 버튼은 눌러도 돌지 않는다", async () => {
  let release;
  const { h, v, c } = await mods({ execResult: () => new Promise((r) => { release = () => r({ code: 0, stdout: "ok", stderr: "" }); }) });
  h.clicks["mod-add-usage-status"]({}, c);
  assert.equal(v.busy.action, "add");
  v.run(c, "add", "path-menu"); // 도는 중에는 무시
  assert.equal(h.execs.length, 1);
  assert.deepEqual(h.execs[0].a.slice(-1), [`curl -fsSL ${RAW}/install.sh | sh -s -- --add usage-status`]);
  h.texts.length = 0; v.render(c);
  assert.ok(h.texts.includes("설치하는 중…"));
  release(); await tick();
  assert.equal(v.busy, null);
  assert.equal(v.result["usage-status"].ok, true);
});

test("설치기가 실패하면 오류를 보여 주고 명령 복사로 넘어갈 수 있다", async () => {
  const { h, v, c } = await mods({ execResult: { code: 1, stdout: "", stderr: "블록: tabs-mine 이(가) 기댑니다" } });
  v.run(c, "remove", "inbox");
  await tick();
  assert.equal(v.result.inbox.ok, false);
  assert.match(v.result.inbox.text, /실패했습니다\(1\).*기댑니다/);
  h.texts.length = 0; v.render(c);
  h.clicks["mod-copy-inbox"]({}, c);
  assert.deepEqual(c.clip, [`curl -fsSL ${RAW}/install.sh | sh -s -- --remove inbox`]);
});

test("설치기를 시작하지 못해도(예외) 깨지지 않고 오류로 남는다", async () => {
  const { v, c } = await mods({ execResult: () => { throw new Error("no sh"); } });
  v.run(c, "add", "usage-status");
  await tick();
  assert.equal(v.busy, null);
  assert.match(v.result["usage-status"].text, /시작하지 못했습니다: no sh/);
});

test("Windows에서는 PowerShell로 같은 설치기를 돌린다", async () => {
  const { h, v, c } = await mods({ platform: "windows" });
  v.run(c, "remove", "inbox");
  await tick();
  assert.equal(h.execs[0].c, "powershell.exe");
  assert.deepEqual(h.execs[0].a.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.equal(h.execs[0].a[2], `$env:HERDR_APP_HOME='/app'; & ([scriptblock]::Create((irm ${RAW}/install.ps1))) -Remove inbox`);
});

test("여백 칸은 비어 있는 배경만 그린다", () => {
  const { h } = make("pad");
  assert.deepEqual(h.clicks, {});
});

test("mod.json을 읽지 못하면 설치 안 됨으로 보여 주고 깨지지 않는다", async () => {
  const h = fake({ props: { part: "mods" } });
  globalThis.__herdr.files = new Proxy({}, { get() { throw new Error("읽기 실패"); } });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(Object.values(v.installed).every((x) => x === false));
});

test("tabs-mine의 설정 버튼은 settings 창을 열고 계정 패널 버튼은 없다", () => {
  assert.match(SRC.tabs, /h_flex\(\)\.id\("settings-open"\)/);
  assert.match(SRC.tabs, /openOverlay\(settingsWindow\(shared\(SETTINGS_SHARED\)\)\)/);
  assert.ok(!/accounts-board/.test(SRC.tabs));
});
