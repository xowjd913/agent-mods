// inbox.cjs 단위 테스트: node --test herdr/test/inbox.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const I = require("../mods/inbox/inbox.cjs");

const line = (o) => JSON.stringify({ v: 1, leader: "lead-a", terminal: "t1", title: "t", body: "b", link: "", ...o });
const text = (...os) => os.map(line).join("\n") + "\n";

test("알 수 없는 종류·깨진 줄·쓰다 만 마지막 줄은 건너뛰고, 모르는 필드는 무시한다", () => {
  const t = text({ ts: "2026-01-01T00:00:00Z", kind: "done", extra: 1 }, { ts: "2026-01-01T00:00:01Z", kind: "weird" }) + "not json\n" + '{"v":1,"ts":"2026-01-01T00:00:02Z","kind":"do';
  const items = I.parseLines(t);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "done");
  assert.equal(items[0].extra, undefined);
});

test("가장 새 결정·확인은 뒤에 answered가 오기 전까지 열려 있다", () => {
  const open = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "decision", body: "x" }, { ts: "2026-01-01T00:01:00Z", kind: "done" }));
  assert.equal(open.open.kind, "decision");
  const closed = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "verify" }, { ts: "2026-01-01T00:01:00Z", kind: "answered", body: "verify" }));
  assert.equal(closed.open, null);
  assert.equal(closed.ask.kind, "verify"); // 대기 라벨이 아직 있으면 패널은 마지막 보고를 보여 준다
});

test("보고는 가장 새 것이 앞이고 리더별 최대 개수를 넘지 않는다", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), kind: "other", body: String(i) }));
  const s = I.summarize("lead-a", text(...many));
  assert.equal(s.items.length, 40);
  assert.equal(s.items[0].body, "59");
  assert.equal(s.last.body, "59");
});

test("collect: 폴더의 .jsonl만 읽고 가장 최근 보고가 있는 리더가 먼저다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
  fs.writeFileSync(path.join(dir, "lead-a.jsonl"), text({ ts: "2026-01-01T00:00:00Z", kind: "done" }));
  fs.writeFileSync(path.join(dir, "lead-b.jsonl"), text({ leader: "lead-b", ts: "2026-01-02T00:00:00Z", kind: "verify", link: "https://x/pr/1" }));
  fs.writeFileSync(path.join(dir, "note.txt"), "x");
  fs.writeFileSync(path.join(dir, "lead-c.jsonl"), "broken\n");
  const d = I.collect(dir);
  assert.deepEqual(d.leaders.map((l) => l.leader), ["lead-b", "lead-a"]);
  assert.equal(I.collect(path.join(dir, "none")).leaders.length, 0);
});

test("findPo: 리더 터미널의 부모이면서 role=po 라벨이 있을 때만 PO다", () => {
  const terms = [
    { address: "t28", name: "", labels: { role: "po" } }, { address: "t91", name: "", labels: { role: "po" } },
    { address: "t12", name: "lead-a", parent: "t28" }, { address: "t13", name: "lead-b", parent: "t28" },
    { address: "t15", name: "lead-c", parent: "t91" },
  ];
  assert.equal(I.findPo(terms, "lead-a"), "t28");
  assert.equal(I.findPo(terms, "lead-c"), "t91"); // PO가 둘이어도 그 리더의 부모를 따른다
  assert.equal(I.findPo(terms, "lead-x", "t15"), "t91"); // 이름이 없으면 보고에 적힌 주소로 찾는다
});

test("findPo: 추측하지 않는다 — 부모가 없거나 role=po가 아니면 null", () => {
  const terms = [
    { address: "t1", name: "", labels: { role: "po" } }, { address: "t2", name: "", labels: { role: "dev" } }, { address: "t3", name: "" },
    { address: "t10", name: "lead-orphan" }, // 부모 없음: 다른 리더들이 달린 PO가 있어도 고르지 않는다
    { address: "t11", name: "lead-a", parent: "t1" }, { address: "t12", name: "lead-b", parent: "t1" },
    { address: "t13", name: "lead-notpo", parent: "t2" }, { address: "t14", name: "lead-nolabel", parent: "t3" },
    { address: "t15", name: "lead-gone", parent: "t99" },
  ];
  for (const name of ["lead-orphan", "lead-notpo", "lead-nolabel", "lead-gone", "lead-none"]) assert.equal(I.findPo(terms, name), null, name);
  assert.equal(I.findPo([], "lead-a"), null);
  assert.equal(I.findPo(undefined, "lead-a"), null);
});

