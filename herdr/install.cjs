#!/usr/bin/env node
// Herdr 모드 설치 도우미. install.sh와 install.ps1이 부른다. macOS·Linux·Windows에서 같은 동작을 한다.
//   node install.cjs mods --home <Herdr 설정 폴더> [--extras]
//     모드 폴더를 <home>/mods/<모드>/에 복사한다. 기본 모드는 늘 설치하고, 추가 모드는 --extras를 주거나
//     이미 설치돼 있을 때만 갱신한다. 이 설치기가 만들지 않은 같은 이름 폴더는 건드리지 않는다.
//   node install.cjs pending-layout --home <home>
//     새로 복제해야 할 레이아웃 이름을 출력한다. 이미 있으면 아무것도 출력하지 않는다.
//   node install.cjs layout --home <home> [--created]
//     우리 레이아웃에 모드 블록을 처음 한 번만 넣는다. --created는 방금 복제한 레이아웃이라는 뜻이다.
// 레이아웃 단계마다 기록 파일을 두어, 사용자가 되돌린 블록은 다시 바꾸지 않는다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const CORE = ["tabs-mine", "work", "prs", "wt-menu", "schedules"];
const EXTRAS = ["usage-status", "agent-groups", "leader-tabs"];
const MARK = ".installed-by-herdr-installer";
// 예전 설치 스크립트가 남긴 표시. 이 표시가 있는 폴더도 우리 것으로 보고 덮어쓴다.
const LEGACY_MARK = ".installed-by-agent-playbook";
const LAYOUT_NAME = "dashboard";
// 예전 설치 스크립트가 만든 레이아웃. agent-groups 블록이 있으면 우리 것으로 보고 계속 쓴다.
const LEGACY_LAYOUT = "agent-groups";
const SRC = path.join(__dirname, "mods");

function log(msg) { process.stdout.write(msg + "\n"); }

function parseArgs(argv) {
  const out = { cmd: argv[0], home: null, extras: false, created: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") out.home = argv[++i];
    else if (a === "--extras") out.extras = true;
    else if (a === "--created") out.created = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!out.home) throw new Error("--home이 필요합니다.");
  return out;
}

const modDir = (home, mod) => path.join(home, "mods", mod);
const ours = (dir) => fs.existsSync(path.join(dir, MARK)) || fs.existsSync(path.join(dir, LEGACY_MARK));
// 레이아웃에 넣어도 되는 모드: 우리 표시가 있고 main.js가 있는 폴더.
const available = (home, mod) => ours(modDir(home, mod)) && fs.existsSync(path.join(modDir(home, mod), "main.js"));

// 1) 모드 복사
function installMods(home, extras) {
  const result = { installed: [], skipped: [] };
  for (const mod of [...CORE, ...EXTRAS]) {
    const target = modDir(home, mod);
    const exists = fs.existsSync(target);
    if (exists && !ours(target)) {
      log(`${target} 은(는) 이 설치기가 만든 폴더가 아니라 덮어쓰지 않고 건너뜁니다. 폴더 이름을 바꾸거나 지운 뒤 다시 실행하세요.`);
      result.skipped.push(mod);
      continue;
    }
    // 추가 모드는 --extras를 줬거나 이미 설치돼 있을 때만 복사한다(갱신이 이어지게).
    if (EXTRAS.includes(mod) && !extras && !exists) continue;
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(SRC, mod), target, { recursive: true, force: true });
    fs.writeFileSync(path.join(target, MARK), "");
    log(`모드 설치: ${target}`);
    result.installed.push(mod);
  }
  return result;
}

// 2) 레이아웃
function readLayout(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeLayout(file, layout) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(layout, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, fn);
}
function usesMod(layout, mods) {
  let found = false;
  walk(layout, (n) => {
    if (n.content && mods.includes(n.content.mod)) found = true;
    const h = n.content?.pane?.header?.content;
    if (h && mods.includes(h.mod)) found = true;
  });
  return found;
}

// 우리 레이아웃 파일 경로. 없으면 null, 같은 이름의 다른 레이아웃이면 { foreign }.
function findLayout(home, created) {
  const legacy = path.join(home, "layouts", LEGACY_LAYOUT + ".json");
  if (fs.existsSync(legacy)) {
    try { if (usesMod(readLayout(legacy), [LEGACY_LAYOUT])) return { file: legacy }; } catch { /* 아래로 */ }
  }
  const file = path.join(home, "layouts", LAYOUT_NAME + ".json");
  if (!fs.existsSync(file)) return null;
  if (created) return { file };
  try { if (usesMod(readLayout(file), [...CORE, ...EXTRAS])) return { file }; } catch { /* 아래로 */ }
  return { foreign: file };
}

