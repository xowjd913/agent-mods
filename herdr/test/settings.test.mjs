// node --test herdr/test/settings.test.mjs
// 설정 창(settings/main.js)은 Herdr 전용 모듈을 불러오므로 호출을 기록하는 가짜 모듈로 바꿔 불러오기·그리기·누르기를 시험한다. 화면 모양은 보지 않는다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stub = "const h = () => globalThis.__herdr;" +
  "const el = () => { let id = null; const p = new Proxy({}, { get: (_t, k) => (...a) => {" +
  "  if (k === 'when') { if (a[0]) a[1](p); return p; }" +
  "  if (k === 'id') id = a[0];" +
  "  if (k === 'on_click' && id) h().clicks[id] = a[0];" +
  "  if ((k === 'pr' || k === 'mr') && id) h().pr[id] = a[0];" +
  "  if (k === 'child' || k === 'children') h().texts.push(...[].concat(a[0]).filter((x) => typeof x === 'string'));" +
  "  return p; } }); return p; };" +
  "export const View = class {}; export const div = el; export const svg = el; export const v_flex = el; export const h_flex = el;" +
  "export const InputState = { new: (o) => ({ v: String(o?.value ?? ''), placeholder: o?.placeholder, value() { return this.v; }, set_value(x) { this.v = String(x); }, on() {} }) };" +
  "export const Input = { new: () => el() };" +
  "export const theme = () => ({});" +
  "export const props = () => h().props;" +
  "export const appHome = () => '/app';" +
  "export const shared = (k) => h().shared[k];" +
  "export const setShared = (k, v) => { h().shared[k] = v; };" +
  "export const openOverlay = (o) => { h().opened.push(o); };" +
  "export const closeOverlay = (id) => { h().closed.push(id); };" +
  "export const readTextFile = async (p) => (h().files[p] ?? null);" +
  "export const exec = async (c, a, o) => { h().execs.push({ c, a, o }); const r = h().execResult; return typeof r === 'function' ? r(c, a) : (r ?? { code: 0, stdout: '', stderr: '' }); };" +
  "export const settings = () => { const s = h().settings; if (s === 'boom') throw new Error('x'); return s ?? {}; };" +
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
  globalThis.__herdr = { props: {}, shared: {}, opened: [], closed: [], clicks: {}, texts: [], pr: {}, files: {}, execs: [], ...over };
  return globalThis.__herdr;
}
const cx = () => { const c = { notified: 0, clip: [], timers: [], notify() { this.notified++; }, write_to_clipboard(t) { this.clip.push(t); }, stop_propagation() {} }; c.timer = { every: (ms, fn) => c.timers.push({ ms, fn }) }; return c; };
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
  for (const [section, body] of [["accounts", { mod: "gh-accounts" }], ["github", { mod: "gh-accounts" }], ["mods", { mod: "settings", props: { part: "mods" } }], ["rules", { mod: "settings", props: { part: "rules" } }], ["fontsize", { mod: "settings", props: { part: "fontsize" } }], ["nope", { mod: "gh-accounts" }], [undefined, { mod: "gh-accounts" }]]) {
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

test("칸 목록: 계정·모드·규칙·UI 모드 글자 크기가 모두 눌러지고 준비 중인 칸은 없다. Claude 계정 줄은 없다(계정 칸에 들어 있다)", () => {
  const { h } = make("nav", { section: "accounts" });
  assert.deepEqual(Object.keys(h.clicks).sort(), ["settings-nav-accounts", "settings-nav-fontsize", "settings-nav-mods", "settings-nav-rules"]);
  for (const s of ["규칙", "UI 모드 글자 크기", "계정", "모드"]) assert.ok(h.texts.includes(s), s);
  assert.ok(!h.texts.includes("Claude 계정"));
  assert.equal(h.texts.filter((x) => x === "준비 중").length, 0);
  const sections = new Function(`${SRC.settings.match(/const SECTIONS = \[[\s\S]*?\n\];/)[0]}\nreturn SECTIONS;`)();
  assert.ok(!sections.some((x) => x.soon), "준비 중 칸이 남아 있지 않다");
  const acc = sections.find((x) => x.id === "accounts");
  assert.ok(/GitHub/.test(acc.hint) && /Claude/.test(acc.hint), "계정 칸 설명이 GitHub와 Claude를 말한다");
  assert.ok(!sections.some((x) => x.id === "claude"));
});

test("칸을 누르면 마지막 칸을 기억하고 같은 키의 창을 그 칸으로 다시 연다", () => {
  const { h, c } = make("nav", { section: "accounts" });
  h.clicks["settings-nav-mods"]({}, c);
  assert.equal(h.shared["settings.section"], "mods");
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].key, "settings");
  assert.deepEqual(h.opened[0].layout.children[1].children[1].children[0].content, { mod: "settings", props: { part: "mods" } });
});

