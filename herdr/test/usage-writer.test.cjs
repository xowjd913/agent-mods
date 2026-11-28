// usage-status 기록기(usage-writer.cjs)와 상태 줄 등록(install.cjs statusline) 테스트. 실행: node --test herdr/test/usage-writer.test.cjs
// 진짜 ~/.claude는 건드리지 않는다. 모든 시험은 임시 HOME·임시 설정 파일에서만 한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const W = require("../mods/usage-status/usage-writer.cjs");
const inst = require("../install.cjs");
const WRITER = path.join(__dirname, "..", "mods", "usage-status", "usage-writer.cjs");
const INSTALL = path.join(__dirname, "..", "install.cjs");

const NOW = Date.parse("2026-11-17T05:10:00Z");
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const tmp = (p = "herdr-uw-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const quiet = (fn) => { const o = console.log; console.log = () => {}; try { return fn(); } finally { console.log = o; } };
// Claude Code 공식 문서의 상태 줄 입력 모양(필드 이름은 문서 기준).
const input = (extra = {}) => ({
  model: { display_name: "Opus" },
  cost: { total_cost_usd: 1.2345 },
  rate_limits: {
    five_hour: { used_percentage: 12.4, resets_at: sec("2026-11-17T09:00:00Z") },
    seven_day: { used_percentage: 67.6, resets_at: sec("2026-11-20T00:00:00Z") },
  },
  ...extra,
});

test("buildUsage: 5h·7d 필드를 비공개 기록기와 같은 모양으로 바꾼다(반올림, ISO 시각, 비용)", () => {
  assert.deepEqual(W.buildUsage(input(), NOW), {
    limits: [
      { kind: "five_hour", percentUsed: 12, resetsAt: "2026-11-17T09:00:00.000Z" },
      { kind: "seven_day", percentUsed: 68, resetsAt: "2026-11-20T00:00:00.000Z" },
    ],
    costUsd: 1.2345,
  });
});

test("buildUsage: 한쪽 창만 있어도 그것만 돌려주고, 비용이 없으면 costUsd를 뺀다", () => {
  const u = W.buildUsage({ rate_limits: { seven_day: { used_percentage: 3, resets_at: sec("2026-11-20T00:00:00Z") } } }, NOW);
  assert.deepEqual(u, { limits: [{ kind: "seven_day", percentUsed: 3, resetsAt: "2026-11-20T00:00:00.000Z" }] });
});

test("buildUsage: rate_limits가 없거나(구독 아님·첫 응답 전) 쓸 수 있는 창이 없으면 null", () => {
  assert.equal(W.buildUsage({ cost: { total_cost_usd: 1 } }, NOW), null);
  assert.equal(W.buildUsage(null, NOW), null);
  assert.equal(W.buildUsage("x", NOW), null);
  assert.equal(W.buildUsage({ rate_limits: {} }, NOW), null);
  assert.equal(W.buildUsage({ rate_limits: { five_hour: { used_percentage: "x" } } }, NOW), null);
  assert.equal(W.buildUsage({ rate_limits: { five_hour: { used_percentage: NaN } } }, NOW), null);
});

test("buildUsage: 이미 리셋된 창은 버리고, 음수는 0으로 맞춘다", () => {
  const u = W.buildUsage({ rate_limits: {
    five_hour: { used_percentage: 50, resets_at: sec("2026-11-17T05:00:00Z") },
    seven_day: { used_percentage: -3, resets_at: sec("2026-11-20T00:00:00Z") },
  } }, NOW);
  assert.deepEqual(u.limits.map((l) => [l.kind, l.percentUsed]), [["seven_day", 0]]);
});

test("writeUsage: 폴더를 만들고 임시 파일 없이 {updatedAt, limits, costUsd}를 쓴다", () => {
  const home = tmp();
  const file = W.limitsFile(home);
  W.writeUsage(file, W.buildUsage(input(), NOW), NOW);
  const data = readJson(file);
  assert.deepEqual(Object.keys(data), ["updatedAt", "limits", "costUsd"]);
  assert.equal(data.updatedAt, "2026-11-17T05:10:00.000Z");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["usage-limits.json"]);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("}\n"));
  W.writeUsage(file, W.buildUsage(input({ cost: { total_cost_usd: 2 } }), NOW), NOW + 1000); // 덮어쓰기
  assert.equal(readJson(file).costUsd, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["usage-limits.json"]);
});

