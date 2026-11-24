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
function fakeRun({ logged = ["acct-a", "acct-b"], remotes = {}, gitVersion = "git version 2.45.0", calls = [], noStatus = false } = {}) {
  return (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env, opts });
    if (cmd === "fake-gh" && args[0] === "auth" && args[1] === "status") {
      if (noStatus) return { status: 1, stdout: "", stderr: "unknown flag: --json" };
      return { status: 0, stdout: JSON.stringify({ hosts: { "github.com": logged.map((login, i) => ({ login, active: i === 0, state: "success" })) } }), stderr: "" };
    }
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

// 포함 규칙의 [aA] 글롭을 읽기 쉬운 글자로 되돌린다.
function plain(s) { return s.replace(/\[([a-z])([A-Z])\]/g, (m, a, b) => (a.toUpperCase() === b ? a : m)); }

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

test("credential: path 는 앞 두 칸(o/r.git/info/lfs 포함)으로 저장소를 정하고 origin 보다 먼저다", () => {
  const { ctx } = setup(MAP, { remotes: { "/w/repo": "https://github.com/acct-a/tool.git" } });
  const input = "protocol=https\nhost=github.com\n";
  assert.equal(ga.credential(ctx, "get", input).out, "");
  assert.equal(ga.credential(ctx, "get", input + "path=example-org/app.git/info/lfs\n").out, "username=acct-b\npassword=tok-acct-b\n");
  assert.equal(ga.credential(ctx, "get", input + "path=example-org/app\n").out, "username=acct-b\npassword=tok-acct-b\n");
  // origin 이 매핑됐어도 다른 주인으로 가는 요청엔 내주지 않는다
  const m = setup(MAP);
  assert.equal(ga.credential(m.ctx, "get", input + "path=other-owner/x.git\n").out, "");
});

test("credential: gh 를 실행하지 못하면 quit 대신 원래 도우미에 넘긴다", () => {
  const { ctx } = setup(MAP);
  // -1: 실행 파일 없음, 127: PATH 의 우리 래퍼가 진짜 gh 를 못 찾음
  for (const status of [-1, 127]) {
    const run = (cmd, args, opts) => cmd === "fake-gh" ? { status, stdout: "", stderr: "" } : ctx.run(cmd, args, opts);
    const r = ga.credential({ ...ctx, run }, "get", "protocol=https\nhost=github.com\n");
    assert.equal(r.out, "");
    assert.match(r.message, /gh 를 찾지 못해/);
  }
});

test("realGh: PATH 에 없으면 설치 때 기록한 경로를 쓴다", () => {
  const { app, ctx } = setup(MAP);
  const gh = path.join(app, "real-gh");
  fs.writeFileSync(gh, "#!/bin/sh\n");
  fs.mkdirSync(path.join(app, "gh-account"), { recursive: true });
  fs.writeFileSync(path.join(app, "gh-account", "state.json"), JSON.stringify({ binDir: "/b", prior: [], gh }));
  const c = { ...ctx, env: { ...ctx.env, GH_ACCOUNT_GH: "" } };
  assert.equal(ga.realGh(c), gh);
  fs.rmSync(gh);
  assert.equal(ga.realGh(c), "gh");
});

