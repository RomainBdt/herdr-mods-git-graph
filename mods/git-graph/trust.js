// A repository's own git config can name commands git runs on its own: a clean
// filter on `git status`, gpg on `git log` (log.showSignature), ssh on a fetch.
// A .git folder from someone else (a zip, a shared drive) brings its config
// along, so the panel reads nothing in a repository whose config names one
// until the person allows it. No herdr imports, so node tests it.
import { READ } from "./git.js";
//
// Only two git calls ever reach a repository before that: `rev-parse
// --show-toplevel` and `config --list`, which read files and run nothing.

// The repository's own config (.git/config and what it includes), one
// NUL-terminated "key\nvalue" record each. --worktree adds config.worktree.
export const CONFIG = ["config", "--local", "--includes", "--list", "-z"];
const WORKTREE_CONFIG = ["config", "--worktree", "--includes", "--list", "-z"];

export function parseConfig(stdout) {
  return stdout.split("\0").filter(Boolean).map((rec) => {
    const nl = rec.indexOf("\n");
    // A bare key (`[core] bare`, no "=") is true and has no value line.
    return nl < 0 ? { key: rec.toLowerCase(), value: null } : { key: rec.slice(0, nl).toLowerCase(), value: rec.slice(nl + 1) };
  });
}

// Keys that name a program git may start. Matched on the lowercased key: git
// keeps a subsection's case (filter.<name>.clean) but not the section's or the key's.
const COMMAND_KEYS = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(textconv|command)$/, /^diff\.external$/,
  /^merge\..+\.driver$/,
  /^core\.(sshcommand|gitproxy|fsmonitor|editor|pager|askpass|alternaterefscommand)$/,
  /^sequence\.editor$/, /^interactive\.difffilter$/, /^pager\./,
  /^gpg\.(.+\.)?program$/, /^gpg\.ssh\.defaultkeycommand$/,
  /^credential\.(.+\.)?helper$/,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/,
  /^uploadpack\.packobjectshook$/,
  /^(difftool|mergetool|man|browser)\..+\.(cmd|path)$/, /^web\.browser$/,
  /^sendemail\.(.+\.)?(smtpserver|tocmd|cccmd|headercmd|sendmailcmd)$/,
  // Anything else that says it holds a command (trailer.<x>.command, hook.<x>.command…).
  /(command|cmd)$/,
];
// No program: git's own builtin (fsmonitor = true), a pager switched on or off, or a reset.
const NO_PROGRAM = /^(|true|false|yes|no|on|off|1|0)$/i;

export function commandsIn(entries) {
  const out = [];
  for (const { key, value } of entries) {
    const v = value ?? "";
    let command = COMMAND_KEYS.some((re) => re.test(key)) && !NO_PROGRAM.test(v.trim());
    // `!cmd` makes `git submodule update` run cmd.
    if (/^submodule\..+\.update$/.test(key)) command = v.trim().startsWith("!");
    // The ext:: transport runs a command as its "remote"; git refuses it unless a protocol policy allows it.
    if (/^protocol\.(.+\.)?allow$/.test(key)) command = v.trim().toLowerCase() !== "never";
    if (/^url\..+\.(insteadof|pushinsteadof)$/.test(key) && /^url\.(ext|fd)::/.test(key)) command = true;
    if (command) out.push(`${key}=${v}`);
  }
  return [...new Set(out)].sort();
}

const truthy = (v) => v === null || /^(true|yes|on|1)$/i.test(v.trim());

// What the repository's config would have git run. git: (args) => exec result,
// in the repository. A config git can't read is never taken as one without commands.
export async function inspect(git) {
  let r;
  try { r = await git(CONFIG); } catch (e) { return { error: String(e?.message ?? e) }; }
  if (r.code !== 0) return { error: (r.stderr || `git config exited with ${r.code}`).trim().split("\n").pop() };
  const entries = parseConfig(r.stdout);
  if (entries.some((e) => e.key === "extensions.worktreeconfig" && truthy(e.value))) {
    let w;
    try { w = await git(WORKTREE_CONFIG); } catch (e) { return { error: String(e?.message ?? e) }; }
    if (w.code !== 0) return { error: (w.stderr || `git config exited with ${w.code}`).trim().split("\n").pop() };
    entries.push(...parseConfig(w.stdout));
  }
  const commands = commandsIn(entries);
  // What the person allows: these exact lines. A new or changed command asks again.
  return { commands, fingerprint: commands.join("\n") };
}

// Where an allowance is kept: the machine and the repository's top folder.
export const trustKey = (on, root) => `${on ?? ""}|${root}`;

// Opens a repository for reading. allowed(key): the fingerprint the person
// allowed there, if any. Returns { root: null } outside a repository,
// { root, key, blocked } when its config names commands not allowed (or can't
// be read), else { root, key, trusted, git } with git running read-only commands.
export async function openRepo(exec, cwd, on, allowed) {
  const plain = (args) => exec("git", args, { cwd, on });
  const [top, check] = await Promise.all([plain(["rev-parse", "--show-toplevel"]), inspect(plain)]);
  if (top.code !== 0) return { root: null };
  const root = top.stdout.trim(), key = trustKey(on, root);
  if (check.error) return { root, key, blocked: { error: check.error, commands: [] } };
  if (check.commands.length && allowed(key) !== check.fingerprint) return { root, key, blocked: check };
  return { root, key, trusted: check.fingerprint, git: (args) => exec("git", [...READ, ...args], { cwd, on }) };
}
