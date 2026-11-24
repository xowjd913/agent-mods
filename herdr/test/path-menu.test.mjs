// node --test herdr/test/path-menu.test.mjs
// link.js·main.js는 Herdr 전용 모듈을 불러오므로, 호출을 기록하는 가짜 모듈로 바꿔 시험한다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const stub = "const h = () => globalThis.__herdr;" +
  "export const View = class {}; export const div = () => ({}); export const v_flex = div; export const h_flex = div;" +
  "export const theme = () => ({}); export const props = () => null; export const closeOverlay = () => null;" +
  "export const window = () => ({ platform: h().platform });" +
  "export const exec = (...a) => { const x = h(); x.calls.push(['exec', ...a]);" +
  "  if (x.fail === 'spawn') return Promise.reject(new Error('not found'));" +
  "  if (x.fail === 'code') return Promise.resolve({ code: 1, stdout: '', stderr: 'boom\\nmore' });" +
  "  const out = typeof x.stdout === 'function' ? x.stdout(...a) : x.stdout;" +
  "  return Promise.resolve(typeof out === 'object' ? out : { code: 0, stdout: out, stderr: '' }); };" +
  "export const hc = (a) => { const x = h(); x.calls.push(['hc', a]); const r = x.hc ? x.hc(a) : { code: 1, stdout: '', stderr: 'no hc' };" +
  "  return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); };" +
  "export const home = () => h().platform === 'windows' ? 'C:\\\\Users\\\\dev' : '/home/dev';" +
  "export const notify = (n) => { h().calls.push(['notify', n]); return 'n1'; };" +
  "export const openOverlay = (o) => { h().calls.push(['overlay', o]); return 'o1'; };";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { handleLink } = await import("../mods/path-menu/link.js");
await import("../mods/path-menu/main.js"); // 화면 모듈도 불러와지는지만 본다.
const { kindOf, kindsOf, openFolder, openFile, copyText, psText } = await import("../mods/path-menu/os.js");
const { cellWidth, joinCandidates, joinedPaths } = await import("../mods/path-menu/wrap.js");

const local = { terminal: "t1", machine: null, cwd: "/work", pane: null, tab: null, space: null };
function fake(platform, stdout = "", fail = null) {
  globalThis.__herdr = { platform, stdout, fail, calls: [] };
  return globalThis.__herdr.calls;
}
const of = (calls, kind) => calls.filter((c) => c[0] === kind).map((c) => c.slice(1));
// psText가 만든 PowerShell 식을 되읽는다: (-join [char[]]@(67,58,...)) -> 문자열
const unps = (script) => String.fromCharCode(...script.match(/\[char\[\]\]@\(([\d,]*)\)/)[1].split(",").map(Number));

test("URL은 넘긴다(pass)", async () => {
  const calls = fake("macos");
  assert.equal(await handleLink({ link: { kind: "url", raw: "https://example.com", url: "https://example.com" }, source: local }), "pass");
  assert.deepEqual(calls, []);
});

test("있는 파일·폴더는 종류에 맞는 팝업을 누른 자리에 연다", async () => {
  for (const [kind, height] of [["file", 128], ["dir", 100]]) {
    const calls = fake("macos", kind + "\n");
    assert.equal(await handleLink({ link: { kind: "file", raw: "src/a.js", path: "/work/src/a.js" }, source: local }), "handled");
    const [[o]] = of(calls, "overlay");
    assert.deepEqual(o, { mod: "path-menu", kind: "popup", at: "pointer", width: 260, height, props: { path: "/work/src/a.js", kind } });
    assert.deepEqual(of(calls, "notify"), []);
  }
});

test("없는 경로는 알림을 띄우고 복사만 남긴다", async () => {
  const calls = fake("macos", "missing\n");
  await handleLink({ link: { kind: "file", raw: "gone.txt:3", path: "/work/gone.txt" }, source: local });
  assert.equal(of(calls, "notify")[0][0].level, "warning");
  assert.equal(of(calls, "overlay")[0][0].props.kind, "missing");
});

