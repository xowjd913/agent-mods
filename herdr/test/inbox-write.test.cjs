// herdr/tools/inbox-write.cjs 단위 테스트: node --test herdr/test/inbox-write.test.cjs
// 쓰기 도구가 만든 줄을 inbox 리더(inbox.cjs)가 그대로 받아들이는지 확인한다.
const test = require("node:test");
const POSIX = process.platform !== "win32"; // Windows has no POSIX file modes: only the mode asserts are skipped there
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const I = require("../mods/inbox/inbox.cjs");
const W = require("../tools/inbox-write.cjs");

const TOOL = path.join(__dirname, "..", "tools", "inbox-write.cjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "inbox-write-"));
// An environment with no hc lookups: every identity comes from flags, so tests never touch a real hc.
const envOf = (dir, extra = {}) => ({ HERDR_INBOX_DIR: dir, ...extra });
const noHc = () => null;
const P = W.loadProfile({ HERDR_INBOX_DIR: os.tmpdir() + "/inbox-write-no-profile" }); // the built-in default profile
const read = (file) => fs.readFileSync(file, "utf8");

test("report 줄은 리더 파일에 한 줄로 붙고 parseLines가 그대로 읽는다", () => {
  const dir = tmp();
  const r = W.run(["report", "--kind", "start", "--leader", "lead-demo", "--terminal", "t9", "--title", "[lead-demo] 시작", "--body", "첫 줄\n둘째 줄", "--link", "https://example.com/issues/1", "--no-label"], envOf(dir), noHc);
  assert.equal(r.code, 0, r.err);
  const text = read(path.join(dir, "lead-demo.jsonl"));
  assert.equal(text.split("\n").length, 2); // 한 줄 + 끝의 빈 조각
  const [it] = I.parseLines(text);
  assert.equal(it.kind, "start");
  assert.equal(it.leader, "lead-demo");
  assert.equal(it.terminal, "t9");
  assert.equal(it.title, "[lead-demo] 시작");
  assert.equal(it.body, "첫 줄\n둘째 줄");
  assert.equal(it.link, "https://example.com/issues/1");
  assert.ok(it.ts && it.ms > 0);
  assert.equal(JSON.parse(text).v, 1);
});

test("종류가 허용 목록에 없으면 아무것도 쓰지 않고 2로 끝난다", () => {
  const dir = tmp();
  for (const kind of ["answered", "weird", undefined]) {
    const args = ["report", "--leader", "lead-demo", "--no-label"];
    if (kind) args.push("--kind", kind);
    const r = W.run(args, envOf(dir), noHc);
    assert.equal(r.code, 2);
  }
  assert.equal(fs.existsSync(path.join(dir, "lead-demo.jsonl")), false);
});

test("리더 이름이 lead-로 시작하지 않으면 1로 끝나고 파일 이름으로 쓰지 않는다", () => {
  const dir = tmp();
  for (const leader of ["demo", "lead-", "lead-A", "../lead-x", "lead-a/b"]) {
    const r = W.run(["report", "--kind", "done", "--leader", leader, "--no-label"], envOf(dir), noHc);
    assert.equal(r.code, 1, leader);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("리더 이름은 --leader, HERDR_INBOX_LEADER, hc get 순서로 정한다", () => {
  const dir = tmp();
  const hc = (id) => (id === "t5" ? { name: "lead-from-hc", parent: "t1" } : id === "t1" ? { labels: { role: "po", po: "main" } } : null);
  const fromFlag = W.reportRecord(P, { kind: "done", agent: "lead-flag", terminal: "t5" }, envOf(dir, { HERDR_INBOX_LEADER: "lead-env" }), hc);
  assert.equal(fromFlag.record.leader, "lead-flag");
  const fromEnv = W.reportRecord(P, { kind: "done", terminal: "t5" }, envOf(dir, { HERDR_INBOX_LEADER: "lead-env" }), hc);
  assert.equal(fromEnv.record.leader, "lead-env");
  const fromHc = W.reportRecord(P, { kind: "done", terminal: "t5" }, envOf(dir), hc);
  assert.equal(fromHc.record.leader, "lead-from-hc");
  assert.equal(fromHc.record.po, "main"); // 부모 터미널의 po 라벨
  assert.equal(I.parseLines(JSON.stringify(fromHc.record))[0].po, "main");
  const noRole = (id) => (id === "t5" ? { name: "lead-x", parent: "t1" } : { labels: { po: "main" } }); // a parent without role=po is not a hub
  assert.equal(W.reportRecord(P, { kind: "done", terminal: "t5" }, envOf(dir), noRole).record.po, undefined);
});

test("HC_TERMINAL_ID를 터미널 번호로 쓰고, 제목을 안 주면 [리더] 종류로 채운다", () => {
  const dir = tmp();
  const r = W.reportRecord(P, { kind: "done", agent: "lead-x", hub: "main" }, envOf(dir, { HC_TERMINAL_ID: "t42" }), noHc);
  assert.equal(r.record.terminal, "t42");
  assert.equal(r.record.title, "[lead-x] done");
  assert.equal(r.record.po, "main");
});

test("decision 본문의 N안·추천 줄을 리더가 그대로 선택지로 읽는다", () => {
  const dir = tmp();
  const body = "어느 쪽으로 갈까요?\n1안: 지금 병합\n2안: 리뷰 후 병합\n3안: 보류\n추천: 2안";
  const r = W.run(["report", "--kind", "decision", "--leader", "lead-demo", "--body", body, "--link", "https://example.com/pull/2", "--no-label"], envOf(dir), noHc);
  assert.equal(r.code, 0, r.err);
  const [it] = I.parseLines(read(path.join(dir, "lead-demo.jsonl")));
  assert.deepEqual(I.decisionOptions(it.body), { options: [1, 2, 3], recommended: 2 });
});

test("decision은 answered가 오기 전까지 열려 있고, answered 뒤에 닫힌다", () => {
  const dir = tmp();
  const file = path.join(dir, "lead-demo.jsonl");
  W.run(["report", "--kind", "decision", "--leader", "lead-demo", "--body", "1안: a\n2안: b", "--no-label"], envOf(dir), noHc);
  assert.equal(I.summarize("lead-demo", read(file)).open.kind, "decision");
  const r = W.run(["answered", "--leader", "lead-demo", "--of", "decision", "--no-label"], envOf(dir), noHc);
  assert.equal(r.code, 0, r.err);
  const items = I.parseLines(read(file));
  assert.deepEqual(items.map((x) => x.kind), ["decision", "answered"]);
  assert.equal(items[1].body, "decision");
  assert.equal(I.summarize("lead-demo", read(file)).open, null);
});

test("--of 없는 answered는 본문이 비고, 리더는 가장 새 열린 확인을 닫는다", () => {
  const dir = tmp();
  const file = path.join(dir, "lead-demo.jsonl");
  W.run(["report", "--kind", "verify", "--leader", "lead-demo", "--no-label"], envOf(dir), noHc);
  W.run(["answered", "--leader", "lead-demo", "--no-label"], envOf(dir), noHc);
  const items = I.parseLines(read(file));
  assert.equal(items[1].body, "");
  assert.equal(I.summarize("lead-demo", read(file)).open, null);
});

test("answered는 이 터미널의 wait 라벨에서 종류와 링크를 가져온다", () => {
  const hc = (id) => (id === "t7" ? { name: "lead-demo", labels: { wait: "verify", "wait-link": "https://example.com/pull/3" } } : null);
  const r = W.answeredRecord(P, { hub: "main" }, envOf(tmp(), { HC_TERMINAL_ID: "t7" }), hc);
  assert.equal(r.record.body, "verify");
  assert.equal(r.record.link, "https://example.com/pull/3");
  const bad = () => W.answeredRecord(P, { of: "weird", agent: "lead-demo" }, envOf(tmp()), noHc);
  assert.throws(bad, /--of must be/);
});

test("decision·verify는 wait 라벨을 달고 answered는 지운다, 그 밖의 종류는 라벨이 없다", () => {
  assert.deepEqual(W.labelArgs(P, { kind: "decision", link: "u" }), ["wait=decision", "wait-link=u"]);
  assert.deepEqual(W.labelArgs(P, { kind: "verify", link: "" }), ["wait=verify", "wait-link="]);
  assert.deepEqual(W.labelArgs(P, { kind: "answered" }), ["wait=", "wait-link="]);
  for (const kind of ["start", "done", "stop", "resume", "other"]) assert.equal(W.labelArgs(P, { kind }), null);
});

test("줄을 이어 붙이면 파일은 줄마다 JSON이고, 쓰다 만 마지막 줄 뒤에서도 새 줄이 온전하다", () => {
  const dir = tmp();
  const file = path.join(dir, "lead-demo.jsonl");
  fs.writeFileSync(file, '{"v":1,"ts":"2026-01-01T00:00:00Z","kind":"do'); // 줄바꿈 없이 끊긴 줄
  W.run(["report", "--kind", "done", "--leader", "lead-demo", "--title", "새 줄", "--no-label"], envOf(dir), noHc);
  W.run(["report", "--kind", "other", "--leader", "lead-demo", "--title", "또 한 줄", "--no-label"], envOf(dir), noHc);
  const items = I.parseLines(read(file));
  assert.deepEqual(items.map((x) => x.title), ["새 줄", "또 한 줄"]);
});

test("따옴표·줄바꿈·이모지가 든 본문도 한 줄 JSON으로 왕복한다", () => {
  const dir = tmp();
  const body = '"따옴표"와 \\역슬래시, 탭\t, 이모지 😀\r\n둘째 줄';
  W.run(["report", "--kind", "done", "--leader", "lead-demo", "--body", body, "--no-label"], envOf(dir), noHc);
  const text = read(path.join(dir, "lead-demo.jsonl"));
  assert.equal(text.trimEnd().split("\n").length, 1);
  assert.equal(I.parseLines(text)[0].body, '"따옴표"와 \\역슬래시, 탭\t, 이모지 😀\n둘째 줄');
});

test("--file로 본문을 읽고, 없는 파일이면 2로 끝난다", () => {
  const dir = tmp();
  const body = path.join(dir, "body.txt");
  fs.writeFileSync(body, "\n\n파일에서 온 본문\n\n");
  const ok = W.run(["report", "--kind", "done", "--leader", "lead-demo", "--file", body, "--no-label"], envOf(dir), noHc);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(I.parseLines(read(path.join(dir, "lead-demo.jsonl")))[0].body, "파일에서 온 본문");
  const miss = W.run(["report", "--kind", "done", "--leader", "lead-demo", "--file", path.join(dir, "nope.txt"), "--no-label"], envOf(dir), noHc);
  assert.equal(miss.code, 2);
});

test("say 줄은 po/<id>.jsonl에 붙고 parsePoLines가 그대로 읽는다", () => {
  const dir = tmp();
  const r = W.run(["say", "--po", "main", "--text", "안녕하세요\n두 번째 줄", "--to", "lead-demo"], envOf(dir), noHc);
  assert.equal(r.code, 0, r.err);
  const file = path.join(dir, "po", "main.jsonl");
  const [m] = I.parsePoLines(read(file));
  assert.equal(m.text, "안녕하세요\n두 번째 줄");
  assert.equal(m.to, "lead-demo");
  assert.equal(JSON.parse(read(file)).v, undefined); // PO 줄에는 v 필드가 없다
  const none = W.run(["say", "--po", "main", "--text", "받는 사람 없음"], envOf(dir), noHc);
  assert.equal(none.code, 0);
  assert.equal(I.parsePoLines(read(file)).at(-1).to, "");
});

test("say는 잘못된 PO id·받는 사람·빈 글·너무 긴 글을 쓰지 않는다", () => {
  const dir = tmp();
  const cases = [
    [["say", "--po", "Main", "--text", "x"], 1],
    [["say", "--po", "../x", "--text", "x"], 1],
    [["say", "--po", "a".repeat(41), "--text", "x"], 1],
    [["say", "--text", "x"], 1],
    [["say", "--po", "main", "--text", "x", "--to", "demo"], 1],
    [["say", "--po", "main", "--text", "  \n "], 2],
    [["say", "--po", "main", "--text", "가".repeat(2001)], 2],
  ];
  for (const [args, code] of cases) assert.equal(W.run(args, envOf(dir), noHc).code, code, args.join(" "));
  assert.equal(fs.existsSync(path.join(dir, "po")), false);
  assert.equal(W.run(["say", "--po", "main", "--text", "가".repeat(2000)], envOf(dir), noHc).code, 0); // 경계값은 통과
});

test("HERDR_INBOX_DIR이 없으면 홈의 .herdr-inbox를 쓴다", () => {
  assert.equal(W.inboxDir({ HERDR_INBOX_DIR: "/x/y" }), "/x/y");
  assert.equal(W.inboxDir({}), path.join(os.homedir(), ".herdr-inbox"));
});

test("알 수 없는 명령·옵션은 1로 끝나고 아무것도 쓰지 않는다", () => {
  const dir = tmp();
  for (const args of [[], ["nope"], ["report", "--bogus", "x"], ["report", "stray"], ["report", "--kind"]]) {
    assert.equal(W.run(args, envOf(dir), noHc).code, 1, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(W.run(["--help"], envOf(dir), noHc).code, 0);
});

test("POSIX에서는 새 파일이 0600, 새 폴더가 0700이다", { skip: !POSIX }, () => {
  const dir = path.join(tmp(), "inbox");
  W.run(["say", "--po", "main", "--text", "x"], envOf(dir), noHc);
  assert.equal(fs.statSync(path.join(dir, "po", "main.jsonl")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "po")).mode & 0o777, 0o700);
});

test("명령줄로 실행해도 같은 결과가 나온다 (종료 코드·표준 오류·환경 변수)", () => {
  const dir = tmp();
  const env = { ...process.env, HERDR_INBOX_DIR: dir, HERDR_INBOX_LEADER: "lead-cli" };
  delete env.HC_TERMINAL_ID;
  const ok = spawnSync(process.execPath, [TOOL, "report", "--kind", "done", "--title", "CLI", "--no-label"], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(I.parseLines(read(path.join(dir, "lead-cli.jsonl")))[0].title, "CLI");
  const bad = spawnSync(process.execPath, [TOOL, "report", "--kind", "weird"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--kind must be/);
});

// ---- profile: names and labels come from a profile file, the default is today's behavior

const profileEnv = (dir, profile) => {
  const file = path.join(dir, "profile.json");
  fs.writeFileSync(file, typeof profile === "string" ? profile : JSON.stringify(profile));
  return envOf(dir);
};

test("프로필 파일이 없으면 기본 프로필(lead-*, role=po)이다", () => {
  const p = W.loadProfile(envOf(tmp()));
  assert.ok(p.agentName.test("lead-x") && !p.agentName.test("agent-x"));
  assert.equal(p.hubRole, "po");
  assert.equal(p.hubDir, "po");
  assert.deepEqual([p.labelRole, p.labelWait, p.labelWaitLink], ["role", "wait", "wait-link"]);
});

test("lead-*·role=po가 아닌 프로필로도 보고·답·말하기가 끝까지 돈다", () => {
  const dir = tmp();
  const env = profileEnv(dir, { v: 1, agent: { name: "^bot-[a-z0-9]+$" }, hub: { role: "desk", idLabel: "room", id: "^[a-z0-9]{1,12}$", dir: "rooms" }, labels: { wait: "needs", waitLink: "needs-url" }, kinds: { question: "decision", review: "verify" } });
  const P2 = W.loadProfile(env);
  // lead-x는 이제 에이전트 이름이 아니고, bot-x는 맞다
  assert.equal(W.run(["report", "--kind", "done", "--agent", "lead-x", "--no-label"], env, noHc).code, 1);
  const r = W.run(["report", "--kind", "question", "--agent", "bot-x", "--hub", "team1", "--body", "1안: a\n2안: b\n추천: 1안", "--link", "https://example.com/1", "--no-label"], env, noHc);
  assert.equal(r.code, 0, r.err);
  const file = path.join(dir, "bot-x.jsonl");
  const [it] = I.parseLines(read(file));
  assert.equal(it.kind, "decision"); // 별칭은 계약 종류로 바뀌어 파일에 적힌다
  assert.equal(it.leader, "bot-x");
  assert.equal(it.po, "team1");
  assert.deepEqual(I.decisionOptions(it.body), { options: [1, 2], recommended: 1 });
  assert.equal(I.summarize("bot-x", read(file)).open.kind, "decision");
  assert.deepEqual(W.labelArgs(P2, it), ["needs=decision", "needs-url=https://example.com/1"]);
  assert.deepEqual(W.labelArgs(P2, { kind: "answered" }), ["needs=", "needs-url="]);
  // 답: 라벨 이름이 프로필의 것이면 hc get에서 종류·링크를 읽는다
  const hc = (id) => (id === "t3" ? { name: "bot-x", labels: { needs: "decision", "needs-url": "https://example.com/1" } } : null);
  const a = W.answeredRecord(P2, { hub: "team1" }, { ...env, HC_TERMINAL_ID: "t3" }, hc);
  assert.equal(a.record.body, "decision");
  assert.equal(W.run(["answered", "--agent", "bot-x", "--of", "decision", "--no-label"], env, noHc).code, 0);
  assert.equal(I.summarize("bot-x", read(file)).open, null);
  // 말하기: 프로필의 허브 폴더와 id 규칙
  assert.equal(W.run(["say", "--hub", "team1", "--text", "안녕", "--to", "bot-x"], env, noHc).code, 0);
  assert.equal(I.parsePoLines(read(path.join(dir, "rooms", "team1.jsonl")))[0].to, "bot-x");
  assert.equal(W.run(["say", "--hub", "Team-1", "--text", "x"], env, noHc).code, 1); // id 규칙 위반
  assert.equal(fs.existsSync(path.join(dir, "po")), false);
});

test("프로필의 허브 역할 라벨이 맞는 부모만 허브로 인정한다", () => {
  const dir = tmp();
  const env = profileEnv(dir, { hub: { role: "desk", idLabel: "room" }, labels: { role: "kind" } });
  const P2 = W.loadProfile(env);
  const hc = (id) => (id === "t5" ? { name: "lead-x", parent: "t1" } : { labels: { kind: "desk", room: "main" } });
  assert.equal(W.reportRecord(P2, { kind: "done", terminal: "t5" }, env, hc).record.po, "main");
  const wrong = (id) => (id === "t5" ? { name: "lead-x", parent: "t1" } : { labels: { kind: "po", room: "main" } });
  assert.equal(W.reportRecord(P2, { kind: "done", terminal: "t5" }, env, wrong).record.po, undefined);
});

test("프로필이 깨졌거나 위험하면 1로 끝나고 기본값으로 조용히 넘어가지 않는다", () => {
  const bad = [
    "{not json",
    "[]",
    JSON.stringify({ v: 2 }),
    JSON.stringify({ agent: { name: "(" } }),
    JSON.stringify({ hub: { dir: "../x" } }),
    JSON.stringify({ hub: { dir: "a/b" } }),
    JSON.stringify({ labels: { wait: "a b" } }),
    JSON.stringify({ kinds: { ask: "answered" } }),
    JSON.stringify({ kinds: { done: "decision" } }),
  ];
  for (const profile of bad) {
    const dir = tmp();
    const env = profileEnv(dir, profile);
    const r = W.run(["report", "--kind", "done", "--agent", "lead-x", "--no-label"], env, noHc);
    assert.equal(r.code, 1, profile);
    assert.deepEqual(fs.readdirSync(dir), ["profile.json"], profile);
  }
  const missing = W.run(["report", "--kind", "done", "--agent", "lead-x"], envOf(tmp(), { HERDR_INBOX_PROFILE: path.join(tmp(), "none.json") }), noHc);
  assert.equal(missing.code, 1); // HERDR_INBOX_PROFILE로 지정한 파일은 없으면 오류
});

test("프로필이 에이전트 이름 규칙을 풀어도 파일 이름으로 안전하지 않은 이름은 막는다", () => {
  const dir = tmp();
  const env = profileEnv(dir, { agent: { name: ".*" } });
  for (const agent of ["../x", "a/b", ".hidden", "a\\b", "x".repeat(65)]) {
    assert.equal(W.run(["report", "--kind", "done", "--agent", agent, "--no-label"], env, noHc).code, 1, agent);
  }
  assert.equal(W.run(["report", "--kind", "done", "--agent", "any.agent_1", "--no-label"], env, noHc).code, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["any.agent_1.jsonl", "profile.json"]);
});

test("--leader·--po와 HERDR_INBOX_LEADER는 --agent·--hub·HERDR_INBOX_AGENT와 같다", () => {
  const dir = tmp();
  assert.equal(W.run(["report", "--kind", "done", "--leader", "lead-a", "--po", "main", "--no-label"], envOf(dir), noHc).code, 0);
  assert.equal(W.run(["report", "--kind", "done", "--agent", "lead-b", "--hub", "main", "--no-label"], envOf(dir), noHc).code, 0);
  assert.equal(W.run(["report", "--kind", "done", "--no-label"], envOf(dir, { HERDR_INBOX_AGENT: "lead-c" }), noHc).code, 0);
  assert.equal(I.parseLines(read(path.join(dir, "lead-a.jsonl")))[0].po, "main");
  assert.equal(I.parseLines(read(path.join(dir, "lead-b.jsonl")))[0].po, "main");
  assert.ok(fs.existsSync(path.join(dir, "lead-c.jsonl")));
});