test("없는 칸은 직접 불러도 창을 열지 않고, 글자 크기 칸은 그 내용으로 연다", () => {
  const { h, v } = make("nav", { section: "accounts" });
  for (const id of ["claude", "없는칸"]) v.open(id);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.shared, {});
  v.open("fontsize");
  assert.equal(h.shared["settings.section"], "fontsize");
  assert.deepEqual(h.opened[0].layout.children[1].children[1].children[0].content, { mod: "settings", props: { part: "fontsize" } });
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

// ---- 규칙 칸(#126) ----
// exec를 진짜 도우미(rules.cjs)로 이어 임시 HOME·받은편지함 폴더에서 돌린다. 진짜 ~/.claude 나 진짜 프로필은 건드리지 않는다.
const RULES_CJS = new URL("../mods/settings/rules.cjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
function rulesEnv(profile = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rules-ui-"));
  const inbox = path.join(home, "inbox");
  fs.mkdirSync(inbox);
  const file = path.join(inbox, "profile.json");
  if (profile !== null) fs.writeFileSync(file, typeof profile === "string" ? profile : JSON.stringify(profile));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, HERDR_INBOX_DIR: inbox };
  const calls = [];
  const execResult = (c, a) => {
    calls.push(a.slice(1));
    assert.equal(c, "node");
    assert.equal(a[0], "/app/mods/settings/rules.cjs");
    const r = spawnSync(process.execPath, [RULES_CJS, ...a.slice(1)], { env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { file, calls, execResult };
}
async function rulesView(profile, over = {}) {
  const e = rulesEnv(profile);
  const h = fake({ props: { part: "rules" }, execResult: e.execResult, ...over });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  await tick();
  h.texts.length = 0;
  v.render(c);
  return { h, v, c, ...e };
}
const redraw = (h, v, c) => { h.texts.length = 0; v.render(c); };
const typed = (v, id, text) => v.ruleInputs[id].set_value(text);

test("규칙 칸: 열면 프로필을 읽어 지금 쓰는 규칙·이유·파일을 보여 주고 이름 규칙을 공유값에 올린다", async () => {
  const { h, calls, file } = await rulesView(null);
  assert.deepEqual(calls, [["show"]]);
  assert.ok(h.texts.includes("지금 쓰는 규칙: 규칙 없음"), h.texts.join("|"));
  assert.ok(h.texts.some((x) => x.startsWith("이유: 프로필 파일이 없고")));
  assert.ok(h.texts.some((x) => x.includes(file) && x.includes("없음")));
  assert.equal(h.shared["inbox.names"].preset, "none");
  assert.ok(["rules-save", "rules-preset-po", "rules-preset-none"].every((id) => h.clicks[id]), "저장과 규칙 고르기 버튼");
  assert.equal(h.clicks["rules-reset"], undefined, "파일이 없으면 되돌릴 것이 없다");
});

test("규칙 칸: PO 규칙을 골라 저장하면 도우미로 쓰고, 결과·재시작 안내를 보이고, 공유 이름 규칙과 바쁨 표시를 정리한다", async () => {
  const { h, v, c, file, calls } = await rulesView(null);
  h.clicks["rules-preset-po"]({}, c);
  assert.equal(v.ruleInputs["agent.name"].value(), "^lead-[a-z0-9_-]+$", "고른 규칙의 기본값으로 칸이 채워진다");
  typed(v, "agent.strip", "^boss-");
  h.clicks["rules-save"]({}, c);
  assert.equal(h.shared["settings.busy"].action, "save", "저장하는 동안 설치와 같은 잠금을 잡는다");
  await tick();
  assert.equal(h.shared["settings.busy"], null);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.preset, "po");
  assert.equal(saved.agent.strip, "^boss-");
  assert.equal(saved.agent.name, undefined, "기본값과 같은 칸은 적지 않는다");
  assert.equal(calls[1][0], "set");
  assert.equal(h.shared["inbox.names"].preset, "po");
  assert.equal(h.shared["inbox.names"].strip, "^boss-");
  redraw(h, v, c);
  assert.ok(h.texts.some((x) => x.startsWith("저장했습니다") && x.includes("다시 시작")), h.texts.join("|"));
  assert.ok(h.texts.includes("지금 쓰는 규칙: PO 규칙"));
  assert.ok(h.clicks["rules-reset"], "파일이 생겼으니 되돌리기가 보인다");
});

test("규칙 칸: 다른 설치·제거가 도는 중이면 저장도 되돌리기도 하지 않고 기다린다고 말한다", async () => {
  const { h, v, c, calls, file } = await rulesView(null);
  h.shared["settings.busy"] = { name: "work", action: "add", at: Date.now() };
  redraw(h, v, c);
  assert.ok(h.texts.some((x) => x === "work 설치 중이라 기다립니다"), h.texts.join("|"));
  assert.equal(h.clicks["rules-save"] && typeof h.clicks["rules-save"], "function", "이전 그리기의 핸들러가 남아 있어도");
  h.clicks["rules-save"]({}, c);
  v.resetRules(c);
  await tick();
  assert.deepEqual(calls, [["show"]], "쓰기 명령은 가지 않았다");
  assert.equal(fs.existsSync(file), false);
});

test("규칙 칸: 파일이 깨졌으면 오류와 되돌리기만 보이고, 되돌리기는 확인 뒤 .bak으로 옮긴다", async () => {
  const { h, v, c, file } = await rulesView("{ not json");
  assert.ok(h.texts.includes("프로필 파일을 읽을 수 없습니다"));
  assert.equal(h.clicks["rules-save"], undefined, "깨진 파일 위에는 저장하지 않는다");
  assert.ok(h.texts.some((x) => x.startsWith("profile")) || h.texts.some((x) => /JSON|json/.test(x)), h.texts.join("|"));
  h.clicks["rules-reset"]({}, c);
  redraw(h, v, c);
  assert.equal(fs.existsSync(file), true, "확인 전에는 그대로");
  h.clicks["rules-reset-yes"]({}, c);
  await tick();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), "{ not json");
  redraw(h, v, c);
  assert.ok(h.texts.some((x) => x.startsWith("기본값으로 되돌렸습니다")));
  assert.ok(h.clicks["rules-save"], "되돌린 뒤에는 다시 저장할 수 있다");
});

test("규칙 칸: 로더가 거절하는 값은 저장하지 못했다고 알리고 파일은 그대로다", async () => {
  const { h, v, c, file } = await rulesView({ v: 1, preset: "po" });
  const before = fs.readFileSync(file, "utf8");
  typed(v, "agent.name", "(");
  h.clicks["rules-save"]({}, c);
  await tick();
  redraw(h, v, c);
  assert.ok(h.texts.some((x) => x.startsWith("저장하지 못했습니다(파일은 그대로입니다)")), h.texts.join("|"));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(h.shared["settings.busy"], null);
});

test("규칙 칸: node나 도우미를 못 돌리면 오류를 보이고 깨지지 않는다", async () => {
  const h = fake({ props: { part: "rules" }, execResult: () => { throw new Error("spawn node ENOENT"); } });
  const v = new Settings();
  const c = cx();
  v.init(h.props, c);
  await tick();
  redraw(h, v, c);
  assert.ok(h.texts.some((x) => x.includes("rules.cjs") && x.includes("node")), h.texts.join("|"));
});

test("규칙 칸 도우미: 이 칸이 보내는 id는 모두 도우미가 알고, busyText는 저장·되돌리기를 말한다", () => {
  assert.match(SRC.settings, /const BUSY_VERB = \{ remove: "제거", save: "저장", reset: "되돌리기" \}/);
  assert.match(SRC.settings, /name: "규칙", action: "save"/);
  assert.match(SRC.settings, /name: "규칙", action: "reset"/);
});

test("tabs-mine은 아직 아무도 이름 규칙을 올리지 않았을 때만 도우미로 읽어 올린다(바탕: 프로필이 아니라 pickPreset)", async () => {
  const src = SRC.tabs;
  assert.match(src, /publishNames\(cx\)/);
  assert.match(src, /mods\/settings\/rules\.cjs/);
  assert.match(src, /if \(cur && Object\.keys\(cur\)\.length\) return;/);
  assert.match(src, /import \{[^}]*\bsetShared\b[^}]*\} from "herdr"/);
});

