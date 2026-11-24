#!/usr/bin/env node
// Data layer for the work/prs/wt-menu mods: prints one JSON object with Herdr sessions mapped to
// issues, per-repo worktrees and open PRs. Read-only (GitHub is only read through one GraphQL call).
//   node collect.cjs          JSON for the mods
//   node collect.cjs --refresh  same, but skip the local (30s) and GitHub (3min) caches; the mods' refresh button uses it
//   node collect.cjs --debug  per-session mapping table
//   node collect.cjs scan <transcript.jsonl>  mapping for one (ended) session transcript
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const REFRESH = process.argv.includes("--refresh");
const VERSION = 2;
const LOCAL_TTL = 30 * 1000;
const GITHUB_TTL = 3 * 60 * 1000;
const APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const CACHE_FILE = path.join(APP_HOME, "cache", "collect.json");
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const MAX_DIRS = 300;

const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 20000, maxBuffer: 32 << 20, windowsHide: true, ...options });
  } catch {
    return null;
  }
}
const git = (dir, ...args) => run("git", ["-C", dir, ...args]);

// ---- cache ----
let cache = { version: VERSION, transcripts: {}, entries: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  if (loaded.version === VERSION) cache = loaded;
} catch {}
// Keys read in this run: a full run drops every cache entry and transcript it did not touch, so the file stays small.
const touched = { entries: new Set(), transcripts: new Set() };
function pruneCache() {
  for (const key of Object.keys(cache.entries)) if (!touched.entries.has(key)) delete cache.entries[key];
  // A cached local result skips the transcript scan, so only prune transcripts when this run scanned.
  if (touched.transcripts.size) for (const file of Object.keys(cache.transcripts)) if (!touched.transcripts.has(file)) delete cache.transcripts[file];
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const temp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(cache));
    fs.renameSync(temp, CACHE_FILE);
  } catch {}
}
function cached(key, ttl, produce) {
  touched.entries.add(key);
  const hit = cache.entries[key];
  if (!REFRESH && hit && Date.now() - hit.at < ttl) return hit.value;
  const value = produce();
  if (value !== null && value !== undefined) cache.entries[key] = { at: Date.now(), value };
  return value;
}

