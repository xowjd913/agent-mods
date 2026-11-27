#!/usr/bin/env node
// Herdr 모드 설치 도우미. install.sh와 install.ps1이 부른다. macOS·Linux·Windows에서 같은 동작을 한다.
//   node install.cjs mods --home <Herdr 설정 폴더> [--extras | --only <모드,..> | --add <모드,..>]
//     모드 폴더를 <home>/mods/<모드>/에 복사한다. 인자가 없으면 설치된 모드만 갱신하고, 처음이면 기본 모드를 넣는다.
//     --extras는 모든 모드, --only는 고른 모드만, --add는 설치된 모드에 더한다. 필요한 모드는 함께 넣는다.
//     이 설치기가 만들지 않은 같은 이름 폴더는 건드리지 않는다.
//   node install.cjs remove --home <home> --mods <모드,..>
//     표시가 있는 모드 폴더만 지우고, 그 모드가 바꾼 레이아웃 블록을 되돌린다. 모드 폴더 밖의 기록은 지우지 않는다.
//   node install.cjs list --home <home>
//     모드마다 설명과 설치 상태를 한 줄씩 보여 준다.
//   node install.cjs pending-layout --home <home>
//     새로 복제해야 할 레이아웃 이름을 출력한다. 이미 있으면 아무것도 출력하지 않는다.
//   node install.cjs layout --home <home> [--created]
//     우리 레이아웃에 모드 블록을 처음 한 번만 넣는다. --created는 방금 복제한 레이아웃이라는 뜻이다.
//   node install.cjs hook --home <home> [--settings <settings.json>] [--remove]
//     PO 훅(inbox의 po-hook.cjs) 한 줄을 Claude Code 설정(기본 ~/.claude/settings.json, CLAUDE_CONFIG_DIR이 있으면 그 폴더)의
//     Stop·UserPromptSubmit에 넣는다. 다른 훅은 그대로 두고, 이미 있으면 바꾸지 않으며, 쓰기 전에 백업하고, JSON을 읽지 못하면 쓰지 않는다.
//     --solo를 붙이면 혼자 모드 기록(UI 모드가 PO 없는 Claude 터미널의 말을 ~/.herdr-inbox/solo/에 저장)도 켠다(--remove --solo는 PO 훅은 그대로 두고 기록 표시만 끈다). 기본은 꺼짐이다.
//     --remove는 우리 줄만 뺀다. 이 명령만 설정 파일을 건드린다(mods·remove는 건드리지 않는다).
// 레이아웃 단계마다 기록 파일을 두어, 사용자가 되돌린 블록은 다시 바꾸지 않는다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const CORE = ["tabs-mine", "settings", "gh-accounts", "work", "prs", "wt-menu", "schedules"];
const EXTRAS = ["usage-status", "agent-groups", "leader-tabs", "path-menu", "inbox"];
const ALL = [...CORE, ...EXTRAS];
// 모드 설명과 꼭 함께 있어야 하는 모드. deps는 코드에서 확인한 것만 적는다.
//   work·prs: wt-menu 팝업을 연다(work/main.js, prs/main.js의 openOverlay). 패널 버튼은 tabs-mine에만 있다.
//   prs: 데이터를 mods/work/collect.cjs로 읽는다. schedules: 30초 tick을 tabs-mine이 부른다.
//   tabs-mine: 설정 버튼이 settings 창을 연다(tabs-mine/main.js의 openOverlay). settings: 계정 칸이 gh-accounts 블록을 그대로 쓴다.
//   gh-accounts: 오른쪽 패널의 계정 버튼은 없어지고 입구는 설정 창뿐이다. gh-account 도구(--gh-account)는 모드가 아니라 따로 설치한다.
const MODS = {
  "tabs-mine": { desc: "탭 줄. 오른쪽 패널 버튼과 설정 버튼을 더하고 예약 실행을 맡는다", deps: ["settings"] },
  settings: { desc: "설정 창: 계정과 설치된 모드", deps: ["gh-accounts"] },
  work: { desc: "Work 패널: 누가 무엇을 하고 있나", deps: ["tabs-mine", "wt-menu"] },
  prs: { desc: "PRs 패널: 무엇을 손봐야 하나", deps: ["work", "tabs-mine", "wt-menu"] },
  "wt-menu": { desc: "워크트리 메뉴: Work·PRs에서 워크트리 줄을 누르면 뜨는 팝업", deps: [] },
  schedules: { desc: "예약 패널: 정해진 시각에 에이전트 돌리기", deps: ["tabs-mine"] },
  "usage-status": { desc: "아래 상태 줄에 Claude 사용률을 보여 준다", deps: [] },
  "agent-groups": { desc: "왼쪽 사이드바 에이전트 목록을 작업별로 묶는다", deps: [] },
  "leader-tabs": { desc: "칸 머리줄에 리더 탭을 보여 준다", deps: [] },
  "path-menu": { desc: "터미널 경로를 Cmd·Ctrl+클릭하면 폴더 열기·파일 열기·경로 복사 메뉴를 띄운다", deps: [] },
  "gh-accounts": { desc: "계정 패널: 스페이스·저장소마다 쓸 GitHub 계정 고르기 (설정 창 계정 칸)", deps: [] },
  inbox: { desc: "UI 모드 패널: 리더 결과 보고를 채팅처럼 보고, 결정을 PO에게 답한다", deps: ["tabs-mine"] },
};
const MARK = ".installed-by-herdr-installer";
// 예전 설치 스크립트가 남긴 표시. 이 표시가 있는 폴더도 우리 것으로 보고 덮어쓴다.
const LEGACY_MARK = ".installed-by-agent-playbook";
const LAYOUT_NAME = "dashboard";
// 예전 설치 스크립트가 만든 레이아웃. agent-groups 블록이 있으면 우리 것으로 보고 계속 쓴다.
const LEGACY_LAYOUT = "agent-groups";
// 이 설치기가 쓰는 레이아웃 이름(dashboard 또는 예전 agent-groups) 기록. 블록이 모두 빠진 뒤에도 같은 레이아웃을 알아본다.
const LAYOUT_MARK = ".herdr-installer-layout";
const SRC = path.join(__dirname, "mods");
// 모드 폴더 밖에 있지만 모드와 함께 복사할 파일. gh-accounts 패널은 설치·확인·계정 추가에 gh-account 도구를 쓴다.
const BUNDLE = { "gh-accounts": [["gh-account/gh-account.cjs", "gh-account.cjs"]], work: [["mods/inbox/profile.cjs", "profile.cjs"]] }; // work: collect.cjs reads the inbox profile (names, labels)