test("출력 모양은 usage-status의 parseUsage가 그대로 읽는다", async () => {
  const inbox = require("../mods/inbox/inbox.cjs");
  const home = tmp();
  const now = Date.now();
  const usage = W.buildUsage(input({ rate_limits: { five_hour: { used_percentage: 12.4, resets_at: Math.floor(now / 1000) + 3600 }, seven_day: { used_percentage: 67.6, resets_at: Math.floor(now / 1000) + 86400 } } }), now);
  W.writeUsage(W.limitsFile(home), usage, now);
  const rows = inbox.parseUsage(fs.readFileSync(W.limitsFile(home), "utf8"), now);
  assert.deepEqual(rows.map(({ label, percent }) => ({ label, percent })), [{ label: "5h", percent: 12 }, { label: "7d", percent: 68 }]);
});

function runWriter(home, stdin, args = []) {
  return spawnSync(process.execPath, [WRITER, ...args], { input: stdin, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
}

test("CLI: 표준 입력을 읽어 ~/.claude/usage-limits.json을 쓰고 한 줄 요약을 출력한다", () => {
  const home = tmp();
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = runWriter(home, JSON.stringify({ cost: { total_cost_usd: 0.5 }, rate_limits: { five_hour: { used_percentage: 12.4, resets_at: future }, seven_day: { used_percentage: 67.6, resets_at: future + 86400 } } }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "5h 12% · 7d 68%\n");
  const data = readJson(path.join(home, ".claude", "usage-limits.json"));
  assert.deepEqual(data.limits.map((l) => [l.kind, l.percentUsed]), [["five_hour", 12], ["seven_day", 68]]);
  assert.equal(data.costUsd, 0.5);
});

test("CLI: 깨진 입력·빈 입력·rate_limits 없음은 아무것도 쓰지 않고 0으로 끝난다", () => {
  const home = tmp();
  for (const stdin of ["", "{oops", "{}", JSON.stringify({ cost: { total_cost_usd: 1 } })]) {
    const r = runWriter(home, stdin);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
});

test("CLI: 기록할 수 없는 곳이어도 0으로 끝난다(상태 줄을 깨지 않는다)", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, ".claude"), "file, not a dir");
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = runWriter(home, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: future } } }));
  assert.equal(r.status, 0);
});

test("--chain: 같은 표준 입력을 원래 상태 줄 명령에 넘기고 그 출력을 상태 줄로 쓴다", () => {
  const home = tmp();
  const dir = tmp();
  const echo = path.join(dir, "orig.cjs");
  fs.writeFileSync(echo, 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write("ORIG:"+j.model.display_name+"\\n")})');
  const chain = path.join(dir, "chain.json");
  fs.writeFileSync(chain, JSON.stringify({ original: { type: "command", command: `"${process.execPath}" "${echo}"` } }));
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = runWriter(home, JSON.stringify({ model: { display_name: "Opus" }, rate_limits: { five_hour: { used_percentage: 9, resets_at: future } } }), ["--chain", chain]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ORIG:Opus\n");
  assert.equal(readJson(path.join(home, ".claude", "usage-limits.json")).limits[0].percentUsed, 9); // 이어 실행해도 기록은 한다
});

test("--chain: 체인 파일이 없거나 자기 자신을 가리키면 이어 실행하지 않고 요약을 낸다(무한 반복 없음)", () => {
  const home = tmp();
  const dir = tmp();
  const future = Math.floor(Date.now() / 1000) + 3600;
  const stdin = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 9, resets_at: future } } });
  assert.equal(runWriter(home, stdin, ["--chain", path.join(dir, "none.json")]).stdout, "5h 9%\n");
  const loop = path.join(dir, "loop.json");
  fs.writeFileSync(loop, JSON.stringify({ original: { type: "command", command: `node "${WRITER}"` } }));
  assert.equal(runWriter(home, stdin, ["--chain", loop]).stdout, "5h 9%\n");
});

// ---- 설치기: statusLine 등록. 설정 파일은 임시 폴더에 둔다.
function slEnv() {
  const home = tmp("herdr-home-");
  quiet(() => inst.installMods(home, { only: ["usage-status"] }));
  const dir = tmp("herdr-claude-");
  return { home, dir, file: path.join(dir, "settings.json"), script: path.join(home, "mods", "usage-status", "usage-writer.cjs") };
}
const fwd = (p) => p.replace(/\\/g, "/");

