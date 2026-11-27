// node --test herdr/test/claude-account.test.cjs
// claude-account CLI: 저장소, 시드(링크), argv 만들기, 세션 계정 이름 찾기, 로그인 상태 기계. 실제 로그인은 하지 않고
// 임시 폴더와 가짜 run/hc 만 쓴다. 진짜 claude·hc·Keychain 은 건드리지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ca = require("../claude-account/claude-account.cjs");
const sch = require("../mods/schedules/schedules.cjs");

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ca-test-"))); }
function mk(over = {}) {
  const home = tmp();
  const ctx = ca.makeCtx({ home, env: { HOME: home, PATH: "/bin:/usr/bin" }, now: 1_000_000, platform: "darwin", run: () => ({ status: 1, stdout: "", stderr: "" }), ...over });
  return { home, ctx };
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// ---- store ----
test("normDir: 절대 경로, 끝 슬래시 없음, 루트는 그대로", () => {
  // 윈도우는 드라이브 글자가 붙고 구분자가 \\ 라서, 같은 입력을 path.resolve 로 푼 값과 비교한다.
  const R = (p) => path.resolve(p);
  assert.equal(ca.normDir("/a/b/"), R("/a/b"));
  assert.equal(ca.normDir("/a//b/../c///"), R("/a/c"));
  assert.equal(ca.normDir("/"), R("/"));
  assert.ok(!/[\\/]$/.test(ca.normDir("/a/b/")), "끝 구분자 없음");
});

test("add: ~/.claude-accounts/<id> 폴더(0700)와 저장 파일을 만들고, 토큰·이메일 같은 값은 저장하지 않는다", () => {
  const { home, ctx } = mk();
  const r = ca.add(ctx, "  회사  계정 ");
  assert.equal(r.ok, true);
  assert.equal(r.label, "회사 계정");
  const dir = path.join(home, ".claude-accounts", r.id);
  assert.ok(fs.statSync(dir).isDirectory());
  if (process.platform !== "win32") assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const file = path.join(home, ".herdr-inbox", "claude-accounts.json");
  const j = read(file);
  assert.deepEqual(j, { accounts: [{ id: r.id, label: "회사 계정", dir }], selected: null });
  assert.deepEqual(Object.keys(j.accounts[0]).sort(), ["dir", "id", "label"]);
  assert.ok(!fs.readdirSync(path.dirname(file)).some((n) => n.endsWith(".tmp")), "임시 파일이 남지 않는다");
});

test("add: 빈 이름·긴 이름·제어 문자·기본/중복 이름은 거절", () => {
  const { ctx } = mk();
  assert.equal(ca.add(ctx, "   ").ok, false);
  assert.equal(ca.add(ctx, "x".repeat(41)).ok, false);
  assert.equal(ca.add(ctx, "a\u0007b").ok, false);
  assert.equal(ca.add(ctx, "기본").ok, false);
  assert.equal(ca.add(ctx, "기본 계정").ok, false);
  assert.equal(ca.add(ctx, "Work").ok, true);
  assert.equal(ca.add(ctx, "work").ok, false);
});

test("readStore: 손으로 고친 파일이 다른 폴더를 가리키거나 깨져 있으면 그 항목을 버린다", () => {
  const { home, ctx } = mk();
  const root = path.join(home, ".claude-accounts");
  const file = path.join(home, ".herdr-inbox", "claude-accounts.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ accounts: [
    { id: "ok", label: "좋음", dir: path.join(root, "ok") },
    { id: "evil", label: "나쁨", dir: "/etc" },
    { id: "../x", label: "경로", dir: path.join(root, "..", "x") },
    { id: "ok", label: "중복", dir: path.join(root, "ok") },
    { id: "slash", label: "끝슬래시", dir: path.join(root, "slash") + "/" },
  ], selected: "evil" }));
  const s = ca.readStore(ctx);
  assert.deepEqual(s.accounts.map((a) => a.id), ["ok"]);
  assert.equal(s.selected, null);
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(ca.readStore(ctx), { accounts: [], selected: null });
});

