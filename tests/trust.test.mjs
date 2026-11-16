// Trap repositories: a repository's own git config names a command that leaves a
// marker file when it runs. The panel's reads (read.js), Fetch all and the menu
// actions (execute.js) must never run it before the repository is allowed, and
// read it as before once it is. Each trap is also shown to fire with plain git,
// so a marker that stays absent means the panel didn't run it.
// Run: node tests/trust.test.mjs (graph.test.mjs runs it too).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ, diffArgs, fileArgs, commandsFor } from "../mods/git-graph/git.js";
import { FETCH, NO_HOOKS } from "../mods/git-graph/repos.js";
import { readFolder, readFiles, readRepo, fetchRepo } from "../mods/git-graph/read.js";
import { parseConfig, commandsIn, inspect, trustKey } from "../mods/git-graph/trust.js";
import { executeAction, UNTRUSTED } from "../mods/git-graph/execute.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t", GIT_TERMINAL_PROMPT: "0" };
const base = mkdtempSync(join(tmpdir(), "herdr-git-trust-"));
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const plain = (cwd, args) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
// Herdr's exec, as node runs it. "env" (Fetch all) sets its leading NAME=value pairs itself.
const calls = [];
const exec = async (program, args, { cwd } = {}) => {
  let extra = {};
  if (program === "env") {
    const i = args.findIndex((a) => !/^[A-Z_][A-Z0-9_]*=/.test(a));
    extra = Object.fromEntries(args.slice(0, i).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
    [program, ...args] = args.slice(i);
  }
  calls.push([program, ...args]);
  const r = spawnSync(program, args, { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const nobody = () => undefined;
const opts = { all: true, remotes: true, limit: 300 };
let n = 0;
const repoAt = (name) => { const d = join(base, name); sh(base, "init", "-q", "-b", "main", d); return d; };
const commit = (cwd, file, text = file) => { writeFileSync(join(cwd, file), text); sh(cwd, "add", "."); sh(cwd, "commit", "-qm", file); };
// A marker, and a shell command that leaves it (then passes its input through, as a filter must).
const trap = (name) => { const marker = join(base, `${name}-ran`); return { marker, cmd: `sh -c 'touch "${marker}"; cat'`, ran: () => existsSync(marker), clear: () => rmSync(marker, { force: true }) }; };
// Same size, new stat: git has to read the file again, so a clean filter runs.
const touch = (file) => { const t = new Date(Date.now() + 5000 + ++n * 1000); utimesSync(file, t, t); };
const ctxOf = (root, trusted) => ({ root, on: null, trusted, remotes: [], branches: [],
  head: plain(root, ["rev-parse", "HEAD"]).stdout.trim(), current: plain(root, ["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim() || null });

try {
  // ---- which config lines name a command
  {
    const entries = parseConfig("core.bare\0core.sshCommand\nssh -i ~/.ssh/work\0Filter.LFS.clean\ngit-lfs clean -- %f\0core.fsmonitor\ntrue\0"
      + "color.pager\nfalse\0core.pager\nless -R\0protocol.ext.allow\nalways\0protocol.file.allow\nnever\0submodule.s.update\n!rm -rf .\0"
      + "submodule.t.update\ncheckout\0remote.origin.url\nhttps://example.com/x.git\0remote.origin.uploadpack\n/tmp/evil\0diff.pdf.textconv\npdftotext\0"
      + "trailer.sign.command\necho hi\0credential.helper\n\0user.name\nMe\0submodule.recurse\ntrue\0");
    assert.deepEqual(entries[0], { key: "core.bare", value: null }, "a bare key has no value");
    assert.deepEqual(commandsIn(entries), ["core.pager=less -R", "core.sshcommand=ssh -i ~/.ssh/work", "diff.pdf.textconv=pdftotext",
      "filter.lfs.clean=git-lfs clean -- %f", "protocol.ext.allow=always", "remote.origin.uploadpack=/tmp/evil",
      "submodule.recurse=true", "submodule.s.update=!rm -rf .", "trailer.sign.command=echo hi"]);
    assert.deepEqual(commandsIn(parseConfig("submodule.recurse\nfalse\0")), []);
    // Only ext:: runs a command: another protocol's policy (a submodule setup's file) is no reason to ask.
    assert.deepEqual(commandsIn(parseConfig("protocol.file.allow\nalways\0protocol.https.allow\nuser\0protocol.ext.allow\nnever\0")), []);
    assert.deepEqual(commandsIn(parseConfig("protocol.allow\nalways\0")), ["protocol.allow=always"], "protocol.allow is ext's default");
    assert.deepEqual(commandsIn(parseConfig("protocol.allow\nnever\0Protocol.EXT.allow\nuser\0")), ["protocol.ext.allow=user"]);
    // A boolean is no program only where git reads one; elsewhere `yes` is the program.
    assert.deepEqual(commandsIn(parseConfig("filter.x.clean\nyes\0pager.log\nfalse\0core.fsmonitor\nfalse\0lfs.extension.foo.clean\nfoo %f\0"
      + "lfs.customtransfer.t.path\n/tmp/agent\0remote.origin.url\next::sh -c evil\0remote.o2.url\nhttps://example.com/x.git\0")),
      ["filter.x.clean=yes", "lfs.customtransfer.t.path=/tmp/agent", "lfs.extension.foo.clean=foo %f", "remote.origin.url=ext::sh -c evil"]);
    // A value holding a newline never reads as two allowed lines.
    const one = await inspect(async () => ({ code: 0, stdout: "local\0core.sshcommand\na\ncore.pager=b\0" }));
    const two = await inspect(async () => ({ code: 0, stdout: "local\0core.sshcommand\na\0local\0core.pager\nb\0" }));
    assert.notEqual(one.fingerprint, two.fingerprint);
    console.log("config lines ok");
  }

  // ---- a normal repository: nothing to allow, read as before
  const normal = repoAt("normal");
  commit(normal, "a.txt");
  {
    const check = await inspect((args) => exec("git", args, { cwd: normal }));
    assert.deepEqual(check.commands, [], "a fresh repository's config names no command");
    const read = await readFolder(exec, normal, null, opts, nobody);
    assert.equal(read.state, undefined); assert.equal(read.base.length, 1); assert.equal(read.trusted, "");
    writeFileSync(join(normal, "a.txt"), "changed");
    assert.deepEqual((await readFiles(exec, normal, null, nobody)).files.map((f) => f.path), ["a.txt"]);
    const st = await readRepo(exec, normal, null, false, nobody);
    assert.equal(st.branch, "main"); assert.equal(st.dirty, 1); assert.equal(st.untrusted, undefined);
    sh(normal, "checkout", "-q", "a.txt");
    assert.equal((await executeAction({ type: "fetch" }, {}, { root: normal, on: null, remotes: [] }, exec)).ok, true, "a normal repository's actions run");
    console.log("normal repository ok");
  }

  // ---- a clean filter in .git/config
  {
    const t = trap("filter"), repo = repoAt("filter");
    commit(repo, "a.txt"); writeFileSync(join(repo, ".gitattributes"), "*.txt filter=trap\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "attrs");
    sh(repo, "config", "filter.trap.clean", t.cmd);
    touch(join(repo, "a.txt"));
    plain(repo, [...READ, "status", "--porcelain"]);
    assert.ok(t.ran(), "the trap is armed: plain git status runs it"); t.clear(); touch(join(repo, "a.txt"));

    calls.length = 0;
    const read = await readFolder(exec, repo, null, opts, nobody);
    assert.equal(read.state, "untrusted");
    assert.deepEqual(read.blocked.commands, [`filter.trap.clean=${t.cmd}`], "the warning lists the command");
    await readFolder(exec, repo, null, { ...opts, status: false }, nobody); // read ahead
    assert.equal(await readFiles(exec, repo, null, nobody), null);
    assert.deepEqual(await readRepo(exec, repo, null, true, nobody), { untrusted: true, trustKey: read.trustKey });
    const fetched = await fetchRepo(exec, repo, null, nobody);
    assert.equal(fetched.skipped, true);
    const refused = await executeAction({ type: "commit" }, { message: "x", all: true }, ctxOf(repo, undefined), exec);
    assert.equal(refused.message, UNTRUSTED);
    assert.equal(plain(repo, ["log", "--format=%s", "-1"]).stdout.trim(), "attrs", "nothing was committed");
    assert.ok(!t.ran(), "the filter never ran before the repository was allowed");
    // Before it's allowed, git only ever hears rev-parse and config there.
    assert.deepEqual([...new Set(calls.filter((c) => c[0] === "git").map((c) => c.slice(1).find((a) => !a.startsWith("-") && !a.includes("="))))].sort(), ["config", "rev-parse"]);

    // Allowed: exactly these commands, under this repository's key.
    assert.equal(read.trustKey, trustKey(null, read.root));
    const allowed = (key) => (key === read.trustKey ? read.blocked.fingerprint : undefined);
    const ok = await readFolder(exec, repo, null, opts, allowed);
    assert.equal(ok.state, undefined); assert.equal(ok.trusted, read.blocked.fingerprint);
    assert.ok(t.ran(), "once allowed, the repository is read as before (its filter included)"); t.clear();
    assert.equal((await readRepo(exec, repo, null, false, allowed)).trusted, read.blocked.fingerprint);
    writeFileSync(join(repo, "b.txt"), "b");
    assert.equal((await executeAction({ type: "commit" }, { message: "allowed", all: true }, ctxOf(repo, ok.trusted), exec)).ok, true, "actions run once allowed");
    // A changed command asks again.
    sh(repo, "config", "filter.trap.smudge", "cat");
    assert.equal((await readFolder(exec, repo, null, opts, allowed)).state, "untrusted", "a new command asks again");
    assert.equal((await executeAction({ type: "commit" }, { message: "y", all: true }, ctxOf(repo, ok.trusted), exec)).message, UNTRUSTED);
    console.log("filter trap ok");
  }

  // ---- a filter brought in by include.path, and one in config.worktree
  {
    const t = trap("include"), repo = repoAt("include");
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=trap\n"); commit(repo, "a.txt");
    const inc = join(base, "evil.inc");
    sh(base, "config", "--file", inc, "filter.trap.clean", t.cmd);
    sh(repo, "config", "include.path", inc.replace(/\\/g, "/"));
    touch(join(repo, "a.txt"));
    plain(repo, [...READ, "status", "--porcelain"]);
    assert.ok(t.ran(), "the included trap is armed"); t.clear(); touch(join(repo, "a.txt"));
    const read = await readFolder(exec, repo, null, opts, nobody);
    assert.equal(read.state, "untrusted"); assert.equal(read.blocked.commands.length, 1);
    assert.equal((await readRepo(exec, repo, null, false, nobody)).untrusted, true);
    assert.ok(!t.ran(), "an included filter never runs before it's allowed");

    const w = trap("worktree"), wt = repoAt("worktree-config");
    writeFileSync(join(wt, ".gitattributes"), "*.txt filter=trap\n"); commit(wt, "a.txt");
    sh(wt, "config", "core.repositoryformatversion", "1"); sh(wt, "config", "extensions.worktreeConfig", "true");
    // With the extension on and no config.worktree yet (a new linked worktree, sparse checkout):
    // no command, not an error.
    const linked = join(base, "linked");
    sh(wt, "worktree", "add", "-q", linked.replace(/\\/g, "/"));
    for (const dir of [wt, linked]) {
      const r = await readFolder(exec, dir, null, opts, nobody);
      assert.equal(r.state, undefined, r.blocked?.error); assert.equal(r.trusted, "");
    }
    sh(wt, "config", "--worktree", "filter.trap.clean", w.cmd);
    touch(join(wt, "a.txt"));
    assert.equal((await readFolder(exec, wt, null, opts, nobody)).state, "untrusted", "config.worktree is checked too");
    assert.equal((await readFolder(exec, linked, null, opts, nobody)).state, undefined, "another worktree's config.worktree isn't this one's");
    assert.ok(!w.ran());
    console.log("include and worktree config ok");
  }

  // ---- a filter in a submodule's own config: the parent's reads never look inside it
  {
    const t = trap("submodule"), lib = repoAt("lib"), parent = repoAt("parent");
    writeFileSync(join(lib, ".gitattributes"), "*.txt filter=trap\n"); commit(lib, "l.txt");
    commit(parent, "p.txt");
    sh(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.replace(/\\/g, "/"), "sub"); sh(parent, "commit", "-qm", "sub");
    sh(join(parent, "sub"), "config", "filter.trap.clean", t.cmd);
    touch(join(parent, "sub", "l.txt"));
    plain(parent, [...READ, "status", "--porcelain"]);
    assert.ok(t.ran(), "the submodule trap is armed: plain git status in the parent runs it"); t.clear(); touch(join(parent, "sub", "l.txt"));
    const read = await readFolder(exec, parent, null, opts, nobody);
    assert.equal(read.state, undefined, "the parent's own config is clean");
    await readRepo(exec, parent, null, true, nobody);
    await readFiles(exec, parent, null, nobody);
    plain(parent, [...READ, ...diffArgs({ uncommitted: true }, "sub")]);
    plain(parent, [...READ, "diff", "--no-renames", "--no-ext-diff", "--ignore-submodules=dirty", "--numstat", "HEAD"]);
    assert.ok(!t.ran(), "the parent's reads run no git inside a submodule");
    // A commit's diff of the submodule: the parent's diff.submodule=diff would run git diff inside it,
    // with the submodule's own diff.external.
    const ext = trap("submodule-diff"), extScript = join(base, "ext-trap.sh");
    writeFileSync(extScript, `#!/bin/sh\ntouch "${ext.marker}"\n`); chmodSync(extScript, 0o755);
    commit(join(parent, "sub"), "l2.txt"); sh(parent, "add", "sub"); sh(parent, "commit", "-qm", "bump sub");
    commit(join(parent, "sub"), "l3.txt");
    sh(parent, "config", "diff.submodule", "diff"); sh(join(parent, "sub"), "config", "diff.external", extScript.replace(/\\/g, "/"));
    assert.equal((await readFolder(exec, parent, null, opts, nobody)).state, undefined);
    const bump = { hash: plain(parent, ["rev-parse", "HEAD"]).stdout.trim(), parents: [plain(parent, ["rev-parse", "HEAD~1"]).stdout.trim()] };
    plain(parent, ["diff", bump.parents[0], bump.hash, "--", "sub"]);
    assert.ok(ext.ran(), "the submodule diff trap is armed"); ext.clear();
    for (const args of [diffArgs(bump, "sub"), fileArgs(bump).status, fileArgs(bump).numstat, diffArgs({ uncommitted: true }, "sub")]) plain(parent, [...READ, ...args]);
    assert.ok(!ext.ran(), "a commit's diff never runs git inside a submodule");
    // Actions don't fetch submodules either.
    assert.ok(commandsFor({ type: "fetch" })[0].includes("--no-recurse-submodules"));
    assert.ok(commandsFor({ type: "pull", upstream: "origin/main" })[0].includes("--no-recurse-submodules"));
    console.log("submodule trap ok");
  }

  // ---- gpg.program with log.showSignature, on a signed commit
  {
    const t = trap("gpg"), repo = repoAt("gpg");
    commit(repo, "a.txt");
    const gpg = join(base, "gpg-trap.sh");
    writeFileSync(gpg, `#!/bin/sh\ntouch "${t.marker}"\nexit 1\n`); chmodSync(gpg, 0o755);
    const head = plain(repo, ["rev-parse", "HEAD"]).stdout.trim(), tree = plain(repo, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    const raw = join(base, "signed.txt");
    writeFileSync(raw, `tree ${tree}\nparent ${head}\nauthor T <t@t> 1700000000 +0000\ncommitter T <t@t> 1700000000 +0000\n`
      + "gpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n");
    sh(repo, "update-ref", "refs/heads/main", sh(repo, "hash-object", "-t", "commit", "-w", raw.replace(/\\/g, "/")).trim());
    sh(repo, "config", "log.showSignature", "true"); sh(repo, "config", "gpg.program", gpg.replace(/\\/g, "/"));
    plain(repo, ["log", "-1"]);
    assert.ok(t.ran(), "the gpg trap is armed: plain git log runs it"); t.clear();
    const read = await readFolder(exec, repo, null, opts, nobody);
    assert.equal(read.state, "untrusted");
    await readFolder(exec, repo, null, { ...opts, status: false }, nobody);
    assert.ok(!t.ran(), "gpg never runs before it's allowed");
    // Allowed, the graph's reads still check no signature (READ turns log.showSignature off).
    const ok = await readFolder(exec, repo, null, opts, () => read.blocked.fingerprint);
    assert.equal(ok.base[0].subject, "signed");
    assert.ok(!t.ran(), "nor after");
    console.log("gpg trap ok");
  }

  // ---- core.sshCommand (a work key): Fetch all and Fetch need the same one-time OK
  {
    const t = trap("ssh"), repo = repoAt("ssh");
    commit(repo, "a.txt");
    sh(repo, "remote", "add", "origin", "ssh://git@example.invalid/owner/repo.git");
    sh(repo, "config", "core.sshCommand", `sh -c 'touch "${t.marker}"; exit 1'`);
    const st = await readRepo(exec, repo, null, false, nobody);
    assert.equal(st.untrusted, true);
    const skipped = await fetchRepo(exec, repo, null, nobody);
    assert.equal(skipped.skipped, true); assert.notEqual(skipped.code, 0);
    assert.deepEqual(await readRepo(exec, repo, null, false, nobody, skipped.repo), st, "a skipped row reads as not allowed");
    assert.equal((await executeAction({ type: "fetch" }, {}, ctxOf(repo, undefined), exec)).message, UNTRUSTED);
    assert.ok(!t.ran(), "ssh never runs before it's allowed");
    const read = await readFolder(exec, repo, null, opts, nobody), allowed = () => read.blocked.fingerprint;
    assert.deepEqual(read.blocked.commands, [`core.sshcommand=sh -c 'touch "${t.marker}"; exit 1'`]);
    const fetched = await fetchRepo(exec, repo, null, allowed);
    assert.notEqual(fetched.code, 0); assert.equal(fetched.skipped, undefined);
    assert.ok(t.ran(), "once allowed, its ssh command runs (Fetch all)"); t.clear();
    await executeAction({ type: "fetch" }, {}, ctxOf(repo, read.blocked.fingerprint), exec);
    assert.ok(t.ran(), "and for the Fetch button");
    console.log("sshCommand trap ok");
  }

  // ---- Fetch all runs no hook, in a repository whose config is clean
  {
    const t = trap("hook"), remote = repoAt("hook-remote");
    commit(remote, "a.txt");
    const repo = join(base, "hook");
    sh(base, "clone", "-q", remote.replace(/\\/g, "/"), repo);
    commit(remote, "b.txt");
    const hook = join(repo, ".git", "hooks", "reference-transaction");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch "${t.marker}"\n`); chmodSync(hook, 0o755);
    const out = await fetchRepo(exec, repo, null, nobody);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(plain(repo, ["rev-parse", "origin/main"]).stdout.trim(), plain(remote, ["rev-parse", "HEAD"]).stdout.trim(), "it fetched");
    assert.ok(!t.ran(), "Fetch all runs no hook");
    // The row's status right after reuses the fetch's check: no second config read.
    calls.length = 0;
    const st = await readRepo(exec, repo, null, false, nobody, out.repo);
    assert.ok(!calls.some((c) => c.includes("config") || c.includes("--show-toplevel")), "checked once per fetch");
    assert.deepEqual(st, await readRepo(exec, repo, null, false, nobody));
    assert.ok(FETCH.includes(NO_HOOKS) && FETCH.includes("--no-recurse-submodules"));
    commit(remote, "c.txt");
    plain(repo, ["fetch", "-q"]);
    assert.ok(t.ran(), "the hook trap is armed: plain git fetch runs it");
    console.log("fetch hook ok");
  }

  // ---- a config git can't read is never taken as clean; a missing one has no command
  {
    const repo = repoAt("noconfig");
    commit(repo, "a.txt");
    renameSync(join(repo, ".git", "config"), join(repo, ".git", "config.away"));
    assert.equal((await readFolder(exec, repo, null, opts, nobody)).state, undefined, "no .git/config: nothing to allow");
    renameSync(join(repo, ".git", "config.away"), join(repo, ".git", "config"));
    // A config git fails to read (a broken include, an unreadable file): as git would answer.
    const failing = async (program, args, o) => (args.includes("--show-scope") ? { code: 128, stdout: "", stderr: "fatal: bad config line 3" } : exec(program, args, o));
    const read = await readFolder(failing, repo, null, opts, nobody);
    assert.equal(read.state, "untrusted"); assert.equal(read.blocked.error, "fatal: bad config line 3", "it says why");
    assert.ok((await readRepo(failing, repo, null, false, nobody)).error);
    assert.ok(!(await executeAction({ type: "fetch" }, {}, { root: repo, on: null, remotes: [] }, failing)).ok);
    // A git older than 2.26 (no --show-scope) reads .git/config by name.
    sh(repo, "config", "core.sshCommand", "ssh -i key");
    const old = async (program, args, o) => (args.includes("--show-scope") ? { code: 129, stdout: "", stderr: "error: unknown option `show-scope'" } : exec(program, args, o));
    assert.deepEqual((await inspect((args) => old("git", args, { cwd: repo }))).commands, ["core.sshcommand=ssh -i key"]);
    console.log("unreadable config ok");
  }
  // Outside a repository, nothing is read.
  mkdirSync(join(base, "plain"));
  assert.equal((await readFolder(exec, join(base, "plain"), null, opts, nobody)).state, "norepo");
  console.log("trust ok");
} finally {
  rmSync(base, { recursive: true, force: true });
}