// ---- UI 모드 글자 크기 칸(#126) ----
const KEY = "settings.uiFontSize";
const has = (h, re) => h.texts.some((x) => re.test(x));

test("글자 크기 칸: 기본은 Herdr 글자 크기를 따르고, 지금 Herdr 크기와 UI 모드 크기를 보여 준다(직접 정하는 줄은 없다)", () => {
  const { h } = make("fontsize", {}, { settings: { font_size: 16 } });
  assert.ok(h.texts.includes("UI 모드 글자 크기"));
  assert.ok(h.texts.includes("Herdr 글자 크기 따르기") && h.texts.includes("UI 모드만 따로 정하기"));
  assert.ok(has(h, /^UI 모드 글자 크기: 16px \(Herdr 글자 크기를 따르는 중\)$/), h.texts.join(" | "));
  assert.ok(h.texts.includes("지금 Herdr 글자 크기: 16px"));
  assert.ok(h.texts.includes("미리보기 (16px)"));
  assert.ok(has(h, /미리보기|리더 보고/));
  assert.equal(h.clicks["font-plus"], undefined);
  assert.equal(h.clicks["font-minus"], undefined);
  assert.ok(!has(h, /준비 중/));
});

test("글자 크기 칸: 직접 정한 크기는 Herdr 값을 이기고, 거기서 -/+로 10~24px 안에서만 움직인다", () => {
  const { h, v, c } = make("fontsize", {}, { settings: { font_size: 16 }, shared: { [KEY]: 18 } });
  assert.ok(has(h, /^UI 모드 글자 크기: 18px \(직접 정한 크기\)$/), h.texts.join(" | "));
  assert.ok(h.texts.includes("지금 Herdr 글자 크기: 16px"));
  assert.ok(h.texts.includes("18px") && h.texts.includes("미리보기 (18px)"));
  h.clicks["font-plus"]({}, c);
  assert.equal(h.shared[KEY], 19);
  h.clicks["font-minus"]({}, c);
  h.clicks["font-minus"]({}, c);
  assert.equal(h.shared[KEY], 17);
  assert.ok(c.notified >= 3);
  h.shared[KEY] = 24;
  h.clicks = {};
  v.render(c);
  assert.equal(h.clicks["font-plus"], undefined, "24px에서는 더 키우지 못한다");
  assert.equal(typeof h.clicks["font-minus"], "function");
  h.shared[KEY] = 10;
  h.clicks = {};
  v.render(c);
  assert.equal(h.clicks["font-minus"], undefined, "10px에서는 더 줄이지 못한다");
  assert.equal(typeof h.clicks["font-plus"], "function");
});