// 각 단계: 쓸 모드, 기록 파일, 이미 반영됐는지, 바꾸는 함수. 바꾼 블록이 없으면 이유를 돌려준다.
const STEPS = [
  {
    name: "에이전트 목록(agent-groups)",
    needs: ["agent-groups"],
    mark: ["agent-groups", ".agents-swapped"],
    done: (l) => usesMod(l, ["agent-groups"]),
    apply(l) {
      let n = 0;
      walk(l, (node) => { if (node.content?.mod === "agents") { node.content.mod = "agent-groups"; n++; } });
      return n ? null : "agents 블록을 찾지 못했습니다.";
    },
  },
  {
    name: "상태 줄(usage-status)",
    needs: ["usage-status"],
    mark: ["usage-status", ".status-swapped"],
    done: (l) => usesMod(l, ["usage-status"]),
    apply(l) {
      let n = 0;
      walk(l, (node) => { if (node.content?.mod === "workspace-status") { node.content.mod = "usage-status"; n++; } });
      return n ? null : "workspace-status 블록을 찾지 못했습니다.";
    },
  },
  {
    name: "탭 줄(tabs-mine)과 오른쪽 패널 Work·PRs",
    needs: ["work", "prs", "wt-menu", "tabs-mine"],
    mark: ["work", ".panels-added"],
    done: () => false,
    apply(l) {
      let tabs = null, body = null;
      walk(l, (node) => {
        if (node.content && ["tabs", "tabs-mine"].includes(node.content.mod)) tabs = node.content;
        if (node.id === "panel-body" && node.type === "stack") body = node;
      });
      if (!tabs || !body) return "tabs 블록이나 panel-body를 찾지 못했습니다.";
      tabs.mod = "tabs-mine";
      if (!Array.isArray(body.children)) body.children = [];
      const kids = body.children;
      const have = new Set(kids.map((k) => k?.content?.mod));
      if (!have.has("files")) kids.unshift({ id: "files", type: "block", content: { mod: "files" } });
      for (const [id, mod] of [["work-board", "work"], ["pr-board", "prs"]]) {
        if (!have.has(mod)) kids.push({ id, type: "block", content: { mod } });
      }
      if (!kids.some((k) => k?.id === body.active)) body.active = kids[0].id;
      return null;
    },
    after: (home) => fs.rmSync(path.join(modDir(home, "work"), ".panels-swapped"), { force: true }),
  },
  {
    name: "오른쪽 패널 예약(schedules)",
    needs: ["schedules"],
    mark: ["schedules", ".board-added"],
    done: () => false,
    apply(l) {
      let body = null;
      walk(l, (node) => { if (node.id === "panel-body" && node.type === "stack") body = node; });
      if (!body) return "panel-body를 찾지 못했습니다.";
      if (!Array.isArray(body.children)) body.children = [];
      if (!body.children.some((k) => k?.content?.mod === "schedules")) {
        body.children.push({ id: "schedules-board", type: "block", content: { mod: "schedules" } });
      }
      return null;
    },
  },
  {
    name: "칸 머리줄(leader-tabs)",
    needs: ["leader-tabs"],
    mark: ["leader-tabs", ".header-swapped"],
    done: (l) => usesMod(l, ["leader-tabs"]),
    apply(l) {
      let n = 0;
      walk(l, (node) => {
        const h = node.content?.pane?.header?.content;
        if (h && h.mod === "pane") { h.mod = "leader-tabs"; n++; }
      });
      return n ? null : "칸 머리줄(pane) 블록을 찾지 못했습니다.";
    },
  },
];

function applyLayout(home, created) {
  const found = findLayout(home, created);
  if (!found) { log("레이아웃이 아직 없어 레이아웃 단계는 건너뜁니다."); return { changed: [] }; }
  if (found.foreign) {
    log(`${found.foreign} 은(는) 이 설치기의 모드를 쓰지 않는 다른 레이아웃이라 건드리지 않습니다.`);
    return { changed: [], foreign: found.foreign };
  }
  const file = found.file;
  let layout;
  try { layout = readLayout(file); } catch (e) {
    log(`레이아웃을 읽지 못했습니다: ${file} (${e.message})`);
    return { changed: [] };
  }
  const before = JSON.stringify(layout);
  const changed = [];
  for (const step of STEPS) {
    if (!step.needs.every((m) => available(home, m))) continue;
    const mark = path.join(modDir(home, step.mark[0]), step.mark[1]);
    // 방금 복제한 레이아웃이면 예전 기록은 무시한다. 기록이 있으면 사용자가 되돌린 것으로 보고 건드리지 않는다.
    if (!created && fs.existsSync(mark)) continue;
    // 이미 들어 있으면 기록만 남긴다.
    let applied = false;
    if (!step.done(layout)) {
      const err = step.apply(layout);
      if (err) { log(`${step.name}: ${err} 이 단계는 건너뜁니다.`); continue; }
      applied = true;
    }
    changed.push({ step, applied });
  }
  // 내용이 실제로 바뀐 경우에만 파일을 다시 쓴다.
  if (JSON.stringify(layout) !== before) {
    writeLayout(file, layout);
    log(`레이아웃을 고쳤습니다: ${file}. 앱에 바로 보이지 않으면 ctrl-shift-l로 다른 레이아웃에 갔다가 돌아오세요.`);
  } else {
    log(`레이아웃은 바꿀 것이 없습니다: ${file}`);
  }
  for (const { step, applied } of changed) {
    fs.writeFileSync(path.join(modDir(home, step.mark[0]), step.mark[1]), "");
    step.after?.(home);
    if (applied) log(`레이아웃 반영: ${step.name}`);
  }
  return { changed: changed.filter((c) => c.applied).map((c) => c.step.mark[1]), file };
}

function pendingLayout(home) {
  const found = findLayout(home, false);
  return found ? "" : LAYOUT_NAME;
}

module.exports = { CORE, EXTRAS, MARK, LEGACY_MARK, LAYOUT_NAME, installMods, applyLayout, pendingLayout };

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    log(e.message);
    process.exit(2);
  }
  if (args.cmd === "mods") installMods(args.home, args.extras);
  else if (args.cmd === "pending-layout") { const name = pendingLayout(args.home); if (name) log(name); }
  else if (args.cmd === "layout") applyLayout(args.home, args.created);
  else { log(`알 수 없는 명령: ${args.cmd}`); process.exit(2); }
}
