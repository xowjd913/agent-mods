// 설정 창 규칙 칸의 프로필 도우미(settings/rules.cjs, #126): node --test herdr/test/rules.test.cjs
// 진짜 ~/.claude 나 진짜 받은편지함 프로필은 건드리지 않는다: 모든 시험은 임시 HOME·HERDR_INBOX_DIR·HERDR_INBOX_PROFILE만 쓴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const P = require("../mods/inbox/profile.cjs");
const R = require("../mods/settings/rules.cjs");
const SCRIPT = path.join(__dirname, "..", "mods", "settings", "rules.cjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));

function env({ script = false, profile = null, viaEnv = false } = {}) {
  const home = tmp(), inbox = tmp();
  if (script) {
    const f = path.join(home, ".claude", "skills", "leader", "herdr-team.sh");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "#!/bin/sh\n");
  }
  const file = path.join(inbox, "profile.json");
  if (profile !== null) fs.writeFileSync(file, typeof profile === "string" ? profile : JSON.stringify(profile));
  const e = { HOME: home, USERPROFILE: home, HERDR_INBOX_DIR: inbox };
  if (viaEnv) e.HERDR_INBOX_PROFILE = file;
  return { e, file, inbox, home };
}
// The real command line, the way the settings window runs it through herdr exec.
function cli(e, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...e }, encoding: "utf8" });
  const line = r.stdout.trim().split("\n").pop();
  return { code: r.status, out: JSON.parse(line) };
}
const set = (e, patch) => cli(e, "set", encodeURIComponent(JSON.stringify(patch)));
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("show: 파일이 없으면 PO 배치 스크립트 유무로 규칙을 정하고 이유를 알려 준다", () => {
  const none = cli(env().e, "show").out;
  assert.equal(none.ok, true);
  assert.equal(none.exists, false);
  assert.equal(none.preset, "none");
  assert.equal(none.why, "no-script");
  assert.equal(none.names.preset, "none");
  const po = cli(env({ script: true }).e, "show").out;
  assert.equal(po.preset, "po");
  assert.equal(po.why, "script");
  assert.equal(po.fields.arrangeScript, P.PO_ARRANGE_SCRIPT);
  assert.equal(po.arrangeScriptExists, true);
});

test("show: 파일의 preset이 이기고, preset 없는 파일은 po다", () => {
  assert.deepEqual([cli(env({ script: true, profile: { preset: "none" } }).e, "show").out].map((o) => [o.preset, o.why]), [["none", "file"]]);
  assert.deepEqual([cli(env({ profile: { v: 1 } }).e, "show").out].map((o) => [o.preset, o.why]), [["po", "file-default"]]);
});

test("show: HERDR_INBOX_PROFILE이 있으면 그 파일을 쓰고 source가 env다", () => {
  const x = env({ profile: { preset: "none" }, viaEnv: true });
  const o = cli(x.e, "show").out;
  assert.equal(o.source, "env");
  assert.equal(o.file, x.file);
  assert.equal(o.preset, "none");
});

test("set: 새 파일을 만들고(v:1, preset), 기본값과 같은 칸은 적지 않으며, 이름 규칙이 바로 바뀐다", () => {
  const x = env();
  const r = set(x.e, { preset: "none", fields: { "agent.name": "(?!)", "agent.role": "", "agent.titlePrefix": "", "agent.strip": "", "hub.role": "", "hub.id": "(?!)", arrangeScript: "" } });
  assert.equal(r.out.saved, true);
  assert.deepEqual(json(x.file), { preset: "none", v: 1 });
  assert.equal(fs.existsSync(`${x.file}.bak`), false, "처음 저장에는 백업할 옛 파일이 없다");
  assert.equal(r.out.preset, "none");
  assert.equal(r.out.why, "file");
  assert.equal(P.loadProfile(x.e).preset, "none");
});

test("set: 값을 바꾸면 적고, 모르는 키는 그대로 두고, 옛 파일은 .bak으로 남긴다", () => {
  const old = { v: 1, preset: "po", kinds: { question: "decision" }, someFutureKey: { a: 1 }, agent: { titlePrefix: "리더 · " } };
  const x = env({ profile: old });
  const before = fs.readFileSync(x.file, "utf8");
  const r = set(x.e, { preset: "po", fields: { "agent.name": "^boss-", "agent.strip": "^boss-", arrangeScript: "  ~/bin/arrange.sh  " } });
  assert.equal(r.out.saved, true, JSON.stringify(r.out));
  const now = json(x.file);
  assert.equal(now.agent.name, "^boss-");
  assert.equal(now.agent.strip, "^boss-");
  assert.equal(now.arrangeScript, "~/bin/arrange.sh", "앞뒤 공백은 잘린다");
  assert.deepEqual(now.kinds, old.kinds);
  assert.deepEqual(now.someFutureKey, old.someFutureKey);
  assert.equal(now.agent.titlePrefix, "리더 · ", "보내지 않은 칸은 그대로");
  assert.equal(fs.readFileSync(`${x.file}.bak`, "utf8"), before);
  assert.equal(P.loadProfile(x.e).agentName.test("boss-x"), true);
  assert.deepEqual(fs.readdirSync(x.inbox).sort(), ["profile.json", "profile.json.bak"], "임시 파일이 남지 않는다");
});

