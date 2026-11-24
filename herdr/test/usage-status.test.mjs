// node --test herdr/test/usage-status.test.mjs
// main.js는 Herdr 전용 모듈(gpui-kit·herdr 등)을 불러오므로, 같은 이름의 빈 모듈로 바꿔서 순수 함수만 시험한다.
import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const stub = "export const View = class {}; export const div = () => ({}); export const svg = div; export const h_flex = div;" +
  "export const spaces = () => []; export const agents = () => []; export const theme = () => ({}); export const run = () => {};" +
  "export const window = () => ({}); export const keys = () => []; export const home = () => ''; export const readTextFile = async () => '';";
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function resolve(s, c, n) { return ["gpui-kit","gpui-base","herdr"].includes(s) ? { url: "stub:" + s, shortCircuit: true } : n(s, c); }
export async function load(u, c, n) { return u.startsWith("stub:") ? { format: "module", source: ${JSON.stringify(stub)}, shortCircuit: true } : n(u, c); }
`)}`;
register(hooks);
const { parseUsage, barOf } = await import("../mods/usage-status/main.js");

const NOW = Date.parse("2026-11-17T05:10:00Z");
const file = (limits, updatedAt = "2026-11-17T05:05:00Z") => JSON.stringify({ updatedAt, limits });

test("barOf: 비율만큼 채우고 나머지는 빈칸", () => {
  assert.deepEqual(barOf(50, 8), { filled: "▰▰▰▰", empty: "▱▱▱▱" });
  assert.deepEqual(barOf(0, 8), { filled: "", empty: "▱▱▱▱▱▱▱▱" });
  assert.deepEqual(barOf(100, 8), { filled: "▰▰▰▰▰▰▰▰", empty: "" });
});

test("barOf: 0보다 크면 최소 1칸, 100 초과·음수·NaN은 칸을 넘지 않는다", () => {
  assert.equal(barOf(1, 8).filled, "▰");
  assert.equal(barOf(250, 8).filled.length, 8);
  assert.equal(barOf(-5, 8).filled, "");
  assert.equal(barOf(NaN, 8).filled, "");
  assert.equal(barOf(30).filled.length + barOf(30).empty.length, 8);
});

test("parseUsage: 5h·7d 행을 반올림해서 돌려준다", () => {
  const rows = parseUsage(file([{ kind: "five_hour", percentUsed: 7.4 }, { kind: "seven_day", percentUsed: 19.6 }, { kind: "spend_limit", percentUsed: 3 }]), NOW);
  assert.deepEqual(rows, [{ label: "5h", percent: 7 }, { label: "7d", percent: 20 }]);
});

test("parseUsage: 없음·깨진 JSON·오래됨·빈 한도는 null(Unknown)", () => {
  assert.equal(parseUsage(null, NOW), null);
  assert.equal(parseUsage("{oops", NOW), null);
  assert.equal(parseUsage(file([{ kind: "five_hour", percentUsed: 7 }], "2026-11-17T04:50:00Z"), NOW), null);
  assert.equal(parseUsage(file([]), NOW), null);
  assert.equal(parseUsage(file([{ kind: "five_hour", percentUsed: "x" }]), NOW), null);
});
