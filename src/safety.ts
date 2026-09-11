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
 *  2. v0.3.64: the subprocess backend is DELETED — `safetyPreamble()` now has
 *     no pipeline consumer (the bench harness keeps the module alive).
 *     Delegated children rely on the registration tool allowlists
 *     (READ_ONLY_TOOLS / WRITER_TOOLS) plus the downstream deterministic
 *     gates, not on this soft preamble.
 *
 * The denylist + protected-file patterns are ported verbatim from the original
 * plugin's battle-tested hook scripts. Protected-file logic differs in one
 * deliberate way: we block OVERWRITES of existing secret files only, and allow
 * creates (+ always allow `.env.example`) so greenfield scaffolding isn't blocked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkBashCommand, checkProtectedWrite } from "./child-guards/safety-guard.ts";

// F-13 (v0.3.86): the denylist/protected-file tables + checkers now live in
// the SELF-CONTAINED child extension (src/child-guards/safety-guard.ts) so the
// SAME rules load inside every delegated child via subagentOnlyExtensions;
// this module re-exports them for host-side consumers (lifecycle.ts service
// bringup, the bench session agent). Single source of truth — no drift.
export { checkBashCommand, checkProtectedWrite } from "./child-guards/safety-guard.ts";
export type { CheckResult } from "./child-guards/safety-guard.ts";

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
		"Refuse to run shell commands that match any of: rm -rf /, rm -rf ~, rm -rf .., rm -rf . (current dir), rm -rf * (glob), git reset --hard, git push --force/-f, git clean -fd, git branch -D, DROP TABLE/DATABASE, TRUNCATE TABLE, DELETE FROM without WHERE, curl|sh, wget|sh, chmod 777, chmod +s, kubectl delete namespace/--all, npm unpublish, cargo yank, mkfs, dd to a device, writes to raw devices.",
		"Refuse to OVERWRITE existing secret files (.env, .env.*, *.pem, *.key, *.p12, *.pfx, *.keystore, id_rsa*, id_ed25519*, *.secret, token.json, service-account*.json) or anything under secrets/, .git/, credentials/. Creating new files (including .env.example) is allowed. NEVER write, edit, or delete any path outside this worktree directory (no absolute paths, no `..` traversal).",
	].join("\n");
}
