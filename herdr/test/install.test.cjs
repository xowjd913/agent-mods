// 설치 도우미(install.cjs) 테스트. 실행: node --test herdr/test/install.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const inst = require("../install.cjs");
const CLI = path.join(__dirname, "..", "install.cjs");

// Herdr 기본 레이아웃(main)을 layout.clone으로 복제했을 때와 같은 모양.
function clonedMain() {
  return {
    id: "root", type: "row", cloned_from: "main",
    children: [
      { id: "sidebar", type: "column", children: [
        { id: "brand", type: "block", content: { mod: "workspace-chrome" } },
        { id: "sidebar-lists", type: "column", children: [
          { id: "spaces", type: "block", content: { mod: "spaces" } },
          { id: "agents", type: "block", content: { mod: "agents" } },
        ] },
        { id: "sidebar-footer", type: "block", content: { mod: "sidebar-footer" } },
      ] },
      { id: "work", type: "column", children: [
        { id: "tabs", type: "block", content: { mod: "tabs" } },
        { id: "work-body", type: "row", children: [
          { id: "main", type: "block", content: { pane: { header: { content: { mod: "pane" } } } } },
          { id: "panel", type: "column", children: [
            { id: "panel-body", type: "stack", active: "files", children: [
              { id: "files", type: "block", content: { mod: "files" } },
              { id: "changes", type: "block", content: { mod: "changes" } },
            ] },
          ] },
        ] },
        { id: "status", type: "block", content: { mod: "workspace-status" } },
      ] },
    ],
  };
}

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-home-"));
  fs.mkdirSync(path.join(home, "mods"));
  fs.mkdirSync(path.join(home, "layouts"));
  return home;
}
function quiet(fn) {
  const write = process.stdout.write;
  const lines = [];
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try { return { result: fn(), out: lines.join("") }; } finally { process.stdout.write = write; }
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const mods = (layout) => {
  const out = [];
  (function walk(n) {
    if (n.content?.mod) out.push(n.content.mod);
    if (n.content?.pane?.header?.content?.mod) out.push(n.content.pane.header.content.mod);
    for (const c of n.children || []) walk(c);
  })(layout);
  return out;
};
function cloneInto(home, name) {
  const file = path.join(home, "layouts", name + ".json");
  fs.writeFileSync(file, JSON.stringify(clonedMain(), null, 2) + "\n");
  return file;
}

test("기본 설치는 기본 모드만 복사한다", () => {
  const home = tempHome();
  const { result } = quiet(() => inst.installMods(home, false));
  assert.deepEqual(result.installed, inst.CORE);
  for (const m of inst.CORE) assert.ok(fs.existsSync(path.join(home, "mods", m, inst.MARK)), m);
  for (const m of inst.EXTRAS) assert.ok(!fs.existsSync(path.join(home, "mods", m)), m);
  assert.ok(fs.existsSync(path.join(home, "mods", "work", "collect.cjs")));
  assert.ok(fs.existsSync(path.join(home, "mods", "schedules", "schedules.cjs")));
});

test("--extras는 추가 모드도 복사하고, 이후 기본 설치도 추가 모드를 갱신한다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, true));
  for (const m of inst.EXTRAS) assert.ok(fs.existsSync(path.join(home, "mods", m, "main.js")), m);
  // 계정 패널은 gh-account 도구를 함께 가져간다
  assert.equal(fs.readFileSync(path.join(home, "mods", "gh-accounts", "gh-account.cjs"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "gh-account", "gh-account.cjs"), "utf8"));
  // Claude 계정 도구(#121)는 계정 패널·스케줄·받은 글 모드가 각자 폴더에서 쓴다
  const cca = fs.readFileSync(path.join(__dirname, "..", "claude-account", "claude-account.cjs"), "utf8");
  for (const m of ["gh-accounts", "schedules", "inbox"]) assert.equal(fs.readFileSync(path.join(home, "mods", m, "claude-account.cjs"), "utf8"), cca, m);
  fs.writeFileSync(path.join(home, "mods", "usage-status", "main.js"), "old");
  const { result } = quiet(() => inst.installMods(home, false));
  assert.ok(result.installed.includes("usage-status"));
  assert.notEqual(fs.readFileSync(path.join(home, "mods", "usage-status", "main.js"), "utf8"), "old");
});

test("표시가 없는 같은 이름 폴더는 건너뛰고, 예전 표시가 있는 폴더는 덮어쓴다", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, "mods", "prs"));
  fs.writeFileSync(path.join(home, "mods", "prs", "main.js"), "foreign");
  fs.mkdirSync(path.join(home, "mods", "work"));
  fs.writeFileSync(path.join(home, "mods", "work", "main.js"), "legacy");
  fs.writeFileSync(path.join(home, "mods", "work", inst.LEGACY_MARK), "");
  const { result } = quiet(() => inst.installMods(home, { add: ["prs"] }));
  assert.deepEqual(result.skipped, ["prs"]);
  assert.equal(fs.readFileSync(path.join(home, "mods", "prs", "main.js"), "utf8"), "foreign");
  assert.notEqual(fs.readFileSync(path.join(home, "mods", "work", "main.js"), "utf8"), "legacy");
  assert.ok(fs.existsSync(path.join(home, "mods", "work", inst.LEGACY_MARK)));
});