test("원격·풀지 못한 경로는 확인하지 않고 원문을 복사용으로 넘긴다", async () => {
  let calls = fake("macos");
  await handleLink({ link: { kind: "file", raw: "/srv/app.log", path: null }, source: { ...local, machine: "box" } });
  assert.deepEqual(of(calls, "exec"), []);
  assert.deepEqual(of(calls, "overlay")[0][0].props, { path: "/srv/app.log", kind: "remote" });
  calls = fake("macos");
  await handleLink({ link: { kind: "file", raw: "/srv/x", path: "/srv/x" }, source: { ...local, machine: "box" } });
  assert.deepEqual(of(calls, "exec"), []);
});

test("경로 확인이 실패하면 오류 알림만 띄우고 복사 메뉴는 연다", async () => {
  for (const fail of ["code", "spawn"]) {
    const calls = fake("macos", "", fail);
    await handleLink({ link: { kind: "file", raw: "a", path: "/w/a" }, source: local });
    const notes = of(calls, "notify").map((n) => n[0]);
    assert.deepEqual(notes.map((n) => [n.title, n.level]), [["경로 확인 실패", "error"]]);
    assert.equal(of(calls, "overlay")[0][0].props.kind, "missing");
  }
});

test("열기·복사 명령이 0이 아닌 코드로 끝나거나 실행되지 않으면 오류 알림을 띄운다", async () => {
  for (const platform of ["macos", "windows", "linux"]) {
    for (const [fn, title] of [[() => openFolder("/w/a", false), "폴더 열기 실패"], [() => openFile("/w/a"), "파일 열기 실패"], [() => copyText("/w/a"), "경로 복사 실패"]]) {
      let calls = fake(platform, "", "code");
      assert.equal(await fn(), null);
      assert.deepEqual(of(calls, "notify").map((n) => [n[0].title, n[0].body, n[0].level]), [[title, "boom", "error"]]);
      calls = fake(platform, "", "spawn");
      assert.equal(await fn(), null);
      assert.equal(of(calls, "notify")[0][0].level, "error");
    }
  }
});

test("psText는 숫자와 쉼표로만 문자열을 다시 만든다", () => {
  const nasty = "C:\\a\\it's ‘x’ ‚y‛ “z” $(calc) `n;.txt 😀";
  const e = psText(nasty);
  assert.match(e, /^\(-join \[char\[\]\]@\([\d,]+\)\)$/);
  assert.equal(unps(e), nasty);
});

test("Windows: 따옴표 비슷한 글자가 든 경로도 스크립트에 글자로 넣지 않는다", async () => {
  for (const path of ["C:\\w\\it’s.txt", "C:\\w\\‘; calc; ‘.txt", "C:\\w\\a'b‚c‛d.txt"]) {
    const calls = fake("windows", "file\r\n");
    await kindOf(path);
    await openFolder(path, false);
    await openFolder(path, true);
    await openFile(path);
    await copyText(path);
    const execs = of(calls, "exec");
    assert.equal(execs.length, 5);
    for (const [cmd, args] of execs) {
      assert.equal(cmd, "powershell.exe");
      const script = args.at(-1);
      for (const ch of "’‘‚‛\"") assert.ok(!script.includes(ch), `${ch} in ${script}`);
      assert.ok(!script.includes(path));
      assert.equal(unps(script), path);
    }
    const scripts = execs.map((e) => e[1].at(-1).replace(/^\$p = \(-join [^;]*\); /, ""));
    assert.deepEqual(scripts.slice(1), [
      "Start-Process explorer.exe -ArgumentList ('/select,' + [char]34 + $p + [char]34)",
      "Start-Process explorer.exe -ArgumentList ([char]34 + $p + [char]34)",
      "Invoke-Item -LiteralPath $p",
      "Set-Clipboard -Value $p",
    ]);
  }
});

test("Windows 경로 확인은 PowerShell 결과로 종류를 정한다", async () => {
  fake("windows", "dir\r\n");
  assert.equal(await kindOf("C:\\w"), "dir");
  fake("windows", "\r\n");
  assert.equal(await kindOf("C:\\w"), "missing");
});

