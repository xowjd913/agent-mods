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

// 패널이 PO 터미널에 넣는 길은 하나(deliver): 클립보드 → PO 칸 포커스 → 붙여넣기 → Enter(hc keys). hc send는 쓰지 않는다.
const mainSrc = () => fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
const methodOf = (src, head, next) => { const a = src.indexOf(head), b = src.indexOf(next, a + 1); assert.ok(a > 0 && b > a, head); return src.slice(a, b); };
const deliverOf = (src) => methodOf(src, '  deliver(po, text, c, rec = null, ok = null, id = "", opened = false) {', "  // A send to a PO with no pane");

test("main.js: 답 버튼·답 상자·N안 칩·채팅은 모두 deliver() 한 길로 붙여넣고 Enter까지 보낸다", () => {
  const src = mainSrc();
  assert.ok(!/hc\(\["send"/.test(src) && !/terminal\.send|send_key/i.test(src)); // hc send는 <hc from=...> 꼬리표가 붙어 쓰지 않는다
  const send = methodOf(src, "  send(a, text, cx, kind = \"answer\") {", "  clearBox(a");
  const chat = methodOf(src, "  sendChat(c) {", "  // The chat footer");
  const del = deliverOf(src);
  assert.match(send, /this\.deliver\(po, answerLine\(/);
  assert.match(chat, /this\.deliver\(po, p\.text, c, \{/);
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
  assert.match(send, /this\.clearBox\(a, r\)/);
  assert.match(send, /\(r2\) => \{ this\.clearBox\(a, r2\); \}/);
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
  assert.equal((sub.match(/this\.restore\(/g) ?? []).length, 2);
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
  assert.match(src, /PO에 보냄 — 리더가 받으면 사라집니다/); // 보낸 표시(Enter까지 누른 경우)
  assert.match(src, /PO에 넣음 — PO가 질문 중이라 PO에서 Enter로 보내세요/); // 막힌 PO에는 붙여넣기만
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
  const copy = src.slice(src.indexOf("  copy(key, text, cx)"), src.indexOf("  // \"옆에 열기\":"));
  assert.match(copy, /cx\.write_to_clipboard\(String\(text\)\)/);
  assert.ok(!/terminal\.paste|pane\.focus|hc send|exec\(/.test(copy));
  // 링크: 앱의 open_url 먼저, http(s)만
  assert.match(src, /cx\.open_url\(url\)/);
  assert.match(src, /if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\) return;/);
  assert.ok(!/hc send|hc\(\["send"/.test(src)); // hc send 없이 클립보드로만(채팅의 Enter는 hc keys)
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

test("main.js: 오른쪽 칸(Dock)도 창과 같은 메신저 화면이다: 좁은 방 칸 + 타임라인 + 채팅 상자, 창 열기 버튼", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
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
  assert.match(src, /\.when\(!this\.windowed, \(el\) => el\.child\(this\.button\(t, "inbox-open"/);
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
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
  assert.match(src, /\.when\(!this\.paned, \(el\) => el\.child\(div\(\)\.text_size\(15\)[^\n]*PO 데스크/);
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /h_flex\(\)\.flex_1\(\)\.min_h\(0\)\.items_stretch\(\)/);
  assert.match(src, /const room = v_flex\(\)\.flex_1\(\)\.min_w\(0\)\.min_h\(0\)\.when\(!strip, \(el\) => el\.h_full\(\)\)/);
  assert.match(src, /id\("po-rooms"\)\.flex_none\(\)\.w\(ROOM_W\)\.h_full\(\)/);
  assert.match(src, /id\("po-rooms"\)\.flex_none\(\)\.w\(SLIM_W\)\.h_full\(\)/);
  // the timeline itself keeps taking the rest of the column above the pinned chat box
  assert.match(src, /id\("inbox-list"\)[^\n]*\.flex_1\(\)\.min_h\(0\)/);
  assert.match(src, /\.child\(lines\)\s*\n\s*\.when\(Boolean\(panel\), \(el\) => el\.child\(panel\)\)\s*\n\s*\.child\(this\.chatBox\(t, v\)\)/);
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
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
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    const a = src.indexOf("// leaderName:begin"), b = src.indexOf("// leaderName:end");
    assert.ok(a >= 0 && b > a, f);
    return src.slice(a, b);
  };
  const ref = block("../mods/inbox/inbox.cjs");
  assert.equal(block("../mods/inbox/main.js"), ref);
  assert.equal(block("../mods/agent-groups/main.js"), ref);
  assert.equal(block("../mods/leader-tabs/main.js"), ref);
  assert.equal(block("../mods/work/main.js"), ref);
});

test("leader-tabs·work: 리더 이름을 hc 이름(lead-x) 그대로 그리지 않는다", () => {
  const tabs = fs.readFileSync(path.join(__dirname, "../mods/leader-tabs/main.js"), "utf8");
  assert.match(tabs, /return leaderName\(term\.name, term, namesMemo\(\)\)/);
  assert.doesNotMatch(tabs, /term\.name \|\| term\.address/);
  const work = fs.readFileSync(path.join(__dirname, "../mods/work/main.js"), "utf8");
  assert.match(work, /const label = sessionLabel\(s\)/);
  // The rule itself: a closed or untitled leader reads as its task, a titled one as its title.
  assert.equal(NAMES.leaderName("lead-po-inbox", { name: "lead-po-inbox", address: "t1", title: "리더 · 받은편지함 정리" }, {}), "받은편지함 정리");
  assert.equal(NAMES.leaderName("lead-po-inbox", { name: "lead-po-inbox", address: "t1", title: "lead-po-inbox" }, {}), "po inbox");
});

// The scroll lists keep their place across presses: handles the view owns, tracked on both lists, and an anchor after every press that
// changes a card's or a section's height. (The kit gives no way to read a pixel offset, so this checks the wiring, not the pixels.)
test("받은편지함: 타임라인은 새 글을 따라 맨 아래로 가고, 올려 읽는 중이면 붙든다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
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
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8");
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
  assert.deepEqual(I.collect(path.join(dir, "none")), { at: I.collect(path.join(dir, "none")).at, leaders: [], po: {} });
});

test("chat 블록: main.js가 inbox.cjs와 한 글자도 다르지 않은 같은 블록을 쓴다", () => {
  const block = (f) => {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
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
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
  assert.match(src, /TextareaState\.new\(/);
  assert.match(src, /Textarea\.new\(this\.chat\)/);
  assert.match(src, /hc\(\["keys", po, "enter"\]\)/);
  assert.ok(!/hc\(\["send"/.test(src));
  assert.match(src, /=== "blocked"/);
  assert.match(src, /enterIntent\(e\?\.key, Boolean\(e\?\.modifiers\?\.shift\)\)/);
  assert.match(src, /PO에 보내기/);
  const body = deliverOf(src);
  assert.ok(body.indexOf('run("terminal.paste"') > 0 && body.indexOf("this.submitPo(") > body.indexOf('run("terminal.paste"')); // 붙여넣은 뒤에 Enter
  assert.match(src, /import \{[^}]*\bhc\b[^}]*\} from "herdr"/);
});

test("main.js: 창은 고른 PO 하나만 보이고(카드·보고·@ 목록·채팅 대상·PO 답글), 이름은 'PO 데스크'다", () => {
  const src = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8");
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
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8");
  assert.match(src, /imeHold\(value, this\.changedAt, this\.heldAt, now\)/);
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
  const src = fs.readFileSync(path.join(__dirname, "..", "mods", "inbox", "main.js"), "utf8");
  assert.match(src, /한 번 더 Enter로 보냅니다/);
  assert.match(src, /pickPo\(id, c\) \{\n\s+this\.heldAt = 0;/);
  assert.match(src, /sendChat\(c\) \{\n\s+this\.sentAt = Date\.now\(\);\n\s+this\.heldAt = 0;/);
  assert.match(src, /this\.heldAt = now; c\.notify\(\)/);
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
  assert.match(body, /disabled: a\.po \? "" : NO_PO, tip: CLIP/);
  assert.ok(body.indexOf("opt-") < body.indexOf("`ok-${s.leader}`") && body.indexOf("`ok-${s.leader}`") < body.indexOf("`write-${s.leader}`")); // 칩 → 확인 완료 → 답 쓰기
  // verify에는 칩이 없다(확인 완료만): 칩은 kind === "decision" 안에서만 만든다
  assert.equal((body.match(/decisionOptions\(/g) ?? []).length, 1);
  assert.match(body, /kind === "verify", \(el\)/);
});

test("decisionOptions: inbox.cjs와 main.js의 chat 블록이 같다", () => {
  const cut = (f) => { const s = fs.readFileSync(path.join(__dirname, f), "utf8"); const a = s.indexOf("function decisionOptions("); return s.slice(a, s.indexOf("\n}\n", a)); };
  assert.equal(cut("../mods/inbox/main.js"), cut("../mods/inbox/inbox.cjs"));
});

// ---- 내가 보낸 모든 글을 오른쪽 말풍선으로 (deliver 한 곳에서 한 번 기록)
test("chatRecord: 사람이 쓴 글만 담고(긴 Panel answer 감싸개 없이), 종류·상태는 정해진 값만", () => {
  const r = I.chatRecord({ text: " 확인 완료 ", to: "lead-a", po: "p1", kind: "verify" }, "held", 1700000000000);
  assert.deepEqual(r, { id: "1700000000000-", at: 1700000000000, ts: new Date(1700000000000).toISOString(), ms: 1700000000000, text: "확인 완료", line: "확인 완료", to: "lead-a", po: "p1", kind: "verify", status: "held" });
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
  assert.match(src, /\{ text: body, to: a\.s\.leader, po: a\.owner, kind \}/); // 버튼·칩·답 상자는 사람이 쓴 글(body)을 기록한다
  assert.match(src, /send\(a, "확인 완료", c, "verify"\)/);
  assert.match(src, /send\(a, `\$\{n\}안 선택`, c, "choice"\)/);
  assert.ok(!/answerLine\([^)]*\)[^;]*kind: "chat"/.test(src));
  // 모양: 내 것은 오른쪽(items_end/justify_end)·강조색 채움, 시간은 말풍선 왼쪽; 남의 것은 말풍선 오른쪽 아래에 시간
  const row = methodOf(src, "  entryRow(t, e, v, cx) {", "  render(cx)");
  assert.match(row, /justify_end\(\)/);
  assert.match(row, /bg\(t\.working \+ "33"\)/);
  assert.match(row, /\.child\(when\(e\.ms\)\)\s*\n\s*\.child\(div\(\)\.max_w\("80%"\)/); // 내 말풍선: 시간이 말풍선 앞(왼쪽)
  assert.match(row, /items_end\(\)\s*\n\s*\.child\(div\(\)\.flex_1\(\)\.min_w\(0\)\.px\(10\)/); // PO: 말풍선 뒤(오른쪽)에 시간
  assert.match(row, /mineNote\(e\.status\)/);
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

test("mineAct: 아무것도 못 간 것은 다시 보내기, Enter만 빠진 것은 Enter 누르기, 질문 중에 붙여 넣은 것은 버튼 없음", () => {
  assert.equal(I.mineAct("nopane"), "resend");
  assert.equal(I.mineAct("failed"), "resend");
  assert.equal(I.mineAct("noenter"), "enter");
  for (const st of ["sent", "sending", "opening", "held"]) assert.equal(I.mineAct(st), "", st); // held의 Enter는 PO의 질문에 답하는 것이라 말풍선에는 두지 않는다
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
  assert.equal(I.badgeTurn({ id: "b", ts: 1000 }, "a", 1000 + 91000), "write"); // 주인이 90초 넘게 갱신하지 않음
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
  assert.match(re, /mineAct\(liveStatus\(r\.status, r\.at \?\? r\.ms, Date\.now\(\)\)\) !== "resend"/);
  assert.match(re, /this\.deliver\(po, r\.line \|\| r\.text, c, r, null, id\)/); // 같은 기록·같은 줄(새 말풍선 없음)
  const en = methodOf(src, "  enterNow(id, c) {", "  // ---- A blocked PO's screen");
  assert.match(en, /if \(this\.isBlocked\(po\)\) \{.*return; \}/); // 질문 중이면 Enter를 누르지 않는다
  assert.ok(en.indexOf("isBlocked") < en.indexOf('hc(["keys", po, "enter"])'));
  assert.match(en, /this\.mark\(id, o && o\.code === 0 \? "sent" : "noenter"\)/);
  const pp = methodOf(src, "  pressPrompt(po, key, c) {", "  promptPanel(t, v, cx) {");
  assert.ok(pp.indexOf("!this.isBlocked(po)") >= 0 && pp.indexOf("!this.isBlocked(po)") < pp.indexOf('hc(["keys", po, key])')); // 질문이 사라졌으면 키를 누르지 않는다
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

test("main.js: 말풍선의 다시 보내기/Enter 누르기 버튼은 mineAct로만 정하고, 막힌 PO가 질문 중일 때 질문 패널이 채팅 상자 위에 붙는다", () => {
  const src = mainSrc();
  const row = methodOf(src, "  entryRow(t, e, v, cx) {", "  render(cx)");
  assert.match(row, /mineAct\(e\.status\)/);
  assert.match(row, /this\.resend\(e\.id, c\)/);
  assert.match(row, /this\.enterNow\(e\.id, c\)/);
  assert.match(row, /다시 보내기/);
  assert.match(row, /Enter 누르기/);
});
