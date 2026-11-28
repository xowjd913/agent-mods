// #152: "결정 필요" 말풍선은 질문 · 선택지 카드 · 추천을 나눠 그린다. 실제 모습은 설치한 앱에서만 보이므로 여기서는 글 규칙과 코드 모양만 시험한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I = require("../mods/inbox/inbox.cjs");

const MAIN = fs.readFileSync(path.join(__dirname, "../mods/inbox/main.js"), "utf8").replace(/\r\n/g, "\n");
const CJS = fs.readFileSync(path.join(__dirname, "../mods/inbox/inbox.cjs"), "utf8").replace(/\r\n/g, "\n");
const cut = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf("\n}\n", i)); };
const line = (src, head) => { const i = src.indexOf(head); return src.slice(i, src.indexOf("\n", i)); };

const ONE = "어느 쪽으로 갈까요?\n1안(추천): 지금 병합\n  - 빠름\n2안: 리뷰 후 병합\n추천: 1안 (이유가 있다)";
const TWO = "결정이 필요합니다.\n① 병합 시점\n1안: 지금\n2안(추천): 다음 주\n② 순서\n1안: A 먼저\n2안: B 먼저\n3안: 동시에\n추천: 3안 — 낫다";

test("decisionLayout: 질문 · 선택지(세부 줄 포함) · 추천 · 이유를 나눈다", () => {
  const l = I.decisionLayout(ONE);
  assert.equal(l.question, "어느 쪽으로 갈까요?");
  assert.deepEqual(l.options, [
    { n: 1, text: "지금 병합", detail: "- 빠름", recommended: true },
    { n: 2, text: "리뷰 후 병합", detail: "", recommended: false },
  ]);
  assert.equal(l.recommended, 1);
  assert.equal(l.reason, "이유가 있다");
  assert.equal(l.rest, ""); // "추천: N안" 줄은 따로 되풀이하지 않는다
});

test("decisionLayout: 선택지 번호와 추천은 decisionOptions와 같다", () => {
  for (const b of [ONE, "1안: 가\n2안: 나", "- **1안**: 가\n- **2안(추천)**: 나", "1안: 가 ★\n2안: 나\n\n마무리\n추천: 2안", "추천: 2안\n1안: 가\n2안: 나\n3안: 다"]) {
    const l = I.decisionLayout(b), o = I.decisionOptions(b);
    assert.deepEqual(l.options.map((x) => x.n), o.options, b);
    assert.equal(l.recommended, o.recommended, b);
  }
});

test("decisionLayout: 마지막 선택지 뒤의 글은 rest, 선택지 사이에 낀 글이나 같은 번호 두 번은 읽지 않는다(null)", () => {
  assert.equal(I.decisionLayout("1안: 가\n2안: 나\n\n마무리 문장\n추천: 2안").rest, "마무리 문장");
  assert.equal(I.decisionLayout("1안: 가\n끼어든 줄\n2안: 나"), null);
  assert.equal(I.decisionLayout("1안: 가\n1안: 또\n2안: 나"), null);
  assert.equal(I.decisionLayout("그냥 보고입니다"), null);
  assert.equal(I.decisionLayout(""), null);
  assert.equal(I.decisionLayout(undefined), null);
});

test("decisionLayout: 선택지 줄의 추천 표시( (추천) · ★ )는 글에서 벗겨 태그로만 보인다", () => {
  const l = I.decisionLayout("1안: 가\n2안(추천): 나 ★");
  assert.deepEqual(l.options.map((o) => o.text), ["가", "나"]);
  assert.equal(l.options[1].recommended, true);
  assert.equal(I.decisionLayout("1안: 가 ★\n2안: 나").options[0].recommended, true);
});

test("decisionView: 질문 하나는 label 빈 묶음 하나", () => {
  const v = I.decisionView(ONE);
  assert.equal(v.intro, "");
  assert.equal(v.groups.length, 1);
  assert.equal(v.groups[0].label, "");
  assert.deepEqual(v.groups[0].options.map((o) => o.n), [1, 2]);
});