test("레이아웃이 없으면 복제할 이름을 알려 준다", () => {
  const home = tempHome();
  assert.equal(inst.pendingLayout(home), inst.LAYOUT_NAME);
  cloneInto(home, inst.LAYOUT_NAME);
  assert.equal(inst.pendingLayout(home), "");
});

test("기본 설치: 복제한 레이아웃에 탭 줄·Work·PRs·예약만 넣는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, false));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const l = readJson(file);
  const m = mods(l);
  for (const x of ["tabs-mine", "files", "changes", "work", "prs", "schedules", "agents", "workspace-status", "pane"]) assert.ok(m.includes(x), x);
  for (const x of ["tabs", "agent-groups", "usage-status", "leader-tabs"]) assert.ok(!m.includes(x), x);
  assert.equal(l.cloned_from, "main");
});

test("--extras 설치: 에이전트 목록·상태 줄·칸 머리줄도 바꾼다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, true));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const m = mods(readJson(file));
  for (const x of ["agent-groups", "usage-status", "leader-tabs", "tabs-mine", "work", "prs", "schedules"]) assert.ok(m.includes(x), x);
  for (const x of ["agents", "workspace-status", "pane", "tabs"]) assert.ok(!m.includes(x), x);
});

test("두 번 실행해도 레이아웃이 같고, 되돌린 블록은 다시 바꾸지 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, true));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const once = fs.readFileSync(file, "utf8");
  quiet(() => inst.installMods(home, true));
  quiet(() => inst.applyLayout(home, false));
  assert.equal(fs.readFileSync(file, "utf8"), once);
  fs.writeFileSync(file, once.replace('"usage-status"', '"workspace-status"'));
  const reverted = fs.readFileSync(file, "utf8");
  quiet(() => inst.applyLayout(home, false));
  assert.equal(fs.readFileSync(file, "utf8"), reverted);
});

test("기본 설치 뒤 --extras로 다시 설치하면 추가 모드 블록만 더 바꾼다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, false));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  assert.equal(inst.pendingLayout(home), "");
  quiet(() => inst.installMods(home, true));
  quiet(() => inst.applyLayout(home, false));
  const m = mods(readJson(file));
  for (const x of ["agent-groups", "usage-status", "leader-tabs"]) assert.ok(m.includes(x), x);
  assert.equal(m.filter((x) => x === "work").length, 1);
});

// 예전 설치: 모든 모드에 예전 표시·기록, layouts/agent-groups.json, 레이아웃 이름 기록 없음.
// full이면 예전 --extras 설치처럼 모든 블록이 바뀐 레이아웃을 만든다.
// 예전 설치기에는 path-menu·gh-accounts·inbox가 없었다.
const LEGACY_MODS = inst.ALL.filter((m) => m !== "path-menu" && m !== "gh-accounts" && m !== "inbox");
function legacyHome(full) {
  const home = tempHome();
  for (const m of LEGACY_MODS) {
    fs.mkdirSync(path.join(home, "mods", m));
    fs.writeFileSync(path.join(home, "mods", m, "main.js"), "legacy");
    fs.writeFileSync(path.join(home, "mods", m, inst.LEGACY_MARK), "");
  }
  for (const [m, f] of [["usage-status", ".status-swapped"], ["work", ".panels-added"], ["schedules", ".board-added"], ["leader-tabs", ".header-swapped"]]) {
    fs.writeFileSync(path.join(home, "mods", m, f), "");
  }
  const swaps = full ? { agents: "agent-groups", "workspace-status": "usage-status", tabs: "tabs-mine" } : { agents: "agent-groups" };
  const l = clonedMain();
  (function walk(n) {
    if (swaps[n.content?.mod]) n.content.mod = swaps[n.content.mod];
    if (full && n.content?.pane) n.content.pane.header.content.mod = "leader-tabs";
    if (full && n.id === "panel-body") for (const mod of ["work", "prs", "schedules"]) n.children.push({ id: mod + "-board", type: "block", content: { mod } });
    for (const c of n.children || []) walk(c);
  })(l);
  const file = path.join(home, "layouts", "agent-groups.json");
  const text = JSON.stringify(l, null, 2) + "\n";
  fs.writeFileSync(file, text);
  return { home, file, text };
}

