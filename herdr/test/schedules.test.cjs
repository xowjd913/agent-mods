// schedules.cjs 단위 테스트: node --test herdr/test/schedules.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "schedules-test-"));
process.env.SCHEDULES_HOME = STORE;
const S = require("../mods/schedules/schedules.cjs");

const iso = (ms) => new Date(ms).toISOString();
const utc = (s) => Date.parse(s);
const sched = (schedule, timezone = "UTC", extra = {}) => ({ schedule, timezone, createdAt: utc("2026-01-01T00:00:00Z"), ...extra });
const nexts = (a, from, n = 3) => S.nextTimes(S.compile(a.schedule, a.timezone, a.createdAt), a.timezone, utc(from), n).map(iso);

function reset() {
  for (const f of fs.readdirSync(STORE)) fs.rmSync(path.join(STORE, f), { recursive: true, force: true });
}
function auto(over = {}) {
  return {
    name: "점검", enabled: true, program: "claude", prompt: "상태를 확인해줘", model: "", effort: "",
    schedule: { kind: "preset", preset: "daily", time: "09:00" }, timezone: "UTC", graceMinutes: 60,
    precheck: null, folder: { mode: "existing", path: os.tmpdir() }, reuseSession: false, ...over,
  };
}
function fakeDeps(now, over = {}) {
  const calls = { hc: [], workers: [], shell: [] };
  const deps = {
    now: () => now.t,
    hc: (args) => { calls.hc.push(args); return over.hc ? over.hc(args) : { code: 1, stdout: "", stderr: "no hc" }; },
    git: () => ({ code: 1, stdout: "", stderr: "" }),
    shell: (command, cwd, ms) => { calls.shell.push({ command, cwd, ms }); return over.shell ? over.shell(command) : { code: 0, timedOut: false, error: "", stderr: "" }; },
    sleep: () => { now.t += 1000; },
    spawnWorker: (id) => { calls.workers.push(id); return 4242; },
    pidAlive: () => true,
  };
  return { deps, calls };
}
const seed = (automations, runs = {}) => {
  fs.writeFileSync(S.paths.AUTOS_FILE, JSON.stringify({ version: 1, automations }));
  fs.writeFileSync(S.paths.RUNS_FILE, JSON.stringify({ version: 1, runs }));
};
const readRuns = () => JSON.parse(fs.readFileSync(S.paths.RUNS_FILE, "utf8")).runs;

test("프리셋: 매시간·매일·평일·매주", () => {
  assert.deepEqual(nexts(sched({ kind: "preset", preset: "hourly", time: "00:15" }), "2026-03-02T10:20:00Z", 2), ["2026-03-02T11:15:00.000Z", "2026-03-02T12:15:00.000Z"]);
  assert.deepEqual(nexts(sched({ kind: "preset", preset: "daily", time: "09:00" }), "2026-03-02T09:00:00Z", 2), ["2026-03-03T09:00:00.000Z", "2026-03-04T09:00:00.000Z"]);
  // 2026-03-06은 금요일. 평일 프리셋은 토·일을 건너뛴다.
  assert.deepEqual(nexts(sched({ kind: "preset", preset: "weekdays", time: "08:30" }), "2026-03-06T09:00:00Z", 3), ["2026-03-09T08:30:00.000Z", "2026-03-10T08:30:00.000Z", "2026-03-11T08:30:00.000Z"]);
  assert.deepEqual(nexts(sched({ kind: "preset", preset: "weekly", weekday: 5, time: "17:00" }), "2026-03-02T00:00:00Z", 2), ["2026-03-06T17:00:00.000Z", "2026-03-13T17:00:00.000Z"]);
});

test("시간대: 서울 매주 금 17:00은 UTC 08:00", () => {
  assert.deepEqual(nexts(sched({ kind: "preset", preset: "weekly", weekday: 5, time: "17:00" }, "Asia/Seoul"), "2026-03-02T00:00:00Z", 1), ["2026-03-06T08:00:00.000Z"]);
});