test("set: 로더가 거절하는 값(잘못된 정규식, 모르는 칸, 글자 아닌 값, 너무 긴 값, 모르는 preset)은 파일을 그대로 둔다", () => {
  const x = env({ profile: { v: 1, preset: "po" } });
  const before = fs.readFileSync(x.file, "utf8");
  for (const patch of [
    { preset: "po", fields: { "agent.name": "(" } },
    { preset: "po", fields: { nope: "x" } },
    { preset: "po", fields: { "agent.name": 5 } },
    { preset: "po", fields: { "agent.name": "x".repeat(301) } },
    { preset: "bogus" },
  ]) {
    const r = set(x.e, patch);
    assert.equal(r.out.ok, false, JSON.stringify(patch));
    assert.ok(r.out.error, JSON.stringify(patch));
    assert.equal(fs.readFileSync(x.file, "utf8"), before, JSON.stringify(patch));
    assert.equal(fs.existsSync(`${x.file}.bak`), false);
    assert.deepEqual(fs.readdirSync(x.inbox), ["profile.json"], "임시 파일이 남지 않는다");
  }
});

test("깨진 JSON: show는 오류와 broken을 알리고, set은 덮어쓰지 않으며, reset은 .bak으로 옮긴다", () => {
  const x = env({ profile: "{ not json" });
  const shown = cli(x.e, "show").out;
  assert.equal(shown.broken, true);
  assert.ok(shown.error);
  const s = set(x.e, { preset: "none", fields: {} });
  assert.equal(s.out.ok, false);
  assert.match(s.out.error, /기본값으로 되돌린 뒤/);
  assert.equal(fs.readFileSync(x.file, "utf8"), "{ not json");
  const r = cli(x.e, "reset").out;
  assert.equal(r.reset, true);
  assert.equal(fs.existsSync(x.file), false);
  assert.equal(fs.readFileSync(`${x.file}.bak`, "utf8"), "{ not json");
  assert.equal(r.broken, false);
  assert.equal(r.exists, false);
  assert.equal(r.preset, "none", "파일이 없으면 스크립트 유무를 따른다");
});

test("모르는 preset이 든 파일은 오류를 보이되 고칠 수 있고, 저장하면 고쳐진다", () => {
  const x = env({ profile: { v: 1, preset: "weird" } });
  const o = cli(x.e, "show").out;
  assert.equal(o.broken, false);
  assert.ok(o.error);
  assert.equal(o.presetInFile, "weird");
  const r = set(x.e, { preset: "none", fields: {} });
  assert.equal(r.out.saved, true, JSON.stringify(r.out));
  assert.equal(json(x.file).preset, "none");
  assert.equal(r.out.error, null);
});

test("reset: 파일이 없으면 아무것도 하지 않고 성공이다. 되돌린 뒤 저장하면 새 파일이 생긴다", () => {
  const x = env();
  assert.equal(cli(x.e, "reset").out.reset, true);
  assert.deepEqual(fs.readdirSync(x.inbox), []);
  assert.equal(set(x.e, { preset: "po", fields: {} }).out.saved, true);
  assert.equal(json(x.file).preset, "po");
});

test("set 인자는 URL 인코딩이라 따옴표·공백·한글·백슬래시가 그대로 간다", () => {
  const x = env();
  const name = String.raw`^(lead|보스)-"a b"\d`;
  const r = set(x.e, { preset: "po", fields: { "agent.name": name } });
  assert.equal(r.out.saved, true, JSON.stringify(r.out));
  assert.equal(json(x.file).agent.name, name);
});

test("알 수 없는 명령과 잘못된 인자는 사용법·오류를 JSON 한 줄로 알린다", () => {
  const x = env();
  assert.equal(cli(x.e, "nope").out.ok, false);
  const bad = cli(x.e, "set", "%7Bnot").out;
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test("FIELDS는 설정 창이 그리는 칸과 같고, 기본값은 프리셋에서 온다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "settings", "main.js"), "utf8");
  const ids = [...src.match(/const RULE_FIELDS = \[[\s\S]*?\n\];/)[0].matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), Object.keys(R.FIELDS).sort());
  assert.equal(R.defaultsOf("po")["agent.name"], P.PRESETS.po.agent.name);
  assert.equal(R.defaultsOf("none")["hub.role"], "");
  assert.equal(R.defaultsOf("none").arrangeScript, "");
});

test("explainPreset: 파일 preset → 파일(preset 없음) → 스크립트 유무", () => {
  assert.deepEqual(P.explainPreset({ preset: "none" }, true, env({ script: true }).e), { preset: "none", why: "file" });
  assert.deepEqual(P.explainPreset({}, true, env().e), { preset: "po", why: "file-default" });
  assert.deepEqual(P.explainPreset({}, false, env({ script: true }).e), { preset: "po", why: "script" });
  assert.deepEqual(P.explainPreset({}, false, env().e), { preset: "none", why: "no-script" });
  assert.throws(() => P.explainPreset({ preset: "x" }, true, env().e), P.ProfileError);
  assert.equal(P.resolvePreset({}, false, env().e), "none");
});