test("priorHelper: 이 도구가 내준 자격 증명의 store·erase 는 버리고 path 줄은 빼서 넘긴다", () => {
  const calls = [];
  const { ctx } = setup(MAP, { calls });
  const sent = () => calls.filter((c) => c.cmd === "/bin/sh");
  const base = "protocol=https\nhost=github.com\n";
  // 매핑된 저장소(origin)에서 매핑 계정 이름이면 버린다
  ga.priorHelper(ctx, "osxkeychain", "store", base + "username=acct-b\npassword=tok-acct-b\n");
  ga.priorHelper(ctx, "osxkeychain", "erase", base + "username=acct-b\npassword=tok-acct-b\n");
  assert.equal(sent().length, 0);
  // 매핑이 없는 저장소라도 비밀번호가 매핑 계정 토큰이면 버린다
  ga.priorHelper(ctx, "osxkeychain", "store", base + "path=someone/else.git\nusername=acct-b\npassword=tok-acct-b\n");
  assert.equal(sent().length, 0);
  // 다른 사용자, 다른 비밀번호는 넘긴다(path 는 빼고)
  ga.priorHelper(ctx, "osxkeychain", "store", base + "path=someone/else.git\nusername=acct-b\npassword=other\n");
  ga.priorHelper(ctx, "/abs/helper --x", "store", base + "username=me\npassword=p\n");
  ga.priorHelper(ctx, "!f() { cat; }; f", "get", base + "path=example-org/app.git\n");
  assert.deepEqual(sent().map((c) => c.args[1]), ["git credential-osxkeychain store", "/abs/helper --x store", "f() { cat; }; f get"]);
  assert.ok(sent().every((c) => !/path=/.test(c.opts.input)));
  // 모르는 동작은 부르지 않는다
  ga.priorHelper(ctx, "osxkeychain", "rm -rf", base);
  assert.equal(sent().length, 3);
  // GH_ACCOUNT_OFF 면 거르지 않고 그대로 넘긴다
  ga.priorHelper({ ...ctx, env: { ...ctx.env, GH_ACCOUNT_OFF: "1" } }, "osxkeychain", "store", base + "username=acct-b\npassword=tok-acct-b\n");
  assert.equal(sent().length, 4);
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
  // 원래 도우미는 우리 도우미로 감싸 store 를 거른다
  assert.deepEqual(lines.filter((l) => l.startsWith("\thelper")), ["\thelper =", '\thelper = "/b/git-credential-gh-account"', `\thelper = "/b/git-credential-gh-account prior 'osxkeychain'"`]);
  assert.ok(lines.includes("\tuseHttpPath = true"));
  const inc = lines.filter((l) => l.startsWith("[includeIf"));
  assert.equal(inc[0], '[includeIf "hasconfig:remote.*.url:https://github.com/**"]');
  // owner·저장소 이름은 대소문자를 가리지 않게 쓴다
  assert.ok(inc.includes('[includeIf "hasconfig:remote.*.url:git@github.com:[oO]/[rR].git"]'));
  assert.equal(inc.at(-1), '[includeIf "hasconfig:remote.*.url:ssh://git@github.com/[oO]/**"]');
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
  const g = plain(fs.readFileSync(path.join(home, "gitconfig"), "utf8"));
  assert.ok(!g.includes("credential"), "설치 전에는 자격 증명 도우미를 쓰지 않는다");
  // example-org 규칙이 첫 규칙이라 맨 뒤에 온다
  const last = g.split("\n").filter((l) => l.startsWith("[includeIf")).at(-1);
  assert.match(last, /example-org/);
  assert.doesNotMatch(g, /tok-/);
});

// 기본 계정은 로그인된 계정 자신의 저장소(owner 가 그 로그인 이름)에 쓰지 않는다. 명시한 규칙은 그대로 이긴다.
test("기본 계정: 로그인된 계정의 저장소는 그 계정, 규칙이 있으면 규칙, 로그인 안 된 owner 는 기본 계정", () => {
  const map = { rules: [{ match: "acct-b/special", account: "acct-a" }], default: "acct-a" };
  const { ctx, calls } = setup(map, { remotes: { "/w/repo": "https://github.com/acct-b/notes.git" } });
  const r = (o, n) => ga.resolve(ctx, { repo: { owner: o, repo: n } }).hit;
  assert.deepEqual(r("acct-b", "notes"), { account: "acct-b", by: "owner", match: null });
  assert.deepEqual(r("acct-b", "special"), { account: "acct-a", by: "rule", match: "acct-b/special" });
  assert.equal(r("example-org", "app").account, "acct-a");
  assert.equal(r("example-org", "app").by, "default");
  assert.equal(r("acct-a", "x").by, "default", "기본 계정 자신의 저장소는 그대로");
  assert.equal(r("acct-c", "x").by, "default", "로그인 안 된 owner 는 기본 계정");
  // gh 래퍼와 git 자격 증명도 같은 계정을 쓴다
  assert.equal(ga.ghToken(ctx, ["pr", "list"]).token, "tok-acct-b");
  assert.equal(ga.ghToken(ctx, ["pr", "list", "-R", "example-org/app"]).token, "tok-acct-a");
  const input = "protocol=https\nhost=github.com\n";
  assert.equal(ga.credential(ctx, "get", input).out, "username=acct-b\npassword=tok-acct-b\n");
  assert.equal(ga.credential(ctx, "get", input + "path=example-org/app.git\n").out, "username=acct-a\npassword=tok-acct-a\n");
  assert.equal(ga.credential(ctx, "get", input + "path=acct-b/special.git\n").out, "username=acct-a\npassword=tok-acct-a\n");
  // 그렇게 내준 자격 증명은 원래 도우미에 저장하지 않는다
  assert.equal(ga.ourCredential(ctx, { username: "acct-b", password: "tok-acct-b", path: "acct-b/notes.git" }), true);
  // 토큰은 프로세스 인자에 넣지 않는다
  for (const c of calls) assert.ok(!c.args.some((x) => /tok-/.test(x)));
  // resolve 출력
  const t = io();
  ga.main(["resolve", "-R", "acct-b/notes"], ctx, t.io);
  assert.match(t.o.lines.join("\n"), /acct-b\/notes: acct-b \(로그인된 계정의 저장소\)/);
});