test("글자 크기 칸: 정하기는 지금 크기로 시작하고(10~24로 맞춤), 따르기는 값을 지운다", () => {
  const { h, c } = make("fontsize", {}, { settings: { font_size: 16 } });
  h.clicks["font-fixed"]({}, c);
  assert.equal(h.shared[KEY], 16);
  h.clicks["font-follow"]({}, c);
  assert.equal(h.shared[KEY], null);
  const big = make("fontsize", {}, { settings: { font_size: 40 } });
  big.h.clicks["font-fixed"]({}, big.c);
  assert.equal(big.h.shared[KEY], 24);
  const small = make("fontsize", {}, { settings: { font_size: 6 } });
  small.h.clicks["font-fixed"]({}, small.c);
  assert.equal(small.h.shared[KEY], 10);
  const none = make("fontsize", {}, { settings: "boom" });
  none.h.clicks["font-fixed"]({}, none.c);
  assert.equal(none.h.shared[KEY], 13, "Herdr 값을 못 읽으면 13px에서 시작한다");
});

test("글자 크기 칸: 잘못된 값은 무시한다(저장된 값이 깨졌으면 따르기로 본다, 입력은 받지 않는다)", () => {
  for (const bad of ["18", "x", 99, 9, 0, -3, NaN, {}, true]) {
    const { h } = make("fontsize", {}, { settings: { font_size: 20 }, shared: { [KEY]: bad } });
    assert.ok(has(h, /^UI 모드 글자 크기: 20px \(Herdr 글자 크기를 따르는 중\)$/), `bad: ${JSON.stringify(bad)}`);
    assert.equal(h.clicks["font-plus"], undefined);
  }
  const { h, v, c } = make("fontsize", {}, { shared: { [KEY]: 15 } });
  for (const bad of [99, 9, NaN, "20", {}, undefined, Infinity]) v.setFont(bad, c);
  assert.equal(h.shared[KEY], 15);
  v.setFont(30.4, c);
  assert.equal(h.shared[KEY], 15);
  v.setFont(12.4, c);
  assert.equal(h.shared[KEY], 12);
});

