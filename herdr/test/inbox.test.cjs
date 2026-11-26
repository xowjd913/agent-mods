// inbox.cjs 단위 테스트: node --test herdr/test/inbox.test.cjs
const test = require("node:test");
const POSIX = process.platform !== "win32"; // Windows has no POSIX file modes: only the mode asserts are skipped there
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const WINDOW = \{[^}]*kind: "window"[^}]*key: "inbox"[^}]*keep: true/);
  assert.match(src, /props: \{ mode: "window" \}/);
  assert.match(src, /openOverlay\(WINDOW\)/);
  assert.match(src, /closeOverlay\(safeProps\(\)\.overlay\)/);
  assert.match(src, /const stop = \(_e, cx\) => cx\.stop_propagation\(\)/);
  // 모든 눌러지는 조각(버튼·이름·링크·입력 칸·닫기·새로고침)은 끌기를 막는다.
  assert.ok((src.match(/on_mouse_down\("left", stop\)/g) ?? []).length >= 8);
  assert.match(src, /setBadge\(text \|\| null\)/);
});

// 패널이 PO 터미널에 넣는 길은 하나(deliver): 클립보드 → PO 칸 포커스 → 붙여넣기 → Enter(hc keys). hc send는 쓰지 않는다.
const mainSrc = () => fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const methodOf = (src, head, next) => { const a = src.indexOf(head), b = src.indexOf(next, a + 1); assert.ok(a > 0 && b > a, head); return src.slice(a, b); };
const deliverOf = (src) => methodOf(src, '  deliver(po, text, c, rec = null, ok = null, id = "", opened = false) {', "  // A send to a PO with no pane");