function log(msg) { process.stdout.write(msg + "\n"); }

// "work,prs"처럼 쉼표로 나눈 모드 이름. 모르는 이름이 있으면 쓸 수 있는 이름과 함께 오류를 낸다.
function parseNames(value, flag) {
  const names = [...new Set(String(value ?? "").split(/[,\s]+/).filter(Boolean))];
  if (!names.length) throw new Error(`${flag} 뒤에 모드 이름이 필요합니다. 쓸 수 있는 이름: ${ALL.join(", ")}`);
  const bad = names.filter((n) => !ALL.includes(n));
  if (bad.length) throw new Error(`알 수 없는 모드: ${bad.join(", ")}. 쓸 수 있는 이름: ${ALL.join(", ")}`);
  return names;
}

function parseArgs(argv) {
  const out = { cmd: argv[0], home: null, extras: false, only: null, add: null, mods: null, created: false, settings: null, remove: false, solo: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") out.home = argv[++i];
    else if (a === "--extras") out.extras = true;
    else if (a === "--only") out.only = parseNames(argv[++i], a);
    else if (a === "--add") out.add = parseNames(argv[++i], a);
    else if (a === "--mods") out.mods = parseNames(argv[++i], a);
    else if (a === "--created") out.created = true;
    else if (a === "--settings") { out.settings = argv[++i]; if (!out.settings) throw new Error("--settings 뒤에 파일 경로가 필요합니다."); }
    else if (a === "--remove") out.remove = true;
    else if (a === "--solo") out.solo = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!out.home) throw new Error("--home이 필요합니다.");
  if ([out.extras, out.only, out.add].filter(Boolean).length > 1) throw new Error("--extras, --only, --add 중 하나만 쓸 수 있습니다.");
  if (out.cmd === "remove" && !out.mods) throw new Error(`remove에는 --mods가 필요합니다. 쓸 수 있는 이름: ${ALL.join(", ")}`);
  return out;
}

const modDir = (home, mod) => path.join(home, "mods", mod);
const ours = (dir) => fs.existsSync(path.join(dir, MARK)) || fs.existsSync(path.join(dir, LEGACY_MARK));
// 레이아웃에 넣어도 되는 모드: 우리 표시가 있고 main.js가 있는 폴더.
const available = (home, mod) => ours(modDir(home, mod)) && fs.existsSync(path.join(modDir(home, mod), "main.js"));

const installedMods = (home) => ALL.filter((m) => ours(modDir(home, m)));

