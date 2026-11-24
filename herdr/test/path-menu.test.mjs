// node --test herdr/test/path-menu.test.mjs
// link.js·main.js는 Herdr 전용 모듈을 불러오므로, 호출을 기록하는 가짜 모듈로 바꿔 시험한다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const stub = "const h = () => globalThis.__herdr;" +
  "export const View = class {}; export const div = () => ({}); export const v_flex = div; export const h_flex = div;" +
  "export const theme = () => ({}); export const props = () => null; export const closeOverlay = () => null;" +
  "export const window = () => ({ platform: h().platform });" +
  "export const exec = (...a) => { h().calls.push(['exec', ...a]); return Promise.resolve({ code: 0, stdout: h().stdout, stderr: '' }); };" +
  "export const notify = (n) => { h().calls.push(['notify', n]); return 'n1'; };" +
  "export const openOverlay = (o) => { h().calls.push(['overlay', o]); return 'o1'; };";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { handleLink } = await import("../mods/path-menu/link.js");
const { openFolder, openFile, copyText } = await import("../mods/path-menu/main.js");

const local = { terminal: "t1", machine: null, cwd: "/work", pane: null, tab: null, space: null };
function fake(platform, stdout = "") {
  globalThis.__herdr = { platform, stdout, calls: [] };
  return globalThis.__herdr.calls;
}
const of = (calls, kind) => calls.filter((c) => c[0] === kind).map((c) => c.slice(1));

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

test("Windows는 PowerShell로 종류를 확인하고, 작은따옴표를 이스케이프한다", async () => {
  const calls = fake("windows", "file\r\n");
  await handleLink({ link: { kind: "file", raw: "x", path: "C:\\a\\it's.txt" }, source: local });
  const [[cmd, args]] = of(calls, "exec");
  assert.equal(cmd, "powershell.exe");
  assert.match(args.at(-1), /'C:\\a\\it''s\.txt'/);
  assert.equal(of(calls, "overlay")[0][0].props.kind, "file");
});

test("macOS: 파일은 Finder에서 골라 보여 주고, 폴더는 그 폴더를 연다", () => {
  const calls = fake("macos");
  openFolder("/w/a b.txt", false);
  openFolder("/w/dir", true);
  openFile("/w/a b.txt");
  copyText("/w/a b.txt");
  assert.deepEqual(of(calls, "exec").map((c) => [c[0], c[1]]), [
    ["open", ["-R", "/w/a b.txt"]],
    ["open", ["/w/dir"]],
    ["open", ["/w/a b.txt"]],
    ["sh", ["-c", 'printf %s "$1" | pbcopy', "sh", "/w/a b.txt"]],
  ]);
});

test("Windows: 파일은 explorer /select로, 폴더는 explorer로 열고 경로는 Set-Clipboard로 복사한다", () => {
  const calls = fake("windows");
  openFolder("C:\\w\\a.txt", false);
  openFolder("C:\\w", true);
  openFile("C:\\w\\a.txt");
  copyText("C:\\w\\a.txt");
  const scripts = of(calls, "exec").map((c) => c[1].at(-1));
  assert.equal(scripts[0], `Start-Process explorer.exe -ArgumentList '/select,"C:\\w\\a.txt"'`);
  assert.equal(scripts[1], `Start-Process explorer.exe -ArgumentList '"C:\\w"'`);
  assert.equal(scripts[2], `Invoke-Item -LiteralPath 'C:\\w\\a.txt'`);
  assert.equal(scripts[3], `Set-Clipboard -Value 'C:\\w\\a.txt'`);
});