test("sync: 기본 계정 신원은 로그인된 계정의 저장소에 붙지 않고, 로그인 목록을 못 읽으면 기본 계정 신원을 뺀다", () => {
  const map = { rules: [{ match: "example-org/*", account: "acct-b" }], default: "acct-a" };
  const { home, ctx } = setup(map);
  ga.sync(ctx);
  const inc = plain(fs.readFileSync(path.join(home, "gitconfig"), "utf8")).split("\n").filter((l) => l.startsWith("[includeIf"));
  // default(**) 다음에 acct-b/** (로그인된 acct-b 자신의 저장소), 마지막이 규칙
  const order = inc.map((l) => (/github\.com[:/]\*\*"/.test(l) ? "default" : l.includes("acct-b/**") ? "owner" : l.includes("example-org/**") ? "rule" : "?"));
  assert.ok(order.indexOf("default") < order.indexOf("owner") && order.lastIndexOf("owner") < order.indexOf("rule"), order.join(","));
  assert.ok(!order.includes("?"), "기본 계정 자신(acct-a/*)은 따로 넣지 않는다");

  const s2 = setup(map, { noStatus: true });
  const logs = [];
  ga.sync(s2.ctx, (l) => logs.push(l));
  const g2 = plain(fs.readFileSync(path.join(s2.home, "gitconfig"), "utf8"));
  assert.doesNotMatch(g2, /github\.com[:/]\*\*"/, "기본 계정 catch-all 신원 없음");
  assert.match(g2, /example-org\/\*\*/);
  assert.ok(logs.some((l) => l.includes("기본 계정 신원은 건너뜁니다")));

  // 로그인된 계정 신원을 만들지 못하면(신원 끔) 기본 계정 신원도 뺀다
  const s3 = setup({ ...map, accounts: { "acct-b": { identity: false } }, rules: [] });
  const logs3 = [];
  ga.sync(s3.ctx, (l) => logs3.push(l));
  assert.equal(fs.existsSync(path.join(s3.home, "gitconfig")), false);
  assert.ok(logs3.some((l) => l.includes("기본 계정 신원은 건너뜁니다")));
});

// URL 의 owner 대소문자가 gh 로그인 이름과 달라도 같은 계정이다. gh auth token --user 에는 gh 의 이름을 넘긴다.
test("로그인 이름 대소문자: sync 가 적어 둔 로그인 목록으로 gh 의 이름을 찾아 토큰·신원에 쓴다", () => {
  const map = { rules: [{ match: "example-org/*", account: "me-personal" }], default: "acct-b", accounts: { "me-personal": { identity: { email: "user@example.com" } } } };
  const { app, home, ctx, calls } = setup(map, { logged: ["acct-b", "Me-Personal"] });
  const r = (o, n) => ga.resolve(ctx, { repo: { owner: o, repo: n } }).hit;
  // sync 전에는 로그인 목록이 없어 받은 이름 그대로 묻는다(gh 가 모른다고 하면 기본 계정)
  assert.equal(r("me-personal", "blog").by, "default");
  ga.sync(ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, "gh-account", "logins.json"), "utf8")), { logins: ["acct-b", "Me-Personal"] });
  assert.deepEqual(r("me-personal", "blog"), { account: "Me-Personal", by: "owner", match: null });
  assert.deepEqual(r("ME-PERSONAL", "blog"), { account: "Me-Personal", by: "owner", match: null });
  assert.equal(ga.ghToken(ctx, ["pr", "list", "-R", "me-personal/blog"]).token, "tok-Me-Personal");
  // 규칙에 적은 이름의 대소문자가 달라도 토큰을 받는다
  assert.equal(ga.ghToken(ctx, ["pr", "list", "-R", "example-org/app"]).token, "tok-Me-Personal");
  const tokenUsers = calls.filter((c) => c.args[0] === "auth" && c.args[1] === "token").map((c) => c.args.at(-1));
  assert.ok(tokenUsers.includes("Me-Personal"));
  // 신원 파일은 gh 의 이름 하나로 만들고, 매핑에 적은 값(대소문자 달라도)을 쓴다
  assert.deepEqual(fs.readdirSync(path.join(app, "gh-account", "identity")).sort(), ["Me-Personal.gitconfig", "acct-b.gitconfig"]);
  assert.match(fs.readFileSync(path.join(app, "gh-account", "identity", "Me-Personal.gitconfig"), "utf8"), /email = "user@example.com"/);
  // 포함 규칙은 URL 대소문자와 상관없이 맞는다
  const g = fs.readFileSync(path.join(home, "gitconfig"), "utf8");
  assert.ok(g.includes('hasconfig:remote.*.url:https://github.com/[mM][eE]-[pP][eE][rR][sS][oO][nN][aA][lL]/**'));
  // 제거하면 로그인 목록도 지운다
  ga.uninstall(ctx, { bin: path.join(home, "bin") }, () => {});
  assert.equal(fs.existsSync(path.join(app, "gh-account", "logins.json")), false);
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

