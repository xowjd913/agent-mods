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
  "export const shared = (k) => h().shared[k];" +
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
const REMOTE = (ref) => ({ "/app/mods/settings/.source.json": JSON.stringify({ kind: "remote", ref }) });
const LOCAL = (dir) => ({ "/app/mods/settings/.source.json": JSON.stringify({ kind: "local", dir }), [`${dir}/install.sh`]: "#!/bin/sh", [`${dir}\\install.ps1`]: "param()" });
const RAW = (ref = "main") => `https://raw.githubusercontent.com/xowjd913/agent-mods/${ref}/herdr`;
async function mods(over = {}, extra = REMOTE("main")) {
  const h = fake({ props: { part: "mods" }, files: { ...files, ...extra }, ...over });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  await new Promise((r) => setTimeout(r, 5));
  h.texts.length = 0;
  v.render(c);
  return { h, v, c };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const ask = (h, v, c, id) => { h.clicks[id]({}, c); h.texts.length = 0; v.render(c); };

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
  assert.ok(!h.clicks["mod-copy-inbox"], "돌릴 수 있으면 복사 버튼은 실패했을 때만");
  assert.deepEqual(h.execs, []);
});

test("제거는 확인을 한 번 거친 뒤에야 설치기를 돌리고, 취소하면 아무것도 돌리지 않는다", async () => {
  const { h, v, c } = await mods();
  ask(h, v, c, "mod-remove-inbox");
  assert.deepEqual(v.confirm, { name: "inbox", action: "remove" });
  assert.deepEqual(h.execs, []);
  assert.ok(h.clicks["mod-remove-yes-inbox"] && h.clicks["mod-remove-no-inbox"]);
  assert.ok(h.texts.some((x) => x.includes("설치기 출처: 원격 main")));
  h.clicks["mod-remove-no-inbox"]({}, c);
  assert.equal(v.confirm, null);
  assert.deepEqual(h.execs, []);
  ask(h, v, c, "mod-remove-inbox");
  delete h.files["/app/mods/inbox/mod.json"]; // 설치기가 지운 것처럼
  h.clicks["mod-remove-yes-inbox"]({}, c);
  assert.equal(h.shared["settings.busy"].name, "inbox");
  await tick();
  assert.equal(h.execs.length, 1);
  assert.equal(h.execs[0].c, "env");
  assert.deepEqual(h.execs[0].a, ["HERDR_APP_HOME=/app", "AGENT_MODS_REF=main", "sh", "-c", `curl -fsSL ${RAW()}/install.sh | sh -s -- --remove inbox`]);
  assert.equal(h.shared["settings.busy"], null);
  assert.equal(v.result.inbox.ok, true);
  assert.match(v.result.inbox.text, /다시 시작/);
  assert.equal(v.installed.inbox, false, "끝나면 설치 여부를 다시 읽는다");
});

test("설치는 설치된 모드 전체를 출처에서 다시 복사한다고 확인을 받은 뒤 --add를 돌리고, 도는 동안 다른 버튼은 돌지 않는다", async () => {
  let release;
  const { h, v, c } = await mods({ execResult: () => new Promise((r) => { release = () => r({ code: 0, stdout: "ok", stderr: "" }); }) });
  ask(h, v, c, "mod-add-usage-status");
  assert.ok(h.texts.some((x) => x.includes("설치된 모드 전체를 원격 main에서 다시 복사합니다")));
  assert.deepEqual(h.execs, []);
  h.clicks["mod-add-yes-usage-status"]({}, c);
  assert.equal(h.shared["settings.busy"].action, "add");
  v.run(c, "add", "path-menu"); // 도는 중에는 무시
  assert.equal(h.execs.length, 1);
  assert.deepEqual(h.execs[0].a.slice(-1), [`curl -fsSL ${RAW()}/install.sh | sh -s -- --add usage-status`]);
  h.texts.length = 0; v.render(c);
  assert.ok(h.texts.includes("설치하는 중…"));
  release(); await tick();
  assert.equal(h.shared["settings.busy"], null);
  assert.equal(v.result["usage-status"].ok, true);
});