test("예전 설치(agent-groups 레이아웃·예전 표시·기록)는 레이아웃을 그대로 둔다", () => {
  const { home, file, text } = legacyHome(false);
  assert.equal(inst.pendingLayout(home), "");
  const { result } = quiet(() => inst.installMods(home, false));
  assert.deepEqual(result.installed, LEGACY_MODS);
  quiet(() => inst.applyLayout(home, false));
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.ok(!fs.existsSync(path.join(home, "layouts", inst.LAYOUT_NAME + ".json")));
});

test("예전 레이아웃에서 agent-groups를 지운 뒤에도 다른 모드 제거는 블록을 되돌리고, 다음 실행은 새 레이아웃을 만들지 않는다", () => {
  const { home, file } = legacyHome(true);
  quiet(() => inst.removeMods(home, ["agent-groups"]));
  let m = mods(readJson(file));
  assert.ok(m.includes("agents") && !m.includes("agent-groups"));
  assert.equal(inst.pendingLayout(home), "");
  quiet(() => inst.removeMods(home, ["leader-tabs", "usage-status"]));
  m = mods(readJson(file));
  for (const x of ["pane", "workspace-status"]) assert.ok(m.includes(x), x);
  for (const x of ["leader-tabs", "usage-status"]) assert.ok(!m.includes(x), x);
  assert.equal(inst.pendingLayout(home), "");
  // 인자 없는 실행: 남은 모드만 갱신하고 같은 예전 레이아웃을 그대로 쓴다.
  const text = fs.readFileSync(file, "utf8");
  quiet(() => inst.installMods(home, {}));
  assert.equal(cli("pending-layout", "--home", home).stdout, "");
  const { result } = quiet(() => inst.applyLayout(home, false));
  assert.equal(result.file, file);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.ok(!fs.existsSync(path.join(home, "layouts", inst.LAYOUT_NAME + ".json")));
});

test("같은 이름의 다른 레이아웃은 건드리지 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, true));
  const file = path.join(home, "layouts", inst.LAYOUT_NAME + ".json");
  const text = JSON.stringify({ id: "root", type: "row", children: [{ id: "x", type: "block", content: { mod: "files" } }] });
  fs.writeFileSync(file, text);
  assert.equal(inst.pendingLayout(home), "");
  const { result } = quiet(() => inst.applyLayout(home, false));
  assert.equal(result.foreign, file);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

const installed = (home) => inst.ALL.filter((m) => fs.existsSync(path.join(home, "mods", m, inst.MARK)));
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("--only는 고른 모드와 필요한 모드만 설치하고, 함께 설치한다고 알린다", () => {
  const home = tempHome();
  const { result, out } = quiet(() => inst.installMods(home, { only: ["prs"] }));
  assert.deepEqual(result.installed, ["tabs-mine", "work", "prs", "wt-menu"]);
  assert.deepEqual([...result.added].sort(), ["tabs-mine", "work", "wt-menu"]);
  assert.match(out, /prs 에 work 이\(가\) 필요해 함께 설치합니다/);
  assert.deepEqual(installed(home), ["tabs-mine", "work", "prs", "wt-menu"]);
});

test("--only는 고르지 않은 설치된 모드를 지우지도 갱신하지도 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, false));
  fs.writeFileSync(path.join(home, "mods", "schedules", "main.js"), "old");
  const { result, out } = quiet(() => inst.installMods(home, { only: ["wt-menu"] }));
  assert.deepEqual(result.installed, ["wt-menu"]);
  assert.deepEqual(result.kept, ["tabs-mine", "work", "prs", "schedules"]);
  assert.match(out, /그대로 둡니다/);
  assert.equal(fs.readFileSync(path.join(home, "mods", "schedules", "main.js"), "utf8"), "old");
});

test("--add는 설치된 모드에 더하고, 인자 없는 실행은 설치된 모드만 갱신한다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["schedules"] }));
  assert.deepEqual(installed(home), ["tabs-mine", "schedules"]);
  quiet(() => inst.installMods(home, { add: ["usage-status"] }));
  assert.deepEqual(installed(home), ["tabs-mine", "schedules", "usage-status"]);
  fs.writeFileSync(path.join(home, "mods", "usage-status", "main.js"), "old");
  const { result } = quiet(() => inst.installMods(home, {}));
  assert.deepEqual(result.installed, ["tabs-mine", "schedules", "usage-status"]);
  assert.notEqual(fs.readFileSync(path.join(home, "mods", "usage-status", "main.js"), "utf8"), "old");
});

test("--only work는 레이아웃에 탭 줄과 Work 패널만 넣는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["work"] }));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const m = mods(readJson(file));
  for (const x of ["tabs-mine", "work", "files", "agents", "workspace-status", "pane"]) assert.ok(m.includes(x), x);
  for (const x of ["tabs", "prs", "schedules"]) assert.ok(!m.includes(x), x);
});