// ---- transcript scan: only file-tool paths, shell cd / git -C, Agent prompts and issue URLs in human messages ----
const ISSUE_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g;
const ABS_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`)<>|;&]+/g;
const FILE_TOOLS = { Read: "file_path", Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path", MultiEdit: "file_path" };
const SHELL_DIR = /(?:\bcd\s+|\bgit\s+-C\s+|--(?:target|cwd|path)[=\s]+)("[^"]+"|'[^']+'|[^\s;&|]+)/g;

function bump(map, key) {
  if (map[key] || Object.keys(map).length < MAX_DIRS) map[key] = (map[key] || 0) + 1;
}
function dirOf(p) {
  return /\.[A-Za-z0-9]{1,6}$/.test(path.basename(p)) ? path.dirname(p) : p;
}
function addPath(state, raw, base) {
  let p = raw.replace(/^~(?=\/|$)/, os.homedir());
  if (!path.isAbsolute(p) && !/^[A-Za-z]:/.test(p)) p = base ? path.resolve(base, p) : "";
  if (p) bump(state.dirs, norm(dirOf(p)));
}
function addIssueUrls(state, text) {
  for (const m of text.matchAll(ISSUE_URL)) bump(state.urls, `${m[1]}/${m[2]}#${m[3]}`);
}
function humanText(o) {
  if (o.type !== "user" || o.isMeta || o.toolUseResult) return "";
  const c = o.message && o.message.content;
  if (typeof c === "string") return c.startsWith("<") ? "" : c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b.type === "text" && !b.text.startsWith("<")).map((b) => b.text).join("\n");
}
function scanRecord(state, o) {
  const content = o.message && o.message.content;
  if (o.type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "text" && b.text.trim()) state.last = b.text.trim().split("\n").find((l) => l.trim()).trim().slice(0, 160);
      if (b.type !== "tool_use") continue;
      const input = b.input || {};
      if (FILE_TOOLS[b.name] && input[FILE_TOOLS[b.name]]) addPath(state, input[FILE_TOOLS[b.name]], o.cwd);
      else if (b.name === "Bash" && typeof input.command === "string") {
        for (const m of input.command.matchAll(SHELL_DIR)) addPath(state, m[1].replace(/^["']|["']$/g, ""), o.cwd);
      } else if ((b.name === "Agent" || b.name === "Task") && typeof input.prompt === "string") {
        for (const m of input.prompt.matchAll(ABS_PATH)) addPath(state, m[0], null);
        addIssueUrls(state, input.prompt);
      }
    }
    return;
  }
  const text = humanText(o);
  if (text) addIssueUrls(state, text);
}
function scanTranscript(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  touched.transcripts.add(file);
  let state = cache.transcripts[file];
  if (!state || stat.size < state.offset) state = cache.transcripts[file] = { offset: 0, dirs: {}, urls: {}, last: "" };
  if (stat.size === state.offset) return state;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - state.offset);
    fs.readSync(fd, buffer, 0, buffer.length, state.offset);
    const end = buffer.lastIndexOf(10) + 1;
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        scanRecord(state, JSON.parse(line));
      } catch {}
    }
    state.offset += end;
  } finally {
    fs.closeSync(fd);
  }
  return state;
}
function transcriptOf(sessionId) {
  const root = path.join(CLAUDE_HOME, "projects");
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

// ---- repos and worktrees ----
function slugOf(dir) {
  const url = (git(dir, "remote", "get-url", "origin") || "").trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
function issueFromName(...names) {
  for (const name of names) {
    const m = name && name.match(/(?:^|[/-])(\d{1,5})-[^/]*|(?:^|\/)review-(\d{1,5})/);
    if (m) return Number(m[1] || m[2]);
  }
  return null;
}
function repoOf(cwd) {
  const common = (git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir") || "").trim();
  if (!common) return null;
  const root = norm(common.replace(/\/\.git$/, ""));
  const slug = slugOf(root);
  return slug ? { root, slug } : null;
}
function worktreesOf(repo) {
  const out = git(repo.root, "worktree", "list", "--porcelain") || "";
  const list = [];
  for (const block of out.split(/\n\n+/)) {
    const wt = { path: "", branch: null };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = norm(line.slice(9));
      else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace("refs/heads/", "");
    }
    if (!wt.path) continue;
    wt.main = wt.path === repo.root;
    wt.issue = issueFromName(wt.branch, path.basename(wt.path));
    wt.temp = !wt.main && !wt.issue;
    list.push(wt);
  }
  return list;
}

// ---- local part: terminals, sessions, repos ----
function collectLocal() {
  const listing = run("hc", ["ls", "--json"]);
  const terminals = listing ? JSON.parse(listing).terminals || [] : [];
  const repos = new Map();
  const sessions = [];
  for (const t of terminals) {
    if (t.cwd && !repos.has(t.cwd)) repos.set(t.cwd, repoOf(t.cwd));
  }
  const byRoot = new Map();
  for (const repo of repos.values()) if (repo && !byRoot.has(repo.root)) byRoot.set(repo.root, { ...repo, worktrees: worktreesOf(repo) });
  for (const t of terminals) {
    if (t.agent !== "claude-code") continue;
    const detail = JSON.parse(run("hc", ["get", t.address]) || "{}");
    const pid = detail.foreground && detail.foreground.pid;
    let sessionId = null;
    try {
      sessionId = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, "sessions", `${pid}.json`), "utf8")).sessionId;
    } catch {}
    const file = sessionId && transcriptOf(sessionId);
    const state = file && scanTranscript(file);
    sessions.push({
      terminal: t.address,
      name: t.name || null,
      label: (detail.labels && detail.labels.session) || detail.title || t.name || t.address,
      parent: t.parent || null,
      status: t.status || null,
      cwd: t.cwd,
      where: t.where || null,
      last: (state && state.last) || (detail.status && detail.status.msg) || "",
      signals: state ? { dirs: state.dirs, urls: state.urls } : { dirs: {}, urls: {} },
    });
  }
  return { sessions, repos: [...byRoot.values()] };
}