// 고른 모드에 필요한 모드를 더한다. added는 [더한 모드, 그것이 필요한 모드] 목록이다.
function withDeps(list) {
  const want = new Set(list);
  const added = [];
  const visit = (m) => {
    for (const d of MODS[m].deps) {
      if (!want.has(d)) { want.add(d); added.push([d, m]); visit(d); }
    }
  };
  for (const m of list) visit(m);
  return { mods: ALL.filter((m) => want.has(m)), added };
}

// 1) 모드 복사. opts는 { extras, only, add }이고, 예전처럼 true/false를 주면 extras로 본다.
function installMods(home, opts = {}) {
  if (typeof opts === "boolean") opts = { extras: opts };
  const result = { installed: [], skipped: [], added: [], kept: [] };
  const have = installedMods(home);
  let base;
  if (opts.extras) base = ALL;
  else if (opts.only) base = opts.only;
  else if (opts.add) base = [...have, ...opts.add];
  else base = have.length ? have : CORE; // 처음 설치면 기본 모드, 아니면 설치된 모드만 갱신
  const { mods, added } = withDeps(base);
  for (const [dep, by] of added) log(`${by} 에 ${dep} 이(가) 필요해 함께 설치합니다.`);
  result.added = added.map(([dep]) => dep);
  result.kept = have.filter((m) => !mods.includes(m));
  if (result.kept.length) log(`고르지 않은 모드는 그대로 둡니다: ${result.kept.join(", ")}. 지우려면 제거 옵션(--remove, Windows는 -Remove)을 쓰세요.`);
  for (const mod of mods) {
    const target = modDir(home, mod);
    if (fs.existsSync(target) && !ours(target)) {
      log(`${target} 은(는) 이 설치기가 만든 폴더가 아니라 덮어쓰지 않고 건너뜁니다. 폴더 이름을 바꾸거나 지운 뒤 다시 실행하세요.`);
      result.skipped.push(mod);
      continue;
    }
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(SRC, mod), target, { recursive: true, force: true });
    for (const [from, to] of BUNDLE[mod] || []) fs.copyFileSync(path.join(__dirname, from), path.join(target, to));
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
  let found = linkHandlers(layout).some((m) => mods.includes(m));
  walk(layout, (n) => {
    if (n.content && mods.includes(n.content.mod)) found = true;
    const h = n.content?.pane?.header?.content;
    if (h && mods.includes(h.mod)) found = true;
  });
  return found;
}

// 레이아웃 맨 위의 link_handlers(터미널 링크 Cmd·Ctrl+클릭을 맡는 모드 순서). 없으면 빈 배열.
function linkHandlers(l) {
  return Array.isArray(l?.link_handlers) ? l.link_handlers : [];
}
function addLinkHandler(l, mod) {
  if (!Array.isArray(l.link_handlers)) l.link_handlers = [];
  if (!l.link_handlers.includes(mod)) l.link_handlers.push(mod);
  return null;
}
// 목록에서 모드를 뺀다. 비면 키를 지워 넣기 전 모양으로 돌린다. 뺀 개수를 돌려준다.
function dropLinkHandler(l, mod) {
  const before = linkHandlers(l).length;
  if (!before) return 0;
  l.link_handlers = l.link_handlers.filter((m) => m !== mod);
  const n = before - l.link_handlers.length;
  if (!l.link_handlers.length) delete l.link_handlers;
  return n;
}

const layoutFile = (home, name) => path.join(home, "layouts", name + ".json");
// 기록 파일이 가리키는 레이아웃 이름. 기록이 없으면 null. 예전 기록은 내용과 상관없이 dashboard를 뜻한다.
function recordedLayout(home) {
  let text;
  try { text = fs.readFileSync(path.join(home, LAYOUT_MARK), "utf8").trim(); } catch { return null; }
  return text === LEGACY_LAYOUT ? LEGACY_LAYOUT : LAYOUT_NAME;
}
// 쓰고 있는 레이아웃 이름을 남겨, 블록이 모두 빠진 뒤에도 같은 레이아웃을 우리 것으로 본다.
function rememberLayout(home, file) {
  fs.writeFileSync(path.join(home, LAYOUT_MARK), path.basename(file, ".json") + "\n");
}

// 우리 레이아웃 파일 경로. 없으면 null, 같은 이름의 다른 레이아웃이면 { foreign }.
function findLayout(home, created) {
  const recorded = recordedLayout(home);
  if (recorded && fs.existsSync(layoutFile(home, recorded))) return { file: layoutFile(home, recorded) };
  // 기록이 없는 예전 설치는 agent-groups 블록으로 알아본다.
  const legacy = layoutFile(home, LEGACY_LAYOUT);
  if (fs.existsSync(legacy)) {
    try { if (usesMod(readLayout(legacy), [LEGACY_LAYOUT])) return { file: legacy }; } catch { /* 아래로 */ }
  }
  const file = layoutFile(home, LAYOUT_NAME);
  if (!fs.existsSync(file)) return null;
  if (created) return { file };
  try { if (usesMod(readLayout(file), [...CORE, ...EXTRAS])) return { file }; } catch { /* 아래로 */ }
  return { foreign: file };
}

