// 프로필 preset(po | none, #124): 고르는 법, 키 덮어쓰기, 자동 판별, 그리고 none일 때 각 모드의 규칙: node --test herdr/test/preset.test.cjs
// 이 파일은 po-home 도우미를 쓰지 않는다: 홈을 직접 정해서(env.HOME) 자동 판별을 시험한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const P = require("../mods/inbox/profile.cjs");
const I = require("../mods/inbox/inbox.cjs");
const MODS = path.join(__dirname, "..", "mods");
const read = (f) => fs.readFileSync(path.join(MODS, f), "utf8").replace(/\r\n/g, "\n");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "preset-"));
// A home with (po) or without (none) the arrange script, and an inbox folder with the given profile text (null = no profile file).
function envOf({ script = false, profile = null } = {}) {
  const home = tmp(), inbox = tmp();
  if (script) {
    const f = path.join(home, ".claude", "skills", "leader", "herdr-team.sh");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "#!/bin/sh\n");
  }
  if (profile !== null) fs.writeFileSync(path.join(inbox, "profile.json"), typeof profile === "string" ? profile : JSON.stringify(profile));
  return { HOME: home, USERPROFILE: home, HERDR_INBOX_DIR: inbox };
}
const load = (o) => P.loadProfile(envOf(o));

test("자동 판별: 프로필 파일이 없으면 arrange 스크립트가 있을 때 po, 없을 때 none", () => {
  assert.equal(load({ script: true }).preset, "po");
  assert.equal(load({ script: false }).preset, "none");
});

test("자동 판별: preset 키 없는 프로필 파일은 예전처럼 po 기본값 위에 덮는다(스크립트가 없어도)", () => {
  const p = load({ script: false, profile: { v: 1, agent: { name: "^bot-" } } });
  assert.equal(p.preset, "po");
  assert.equal(p.hubRole, "po");
  assert.equal(p.agentName.source, "^bot-");
});

test("preset 키가 자동 판별보다 앞선다", () => {
  assert.equal(load({ script: true, profile: { preset: "none" } }).preset, "none");
  assert.equal(load({ script: false, profile: { preset: "po" } }).preset, "po");
});

test("모르는 preset 값은 조용히 넘기지 않고 오류다", () => {
  assert.throws(() => load({ profile: { preset: "solo" } }), (e) => e instanceof P.ProfileError && /preset/.test(e.message));
  assert.throws(() => load({ profile: { preset: 1 } }), P.ProfileError);
});

test("po preset은 지금의 기본 프로필과 같다: 이름·라벨·허브 모두", () => {
  const p = load({ script: true, profile: { preset: "po" } });
  assert.deepEqual(P.namesOf(p), P.namesOf(load({ script: true })));
  assert.equal(p.agentName.source, "^lead-[a-z0-9_-]+$");
  assert.equal(p.agentRole, "leader");
  assert.equal(p.hubRole, "po");
  assert.equal(p.hubDir, "po");
  assert.equal(p.agentTitlePrefix, "리더 · ");
});

test("none preset: 에이전트 이름·허브·접두어 규칙이 하나도 없다", () => {
  const p = load({ script: false });
  assert.equal(p.agentName.test("lead-demo"), false);
  assert.equal(p.agentName.test(""), false);
  assert.equal(p.agentRole, "");
  assert.equal(p.hubRole, "");
  assert.equal(p.hubId.test("po-1"), false);
  assert.equal(p.agentTitlePrefix, "");
  assert.equal(p.agentStrip, null);
  const n = P.namesOf(p);
  assert.equal(n.preset, "none");
  assert.equal(n.titlePrefix, "");
  assert.equal(n.strip, "");
  assert.equal(n.arrangeScript, "");
  assert.equal(n.labelWait, "wait"); // the labels are not naming rules: they stay
});

test("키를 적으면 preset 위에 덮는다: none에 이름 규칙을, po에서 허브 이름을", () => {
  const a = load({ profile: { preset: "none", agent: { name: "^bot-[a-z]+$", role: "agentx" }, hub: { role: "desk" } } });
  assert.equal(a.preset, "none");
  assert.equal(a.agentName.test("bot-x"), true);
  assert.equal(a.agentRole, "agentx");
  assert.equal(a.hubRole, "desk");
  assert.equal(a.hubId.test("po-1"), false); // not overridden: still the never-matching none pattern
  const b = load({ profile: { preset: "po", hub: { role: "desk" } } });
  assert.equal(b.hubRole, "desk");
  assert.equal(b.agentName.source, "^lead-[a-z0-9_-]+$");
});

