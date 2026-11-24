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
// 예전 설치기에는 path-menu가 없었다.
const LEGACY_MODS = inst.ALL.filter((m) => m !== "path-menu");
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