test("answerLine: 한 줄이고, 원문을 그대로 따옴표에 넣고, 링크가 있으면 Target을 붙인다", () => {
  assert.equal(I.answerLine("decision", "lead-a", "A로 가자\n그리고 서둘러", "https://x/1"), 'Panel answer (decision) for lead-a: "A로 가자 그리고 서둘러". Target: https://x/1');
  assert.equal(I.answerLine("verify", "lead-a", "확인 완료", ""), 'Panel answer (verify) for lead-a: "확인 완료".');
  assert.ok(!I.answerLine("decision", "l", "x", "").includes("<hc"));
});

// 요약 칸이 채팅 창을 여는 약속: 같은 키로 위치를 기억하고(keep) 다시 켤 때 돌아오며, 창 안 버튼은 끌기를 시작하지 않는다.
test("main.js: 요약 칸은 key·keep이 있는 떠 있는 창으로 채팅 보기를 열고, 창에는 닫기 버튼이 있다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /const WINDOW = \{[^}]*kind: "window"[^}]*key: "inbox"[^}]*keep: true/);
  assert.match(src, /props: \{ mode: "window" \}/);
  assert.match(src, /openOverlay\(WINDOW\)/);
  assert.match(src, /closeOverlay\(safeProps\(\)\.overlay\)/);
  assert.match(src, /const stop = \(_e, cx\) => cx\.stop_propagation\(\)/);
  // 모든 눌러지는 조각(버튼·이름·링크·입력 칸·닫기·새로고침)은 끌기를 막는다.
  assert.ok((src.match(/on_mouse_down\("left", stop\)/g) ?? []).length >= 8);
  assert.match(src, /setBadge\(text \|\| null\)/);
});

// 답은 진짜 사용자 입력이 된다: 클립보드 → PO 칸 포커스 → 붙여넣기. Enter는 누르지 않고, hc send 경로는 없다.
test("main.js: 답은 클립보드·포커스·붙여넣기로 넣고 hc send와 Enter 입력은 쓰지 않는다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /write_to_clipboard\(line\)/);
  assert.match(src, /run\("pane\.focus", \{ terminal: po \}\)/);
  assert.match(src, /run\("terminal\.paste"/);
  assert.ok(!/\bhc\b[^"\n]*\(\[?"send"/.test(src) && !/hc\(\[/.test(src));
  assert.ok(!/import \{[^}]*\bhc\b[^}]*\} from "herdr"/.test(src));
  assert.ok(!/terminal\.send|send_key|"enter"/i.test(src));
  assert.match(src, /disabled: a\.po \? "" : NO_PO/); // PO를 못 찾으면 답 버튼이 막힌다
});

test("main.js: 배지는 요약 칸이 맡고 30초마다 새로 읽는다(창은 닫혀 있어도 된다)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /PANE_REFRESH_MS = 30000/);
  assert.match(src, /if \(this\.windowed\) return;/);
  const tabs = fs.readFileSync(path.join(__dirname, "../mods/tabs-mine/main.js"), "utf8");
  assert.match(tabs, /inboxWaiting\(\)/);
  assert.ok(!/shared\("inbox\.waiting"\)/.test(tabs)); // 받은편지함 칸이 닫혀 있어도 터미널 라벨로 센다
});

test("waitingKind: lead-* 이름과 wait=decision|verify 라벨만 대기 리더로 본다", () => {
  const { waitingKind } = require("../mods/inbox/inbox.cjs");
  assert.equal(waitingKind({ name: "lead-a", labels: { wait: "decision" } }), "decision");
  assert.equal(waitingKind({ name: "lead-a", labels: { wait: " Verify " } }), "verify");
  assert.equal(waitingKind({ name: "lead-a", labels: { wait: "other" } }), "");
  assert.equal(waitingKind({ name: "lead-a", labels: {} }), "");
  assert.equal(waitingKind({ name: "worker-1", labels: { wait: "decision" } }), ""); // lead-*가 아니면 세지 않는다
  assert.equal(waitingKind({ name: null, labels: { wait: "decision" } }), "");
  assert.equal(waitingKind(null), "");
});

