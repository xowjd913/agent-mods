// 설치 도우미(install.cjs) 테스트. 실행: node --test herdr/test/install.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const inst = require("../install.cjs");

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
  const { result } = quiet(() => inst.installMods(home, false));
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

test("예전 설치(agent-groups 레이아웃·예전 표시·기록)는 레이아웃을 그대로 둔다", () => {
  const home = tempHome();
  for (const m of [...inst.CORE, ...inst.EXTRAS]) {
    fs.mkdirSync(path.join(home, "mods", m));
    fs.writeFileSync(path.join(home, "mods", m, "main.js"), "legacy");
    fs.writeFileSync(path.join(home, "mods", m, inst.LEGACY_MARK), "");
  }
  for (const [m, f] of [["usage-status", ".status-swapped"], ["work", ".panels-added"], ["schedules", ".board-added"], ["leader-tabs", ".header-swapped"]]) {
    fs.writeFileSync(path.join(home, "mods", m, f), "");
  }
  const l = clonedMain();
  (function walk(n) {
    if (n.content?.mod === "agents") n.content.mod = "agent-groups";
    for (const c of n.children || []) walk(c);
  })(l);
  const file = path.join(home, "layouts", "agent-groups.json");
  const text = JSON.stringify(l, null, 2) + "\n";
  fs.writeFileSync(file, text);
  assert.equal(inst.pendingLayout(home), "");
  const { result } = quiet(() => inst.installMods(home, false));
  assert.deepEqual(result.installed, [...inst.CORE, ...inst.EXTRAS]);
  quiet(() => inst.applyLayout(home, false));
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
