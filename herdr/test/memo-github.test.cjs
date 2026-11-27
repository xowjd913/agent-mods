// memo GitHub 올리기(#144) 단위 테스트: node --test herdr/test/memo-github.test.cjs
// gh는 한 번도 실제로 실행하지 않는다. 모든 gh 호출은 run(args) 모의 함수로 갈음한다(실제 저장소에 올리지 않음).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const G = require("../mods/memo/github.cjs");
const M = require("../mods/memo/memo.cjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "memo-gh-test-"));
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", error: null });
const bad = (status, message, extra = "") => ({ code: 1, stdout: JSON.stringify({ message }), stderr: `gh: ${message} (HTTP ${status})${extra}`, error: null });
const S = { owner: "me", repo: "notes", branch: "", folder: "memos" };

// ---- 설정 문자열 검사
test("parseRepo: owner/이름, URL 붙여넣기, 잘못된 값", () => {
  assert.deepEqual(G.parseRepo("me/notes"), { owner: "me", repo: "notes" });
  assert.deepEqual(G.parseRepo(" https://github.com/me/my.notes.git/ "), { owner: "me", repo: "my.notes" });
  for (const x of ["", "me", "me/", "/notes", "a/b/c", "me/no tes", "-me/notes", "me-/notes", "me/..", "me/{repo}", "me/한글", "me/notes?x=1", "m e/notes", "me/a:b"])
    assert.throws(() => G.parseRepo(x), undefined, x);
});

test("parseBranch: 빈 값은 기본 브랜치, 위험한 이름은 거부", () => {
  assert.equal(G.parseBranch(""), "");
  assert.equal(G.parseBranch("  "), "");
  assert.equal(G.parseBranch("feature/x-1.2"), "feature/x-1.2");
  for (const x of ["-x", "a..b", "a//b", "/a", "a/", "a.lock", "a b", "a~1", "a?b", "a:b", ".hid", "a/.hid", "a\\b", "a;rm"])
    assert.throws(() => G.parseBranch(x), undefined, x);
});

test("parseFolder: 기본값 memos, 한글/중첩 허용, 탈출 경로 거부", () => {
  assert.equal(G.parseFolder(""), "memos");
  assert.equal(G.parseFolder("  /메모/2026/ "), "메모/2026");
  assert.equal(G.parseFolder("a/b"), "a/b");
  for (const x of ["..", "a/../b", "./a", "a/./b", ".git", "a/.github", "a\\b", "C:/x", "a/con", "a/nul.txt", "a /b", "a./b", "a/b?", "a/b*", "a/b\u0000c"])
    assert.throws(() => G.parseFolder(x), undefined, JSON.stringify(x));
  assert.throws(() => G.parseFolder("가".repeat(101)));
});

test("normalizeSettings: 세 값을 한 번에 검사", () => {
  assert.deepEqual(G.normalizeSettings({ repo: "me/notes", branch: "", folder: "" }), { owner: "me", repo: "notes", repoText: "me/notes", branch: "", folder: "memos" });
  assert.throws(() => G.normalizeSettings({ repo: "" }));
  assert.throws(() => G.normalizeSettings({ repo: "me/notes", folder: ".." }));
});

// ---- 경로와 URL
test("remotePath: 폴더/파일, 한글은 NFC, 경로 조각 검사", () => {
  assert.equal(G.remotePath("memos", "2026-11-27 1530 장보기.md"), "memos/2026-11-27 1530 장보기.md");
  const nfd = "각.md".normalize("NFD");
  assert.equal(G.remotePath("memos", nfd), "memos/각.md");
  assert.equal(G.remotePath("memos", nfd).normalize("NFC"), G.remotePath("memos", nfd));
  assert.throws(() => G.remotePath("memos", "../x.md"));
  assert.throws(() => G.remotePath("memos", "a/b.md"));
  assert.throws(() => G.remotePath("memos", ".hidden.md"));
  assert.throws(() => G.remotePath("memos", "a.md ".trim() + "\u0001"));
  assert.throws(() => G.remotePath(["가", "나", "다"].map((c) => c.repeat(100)).join("/"), "x.md"), /너무 깁니다/);
});

test("encodePath: 조각마다 퍼센트 인코딩, 슬래시만 남는다", () => {
  assert.equal(G.encodePath("memos/장보기 #1.md"), "memos/%EC%9E%A5%EB%B3%B4%EA%B8%B0%20%231.md");
  assert.equal(G.encodePath("a/b?c=d&e.md"), "a/b%3Fc%3Dd%26e.md");
  assert.equal(G.encodePath("a/(x)!'*.md"), "a/%28x%29%21%27%2A.md");
  assert.equal(G.encodePath("a/100%.md"), "a/100%25.md");
  // gh는 {owner} 같은 자리표시자를 바꾸므로 중괄호와 콜론도 인코딩돼야 한다
  assert.ok(!/[{}:]/.test(G.encodePath("a/{owner}:repo.md")));
  assert.throws(() => G.encodePath("a/\ud800.md"));
});

test("contentsEndpoint: ref는 있을 때만, 값도 인코딩", () => {
  assert.equal(G.contentsEndpoint("me", "notes", "memos/a b.md", ""), "repos/me/notes/contents/memos/a%20b.md");
  assert.equal(G.contentsEndpoint("me", "notes", "memos/a.md", "feature/x y"), "repos/me/notes/contents/memos/a.md?ref=feature%2Fx%20y");
});

test("commitMessage / buildBody: 본문은 base64, branch·sha는 있을 때만", () => {
  assert.equal(G.commitMessage("장보기", false), "메모 추가: 장보기");
  assert.equal(G.commitMessage("장보기", true), "메모 수정: 장보기");
  assert.equal(G.commitMessage("", false), "메모 추가: 제목 없음");
  assert.ok(Array.from(G.commitMessage("가".repeat(200), false)).length <= 70);
  assert.ok(!G.commitMessage("줄\n바꿈", false).includes("\n"));
  const b = JSON.parse(G.buildBody({ message: "m", content: Buffer.from("안녕\r\n# x\n", "utf8"), branch: "", sha: null }));
  assert.deepEqual(Object.keys(b), ["message", "content"]);
  assert.equal(Buffer.from(b.content, "base64").toString("utf8"), "안녕\r\n# x\n");
  const c = JSON.parse(G.buildBody({ message: "m", content: Buffer.from("x"), branch: "dev", sha: "abc" }));
  assert.equal(c.branch, "dev");
  assert.equal(c.sha, "abc");
});

// ---- gh 실행 환경
test("ghEnv: 기존 PATH 뒤에 gh 설치 폴더만 더하고 토큰은 건드리지 않는다", () => {
  const mac = G.ghEnv({ PATH: "/usr/bin:/bin", GH_TOKEN: "keep-as-is" }, "darwin");
  assert.equal(mac.PATH, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(mac.GH_TOKEN, "keep-as-is"); // 값을 읽거나 바꾸지 않는다: 그대로 지나간다
  assert.equal(G.ghEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }, "darwin").PATH, "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  const win = G.ghEnv({ Path: "C:\\Windows", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32");
  assert.equal(win.Path, "C:\\Windows;C:\\Program Files\\GitHub CLI;C:\\Users\\a\\AppData\\Local\\Programs\\GitHub CLI");
  assert.equal(win.PATH, undefined);
  assert.equal(G.ghEnv({}, "linux").PATH, "/usr/local/bin");
});