// 실제 git 과 가짜 gh 셸 스크립트로 설치까지 해 둔다. 공백이 든 경로도 함께 본다.
// prior(root) 는 설치 전 전역 git 설정 내용(원래 자격 증명 도우미)이다.
function e2eSetup(prior) {
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
  fs.writeFileSync(gconf, prior(root));
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
  const fill = (cwd, input = "protocol=https\nhost=github.com\n\n", extra = {}) => sh("git", ["credential", "fill"], { cwd, input, ...extra });
  return { root, home, app, bin, fake, tools, gconf, sh, repo, fill };
}

// 설치부터 제거까지 확인한다.
test("e2e: 래퍼가 GH_TOKEN 을 넣고 git 자격 증명·커밋 신원이 매핑을 따른다", { skip: !POSIX && "POSIX 전용" }, () => {
  const { app, bin, gconf, sh, repo, fill } = e2eSetup(() => "[credential]\n\thelper = \"!f() { echo username=prior; echo password=prior-pass; }; f\"\n");
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

  // 저장소와 상관없는 명령은 매핑 계정이 로그인 안 돼 있어도 그대로 넘긴다
  assert.equal(sh("gh", ["--version"], { cwd: missing }).stdout.trim(), "token= args=--version");

  // git 자격 증명
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

// gh 래퍼로 로그인·로그아웃하면 sync 를 다시 돌려, 새로 로그인한 계정의 저장소에 기본 계정 신원이 붙지 않게 한다.
test("e2e: gh auth login·logout 이 성공하면 래퍼가 커밋 신원을 다시 맞춘다", { skip: !POSIX && "POSIX 전용" }, () => {
  const { app, bin, fake, sh, repo } = e2eSetup(() => "");
  const logins = path.join(fake, "logins");
  fs.writeFileSync(logins, "acct-a\n");
  // 로그인 목록을 파일로 기억하는 가짜 gh. auth login 은 acct-b 를 더하고, auth logout 은 acct-b 를 뺀다.
  fs.writeFileSync(path.join(fake, "gh"), `#!/bin/sh
L=${"'" + logins.replace(/'/g, "'\\''") + "'"}
case "$1 $2" in
"auth status") printf '{"hosts":{"github.com":['; sep=; while read -r a; do printf '%s{"login":"%s","active":false,"state":"success"}' "$sep" "$a"; sep=,; done < "$L"; echo ']}}'; exit 0 ;;
"auth token") for a in "$@"; do last="$a"; done; grep -qx "$last" "$L" && { echo "tok-$last"; exit 0; }; echo "no account" >&2; exit 1 ;;
"auth login") [ -n "$FAKE_FAIL" ] && exit 4; echo acct-b >> "$L"; echo "logged in"; exit 0 ;;
"auth logout") grep -vx acct-b "$L" > "$L.new"; mv "$L.new" "$L"; exit 0 ;;
"api user") case "$GH_TOKEN" in tok-acct-a) echo '{"id":1001,"login":"acct-a","name":"Person A"}' ;; tok-acct-b) echo '{"id":1002,"login":"acct-b","name":null}' ;; *) exit 1 ;; esac; exit 0 ;;
esac
echo "args=$*"
`);
  fs.writeFileSync(path.join(app, "gh-accounts.json"), JSON.stringify({ rules: [], default: "acct-a" }));
  assert.equal(sh(process.execPath, [CLI, "sync"]).status, 0);
  const own = repo("own", "https://github.com/acct-b/blog.git");
  const email = () => sh("git", ["config", "user.email"], { cwd: own }).stdout.trim();
  const v = sh("git", ["version"]).stdout.match(/(\d+)\.(\d+)/);
  const identity = Number(v[1]) > 2 || (Number(v[1]) === 2 && Number(v[2]) >= 36);
  if (identity) assert.equal(email(), "1001+acct-a@users.noreply.github.com", "로그인 전에는 기본 계정 신원");

  // 실패한 로그인은 종료 코드를 그대로 돌려주고 sync 하지 않는다
  const bad = sh(path.join(bin, "gh"), ["auth", "login"], { env: { FAKE_FAIL: "1" } });
  assert.equal(bad.status, 4);
  assert.equal(fs.existsSync(path.join(app, "gh-account", "identity", "acct-b.gitconfig")), false);

  const ok = sh(path.join(bin, "gh"), ["auth", "login"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "logged in");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, "gh-account", "logins.json"), "utf8")).logins, ["acct-a", "acct-b"]);
  if (identity) assert.equal(email(), "1002+acct-b@users.noreply.github.com", "로그인 뒤에는 그 계정 신원");

  // GH_ACCOUNT_OFF 면 그대로 넘기기만 한다
  assert.equal(sh(path.join(bin, "gh"), ["auth", "logout"], { env: { GH_ACCOUNT_OFF: "1" } }).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, "gh-account", "logins.json"), "utf8")).logins, ["acct-a", "acct-b"]);
  fs.writeFileSync(logins, "acct-a\nacct-b\n");
  assert.equal(sh(path.join(bin, "gh"), ["auth", "logout"]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, "gh-account", "logins.json"), "utf8")).logins, ["acct-a"]);
  if (identity) assert.equal(email(), "1001+acct-a@users.noreply.github.com", "로그아웃 뒤에는 다시 기본 계정 신원");
});

