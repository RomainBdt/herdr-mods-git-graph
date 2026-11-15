// Every read the panel makes of a repository on its own, with no herdr imports:
// graph.js passes Herdr's exec, the tests node's. Each one opens the repository
// through trust.js first, so a config that names commands not allowed yet stops
// it before git reads anything there. allowed(key): the fingerprint the person
// allowed for that repository, if any.
import { STATUS, logArgs, parseLog, parseStatus } from "./git.js";
import { REPO_STATUS, LATEST_TAG, FETCH, parseRepoStatus } from "./repos.js";
import { openRepo } from "./trust.js";

export const scopeOf = ({ all, remotes }) => `${all} ${remotes}`;

// Everything the table shows for a folder, in one round of git calls: each
// answers from any subfolder, and status names paths from the repository root.
// status: false leaves the working tree unread (a folder read ahead).
// state: "norepo" outside a repository, "untrusted" when its config names
// commands not allowed yet (blocked says which), else the table's data.
export async function readFolder(exec, cwd, on, { all, remotes, limit, status: withStatus = true }, allowed) {
  const repo = await openRepo(exec, cwd, on, allowed);
  if (!repo.root) return { state: "norepo", cwd, on };
  if (repo.blocked) return { state: "untrusted", root: repo.root, trustKey: repo.key, blocked: repo.blocked, cwd, on };
  const { git } = repo;
  const [log, head, current, branches, remoteNames, status] = await Promise.all([
    // One commit past the page says whether there are more, as Git Graph asks.
    git(logArgs({ all, remotes, limit: limit + 1 })),
    git(["rev-parse", "--verify", "-q", "HEAD"]), git(["symbolic-ref", "-q", "--short", "HEAD"]),
    git(["for-each-ref", "--format=%(refname)", "refs/heads"]), git(["remote"]), withStatus ? git(STATUS) : null]);
  // A log that fails without a HEAD is a repository with no commits yet.
  if (log.code !== 0 && head.code === 0) throw new Error(log.stderr.trim());
  const base = log.code === 0 ? parseLog(log.stdout) : [];
  return {
    root: repo.root, trustKey: repo.key, trusted: repo.trusted, blocked: null, on, cwd, base: base.slice(0, limit), limit, hasMore: base.length > limit,
    head: head.code === 0 ? head.stdout.trim() : null, current: current.code === 0 ? current.stdout.trim() : null,
    branches: branches.stdout.split("\n").filter(Boolean).map((r) => r.replace(/^refs\/heads\//, "")),
    remoteNames: remoteNames.stdout.split("\n").filter(Boolean),
    files: status?.code === 0 ? parseStatus(status.stdout) : [],
    signature: [log.stdout, head.stdout, current.stdout, branches.stdout, remoteNames.stdout].join("\0"), scope: scopeOf({ all, remotes }),
  };
}

// The uncommitted files alone (a working tree edit), or null when the
// repository can't be read as before (not one any more, or not allowed now).
export async function readFiles(exec, cwd, on, allowed) {
  const repo = await openRepo(exec, cwd, on, allowed);
  if (!repo.git) return null;
  const status = await repo.git(STATUS);
  return status.code === 0 ? parseStatus(status.stdout) : [];
}

// A Manygit row's status: one git call (with the newest tag beside it when tags
// show), and `git remote` only when the branch has no upstream.
export async function readRepo(exec, path, on, tags, allowed) {
  const repo = await openRepo(exec, path, on, allowed);
  if (!repo.root) return { error: "not a git repository" };
  if (repo.blocked) return repo.blocked.error ? { error: repo.blocked.error } : { untrusted: true, trustKey: repo.key };
  const { git } = repo, plain = (args) => exec("git", args, { cwd: path, on });
  // These two carry READ already.
  const [r, tag] = await Promise.all([plain(REPO_STATUS), tags ? plain(LATEST_TAG) : null]);
  if (r.code !== 0) return { error: (r.stderr || "git status failed").trim().split("\n").pop() };
  const st = parseRepoStatus(r.stdout);
  st.trusted = repo.trusted;
  if (tag?.code === 0 && tag.stdout.trim()) st.tag = tag.stdout.trim();
  if (!st.upstream) st.hasRemote = Boolean((await git(["remote"])).stdout.trim());
  return st;
}

// One repository's part of Fetch all, checked again right before it runs.
// skipped: its config names commands not allowed yet, so nothing ran.
export async function fetchRepo(exec, path, on, allowed) {
  const repo = await openRepo(exec, path, on, allowed);
  if (!repo.git) return { code: 1, skipped: Boolean(repo.blocked && !repo.blocked.error),
    stderr: repo.blocked?.error ?? (repo.blocked ? "Not fetched: its git config runs commands. Open it to allow it." : "not a git repository") };
  return exec("env", FETCH, { cwd: path, on });
}