test("모두 제거하면 레이아웃이 복제 직후로 돌아가고, 모드 폴더 밖의 기록은 남는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, true));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const records = [path.join(home, "schedules", "jobs.json"), path.join(home, "data", "prs", "panes.json"), path.join(home, "cache", "collect.json")];
  for (const f of records) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "{}"); }
  const { result } = quiet(() => inst.removeMods(home, inst.ALL));
  assert.deepEqual(result.removed, inst.ALL);
  assert.deepEqual(fs.readdirSync(path.join(home, "mods")), []);
  assert.deepEqual(readJson(file), clonedMain());
  for (const f of records) assert.ok(fs.existsSync(f), f);
  // 다시 설치하면 같은 레이아웃에 블록을 다시 넣는다.
  quiet(() => inst.installMods(home, false));
  quiet(() => inst.applyLayout(home, false));
  for (const x of ["tabs-mine", "work", "prs", "schedules"]) assert.ok(mods(readJson(file)).includes(x), x);
});

test("레이아웃 블록이 없는 wt-menu만 설치한 뒤에도 --add로 패널을 넣는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["wt-menu"] }));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  assert.deepEqual(readJson(file), clonedMain());
  quiet(() => inst.installMods(home, { add: ["prs"] }));
  const { result } = quiet(() => inst.applyLayout(home, false));
  assert.equal(result.foreign, undefined);
  for (const x of ["tabs-mine", "work", "prs"]) assert.ok(mods(readJson(file)).includes(x), x);
});

test("제거는 사용자가 바꾼 블록을 건드리지 않고, 다시 더하면 레이아웃에 다시 넣는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, true));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"leader-tabs"', '"my-header"'));
  quiet(() => inst.removeMods(home, ["leader-tabs", "schedules"]));
  let m = mods(readJson(file));
  assert.ok(m.includes("my-header"));
  assert.ok(!m.includes("pane"));
  assert.ok(!m.includes("schedules"));
  for (const x of ["usage-status", "agent-groups", "tabs-mine", "work", "prs"]) assert.ok(m.includes(x), x);
  quiet(() => inst.installMods(home, { add: ["schedules"] }));
  quiet(() => inst.applyLayout(home, false));
  m = mods(readJson(file));
  assert.equal(m.filter((x) => x === "schedules").length, 1);
});

test("제거는 표시 없는 폴더를 지우지 않고, 남는 모드가 쓰는 모드는 지우지 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, false));
  fs.mkdirSync(path.join(home, "mods", "leader-tabs"));
  fs.writeFileSync(path.join(home, "mods", "leader-tabs", "main.js"), "mine");
  let { result } = quiet(() => inst.removeMods(home, ["leader-tabs", "agent-groups"]));
  assert.deepEqual(result.kept, ["leader-tabs"]);
  assert.deepEqual(result.missing, ["agent-groups"]);
  assert.ok(fs.existsSync(path.join(home, "mods", "leader-tabs", "main.js")));
  let out;
  ({ result, out } = quiet(() => inst.removeMods(home, ["work"])));
  assert.deepEqual(result.blocked, ["prs"]);
  assert.match(out, /work,prs/);
  assert.ok(fs.existsSync(path.join(home, "mods", "work", "main.js")));
  const r = cli("remove", "--home", home, "--mods", "tabs-mine");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /tabs-mine,work,prs,schedules/);
  assert.ok(fs.existsSync(path.join(home, "mods", "tabs-mine", "main.js")));
});

test("--list는 모드마다 설명과 설치 상태를 보여 준다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["wt-menu"] }));
  fs.mkdirSync(path.join(home, "mods", "prs"));
  const r = cli("list", "--home", home);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n").slice(1);
  assert.equal(lines.length, inst.ALL.length);
  const line = (m) => lines.find((l) => l.startsWith(`  ${m} [`));
  assert.match(line("wt-menu"), /설치됨/);
  assert.match(line("prs"), /표시 없는/);
  assert.match(line("work"), /설치 안 됨.*Work 패널.*함께 설치: tabs-mine, wt-menu/);
});

test("모르는 모드 이름이나 함께 못 쓰는 옵션은 쓸 수 있는 이름과 함께 2로 끝난다", () => {
  const home = tempHome();
  let r = cli("mods", "--home", home, "--only", "work,nope");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /알 수 없는 모드: nope/);
  for (const m of inst.ALL) assert.ok(r.stdout.includes(m), m);
  assert.deepEqual(fs.readdirSync(path.join(home, "mods")), []);
  r = cli("remove", "--home", home, "--mods", "x");
  assert.equal(r.status, 2);
  assert.throws(() => inst.parseArgs(["mods", "--home", home, "--only", "work", "--extras"]), /하나만/);
  assert.throws(() => inst.parseArgs(["remove", "--home", home]), /--mods/);
});

