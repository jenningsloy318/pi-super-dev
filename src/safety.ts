/**
 * Safety guardrails for spawned specialist agents — the Pi-native equivalent of
 * the original plugin's `block-dangerous` + `protect-files` PreToolUse hooks.
 *
 * Two enforcement surfaces:
 *  1. Session backend (default): `createSafetyExtensionFactory()` returns an
 *     inline ExtensionFactory that registers a `tool_call` hook. Passed to the
 *     child session's ResourceLoader alongside `noExtensions: true` (the latter
 *     suppresses ambient global-extension discovery — see verification doc C9 —
 *     while inline factories still load). This gives HARD, uniform interception
 *     of every tool the child calls, bound to that child session.
 *  2. Subprocess backend: `safetyPreamble()` is prepended to the system prompt —
 *     a SOFT guardrail (defense-in-depth) for `SUPER_DEV_BACKEND=subprocess`.
 *
 * The denylist + protected-file patterns are ported verbatim from the original
 * plugin's battle-tested hook scripts. Protected-file logic differs in one
 * deliberate way: we block OVERWRITES of existing secret files only, and allow
 * creates (+ always allow `.env.example`) so greenfield scaffolding isn't blocked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, relative, resolve, isAbsolute } from "node:path";

export interface CheckResult {
	blocked: boolean;
	reason?: string;
}

/** Dangerous command patterns — ported verbatim from the original block-dangerous.mjs. */
const DANGEROUS: ReadonlyArray<readonly [RegExp, string]> = [
	[/rm\s+-rf\s+\/(?!\w)/, "rm -rf /"],
	[/rm\s+-rf\s+~/, "rm -rf ~"],
	[/rm\s+-rf\s+\.\./, "rm -rf .."],
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
 * when the factory runs in the host process.
 */
export function checkProtectedWrite(file: string, cwd: string): CheckResult {
	const name = basename(file);
	if (ALWAYS_ALLOWED.has(name)) return { blocked: false };

	// Resolve to an absolute path (relative paths resolve against the child cwd).
	const target = isAbsolute(file) ? file : resolve(cwd, file);
	const rel = relative(cwd, target).replace(/\\/g, "/");

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

/**
 * Inline ExtensionFactory: registers a `tool_call` hook on the child session
 * that hard-blocks dangerous bash commands and protected-file overwrites.
 * Uniform — covers every tool the child calls, including future/extension tools.
 */
export function createSafetyExtensionFactory(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event, ctx) => {
			const e = event as { toolName?: string; input?: Record<string, unknown> };
			const toolName = e.toolName;
			const input = e.input ?? {};
			const cwd = (ctx as { cwd: string }).cwd;

			if (toolName === "bash") {
				const r = checkBashCommand(String(input.command ?? ""));
				if (r.blocked) {
					return { block: true, reason: `Blocked by super-dev safety hook: ${r.reason}. Propose a safer alternative.` };
				}
			} else if (toolName === "write" || toolName === "edit") {
				const file = String(input.path ?? input.file_path ?? "");
				if (file) {
					const r = checkProtectedWrite(file, cwd);
					if (r.blocked) {
						return { block: true, reason: `Blocked by super-dev safety hook: ${r.reason}. Explain why this edit is necessary and request an override.` };
					}
				}
			}
			return undefined;
		});
	};
}

/** Soft guardrail preamble for the subprocess backend (defense-in-depth). */
export function safetyPreamble(): string {
	return [
		"## Safety guardrails (MANDATORY — refuse and propose a safer alternative)",
		"Refuse to run shell commands that match any of: rm -rf /, rm -rf ~, rm -rf .., git reset --hard, git push --force/-f, git clean -fd, git branch -D, DROP TABLE/DATABASE, TRUNCATE TABLE, DELETE FROM without WHERE, curl|sh, wget|sh, chmod 777, chmod +s, kubectl delete namespace/--all, npm unpublish, cargo yank, mkfs, dd to a device, writes to raw devices.",
		"Refuse to OVERWRITE existing secret files (.env, .env.*, *.pem, *.key, *.p12, *.pfx, *.keystore, id_rsa*, id_ed25519*, *.secret, token.json, service-account*.json) or anything under secrets/, .git/, credentials/. Creating new files (including .env.example) is allowed.",
	].join("\n");
}