// 블록의 mod 이름을 from에서 to로 바꾼다. 바꾼 개수를 돌려준다.
function swapMod(l, from, to) {
  let n = 0;
  walk(l, (node) => { if (node.content?.mod === from) { node.content.mod = to; n++; } });
  return n;
}
function swapHeader(l, from, to) {
  let n = 0;
  walk(l, (node) => {
    const h = node.content?.pane?.header?.content;
    if (h && h.mod === from) { h.mod = to; n++; }
  });
  return n;
}
function panelBody(l) {
  let body = null;
  walk(l, (node) => { if (node.id === "panel-body" && node.type === "stack") body = node; });
  if (body && !Array.isArray(body.children)) body.children = [];
  return body;
}
function fixActive(body) {
  if (body.children.length && !body.children.some((k) => k?.id === body.active)) body.active = body.children[0].id;
}
// 오른쪽 패널에 모드 블록을 하나 더한다. Files가 없으면 맨 앞에 넣어 기본 버튼이 남게 한다.
function addPanel(l, id, mod) {
  const body = panelBody(l);
  if (!body) return "panel-body를 찾지 못했습니다.";
  const kids = body.children;
  if (!kids.some((k) => k?.content?.mod === "files")) kids.unshift({ id: "files", type: "block", content: { mod: "files" } });
  if (!kids.some((k) => k?.content?.mod === mod)) kids.push({ id, type: "block", content: { mod } });
  fixActive(body);
  return null;
}
function dropPanel(l, mod) {
  const body = panelBody(l);
  if (!body) return 0;
  const before = body.children.length;
  body.children = body.children.filter((k) => k?.content?.mod !== mod);
  fixActive(body);
  return before - body.children.length;
}

// 각 단계: 쓸 모드, 기록 파일, 이미 반영됐는지, 바꾸는 함수, 되돌리는 함수(제거할 때).
// 기록 파일은 그 모드 폴더에 두므로, 모드를 지우면 기록도 함께 사라진다.
const STEPS = [
  {
    name: "에이전트 목록(agent-groups)",
    needs: ["agent-groups"],
    mark: ["agent-groups", ".agents-swapped"],
    done: (l) => usesMod(l, ["agent-groups"]),
    apply: (l) => (swapMod(l, "agents", "agent-groups") ? null : "agents 블록을 찾지 못했습니다."),
    undo: (l) => swapMod(l, "agent-groups", "agents"),
  },
  {
    name: "상태 줄(usage-status)",
    needs: ["usage-status"],
    mark: ["usage-status", ".status-swapped"],
    done: (l) => usesMod(l, ["usage-status"]),
    apply: (l) => (swapMod(l, "workspace-status", "usage-status") ? null : "workspace-status 블록을 찾지 못했습니다."),
    undo: (l) => swapMod(l, "usage-status", "workspace-status"),
  },
  {
    name: "탭 줄(tabs-mine)",
    needs: ["tabs-mine"],
    mark: ["tabs-mine", ".tabs-swapped"],
    done: (l) => usesMod(l, ["tabs-mine"]),
    apply: (l) => (swapMod(l, "tabs", "tabs-mine") ? null : "tabs 블록을 찾지 못했습니다."),
    undo: (l) => swapMod(l, "tabs-mine", "tabs"),
  },
  {
    name: "오른쪽 패널 Work(work)",
    needs: ["work"],
    mark: ["work", ".work-board-added"],
    done: () => false,
    apply: (l) => addPanel(l, "work-board", "work"),
    undo: (l) => dropPanel(l, "work"),
    after: (home) => fs.rmSync(path.join(modDir(home, "work"), ".panels-swapped"), { force: true }),
  },
  {
    name: "오른쪽 패널 PRs(prs)",
    needs: ["prs"],
    mark: ["prs", ".pr-board-added"],
    done: () => false,
    apply: (l) => addPanel(l, "pr-board", "prs"),
    undo: (l) => dropPanel(l, "prs"),
  },
  {
    name: "오른쪽 패널 예약(schedules)",
    needs: ["schedules"],
    mark: ["schedules", ".board-added"],
    done: () => false,
    apply: (l) => addPanel(l, "schedules-board", "schedules"),
    undo: (l) => dropPanel(l, "schedules"),
  },
  {
    // 계정 화면의 입구는 설정 창뿐이라(#126) 패널을 더하지 않고, 예전 설치가 더해 둔 accounts-board 는 갱신할 때 한 번 뺀다.
    // 기록 이름을 새로 정해 예전 .board-added 기록과 무관하게 한 번 돈다. 제거할 때도 남은 블록을 되돌린다.
    name: "오른쪽 패널 계정(gh-accounts) 정리",
    needs: ["gh-accounts"],
    mark: ["gh-accounts", ".board-dropped"],
    done: (l) => !(panelBody(l)?.children ?? []).some((k) => k?.content?.mod === "gh-accounts"),
    apply: (l) => { dropPanel(l, "gh-accounts"); return null; },
    undo: (l) => dropPanel(l, "gh-accounts"),
  },
  {
    name: "오른쪽 패널 UI 모드(inbox)",
    needs: ["inbox"],
    mark: ["inbox", ".board-added"],
    done: () => false,
    apply: (l) => addPanel(l, "inbox-board", "inbox"),
    undo: (l) => dropPanel(l, "inbox"),
  },
  {
    name: "칸 머리줄(leader-tabs)",
    needs: ["leader-tabs"],
    mark: ["leader-tabs", ".header-swapped"],
    done: (l) => usesMod(l, ["leader-tabs"]),
    apply: (l) => (swapHeader(l, "pane", "leader-tabs") ? null : "칸 머리줄(pane) 블록을 찾지 못했습니다."),
    undo: (l) => swapHeader(l, "leader-tabs", "pane"),
  },
  {
    name: "터미널 경로 메뉴(path-menu)",
    needs: ["path-menu"],
    mark: ["path-menu", ".link-handler-added"],
    done: (l) => linkHandlers(l).includes("path-menu"),
    apply: (l) => addLinkHandler(l, "path-menu"),
    undo: (l) => dropLinkHandler(l, "path-menu"),
  },
];

