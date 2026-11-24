// gh-account(저장소별 GitHub 계정) 테스트. 실행: node --test herdr/test/gh-account.test.cjs
// 진짜 gh·git 설정은 건드리지 않는다. gh 는 가짜 run 이나 가짜 셸 스크립트, git 설정은 임시 HOME·GIT_CONFIG_GLOBAL 을 쓴다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ga = require("../gh-account/gh-account.cjs");
const CLI = path.join(__dirname, "..", "gh-account", "gh-account.cjs");
const POSIX = process.platform !== "win32";

function tmpdir(name = "gh-account") { return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); }

// 가짜 gh: acct-a, acct-b 만 로그인돼 있다. 그 밖의 명령은 결과를 기록만 한다.
function fakeRun({ logged = ["acct-a", "acct-b"], remotes = {}, gitVersion = "git version 2.45.0", calls = [] } = {}) {
  return (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    if (cmd === "fake-gh" && args[0] === "auth" && args[1] === "token") {
      const user = args[args.indexOf("--user") + 1];
      return logged.includes(user) ? { status: 0, stdout: `tok-${user}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "no account" };
    }
    if (cmd === "fake-gh" && args[0] === "api" && args[1] === "user") {
      const login = String(opts.env.GH_TOKEN || "").replace(/^tok-/, "");
      if (!logged.includes(login)) return { status: 1, stdout: "", stderr: "401" };
      return { status: 0, stdout: JSON.stringify({ id: 1000 + login.charCodeAt(5), login, name: login === "acct-a" ? "Person A" : null }), stderr: "" };
    }
    if (cmd === "git" && args[0] === "version") return { status: 0, stdout: gitVersion + "\n", stderr: "" };
    if (cmd === "git" && args[0] === "remote") {
      const url = remotes[opts.cwd];
      return url ? { status: 0, stdout: url + "\n", stderr: "" } : { status: 2, stdout: "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "config") return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

function setup(map, opts = {}) {
  const home = tmpdir();
  const app = path.join(home, "app");
  fs.mkdirSync(app, { recursive: true });
  if (map !== undefined) fs.writeFileSync(path.join(app, "gh-accounts.json"), typeof map === "string" ? map : JSON.stringify(map));
  const calls = [];
  const env = { HOME: home, HERDR_APP_HOME: app, GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GH_ACCOUNT_GH: "fake-gh", PATH: "", ...(opts.env || {}) };
  const ctx = ga.makeCtx({ env, cwd: "/w/repo", run: fakeRun({ remotes: { "/w/repo": "https://github.com/example-org/app.git", ...(opts.remotes || {}) }, calls, ...opts }), platform: "linux" });
  return { home, app, ctx, calls };
}

function io(stdin = "") {
  const o = { lines: [], errs: [], raw: "" };
  return { o, io: { out: (s) => o.lines.push(s), err: (s) => o.errs.push(s), raw: (s) => { o.raw += s; }, stdin: () => stdin, isTTY: false } };
}

const MAP = { rules: [{ match: "example-org/*", account: "acct-b" }, { match: "acct-a/special", account: "acct-b" }], default: null };

test("parseRepo: https, scp, ssh, owner/repo 를 읽고 다른 호스트는 버린다", () => {
  const ok = { owner: "example-org", repo: "app" };
  for (const s of ["https://github.com/example-org/app.git", "https://user@github.com/example-org/app", "git@github.com:example-org/app.git",
    "ssh://git@github.com/example-org/app.git", "example-org/app", "github.com/example-org/app", "https://github.com/example-org/app/pull/3"]) {
    assert.deepEqual(ga.parseRepo(s), ok, s);
  }
  for (const s of ["https://gitlab.com/o/r", "git@gitlab.com:o/r.git", "o", "a/b/c", "", null, "../x", "https://github.com/o"]) {
    assert.equal(ga.parseRepo(s), null, String(s));
  }
});

test("readMap: 없으면 빈 매핑, 깨지면 ok:false, 잘못된 규칙은 버린다", () => {
  const d = tmpdir();
  assert.deepEqual(ga.readMap(path.join(d, "none.json")), { ok: true, map: ga.emptyMap() });
  fs.writeFileSync(path.join(d, "bad.json"), "{nope");
  assert.equal(ga.readMap(path.join(d, "bad.json")).ok, false);
  fs.writeFileSync(path.join(d, "m.json"), JSON.stringify({ rules: [{ match: "bad pattern", account: "x" }, { match: "o/*", account: "acct-a" }, { match: "o/r", account: "a b" }], default: "acct-b" }));
  const m = ga.readMap(path.join(d, "m.json"));
  assert.deepEqual(m.map.rules, [{ match: "o/*", account: "acct-a" }]);
  assert.equal(m.map.default, "acct-b");
});

test("matchAccount: 첫 규칙이 이기고 대소문자를 가리지 않으며, 없으면 default", () => {
  const map = { rules: [{ match: "Example-Org/app", account: "acct-a" }, { match: "example-org/*", account: "acct-b" }], default: "acct-c", accounts: {} };
  assert.equal(ga.matchAccount(map, { owner: "example-org", repo: "APP" }).account, "acct-a");
  assert.equal(ga.matchAccount(map, { owner: "example-org", repo: "other" }).account, "acct-b");
  assert.deepEqual(ga.matchAccount(map, { owner: "someone", repo: "x" }), { account: "acct-c", by: "default", match: null });
  assert.equal(ga.matchAccount({ ...map, default: null }, { owner: "someone", repo: "x" }), null);
  assert.equal(ga.matchAccount(map, null), null);
});

test("repoFromGhArgs: -R, URL, gh repo, gh api, GH_REPO 순서", () => {
  const r = (args, env) => { const x = ga.repoFromGhArgs(args, env); return x && `${x.owner}/${x.repo}`; };
  assert.equal(r(["pr", "list", "-R", "o/a"]), "o/a");
  assert.equal(r(["pr", "list", "--repo=o/b"]), "o/b");
  assert.equal(r(["pr", "list", "-Ro/c"]), "o/c");
  assert.equal(r(["pr", "view", "https://github.com/o/d/pull/1"]), "o/d");
  assert.equal(r(["repo", "clone", "o/e", "--", "--depth=1"]), "o/e");
  assert.equal(r(["api", "repos/o/f/pulls"]), "o/f");
  assert.equal(r(["api", "/repos/o/g"]), "o/g");
  assert.equal(r(["pr", "list"], { GH_REPO: "o/h" }), "o/h");
  assert.equal(r(["pr", "list", "-R", "o/a"], { GH_REPO: "o/h" }), "o/a");
  assert.equal(r(["pr", "list"]), null);
  assert.equal(r(["issue", "create", "--title", "a/b"]), null);
});

test("credential: 매핑된 저장소는 그 계정 토큰, 아니면 아무것도 출력하지 않는다", () => {
  const { ctx } = setup(MAP);
  const input = "capability[]=authtype\nprotocol=https\nhost=github.com\n";
  assert.deepEqual(ga.credential(ctx, "get", input), { out: "username=acct-b\npassword=tok-acct-b\n" });
  // path 속성(useHttpPath)이 있으면 그 저장소를 쓴다
  assert.equal(ga.credential(ctx, "get", input + "path=acct-a/special.git\n").out, "username=acct-b\npassword=tok-acct-b\n");
  assert.equal(ga.credential(ctx, "get", input + "path=acct-a/other.git\n").out, "");
  assert.equal(ga.credential(ctx, "store", input).out, "");
  assert.equal(ga.credential(ctx, "get", "protocol=https\nhost=gitlab.com\n").out, "");
  assert.equal(ga.credential(ctx, "get", "protocol=http\nhost=github.com\n").out, "");
  // 다른 사용자 이름을 요구하면 비켜 준다
  assert.equal(ga.credential(ctx, "get", input + "username=acct-a\n").out, "");
  assert.equal(ga.credential({ ...ctx, env: { ...ctx.env, GH_ACCOUNT_OFF: "1" } }, "get", input).out, "");
});

test("credential: 매핑 파일이 깨졌거나 원격이 없으면 비켜 주고, 로그인 안 된 계정은 quit 로 막는다", () => {
  assert.equal(ga.credential(setup("{broken").ctx, "get", "protocol=https\nhost=github.com\n").out, "");
  const none = setup(MAP);
  assert.equal(ga.credential({ ...none.ctx, cwd: "/w/no-remote" }, "get", "protocol=https\nhost=github.com\n").out, "");
  const { ctx } = setup({ rules: [{ match: "example-org/*", account: "acct-c" }] });
  const r = ga.credential(ctx, "get", "protocol=https\nhost=github.com\n");
  assert.equal(r.out, "quit=1\n");
  assert.match(r.message, /acct-c 계정으로 매핑돼 있지만/);
  assert.doesNotMatch(r.message, /tok-/);
});

test("ghToken: 매핑이 있으면 토큰, 없거나 깨지면 빈 값, 로그인 안 됐으면 3", () => {
  const { ctx, calls } = setup(MAP, { env: { GH_TOKEN: "outer" } });
  assert.deepEqual(ga.ghToken(ctx, ["pr", "list"]), { code: 0, token: "tok-acct-b" });
  // 토큰을 받을 때 바깥 토큰을 넘기지 않는다
  const tokenCall = calls.find((c) => c.cmd === "fake-gh");
  assert.equal(tokenCall.env.GH_TOKEN, undefined);
  assert.equal(tokenCall.env.GH_ACCOUNT_OFF, "1");
  assert.deepEqual(ga.ghToken(ctx, ["pr", "list", "-R", "someone/else"]), { code: 0 });
  assert.deepEqual(ga.ghToken({ ...ctx, env: { ...ctx.env, GH_HOST: "ghe.example.com" } }, ["pr", "list"]), { code: 0 });
  assert.deepEqual(ga.ghToken(setup("[]").ctx, ["pr", "list"]), { code: 0 });
  const r = ga.ghToken(setup({ rules: [{ match: "example-org/*", account: "acct-c" }] }).ctx, ["pr", "list"]);
  assert.equal(r.code, 3);
  assert.match(r.message, /gh-account unset example-org\/\*/);
});

test("main gh-token: 터미널이면 토큰을 출력하지 않는다", () => {
  const { ctx } = setup(MAP);
  const t = io();
  t.io.isTTY = true;
  assert.equal(ga.main(["gh-token", "--", "pr", "list"], ctx, t.io), 2);
  assert.equal(t.o.raw, "");
  const p = io();
  assert.equal(ga.main(["gh-token", "--", "pr", "list"], ctx, p.io), 0);
  assert.equal(p.o.raw, "tok-acct-b");
});

test("buildBlock: default 를 먼저, 규칙은 거꾸로 써서 첫 규칙이 마지막(이기는 자리)에 온다", () => {
  const block = ga.buildBlock({
    helper: "/b/git-credential-gh-account", prior: ["osxkeychain"],
    includes: [{ match: null, file: "/i/d.gitconfig" }, { match: "o/r", file: "/i/b.gitconfig" }, { match: "o/*", file: "/i/a.gitconfig" }],
  });
  const lines = block.split("\n");
  assert.equal(lines[0], ga.BEGIN);
  assert.equal(lines.at(-1), ga.END);
  assert.deepEqual(lines.filter((l) => l.startsWith("\thelper")), ["\thelper =", '\thelper = "/b/git-credential-gh-account"', '\thelper = "osxkeychain"']);
  const inc = lines.filter((l) => l.startsWith("[includeIf"));
  assert.equal(inc[0], '[includeIf "hasconfig:remote.*.url:https://github.com/**"]');
  assert.ok(inc.includes('[includeIf "hasconfig:remote.*.url:git@github.com:o/r.git"]'));
  assert.equal(inc.at(-1), '[includeIf "hasconfig:remote.*.url:ssh://git@github.com/o/**"]');
  assert.equal(ga.buildBlock({ helper: null, prior: [], includes: [] }), null);
  assert.match(ga.buildBlock({ helper: "/a b/git-credential-gh-account", prior: [], includes: [] }), /helper = "!'\/a b\/git-credential-gh-account'"/);
});

test("writeBlock: 블록을 넣고 바꾸고 지워도 사용자 설정은 그대로 둔다", () => {
  const f = path.join(tmpdir(), "gitconfig");
  fs.writeFileSync(f, "[user]\n\tname = Someone\n");
  ga.writeBlock(f, `${ga.BEGIN}\nx\n${ga.END}`);
  ga.writeBlock(f, `${ga.BEGIN}\ny\n${ga.END}`);
  const t = fs.readFileSync(f, "utf8");
  assert.equal(t.split(ga.BEGIN).length, 2);
  assert.match(t, /^\[user\]\n\tname = Someone\n\n# >>>/);
  assert.match(t, /\ny\n/);
  ga.writeBlock(f, null);
  assert.equal(fs.readFileSync(f, "utf8"), "[user]\n\tname = Someone\n");
});

test("sync: 신원 파일은 매핑 값 또는 noreply 주소, 끈 계정과 로그인 안 된 계정은 건너뛴다", () => {
  const { app, home, ctx } = setup({
    rules: [{ match: "example-org/*", account: "acct-b" }, { match: "acct-a/*", account: "acct-a" }, { match: "other/*", account: "acct-c" }, { match: "quiet/*", account: "acct-d" }],
    default: "acct-a",
    accounts: { "acct-a": { identity: { email: "user@example.com" } }, "acct-d": { identity: false } },
  });
  const logs = [];
  assert.equal(ga.sync(ctx, (s) => logs.push(s)), true);
  const dir = path.join(app, "gh-account", "identity");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["acct-a.gitconfig", "acct-b.gitconfig"]);
  assert.match(fs.readFileSync(path.join(dir, "acct-a.gitconfig"), "utf8"), /name = "Person A"\n\temail = "user@example.com"/);
  assert.match(fs.readFileSync(path.join(dir, "acct-b.gitconfig"), "utf8"), /name = "acct-b"\n\temail = "1098\+acct-b@users.noreply.github.com"/);
  assert.ok(logs.some((l) => l.includes("acct-c")));
  const g = fs.readFileSync(path.join(home, "gitconfig"), "utf8");
  assert.ok(!g.includes("credential"), "설치 전에는 자격 증명 도우미를 쓰지 않는다");
  // example-org 규칙이 첫 규칙이라 맨 뒤에 온다
  const last = g.split("\n").filter((l) => l.startsWith("[includeIf")).at(-1);
  assert.match(last, /example-org/);
  assert.doesNotMatch(g, /tok-/);
});

test("sync: git 2.36 보다 낮으면 신원을 건너뛰고 알린다", () => {
  const { home, ctx } = setup(MAP, { gitVersion: "git version 2.30.1" });
  const logs = [];
  ga.sync(ctx, (s) => logs.push(s));
  assert.ok(logs.some((l) => l.includes("2.36")));
  assert.equal(fs.existsSync(path.join(home, "gitconfig")), false);
});

test("main set/unset/default: 매핑 파일을 고치고, 깨진 파일은 덮어쓰지 않는다", () => {
  const { app, ctx } = setup(undefined);
  const file = path.join(app, "gh-accounts.json");
  let t = io();
  assert.equal(ga.main(["set", "example-org/*", "acct-b"], ctx, t.io), 0);
  assert.equal(ga.main(["set", "example-org/*", "acct-a"], ctx, t.io), 0);
  assert.equal(ga.main(["default", "acct-c"], ctx, t.io), 0);
  assert.ok(t.o.lines.some((l) => l.includes("acct-c 계정이 gh 에 로그인돼 있지 않습니다")));
  let m = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(m.rules, [{ match: "example-org/*", account: "acct-a" }]);
  assert.equal(m.default, "acct-c");
  assert.equal(ga.main(["set", "bad", "acct-a"], ctx, io().io), 2);
  assert.equal(ga.main(["unset", "example-org/*"], ctx, t.io), 0);
  assert.equal(ga.main(["default", "none"], ctx, t.io), 0);
  m = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([m.rules, m.default], [[], null]);
  fs.writeFileSync(file, "{broken");
  t = io();
  assert.equal(ga.main(["set", "o/*", "acct-a"], ctx, t.io), 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

// 스페이스 폴더: 저장소가 아닌 폴더 안에 저장소 둘(같은 owner)과 .git 없는 폴더, 따로 있는 다른 owner 저장소.
function spaceDirs() {
  const root = tmpdir("gh-space");
  const ws = path.join(root, "ws");
  for (const d of ["app", "api", "notes"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  for (const d of ["app", "api"]) fs.mkdirSync(path.join(ws, d, ".git"));
  const solo = path.join(root, "solo");
  fs.mkdirSync(solo);
  const remotes = {
    [path.join(ws, "app")]: "https://github.com/example-org/app.git",
    [path.join(ws, "api")]: "git@github.com:Example-Org/api.git",
    [path.join(ws, "notes")]: "https://github.com/other-org/notes.git",
    [solo]: "https://github.com/acct-a/tool.git",
  };
  return { ws, solo, remotes, missing: path.join(root, "gone") };
}

test("space: 폴더와 그 아래 저장소를 owner 별로 묶고 지금 쓰는 계정을 붙인다", () => {
  const s = spaceDirs();
  const { ctx } = setup({ rules: [{ match: "example-org/api", account: "acct-a" }, { match: "example-org/*", account: "acct-b" }], default: null }, { remotes: s.remotes });
  const t = io();
  assert.equal(ga.main(["space", "--json", s.ws, s.solo, s.missing, s.ws], ctx, t.io), 0);
  const out = JSON.parse(t.o.lines[0]);
  assert.equal(out.error, null);
  assert.deepEqual(out.owners, [
    { owner: "acct-a", rule: null, repos: [{ repo: "acct-a/tool", account: null, by: null, match: null }] },
    { owner: "Example-Org", rule: "acct-b", repos: [
      { repo: "Example-Org/api", account: "acct-a", by: "rule", match: "example-org/api" },
      { repo: "example-org/app", account: "acct-b", by: "rule", match: "example-org/*" },
    ] },
  ]);
  // .git 이 없는 하위 폴더(notes)는 원격이 있어도 보지 않는다.
  assert.ok(!t.o.lines[0].includes("other-org"));
  const txt = io();
  ga.main(["space", s.ws], ctx, txt.io);
  assert.ok(txt.o.lines.some((l) => l.includes("Example-Org/api -> acct-a (규칙 example-org/api)")));
});

test("assign: 찾은 owner 마다 owner/* 규칙을 정하거나 지우고, 저장소 하나 규칙은 그대로 둔다", () => {
  const s = spaceDirs();
  const { app, ctx } = setup({ rules: [{ match: "example-org/api", account: "acct-a" }, { match: "example-org/*", account: "acct-a" }], default: null }, { remotes: s.remotes });
  const file = path.join(app, "gh-accounts.json");
  let t = io();
  assert.equal(ga.main(["assign", "acct-b", s.ws, s.solo], ctx, t.io), 0);
  let m = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(m.rules, [
    { match: "example-org/api", account: "acct-a" },
    { match: "Example-Org/*", account: "acct-b" },
    { match: "acct-a/*", account: "acct-b" },
  ]);
  t = io();
  assert.equal(ga.main(["assign", "none", s.ws], ctx, t.io), 0);
  m = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(m.rules, [{ match: "example-org/api", account: "acct-a" }, { match: "acct-a/*", account: "acct-b" }]);
  // 원격을 못 찾거나 인자가 틀리면 아무것도 바꾸지 않는다.
  assert.equal(ga.main(["assign", "acct-b", s.missing], ctx, io().io), 1);
  assert.equal(ga.main(["assign", "bad name", s.ws], ctx, io().io), 2);
  assert.equal(ga.main(["assign", "acct-b"], ctx, io().io), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).rules, m.rules);
  // 깨진 매핑 파일은 덮어쓰지 않고, space --json 은 error 를 담아 0 으로 끝난다.
  fs.writeFileSync(file, "{broken");
  assert.equal(ga.main(["assign", "acct-b", s.ws], ctx, io().io), 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  t = io();
  assert.equal(ga.main(["space", "--json", s.ws], ctx, t.io), 0);
  assert.ok(JSON.parse(t.o.lines[0]).error);
});

test("main resolve: 폴더와 -R 로 계정을 보여 준다", () => {
  const { ctx } = setup(MAP);
  let t = io();
  ga.main(["resolve", "--json"], ctx, t.io);
  assert.deepEqual(JSON.parse(t.o.lines[0]), { repo: "example-org/app", account: "acct-b", by: "rule", match: "example-org/*" });
  t = io();
  ga.main(["resolve", "-R", "someone/x"], ctx, t.io);
  assert.match(t.o.lines[0], /매핑 없음/);
  t = io();
  assert.equal(ga.main(["resolve", "-R", "https://gitlab.com/o/r"], ctx, t.io), 2);
});

test("install: 다른 gh 가 이미 있으면 덮어쓰지 않는다, Windows 는 지원하지 않는다", () => {
  const { home, ctx } = setup(MAP);
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho real\n");
  const logs = [];
  assert.equal(ga.install(ctx, { bin }, (s) => logs.push(s)), 1);
  assert.equal(fs.readFileSync(path.join(bin, "gh"), "utf8"), "#!/bin/sh\necho real\n");
  assert.equal(ga.install({ ...ctx, platform: "win32" }, { bin }, () => {}), 1);
});

test("priorHelpers: 일반 도우미와 github.com 도우미만 순서대로, 빈 값은 목록을 비운다", { skip: !POSIX && "POSIX 전용" }, () => {
  const d = tmpdir();
  const g = path.join(d, "gitconfig");
  fs.writeFileSync(g, [
    "[credential]", "\thelper = first", "\thelper =", "\thelper = cache",
    '[credential "https://gitlab.com"]', "\thelper = gitlab-only",
    '[credential "https://github.com"]', "\thelper = !gh auth git-credential",
    `${ga.BEGIN}`, '[credential "https://github.com"]', "\thelper = /old/git-credential-gh-account", ga.END, "",
  ].join("\n"));
  const ctx = ga.makeCtx({ env: { ...process.env, HOME: d, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.deepEqual(ga.priorHelpers(ctx, g), ["cache", "!gh auth git-credential"]);
});

// 실제 git 과 가짜 gh 셸 스크립트로 설치부터 제거까지 확인한다. 공백이 든 경로도 함께 본다.
test("e2e: 래퍼가 GH_TOKEN 을 넣고 git 자격 증명·커밋 신원이 매핑을 따른다", { skip: !POSIX && "POSIX 전용" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh account e2e-"));
  const home = path.join(root, "home");
  const app = path.join(home, "app");
  const bin = path.join(root, "my bin");
  const fake = path.join(root, "fake");
  const tools = path.join(root, "tools");
  for (const d of [home, app, fake, tools]) fs.mkdirSync(d, { recursive: true });
  // 가짜 gh: acct-a, acct-b 로그인. 다른 명령은 받은 GH_TOKEN 과 인자를 출력한다.
  fs.writeFileSync(path.join(fake, "gh"), `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
  for a in "$@"; do last="$a"; done
  case "$last" in acct-a|acct-b) echo "tok-$last"; exit 0 ;; esac
  echo "no account" >&2; exit 1
fi
if [ "$1" = api ] && [ "$2" = user ]; then
  case "$GH_TOKEN" in tok-acct-b) echo '{"id":1002,"login":"acct-b","name":null}'; exit 0 ;; tok-acct-a) echo '{"id":1001,"login":"acct-a","name":"Person A"}'; exit 0 ;; esac
  exit 1
fi
echo "token=$GH_TOKEN args=$*"
`);
  fs.chmodSync(path.join(fake, "gh"), 0o755);
  const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.symlinkSync(gitPath, path.join(tools, "git"));
  fs.symlinkSync(process.execPath, path.join(tools, "node"));
  const gconf = path.join(home, ".gitconfig");
  // 설치 전부터 있던 도우미는 매핑 없는 저장소에서 그대로 쓰여야 한다
  fs.writeFileSync(gconf, "[credential]\n\thelper = \"!f() { echo username=prior; echo password=prior-pass; }; f\"\n");
  const env = {
    HOME: home, HERDR_APP_HOME: app, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    PATH: [bin, fake, tools, "/usr/bin", "/bin"].join(":"), LANG: "C",
  };
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd || root, input: opts.input });
  fs.writeFileSync(path.join(app, "gh-accounts.json"), JSON.stringify({ rules: [{ match: "example-org/*", account: "acct-b" }, { match: "other-org/*", account: "acct-c" }] }));

  const inst = sh(process.execPath, [CLI, "install", "--bin", bin]);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.doesNotMatch(inst.stdout, /주의: PATH/);

  const repo = (name, url) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    sh("git", ["init", "-q"], { cwd: d });
    sh("git", ["remote", "add", "origin", url], { cwd: d });
    return d;
  };
  const mapped = repo("mapped", "https://github.com/example-org/app.git");
  const plain = repo("plain", "https://github.com/acct-a/tool.git");
  const missing = repo("missing", "https://github.com/other-org/x.git");

  // gh 래퍼
  assert.equal(sh("gh", ["pr", "list"], { cwd: mapped }).stdout.trim(), "token=tok-acct-b args=pr list");
  assert.equal(sh("gh", ["pr", "list"], { cwd: plain }).stdout.trim(), "token= args=pr list");
  assert.equal(sh("gh", ["pr", "list", "-R", "example-org/app"], { cwd: plain }).stdout.trim(), "token=tok-acct-b args=pr list -R example-org/app");
  assert.equal(sh("gh", ["pr", "list"], { cwd: mapped, env: { GH_TOKEN: "outer" } }).stdout.trim(), "token=outer args=pr list");
  assert.equal(sh("gh", ["pr", "list"], { cwd: mapped, env: { GH_ACCOUNT_OFF: "1" } }).stdout.trim(), "token= args=pr list");
  assert.equal(sh("gh", ["auth", "status"], { cwd: mapped }).stdout.trim(), "token= args=auth status");
  const miss = sh("gh", ["pr", "list"], { cwd: missing });
  assert.equal(miss.status, 1);
  assert.equal(miss.stdout, "");
  assert.match(miss.stderr, /acct-c 계정으로 매핑돼 있지만/);

  // git 자격 증명
  const fill = (cwd) => sh("git", ["credential", "fill"], { cwd, input: "protocol=https\nhost=github.com\n\n" });
  assert.match(fill(mapped).stdout, /^username=acct-b\npassword=tok-acct-b$/m);
  assert.match(fill(plain).stdout, /username=prior\npassword=prior-pass/);
  const q = fill(missing);
  assert.notEqual(q.status, 0);
  assert.match(q.stderr, /acct-c/);

  // 커밋 신원(git 2.36 이상)
  const v = sh("git", ["version"]).stdout.match(/(\d+)\.(\d+)/);
  if (Number(v[1]) > 2 || (Number(v[1]) === 2 && Number(v[2]) >= 36)) {
    assert.equal(sh("git", ["config", "user.email"], { cwd: mapped }).stdout.trim(), "1002+acct-b@users.noreply.github.com");
    assert.equal(sh("git", ["config", "user.email"], { cwd: plain }).stdout.trim(), "");
    sh("git", ["config", "user.email", "user@example.com"], { cwd: mapped });
    assert.equal(sh("git", ["config", "user.email"], { cwd: mapped }).stdout.trim(), "user@example.com", "저장소 설정이 이긴다");
  }

  // 깨진 매핑: gh 는 그대로, git 은 원래 도우미
  fs.writeFileSync(path.join(app, "gh-accounts.json"), "{broken");
  assert.equal(sh("gh", ["pr", "list"], { cwd: mapped }).stdout.trim(), "token= args=pr list");
  assert.match(fill(mapped).stdout, /username=prior/);

  // 제거: 우리 파일과 블록만 지우고 매핑 파일과 원래 설정은 남긴다
  const un = sh(process.execPath, [CLI, "uninstall"]);
  assert.equal(un.status, 0, un.stderr);
  assert.equal(fs.existsSync(path.join(bin, "gh")), false);
  assert.equal(fs.readFileSync(gconf, "utf8"), "[credential]\n\thelper = \"!f() { echo username=prior; echo password=prior-pass; }; f\"\n");
  assert.equal(fs.readFileSync(path.join(app, "gh-accounts.json"), "utf8"), "{broken");
  assert.equal(fs.existsSync(path.join(app, "gh-account")), false);
});