test("허브 role이 비는 건 none뿐이다: po에서 빈 role은 예전처럼 오류", () => {
  assert.throws(() => load({ profile: { preset: "po", hub: { role: "" } } }), P.ProfileError);
  assert.equal(load({ profile: { preset: "none", hub: { role: "" } } }).hubRole, "");
});

test("arrangeScript: po 기본 경로는 파일이 있을 때만 나오고, 키로 바꾸거나 끌 수 있다", () => {
  assert.equal(load({ script: true }).arrangeScript, P.PO_ARRANGE_SCRIPT);
  assert.equal(load({ script: false, profile: { preset: "po" } }).arrangeScript, ""); // missing file: the feature hides
  assert.equal(load({ script: true, profile: { preset: "po", arrangeScript: "" } }).arrangeScript, "");
  const o = envOf({ script: false, profile: null });
  const mine = path.join(o.HOME, "my-arrange.sh");
  fs.writeFileSync(mine, "#!/bin/sh\n");
  fs.writeFileSync(path.join(o.HERDR_INBOX_DIR, "profile.json"), JSON.stringify({ preset: "none", arrangeScript: mine }));
  assert.equal(P.loadProfile(o).arrangeScript, mine);
  fs.writeFileSync(path.join(o.HERDR_INBOX_DIR, "profile.json"), JSON.stringify({ arrangeScript: "~/my-arrange.sh" }));
  assert.equal(P.loadProfile(o).arrangeScript, "~/my-arrange.sh"); // `~` is kept: the shell and the mods expand it
});

test("namesOf: po 기본값은 데스크 사본(DEFAULT_NAMES)과 같고 none은 규칙이 비어 있다", () => {
  assert.deepEqual(P.namesOf(load({ script: true })), { ...I.DEFAULT_NAMES });
});

// ---- none일 때 모드 도우미 ----

const NONE = () => P.namesOf(load({ script: false }));
test("inbox.cjs: none이면 리더도 허브도 알아보지 못하고, 기본값으로 되돌리면 그대로다", () => {
  I.setNames(NONE());
  try {
    const lead = { name: "lead-demo", labels: { role: "leader" } };
    const po = { name: "po", labels: { role: "po", po: "po-1" } };
    assert.equal(I.isAgentName("lead-demo"), false);
    assert.equal(I.isAgentTerm(lead), false);
    assert.equal(I.isHubTerm(po), false);
    assert.equal(I.poId(po), "");
    assert.equal(I.cleanPoId("po-1"), "");
  } finally { I.setNames(null); }
  assert.equal(I.isAgentName("lead-demo"), true);
  assert.equal(I.isHubTerm({ labels: { role: "po" } }), true);
});

test("모든 모드 사본의 블록은 DEFAULT_NAMES에 preset·arrangeScript가 있다", () => {
  for (const f of ["inbox/main.js", "inbox/inbox.cjs", "leader-tabs/main.js", "agent-groups/main.js", "work/main.js", "tabs-mine/main.js", "prs/main.js"]) {
    assert.match(read(f), /preset: "po", arrangeScript: "~\/\.claude\/skills\/leader\/herdr-team\.sh"/, f);
  }
});

test("leader-tabs: arrange 스크립트는 프로필 경로를 $2로 받고, 경로가 없으면 스크립트 없이 한 리더만 남긴다", () => {
  const src = read("leader-tabs/main.js");
  assert.doesNotMatch(src, /herdr-team\.sh"; \[ -f/, "no hard-coded path in the shell text");
  assert.match(src, /if \(!NAMES\.arrangeScript\) \{ keep\(\); return; \}/);
  assert.match(src, /"sh", po\.address, NAMES\.arrangeScript\]/);
  // The shell snippet itself: `~/` expands to $HOME, a missing file ends with 127 (the mod then keeps a leader itself), an existing one runs.
  const ARRANGE = src.match(/^const ARRANGE = '(.*)';$/m)[1];
  const home = tmp();
  const script = path.join(home, "arr.sh");
  fs.writeFileSync(script, '#!/bin/sh\necho "arranged $HC_TERMINAL_ID $1"\n');
  const sh = (arg) => spawnSync("sh", ["-c", ARRANGE, "sh", "t7", arg], { encoding: "utf8", env: { ...process.env, HOME: home } });
  const viaTilde = sh("~/arr.sh");
  assert.equal(viaTilde.status, 0, viaTilde.stderr);
  assert.equal(viaTilde.stdout.trim(), "arranged t7 arrange");
  assert.equal(sh(script).stdout.trim(), "arranged t7 arrange");
  assert.equal(sh("~/missing.sh").status, 127);
  assert.equal(sh("").status, 127);
});

