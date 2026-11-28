// node --test herdr/test/inbox-newspace.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { newSpaceArgs, PICK_FOLDER } from "../mods/inbox/newspace.js";

test("newSpaceArgs: 고른 폴더 이름으로 space.new 인자를 만든다", () => {
  assert.deepEqual(newSpaceArgs({ code: 0, stdout: "/Users/me/code/my repo/\n" }), { name: "my repo", folder: "/Users/me/code/my repo", tab: "PO · my repo", argv: ["claude", "--remote-control", "PO"], task: "/PO" });
});
test("newSpaceArgs: 취소·빈 출력·루트는 null", () => {
  assert.equal(newSpaceArgs({ code: 1, stdout: "", stderr: "User canceled. (-128)" }), null);
  assert.equal(newSpaceArgs({ code: 0, stdout: "\n" }), null);
  assert.equal(newSpaceArgs({ code: 0, stdout: "/\n" }), null);
  assert.equal(newSpaceArgs(null), null);
});
test("PICK_FOLDER는 폴더 선택 AppleScript다", () => assert.match(PICK_FOLDER[1], /choose folder/));