// 예전 설치기는 탭 줄·Work·PRs를 한 단계로 넣고 work/.panels-added 하나만 남겼다. 단계별 기록으로 옮긴다.
const LEGACY_PANELS = [["tabs-mine", ".tabs-swapped"], ["work", ".work-board-added"], ["prs", ".pr-board-added"]];
function migrateMarks(home) {
  const old = path.join(modDir(home, "work"), ".panels-added");
  if (!fs.existsSync(old)) return;
  for (const [mod, file] of LEGACY_PANELS) {
    if (ours(modDir(home, mod))) fs.writeFileSync(path.join(modDir(home, mod), file), "");
  }
  fs.rmSync(old, { force: true });
}

// UI 모드 레이아웃(<기본 레이아웃>-ui): 기본 레이아웃에서 터미널이 있는 main 칸(content.tab "active", 없으면 id "main")만 UI 모드로 바꾼 복사본.
// 터미널 모드(기본 레이아웃)와 `layout.switch`로 오간다. 만든 파일의 해시를 inbox 모드 폴더에 남겨, 사용자가 고친 파일은 다시 쓰지 않는다.
const UI_SUFFIX = "-ui";
const UI_MARK = ["inbox", ".ui-layout-hash" ];
const hashOf = (text) => require("node:crypto").createHash("sha1").update(text).digest("hex");
const uiMarkFile = (home) => path.join(modDir(home, UI_MARK[0]), UI_MARK[1]);
const readMark = (home) => { try { return fs.readFileSync(uiMarkFile(home), "utf8").trim(); } catch { return ""; } };
const uiText = (layout) => JSON.stringify(layout, null, 2) + "\n";

// 기본 레이아웃 객체에서 UI 모드 레이아웃 객체를 만든다. main 칸이 없으면 null.
function deriveUiLayout(base) {
  const ui = JSON.parse(JSON.stringify(base));
  let main = null;
  walk(ui, (n) => { if (!main && n.type === "block" && n.content?.tab === "active") main = n; });
  if (!main) walk(ui, (n) => { if (!main && n.type === "block" && n.id === "main") main = n; });
  if (!main) return null;
  main.content = { mod: "inbox", props: { mode: "main" } };
  delete ui.cloned_from;
  return ui;
}