// ---- mapping: signals -> issues ----
function mapIssues(signals, repos) {
  const weights = {};
  const add = (key, n) => (weights[key] = (weights[key] || 0) + n);
  for (const [dir, n] of Object.entries(signals.dirs)) {
    for (const repo of repos) {
      const wt = repo.worktrees.filter((w) => !w.main && (dir === w.path || dir.startsWith(`${w.path}/`))).sort((a, b) => b.path.length - a.path.length)[0];
      // A worktree outside the repository root still counts; anything else must be under the root.
      if (!wt && !(dir === repo.root || dir.startsWith(`${repo.root}/`))) continue;
      const rel = dir.slice(repo.root.length + 1).split("/")[0];
      const issue = wt ? wt.issue : /^(?:review-)?\d{1,5}(?:-|$)/.test(rel) ? issueFromName(rel) : null;
      if (issue) add(`${repo.slug}#${issue}`, n);
      break;
    }
  }
  for (const [key, n] of Object.entries(signals.urls)) add(key, n);
  const top = Math.max(0, ...Object.values(weights));
  return Object.entries(weights)
    .filter(([, w]) => w >= Math.max(1, top * 0.2))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, weight]) => {
      const [repo, number] = key.split("#");
      return { key, repo, number: Number(number), weight };
    });
}

// ---- GitHub: one aliased GraphQL call, read-only ----
const PR_FIELDS = "number title url isDraft state mergedAt closedAt headRefName author{login} updatedAt reviewDecision reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}";
const PROJECT_FIELDS = " projectItems(first:2){nodes{fieldValueByName(name:\"Status\"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}";
const ISSUE_FIELDS = (rich, project) =>
  `number title url state closedAt labels(first:8){nodes{name}}${project ? PROJECT_FIELDS : ""}${rich ? " parent{number title url subIssuesSummary{total completed}}" : ""}`;