test("DST: 뉴욕 봄(2026-03-08) 02:30은 없는 시각이라 갭 뒤로 밀리고 하루에 한 번만", () => {
  const a = sched({ kind: "preset", preset: "daily", time: "02:30" }, "America/New_York");
  assert.deepEqual(nexts(a, "2026-03-07T12:00:00Z", 3), ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
});

test("DST: 뉴욕 가을(2026-11-01) 01:30은 두 번 오지만 먼저 오는 한 번만 실행", () => {
  const a = sched({ kind: "preset", preset: "daily", time: "01:30" }, "America/New_York");
  assert.deepEqual(nexts(a, "2026-10-31T12:00:00Z", 3), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
});

test("DST: 매일 09:00은 전환 전후로 벽시계 09:00을 지킨다", () => {
  const a = sched({ kind: "preset", preset: "daily", time: "09:00" }, "America/New_York");
  assert.deepEqual(nexts(a, "2026-03-07T00:00:00Z", 3), ["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
});

test("cron: 목록·범위·간격·요일 이름·일/요일 OR", () => {
  assert.deepEqual(nexts(sched({ kind: "cron", cron: "*/20 9-10 * * *" }), "2026-03-02T09:30:00Z", 3), ["2026-03-02T09:40:00.000Z", "2026-03-02T10:00:00.000Z", "2026-03-02T10:20:00.000Z"]);
  assert.deepEqual(nexts(sched({ kind: "cron", cron: "0 8 * * MON-WED" }), "2026-03-06T00:00:00Z", 2), ["2026-03-09T08:00:00.000Z", "2026-03-10T08:00:00.000Z"]);
  // 15일이거나 금요일
  assert.deepEqual(nexts(sched({ kind: "cron", cron: "0 0 15 * 5" }), "2026-03-01T00:00:00Z", 3), ["2026-03-06T00:00:00.000Z", "2026-03-13T00:00:00.000Z", "2026-03-15T00:00:00.000Z"]);
  // 요일 7은 일요일
  assert.deepEqual(nexts(sched({ kind: "cron", cron: "0 0 * * 7" }), "2026-03-01T01:00:00Z", 1), ["2026-03-08T00:00:00.000Z"]);
});

test("cron: 잘못된 식은 오류", () => {
  for (const bad of ["* * * *", "61 * * * *", "* 24 * * *", "*/0 * * * *", "a b c d e", "5-1 * * * *"]) {
    assert.throws(() => S.compile({ kind: "cron", cron: bad }, "UTC", 0), S.ScheduleError, bad);
  }
});

test("RRULE: 지원 항목", () => {
  const anchor = utc("2026-03-02T09:00:00Z"); // 월요일
  const mk = (rrule) => sched({ kind: "rrule", rrule }, "UTC", { createdAt: anchor });
  assert.deepEqual(nexts(mk("FREQ=DAILY;INTERVAL=2"), "2026-03-02T09:00:00Z", 3), ["2026-03-04T09:00:00.000Z", "2026-03-06T09:00:00.000Z", "2026-03-08T09:00:00.000Z"]);
  assert.deepEqual(nexts(mk("RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=7;BYMINUTE=30"), "2026-03-02T00:00:00Z", 3), ["2026-03-02T07:30:00.000Z", "2026-03-06T07:30:00.000Z", "2026-03-09T07:30:00.000Z"]);
  assert.deepEqual(nexts(mk("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"), "2026-03-02T09:00:00Z", 2), ["2026-03-16T09:00:00.000Z", "2026-03-30T09:00:00.000Z"]);
  assert.deepEqual(nexts(mk("FREQ=MONTHLY;BYMONTHDAY=1,-1;BYHOUR=6;BYMINUTE=0"), "2026-03-02T00:00:00Z", 3), ["2026-03-31T06:00:00.000Z", "2026-04-01T06:00:00.000Z", "2026-04-30T06:00:00.000Z"]);
  assert.deepEqual(nexts(mk("FREQ=HOURLY;INTERVAL=6;BYMINUTE=15"), "2026-03-02T09:00:00Z", 3), ["2026-03-02T09:15:00.000Z", "2026-03-02T15:15:00.000Z", "2026-03-02T21:15:00.000Z"]);
  assert.deepEqual(nexts(mk("FREQ=MONTHLY"), "2026-03-02T09:00:00Z", 2), ["2026-04-02T09:00:00.000Z", "2026-05-02T09:00:00.000Z"]);
});

test("RRULE: 지원하지 않는 항목·값은 저장 전에 오류", () => {
  for (const bad of ["FREQ=YEARLY", "FREQ=DAILY;COUNT=3", "FREQ=DAILY;UNTIL=20271231T000000Z", "FREQ=MONTHLY;BYDAY=1MO", "FREQ=DAILY;BYSETPOS=1", "FREQ=DAILY;INTERVAL=0", "FREQ=WEEKLY;BYMONTHDAY=3", "INTERVAL=2", "FREQ=DAILY;BYHOUR=25", "FREQ=DAILY;BYMONTHDAY=0"]) {
    assert.throws(() => S.compile({ kind: "rrule", rrule: bad }, "UTC", 0), S.ScheduleError, bad);
  }
});

test("validateAutomation: 필수값·시간대·유예·폴더", () => {
  assert.deepEqual(S.validateAutomation(auto()), []);
  assert.ok(S.validateAutomation(auto({ name: " " })).length);
  assert.ok(S.validateAutomation(auto({ program: "gpt" })).length);
  assert.ok(S.validateAutomation(auto({ prompt: "" })).length);
  assert.ok(S.validateAutomation(auto({ timezone: "Mars/Base" })).length);
  assert.ok(S.validateAutomation(auto({ graceMinutes: -1 })).length);
  assert.ok(S.validateAutomation(auto({ folder: { mode: "existing", path: "/없는/폴더" } })).length);
  assert.ok(S.validateAutomation(auto({ folder: { mode: "worktree", path: os.tmpdir() }, reuseSession: true })).length);
  assert.ok(S.validateAutomation(auto({ schedule: { kind: "rrule", rrule: "FREQ=DAILY;COUNT=2" } })).length);
  assert.ok(S.validateAutomation(auto({ model: "x; rm -rf /" })).length);
});

test("validateAutomation: 기준 브랜치 이름 검사", () => {
  const wt = (base) => auto({ folder: { mode: "worktree", path: os.tmpdir(), base } });
  for (const ok of [undefined, "", "develop", "release/1.2", "feature/363-x_y.z"]) assert.deepEqual(S.validateAutomation(wt(ok)), [], String(ok));
  for (const bad of ["-rf", "a b", "a..b", "/a", "a/", "a//b", "x.lock", "a;b", "a$(b)", ".hidden", "한글"]) assert.ok(S.validateAutomation(wt(bad)).length, bad);
  assert.ok(S.validateAutomation(auto({ folder: { mode: "existing", path: os.tmpdir(), base: "develop" } })).length, "기존 폴더 방식에는 기준 브랜치를 못 쓴다");
});

// 새 워크트리 실행에서 git 호출을 기록하는 가짜. refs는 존재하는 참조 목록.
function worktreeRun(folder, refs, { fetchOk = true } = {}) {
  reset();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sched-repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "22222222", createdAt: now.t, ...auto({ folder: { mode: "worktree", path: repo, ...folder } }) };
  seed([a], { "22222222": [{ id: "w1", automationId: "22222222", trigger: "수동", scheduledAt: now.t, startedAt: now.t, status: "실행 중" }] });
  const gitCalls = [];
  const { deps } = fakeDeps(now, { hc: () => ({ code: 1, stdout: "", stderr: "no hc" }) });
  deps.git = (dir, args) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return { code: 0, stdout: `${path.join(repo, ".git")}\n`, stderr: "" };
    if (args[0] === "fetch") return { code: fetchOk ? 0 : 1, stdout: "", stderr: fetchOk ? "" : "offline" };
    if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: refs.includes(args[args.length - 1].replace(/\^\{commit\}$/, "")) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "worktree") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  S.execute("w1", deps);
  return { run: readRuns()["22222222"][0], add: gitCalls.find((c) => c[0] === "worktree"), gitCalls, repo };
}

test("execute: 새 워크트리는 기준 브랜치를 비우면 기본 브랜치에서, 주면 origin/<기준>에서 만든다", () => {
  const blank = worktreeRun({}, []);
  assert.deepEqual(blank.add.slice(0, 3), ["worktree", "add", "--no-track"]);
  assert.equal(blank.add[blank.add.length - 1], "origin/main");
  const dev = worktreeRun({ base: "develop" }, ["refs/remotes/origin/develop", "refs/heads/develop"]);
  assert.equal(dev.add[dev.add.length - 1], "refs/remotes/origin/develop");
  assert.ok(dev.gitCalls.some((c) => c[0] === "fetch"), "fetch origin 뒤에 기준을 고른다");
  assert.ok(dev.run.worktree && dev.run.branch, "워크트리와 브랜치가 기록된다");
});

test("execute: origin에 없고 로컬에만 있는 기준은 로컬 브랜치에서 만든다", () => {
  const local = worktreeRun({ base: "release/1.2" }, ["refs/heads/release/1.2"], { fetchOk: false });
  assert.equal(local.add[local.add.length - 1], "refs/heads/release/1.2");
  assert.match(local.run.note, /fetch origin 실패/);
});

test("execute: 기준 브랜치가 어디에도 없으면 워크트리를 만들지 않고 '실패'로 기록한다", () => {
  const missing = worktreeRun({ base: "nope" }, ["refs/remotes/origin/main"]);
  assert.equal(missing.add, undefined);
  assert.equal(missing.run.status, "실패");
  assert.match(missing.run.error, /기준 브랜치를 찾지 못했습니다: nope/);
});

test("save: 기준 브랜치는 워크트리 방식에서만 저장하고 비우면 필드를 두지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T00:00:00Z") };
  const { deps } = fakeDeps(now);
  const withBase = S.save(auto({ folder: { mode: "worktree", path: os.tmpdir(), base: " develop " } }), deps);
  assert.equal(withBase.automation.folder.base, "develop");
  const blank = S.save(auto({ name: "b", folder: { mode: "worktree", path: os.tmpdir(), base: "  " } }), deps);
  assert.equal("base" in blank.automation.folder, false);
  reset();
});