test("decisionView: ①·② 질문은 묶음마다 제목 · 선택지 · 추천을 가지고 머리 위 글은 intro", () => {
  const v = I.decisionView(TWO);
  assert.equal(v.intro, "결정이 필요합니다.");
  assert.deepEqual(v.groups.map((g) => [g.label, g.title, g.recommended]), [["①", "병합 시점", 2], ["②", "순서", 3]]);
  assert.deepEqual(v.groups[1].options.map((o) => o.text), ["A 먼저", "B 먼저", "동시에"]);
  assert.equal(v.groups[1].reason, "낫다");
  // 묶음 번호는 버튼 길과 같은 decisionGroups가 정한다
  assert.deepEqual(I.decisionGroups(TWO).map((g) => g.label), v.groups.map((g) => g.label));
});

test("decisionView: 알아볼 수 없는 모양이나 일반 보고는 null이라 지금처럼 그려진다", () => {
  assert.equal(I.decisionView("그냥 보고입니다.\n끝."), null);
  assert.equal(I.decisionView("1안: 가\n끼어든 줄\n2안: 나"), null);
  assert.equal(I.decisionView(""), null);
  assert.equal(I.decisionView("① 가\n1안: x\n2안: y\n② 나\n끼어든 말\n1안: x\n끼어든 줄\n2안: y"), null);
});

test("mdPlain: 굵게 · 코드 · 링크 표시를 벗긴다", () => {
  assert.equal(I.mdPlain("**굵게** `코드` [링크](https://x.y/z) __밑줄__"), "굵게 코드 링크 밑줄");
  assert.equal(I.mdPlain(undefined), "");
  assert.equal(I.mdPlain("평범한 글"), "평범한 글");
});

test("main.js와 inbox.cjs의 새 글 규칙은 한 글자도 다르지 않다", () => {
  for (const n of ["decisionOptions", "decisionLayout", "decisionView", "decisionGroups"]) assert.equal(cut(MAIN, n), cut(CJS, n), n);
  for (const h of ["const OPT_LINE =", "const REC_LINE =", "const optText =", "const mdPlain =", "const recReason ="]) assert.equal(line(MAIN, h), line(CJS, h), h);
  assert.ok(line(MAIN, "const OPT_LINE =").length > 20);
});

test("말풍선: 선택지가 읽히는 결정 보고만 구조로 그리고 접지 않으며, 읽히지 않으면 지금 그림 그대로", () => {
  const b = MAIN.slice(MAIN.indexOf("  bubble(t, s, it, accent, a, poRec = 0) {"), MAIN.indexOf("  decisionBody("));
  assert.match(b, /const view = it\.kind === "decision" \? decisionView\(it\.body\) : null/);
  assert.match(b, /const open = it\.long && !view && this\.isOpen/);
  assert.match(b, /const toggle = it\.long && !view/);
  assert.match(b, /if \(view\) box\.child\(this\.decisionBody\(t, s, it, view, id, a, poRec\)\);\s*\n\s*else if \(!open\)/);
  assert.match(MAIN, /this\.bubble\(t, e\.s, wait, e\.waiting \? t\.blocked : null, a, poRec\)/);
});