test("macOS·Linux는 경로를 인자 하나로 넘긴다", async () => {
  let calls = fake("macos");
  await openFolder("/w/it’s b.txt", false);
  await openFolder("/w/dir", true);
  await openFile("/w/it’s b.txt");
  await copyText("/w/it’s b.txt");
  assert.deepEqual(of(calls, "exec").map((c) => [c[0], c[1]]), [
    ["open", ["-R", "/w/it’s b.txt"]],
    ["open", ["/w/dir"]],
    ["open", ["/w/it’s b.txt"]],
    ["sh", ["-c", 'printf %s "$1" | pbcopy', "sh", "/w/it’s b.txt"]],
  ]);
  calls = fake("linux");
  await openFolder("/w/‘a’.txt", false);
  await openFile("/w/‘a’.txt");
  assert.deepEqual(of(calls, "exec").map((c) => [c[0], c[1]]), [["xdg-open", ["/w"]], ["xdg-open", ["/w/‘a’.txt"]]]);
});

// Windows CI에서만: os.js가 만든 스크립트를 진짜 PowerShell로 돌려, 따옴표 비슷한 글자가 든 이름도
// 그대로 찾고 이름 속 명령은 실행되지 않는지 본다.
test("Windows PowerShell에서 실제 파일 이름으로 확인한다", { skip: process.platform !== "win32" }, async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "path-menu-"));
  const marker = join(dir, "pwned"); // 이름 속 New-Item이 실행되면 생기는 파일
  try {
    const file = join(dir, "it’s ‘x’ ‚y‛ a'b; New-Item pwned; ‘.txt");
    const sub = join(dir, "‘폴더’");
    writeFileSync(file, "x");
    mkdirSync(sub);
    for (const [path, want] of [[file, "file"], [sub, "dir"], [join(dir, "없는’파일"), "missing"]]) {
      const calls = fake("windows", "");
      await kindOf(path);
      const [[cmd, args]] = of(calls, "exec");
      assert.equal(execFileSync(cmd, args, { encoding: "utf8", cwd: dir }).trim(), want);
    }
    // 이어 붙인 후보 여러 개를 한 번에 확인한다(쓸 수 없는 글자가 든 후보는 없는 것으로).
    const calls = fake("windows", "");
    await kindsOf([file, sub, join(dir, "없는’파일"), join(dir, "a<b>|c")]);
    const [[cmd, args]] = of(calls, "exec");
    assert.deepEqual(execFileSync(cmd, args, { encoding: "utf8", cwd: dir }).trim().split(/\r?\n/), ["file", "dir", "missing", "missing"]);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 줄바꿈으로 나뉜 경로 이어 붙이기 ----
// Claude Code 화면 모양을 흉내 낸다(200칸 화면에서 본 것): 첫 줄은 "⏺ ", 이어지는 줄은 2칸 들여쓰기,
// 글은 오른쪽 2칸을 비우고(cols - 2) 끊으며, 한 줄보다 긴 낱말(경로)은 줄 끝까지 채우고 중간에서 자른다.
// 넓은 글자(한글)가 마지막 칸에 안 들어가면 다음 줄로 넘긴다.
function claudeRows(text, cols, { first = "⏺ ", indent = "  ", gutter = 2 } = {}) {
  const width = cols - gutter;
  const rows = [];
  let row = first;
  const put = (ch) => {
    if (cellWidth(row + ch) > width) {
      rows.push(row);
      row = indent;
    }
    row += ch;
  };
  for (const word of text.split(" ")) {
    const fresh = row === first || row === indent;
    const lead = fresh ? "" : " ";
    if (cellWidth(row + lead + word) <= width) row += lead + word;
    else if (cellWidth(indent + word) <= width) {
      rows.push(row);
      row = indent + word;
    } else {
      if (!fresh) row += " ";
      for (const ch of word) put(ch);
    }
  }
  rows.push(row);
  return rows;
}
// Herdr가 한 줄에서 찾아 넘기는 조각: 줄 속 경로처럼 보이는 낱말(괄호·따옴표·조사 바깥은 뺀다).
const pieceOf = (row, from) => row.trim().split(" ").find((w) => w.includes(from)).replace(/^[(`'"]+|[)`'".,가-힣]+$/g, "");
// hc read/get 대답: 화면 글과 칸 수.
const screen = (rows, cols) => (a) => a[0] === "read"
  ? { code: 0, stdout: JSON.stringify({ complete: true, how: "screen", text: rows.join("\n") }), stderr: "" }
  : { code: 0, stdout: JSON.stringify({ address: a[1], cols, rows: 40 }), stderr: "" };
// 있는 경로 목록으로 kindOf·kindsOf에 답하는 가짜 exec(sh 인자 또는 PowerShell 글자 코드를 읽는다).
const unpsAll = (script) => [...script.matchAll(/\[char\[\]\]@\(([\d,]*)\)/g)].map((m) => String.fromCharCode(...m[1].split(",").map(Number)));
function fakeFs(platform, rows, cols, existing) {
  const calls = fake(platform, (cmd, args) => {
    const paths = cmd === "sh" ? args.slice(3) : unpsAll(args.at(-1));
    return paths.map((p) => existing[p] ?? "missing").join("\n") + "\n";
  });
  globalThis.__herdr.hc = rows ? screen(rows, cols) : undefined;
  return calls;
}
const click = (raw, path, source = local) => handleLink({ link: { kind: "file", raw, path }, source });
const opened = (calls) => of(calls, "overlay")[0][0].props;

test("글자 칸 너비: 한글·전각·이모지는 2칸", () => {
  assert.equal(cellWidth("ab"), 2);
  assert.equal(cellWidth("경로a"), 5);
  assert.equal(cellWidth("ＡＢ😀"), 6);
});

test("시험용 화면은 Claude Code처럼 2칸 들여쓰고 cols-2에서 경로 중간을 자른다", () => {
  const path = "/home/dev/projects/sample-app/src/components/very-long-directory-name/another-nested-folder/final-file-name.tsx";
  const rows = claudeRows(`수정한 파일은 ${path} 입니다.`, 100);
  assert.equal(rows.length, 2);
  assert.equal(cellWidth(rows[0]), 98);
  assert.match(rows[1], /^ {2}\S/);
  assert.ok(!rows[0].includes(path) && !rows[1].includes(path));
});

test("두 줄로 나뉜 경로: 윗줄·아랫줄 어느 쪽을 눌러도 이어 붙인 경로를 연다", async () => {
  const path = "/home/dev/projects/sample-app/src/components/very-long-directory-name/another-nested-folder/final-file-name.tsx";
  for (const cols of [100, 101, 110]) {
    const rows = claudeRows(`수정한 파일은 ${path} 입니다.`, cols);
    assert.equal(rows.length, 2, `cols ${cols}`);
    const top = pieceOf(rows[0], "/home");
    const bottom = rows[1].trim().split(" ")[0];
    for (const [raw, rawPath] of [[top, top], [bottom, `/work/${bottom}`]]) {
      const calls = fakeFs("macos", rows, cols, { [path]: "file" });
      assert.equal(await click(raw, rawPath), "handled");
      assert.deepEqual(opened(calls), { path, kind: "file" }, `cols ${cols} raw ${raw}`);
      assert.deepEqual(of(calls, "notify"), []);
      assert.equal(of(calls, "exec").length, 1); // 후보 확인 한 번으로 끝난다
      assert.deepEqual(of(calls, "hc").map((c) => c[0]), [["read", "t1", "--json"], ["get", "t1"]]);
    }
  }
});

test("세 줄에 걸친 경로: 위·가운데·아래 조각 모두 같은 경로가 된다", async () => {
  const path = "/home/dev/projects/sample-app/packages/feature-module/src/internal/helpers/deeply/nested/structure/folder/target";
  const rows = claudeRows(`폴더 ${path} 를 보세요`, 60);
  assert.equal(rows.length, 3);
  const pieces = [pieceOf(rows[0], "/home"), rows[1].trim(), rows[2].trim().split(" ")[0]];
  assert.equal(pieces.join(""), path);
  for (const raw of pieces) {
    const calls = fakeFs("linux", rows, 60, { [path]: "dir" });
    await click(raw, raw.startsWith("/") ? raw : `/work/${raw}`);
    assert.deepEqual(opened(calls), { path, kind: "dir" }, raw);
  }
});

test("다음 줄이 글이면 이어 붙인 경로가 없어서 원래 경로를 쓴다", async () => {
  // 경로가 줄 끝에 딱 닿고 다음 줄은 낱말이 이어지는 경우
  for (const next of ["그리고 다음 단계로 넘어갑니다", "and then the build continues"]) {
    const path = "/home/dev/projects/app/src/index.ts";
    const head = "x".repeat(98 - 2 - 1 - path.length);
    const rows = [`⏺ ${head} ${path}`, `  ${next}`];
    assert.equal(cellWidth(rows[0]), 98);
    const calls = fakeFs("macos", rows, 100, { [path]: "file" });
    await click(path, path);
    assert.deepEqual(opened(calls), { path, kind: "file" });
    const [first, second] = of(calls, "exec");
    assert.ok(first[1].slice(3).every((p) => p !== path && p.startsWith(path))); // 붙인 후보만 먼저 본다
    assert.deepEqual(second[1].slice(3), [path]); // 없으니 원래 경로 확인
  }
});

test("가장자리에 닿지 않은 줄은 붙이지 않는다", () => {
  const rows = ["⏺ 짧은 줄 /home/dev/a", "  b/c.txt 다음"];
  assert.deepEqual(joinCandidates(rows, "/home/dev/a", 100), []);
  assert.deepEqual(joinCandidates(rows, "b/c.txt", 100), []);
});

test("한글 글 뒤에서 잘린 경로도 칸 너비로 가장자리를 잰다", async () => {
  const path = "/home/dev/작업/프로젝트-폴더/소스/아주-긴-한글-폴더-이름/설정-파일-모음/최종-설정.json";
  const rows = claudeRows(`한글 설명이 길게 이어지는 문장 다음에 ${path} 파일을 열어 보세요.`, 80);
  assert.ok(rows.length >= 2);
  assert.ok(rows.slice(0, -1).every((r) => cellWidth(r) >= 80 - 3), rows.map(cellWidth).join(","));
  const bottom = rows.at(-1).trim().split(" ")[0];
  const calls = fakeFs("macos", rows, 80, { [path]: "file" });
  await click(bottom, `/work/${bottom}`);
  assert.deepEqual(opened(calls), { path, kind: "file" });
});

test("상대 경로는 cwd 기준으로 풀고, 바깥 따옴표·조사·문장부호·줄 번호는 뗀다", () => {
  const cases = [
    ["src/modules/path-menu/a-very-long-name-for-a-module-folder/subfolder/another-level/os.js", "{p}로 옮겼습니다."],
    ["src/modules/path-menu/a-very-long-name-for-a-module-folder/subfolder/another-level/os.js", "(`{p}:12:3`) 참고"],
    ["docs/guide/a-very-long-name-for-a-documentation-folder/chapter-one/section-two/readme.md", "{p}."],
  ];
  for (const [rel, shape] of cases) {
    const rows = claudeRows(`앞 문장을 조금 길게 써서 경로가 잘리게 한다 ${shape.replace("{p}", rel)}`, 90);
    assert.equal(rows.length, 2, rows.join("\n"));
    const bottomRaw = rows[1].trim().split(" ")[0].replace(/[)`'".,가-힣]+$/g, "").replace(/(:\d+)+$/, "");
    const guesses = joinedPaths(rows, bottomRaw, 90, { cwd: "/work", home: "/home/dev" });
    assert.ok(guesses.includes(`/work/${rel}`), `${shape}\n${guesses.join("\n")}`);
  }
  // ~/ 는 홈 폴더로
  const rows = ["⏺ " + "x".repeat(70) + " ~/notes/a-long-folder", "  -name/today.md 입니다"];
  assert.ok(joinedPaths(rows, "-name/today.md", cellWidth(rows[0]) + 2, { cwd: "/work", home: "/home/dev" })
    .includes("/home/dev/notes/a-long-folder-name/today.md"));
});

test("도구 미리보기(⎿)의 5칸 들여쓰기도 이어 붙인다", () => {
  const path = "/home/dev/projects/sample-app/build/output/generated/reports/coverage/lcov-report/index.html";
  const rows = claudeRows(path, 64, { first: "  ⎿  ", indent: "     " });
  assert.equal(rows.length, 2);
  const top = rows[0].trim().slice(3).trim();
  assert.equal(joinedPaths(rows, top, 64, { cwd: "/work" })[0], path);
  assert.equal(joinedPaths(rows, rows[1].trim(), 64, { cwd: "/work" })[0], path);
});

test("Windows 경로도 이어 붙이고, 확인 스크립트에는 경로를 글자로 넣지 않는다", async () => {
  const path = "C:\\Users\\dev\\projects\\sample-app\\src\\components\\very-long-directory-name\\it’s-nested\\final-file.tsx";
  const rows = claudeRows(`수정한 파일은 ${path} 입니다.`, 90);
  assert.equal(rows.length, 2);
  const bottom = rows[1].trim().split(" ")[0];
  const calls = fakeFs("windows", rows, 90, { [path]: "file" });
  await click(bottom, `C:\\work\\${bottom}`, { ...local, cwd: "C:\\work" });
  assert.deepEqual(opened(calls), { path, kind: "file" });
  const [[cmd, args, opts]] = of(calls, "exec");
  assert.equal(cmd, "powershell.exe");
  assert.deepEqual(opts, { timeout: 5000 });
  const script = args.at(-1);
  assert.ok(!script.includes("’") && !script.includes(path));
  assert.ok(unpsAll(script).includes(path));
  // 상대 경로는 cwd 아래로, 역슬래시로 잇는다
  const rel = joinedPaths(["⏺ " + "x".repeat(60) + " src\\a-long-folder", "  -name\\b.cs 끝"], "src\\a-long-folder", 82,
    { cwd: "C:\\work\\", windows: true });
  assert.ok(rel.includes("C:\\work\\src\\a-long-folder-name\\b.cs"), rel.join("\n"));
});

test("화면을 못 읽거나 확인이 실패해도 원래 경로로 메뉴를 연다", async () => {
  const path = "/w/a.txt";
  for (const hcAnswer of [undefined, () => new Error("no hc"), () => ({ code: 0, stdout: "not json", stderr: "" }),
    (a) => (a[0] === "read" ? { code: 0, stdout: "{}", stderr: "" } : { code: 0, stdout: '{"cols":0}', stderr: "" })]) {
    const calls = fake("macos", "file\n");
    globalThis.__herdr.hc = hcAnswer;
    assert.equal(await click("a.txt", path), "handled");
    assert.deepEqual(opened(calls), { path, kind: "file" });
    assert.deepEqual(of(calls, "exec").map((c) => c[1].at(-1)), [path]);
  }
  // 후보 확인 명령이 실패하면(종료 코드 1) 알림 없이 원래 경로 확인으로 넘어간다
  const rows = ["⏺ " + "x".repeat(80) + " /w/split-", "  name.txt"];
  let n = 0;
  const calls = fake("macos", () => (n++ === 0 ? { code: 1, stdout: "", stderr: "timeout" } : "file\n"));
  globalThis.__herdr.hc = screen(rows, cellWidth(rows[0]) + 2);
  await click("name.txt", "/work/name.txt");
  assert.deepEqual(opened(calls), { path: "/work/name.txt", kind: "file" });
  assert.deepEqual(of(calls, "notify"), []);
});

test("kindsOf는 경로를 인자로 넘기고 시간 제한을 둔다", async () => {
  const calls = fake("linux", "dir\nmissing\nfile\n");
  assert.deepEqual(await kindsOf(["/a b", "/c’d", "/e"]), ["dir", "missing", "file"]);
  const [[cmd, args, opts]] = of(calls, "exec");
  assert.equal(cmd, "sh");
  assert.deepEqual(args.slice(2), ["sh", "/a b", "/c’d", "/e"]);
  assert.deepEqual(opts, { timeout: 5000 });
  fake("linux", "dir\n");
  assert.equal(await kindsOf(["/a", "/b"]), null); // 대답 줄 수가 다르면 믿지 않는다
  fake("linux", "", "spawn");
  assert.equal(await kindsOf(["/a"]), null);
  assert.deepEqual(await kindsOf([]), []);
});
