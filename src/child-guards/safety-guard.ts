/**
 * v0.3.86 F-13 — safety guard (child extension; commit-guard's sibling).
 *
 * `src/safety.ts`'s denylist + protected-file rules were DORMANT in
 * production: `createSafetyExtensionFactory` is only loaded by the bench
 * harness, while delegated subagents (the real pipeline path) ran with only
 * the commit guard. This child extension carries the SAME battle-tested rules
 * into every delegated child via `subagentOnlyExtensions` (register-agents.ts)
 * — hard `pi.on("tool_call")` interception of dangerous bash commands and
 * protected-file writes, bound to that child session.
 *
 * SINGLE SOURCE OF TRUTH: the pattern tables and the check* functions live
 * HERE; `src/safety.ts` re-exports them for host-side consumers (lifecycle.ts
 * service bringup, the bench session agent) so the tables can never drift
 * between host and child.
 *
 * SELF-CONTAINED like commit-guard, with one documented deviation: node:
 * BUILTIN imports are allowed (existsSync for the existing-secret-file check).
 * commit-guard's zero-import contract guards against REPO-RELATIVE imports —
 * those may not resolve under the child's jiti loader — and node: builtins
 * resolve everywhere. No relative imports, ever (pinned by
 * tests/safety-guard.test.ts).
 *
 * Legitimate-flow audit (F-13): the denylist blocks only destructive shapes
 * (rm -rf / ~ .. . *, git reset --hard / push --force / clean -fd /
 * branch -D, DROP/TRUNCATE/DELETE-without-WHERE, curl|sh, env→network
 * exfiltration, chmod 777/+s, kubectl delete, unpublish/yank, mkfs/dd/raw
 * devices). Standard agent work — build/test/lint, git status/diff/log/add,
 * scoped rm -rf <subdir> — passes; the harness's own restore/clean invocations
 * run host-side and never see this hook. Protected writes block OVERWRITES of
 * existing secret files and anything under .git/, secrets/, credentials/, or
 * outside the child cwd; creates and .env.example stay allowed (greenfield
 * scaffolding).
 *
 * Kill switch: SUPER_DEV_NO_SAFETY_GUARD=1 (checked host-side at registration,
 * the commit-guard precedent). Fail-open by design: if the guard is absent or
 * fails to load, the deterministic gates and the denylist at service bringup
 * remain.
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface CheckResult {
	blocked: boolean;
	reason?: string;
}

/** Dangerous command patterns — ported verbatim from the original
 *  block-dangerous.mjs (host twin: src/safety.ts re-exports from here). */