test("select/remove: 선택은 null(기본 계정)로 돌아갈 수 있고, 빼도 폴더는 디스크에 남는다", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "A");
  assert.equal(ca.select(ctx, a.id).ok, true);
  assert.equal(ca.selectedDir(ctx), ca.dirFor(ctx, a.id));
  assert.equal(ca.select(ctx, "nope").ok, false);
  const r = ca.remove(ctx, a.id);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(ca.dirFor(ctx, a.id)), "폴더는 지우지 않는다");
  assert.equal(ca.selectedDir(ctx), null);
  assert.deepEqual(ca.readStore(ctx).accounts, []);
  assert.equal(ca.select(ctx, null).ok, true);
});

test("remove: 그 계정의 로그인이 진행 중이면 거절", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  fs.writeFileSync(path.join(home, ".herdr-inbox", "claude-login.json"), JSON.stringify({ id: a.id, state: "waiting", terminal: "t1", startedAt: ctx.now }));
  ctx.hc = (args) => (args[0] === "get" ? { status: 0, stdout: JSON.stringify({ state: "live" }), stderr: "" } : { status: 0, stdout: JSON.stringify({ text: "" }), stderr: "" });
  assert.equal(ca.remove(ctx, a.id).ok, false);
});

// ---- seeding ----
function fakeDefault(home) {
  const d = path.join(home, ".claude");
  fs.mkdirSync(path.join(d, "skills"), { recursive: true });
  fs.mkdirSync(path.join(d, "projects"), { recursive: true });
  for (const f of ["CLAUDE.md", "settings.json", "keybindings.json", ".credentials.json", "usage-limits.json"]) fs.writeFileSync(path.join(d, f), "x");
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  return d;
}

test("seed: 공유 항목은 링크하고 .claude.json·projects·로그인 파일·usage-limits 는 공유하지 않는다", () => {
  const { home, ctx } = mk();
  const src = fakeDefault(home);
  const dir = path.join(home, ".claude-accounts", "w");
  const r = ca.seed(ctx, dir);
  assert.deepEqual(r.linked.sort(), ["CLAUDE.md", "keybindings.json", "settings.json", "skills"]);
  assert.ok(r.skipped.includes("hooks"), "기본 폴더에 없는 항목은 건너뛴다");
  for (const n of r.linked) assert.equal(fs.readlinkSync(path.join(dir, n)), path.join(src, n));
  for (const n of [".claude.json", "projects", ".credentials.json", "usage-limits.json", "sessions"]) assert.ok(!fs.existsSync(path.join(dir, n)), n);
  assert.ok(!ca.SHARED.some((n) => /credentials|\.claude\.json|projects|sessions|usage-limits/.test(n)));
  // 다시 돌려도 있는 것은 그대로 둔다
  const again = ca.seed(ctx, dir);
  assert.deepEqual(again.linked, []);
  assert.ok(again.skipped.includes("CLAUDE.md"));
});

test("seed: 있는 파일은 덮어쓰지 않는다", () => {
  const { home, ctx } = mk();
  fakeDefault(home);
  const dir = path.join(home, ".claude-accounts", "w");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "mine");
  const r = ca.seed(ctx, dir);
  assert.ok(r.skipped.includes("settings.json"));
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "mine");
});

test("seed: 심볼릭 링크가 막힌 윈도우처럼 symlink 가 실패하면 폴더는 junction, 파일은 복사", () => {
  const { home, ctx } = mk({ platform: "win32" });
  const src = fakeDefault(home);
  const calls = [], copies = [];
  ctx.symlink = (t, p, type) => { calls.push(type); if (type !== "junction") throw Object.assign(new Error("EPERM"), { code: "EPERM" }); fs.symlinkSync(t, p, "dir"); };
  ctx.copy = (a, b) => { copies.push([a, b]); fs.copyFileSync(a, b); };
  const dir = path.join(home, ".claude-accounts", "w");
  const r = ca.seed(ctx, dir);
  assert.deepEqual(r.junctions, ["skills"]);
  assert.deepEqual(r.copied.sort(), ["CLAUDE.md", "keybindings.json", "settings.json"]);
  assert.deepEqual(r.linked, []);
  assert.deepEqual(r.failed, []);
  assert.ok(copies.every(([a]) => a.startsWith(src)));
  assert.ok(calls.includes("dir") && calls.includes("file") && calls.includes("junction"), "윈도우는 종류를 붙여 먼저 시도한다");
});