test("waitingKind: 탭 줄(tabs-mine)·요약 칸(inbox/main.js)·inbox.cjs가 같은 줄을 쓴다", () => {
  const line = (f) => fs.readFileSync(path.join(__dirname, f), "utf8").split("\n").find((l) => l.startsWith("const waitingKind = "));
  const a = line("../mods/inbox/inbox.cjs");
  assert.ok(a);
  assert.equal(line("../mods/inbox/main.js"), a);
  assert.equal(line("../mods/tabs-mine/main.js"), a);
});

test("main.js: 보고 기록이 없어도 라벨만으로 카드를 만들고 보낸 표시는 공유 상태에 둔다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /for \(const term of list\) \{\s*const kind = waitingKind\(term\);/); // 터미널을 돈다(보고 파일 목록이 아니라)
  assert.match(src, /items: \[\], last: null/); // 보고 없는 리더의 빈 기록
  assert.match(src, /setShared\(SENT_KEY/);
  assert.match(src, /shared\(SENT_KEY\)/);
  assert.ok(!/this\.sent\b/.test(src)); // 창 안에만 있던 표시는 없다
  assert.match(src, /다른 것을 복사하기 전에/);
});

// ---- 읽기 쉬운 본문(parseBody)
const flat = (segs) => segs.map((g) => (g.k === "l" ? `<${g.label}>` : g.k === "c" ? `\`${g.v}\`` : g.v)).join("");
const shape = (bl) => bl.filter((b) => b.t !== "gap").map((b) => (b.t === "code" ? `code:${b.text}` : `${b.t}${b.mark ? b.mark : ""}:${flat(b.segs)}`));

test("linkLabel: PR·이슈·댓글은 짧은 이름, 나머지는 줄인 호스트/경로", () => {
  assert.equal(I.linkLabel("https://github.com/xowjd913/agent-mods/pull/26"), "PR #26");
  assert.equal(I.linkLabel("https://github.com/xowjd913/agent-mods/pull/26/files"), "PR #26");
  assert.equal(I.linkLabel("https://github.com/xowjd913/agent-mods/issues/25"), "issue #25");
  assert.equal(I.linkLabel("https://github.com/xowjd913/agent-mods/pull/26#issuecomment-123"), "comment");
  assert.equal(I.linkLabel("https://example.com/a/"), "example.com/a");
  assert.ok(I.linkLabel("https://example.com/" + "x".repeat(80)).length <= 28);
  assert.equal(I.linkLabel("not a url"), "not a url");
});

test("parseBody: 제목·목록·번호 목록·문단을 나누고 줄바꿈과 빈 줄 간격을 지킨다", () => {
  const bl = I.parseBody("## 요약\n첫 줄\n- 하나\n  - 안쪽\n1. 일\n2) 이\n\n끝");
  assert.deepEqual(shape(bl), ["h:요약", "p:첫 줄", "li•:하나", "li•:안쪽", "li1.:일", "li2.:이", "p:끝"]);
  assert.equal(bl.find((b) => b.t === "li" && flat(b.segs) === "안쪽").depth, 1);
  assert.ok(bl.some((b) => b.t === "gap"));
});

test("parseBody: 짧은 '라벨:' 줄과 '되돌리기: 내용' 줄은 소제목이 된다", () => {
  const bl = I.parseBody("따라 하기(새 터미널에 붙여 넣기):\n1. 해 본다\n\n아직 못 해 본 것: 마우스 클릭");
  assert.deepEqual(shape(bl), ["h:따라 하기(새 터미널에 붙여 넣기)", "li1.:해 본다", "h:아직 못 해 본 것", "p:마우스 클릭"]);
  const cmd = I.parseBody("되돌리기: cd ~/x && sh a.sh --remove inbox, 그다음 git checkout main && sh a.sh");
  // 한글 설명이 섞인 줄은 명령 상자를 만들지 않고 선택할 수 있는 글로 둔다(반쪽 명령을 건네지 않는다)
  assert.deepEqual(shape(cmd), ["h:되돌리기", "p:cd ~/x && sh a.sh --remove inbox, 그다음 git checkout main && sh a.sh"]);
  assert.deepEqual(shape(I.parseBody("되돌리기: cd ~/x && sh a.sh --remove inbox")), ["h:되돌리기", "code:cd ~/x && sh a.sh --remove inbox"]);
});