const DANGEROUS: ReadonlyArray<readonly [RegExp, string]> = [
	[/rm\s+-rf\s+\/(?!\w)/, "rm -rf /"],
	[/rm\s+-rf\s+~/, "rm -rf ~"],
	[/rm\s+-rf\s+\.\./, "rm -rf .."],
	// A recursive-force rm of the current directory or a bare glob wipes the whole
	// worktree just as effectively as `rm -rf .` — the three patterns above missed
	// `.`, `./`, and `*` (verified bypass). Match `.`/`./`/`*` as the target.
	[/rm\s+-rf\s+\.\/?(?:\s|$)/, "rm -rf . (current directory)"],
	[/rm\s+-rf\s+\*/, "rm -rf * (glob)"],
	[/git\s+reset\s+--hard/, "git reset --hard"],
	[/git\s+push\s.*--force(?!-)/, "git push --force"],
	[/git\s+push\s.*-f\s/, "git push -f"],
	[/git\s+push\s+-f$/, "git push -f"],
	[/git\s+clean\s+-fd/, "git clean -fd"],
	[/git\s+branch\s+-D/, "git branch -D"],
	[/DROP\s+TABLE/i, "DROP TABLE"],
	[/DROP\s+DATABASE/i, "DROP DATABASE"],
	[/TRUNCATE\s+TABLE/i, "TRUNCATE TABLE"],
	[/DELETE\s+FROM\s+\S+$/i, "DELETE FROM (no WHERE clause)"],
	[/curl\s.*\|\s*(?:sh|bash)/, "curl | sh"],
	[/wget\s.*\|\s*(?:sh|bash)/, "wget | sh"],
	// Env-exfiltration: the child pi process inherits the full parent env (API keys,
	// cloud creds) so it can authenticate. Block the obvious paths that ship that env
	// off-box — `printenv`/`env`/`export`/`set` fed into a network tool, in either
	// order (pipe or command-substitution argument).
	[/\b(?:printenv|env|export|set)\b[\s\S]*\|[\s\S]*\b(?:curl|wget|nc|ncat|telnet)\b/i, "env piped to network tool"],
	[/\b(?:curl|wget|nc|ncat)\b[\s\S]*\$\((?:\s*(?:printenv|env|export|set))/i, "network tool sending env via command substitution"],
	[/chmod\s+777/, "chmod 777"],
	[/chmod\s+-R\s+777/, "chmod -R 777"],
	[/chmod\s+\+s/, "chmod +s (setuid)"],
	[/kubectl\s+delete\s+namespace/, "kubectl delete namespace"],
	[/kubectl\s+delete\s.*--all/, "kubectl delete --all"],
	[/npm\s+unpublish/, "npm unpublish"],
	[/cargo\s+yank/, "cargo yank"],
	[/mkfs\./, "mkfs (format disk)"],
	[/dd\s+if=.*\s+of=\/dev\//, "dd to device"],
	[/>\s*\/dev\/sd/, "write to raw device"],
];

/** Secret-file basename patterns (block OVERWRITE of existing only). */
const SECRET_BASENAME: ReadonlyArray<RegExp> = [
	/^\.env$/i,
	/^\.env\./i,
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/\.pfx$/i,
	/\.keystore$/i,
	/^id_rsa/i,
	/^id_ed25519/i,
	/\.secret$/i,
	/^token\.json$/i,
	/^service-account.*\.json$/i,
];

/** Protected directories — any direct write is blocked (existing or not). */
const PROTECTED_DIRS: ReadonlyArray<RegExp> = [/^secrets\//i, /^\.git\//i, /^credentials\//i];

/** Basenames always allowed even if they match a secret pattern. */
const ALWAYS_ALLOWED = new Set([".env.example"]);

/** Check a bash command against the denylist. */
export function checkBashCommand(command: string): CheckResult {
	for (const [pattern, desc] of DANGEROUS) {
		if (pattern.test(command)) return { blocked: true, reason: `command matches dangerous pattern '${desc}'` };
	}
	return { blocked: false };
}

/**
 * Check a write/edit target. Blocks protected-directory writes (any) and
 * OVERWRITES of existing secret files; allows creates + `.env.example`.
 * `cwd` is the child session's cwd (the worktree) so paths resolve correctly
 * when the hook runs in the child process.
 */
export function checkProtectedWrite(file: string, cwd: string): CheckResult {
	const name = basename(file);
	if (ALWAYS_ALLOWED.has(name)) return { blocked: false };

	// Resolve to an absolute path (relative paths resolve against the child cwd).
	const target = isAbsolute(file) ? file : resolve(cwd, file);
	const rel = relative(cwd, target).replace(/\\/g, "/");

	// Worktree-escape guard: any path that resolves OUTSIDE the child cwd (a `..`
	// prefix after normalization, or an absolute path that isn't under cwd) is
	// blocked outright. Without this, the `^`-anchored PROTECTED_DIRS patterns
	// below never match an escaping path (e.g. `../.git/hooks/pre-commit` or
	// `/etc/...`), so a specialist agent could write anywhere on disk. Specialist
	// agents must only mutate their own worktree.
	if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
		return { blocked: true, reason: `'${file}' is outside the working directory` };
	}

	for (const re of PROTECTED_DIRS) {
		if (re.test(rel)) return { blocked: true, reason: `'${file}' is in a protected directory` };
	}
	for (const re of SECRET_BASENAME) {
		if (re.test(name)) {
			if (existsSync(target)) return { blocked: true, reason: `overwriting existing secret file '${file}' is blocked` };
			return { blocked: false }; // create allowed
		}
	}
	return { blocked: false };
}

/** pi extension entry — registered for EVERY delegated agent via
 *  subagentOnlyExtensions alongside the commit guard (F-13). */
export default function safetyGuardExtension(pi: {
	on(event: "tool_call", handler: (event: { toolName?: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>): void;
}): void {
	pi.on("tool_call", async (event, ctx) => {
		const toolName = event?.toolName;
		const input = event?.input ?? {};
		if (toolName === "bash") {
			const r = checkBashCommand(String(input.command ?? ""));
			if (r.blocked) {
				return { block: true, reason: `Blocked by super-dev safety hook: ${r.reason}. Propose a safer alternative.` };
			}
		} else if (toolName === "write" || toolName === "edit") {
			const file = String(input.path ?? input.file_path ?? "");
			if (file) {
				const r = checkProtectedWrite(file, ctx?.cwd ?? process.cwd());
				if (r.blocked) {
					return { block: true, reason: `Blocked by super-dev safety hook: ${r.reason}. Explain why this edit is necessary and request an override.` };
				}
			}
		}
		return undefined;
	});
}