test("seed: 링크도 복사도 안 되면 failed 에 적고 멈추지 않는다", () => {
  const { home, ctx } = mk({ platform: "win32" });
  fakeDefault(home);
  ctx.symlink = () => { throw new Error("EPERM"); };
  ctx.copy = () => { throw new Error("EACCES"); };
  const r = ca.seed(ctx, path.join(home, ".claude-accounts", "w"));
  assert.deepEqual(r.failed.sort(), ["CLAUDE.md", "keybindings.json", "settings.json", "skills"]);
});

// ---- argv ----
test("envArgs/loginArgv: 기본 계정은 변수를 넣지 않고(~/.claude 를 넣지 않는다), 계정은 정규화한 경로를 그대로 넣는다", () => {
  const { ctx } = mk();
  assert.deepEqual(ca.envArgs(null), []);
  assert.deepEqual(ca.envArgs("/a/b/"), [`CLAUDE_CONFIG_DIR=${path.resolve("/a/b")}`]);
  assert.deepEqual(ca.loginArgv(ctx, "/h/.claude-accounts/w"),
    ["env", "PATH=/bin:/usr/bin", `CLAUDE_CONFIG_DIR=${path.resolve("/h/.claude-accounts/w")}`, "claude", "auth", "login", "--claudeai"]);
  assert.ok(!ca.loginArgv(ctx, null).some((t) => t.startsWith("CLAUDE_CONFIG_DIR=")));
});

test("claudeEnv: 부르는 쪽의 CLAUDE_CONFIG_DIR 를 비우고 계정 폴더로 바꾼다", () => {
  const { ctx } = mk({ env: { HOME: "/h", CLAUDE_CONFIG_DIR: "/other", PATH: "/bin" } });
  assert.equal(ca.claudeEnv(ctx, null).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(ca.claudeEnv(ctx, "/x/y/").CLAUDE_CONFIG_DIR, path.resolve("/x/y"));
  assert.equal(ctx.env.CLAUDE_CONFIG_DIR, "/other", "원래 환경은 바꾸지 않는다");
});

test("schedules launchArgs: claude 프로그램에만 책상에서 고른 계정을 넣고, 기본 계정이면 넣지 않는다", () => {
  const a = { program: "claude", prompt: "x" };
  // 윈도우 실행기에서도 맥·리눅스 분기를 시험하도록 win 을 false 로 못박는다(윈도우 분기는 아래 시험이 따로 본다).
  const withDir = sch.launchArgs(a, "n", "/w", {}, "/h/.claude-accounts/w", false);
  assert.ok(withDir.includes("CLAUDE_CONFIG_DIR=/h/.claude-accounts/w"));
  assert.ok(withDir.indexOf("CLAUDE_CONFIG_DIR=/h/.claude-accounts/w") < withDir.indexOf("claude"));
  assert.ok(!sch.launchArgs(a, "n", "/w", {}, null, false).some((t) => String(t).startsWith("CLAUDE_CONFIG_DIR=")));
  assert.ok(!sch.launchArgs({ ...a, program: "codex" }, "n", "/w", {}, "/h/.claude-accounts/w", false).some((t) => String(t).startsWith("CLAUDE_CONFIG_DIR=")));
});

test("schedules launchArgs: Windows 에서는 적용하지 못하는 계정을 인자에 넣지 않는다(env 도, 변수도 없다)", () => {
  const args = sch.launchArgs({ program: "claude", prompt: "x" }, "n", "C:\\w", {}, "C:\\Users\\u\\.claude-accounts\\w", true);
  assert.ok(!args.some((t) => String(t).includes("CLAUDE_CONFIG_DIR")));
  assert.ok(!args.includes("env"));
});

test("schedules claudeAccountDir: 읽기 실패는 경고, Windows 에서 고른 계정은 적용하지 않고 경고, 기본 계정은 조용히 null", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "A");
  const home = { ...process.env };
  const saved = process.env.HOME, savedInbox = process.env.HERDR_INBOX_DIR;
  try {
    process.env.HOME = ctx.home; process.env.USERPROFILE = ctx.home; delete process.env.HERDR_INBOX_DIR;
    assert.deepEqual(sch.claudeAccountDir(false), { dir: null, warning: null }); // 아직 고른 계정 없음
    ca.select(ctx, a.id);
    assert.deepEqual(sch.claudeAccountDir(false), { dir: ca.dirFor(ctx, a.id), warning: null });
    assert.deepEqual(sch.claudeAccountDir(true), { dir: null, warning: "Windows에서는 아직 지원하지 않습니다(이슈 #121 후속)" });
  } finally { process.env.HOME = saved; if (savedInbox !== undefined) process.env.HERDR_INBOX_DIR = savedInbox; }
  assert.ok(home);
});