test("예전 work/.panels-added 기록은 단계별 기록으로 옮기고 되돌린 패널을 다시 넣지 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, false));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  for (const [m, f] of [["tabs-mine", ".tabs-swapped"], ["work", ".work-board-added"], ["prs", ".pr-board-added"]]) {
    fs.rmSync(path.join(home, "mods", m, f));
  }
  fs.writeFileSync(path.join(home, "mods", "work", ".panels-added"), "");
  const l = readJson(file);
  (function walk(n) {
    if (n.id === "panel-body") n.children = n.children.filter((k) => k.content.mod !== "prs");
    for (const c of n.children || []) walk(c);
  })(l);
  const text = JSON.stringify(l, null, 2) + "\n";
  fs.writeFileSync(file, text);
  quiet(() => inst.applyLayout(home, false));
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.ok(!fs.existsSync(path.join(home, "mods", "work", ".panels-added")));
  assert.ok(fs.existsSync(path.join(home, "mods", "prs", ".pr-board-added")));
});

test("inbox는 tabs-mine과 함께 설치돼 오른쪽 패널에 inbox-board를 한 번만 더하고, 제거하면 뺀다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["inbox"] }));
  assert.ok(fs.existsSync(path.join(home, "mods", "tabs-mine", "main.js")));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const count = () => (JSON.stringify(readJson(file)).match(/"mod":\s*"inbox"/g) ?? []).length;
  assert.equal(count(), 1);
  assert.ok(fs.existsSync(path.join(home, "mods", "inbox", ".board-added")));
  quiet(() => inst.applyLayout(home, false));
  assert.equal(count(), 1);
  quiet(() => inst.removeMods(home, ["inbox"]));
  assert.equal(count(), 0);
});

test("path-menu는 레이아웃 link_handlers 끝에 한 번만 넣고, 제거하면 원래 목록으로 돌린다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["path-menu"] }));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  fs.writeFileSync(file, JSON.stringify({ ...clonedMain(), link_handlers: ["my-viewer"] }, null, 2) + "\n");
  quiet(() => inst.applyLayout(home, true));
  assert.deepEqual(readJson(file).link_handlers, ["my-viewer", "path-menu"]);
  assert.ok(fs.existsSync(path.join(home, "mods", "path-menu", ".link-handler-added")));
  quiet(() => inst.applyLayout(home, false));
  assert.deepEqual(readJson(file).link_handlers, ["my-viewer", "path-menu"]);
  quiet(() => inst.removeMods(home, ["path-menu"]));
  assert.deepEqual(readJson(file).link_handlers, ["my-viewer"]);
});

test("path-menu만 넣은 레이아웃도 우리 것으로 보고, 사용자가 뺀 link_handlers는 다시 넣지 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["path-menu"] }));
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  assert.deepEqual(readJson(file).link_handlers, ["path-menu"]);
  fs.rmSync(path.join(home, ".herdr-installer-layout"));
  let { result } = quiet(() => inst.applyLayout(home, false));
  assert.equal(result.foreign, undefined);
  fs.writeFileSync(file, JSON.stringify(clonedMain(), null, 2) + "\n");
  quiet(() => inst.applyLayout(home, false));
  assert.deepEqual(readJson(file), clonedMain());
  // Herdr가 먼저 넣어 둔 경우: 겹쳐 넣지 않고, 제거하면 키까지 지운다.
  fs.rmSync(path.join(home, "mods", "path-menu", ".link-handler-added"));
  fs.writeFileSync(file, JSON.stringify({ ...clonedMain(), link_handlers: ["path-menu"] }, null, 2) + "\n");
  quiet(() => inst.applyLayout(home, false));
  assert.deepEqual(readJson(file).link_handlers, ["path-menu"]);
  quiet(() => inst.removeMods(home, ["path-menu"]));
  assert.deepEqual(readJson(file), clonedMain());
});