test("refreshRun: hc get이 일시 실패하면 닫힌 것으로 보지 않고 건너뛰고, 없는 터미널(not_found)만 닫힘으로 본다", () => {
  const now = utc("2026-03-02T09:05:00Z");
  const run = { id: "r", automationId: "z", status: "실행 중", terminal: "t1", promptSent: true, sentAt: now - 120000, startedAt: now - 130000, turnBefore: 0, sawWorking: true };
  const deps = (r) => ({ now: () => now, hc: () => r, pidAlive: () => true });
  assert.equal(S.refreshRun(run, {}, deps({ code: 124, stdout: "", stderr: "timed out" }), now), null);
  assert.equal(S.refreshRun(run, {}, deps({ code: 127, stdout: "", stderr: "spawn hc ENOENT" }), now), null);
  assert.equal(S.refreshRun(run, {}, deps({ code: 0, stdout: "not json", stderr: "" }), now), null);
  const gone = S.refreshRun(run, {}, deps({ code: 3, stdout: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "t1"' } }), stderr: "" }), now);
  assert.equal(gone.status, "완료");
  assert.equal(gone.terminalClosed, true);
});

test("refreshRun: 작업 프로세스가 시작을 기다리는 중(프롬프트 전)이면 tick이 상태를 건드리지 않는다", () => {
  const now = utc("2026-03-02T09:05:00Z");
  const run = { id: "r", automationId: "z", status: "실행 중", terminal: "t1", workerPid: 4242, startedAt: now - 20000 };
  const blocked = { now: () => now, pidAlive: () => true, hc: () => ({ code: 0, stdout: JSON.stringify({ state: "live", labels: { schedule: "z" }, turn: 0, status: { state: "blocked" } }), stderr: "" }) };
  assert.equal(S.refreshRun(run, {}, blocked, now), null);
  // 작업 프로세스가 죽었다면 tick이 이어받는다
  assert.equal(S.refreshRun(run, {}, { ...blocked, pidAlive: () => false }, now).status, "입력 대기");
});

test("describe: 요약 문구", () => {
  assert.equal(S.describe({ schedule: { kind: "preset", preset: "weekly", weekday: 5, time: "17:00" }, timezone: "Asia/Seoul" }), "매주 금 17:00 · Asia/Seoul");
  assert.equal(S.describe({ schedule: { kind: "preset", preset: "weekdays", time: "09:00" }, timezone: "UTC" }), "평일 09:00 · UTC");
});

test("latestIn: 구간 안에서 가장 최근 하나만 고른다", () => {
  const m = S.compile({ kind: "preset", preset: "daily", time: "09:00" }, "UTC", 0);
  assert.equal(iso(S.latestIn(m, "UTC", utc("2026-03-01T00:00:00Z"), utc("2026-03-04T12:00:00Z"))), "2026-03-04T09:00:00.000Z");
  assert.equal(S.latestIn(m, "UTC", utc("2026-03-04T09:00:00Z"), utc("2026-03-04T12:00:00Z")), null);
});

test("tick: 정시 실행은 '예약', 같은 회차는 두 번 만들지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:20Z") };
  seed([{ id: "aaaaaaaa", createdAt: utc("2026-03-01T00:00:00Z"), cursor: utc("2026-03-02T08:59:50Z"), ...auto() }]);
  const { deps, calls } = fakeDeps(now);
  const r1 = S.tick(deps);
  assert.equal(r1.started.length, 1);
  const runs = readRuns().aaaaaaaa;
  assert.equal(runs[0].trigger, "예약");
  assert.equal(iso(runs[0].scheduledAt), "2026-03-02T09:00:00.000Z");
  assert.equal(calls.workers.length, 1);
  // 커서를 되돌려도 (id, 예정 시각)이 이미 있어 다시 만들지 않는다.
  const store = JSON.parse(fs.readFileSync(S.paths.AUTOS_FILE, "utf8"));
  store.automations[0].cursor = utc("2026-03-02T08:59:50Z");
  fs.writeFileSync(S.paths.AUTOS_FILE, JSON.stringify(store));
  now.t += 30000;
  const r2 = S.tick(deps);
  assert.equal(r2.started.length, 0);
  assert.equal(readRuns().aaaaaaaa.length, 1);
});

