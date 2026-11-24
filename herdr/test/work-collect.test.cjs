// collect.cjs GitHub 조회 단위 테스트: node --test herdr/test/work-collect.test.cjs
// gh 호출은 가짜 함수로 바꾸고, 캐시는 임시 폴더를 쓴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.HERDR_APP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "work-collect-test-"));
const C = require("../mods/work/collect.cjs");

const repos = [{ slug: "o/r", root: "/x/r", worktrees: [{ path: "/x/r/.wt/7-a", branch: "feature/7-a", main: false, issue: 7, temp: false }] }];
const issues = [{ repo: "o/r", number: 7 }];
const SCOPE_ERROR = { errors: [{ type: "INSUFFICIENT_SCOPES", message: "The 'name' field requires one of the following scopes: ['read:project']" }] };
const issueNode = (withProject) => ({
  number: 7, title: "작업", url: "u", state: "OPEN", closedAt: null, labels: { nodes: [] }, parent: null,
  ...(withProject ? { projectItems: { nodes: [{ fieldValueByName: { name: "In Progress" } }] } } : {}),
});
const reply = (withProject) => ({
  data: { viewer: { login: "me" }, r0: { nameWithOwner: "o/r", i7: issueNode(withProject), open: { nodes: [] }, done: { nodes: [] } } },
});
// read:project 없는 토큰처럼: projectItems가 들어간 조회는 전부 권한 오류.
function fakeGh(hasProjectScope) {
  const calls = [];
  const query = (text) => {
    calls.push(text);
    const asksProject = text.includes("projectItems");
    return asksProject && !hasProjectScope ? SCOPE_ERROR : reply(asksProject);
  };
  return { query, calls };
}
const reset = () => { for (const k of Object.keys(C.cache.entries)) delete C.cache.entries[k]; };

test("read:project 없음: projectItems 없이 다시 조회해 이슈·PR을 보여주고 상태만 비운다", () => {
  reset();
  const gh = fakeGh(false);
  const github = C.fetchGitHub(repos, issues, gh.query);
  assert.deepEqual(github.errors, []);
  assert.equal(github.notes.length, 1);
  assert.match(github.notes[0], /gh auth refresh -s read:project/);
  assert.equal(gh.calls.length, 2);
  assert.ok(gh.calls[0].includes("projectItems") && !gh.calls[1].includes("projectItems"));
  const out = C.compose({ sessions: [], repos }, github);
  assert.equal(out.issues["o/r#7"].title, "작업");
  assert.equal(out.issues["o/r#7"].status, null);
  assert.equal(out.repos[0].worktrees[0].ref.title, "작업");
});

test("read:project 없음을 기억해 다음 조회는 처음부터 projectItems를 빼고 한 번만 묻는다", () => {
  reset();
  C.fetchGitHub(repos, issues, fakeGh(false).query);
  for (const k of Object.keys(C.cache.entries)) if (k !== "gh:no-project") delete C.cache.entries[k];
  const gh = fakeGh(false);
  const github = C.fetchGitHub(repos, issues, gh.query);
  assert.equal(gh.calls.length, 1);
  assert.ok(!gh.calls[0].includes("projectItems"));
  assert.equal(github.notes.length, 1);
});

test("권한이 있으면 그대로 한 번 조회하고 프로젝트 상태를 채운다", () => {
  reset();
  const gh = fakeGh(true);
  const github = C.fetchGitHub(repos, issues, gh.query);
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(github.notes, []);
  assert.equal(C.compose({ sessions: [], repos }, github).issues["o/r#7"].status, "In Progress");
});

test("권한 오류가 아닌 실패는 기억하지 않고 기존 오류 문구를 낸다", () => {
  reset();
  const github = C.fetchGitHub(repos, issues, () => null);
  assert.equal(github.data, null);
  assert.deepEqual(github.errors, ["GitHub query failed (gh auth or network)"]);
  assert.equal(C.cache.entries["gh:no-project"], undefined);
});