test("usage-status 설치는 usage-writer.cjs를 함께 복사한다(설정은 건드리지 않는다)", () => {
  const { script, dir } = slEnv();
  assert.ok(fs.existsSync(script));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("statusLine: 설정이 없으면 만들고 기록기 한 줄만 넣는다", () => {
  const { home, file, script } = slEnv();
  const r = inst.statusLineSettings(home, file);
  assert.equal(r.status, "installed");
  assert.equal(r.backup, undefined);
  assert.deepEqual(readJson(file), { statusLine: { type: "command", command: `node "${fwd(script)}"` } });
});

test("statusLine: 다른 키를 그대로 두고 쓰기 전에 백업하며, 들여쓰기를 지킨다", () => {
  const { home, file } = slEnv();
  const text = JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(ls)"] } }, null, 4) + "\n";
  fs.writeFileSync(file, text);
  const r = inst.statusLineSettings(home, file, {}, Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(r.status, "installed");
  assert.equal(fs.readFileSync(r.backup, "utf8"), text);
  assert.match(path.basename(r.backup), /^settings\.json\.bak-herdr-20260102030405$/);
  const s = readJson(file);
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.permissions, { allow: ["Bash(ls)"] });
  assert.ok(inst.isOurStatusLine(s.statusLine));
  assert.match(fs.readFileSync(file, "utf8"), /^\{\n {4}"theme"/);
});

test("statusLine: 두 번 넣어도 같고, 두 번째는 파일도 백업도 만들지 않는다", () => {
  const { home, dir, file } = slEnv();
  inst.statusLineSettings(home, file);
  const first = fs.readFileSync(file, "utf8");
  const names = fs.readdirSync(dir).sort();
  assert.equal(inst.statusLineSettings(home, file).status, "present");
  assert.equal(fs.readFileSync(file, "utf8"), first);
  assert.deepEqual(fs.readdirSync(dir).sort(), names);
});

test("statusLine: 다른 상태 줄이 있으면 바꾸지 않고 안내만 한다", () => {
  const { home, dir, file } = slEnv();
  const text = JSON.stringify({ statusLine: { type: "command", command: "my-line.sh", padding: 1 } }, null, 2) + "\n";
  fs.writeFileSync(file, text);
  const r = inst.statusLineSettings(home, file);
  assert.equal(r.status, "foreign");
  assert.ok(r.instructions.length >= 2);
  assert.match(r.instructions.join("\n"), /--wrap/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]); // 백업도 체인 파일도 없다
});

test("statusLine: command 형식이 아닌 상태 줄은 --wrap을 줘도 바꾸지 않는다", () => {
  const { home, file } = slEnv();
  const text = JSON.stringify({ statusLine: "weird" }) + "\n";
  fs.writeFileSync(file, text);
  assert.equal(inst.statusLineSettings(home, file, { wrap: true }).status, "foreign");
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("statusLine --wrap: 있던 상태 줄을 체인 파일에 보관하고 다른 키(padding)를 지킨다", () => {
  const { home, dir, file, script } = slEnv();
  const orig = { type: "command", command: "my-line.sh", padding: 2, refreshInterval: 5 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: orig, theme: "dark" }, null, 2) + "\n");
  const r = inst.statusLineSettings(home, file, { wrap: true });
  assert.equal(r.status, "wrapped");
  const chain = path.join(fs.realpathSync(dir), inst.CHAIN_FILE); // 설정 파일의 실제 위치(macOS 임시 폴더는 /private 아래) 옆
  assert.deepEqual(readJson(chain), { original: orig });
  const s = readJson(file);
  assert.equal(s.statusLine.command, `node "${fwd(script)}" --chain "${fwd(chain)}"`);
  assert.equal(s.statusLine.padding, 2);
  assert.equal(s.statusLine.refreshInterval, 5);
  assert.equal(s.theme, "dark");
  assert.equal(inst.statusLineSettings(home, file, { wrap: true }).status, "present");
});

test("statusLine --remove: 감싼 상태 줄을 되돌리고 체인 파일을 지운다", () => {
  const { home, dir, file } = slEnv();
  const orig = { type: "command", command: "my-line.sh", padding: 2 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: orig, theme: "dark" }, null, 2) + "\n");
  inst.statusLineSettings(home, file, { wrap: true });
  const r = inst.statusLineSettings(home, file, { remove: true });
  assert.equal(r.status, "removed");
  assert.deepEqual(readJson(file), { statusLine: orig, theme: "dark" });
  assert.equal(fs.existsSync(path.join(dir, inst.CHAIN_FILE)), false);
});

test("statusLine --remove: 감쌌다가 사용자가 상태 줄을 지운 뒤 다시 넣고 빼면 예전 상태 줄을 되살리지 않는다", () => {
  const { home, dir, file } = slEnv();
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: "old-line.sh" } }) + "\n");
  inst.statusLineSettings(home, file, { wrap: true });
  fs.writeFileSync(file, JSON.stringify({}) + "\n"); // 사용자가 statusLine을 직접 지웠다
  assert.equal(inst.statusLineSettings(home, file).status, "installed");
  assert.equal(fs.existsSync(path.join(dir, inst.CHAIN_FILE)), false); // 감싸지 않은 등록은 남은 감싸기 기록을 지운다
  const r = inst.statusLineSettings(home, file, { remove: true });
  assert.equal(r.status, "removed");
  assert.equal(r.restored, false);
  assert.deepEqual(readJson(file), {});
});

