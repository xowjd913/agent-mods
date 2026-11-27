// 프로필 이름 블록이 모든 모드에 같은 모양으로 들어가 있고, 인박스가 읽은 이름을 다른 모드가 받아 쓰는지: node --test herdr/test/profile-share.test.cjs
require("./helpers/po-home.cjs"); // a PO machine: a profile without `preset` is "po" (see the helper)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROFILE = require("../mods/inbox/profile.cjs");
const FILES = ["inbox/main.js", "inbox/inbox.cjs", "leader-tabs/main.js", "agent-groups/main.js", "work/main.js", "tabs-mine/main.js", "prs/main.js"];
const read = (f) => fs.readFileSync(path.join(__dirname, "..", "mods", f), "utf8").replace(/\r\n/g, "\n");
const blockOf = (f) => {
  const src = read(f);
  const a = src.indexOf("// names:begin"), b = src.indexOf("// names:end");
  assert.ok(a >= 0 && b > a, f);
  return src.slice(a, b);
};
const BOT = { v: 1, agent: { name: "^bot-[a-z0-9]+$", role: "agentx", titlePrefix: "봇 · ", strip: "^bot-" }, hub: { role: "desk", idLabel: "room", id: "^[a-z0-9]{1,12}$", dir: "rooms" }, labels: { role: "kind", wait: "needs", waitLink: "needs-link", session: "who" } };
const botDir = (profile = BOT) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-share-"));
  fs.writeFileSync(path.join(dir, "profile.json"), typeof profile === "string" ? profile : JSON.stringify(profile));
  return dir;
};

// 모드가 사는 곳처럼 shared/setShared를 가짜로 둔 채 블록만 실행한다.
function load(file, shared = {}) {
  const sets = [];
  const api = new Function("shared", "setShared", `${blockOf(file)}\nreturn { DEFAULT_NAMES, setNames, adoptNames, syncNames, isAgentName, isAgentTerm, isHubTerm, labelOf, NAMES_SHARED };`)(
    (k) => shared[k], (k, v) => { shared[k] = v; sets.push(k); });
  return { ...api, shared, sets };
}

test("names 블록은 일곱 파일에서 한 글자도 다르지 않다", () => {
  const first = blockOf(FILES[0]);
  for (const f of FILES.slice(1)) assert.equal(blockOf(f), first, f);
});

test("모든 사본의 기본값은 기본 프로필(profile.cjs)과 같다", () => {
  const dflt = PROFILE.namesOf(PROFILE.loadProfile({ HERDR_INBOX_DIR: path.join(os.tmpdir(), "profile-share-none") }));
  for (const f of FILES) assert.deepEqual({ ...load(f).DEFAULT_NAMES }, dflt, f);
});

test("adoptNames는 이름을 적용하고 공유 키에 올리며, 같은 이름을 다시 올리지 않는다", () => {
  const n = PROFILE.namesOf(PROFILE.loadProfile({ HERDR_INBOX_DIR: botDir() }));
  const a = load("work/main.js");
  assert.equal(a.isAgentName("lead-x"), true);
  assert.equal(a.adoptNames(n), true);
  assert.equal(a.isAgentName("lead-x"), false);
  assert.equal(a.isAgentName("bot-x"), true);
  assert.deepEqual(a.shared[a.NAMES_SHARED], n);
  assert.equal(a.adoptNames(n), false); // 달라진 게 없다
  assert.deepEqual(a.sets, [a.NAMES_SHARED]); // 공유 키는 한 번만 썼다
});

test("다른 모드는 syncNames로 인박스가 올린 이름을 따르고, 올린 게 없으면 기본 이름이다", () => {
  const n = PROFILE.namesOf(PROFILE.loadProfile({ HERDR_INBOX_DIR: botDir() }));
  for (const f of ["leader-tabs/main.js", "agent-groups/main.js", "tabs-mine/main.js", "prs/main.js"]) {
    const m = load(f, {});
    m.syncNames(); // nothing published: the defaults
    assert.equal(m.syncNames(), false, f);
    assert.equal(m.isAgentName("lead-x"), true, f);
    m.shared[m.NAMES_SHARED] = n;
    assert.equal(m.syncNames(), true, f);
    assert.equal(m.isAgentName("lead-x"), false, f);
    assert.equal(m.isAgentTerm({ labels: { kind: "agentx" } }), true, f);
    assert.equal(m.isHubTerm({ labels: { kind: "desk" } }), true, f);
    assert.equal(m.isHubTerm({ labels: { role: "po" } }), false, f);
    assert.equal(m.labelOf({ labels: { needs: "Decision" } }, "labelWait"), "Decision", f);
    delete m.shared[m.NAMES_SHARED]; // 이름이 지워지면 기본으로 돌아온다
    m.syncNames();
    assert.equal(m.isAgentName("lead-x"), true, f);
  }
});

test("shared가 없거나 던져도 블록은 죽지 않는다", () => {
  const b = new Function(`${blockOf("leader-tabs/main.js")}\nreturn { adoptNames, syncNames, isAgentName };`)();
  assert.equal(b.syncNames(), false);
  assert.equal(b.adoptNames({ agentName: "^bot-" }), true);
  const t = new Function("shared", `${blockOf("prs/main.js")}\nreturn { syncNames, isAgentName };`)(() => { throw new Error("boom"); });
  assert.equal(t.syncNames(), false);
  assert.equal(t.isAgentName("lead-x"), true);
});

