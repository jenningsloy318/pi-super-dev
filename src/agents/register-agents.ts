/**
 * v0.3.25 L3 — register super-dev's specialists as first-class pi-subagents
 * agents via the process-local `pi-subagents:runtime-agent-register:v1` event
 * contract (docs/extension-api.md, "Runtime agent registration").
 *
 * Each agents/<name>.md body is the system prompt (the SAME prompt the
 * session/subprocess backends load via loadAgentPrompt — one source of
 * truth); the name is `sd-`-prefixed to avoid collisions with pi-subagents'
 * own agents; the tool set mirrors the session backend's access-mode split
 * (reviewers/judges/classifiers are read-only; writers/implementers may
 * edit). Learned lessons are NOT baked into the registration (base .md body
 * only — review-2 P2) — they inject per-call through the task prompt as
 * today, so registrations never go stale after reflection updates.
 *
 * The event contract writes `request.result` synchronously; a missing owner
 * (pi-subagents not installed) leaves result undefined → we skip silently.
 * Failures (collisions, validation) are logged, never thrown — the extension
 * must not fail to activate because a registration was rejected.
 */

import { loadAgentBasePrompt } from "../agents.ts";
import { skillsEnabled } from "../pi-spawn.ts";
import type { DelegationEventBus } from "./delegation-backend.ts";

export const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

/** Read-only tool set — mirrors sessionToolAccess("source-read-only"):
 *  inspection + diagnostics, no mutation. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** Writer tool set — the coding surface minus the super_dev tool itself. */
export const WRITER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

/** Agents whose ROLE is analytical (reviewers, judges, classifiers,
 *  analyzers) — they never need to mutate the worktree. Mirrors the
 *  access-mode split the other backends apply. */
export const READ_ONLY_AGENTS = new Set([
	"task-classifier",
	"requirements-clarifier",
	"requirements-reviewer",
	"bdd-reviewer",
	"design-reviewer",
	"spec-reviewer",
	"code-reviewer",
	"adversarial-reviewer",
	"code-assessor",
	"debug-analyzer",
	"judge",
	"red-boundary-classifier",
	"tdd-coverage-classifier",
	"reflection",
	"replan-lead",
	// Review-2 P1: the four design-stage specialists (routeDesigner,
	// helpers.ts:57-67) — analytical design roles; they emit controls, the
	// stage renders the artifact.
	"product-designer",
	"ui-ux-designer",
	"architecture-improver",
	"architecture-designer",
]);

/** The agents that must NOT be delegated (browser/web-research roles forced
 *  onto the subprocess backend) are still registered for future use — the
 *  backend-selection rule, not the registration, gates them. */
const REGISTERED_AGENTS = [
	"task-classifier",
	"requirements-clarifier",
	"requirements-reviewer",
	"bdd-scenario-writer",
	"bdd-reviewer",
	"research-agent",
	"debug-analyzer",
	"code-assessor",
	// Review-2 P1: the design-stage specialists were missing — every non-bug
	// task routes here (routeDesigner, helpers.ts:57-67), so backend=
	// pi-subagents could not run the design stage at all.
	"product-designer",
	"ui-ux-designer",
	"architecture-improver",
	"architecture-designer",
	"design-reviewer",
	"spec-writer",
	"spec-reviewer",
	"implementer",
	"tdd-guide",
	"code-reviewer",
	"adversarial-reviewer",
	"judge",
	"red-boundary-classifier",
	"tdd-coverage-classifier",
	"docs-executor",
	"orchestrator",
	"reflection",
	"replan-lead",
	"prototype-runner",
	"api-tester",
	"ui-tester",
];

function descriptionFor(name: string): string {
	return `super-dev pipeline specialist: ${name.replace(/-/g, " ")} (13-stage development pipeline)`;
}

let ownerPresentSeen: boolean | null = null;

