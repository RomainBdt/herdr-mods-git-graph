// Action execution is separate from the UI so context checks can be tested
// against disposable repositories. exec has Herdr's (program, argv, options) shape.
import { READ, commandsFor, gitError } from "./git.js";
import { inspect } from "./trust.js";

export const UNTRUSTED = "This repository's git config runs commands you haven't allowed. Open it in the graph to see them and allow it.";

export async function executeAction(action, values, ctx, exec) {
  const git = (args) => exec("git", args, { cwd: ctx.root, on: ctx.on });
  const commands = commandsFor(action, values, ctx);
  // Only in a repository the graph could read: one whose config runs no command,
  // or exactly the commands the person allowed (ctx.trusted, see trust.js).
  // Then git runs as in a terminal, hooks and that config included.
  const check = await inspect(git);
  if (check.error || (check.commands.length && check.fingerprint !== ctx.trusted)) return { ok: false, message: check.error ? `Can't check this repository's git config: ${check.error}` : UNTRUSTED };
  // A dialog/menu describes this snapshot, not whatever HEAD happens to be
  // when the user confirms it. Fetch does not operate on the current branch.
  if (action.type !== "fetch") {
    const head = await git([...READ, "rev-parse", "--verify", "-q", "HEAD"]);
    const branch = await git([...READ, "symbolic-ref", "-q", "--short", "HEAD"]);
    // Exit 1 means unborn HEAD or detached HEAD, respectively. Other failures
    // are not empty states and must not authorize a mutation.
    if (![0, 1].includes(head.code) || ![0, 1].includes(branch.code)) {
      return { ok: false, message: "Cannot verify the repository state. Close this action and refresh the graph." };
    }
    const actualHead = head.code === 0 ? head.stdout.trim() : null;
    const actualBranch = branch.code === 0 ? branch.stdout.trim() : null;
    if (actualHead !== ctx.head || actualBranch !== ctx.current) {
      return { ok: false, stale: true, message: "The repository's branch or HEAD changed. Close this action, refresh the graph, and review it again." };
    }
  }
  // Staging everything would mark unresolved conflicts resolved and commit their markers.
  if (action.type === "commit" && values.all) {
    const unmerged = await git([...READ, "ls-files", "--unmerged"]);
    if (unmerged.code !== 0 || unmerged.stdout.trim()) {
      return { ok: false, message: "There are unresolved merge conflicts. Resolve them first, or untick \"Stage every change\" to let git decide." };
    }
  }
  // Git has no transaction spanning these commands and other terminals. This
  // preflight detects an already changed context; it cannot lock out future edits.
  for (const args of commands) {
    const result = await git(args);
    if (result.code !== 0) return { ok: false, message: gitError(result) };
  }
  return { ok: true };
}