test("statusLine --remove: 감싸지 않은 등록이면 남아 있는 체인 파일이 있어도 쓰지 않는다", () => {
  const { home, dir, file } = slEnv();
  inst.statusLineSettings(home, file);
  fs.writeFileSync(path.join(dir, inst.CHAIN_FILE), JSON.stringify({ original: { type: "command", command: "stale.sh" } }));
  assert.equal(inst.statusLineSettings(home, file, { remove: true }).status, "removed");
  assert.deepEqual(readJson(file), {});
});

test("statusLine --remove: 우리가 넣기만 했으면 키를 지우고, 우리 것이 아니면 그대로 둔다", () => {
  const { home, file } = slEnv();
  inst.statusLineSettings(home, file);
  assert.equal(inst.statusLineSettings(home, file, { remove: true }).status, "removed");
  assert.deepEqual(readJson(file), {});
  const text = JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } }) + "\n";
  fs.writeFileSync(file, text);
  assert.equal(inst.statusLineSettings(home, file, { remove: true }).status, "absent");
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

test("statusLine: 모드를 지우고 다시 설치해도 체인 파일이 설정 옆에 남아 원래 상태 줄을 잃지 않는다", () => {
  const { home, dir, file } = slEnv();
  const orig = { type: "command", command: "my-line.sh" };
  fs.writeFileSync(file, JSON.stringify({ statusLine: orig }) + "\n");
  inst.statusLineSettings(home, file, { wrap: true });
  quiet(() => inst.removeMods(home, ["usage-status"]));
  assert.deepEqual(readJson(path.join(dir, inst.CHAIN_FILE)), { original: orig });
  assert.equal(inst.statusLineSettings(home, file, { remove: true }).status, "removed"); // 스크립트가 없어도 뺄 수 있다
  assert.deepEqual(readJson(file), { statusLine: orig });
});

test("statusLine: 깨진 JSON·객체가 아닌 최상위는 건드리지 않는다", () => {
  const { home, dir, file } = slEnv();
  for (const text of ["{oops", "[1,2]"]) {
    fs.writeFileSync(file, text);
    assert.equal(inst.statusLineSettings(home, file).status, "invalid");
    assert.equal(fs.readFileSync(file, "utf8"), text);
    assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
  }
});

test("statusLine: 기록기 스크립트가 없으면(usage-status 미설치) 설정을 건드리지 않는다", () => {
  const home = tmp("herdr-home-");
  const file = path.join(tmp("herdr-claude-"), "settings.json");
  const r = inst.statusLineSettings(home, file);
  assert.equal(r.status, "skipped");
  assert.equal(fs.existsSync(file), false);
});

test("statusLine: 우리 명령의 경로가 낡았으면(홈 이동 등) 같은 자리에서 고친다", () => {
  const { home, file, script } = slEnv();
  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: 'node "/old/home/mods/usage-status/usage-writer.cjs"', padding: 1 } }) + "\n");
  assert.equal(inst.statusLineSettings(home, file).status, "installed");
  const s = readJson(file);
  assert.equal(s.statusLine.command, `node "${fwd(script)}"`);
  assert.equal(s.statusLine.padding, 1);
});

test("CLI: mods --statusline은 usage-status를 복사하고 임시 설정에 등록한다(--settings로 진짜 설정을 피한다)", () => {
  const home = tmp("herdr-home-");
  const file = path.join(tmp("herdr-claude-"), "settings.json");
  const r = spawnSync(process.execPath, [INSTALL, "mods", "--home", home, "--only", "usage-status", "--statusline", "--settings", file], { encoding: "utf8", env: { ...process.env, HOME: tmp(), USERPROFILE: tmp() } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(inst.isOurStatusLine(readJson(file).statusLine));
});

test("CLI: --statusline 없이 usage-status만 설치하면 설정은 그대로이고 안내만 나온다", () => {
  const home = tmp("herdr-home-");
  const fakeHome = tmp();
  const r = spawnSync(process.execPath, [INSTALL, "mods", "--home", home, "--only", "usage-status"], { encoding: "utf8", env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "settings.json")), false);
  assert.match(r.stdout, /--statusline/);
});

test("CLI: --wrap과 --remove는 함께 쓸 수 없다", () => {
  assert.throws(() => inst.parseArgs(["statusline", "--home", "x", "--wrap", "--remove"]), /함께/);
});