// ---- PO 훅: Claude Code 설정(settings.json)에 한 줄 넣기·빼기. 진짜 ~/.claude는 건드리지 않고 임시 폴더의 파일로만 시험한다.
function hookEnv() {
  const home = tempHome();
  quiet(() => inst.installMods(home, { only: ["inbox"] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-claude-"));
  return { home, dir, file: path.join(dir, "settings.json"), script: path.join(home, "mods", "inbox", "po-hook.cjs") };
}
const ourCommands = (settings) => Object.values(settings.hooks ?? {}).flat().flatMap((g) => g.hooks ?? []).filter(inst.isOurHook);
const OTHER = { hooks: { Stop: [{ hooks: [{ type: "command", command: "herdr-hook stop" }] }], UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "orca hook prompt", timeout: 3 }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] }, theme: "dark", permissions: { allow: ["Bash(ls)"] } };

test("inbox 설치는 po-hook.cjs를 모드 폴더에 함께 복사한다(설정은 건드리지 않는다)", () => {
  const { script, dir } = hookEnv();
  assert.ok(fs.existsSync(script));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("훅: 설정 파일이 없으면 만들고 Stop·UserPromptSubmit에 우리 줄만 넣는다", () => {
  const { home, file, script } = hookEnv();
  const r = inst.hookSettings(home, file);
  assert.equal(r.status, "installed");
  assert.equal(r.backup, undefined);
  const s = readJson(file);
  assert.deepEqual(Object.keys(s.hooks).sort(), ["Stop", "UserPromptSubmit"]);
  for (const ev of ["Stop", "UserPromptSubmit"]) assert.deepEqual(s.hooks[ev], [{ hooks: [{ type: "command", command: `node "${script}"`, timeout: 5 }] }]);
});

test("훅: 다른 훅·다른 키를 그대로 두고 우리 줄만 더하며, 쓰기 전에 백업한다", () => {
  const { home, file } = hookEnv();
  const text = JSON.stringify(OTHER, null, 4) + "\n";
  fs.writeFileSync(file, text);
  const r = inst.hookSettings(home, file, false, Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(r.status, "installed");
  assert.equal(fs.readFileSync(r.backup, "utf8"), text);
  assert.match(path.basename(r.backup), /^settings\.json\.bak-herdr-20260102030405$/);
  const s = readJson(file);
  assert.deepEqual(s.hooks.PreToolUse, OTHER.hooks.PreToolUse);
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.permissions, OTHER.permissions);
  assert.deepEqual(s.hooks.Stop[0], OTHER.hooks.Stop[0]);
  assert.deepEqual(s.hooks.UserPromptSubmit[0], OTHER.hooks.UserPromptSubmit[0]);
  assert.equal(ourCommands(s).length, 2);
  assert.match(fs.readFileSync(file, "utf8"), /^\{\n {4}"hooks"/); // 들여쓰기 4칸과 끝 줄바꿈을 지킨다
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
});

test("훅: 두 번 넣어도 한 번만 들어가고, 두 번째는 파일도 백업도 만들지 않는다", () => {
  const { home, dir, file } = hookEnv();
  fs.writeFileSync(file, JSON.stringify(OTHER, null, 2));
  inst.hookSettings(home, file);
  const first = fs.readFileSync(file, "utf8");
  const names = fs.readdirSync(dir).sort();
  const r = inst.hookSettings(home, file);
  assert.equal(r.status, "present");
  assert.equal(fs.readFileSync(file, "utf8"), first);
  assert.deepEqual(fs.readdirSync(dir).sort(), names);
  assert.equal(ourCommands(readJson(file)).length, 2);
});

test("훅: 설치 위치가 바뀌면 우리 줄의 명령만 새 경로로 고친다(줄이 늘지 않는다)", () => {
  const { home, file } = hookEnv();
  inst.hookSettings(home, file);
  const s = readJson(file);
  for (const ev of Object.keys(s.hooks)) s.hooks[ev][0].hooks[0].command = 'node "/old/place/mods/inbox/po-hook.cjs"';
  fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(inst.hookSettings(home, file).status, "installed");
  const cmds = ourCommands(readJson(file));
  assert.equal(cmds.length, 2);
  assert.ok(cmds.every((h) => h.command === inst.hookCommand(inst.hookScript(home))));
});

test("훅: JSON을 읽지 못하거나 모양이 이상하면 아무것도 쓰지 않는다(백업도 임시 파일도 없다)", () => {
  const { home, dir, file } = hookEnv();
  const bad = ["{ not json", "[]", '"x"', JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { Stop: {} } }), JSON.stringify({ hooks: { Stop: [null] } }), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: "x" }] } })];
  for (const text of bad) {
    fs.writeFileSync(file, text);
    const r = inst.hookSettings(home, file);
    assert.equal(r.status, "invalid", text);
    assert.match(r.error, /건드리지 않았습니다/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
    assert.equal(inst.hookSettings(home, file, true).status, "invalid", `remove: ${text}`);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
});

test("훅: 스크립트가 설치돼 있지 않으면 넣지 않는다", () => {
  const home = tempHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-claude-"));
  const r = inst.hookSettings(home, path.join(dir, "settings.json"));
  assert.equal(r.status, "skipped");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("훅 제거: 우리 줄만 빼고 다른 훅은 그대로, 비게 된 묶음·이벤트만 치운다", () => {
  const { home, file } = hookEnv();
  fs.writeFileSync(file, JSON.stringify(OTHER, null, 2));
  inst.hookSettings(home, file);
  const r = inst.hookSettings(home, file, true);
  assert.equal(r.status, "removed");
  assert.ok(r.backup);
  assert.deepEqual(readJson(file), OTHER);
  assert.equal(inst.hookSettings(home, file, true).status, "absent");
});

test("훅 제거: 우리가 만든 파일은 hooks 키까지 비우고, 파일이 없으면 만들지 않는다", () => {
  const { home, dir, file } = hookEnv();
  assert.equal(inst.hookSettings(home, file, true).status, "absent");
  assert.deepEqual(fs.readdirSync(dir), []);
  inst.hookSettings(home, file);
  inst.hookSettings(home, file, true);
  assert.deepEqual(readJson(file), {});
});

test("훅 제거: 한 묶음에 다른 훅과 함께 있던 우리 줄도 그것만 빠진다", () => {
  const { home, file } = hookEnv();
  const mixed = { hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }, { type: "command", command: `node "/x/mods/inbox/po-hook.cjs"`, timeout: 5 }] }] } };
  fs.writeFileSync(file, JSON.stringify(mixed));
  inst.hookSettings(home, file, true);
  assert.deepEqual(readJson(file), { hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] } });
});