test("글자 크기 칸: Herdr 글자 크기를 못 읽어도 그린다(알 수 없음, 13px 기준)", () => {
  const { h } = make("fontsize", {}, { settings: "boom" });
  assert.ok(h.texts.includes("지금 Herdr 글자 크기: 알 수 없음"));
  assert.ok(has(h, /^UI 모드 글자 크기: 13px/));
});

test("글자 크기 칸: Herdr 글자 크기는 몇 초마다 다시 읽고 달라졌을 때만 다시 그린다", () => {
  const { h, c } = make("fontsize", {}, { settings: { font_size: 13 } });
  assert.equal(c.timers.length, 1);
  assert.equal(c.timers[0].ms, 2000);
  const before = c.notified;
  c.timers[0].fn(c);
  assert.equal(c.notified, before, "그대로면 다시 그리지 않는다");
  h.settings = { font_size: 18 };
  c.timers[0].fn(c);
  assert.equal(c.notified, before + 1);
  const rules = make("rules");
  assert.equal(rules.c.timers.length, 0, "다른 칸은 타이머를 쓰지 않는다");
});

test("글자 크기 규칙은 inbox와 같다(FONT_BASE·키·범위·fontOverride·fontScale이 한 글자도 다르지 않다)", () => {
  const cut = (t) => t.slice(t.indexOf("const FONT_BASE"), t.indexOf("\n};\n", t.indexOf("const fontScale")) + 4).replace(/\r\n/g, "\n");
  const inbox = fs.readFileSync(new URL("../mods/inbox/inbox.cjs", import.meta.url), "utf8");
  const a = cut(SRC.settings).split("\n").filter((l) => !l.startsWith("//")).join("\n");
  const b = cut(inbox).split("\n").filter((l) => !l.startsWith("//")).join("\n");
  assert.ok(a.includes("fontOverride") && a.includes("FONT_KEY"));
  assert.equal(a, b);
});

test("오른쪽 여백: 모드·규칙·글자 크기 칸의 목록·폼·줄이 같은 오른쪽 여백(INSET_R)을 쓰고, 계정 칸(gh-accounts)도 컨트롤이 같은 거리에 놓인다(#126)", async () => {
  const inset = Number(SRC.settings.match(/^const INSET_R = (\d+);/m)?.[1]);
  assert.ok(inset >= 20, "스크롤바에 붙지 않을 만큼의 여백");
  const ghSrc = fs.readFileSync(new URL("../mods/gh-accounts/main.js", import.meta.url), "utf8");
  assert.equal(Number(ghSrc.match(/^const INSET_R = (\d+);/m)?.[1]), inset, "gh-accounts 의 값이 같다");
  assert.match(ghSrc, /id\("acct-list"\)[^\n]*\.pr\(INSET_R - 8\)/, "계정 목록: 줄 안쪽 8 + 목록 오른쪽 = INSET_R");
  const seen = (part, ids) => { const { h } = make(part, {}, { settings: {} }); for (const id of ids) assert.equal(h.pr[id], inset, `${part}/${id}`); };
  seen("mods", ["mods-list", "mods-source"]);
  const rv = await rulesView(null);
  for (const id of ["rules-status", "rules-presets", "rules-form"]) assert.equal(rv.h.pr[id], inset, `rules/${id}`);
  seen("fontsize", ["font-status", "font-modes", "font-sample"]);
  // 본문 칸(스크롤 목록 밖 한 줄짜리)에 14 로 굳은 좌우 여백이 남아 있지 않다.
  const body = SRC.settings.slice(SRC.settings.indexOf("modsBody(t) {"), SRC.settings.indexOf("  render(cx) {"));
  assert.equal([...body.matchAll(/\.px\(14\)/g)].length, [...body.matchAll(/h\(38\)\.px\(14\)/g)].length, "제목 줄(h(38)) 말고는 px(14)를 쓰지 않는다");
});
