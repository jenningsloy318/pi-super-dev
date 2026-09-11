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
import { commitGuardExtensionPath, safetyGuardExtensionPath, buildToolIndex, configExtensionEntriesForAgent, configExtensionToolsForAgent, toolsWildcardForAgent, extensionsForAgent, skillsEnabled, curatedSkillsRole, ambientSkillsForced, explicitSkillConfigured, resolveToolBudget, type ResolvedToolBudget } from "./agent-runtime.ts";
import { getConfig } from "../render/super-dev-dir.ts";
import type { DelegationEventBus } from "./delegation-backend.ts";

export const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

/** Read-only tool set — mirrors sessionToolAccess("source-read-only"):
 *  inspection + diagnostics, no mutation. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

/** Writer tool set — the coding surface minus the super_dev tool itself. */
export const WRITER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

/** v0.3.82: tools excluded when the all-tools mode unpins an allowlist.
 *  Read-only roles: the write family + powershell (the Windows bash twin —
 *  never in READ_ONLY_TOOLS by precedent, so the unpinned mode must re-exclude
 *  it to preserve posture). EVERY role: `super_dev` — children without an
 *  extensions pin keep AMBIENT extension loading, so an unpinned child would
 *  otherwise carry an ACTIVE super_dev tool and could recurse into a nested
 *  nested pipeline (dual review code-F3/adv-F5; the pin was the only thing
 *  keeping it out — see the WRITER_TOOLS "minus the super_dev tool" note).
 *  Bash stays available per repo precedent; the binding read-only enforcement
 *  remains the engine-side source boundary. */
const WILDCARD_READ_ONLY_EXCLUDES = ["write", "edit", "powershell", "super_dev"] as const;
const WILDCARD_WRITER_EXCLUDES = ["powershell", "super_dev"] as const;

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
	// v0.3.69 E2: incident diagnostician — read-only; the ENGINE writes its
	// inbox draft from the returned control (P4: the boundary is mechanical).
	"post-mortem",
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
export const REGISTERED_AGENTS = [
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
	"post-mortem",
	"prototype-runner",
	"api-tester",
	"ui-tester",
];

function descriptionFor(name: string): string {
	return `super-dev pipeline specialist: ${name.replace(/-/g, " ")}`;
}

let ownerPresentSeen: boolean | null = null;

/** v0.3.26: whether pi-subagents answered the registration handshake at
 *  activate() time. `null` = never probed (tests, CLI, or a different
 *  module instance) — callers must treat unknown as "proceed", only a
 *  definite `false` degrades. This is the capability check for the
 *  every specialist call (pi-subagents is required since v0.3.64): without an owner listening,
 *  every delegation request would hang to its timeout backstop. */
export function delegationOwnerPresent(): boolean | null {
	return ownerPresentSeen;
}

/** Emit one registration request; returns the dispose when accepted.
 *  `onAnswered` fires when the owner wrote any result (ok or rejection) —
 *  the v0.3.26 capability signal that pi-subagents is listening. */