test("select: 캐시에 '로그인 안 됨'으로 남은 계정을 고르면 경고를 돌려주고, 로그인된 계정·기본 계정은 경고가 없다", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "A");
  const b = ca.add(ctx, "B");
  fs.writeFileSync(path.join(ctx.home, ".herdr-inbox", "claude-accounts-cache.json"), JSON.stringify({ [a.id]: { loggedIn: false, authMethod: null, at: ctx.now }, [b.id]: { loggedIn: true, authMethod: "claude.ai", at: ctx.now } }));
  const ra = ca.select(ctx, a.id);
  assert.equal(ra.ok, true);
  assert.match(ra.warning, /로그인되지 않은/);
  assert.equal(ca.select(ctx, b.id).warning, undefined);
  assert.equal(ca.select(ctx, null).warning, undefined);
});

test("Windows: Claude 계정 추가·새 세션 선택·로그인은 안내만 하고 아무것도 바꾸지 않는다(기본 계정으로 되돌리기는 된다)", () => {
  const { ctx: mac } = mk();
  const a = ca.add(mac, "A");
  const { ctx } = mk({ platform: "win32" });
  const note = "Windows에서는 아직 지원하지 않습니다(이슈 #121 후속)";
  assert.deepEqual(ca.add(ctx, "B"), { ok: false, message: note });
  assert.deepEqual(ca.select(ctx, "x"), { ok: false, message: note });
  assert.deepEqual(ca.loginStart(ctx, "x"), { ok: false, message: note });
  assert.equal(ca.select(ctx, null).ok, true);
  assert.ok(!fs.existsSync(path.join(ctx.home, ".claude-accounts")));
  assert.ok(a.ok);
});

// ---- label resolution ----
test("envTokenDir: argv 의 env 부분만 본다(프로그램 뒤 인자는 보지 않음)", () => {
  assert.equal(ca.envTokenDir(["env", "PATH=/x", "CLAUDE_CONFIG_DIR=/d", "claude"]), "/d");
  assert.equal(ca.envTokenDir(["env", "PATH=/x", "claude", "CLAUDE_CONFIG_DIR=/d"]), null);
  assert.equal(ca.envTokenDir(["claude", "--model", "x"]), null);
  assert.equal(ca.envTokenDir(undefined), undefined);
});

test("labelForDir: 기본은 '기본', 등록된 폴더는 이름, 모르는 폴더는 폴더 이름만", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "회사");
  const store = ca.readStore(ctx);
  assert.equal(ca.labelForDir(store, null), "기본");
  assert.equal(ca.labelForDir(store, ca.dirFor(ctx, a.id) + "/"), "회사");
  assert.equal(ca.labelForDir(store, "/somewhere/else/old-acct"), "old-acct");
  assert.equal(ca.labelForDir(store, "   "), "기본");
});

