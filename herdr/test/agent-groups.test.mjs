// node --test herdr/test/agent-groups.test.mjs
// main.js는 Herdr 전용 모듈을 불러오므로, 같은 이름의 빈 모듈로 바꿔서 taskPlan만 시험한다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const stub = "export const View = class {}; export const div = () => ({}); export const svg = div; export const image = div; export const h_flex = div; export const v_flex = div;" +
  "export const agents = () => []; export const terminals = () => []; export const panes = () => []; export const focused = () => null; export const spaces = () => [];" +
  "export const run = () => {}; export const theme = () => ({}); export const shared = () => null; export const setShared = () => {}; export const setAgentOrder = () => {};" +
  "export const openOverlay = () => {}; export const closeOverlay = () => {}; export const props = () => ({}); export const window = () => ({}); export const layout = () => ({});";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { taskPlan, paneless } = await import("../mods/agent-groups/main.js");

const term = (address, name, parent, labels = {}) => ({ address, name, parent, state: "live", labels });
const agent = (address, seq, tab, tab_name) => ({ address, seq, space: "s1", space_name: "repo", tab, tab_name, pane: address });

// 이슈 번호(28)와 PR 번호(29)가 달라도 부모 사슬로 묶인다. 리더 패널은 PO 탭의 다른 서브 탭에 있다.
const all = [
  term("t28", "po", null, { role: "po" }),
  term("t137", "lead-po-inbox", "t28", { role: "leader" }),
  term("t14d", "dev-25-inbox", "t137"),
  term("t14p", "review-25-inbox", "t137"),
  term("t14r", "lead-sched-acct", "t28"),
  term("t14t", "dev-28-gh-account", "t14r"),
  term("t14w", "review-29-gh-account", "t14r"),
];
const list = [
  agent("t28", 0, "tab-po", "PO · repo"),
  agent("t137", 1, "tab-po", "PO · repo"),
  agent("t14r", 2, "tab-po", "PO · repo"),
  // 리뷰를 먼저 넣어도 개발이 앞에 온다.
  agent("t14w", 5, null, "리뷰 · #29 계정"),
  agent("t14t", 4, null, "개발 · #28 계정"),
  agent("t14p", 6, null, "리뷰 · #25 받은함"),
  agent("t14d", 3, null, "개발 · #25 받은함"),
];

test("taskPlan: 리더마다 섹션 하나, 팀원은 부모 사슬의 리더 아래 개발·리뷰 순", () => {
  const [sp] = taskPlan(list, all);
  assert.equal(sp.poTiers.length, 1);
  const secs = sp.poTiers[0].sections;
  assert.deepEqual(secs.map((s) => s.leader.address), ["t137", "t14r"]);
  assert.deepEqual(secs[0].members.map((a) => a.address), ["t14d", "t14p"]);
  assert.deepEqual(secs[1].members.map((a) => a.address), ["t14t", "t14w"]);
  assert.equal(sp.loose.length, 0);
  assert.equal(sp.sections.length, 0);
  assert.deepEqual(sp.order.map((a) => a.address), ["t28", "t137", "t14d", "t14p", "t14r", "t14t", "t14w"]);
});

test("taskPlan: 머리줄 제목은 숫자만이거나 PO 탭과 같은 탭 이름 대신 hc 이름에서 만든다", () => {
  const [sp] = taskPlan(list, all);
  assert.deepEqual(sp.poTiers[0].sections.map((s) => s.title), ["po inbox", "sched acct"]);
});

test("taskPlan: 부모를 알 수 없는 팀원만 이슈 번호 묶음으로 남고, 팀원이 없는 리더도 섹션이 있다", () => {
  const more = [...all, term("t200", "dev-7-x", null), term("t201", "lead-new", "t28", { role: "leader" })];
  const agents = [...list, agent("t200", 8, null, "개발 · #7 일"), agent("t201", 9, "tab-new", "새 작업")];
  const [sp] = taskPlan(agents, more);
  assert.deepEqual(sp.poTiers[0].sections.map((s) => s.leader.address), ["t137", "t14r", "t201"]);
  assert.equal(sp.poTiers[0].sections[2].title, "새 작업");
  assert.equal(sp.poTiers[0].sections[2].members.length, 0);
  assert.deepEqual(sp.loose.map((g) => g.issue), ["7"]);
});