function applyUiLayout(home, baseFile, baseLayout) {
  if (!available(home, "inbox")) return "skipped";
  const file = path.join(path.dirname(baseFile), path.basename(baseFile, ".json") + UI_SUFFIX + ".json");
  const ui = deriveUiLayout(baseLayout);
  if (!ui) { log("UI 모드 레이아웃: main(터미널) 칸을 찾지 못해 만들지 않았습니다."); return "skipped"; }
  const text = uiText(ui);
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch {}
  if (current === text) { fs.writeFileSync(uiMarkFile(home), hashOf(text) + "\n"); return "same"; }
  if (current !== null && hashOf(current) !== readMark(home)) {
    log(`${file} 은(는) 이 설치기가 만들었거나 그대로 둔 파일이 아니라 건드리지 않습니다.`);
    return "foreign";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeLayout(file, ui);
  fs.writeFileSync(uiMarkFile(home), hashOf(text) + "\n");
  log(`UI 모드 레이아웃을 ${current === null ? "만들었습니다" : "다시 만들었습니다"}: ${file} (탭 줄의 "전체 화면" 버튼으로 전환)`);
  return current === null ? "created" : "updated";
}

// inbox를 지울 때: 우리가 만든 그대로인 UI 모드 레이아웃만 지운다.
function removeUiLayout(home, baseFile) {
  const file = path.join(path.dirname(baseFile), path.basename(baseFile, ".json") + UI_SUFFIX + ".json");
  let current;
  try { current = fs.readFileSync(file, "utf8"); } catch { return false; }
  if (hashOf(current) !== readMark(home)) return false;
  fs.rmSync(file, { force: true });
  log(`UI 모드 레이아웃을 지웠습니다: ${file}`);
  log("UI 모드 화면을 보고 있었다면 Herdr에서 '터미널 모드'로 먼저 돌아오세요(보던 -ui 레이아웃이 없어집니다).");
  return true;
}

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
  migrateMarks(home);
  rememberLayout(home, file);
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
  const ui = applyUiLayout(home, file, layout);
  return { changed: changed.filter((c) => c.applied).map((c) => c.step.mark[1]), file, ui };
}

function pendingLayout(home) {
  const found = findLayout(home, false);
  return found ? "" : LAYOUT_NAME;
}

// 3) 제거. 남는 모드가 지우려는 모드를 쓰면 아무것도 지우지 않는다(blocked).
function removeMods(home, names) {
  const result = { removed: [], kept: [], missing: [], blocked: [] };
  const going = new Set(names);
  result.blocked = installedMods(home).filter((m) => !going.has(m) && withDeps([m]).mods.some((d) => going.has(d)));
  if (result.blocked.length) {
    for (const m of result.blocked) {
      const uses = withDeps([m]).mods.filter((d) => going.has(d));
      log(`${m} 이(가) ${uses.join(", ")} 을(를) 씁니다.`);
    }
    log(`아무것도 지우지 않았습니다. 함께 지우려면 이 이름으로 다시 실행하세요: ${ALL.filter((m) => going.has(m) || result.blocked.includes(m)).join(",")}`);
    return result;
  }
  const targets = [];
  for (const mod of ALL.filter((m) => going.has(m))) {
    const dir = modDir(home, mod);
    if (!fs.existsSync(dir)) { log(`${mod} 은(는) 설치돼 있지 않습니다.`); result.missing.push(mod); continue; }
    if (!ours(dir)) {
      log(`${dir} 은(는) 이 설치기가 만든 폴더가 아니라 지우지 않습니다.`);
      result.kept.push(mod);
      continue;
    }
    targets.push(mod);
  }
  if (!targets.length) return result;
  revertLayout(home, targets);
  for (const mod of targets) {
    fs.rmSync(modDir(home, mod), { recursive: true, force: true });
    log(`모드 제거: ${modDir(home, mod)}`);
    result.removed.push(mod);
  }
  log("모드 폴더 밖의 기록(예약 기록, PR 칸 기록, 캐시)은 지우지 않았습니다.");
  return result;
}

// 지울 모드가 바꾼 블록만 기본 블록으로 되돌린다. 사용자가 이미 바꾼 블록은 mod 이름이 달라 건드리지 않는다.
function revertLayout(home, mods) {
  const found = findLayout(home, false);
  if (!found || found.foreign) return;
  rememberLayout(home, found.file);
  let layout;
  try { layout = readLayout(found.file); } catch (e) {
    log(`레이아웃을 읽지 못해 되돌리지 않았습니다: ${found.file} (${e.message})`);
    return;
  }
  if (mods.includes("inbox")) removeUiLayout(home, found.file);
  const names = [];
  for (const step of STEPS) {
    if (mods.includes(step.mark[0]) && step.undo(layout)) names.push(step.name);
  }
  if (!names.length) return;
  writeLayout(found.file, layout);
  log(`레이아웃을 되돌렸습니다: ${names.join(", ")} (${found.file})`);
}