test("훅: 이름이 비슷한 다른 스크립트는 우리 것으로 보지 않는다", () => {
  assert.equal(inst.isOurHook({ command: 'node "/a/b/my-po-hook.cjs"' }), false);
  assert.equal(inst.isOurHook({ command: "po-hook.cjs.bak" }), false);
  assert.equal(inst.isOurHook({ command: 'node "C:\\Users\\a\\mods\\inbox\\po-hook.cjs"' }), true);
  assert.equal(inst.isOurHook({ command: 'node "/a/mods/inbox/po-hook.cjs"' }), true);
  assert.equal(inst.isOurHook({}), false);
  // 우리 표식(node "<home>/mods/inbox/po-hook.cjs")이 아닌 po-hook.cjs는 다른 사람의 훅이다: 설치·제거가 건드리지 않는다.
  assert.equal(inst.isOurHook({ command: 'node "/other/tools/po-hook.cjs"' }), false);
  assert.equal(inst.isOurHook({ command: 'node /a/mods/inbox/po-hook.cjs' }), false);
  assert.equal(inst.isOurHook({ command: 'node "/a/mods/inbox/po-hook.cjs" --extra' }), false);
  assert.equal(inst.isOurHook({ command: 'bash -c "node /a/mods/inbox/po-hook.cjs"' }), false);
});

test("훅: 심볼릭 링크로 연결된 설정 파일은 링크를 그대로 두고 대상 파일에 쓴다", () => {
  const { home, dir, file } = hookEnv();
  const real = path.join(dir, "real.json");
  fs.writeFileSync(real, JSON.stringify(OTHER));
  try { fs.symlinkSync(real, file); } catch { return; } // 심볼릭 링크를 못 만드는 환경은 건너뛴다
  inst.hookSettings(home, file);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal(ourCommands(readJson(real)).length, 2);
});

test("훅: 설정 파일의 권한과 BOM 없는 JSON을 지키고, 임시 파일을 남기지 않는다", () => {
  const { home, dir, file } = hookEnv();
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ a: 1 }), { mode: 0o640 });
  inst.hookSettings(home, file);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(readJson(file).a, 1);
  assert.ok(fs.readdirSync(dir).every((n) => n === "settings.json" || n.startsWith("settings.json.bak-herdr-")));
});

test("훅 명령줄: --settings 경로로 넣고 빼며, 읽지 못하는 파일이면 1로 끝나고 그대로 둔다", () => {
  const { home, dir, file } = hookEnv();
  let r = cli("hook", "--home", home, "--settings", file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PO 훅을 넣었습니다/);
  assert.equal(ourCommands(readJson(file)).length, 2);
  r = cli("hook", "--home", home, "--settings", file);
  assert.match(r.stdout, /이미 들어 있습니다/);
  r = cli("hook", "--home", home, "--settings", file, "--remove");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PO 훅을 뺐습니다/);
  assert.equal(ourCommands(readJson(file)).length, 0);
  fs.writeFileSync(file, "{ nope");
  r = cli("hook", "--home", home, "--settings", file);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /올바른 JSON이 아니라 건드리지 않았습니다/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ nope");
  assert.equal(cli("hook", "--home", home, "--settings").status, 2);
});

test("mods·remove 명령은 Claude 설정 파일을 건드리지 않는다(CLAUDE_CONFIG_DIR을 임시 폴더로 돌려 확인)", () => {
  const home = tempHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-claude-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  assert.equal(spawnSync(process.execPath, [CLI, "mods", "--home", home, "--only", "inbox"], { encoding: "utf8", env }).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI, "remove", "--home", home, "--mods", "inbox"], { encoding: "utf8", env }).status, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(inst.settingsPath({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, "settings.json"));
});

test("--add gh-accounts는 오른쪽 패널에 accounts-board를 더하고, 제거하면 뺀다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { add: ["gh-accounts"] }));
  assert.deepEqual(installed(home).sort(), ["gh-accounts", "tabs-mine"]);
  const file = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const ids = () => JSON.stringify(readJson(file)).match(/"id":"accounts-board"/g) ?? [];
  assert.equal(ids().length, 1);
  assert.ok(mods(readJson(file)).includes("gh-accounts"));
  quiet(() => inst.removeMods(home, ["gh-accounts"]));
  assert.equal(ids().length, 0);
  assert.ok(!fs.existsSync(path.join(home, "mods", "gh-accounts")));
});