test("tick: 앱이 꺼져 있다가 허용 시간 안이면 '놓친 실행', 가장 최근 회차 하나만", () => {
  reset();
  const now = { t: utc("2026-03-04T09:30:00Z") };
  // 3·4일 09:00 두 번을 놓쳤다. 허용 60분 → 4일 것만 놓친 실행으로 돌린다.
  seed([{ id: "bbbbbbbb", createdAt: utc("2026-03-01T00:00:00Z"), cursor: utc("2026-03-02T09:10:00Z"), ...auto() }]);
  const { deps, calls } = fakeDeps(now);
  S.tick(deps);
  const runs = readRuns().bbbbbbbb;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "놓친 실행");
  assert.equal(iso(runs[0].scheduledAt), "2026-03-04T09:00:00.000Z");
  assert.equal(calls.workers.length, 1);
});

test("tick: 허용 시간을 넘기면 '놓침'으로만 기록하고 실행하지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-04T12:00:00Z") };
  seed([{ id: "cccccccc", createdAt: utc("2026-03-01T00:00:00Z"), cursor: utc("2026-03-03T10:00:00Z"), ...auto() }]);
  const { deps, calls } = fakeDeps(now);
  const r = S.tick(deps);
  assert.equal(r.started.length, 0);
  assert.equal(calls.workers.length, 0);
  const runs = readRuns().cccccccc;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "놓침");
  assert.match(runs[0].error, /허용 시간/);
  // 예정 시각(3일 10:00 이후 첫 회차 = 4일 09:00 UTC)과 늦은 분이 문구에 들어간다.
  assert.match(runs[0].error, /^예정 3\/4 09:00 실행을 앱이 꺼져 있어 180분 늦게 확인했고, 허용 시간\(60분\)이 지나 실행하지 않았습니다\.$/);
  assert.equal(iso(runs[0].scheduledAt), "2026-03-04T09:00:00.000Z");
});

test("tick: 꺼 둔 예약은 실행하지 않고, 다시 켜면 그 사이 회차를 뒤늦게 돌리지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:10Z") };
  seed([{ id: "dddddddd", createdAt: utc("2026-03-01T00:00:00Z"), cursor: utc("2026-03-02T08:59:00Z"), ...auto({ enabled: false }) }]);
  const { deps, calls } = fakeDeps(now);
  S.tick(deps);
  assert.equal(calls.workers.length, 0);
  assert.deepEqual(readRuns(), {});
  now.t = utc("2026-03-02T09:00:40Z");
  S.toggle("dddddddd", true, deps);
  now.t = utc("2026-03-02T09:01:10Z");
  S.tick(deps);
  assert.equal(calls.workers.length, 0);
});

test("tick: 동시에 도는 tick은 하나만", () => {
  reset();
  fs.writeFileSync(path.join(STORE, "tick.lock"), "1");
  const now = { t: Date.now() };
  const { deps } = fakeDeps(now);
  assert.ok(S.tick(deps).skipped);
  fs.rmSync(path.join(STORE, "tick.lock"));
});

test("execute: 사전 검사 실패는 '검사로 건너뜀', 터미널을 만들지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "eeeeeeee", createdAt: now.t, ...auto({ precheck: { command: "test -f nothing", timeoutSec: 5 } }) };
  seed([a], { eeeeeeee: [{ id: "r1", automationId: "eeeeeeee", trigger: "예약", scheduledAt: now.t, startedAt: now.t, status: "실행 중" }] });
  const { deps, calls } = fakeDeps(now, { shell: () => ({ code: 1, timedOut: false, error: "", stderr: "" }) });
  S.execute("r1", deps);
  const run = readRuns().eeeeeeee[0];
  assert.equal(run.status, "검사로 건너뜀");
  assert.equal(calls.shell.length, 1);
  assert.equal(calls.hc.length, 0);
});

