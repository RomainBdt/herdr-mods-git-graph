// A repository's own git config can name commands git runs on its own: a clean
// filter on `git status`, gpg on `git log` (log.showSignature), ssh on a fetch.
// A .git folder from someone else (a zip, a shared drive) brings its config
// along, so the panel reads nothing in a repository whose config names one
// until the person allows it. No herdr imports, so node tests it.
//
// Only two git calls ever reach a repository before that: `rev-parse
// --show-toplevel` and `config --list`, which read files and run nothing.
import { READ } from "./git.js";

// Every config git reads there, each "key\nvalue" record after its scope
// ("system", "global", "local", "worktree"; what a file includes takes that
// file's scope). A missing file is skipped. --show-scope needs git 2.26; older
// gits read .git/config (and config.worktree) by name instead.
export const CONFIG = ["config", "--list", "--show-scope", "--includes", "-z"];
const LOCAL_CONFIG = ["config", "--local", "--includes", "--list", "-z"];
const WORKTREE_CONFIG = ["config", "--worktree", "--includes", "--list", "-z"];
const OWN = ["local", "worktree"];

const entry = (rec) => {
  const nl = rec.indexOf("\n");
  // A bare key (`[core] bare`, no "=") is true and has no value line.
  return nl < 0 ? { key: rec.toLowerCase(), value: null } : { key: rec.slice(0, nl).toLowerCase(), value: rec.slice(nl + 1) };
};
export const parseConfig = (stdout) => stdout.split("\0").filter(Boolean).map(entry);

// --show-scope's output: the repository's own entries only.
export function parseScoped(stdout) {
  const fields = stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (OWN.includes(fields[i])) out.push(entry(fields[i + 1]));
  return out;
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
  // git-lfs (often installed globally) reads these from the repository's config: an
  // extension runs on its clean filter (git status), a custom transfer agent on a transfer.
  /^lfs\.extension\..+\.(clean|smudge)$/, /^lfs\.customtransfer\..+\.path$/,
  /^(difftool|mergetool|man|browser)\..+\.(cmd|path)$/, /^web\.browser$/,
  /^sendemail\.(.+\.)?(smtpserver|tocmd|cccmd|headercmd|sendmailcmd)$/,
  // Anything else that says it holds a command (trailer.<x>.command, hook.<x>.command…).
  /(command|cmd)$/,
];
// No program: an empty value (a reset), or a boolean where git reads one (fsmonitor = true
// is git's builtin, pager.<cmd> switches a pager on or off). Elsewhere `yes` or `true`
// is the program of that name.
const BOOLEAN_KEYS = /^(core\.fsmonitor|pager\..+)$/;
const NO_PROGRAM = /^(true|false|yes|no|on|off|1|0)$/i;
const noProgram = (key, v) => v === "" || (BOOLEAN_KEYS.test(key) && NO_PROGRAM.test(v));

export function commandsIn(entries) {
  const out = [];
  for (const { key, value } of entries) {
    const v = value ?? "";
    let command = COMMAND_KEYS.some((re) => re.test(key)) && !noProgram(key, v.trim());
    // `!cmd` makes `git submodule update` run cmd.
    if (/^submodule\..+\.update$/.test(key)) command = v.trim().startsWith("!");
    // The ext:: transport runs a command as its "remote"; git refuses it unless a protocol policy allows it.
    if (/^protocol\.(.+\.)?allow$/.test(key)) command = v.trim().toLowerCase() !== "never";
    if (/^url\..+\.(insteadof|pushinsteadof)$/.test(key) && /^url\.(ext|fd)::/.test(key)) command = true;
    // An ext:: remote itself: a global or system protocol policy may allow it, and that's never checked here.
    if (/^remote\..+\.(url|pushurl)$/.test(key) && /^\s*ext::/i.test(v)) command = true;
    // Checkout, merge and pull then run git in each submodule, with its own config, never checked.
    if (key === "submodule.recurse") command = truthy(value);
    if (command) out.push(`${key}=${v}`);
  }
  return [...new Set(out)].sort();
}

const truthy = (v) => v === null || /^(true|yes|on|1)$/i.test(v.trim());

// What the repository's config would have git run. git: (args) => exec result,
// in the repository. A config git can't read is never taken as one without commands.
const failure = (r) => ({ error: (r.stderr || `git config exited with ${r.code}`).trim().split("\n").pop() });
export async function inspect(git) {
  let entries;
  try {
    const r = await git(CONFIG);
    if (r.code === 0) entries = parseScoped(r.stdout);
    else if (r.code !== 129) return failure(r);
    else {
      // An unknown option: a git older than 2.26.
      const l = await git(LOCAL_CONFIG);
      if (l.code !== 0) return failure(l);
      entries = parseConfig(l.stdout);
      if (entries.some((e) => e.key === "extensions.worktreeconfig" && truthy(e.value))) {
        const w = await git(WORKTREE_CONFIG);
        if (w.code !== 0) return failure(w);
        entries.push(...parseConfig(w.stdout));
      }
    }
  } catch (e) { return { error: String(e?.message ?? e) }; }
  const commands = commandsIn(entries);
  // What the person allows: these exact lines. A new or changed command asks again.
  // JSON keeps a value holding a newline from reading as two lines; none is "".
  return { commands, fingerprint: commands.length ? JSON.stringify(commands) : "" };
}

// Where an allowance is kept: the machine and the repository's top folder.
export const trustKey = (on, root) => `${on ?? ""}|${root}`;

// Opens a repository for reading. allowed(key): the fingerprint the person
// allowed there, if any. Returns { root: null, error } outside a repository,
// { root, key, blocked } when its config names commands not allowed (or can't
// be read), else { root, key, trusted, git } with git running read-only commands.
export async function openRepo(exec, cwd, on, allowed) {
  const plain = (args) => exec("git", args, { cwd, on });
  const [top, check] = await Promise.all([plain(["rev-parse", "--show-toplevel"]), inspect(plain)]);
  // error: git's last line (dubious ownership, a folder it can't read…), for a Manygit row.
  if (top.code !== 0) return { root: null, error: (top.stderr ?? "").trim().split("\n").pop() || null };
  const root = top.stdout.trim(), key = trustKey(on, root);
  if (check.error) return { root, key, blocked: { error: check.error, commands: [] } };
  if (check.commands.length && allowed(key) !== check.fingerprint) return { root, key, blocked: check };
  return { root, key, trusted: check.fingerprint, git: (args) => exec("git", [...READ, ...args], { cwd, on }) };
}