// 실제 화면 모양: 창이 있는 건 PO와 리더 t137뿐이고, 리더 t14r·t14x와 팀원은 창 없이 떠 있다.
test("paneless + taskPlan: 창 없는 리더도 섹션이 되고 loose·중복 행이 없다", () => {
  const all2 = [
    term("t28", "po", null, { role: "po" }),
    term("t137", "lead-po-inbox", "t28", { role: "leader" }),
    term("t14r", "lead-sched-acct", "t28", { role: "leader", session: "리더 · 예약 계정" }),
    term("t14x", "lead-agent-groups", "t28", { role: "leader" }),
    term("t14d", "dev-25-inbox", "t137"),
    term("t14p", "review-25-inbox", "t137"),
    term("t14t", "dev-28-gh-account", "t14r"),
    term("t14w", "review-29-gh-account", "t14r"),
    term("t14y", "dev-30-agent-groups-tree", "t14x"),
    term("t150", "review-31-agent-groups-tree", "t14x"),
  ];
  const real = [agent("t28", 0, "tab-po", "PO · repo"), agent("t137", 1, "tab-po", "PO · repo")];
  const ghosts = paneless(real, all2, new Map());
  assert.deepEqual(ghosts.map((g) => g.address), ["t14r", "t14x", "t14d", "t14p", "t14t", "t14w", "t14y", "t150"]);
  assert.ok(ghosts.every((g) => g.ghost && g.space === "s1"));
  // 행 제목은 진짜 리더처럼 "리더 · ..." 꼴이다. 머리줄 제목은 그대로다.
  assert.deepEqual(ghosts.slice(0, 2).map((g) => g.title), ["리더 · 예약 계정", "리더 · agent groups"]);
  const [sp] = taskPlan([...real, ...ghosts], all2);
  const secs = sp.poTiers[0].sections;
  assert.deepEqual(secs.map((s) => s.leader.address), ["t137", "t14r", "t14x"]);
  assert.deepEqual(secs.map((s) => s.members.map((a) => a.address)), [["t14d", "t14p"], ["t14t", "t14w"], ["t14y", "t150"]]);
  assert.deepEqual(secs.map((s) => s.title), ["po inbox", "예약 계정", "agent groups"]);
  assert.equal(sp.loose.length, 0);
  assert.equal(sp.others.length, 0);
  assert.equal(new Set(sp.order.map((a) => a.address)).size, sp.order.length);
});

// 리더 머리줄은 리더의 세션 이름(터미널 제목)으로 나온다. 제목이 없으면 기억한 이름, 그것도 없으면 hc 이름.
test("taskPlan: 리더 머리줄은 터미널 제목 → 기억한 이름 → hc 이름 순이다", () => {
  const withTitle = (title) => [
    term("t28", "po", null, { role: "po" }),
    { ...term("t137", "lead-po-inbox", "t28", { role: "leader" }), title },
  ];
  const list = [agent("t28", 1, "tab1", "PO · repo"), agent("t137", 2, "tab1", "PO · repo")];
  const head = (all, memo) => taskPlan(list, all, new Map(), memo)[0].poTiers[0].sections[0].title;
  assert.equal(head(withTitle("리더 · 받은편지함 패널"), {}), "받은편지함 패널");
  assert.equal(head(withTitle(""), { "lead-po-inbox": "기억한 이름" }), "기억한 이름");
  assert.equal(head(withTitle(""), {}), "po inbox");
});

test("paneless: 터미널 제목 없는 리더 행은 기억한 이름으로 '리더 · ' 를 붙여 보인다", () => {
  const all3 = [term("t28", "po", null, { role: "po" }), term("t137", "lead-po-inbox", "t28", { role: "leader" })];
  const real = [agent("t28", 1, "tab1", "PO · repo")];
  assert.equal(paneless(real, all3, new Map(), { "lead-po-inbox": "기억한 이름" })[0].title, "리더 · 기억한 이름");
  assert.equal(paneless(real, all3, new Map(), {})[0].title, "리더 · po inbox");
  assert.equal(paneless(real, [all3[0], { ...all3[1], title: "리더 · 받은편지함 패널" }], new Map(), {})[0].title, "리더 · 받은편지함 패널");
});