// ---- 오류 매핑
test("parseFailure / mapGhError: 404 저장소, 403 권한, 409·422 sha 충돌", () => {
  const f404 = G.parseFailure(bad(404, "Not Found"));
  assert.equal(f404.status, 404);
  assert.equal(f404.message, "Not Found");
  assert.match(G.mapGhError(f404, "repo"), /저장소를 찾지 못했습니다\(404\)/);
  assert.match(G.mapGhError(G.parseFailure(bad(404, "No commit found for the ref nope")), "lookup"), /브랜치/);
  assert.match(G.mapGhError(f404, "put"), /브랜치/);
  assert.match(G.mapGhError(G.parseFailure(bad(403, "Resource not accessible")), "put"), /권한이 없습니다\(403\)/);
  assert.match(G.mapGhError(G.parseFailure(bad(409, "x does not match")), "put"), /409/);
  assert.match(G.mapGhError(G.parseFailure(bad(422, "Invalid request.\n\n\"sha\" wasn't supplied.")), "put"), /422/);
  assert.match(G.mapGhError(G.parseFailure(bad(422, "Something else")), "put"), /올릴 수 없습니다\(422\): Something else/);
  assert.match(G.mapGhError(G.parseFailure(bad(502, "Bad")), "put"), /서버 오류입니다\(502\)/);
  assert.match(G.mapGhError(G.parseFailure(bad(418, "teapot")), "put"), /\(418\): teapot/);
});