test("parseBody: '라벨: 명령' 줄은 줄 전체가 명령일 때만 상자가 되고, 복사 글은 원문과 한 글자도 다르지 않다", () => {
  const codes = (line) => I.parseBody(line).filter((b) => b.t === "code").map((b) => b.text);
  // 리뷰 4회차에서 지적한 줄들: 상자가 없거나, 원문 명령 전체
  assert.deepEqual(codes('설치: git commit -m "받은편지함 수정" && git push'), []);
  assert.deepEqual(codes("설치: curl https://x.y/i.sh | sh -s -- --add inbox. 끝"), []);
  assert.deepEqual(codes("설치: cd ~/문서/x && rm -rf build"), []);
  assert.deepEqual(codes("설치: curl https://x.y/i.sh | sh -s -- --add inbox."), []); // 문장 끝 마침표
  assert.deepEqual(codes('설치: git commit -m "a  b" && git push'), ['git commit -m "a  b" && git push']); // 두 칸 공백 그대로
  // 실제 확인 보고(2026-11-24) 줄: 통째로 명령이라 원문 그대로 들어간다
  const real = "[ -d ~/agent-mods ] || git clone https://github.com/xowjd913/agent-mods ~/agent-mods; cd ~/agent-mods && git fetch origin feature/25-inbox && git checkout feature/25-inbox && sh herdr/install.sh --add inbox";
  assert.deepEqual(codes(`1. 설치: ${real}`), [real]);
  // 실제 되돌리기 줄은 한글(그다음)이 들어 있어 상자 없이 글로 남는다
  const undo = "되돌리기: cd ~/agent-mods && sh herdr/install.sh --remove inbox, 그다음 cd ~/agent-mods && git checkout main && sh herdr/install.sh";
  assert.deepEqual(codes(undo), []);
  assert.ok(flat(I.parseBody(undo)[1].segs).endsWith("&& sh herdr/install.sh"));
  // 어떤 줄이든 상자 글자는 원문에 그대로 들어 있는 조각이다
  for (const line of ['설치: git commit -m "a  b"', "설치: ls -la ~/a", "1. 설치: " + real, "- 설치: echo   hi"]) {
    for (const c of codes(line)) assert.ok(line.includes(c), c);
  }
});

test("toParts: 소제목은 <strong>이 아니라 따로 그리는 조각(h)이고, 명령 하나뿐인 보고도 펼칠 수 있다", () => {
  const parts = I.toParts(I.parseBody("요약 줄\n\n되돌리기:\n- 하나"));
  assert.deepEqual(parts.map((p) => p.t), ["prose", "h", "prose"]);
  assert.equal(parts[1].text, "되돌리기");
  assert.ok(!parts.some((p) => p.html?.includes("<strong>")));
  const one = (body) => I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "verify", title: "[lead-a] 명령 하나", body })).items[0];
  for (const body of ["`git pull --ff-only origin main`", "$ echo hi", "```\ngit status\n```"]) {
    const it = one(body);
    assert.equal(it.long, true, body); // 접힌 카드에 자세히가 생기고, 펼치면 명령 상자와 복사가 보인다
    assert.equal(it.parts.filter((p) => p.t === "code").length, 1, body);
  }
  assert.equal(one("한 줄만").long, false);
});

test("parseBody: 명령은 코드 블록으로 빼고(전체가 복사됨), 일반 `코드`는 인라인으로 둔다", () => {
  const bl = I.parseBody("1. 설치: [ -d ~/a ] || git clone https://x.y/z ~/a; cd ~/a && sh i.sh --add inbox\n2. `받은편지함` 버튼을 누릅니다\n3. 실행 `hc label t1 role=po` 하세요\n$ ls -la\n```\na\nb\n```");
  assert.deepEqual(shape(bl), [
    "li1.:설치:",
    "code:[ -d ~/a ] || git clone https://x.y/z ~/a; cd ~/a && sh i.sh --add inbox",
    "li2.:`받은편지함` 버튼을 누릅니다",
    "li3.:실행 ",
    "code:hc label t1 role=po",
    "p: 하세요",
    "code:ls -la",
    "code:a\nb",
  ]);
});