test("execute: 사전 검사 시간 초과도 건너뜀, 수동 실행은 검사를 하지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "ffffffff", createdAt: now.t, ...auto({ precheck: { command: "sleep 99", timeoutSec: 1 } }) };
  seed([a], { ffffffff: [
    { id: "r1", automationId: "ffffffff", trigger: "예약", scheduledAt: 1, startedAt: now.t, status: "실행 중" },
    { id: "r2", automationId: "ffffffff", trigger: "수동", scheduledAt: 2, startedAt: now.t, status: "실행 중" },
  ] });
  const { deps, calls } = fakeDeps(now, { shell: () => ({ code: null, timedOut: true, error: "", stderr: "" }) });
  S.execute("r1", deps);
  assert.equal(readRuns().ffffffff.find((r) => r.id === "r1").status, "검사로 건너뜀");
  const shellBefore = calls.shell.length;
  S.execute("r2", deps); // hc가 없어 실패하지만 사전 검사는 건너뛴다
  assert.equal(calls.shell.length, shellBefore);
});

test("execute: 새 터미널을 열고 idle이 되면 프롬프트를 hc send로 보낸다(인자로 넘기지 않는다)", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "11111111", createdAt: now.t, ...auto({ model: "opus", effort: "high" }) };
  seed([a], { "11111111": [{ id: "r1", automationId: "11111111", trigger: "예약", scheduledAt: now.t, startedAt: now.t, status: "실행 중" }] });
  let polls = 0;
  const { deps, calls } = fakeDeps(now, {
    hc: (args) => {
      if (args[0] === "run") return { code: 0, stdout: JSON.stringify({ address: "t99" }), stderr: "" };
      if (args[0] === "get") { polls++; return { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "claude-code", state: polls < 3 ? "working" : "idle" }, turn: 0, labels: { schedule: "11111111" } }), stderr: "" }; }
      if (args[0] === "send") return { code: 0, stdout: "{}", stderr: "" };
      return { code: 1, stdout: "", stderr: "?" };
    },
  });
  S.execute("r1", deps);
  const run = readRuns()["11111111"][0];
  assert.equal(run.status, "실행 중");
  assert.equal(run.terminal, "t99");
  assert.equal(run.promptSent, true);
  const runCall = calls.hc.find((c) => c[0] === "run");
  const joined = runCall.join(" ");
  assert.match(joined, /--no-parent/);
  assert.match(joined, /--permission-mode auto/);
  assert.match(joined, /--model opus/);
  assert.match(joined, /--effort high/);
  assert.match(joined, /--label schedule=11111111/);
  assert.ok(!joined.includes("상태를 확인해줘"), "프롬프트는 실행 인자에 들어가면 안 된다");
  assert.ok(!joined.includes("dangerously"));
  const send = calls.hc.find((c) => c[0] === "send");
  assert.deepEqual(send.slice(-2), ["t99", "상태를 확인해줘"]);
});

test("execute: 시작 화면에서 blocked면 '입력 대기'로 기록하고 키를 보내지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "22222222", createdAt: now.t, ...auto() };
  seed([a], { "22222222": [{ id: "r1", automationId: "22222222", trigger: "예약", scheduledAt: now.t, startedAt: now.t, status: "실행 중" }] });
  const { deps, calls } = fakeDeps(now, {
    hc: (args) => {
      if (args[0] === "run") return { code: 0, stdout: JSON.stringify({ address: "t7" }), stderr: "" };
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "claude-code", kind: "permission", msg: "trust this folder", state: "blocked" }, turn: 0, labels: { schedule: "22222222" } }), stderr: "" };
      return { code: 1, stdout: "", stderr: "?" };
    },
  });
  S.execute("r1", deps);
  assert.equal(readRuns()["22222222"][0].status, "입력 대기");
  assert.ok(!calls.hc.some((c) => c[0] === "send"));
});

test("execute: status 없이 선택 화면(업데이트 안내)에 멈추면 시간 초과 뒤 '입력 대기'로 기록한다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "44444444", createdAt: now.t, ...auto({ program: "codex" }) };
  seed([a], { "44444444": [{ id: "r1", automationId: "44444444", trigger: "예약", scheduledAt: now.t, startedAt: now.t, status: "실행 중" }] });
  const { deps, calls } = fakeDeps(now, {
    hc: (args) => {
      if (args[0] === "run") return { code: 0, stdout: JSON.stringify({ address: "t8" }), stderr: "" };
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ state: "live", status: null, turn: 0, labels: { schedule: "44444444" } }), stderr: "" };
      if (args[0] === "read") return { code: 0, stdout: "Update available\n› 1. Update now\n  2. Skip\n  enter continue · esc skip\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "?" };
    },
  });
  S.execute("r1", deps);
  assert.equal(readRuns()["44444444"][0].status, "입력 대기");
  assert.ok(!calls.hc.some((c) => c[0] === "send"));
});

test("execute: codex는 --approve-for-me, 위험 우회 옵션은 쓰지 않는다", () => {
  const args = S.launchArgs({ id: "x", name: "n", program: "codex", model: "", effort: "" }, "sched-x", "/w");
  assert.ok(args.includes("--approve-for-me"));
  assert.ok(!args.some((v) => String(v).includes("dangerously")));
});

test("execute: 세션 재사용은 살아 있는 이전 터미널로 보낸다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:00:00Z") };
  const a = { id: "33333333", createdAt: now.t, ...auto({ reuseSession: true }) };
  seed([a], { "33333333": [
    { id: "r2", automationId: "33333333", trigger: "예약", scheduledAt: 2, startedAt: now.t, status: "실행 중" },
    { id: "r1", automationId: "33333333", trigger: "예약", scheduledAt: 1, startedAt: now.t - 1000, status: "완료", terminal: "t5", promptSent: true },
  ] });
  const { deps, calls } = fakeDeps(now, {
    hc: (args) => {
      if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ state: "live", status: "idle", turn: 3, labels: { schedule: "33333333" } }), stderr: "" };
      if (args[0] === "send") return { code: 0, stdout: "{}", stderr: "" };
      return { code: 1, stdout: "", stderr: "?" };
    },
  });
  S.execute("r2", deps);
  const run = readRuns()["33333333"].find((r) => r.id === "r2");
  assert.equal(run.terminal, "t5");
  assert.equal(run.reused, true);
  assert.ok(!calls.hc.some((c) => c[0] === "run"));
});