test("main.js: 답 버튼·답 상자·N안 칩·채팅은 모두 deliver() 한 길로 붙여넣고 Enter까지 보낸다", () => {
  const src = mainSrc();
  assert.ok(!/hc\(\["send"/.test(src.replaceAll('hc(["send", "--json", "--", po, text])', "")) && !/terminal\.send|send_key/i.test(src)); // chat/answers: no hc send (it adds a <hc from=...> tag); only the restart sendLine uses it (a /clear must run as a command)
  const send = methodOf(src, "  send(a, text, cx, kind = \"answer\") {", "  clearBox(a");
  const chat = methodOf(src, "  sendChat(c) {", "  // The chat footer");
  const del = deliverOf(src);
  assert.match(send, /answerLine\(a\.kind, a\.s\.leader, /); assert.match(send, /this\.deliver\(po, line, cx, \{/);
  assert.match(chat, /this\.deliver\(po, line, c, \{/);
  assert.ok(!/run\("terminal\.paste"|submitPo|hc\(/.test(send + chat)); // 붙여넣기·Enter는 deliver 안에서만
  // 순서: 클립보드 → 포커스 → 붙여넣기 → Enter
  const at = (re) => del.search(re);
  assert.ok(at(/write_to_clipboard\(text\)/) >= 0 && at(/pane\.focus", \{ terminal: po \}/) > at(/write_to_clipboard/));
  assert.ok(at(/run\("terminal\.paste"/) > at(/pane\.focus", \{ terminal: po \}/) && at(/this\.submitPo\(/) > at(/run\("terminal\.paste"/));
  assert.match(src, /write_to_clipboard\(text\)/);
  assert.match(src, /disabled: a\.po \? "" : NO_PO/); // PO를 못 찾으면 답 버튼이 막힌다
  assert.ok(!/Enter를 눌러 보내세요|PO에서 Enter로 보내면 리더가 받고/.test(src)); // 이제 보내므로 '직접 Enter' 안내는 막힌 경우에만
});

test("main.js: deliver — 막힌 PO(blocked)는 붙여넣기만, 칸 없는 PO는 열고 칸이 생기면 한 번만 자동으로 보낸다", () => {
  const src = mainSrc();
  const del = deliverOf(src);
  const nopane = del.slice(del.indexOf("if (!(panes()"), del.indexOf("const blocked"));
  assert.match(nopane, /terminal\.keep/);
  assert.match(nopane, /this\.awaitPane\(/);
  assert.match(nopane, /return "opening"/);
  assert.match(nopane, /if \(opened\)[^\n]*return "nopane"/); // 한 번 연 뒤에도 칸이 없으면 다시 열지 않고 멈춘다
  assert.ok(!/submitPo/.test(nopane)); // 칸이 없는 채로는 Enter 없음
  assert.match(del, /if \(!opened && this\.opening\.has\(po\)\)[^\n]*return "busy"/); // 같은 PO에 둘째 보내기는 시작하지 않는다(이중 전송 없음)
  assert.ok(del.indexOf("const blocked") < del.indexOf('run("terminal.paste"'));
  const afterPaste = del.slice(del.indexOf('run("terminal.paste"'));
  assert.ok(afterPaste.indexOf("if (blocked)") >= 0 && afterPaste.indexOf('return "held"') < afterPaste.indexOf("this.submitPo(")); // blocked는 submitPo 앞에서 끝난다
  assert.ok(afterPaste.indexOf('return "failed"') >= 0 && afterPaste.indexOf('return "failed"') < afterPaste.indexOf("this.submitPo(")); // 붙여넣기 실패도 Enter 없음
  // awaitPane: 300ms마다 6초까지 보고, 칸이 보이면 붙여넣기가 들어갈 틈 뒤에 opened=true로 한 번만 deliver, 끝내 안 열리면 nopane
  const aw = methodOf(src, "  awaitPane(po, text, c, rec, ok, id) {", "  isBlocked(po)");
  assert.match(aw, /this\.opening\.add\(po\)/);
  assert.match(aw, /this\.mark\(id, "opening"\)/);
  assert.match(aw, /PANE_WAIT_MS/);
  assert.match(aw, /PANE_POLL_MS/);
  assert.match(aw, /cx\.timer\.after\(PASTE_SETTLE_MS, go\)/);
  assert.match(aw, /this\.deliver\(po, text, c2, rec, ok, id, true\)/);
  assert.match(aw, /this\.mark\(id, "nopane"\)/);
  assert.equal((aw.match(/this\.opening\.delete\(po\)/g) ?? []).length, 2); // 열렸을 때와 포기했을 때 모두 잠금을 푼다
  assert.match(src, /const PANE_POLL_MS = 300, PANE_WAIT_MS = 6000/);
  // 닫기·지우기는 PO에 닿았을 때(sent·held), 칸을 여는 중이면 글이 가는 순간(ok)에
  const send = methodOf(src, "  send(a, text, cx, kind = \"answer\") {", "  clearBox(a");
  assert.match(send, /r === "sent" \|\| r === "held"/);
  assert.match(send, /this\.clearBox\(a, r, sent\)/);
  assert.match(send, /\(r2\) => \{ this\.clearBox\(a, r2, sent\); \}/);
});

test("main.js: 보내도 PO 데스크는 닫히지 않고(Dock·창·페인), 페인이면 Enter 뒤에 키보드를 돌려준다", () => {
  const src = mainSrc();
  const send = methodOf(src, "  send(a, text, cx, kind = \"answer\") {", "  clearBox(a");
  const chat = methodOf(src, "  sendChat(c) {", "  // The chat footer");
  const sub = methodOf(src, "  submitPo(po, c, settle", "  sendChat(c) {");
  const del = deliverOf(src);
  for (const part of [send, chat, sub, del]) assert.ok(!/closeOverlay/.test(part));
  // 닫기는 창의 닫기 버튼과 '옆에 열기'(창 → 페인)에만 남는다
  assert.equal((src.match(/closeOverlay\(/g) ?? []).length, 2); // openBeside(창 → 페인)와 닫기 버튼, 두 곳뿐
  // 키보드를 돌려받는 길(모든 모드): 보내기 전에 포커스가 있던 칸(아무 칸) id를 적어 두고 Enter 뒤에 pane.focus
  assert.match(del, /focused\(\)\?\.pane/);
  assert.ok(!/p\.mod/.test(del)); // 모드 칸만이 아니라 어느 칸이든
  assert.match(del, /this\.submitPo\(po, c, [^\n]*, back, id\)/);
  const rs = methodOf(src, "  restore(back, c, id", "  // One line of the person");
  assert.match(rs, /run\("pane\.focus", \{ pane: back \}\)/);
  assert.match(rs, /this\.chat\.focus\(\)/);
  assert.match(sub, /this\.restore\(back, cx, id\)/);
  assert.equal((sub.match(/this\.restore\(/g) ?? []).length, 3); // Enter 뒤, Enter 실패 뒤, 그 사이 질문이 열려 Enter를 건너뛴 뒤
  assert.match(del, /this\.restore\(back, c, id, PASTE_SETTLE_MS\)/); // 막힌 PO에 붙여 넣기만 한 뒤에도 돌려준다
  assert.match(sub, /this\.mark\(id, "sent"\)/); // 기록은 Enter가 지나간 뒤에야 sent
  assert.match(sub, /this\.mark\(id, "noenter"\)/);
  // 붙여 넣은 글이 길면 Enter까지 더 기다린다
  assert.match(del, /PASTE_SETTLE_MS \+ Math\.min\(600, /);
});

test("answerLine: 한 줄·끝 개행 없음(붙여 넣고 Enter 한 번이면 한 번 제출)", () => {
  const l = I.answerLine("decision", "lead-herdr-mobile", "그래 니가 추천하는 방식으로 진행하자", "");
  assert.equal(l, 'Panel answer (decision) for lead-herdr-mobile: "그래 니가 추천하는 방식으로 진행하자".');
  assert.ok(!/[\r\n]/.test(l));
  assert.ok(!/[\r\n]/.test(I.answerLine("verify", "lead-x", "첫 줄\n\n둘째 줄", "https://x.test/1")));
  assert.ok(!/\s$/.test(I.answerLine("verify", "lead-x", "확인 완료", "https://x.test/1")));
});

test("main.js: 배지는 요약 칸이 맡고 30초마다 새로 읽는다(창은 닫혀 있어도 된다)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /PANE_REFRESH_MS = 30000/);
  assert.match(src, /if \(this\.windowed\) return;/);
  const tabs = fs.readFileSync(path.join(__dirname, "../mods/tabs-mine/main.js"), "utf8").replace(/\r\n/g, "\n");
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
  const line = (f) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n").split("\n").find((l) => l.startsWith("const waitingKind = "));
  const a = line("../mods/inbox/inbox.cjs");
  assert.ok(a);
  assert.equal(line("../mods/inbox/main.js"), a);
  // tabs-mine still has the old line (default names only) until #60 step B part 2 moves it to the profile too.
});

test("main.js: 보고 기록이 없어도 라벨만으로 카드를 만들고 보낸 표시는 공유 상태에 둔다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /for \(const term of list\) \{\s*const kind = waitingKind\(term\);/); // 터미널을 돈다(보고 파일 목록이 아니라)
  assert.match(src, /items: \[\], last: null/); // 보고 없는 리더의 빈 기록
  assert.match(src, /setShared\(SENT_KEY/);
  assert.match(src, /shared\(SENT_KEY\)/);
  assert.ok(!/this\.sent\b/.test(src)); // 창 안에만 있던 표시는 없다
  assert.match(src, /PO에 보냄 — 리더가 받으면 사라집니다/); // 보낸 표시(Enter까지 누른 경우)
  assert.match(src, /PO에 넣음 — PO가 질문 중입니다\. 방의 질문에 먼저 답하세요/); // 막힌 PO에는 붙여넣기만(아직 질문 중)
  assert.match(src, /PO에 넣음 — 말풍선의 'Enter 누르기'로 보내세요/); // 질문에 답한 뒤에는 말풍선 버튼으로
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /shared\(OPEN_KEY\)/);
  assert.match(src, /setShared\(OPEN_KEY/);
  assert.match(src, /"접기" : "자세히"/);
  assert.match(src, /const open = it\.long && this\.isOpen/); // 기본은 접힘
  // 복사: 클립보드에만 쓰고 붙여 넣기·PO 이동·hc send 경로는 없다
  const copy = src.slice(src.indexOf("  copy(key, text, cx)"), src.indexOf("  // \"옆에 열기\":"));
  assert.match(copy, /cx\.write_to_clipboard\(String\(text\)\)/);
  assert.ok(!/terminal\.paste|pane\.focus|hc send|exec\(/.test(copy));
  // 링크: 앱의 open_url 먼저, http(s)만
  assert.match(src, /cx\.open_url\(url\)/);
  assert.match(src, /if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\) return;/);
  assert.ok(!/hc\(\["send"/.test(src.replaceAll('hc(["send", "--json", "--", po, text])', ""))); // 클립보드로만(채팅의 Enter는 hc keys); 재시작의 sendLine만 hc send
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /TextView\.html\(id, html\)\.selectable\(true\)\.on_link_click/);
  for (const k of ["-lead`", "-link`"]) assert.ok(src.includes("this.text(`${id}" + k), k); // 요약·링크
  assert.ok(src.includes("this.heading_text(t, `${id}-h`") && src.includes("this.heading_text(t, key, p.html")); // 제목·소제목: TextView 자체에 굵기를 준 선택 가능한 글
  assert.ok(!src.includes("<strong>"));
  assert.match(src, /it\.parts/); // 펼친 본문
  // 카드 전체에는 클릭 처리가 없다: toggleOpen은 버튼 한 곳에서만 부른다
  assert.equal((src.match(/toggleOpen\(/g) ?? []).length, 2); // 정의 1 + 버튼 1
  assert.ok(!/linkChip|codeSpan/.test(src));
});

test("main.js: 오른쪽 칸(Dock)도 창과 같은 메신저 화면이다: 좁은 방 칸 + 타임라인 + 채팅 상자, 창 열기 버튼", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(!/summary\(cx\)|paneRow|openCard|MAX_ROWS|rowsScroll|FOCUS_KEY|inbox-rows/.test(src)); // 카드 목록·칩 보기는 없다
  assert.match(src, /render\(cx\) \{ return this\.full\(cx\); \}/); // 창과 Dock이 같은 그림
  assert.match(src, /const strip = this\.windowed && this\.narrow;/); // 위쪽 띠는 좁은 창에서만, Dock(460px)은 좁은 방 칸
  assert.match(src, /this\.narrow \? this\.slimRooms\(t, v\) : this\.roomList\(t, v\)/); // 방 목록은 모드가 아니라 자기 폭으로 고른다
  assert.match(src, /const SLIM_W = 58|SLIM_W = 58/);
  const slim = src.slice(src.indexOf("  slimRooms("), src.indexOf("  // The room list (the wide window)"));
  assert.match(slim, /this\.circle\(t, color,/); // 이니셜 동그라미
  assert.match(slim, /this\.roomBadges\(t, x\)/); // 안 읽은 수·대기 수
  assert.match(slim, /\.tooltip\(/); // 프로젝트 이름은 툴팁
  assert.match(slim, /\.on_click\(\(_e, c\) => this\.pickPo\(x\.id, c\)\)/);
  assert.match(src, /this\.button\(t, "inbox-open", "창 열기"/); // Dock 머리줄의 창 열기
  assert.match(src, /\.when\(!this\.windowed && !this\.mained, \(el\) => el\.child\(this\.button\(t, "inbox-open"/);
  assert.match(src, /markSeen\(\) \{\s*if \(!this\.drawnAt \|\| !this\.drawing\(\)\) return;/);
  assert.match(src, /대기 \$\{waiting\}/); // 머리줄의 대기 수 표시
  // Dock이 방을 보여 주는 동안 읽은 것으로 친다(그려지지 않는 동안은 아니다)
  assert.match(src, /this\.drawnAt = Date\.now\(\);/);
  assert.ok(!/if \(!this\.windowed\) return;\s*\n\s*try \{\s*\n\s*const v = this\.view/.test(src));
  assert.match(src, /unread: r\.id === pick \? 0 : unreadCount/);
});

// The PO desk as a pane of its own (pane.split {mod: "inbox", props: {mode: "pane"}}), beside the Dock and the window.
test("dockTarget: 포커스가 리더면 그 옆, 아니면 탭의 가장 새 리더, 리더가 없으면 포커스한 터미널 옆, 이미 있으면 그 페인으로 간다", () => {
  const terms = [
    { address: "t1", labels: { role: "leader" }, created_ms: 100 },
    { address: "t2", labels: { role: "LEADER " }, created_ms: 300 },
    { address: "t3", labels: { role: "worker" }, created_ms: 500 },
  ];
  const here = [
    { pane: "p1", terminal: "t1", focused: false },
    { pane: "p2", terminal: "t2", focused: false },
    { pane: "p3", terminal: "t3", focused: true },
  ];
  assert.deepEqual(I.dockTarget(here, { pane: "p3" }, terms), { action: "split", pane: "p2" }); // 가장 새 리더
  assert.deepEqual(I.dockTarget(here, { pane: "p1" }, terms), { action: "split", pane: "p1" }); // 포커스한 리더
  assert.deepEqual(I.dockTarget(here.filter((p) => p.pane === "p3"), { pane: "p3" }, terms), { action: "split", pane: "p3" }); // 리더 없음
  assert.deepEqual(I.dockTarget([{ pane: "p9", mod: "x", focused: true }], { pane: "p9" }, []), { action: "split", pane: "p9" }); // 터미널 아닌 페인도 마지막 후보
  assert.deepEqual(I.dockTarget([], null, terms), { action: "split" }); // 기준이 없으면 인자 없이
  // 이 탭에 이미 PO 데스크 페인이 있으면 새로 만들지 않고 그쪽으로
  const had = [...here, { pane: "p7", mod: "inbox", terminal: null, focused: false }];
  assert.deepEqual(I.dockTarget(had, { pane: "p3" }, terms), { action: "focus", pane: "p7" });
  assert.deepEqual(I.dockTarget(had.concat({ pane: "p8", mod: "prs" }), { pane: "p1" }, terms), { action: "focus", pane: "p7" });
  // 다른 mod 페인(prs)은 PO 데스크로 세지 않는다
  assert.deepEqual(I.dockTarget([...here, { pane: "p8", mod: "prs" }], { pane: "p3" }, terms), { action: "split", pane: "p2" });
  // 잘못된 입력도 던지지 않는다
  assert.deepEqual(I.dockTarget(null, undefined, null), { action: "split" });
});

test("main.js: 페인 모드: 같은 메신저 화면, 자기 제목줄을 쓰고, 방 목록은 폭으로 고르며, 옆에 열기는 dockTarget을 따른다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /this\.paned = mode === "pane"/);
  assert.match(src, /this\.windowed = mode === "window"/);
  assert.match(src, /this\.narrow = !this\.windowed;/); // Dock과 페인은 좁게 시작, 창은 넓게
  // 옆에 열기: 리더 옆 오른쪽 분할, 이미 있으면 포커스, props는 {mode: "pane"}
  const open = src.slice(src.indexOf("  openBeside()"), src.indexOf("  openWindow()"));
  assert.match(open, /dockTarget\(here, f, terminals\(\) \?\? \[\]\)/);
  assert.match(open, /\(panes\(\) \?\? \[\]\)\.filter\(\(p\) => p\.tab === f\?\.tab\)/); // 보이는 탭의 페인만
  assert.match(open, /run\("pane\.focus", \{ pane: d\.pane \}\)/);
  assert.match(open, /run\("pane\.split", \{ direction: "right", mod: "inbox", props: \{ mode: "pane" \}/);
  assert.match(open, /if \(this\.windowed\) \{ try \{ closeOverlay/); // 창에서 열면 창을 닫는다
  assert.ok(!/hc send|hc\(/.test(open));
  // 머리줄: 페인은 제목·옆에 열기가 없고(페인 머리줄·이미 페인), 닫기 버튼도 만들지 않는다
  assert.match(src, /\.when\(!this\.paned \|\| this\.mained, \(el\) => el\.child\(div\(\)\.text_size\(15\)[^\n]*PO 데스크/); // 페인은 자기 제목줄이 있고, UI 모드 main 칸은 없어서 제목을 그린다
  assert.match(src, /\.when\(!this\.paned, \(el\) => el\.child\(this\.button\(t, "inbox-beside", "옆에 열기"/);
  assert.match(src, /\.when\(this\.windowed, \(el\) => el\.child\(div\(\)\.id\("inbox-close"\)/);
  // 갱신·뱃지: 창과 페인은 5초(페인은 그려지는 동안만), Dock만 30초, 뱃지는 창만 건너뛴다
  assert.match(src, /refreshMs\(\) \{ return this\.windowed \|\| this\.paned \? WINDOW_REFRESH_MS : PANE_REFRESH_MS; \}/);
  assert.match(src, /cx\.timer\.every\(this\.refreshMs\(\), \(cx\) => \{ if \(!this\.paned \|\| this\.drawing\(\)\) this\.load\(cx\); \}\)/);
  assert.match(src, /badge\(\) \{\s*if \(this\.windowed\) return;/);
  assert.match(src, /drawing\(\) \{ return !this\.drawnAt \|\| Date\.now\(\) - this\.drawnAt <= this\.refreshMs\(\) \* 2 \+ 2000; \}/);
  // 보낸 글·고른 방·안 읽은 시각은 모두 공유 상태라 Dock·페인·창이 같다
  assert.match(src, /shared\(PICK_KEY\)/);
  assert.match(src, /setShared\(SEEN_KEY/);
  assert.match(src, /setShared\(CHAT_KEY/);
  // focusable은 두지 않는다: 켜면 pane.go가 복사본에 "focus"를 보내는데 nextCommand 처리가 없다
  const mod = JSON.parse(fs.readFileSync(path.join(__dirname, "../mods/inbox/mod.json"), "utf8"));
  assert.ok(!("focusable" in mod));
});

// Regression: h_flex() centers its children on the cross axis, so a column placed in it takes only its content height and the timeline
// (flex_1 + min_h(0)) collapsed to nothing — the room showed a header and the chat box with an empty gap above. The row stretches and
// both columns are h_full.
test("main.js: 방 목록과 방 칸이 행의 전체 높이를 채운다(타임라인이 0 높이로 접히지 않는다)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /h_flex\(\)\.flex_1\(\)\.min_h\(0\)\.items_stretch\(\)/);
  assert.match(src, /const room = v_flex\(\)\.flex_1\(\)\.min_w\(0\)\.min_h\(0\)\.when\(!strip, \(el\) => el\.h_full\(\)\)/);
  assert.match(src, /id\("po-rooms"\)\.flex_none\(\)\.w\(ROOM_W\)\.h_full\(\)/);
  assert.match(src, /id\("po-rooms"\)\.flex_none\(\)\.w\(SLIM_W\)\.h_full\(\)/);
  // the timeline itself keeps taking the rest of the column above the pinned chat box
  assert.match(src, /id\("inbox-list"\)[^\n]*\.flex_1\(\)\.min_h\(0\)/);
  assert.match(src, /\.child\(lines\)\s*\n\s*\.when\(Boolean\(panel\), \(el\) => el\.child\(panel\)\)\s*\n\s*\.when\(Boolean\(rrow\), \(el\) => el\.child\(rrow\)\)\s*\n\s*\.child\(this\.chatBox\(t, v\)\)/);
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

test("메신저 창: 방 목록·타임라인·인라인 버튼·답함 표시 규칙이 main.js에 있다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(!/SECT_KEY|collapsed\(|toggleSection|sec-ask|sec-rep|chatRow|askCard|heading\(/.test(src)); // 두 줄기·접기 구역은 없다
  assert.match(src, /\$\{k\[0\]\} · 답함/); // 답함 태그
  assert.match(src, /this\.nameRow\(t, e\.s, e\.it, null, Boolean\(e\.waiting\), !e\.head\)/); // 같은 보낸이가 이어지면 이름 줄을 줄인다
  assert.match(src, /this\.askActions\(t, a, cx\)/); // 기다리는 메시지에만 인라인 버튼
  const act = src.slice(src.indexOf("  askActions("), src.indexOf("  entryRow("));
  for (const id of ["link-", "ok-", "write-", "send-"]) assert.ok(act.includes(id));
  assert.match(act, /kind === "verify"/); // 확인 완료는 verify에만
  assert.match(src, /roomList\(t, v\) \{[\s\S]*border_r\(1\)/); // 왼쪽 방 목록
  assert.match(src, /\.child\(strip \? room : h_flex\(\)\.flex_1\(\)\.min_h\(0\)\.items_stretch\(\)/);
  assert.match(src, /\.when\(strip, \(el\) => el\.child\(this\.picker\(t, v\)\)\)/); // 좁은 창은 위쪽 띠
  assert.match(src, /const WIDE_MIN = 520/);
  assert.match(src, /e\.who === "me"[\s\S]*items_end\(\)/); // 내 글은 오른쪽
  assert.match(src, /this\.circle\(t, color, letter\)|circle\(t, color, letter\) \{/);
  assert.match(src, /채팅 없음/); // PO 모름 방에는 채팅 상자가 없다
  assert.match(src, /v\.pick === PO_OTHER[\s\S]*chat-none/);
});

// ---- 리더 이름(#33): 받은편지함과 에이전트 목록이 같은 규칙으로 세션 이름을 고른다.
const NAMES = require("../mods/inbox/inbox.cjs");

test("leaderName: 살아 있는 터미널 제목이 있으면 그것을 쓰고 '리더 · ' 머리말은 뗀다", () => {
  const term = { name: "lead-po-inbox", address: "t137", title: "리더 · 받은편지함 패널" };
  assert.equal(NAMES.leaderName("lead-po-inbox", term, {}), "받은편지함 패널");
  assert.equal(NAMES.leaderName("lead-po-inbox", { ...term, title: "리더·받은편지함 패널" }, {}), "받은편지함 패널");
  assert.equal(NAMES.leaderName("lead-po-inbox", { ...term, title: "✦ 리더 · 받은편지함 패널" }, {}), "받은편지함 패널"); // 상태 기호는 뗀다
  assert.equal(NAMES.leaderName("lead-po-inbox", { ...term, title: "받은편지함 패널" }, {}), "받은편지함 패널"); // 머리말이 없어도 그대로
});

test("leaderName: 제목이 비었거나 쓸모없으면 session 라벨, 그다음 기억한 이름, 마지막으로 내부 이름", () => {
  const base = { name: "lead-po-inbox", address: "t137" };
  assert.equal(NAMES.leaderName("lead-po-inbox", { ...base, title: "  ", labels: { session: "리더 · 라벨 이름" } }, {}), "라벨 이름");
  for (const title of ["", undefined, "lead-po-inbox", "t137", "claude", "리더 · "]) {
    assert.equal(NAMES.leaderName("lead-po-inbox", { ...base, title }, {}), "po inbox", String(title)); // 기억도 없으면 내부 이름
    assert.equal(NAMES.leaderName("lead-po-inbox", { ...base, title }, { "lead-po-inbox": "리더 · 기억한 이름" }), "기억한 이름", String(title));
  }
  assert.equal(NAMES.leaderName("lead-sched-acct", null, undefined), "sched acct");
  assert.equal(NAMES.leaderName("lead-sched-acct", undefined, null), "sched acct");
});

test("leaderName: 이미 닫힌 리더(터미널 없음)는 마지막으로 본 이름을 쓴다", () => {
  assert.equal(NAMES.leaderName("lead-gone", null, { "lead-gone": "닫힌 작업" }), "닫힌 작업");
  assert.equal(NAMES.leaderName("lead-other", null, { "lead-gone": "닫힌 작업" }), "other"); // 다른 리더의 이름을 가져오지 않는다
  assert.equal(NAMES.leaderName("", null, {}), "");
});

test("rememberNames: lead-* 터미널의 읽을 수 있는 제목만 기억하고, 바뀐 것이 없으면 null", () => {
  const terms = [
    { name: "lead-a", address: "t1", title: "리더 · 가 작업" },
    { name: "lead-b", address: "t2", title: "" },
    { name: "dev-1-x", address: "t3", title: "개발 · #1" }, // 리더가 아니다
  ];
  const m = NAMES.rememberNames({}, terms);
  assert.deepEqual(m, { "lead-a": "가 작업" });
  assert.equal(NAMES.rememberNames(m, terms), null);
  assert.deepEqual(NAMES.rememberNames(m, [{ name: "lead-a", address: "t1", title: "리더 · 새 이름" }]), { "lead-a": "새 이름" });
  assert.equal(NAMES.rememberNames({ "lead-a": "keep" }, [{ name: "lead-b", address: "t2", title: "" }]), null); // 제목이 비면 지우지 않는다
  assert.equal(NAMES.rememberNames(undefined, undefined), null);
});

test("rememberNames: 오래된 것부터 버려 상한을 지킨다", () => {
  const memo = { x1: "1", x2: "2", x3: "3" };
  const next = NAMES.rememberNames(memo, [{ name: "lead-n", address: "t9", title: "새" }], 3);
  assert.deepEqual(Object.keys(next), ["x2", "x3", "lead-n"]);
});

test("leaderName: 받은편지함·에이전트 목록·inbox.cjs가 같은 블록을 쓴다", () => {
  const block = (f) => {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
    const a = src.indexOf("// leaderName:begin"), b = src.indexOf("// leaderName:end");
    assert.ok(a >= 0 && b > a, f);
    return src.slice(a, b);
  };
  const ref = block("../mods/inbox/inbox.cjs");
  assert.equal(block("../mods/inbox/main.js"), ref);
  // agent-groups, leader-tabs and work still copy the old (default-name) block until #60 step B part 2 moves them to the profile.
});

test("leader-tabs·work: 리더 이름을 hc 이름(lead-x) 그대로 그리지 않는다", () => {
  const tabs = fs.readFileSync(path.join(__dirname, "../mods/leader-tabs/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(tabs, /return leaderName\(term\.name, term, namesMemo\(\)\)/);
  assert.doesNotMatch(tabs, /term\.name \|\| term\.address/);
  const work = fs.readFileSync(path.join(__dirname, "../mods/work/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(work, /const label = sessionLabel\(s\)/);
  // The rule itself: a closed or untitled leader reads as its task, a titled one as its title.
  assert.equal(NAMES.leaderName("lead-po-inbox", { name: "lead-po-inbox", address: "t1", title: "리더 · 받은편지함 정리" }, {}), "받은편지함 정리");
  assert.equal(NAMES.leaderName("lead-po-inbox", { name: "lead-po-inbox", address: "t1", title: "lead-po-inbox" }, {}), "po inbox");
});

// The scroll lists keep their place across presses: handles the view owns, tracked on both lists, and an anchor after every press that
// changes a card's or a section's height. (The kit gives no way to read a pixel offset, so this checks the wiring, not the pixels.)
test("받은편지함: 타임라인은 새 글을 따라 맨 아래로 가고, 올려 읽는 중이면 붙든다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /ScrollHandle\.new\(\)/);
  assert.match(src, /id\("inbox-list"\)[^\n]*/);
  assert.match(src, /track_scroll\(this\.scroll\)/);
  assert.match(src, /atBottom\(o\.y, vp\.height, ct\.height\)/); // 마지막 레이아웃의 값으로 바닥 여부를 읽는다
  assert.match(src, /tlFollow\(this\.tlSeen, key, atEnd\)/);
  assert.match(src, /scroll_to_item\(last\)/); // ScrollHandle에는 scroll_to_bottom이 없다
  assert.match(src, /this\.tlSeen = key/);
  assert.match(src, /this\.reveal\(this\.spot\(s, item\)\)/); // 답 상자가 열려도 그 자리를 붙든다
  assert.match(src, /this\.toggleOpen\(s, it\); this\.reveal\(this\.spot\(s, it\)\)/);
});

// ---- PO 채팅: @ 멘션, 리더 메뉴, po/<id>.jsonl
const TERMS = [
  { address: "t28", name: "", title: "PO · DevNotes", labels: { role: "po", po: "devnotes" } },
  { address: "t12", name: "lead-b", title: "받은편지함 패널", parent: "t28" },
  { address: "t13", name: "lead-a", title: "리더 · 가나다", parent: "t28" },
  { address: "t99", name: "lead-orphan", parent: "t5" },
  { address: "t40", name: "", labels: { role: "po", po: "mascoz" } },
  { address: "t41", name: "lead-c", parent: "t40" },
];

test("parseMention: @리더는 살아 있는 리더만 대상이 되고, @here는 글에서 빠진다", () => {
  const known = ["lead-a", "lead-b"];
  const m = I.parseMention("@lead-a 상태 알려줘", known);
  assert.deepEqual([m.text, m.to, m.here, m.empty], ["@lead-a 상태 알려줘", ["lead-a"], false, false]);
  const h = I.parseMention("@here 오늘 뭐 했어?", known);
  assert.deepEqual([h.text, h.to, h.here], ["오늘 뭐 했어?", [], true]);
  const none = I.parseMention("그냥 PO에게", known);
  assert.deepEqual([none.to, none.here], [[], false]);
  assert.deepEqual(I.parseMention("@lead-zzz 안녕", known).to, []); // 모르는 리더는 일반 글자
  assert.deepEqual(I.parseMention("둘 다 @lead-a, @lead-b! 그리고 @lead-a", known).to, ["lead-a", "lead-b"]);
});

test("parseMention: 줄바꿈은 지키고, 멘션만 있거나 빈 글은 empty, 단어 중간의 @는 멘션이 아니다", () => {
  const known = ["lead-a"];
  assert.equal(I.parseMention("위\n  아래", known).text, "위\n아래");
  assert.equal(I.parseMention("@lead-a", known).empty, true);
  assert.equal(I.parseMention("@here  ", known).empty, true);
  assert.equal(I.parseMention("   ", known).empty, true);
  assert.equal(I.parseMention("mail@lead-a x", known).to.length, 0);
  assert.equal(I.parseMention("@lead-ab 안녕", known).to.length, 0); // lead-a가 아니라 lead-ab
});

test("composeChat: 칩의 글자를 범위에 맞춰 풀어 쓴다(범위가 이미 그 글자이든, 한 글자 자리표시이든)", () => {
  const tok = (start, end) => ({ range: { start, end }, token: { id: "lead-a", text: "@lead-a" } });
  assert.equal(I.composeChat({ text: "@lead-a 안녕", tokens: [tok(0, 7)] }), "@lead-a 안녕");
  assert.equal(I.composeChat({ text: "￼ 안녕", tokens: [tok(0, 1)] }), "@lead-a 안녕");
  assert.equal(I.composeChat({ text: "a ￼ b ￼", tokens: [tok(2, 3), tok(6, 7)] }), "a @lead-a b @lead-a");
  assert.equal(I.composeChat({ text: "그냥", tokens: [] }), "그냥");
  assert.equal(I.composeChat(null), "");
});

test("mentionQuery: 커서 바로 앞의 @글자만 질의이고, 칩 안이나 단어 중간은 아니다", () => {
  assert.deepEqual(I.mentionQuery("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(I.mentionQuery("안녕 @re", 6), { start: 3, end: 6, query: "re" });
  assert.equal(I.mentionQuery("안녕 @re 뒤", 3), null);
  assert.equal(I.mentionQuery("a@b", 3), null);
  assert.equal(I.mentionQuery("@lead-a ", 8), null); // 공백이 지나면 끝
  assert.equal(I.mentionQuery("@lead-a", 7, [{ range: { start: 0, end: 7 } }]), null);
  assert.deepEqual(I.mentionQuery("@lead-a @", 9, [{ range: { start: 0, end: 7 } }]), { start: 8, end: 9, query: "" });
});

test("leaderMenu: @here가 맨 위, 그다음 고른 PO의 살아 있는 리더를 세션 이름으로, 질의로 거른다", () => {
  const all = I.leaderMenu(TERMS, {}, "", 8, "devnotes");
  assert.deepEqual(all.map((x) => x.id), ["here", "lead-a", "lead-b"]); // 이름 순(글자 코드 순)
  assert.equal(all.some((x) => x.id === "lead-orphan" || x.id === "lead-c"), false); // 다른 PO나 PO 없는 리더는 뺀다
  assert.equal(all.find((x) => x.id === "lead-b").label, "받은편지함 패널");
  assert.equal(all.find((x) => x.id === "lead-a").label, "가나다"); // '리더 · ' 머리말은 뗀다
  const m = I.leaderMenu(TERMS, {}, "", 8, "mascoz");
  assert.deepEqual(m.map((x) => x.id), ["here", "lead-c"]);
  assert.equal(m.find((x) => x.id === "lead-c").label, "c"); // 제목이 없으면 hc 이름에서
  assert.deepEqual(I.leaderMenu(TERMS, {}, "받은", 8, "devnotes").map((x) => x.id), ["lead-b"]);
  assert.deepEqual(I.leaderMenu(TERMS, {}, "LEAD-A", 8, "devnotes").map((x) => x.id), ["lead-a"]);
  assert.deepEqual(I.leaderMenu(TERMS, {}, "he", 8, "devnotes").map((x) => x.id), ["here"]);
  assert.deepEqual(I.leaderMenu(TERMS, {}, "없는이름", 8, "devnotes"), []);
  assert.equal(I.leaderMenu(TERMS, {}, "", 2, "devnotes").length, 2);
  assert.deepEqual(I.leaderMenu([], {}, "", 8, "devnotes").map((x) => x.id), ["here"]);
  assert.deepEqual(I.leaderMenu(TERMS, {}).map((x) => x.id), ["here"]); // 고른 PO가 없으면 리더도 없다
  assert.deepEqual(I.leaderMenu(TERMS, {}, "", 8, I.PO_OTHER).map((x) => x.id), ["here"]); // 기타에는 리더 메뉴가 없다
});

test("leaderMenu: 닫힌 리더는 없고, 기억한 이름은 터미널 제목이 없을 때만 쓴다", () => {
  const terms = [{ address: "t1", name: "", labels: { role: "po", po: "p1" } }, { address: "t2", name: "lead-x", parent: "t1" }];
  assert.equal(I.leaderMenu(terms, { "lead-x": "기억한 이름" }, "", 8, "p1").find((x) => x.id === "lead-x").label, "기억한 이름");
  assert.deepEqual(I.leaderMenu([terms[0]], { "lead-x": "기억한 이름" }, "", 8, "p1").map((x) => x.id), ["here"]);
});

test("chatTarget: 부른 리더들의 PO, 서로 다른 PO나 PO 없는 리더는 거절, 멘션이 없으면 고른 PO", () => {
  assert.deepEqual(I.chatTarget(TERMS, ["lead-a"], "devnotes"), { po: "t28" });
  assert.deepEqual(I.chatTarget(TERMS, ["lead-a", "lead-b"], "devnotes"), { po: "t28" });
  assert.deepEqual(I.chatTarget(TERMS, ["lead-c"], "mascoz"), { po: "t40" });
  assert.deepEqual(I.chatTarget(TERMS, ["lead-a", "lead-c"], "devnotes"), { po: null, why: "many" });
  assert.deepEqual(I.chatTarget(TERMS, ["lead-orphan"], "devnotes"), { po: null, why: "orphan" });
  assert.deepEqual(I.chatTarget(TERMS, [], "devnotes"), { po: "t28" });
  assert.deepEqual(I.chatTarget(TERMS, [], "mascoz"), { po: "t40" }); // 리더가 적어도 고른 PO가 받는다
  assert.deepEqual(I.chatTarget(TERMS.slice(0, 1), [], "devnotes"), { po: "t28" }); // 리더가 없어도 고른 PO면 보낼 수 있다
  assert.deepEqual(I.chatTarget(TERMS, [], ""), { po: null, why: "none" }); // 고른 PO가 없다
  assert.deepEqual(I.chatTarget(TERMS, [], "gone"), { po: null, why: "none" }); // 닫힌 PO
  assert.deepEqual(I.chatTarget(TERMS, [], I.PO_OTHER), { po: null, why: "none" }); // 기타에는 보내지 않는다
  assert.deepEqual(I.chatTarget([{ address: "t1", name: "", labels: { role: "po" } }], [], "x"), { po: null, why: "none" });
});

test("cleanPoId·poId: 소문자·숫자·하이픈 1~40자만 id이고, po 라벨은 role=po 터미널에서만 읽는다", () => {
  assert.equal(I.cleanPoId("devnotes"), "devnotes");
  assert.equal(I.cleanPoId(" mascoz-2 "), "mascoz-2"); // 앞뒤 공백은 뗀다
  for (const bad of ["", "DevNotes", "a_b", "a b", "../x", "a/b", "a.b", "한글", null, undefined, 5 === 5 ? "x".repeat(41) : ""]) assert.equal(I.cleanPoId(bad), "", String(bad));
  assert.equal(I.cleanPoId("x".repeat(40)), "x".repeat(40));
  assert.equal(I.poId({ labels: { role: "po", po: "devnotes" } }), "devnotes");
  assert.equal(I.poId({ labels: { role: "PO", po: "devnotes" } }), "devnotes");
  assert.equal(I.poId({ labels: { role: "po" } }), ""); // po 라벨이 없다
  assert.equal(I.poId({ labels: { role: "dev", po: "devnotes" } }), ""); // PO가 아니다
  assert.equal(I.poId({ labels: { role: "po", po: "Bad Id" } }), "");
  assert.equal(I.poId({}), "");
  assert.equal(I.poId(null), "");
});

test("poList: po id가 있는 살아 있는 PO만, 터미널 제목(없으면 id)과 살아 있는 리더 수와 함께, 같은 id는 첫 터미널", () => {
  assert.deepEqual(I.poList(TERMS), [
    { id: "devnotes", address: "t28", label: "devnotes", title: "PO · DevNotes", n: 2 },
    { id: "mascoz", address: "t40", label: "mascoz", title: "", n: 1 },
  ]);
  assert.deepEqual(I.poList([{ address: "t1", labels: { role: "po" } }, { address: "t2", labels: { role: "dev", po: "x" } }]), []); // po 라벨 없음·PO 아님
  assert.deepEqual(I.poList(null), []);
  const dup = [{ address: "t1", title: "첫째", labels: { role: "po", po: "a" } }, { address: "t2", title: "둘째", labels: { role: "po", po: "a" } }];
  assert.deepEqual(I.poList(dup).map((p) => [p.id, p.address]), [["a", "t1"]]);
  assert.equal(I.poList([{ address: "t1", name: "po-main", title: "po-main", labels: { role: "po", po: "a" } }])[0].label, "a"); // 제목이 이름·주소 그대로면 id
});

test("poProject·poList: 칩 이름은 탭 이름 'PO · <프로젝트>'의 프로젝트이고, 없으면 po id, 세션 제목은 title로만 간다", () => {
  assert.equal(I.poProject({ where: "DevNotes / PO · DevNotes" }), "DevNotes");
  assert.equal(I.poProject({ where: "Mascoz / PO · Mascoz" }), "Mascoz");
  assert.equal(I.poProject({ where: "a / PO: 한글 프로젝트" }), "한글 프로젝트");
  assert.equal(I.poProject({ where: "DevNotes / PO" }), ""); // 프로젝트 이름이 없다
  assert.equal(I.poProject({ where: "DevNotes / 리더 · DevNotes" }), ""); // PO 탭이 아니다
  assert.equal(I.poProject({ where: "POSTMAN / 1" }), ""); // 공간 이름은 보지 않는다
  assert.equal(I.poProject({}), "");
  const t = { address: "t28", title: "/po 세션 중단과 하위 작업 상태", where: "DevNotes / PO · DevNotes", labels: { role: "po", po: "devnotes" } };
  const [p] = I.poList([t]);
  assert.equal(p.label, "DevNotes");
  assert.equal(p.title, "/po 세션 중단과 하위 작업 상태");
  assert.equal(I.poList([{ ...t, where: "DevNotes / 3" }])[0].label, "devnotes"); // 탭 이름에서 못 읽으면 id
});

test("main.js: 칩 줄에 PO 머리말, 이름 'PO 모름', 세션 제목은 툴팁", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const OTHER_LABEL = "PO 모름"/);
  assert.match(src, /child\("PO"\)\)\n\s+\.children\(v\.tabs/);
  assert.match(src, /세션: \$\{x\.title\}/);
  assert.doesNotMatch(src, /label: "기타"|OTHER_LABEL = "기타"/);
});

test("poFile: po/<id>.jsonl 경로만 만들고, 잘못된 id는 null이라 폴더를 벗어나지 못한다", () => {
  assert.equal(I.poFile("/h/.herdr-inbox", "devnotes"), path.join("/h/.herdr-inbox", "po", "devnotes.jsonl"));
  for (const bad of ["", "../x", "a/b", "A", "..", ".", "a.jsonl", null]) assert.equal(I.poFile("/h/.herdr-inbox", bad), null, String(bad));
});

test("leaderOwner: 살아 있는 리더는 부모 PO, 닫힌 리더는 보고에 적힌 po(그 PO가 살아 있을 때), 나머지는 기타", () => {
  const O = I.leaderOwner, X = I.PO_OTHER;
  assert.equal(O(TERMS, "lead-a", "t13"), "devnotes");
  assert.equal(O(TERMS, "lead-c", "t41"), "mascoz");
  assert.equal(O(TERMS, "lead-a", "t13", "mascoz"), "devnotes"); // 터미널이 보고의 po보다 앞선다
  assert.equal(O(TERMS, "lead-gone", "", "mascoz"), "mascoz"); // 닫힌 리더는 보고의 po
  assert.equal(O(TERMS, "lead-gone", "", "nobody"), X); // 그 PO가 닫혀 있다
  assert.equal(O(TERMS, "lead-gone", "", ""), X); // po 없음
  assert.equal(O(TERMS, "lead-gone", "", "../x"), X); // 잘못된 id
  assert.equal(O(TERMS, "lead-orphan", "t99", "devnotes"), X); // 살아 있는데 부모가 PO가 아니다: 보고의 po를 믿지 않는다
  assert.equal(O([{ address: "t1", name: "", labels: { role: "po" } }, { address: "t2", name: "lead-x", parent: "t1" }], "lead-x", "t2"), X); // 부모 PO에 po 라벨이 없다
  assert.equal(O([], "lead-a", "t1", "devnotes"), X); // PO가 하나도 안 살아 있다
});

test("choosePick: 마지막에 고른 PO(살아 있으면), 아니면 살아 있는 리더가 가장 많은 PO, 같으면 앞의 PO, 기타만 남으면 기타", () => {
  const pos = [{ id: "a", n: 1 }, { id: "b", n: 3 }, { id: "c", n: 3 }];
  assert.equal(I.choosePick(pos, "a", false), "a");
  assert.equal(I.choosePick(pos, "gone", false), "b"); // 닫힌 PO는 건너뛴다
  assert.equal(I.choosePick(pos, "", false), "b"); // 같은 3이면 앞의 b
  assert.equal(I.choosePick(pos, undefined, true), "b");
  assert.equal(I.choosePick(pos, I.PO_OTHER, true), I.PO_OTHER); // 기타에 볼 것이 남아 있으면 유지
  assert.equal(I.choosePick(pos, I.PO_OTHER, false), "b"); // 기타가 비면 기본으로
  assert.equal(I.choosePick([], "a", true), I.PO_OTHER);
  assert.equal(I.choosePick([], "a", false), "");
  assert.equal(I.choosePick([{ id: "a", n: 0 }, { id: "b", n: 0 }], "", false), "a");
});

test("#57 재현: terminals()에서 고른 PO가 잠깐 빠지면 choosePick만으로는 다른 방으로 튄다 — settlePick은 유예 동안 고른 방을 붙든다", () => {
  const now = 1_000_000;
  const both = [{ id: "a", n: 1 }, { id: "b", n: 3 }];
  const gap = [{ id: "b", n: 3 }]; // a 가 한 번의 조회에서 빠졌다
  assert.equal(I.choosePick(gap, "a", false), "b"); // 예전 동작: 쓰던 방이 b 로 바뀌고 채팅 대상도 b 의 PO가 된다
  assert.deepEqual(I.settlePick(gap, "a", false, now - 2000, now), { pick: "a", ghost: true }); // 고른 방 유지
  assert.deepEqual(I.settlePick(both, "a", false, now - 2000, now), { pick: "a", ghost: false }); // 살아 있으면 그대로
  assert.deepEqual(I.settlePick(gap, "a", false, now - I.PICK_GRACE_MS, now), { pick: "b", ghost: false }); // 유예가 지나면 되돌린다
  assert.deepEqual(I.settlePick(gap, "a", false, 0, now), { pick: "b", ghost: false }); // 산 적을 모르면(창을 막 열었다) 붙들지 않는다
  assert.deepEqual(I.settlePick(gap, "", false, 0, now), { pick: "b", ghost: false }); // 고른 적이 없으면 자동 선택
  // 'PO 모름' 방도 잠깐 비었다고 사라지지 않는다
  assert.deepEqual(I.settlePick(gap, I.PO_OTHER, false, now - 1000, now), { pick: I.PO_OTHER, ghost: true });
  assert.deepEqual(I.settlePick(gap, I.PO_OTHER, true, now - 1000, now), { pick: I.PO_OTHER, ghost: false });
  assert.deepEqual(I.settlePick([], "a", false, now - 1000, now), { pick: "a", ghost: true }); // PO가 하나도 안 보이는 순간에도
});

test("#57 재현: 답변 상자 초안은 리더가 한 번 빠졌다고 지워지지 않고, 유예가 지나야 지워진다", () => {
  const now = 5_000_000;
  const seen = new Map([["lead-a", now - 3000], ["lead-b", now - I.DRAFT_GRACE_MS - 1]]);
  const stale = (live) => I.staleDrafts(["lead-a", "lead-b", "lead-c"], new Set(live), seen, now);
  assert.deepEqual(stale([]), ["lead-b", "lead-c"]); // a 는 방금 있었다 → 남긴다, 본 적 없는 c 는 바로 지운다
  assert.deepEqual(stale(["lead-b"]), ["lead-c"]);
  assert.deepEqual(stale(["lead-a", "lead-b", "lead-c"]), []);
});

test("#57: view()는 settlePick으로 고른 방을 붙들고, 자동으로 고른 방도 저장해 리더 수에 따라 떠다니지 않게 한다", () => {
  const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(MAIN, /settlePick\(pos, last, hasOther, this\.pickLive\.id === last \? this\.pickLive\.at : 0, now\)/);
  assert.match(MAIN, /if \(pick && pick !== last\) \{ try \{ setShared\(PICK_KEY, pick\); \} catch \{\} \}/);
  assert.match(MAIN, /settled\.ghost && !rooms\.some/); // 붙든 방은 방 목록에도 남는다
  assert.match(MAIN, /staleDrafts\(this\.inputs\.keys\(\), live, this\.inputSeen, now\)/);
  const chat = (src) => src.slice(src.indexOf("// chat:begin"), src.indexOf("// chat:end"));
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.equal(chat(MAIN), chat(cjs));
});

test("parseLines·summarize: 보고 줄의 po는 규칙에 맞을 때만 읽고, 리더의 po는 가장 최근 줄의 것이다", () => {
  const l1 = JSON.stringify({ ts: "2026-01-01T00:00:00Z", kind: "done", po: "devnotes" });
  const l2 = JSON.stringify({ ts: "2026-01-02T00:00:00Z", kind: "done" });
  const l3 = JSON.stringify({ ts: "2026-01-03T00:00:00Z", kind: "done", po: "Bad Id" });
  assert.deepEqual(I.parseLines([l1, l2, l3].join("\n")).map((x) => x.po), ["devnotes", "", ""]);
  assert.equal(I.summarize("lead-a", [l1, l2].join("\n")).po, "devnotes"); // po가 없는 줄은 건너뛰고 있는 줄의 것
  assert.equal(I.summarize("lead-a", l2).po, "");
  assert.equal(I.summarize("lead-a", [l1, l3].join("\n")).po, "devnotes"); // 잘못된 id는 없는 것과 같다
});

test("parsePoLines: say 줄만, 오래된 것부터, 깨진 줄·모르는 종류·빈 글·잘못된 시각은 건너뛴다", () => {
  const l = (o) => JSON.stringify(o);
  const t = [
    l({ ts: "2026-01-01T00:00:02Z", kind: "say", text: " 두번째 ", to: "lead-a", extra: 1 }),
    "not json",
    l({ ts: "2026-01-01T00:00:01Z", kind: "say", text: "첫번째" }),
    l({ ts: "2026-01-01T00:00:03Z", kind: "other", text: "x" }),
    l({ ts: "2026-01-01T00:00:04Z", kind: "say", text: "   " }),
    l({ ts: "어제", kind: "say", text: "시각 없음" }),
    l({ ts: "2026-01-01T00:00:05Z", kind: "say", text: 5 }),
    '{"ts":"2026-01-01T00:00:06Z","kind":"say","te',
  ].join("\n");
  const out = I.parsePoLines(t);
  assert.deepEqual(out.map((x) => [x.text, x.to]), [["첫번째", ""], ["두번째", "lead-a"]]);
  assert.equal(out[0].extra, undefined);
  assert.equal(typeof out[0].ms, "number");
});

test("parsePoLines: 최근 100줄만 남긴다. 빈 글은 빈 목록", () => {
  const many = Array.from({ length: 130 }, (_, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), kind: "say", text: String(i) })).join("\n");
  const out = I.parsePoLines(many);
  assert.equal(out.length, 100);
  assert.equal(out[99].text, "129");
  assert.deepEqual(I.parsePoLines(""), []);
  assert.deepEqual(I.parsePoLines(undefined), []);
});

test("collect: po/<id>.jsonl을 PO별로 읽고, 옛 po.jsonl과 잘못된 파일 이름은 무시하며, 리더로 보이지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-po-"));
  fs.writeFileSync(path.join(dir, "lead-a.jsonl"), text({ ts: "2026-01-01T00:00:00Z", kind: "done", po: "devnotes" }));
  assert.deepEqual(I.collect(dir).po, {}); // 폴더 없음
  fs.mkdirSync(path.join(dir, "po"));
  fs.writeFileSync(path.join(dir, "po", "devnotes.jsonl"), ""); // 빈 파일
  assert.deepEqual(I.collect(dir).po, {}); // 줄이 없는 파일은 항목이 아니다
  const line = (t, to) => JSON.stringify({ ts: "2026-01-02T00:00:00Z", kind: "say", text: t, to }) + "\n";
  fs.writeFileSync(path.join(dir, "po", "devnotes.jsonl"), line("안녕하세요", "here"));
  fs.writeFileSync(path.join(dir, "po", "mascoz.jsonl"), line("마스코즈", ""));
  fs.writeFileSync(path.join(dir, "po", "Bad.jsonl"), line("버려진다", "")); // id 규칙에 안 맞는 파일 이름
  fs.writeFileSync(path.join(dir, "po", "notes.txt"), "x");
  fs.writeFileSync(path.join(dir, "po.jsonl"), line("옛 파일", "")); // 옛 전역 파일: 읽지 않고 리더도 아니다
  const d = I.collect(dir);
  assert.deepEqual(d.leaders.map((x) => [x.leader, x.po]), [["lead-a", "devnotes"]]);
  assert.deepEqual(Object.keys(d.po).sort(), ["devnotes", "mascoz"]);
  assert.deepEqual(d.po.devnotes.map((x) => [x.text, x.to]), [["안녕하세요", "here"]]);
  assert.deepEqual(d.po.mascoz.map((x) => x.text), ["마스코즈"]);
  assert.deepEqual(I.readPo(dir), d.po);
  assert.deepEqual(I.collect(path.join(dir, "none")), { at: I.collect(path.join(dir, "none")).at, dir: path.join(dir, "none"), root: I.appRoot(), leaders: [], po: {}, imgd: {}, cost: {}, names: I.plainNames(), profileError: "" });
});

test("chat 블록: main.js가 inbox.cjs와 한 글자도 다르지 않은 같은 블록을 쓴다", () => {
  const block = (f) => {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
    const a = src.indexOf("// chat:begin"), b = src.indexOf("// chat:end");
    assert.ok(a >= 0 && b > a, f);
    return src.slice(a, b);
  };
  assert.equal(block("../mods/inbox/main.js"), block("../mods/inbox/inbox.cjs"));
});

test("parseMention: 글 가운데 @here는 빠지고 남는 공백·문장부호를 정리한다, 모르는 @lead는 글에 그대로 남는다", () => {
  const known = ["lead-a"];
  assert.equal(I.parseMention("확인해 줘 @here 부탁해", known).text, "확인해 줘 부탁해");
  assert.equal(I.parseMention("확인해 줘 @here, 부탁해", known).text, "확인해 줘, 부탁해");
  assert.equal(I.parseMention("@here, 부탁해", known).text, "부탁해");
  const u = I.parseMention("@lead-zzz 이거 해줘", known);
  assert.deepEqual([u.text, u.to, u.empty], ["@lead-zzz 이거 해줘", [], false]);
});

// ---- 메신저 타임라인 (PO별 방)
const sumOf = (leader, ...items) => ({ leader, items: items.map((i) => ({ ...i, ms: Date.parse(i.ts) })) });
const T = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();

test("timeline: 방에 속한 리더 보고와 PO 말, 내가 보낸 글이 시간순(오래된 것이 위)으로 한 줄에 섞이고 answered·start는 빠진다", () => {
  const a = sumOf("lead-a", { ts: T(5), kind: "done" }, { ts: T(1), kind: "decision" }, { ts: T(2), kind: "answered" }, { ts: T(0), kind: "start" });
  const b = sumOf("lead-b", { ts: T(3), kind: "verify" });
  const says = [{ ts: T(4), ms: Date.parse(T(4)), text: "PO 말", to: "lead-a" }];
  const mine = [{ ts: T(6), ms: Date.parse(T(6)), text: "내 글", to: "lead-a", po: "p1" }];
  const t = I.timeline("p1", [{ s: a, owner: "p1" }, { s: b, owner: "p1" }], says, mine);
  assert.deepEqual(t.map((e) => e.who), ["l:lead-a", "l:lead-b", "po", "l:lead-a", "me"]);
  assert.deepEqual(t.map((e) => e.ms), t.map((e) => e.ms).slice().sort((x, y) => x - y));
  assert.equal(t.filter((e) => e.it && (e.it.kind === "answered" || e.it.kind === "start")).length, 0);
});

test("timeline: 다른 PO의 리더·내 글은 들어오지 않고, PO 모름 방에는 PO 말이 없다", () => {
  const a = sumOf("lead-a", { ts: T(1), kind: "done" });
  const b = sumOf("lead-b", { ts: T(2), kind: "done" });
  const says = [{ ts: T(3), ms: Date.parse(T(3)), text: "x", to: "" }];
  const mine = [{ ts: T(4), ms: Date.parse(T(4)), text: "y", to: "", po: "p2" }];
  const t1 = I.timeline("p1", [{ s: a, owner: "p1" }, { s: b, owner: "p2" }], says, mine);
  assert.deepEqual(t1.map((e) => e.who), ["l:lead-a", "po"]);
  const t0 = I.timeline(I.PO_OTHER, [{ s: a, owner: "p1" }, { s: b, owner: I.PO_OTHER }], says, []);
  assert.deepEqual(t0.map((e) => e.who), ["l:lead-b"]);
});

test("timeline: 같은 시각은 입력 순서를 지키고, 같은 보고가 두 번 와도 한 번만 나온다", () => {
  const a = sumOf("lead-a", { ts: T(1), kind: "done" }, { ts: T(1), kind: "done" });
  const says = [{ ts: T(1), ms: Date.parse(T(1)), text: "x" }];
  const t = I.timeline("p1", [{ s: a, owner: "p1" }], says, []);
  assert.deepEqual(t.map((e) => e.who), ["l:lead-a", "po"]);
});

test("timeline: 대기 중인 보고에는 waiting 표시가 붙고, 보고가 목록에 없으면 맨 아래에 대기 항목을 하나 만든다", () => {
  const a = sumOf("lead-a", { ts: T(1), kind: "decision" }, { ts: T(2), kind: "done" });
  const t = I.timeline("p1", [{ s: a, owner: "p1" }], [], [], [{ leader: "lead-a", ts: T(1), kind: "decision" }], Date.parse(T(9)));
  assert.equal(t.find((e) => e.it?.kind === "decision").waiting, "decision");
  assert.equal(t.some((e) => e.wait), false);
  const t2 = I.timeline("p1", [{ s: a, owner: "p1" }], [], [], [{ leader: "lead-z", ts: "", kind: "verify" }], Date.parse(T(9)));
  const last = t2[t2.length - 1];
  assert.deepEqual([last.wait, last.leader, last.waiting, last.ms], [true, "lead-z", "verify", Date.parse(T(9))]);
});

test("groupTimeline: 같은 사람이 5분 안에 이어 쓰면 머리말을 접고, 사람이 바뀌거나 5분이 지나면 다시 단다", () => {
  const m = (who, min) => ({ who, ms: min * 60000 });
  const g = I.groupTimeline([m("l:a", 0), m("l:a", 4), m("l:a", 10), m("po", 11), m("l:a", 12), m("l:b", 12), m("l:b", 17)]);
  assert.deepEqual(g.map((e) => e.head), [true, false, true, true, true, true, false]);
  assert.equal(I.TL_GAP_MS, 300000);
  assert.deepEqual(I.groupTimeline([]), []);
  assert.equal(I.groupTimeline([m("me", 0), m("me", 5)])[1].head, false); // 정확히 5분은 접힌다
});

test("unreadCount: 마지막으로 연 시각 뒤의 남의 메시지만 세고, 내 글과 대기 항목은 세지 않는다", () => {
  const e = [{ who: "l:a", ms: 10 }, { who: "po", ms: 20 }, { who: "me", ms: 30 }, { who: "l:a", ms: 40, wait: true }, { who: "l:b", ms: 50 }];
  assert.equal(I.unreadCount(e, 0), 3); // 한 번도 안 연 방은 전부
  assert.equal(I.unreadCount(e, 10), 2);
  assert.equal(I.unreadCount(e, 50), 0);
  assert.equal(I.unreadCount([], 0), 0);
  assert.equal(I.unreadCount(e, undefined), 3);
});

test("seenNext: 방을 열면 가장 새 메시지 시각을 기억하고, 달라질 게 없으면 null", () => {
  const e = [{ who: "l:a", ms: 10 }, { who: "po", ms: 20 }, { who: "l:a", ms: 99, wait: true }];
  assert.deepEqual(I.seenNext({ x: 5 }, "p1", e), { x: 5, p1: 20 });
  assert.equal(I.seenNext({ p1: 20 }, "p1", e), null);
  assert.equal(I.seenNext({}, "p1", []), null);
  assert.equal(I.seenNext({}, "", e), null);
  assert.deepEqual(I.seenNext(null, "p1", e), { p1: 20 });
});

test("tlFollow: 방을 바꿨거나 창을 막 열 때, 그리고 맨 아래에 있는 중 새 글이 올 때만 맨 아래로 간다", () => {
  const a = [{ ms: 1, key: "k1" }];
  const b = [...a, { ms: 2, key: "k2" }];
  const ka = I.tlKey("p1", a), kb = I.tlKey("p1", b);
  assert.notEqual(ka, kb);
  assert.equal(I.tlFollow("", ka, false), true); // 창을 막 열었다
  assert.equal(I.tlFollow(ka, ka, true), false); // 같은 상태
  assert.equal(I.tlFollow(ka, kb, true), true); // 맨 아래에서 새 글
  assert.equal(I.tlFollow(ka, kb, false), false); // 위로 올려 읽는 중
  assert.equal(I.tlFollow(ka, I.tlKey("p2", a), false), true); // 방을 바꿨다
  assert.equal(I.tlFollow(null, ka, false), true);
});

test("atBottom: 스크롤 위치+보이는 높이가 내용 높이 가까이면 맨 아래", () => {
  assert.equal(I.atBottom(500, 300, 800), true);
  assert.equal(I.atBottom(499.5, 300, 800), true);
  assert.equal(I.atBottom(100, 300, 800), false);
  assert.equal(I.atBottom(0, 300, 200), true); // 내용이 짧다
  assert.equal(I.atBottom(undefined, undefined, undefined), true);
});

test("chatHtml: HTML을 이스케이프하고 줄마다 문단으로 나누며 http(s) 링크만 누를 수 있게 하고 끝 문장부호는 뺀다", () => {
  assert.equal(I.chatHtml("a<b>&\"c\""), "<p>a&lt;b&gt;&amp;&quot;c&quot;</p>");
  assert.equal(I.chatHtml("위\n\n아래"), "<p>위</p><p>&nbsp;</p><p>아래</p>");
  assert.equal(I.chatHtml("보세요 https://x.io/a?b=1&c=2). 끝"), "<p>보세요 <a href=\"https://x.io/a?b=1&amp;c=2\">https://x.io/a?b=1&amp;c=2</a>). 끝</p>");
  assert.equal(I.chatHtml("javascript:alert(1) ftp://x"), "<p>javascript:alert(1) ftp://x</p>");
  assert.equal(I.chatHtml(""), "<p>&nbsp;</p>");
  assert.equal(I.chatHtml("a\r\nb"), "<p>a</p><p>b</p>");
});

test("parseMention: 줄바꿈과 빈 줄은 지키고, 줄 끝 공백·연속 빈 줄·CRLF만 정리한다", () => {
  const known = ["lead-a"];
  assert.equal(I.parseMention("첫 줄  \r\n\n\n\n  셋째   줄\n", known).text, "첫 줄\n\n셋째 줄");
  assert.equal(I.parseMention("@lead-a 위\n아래", known).text, "@lead-a 위\n아래");
  assert.deepEqual(I.parseMention("@lead-a 위\n아래", known).to, ["lead-a"]);
  assert.equal(I.parseMention("@here 안녕\n둘째 줄", known).text, "안녕\n둘째 줄");
  assert.equal(I.parseMention("a\n@here, b", known).text, "a\nb"); // 줄 맨 앞 @here는 줄바꿈을 먹지 않는다
  assert.equal(I.parseMention("a @here, b\nc", known).text, "a, b\nc");
  assert.equal(I.parseMention("\n\n  \n", known).empty, true);
  assert.equal(I.parseMention("@here\n@lead-a\n", known).empty, true);
});

test("enterIntent: Shift+Enter는 줄바꿈, Enter(Cmd/Ctrl 포함)는 보내기, 다른 키는 아무것도 아니다", () => {
  assert.equal(I.enterIntent("enter", true), "newline");
  assert.equal(I.enterIntent("Enter", false), "send");
  assert.equal(I.enterIntent("return", false), "send");
  assert.equal(I.enterIntent("a", false), "");
  assert.equal(I.enterIntent(undefined, true), "");
});

test("needsNewline·strayBreak: 위젯이 줄바꿈을 이미 넣었으면 더 넣지 않고, 보낸 뒤 남은 빈 줄만 지운다", () => {
  assert.equal(I.needsNewline(0, 1000), true); // 편집이 없었다
  assert.equal(I.needsNewline(990, 1000), false); // 키와 같은 때 위젯이 넣었다
  assert.equal(I.needsNewline(1010, 1000), false);
  assert.equal(I.needsNewline(500, 1000), true);
  assert.equal(I.strayBreak("\n", 1000, 1050), true);
  assert.equal(I.strayBreak("\n", 1000, 1500), false); // 한참 뒤 사람이 친 줄바꿈은 지우지 않는다
  assert.equal(I.strayBreak("글", 1000, 1050), false);
  assert.equal(I.strayBreak("", 1000, 1050), false);
});

test("main.js: 채팅 입력은 Textarea, Enter는 붙여넣고 hc keys enter까지, 막힌 PO에는 Enter를 누르지 않는다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /TextareaState\.new\(/);
  assert.match(src, /Textarea\.new\(this\.chat\)/);
  assert.match(src, /hc\(\["keys", po, "enter"\]\)/);
  assert.ok(!/hc\(\["send"/.test(src.replaceAll('hc(["send", "--json", "--", po, text])', "")));
  assert.match(src, /=== "blocked"/);
  assert.match(src, /enterIntent\(e\?\.key, Boolean\(e\?\.modifiers\?\.shift\)\)/);
  assert.match(src, /PO에 보내기/);
  const body = deliverOf(src);
  assert.ok(body.indexOf('run("terminal.paste"') > 0 && body.indexOf("this.submitPo(") > body.indexOf('run("terminal.paste"')); // 붙여넣은 뒤에 Enter
  assert.match(src, /import \{[^}]*\bhc\b[^}]*\} from "herdr"/);
});

test("main.js: 창은 고른 PO 하나만 보이고(카드·보고·@ 목록·채팅 대상·PO 답글), 이름은 'PO 데스크'다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /const PICK_KEY = "inbox\.po"/);
  assert.match(src, /choosePick\(pos, last, hasOther\)/);
  assert.match(src, /leaderMenu\(this\.liveTerms\(\), namesMemo\(\), q\.query, 8, this\.view\(\)\.pick\)/);
  assert.match(src, /chatTarget\(terms, p\.to, v\.pick\)/);
  assert.match(src, /for \(const x of mine \?\? \[\]\) if \(x\.po === room\)/); // 내 글은 그 방의 것만
  assert.match(src, /this\.data\?\.po\?\.\[id\]/); // PO 답글도 그 방의 것만
  assert.match(src, /po: v\.pick, kind: "chat" \}/); // 보낸 글에 PO를 적어 둔다
  assert.match(src, /setShared\(PICK_KEY, id\)/);
  assert.match(src, /child\("PO 데스크"\)/);
  assert.ok(!/받은편지함/.test(src));
  // 배지·탭 개수는 PO와 상관없이 기다리는 리더 전부
  const badge = src.slice(src.indexOf("  badge() {"), src.indexOf("  // The \"pasted into the PO\""));
  assert.match(badge, /this\.asks\(\)/);
  assert.ok(!/view\(\)/.test(badge));
});

test("imeHold: 글을 막 고쳤거나 한글·가나·한자로 끝나면 첫 Enter는 한 번 붙들고, 그 뒤 편집 없는 Enter는 보낸다", () => {
  assert.equal(I.imeHold("hello", 1000, 0, 1200), true); // 막 친 글: 500ms 안
  assert.equal(I.imeHold("hello", 1000, 0, 1600), false); // 한참 전, 영문 끝: 바로 보낸다
  assert.equal(I.imeHold("안녕", 1000, 0, 5000), true); // 조합 중일 수 있는 한글 끝
  assert.equal(I.imeHold("안녕 ", 1000, 0, 5000), true); // 끝 공백은 무시
  assert.equal(I.imeHold("안녕.", 1000, 0, 5000), false); // 마침표로 끝나면 조합이 끝난 글
  assert.equal(I.imeHold("ありがとう", 1000, 0, 5000), true);
  assert.equal(I.imeHold("你好", 1000, 0, 5000), true);
  assert.equal(I.imeHold("ㅎ", 1000, 0, 5000), true); // 자모
  // 붙든 뒤 두 번째 Enter: 그 사이 편집이 없으면(확정이 만든 100ms 안 편집 포함) 보낸다
  assert.equal(I.imeHold("안녕", 1000, 5000, 6000), false);
  assert.equal(I.imeHold("안녕", 5050, 5000, 6000), false);
  // 붙든 뒤 새로 쳤으면 다시 붙든다
  assert.equal(I.imeHold("안녕하", 5500, 5000, 5600), true);
  assert.equal(I.imeHold("", 0, 0, 100), true);
});

test("poFile: 앞뒤 공백이 낀 id는 다듬은 id로 파일을 만든다", () => {
  assert.equal(I.poFile("/h/x", " devnotes "), path.join("/h/x", "po", "devnotes.jsonl"));
  assert.equal(I.poFile("/h/x", " a/b "), null);
});

test("main.js: Enter 전송은 imeHold를 거치고, PO 라벨이 없으면 안내를 보인다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /imeHold\(value, this\.editAt, this\.heldAt, now\)/); // 글자가 바뀐 때 기준(위젯이 넣은 줄바꿈은 편집이 아니다)
  assert.match(src, /id\("po-hint"\)/);
  assert.match(src, /\.child\(this\.picker\(t, v\)\)/); // 전체 보기는 PO가 0개여도 안내를 그린다
});

test("holdShown: 붙든 Enter가 둘째 Enter를 기다리는 동안만 안내를 보인다", () => {
  assert.equal(I.holdShown(1000, 0), false);
  assert.equal(I.holdShown(1000, 5000), true);
  assert.equal(I.holdShown(5050, 5000), true); // 확정이 만든 편집
  assert.equal(I.holdShown(5500, 5000), false); // 새로 쳤다
});

test("main.js: 붙든 Enter 안내를 그리고, PO를 고르거나 보내면 heldAt을 비운다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /한 번 더 Enter로 보냅니다/);
  assert.match(src, /pickPo\(id, c\) \{\n\s+this\.heldAt = 0;/);
  assert.match(src, /sendChat\(c\) \{\n\s+this\.sentAt = Date\.now\(\);\n\s+this\.heldAt = 0;/);
  assert.match(src, /this\.heldAt = now;\n[^\n]*\n\s+c\.notify\(\);/);
});

// ---- 결정 보고의 N안 칩(리더 보고 규칙의 고정 형식 "1안: …" / "추천: N안")
test("decisionOptions: '1안: …' 줄이 서로 다른 번호로 둘 이상일 때만 선택지로 본다", () => {
  const body = "결정이 필요합니다.\n1안: 지금 합친다\n2안: 다음 주에 합친다\n3안: 안 합친다";
  assert.deepEqual(I.decisionOptions(body), { options: [1, 2, 3], recommended: 0 });
  assert.deepEqual(I.decisionOptions("- 1안: 가\n* 2안：나"), { options: [1, 2], recommended: 0 }); // 글머리·전각 콜론
  assert.deepEqual(I.decisionOptions("1안) 가\n  2안: 나"), { options: [1, 2], recommended: 0 });
  assert.deepEqual(I.decisionOptions("1안: 가\n1안: 같은 번호"), { options: [], recommended: 0 }); // 서로 다른 번호 둘 미만
  assert.deepEqual(I.decisionOptions("1안: 하나뿐"), { options: [], recommended: 0 });
  assert.deepEqual(I.decisionOptions("2안: 나\n3안: 다"), { options: [2, 3], recommended: 0 }); // 1부터가 아니어도 번호 그대로
});

test("decisionOptions: 추천 줄은 그 칩만 primary로 가리킨다(없는 번호면 무시)", () => {
  assert.deepEqual(I.decisionOptions("1안: 가\n2안: 나\n추천: 2안 (이유)"), { options: [1, 2], recommended: 2 });
  assert.deepEqual(I.decisionOptions("1안: 가\n2안: 나\n- 추천：1안"), { options: [1, 2], recommended: 1 });
  assert.deepEqual(I.decisionOptions("1안: 가\n2안: 나\n추천: 3안"), { options: [1, 2], recommended: 0 });
  assert.deepEqual(I.decisionOptions("추천: 1안\n1안: 가"), { options: [], recommended: 0 }); // 선택지가 둘 미만이면 추천도 없다
});

test("decisionOptions: 다른 형식은 추측하지 않는다(A:, 1), ①, 번호 목록, 4안, 문장 중간)", () => {
  for (const body of ["A: 가\nB: 나", "1) 가\n2) 나", "① 가\n② 나", "1. 첫 단계\n2. 둘째 단계", "4안: 가\n5안: 나", "옵션 1안: 가\n옵션 2안: 나", "1안:\n2안:", "1안 가\n2안 나", "", null, undefined])
    assert.deepEqual(I.decisionOptions(body), { options: [], recommended: 0 }, String(body));
});

test("main.js: 칩은 대기 중인 결정(decision) 말풍선에만, 같은 send() 길로, 추천만 primary", () => {
  const src = mainSrc();
  const a = src.indexOf("  askActions(t, a, cx) {");
  const body = src.slice(a, src.indexOf("    if (!a.po) box.child", a));
  assert.match(body, /const opts = kind === "decision" \? decisionOptions\(item\?\.body\)/); // 한 번만 계산
  assert.match(body, /kind === "decision" \? opts\.options\.map/);
  assert.match(body, /`\$\{n\}안 선택`/);
  assert.match(body, /this\.send\(a, `\$\{n\}안 선택`, c, "choice"\)/);
  assert.match(body, /primary: n === opts\.recommended/);
  assert.match(body, /disabled: a\.po \? "" : NO_PO\(\), tip: CLIP/);
  assert.ok(body.indexOf("opt-") < body.indexOf("`ok-${s.leader}`") && body.indexOf("`ok-${s.leader}`") < body.indexOf("`write-${s.leader}`")); // 칩 → 확인 완료 → 답 쓰기
  // verify에는 칩이 없다(확인 완료만): 칩은 kind === "decision" 안에서만 만든다
  assert.equal((body.match(/decisionOptions\(/g) ?? []).length, 1);
  assert.match(body, /kind === "verify", \(el\)/);
});

test("decisionOptions: inbox.cjs와 main.js의 chat 블록이 같다", () => {
  const cut = (f) => { const s = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n"); const a = s.indexOf("function decisionOptions("); return s.slice(a, s.indexOf("\n}\n", a)); };
  assert.equal(cut("../mods/inbox/main.js"), cut("../mods/inbox/inbox.cjs"));
});

// ---- #62: N안 줄이 없는 결정도 선택지(추천·답 줄, 따옴표 답)를 펼치지 않고 보인다
test("decisionHints: 추천·답 줄을 그대로 뽑고, 답 뒤 따옴표 둘~여섯 개를 답 버튼으로, 추천이 들어 있는 답이 primary", () => {
  const body = '결정이 필요합니다.\n추천: 둘 다 진행. 답: "둘 다 진행" / "1번만" / "2번만" / "보류"';
  assert.deepEqual(I.decisionHints(body), { lines: ["추천: 둘 다 진행", '답: "둘 다 진행" / "1번만" / "2번만" / "보류"'], answers: ["둘 다 진행", "1번만", "2번만", "보류"], recommended: "둘 다 진행" });
  assert.deepEqual(I.decisionHints("- 추천: 가\n- 답: “가” / “나”"), { lines: ["추천: 가", "답: “가” / “나”"], answers: ["가", "나"], recommended: "가" }); // 글머리·둥근 따옴표
  assert.deepEqual(I.decisionHints("추천: 1안"), { lines: ["추천: 1안"], answers: [], recommended: "" }); // 답 줄이 없으면 글자만
});
test("decisionHints: 다른 형식은 추측하지 않는다(정답:, 답변:, 따옴표 하나, 일곱 개 이상)", () => {
  assert.deepEqual(I.decisionHints('정답: "가" / "나"'), { lines: [], answers: [], recommended: "" });
  assert.deepEqual(I.decisionHints('답변: "가" / "나"'), { lines: [], answers: [], recommended: "" });
  assert.deepEqual(I.decisionHints('답: "가"'), { lines: ['답: "가"'], answers: [], recommended: "" }); // 줄은 보이지만 버튼은 없다
  assert.deepEqual(I.decisionHints('답: "1" "2" "3" "4" "5" "6" "7"').answers, []);
  assert.deepEqual(I.decisionHints("그냥 문장입니다"), { lines: [], answers: [], recommended: "" });
  assert.deepEqual(I.decisionHints(undefined), { lines: [], answers: [], recommended: "" });
  assert.ok(I.decisionHints(`추천: ${"가".repeat(300)}`).lines[0].length <= 160); // 긴 줄은 자른다
});
test("main.js: 추천·답 줄과 답 버튼은 N안 칩이 없는 결정 카드에만, 같은 send() 길로", () => {
  const src = mainSrc();
  const a = src.indexOf("  askActions(t, a, cx) {");
  const body = src.slice(a, src.indexOf("    if (!a.po) box.child", a));
  assert.match(body, /const hint = kind === "decision" && opts\.options\.length < 2 \? decisionHints\(item\?\.body\)/);
  assert.match(body, /hint\.lines\.map/);
  assert.match(body, /hint\.answers\.map/);
  assert.match(body, /this\.send\(a, w, c, "choice"\)/);
  assert.match(body, /primary: w === hint\.recommended/);
  assert.ok(body.indexOf("hint-") < body.indexOf("ans-") && body.indexOf("opt-") < body.indexOf("ans-") && body.indexOf("ans-") < body.indexOf("`ok-${s.leader}`"));
});
test("decisionHints: inbox.cjs와 main.js의 chat 블록이 같다", () => {
  const cut = (f) => { const s = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n"); const a = s.indexOf("function decisionHints("); return s.slice(a, s.indexOf("\n}\n", a)); };
  assert.ok(cut("../mods/inbox/main.js").length > 100);
  assert.equal(cut("../mods/inbox/main.js"), cut("../mods/inbox/inbox.cjs"));
});

// ---- 내가 보낸 모든 글을 오른쪽 말풍선으로 (deliver 한 곳에서 한 번 기록)
test("chatRecord: 사람이 쓴 글만 담고(긴 Panel answer 감싸개 없이), 종류·상태는 정해진 값만", () => {
  const r = I.chatRecord({ text: " 확인 완료 ", to: "lead-a", po: "p1", kind: "verify" }, "held", 1700000000000);
  assert.deepEqual(r, { id: "1700000000000-", at: 1700000000000, ts: new Date(1700000000000).toISOString(), ms: 1700000000000, text: "확인 완료", line: "확인 완료", to: "lead-a", po: "p1", kind: "verify", status: "held", ak: "" });
  const w = I.chatRecord({ text: "확인 완료", line: 'Panel answer (verify) for lead-a: "확인 완료".', po: "p1" }, "sending", 5, "ab3");
  assert.equal(w.id, "5-ab3"); // 같은 ms에 두 번 보내도 id가 겹치지 않게 seq를 붙인다
  assert.equal(w.text, "확인 완료"); // 말풍선에는 사람이 쓴 글
  assert.match(w.line, /^Panel answer/); // 다시 보내기는 실제로 붙여 넣은 줄 그대로
  assert.equal(I.chatRecord({ text: "  ", po: "p1" }, "sent", 1), null); // 빈 글
  assert.equal(I.chatRecord({ text: "x", po: "" }, "sent", 1), null); // 방 없음
  const odd = I.chatRecord({ text: "x", po: "p1", kind: "zzz" }, "weird", 5);
  assert.equal(odd.kind, "chat");
  assert.equal(odd.status, "failed"); // 모르는 상태는 '보내지 못함'으로 둔다(보냈다고 거짓 표시 금지)
  assert.deepEqual(I.CHAT_KINDS, ["answer", "verify", "choice", "chat"]);
});

test("mineNote: 보낸 것은 비고, 붙여 넣기만 했거나 못 보낸 것은 작은 안내가 붙는다", () => {
  assert.equal(I.mineNote("sent"), "");
  assert.match(I.mineNote("held"), /붙여 넣기만/);
  assert.match(I.mineNote("nopane"), /보내지 못함/);
  assert.match(I.mineNote("failed"), /보내지 못함/);
  assert.match(I.mineNote("gone"), /입력창/);
  assert.match(I.mineNote("held", true), /붙여 넣기만/); // 아직 질문 중
  assert.match(I.mineNote("held", false, 1000), /질문에 답했습니다/);
  assert.match(I.mineNote("held", false, 11 * 60000), /다시 보내세요/);
  assert.match(I.mineNote("noenter", false, 11 * 60000), /다시 보내세요/);
});

test("timeline: 내 글은 그 방(po)에만, 종류·상태·받는 리더를 달고 오른쪽 말풍선 데이터가 된다(옛 기록은 chat·sent)", () => {
  const mine = [
    { ts: "a", ms: 10, text: "1안 선택", to: "lead-a", po: "p1", kind: "choice", status: "sent" },
    { ts: "b", ms: 20, text: "답", to: "lead-a", po: "p1", kind: "answer", status: "nopane" },
    { ts: "c", ms: 30, text: "다른 방", to: "lead-b", po: "p2", kind: "chat", status: "sent" },
    { ts: "d", ms: 5, text: "옛 기록", to: "", po: "p1" },
  ];
  const t = I.timeline("p1", [], [], mine).filter((e) => e.who === "me");
  assert.deepEqual(t.map((e) => [e.text, e.kind, e.status, e.to]), [["옛 기록", "chat", "sent", ""], ["1안 선택", "choice", "sent", "lead-a"], ["답", "answer", "nopane", "lead-a"]]);
  assert.equal(I.unreadCount(t, 0), 0); // 내 글은 안 읽은 글이 아니다
});

test("main.js: 모든 데스크 보내기는 deliver 한 곳에서 한 번만 기록하고, 말풍선은 오른쪽(내 것)·왼쪽(리더·PO)에 시간을 바깥 아래에 둔다", () => {
  const src = mainSrc();
  const del = deliverOf(src);
  assert.equal((src.match(/setShared\(CHAT_KEY/g) ?? []).length, 2); // 쓰는 곳은 record()(새 글)와 mark()(상태 바꿈) 둘뿐
  assert.equal((del.match(/this\.record\(/g) ?? []).length, 1); // 새 기록은 deliver 한 곳에서 한 번(다시 보내기는 같은 id로 상태만 바꾼다)
  assert.match(del, /if \(!id\) id = this\.record\(\{ \.\.\.rec, line: text \}, "sending"\)/);
  for (const st of ["failed", "held", "nopane"]) assert.match(del, new RegExp(`this\\.mark\\(id, "${st}"\\)`));
  assert.match(src, /\{ text: body, imgs: pics\.map\(\(x\) => x\.path\), to: a\.s\.leader, po: a\.owner, kind, ak: this\.askKey\(a\) \}/); // 버튼·칩·답 상자는 사람이 쓴 글(body)을 기록한다
  assert.match(src, /send\(a, "확인 완료", c, "verify"\)/);
  assert.match(src, /send\(a, `\$\{n\}안 선택`, c, "choice"\)/);
  assert.ok(!/answerLine\([^)]*\)[^;]*kind: "chat"/.test(src));
  // 모양: 내 것은 오른쪽(items_end/justify_end)·강조색 채움, 시간은 말풍선 왼쪽; 남의 것은 말풍선 오른쪽 아래에 시간
  const row = methodOf(src, "  entryRow(t, e, v, cx) {", "  render(cx)");
  assert.match(row, /justify_end\(\)/);
  assert.match(row, /bg\(t\.working \+ "33"\)/);
  assert.match(row, /\.child\(this\.sideTools\(t, id, e\.text, e\.ms\)\)\s*\n\s*\.child\(v_flex\(\)\.flex_none\(\)\.w\(width\)\.max_w\(cap \?\? "75%"\)/); // 내 말풍선: 시간이 말풍선 앞(왼쪽), 폭은 글에서 정한다
  assert.match(row, /items_end\(\)\s*\n\s*\.child\(div\(\)\.flex_1\(\)\.min_w\(0\)\.max_w\(this\.capOf\(\) \?\? "75%"\)\.px\(12\)/); // PO: 말풍선 뒤(오른쪽)에 시간
  assert.match(row, /mineNote\(e\.status, blockedNow, age\)/);
  assert.ok(!/clock\(it\.ms\)/.test(methodOf(src, "  nameRow(t,", "  // What a waiting leader"))); // 머리줄에서 시간이 빠졌다
});

test("setChatStatus: 그 id의 기록만 상태와 시각을 바꾸고, 같은 상태·없는 id·모르는 상태는 바꾸지 않는다", () => {
  const list = [{ id: "1-a", status: "sending", at: 1, text: "x" }, { id: "2-a", status: "sent", at: 2, text: "y" }];
  const next = I.setChatStatus(list, "1-a", "sent", 99);
  assert.deepEqual(next.map((x) => [x.id, x.status, x.at]), [["1-a", "sent", 99], ["2-a", "sent", 2]]);
  assert.equal(list[0].status, "sending"); // 원본은 그대로
  assert.equal(I.setChatStatus(list, "1-a", "sending", 5), null);
  assert.equal(I.setChatStatus(list, "9-z", "sent", 5), null);
  assert.equal(I.setChatStatus(list, "1-a", "weird", 5), null);
  assert.equal(I.setChatStatus(null, "1-a", "sent", 5), null);
});

test("mineActs: 아무것도 못 간 것은 다시 보내기, Enter만 빠진 것은 Enter(10분 안)·다시 보내기(오래되면), 질문에 답한 뒤의 held도 버튼이 생긴다", () => {
  const MIN = 60000;
  for (const st of ["nopane", "failed", "gone"]) assert.deepEqual(I.mineActs(st), ["resend"], st);
  assert.deepEqual(I.mineActs("noenter", false, 0), ["enter"]);
  assert.deepEqual(I.mineActs("noenter", false, 9 * MIN), ["enter"]);
  assert.deepEqual(I.mineActs("noenter", false, 11 * MIN), ["resend"]); // 10분 지난 Enter 버튼은 사라진다(입력창이 바뀌었을 수 있다)
  assert.equal(I.ENTER_TTL_MS, 10 * MIN);
  assert.deepEqual(I.mineActs("held", true, 0), []); // 아직 PO가 질문 중: Enter는 그 질문에 답하는 것이라 버튼 없음
  assert.deepEqual(I.mineActs("held", false, 1000), ["enter", "resend"]); // 질문에 답한 뒤
  assert.deepEqual(I.mineActs("held", false, 11 * MIN), ["resend"]);
  for (const st of ["sent", "sending", "opening"]) assert.deepEqual(I.mineActs(st, false, 0), [], st);
  assert.equal(I.mineAct, undefined); // 옛 단일 버튼 함수는 없다
});

test("liveStatus: 20초 넘게 sending/opening에 머문 기록은 각각 noenter/nopane으로 본다(영원히 '보내는 중' 금지)", () => {
  assert.equal(I.liveStatus("sending", 1000, 1000 + 19000), "sending");
  assert.equal(I.liveStatus("sending", 1000, 1000 + 21000), "noenter");
  assert.equal(I.liveStatus("opening", 1000, 1000 + 21000), "nopane");
  assert.equal(I.liveStatus("opening", 1000, 1000 + 5000), "opening");
  for (const st of ["sent", "held", "failed", "nopane", "noenter"]) assert.equal(I.liveStatus(st, 1000, 1000 + 999999), st);
});

test("badgeTurn: 아이콘 배지는 한 번에 한 복사본만 쓴다(주인이거나 주인이 조용해졌을 때만)", () => {
  assert.equal(I.badgeTurn(null, "a", 1000), "write");
  assert.equal(I.badgeTurn({ id: "a", ts: 1000 }, "a", 2000), "write");
  assert.equal(I.badgeTurn({ id: "b", ts: 1000 }, "a", 2000), "skip");
  assert.equal(I.badgeTurn({ id: "b", ts: 1000 }, "a", 1000 + 66000), "write"); // 주인이 65초 넘게 갱신하지 않음(창을 닫으면 곧 넘겨받는다)
  assert.equal(I.badgeTurn({ id: "b", ts: 1000 }, "a", 1000 + 64000), "skip");
});

test("promptTail·promptOptions: PO 화면 끝줄과 1,2,3…으로 이어진 선택지만(강조 표시 포함), 아니면 없음", () => {
  const screen = "\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. Yes, and don't ask again for this command\n    3. No, and tell Claude what to do differently (esc)\n\n";
  assert.deepEqual(I.promptTail(screen, 2), ["    2. Yes, and don't ask again for this command", "    3. No, and tell Claude what to do differently (esc)"]);
  assert.deepEqual(I.promptOptions(screen).map((o) => [o.key, o.on]), [["1", true], ["2", false], ["3", false]]);
  assert.equal(I.promptOptions(screen)[1].label, "Yes, and don't ask again for this command");
  assert.deepEqual(I.promptOptions("Proceed?\n 2. a\n 3. b"), []); // 1부터 이어지지 않으면 추측하지 않는다
  assert.deepEqual(I.promptOptions("Proceed?\n 1. only one"), []);
  assert.deepEqual(I.promptOptions("Proceed? (y/n)"), []);
  assert.deepEqual(I.promptOptions(""), []);
  assert.equal(I.promptTail("a".repeat(300), 1)[0].length, 140);
});

test("timeline: 내 글은 id와 실시간 상태를 달고, 오래 머문 sending은 noenter로 보인다", () => {
  const mine = [{ id: "1-a", ts: "t", ms: 1000, at: 1000, text: "x", po: "p1", kind: "chat", status: "sending" }];
  assert.equal(I.timeline("p1", [], [], mine, [], 1000 + 5000).find((e) => e.who === "me").status, "sending");
  const late = I.timeline("p1", [], [], mine, [], 1000 + 30000).find((e) => e.who === "me");
  assert.equal(late.status, "noenter");
  assert.equal(late.id, "1-a");
});

test("main.js: 다시 보내기·Enter 누르기·질문 패널은 PO가 지금 질문 중인지로 막고, 배지는 한 곳만 쓴다", () => {
  const src = mainSrc();
  const re = methodOf(src, "  resend(id, c) {", "  // The bubble's \"Enter 누르기\"");
  assert.match(re, /includes\("resend"\)/);
  assert.ok(re.indexOf('this.mark(id, "sending")') > 0 && re.indexOf('this.mark(id, "sending")') < re.indexOf("this.deliver(")); // 붙여 넣기 전에 sending
  assert.match(re, /this\.deliver\(po, r\.line \|\| r\.text, c, r, \(r2\) => this\.markAsk\(r, r2\), id\)/); // 같은 기록·같은 줄(새 말풍선 없음)
  const en = methodOf(src, "  enterNow(id, c) {", "  // ---- A blocked PO's screen");
  assert.match(en, /includes\("enter"\)/);
  assert.match(en, /if \(this\.isBlocked\(po\)\) \{.*return; \}/); // 질문 중이면 Enter를 누르지 않는다
  assert.ok(en.indexOf("this.isBlocked(po)") < en.indexOf('hc(["keys", po, "enter"])'));
  assert.ok(en.indexOf('hc(["read"') < en.indexOf('hc(["keys", po, "enter"])')); // Enter 전에 PO 화면을 읽는다
  assert.match(en, /inputHas\(/);
  assert.match(en, /this\.mark\(id, okk \? "sent" : "noenter"\)/);
  const pp = methodOf(src, "  pressPrompt(po, key, c) {", "  promptPanel(t, v, cx) {");
  assert.ok(pp.indexOf("!this.isBlocked(po)") >= 0 && pp.lastIndexOf("!this.isBlocked(po)") < pp.indexOf('hc(["keys", po, key])')); // 질문이 사라졌으면 키를 누르지 않는다
  assert.ok(pp.indexOf('hc(["read"') < pp.indexOf('hc(["keys", po, key])') && /promptSig\(text\) !== want/.test(pp)); // 키 전에 화면을 다시 읽어 같은 질문인지 본다
  const panel = methodOf(src, "  promptPanel(t, v, cx) {", "  // A panel answer:");
  assert.match(panel, /if \(!po \|\| !this\.isBlocked\(po\)\) \{ this\.prompt = null; return null; \}/); // 질문 중일 때만 보인다
  assert.match(panel, /promptOptions\(shown\.text\)/);
  assert.match(panel, /"enter"/);
  assert.match(panel, /"esc"/);
  const callers = src.match(/this\.pressPrompt\(/g) ?? [];
  assert.equal(callers.length, 2); // 옵션 버튼과 Enter/Esc 버튼, 둘 다 클릭 핸들러 안
  assert.ok(!/readPrompt\([^)]*\)[^;]*pressPrompt/.test(src)); // 화면을 읽은 결과로 스스로 누르지 않는다
  const rp = methodOf(src, "  readPrompt(po, cx) {", "  pressPrompt(po, key, c) {");
  assert.match(rp, /hc\(\["read", po, "--lines"/);
  assert.ok(!/"keys"/.test(rp));
  const badge = methodOf(src, "  badge(", "\n  }\n");
  assert.match(badge, /badgeTurn\(/);
  assert.match(badge, /setShared\(BADGE_KEY/);
});

test("main.js: 말풍선의 다시 보내기/Enter 누르기 버튼은 mineActs로만 정하고, 막힌 PO가 질문 중일 때 질문 패널이 채팅 상자 위에 붙는다", () => {
  const src = mainSrc();
  const row = methodOf(src, "  entryRow(t, e, v, cx) {", "  render(cx)");
  assert.match(row, /mineActs\(e\.status, blockedNow, age\)/);
  assert.match(row, /this\.resend\(e\.id, c\)/);
  assert.match(row, /this\.enterNow\(e\.id, c\)/);
  assert.match(row, /다시 보내기/);
  assert.match(row, /Enter 누르기/);
});

// ---- R8: 질문 화면 읽기(실제 샘플), 입력창 확인, 보내기·누르기 직전 재확인
// 실제 캡처: claude 2.1.332 (빈 CLAUDE_CONFIG_DIR) 로그인 방식 선택 화면(번호가 있는 유일한 화면). 개인 정보 없음.
const REAL_LOGIN = " Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.\n\n Select login method:\n\n ❯ 1. Claude account with subscription · Individual, Team, or Enterprise\n   2. Anthropic Console account · API usage billing\n   3. 3rd-party platform · Bedrock, Microsoft Foundry, Google Vertex AI\n\n";
// 실제 캡처: 같은 버전의 폴더 신뢰 화면(경로만 익명화). 이 버전의 선택 메뉴는 번호가 없다.
const REAL_TRUST = " Do you trust the files in this folder?\n\n /tmp/proj\n\n Claude Code may read, write, or execute files contained in this directory.\n\n ❯ Yes, proceed\n   No, exit\n\n Enter to confirm · Esc to cancel\n";
// 합성(실제 캡처 아님): 번호 메뉴 + 바닥 힌트줄 + 테두리 — 힌트 문구는 근사치다.
const SYNTH_FOOTER = "  Do you want to proceed?\n  ❯ 1. Yes\n    2. Yes, and don't ask again\n    3. No, and tell Claude what to do differently (esc)\n\n  Esc to cancel · Tab to amend\n╰──────────────╯\n";

test("promptOptions: 실제 로그인 화면은 3개(1번 강조), 번호 없는 실제 폴더 신뢰 화면은 없음, 바닥 힌트·테두리는 건너뛴다", () => {
  assert.deepEqual(I.promptOptions(REAL_LOGIN).map((o) => [o.key, o.on]), [["1", true], ["2", false], ["3", false]]);
  assert.match(I.promptOptions(REAL_LOGIN)[0].label, /^Claude account with subscription/);
  assert.deepEqual(I.promptOptions(REAL_TRUST), []); // 번호 없는 메뉴는 숫자 키를 추측하지 않는다
  assert.deepEqual(I.promptOptions(SYNTH_FOOTER).map((o) => o.key), ["1", "2", "3"]);
  assert.deepEqual(I.promptOptions("  ❯ 1. Yes\n    2. No\n\n  ? for shortcuts\n"), [{ key: "1", label: "Yes", on: true }, { key: "2", label: "No", on: false }]);
  // 화면 위쪽의 옛 번호 목록은 선택지가 아니다(맨 아래 덩어리만)
  assert.deepEqual(I.promptOptions("1. old\n2. old\n" + "text\n".repeat(12) + "tail"), []);
  const two = I.promptOptions("  1. old\n  2. old\n\nresult text\n\nProceed?\n  ❯ 1. Yes\n    2. No\n");
  assert.deepEqual(two.map((o) => o.label), ["Yes", "No"]);
});

test("promptSig: 같은 질문이면 같은 값(공백·강조 이동 무관), 질문이 바뀌면 다른 값", () => {
  assert.equal(I.promptSig(SYNTH_FOOTER), I.promptSig(SYNTH_FOOTER.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.")));
  assert.notEqual(I.promptSig(SYNTH_FOOTER), I.promptSig(SYNTH_FOOTER.replace("Do you want to proceed?", "Allow this edit?")));
  assert.notEqual(I.promptSig(SYNTH_FOOTER), I.promptSig(SYNTH_FOOTER.replace("2. Yes, and don't ask again", "2. Yes, always")));
  assert.notEqual(I.promptSig(REAL_TRUST), I.promptSig(REAL_TRUST.replace("/tmp/proj", "/tmp/other"))); // 번호가 없어도 끝 6줄로 비교
  assert.equal(I.promptSig(""), "");
});

test("inputHas: 붙여 넣은 줄이 PO 화면 아래쪽 입력창에 아직 있는지(테두리·공백 무시), 긴 글은 [Pasted text 표시도 인정", () => {
  const box = "output\n╭──────────────────╮\n│ > 확인 완료 그리고   진행해 │\n╰──────────────────╯\n  ? for shortcuts\n";
  assert.equal(I.inputHas(box, "확인 완료 그리고 진행해"), true);
  assert.equal(I.inputHas("output\n  ? for shortcuts\n", "확인 완료 그리고 진행해"), false);
  assert.equal(I.inputHas(("x\n".repeat(30)) + "> hi\n", "맨 위에 있던 글".repeat(2)), false);
  const long = "가".repeat(300);
  assert.equal(I.inputHas("> [Pasted text #1 +1 lines]\n", long), true);
  assert.equal(I.inputHas("> [Pasted text #1 +1 lines]\n", "짧은 한 줄"), false); // 짧은 한 줄은 표시로 대신하지 않는다
  assert.equal(I.inputHas("", "x"), false);
});

test("cleanText: 제어·bidi·제로폭 문자는 지우고 줄바꿈·탭은 둔다(\\r\\n은 \\n)", () => {
  assert.equal(I.cleanText("a‮b​c\r\nd\u0007e\tf⁦g﻿h\u009bi"), "abc\nde\tfghi");
  assert.equal(I.cleanText(null), "");
  const r = I.chatRecord({ text: "답‮변\u0000", line: "줄​", ak: "k|1|l", to: "lead-a", po: "p1" }, "sent", 5);
  assert.equal(r.text, "답변");
  assert.equal(r.line, "줄");
  assert.equal(r.ak, "k|1|l");
  assert.equal(I.promptTail("a‮b\nc\u0007", 2).join("|"), "ab|c");
});

test("chatRecord·timeline: gone 상태가 있고, 내 글에 시각(at)이 실린다", () => {
  assert.ok(I.CHAT_STATUS.includes("gone"));
  assert.equal(I.chatRecord({ text: "x", po: "p1" }, "gone", 5).status, "gone");
  const mine = [{ id: "1-a", ts: "t", ms: 1000, at: 4000, text: "x", po: "p1", kind: "chat", status: "gone" }];
  const e = I.timeline("p1", [], [], mine, [], 5000).find((x) => x.who === "me");
  assert.equal(e.at, 4000);
  assert.equal(e.status, "gone");
});

// main.js 메서드를 가짜 this·전역으로 돌린다(런타임 없이 흐름만 본다).
const runMethod = (src, head, next, globals) => {
  const m = methodOf(src, head, next);
  const names = Object.keys(globals);
  return new Function(...names, `return ({ ${m.replace(/\n\s*\/\/[^\n]*\s*$/g, "")} });`)(...names.map((k) => globals[k]));
};
const tick = () => new Promise((r) => setImmediate(r));
const mkGlobals = (extra = {}) => ({ hc: () => ({ code: 0, stdout: "" }), liveStatus: I.liveStatus, mineActs: I.mineActs, promptSig: I.promptSig, inputHas: I.inputHas, PROMPT_LINES: 40, NO_PO: "NOPO", chatTarget: null, ...extra });

test("resend: 붙여 넣기 전에 sending으로 바꾸고, sending 중의 두 번째 클릭은 아무것도 보내지 않으며, 같은 카드를 sent로 닫는다", () => {
  const src = mainSrc();
  const rec = { id: "1-a", status: "nopane", at: Date.now() - 1000, ms: 1, text: "답", line: "답", to: "lead-a", po: "p1", ak: "decision|t|l" };
  const log = [];
  const self = {
    recordOf: () => rec, recordPo: () => "t5", isBlocked: () => false, say: (m) => log.push(["say", m]),
    mark: (id, st) => { rec.status = st; log.push(["mark", st]); },
    deliver: (po, text) => { log.push(["deliver", po, text, rec.status]); return "sent"; },
    markAsk: (r, how) => log.push(["ask", how]),
  };
  self.recordActs = runMethod(src, "  recordActs(r, po", "  // The bubble's \"다시 보내기\"", mkGlobals()).recordActs.bind(self);
  const { resend } = runMethod(src, "  resend(id, c) {", "  // The bubble's \"Enter 누르기\"", mkGlobals());
  const c = { notify() {} };
  resend.call(self, "1-a", c);
  assert.deepEqual(log.filter((x) => x[0] === "mark" || x[0] === "deliver").map((x) => x[0] === "deliver" ? `deliver:${x[3]}` : `mark:${x[1]}`), ["mark:sending", "deliver:sending"]); // deliver가 시작될 때 이미 sending
  assert.ok(log.some((x) => x[0] === "ask" && x[1] === "sent"));
  // sending 중(또 눌러도)
  rec.status = "sending"; rec.at = Date.now();
  const before = log.length;
  resend.call(self, "1-a", c);
  assert.equal(log.length, before); // 아무 일도 없음
  // 막혔을 때(busy)는 원래 상태로 되돌린다
  rec.status = "failed";
  self.deliver = () => "busy";
  resend.call(self, "1-a", c);
  assert.equal(rec.status, "failed");
});

test("pressPrompt: 키 직전에 화면을 다시 읽어 질문이 바뀌었으면 키를 보내지 않고 패널을 새로 읽는다", async () => {
  const src = mainSrc();
  const Q1 = SYNTH_FOOTER, Q2 = SYNTH_FOOTER.replace("Do you want to proceed?", "Allow this edit?");
  const calls = [];
  let screen = Q1;
  const g = mkGlobals({ hc: (a) => { calls.push(a.join(" ")); return { code: 0, stdout: a[0] === "read" ? screen : "" }; } });
  const { pressPrompt } = runMethod(src, "  pressPrompt(po, key, c) {", "  promptPanel(t, v, cx) {", g);
  const said = [];
  const self = { prompt: { po: "t5", at: Date.now(), text: Q1 }, isBlocked: () => true, say: (m, bad) => said.push(m) };
  const c = { notify() {} };
  pressPrompt.call(self, "t5", "1", c); await tick(); await tick();
  assert.deepEqual(calls, ["read t5 --lines 40", "keys t5 1"]); // 같은 질문이면 누른다
  // 질문이 바뀜
  calls.length = 0; said.length = 0; screen = Q2; self.prompt = { po: "t5", at: Date.now(), text: Q1 };
  pressPrompt.call(self, "t5", "2", c); await tick(); await tick();
  assert.deepEqual(calls, ["read t5 --lines 40"]); // 키 없음
  assert.ok(said.some((m) => /질문이 바뀌었습니다, 다시 확인하세요/.test(m)));
  assert.equal(self.prompt.text, Q2); // 패널이 새 화면으로 갱신
  // 질문이 사라짐(막힘 해제)
  calls.length = 0; said.length = 0; self.isBlocked = () => false;
  pressPrompt.call(self, "t5", "1", c); await tick();
  assert.deepEqual(calls, []);
  // 화면을 아직 못 읽음
  self.isBlocked = () => true; self.prompt = null; said.length = 0;
  pressPrompt.call(self, "t5", "1", c); await tick();
  assert.deepEqual(calls, []);
  assert.ok(said.some((m) => /읽지 못해/.test(m)));
  // 다시 읽기 실패
  self.prompt = { po: "t5", at: Date.now(), text: Q1 }; screen = Q1;
  g.hc = null;
});

test("enterNow: Enter 전에 입력창을 읽어 보낸 글이 없으면 gone으로 두고 Enter를 누르지 않는다, 있으면 누르고 sent + 카드 닫기", async () => {
  const src = mainSrc();
  const calls = [];
  let screen = "╭──╮\n│ > 안녕하세요 PO │\n╰──╯\n";
  let blockedAfterRead = false;
  const rec = { id: "1-a", status: "noenter", at: Date.now() - 1000, ms: 1, text: "안녕하세요 PO", line: "안녕하세요 PO", to: "lead-a", po: "p1", ak: "k" };
  const log = [];
  const g = mkGlobals({ hc: (a) => { calls.push(a.join(" ")); return { code: 0, stdout: a[0] === "read" ? screen : "" }; } });
  const self = {
    recordOf: () => rec, recordPo: () => "t5", say: (m) => log.push(["say", m]),
    isBlocked: () => blockedAfterRead,
    mark: (id, st) => { rec.status = st; log.push(["mark", st]); }, markAsk: (r, how) => log.push(["ask", how]),
  };
  self.recordActs = runMethod(src, "  recordActs(r, po", "  // The bubble's \"다시 보내기\"", g).recordActs.bind(self);
  const { enterNow } = runMethod(src, "  enterNow(id, c) {", "  // ---- A blocked PO's screen", g);
  const c = { notify() {} };
  enterNow.call(self, "1-a", c); await tick(); await tick(); await tick();
  assert.deepEqual(calls, ["read t5 --lines 40", "keys t5 enter"]);
  assert.equal(rec.status, "sent");
  assert.ok(log.some((x) => x[0] === "ask" && x[1] === "sent"));
  // 입력창에 글이 없음 → gone
  calls.length = 0; log.length = 0; rec.status = "noenter"; screen = "output only\n";
  enterNow.call(self, "1-a", c); await tick(); await tick(); await tick();
  assert.deepEqual(calls, ["read t5 --lines 40"]);
  assert.equal(rec.status, "gone");
  assert.ok(log.some((x) => x[0] === "say" && /입력창에 보낸 글이 없어/.test(x[1])));
  // 10분 지난 noenter는 Enter 버튼이 없다(아무 일 없음)
  calls.length = 0; rec.status = "noenter"; rec.at = Date.now() - 11 * 60000; screen = "> 안녕하세요 PO\n";
  enterNow.call(self, "1-a", c); await tick();
  assert.deepEqual(calls, []);
  // 지금 질문 중이면 읽지도 누르지도 않는다
  rec.at = Date.now() - 1000; blockedAfterRead = true;
  enterNow.call(self, "1-a", c); await tick();
  assert.deepEqual(calls, []);
});

test("main.js: R8 배선 — 방 목록 질문 표시, deliver 정리, awaitPane 순서, readPrompt 시간 제한, submitPo 재확인, ask 카드 표시", () => {
  const src = mainSrc();
  // 방 목록(고르개·좁은 목록·방 칸)이 같은 배지 함수로 질문 중 표시를 낸다
  const rb = methodOf(src, "  roomBadges(t, x) {", "\n  }\n");
  assert.match(rb, /x\.blocked/);
  assert.match(rb, /질문/);
  assert.equal((src.match(/this\.roomBadges\(t, x\)/g) ?? []).length, 3);
  assert.match(src, /blocked: this\.isBlocked\(p\.address\)/); // 방마다 막힘 여부
  assert.match(src, /label: OTHER_LABEL, title: "", blocked: false/);
  // 붙여 넣기 직전 글 정리
  assert.match(deliverOf(src), /text = cleanText\(text\)/);
  // opening 표시는 붙여 넣기가 끝난 뒤 지운다(go 안의 try/catch 다음)
  const ap = methodOf(src, "  awaitPane(", "\n  }\n");
  assert.ok(ap.indexOf("this.deliver(") < ap.indexOf("this.opening.delete(po)", ap.indexOf("const go"))); // go 안: 붙여 넣기 뒤에 지운다
  assert.ok(!/this\.opening\.delete\(po\);\s*\n\s*const go/.test(ap)); // go 앞에서 먼저 지우지 않는다
  // readPrompt: 시간 제한 + 세대 확인
  const rp = methodOf(src, "  readPrompt(po, cx) {", "  pressPrompt(po, key, c) {");
  assert.match(rp, /PROMPT_TIMEOUT_MS/);
  assert.match(rp, /gen !== this\.promptGen/);
  assert.match(src, /const PROMPT_TIMEOUT_MS = \d+/);
  // submitPo: Enter 직전 다시 막혔는지 본다
  const sub = methodOf(src, "  submitPo(po, c, settle", "  sendChat(c) {");
  assert.ok(sub.indexOf("this.isBlocked(po)") > 0 && sub.indexOf("this.isBlocked(po)") < sub.indexOf('hc(["keys", po, "enter"])'));
  assert.match(sub, /this\.mark\(id, "held"\)/);
  // ask 카드: 보낸 표시는 resend·enterNow에서도 닫는다
  assert.match(src, /markAsk\(r, how\) \{/);
  assert.match(methodOf(src, "  enterNow(id, c) {", "  // ---- A blocked PO's screen"), /this\.markAsk\(r, "sent"\)/);
  // 질문 패널은 다시 그리지 않아도 되도록 나이(몇 초 전 화면) 표시를 두지 않는다
  assert.ok(!/초 전 화면/.test(methodOf(src, "  promptPanel(t, v, cx) {", "  // A panel answer:")));
});

// ---- 채팅 필터 (#36, #37)
const LEAD = (kind, ms, extra = {}) => ({ key: `l|a|${ms}`, who: "l:a", ms, leader: "a", it: { kind, ts: String(ms), ms }, ...extra });
const MIXED = [
  LEAD("done", 100), LEAD("decision", 200), LEAD("verify", 300), LEAD("stop", 400), LEAD("resume", 500), LEAD("start", 550), LEAD("other", 600),
  { key: "po|700|x", who: "po", ms: 700, text: "x" },
  { key: "me|800|y", who: "me", ms: 800, text: "y", status: "sent" },
];
const keysOf = (l) => l.map((e) => e.key);
test("filterEntries: 칩 6개 순서와 이름", () => {
  assert.deepEqual(I.CHAT_FILTERS.map((f) => f[1]), ["전체", "안 읽은 것", "결정 필요", "최종 확인 요청", "결과", "멈춤"]);
  assert.deepEqual(I.CHAT_FILTERS.map((f) => f[0]), ["all", "unread", "decision", "verify", "done", "stop"]);
});
test("filterEntries: 종류별 필터는 그 종류의 리더 보고만 — 내 글·PO 글·resume/start/other는 전체에만", () => {
  assert.equal(I.filterEntries(MIXED, "all", 0).length, MIXED.length);
  assert.deepEqual(keysOf(I.filterEntries(MIXED, "decision", 0)), ["l|a|200"]);
  assert.deepEqual(keysOf(I.filterEntries(MIXED, "verify", 0)), ["l|a|300"]);
  assert.deepEqual(keysOf(I.filterEntries(MIXED, "done", 0)), ["l|a|100"]); // 결과는 done만
  assert.deepEqual(keysOf(I.filterEntries(MIXED, "stop", 0)), ["l|a|400"]);
  for (const f of ["decision", "verify", "done", "stop"]) {
    for (const e of I.filterEntries(MIXED, f, 0)) assert.ok(e.who !== "me" && e.who !== "po");
  }
  assert.deepEqual(I.filterEntries(MIXED, "bogus", 0), MIXED); // 모르는 필터는 전체
  assert.deepEqual(I.filterEntries(undefined, "done", 0), []);
});
test("filterEntries: 기다리는 리더는 기다리는 종류로 센다(보고 종류가 달라도, 보고 없는 대기 줄도)", () => {
  const list = [LEAD("done", 100, { waiting: "decision" }), { key: "w|b", who: "l:b", ms: 900, leader: "b", waiting: "verify", wait: true }];
  assert.deepEqual(keysOf(I.filterEntries(list, "decision", 0)), ["l|a|100"]);
  assert.deepEqual(keysOf(I.filterEntries(list, "verify", 0)), ["w|b"]);
  assert.deepEqual(I.filterEntries(list, "done", 0), []);
});
test("filterEntries: 안 읽은 것은 방을 열 때의 기준(snapshot)보다 새 글만, 내 글과 대기 줄은 아니다", () => {
  const seen = 450; // 방을 열 때 마지막으로 본 시각
  assert.deepEqual(keysOf(I.filterEntries(MIXED, "unread", seen)), ["l|a|500", "l|a|550", "l|a|600", "po|700|x"]);
  // 방을 열면 실제 기준은 지금으로 올라간다: 그 값으로 거르면 곧바로 비지만, 열 때의 값으로 걸러야 한다
  assert.equal(I.filterEntries(MIXED, "unread", 800).length, 0);
  assert.equal(I.filterCounts(MIXED, seen).unread, 4);
  const w = { key: "w|b", who: "l:b", ms: 9999, leader: "b", waiting: "decision", wait: true };
  assert.equal(I.filterEntries([...MIXED, w], "unread", seen).includes(w), false);
  assert.equal(I.filterEntries(MIXED, "unread", undefined).length, MIXED.length - 1); // 기준 0이면 내 글만 빠진다
});
test("filterCounts: 칩마다 개수(0도 키가 있다), 빈 방은 모두 0", () => {
  assert.deepEqual(I.filterCounts(MIXED, 450), { all: 9, unread: 4, decision: 1, verify: 1, done: 1, stop: 1 });
  assert.deepEqual(I.filterCounts([], 0), { all: 0, unread: 0, decision: 0, verify: 0, done: 0, stop: 0 });
  assert.deepEqual(I.filterCounts(null, 0), { all: 0, unread: 0, decision: 0, verify: 0, done: 0, stop: 0 });
});
test("timeline: 같은 시각·같은 글이 둘이어도 key(=요소 id)가 겹치지 않는다", () => {
  const po = [{ ms: 5, ts: "t", text: "same" }, { ms: 5, ts: "t", text: "same" }];
  const mine = [{ ms: 9, ts: "t", text: "me", po: "r", status: "sent" }, { ms: 9, ts: "t", text: "me", po: "r", status: "sent" }];
  const keys = keysOf(I.timeline("r", [], po, mine, [], 100));
  assert.equal(new Set(keys).size, 4);
  assert.ok(keys.includes("po|5|same") && keys.includes("po|5|same#1"));
});
test("main.js: chat 블록(필터 함수 포함)은 inbox.cjs와 같다", () => {
  const cut = (t) => t.slice(t.indexOf("// chat:begin"), t.indexOf("// chat:end"));
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(cut(mainSrc()), cut(cjs));
  assert.match(cut(mainSrc()), /function filterEntries/);
});
test("main.js: 필터 배선 — 방별 상태, 열 때 기준 저장(표시 전환 전), 칩 줄, 빈 화면 '전체 보기', 세 화면 공통", () => {
  const src = mainSrc();
  assert.match(src, /this\.filt = new Map\(\)/);
  // 기준은 읽음 표시를 올리기 전에 잡는다
  const ms = methodOf(src, "  markSeen() {", "  setFilter(");
  assert.ok(ms.indexOf("snapStep(") > 0 && ms.indexOf("setShared(SNAP_KEY") > 0 && ms.indexOf("setShared(SNAP_KEY") < ms.indexOf("setShared(SEEN_KEY"));
  assert.ok(!/this\.snap\b/.test(src));
  // view: 기준으로 거르고, raw(읽음 표시용)는 거르지 않은 전체
  const vw = methodOf(src, "  view() {", "  // Remembers that the person");
  assert.match(vw, /filterEntries\(scope, filter, base\)/);
  assert.match(vw, /snapBase\(snaps, pick, seen, now\)/);
  assert.match(vw, /keepWaiting\(scope, shown\)/);
  assert.match(vw, /filterCounts\(scope, base\)/);
  // 칩 줄: 6칩, 개수, 0이어도 누를 수 있다(on_click은 항상), 누름이 창을 끌지 않게 stop
  const fb = methodOf(src, "  filterBar(t, v) {", "  pickPo(id, c) {");
  assert.match(fb, /CHAT_FILTERS\.map/);
  assert.match(fb, /\$\{label\} \$\{n\}/);
  assert.match(fb, /on_mouse_down\("left", stop\)/);
  assert.match(fb, /on_click\(\(_e, c\) => this\.setFilter\(v\.pick, k, c\)\)/);
  assert.ok(!/disabled/.test(fb));
  // 빈 상태 + 전체 보기 칩
  assert.match(src, /해당 메시지 없음 —/);
  assert.match(src, /"flt-reset", "전체 보기"/);
  // 한 full()이 Dock·창·페인 모두를 그린다: 칩 줄은 방 칸 안에, 타임라인 위
  const fl = methodOf(src, "  full(cx) {", "    return v_flex().size_full()");
  assert.ok(fl.indexOf(".child(el.child(bar))") < 0);
  assert.ok(fl.indexOf("el.child(bar)") > 0 && fl.indexOf("el.child(bar)") < fl.indexOf(".child(lines)"));
  assert.equal((src.match(/^  full\(cx\) \{/gm) ?? []).length, 1);
});
// 동작: setFilter / markSeen 기준 / view 필터
// ---- #58: 특정 리더만(1:1) 보기
const LD = (leader, kind, ms, extra = {}) => ({ key: `l|${leader}|${ms}`, who: `l:${leader}`, ms, leader, it: { kind }, ...extra });
const ME = (to, ms) => ({ key: `me|${ms}`, who: "me", ms, text: "t", to, status: "sent" });
const ROOM = [LD("lead-a", "done", 100), LD("lead-b", "decision", 200, { waiting: "decision" }), ME("lead-a", 300), ME("", 350), { key: "po|400", who: "po", ms: 400, text: "p" }, LD("lead-a", "verify", 500), { key: "w|lead-c", who: "l:lead-c", ms: 900, leader: "lead-c", waiting: "verify", wait: true }];
test("roomLeaders: 방에 글이 있는 리더만 보이는 이름 순으로, 기다리는 리더는 표시한다", () => {
  const names = { "lead-a": "나", "lead-b": "가", "lead-c": "다" };
  assert.deepEqual(I.roomLeaders(ROOM, (n) => names[n]), [{ id: "lead-b", label: "가", waiting: true }, { id: "lead-a", label: "나", waiting: false }, { id: "lead-c", label: "다", waiting: true }]);
  assert.deepEqual(I.roomLeaders([ME("lead-a", 1), { who: "po" }]), []); // 내 글·PO 글만으로는 리더가 생기지 않는다
  assert.deepEqual(I.roomLeaders(undefined), []);
});
test("settleLeader: 방에 있는 리더면 유지, 방을 떠났거나 모르면 전체('')로 돌아간다 — PO마다 목록이 다르다", () => {
  const po1 = I.roomLeaders([LD("lead-a", "done", 1), LD("lead-b", "done", 2)]);
  const po2 = I.roomLeaders([LD("lead-x", "done", 1), LD("lead-y", "done", 2)]);
  assert.equal(I.settleLeader(po1, "lead-a"), "lead-a");
  assert.equal(I.settleLeader(po2, "lead-a"), ""); // 다른 PO 방에는 그 리더가 없다
  assert.equal(I.settleLeader(po1, ""), "");
  assert.equal(I.settleLeader(undefined, "lead-a"), "");
  // The row hides under two leaders (nothing to pick), so a filter must not stay set behind it: one live leader left = the whole room.
  assert.equal(I.settleLeader([{ id: "lead-a" }], "lead-a"), "");
  assert.equal(I.settleLeader([], "lead-a"), "");
});
test("aliveLeaders(#58): 터미널이 열려 있는 리더만 칩으로 남고, 닫힌 리더는 사라지되 기록은 전체에 남는다", () => {
  const room = [LD("lead-a", "done", 1), LD("lead-b", "done", 2), LD("lead-c", "done", 3)];
  const all = I.roomLeaders(room);
  const terms = [{ name: "lead-a", address: "x1" }, { name: "", address: "x9" }];
  const sums = [{ leader: "lead-b", terminal: "x9" }, { leader: "lead-c", terminal: "x7" }];
  const alive = I.aliveLeaders(all, terms, sums);
  assert.deepEqual(alive.map((x) => x.id), ["lead-a", "lead-b"]); // 이름으로, 또는 보고에 적힌 터미널 주소로 열려 있다
  assert.deepEqual(I.aliveLeaders(all, [], sums), []); // 다 닫히면 칩이 없다
  assert.deepEqual(I.aliveLeaders(all, undefined, undefined), []);
  assert.equal(I.settleLeader(alive, "lead-c"), ""); // 고른 리더가 닫히면 전체로
  assert.equal(I.settleLeader(alive, "lead-a"), "lead-a");
  assert.equal(I.leaderEntries(room, "").length, 3); // 전체에는 닫힌 리더의 기록도 그대로
  const src = mainSrc();
  assert.match(src, /aliveLeaders\(roomLeaders\(raw, \(n\) => shortName\(n\)\), terms, this\.data\?\.leaders\)/);
  const cut = (g) => { const t = fs.readFileSync(path.join(__dirname, g), "utf8"); const i = t.indexOf("const aliveLeaders"); return t.slice(i, t.indexOf("\n", i)); };
  assert.equal(cut("../mods/inbox/main.js"), cut("../mods/inbox/inbox.cjs"));
});
test("leaderEntries: 그 리더의 글 + 그 리더에게 보낸 내 글만 — 칩과 겹쳐 쓴다", () => {
  assert.deepEqual(keysOf(I.leaderEntries(ROOM, "lead-a")), ["l|lead-a|100", "me|300", "l|lead-a|500"]);
  assert.deepEqual(keysOf(I.leaderEntries(ROOM, "lead-c")), ["w|lead-c"]);
  assert.equal(I.leaderEntries(ROOM, "").length, ROOM.length); // 고르지 않으면 방 전체
  const scope = I.leaderEntries(ROOM, "lead-a");
  assert.deepEqual(keysOf(I.filterEntries(scope, "verify", 0)), ["l|lead-a|500"]); // 칩은 그 리더 안에서만 거른다
  assert.deepEqual(keysOf(I.filterEntries(scope, "decision", 0)), []); // lead-b 의 결정은 보이지 않는다
  assert.deepEqual(I.filterCounts(scope, 0), { all: 3, unread: 2, decision: 0, verify: 1, done: 1, stop: 0 });
  // 다른 리더가 기다리는 중이어도 1:1 보기에서는 그 리더의 글만 남는다
  assert.deepEqual(keysOf(I.keepWaiting(scope, I.filterEntries(scope, "done", 0))), ["l|lead-a|100"]);
});
test("leaderEntries(#58): 한 글에서 부른 모든 리더(tos)와 그 리더 앞으로 쓴 PO 말(to)·그 리더에게 보낸 글의 답(about)도 1:1 에 든다", () => {
  const room = [
    LD("lead-a", "done", 100),
    { key: "me|1", who: "me", ms: 110, text: "t", to: "lead-a", tos: ["lead-a", "lead-b"], status: "sent" }, // 두 리더를 부른 글
    { key: "me|2", who: "me", ms: 120, text: "t", to: "", status: "sent" }, // 누구에게인지 모른다
    { key: "po|3", who: "po", ms: 130, text: "p", to: "lead-a" }, // PO가 lead-a 앞으로 쓴 말
    { key: "po|4", who: "po", ms: 140, text: "p", to: "", about: "lead-b" }, // lead-b 에게 보낸 글에 대한 답
    { key: "po|5", who: "po", ms: 150, text: "p", to: "" }, // 어디에도 못 묶는다
  ];
  assert.deepEqual(keysOf(I.leaderEntries(room, "lead-a")), ["l|lead-a|100", "me|1", "po|3"]);
  assert.deepEqual(keysOf(I.leaderEntries(room, "lead-b")), ["me|1", "po|4"]);
  assert.deepEqual(keysOf(I.leaderEntries(room, "lead-z")), []);
  assert.equal(I.leaderEntries(room, "").length, room.length);
});
test("chatRecord(#58): 둘 이상 부른 글은 tos 에 모두 담고(to 는 첫 리더), 한 명이면 tos 를 두지 않는다", () => {
  const two = I.chatRecord({ text: "봐 줘", to: "lead-a", tos: ["lead-a", "lead-b", "lead-a", ""], po: "p1" }, "sent", 5);
  assert.deepEqual([two.to, two.tos], ["lead-a", ["lead-a", "lead-b"]]);
  const one = I.chatRecord({ text: "봐 줘", to: "lead-a", tos: ["lead-a"], po: "p1" }, "sent", 5);
  assert.equal("tos" in one, false);
  assert.equal("tos" in I.chatRecord({ text: "봐 줘", po: "p1" }, "sent", 5), false);
  assert.match(mainSrc(), /to: p\.to\[0\] \?\? "", tos: p\.to, po: v\.pick, kind: "chat"/);
});
test("timeline(#58): 데스크에서 리더에게 보낸 글과 같은 prompt id 의 PO 답에 about 을 달고, 묶을 수 없는 것은 달지 않는다", () => {
  const t0 = Date.parse(T(0));
  const rec = (ms, text, to, extra = {}) => ({ id: `r${ms}`, ts: T(ms), ms: t0 + ms * 60000, at: t0 + ms * 60000, text, line: text, to, po: "p1", kind: "chat", status: "sent", ...extra });
  const said = (ms, text, extra = {}) => ({ ts: T(ms), ms: t0 + ms * 60000, text, to: "", ...extra });
  const mine = [rec(1, "lead-a 확인해 줘", "lead-a", { tos: ["lead-a", "lead-b"] }), rec(5, "그냥 한 마디", "")];
  const says = [
    said(1, "lead-a 확인해 줘", { me: true, pid: "p-1" }), // 데스크 기록과 같은 글: 한 말풍선으로 합쳐지고 pid 만 남는다
    said(2, "확인했습니다", { pid: "p-1" }),
    said(3, "터미널에서 직접 친 말", { me: true, pid: "p-2" }),
    said(4, "그 말의 답", { pid: "p-2" }),
    said(5, "그냥 한 마디", { me: true, pid: "p-3" }),
    said(6, "한 마디의 답", { pid: "p-3" }),
    said(7, "pid 없는 말"),
    said(8, "다른 리더 앞으로", { to: "lead-b", pid: "p-1" }),
  ];
  const t = I.timeline("p1", [], says, mine);
  const by = (txt) => t.find((e) => e.text === txt);
  assert.equal(by("확인했습니다").about, "lead-a");
  assert.equal(by("그 말의 답").about, undefined); // 터미널에서 친 말: 누구에게인지 기록에 없다
  assert.equal(by("한 마디의 답").about, undefined); // @ 없이 보낸 글
  assert.equal(by("pid 없는 말").about, undefined);
  assert.equal(by("다른 리더 앞으로").about, undefined); // 이미 to 가 있으면 to 가 따른다
  assert.equal(by("확인했습니다").to, ""); // 말풍선의 "→" 표시는 늘지 않는다
  assert.deepEqual(by("lead-a 확인해 줘").tos, ["lead-a", "lead-b"]);
  assert.deepEqual(t.filter((e) => e.who === "me").length, 3); // 합쳐진 한 개 + 터미널 한 개 + 그냥 한 마디
  assert.deepEqual(I.leaderEntries(t, "lead-a").map((e) => e.text), ["lead-a 확인해 줘", "확인했습니다"]);
  assert.deepEqual(I.leaderEntries(t, "lead-b").map((e) => e.text), ["lead-a 확인해 줘", "다른 리더 앞으로"]);
});
test("main.js: 리더 줄 배선 — 방별 상태, 칩 아래 한 줄, 방을 떠난 리더는 전체, '전체 보기'는 둘 다 푼다", () => {
  const src = mainSrc();
  assert.match(src, /this\.who = new Map\(\)/);
  const vw = methodOf(src, "  view() {", "  // Remembers that the person");
  assert.match(vw, /roomLeaders\(raw, \(n\) => shortName\(n\)\)/);
  assert.match(vw, /settleLeader\(choices, this\.who\.get\(pick\)\)/);
  assert.match(vw, /leaderEntries\(raw, who\)/);
  assert.match(vw, /raw, shown, filter, who, choices/); // raw(읽음 표시용)는 좁히지 않은 전체
  const bar = src.slice(src.indexOf("  leaderBar(t, v) {"), src.indexOf("  peek(s) {"));
  assert.match(bar, /\(v\.choices\?\.length \?\? 0\) < 2\) return null/); // 리더가 둘 미만이면 고를 것이 없다
  assert.match(bar, /on_mouse_down\("left", stop\)/);
  assert.match(bar, /this\.setWho\(v\.pick, id, c\)/);
  assert.match(src, /\.when\(Boolean\(lbar\), \(el\) => el\.child\(lbar\)\)/);
  assert.match(src, /tlKey\(`\$\{v\.pick\}~\$\{v\.filter\}~\$\{v\.who\}`, v\.shown\)/); // 리더를 바꾸면 맨 아래로
  assert.match(src, /\(v\.filter !== "all" \|\| v\.who\) && v\.raw\.length/);
  assert.match(src, /this\.setWho\(v\.pick, "", c\); this\.setFilter\(v\.pick, "all", c\)/);
});
test("setWho: 방마다 따로 기억하고, 빈 값이면 풀어 다시 그린다", () => {
  let n = 0;
  const m = runMethod(mainSrc(), "  setWho(room, leader, c) {", "  // #58: the leader row", mkGlobals()).setWho;
  const self = { who: new Map() };
  m.call(self, "r1", "lead-a", { notify: () => n++ });
  m.call(self, "r2", "lead-b", { notify: () => n++ });
  m.call(self, "", "lead-c", { notify: () => n++ });
  assert.equal(self.who.get("r1"), "lead-a");
  assert.equal(self.who.size, 2);
  m.call(self, "r1", "", { notify: () => n++ });
  assert.equal(self.who.has("r1"), false);
  assert.equal(n, 3);
});
test("setFilter: 방마다 따로 기억하고 다시 그린다", () => {
  const src = mainSrc();
  let n = 0;
  const m = runMethod(src, "  setFilter(room, key, c) {", "  // The chips above", mkGlobals()).setFilter;
  const self = { filt: new Map() };
  m.call(self, "r1", "done", { notify: () => n++ });
  m.call(self, "r2", "stop", { notify: () => n++ });
  m.call(self, "", "stop", { notify: () => n++ });
  assert.equal(self.filt.get("r1"), "done");
  assert.equal(self.filt.get("r2"), "stop");
  assert.equal(self.filt.size, 2);
  assert.equal(n, 2);
});

// ---- 글자 드래그 선택 (#36, #37)
test("글자는 모두 TextView(selectable)로 그린다 — 말풍선·내 글·PO 글·질문 화면 줄, 글자 위 부모에는 누름 처리가 없다", () => {
  const src = mainSrc();
  assert.match(methodOf(src, "  text(id, html) {", "  codeBlock("), /TextView\.html\(id, html\)\.selectable\(true\)/);
  // 질문 패널 화면 줄은 더 이상 그냥 div 글이 아니다
  const pp = methodOf(src, "  promptPanel(t, v, cx) {", "  // A panel answer:");
  assert.match(pp, /this\.text\(`pp-l\$\{i\}`, chatHtml\(l\)\)/);
  assert.ok(!/id\(`pp-l/.test(pp));
  // 글자를 담는 줄에는 누름 처리가 없다: this.text( 가 있는 줄(말풍선 본문·내 글·PO 글)에 on_click/on_mouse_down이 같이 있으면 안 된다
  for (const l of src.split("\n")) {
    if (/this\.text\(/.test(l) && !/^\s*text\(/.test(l)) assert.ok(!/on_click|on_mouse_down/.test(l), l.trim());
  }
  // 글자 부모를 감싸는 곳 중 누름을 가로채는 것은 타임라인 목록 하나뿐이고(자식이 먼저 받는다), 나머지 on_mouse_down은 모두 버튼·칩·입력칸 줄이다
  const downs = src.split("\n").filter((l) => /on_mouse_down\("left", stop\)/.test(l) && /this\.text\(/.test(l));
  assert.equal(downs.length, 0);
});
test("글자 요소 id는 다시 그려도 그대로이고 서로 겹치지 않는다(같은 시각 같은 글 포함)", () => {
  const po = [{ ms: 5, ts: "t", text: "same" }, { ms: 5, ts: "t", text: "same" }];
  const a = I.timeline("r", [], po, [], [], 100).map((e) => `tl-${String(e.key).slice(0, 80)}`);
  const b = I.timeline("r", [], po, [], [], 999).map((e) => `tl-${String(e.key).slice(0, 80)}`); // 나중에 다시 그려도(now만 다름)
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

// ---- PO 훅: PO 터미널의 답·입력을 데스크 파일로 옮긴다 ----
const HOOK = require("../mods/inbox/po-hook.cjs");

test("hookLine: Stop은 마지막 답을 say로, UserPromptSubmit은 입력을 me로 쓴다(출처·프롬프트 id 포함)", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.deepEqual(I.hookLine({ hook_event_name: "Stop", last_assistant_message: "  끝났습니다.\n", prompt_id: "p-1" }, now), { ts: "2026-01-01T00:00:00.000Z", kind: "say", text: "끝났습니다.", src: "hook", pid: "p-1" });
  assert.deepEqual(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "이거 해줘" }, now), { ts: "2026-01-01T00:00:00.000Z", kind: "me", text: "이거 해줘", src: "hook", pid: "" });
});

test("hookLine: 다른 이벤트·빈 글·Stop 훅이 이어 가는 턴·하네스가 넣은 프롬프트는 쓸 것이 없다", () => {
  assert.equal(I.hookLine({ hook_event_name: "SubagentStop", last_assistant_message: "x" }), null);
  assert.equal(I.hookLine({ hook_event_name: "PreToolUse", prompt: "x" }), null);
  assert.equal(I.hookLine({ hook_event_name: "Stop", last_assistant_message: "  \n " }), null);
  assert.equal(I.hookLine({ hook_event_name: "Stop" }), null);
  assert.equal(I.hookLine({ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "x" }), null);
  assert.equal(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "<task-notification>done</task-notification>" }), null);
  assert.equal(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "<system-reminder>x" }), null);
  assert.equal(I.hookLine(null), null);
  assert.equal(I.hookLine("x"), null);
  assert.ok(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "a < b 를 비교해 줘" }));
  assert.ok(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "<div> 태그가 깨져요" })); // 알려진 하네스 태그가 아니면 사람이 친 글이다
  assert.ok(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "<b>굵게</b> 해줘" }));
  assert.equal(I.hookLine({ hook_event_name: "UserPromptSubmit", prompt: "<command-name>/x</command-name>" }), null);
});

test("hookLine: 제어·양방향 문자를 지우고 2000자로 줄이며 끝에 …을 붙인다", () => {
  const dirty = I.hookLine({ hook_event_name: "Stop", last_assistant_message: "a\u0007b‮c\u001b[31md" });
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]/.test(dirty.text), false);
  assert.ok(dirty.text.startsWith("a") && dirty.text.includes("d"));
  const big = I.hookLine({ hook_event_name: "Stop", last_assistant_message: "가".repeat(5000), prompt_id: "x".repeat(300) });
  assert.equal(big.text.length, 2000);
  assert.ok(big.text.endsWith("…"));
  assert.equal(big.pid.length, 80);
});

test("parsePoLines: kind:me 줄은 me 표시를 달고, say 줄은 그대로다", () => {
  const f = (o) => JSON.stringify(o) + "\n";
  const got = I.parsePoLines(f({ ts: "2026-01-01T00:00:01Z", kind: "say", text: "답" }) + f({ ts: "2026-01-01T00:00:02Z", kind: "me", text: "내 말" }) + f({ ts: "2026-01-01T00:00:03Z", kind: "other", text: "x" }));
  assert.deepEqual(got.map((x) => [x.text, !!x.me]), [["답", false], ["내 말", true]]);
});

test("timeline: 터미널에 직접 친 글(me)은 오른쪽 내 말풍선으로, 데스크가 보낸 같은 글은 두 번 나오지 않는다", () => {
  const ms = Date.parse(T(10));
  const typed = (text, at = ms) => ({ ts: new Date(at).toISOString(), ms: at, text, to: "", me: true });
  const kinds = (t) => t.map((e) => `${e.who}${e.typed ? ":typed" : ""}`);
  // 데스크에서 보낸 기록이 없으면 직접 친 글이 그대로 보인다
  const only = I.timeline("p1", [], [typed("직접 쳤어")], []);
  assert.deepEqual(kinds(only), ["me:typed"]);
  assert.equal(only[0].id, "");
  assert.equal(only[0].status, "sent");
  // 데스크 기록(line 또는 text)과 같은 글이면 하나만 남는다 - 공백 차이는 무시
  const sent = { id: "m1", ms: ms - 5000, at: ms - 5000, text: "데스크 글", line: "@lead-a  데스크   글", to: "lead-a", po: "p1", status: "sent" };
  assert.deepEqual(kinds(I.timeline("p1", [], [typed("데스크 글")], [sent])), ["me"]);
  assert.deepEqual(kinds(I.timeline("p1", [], [typed("@lead-a 데스크 글")], [sent])), ["me"]);
  // 기록 하나는 직접 친 글 하나만 덮는다
  assert.deepEqual(kinds(I.timeline("p1", [], [typed("데스크 글"), typed("데스크 글", ms + 1000)], [sent])), ["me", "me:typed"]);
  // 실패·칸 없음·사라짐 기록은 PO에 닿지 않았으니 덮지 않는다
  for (const status of ["failed", "nopane", "gone"]) assert.deepEqual(kinds(I.timeline("p1", [], [typed("데스크 글")], [{ ...sent, status }])).sort(), ["me", "me:typed"]);
  // 다른 PO의 기록, 11분보다 오래된 기록, 훅 줄보다 1분 넘게 나중인 기록은 덮지 않는다
  assert.equal(I.timeline("p1", [], [typed("데스크 글")], [{ ...sent, po: "p2" }]).length, 1);
  assert.deepEqual(kinds(I.timeline("p1", [], [typed("데스크 글")], [{ ...sent, ms: ms - 12 * 60000 }])), ["me", "me:typed"]);
  assert.deepEqual(kinds(I.timeline("p1", [], [typed("데스크 글")], [{ ...sent, ms: ms + 2 * 60000 }])).sort(), ["me", "me:typed"]);
  // PO 모름 방에는 직접 친 글도 없다
  assert.equal(I.timeline(I.PO_OTHER, [], [typed("x")], []).length, 0);
});

test("timeline: me 줄이 아닌 say는 왼쪽 PO 말풍선 그대로다", () => {
  const ms = Date.parse(T(1));
  const t = I.timeline("p1", [], [{ ts: T(1), ms, text: "답", to: "" }], []);
  assert.deepEqual(t.map((e) => e.who), ["po"]);
});

// po-hook.cjs: `hc get`은 주입한 get으로 바꾸고 HERDR_INBOX_DIR은 임시 폴더로 돌려, 진짜 터미널과 홈은 건드리지 않는다.
function hookRun(env0, payload, term) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-hook-"));
  const env = { ...env0, HERDR_INBOX_DIR: dir }; // the hook also reads the profile from this dir (never the real home)
  const prev = process.env.HERDR_INBOX_DIR;
  process.env.HERDR_INBOX_DIR = dir;
  let calls = 0;
  try {
    const r = HOOK.run(env, payload, I, () => { calls++; return term; }, Date.UTC(2026, 0, 1));
    return { r, dir, calls, files: fs.existsSync(path.join(dir, "po")) ? fs.readdirSync(path.join(dir, "po")) : [] };
  } finally { I.setNames(null); if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; }
}
const PO_TERM = { id: "t5", labels: { role: "po", po: "devnotes" } };
const STOP = { hook_event_name: "Stop", last_assistant_message: "다 했습니다" };

test("po-hook: PO 터미널이면 po/<id>.jsonl에 한 줄을 덧붙이고, 같은 파일에 이어 쓴다", () => {
  const a = hookRun({ HC_TERMINAL_ID: "t5" }, STOP, PO_TERM);
  assert.deepEqual(a.files, ["devnotes.jsonl"]);
  const read = I.parsePoLines(fs.readFileSync(path.join(a.dir, "po", "devnotes.jsonl"), "utf8"));
  assert.deepEqual(read.map((x) => [x.text, !!x.me]), [["다 했습니다", false]]);
  process.env.HERDR_INBOX_DIR = a.dir;
  try { HOOK.run({ HC_TERMINAL_ID: "t5" }, { hook_event_name: "UserPromptSubmit", prompt: "다음 것" }, I, () => PO_TERM, Date.UTC(2026, 0, 1, 0, 1)); } finally { delete process.env.HERDR_INBOX_DIR; }
  assert.deepEqual(I.parsePoLines(fs.readFileSync(path.join(a.dir, "po", "devnotes.jsonl"), "utf8")).map((x) => !!x.me), [false, true]);
});

test("po-hook: HC_TERMINAL_ID가 없거나 쓸 글이 없으면 hc를 부르지도 않는다", () => {
  const none = hookRun({}, STOP, PO_TERM);
  assert.equal(none.r, null); assert.equal(none.calls, 0); assert.deepEqual(none.files, []);
  const blank = hookRun({ HC_TERMINAL_ID: "  " }, STOP, PO_TERM);
  assert.equal(blank.calls, 0);
  const nothing = hookRun({ HC_TERMINAL_ID: "t5" }, { hook_event_name: "Stop", last_assistant_message: "" }, PO_TERM);
  assert.equal(nothing.calls, 0); assert.deepEqual(nothing.files, []);
});

test("po-hook: 리더·워커·id 없는 PO·hc 실패 터미널에는 아무것도 쓰지 않는다", () => {
  const cases = [
    { id: "t6", name: "lead-x", parent: "t5", labels: { role: "leader" } },
    { id: "t7", labels: { session: "s1", where: "main / PO · devnotes" } },
    { id: "t5", labels: { role: "po" } },
    { id: "t5", labels: { role: "po", po: "../evil" } },
    { id: "t5", labels: { role: "po", po: "devnotes" }, parent: "t1" },
    { id: "t5", name: "lead-po", labels: { role: "po", po: "devnotes" } },
    null,
  ];
  for (const term of cases) {
    const x = hookRun({ HC_TERMINAL_ID: "t5" }, STOP, term);
    assert.equal(x.r, null, JSON.stringify(term));
    assert.deepEqual(x.files, [], JSON.stringify(term));
  }
});

test("po-hook: 폴더를 쓸 수 없어도 run은 던지고 진입점은 0으로 끝나며 아무것도 출력하지 않는다(진짜 홈은 건드리지 않음)", () => {
  const { spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-hook-e2e-"));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x"); // 폴더가 올 자리에 파일이 있어 mkdir이 실패한다
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "po-hook-bin-"));
  const hc = path.join(bin, "hc");
  fs.writeFileSync(hc, '#!/bin/sh\necho \'{"id":"t5","labels":{"role":"po","po":"devnotes"}}\'\n', { mode: 0o755 });
  const script = path.join(__dirname, "..", "mods", "inbox", "po-hook.cjs");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t5" };
  const bad = spawnSync(process.execPath, [script], { input: JSON.stringify(STOP), encoding: "utf8", env: { ...env, HERDR_INBOX_DIR: blocker } });
  assert.equal(bad.status, 0); assert.equal(bad.stdout, ""); assert.equal(bad.stderr, "");
  const junk = spawnSync(process.execPath, [script], { input: "not json", encoding: "utf8", env: { ...env, HERDR_INBOX_DIR: dir } });
  assert.equal(junk.status, 0); assert.equal(junk.stdout, "");
  if (!POSIX) return; // 가짜 hc가 #!/bin/sh 스크립트라 Windows에서는 실행되지 않는다: 끝까지 가는 부분만 건너뛴다
  // 가짜 hc로 끝까지: 한 줄이 쓰인다
  const good = spawnSync(process.execPath, [script], { input: JSON.stringify(STOP), encoding: "utf8", env: { ...env, HERDR_INBOX_DIR: path.join(dir, "inbox") } });
  assert.equal(good.status, 0); assert.equal(good.stdout, "");
  assert.equal(I.parsePoLines(fs.readFileSync(path.join(dir, "inbox", "po", "devnotes.jsonl"), "utf8"))[0].text, "다 했습니다");
});

// ---- R9 (PR #39 리뷰): 질문 패널·공유 기준·대기 줄·행 id
test("promptTail/promptSig: 초 단위로 바뀌는 스피너·타이머 줄은 보이지도, 서명에도 들지 않는다", () => {
  const a = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n✻ Waiting (12s)";
  const b = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n✻ Waiting (13s)";
  assert.deepEqual(I.promptTail(a, 8), ["Do you want to proceed?", "❯ 1. Yes", "  2. No"]);
  assert.equal(I.promptSig(a), I.promptSig(b));
  assert.ok(I.PROMPT_TIMER.test("✻ Thinking… (3s · ↓ 1.2k tokens · esc to interrupt)"));
  assert.ok(I.PROMPT_TIMER.test("  ✶ Cogitating… (1m 5s)"));
  // 선택지·일반 문장은 지우지 않는다
  assert.ok(!I.PROMPT_TIMER.test("1. Yes (10s)"));
  assert.ok(!I.PROMPT_TIMER.test("Run the command for 12s?"));
  assert.ok(!I.PROMPT_TIMER.test("Waiting for the build"));
});
test("promptSame: 타이머·공백만 다르면 같은 화면, 질문이나 선택지가 다르면 다른 화면", () => {
  const base = "Allow edit?\n❯ 1. Yes\n  2. No";
  assert.equal(I.promptSame(`${base}\n✻ Waiting (1s)`, `${base}\n✻ Waiting (2s)  `), true);
  assert.equal(I.promptSame(base, `${base}\n`), true);
  assert.equal(I.promptSame(base, "Allow edit?\n  1. Yes\n❯ 2. No"), false);
  assert.equal(I.promptSame(base, "Allow write?\n❯ 1. Yes\n  2. No"), false);
  assert.equal(I.promptSame("", ""), true);
  assert.equal(I.promptSame("", base), false);
});
test("keepWaiting: 필터가 숨겨도 아직 기다리는 줄은 남고, 순서는 그대로", () => {
  const raw = [{ key: "a", who: "l:x", it: { kind: "done" } }, { key: "b", who: "l:y", waiting: "decision" }, { key: "c", who: "l:x", it: { kind: "stop" } }, { key: "d", who: "l:y", waiting: "verify", wait: true }];
  const shown = I.filterEntries(raw, "stop", 0);
  assert.deepEqual(shown.map((e) => e.key), ["c"]);
  assert.deepEqual(I.keepWaiting(raw, shown).map((e) => e.key), ["b", "c", "d"]);
  assert.deepEqual(I.keepWaiting(raw, raw).map((e) => e.key), ["a", "b", "c", "d"]);
  assert.deepEqual(I.keepWaiting(null, null), []);
  // 칩 개수는 그대로(필터 결과 기준)
  assert.equal(I.filterCounts(raw, 0).stop, 1);
});
test("snapStep/snapBase: 첫 복사본이 잡은 기준을 다른 복사본이 30초 동안 같이 쓴다", () => {
  const T = 1_000_000;
  // 처음: 방의 마지막 읽음(50)을 기준으로 잡아 저장
  let st = I.snapStep(undefined, "r1", { r1: 50 }, T);
  assert.equal(st.base, 50);
  assert.deepEqual(st.next, { r1: { seen: 50, ts: T } });
  // 읽음 표시가 올라간 뒤(seen=999) 다른 복사본이 열어도 기준은 50
  assert.equal(I.snapBase(st.next, "r1", { r1: 999 }, T + 5000), 50);
  let st2 = I.snapStep(st.next, "r1", { r1: 999 }, T + 5000);
  assert.equal(st2.base, 50);
  assert.equal(st2.next, null); // ttl/3 안이라 다시 쓰지 않는다
  // ttl/3 지나면 시각만 갱신
  st2 = I.snapStep(st.next, "r1", { r1: 999 }, T + 12000);
  assert.deepEqual(st2.next, { r1: { seen: 50, ts: T + 12000 } });
  // 30초 동안 아무도 그리지 않으면 만료: 현재 읽음 표시가 새 기준
  assert.equal(I.snapBase(st.next, "r1", { r1: 999 }, T + 31000), 999);
  st2 = I.snapStep(st.next, "r1", { r1: 999 }, T + 31000);
  assert.deepEqual(st2.next, { r1: { seen: 999, ts: T + 31000 } });
  // 다른 방은 따로, 만료된 방은 지운다
  st2 = I.snapStep({ r1: { seen: 50, ts: T }, r2: { seen: 7, ts: T + 40000 } }, "r2", { r2: 70 }, T + 45000);
  assert.deepEqual(st2.next, { r2: { seen: 7, ts: T + 40000 } });
  assert.equal(st2.base, 7);
  assert.deepEqual(I.snapStep({}, "", {}, T), { base: 0, next: null });
  assert.equal(I.snapBase(null, "r1", null, T), 0);
});
test("tlId: 80자까지는 그대로, 넘으면 앞 64자 + 전체 해시라 '#n'이 잘려도 id가 다르다", () => {
  assert.equal(I.tlId("abc#2"), "tl-abc#2");
  const long = "k".repeat(100);
  const a = I.tlId(long), b = I.tlId(`${long}#2`);
  assert.notEqual(a, b);
  assert.match(a, /^tl-k{64}~[0-9a-f]{8}$/);
  assert.equal(I.tlId(long), a);
  assert.ok(a.length <= 3 + 64 + 9);
  assert.equal(I.tlId(undefined), "tl-");
});
test("main.js: 질문 패널 — 왼쪽 눌림 stop, 같은 화면이면 상태·다시 그리기 생략, 한 줄 다시 읽기, 나이 표시 없음", () => {
  const src = mainSrc();
  const pp = methodOf(src, "  promptPanel(t, v, cx) {", "  // A panel answer");
  assert.match(pp, /id\("po-prompt"\)[^\n]*on_mouse_down\("left", stop\)/);
  assert.ok(!/초 전 화면/.test(pp));
  const rp = methodOf(src, "  readPrompt(po, cx) {", "  // A key press from the question panel");
  assert.match(rp, /promptSame\(this\.prompt\.text, text\)/);
  assert.match(rp, /if \(!same\) this\.softNotify\(cx\)/); // 드래그 중에는 softNotify가 다시 그리기를 미룬다
  assert.match(rp, /chain === this\.promptChain && this\.isBlocked\(po\)\) this\.readPrompt\(po, c2\)/);
  assert.match(src, /id = tlId\(e\.key\)/);
});

test("po-hook: 쓰는 파일은 0600이고(이미 있던 파일도 조인다), 1MiB를 넘으면 새 줄만 남기고 줄 단위로 줄인다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-hook-cap-"));
  const file = path.join(dir, "devnotes.jsonl");
  fs.writeFileSync(file, '{"a":1}\n', { mode: 0o644 });
  HOOK.appendLine(file, '{"b":2}\n');
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n{"b":2}\n');
  const row = JSON.stringify({ k: "x".repeat(1000) }) + "\n";
  fs.writeFileSync(file, row.repeat(Math.ceil(HOOK.FILE_MAX / row.length) + 5));
  HOOK.appendLine(file, '{"last":1}\n');
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.length <= HOOK.KEEP + 20, `줄어듦 ${text.length}`);
  assert.ok(text.endsWith('{"last":1}\n'));
  for (const l of text.trim().split("\n")) JSON.parse(l); // 잘린 줄이 남지 않는다
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["devnotes.jsonl"]); // 임시 파일이 남지 않는다
});

// ---- (C) 입력 중 "···" 말풍선, 폴더 감시로 바로 갱신, Enter(한글 IME)
const tm = (o) => ({ address: "t1", name: "", labels: {}, status: "idle", parent: "", where: "", title: "", ...o });
const poT = (o = {}) => tm({ address: "tp", name: "po-a", labels: { role: "po", po: "pa" }, where: "공간 / PO · 데스크", ...o });
const leadT = (n, o = {}) => tm({ address: `t-${n}`, name: n, parent: "tp", ...o });

test("typingNow: 방의 PO와 그 방 리더 중 working인 것만, 이름순으로 낸다", () => {
  const terms = [poT({ status: "working" }), leadT("lead-b", { status: "working", title: "베타 작업" }), leadT("lead-a", { status: "working", title: "알파 작업" }), leadT("lead-c", { status: "idle" }), leadT("lead-d", { status: "blocked" })];
  assert.deepEqual(I.typingNow(terms, "pa", {}), [{ who: "po", name: "데스크", label: "작업중" }, { who: "l:lead-d", name: "d", label: "승인 대기" }, { who: "l:lead-b", name: "베타 작업", label: "작업중" }, { who: "l:lead-a", name: "알파 작업", label: "작업중" }]); // PO 먼저, 리더는 이름순; 권한 기다림(blocked)도 일하는 중으로 센다
  assert.deepEqual(I.typingNow([poT({ status: "blocked" })], "pa", {}), []); // PO 줄은 working만
  assert.deepEqual(I.typingNow([poT({ status: "idle" }), leadT("lead-c", { status: "done" })], "pa", {}), []); // 쓰는 중이 아니면 없다
  assert.deepEqual(I.typingNow([poT({ status: " Working " })], "pa", {}).map((x) => x.who), ["po"]); // 대소문자·공백 무시
});

test("typingNow: 다른 방의 리더·PO는 내지 않고, PO 모름 방에는 PO 줄이 없다", () => {
  const other = { address: "tq", name: "po-b", labels: { role: "po", po: "pb" }, status: "working", where: "공간 / PO · 다른", parent: "" };
  const terms = [poT(), other, leadT("lead-x", { status: "working" }), { address: "t9", name: "lead-orphan", labels: {}, status: "working", parent: "" }];
  assert.deepEqual(I.typingNow(terms, "pa", {}).map((x) => x.who), ["l:lead-x"]);
  assert.deepEqual(I.typingNow(terms, "pb", {}).map((x) => x.who), ["po"]);
  assert.deepEqual(I.typingNow(terms, I.PO_OTHER, {}).map((x) => x.who), ["l:lead-orphan"]); // PO 모름: PO 줄 없음
  assert.deepEqual(I.typingNow(terms, "", {}), []);
  assert.deepEqual(I.typingNow(null, "pa", {}), []);
  assert.deepEqual(I.typingNow([poT({ status: "working" }), leadT("lead-x", { status: "working" }), leadT("lead-x", { address: "t-dup", status: "working" })], "pa", {}).filter((x) => x.who === "l:lead-x").length, 1); // 같은 이름은 한 번
});

test("statusSig: 상태·기다림 라벨·이름이 바뀔 때만 달라지고, 순서와 상관없는 터미널은 무시한다", () => {
  const a = [poT(), leadT("lead-a", { title: "알파", status: "working" })];
  const base = I.statusSig(a);
  assert.equal(I.statusSig([...a].reverse()), base); // 순서와 무관
  assert.equal(I.statusSig([...a, tm({ address: "tz", name: "shell", status: "working" })]), base); // PO도 리더도 아닌 터미널
  assert.notEqual(I.statusSig([poT(), leadT("lead-a", { title: "알파", status: "idle" })]), base); // 상태
  assert.notEqual(I.statusSig([poT(), leadT("lead-a", { title: "알파", status: "working", labels: { wait: "decision" } })]), base); // 기다림
  assert.notEqual(I.statusSig([poT(), leadT("lead-a", { title: "새 이름", status: "working" })]), base); // 이름
  assert.notEqual(I.statusSig([poT({ status: "working" }), a[1]]), base); // PO 상태
  assert.equal(I.statusSig(null), "");
});

test("collect: 읽은 폴더 경로(dir)를 돌려준다(폴더 감시용) — 폴더가 없어도", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-dir-"));
  assert.equal(I.collect(dir).dir, dir);
  assert.equal(I.collect(path.join(dir, "nope")).dir, path.join(dir, "nope"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("main.js: 폴더 감시는 그려질 때만 걸고, 안 그려지면 풀며, 감시가 끝나면 타이머가 대신한다", () => {
  const src = mainSrc();
  assert.match(src, /import \{[^}]*\bwatchFolder\b[^}]*\} from "herdr"/);
  assert.match(src, /cx\.timer\.every\(STATUS_POLL_MS, \(cx\) => this\.pollStatus\(cx\)\)/);
  assert.match(src, /cx\.timer\.every\(this\.refreshMs\(\)/); // 타이머는 그대로
  const poll = methodOf(src, "  pollStatus(cx) {", "  refreshMs()");
  assert.match(poll, /if \(!this\.drawing\(\)\) \{ this\.stopWatch\(\); return; \}/);
  assert.match(poll, /statusSig\(terms\)/);
  assert.match(poll, /this\.liveTerms\(\)/);
  assert.match(poll, /graceKey\(this\.typingAt, now\)/); // 말미 유예가 끝나면 서명이 달라져 점이 사라진다
  assert.match(poll, /if \(first\) return;/); // 처음 한 번은 다시 그리지 않는다
  const start = methodOf(src, "  startWatch(cx) {", "  pollStatus(cx)");
  assert.match(start, /watchFolder\(dir\)/);
  assert.match(start, /if \(this\.watch \|\| !dir/); // 이미 걸려 있으면 또 걸지 않는다
  assert.match(start, /mine !== this\.watchGen/); // 취소된 감시는 아무것도 하지 않는다
  assert.match(start, /!paths\.length\) break/); // []로 끝나면 루프를 접고 다음 poll이 다시 건다
  assert.match(methodOf(src, "  stopWatch() {", "  startWatch(cx)"), /watchGen\+\+[\s\S]*cancel\(\)/);
  assert.match(src, /if \(this\.busy\) \{ this\.again = true; return; \}|this\.again = true/); // 읽는 중이면 한 번 더
  assert.match(src, /if \(this\.again\)/);
});

test("startWatch·stopWatch·pollStatus: 가짜 런타임으로 감시 한 번, 취소, 변화 때만 다시 그리기", async () => {
  const src = mainSrc();
  const calls = { watch: 0, cancel: 0 };
  let resolve;
  const mkWatch = () => { calls.watch++; const p = new Promise((r) => { resolve = r; }); p.cancel = () => { calls.cancel++; resolve([]); }; return p; };
  const g = mkGlobals({ watchFolder: mkWatch, statusSig: I.statusSig, graceKey: I.graceKey, Date, STATUS_POLL_MS: 1500, WATCH_DEBOUNCE_MS: 5, Array });
  const m = {
    ...runMethod(src, "  stopWatch() {", "  // Starts watching", g),
    ...runMethod(src, "  startWatch(cx) {", "  // Every STATUS_POLL_MS", g),
    ...runMethod(src, "  pollStatus(cx) {", "  refreshMs()", g),
  };
  const loads = [];
  let drawing = true, terms = [poT()], notified = 0, badged = 0;
  const self = { watch: null, watchGen: 0, debounced: false, sig: null, typingAt: new Map(), syncTyping: () => {}, data: { dir: "/x/inbox" }, drawing: () => drawing, liveTerms: () => terms, badge: () => badged++, load: (c) => loads.push(c), ui: {} };
  self.softNotify = (c) => c.notify(); // (the real one waits while a selection is held: see the quietNow test)
  for (const k of Object.keys(m)) self[k] = m[k].bind(self);
  const cx = { spawn: (f) => f({ timer: { after: (ms, fn) => setTimeout(() => fn({}), ms) } }), notify: () => notified++, timer: { after: (ms, fn) => setTimeout(() => fn({}), ms) } };
  self.pollStatus(cx); await tick();
  assert.equal(calls.watch, 1); // 그려지는 동안 감시를 건다
  self.pollStatus(cx); await tick();
  assert.equal(calls.watch, 1); // 두 번 걸지 않는다
  assert.equal(notified, 0); // 처음 poll은 다시 그리지 않는다
  terms = [poT({ status: "working" })];
  self.pollStatus(cx);
  assert.equal(notified, 1); assert.equal(badged, 1); // 바뀌면 한 번
  self.pollStatus(cx);
  assert.equal(notified, 1); // 가만하면 다시 그리지 않는다
  // 폴더에 변화가 오면 짧은 뒤 한 번 읽는다(여러 번 와도 한 번)
  const first = resolve; first(["/x/inbox/a.jsonl"]); await tick();
  resolve(["/x/inbox/b.jsonl"]); await tick();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(loads.length, 1);
  assert.equal(calls.watch, 3); // 변화 묶음마다 다음 변화를 위해 다시 기다린다(1 + 묶음 2)
  // 안 그려지면 감시를 푼다
  drawing = false;
  self.pollStatus(cx); await tick();
  assert.equal(calls.cancel, 1); assert.equal(self.watch, null);
  const w = calls.watch;
  self.pollStatus(cx); await tick();
  assert.equal(calls.watch, w); // 풀린 뒤에는 걸지 않는다
  drawing = true;
  self.pollStatus(cx); await tick();
  assert.equal(calls.watch, w + 1); // 다시 그려지면 다시 건다
  self.stopWatch();
});

test("typingRow·full: ··· 말풍선은 모든 필터에서 그리고, 안 읽은 수·따라가기·위치 지도에는 넣지 않는다", () => {
  const src = mainSrc();
  assert.match(src, /\n    for \(const x of this\.typing\(v\)\) blocks\.push\(this\.typingRow\(t, x\)\);/);
  const row = methodOf(src, "  typingRow(t, x) {", "  render(cx)");
  assert.match(row, /"···"/);
  assert.ok(!/on_mouse_down|text_view|TextView|selectable/.test(row)); // 드래그를 가로채지 않는다
  const full = methodOf(src, "  full(cx) {", "const waiting = v.tabs");
  const typingAt = full.indexOf("typingRow"), keyAt = full.indexOf("const key = tlKey(");
  assert.ok(typingAt > 0 && typingAt < keyAt); // 따라가기 키를 만들기 전에 붙이되
  assert.ok(!/typingNow|typingRow/.test(full.slice(keyAt))); // 키·안 읽은 것·seenNext는 건드리지 않는다
  assert.ok(!/at\.set\([^)]*typing/.test(full));
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(!/typingNow|isWorking/.test(cjs.slice(0, cjs.indexOf("// chat:begin")))); // 순수 블록 안에만 있다
});

test("editCore·strayHeld: 위젯이 넣은 줄바꿈은 편집이 아니고, 붙든 Enter가 남긴 줄바꿈만 걷어낸다", () => {
  assert.equal(I.editCore("안녕\n"), "안녕");
  assert.equal(I.editCore("안녕\n\n"), "안녕");
  assert.equal(I.editCore("안\n녕"), "안\n녕"); // 가운데 줄바꿈은 글이다
  assert.equal(I.editCore(null), "");
  assert.equal(I.strayHeld("안녕\n", 1000, 1050), true); // 붙든 직후 끝의 줄바꿈
  assert.equal(I.strayHeld("안녕", 1000, 1050), false); // 줄바꿈이 없다
  assert.equal(I.strayHeld("안녕\n", 1000, 1000 + I.HELD_BREAK_MS), false); // 오래 지났다
  assert.equal(I.strayHeld("안녕\n", 0, 1050), false); // 붙든 적 없다(Shift+Enter 줄바꿈은 건드리지 않는다)
});

test("Enter 흐름: 위젯이 넣은 줄바꿈은 IME 붙들기를 매번 켜지 않아, 한글 뒤 Enter 한 번에 보내고 이중 Enter는 붙들지 않는다", () => {
  // 사용자 보고: 그냥 Enter를 치면 줄바꿈이 되고 보내지지 않는다. 원인 후보 — 위젯이 Enter에 "\n"을 넣고 change를 내면
  // changedAt이 '방금'이 되어 imeHold가 첫 Enter를 늘 붙든다. editAt은 줄바꿈을 뗀 글이 바뀐 때만 움직인다.
  const hold = (value, editAt, heldAt, now) => I.imeHold(value, editAt, heldAt, now);
  const typedAt = 10_000;
  // 끝이 한글이 아니면 잠깐 쉰 뒤의 Enter는 바로 보낸다 — 위젯이 "\n"을 넣어 change가 now에 났어도 편집 시각(editAt)은 그대로다
  assert.equal(hold("hello", typedAt, 0, typedAt + 1000), false);
  // 끝이 한글이면 IME가 아직 글자를 조합 중인지 키 이벤트로는 알 수 없어(KeyEvent에 composing 표시가 없다) 첫 Enter는 한 번 붙든다
  assert.equal(hold("가나다", typedAt, 0, typedAt + 1000), true);
  // 방금(500ms 안) 글이 바뀌었으면 IME 확정 Enter일 수 있으니 한 번 붙든다 — 끝이 한글이면
  assert.equal(hold("가나다", typedAt, 0, typedAt + 100), true);
  // 붙든 뒤 둘째 Enter는 보낸다
  assert.equal(hold("가나다", typedAt, typedAt + 100, typedAt + 400), false);
  // 편집 시각을 줄바꿈 뗀 글로 재는 흐름을 가짜 change 이벤트로 돌린다
  let core = "", editAt = 0;
  const change = (value, now) => { const c = I.editCore(value); if (c !== core) { core = c; editAt = now; } };
  change("가나다", typedAt);
  change("가나다\n", typedAt + 1000); // 위젯의 줄바꿈
  assert.equal(editAt, typedAt);
  assert.equal(hold("hello\n", typedAt, 0, typedAt + 1000), false);
  // 붙든 Enter가 위젯의 줄바꿈 change(편집 시각은 그대로)를 만들어도 둘째 Enter는 붙들지 않는다
  assert.equal(hold("가나다\n", editAt, typedAt + 1000, typedAt + 1500), false);
  change("가나다\n라", typedAt + 1100); // 진짜 편집
  assert.equal(editAt, typedAt + 1100);
  // main.js 배선: 줄바꿈 뗀 글이 바뀔 때만 editAt이 움직이고, 보내기 판단은 editAt을 쓴다
  const src = mainSrc();
  assert.match(src, /if \(core !== this\.core\) \{ this\.core = core; this\.editAt = this\.changedAt; \}/);
  assert.match(src, /dropBreak\(value\) \{/);
  assert.match(src, /if \(strayHeld\(value, now, now\) && now - this\.changedAt <= 25\) this\.dropBreak\(value\)/);
  assert.match(src, /needsNewline\(this\.changedAt, now\)/); // Shift+Enter의 줄바꿈 보충은 원래 시각(changedAt) 그대로
});

// ---- PO 새로 시작 (#41) ----
test("restartBlock: PO 없음/작업 중/질문 중/진행 중이면 이유를, 쉬는 PO면 빈 글을 준다", () => {
  assert.match(I.restartBlock({}), /찾지 못/);
  assert.match(I.restartBlock({ po: "p", status: "working" }), /작업 중/);
  assert.match(I.restartBlock({ po: "p", status: "blocked" }), /질문 중/);
  assert.match(I.restartBlock({ po: "p", status: "idle", running: true }), /새로 시작하는 중/);
  assert.equal(I.restartBlock({ po: "p", status: "idle" }), "");
  assert.equal(I.restartBlock({ po: "p", status: "" }), "");
});
test("handoffAsk: 표식으로 시작하고 노트 경로를 담는다(영어 한 덩어리)", () => {
  const a = I.handoffAsk("~/.herdr-inbox/po/x.handoff.md");
  assert.ok(a.startsWith(I.RESTART_MARK));
  assert.ok(a.includes("~/.herdr-inbox/po/x.handoff.md"));
  assert.ok(!a.includes("\n"));
});
test("restartConfirm: 무엇이 일어나는지와 결정·확인 대기 수를 함께 보여 준다", () => {
  const c = I.restartConfirm(2, 1);
  assert.match(c, /\/clear/);
  assert.match(c, /\/PO/);
  assert.match(c, /결정 대기 2건/);
  assert.match(c, /확인 대기 1건/);
  assert.doesNotMatch(I.restartConfirm(0, 0), /대기 0건/);
});
test("restartSteps: 네 단계의 done/active/fail/todo", () => {
  assert.deepEqual(I.restartSteps(0).map((s) => s.state), ["active", "todo", "todo", "todo"]);
  assert.deepEqual(I.restartSteps(2).map((s) => s.state), ["done", "done", "active", "todo"]);
  assert.deepEqual(I.restartSteps(4).map((s) => s.state), ["done", "done", "done", "done"]);
  assert.deepEqual(I.restartSteps(1, true).map((s) => s.state), ["done", "fail", "todo", "todo"]);
  assert.deepEqual(I.restartSteps(2).map((s) => s.label), I.RESTART_STEPS);
});
test("restartNoteFresh/restartPoll: 요청 전에 있던 노트는 새 것이 아니다, 새 노트 + 쉬는 PO만 go, 5분이면 timeout", () => {
  const since = 1_000_000;
  const old = { exists: true, size: 9, ms: since - 60_000 };
  const fresh = { exists: true, size: 9, ms: since + 5_000 };
  assert.equal(I.restartNoteFresh(old, since), false);
  assert.equal(I.restartNoteFresh(fresh, since), true);
  assert.equal(I.restartNoteFresh({ exists: true, size: 0, ms: since + 5 }, since), false);
  assert.equal(I.restartNoteFresh({ exists: false, size: 0, ms: 0 }, since), false);
  const now = since + 10_000;
  assert.equal(I.restartPoll({ note: old, since, now, status: "idle", quiet: 5 }), "wait");
  assert.equal(I.restartPoll({ note: fresh, since, now, status: "working", quiet: 5 }), "idle-wait");
  assert.equal(I.restartPoll({ note: fresh, since, now, status: "idle", quiet: 0 }), "idle-wait");
  assert.equal(I.restartPoll({ note: fresh, since, now, status: "idle", quiet: 1 }), "go");
  assert.equal(I.restartPoll({ note: old, since, now: since + I.RESTART_WAIT_MS + 1, status: "idle" }), "timeout");
});
test("readHandoff: 노트 파일을 읽고(없으면 exists=false), 이상한 id는 받지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  try {
    assert.equal(I.readHandoff(dir, "p1").exists, false);
    fs.mkdirSync(path.join(dir, "po"), { recursive: true });
    fs.writeFileSync(path.join(dir, "po", "p1.handoff.md"), "# note\nhello");
    const h = I.readHandoff(dir, "p1");
    assert.equal(h.exists, true);
    assert.equal(h.text, "# note\nhello");
    assert.ok(h.ms > 0 && h.size > 0);
    assert.equal(I.readHandoff(dir, "../x").exists, false);
    assert.equal(I.handoffFile(dir, "../x"), null);
    assert.ok(I.handoffFile(dir, "p1").endsWith("p1.handoff.md"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("main.js: PO 새로 시작 배선 — 방별 상태, 버튼은 막힌 이유와 함께, 확인 줄, 단계 줄, 노트 말풍선, 지우기 전 확인", () => {
  const src = mainSrc();
  assert.match(src, /this\.rs = new Map\(\)/);
  assert.match(src, /restartRow\(t, v, cx\) \{/);
  assert.match(src, /"PO 새로 시작", \(c\) => this\.restartOpen\(room, c\), \{ disabled: why/);
  assert.match(src, /restartConfirm\(waiting\("decision"\), waiting\("verify"\)\)/);
  assert.match(src, /"새로 시작", \(c\) => this\.restartRun\(room, po, room, c\)/);
  assert.match(src, /"다시", \(c\) => this\.restartRun\(/);
  assert.match(src, /restartSteps\(r\.n, failed\)/);
  assert.match(src, /who: "po", head: true, ms: hn\.ms/);
  // sendLine never records a chat bubble; /PO only after the /clear signal; a timeout/failure clears nothing
  const tl = src.slice(src.indexOf("  async sendLine("), src.indexOf("  // 새로 시작 / 다시"));
  assert.doesNotMatch(tl, /setShared|record\(/);
  const fl = src.slice(src.indexOf("  async restartFlow("), src.indexOf("  // The strip above the chat box"));
  assert.ok(fl.indexOf("restartClearState(") < fl.indexOf('"/PO"'));
  assert.match(fl, /\/PO를 보내지 않았습니다/);
  assert.match(fl, /act === "timeout"/);
  // no callback chain after an await: no .then(, and the click's c is only used by restartRun before its spawn
  const rr = src.slice(src.indexOf("  sleepOn("), src.indexOf("  // The strip above the chat box"));
  assert.doesNotMatch(rr, /\.then\(/);
  assert.match(rr, /c\.spawn\(async \(cx\) =>/);
});

// ---- Claude 사용률 한 줄 (#42)
const usageFile = (limits, updatedAt = "2026-11-25T05:05:00Z") => JSON.stringify({ updatedAt, limits });
const USAGE_NOW = Date.parse("2026-11-25T05:10:00Z");

test("usageLine: parseUsage가 5h·7d 행과 리셋 시각을 돌려주고, 없음·깨짐·10분 넘게 오래됨은 null(Unknown)이다", () => {
  const rows = I.parseUsage(usageFile([
    { kind: "five_hour", percentUsed: 53.6, resetsAt: "2026-11-25T10:20:00.000Z" },
    { kind: "seven_day", percentUsed: 34 },
    { kind: "spend_limit", percentUsed: 3 },
  ]), USAGE_NOW);
  assert.deepEqual(rows, [{ label: "5h", percent: 54, resetsAt: Date.parse("2026-11-25T10:20:00.000Z") }, { label: "7d", percent: 34, resetsAt: 0 }]);
  assert.equal(I.parseUsage(null, USAGE_NOW), null);
  assert.equal(I.parseUsage("{oops", USAGE_NOW), null);
  assert.equal(I.parseUsage(usageFile([{ kind: "five_hour", percentUsed: 7 }], "2026-11-25T04:59:00Z"), USAGE_NOW), null); // 11분 전
  assert.ok(I.parseUsage(usageFile([{ kind: "five_hour", percentUsed: 7 }], "2026-11-25T05:01:00Z"), USAGE_NOW)); // 9분 전
  assert.equal(I.parseUsage(usageFile([]), USAGE_NOW), null);
  assert.equal(I.parseUsage(usageFile([{ kind: "five_hour", percentUsed: "x" }]), USAGE_NOW), null);
  assert.equal(I.USAGE_REFRESH_MS, 60000);
  assert.equal(I.USAGE_STALE_MS, 600000);
  assert.equal(I.USAGE_WARN, 80);
});

test("usageLine: 선 막대 폭은 0이면 0, 0보다 크면 최소 폭, 넘쳐도 track을 넘지 않는다", () => {
  assert.equal(I.usageFill(50, 40), 20);
  assert.equal(I.usageFill(0, 40), 0);
  assert.equal(I.usageFill(1, 40), 2);
  assert.equal(I.usageFill(250, 40), 40);
  assert.equal(I.usageFill(-5, 40), 0);
  assert.equal(I.usageFill(NaN, 40), 0);
  assert.ok(I.usageFill(30) > 0 && I.usageFill(30) < I.usageFill(100));
});

test("usageLine: 툴팁은 초기화까지 남은 일·시간·분을 보여 주고 0인 단위는 뺀다", () => {
  const now = new Date(2026, 10, 25, 14, 0).getTime();
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(I.usageLeft(now + 2 * HOUR + 15 * MIN, now), "2시간 15분");
  assert.equal(I.usageLeft(now + 5 * DAY + 4 * HOUR + 41 * MIN, now), "5일 4시간 41분");
  assert.equal(I.usageLeft(now + 5 * DAY + 41 * MIN, now), "5일 41분");
  assert.equal(I.usageLeft(now + 3 * HOUR, now), "3시간");
  assert.equal(I.usageLeft(now + 59 * MIN + 59000, now), "59분");
  assert.equal(I.usageLeft(now + 30000, now), "1분 미만");
  assert.equal(I.usageLeft(now - MIN, now), "");
  assert.equal(I.usageLeft(0, now), "");
  assert.equal(I.usageLeft(now + DAY, now), "1일");
  assert.equal(I.usageLeft(now + DAY - 1, now), "23시간 59분");
  assert.equal(I.usageLeft(now + MIN, now), "1분");
  assert.equal(I.usageLeft(now, now), "1분 미만");
  const rows = [{ label: "5h", percent: 54, resetsAt: now + 2 * HOUR + 15 * MIN }, { label: "7d", percent: 34, resetsAt: now + 5 * DAY + 4 * HOUR + 41 * MIN }];
  assert.equal(I.usageTip(rows, now), "5h 초기화까지 2시간 15분 · 7d 초기화까지 5일 4시간 41분");
  assert.equal(I.usageTip([{ label: "5h", percent: 1, resetsAt: now - HOUR }, rows[1]], now), "5h 초기화 시각이 지났습니다 · 7d 초기화까지 5일 4시간 41분");
  assert.equal(I.usageTip([{ label: "5h", percent: 1, resetsAt: 0 }], now), "초기화 시각 정보가 없습니다");
  assert.match(I.usageTip(null, now), /알 수 없습니다/);
});

test("usageLine: main.js와 inbox.cjs가 같은 블록을 쓴다", () => {
  const block = (f) => {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
    const a = src.indexOf("// usageLine:begin"), b = src.indexOf("// usageLine:end");
    assert.ok(a >= 0 && b > a, f);
    return src.slice(a, b);
  };
  assert.equal(block("../mods/inbox/main.js"), block("../mods/inbox/inbox.cjs"));
});

test("usageLine: main.js 배선 — 파일만 읽고(exec·네트워크 없음), 1분 주기, 80% 경고색, 툴팁, 방 제목 아래, 바뀔 때만 다시 그린다", () => {
  const src = mainSrc();
  const fn = src.slice(src.indexOf("  loadUsage(cx) {"), src.indexOf('  usageLine(t, pick = "") {'));
  assert.match(fn, /readTextFile\(`\$\{home\(\)\}\/\$\{USAGE_FILE\}`\)/);
  assert.doesNotMatch(fn, /exec\(|fetch\(/);
  assert.match(fn, /JSON\.stringify\(\[rows, usageTip\(rows, Date\.now\(\)\)\]\)/);
  assert.match(src, /cx\.timer\.every\(USAGE_REFRESH_MS, \(cx\) => this\.loadUsage\(cx\)\)/);
  assert.match(fn, /if \(sig === this\.usageSig\) return;/);
  const line = src.slice(src.indexOf('  usageLine(t, pick = "") {'), src.indexOf("  // ---- redraw gating"));
  assert.match(line, /u\.percent >= USAGE_WARN/);
  assert.match(line, /\.tooltip\(usageTip\(rows, Date\.now\(\)\)\)/);
  assert.match(line, /"Unknown"/);
  // 방 제목 줄 다음, 걸러내기 줄 앞
  const room = src.slice(src.indexOf("const room = v_flex()"));
  assert.ok(room.indexOf("child(head)") < room.indexOf("el.child(usage)") && room.indexOf("el.child(usage)") < room.indexOf("el.child(bar)"));
});

// ---- PO 새로 시작: hc send로 보낸다 — 화면(칸 너비)에 기대지 않는다 (#41, 3차 사용자 확인 실패: PO 칸 2열) ----
const sendOk = (extra = {}) => ({ code: 0, stdout: JSON.stringify({ started: true, status: "idle", turn: 6, ...extra }), stderr: "" });
test("restartSendResult: 종료 코드 0과 started === true일 때만 성공이고, 그 밖에는 한국어 이유와 diag용 요약을 준다", () => {
  const ok = I.restartSendResult(sendOk({ status: "done", turn: 12 }));
  assert.deepEqual({ ok: ok.ok, turn: ok.turn, status: ok.status, why: ok.why }, { ok: true, turn: 12, status: "done", why: "" });
  assert.equal(I.restartSendResult(sendOk({ started: false })).ok, false);
  assert.equal(I.restartSendResult({ code: 1, stdout: JSON.stringify({ started: true }), stderr: "" }).ok, false, "exit code wins");
  assert.equal(I.restartSendResult({ code: 0, stdout: "not json", stderr: "" }).ok, false);
  assert.equal(I.restartSendResult({ code: 0, stdout: "", stderr: "" }).ok, false);
  assert.equal(I.restartSendResult(null).ok, false);
  const blocked = I.restartSendResult({ code: 1, stdout: JSON.stringify({ error: { kind: "blocked", message: "t9 is blocked" } }), stderr: "" });
  assert.equal(blocked.ok, false); assert.match(blocked.why, /질문 중/);
  const mism = I.restartSendResult({ code: 1, stdout: JSON.stringify({ error: { kind: "status_mismatch", message: "t9 is done, not idle" } }), stderr: "" });
  assert.match(mism.why, /일하는 중/);
  const other = I.restartSendResult({ code: 1, stdout: JSON.stringify({ error: { kind: "x", message: "boom" } }), stderr: "" });
  assert.match(other.why, /boom/);
  const crash = I.restartSendResult({ code: 2, stdout: "", stderr: "e".repeat(500) });
  assert.match(crash.why, /종료 코드 2/);
  assert.ok(crash.detail.length < 400 && /code 2/.test(crash.detail), "detail is trimmed: " + crash.detail.length);
  assert.equal(I.restartSendResult({ code: 0, stdout: JSON.stringify({ started: true, status: "idle" }) }).turn, null, "no turn: null, not NaN");
});
test("restartTerm/restartSendBlock: hc get의 상태·turn을 읽고, 실행 중이고 질문·작업 중이 아닐 때만 보낸다(idle과 done 모두 허용)", () => {
  const get = (o) => ({ code: 0, stdout: JSON.stringify({ state: "live", exit_code: null, status: { state: "idle" }, turn: 3, cols: 2, rows: 115, ...o }), stderr: "" });
  assert.deepEqual(I.restartTerm(get()), { live: true, status: "idle", turn: 3 });
  assert.deepEqual(I.restartTerm(get({ status: { state: "DONE" } })), { live: true, status: "done", turn: 3 });
  assert.equal(I.restartTerm(get({ state: "exited", exit_code: 0 })).live, false);
  assert.equal(I.restartTerm(get({ turn: undefined })).turn, null);
  assert.equal(I.restartTerm({ code: 1, stdout: "" }), null);
  assert.equal(I.restartTerm({ code: 0, stdout: "x" }), null);
  assert.equal(I.restartTerm(null), null);
  const T = (o) => ({ live: true, status: "idle", turn: 3, ...o });
  assert.equal(I.restartSendBlock(T()), "");
  assert.equal(I.restartSendBlock(T({ status: "done" })), "");
  assert.match(I.restartSendBlock(T({ status: "blocked" })), /질문 중/);
  assert.match(I.restartSendBlock(T({ status: "working" })), /일하는 중/);
  assert.match(I.restartSendBlock(T({ live: false })), /실행 중이 아닙니다/);
  assert.match(I.restartSendBlock(null), /읽지 못했습니다/);
});
test("restartClearState: /clear 뒤에는 working·blocked가 아니면서 turn이 보낼 때보다 커졌을 때만 done — 칸 너비와 무관한 신호", () => {
  const T = (o) => ({ live: true, status: "idle", turn: 6, ...o });
  assert.equal(I.restartClearState(6, T({ status: "idle", turn: 6 })), "wait", "turn not up yet");
  assert.equal(I.restartClearState(6, T({ status: "working", turn: 6 })), "wait");
  assert.equal(I.restartClearState(6, T({ status: "working", turn: 7 })), "wait", "counter up but still working");
  assert.equal(I.restartClearState(6, T({ status: "blocked", turn: 7 })), "wait");
  assert.equal(I.restartClearState(6, T({ status: "idle", turn: 7 })), "done");
  assert.equal(I.restartClearState(6, T({ status: "done", turn: 7 })), "done", "herdr turns done into idle only once someone looks at the pane: done counts (the hook record check proves /clear itself)");
  assert.equal(I.restartClearState(6, T({ turn: null })), "wait");
  assert.equal(I.restartClearState(null, T({ turn: 7 })), "wait", "no base turn: never done");
  assert.equal(I.restartClearState(6, T({ live: false })), "gone");
  assert.equal(I.restartClearState(6, null), "gone");
});
// ---- 새로 시작 전체 흐름: 낡은 cx를 쓰면 던지는 가짜 cx로 4단계를 끝까지 돌린다 ----
// A click's or a timer's cx is good only during its own call (the host throws "cx is no longer valid" later); the cx a spawn passes in stays good.
const strictCx = (log, kind = "sync") => {
  const cx = { valid: true, kind };
  const need = (what) => { if (!cx.valid) { const e = new Error(`cx is no longer valid: ${what}`); log.stale.push(what); throw e; } };
  cx.notify = () => { need("notify"); };
  cx.timer = { after: (ms, f) => { need("timer.after"); setImmediate(() => { const c2 = strictCx(log, "timer"); try { f(c2); } finally { c2.valid = false; } }); } };
  cx.spawn = (f) => { need("spawn"); const sc = strictCx(log, "spawn"); log.spawnCx = sc; log.spawned++; Promise.resolve().then(() => f(sc)).catch(() => {}); };
  return cx;
};
// A fake `hc` that knows only `get` and `send` (a PO pane of any width, even 2 columns: there is no screen at all). Any other hc call is recorded in
// log.other; the flow must never make one. `poll` counts the status reads after /clear: the counter goes up on the 3rd.
const restartWorld = ({ clearWorks = true, cols = 2, glue = "", noRecs = false, clearAsText = false, held = [] } = {}) => {
  const src = mainSrc();
  const log = { stale: [], spawned: 0, sends: [], other: [], says: [], diag: [] };
  const po = { status: "idle", turn: 6, noteMs: 0, live: true, sendFail: null, clearPoll: -1, recs: [] }; // recs: the PO hook's "me" lines
  const g = mkGlobals({
    RESTART_POLL_MS: 2000, RESTART_CLEAR_MS: 300, RESTART_REC_MS: 300, CHAT_KEY: "chat", shared: () => held,
    restartDraft: I.restartDraft, restartSubmitCheck: I.restartSubmitCheck, restartClearCheck: I.restartClearCheck, RESTART_MARK: I.RESTART_MARK,
    restartBlock: I.restartBlock, restartPoll: I.restartPoll, restartNoteFresh: I.restartNoteFresh,
    restartSendResult: I.restartSendResult, restartTerm: I.restartTerm, restartSendBlock: I.restartSendBlock, restartClearState: I.restartClearState,
    handoffAsk: I.handoffAsk, HELPER: () => "h.cjs",
    exec: async (c, a) => a[1] === "po-me" ? { code: 0, stdout: JSON.stringify(po.recs) } : ({ code: 0, stdout: JSON.stringify({ path: "/n.md", exists: po.noteMs > 0, ms: po.noteMs, size: po.noteMs ? 20 : 0, text: po.noteMs ? "note" : "" }) }),
    hc: async (a) => {
      if (a[0] === "get") {
        if (po.clearPoll >= 0 && ++po.clearPoll >= 3 && clearWorks) { po.status = "idle"; po.turn++; po.clearPoll = -1; }
        return { code: 0, stdout: JSON.stringify({ address: a[1], state: po.live ? "live" : "exited", exit_code: po.live ? null : 0, status: { state: po.status }, turn: po.turn, cols, rows: 115 }), stderr: "" };
      }
      if (a[0] === "send") {
        assert.deepEqual(a.slice(0, 4), ["send", "--json", "--", a[3]]); assert.ok(!a.includes("--if"), "no --if: it refuses a PO that is 'done'");
        const text = a[4];
        if (po.sendFail) return po.sendFail;
        log.sends.push(text);
        // the hook records what was submitted: a glued draft comes in front; the built-in /clear records nothing (unless the test makes it go as text)
        if (!noRecs && (text !== "/clear" || clearAsText)) po.recs.push({ ms: Date.now(), text: (text === "/clear" ? "" : glue) + text });
        const before = { status: po.status, turn: po.turn };
        if (text.startsWith(I.RESTART_MARK)) { po.noteMs = Date.now() + 5; po.turn++; }
        else if (text === "/clear") { po.status = "working"; po.clearPoll = 0; }
        else if (text === "/PO") po.turn++;
        return { code: 0, stdout: JSON.stringify({ started: true, ...before }), stderr: "" };
      }
      log.other.push(a.join(" "));
      return { code: 0, stdout: "" };
    },
  });
  const self = {
    rs: new Map(), rgen: 0,
    liveTerms: () => [{ address: "t9", status: po.status }], isBlocked: () => po.status === "blocked",
    say: (m) => log.says.push(m), diag: (m) => log.diag.push(m),
  };
  const grab = (head, next) => Object.assign(self, runMethod(src, head, next, g));
  grab("  restartAlive(room, g)", "  restartSet(");
  grab("  restartSet(room, g, patch, c) {", "  restartFail(");
  grab("  restartFail(", "  restartOpen(");
  grab("  restartClose(", "  // The helper reads");
  grab("  async handoffRead(id) {", "  // The whole run is ONE");
  grab("  sleepOn(cx, ms) {", "  // The PO's \"me\" records");
  grab("  async poMe(id) {", "  // Waits (bounded)");
  grab("  async poProof(", "  // The PO's {live, status, turn}");
  grab("  async poTerm(po) {", "  // One line to the PO through");
  grab("  async sendLine(po, text, still", "  // 새로 시작 / 다시");
  grab("  restartRun(room, po, id, c) {", "  // Steps 1-4.");
  grab("  async restartFlow(", "  // The strip above the chat box");
  const click = () => { const c = strictCx(log); try { self.restartRun("r", "t9", "r", c); } finally { c.valid = false; } };
  const settle = async (ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await tick(); const r = self.rs.get("r"); if (r && (r.phase === "done" || r.phase === "fail" || r.phase === "timeout")) break; } };
  return { self, po, log, click, settle };
};
test("새로 시작 전체 흐름(PO 칸 2열): 노트 요청 → 노트 → /clear → /PO가 hc send로만 끝까지 가고, 화면·붙여넣기·키 입력은 한 번도 쓰이지 않는다", async () => {
  const w = restartWorld({ cols: 2 });
  w.click();
  await w.settle(20000);
  const r = w.self.rs.get("r");
  assert.deepEqual(w.log.stale, [], "stale cx used");
  assert.equal(r.phase, "done", JSON.stringify(r) + w.log.says.join("|") + w.log.diag.join("|"));
  assert.equal(r.n, 4);
  assert.equal(w.log.sends.length, 3);
  assert.ok(w.log.sends[0].startsWith(I.RESTART_MARK));
  assert.deepEqual(w.log.sends.slice(1), ["/clear", "/PO"]);
  assert.deepEqual(w.log.other, [], "only hc get / hc send: no read, no keys");
  assert.equal(w.log.spawned, 1);
});
test("새로 시작: /clear가 끝났다는 신호(turn 증가)가 없으면 /PO를 보내지 않고 멈추며, 이유를 diag에 남긴다", async () => {
  const w = restartWorld({ clearWorks: false });
  w.click();
  await w.settle(20000);
  const r = w.self.rs.get("r");
  assert.deepEqual(w.log.stale, []);
  assert.equal(r.phase, "fail");
  assert.match(r.why, /\/clear가 끝났는지 확인하지 못해/);
  assert.deepEqual(w.log.sends.slice(1), ["/clear"]);
  assert.ok(w.log.diag.some((d) => /not confirmed: sent turn 7/.test(d)), w.log.diag.join("|"));
});
test("새로 시작: PO 입력칸에 남은 글이 요청 앞에 붙어 보내졌다면(훅 기록이 요청과 다름) /clear 전에 멈춘다", async () => {
  const w = restartWorld({ glue: "남은 초안 " });
  w.click();
  await w.settle(20000);
  const r = w.self.rs.get("r");
  assert.equal(r.phase, "fail");
  assert.match(r.why, /입력칸에 남아 있던 글이 요청과 함께 보내졌습니다\. 입력칸을 비운 뒤 다시 눌러 주세요/);
  assert.equal(w.log.sends.length, 1, "no /clear");
});
test("새로 시작: 요청의 훅 기록이 제때 오지 않으면 보수적으로 /clear 전에 멈춘다", async () => {
  const w = restartWorld({ noRecs: true });
  w.click();
  await w.settle(20000);
  const r = w.self.rs.get("r");
  assert.equal(r.phase, "fail");
  assert.match(r.why, /PO 기록으로 확인하지 못해 \/clear를 보내지 않았습니다/);
  assert.equal(w.log.sends.length, 1);
});
test("새로 시작: /clear 뒤에 PO의 새 'me' 기록이 생기면(글로 들어감) turn이 올라도 /PO를 보내지 않는다", async () => {
  const w = restartWorld({ clearAsText: true });
  w.click();
  await w.settle(20000);
  const r = w.self.rs.get("r");
  assert.equal(r.phase, "fail");
  assert.match(r.why, /\/clear가 명령이 아니라 글로/);
  assert.deepEqual(w.log.sends.slice(1), ["/clear"]);
});
test("새로 시작: 데스크가 붙여 넣기만 한 글(held)이 이 방에 있으면 어떤 send도 하지 않는다", async () => {
  const w = restartWorld({ held: [{ po: "r", status: "held", at: Date.now() - 1000 }] });
  const res = await w.self.sendLine("t9", "x", () => true, "r");
  assert.equal(res.ok, false); assert.match(res.why, /입력칸에 남은 글.*아무것도 보내지 않았습니다/);
  assert.deepEqual(w.log.sends, []);
  w.click(); await w.settle(3000);
  assert.deepEqual(w.log.sends, [], "the run stops before its first send too");
  assert.equal(w.self.rs.get("r").phase, "fail");
});
test("restartSubmitCheck/restartClearCheck: 요청과 똑같이 기록되면 ok, 앞에 글이 붙으면 mismatch, 기록이 없으면 wait; /clear 뒤 기록이 있으면 text", () => {
  const ask = "[desk:handoff] write the note\n  to /x.md";
  const rec = (text, ms = 100) => ({ ms, text });
  assert.equal(I.restartSubmitCheck([rec("[desk:handoff] write the note to /x.md")], 50, ask), "ok", "whitespace-insensitive exact match");
  assert.equal(I.restartSubmitCheck([rec("draft [desk:handoff] write the note to /x.md")], 50, ask), "mismatch");
  assert.equal(I.restartSubmitCheck([rec("[desk:handoff] write the note to /x.md and more")], 50, ask), "mismatch");
  assert.equal(I.restartSubmitCheck([], 50, ask), "wait");
  assert.equal(I.restartSubmitCheck([rec("old", 10)], 50, ask), "wait", "records from before the send do not count");
  assert.equal(I.restartSubmitCheck([rec("[desk:handoff] write the…")], 50, ask), "ok", "a record cut at the hook's limit still matches as a prefix");
  assert.equal(I.restartSubmitCheck([rec("x [desk:handoff] write the…")], 50, ask), "mismatch");
  assert.equal(I.restartClearCheck([], 50), "clean");
  assert.equal(I.restartClearCheck([rec("old", 10)], 50), "clean");
  assert.equal(I.restartClearCheck([rec("/clear")], 50), "text");
  assert.equal(I.restartClearCheck([rec("draft/clear")], 50), "text");
});
test("새로 시작: 노트 요청 send가 실패하면 아무것도 더 보내지 않고 멈추며, hc 출력을 짧게 diag에 남긴다(화면은 남기지 않는다)", async () => {
  const w = restartWorld();
  w.po.sendFail = { code: 1, stdout: JSON.stringify({ error: { kind: "blocked", message: "t9 is blocked" } }), stderr: "" };
  w.click();
  await w.settle(5000);
  const r = w.self.rs.get("r");
  assert.equal(r.phase, "fail"); assert.equal(r.n, 0);
  assert.match(r.why, /노트를 요청하지 못했습니다\(PO가 질문 중이라 받지 않았습니다\)/);
  assert.deepEqual(w.log.sends, []);
  assert.ok(w.log.diag.some((d) => /restart send failed: code 1; stdout .*blocked/.test(d)), w.log.diag.join("|"));
  assert.ok(!w.log.diag.some((d) => /row \d+:/.test(d)), "no screen dump");
});
test("새로 시작: 보내기 전에 PO가 질문 중·작업 중·꺼져 있으면 send를 부르지 않는다", async () => {
  for (const [patch, re] of [[{ status: "blocked" }, /질문 중/], [{ status: "working" }, /일하는 중/], [{ live: false }, /실행 중이 아닙니다/]]) {
    const w = restartWorld();
    const c = strictCx(w.log);
    const res = await w.self.sendLine("t9", "/clear", () => true).catch((e) => e);
    assert.equal(res.ok, true, "idle PO takes it");
    w.log.sends.length = 0; Object.assign(w.po, patch);
    const res2 = await w.self.sendLine("t9", "/clear", () => true);
    assert.equal(res2.ok, false); assert.match(res2.why, re); assert.match(res2.why, /아무것도 보내지 않았습니다/);
    assert.deepEqual(w.log.sends, []); c.valid = false;
  }
  const w = restartWorld(); w.po.status = "done"; // a PO that just finished is "done": accepted
  assert.equal((await w.self.sendLine("t9", "x", () => true)).ok, true);
  const w2 = restartWorld(); // cancelled: nothing is sent
  assert.equal((await w2.self.sendLine("t9", "x", () => false)).ok, false); assert.deepEqual(w2.log.sends, []);
});
test("새로 시작: 클릭의 c는 낡으면 던지는 것으로 확인 — 클릭 뒤에 c를 쓰면 시험이 실패한다(시험의 감시 장치)", () => {
  const log = { stale: [], spawned: 0 };
  const c = strictCx(log);
  c.valid = false;
  assert.throws(() => c.notify(), /no longer valid/);
  assert.throws(() => c.timer.after(1, () => {}), /no longer valid/);
});
test("새로 시작: 흐름 도중 spawn cx가 낡으면(모드 다시 읽힘) 더 확인하지 않고 끝난다", async () => {
  const w = restartWorld();
  let reads = 0;
  const orig = w.self.handoffRead;
  w.self.handoffRead = async (id) => { reads++; return orig.call(w.self, id); };
  w.po.noteMs = 0;
  w.click();
  while (reads < 2) await tick();
  w.log.spawnCx.valid = false;
  w.po.noteMs = 0; // no fresh note can show up: only a stopped flow ends here
  const at = reads;
  for (let i = 0; i < 50; i++) await tick();
  assert.ok(reads <= at + 1, `handoffRead kept running: ${reads} after ${at}`);
  assert.equal(w.self.rs.get("r").phase, "fail");
});
test("새로 시작: 사람이 닫으면(restartClose) 지켜보기를 끝내고 더 보내지 않는다", async () => {
  const w = restartWorld();
  const orig = w.self.handoffRead; let reads = 0;
  w.self.handoffRead = async (id) => { reads++; const r = await orig.call(w.self, id); return { ...r, exists: false, size: 0, ms: 0 }; }; // the note never shows
  w.click();
  while (reads < 2) await tick();
  const c = strictCx(w.log); w.self.restartClose("r", c); c.valid = false;
  const at = reads;
  for (let i = 0; i < 30; i++) await tick();
  assert.ok(reads <= at + 1, "stopped after the close: " + (reads - at));
  assert.equal(w.log.sends.length, 1, "only the note request went out");
  assert.deepEqual(w.log.stale, []);
});
test("새로 시작: 재시작 길(sendLine·restartFlow)은 화면 읽기·클립보드·붙여넣기·포커스·hc keys를 쓰지 않고, 화면 모양을 보는 도우미도 없다", () => {
  const src = mainSrc();
  const flow = src.slice(src.indexOf("  async poTerm("), src.indexOf("  // The strip above the chat box"));
  assert.ok(flow.includes("async sendLine(") && flow.includes("async restartFlow("));
  for (const bad of ["readScreen", "terminal.paste", "write_to_clipboard", "pane.focus", "typeLine", '"keys"', '"read"', "hc keys", "focused(", "panes("]) assert.ok(!flow.includes(bad), `restart path uses ${bad}`);
  for (const gone of ["restartInputText", "restartInputEmpty", "restartInputOnly", "restartShot", "RESTART_RULE", "squeezeRow", "RESTART_READ_LINES", "restartHasMark", "restartCleared", "diagShot", "readScreen"]) {
    assert.ok(!src.includes(gone), `${gone} is deleted from main.js`);
    assert.ok(!(gone in I), `${gone} is not exported`);
  }
  assert.match(flow, /hc\(\["send", "--json", "--", po, text\]\)/);
  assert.ok(!/"--if"/.test(flow), "no --if: it refuses a PO that is 'done'");
  assert.ok(flow.indexOf("restartClearState(clr.turn") < flow.indexOf('sendLine(po, "/PO"'), "/PO only after the clear signal");
});

test("restartDraft: 이 방에 데스크가 붙여 넣기만 한 글(held/noenter)이 10분 안에 있으면 새로 시작을 막는다(hc send는 입력칸을 비우지 않는다)", () => {
  const now = 10_000_000;
  const m = (o) => ({ po: "r", status: "held", at: now - 1000, ...o });
  assert.match(I.restartDraft([m()], "r", now), /입력칸에 남은 글/);
  assert.match(I.restartDraft([m({ status: "noenter" })], "r", now), /입력칸에 남은 글/);
  assert.equal(I.restartDraft([m({ status: "sent" })], "r", now), "");
  assert.equal(I.restartDraft([m({ po: "x" })], "r", now), "");
  assert.equal(I.restartDraft([m({ at: now - I.RESTART_DRAFT_MS - 1 })], "r", now), "");
  assert.equal(I.restartDraft(null, "r", now), "");
  assert.match(I.restartConfirm(0, 0), /입력칸은 비어 있어야/);
});

test('UI 모드(#59): inbox mode "main"은 페인처럼 전체 메신저 화면이고, 터미널 모드로 돌아가는 버튼은 <기본>-ui에서만 기본 레이아웃으로 바꾼다', () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8");
  assert.match(src, /this\.mained = mode === "main";/);
  assert.match(src, /this\.paned = mode === "pane" \|\| this\.mained;/);
  assert.match(src, /cur\.endsWith\("-ui"\) \? cur\.slice\(0, -3\)/);
  assert.match(src, /run\("layout\.switch", \{ name: base \}\)/);
  assert.match(src, /"inbox-terminal-mode"/);
  const tabs = fs.readFileSync(path.join(__dirname, "..", "mods", "tabs-mine", "main.js"), "utf8");
  assert.match(tabs, /"mode-switch"/);
  assert.match(tabs, /layout\.switch/);
});

// ---- UI 모드(main): 터미널 칸이 없으므로 PO 터미널 주소로 보낸다 (review-59 R1 P2)
test("main.js: UI 모드(mained)의 deliver는 칸·포커스·클립보드 없이 hc send(터미널 주소)로 보내고, 터미널 모드 경로는 그대로다", () => {
  const src = mainSrc();
  const del = deliverOf(src);
  const by = methodOf(src, "  deliverByAddress(po, text, c, rec, ok, id) {", "  // Gives the keyboard back after a send");
  // deliver: 기록(record) 뒤, 클립보드·panes()·terminal.keep 앞에서 mained면 주소 경로로 간다
  const at = del.search(/this\.mained\) return this\.deliverByAddress\(po, text, c, rec, ok, id\)/);
  assert.ok(at > del.indexOf("this.record(") && at < del.indexOf("write_to_clipboard(text)") && at < del.indexOf("panes()") && at < del.indexOf('"terminal.keep"'));
  assert.equal((del.match(/this\.record\(/g) ?? []).length, 1); // 기록은 여전히 deliver 한 곳
  // 주소 경로: hc send <po> <text> --json 하나로 붙여넣기+Enter, 칸/포커스/클립보드/--force 없음
  assert.match(by, /hc\(\["send", "--json", "--", po, text\]\)/); // "--" ends the options: text starting with "-" / "--" (e.g. "- a", "--force x") is not read as an hc option
  for (const t of ["- a", "--force x", "-", "--"]) { const args = ["send", "--json", "--", "t7", t]; assert.equal(args.indexOf("--", 2), 2); assert.equal(args.slice(3).join("|"), `t7|${t}`); } // the user text always sits after the first "--"
  assert.match(by, /c\.spawn\(async \(cx\) =>/);
  assert.ok(!/panes\(|terminal\.keep|pane\.focus|terminal\.paste|write_to_clipboard|submitPo|--force/.test(by));
  // 막힌 PO는 보내지 않고(failed), 성공하면 sent + ok("sent"), 실패는 failed + 이유, 같은 PO에 한 번에 하나(opening)
  assert.match(by, /if \(this\.isBlocked\(po\)\)[\s\S]*?this\.mark\(id, "failed"\)[\s\S]*?return "failed"/);
  assert.match(by, /this\.opening\.add\(po\)/);
  assert.match(by, /restartSendResult\(r\)/);
  assert.match(by, /this\.mark\(id, "sent"\);[\s\S]*?ok\?\.\("sent"\)/);
  assert.match(by, /this\.opening\.delete\(po\)[\s\S]*?this\.mark\(id, "failed"\)/);
  assert.match(by, /return "opening"/);
});

// ---- #60 step B (part 1): the desk, the writer's reader and the PO hook read the profile (docs/inbox-contract.md §9-§10)
const blockOf = (f, name) => {
  const src = fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
  const a = src.indexOf(`// ${name}:begin`), b = src.indexOf(`// ${name}:end`);
  assert.ok(a >= 0 && b > a, f);
  return src.slice(a, b);
};
const PROFILE = require("../mods/inbox/profile.cjs");
const BOT = { v: 1, agent: { name: "^bot-[a-z0-9]+$", role: "agentx", titlePrefix: "봇 · ", strip: "^bot-" }, hub: { role: "desk", idLabel: "room", id: "^[a-z0-9]{1,12}$", dir: "rooms" }, labels: { role: "kind", wait: "needs", waitLink: "needs-url", session: "title" }, answerLine: "Reply [{kind}] -> {agent}: {text}{ ({link})}" };
const botDir = (profile = BOT) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-bot-"));
  fs.writeFileSync(path.join(dir, "profile.json"), typeof profile === "string" ? profile : JSON.stringify(profile));
  return dir;
};

test("names 블록: inbox.cjs와 main.js가 한 글자도 다르지 않고, 기본값은 기본 프로필과 같다", () => {
  assert.equal(blockOf("../mods/inbox/main.js", "names"), blockOf("../mods/inbox/inbox.cjs", "names"));
  assert.deepEqual({ ...I.DEFAULT_NAMES }, PROFILE.namesOf(PROFILE.loadProfile({ HERDR_INBOX_DIR: path.join(os.tmpdir(), "inbox-no-profile-dir") })));
  assert.deepEqual(I.plainNames(), { ...I.DEFAULT_NAMES }); // nothing loaded: the defaults
});

test("names 블록(main.js 사본)은 그대로 실행되고 inbox.cjs와 같은 답을 한다", () => {
  const B = new Function(`${blockOf("../mods/inbox/main.js", "names")}\nreturn { setNames, isAgentName, labelOf, answerLine, poId, isHubTerm };`)();
  assert.equal(B.isAgentName("lead-x"), true);
  assert.equal(B.answerLine("decision", "lead-a", "A로 가자\n서둘러", "https://x/1"), I.answerLine("decision", "lead-a", "A로 가자\n서둘러", "https://x/1"));
  assert.equal(B.poId({ labels: { role: "po", po: "devnotes" } }), "devnotes");
  const n = PROFILE.namesOf(PROFILE.loadProfile({ HERDR_INBOX_DIR: botDir() }));
  B.setNames(n);
  assert.equal(B.isAgentName("lead-x"), false);
  assert.equal(B.isAgentName("bot-x"), true);
  assert.equal(B.labelOf({ labels: { needs: " decision " } }, "labelWait"), "decision");
  assert.equal(B.poId({ labels: { kind: "desk", room: "team1" } }), "team1");
  assert.equal(B.poId({ labels: { role: "po", po: "devnotes" } }), ""); // the default labels mean nothing now
  assert.equal(B.poId({ labels: { kind: "desk", room: "TOO-LONG-ID-XXXXXXXX" } }), ""); // the profile's id pattern
  assert.equal(B.answerLine("decision", "bot-x", "A", "https://x/1"), "Reply [decision] -> bot-x: A (https://x/1)");
  assert.equal(B.answerLine("decision", "bot-x", "A", ""), "Reply [decision] -> bot-x: A");
  B.setNames({ hubId: "(" }); // an invalid pattern never breaks the desk: back to the defaults
  assert.equal(B.isAgentName("lead-x"), true);
});

test("프로필: 에이전트 이름·대기 라벨·세션 이름·답 줄·멘션이 프로필을 따른다(기본 이름은 더 이상 아니다)", () => {
  const dir = botDir();
  try {
    assert.equal(I.loadNames({ HERDR_INBOX_DIR: dir }), "");
    assert.equal(I.waitingKind({ name: "bot-x", labels: { needs: "decision" } }), "decision");
    assert.equal(I.waitingKind({ name: "lead-x", labels: { wait: "decision" } }), "");
    assert.equal(I.waitingKind({ name: "bot-x", labels: { wait: "decision" } }), ""); // the old label name is not read
    assert.equal(I.leaderName("bot-po-inbox", { name: "bot-po-inbox", address: "t1", title: "봇 · 받은편지함 정리" }, {}), "받은편지함 정리");
    assert.equal(I.leaderName("bot-po-inbox", { name: "bot-po-inbox", address: "t1", labels: { title: "봇 · 라벨 제목" } }, {}), "라벨 제목");
    assert.equal(I.leaderName("bot-po-inbox", { name: "bot-po-inbox", address: "t1", title: "bot-po-inbox" }, {}), "po inbox");
    assert.equal(I.answerLine("verify", "bot-x", "확인 완료", ""), "Reply [verify] -> bot-x: 확인 완료");
    assert.equal(I.isAgentTerm({ labels: { kind: "agentx" } }), true);
    assert.equal(I.isHubTerm({ labels: { kind: "desk" } }), true);
    assert.equal(I.isHubTerm({ labels: { role: "po" } }), false);
    assert.equal(I.poId({ labels: { kind: "desk", room: "team1" } }), "team1");
    assert.ok(I.mentionRe().test("@bot-x 해줘"));
    assert.ok(!I.mentionRe().test("@lead-x 해줘"));
    const dirs = path.join(dir, "rooms"); // the hub folder is the profile's
    fs.mkdirSync(dirs);
    assert.equal(I.poFile(dir, "team1"), path.join(dir, "rooms", "team1.jsonl"));
    assert.equal(I.handoffFile(dir, "team1"), path.join(dir, "rooms", "team1.handoff.md"));
  } finally { I.setNames(null); }
  assert.equal(I.poFile(dir, "team1"), path.join(dir, "po", "team1.jsonl")); // back to the defaults
});

test("프로필 끝까지: 쓰기 도구 → collect CLI → PO 훅이 lead-/role=po가 아닌 이름으로 돈다", () => {
  const { spawnSync } = require("child_process");
  const W = require("../tools/inbox-write.cjs");
  const dir = botDir();
  const env = { HERDR_INBOX_DIR: dir };
  // 1) the writer: a report from bot-x to hub team1, and the hub's own line
  assert.equal(W.run(["report", "--kind", "decision", "--agent", "bot-x", "--hub", "team1", "--body", "1안: a\n2안: b", "--no-label"], env, () => null).code, 0);
  assert.equal(W.run(["say", "--hub", "team1", "--text", "안녕하세요"], env, () => null).code, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["bot-x.jsonl", "profile.json", "rooms"]);
  // 2) the desk's data: the same CLI the mod runs
  const cli = path.join(__dirname, "..", "mods", "inbox", "inbox.cjs");
  const out = spawnSync(process.execPath, [cli], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(out.status, 0, out.stderr);
  const d = JSON.parse(out.stdout);
  assert.equal(d.profileError, "");
  assert.equal(d.names.hubDir, "rooms");
  assert.equal(d.names.agentName, "^bot-[a-z0-9]+$");
  assert.deepEqual(d.leaders.map((x) => [x.leader, x.po, x.open?.kind]), [["bot-x", "team1", "decision"]]);
  assert.deepEqual(Object.keys(d.po), ["team1"]);
  assert.equal(d.po.team1[0].text, "안녕하세요");
  // 3) the PO hook: a hub terminal with the profile's labels writes into the profile's folder; the default labels write nothing
  const hub = { id: "t5", labels: { kind: "desk", room: "team1" } };
  const run = (term, payload = STOP) => {
    const prev = process.env.HERDR_INBOX_DIR;
    process.env.HERDR_INBOX_DIR = dir;
    try { return HOOK.run({ HC_TERMINAL_ID: "t5", HERDR_INBOX_DIR: dir }, payload, I, () => term, Date.now() + 60000); } finally { I.setNames(null); if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; }
  };
  assert.equal(run({ id: "t5", labels: { role: "po", po: "team1" } }), null);
  assert.equal(run({ id: "t6", name: "bot-y", labels: { kind: "desk", room: "team1" } }), null); // an agent is never a hub
  assert.equal(run({ ...hub, labels: { kind: "desk", room: "TOO-LONG-ID-XXXXXXXX" } }), null);
  assert.equal(fs.existsSync(path.join(dir, "po")), false);
  assert.equal(run(hub).file, path.join(dir, "rooms", "team1.jsonl"));
  assert.deepEqual(I.parsePoLines(fs.readFileSync(path.join(dir, "rooms", "team1.jsonl"), "utf8")).map((x) => x.text), ["안녕하세요", "다 했습니다"]);
});

test("프로필이 깨졌으면 데스크 데이터가 이유를 알리고 기본 이름으로 보이며, 훅은 아무것도 쓰지 않는다", () => {
  const { spawnSync } = require("child_process");
  for (const bad of ["{ nope", JSON.stringify({ hub: { dir: "../x" } }), JSON.stringify({ agent: { name: "(" } })]) {
    const dir = botDir(bad);
    const out = spawnSync(process.execPath, [path.join(__dirname, "..", "mods", "inbox", "inbox.cjs")], { encoding: "utf8", env: { ...process.env, HERDR_INBOX_DIR: dir } });
    assert.equal(out.status, 0, out.stderr);
    const d = JSON.parse(out.stdout);
    assert.match(d.profileError, /profile/, bad);
    assert.deepEqual(d.names, { ...I.DEFAULT_NAMES }, bad);
    const prev = process.env.HERDR_INBOX_DIR;
    process.env.HERDR_INBOX_DIR = dir;
    try { assert.equal(HOOK.run({ HC_TERMINAL_ID: "t5", HERDR_INBOX_DIR: dir }, STOP, I, () => PO_TERM, Date.UTC(2026, 0, 1)), null, bad); } finally { I.setNames(null); if (prev === undefined) delete process.env.HERDR_INBOX_DIR; else process.env.HERDR_INBOX_DIR = prev; }
    assert.equal(fs.existsSync(path.join(dir, "po")), false, bad);
  }
});

test("main.js: 프로필을 읽어 온 names를 쓰고, 읽지 못한 이유를 보인다", () => {
  const src = mainSrc();
  assert.match(src, /adoptNames\(d\?\.names\)/);
  assert.match(src, /d\?\.profileError/);
  assert.match(src, /const NO_PO = \(\) =>/);
  assert.ok(!/\bPO_DIR\b|\bisPoTerm\b|\/\^lead-\/\.test/.test(src)); // no hard-coded default name left in the desk
  const cjs = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8");
  assert.ok(!/\bPO_DIR\b|\bisPoTerm\b|\/\^lead-\/\.test/.test(cjs));
  assert.ok(!/\/\^lead-\/\.test/.test(fs.readFileSync(path.join(__dirname, "../mods/inbox/po-hook.cjs"), "utf8")));
});
