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