// UI 모드(#59): 기본 레이아웃(터미널 모드)에서 main 칸만 UI 모드로 바꾼 `<이름>-ui` 레이아웃.
const uiFile = (home) => path.join(home, "layouts", inst.LAYOUT_NAME + "-ui.json");
const findNode = (n, id) => (n.id === id ? n : (n.children || []).map((c) => findNode(c, id)).find(Boolean));

test("UI 모드: inbox를 설치하면 main 칸만 UI 모드(mode main)로 바뀐 -ui 레이아웃을 만든다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { add: ["inbox"] }));
  const base = cloneInto(home, inst.LAYOUT_NAME);
  const { result } = quiet(() => inst.applyLayout(home, true));
  assert.equal(result.ui, "created");
  const ui = readJson(uiFile(home));
  assert.deepEqual(findNode(ui, "main").content, { mod: "inbox", props: { mode: "main" } });
  // 사이드바·탭 줄·상태 줄은 그대로, 기본 레이아웃(터미널 모드)은 건드리지 않는다.
  assert.ok(mods(ui).includes("tabs-mine") && mods(ui).includes("workspace-status") && mods(ui).includes("agents"));
  assert.ok(findNode(readJson(base), "main").content.pane);
  assert.equal(ui.cloned_from, undefined);
});

test("UI 모드: main 칸이 content.tab active인 실제 모양도 바꾼다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { add: ["inbox"] }));
  const layout = clonedMain();
  findNode(layout, "main").content = { tab: "active", pane: { gap: 8, lone: true } };
  fs.writeFileSync(path.join(home, "layouts", inst.LAYOUT_NAME + ".json"), JSON.stringify(layout));
  quiet(() => inst.applyLayout(home, true));
  assert.deepEqual(findNode(readJson(uiFile(home)), "main").content, { mod: "inbox", props: { mode: "main" } });
});

test("UI 모드: inbox가 없으면 만들지 않고, 두 번 실행해도 같다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, false));
  cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  assert.ok(!fs.existsSync(uiFile(home)));
  quiet(() => inst.installMods(home, { add: ["inbox"] }));
  quiet(() => inst.applyLayout(home, false));
  const once = fs.readFileSync(uiFile(home), "utf8");
  const { result } = quiet(() => inst.applyLayout(home, false));
  assert.equal(result.ui, "same");
  assert.equal(fs.readFileSync(uiFile(home), "utf8"), once);
});

test("UI 모드: 기본 레이아웃이 바뀌면 따라가고, 사용자가 고친 파일은 다시 쓰지 않는다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { add: ["inbox"] }));
  const base = cloneInto(home, inst.LAYOUT_NAME);
  quiet(() => inst.applyLayout(home, true));
  const layout = readJson(base);
  findNode(layout, "spaces").content.mod = "my-spaces";
  fs.writeFileSync(base, JSON.stringify(layout));
  const { result } = quiet(() => inst.applyLayout(home, false));
  assert.equal(result.ui, "updated");
  assert.ok(mods(readJson(uiFile(home))).includes("my-spaces"));
  const mine = fs.readFileSync(uiFile(home), "utf8").replace("my-spaces", "mine");
  fs.writeFileSync(uiFile(home), mine);
  findNode(layout, "spaces").content.mod = "other";
  fs.writeFileSync(base, JSON.stringify(layout));
  assert.equal(quiet(() => inst.applyLayout(home, false)).result.ui, "foreign");
  assert.equal(fs.readFileSync(uiFile(home), "utf8"), mine);
});

test("UI 모드: 표시 없는 같은 이름 레이아웃은 건드리지 않고, inbox를 지우면 만든 파일만 지운다", () => {
  const home = tempHome();
  quiet(() => inst.installMods(home, { add: ["inbox"] }));
  cloneInto(home, inst.LAYOUT_NAME);
  fs.writeFileSync(uiFile(home), '{"id":"root","type":"row"}');
  assert.equal(quiet(() => inst.applyLayout(home, true)).result.ui, "foreign");
  assert.equal(fs.readFileSync(uiFile(home), "utf8"), '{"id":"root","type":"row"}');
  fs.rmSync(uiFile(home));
  quiet(() => inst.applyLayout(home, false));
  assert.ok(fs.existsSync(uiFile(home)));
  const gone = quiet(() => inst.removeMods(home, ["inbox"]));
  assert.ok(!fs.existsSync(uiFile(home)));
  assert.match(gone.out, /터미널 모드'로 먼저 돌아오세요/); // 보던 -ui 레이아웃이 사라지니 먼저 돌아오라는 안내(review-59 R1 P3)
});