test("refreshRun: working→실행 중, 보낸 뒤 idle→완료, blocked→입력 대기, error→실패", () => {
  const now = utc("2026-03-02T09:05:00Z");
  const base = { id: "r", automationId: "z", status: "실행 중", terminal: "t1", promptSent: true, sentAt: now - 120000, startedAt: now - 130000, turnBefore: 0 };
  const mk = (t) => ({ now: () => now, hc: () => ({ code: 0, stdout: JSON.stringify({ state: "live", labels: { schedule: "z" }, turn: 1, ...t }), stderr: "" }), pidAlive: () => true });
  // 진짜 hc get --json은 status가 객체다. 문자열(hc ls 모양)도 같이 받는다.
  assert.equal(S.refreshRun(base, {}, mk({ status: { app: "claude-code", kind: "permission", state: "blocked" } }), now).status, "입력 대기");
  // 멈춘 시각이 기록돼야 화면에 "입력 대기 14:03"으로 보인다.
  assert.equal(S.refreshRun(base, {}, mk({ status: { app: "claude-code", kind: "permission", state: "blocked" } }), now).finishedAt, now);
  // 사용자가 답해 다시 실행 중이 되면 저장돼 있던 멈춘 시각을 지운다(null로 덮어쓴다).
  const resumed = S.refreshRun({ ...base, status: "입력 대기", finishedAt: now - 60000 }, {}, mk({ status: "working" }), now);
  assert.equal(resumed.status, "실행 중");
  assert.equal(resumed.finishedAt, null);
  assert.equal(S.refreshRun(base, {}, mk({ status: { app: "claude-code", state: "done" } }), now).status, "완료");
  assert.deepEqual(S.refreshRun(base, {}, mk({ status: "working" }), now), { sawWorking: true });
  assert.equal(S.refreshRun(base, {}, mk({ status: "idle" }), now).status, "완료");
  assert.equal(S.refreshRun(base, {}, mk({ status: "blocked" }), now).status, "입력 대기");
  assert.equal(S.refreshRun(base, {}, mk({ status: "error" }), now).status, "실패");
  // 보낸 직후(턴 변화 없음, working 본 적 없음)의 idle은 아직 끝난 것이 아니다
  const fresh = { ...base, sentAt: now - 5000, startedAt: now - 8000 };
  assert.equal(S.refreshRun(fresh, {}, mk({ status: "idle", turn: 0 }), now), null);
});

test("save/validate/list/delete 왕복과 50개 보관 제한", () => {
  reset();
  const now = { t: utc("2026-03-02T00:00:00Z") };
  const { deps } = fakeDeps(now);
  const bad = S.validate(auto({ schedule: { kind: "rrule", rrule: "FREQ=DAILY;COUNT=1" } }), deps);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.next, []);
  const good = S.validate(auto(), deps);
  assert.equal(good.ok, true);
  assert.equal(good.next.length, 3);
  const saved = S.save(auto(), deps);
  assert.equal(saved.ok, true);
  const id = saved.automation.id;
  assert.equal(S.list(deps).automations.length, 1);
  assert.equal(S.save({ ...auto({ name: "이름 바꿈" }), id }, deps).automation.name, "이름 바꿈");
  assert.equal(S.list(deps).automations.length, 1);
  const runs = { version: 1, runs: { [id]: [] } };
  const store = S.list(deps).automations[0];
  for (let i = 0; i < 60; i++) S.claimRun(runs, store, { trigger: "예약", scheduledAt: i, now: now.t });
  assert.equal(runs.runs[id].length, 50);
  assert.equal(S.claimRun(runs, store, { trigger: "예약", scheduledAt: 59, now: now.t }), null);
  assert.equal(S.remove(id).ok, true);
  assert.equal(S.list(deps).automations.length, 0);
});