test("선택지 카드: 열린 질문에서만 눌리고, 한 질문은 '선택' 한 길로, 여러 질문은 pickGroup으로 보내며 PO가 없으면 막는다", () => {
  const d = MAIN.slice(MAIN.indexOf("  decisionBody("), MAIN.indexOf("  // A message header"));
  assert.match(d, /this\.send\(a, `\$\{o\.n\}안 선택`, c, "choice"\)/);
  assert.match(d, /this\.pickGroup\(a, groups, g\.label, o\.n, c\)/);
  assert.match(d, /if \(!a\.po\) return el\.opacity\(0\.5\)\.tooltip\(NO_PO\(\)\)/);
  assert.match(d, /const live = Boolean\(a\) && done === ""/);
  assert.match(d, /this\.tag\(t, "추천", "working"\)/);
  assert.match(d, /추천 이유/);
  assert.equal((d.match(/this\.send\(/g) ?? []).length, 1); // 보내는 길은 하나
});

test("askActions: 카드가 선택지를 그릴 때는 같은 선택지 버튼을 되풀이하지 않고 나머지 버튼은 그대로 둔다", () => {
  const a = MAIN.indexOf("  askActions(t, a, cx) {");
  const body = MAIN.slice(a, MAIN.indexOf("    if (!a.po) box.child", a));
  assert.match(body, /const view = kind === "decision" \? decisionView\(item\?\.body\) : null/);
  assert.match(body, /\(view \? \[\] : groups\)\.map/);
  assert.match(body, /kind === "decision" && !view \? opts\.options\.map/);
  for (const s of ["링크 열기", "답 쓰기", "확인 완료", "hint.answers.map"]) assert.ok(body.includes(s), s);
});

test("decisionLayout: 추천과 같은 번호의 추천 줄이 여러 번 와도 이유가 사라지지 않는다", () => {
  const v = I.decisionLayout("질문?\n1안: A\n2안: B\n추천: 2안 — 이유1\n추천: 2안 — 이유2");
  assert.ok(v);
  assert.ok(v.reason.includes("이유1") && v.reason.includes("이유2"), v.reason);
});

// #157: PO 추천 배지 — PO 채팅 글에서 추천한 안을 읽는다(없으면 0, 추측하지 않는다).
const po = (ms, text, extra = {}) => ({ who: "po", ms, text, ...extra });
test("poRecommend: 보고 뒤 PO 글에서 한 안만 말한 추천 문장을 읽는다", () => {
  const L = "l1";
  assert.equal(I.poRecommend([po(20, "저는 2안을 추천합니다.")], L, 10, [1, 2]), 2);
  assert.equal(I.poRecommend([po(20, "추천: 1안 — 빠릅니다")], L, 10, [1, 2]), 1);
  assert.equal(I.poRecommend([po(20, "1안 추천\n그래도 2안도 괜찮습니다")], L, 10, [1, 2]), 1);
});
test("poRecommend: 부정·여러 안이 섞인 문장·없는 안·보고 이전 글은 0", () => {
  const L = "l1";
  assert.equal(I.poRecommend([po(20, "2안은 비추천입니다")], L, 10, [1, 2]), 0);
  assert.equal(I.poRecommend([po(20, "1안보다 2안을 추천합니다")], L, 10, [1, 2]), 0);
  assert.equal(I.poRecommend([po(20, "3안을 추천합니다")], L, 10, [1, 2]), 0);
  assert.equal(I.poRecommend([po(5, "2안을 추천합니다")], L, 10, [1, 2]), 0);
  assert.equal(I.poRecommend([{ who: "me", ms: 20, text: "2안 추천" }], L, 10, [1, 2]), 0);
  assert.equal(I.poRecommend([], L, 10, [1, 2]), 0);
});
test("poRecommend: 다른 리더에게 간 글은 제외하고, 가장 최근 글을 쓴다", () => {
  assert.equal(I.poRecommend([po(20, "2안 추천", { to: "l2" })], "l1", 10, [1, 2]), 0);
  assert.equal(I.poRecommend([po(20, "2안 추천", { about: "l1" })], "l1", 10, [1, 2]), 2);
  assert.equal(I.poRecommend([po(20, "1안 추천"), po(30, "생각해 보니 2안을 추천합니다")], "l1", 10, [1, 2]), 1 + 1);
});
test("poRecommend: main.js의 사본이 inbox.cjs와 같고, 카드가 배지를 그린다", () => {
  assert.equal(cut(MAIN, "poRecommend"), cut(CJS, "poRecommend"));
  assert.match(MAIN, /"PO 추천"/);
  assert.match(MAIN, /poRec === o\.n/);
});