// 4) 목록
function modStatus(home, mod) {
  const dir = modDir(home, mod);
  if (!fs.existsSync(dir)) return "설치 안 됨";
  return ours(dir) ? "설치됨" : "표시 없는 같은 이름 폴더";
}
function listMods(home) {
  log(`Herdr 설정 폴더: ${home}`);
  for (const mod of ALL) {
    const kind = CORE.includes(mod) ? "기본" : "추가";
    const deps = MODS[mod].deps.length ? ` (함께 설치: ${MODS[mod].deps.join(", ")})` : "";
    log(`  ${mod} [${kind}, ${modStatus(home, mod)}] ${MODS[mod].desc}${deps}`);
  }
  return ALL.map((mod) => ({ mod, status: modStatus(home, mod) }));
}

// ---- PO hook: one entry in Claude Code's settings.json (Stop and UserPromptSubmit) that runs inbox/po-hook.cjs.
// Our entry is told apart from every other hook by its exact command shape: node "<home>/mods/inbox/po-hook.cjs" (what hookCommand writes).
const HOOK_EVENTS = ["Stop", "UserPromptSubmit"];
const HOOK_SCRIPT = "po-hook.cjs";
const HOOK_TIMEOUT_S = 5;
const isOurHook = (h) => h && typeof h.command === "string" && /^node "[^"\n\r]*[\\/]mods[\\/]inbox[\\/]po-hook\.cjs"$/.test(h.command);
const settingsPath = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(require("node:os").homedir(), ".claude"), "settings.json");
const hookScript = (home) => path.join(modDir(home, "inbox"), HOOK_SCRIPT);
// The command that runs the script with node (no sh needed: it runs the same on macOS, Linux and Windows).
function hookCommand(script) {
  if (/["\n\r]/.test(script)) throw new Error(`훅 스크립트 경로에 쓸 수 없는 글자가 있습니다: ${script}`);
  return `node "${script}"`;
}
// The settings object with our entry added to (or taken out of, `remove`) every event: {settings, changed}. Pure: the input is not changed.
// Everything else (other hooks, other groups, other keys) is kept as it is. An entry of ours that already has `command` is left alone; one
// with another command (the install moved) gets the new command. Throws a Korean message when `hooks` or an event has an unexpected shape:
// nothing is guessed, so nothing is written over it.
function mergeHook(settings, command, remove = false) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("설정 파일의 최상위가 객체가 아닙니다.");
  const out = JSON.parse(JSON.stringify(settings));
  let changed = false;
  if (out.hooks === undefined) { if (remove) return { settings: out, changed: false }; out.hooks = {}; }
  if (!out.hooks || typeof out.hooks !== "object" || Array.isArray(out.hooks)) throw new Error("설정 파일의 hooks가 객체가 아닙니다.");
  for (const ev of HOOK_EVENTS) {
    if (out.hooks[ev] === undefined) {
      if (remove) continue;
      out.hooks[ev] = [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }];
      changed = true;
      continue;
    }
    const groups = out.hooks[ev];
    if (!Array.isArray(groups)) throw new Error(`설정 파일의 hooks.${ev}가 배열이 아닙니다.`);
    for (const g of groups) if (!g || typeof g !== "object" || (g.hooks !== undefined && !Array.isArray(g.hooks))) throw new Error(`설정 파일의 hooks.${ev} 항목 모양을 알 수 없습니다.`);
    if (remove) {
      for (const g of groups) {
        const keep = (g.hooks ?? []).filter((h) => !isOurHook(h));
        if (keep.length !== (g.hooks ?? []).length) { g.hooks = keep; changed = true; }
      }
      const left = groups.filter((g) => !((g.hooks ?? []).length === 0 && Array.isArray(g.hooks)));
      if (left.length !== groups.length) { out.hooks[ev] = left; changed = true; }
      if (!out.hooks[ev].length) delete out.hooks[ev];
      continue;
    }
    const mine = groups.flatMap((g) => (g.hooks ?? []).filter(isOurHook));
    if (!mine.length) { groups.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }); changed = true; continue; }
    for (const h of mine) if (h.command !== command) { h.command = command; changed = true; }
  }
  if (remove && !Object.keys(out.hooks).length) delete out.hooks;
  return { settings: out, changed };
}
const indentOf = (text) => { const m = /\n([ \t]+)\S/.exec(text); return m ? m[1] : "  "; };
// Install or remove the hook entry in the settings file `file`. Returns {status, file, backup?}:
//   status "installed" | "updated"-free: "installed" (added or fixed), "present" (already there, nothing written), "removed", "absent" (nothing to remove),
//   "skipped" (the script is not installed), "invalid" (the file is not usable JSON: nothing written; `error` says why).
// The file is backed up (<file>.bak-herdr-<time>) before it is changed and replaced atomically (a temp file in the same folder, then rename);
// a symlinked settings file is written through the link. A missing file is created on install.
function hookSettings(home, file, remove = false, now = Date.now()) {
  const script = hookScript(home);
  if (!remove && !fs.existsSync(script)) return { status: "skipped", file, error: `${script} 이(가) 없습니다. inbox 모드를 먼저 설치하세요.` };
  let real = file;
  try { real = fs.realpathSync(file); } catch {}
  let text = null;
  try { text = fs.readFileSync(real, "utf8"); } catch (e) { if (e.code !== "ENOENT") return { status: "invalid", file, error: `설정 파일을 읽지 못했습니다: ${e.message}` }; }
  let cur = {};
  if (text !== null) {
    try { cur = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { return { status: "invalid", file, error: `설정 파일이 올바른 JSON이 아니라 건드리지 않았습니다: ${e.message}` }; }
  } else if (remove) return { status: "absent", file };
  let merged;
  try { merged = mergeHook(cur, hookCommand(script), remove); } catch (e) { return { status: "invalid", file, error: `${e.message} 건드리지 않았습니다.` }; }
  if (!merged.changed) return { status: remove ? "absent" : "present", file };
  const body = JSON.stringify(merged.settings, null, text === null ? 2 : indentOf(text)) + (text === null || text.endsWith("\n") ? "\n" : "");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  let backup;
  if (text !== null) {
    backup = `${real}.bak-herdr-${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    fs.copyFileSync(real, backup);
  }
  const tmp = `${real}.tmp-herdr-${process.pid}`;
  let mode = 0o600;
  try { mode = fs.statSync(real).mode & 0o777; } catch {}
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, real);
  return { status: remove ? "removed" : "installed", file, ...(backup ? { backup } : {}) };
}

// 혼자 모드 기록 표시(inbox 폴더의 solo.on)를 켜거나 끈다. 방 목록의 "혼자 모드 켜기" 버튼과 같은 표시다. 켜진 상태를 돌려준다.
function soloSetting(on, dir) {
  const I = require("./mods/inbox/inbox.cjs");
  return I.setSolo(dir || I.inboxDir(), on);
}

module.exports = {
  CORE, EXTRAS, ALL, MODS, MARK, LEGACY_MARK, LAYOUT_NAME,
  parseArgs, installMods, applyLayout, deriveUiLayout, pendingLayout, removeMods, listMods,
  HOOK_EVENTS, HOOK_SCRIPT, isOurHook, settingsPath, hookScript, hookCommand, mergeHook, hookSettings, soloSetting,
};

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    log(e.message);
    process.exit(2);
  }
  if (args.cmd === "mods") installMods(args.home, args);
  else if (args.cmd === "remove") { if (removeMods(args.home, args.mods).blocked.length) process.exit(2); }
  else if (args.cmd === "list") listMods(args.home);
  else if (args.cmd === "pending-layout") { const name = pendingLayout(args.home); if (name) log(name); }
  else if (args.cmd === "layout") applyLayout(args.home, args.created);
  else if (args.cmd === "hook") {
    if (args.remove && args.solo) { // `--remove --solo` only turns the solo recording off; the PO hook stays
      try { soloSetting(false); log("혼자 모드 기록을 껐습니다(PO 훅은 그대로 둡니다)."); } catch (e) { log(`혼자 모드 기록 표시를 바꾸지 못했습니다: ${e.message}`); process.exit(1); }
      return;
    }
    const r = hookSettings(args.home, args.settings || settingsPath(), args.remove);
    const say = { installed: `PO 훅을 넣었습니다: ${r.file}${r.backup ? ` (백업: ${r.backup})` : ""}. 이미 켜진 PO 세션은 다시 시작해야 적용됩니다.`, present: `PO 훅이 이미 들어 있습니다: ${r.file}`, removed: `PO 훅을 뺐습니다: ${r.file}${r.backup ? ` (백업: ${r.backup})` : ""}`, absent: `뺄 PO 훅이 없습니다: ${r.file}`, skipped: `PO 훅은 넣지 않았습니다. ${r.error}`, invalid: `PO 훅을 넣지 못했습니다. ${r.error}` };
    log(say[r.status]);
    if (r.status === "invalid") process.exit(1);
    if (args.solo) {
      try { log(soloSetting(true) ? "혼자 모드 기록을 켰습니다(모든 Claude 터미널의 프롬프트가 이 컴퓨터에 저장됩니다)." : "혼자 모드 기록을 켜지 못했습니다."); } catch (e) { log(`혼자 모드 기록 표시를 바꾸지 못했습니다: ${e.message}`); process.exit(1); }
    }
  }
  else { log(`알 수 없는 명령: ${args.cmd}`); process.exit(2); }
}