test("parseBody: URL은 짧은 링크로, 끝의 문장부호는 링크에서 뺀다. 모르는 문법은 글자 그대로 둔다", () => {
  const bl = I.parseBody("보기 https://github.com/o/r/pull/7). 그리고 *굵게* | 표 | `짝 없는 백틱");
  assert.equal(flat(bl[0].segs), "보기 <PR #7>). 그리고 *굵게* | 표 | `짝 없는 백틱");
  const l = bl[0].segs.find((g) => g.k === "l");
  assert.equal(l.v, "https://github.com/o/r/pull/7");
  assert.deepEqual(I.parseBody(""), []);
  assert.deepEqual(I.parseBody(null), []);
  // HTML은 해석하지 않는다: 글자일 뿐이다
  assert.equal(flat(I.parseBody("<b>x</b>")[0].segs), "<b>x</b>");
});

test("summarize: 카드마다 blocks·head·lead·long을 붙인다(진짜 확인 보고 모양)", () => {
  const body = "받은편지함 PR #26이 통과했습니다.\n- PR: https://github.com/xowjd913/agent-mods/pull/26\n\n되돌리기: cd ~/a && sh i.sh --remove inbox";
  const s = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "verify", title: "[lead-a] 최종 확인 요청", body }));
  const it = s.open;
  assert.equal(it.head, "최종 확인 요청");
  assert.equal(it.lead, "받은편지함 PR #26이 통과했습니다.");
  assert.equal(it.long, true);
  assert.ok(it.blocks.some((b) => b.t === "h") && it.blocks.some((b) => b.t === "code"));
  assert.equal(s.items[0].blocks, it.blocks); // 같은 카드는 한 번만 풀어 쓴다
  const short = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "done", title: "끝", body: "" }));
  assert.equal(short.items[0].long, false);
  const longLead = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "done", title: "", body: "가".repeat(300) }));
  assert.ok(longLead.items[0].lead.length <= 110 && longLead.items[0].long);
});

test("main.js: 카드는 접힌 채 시작하고, 펼침은 공유 상태에 두며, 복사 버튼은 클립보드에만 쓴다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /shared\(OPEN_KEY\)/);
  assert.match(src, /setShared\(OPEN_KEY/);
  assert.match(src, /"접기" : "자세히"/);
  assert.match(src, /const open = it\.long && this\.isOpen/); // 기본은 접힘
  // 복사: 클립보드에만 쓰고 붙여 넣기·PO 이동·hc send 경로는 없다
  const copy = src.slice(src.indexOf("  copy(key, text, cx)"), src.indexOf("  openWindow()"));
  assert.match(copy, /cx\.write_to_clipboard\(String\(text\)\)/);
  assert.ok(!/terminal\.paste|pane\.focus|hc send|exec\(/.test(copy));
  // 링크: 앱의 open_url 먼저, http(s)만
  assert.match(src, /cx\.open_url\(url\)/);
  assert.match(src, /if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\) return;/);
  assert.ok(!/hc send|"hc"/.test(src)); // 답은 여전히 hc send 없이 클립보드로만
});

test("toParts·escapeHtml: 글자는 이스케이프하고, 목록은 <ul>로 묶고, 명령은 코드 조각으로 뺀다", () => {
  assert.equal(I.escapeHtml(`a<b>&"c"`), "a&lt;b&gt;&amp;&quot;c&quot;");
  const body = "소개 <b>\n- 하나\n- 둘 https://github.com/x/y/pull/26\n\n되돌리기: cd ~/a && sh i.sh --remove inbox";
  const s = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "verify", title: "t", body }));
  const parts = s.items[0].parts;
  const prose = parts.filter((p) => p.t === "prose").map((p) => p.html).join("");
  assert.match(prose, /소개 &lt;b&gt;/); // 본문의 꺾쇠가 태그로 번지지 않는다
  assert.match(prose, /<ul><li>하나<\/li><li>둘 <a href="https:\/\/github\.com\/x\/y\/pull\/26">PR #26<\/a><\/li><\/ul>/);
  const code = parts.find((p) => p.t === "code");
  assert.ok(code && code.text.includes("cd ~/a && sh i.sh --remove inbox") && code.html.includes("&amp;&amp;"));
  assert.equal(s.items[0].linkHtml, "");
  const linked = I.summarize("lead-a", text({ ts: "2026-01-01T00:00:00Z", kind: "verify", title: "t", body: "x", link: "https://github.com/xowjd913/agent-mods/pull/26" }));
  assert.equal(linked.items[0].linkHtml, '<a href="https://github.com/xowjd913/agent-mods/pull/26">PR #26</a>');
});