// 설치한 gh-account 명령 스크립트를 진짜 sh 로 실행한다(예전에는 exec VAR=... 를 명령으로 읽어 실행하지 못했다).
test("e2e: 설치한 gh-account 명령이 HERDR_APP_HOME 을 넘겨 node 로 도구를 실행한다", { skip: !POSIX && "POSIX 전용" }, () => {
  const { root, app, bin, sh } = e2eSetup(() => "");
  const r = sh("sh", [path.join(bin, "gh-account"), "list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /매핑\(/);
  // 가짜 node 로 넘긴 환경과 인자를 확인한다
  const fakeNode = path.join(root, "fake node");
  fs.mkdirSync(fakeNode);
  fs.writeFileSync(path.join(fakeNode, "node"), '#!/bin/sh\necho "home=$HERDR_APP_HOME"\nfor a in "$@"; do echo "arg=$a"; done\n');
  fs.chmodSync(path.join(fakeNode, "node"), 0o755);
  const env = { PATH: [fakeNode, bin, "/usr/bin", "/bin"].join(":"), HERDR_APP_HOME: "/elsewhere" };
  const f = sh(path.join(bin, "gh-account"), ["set", "a b/*", "acct-a"], { env });
  assert.equal(f.status, 0, f.stderr);
  const lines = f.stdout.trim().split("\n");
  assert.equal(lines[0], `home=${app}`);
  assert.match(lines[1], /^arg=.*gh-account\.cjs$/);
  assert.deepEqual(lines.slice(2), ["arg=set", "arg=a b/*", "arg=acct-a"]);
});

// 리뷰 R1: 원래 도우미에 매핑 토큰을 저장하지 않고, 요청 URL 의 저장소로 계정을 고르고, gh 가 PATH 에 없어도 push 를 막지 않는다.
test("e2e: 원래 도우미 저장 거르기, URL 경로 우선, gh 가 없을 때 그대로 넘기기", { skip: !POSIX && "POSIX 전용" }, () => {
  const { root, fake, bin, tools, sh, repo, fill } = e2eSetup((r) => `[credential]\n\thelper = "store --file '${r}/creds'"\n`);
  const creds = path.join(root, "creds");
  fs.writeFileSync(creds, "https://prior:prior-pass@github.com\n");
  const mapped = repo("mapped", "https://github.com/example-org/app.git");
  const plain = repo("plain", "https://github.com/acct-a/tool.git");
  const approve = (cwd, input) => sh("git", ["credential", "approve"], { cwd, input });

  // P1: 매핑 토큰은 성공 뒤에도 원래 도우미(store)에 저장되지 않는다
  const got = fill(mapped);
  assert.match(got.stdout, /^username=acct-b\npassword=tok-acct-b$/m);
  assert.equal(approve(mapped, got.stdout + "\n").status, 0);
  assert.equal(fs.readFileSync(creds, "utf8"), "https://prior:prior-pass@github.com\n");
  // 다른 계정 이름으로 와도 매핑 계정 토큰이면 거른다
  approve(plain, "protocol=https\nhost=github.com\nusername=acct-b\npassword=tok-acct-b\n\n");
  assert.doesNotMatch(fs.readFileSync(creds, "utf8"), /tok-acct/);
  // 매핑 없는 저장소는 원래 도우미가 읽고 저장한다. path 는 넘기지 않는다
  assert.match(fill(plain).stdout, /username=prior\npassword=prior-pass/);
  assert.equal(approve(plain, "protocol=https\nhost=github.com\npath=acct-a/tool.git\nusername=user2\npassword=pass2\n\n").status, 0);
  const saved = fs.readFileSync(creds, "utf8");
  assert.match(saved, /^https:\/\/user2:pass2@github\.com$/m);
  assert.doesNotMatch(saved, /tool\.git/);

  // P3: 요청 URL 의 저장소가 지금 폴더의 origin 보다 먼저다
  assert.match(fill(plain, "url=https://github.com/example-org/x.git\n\n").stdout, /^username=acct-b$/m);
  assert.doesNotMatch(fill(mapped, "url=https://github.com/acct-a/tool.git\n\n").stdout, /acct-b/);

  // P2: PATH 에 gh 가 없어도 설치 때 기록한 gh 를 쓴다.
  // /usr/bin 이나 /bin 에 진짜 gh 가 있는 기계(예: Linux 의 apt 설치)는 PATH 의 gh 가 먼저라 이 상황을 만들 수 없어 건너뛴다.
  if (["/usr/bin/gh", "/bin/gh"].some((f) => fs.existsSync(f))) return;
  const noGh = { env: { PATH: [bin, tools, "/usr/bin", "/bin"].join(":") } };
  assert.match(fill(mapped, undefined, noGh).stdout, /^username=acct-b$/m);
  // 그 gh 마저 없으면 실패하지 않고 원래 도우미로 넘긴다
  const away = fake + "-away";
  fs.renameSync(fake, away);
  try {
    const r = fill(mapped, undefined, noGh);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /username=user2|username=prior/);
    assert.match(r.stderr, /gh 를 찾지 못해/);
  } finally {
    fs.renameSync(away, fake);
  }
});