test("parseFailure: gh 없음·로그인 필요·네트워크·시간 초과", () => {
  const enoent = G.parseFailure({ code: null, stdout: "", stderr: "", error: Object.assign(new Error("x"), { code: "ENOENT" }) });
  assert.equal(enoent.kind, "nogh");
  assert.match(G.mapGhError(enoent, "repo"), /gh auth login/);
  const login = G.parseFailure({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", error: null });
  assert.equal(login.kind, "login");
  assert.match(G.mapGhError(login, "repo"), /gh auth login/);
  assert.equal(G.parseFailure(bad(401, "Bad credentials")).kind, "login");
  assert.equal(G.parseFailure({ code: 1, stdout: "", stderr: "error connecting to api.github.com", error: null }).kind, "network");
  assert.equal(G.parseFailure({ code: null, stdout: "", stderr: "", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }).kind, "timeout");
});

test("mapGhError: 원문 stderr나 토큰이 메시지에 섞이지 않는다", () => {
  const msg = G.mapGhError(G.parseFailure({ code: 1, stdout: "", stderr: "gh: boom (HTTP 500)\nAuthorization: token ghp_SECRET123", error: null }), "put");
  assert.ok(!msg.includes("ghp_"));
  assert.ok(!msg.includes("Authorization"));
});

// ---- gh 준비 단계
test("checkGh: gh 없음 / 로그인 안 됨이면 안내를 주고 멈춘다", () => {
  const calls = [];
  const none = G.checkGh((a) => { calls.push(a); return { code: null, stdout: "", stderr: "", error: Object.assign(new Error("e"), { code: "ENOENT" }) }; });
  assert.deepEqual(calls[0], ["auth", "status", "--hostname", "github.com"]);
  assert.equal(none.ready, false);
  assert.equal(none.reason, "nogh");
  assert.match(none.message, /gh auth login/);
  const out = G.checkGh(() => ({ code: 1, stdout: "", stderr: "You are not logged in", error: null }));
  assert.equal(out.ready, false);
  assert.equal(out.reason, "login");
  assert.match(out.message, /gh auth login/);
  assert.deepEqual(G.checkGh(() => ok()), { ready: true });
});

test("repoInfo: .private 값으로 공개 여부, 이상한 값은 거부", () => {
  const seen = [];
  assert.deepEqual(G.repoInfo("me", "notes", (a) => { seen.push(a); return ok("false\n"); }), { isPublic: true });
  assert.deepEqual(seen[0], ["api", "repos/me/notes", "--jq", ".private"]);
  assert.deepEqual(G.repoInfo("me", "notes", () => ok("true\n")), { isPublic: false });
  assert.throws(() => G.repoInfo("me", "notes", () => ok("null")), /알 수 없어/);
  assert.throws(() => G.repoInfo("me", "notes", () => bad(404, "Not Found")), /저장소를 찾지 못했습니다\(404\)/);
});

// ---- 올리기
const fileJson = (content, sha = "SHA1") => JSON.stringify({ type: "file", sha, content: Buffer.from(content).toString("base64").replace(/(.{20})/g, "$1\n"), html_url: "https://github.com/me/notes/blob/main/memos/a.md" });

test("upload: 새 파일은 sha 없이 PUT, 본문은 임시 파일로 --input, 끝나면 지운다", () => {
  const root = tmp();
  const calls = [];
  let bodyAtCall = null, bodyPath = null;
  const run = (a) => {
    calls.push(a);
    if (a[1] === "-X") {
      bodyPath = a[a.indexOf("--input") + 1];
      bodyAtCall = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
      return ok(JSON.stringify({ content: { html_url: "https://github.com/me/notes/blob/main/memos/%EA%B0%81.md" } }));
    }
    return bad(404, "Not Found");
  };
  const content = Buffer.from("# 각\n본문\r\n", "utf8");
  const r = G.upload({ ...S, branch: "dev" }, { file: "각.md", title: "각", content }, run, root);
  assert.deepEqual(calls[0], ["api", "repos/me/notes/contents/memos/%EA%B0%81.md?ref=dev"]);
  assert.deepEqual(calls[1].slice(0, 3), ["api", "-X", "PUT"]);
  assert.equal(calls[1][3], "repos/me/notes/contents/memos/%EA%B0%81.md");
  assert.equal(calls[1][4], "--input");
  assert.equal(calls[1].length, 6);
  assert.equal(bodyAtCall.message, "메모 추가: 각");
  assert.equal(bodyAtCall.branch, "dev");
  assert.equal(bodyAtCall.sha, undefined);
  assert.equal(Buffer.from(bodyAtCall.content, "base64").toString("utf8"), "# 각\n본문\r\n");
  assert.deepEqual(r, { url: "https://github.com/me/notes/blob/main/memos/%EA%B0%81.md", created: true, unchanged: false });
  assert.equal(fs.existsSync(bodyPath), false);
  assert.equal(fs.existsSync(path.dirname(bodyPath)), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("upload: 이미 있는 파일은 GET으로 받은 sha를 실어 수정한다 (브랜치 비면 ref·branch 모두 생략)", () => {
  const root = tmp();
  let body = null;
  const calls = [];
  const run = (a) => {
    calls.push(a);
    if (a[1] === "-X") { body = JSON.parse(fs.readFileSync(a[a.indexOf("--input") + 1], "utf8")); return ok(JSON.stringify({ content: { html_url: "https://github.com/me/notes/blob/main/memos/a.md" } })); }
    return ok(fileJson("옛 내용"));
  };
  const r = G.upload(S, { file: "a.md", title: "a", content: Buffer.from("새 내용") }, run, root);
  assert.equal(calls[0][1], "repos/me/notes/contents/memos/a.md");
  assert.equal(body.sha, "SHA1");
  assert.equal("branch" in body, false);
  assert.equal(body.message, "메모 수정: a");
  assert.equal(r.created, false);
  assert.equal(r.unchanged, false);
});

test("upload: 내용이 같으면 PUT 없이 '변경 없음'", () => {
  const calls = [];
  const r = G.upload(S, { file: "a.md", title: "a", content: Buffer.from("같다") }, (a) => { calls.push(a); return ok(fileJson("같다")); }, tmp());
  assert.equal(r.unchanged, true);
  assert.equal(calls.length, 1);
});

test("upload: 같은 이름이 폴더이거나 파일이 아니면 올리지 않는다", () => {
  assert.throws(() => G.upload(S, { file: "a.md", title: "a", content: Buffer.from("x") }, () => ok("[]"), tmp()), /폴더/);
  assert.throws(() => G.upload(S, { file: "a.md", title: "a", content: Buffer.from("x") }, () => ok(JSON.stringify({ type: "symlink", sha: "s" })), tmp()), /일반 파일이 아니라/);
});

test("upload: 조회 403·브랜치 404, 쓰기 409·422는 짧은 한국어 사유로", () => {
  const c = Buffer.from("x");
  const up = (run) => () => G.upload({ ...S, branch: "nope" }, { file: "a.md", title: "a", content: c }, run, tmp());
  assert.throws(up(() => bad(403, "Forbidden")), /권한이 없습니다\(403\)/);
  assert.throws(up(() => bad(404, "No commit found for the ref nope")), /브랜치/);
  const putFail = (st, msg) => (a) => (a[1] === "-X" ? bad(st, msg) : bad(404, "Not Found"));
  assert.throws(up(putFail(409, "memos/a.md does not match abc")), /409/);
  assert.throws(up(putFail(422, "Invalid request. \"sha\" wasn't supplied.")), /422/);
  assert.throws(up(putFail(404, "Not Found")), /404/);
});

test("upload: PUT가 실패해도 임시 파일은 지워진다", () => {
  const root = tmp();
  assert.throws(() => G.upload(S, { file: "a.md", title: "a", content: Buffer.from("x") }, (a) => (a[1] === "-X" ? bad(403, "no") : bad(404, "Not Found")), root));
  assert.deepEqual(fs.readdirSync(root), []);
});

test("upload: 1 MiB 넘는 메모와 잘못된 파일 이름은 gh를 부르기 전에 거부", () => {
  let n = 0;
  const run = () => { n++; return ok(); };
  assert.throws(() => G.upload(S, { file: "a.md", title: "a", content: Buffer.alloc(G.MAX_UPLOAD_BYTES + 1) }, run, tmp()), /1 MiB/);
  assert.throws(() => G.upload(S, { file: "../a.md", title: "a", content: Buffer.from("x") }, run, tmp()));
  assert.equal(n, 0);
});

// ---- memo.cjs 쪽: 설정 저장과 올리기 흐름 (모의 run)
test("gh 설정: 저장·읽기, 다른 설정은 그대로, 빈 저장소는 지움", () => {
  const home = tmp();
  assert.deepEqual(M.ghConfig(home), { repo: "", branch: "", folder: "", defaultFolder: "memos" });
  M.setDir(home, path.join(home, "memos-dir"));
  const saved = M.setGhConfig(home, { repo: "https://github.com/me/notes", branch: " dev ", folder: "" });
  assert.deepEqual(saved, { repo: "me/notes", branch: "dev", folder: "", defaultFolder: "memos" });
  assert.equal(M.configInfo(home).dir, path.join(home, "memos-dir"));
  assert.equal(M.setGhConfig(home, { repo: "me/notes", branch: "", folder: "메모/가" }).folder, "메모/가");
  assert.throws(() => M.setGhConfig(home, { repo: "me/notes", folder: "../x" }));
  assert.equal(M.ghConfig(home).folder, "메모/가"); // 거부된 값은 저장되지 않는다
  assert.equal(M.setGhConfig(home, { repo: "  ", branch: "x", folder: "y" }).repo, "");
  assert.equal(M.configInfo(home).dir, path.join(home, "memos-dir"));
});

test("gh 설정: 토큰 비슷한 키는 저장하지 않는다", () => {
  const home = tmp();
  M.setGhConfig(home, { repo: "me/notes", token: "ghp_x", GH_TOKEN: "y" });
  const raw = fs.readFileSync(path.join(home, "memo", "config.json"), "utf8");
  assert.ok(!/ghp_|token/i.test(raw));
});

function memoFixture(text = "# 제목\n본문\n") {
  const home = tmp();
  const dir = path.join(home, "m");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.md"), text);
  M.setDir(home, dir);
  return { home, dir, file: "a.md", p: path.join(dir, "a.md") };
}

test("ghPrepare: 저장소 미설정이면 안내, gh 로그인 안 되면 ready:false", () => {
  const f = memoFixture();
  assert.throws(() => M.ghPrepare(f.home, f.dir, f.file, f.p, () => ok()), /저장소/);
  M.setGhConfig(f.home, { repo: "me/notes" });
  const r = M.ghPrepare(f.home, f.dir, f.file, f.p, () => ({ code: 1, stdout: "", stderr: "not logged in", error: null }));
  assert.equal(r.ready, false);
  assert.match(r.message, /gh auth login/);
});

test("ghPrepare: 공개 여부와 올라갈 경로를 알려 준다", () => {
  const f = memoFixture();
  M.setGhConfig(f.home, { repo: "me/notes", branch: "dev", folder: "x" });
  const run = (a) => (a[0] === "auth" ? ok() : ok("false"));
  assert.deepEqual(M.ghPrepare(f.home, f.dir, f.file, f.p, run), { ok: true, ready: true, isPublic: true, repo: "me/notes", branch: "dev", remote: "x/a.md" });
  assert.equal(M.ghPrepare(f.home, f.dir, f.file, f.p, (a) => (a[0] === "auth" ? ok() : ok("true"))).isPublic, false);
});

test("ghPrepare/ghUpload: 폴더가 바뀐 경로·잘못된 파일 이름은 거부", () => {
  const f = memoFixture();
  M.setGhConfig(f.home, { repo: "me/notes" });
  assert.throws(() => M.ghPrepare(f.home, f.dir, f.file, path.join(f.home, "other", "a.md"), () => ok()), /폴더가 바뀌었습니다/);
  assert.throws(() => M.ghUpload(f.home, f.dir, "../a.md", f.p, true, () => ok()), /올바르지/);
  assert.throws(() => M.ghUpload(f.home, f.dir, f.file, "", true, () => ok()), /경로가 없습니다/);
});

test("ghUpload: 공개 저장소는 확인 없이는 PUT하지 않는다", () => {
  const f = memoFixture();
  M.setGhConfig(f.home, { repo: "me/notes" });
  const calls = [];
  const run = (a) => { calls.push(a); return a[0] === "auth" ? ok() : a[2] === "repos/me/notes" || a[1] === "repos/me/notes" ? ok("false") : bad(404, "Not Found"); };
  assert.throws(() => M.ghUpload(f.home, f.dir, f.file, f.p, false, run), /공개 저장소/);
  assert.ok(!calls.some((a) => a.includes("PUT")));
});

test("ghUpload: 끝까지 흐르는 경로(비공개) - 파일 바이트가 그대로 올라간다", () => {
  const text = "# 제목\r\n본문 한글\r\n";
  const f = memoFixture(text);
  M.setGhConfig(f.home, { repo: "me/notes", branch: "main", folder: "메모" });
  let body = null, url = null;
  const run = (a) => {
    if (a[0] === "auth") return ok();
    if (a[1] === "repos/me/notes") return ok("true");
    if (a[1] === "-X") { url = a[3]; body = JSON.parse(fs.readFileSync(a[a.indexOf("--input") + 1], "utf8")); return ok(JSON.stringify({ content: { html_url: "https://github.com/me/notes/blob/main/x" } })); }
    return bad(404, "Not Found");
  };
  const r = M.ghUpload(f.home, f.dir, f.file, f.p, false, run);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.isPublic, false);
  assert.equal(r.remote, "메모/a.md");
  assert.equal(url, "repos/me/notes/contents/%EB%A9%94%EB%AA%A8/a.md");
  assert.equal(body.branch, "main");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), text);
  assert.equal(body.message, "메모 추가: 제목");
});

test("ghUpload: 게이트 통과 후에도 gh 오류는 사유 문장으로 던진다", () => {
  const f = memoFixture();
  M.setGhConfig(f.home, { repo: "me/notes" });
  assert.throws(() => M.ghUpload(f.home, f.dir, f.file, f.p, true, (a) => (a[0] === "auth" ? ok() : bad(404, "Not Found"))), /저장소를 찾지 못했습니다\(404\)/);
  assert.throws(() => M.ghUpload(f.home, f.dir, f.file, f.p, true, () => ({ code: 1, stdout: "", stderr: "", error: null })), /gh/);
});
