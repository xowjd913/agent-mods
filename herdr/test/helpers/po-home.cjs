// Test helper: makes this process's home look like a PO machine (the arrange script exists), so a profile with no `preset` resolves to "po" the way it
// does on a developer PC, whatever machine runs the tests (CI has no such script). Require it first in a test that expects today's default names.
// It points HOME / USERPROFILE at a temp folder, so nothing here reads or writes the real home.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "po-home-"));
const script = path.join(home, ".claude", "skills", "leader", "herdr-team.sh");
fs.mkdirSync(path.dirname(script), { recursive: true });
fs.writeFileSync(script, "#!/bin/sh\n");
process.env.HOME = home;
process.env.USERPROFILE = home;
module.exports = { home, script };