/** v0.3.26: whether pi-subagents answered the registration handshake at
 *  activate() time. `null` = never probed (tests, CLI, or a different
 *  module instance) — callers must treat unknown as "proceed", only a
 *  definite `false` degrades. This is the capability check for the
 *  `agentBackend: "pi-subagents"` config: without an owner listening,
 *  every delegation request would hang to its timeout backstop. */
export function delegationOwnerPresent(): boolean | null {
	return ownerPresentSeen;
}

/** Emit one registration request; returns the dispose when accepted.
 *  `onAnswered` fires when the owner wrote any result (ok or rejection) —
 *  the v0.3.26 capability signal that pi-subagents is listening. */
function registerOne(events: DelegationEventBus, name: string, log: (line: string) => void, onAnswered: () => void): (() => void) | null {
	const request: {
		version: 1;
		name: string;
		definition: { description: string; systemPrompt: string; tools: readonly string[]; inheritSkills: boolean };
		result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
	} = {
		version: 1,
		name: `sd-${name}`,
		definition: {
			description: descriptionFor(name),
			systemPrompt: loadAgentBasePrompt(name),
			tools: READ_ONLY_AGENTS.has(name) ? READ_ONLY_TOOLS : WRITER_TOOLS,
			// v0.3.59 — skills are a capability on EVERY backend (v0.2.10 W4 parity).
			// pi-subagents defaults inheritSkills to FALSE (agents.ts
			// defaultInheritSkills), which launched every sd-* child with
			// `--no-skills` — the delegation backend silently broke the documented
			// session/subprocess skills parity. skillsEnabled() is the ONE switch
			// (SUPER_DEV_NO_SKILLS=1) governing all three backends; children keep
			// lazy keyword-matched loading (system-prompt skill list + `read` of
			// SKILL.md), and the tool allowlist above stays the hard boundary.
			inheritSkills: skillsEnabled(),
		},
	};
	try {
		events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
	} catch (error) {
		log(`super-dev: agent registration emit failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	const result = request.result;
	if (!result) return null; // no owner listening — silent skip
	onAnswered();
	if (!result.ok) {
		log(`ERROR super-dev: agent registration rejected for sd-${name}: ${result.error.message}`);
		return null;
	}
	return result.registration.dispose.bind(result.registration);
}

/** Register every specialist. Idempotent-ish: re-registration attempts that
 *  the owner rejects (collision) are logged, not thrown. Returns a dispose
 *  that unregisters everything accepted so far. */
export function registerSuperDevAgents(events: DelegationEventBus, log: (line: string) => void = () => {}): () => void {
	const accepted: Array<() => void> = [];
	let answered = 0; // requests that got ANY result back → an owner is listening
	for (const name of REGISTERED_AGENTS) {
		try {
			const dispose = registerOne(events, name, log, () => { answered++; });
			if (dispose) accepted.push(dispose);
		} catch (error) {
			log(`super-dev: agent registration failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	ownerPresentSeen = answered > 0;
	const total = REGISTERED_AGENTS.length;
	if (answered === 0) {
		// No pi-subagents owner in this process: the delegation backend would
		// hang per call, so say exactly what the user should do (v0.3.26).
		log("WARN super-dev: pi-subagents is not active in this session — the 'pi-subagents' agentBackend would degrade to 'session'. Install pi-subagents (the pi package, not an npm dep) or remove agentBackend from ~/.super-dev/config.json.");
	} else if (accepted.length < total) {
		log(`ERROR super-dev: only ${accepted.length}/${total} sd-* agents registered — delegation for the missing names degrades to the session backend per call (see the rejection lines above).`);
	} else {
		log(`super-dev: registered ${accepted.length}/${total} sd-* agents with pi-subagents (skills=${skillsEnabled() ? "on" : "off"} — SUPER_DEV_NO_SKILLS=1 disables)`);
	}
	return () => {
		for (const dispose of accepted) {
			try { dispose(); } catch { /* best-effort */ }
		}
	};
}
