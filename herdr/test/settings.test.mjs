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
  "export const readTextFile = async (p) => (h().files[p] ?? null);";
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
  globalThis.__herdr = { props: {}, shared: {}, opened: [], closed: [], clicks: {}, texts: [], files: {}, ...over };
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
  for (const [section, body] of [["github", { mod: "gh-accounts" }], ["mods", { mod: "settings", props: { part: "mods" } }], ["nope", { mod: "gh-accounts" }], [undefined, { mod: "gh-accounts" }]]) {
    const w = settingsWindow(section);
    assert.equal(w.kind, "window");
    assert.equal(w.key, "settings");
    const [bar, main] = w.layout.children;
    assert.deepEqual(bar.content, { mod: "settings", props: { part: "bar" } });
    assert.equal(bar.window_drag, true);
    const [nav, content] = main.children;
    assert.equal(nav.content.props.part, "nav");
    assert.deepEqual(content.content, body);
  }
});

test("제목 줄의 닫기는 이 창의 overlay로 closeOverlay를 부른다", () => {
  const { h, c } = make("bar", { overlay: "ov-1" });
  h.clicks["settings-close"]({}, c);
  assert.deepEqual(h.closed, ["ov-1"]);
});

test("칸 목록: GitHub·모드는 눌러지고, 규칙·Claude 계정·UI 모드 글자 크기는 준비 중이라 눌러지지 않는다", () => {
  const { h } = make("nav", { section: "github" });
  assert.deepEqual(Object.keys(h.clicks).sort(), ["settings-nav-github", "settings-nav-mods"]);
  for (const s of ["규칙", "Claude 계정", "UI 모드 글자 크기", "GitHub", "모드"]) assert.ok(h.texts.includes(s), s);
  assert.equal(h.texts.filter((x) => x === "준비 중").length, 3);
});

test("칸을 누르면 마지막 칸을 기억하고 같은 키의 창을 그 칸으로 다시 연다", () => {
  const { h, c } = make("nav", { section: "github" });
  h.clicks["settings-nav-mods"]({}, c);
  assert.equal(h.shared["settings.section"], "mods");
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].key, "settings");
  assert.deepEqual(h.opened[0].layout.children[1].children[1].content, { mod: "settings", props: { part: "mods" } });
});

test("준비 중인 칸은 직접 불러도 창을 열지 않는다", () => {
  const { h, v } = make("nav", { section: "github" });
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

test("모드 칸: 모드 폴더의 mod.json 유무로 설치 여부를 보여 주고, 명령은 복사만 한다", async () => {
  const h = fake({ props: { part: "mods" }, files: { "/app/mods/tabs-mine/mod.json": "{}", "/app/mods/work/mod.json": "{}" } });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(v.installed["tabs-mine"], true);
  assert.equal(v.installed.inbox, false);
  h.texts.length = 0;
  v.render(c);
  assert.ok(h.texts.includes("설치됨") && h.texts.includes("설치 안 됨"));
  assert.ok(h.texts.includes("제거 명령 복사") && h.texts.includes("설치 명령 복사"));
  h.clicks["mod-copy-inbox"]({}, c);
  h.clicks["mod-copy-win-inbox"]({}, c);
  h.clicks["mod-copy-tabs-mine"]({}, c);
  assert.deepEqual(c.clip, ["sh herdr/install.sh --add inbox", "./herdr/install.ps1 -Add inbox", "sh herdr/install.sh --remove tabs-mine"]);
  assert.deepEqual(h.opened, []);
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