test("원격 출처는 기록된 브랜치의 주소와 AGENT_MODS_REF로 돌리고 main을 못 박지 않는다", async () => {
  const { h, v, c } = await mods({}, REMOTE("feature/126-settings"));
  v.run(c, "add", "usage-status");
  await tick();
  assert.deepEqual(h.execs[0].a, ["HERDR_APP_HOME=/app", "AGENT_MODS_REF=feature/126-settings", "sh", "-c", `curl -fsSL ${RAW("feature/126-settings")}/install.sh | sh -s -- --add usage-status`]);
  assert.ok(!h.execs[0].a.join(" ").includes("/main/"));
});

test("복제본 출처는 그 폴더의 install.sh를 직접 돌린다(내려받지 않는다)", async () => {
  const { h, v, c } = await mods({}, LOCAL("/Users/me/agent-mods/herdr"));
  assert.equal(v.source.kind, "local");
  v.run(c, "remove", "inbox");
  await tick();
  assert.deepEqual(h.execs[0], { c: "env", a: ["HERDR_APP_HOME=/app", "sh", "/Users/me/agent-mods/herdr/install.sh", "--remove", "inbox"], o: { timeout: 600000 } });
  h.texts.length = 0; v.render(c);
  assert.ok(h.texts.some((x) => x.includes("설치 출처: 로컬 /Users/me/agent-mods/herdr")));
});

test("출처 기록이 없거나 복제본이 사라졌거나 깨졌으면 직접 돌리지 않고 명령 복사만 보여 준다", async () => {
  const cases = [
    ["기록 없음", {}, /기록\(\.source\.json\)이 없어/],
    ["복제본 사라짐", { "/app/mods/settings/.source.json": JSON.stringify({ kind: "local", dir: "/gone/herdr" }) }, /설치 스크립트가 없어/],
    ["깨진 JSON", { "/app/mods/settings/.source.json": "{oops" }, /기록\(\.source\.json\)이 없어/],
    ["위험한 브랜치", REMOTE("main; rm -rf ~"), /기록\(\.source\.json\)이 없어/],
  ];
  for (const [name, extra, text] of cases) {
    const { h, v, c } = await mods({}, extra);
    assert.ok(!canRunButtons(h), name);
    v.run(c, "remove", "inbox");
    await tick();
    assert.deepEqual(h.execs, [], name);
    assert.ok(h.texts.some((x) => text.test(x)), name);
    assert.ok(h.clicks["mod-copy-inbox"] && h.clicks["mod-copy-usage-status"], name);
    h.clicks["mod-copy-inbox"]({}, c);
    assert.equal(c.clip[0], `curl -fsSL ${RAW()}/install.sh | sh -s -- --remove inbox`, name);
  }
});
const canRunButtons = (h) => Object.keys(h.clicks).some((k) => /^mod-(add|remove)(-yes)?-/.test(k));

test("설치기가 실패하면 오류를 보여 주고 출처에 맞는 명령 복사로 넘어갈 수 있다", async () => {
  const { h, v, c } = await mods({ execResult: { code: 1, stdout: "", stderr: "블록: tabs-mine 이(가) 기댑니다" } }, REMOTE("dev"));
  v.run(c, "remove", "inbox");
  await tick();
  assert.equal(v.result.inbox.ok, false);
  assert.match(v.result.inbox.text, /실패했습니다\(1\).*기댑니다/);
  h.texts.length = 0; v.render(c);
  h.clicks["mod-copy-inbox"]({}, c);
  assert.deepEqual(c.clip, [`curl -fsSL ${RAW("dev")}/install.sh | AGENT_MODS_REF=dev sh -s -- --remove inbox`]);
});