test("sessionLabel: argv 에 변수가 있으면 ps 를 부르지 않고, 없으면 ps 에서 CLAUDE_CONFIG_DIR 한 줄만 읽는다", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "회사");
  const store = ca.readStore(ctx);
  let ps = 0;
  ctx.run = () => { ps += 1; return { status: 0, stdout: "", stderr: "" }; };
  assert.equal(ca.sessionLabel(ctx, store, { argv: ["env", `CLAUDE_CONFIG_DIR=${ca.dirFor(ctx, a.id)}`, "claude"], pid: 5 }), "회사");
  assert.equal(ps, 0);

  const secret = "ANTHROPIC_API_KEY=sk-ant-SECRET";
  ctx.run = (cmd, args) => {
    assert.equal(cmd, "ps");
    assert.deepEqual(args, ["eww", "-p", "42", "-o", "command="]);
    return { status: 0, stdout: `claude --model x ${secret} CLAUDE_CONFIG_DIR=/h/.claude-accounts/zzz HOME=/h`, stderr: "" };
  };
  const label = ca.sessionLabel(ctx, store, { argv: ["claude"], pid: 42 });
  assert.equal(label, "zzz");
  assert.ok(!JSON.stringify(label).includes("SECRET"));

  ctx.run = () => ({ status: 0, stdout: "claude --model x HOME=/h", stderr: "" });
  assert.equal(ca.sessionLabel(ctx, store, { argv: ["claude"], pid: 42 }), "기본");
});

test("sessionLabel: 알 수 없으면 null(ps 실패, pid 없음, 윈도우)", () => {
  const { ctx } = mk();
  const store = ca.readStore(ctx);
  ctx.run = () => ({ status: 1, stdout: "", stderr: "" });
  assert.equal(ca.sessionLabel(ctx, store, { argv: ["claude"], pid: 42 }), null);
  assert.equal(ca.sessionLabel(ctx, store, { argv: ["claude"] }), null);
  const win = mk({ platform: "win32" }).ctx;
  assert.equal(ca.sessionLabel(win, store, { argv: ["claude"], pid: 42 }), null);
});

// ---- status ----
test("reduceStatus: loggedIn 과 authMethod 두 값만 남긴다", () => {
  const s = ca.reduceStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", orgName: "X", token: "t" }));
  assert.deepEqual(s, { loggedIn: true, authMethod: "claude.ai" });
  assert.deepEqual(ca.reduceStatus('{"loggedIn":false}'), { loggedIn: false, authMethod: null });
  assert.equal(ca.reduceStatus("nope"), null);
});

test("status: 캐시된 값을 쓰고 --refresh 나 오래되면 claude auth status 를 그 폴더 환경으로 부른다", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  const seen = [];
  ctx.run = (cmd, args, o) => { seen.push({ cmd, args, dir: o.env.CLAUDE_CONFIG_DIR }); return { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "x@y.z" }), stderr: "" }; };
  const r1 = ca.status(ctx, a.id, false);
  assert.deepEqual([r1.ok, r1.loggedIn, r1.authMethod], [true, true, "claude.ai"]);
  assert.equal(seen[0].dir, ca.dirFor(ctx, a.id));
  assert.deepEqual(seen[0].args, ["auth", "status", "--json"]);
  ca.status(ctx, a.id, false);
  assert.equal(seen.length, 1, "신선한 캐시는 다시 부르지 않는다");
  ca.status(ctx, a.id, true);
  assert.equal(seen.length, 2);
  const cache = fs.readFileSync(path.join(home, ".herdr-inbox", "claude-accounts-cache.json"), "utf8");
  assert.ok(!cache.includes("x@y.z"), "이메일은 저장하지 않는다");
  ctx.now += 6 * 60 * 1000;
  ca.status(ctx, a.id, false);
  assert.equal(seen.length, 3);
  ca.status(ctx, null, true);
  assert.equal(seen.at(-1).dir, undefined, "기본 계정은 변수 없이");
});