test("모드 코드에는 기본 이름이 굳어 있지 않다(블록 밖)", () => {
  for (const f of FILES) {
    const src = read(f);
    const outside = src.slice(0, src.indexOf("// names:begin")) + src.slice(src.indexOf("// names:end"));
    assert.ok(!/\/\^lead-/.test(outside), `${f}: /^lead-`);
    assert.ok(!/role\s*===?\s*["']po["']/.test(outside), `${f}: role po`);
    assert.ok(!/["']leader["']\s*===/.test(outside), `${f}: role leader`);
    assert.ok(!/labels\??\.session\b/.test(outside), `${f}: session label name`);
    assert.ok(!/\/\^리더|\/\^PO\(\?:/.test(outside), `${f}: leader/PO tab-name pattern`);
    assert.ok(!/`리더 · \$\{/.test(outside), `${f}: leader title prefix`);
  }
});

test("모드가 이름을 받는 자리: 인박스·work는 올리고(adoptNames), 나머지는 읽는다(syncNames)", () => {
  assert.match(read("inbox/main.js"), /\badoptNames\(d\?\.names\)/); // the desk publishes inbox.names; a bare setNames there left leader-tabs & co. on the defaults
  assert.doesNotMatch(read("inbox/main.js"), /\bsetNames\(d\?\.names\)/);
  assert.match(read("work/main.js"), /adoptNames\(d\.names\)/);
  assert.match(read("work/main.js"), /profileError/);
  assert.match(read("prs/main.js"), /adoptNames\(/);
  assert.match(read("prs/main.js"), /profileError/);
  for (const f of ["leader-tabs/main.js", "agent-groups/main.js", "tabs-mine/main.js", "prs/main.js"]) assert.match(read(f), /syncNames\(\)/, f);
  assert.ok((read("leader-tabs/main.js").match(/\bsyncNames\(\)/g) || []).length >= 2); // leaders() and reseat()
});

test("work/collect.cjs: 프로필을 읽은 names와 세션 라벨 이름을 JSON으로 내고, 깨진 프로필은 profileError로 알린다", () => {
  const collect = path.join(__dirname, "..", "mods", "work", "collect.cjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profile-share-home-"));
  const run = (inboxDir) => spawnSync(process.execPath, [collect], { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: home, HERDR_INBOX_DIR: inboxDir, PATH: "/usr/bin:/bin" } });
  const ok = run(botDir());
  assert.equal(ok.status, 0, ok.stderr);
  const d = JSON.parse(ok.stdout);
  assert.equal(d.profileError, "");
  assert.equal(d.names.labelSession, "who");
  assert.equal(d.names.agentName, "^bot-[a-z0-9]+$");
  const none = JSON.parse(run(path.join(os.tmpdir(), "profile-share-missing")).stdout);
  assert.equal(none.profileError, "");
  assert.equal(none.names.agentName, "^lead-[a-z0-9_-]+$");
  const bad = JSON.parse(run(botDir("{ nope")).stdout);
  assert.match(bad.profileError, /profile/);
  assert.equal(bad.names, null);
});

test("설치기: work 모드에 profile.cjs를 함께 복사하고 인박스 것과 같다", () => {
  const inst = require("../install.cjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "profile-share-install-"));
  const log = console.log; console.log = () => {};
  try { inst.installMods(home, false); } finally { console.log = log; }
  assert.equal(fs.readFileSync(path.join(home, "mods", "work", "profile.cjs"), "utf8"), fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "profile.cjs"), "utf8"));
});

test("agent-groups: PO·리더 탭 이름 규칙은 프로필의 허브 이름·접두어를 따른다", () => {
  const src = read("agent-groups/main.js");
  const fn = (name) => { const m = src.match(new RegExp(`^const ${name} = .*$`, "m")); assert.ok(m, name); return m[0]; };
  const run = (names) => new Function(`${blockOf("agent-groups/main.js")}\n${fn("poTab")}\n${fn("leaderTab")}\nsetNames(${JSON.stringify(names)});\nreturn { poTab, leaderTab };`)();
  const d = run(undefined); // default profile: as before
  assert.equal(d.poTab("PO · repo"), true);
  assert.equal(d.poTab("PO"), true);
  assert.equal(d.poTab("POLICY"), false);
  assert.equal(d.poTab("DESK · x"), false);
  assert.equal(d.leaderTab("리더 · repo"), true);
  assert.equal(d.leaderTab("봇 · repo"), false);
  const b = run(PROFILE.namesOf(PROFILE.loadProfile({ HERDR_INBOX_DIR: botDir() })));
  assert.equal(b.poTab("DESK · x"), true);
  assert.equal(b.poTab("DESKTOP"), false);
  assert.equal(b.poTab("PO · x"), false);
  assert.equal(b.leaderTab("봇 · x"), true);
  assert.equal(b.leaderTab("리더 · x"), false);
});