// A token without read:project fails the whole query on projectItems; remember that so later runs skip it.
// --refresh probes again, so the project status comes back after `gh auth refresh -s read:project`.
const NO_PROJECT_KEY = "gh:no-project";
const NO_PROJECT_TTL = 60 * 60 * 1000;
const NO_PROJECT_NOTE = "프로젝트 상태 숨김 (read:project 권한 없음) · gh auth refresh -s read:project 후 새로고침";
function buildQuery(repos, issues, rich, project = true) {
  const parts = repos.map((repo, i) => {
    const [owner, name] = repo.slug.split("/");
    const mine = issues.filter((x) => x.repo === repo.slug);
    const issueParts = mine.map((x) => `i${x.number}:issue(number:${x.number}){${ISSUE_FIELDS(rich, project)}}`).join(" ");
    return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ nameWithOwner ${issueParts} open:pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}}} done:pullRequests(states:[MERGED,CLOSED],first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}}} }`;
  });
  return `query { viewer{login} ${parts.join("\n")} }`;
}
function ghQuery(query) {
  // gh exits non-zero on partial errors (e.g. one repo not visible) but still prints the data.
  const done = spawnSync("gh", ["api", "graphql", "-F", "query=@-"], { input: query, encoding: "utf8", timeout: 30000, maxBuffer: 32 << 20, windowsHide: true });
  try {
    return done.stdout ? JSON.parse(done.stdout) : null;
  } catch {
    return null;
  }
}
const lacksProjectScope = (reply) =>
  Boolean(reply && Array.isArray(reply.errors)) && reply.errors.some((e) => e && e.type === "INSUFFICIENT_SCOPES" && /read:project|projectItems/.test(e.message || ""));
function fetchGitHub(repos, issues, query = ghQuery) {
  if (!repos.length) return { data: null, errors: [], notes: [] };
  touched.entries.add(NO_PROJECT_KEY);
  const known = cache.entries[NO_PROJECT_KEY];
  let project = REFRESH || !known || Date.now() - known.at >= NO_PROJECT_TTL;
  // Returns the data, or the raw reply (possibly null) when the query did not give data.
  const attempt = (rich) => {
    const text = buildQuery(repos, issues, rich, project);
    const key = `gh:${crypto.createHash("sha1").update(text).digest("hex")}`;
    touched.entries.add(key);
    const hit = cache.entries[key];
    if (!REFRESH && hit && Date.now() - hit.at < GITHUB_TTL) return { data: hit.value };
    const reply = query(text);
    if (!(reply && reply.data && reply.data.viewer)) return { reply };
    cache.entries[key] = { at: Date.now(), value: reply.data };
    return { data: reply.data };
  };
  let fellBack = false;
  for (const rich of [true, false]) {
    let result = attempt(rich);
    if (!result.data && project && lacksProjectScope(result.reply)) {
      project = false;
      fellBack = true;
      result = attempt(rich);
    }
    if (result.data) {
      if (fellBack) cache.entries[NO_PROJECT_KEY] = { at: Date.now(), value: true };
      else if (project) delete cache.entries[NO_PROJECT_KEY];
      return { data: result.data, errors: [], notes: project ? [] : [NO_PROJECT_NOTE] };
    }
  }
  return { data: null, errors: ["GitHub query failed (gh auth or network)"], notes: [] };
}

const ci = (pr) => {
  const rollup = pr.commits && pr.commits.nodes[0] && pr.commits.nodes[0].commit.statusCheckRollup;
  return rollup ? rollup.state : null;
};
// Whether the open PR is the viewer's (or the repo owner's account) and what is waiting on the viewer.
// "Needs my action" = my open PR with failing CI or changes requested, or an open PR asking me to review.
const slimPr = (pr, viewer, owner) => {
  const asked = Boolean(viewer) && pr.reviewRequests && pr.reviewRequests.nodes.some((n) => n.requestedReviewer && n.requestedReviewer.login === viewer);
  const author = pr.author && pr.author.login;
  const mine = Boolean(author) && (author === viewer || author === owner);
  const state = ci(pr);
  const open = pr.state === "OPEN";
  const needs = open && ((mine && (state === "FAILURE" || state === "ERROR" || pr.reviewDecision === "CHANGES_REQUESTED")) || asked);
  return { number: pr.number, title: pr.title, url: pr.url, draft: pr.isDraft, state: pr.state, branch: pr.headRefName, author, updated: pr.updatedAt, mergedAt: pr.mergedAt, closedAt: pr.closedAt, review: pr.reviewDecision, ci: state, asked, mine, needs };
};

function compose(local, github) {
  const issues = {};
  const reposOut = local.repos.map((repo, i) => {
    const node = github.data && github.data[`r${i}`];
    const viewer = github.data ? github.data.viewer.login : null;
    const owner = repo.slug.split("/")[0];
    const open = node ? node.open.nodes.map((p) => slimPr(p, viewer, owner)) : [];
    const done = node ? node.done.nodes.map((p) => slimPr(p, viewer, owner)) : [];
    if (node) {
      for (const [alias, issue] of Object.entries(node)) {
        if (!/^i\d+$/.test(alias) || !issue) continue;
        const project = (issue.projectItems ? issue.projectItems.nodes : []).map((n) => n.fieldValueByName && n.fieldValueByName.name).find(Boolean);
        issues[`${repo.slug}#${issue.number}`] = {
          title: issue.title, url: issue.url, state: issue.state, closedAt: issue.closedAt, status: project || null, labels: issue.labels.nodes.map((l) => l.name),
          epic: issue.parent ? { number: issue.parent.number, title: issue.parent.title, url: issue.parent.url, done: issue.parent.subIssuesSummary.completed, total: issue.parent.subIssuesSummary.total } : null,
        };
      }
    }
    const worktrees = repo.worktrees.map((wt) => {
      const pr = wt.branch && !wt.main ? open.find((p) => p.branch === wt.branch) || done.find((p) => p.branch === wt.branch) || null : null;
      // Title, state and end time for the dashboard's worktree rows: the PR if there is one, else the issue named by the branch number.
      const issue = !pr && wt.issue && !wt.main ? issues[`${repo.slug}#${wt.issue}`] : null;
      const ref = pr ? { kind: "pr", number: pr.number, title: pr.title, state: pr.state, at: pr.mergedAt || pr.closedAt || pr.updated }
        : issue ? { kind: "issue", number: wt.issue, title: issue.title, state: issue.state, at: issue.closedAt } : null;
      return { ...wt, pr, ref };
    });
    return { slug: repo.slug, root: repo.root, prs: open, worktrees };
  });
  const sessions = local.sessions.map((s) => ({ terminal: s.terminal, name: s.name, label: s.label, parent: s.parent, status: s.status, cwd: s.cwd, last: s.last, issues: mapIssues(s.signals, local.repos) }));
  const attention = reposOut.reduce((n, r) => n + r.prs.filter((p) => p.needs).length, 0);
  return { version: VERSION, at: Date.now(), viewer: github.data ? github.data.viewer.login : null, errors: github.errors, notes: github.notes || [], attention, sessions, issues, repos: reposOut };
}

