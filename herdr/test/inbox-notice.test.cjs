// #87: 완료·재개·중단 보고는 말풍선이 아니라 가운데 붉은 알림 줄이고, 같은 보고가 PO 훅에 <hc from=...>로 남은 복사본은 내 말풍선으로 나오지 않는다.
// 실제 앱에서 보이는 모습은 시험할 수 없다. 여기서는 글 규칙과 코드 모양만 시험한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const ms0 = Date.parse("2026-01-01T00:00:00Z");
const E = (kind, extra = {}) => ({ who: "l:lead-a", leader: "lead-a", it: { kind, title: "t" }, ...extra });

test("isNotice: done·resume·stop·start만 알림이고 결정·확인·기타 카드와 대기 항목은 아니다", () => {
  for (const k of ["done", "resume", "stop", "start"]) assert.equal(I.isNotice(E(k)), true, k);
  for (const k of ["decision", "verify", "other"]) assert.equal(I.isNotice(E(k)), false, k);
  assert.equal(I.isNotice(E("done", { waiting: "verify" })), false);
  assert.equal(I.isNotice(E("done", { wait: true })), false);
  assert.equal(I.isNotice({ who: "po", it: { kind: "done" } }), false);
  assert.equal(I.isNotice({ who: "l:a" }), false);
});

test("noticeText: 이름 · 종류 · 한 줄 요약, 비어 있는 칸은 건너뛴다", () => {
  assert.equal(I.noticeText("lead-a", "완료", { head: "설치  끝\n확인" }), "lead-a · 완료 · 설치 끝 확인");
  assert.equal(I.noticeText("lead-a", "중단", { lead: "막힘", title: "t" }), "lead-a · 중단 · 막힘");
  assert.equal(I.noticeText("lead-a", "재개", { title: "다시" }), "lead-a · 재개 · 다시");
  assert.equal(I.noticeText("lead-a", "재개", {}), "lead-a · 재개");
});

test("noticeText: 머리글이 종류 단어뿐이면 첫 본문 줄을 쓰고, 본문이 없으면 이름 · 종류만", () => {
  for (const w of ["재개", "완료", "멈춤"]) {
    assert.equal(I.noticeText("x", w, { title: `[x] ${w}`, body: "첫 줄\n둘째 줄" }), `x · ${w} · 첫 줄`);
    assert.equal(I.noticeText("x", w, { title: `[x] ${w}`, head: w, body: "\n  \n첫  줄\n둘째 줄" }), `x · ${w} · 첫 줄`, "enriched item, blank lines first");
    assert.equal(I.noticeText("x", w, { title: `[x] ${w}` }), `x · ${w}`);
    assert.equal(I.noticeText("x", w, { title: `[x] ${w}`, body: " \n\n" }), `x · ${w}`);
  }
  assert.equal(I.noticeText("x", "재개", { title: "[x] 재개 — 큐 이어서", body: "첫 줄" }), "x · 재개 · 재개 — 큐 이어서");
  assert.equal(I.noticeText("x", "완료", { title: "[x] 설치 끝", body: "첫 줄" }), "x · 완료 · 설치 끝");
  assert.equal(I.noticeText("x", "완료", { title: "재개", body: "첫 줄" }), "x · 완료 · 재개", "a different kind word is a real headline");
});

test("hcSender: <hc from=\"t1 lead-x\">의 마지막 낱말이 보낸 리더이고 일반 글은 빈 글이다", () => {
  assert.equal(I.hcSender('<hc from="t137 lead-po-inbox">[x] y</hc>'), "lead-po-inbox");
  assert.equal(I.hcSender('<hc from="lead-b">z'), "lead-b");
  assert.equal(I.hcSender("그냥 글"), "");
  assert.equal(I.hcSender(undefined), "");
});

const leaders = (ms = ms0) => [{ owner: "p1", s: { leader: "lead-a", items: [{ kind: "done", title: "[lead-a] 설치 완료", head: "설치 완료", ts: new Date(ms).toISOString(), ms }] } }];
const hook = (ms, from = "t1 lead-a", text = "[lead-a] 설치 완료: 확인해 주세요") => ({ ts: new Date(ms).toISOString(), ms, text: `<hc from="${from}">${text}</hc>`, me: true });
const meCount = (tl) => tl.filter((e) => e.who === "me").length;

test("timeline: 보고가 있으면 같은 리더의 <hc> 복사본은 내 말풍선으로 나오지 않는다", () => {
  const tl = I.timeline("p1", leaders(), [hook(ms0 + 2000)], [], [], ms0 + 9000);
  assert.equal(meCount(tl), 0);
  assert.equal(tl.length, 1);
});

test("timeline: 맞는 보고가 없거나 ±5분 밖이거나 다른 리더면 복사본이 그대로 남는다", () => {
  assert.equal(meCount(I.timeline("p1", [], [hook(ms0)], [], [], ms0 + 9000)), 1); // 보고 없음
  assert.equal(meCount(I.timeline("p1", leaders(), [hook(ms0 + 6 * 60000)], [], [], ms0 + 9e6)), 1); // 5분 밖
  assert.equal(meCount(I.timeline("p1", leaders(), [hook(ms0 + 1000, "t1 lead-b")], [], [], ms0 + 9000)), 1); // 다른 리더
});

test("timeline: 보고 하나는 복사본 한 줄만 덮고 두 번째 줄은 남는다", () => {
  const tl = I.timeline("p1", leaders(), [hook(ms0 + 1000), hook(ms0 + 2000)], [], [], ms0 + 9000);
  assert.equal(meCount(tl), 1);
});