test("options: Codex 모델·강도는 캐시에서 읽고 숨김 모델은 뺀다, 캐시가 없으면 기본 강도만", () => {
  reset();
  const cache = path.join(STORE, "models_cache.json");
  process.env.SCHEDULES_CODEX_CACHE = cache;
  try {
    fs.writeFileSync(cache, JSON.stringify({ models: [
      { slug: "b-model", display_name: "B", visibility: "list", priority: 2, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
      { slug: "hidden-one", visibility: "hide", priority: 1, supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "a-model", display_name: "A", visibility: "list", priority: 1, default_reasoning_level: "medium", supported_reasoning_levels: [] },
      { slug: "bad slug!", visibility: "list", priority: 3 },
    ] }));
    const out = S.options({});
    assert.equal(out.codex.fromCache, true);
    assert.deepEqual(out.codex.models.map((m) => m.slug), ["a-model", "b-model"]);
    assert.deepEqual(out.codex.models[0].efforts, ["low", "medium", "high", "xhigh"]); // 비어 있으면 기본 목록
    assert.deepEqual(out.codex.models[1].efforts, ["low", "high"]);
    assert.equal(out.codex.models[1].defaultEffort, "low");
    fs.writeFileSync(cache, "{깨진 파일");
    const broken = S.options({});
    assert.equal(broken.codex.fromCache, false);
    assert.deepEqual(broken.codex.models, []);
    assert.deepEqual(broken.codex.efforts, ["low", "medium", "high", "xhigh"]);
  } finally { delete process.env.SCHEDULES_CODEX_CACHE; }
});

test("options: 최근 폴더는 저장된 예약의 폴더만(없어진 폴더·중복 제외), 기준 브랜치는 기본 브랜치가 맨 앞", () => {
  reset();
  seed([
    { ...auto({ folder: { mode: "existing", path: os.tmpdir() } }), id: "a1" },
    { ...auto({ folder: { mode: "existing", path: os.tmpdir() } }), id: "a2" },
    { ...auto({ folder: { mode: "existing", path: path.join(STORE, "없는-폴더") } }), id: "a3" },
  ]);
  const now = { t: utc("2026-03-02T00:00:00Z") };
  const { deps } = fakeDeps(now, {});
  deps.git = (dir, args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse --path-format=absolute --git-common-dir")) return { code: 0, stdout: "/repo/.git\n", stderr: "" };
    if (key === "symbolic-ref --short refs/remotes/origin/HEAD") return { code: 0, stdout: "origin/trunk\n", stderr: "" };
    if (key === "for-each-ref --format=%(refname:short) refs/remotes/origin") return { code: 0, stdout: "origin\norigin/HEAD\norigin/feature/x\norigin/trunk\norigin/bad..name\n", stderr: "" };
    if (key === "for-each-ref --format=%(refname:short) refs/heads") return { code: 0, stdout: "trunk\nlocal-only\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const out = S.options({ path: os.tmpdir() }, deps);
  assert.deepEqual(out.folders, [os.tmpdir()]);
  assert.equal(out.isRepo, true);
  assert.equal(out.defaultBranch, "trunk");
  assert.deepEqual(out.branches, ["trunk", "feature/x", "local-only"]);
  // 저장소가 아니거나 폴더가 없으면 브랜치는 비어 있다
  deps.git = () => ({ code: 128, stdout: "", stderr: "not a git repository" });
  const plain = S.options({ path: os.tmpdir() }, deps);
  assert.equal(plain.isRepo, false);
  assert.deepEqual(plain.branches, []);
  assert.deepEqual(S.options({ path: path.join(STORE, "없는-폴더") }, deps).branches, []);
});

// ---------------------------------------------------------------- 알림
function noticeDeps(now, sent) {
  const { deps } = fakeDeps(now);
  deps.osNotify = (title, body) => { sent.push({ title, body }); };
  return deps;
}
const doneRun = (id, status, at, over = {}) => ({ id, automationId: "nnnnnnnn", trigger: "예약", status, startedAt: at - 60000, finishedAt: at, ...over });
const noticeAuto = (over = {}) => ({ id: "nnnnnnnn", createdAt: utc("2026-01-01T00:00:00Z"), cursor: utc("2026-03-02T09:00:00Z"), ...auto({ schedule: { kind: "preset", preset: "weekly", weekday: 0, time: "03:00" } }), ...over });

test("알림: 실패·입력 대기·놓침은 '문제만'에서 한 번씩만 나가고 tick이 반복돼도 다시 나가지 않는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:05:00Z") };
  const at = now.t - 60000;
  seed([noticeAuto()], { nnnnnnnn: [doneRun("r1", "실패", at, { error: "프로그램이 오류를 알렸습니다." }), doneRun("r2", "놓침", at - 1000, { error: "허용 시간이 지났습니다." })] });
  const sent = [];
  const deps = noticeDeps(now, sent);
  const r1 = S.tick(deps);
  assert.equal(r1.notices.length, 2);
  assert.deepEqual(sent.map((x) => x.title), ["예약 · 점검 — 놓침", "예약 · 점검 — 실패"]);
  assert.equal(sent[1].body, `3/2(월) 오전 9:04 · ${path.basename(os.tmpdir())}\n프로그램이 오류를 알렸습니다.`);
  now.t += 30000;
  assert.equal(S.tick(deps).notices.length, 0);
  assert.equal(sent.length, 2);
  assert.equal(readRuns().nnnnnnnn.find((r) => r.id === "r1").notified, "실패");
});

test("알림: 완료는 '모두'에서만, '끄기'는 아무것도 보내지 않는다", () => {
  for (const [mode, expected] of [["problems", 0], ["all", 1], ["off", 0], [undefined, 0]]) {
    reset();
    const now = { t: utc("2026-03-02T09:05:00Z") };
    seed([noticeAuto(mode === undefined ? {} : { notify: mode })], { nnnnnnnn: [doneRun("r1", "완료", now.t - 60000)] });
    const sent = [];
    const r = S.tick(noticeDeps(now, sent));
    assert.equal(r.notices.length, expected, `mode=${mode}`);
    assert.equal(sent.length, expected);
    if (expected) assert.equal(r.notices[0].title, "예약 · 점검 — 완료");
  }
  reset();
  const now = { t: utc("2026-03-02T09:05:00Z") };
  seed([noticeAuto({ notify: "off" })], { nnnnnnnn: [doneRun("r1", "실패", now.t - 60000, { error: "x" })] });
  assert.equal(S.tick(noticeDeps(now, [])).notices.length, 0);
});

test("알림: 오래전에 끝난 기록은 알리지 않는다(켤 때 한꺼번에 쏟아지지 않음)", () => {
  reset();
  const now = { t: utc("2026-03-02T09:05:00Z") };
  seed([noticeAuto({ notify: "all" })], { nnnnnnnn: [doneRun("old", "실패", now.t - 3 * 3600 * 1000, { error: "x" }), doneRun("new", "완료", now.t - 60000)] });
  const sent = [];
  const r = S.tick(noticeDeps(now, sent));
  assert.deepEqual(r.notices.map((n) => n.runId), ["new"]);
});

