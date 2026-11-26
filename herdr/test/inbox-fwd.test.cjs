// #82: a {kind:"fwd"} line in the PO's file says which prompt of the person was forwarded to which agent; parsePoLines joins it to the `me` line.
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../mods/inbox/inbox.cjs");

const me = (text, pid, ts = "2026-01-01T09:00:00Z") => ({ ts, kind: "me", text, src: "hook", pid });
const fwd = (to, pid, extra = {}) => ({ ts: "2026-01-01T09:01:00Z", kind: "fwd", to, pid, ...extra });
const parse = (...lines) => I.parsePoLines(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));

test("fwd 줄은 같은 pid의 me 줄에 fwd: [{to, exact}]로 붙고, 자기 줄은 목록에 남지 않는다", () => {
  const out = parse(me("배포 막아 줘", "p1"), fwd("lead-demo", "p1", { h: I.fwdHash("배포 막아 줘") }));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].fwd, [{ to: "lead-demo", exact: true }]);
  assert.equal(out[0].me, true);
  assert.equal(out[0].pid, "p1");
  assert.equal(out[0].whole, undefined); // the helper field never leaves the parser
});

test("PO가 고치거나 요약해서 보냈어도 pid로 이어지고 exact만 false가 된다", () => {
  const out = parse(me("배포 막아 줘, 이유는 어제 장애 때문", "p1"), fwd("lead-demo", "p1", { h: I.fwdHash("배포를 멈추세요") }));
  assert.deepEqual(out[0].fwd, [{ to: "lead-demo", exact: false }]);
  const noHash = parse(me("가", "p1"), fwd("lead-demo", "p1"));
  assert.deepEqual(noHash[0].fwd, [{ to: "lead-demo", exact: false }]); // h is optional
});

test("공백·줄바꿈만 다른 글은 같은 글로 보고, me 줄의 <hc/pasted> 껍질은 벗기고 비교한다(exact)", () => {
  assert.equal(I.fwdHash("a  b\n c"), I.fwdHash(" a b c "));
  const out = parse(me("가  나\n다", "p1"), fwd("lead-demo", "p1", { h: I.fwdHash("가 나 다") }));
  assert.equal(out[0].fwd[0].exact, true);
  const wrapped = parse(me('<pasted_content id="x">긴 글</pasted_content>', "p2"), fwd("lead-demo", "p2", { h: I.fwdHash("긴 글") }));
  assert.equal(wrapped[0].fwd[0].exact, true);
});

test("해시는 ASCII 공백(스페이스·탭·CR·LF)만 접고, NBSP·U+3000은 접지도 자르지도 않는다 (셸 도우미와 바이트 단위로 맞추기 위함)", () => {
  // contract §4 sample pair: printf '배포는 내일 합니다.' | shasum -a 256 | cut -c1-16
  assert.equal(I.fwdHash("배포는 내일 합니다."), "31006470c1510a5e");
  assert.equal(I.fwdHash("  배포는  내일\r\n합니다. \t"), "31006470c1510a5e");
  assert.equal(I.fwdHash("a b"), "c8687a08aa5d6ed2");
  assert.equal(I.fwdHash("a\u00a0b"), "9507017c6d887511");
  assert.equal(I.fwdHash("a\u3000b"), "a59e41483057a662");
  assert.equal(I.fwdHash("\u00a0a b\u3000"), "af90782fa2429a07"); // the ends are not cut either
  assert.notEqual(I.fwdHash("a\u00a0b"), I.fwdHash("a b"));
  assert.match(I.fwdHash("x"), /^[0-9a-f]{16}$/);
});

test("한 말을 여러 리더에게 보내면 리더마다 한 번씩, 같은 리더에게 다시 보내도 한 번만 센다", () => {
  const out = parse(me("공지", "p1"), fwd("lead-a", "p1"), fwd("lead-b", "p1"), fwd("lead-a", "p1"));
  assert.deepEqual(out[0].fwd.map((f) => f.to), ["lead-a", "lead-b"]);
});

test("전달하지 않은 말에는 fwd가 없다(다른 pid의 fwd는 붙지 않는다)", () => {
  const out = parse(me("보낸 말", "p1"), me("안 보낸 말", "p2"), fwd("lead-a", "p1"));
  assert.ok(out.find((x) => x.pid === "p1").fwd);
  assert.equal(out.find((x) => x.pid === "p2").fwd, undefined);
});

test("글이 같아도 pid가 없거나 다르면 잇지 않는다(글자로 짐작하지 않는다)", () => {
  const out = parse(me("같은 글", "p1"), fwd("lead-a", "other"), fwd("lead-a", ""), { ts: "2026-01-01T09:02:00Z", kind: "fwd", to: "lead-a" });
  assert.equal(out[0].fwd, undefined);
  const noPid = parse({ ts: "2026-01-01T09:00:00Z", kind: "me", text: "pid 없음" }, fwd("lead-a", ""));
  assert.equal(noPid[0].fwd, undefined);
});

test("에이전트 이름 규칙 밖의 to, 이름이 아닌 값, me 줄이 없는 fwd는 버린다", () => {
  const out = parse(me("글", "p1"), fwd("po", "p1"), fwd("LEAD-X", "p1"), fwd("../x", "p1"), { ts: "2026-01-01T09:01:00Z", kind: "fwd", to: 5, pid: "p1" }, fwd("lead-a", "none"));
  assert.equal(out.length, 1);
  assert.equal(out[0].fwd, undefined);
});

test("깨진 줄과 알 수 없는 종류가 섞여도 나머지는 읽는다, 말(say) 줄은 영향이 없다", () => {
  const out = parse("{깨짐", me("글", "p1"), '{"kind":"zzz"}', fwd("lead-a", "p1", { h: 5 }), { ts: "2026-01-01T09:05:00Z", kind: "say", text: "답", to: "lead-a" });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].fwd, [{ to: "lead-a", exact: false }]); // a non-string h is ignored
  assert.equal(out[1].fwd, undefined);
  assert.equal(out[1].to, "lead-a");
});

test("프로필이 에이전트 이름 규칙을 바꾸면 fwd의 to도 그 규칙을 따른다", () => {
  try {
    I.setNames({ agentName: "^bot-[a-z0-9_-]+$" });
    const out = parse(me("글", "p1"), fwd("bot-x", "p1"), fwd("lead-a", "p1"));
    assert.deepEqual(out[0].fwd, [{ to: "bot-x", exact: false }]);
  } finally {
    I.setNames(null);
  }
});

test("fwd 줄이 없는 옛 파일은 지금과 똑같이 읽힌다", () => {
  const out = parse(me("글", "p1"), { ts: "2026-01-01T09:02:00Z", kind: "say", text: "답" });
  assert.equal(out.length, 2);
  assert.equal("fwd" in out[0], false);
});