function collect() {
  const local = cached("local", LOCAL_TTL, collectLocal) || { sessions: [], repos: [] };
  const keys = new Set();
  for (const s of local.sessions) for (const issue of mapIssues(s.signals, local.repos)) keys.add(issue.key);
  // Worktree issue numbers ride in the same query so PR-less worktrees can show an issue title.
  for (const repo of local.repos) for (const wt of repo.worktrees) if (!wt.main && wt.issue) keys.add(`${repo.slug}#${wt.issue}`);
  const issues = [...keys].map((k) => ({ repo: k.split("#")[0], number: Number(k.split("#")[1]) }));
  const github = fetchGitHub(local.repos, issues);
  return compose(local, github);
}

function printMapping(result) {
  for (const s of result.sessions) {
    console.log(`${s.terminal} ${s.name || ""} [${s.label}]`);
    for (const i of s.issues) {
      const info = result.issues[i.key];
      console.log(`    ${i.key} w=${i.weight} ${info ? `${info.state} ${info.status || "-"} ${info.title}` : ""}`);
    }
    if (!s.issues.length) console.log("    (no issues)");
  }
}

function main() {
  const [command, arg] = process.argv.slice(2).filter((a) => a !== "--refresh");
  if (command === "scan") {
    const state = scanTranscript(path.resolve(arg));
    const repos = new Map();
    for (const dir of Object.keys(state.dirs)) {
      let near = dir;
      while (near.length > 1 && !fs.existsSync(near)) near = path.dirname(near);
      const repo = repoOf(near);
      if (repo && !repos.has(repo.root)) repos.set(repo.root, { ...repo, worktrees: worktreesOf(repo) });
    }
    console.log(JSON.stringify({ issues: mapIssues(state, [...repos.values()]), dirs: Object.keys(state.dirs).length, urls: state.urls }, null, 2));
  } else {
    const result = collect();
    if (command === "--debug") printMapping(result);
    else process.stdout.write(JSON.stringify(result));
    pruneCache();
  }
  saveCache();
}

if (require.main === module) main();
else module.exports = { fetchGitHub, compose, cache };
