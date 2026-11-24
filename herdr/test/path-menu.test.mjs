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
  "  return Promise.resolve(x.fail === 'code' ? { code: 1, stdout: '', stderr: 'boom\\nmore' } : { code: 0, stdout: x.stdout, stderr: '' }); };" +
  "export const notify = (n) => { h().calls.push(['notify', n]); return 'n1'; };" +
  "export const openOverlay = (o) => { h().calls.push(['overlay', o]); return 'o1'; };";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { handleLink } = await import("../mods/path-menu/link.js");
await import("../mods/path-menu/main.js"); // 화면 모듈도 불러와지는지만 본다.
const { kindOf, openFolder, openFile, copyText, psText } = await import("../mods/path-menu/os.js");

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
  const marker = join(dir, "pwned");
  try {
    const file = join(dir, `it’s ‘x’ ‚y‛ a'b; New-Item ${marker}; ‘.txt`);
    const sub = join(dir, "‘폴더’");
    writeFileSync(file, "x");
    mkdirSync(sub);
    for (const [path, want] of [[file, "file"], [sub, "dir"], [join(dir, "없는’파일"), "missing"]]) {
      const calls = fake("windows", "");
      await kindOf(path);
      const [[cmd, args]] = of(calls, "exec");
      assert.equal(execFileSync(cmd, args, { encoding: "utf8" }).trim(), want);
    }
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