test("설치기를 시작하지 못해도(예외) 깨지지 않고 오류로 남는다", async () => {
  const { h, v, c } = await mods({ execResult: () => { throw new Error("no sh"); } });
  v.run(c, "add", "usage-status");
  await tick();
  assert.equal(h.shared["settings.busy"], null);
  assert.match(v.result["usage-status"].text, /시작하지 못했습니다: no sh/);
});

test("도는 중 표시는 공유 값이라 창을 닫았다 다시 열어도 두 번째 실행을 막고, 끝나면 목록을 다시 읽는다", async () => {
  let release;
  const first = await mods({ execResult: () => new Promise((r) => { release = () => r({ code: 0, stdout: "", stderr: "" }); }) });
  first.v.run(first.c, "add", "usage-status");
  assert.equal(first.h.shared["settings.busy"].name, "usage-status");
  // 새 창(새 인스턴스)이 같은 공유 값을 본다.
  const h2 = fake({ props: { part: "mods" }, files: { ...files, ...REMOTE("main") }, shared: first.h.shared, execs: first.h.execs });
  const v2 = new Settings(); const c2 = cx();
  v2.init(h2.props, c2);
  await tick();
  v2.render(c2);
  assert.ok(h2.texts.some((x) => x.includes("usage-status 설치 중이라 기다립니다") || x === "설치하는 중…"));
  assert.ok(!h2.clicks["mod-add-path-menu"] || (h2.clicks["mod-add-path-menu"]({}, c2), v2.confirm === null));
  v2.run(c2, "add", "path-menu");
  assert.equal(h2.execs.length, 1, "두 번째 실행은 시작하지 않는다");
  // 끝나면 표시가 지워지고 새 창도 다시 읽는다.
  h2.files["/app/mods/usage-status/mod.json"] = "{}";
  release(); await tick();
  assert.equal(h2.shared["settings.busy"], null);
  v2.render(c2); await tick();
  assert.equal(v2.installed["usage-status"], true);
});

test("10분이 지난 도는 중 표시는 죽은 것으로 보고 무시한다", async () => {
  const { h, v, c } = await mods({ shared: { "settings.busy": { name: "work", action: "add", at: Date.now() - 11 * 60000 } } });
  v.run(c, "add", "usage-status");
  assert.equal(h.execs.length, 1);
  await tick(); // 첫 실행이 끝나야 전역 가짜 값이 섞이지 않는다
  const fresh = await mods({ shared: { "settings.busy": { name: "work", action: "add", at: Date.now() - 60000 } } });
  fresh.v.run(fresh.c, "add", "usage-status");
  assert.equal(fresh.h.execs.length, 0);
});

test("Windows에서는 PowerShell로 같은 출처의 설치기를 돌린다", async () => {
  const remote = await mods({ platform: "windows" }, REMOTE("feature/x"));
  remote.v.run(remote.c, "remove", "inbox");
  await tick();
  assert.equal(remote.h.execs[0].c, "powershell.exe");
  assert.deepEqual(remote.h.execs[0].a.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.equal(remote.h.execs[0].a[2], `$env:HERDR_APP_HOME='/app'; $env:AGENT_MODS_REF='feature/x'; & ([scriptblock]::Create((irm ${RAW("feature/x")}/install.ps1))) -Remove inbox`);
  const local = await mods({ platform: "windows" }, LOCAL("C:\\src\\herdr"));
  local.v.run(local.c, "add", "usage-status");
  await tick();
  assert.deepEqual(local.h.execs[0].a, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$env:HERDR_APP_HOME='/app'; & 'C:\\src\\herdr\\install.ps1' -Add usage-status`]);
});

test("실행 경로에 main 브랜치를 못 박은 곳이 없다", () => {
  const code = SRC.settings.match(/const REPO_RAW[\s\S]*?const setBusy/)[0];
  assert.ok(!/\/main\/|"main"|'main'/.test(code.replace(/\/\/.*$/gm, "").replace(/const ref = src\?\.kind === "remote" \? src\.ref : "main";/, "")), "복사 안내의 main 한 줄 말고는 없다");
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