test("main.js: 카드 글자는 모두 선택 가능한 TextView이고, 눌러서 펼치는 곳은 자세히/접기 버튼뿐이다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /TextView\.html\(id, html\)\.selectable\(true\)\.on_link_click/);
  for (const k of ["-lead`", "-link`"]) assert.ok(src.includes("this.text(`${id}" + k), k); // 요약·링크
  assert.ok(src.includes("this.heading_text(t, `${id}-h`") && src.includes("this.heading_text(t, key, p.html")); // 제목·소제목: TextView 자체에 굵기를 준 선택 가능한 글
  assert.ok(!src.includes("<strong>"));
  assert.match(src, /it\.parts/); // 펼친 본문
  // 카드 전체에는 클릭 처리가 없다: toggleOpen은 버튼 한 곳에서만 부른다
  assert.equal((src.match(/toggleOpen\(/g) ?? []).length, 2); // 정의 1 + 버튼 1
  assert.ok(!/linkChip|codeSpan/.test(src));
});

test("main.js: 오른쪽 칸은 분류 단계 없이 한 목록이고, 줄을 누르면 그 카드를 펼쳐 창을 연다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  const sum = src.slice(src.indexOf("  summary(cx) {"), src.indexOf("  // The full chat view"));
  assert.ok(sum.length > 200);
  assert.ok(!/결정 필요|결과 보고|눌러서 채팅 창 열기/.test(sum)); // 분류 버튼·안내 줄이 없다
  assert.ok(!/id\("inbox-summary"\)[^\n]*on_click/.test(sum) && !/\.on_click\(\(\) => this\.openWindow/.test(sum)); // 칸 전체 클릭 없음
  assert.match(sum, /badge\("결정", asks\.length/); // 개수는 머리줄의 작은 표시
  assert.match(sum, /badge\("보고", all\.length/);
  assert.match(sum, /asks\.forEach\(\(a\) => list\.push\(this\.paneRow/); // 결정·확인이 맨 위
  assert.match(sum, /reports\(asks, Infinity\)/); // 개수는 전부, 줄은 MAX_ROWS까지
  assert.match(src, /const MAX_ROWS = 20;/);
  assert.match(sum, /나머지 \$\{all\.length - rows\.length\}개는 창에서/);
  const row = src.slice(src.indexOf("  paneRow("), src.indexOf("  // The small pane"));
  assert.match(row, /on_click\(\(_e, c\) => \{ this\.openCard\(s, it\)/);
  assert.match(row, /\.truncate\(\)/); // 한 줄로 줄임표
  // 창은 공유 상태의 선택을 읽어 그 카드를 맨 앞에 둔다(스크롤 이동 API가 없다)
  assert.match(src, /const FOCUS_KEY = "inbox\.focus"/);
  assert.match(src, /openCard\(s, it\) \{[\s\S]*cur\[k\] = 1[\s\S]*setShared\(FOCUS_KEY, it \? this\.cardKey\(s, it\) : ""\)[\s\S]*this\.openWindow\(\)/);
  assert.match(src, /선택한 보고/);
  assert.match(src, /clearFocus\(\); try \{ closeOverlay/); // 창을 닫으면 선택도 지운다
  // 창 카드에는 여전히 카드 전체 클릭이 없다
  assert.equal((src.match(/toggleOpen\(/g) ?? []).length, 2);
});

test("답함 표시: 실제 lead-sched-acct 순서(결정·답, 확인·답, 결정·답)는 모두 답함이고 열린 것이 없다", () => {
  const seq = [
    { ts: "2026-11-24T07:16:07Z", kind: "start", body: "시작" },
    { ts: "2026-11-24T07:18:01Z", kind: "decision", body: "- 핵심: 결정" },
    { ts: "2026-11-24T07:19:41Z", kind: "answered", body: "decision" },
    { ts: "2026-11-24T07:20:06Z", kind: "start", body: "- 핵심: 계획 확정" },
    { ts: "2026-11-24T07:51:14Z", kind: "verify", body: "- 핵심: 1/3" },
    { ts: "2026-11-24T07:57:06Z", kind: "answered", body: "verify" },
    { ts: "2026-11-24T07:58:55Z", kind: "decision", body: "- 질문: 계정 추가" },
    { ts: "2026-11-24T07:59:53Z", kind: "answered", body: "decision" },
  ];
  const s = I.summarize("lead-sched-acct", text(...seq));
  const asks = s.items.filter((i) => i.kind === "decision" || i.kind === "verify");
  assert.equal(asks.length, 3);
  assert.ok(asks.every((i) => i.answered === true));
  assert.equal(s.open, null);
  assert.equal(s.ask.answered, true); // 대기 라벨이 아직 있어도 데이터는 답함으로 알려 준다
  // 데이터는 JSON으로 옮겨져도 표시가 남는다
  assert.equal(JSON.parse(JSON.stringify(s)).items.find((i) => i.ts === "2026-11-24T07:51:14Z").answered, true);
});

test("답함 표시: 새 결정이 답 없이 뒤따르면 그것만 열려 있고 이전 것은 답함이다", () => {
  const s = I.summarize("lead-a", text(
    { ts: "2026-01-01T00:00:00Z", kind: "decision" }, { ts: "2026-01-01T00:01:00Z", kind: "answered", body: "decision" },
    { ts: "2026-01-01T00:02:00Z", kind: "verify" }));
  assert.equal(s.open.kind, "verify");
  assert.equal(s.open.answered, false);
  assert.equal(s.items.find((i) => i.kind === "decision").answered, true);
});

test("답함 표시: answered의 본문 종류가 맞는 가장 가까운 앞선 열린 질문을 닫고, 종류를 모르면 가장 새 질문을 닫는다", () => {
  const a = I.markAnswered(I.parseLines(text(
    { ts: "2026-01-01T00:00:00Z", kind: "decision" }, { ts: "2026-01-01T00:01:00Z", kind: "verify" },
    { ts: "2026-01-01T00:02:00Z", kind: "answered", body: "decision" })));
  assert.deepEqual(a.map((i) => i.answered), [true, false, undefined]);
  const b = I.markAnswered(I.parseLines(text(
    { ts: "2026-01-01T00:00:00Z", kind: "decision" }, { ts: "2026-01-01T00:01:00Z", kind: "decision" },
    { ts: "2026-01-01T00:02:00Z", kind: "answered", body: "" })));
  assert.deepEqual(b.map((i) => i.answered), [false, true, undefined]);
  // 질문 없이 온 answered, 맞는 종류가 없는 answered
  assert.equal(I.markAnswered(I.parseLines(text({ ts: "2026-01-01T00:00:00Z", kind: "answered", body: "verify" }))).length, 1);
  const c = I.markAnswered(I.parseLines(text({ ts: "2026-01-01T00:00:00Z", kind: "decision" }, { ts: "2026-01-01T00:01:00Z", kind: "answered", body: "verify" })));
  assert.equal(c[0].answered, true); // 계약 v1: 뒤따른 answered 한 줄은 질문을 닫는다
  // 같은 종류가 둘이면 가장 가까운 앞선 것부터
  const d = I.markAnswered(I.parseLines(text(
    { ts: "2026-01-01T00:00:00Z", kind: "verify" }, { ts: "2026-01-01T00:01:00Z", kind: "verify" },
    { ts: "2026-01-01T00:02:00Z", kind: "answered", body: "verify" }, { ts: "2026-01-01T00:03:00Z", kind: "answered", body: "verify" })));
  assert.deepEqual(d.map((i) => i.answered), [true, true, undefined, undefined]);
});

test("창 구역 접기와 답함 표시: 머리줄 누름·공유 상태·기본값·붉은색 규칙이 main.js에 있다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /const SECT_KEY = "inbox\.sections"/);
  assert.match(src, /collapsed\(name, count, force\)/);
  assert.match(src, /return name === "ask" && count === 0/); // 결정 필요는 비면 스스로 접힘
  assert.match(src, /st\.n === count/); // 직접 누른 것은 개수가 바뀔 때까지 이김
  assert.match(src, /setShared\(SECT_KEY/);
  assert.match(src, /id: "sec-ask"[^\n]*this\.collapsed|collapsed\("ask", asks\.length, fa >= 0\)/);
  assert.match(src, /"▸" : "▾"/);
  assert.match(src, /\$\{k\[0\]\} · 답함/);
  assert.match(src, /nameRow\(t, s, item \? \{ \.\.\.item, kind \} : null, null, true\)/); // 대기 카드만 붉은 종류 표시
  assert.match(src, /this\.kindTag\(t, it, kind \?\? it\?\.kind, ask\)/); // 창 보고 줄과 같은 규칙을 창 옆 목록 줄도 쓴다
});