test("timeline: 사람이 터미널에 직접 친 글은 <hc>가 아니므로 남는다", () => {
  const typed = { ts: new Date(ms0 + 1000).toISOString(), ms: ms0 + 1000, text: "직접 친 글", me: true };
  assert.equal(meCount(I.timeline("p1", leaders(), [typed], [], [], ms0 + 9000)), 1);
});

test("main.js: 알림 줄은 가운데 붉은 한 줄이고 눌러야 전체 보고가 아래에 열린다", () => {
  const i = MAIN.indexOf("if (isNotice(e)) {");
  assert.ok(i > 0);
  const blk = MAIN.slice(i, i + 1800);
  assert.match(blk, /justify_center\(\)/);
  assert.match(blk, /t\.blocked/);
  assert.match(blk, /noticeText\(shortName\(e\.leader\)/);
  assert.match(blk, /this\.toggleOpen\(e\.s, e\.it\)/);
  assert.match(blk, /\.when\(open, /);
  assert.match(blk, /this\.body\(t, e\.it, id\)/);
  assert.ok(MAIN.indexOf("const a = e.waiting ?") > i); // 알림은 대기 처리보다 앞에서 갈라진다
});

test("timeline: 같은 리더가 보고 근처에 보낸 다른 내용의 <hc> 글(질문 등)은 덮이지 않고 남는다", () => {
  const q = hook(ms0 + 60000, "t1 lead-a", "[lead-a] 질문: 배포 순서를 바꿔도 되나요?");
  const tl = I.timeline("p1", leaders(), [q], [], [], ms0 + 9e5);
  assert.equal(meCount(tl), 1);
  // 질문이 남아도 같은 보고의 복사본은 계속 덮인다
  assert.equal(meCount(I.timeline("p1", leaders(), [q, hook(ms0 + 2000)], [], [], ms0 + 9e5)), 1);
});

test("hcSame: 감싸개·[이름] 머리표·대소문자·공백을 무시하고 제목·머리줄·요약과 겹칠 때만 같은 보고다", () => {
  const it = { title: "[lead-a] 설치 완료", head: "설치 완료", lead: "inbox 모드를 깔았습니다" };
  assert.equal(I.hcSame('<hc from="t1 lead-a">[lead-a]  설치   완료: 확인</hc>', it), true);
  assert.equal(I.hcSame("INBOX 모드를 깔았습니다", it), true);
  assert.equal(I.hcSame("[lead-a] 다른 이야기", it), false);
  assert.equal(I.hcSame("네", it), false); // 너무 짧은 글은 겹침으로 치지 않는다
  assert.equal(I.hcSame("설치 완료", { title: "", head: "", lead: "" }), false);
});

test("noticeText: 본문 첫 줄을 대신 쓸 때 마크다운 기호(#, -, 1., >, **, `)를 벗긴다 (#147)", () => {
  const T = (body) => I.noticeText("x", "재개", { title: "[x] 재개", body });
  assert.equal(T("## 제목\n둘째"), "x · 재개 · 제목");
  assert.equal(T("- 항목\n둘째"), "x · 재개 · 항목");
  assert.equal(T("* 항목"), "x · 재개 · 항목");
  assert.equal(T("1. 첫째\n2. 둘째"), "x · 재개 · 첫째");
  assert.equal(T("> 인용"), "x · 재개 · 인용");
  assert.equal(T("> - 인용 속 항목"), "x · 재개 · 인용 속 항목");
  assert.equal(T("**굵게** 그리고 `코드`"), "x · 재개 · 굵게 그리고 코드");
  assert.equal(T("### **굵은 제목**"), "x · 재개 · 굵은 제목");
  assert.equal(T("---\n```\n## 진짜 첫 줄"), "x · 재개 · 진짜 첫 줄", "marker-only lines are skipped");
  assert.equal(T("##\n   \n- "), "x · 재개", "only markers -> no headline");
  assert.equal(T("2026-11-27 정리"), "x · 재개 · 2026-11-27 정리", "a dash or digit inside the text is kept");
  assert.equal(T("#태그 그대로"), "x · 재개 · #태그 그대로", "# without a space is text");
  assert.equal(T("snake_case와 a*b"), "x · 재개 · snake_case와 a*b");
  // nothing is taken off mid-line unless it is a pair around text (#147 review)
  assert.equal(T("__init__ 수정"), "x · 재개 · __init__ 수정");
  assert.equal(T("a ** b 계산"), "x · 재개 · a ** b 계산");
  assert.equal(T(">= 5 이면"), "x · 재개 · >= 5 이면");
  assert.equal(T("**a** and **b** 끝"), "x · 재개 · a and b 끝");
  assert.equal(T("`x` 와 ` y ` 와 `"), "x · 재개 · x 와 ` y ` 와 `");
  assert.equal(T("```js\n## 코드 안 제목"), "x · 재개 · 코드 안 제목", "a fence line is skipped whole, not shown as 'js'");
  assert.equal(T(">> 겹친 인용"), "x · 재개 · 겹친 인용");
});

test("noticeText: 머리글이 있으면 그대로 쓰고(마크다운 손대지 않음), inbox.cjs와 main.js의 noticeText 본문은 같다", () => {
  assert.equal(I.noticeText("x", "완료", { title: "[x] **굵은** 제목", body: "## 본문" }), "x · 완료 · **굵은** 제목");
  const fs = require("node:fs"), path = require("node:path");
  const pick = (f) => { const s = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", f), "utf8"); const a = s.indexOf("const noticePlain"); return s.slice(a, s.indexOf("\n};\n", s.indexOf("const noticeText", a)) + 4); };
  assert.equal(pick("main.js"), pick("inbox.cjs"));
});