test("list: 기본 계정이 먼저, 선택 표시, 사용량은 그 폴더의 usage-limits.json 에서", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  ca.select(ctx, a.id);
  fs.writeFileSync(path.join(ca.dirFor(ctx, a.id), "usage-limits.json"), JSON.stringify({ updatedAt: new Date(ctx.now - 60_000).toISOString(),
    limits: [{ kind: "five_hour", percentUsed: 41.6 }, { kind: "seven_day", percentUsed: 7 }, { kind: "other", percentUsed: 1 }] }));
  const l = ca.list(ctx);
  assert.deepEqual(l.accounts.map((x) => [x.id, x.label, x.selected]), [[null, "기본 계정", false], [a.id, "A", true]]);
  assert.deepEqual(l.accounts[1].usage, [{ label: "5h", percent: 42 }, { label: "7d", percent: 7 }]);
  assert.equal(l.accounts[0].usage, null);
  assert.equal(ca.parseUsage("{", ctx.now), null);
  assert.equal(ca.parseUsage(JSON.stringify({ updatedAt: new Date(ctx.now - 3_600_000).toISOString(), limits: [{ kind: "five_hour", percentUsed: 1 }] }), ctx.now), null);
  assert.ok(home);
});

test("sameAs: 같은 accountUuid 해시면 같은 계정으로 보고, 값 자체는 어디에도 내보내지 않는다", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  const b = ca.add(ctx, "B");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-1", emailAddress: "e@x.y" } }));
  fs.writeFileSync(path.join(ca.dirFor(ctx, a.id), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-1" } }));
  fs.writeFileSync(path.join(ca.dirFor(ctx, b.id), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-2" } }));
  const store = ca.readStore(ctx);
  assert.deepEqual(ca.sameAs(ctx, store, a.id), ["default"]);
  assert.deepEqual(ca.sameAs(ctx, store, b.id), []);
  assert.equal(ca.fingerprint(ctx, ca.dirFor(ctx, a.id)), crypto.createHash("sha256").update("uuid-1").digest("hex"));
  assert.equal(ca.fingerprint(ctx, path.join(home, "none")), null);
});

// ---- login state machine ----
test("parseLoginUrl: 첫 https 주소, 터미널이 줄바꿈한 나머지는 이어 붙이고 문장은 붙이지 않는다", () => {
  assert.equal(ca.parseLoginUrl("Opening browser...\nhttps://claude.ai/oauth/authorize?code=true\n"), "https://claude.ai/oauth/authorize?code=true");
  assert.equal(ca.parseLoginUrl("visit https://claude.ai/oauth/authorize?code=true&client_id=abc\n123def&state=xyz\nPaste code here if prompted"),
    "https://claude.ai/oauth/authorize?code=true&client_id=abc123def&state=xyz");
  assert.equal(ca.parseLoginUrl("no url here"), null);
  assert.equal(ca.parseLoginUrl("\x1b[1mhttps://a.b/c\x1b[0m"), "https://a.b/c");
});

function hcStub(state) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const out = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
    if (args[0] === "run") return out({ address: "t9" });
    if (args[0] === "get") return state.gone ? { status: 1, stdout: "", stderr: "" } : out({ state: state.state, exit_code: state.exit });
    if (args[0] === "read") return out({ complete: true, how: "screen", text: state.text || "" });
    return { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

test("login start: 그 폴더로 백그라운드 hc 터미널을 열고(env 로 CLAUDE_CONFIG_DIR), 폴더를 시드한다", () => {
  const { home, ctx } = mk();
  fakeDefault(home);
  const a = ca.add(ctx, "A");
  const st = { state: "live" };
  ctx.hc = hcStub(st);
  const r = ca.loginStart(ctx, a.id);
  assert.equal(r.ok, true);
  const run = ctx.hc.calls.find((c) => c[0] === "run");
  const dir = ca.dirFor(ctx, a.id);
  assert.deepEqual(run.slice(0, 7), ["run", "--bg", "--json", "--no-parent", "--cwd", dir, "--label"]);
  assert.equal(run[7], `claude-login=${a.id}`);
  assert.deepEqual(run.slice(9), ["env", "PATH=/bin:/usr/bin", `CLAUDE_CONFIG_DIR=${dir}`, "claude", "auth", "login", "--claudeai"]);
  assert.equal(r.login.state, "starting");
  assert.equal(ca.loginStart(ctx, a.id).ok, false, "진행 중에는 또 시작하지 않는다");
  assert.equal(ca.loginStart(mk({ platform: "win32" }).ctx, "x").ok, false);
});

test("login status: 주소가 보이면 waiting+url, 끝나면(성공) 상태를 확인해 done, 터미널은 치운다", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  const st = { state: "live", text: "Open this URL:\nhttps://claude.ai/oauth/authorize?code=true\n" };
  ctx.hc = hcStub(st);
  ca.loginStart(ctx, a.id);
  const w = ca.loginStatus(ctx);
  assert.deepEqual([w.state, w.url], ["waiting", "https://claude.ai/oauth/authorize?code=true"]);
  ctx.run = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" });
  st.state = "finished"; st.exit = 0;
  const d = ca.loginStatus(ctx);
  assert.deepEqual([d.state, d.duplicate, d.url], ["done", false, null]);
  assert.ok(ctx.hc.calls.some((c) => c[0] === "rm" && c[1] === "t9"));
  assert.equal(ca.loginStatus(ctx).state, "done", "끝난 결과는 다음 읽기에도 남는다");
  assert.ok(home);
});

test("login status: 같은 계정을 또 로그인하면 duplicate 와 '이미 등록된 계정과 같음' 만 알리고 값은 알리지 않는다", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "same-uuid" } }));
  fs.writeFileSync(path.join(ca.dirFor(ctx, a.id), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "same-uuid" } }));
  const st = { state: "finished", exit: 0 };
  ctx.hc = hcStub(st);
  ctx.run = () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" });
  fs.mkdirSync(path.join(home, ".herdr-inbox"), { recursive: true });
  fs.writeFileSync(path.join(home, ".herdr-inbox", "claude-login.json"), JSON.stringify({ id: a.id, label: "A", terminal: "t9", state: "waiting", startedAt: ctx.now }));
  const d = ca.loginStatus(ctx);
  assert.equal(d.state, "done");
  assert.equal(d.duplicate, true);
  assert.match(d.message, /이미 등록된 계정과 같음/);
  assert.ok(!JSON.stringify(d).includes("same-uuid"));
});