function registerOne(events: DelegationEventBus, name: string, log: (line: string) => void, onAnswered: () => void, toolIndex?: ReadonlyMap<string, readonly string[]>): (() => void) | null {
	// v0.3.82: resolved ONCE per agent (registration-time) — list + wildcard.
	let cachedTools: { list: string[]; wildcard: boolean } | undefined;
	const configToolsFor = (agent: string): { list: string[]; wildcard: boolean } => {
		if (!cachedTools) {
			const wildcard = toolsWildcardForAgent(agent, { warn: log });
			if (wildcard && !warnedWildcardOnce) {
				warnedWildcardOnce = true;
				log(`super-dev: allTools mode active for '${agent}' — registration omits the tools pin (all tools incl. every mcp__* direct tool)${READ_ONLY_AGENTS.has(agent) ? `; read-only posture kept via excludeTools [${WILDCARD_READ_ONLY_EXCLUDES.join(", ")}]` : ""}`);
			}
			cachedTools = { list: wildcard ? [] : configExtensionToolsForAgent(agent, { warn: log, toolIndex }), wildcard };
		}
		return cachedTools;
	};
	let warnedWildcardOnce = false;

	// v0.3.76 dual-review R1/AR-2: the SAME config skillsForCall consults per
	// call — read once at registration (activate-time) so the two layers
	// agree on entry existence; try/catch matches workflow.ts's read pattern.
	const agentSkillsConfig = (() => { try { return getConfig().agentSkills ?? {}; } catch { return {}; } })();
	const request: {
		version: 1;
		name: string;
		definition: { description: string; systemPrompt: string; tools?: readonly string[]; excludeTools?: readonly string[]; inheritSkills: boolean; extensions?: string[]; subagentOnlyExtensions?: string[]; toolBudget?: ResolvedToolBudget };
		result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
	} = {
		version: 1,
		name: `sd-${name}`,
		definition: {
			description: descriptionFor(name),
			systemPrompt: loadAgentBasePrompt(name),
			// v0.3.78 review fix (adv F1): pi-coding-agent maps `tools` to
			// allowedToolNames and drops extension-registered tools not in it —
			// every tool of every DECLARED extension merges onto the role
			// allowlist mechanically (the activation-time tool index; scope and
			// malformed guards live in configExtensionToolsForAgent).
			//
			// v0.3.82 all-tools MODE (boolean allTools/agentAllTools — replaced
			// the "*" string form): registration OMITS the pin (the only correct
			// "all tools" — pi's allowlist is exact-match) for BOTH postures;
			// excludeTools preserves the write-family posture for read-only roles
			// and the recursion guard (super_dev) for EVERY role (ambient children
			// load pi-super-dev itself — see WILDCARD_*_EXCLUDES). The binding
			// read-only enforcement remains the engine-side source boundary (P4);
			// this is the tool-layer mirror.
			...(configToolsFor(name).wildcard
				? { excludeTools: READ_ONLY_AGENTS.has(name) ? WILDCARD_READ_ONLY_EXCLUDES : WILDCARD_WRITER_EXCLUDES }
				: { tools: [...new Set([
					...(READ_ONLY_AGENTS.has(name) ? READ_ONLY_TOOLS : WRITER_TOOLS),
					...configToolsFor(name).list,
				])] }),
			// v0.3.59 — skills are a capability on EVERY backend (v0.2.10 W4 parity).
			// pi-subagents defaults inheritSkills to FALSE (agents.ts
			// defaultInheritSkills), which launched every sd-* child with
			// `--no-skills` — the delegation backend silently broke the documented
			// session/subprocess skills parity. skillsEnabled() is the ONE switch
			// (SUPER_DEV_NO_SKILLS=1) governing all three backends; children keep
			// lazy keyword-matched loading (system-prompt skill list + `read` of
			// SKILL.md). v0.3.60 r59-P2-doc: the tool allowlist above bounds the
			// DEFAULT surface but is NOT a hard boundary — bash stays allowlisted,
			// so a skill-instructed out-of-role action remains executable; the
			// BINDING enforcement is the downstream deterministic gates (P4:
			// prompts and skills are advisory).
			//
			// v0.3.76 — the REGISTRATION-level gate is the one that actually controls
			// child-side ambient discovery (pi-subagents child-launch.ts:298
			// `noSkills: !inheritSkills`; the per-call request `skill` field only
			// adds a curated injection block, it does NOT suppress ambient — E2E
			// probe 2026-09-07, /tmp/sd376probe). So curated roles (mechanical
			// classifiers: measured 0 skill use; research: firecrawl family via the
			// per-call field) register inheritSkills:false and get their cards via
			// skillsForCall on each request instead. SUPER_DEV_SKILLS=ambient (L3
			// escape hatch) keeps every role ambient — the standing "subagents same
			// as pi" decision for capability roles is untouched.
			//
			// Dual-review R1/AR-2 fix: an explicit agentSkills config entry for a
			// role ALSO flips registration (ambient suppression is registration-
			// only) — otherwise `false` on a capability role is a silent no-op and
			// an array is ambient+curated duplicate injection. Registration reads
			// the config ONCE at activate, so agentSkills EDITS REQUIRE A pi
			// RESTART to change a role's registration-layer semantics (documented
			// in super-dev-dir.ts).
			// Ambient-forced forces inheritSkills TRUE for every role (restore);
			// otherwise any curation flag (tier or explicit config) → false.
			inheritSkills: skillsEnabled() && (ambientSkillsForced() || !(curatedSkillsRole(name) || explicitSkillConfigured(agentSkillsConfig, name))),
			// v0.3.64 — per-agent extension entries for roles that need
			// extension-provided tools: research-agent (pi-web-access web tools +
			// pi-mcp-adapter MCP gateway) and qa-agent/ui-tester
			// (pi-browser-cdp-extension `browser_execute`). Verified live on
			// pi-subagents 0.64 (-e on the spawned CLI child) AND 0.65 (in-process
			// extensionPaths) on 2026-09-04: the child's tool list contains
			// web_search/fetch_content/browser_execute etc. Declaring `extensions`
			// disables AMBIENT discovery for that child — the same isolation these
			// roles always had on the deleted subprocess backend; missing packages
			// degrade to an empty list (agent loses the tools, run continues).
			...(extensionsForAgent(name).length > 0 ? { extensions: extensionsForAgent(name) } : {}),
		// v0.3.74 dual review F2: the commit guard rides subagentOnlyExtensions —
		// child-only loading that does NOT disable the child's ambient extension
		// discovery (unlike `extensions`, per child-tool-plan.ts:403).
		// v0.3.78 — config-driven commonExtensions (every capability agent) and
		// agentExtensions[role] merge onto the SAME additive channel, UNIONed with
		// the guard and never replacing it. Scope (mechanical classifiers
		// excluded from common; explicit agentExtensions honored for any role),
		// npm: normalization, and missing-package WARN+skip semantics live in
		// agent-runtime.configExtensionEntriesForAgent; the warn sink is this
		// registration log. Registration reads config once at activate — restart
		// pi after edits (same as agentSkills).
		...(() => {
			const guard = commitGuardExtensionPath(name);
			// v0.3.86 F-13: the SAFETY guard (dangerous-bash denylist + protected-file
			// writes) rides the SAME additive child-only channel for EVERY agent —
			// previously the rules were dormant outside the bench harness.
			const safetyGuard = safetyGuardExtensionPath(name);
			const configEntries = configExtensionEntriesForAgent(name, { warn: log });
			const merged = [...(guard ? [guard] : []), ...(safetyGuard ? [safetyGuard] : []), ...configEntries];
			return merged.length > 0 ? { subagentOnlyExtensions: merged } : {};
		})(),
		// v0.3.87 (S4 decisions 8/9/10) — config-resolved tool-call budget riding
		// the SAME per-agent registration seam as tools:/subagentOnlyExtensions:
		// pi-subagents native RuntimeAgentDefinition.toolBudget (≥ 0.65; a
		// pre-0.65 owner rejects the field → the existing structured-degrade
		// machinery reports it per agent, no new code path). Resolution
		// agentToolBudget[role] > commonToolBudget > none; absent config sends
		// NO toolBudget (caps strictly opt-in); mechanical classifiers never
		// get one; the block list is the fixed five external-exploration
		// families, never "*". ZERO budget numbers live in code — values are
		// policy in ~/.super-dev/config.json (recommended values: README).
		// Read once at registration — restart pi after config edits.
		...(() => {
			const budget = resolveToolBudget(name, { warn: log });
			return budget !== undefined ? { toolBudget: budget } : {};
		})(),
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
/** v0.3.82 dual review BLOCKER fix: registerSuperDevAgents must NOT be
 *  called at extension-activation time — pi.getAllTools() THROWS there
 *  (notInitialized stub until _bindExtensionCore, which runs after every
 *  extension factory), and the old "alphabetical load order" rationale was
 *  wrong (settings.json packages-array order). Deferred registration:
 *  arm the first session_start (runtime bound, every settings package
 *  activated, tools carry their real npm:<pkg> sourceInfo) with a belt-and-
 *  braces 15s unref'd timer fallback for hosts that never emit the event
 *  (the fallback registers with whatever the index then holds — a loud WARN
 *  covers the empty case; agents existing with role built-ins beats every
 *  delegation failing "Unknown agent"). Once per activation; a previous
 *  activation's registration is disposed first (reload re-activates us).
 *  Returns a dispose that cancels the deferral AND any registration made. */
export function registerSuperDevAgentsDeferred(
	pi: { on?: (event: "session_start", handler: () => void) => void; getAllTools?: () => Array<{ name: string; sourceInfo?: { source?: string; path?: string } }> },
	events: DelegationEventBus,
	log: (line: string) => void = () => {},
): () => void {
	let done = false;
	let registered: (() => void) | null = null;
	const fire = () => {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		try {
			registered?.();
		} catch { /* best-effort */ }
		registered = null;
		const built = buildToolIndex(pi);
		if (built.error) log(`super-dev: tool index build FAILED (${built.error}) — extension-registered tools will NOT merge onto agent allowlists (children keep role built-ins; declared extension hooks still load)`);
		registered = registerSuperDevAgents(events, log, built.toolIndex);
	};
	let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { try { fire(); } catch (error) { log(`super-dev: deferred registration fallback failed: ${error instanceof Error ? error.message : String(error)}`); } }, 15_000);
	timer.unref?.();
	try {
		pi.on?.("session_start", fire);
	} catch (error) {
		log(`super-dev: session_start listener failed to arm (${error instanceof Error ? error.message : String(error)}) — relying on the 15s fallback`);
	}
	return () => {
		if (done && registered) { try { registered(); } catch { /* best-effort */ } registered = null; }
		done = true;
		if (timer) clearTimeout(timer);
	};
}

export function registerSuperDevAgents(events: DelegationEventBus, log: (line: string) => void = () => {}, toolIndex?: ReadonlyMap<string, readonly string[]>): () => void {
	const accepted: Array<() => void> = [];
	let answered = 0; // requests that got ANY result back → an owner is listening
	for (const name of REGISTERED_AGENTS) {
		try {
			const dispose = registerOne(events, name, log, () => { answered++; }, toolIndex);
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
		log("ERROR super-dev: pi-subagents is not active in this session — every specialist call will fail until it is installed. super-dev v0.3.64+ REQUIRES pi-subagents (a hard requirement — see README: Requirements). Install it with: pi install npm:pi-subagents — then restart pi.");
	} else if (accepted.length < total) {
		log(`ERROR super-dev: only ${accepted.length}/${total} sd-* agents registered — delegation for the missing names will fail with \`Unknown agent\` per call until they register (see the rejection lines above; fix the registration error and restart pi).`);
	} else {
		log(`super-dev: registered ${accepted.length}/${total} sd-* agents with pi-subagents (skills=${skillsEnabled() ? "on" : "off"} — SUPER_DEV_NO_SKILLS=1 disables)`);
	}
	return () => {
		for (const dispose of accepted) {
			try { dispose(); } catch { /* best-effort */ }
		}
	};
}