test("prs: arrange 스크립트가 없으면(none) 창 목록 기록(PANES_FILE)을 건너뛴다", () => {
  assert.match(read("prs/main.js"), /if \(writing \|\| checking\(\) \|\| !NAMES\.arrangeScript\) return;/);
});

test("tabs-mine: none이면 이름과 상관없이 대기 라벨(decision|verify)이 붙은 터미널을 센다; po는 에이전트 이름만", async () => {
  const src = read("tabs-mine/main.js");
  const block = src.slice(src.indexOf("// names:begin"), src.indexOf("// names:end"));
  const wk = src.match(/^const waitingKind = .*$/m)[0];
  const count = src.match(/^\s*inboxWaiting\(\) \{.*\}$/m)[0].replace(/^\s*inboxWaiting\(\) /, "function inboxWaiting() ").replace("(terminals() ?? [])", "(TERMS)");
  // The desk publishes its profile through shared(); the mod reads it with syncNames().
  const run = (names, terms) => new Function("shared", "TERMS", `${block}\n${wk}\n${count}\nreturn inboxWaiting();`)(() => names, terms);
  const terms = [
    { name: "lead-a", labels: { wait: "decision" } },
    { name: "plain", labels: { wait: "verify" } },
    { name: "other", labels: { wait: "later" } },
    { name: "plain2", labels: {} },
  ];
  assert.equal(run(NONE(), terms), 2); // any terminal with a decision|verify label
  assert.equal(run(undefined, terms), 1); // the default: only lead-* names
});

test("agent-groups: none이면 부모가 있는 터미널이 팀원이고 이름 규칙(dev-N, lead-*, 탭 이름)은 쓰지 않는다", async () => {
  const src = read("agent-groups/main.js");
  const stub = "const View = class {}; const div = () => ({}); const svg = div, image = div, h_flex = div, v_flex = div;" +
    "const agents = () => [], terminals = () => [], panes = () => [], focused = () => null, spaces = () => [];" +
    "const run = () => {}, theme = () => ({}), shared = () => null, setShared = () => {}, setAgentOrder = () => {};" +
    "const openOverlay = () => {}, closeOverlay = () => {}, props = () => ({}), window = () => ({}), layout = () => ({});";
  const body = src.replace(/^import .*$/gm, "") + "\nexport { setNames };";
  const m = await import(`data:text/javascript;base64,${Buffer.from(stub + body).toString("base64")}`);
  const term = (address, name, parent, labels = {}) => ({ address, name, parent, state: "live", labels });
  const agent = (address, seq, tab_name) => ({ address, seq, space: "s1", space_name: "repo", tab: "tab-" + address, tab_name, pane: address });
  // t1 is a plain terminal that spawned t2 (a child); t3 is a child of t2; t9 is a stray child of a parent nobody listed; t8 stands alone.
  const all = [term("t1", "main", null), term("t2", "dev-5-x", "t1"), term("t3", "worker", "t2"), term("t9", "stray", "tX"), term("t8", "solo", null)];
  const list = [agent("t1", 0, "work"), agent("t2", 1, "개발 · #5 일"), agent("t3", 2, "w"), agent("t9", 3, "s"), agent("t8", 4, "solo")];
  m.setNames(NONE());
  const [sp] = m.taskPlan(list, all);
  assert.deepEqual(sp.poTiers, []);
  assert.deepEqual(sp.sections.map((s) => s.leader.address), ["t1"]); // t1 has children: a section of its own
  assert.deepEqual(sp.sections[0].members.map((a) => a.address), ["t2", "t3"]); // grouped by parent chain only, the dev-5 name and tab are ignored
  assert.deepEqual(sp.loose, []); // no issue numbers: nothing is grouped by issue
  assert.deepEqual(sp.others.map((a) => a.address).sort(), ["t8", "t9"]); // a parent we cannot place, or no parent: plain agents
  // Paneless children get entries too (a parent chain is all they need).
  const ghosts = m.paneless([list[0]], all);
  assert.deepEqual(ghosts.map((g) => g.address).sort(), ["t2", "t3"]);
  m.setNames(null); // the default again: the same data now follows the names
  const [sp2] = m.taskPlan(list, all);
  assert.deepEqual(sp2.loose.map((g) => g.issue), []);
});