test("login status: 실패 종료·로그인 안 됨·터미널 사라짐·15분 초과는 failed", () => {
  const cases = [
    [{ state: "finished", exit: 1 }, null, /실패/],
    [{ state: "finished", exit: 0 }, { loggedIn: false }, /확인하지 못했습니다/],
    [{ gone: true }, null, /찾지 못했습니다/],
  ];
  for (const [st, status, re] of cases) {
    const { ctx } = mk();
    const a = ca.add(ctx, "A");
    ctx.hc = hcStub({ state: "live" });
    ca.loginStart(ctx, a.id);
    ctx.hc = hcStub(st);
    ctx.run = () => ({ status: 0, stdout: JSON.stringify(status || {}), stderr: "" });
    const r = ca.loginStatus(ctx);
    assert.equal(r.state, "failed");
    assert.match(r.message, re);
  }
  const { ctx } = mk();
  const a = ca.add(ctx, "A");
  const st = { state: "live" };
  ctx.hc = hcStub(st);
  ca.loginStart(ctx, a.id);
  ctx.now += 16 * 60 * 1000;
  const r = ca.loginStatus(ctx);
  assert.equal(r.state, "failed");
  assert.ok(ctx.hc.calls.some((c) => c[0] === "kill"));
});

test("login cancel: 터미널을 멈추고 cancelled, 진행 중이 아니면 거절", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "A");
  ctx.hc = hcStub({ state: "live" });
  assert.equal(ca.loginCancel(ctx).ok, false);
  ca.loginStart(ctx, a.id);
  assert.equal(ca.loginCancel(ctx).ok, true);
  assert.ok(ctx.hc.calls.some((c) => c[0] === "kill" && c[1] === "t9"));
  assert.equal(ca.loginStatus(ctx).state, "cancelled");
});

