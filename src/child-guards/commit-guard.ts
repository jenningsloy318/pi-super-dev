/**
 * v0.3.74 P2-e — commit guard (M7 root, P4 mechanical prevention).
 *
 * Run 2026-09-05T23-09-55-596Z: the implementer committed GREEN work itself
 * (2e92da3) and pre-landed phase-5 production code (5d4790d) BEFORE its RED
 * ran. v0.3.73 made that DETECTED (advisory log + HEAD-drift finding), but
 * detection still pays the RED cycle. pi exposes `pi.on("tool_call")` with
 * `{ block: true, reason }` (docs/extensions.md) and pi-subagents loads
 * agent-declared extension paths into the child, so the git-commit class is
 * now BLOCKED for the writer agents at the tool layer.
 *
 * SELF-CONTAINED BY CONTRACT: ZERO imports — this file loads standalone in the
 * child pi process via jiti (pinned by tests/commit-guard.test.ts). Fail-open
 * by design: if the guard is absent or fails to load, the v0.3.73 detective
 * HEAD-drift net still catches the drift honestly.
 */

/** Segment-level classifier: TRUE when one shell segment invokes git with an
 *  ENGINE-OWNED verb — commit/merge/rebase/cherry-pick/stash/revert/pull/push/am,
 *  every verb class that CREATES or MOVES commits. Read-only shapes are
 *  exempt (v0.3.74 dual review CR-F2): `git merge-base …` (the (?![\w-])
 *  terminator fails on the hyphenated subcommand), `git stash list/show/clear`
 *  (explicit negative lookahead), and flag VALUES (`git log --grep commit`).
 *  Flags and their values may sit between `git` and the verb (`git -c
 *  user.email=x@y commit`, `git -C /repo commit`, `git --git-dir=/x commit`);
 *  env-var assignment prefixes (`GIT_DIR=/x git commit`) and sudo/env
 *  prefixes are stripped first; command chaining is split first so
 *  `cd /r && git commit` and `npm test && git commit` match while
 *  `echo git commit` (git not the segment's command word) does not; quotes
 *  around the verb (`git "commit"`) are tolerated.
 *  Documented fail-open residuals (covered by the v0.3.73 HEAD-drift
 *  detective net): command substitution `$(git commit …)`, `xargs git
 *  commit`, nested-shell quoting — nonsense or contrived shapes for a
 *  writer child, caught honestly if they ever occur. */
export function isCommitClassGitCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	const segments = command.split(/\|\||&&|;|\||\n/);
	for (const rawSeg of segments) {
		const seg = rawSeg.trim().replace(/^(?:sudo\s+|env\s+\S+\s+|[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
		if (/^git\s+(?:-{1,2}[\w.-]+(?:[=\s]"?[^\s"&|;]+"?)?\s+)*["']?(?:commit|merge|rebase|cherry-pick|stash(?!\s+(?:list|show|clear)\b)|revert|pull|push|am)["']?(?![\w-])/i.test(seg)) {
			return true;
		}
	}
	return false;
}

const BLOCK_REASON =
	"Commits are engine-owned in pi-super-dev: the pipeline commits deterministically after the build and deliverable gates pass. Do not run git commit/merge/rebase/cherry-pick/stash/revert/pull/am — edit the files and report them in your structured control (filesCreated/filesModified/filesDeleted) instead.";

/** pi extension entry — registered for the writer agents via
 *  subagentOnlyExtensions (register-agents.ts; dual review F2: child-only
 *  loading that keeps the child's ambient extension discovery intact).
 *  Kill switch: SUPER_DEV_NO_COMMIT_GUARD=1. */
export default function commitGuardExtension(pi: {
	on(event: "tool_call", handler: (event: { toolName: string; input: { command?: string } }) => Promise<{ block: true; reason: string } | undefined>): void;
}): void {
	pi.on("tool_call", async (event) => {
		const command = event?.input?.command;
		if (event?.toolName !== "bash" || typeof command !== "string") return undefined;
		if (!isCommitClassGitCommand(command)) return undefined;
		return { block: true, reason: BLOCK_REASON };
	});
}