test("알림: 한 번에 3건까지만 개별로 보내고 오래된 것은 요약 한 건으로 접는다(가장 새 알림이 남는다)", () => {
  reset();
  const now = { t: utc("2026-03-02T09:05:00Z") };
  const runs = [1, 2, 3, 4, 5].map((i) => doneRun(`r${i}`, "실패", now.t - i * 1000, { error: `이유${i}` }));
  seed([noticeAuto()], { nnnnnnnn: runs });
  const sent = [];
  const r = S.tick(noticeDeps(now, sent));
  assert.equal(r.notices.length, 4);
  assert.deepEqual(r.notices.slice(0, 3).map((n) => n.runId), ["r3", "r2", "r1"]); // r1이 가장 새것, 보이는 순서는 오래된 것부터
  assert.equal(r.notices[3].title, "예약 · 알림 2건 더");
  assert.equal(S.tick(noticeDeps(now, sent)).notices.length, 0);
});

test("알림: 제목은 이름이 먼저고 이름이 길어도 결과 낱말이 끝에 남는다", () => {
  reset();
  const now = { t: utc("2026-03-02T09:05:00Z") };
  const long = "아주아주아주 길고 길고 길어서 한눈에 안 들어오는 예약 이름입니다";
  seed([noticeAuto({ name: long, notify: "all" })], { nnnnnnnn: [doneRun("r1", "입력 대기", now.t - 60000, { error: "멈춤" })] });
  const r = S.tick(noticeDeps(now, []));
  const t = r.notices[0].title;
  assert.ok(t.startsWith("예약 · 아주아주아주"));
  assert.ok(t.endsWith("… — 입력 대기"), t);
  assert.ok(Array.from(t).length <= 40, t);
});

test("알림: 본문은 짧은 시각·폴더 이름이고 이유 줄은 문제일 때만 있으며 길면 줄인다", () => {
  reset();
  const now = { t: utc("2026-03-02T21:05:00Z") };
  seed([noticeAuto({ notify: "all", folder: { mode: "existing", path: "/work/repos/my-app/" } })], {
    nnnnnnnn: [
      doneRun("ok", "완료", now.t - 60000),
      doneRun("bad", "실패", now.t - 120000, { error: `첫 줄\n둘째 줄 ${"가".repeat(200)}` }),
    ],
  });
  const r = S.tick(noticeDeps(now, []));
  const ok = r.notices.find((n) => n.runId === "ok");
  const bad = r.notices.find((n) => n.runId === "bad");
  assert.equal(ok.body, "3/2(월) 오후 9:04 · my-app"); // 이유 줄 없음
  const [head, reason, ...rest] = bad.body.split("\n");
  assert.equal(head, "3/2(월) 오후 9:03 · my-app");
  assert.ok(reason.startsWith("첫 줄 둘째 줄 가가") && reason.endsWith("…") && Array.from(reason).length <= 60, reason);
  assert.deepEqual(rest, []);
});

test("알림: Windows 경로와 폴더 없는 옛 기록도 본문을 만든다", () => {
  reset();
  const now = { t: utc("2026-03-02T00:30:00Z") };
  seed([noticeAuto({ notify: "all", folder: { mode: "existing", path: "C:\\Users\\kim\\Game Project\\" } })], { nnnnnnnn: [doneRun("a", "완료", now.t - 60000)] });
  assert.equal(S.tick(noticeDeps(now, [])).notices[0].body, "3/2(월) 오전 12:29 · Game Project");
  reset();
  seed([noticeAuto({ notify: "all", folder: undefined })], { nnnnnnnn: [doneRun("a", "완료", now.t - 60000, { error: undefined })] });
  assert.equal(S.tick(noticeDeps(now, [])).notices[0].body, "3/2(월) 오전 12:29");
});

test("알림: 입력 대기가 풀려 실행 중이 되면 표시가 지워져 다음 결과를 다시 알린다", () => {
  const run = { id: "r1", automationId: "nnnnnnnn", status: "입력 대기", terminal: "t1", promptSent: true, sawWorking: true, startedAt: 0, notified: "입력 대기", error: "멈춤" };
  const deps = { hc: () => ({ code: 0, stdout: JSON.stringify({ state: "live", labels: { schedule: "nnnnnnnn" }, status: { state: "working" }, turn: 2 }), stderr: "" }), pidAlive: () => true };
  const patch = S.refreshRun(run, {}, deps, 1000);
  assert.equal(patch.status, "실행 중");
  assert.equal(patch.notified, null);
});

test("알림: notify 값 검사와 저장 기본값", () => {
  assert.ok(S.validateAutomation(auto({ notify: "sometimes" })).some((e) => /알림/.test(e)));
  assert.deepEqual(S.validateAutomation(auto({ notify: "all" })), []);
  assert.deepEqual(S.validateAutomation(auto()), []);
  reset();
  const now = { t: utc("2026-03-02T09:05:00Z") };
  const { deps } = fakeDeps(now);
  const saved = S.save(auto(), deps);
  assert.equal(saved.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(S.paths.AUTOS_FILE, "utf8")).automations[0].notify, "problems");
});

test("알림: OS 알림 명령은 제목·본문을 인자나 환경 변수로만 넘긴다", () => {
  const evil = `x"; do shell script "rm -rf /" --'`;
  const mac = S.osNotifyCommand(evil, "본문", "darwin");
  assert.equal(mac.cmd, "osascript");
  assert.deepEqual(mac.args.slice(-3), [evil, "본문", "Herdr 예약"]); // 제목, 본문, subtitle(출처)
  assert.ok(!mac.args.slice(0, -3).some((x) => x.includes("rm -rf")));
  assert.ok(mac.args.includes("display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)"));
  assert.deepEqual(S.osNotifyCommand("t", "b", "linux").args, ["-a", "Herdr 예약", "t", "b"]);
  const win = S.osNotifyCommand(evil, "본문", "win32");
  assert.equal(win.cmd, "powershell.exe");
  assert.equal(win.env.SCHED_TITLE, evil);
  assert.ok(!win.args.join(" ").includes("rm -rf"));
});