test("logout: 그 폴더 환경으로 claude auth logout 만 부르고, 목록에 없으면 거절", () => {
  const { ctx } = mk();
  const a = ca.add(ctx, "A");
  const seen = [];
  ctx.run = (cmd, args, o) => { seen.push([cmd, ...args, o.env.CLAUDE_CONFIG_DIR]); return { status: 0, stdout: "", stderr: "" }; };
  assert.equal(ca.logout(ctx, a.id).ok, true);
  assert.deepEqual(seen, [["claude", "auth", "logout", ca.dirFor(ctx, a.id)]]);
  assert.equal(ca.logout(ctx, "nope").ok, false);
});

test("CLI: main 은 JSON 한 줄을 stdout 에 쓰고, label --info 는 값 하나만 돌려준다", () => {
  const { home, ctx } = mk();
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = (s) => { out += s; return true; };
  try {
    const env = { ...process.env, HERDR_INBOX_DIR: path.join(home, ".herdr-inbox"), HOME: home };
    ctx.env = env;
    const code = ca.main(["label", "--info", JSON.stringify({ argv: ["env", "CLAUDE_CONFIG_DIR=/x/dirname", "claude"], pid: 1 })], { home, env, run: ctx.run });
    assert.equal(code, 0);
  } finally { process.stdout.write = write; }
  assert.deepEqual(JSON.parse(out), { label: "dirname" });
});

test("psConfigDir: 공백이 든 경로도 통째로 읽고, 다음 변수나 줄 끝에서 멈춘다", () => {
  const out = (stdout) => mk({ run: () => ({ status: 0, stdout, stderr: "" }) }).ctx;
  assert.equal(ca.psConfigDir(out("claude --x HOME=/h CLAUDE_CONFIG_DIR=/Users/a b/.claude-accounts/w-1 PATH=/bin TERM=x\n"), 123), "/Users/a b/.claude-accounts/w-1");
  assert.equal(ca.psConfigDir(out("claude CLAUDE_CONFIG_DIR=/Users/a b/c\n"), 123), "/Users/a b/c");
  assert.equal(ca.psConfigDir(out("claude HOME=/h PATH=/bin\n"), 123), null);
  assert.equal(ca.psConfigDir(out("claude XCLAUDE_CONFIG_DIR=/no\n"), 123), null);
});

test("fingerprint: accountUuid 한 칸만 읽어 해시로 비교하고, 값도 해시도 저장·출력 파일에 남지 않는다", () => {
  const { home, ctx } = mk();
  const a = ca.add(ctx, "A");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "SECRET-UUID-1", emailAddress: "me@example.org" }, other: "x" }));
  fs.writeFileSync(path.join(ca.dirFor(ctx, a.id), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "SECRET-UUID-1" } }));
  assert.deepEqual(ca.sameAs(ctx, ca.readStore(ctx), a.id), ["default"]);
  const hash = crypto.createHash("sha256").update("SECRET-UUID-1").digest("hex");
  const reads = [];
  const orig = fs.readFileSync;
  fs.readFileSync = function (f, ...r) { reads.push(String(f)); return orig.call(this, f, ...r); };
  try { ca.sameAs(ctx, ca.readStore(ctx), a.id); } finally { fs.readFileSync = orig; }
  assert.ok(reads.filter((f) => f.endsWith(".claude.json")).every((f) => f === path.join(home, ".claude.json") || f === path.join(ca.dirFor(ctx, a.id), ".claude.json")), ".claude.json 외 파일은 읽지 않는다");
  for (const dir of [path.join(home, ".herdr-inbox")]) for (const n of fs.readdirSync(dir)) {
    const body = fs.readFileSync(path.join(dir, n), "utf8");
    assert.ok(!body.includes("SECRET-UUID-1") && !body.includes(hash) && !body.includes("example.org"), `${n} 에 계정 식별값이 없다`);
  }
});
