/**
 * v0.3.95 FIX B2 (run-2026-09-12T15-16-29-042Z §5.2) — thinking-level fidelity
 * at the dispatch seam. The incident: an untiered reviewer inherited the parent
 * session's "max" thinking on a model whose thinkingLevelMap maps max→null;
 * pi-subagents appended the suffix, the provider rejected
 * "antigravity/gemini-3.8-flash:max" ("Model not found"), and the failure was
 * cached as a 5h model exclusion poisoning every later dispatch of the model.
 *
 * Three surfaces under test:
 *  1. clampThinkingToModel (agent-runtime) — clamp to the NEAREST supported
 *     level over THINKING_LEVELS (bidirectional distance, ties → lower), per
 *     the pi-ai thinkingLevelMap convention (mirrored from pi-subagents
 *     getSupportedThinkingLevels; reasoning:false → off is authoritative
 *     even without a map — fix-round BLOCKING-1);
 *  2. resolveThinkingDetailed — the provenance the owner ruling keys on
 *     (config/explicit intent dispatches as-is with a one-time WARN; role-tier
 *     / inherited / medium-default levels clamp);
 *  3. the delegation-backend wiring — request.thinking carries the clamped
 *     (or intent-preserved) level, with one-time-per-process run-log WARNs.
 *
 * Catalog data is injected via fixture files in a temp agent dir (never the
 * real ~/.pi/agent), and config via the getConfig mock (hermeticity pattern of
 * tests/thinking-config.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const configState: { agentModels?: Record<string, string>; agentThinking?: Record<string, string> } = {};
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	return {
		...actual,
		getConfig: () => ({ ...actual.DEFAULT_CONFIG, ...configState }),
	};
});

/** Fix-round ADVISORY-3: the e2e slice runs the LIVE delegation backend
 *  through runWorkflow — stub the owner-presence probe (definite `false`
 *  would fail every call closed; null = never probed, the workflow-delegation-
 *  backend.test.ts wiring-harness pattern). */
vi.mock("../src/agents/register-agents.ts", () => ({
	delegationOwnerPresent: vi.fn((): boolean | null => null),
	REGISTERED_AGENTS: [],
}));

import {
	clampThinkingToModel,
	resolveThinking,
	resolveThinkingDetailed,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "../src/agents/agent-runtime.ts";
import {
	clampThinkingForDispatch,
	DELEGATION_REQUEST_EVENT,
	DELEGATION_RESPONSE_EVENT,
	resetThinkingClampState,
	runAgentViaDelegation,
	type DelegationEventBus,
	type DelegationRequestPayload,
} from "../src/agents/delegation-backend.ts";
import { runWorkflow } from "../src/workflow.ts";
import { sequence, task } from "../src/nodes.ts";
import type { AgentProgress, PipelineState, SpawnResult, Stage, StageContext, Workflow } from "../src/types.ts";

// ─── fixtures ───────────────────────────────────────────────────────────────

/** The LIVE antigravity catalog shape (models as an ARRAY of {id, ...}). */
const ANTIGRAVITY_CATALOG = {
	version: 1,
	checkedAt: 1788527459285,
	models: [
		{
			id: "gemini-3.8-flash",
			name: "Gemini 3.8 Flash (Antigravity)",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
		},
		{
			id: "nullmap-model",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		},
		{
			id: "nomap-model",
			reasoning: true,
		},
		{
			id: "noreason-model",
			reasoning: false,
			thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
		},
		// Fix-round BLOCKING-1: the PRODUCTION shape of a non-reasoning model —
		// reasoning:false and NO thinkingLevelMap (gpt-4o / haiku declare exactly
		// this). The reasoning signal must be reachable without a map.
		{
			id: "noreason-nomap-model",
			reasoning: false,
		},
	],
};

/** An object-keyed `models` map (both shapes name the model unambiguously). */
const OBJECT_KEYED_CATALOG = {
	version: 1,
	checkedAt: 1788527459285,
	models: {
		"object-model": {
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		},
	},
};

/** models-store.json shape: { <provider>: { models: [...] } }. */
const MODELS_STORE = {
	"store-prov": {
		models: [
			{
				id: "store-clamped",
				thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null, max: null },
			},
		],
	},
};

/** models.json shape: { providers: { <provider>: { models: [...] } } }. */
const MODELS_JSON = {
	providers: {
		"json-prov": {
			models: [
				{ id: "json-only-high", thinkingLevelMap: { low: null, medium: null, high: "high", xhigh: null, max: null } },
			],
		},
	},
};

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "sd-thinkclamp-"));
	writeFileSync(join(agentDir, "antigravity-model-catalog.json"), JSON.stringify(ANTIGRAVITY_CATALOG));
	writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(MODELS_STORE));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(MODELS_JSON));
	configState.agentModels = undefined;
	configState.agentThinking = undefined;
	delete process.env.SUPER_DEV_THINKING; // hermetic: a dev shell export must not skew precedence
	resetThinkingClampState();
});
afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

// ─── clampThinkingToModel (pure, fixture agentDir injected) ─────────────────

describe("clampThinkingToModel", () => {
	it("clamps inherited max down to high on the incident map (walks max→xhigh→high, two steps)", () => {
		expect(clampThinkingToModel("antigravity", "gemini-3.8-flash", "max", { agentDir }))
			.toEqual({ level: "high", clamped: true, source: "catalog" });
	});

	it("clamps xhigh down to high when xhigh is null (single step)", () => {
		expect(clampThinkingToModel("antigravity", "gemini-3.8-flash", "xhigh", { agentDir }))
			.toEqual({ level: "high", clamped: true, source: "catalog" });
	});

	it("clamps off/minimal up-front holes down to low (off:null, minimal:null)", () => {
		expect(clampThinkingToModel("antigravity", "gemini-3.8-flash", "minimal", { agentDir }))
			.toEqual({ level: "low", clamped: true, source: "catalog" });
	});

	it("leaves an already-supported level untouched", () => {
		for (const level of ["low", "medium", "high"] as ThinkingLevel[]) {
			expect(clampThinkingToModel("antigravity", "gemini-3.8-flash", level, { agentDir }))
				.toEqual({ level, clamped: false, source: "catalog" });
		}
	});

	it("no catalog anywhere → source unknown, NO clamp (fail-open, today's behavior)", () => {
		expect(clampThinkingToModel("no-such-prov", "no-such-model", "max", { agentDir }))
			.toEqual({ level: "max", clamped: false, source: "unknown" });
	});

	it("a catalog entry WITHOUT a thinkingLevelMap is unknown, not empty-supported", () => {
		expect(clampThinkingToModel("antigravity", "nomap-model", "max", { agentDir }))
			.toEqual({ level: "max", clamped: false, source: "unknown" });
	});

	it("an all-null map clamps nothing — no supported level exists at-or-below, fail open", () => {
		expect(clampThinkingToModel("antigravity", "nullmap-model", "max", { agentDir }))
			.toEqual({ level: "max", clamped: false, source: "catalog" });
	});

	it("models-store.json entries carrying a thinkingLevelMap are a supported source", () => {
		// map holes through `high` mean provider defaults (pi-ai convention):
		// off/minimal absent → supported; xhigh/max explicitly null → not.
		expect(clampThinkingToModel("store-prov", "store-clamped", "max", { agentDir }))
			.toEqual({ level: "high", clamped: true, source: "catalog" });
		expect(clampThinkingToModel("store-prov", "store-clamped", "off", { agentDir }))
			.toEqual({ level: "off", clamped: false, source: "catalog" });
	});

	it("models.json providers.<provider>.models entries are a supported source", () => {
		expect(clampThinkingToModel("json-prov", "json-only-high", "medium", { agentDir }))
			.toEqual({ level: "high", clamped: true, source: "catalog" });
	});

	it("a reasoning:false model supports only off (mirrored from getSupportedThinkingLevels)", () => {
		expect(clampThinkingToModel("antigravity", "noreason-model", "medium", { agentDir }))
			.toEqual({ level: "off", clamped: true, source: "catalog" });
	});

	it("BLOCKING-1: reasoning:false WITHOUT any thinkingLevelMap → off-only supported (branch reachable)", () => {
		// The production non-reasoning shape (gpt-4o / haiku): reasoning:false,
		// no map. The old map-first order returned unknown here and left an
		// inherited max unguarded — the exact 5h-exclusion crash class.
		expect(clampThinkingToModel("antigravity", "noreason-nomap-model", "medium", { agentDir }))
			.toEqual({ level: "off", clamped: true, source: "catalog" });
		// the crash-class guard itself: inherited max on a non-reasoning model
		// clamps to off instead of dispatching "model:max".
		expect(clampThinkingToModel("antigravity", "noreason-nomap-model", "max", { agentDir }))
			.toEqual({ level: "off", clamped: true, source: "catalog" });
	});

	it("an object-keyed models map resolves too (both catalog shapes name the model)", () => {
		writeFileSync(join(agentDir, "objprov-model-catalog.json"), JSON.stringify(OBJECT_KEYED_CATALOG));
		expect(clampThinkingToModel("objprov", "object-model", "max", { agentDir }))
			.toEqual({ level: "high", clamped: true, source: "catalog" });
	});

	it("ADVISORY-2: a mapless higher-priority entry is TRANSPARENT — a models-store map wins over a mapless catalog entry", () => {
		// Catalog has the model but WITHOUT a thinkingLevelMap; models-store
		// carries one. Without the fix the catalog entry shadowed the store and
		// the lookup degraded to unknown (no clamp).
		writeFileSync(join(agentDir, "shadowprov-model-catalog.json"), JSON.stringify({
			version: 1,
			checkedAt: Date.now(),
			models: [{ id: "dual-entry", reasoning: true }],
		}));
		writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({
			...MODELS_STORE,
			shadowprov: { models: [{ id: "dual-entry", thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null, max: null } }] },
		}));
		expect(clampThinkingToModel("shadowprov", "dual-entry", "max", { agentDir }))
			.toEqual({ level: "high", clamped: true, source: "catalog" });
	});

	it("never throws on unparsable catalog files (P5)", () => {
		writeFileSync(join(agentDir, "broken-model-catalog.json"), "{not json");
		expect(clampThinkingToModel("broken", "anything", "max", { agentDir }))
			.toEqual({ level: "max", clamped: false, source: "unknown" });
	});
});

// ─── resolveThinkingDetailed (provenance; P6: resolveThinking is its face) ──

describe("resolveThinkingDetailed", () => {
	const OLD_ENV = process.env.SUPER_DEV_THINKING;
	afterEach(() => {
		if (OLD_ENV === undefined) delete process.env.SUPER_DEV_THINKING;
		else process.env.SUPER_DEV_THINKING = OLD_ENV;
	});

	it("per-call wins and is labeled per-call", () => {
		expect(resolveThinkingDetailed("requirements-reviewer", "low", "max"))
			.toEqual({ level: "low", source: "per-call" });
	});

	it("SUPER_DEV_THINKING env is labeled env and orders BEFORE inherited", () => {
		process.env.SUPER_DEV_THINKING = "low";
		expect(resolveThinkingDetailed("requirements-reviewer", undefined, "max"))
			.toEqual({ level: "low", source: "env" });
	});

	it("config.agentThinking[role] is labeled agent-thinking", () => {
		configState.agentThinking = { "requirements-reviewer": "high" };
		expect(resolveThinkingDetailed("requirements-reviewer", undefined, "max"))
			.toEqual({ level: "high", source: "agent-thinking" });
	});

	it("the config.agentModels :level suffix is labeled model-suffix (the operator's incident fix)", () => {
		configState.agentModels = { "requirements-reviewer": "antigravity/gemini-3.8-flash:high" };
		expect(resolveThinkingDetailed("requirements-reviewer", undefined, "max"))
			.toEqual({ level: "high", source: "model-suffix" });
	});

	it("tiered roles are labeled role-tier and beat inheritance", () => {
		expect(resolveThinkingDetailed("code-reviewer", undefined, "max"))
			.toEqual({ level: "high", source: "role-tier" });
	});

	it("untiered roles inherit (the incident: requirements-reviewer + max)", () => {
		expect(resolveThinkingDetailed("requirements-reviewer", undefined, "max"))
			.toEqual({ level: "max", source: "inherited" });
	});

	it("nothing anywhere → medium-default", () => {
		expect(resolveThinkingDetailed("requirements-reviewer", undefined, undefined))
			.toEqual({ level: "medium", source: "medium-default" });
	});

	it("resolveThinking stays the level-only face of the same grammar (P6)", () => {
		configState.agentModels = { "requirements-reviewer": "antigravity/gemini-3.8-flash:high" };
		for (const agent of ["requirements-reviewer", "code-reviewer", "implementer", "commit"]) {
			expect(resolveThinking(agent, undefined, "max")).toBe(resolveThinkingDetailed(agent, undefined, "max").level);
		}
	});
});

// ─── clampThinkingForDispatch (the provenance ruling, unit level) ───────────

describe("clampThinkingForDispatch", () => {
	it("heuristic sources (inherited) clamp to the nearest supported level", () => {
		const warns: string[] = [];
		expect(clampThinkingForDispatch(
			{ agent: "requirements-reviewer", model: "antigravity/gemini-3.8-flash", level: "max", source: "inherited" },
			(m) => warns.push(m),
			{ agentDir },
		)).toBe("high");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("clamped thinking max -> high");
	});

	it("intent sources (model-suffix config) keep the level and WARN naming the dispatch consequence", () => {
		const warns: string[] = [];
		expect(clampThinkingForDispatch(
			{ agent: "requirements-reviewer", model: "antigravity/gemini-3.8-flash", level: "max", source: "model-suffix" },
			(m) => warns.push(m),
			{ agentDir },
		)).toBe("max");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("NOT supported");
		expect(warns[0]).toContain("antigravity/gemini-3.8-flash:max");
	});

	it("one-time-per-process: the second identical contradiction is silent (P8)", () => {
		const warns: string[] = [];
		const warn = (m: string) => warns.push(m);
		clampThinkingForDispatch({ agent: "a", model: "antigravity/gemini-3.8-flash", level: "max", source: "inherited" }, warn, { agentDir });
		clampThinkingForDispatch({ agent: "b", model: "antigravity/gemini-3.8-flash", level: "max", source: "inherited" }, warn, { agentDir });
		expect(warns).toHaveLength(1);
	});

	it("strips a known :level suffix from the model before the provider/model split", () => {
		const warns: string[] = [];
		expect(clampThinkingForDispatch(
			{ agent: "requirements-reviewer", model: "antigravity/gemini-3.8-flash:high", level: "max", source: "inherited" },
			(m) => warns.push(m),
			{ agentDir },
		)).toBe("high");
	});

	it("no provider/model split (bare id) and missing catalogs change nothing", () => {
		const warns: string[] = [];
		const warn = (m: string) => warns.push(m);
		expect(clampThinkingForDispatch({ agent: "a", model: "bare-model", level: "max", source: "inherited" }, warn, { agentDir })).toBe("max");
		expect(clampThinkingForDispatch({ agent: "a", model: undefined, level: "max", source: "inherited" }, warn, { agentDir })).toBe("max");
		expect(clampThinkingForDispatch({ agent: "a", model: "no-prov/no-model", level: "max", source: "inherited" }, warn, { agentDir })).toBe("max");
		expect(warns).toHaveLength(0);
	});
});

// ─── runAgentViaDelegation wiring (fixture catalog via PI_CODING_AGENT_DIR) ──

/** A fake pi EventBus letting tests reply to the emitted request (the
 *  delegation-backend.test.ts FakeBus, trimmed to what this file needs). */
class FakeBus implements DelegationEventBus {
	readonly emitted: Array<{ channel: string; payload: unknown }> = [];
	private readonly bus = new EventEmitter();
	on(channel: string, handler: (payload: unknown) => void): unknown {
		this.bus.on(channel, handler);
		return () => { this.bus.off(channel, handler); };
	}
	emit(channel: string, payload: unknown): void {
		this.emitted.push({ channel, payload });
		this.bus.emit(channel, payload);
	}
	/** Test-side helper: deliver a payload as if pi-subagents emitted it. */
	deliver(channel: string, payload: unknown): void {
		this.bus.emit(channel, payload);
	}
	/** Test-side helper: the most recent payload emitted on a channel. */
	last(channel: string): unknown {
		for (let i = this.emitted.length - 1; i >= 0; i--) {
			if (this.emitted[i].channel === channel) return this.emitted[i].payload;
		}
		return undefined;
	}
}

function baseOpts(overrides: Record<string, unknown> = {}): Parameters<typeof runAgentViaDelegation>[0] {
	return {
		agent: "requirements-reviewer",
		prompt: "Review the requirements.",
		cwd: process.cwd(),
		id: "pipeline.stage2b.req.a1",
		ownerRunId: "spec-26",
		events: undefined as unknown as DelegationEventBus,
		...overrides,
	} as Parameters<typeof runAgentViaDelegation>[0];
}

/** Drive one delegation call to completion; return the emitted request + progress lines. */
async function dispatchOnce(overrides: Record<string, unknown>): Promise<{ req: DelegationRequestPayload; progress: string[]; result: SpawnResult }> {
	const bus = new FakeBus();
	const progress: string[] = [];
	const onProgress: AgentProgress = { event: (m) => progress.push(m), text: () => {} };
	const pending = runAgentViaDelegation(baseOpts({ events: bus, onProgress, ...overrides }) as Parameters<typeof runAgentViaDelegation>[0]);
	await Promise.resolve();
	const req = bus.last("prompt-template:subagent:request") as DelegationRequestPayload;
	bus.deliver("prompt-template:subagent:response", {
		requestId: req.requestId,
		ownerRunId: req.ownerRunId,
		nodeId: req.nodeId,
		status: "completed",
		model: req.model,
		result: { kind: "text", text: "ok" },
	});
	const result = await pending;
	return { req, progress, result };
}

describe("runAgentViaDelegation — thinking clamp wiring", () => {
	const OLD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	beforeEach(() => { process.env.PI_CODING_AGENT_DIR = agentDir; });
	afterEach(() => {
		if (OLD_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = OLD_AGENT_DIR;
	});

	it("THE INCIDENT: inherited max on a max:null map dispatches clamped high with a named run-log notice", async () => {
		const { req, progress } = await dispatchOnce({
			model: "antigravity/gemini-3.8-flash",
			inheritedThinking: "max",
		});
		expect(req.thinking).toBe("high");
		expect(req.model).toBe("antigravity/gemini-3.8-flash");
		const notice = progress.find((m) => m.includes("clamped thinking max -> high"));
		expect(notice).toBeTruthy();
		expect(notice).toContain("run-2026-09-12T15-16-29-042Z");
	});

	it("config-supplied max (agentModels :max suffix) STAYS max + one-time WARN naming the consequence", async () => {
		configState.agentModels = { "requirements-reviewer": "antigravity/gemini-3.8-flash:max" };
		const first = await dispatchOnce({ model: "antigravity/gemini-3.8-flash", inheritedThinking: "medium" });
		expect(first.req.thinking).toBe("max");
		const warns = first.progress.filter((m) => m.includes("WARN thinking=max"));
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("antigravity/gemini-3.8-flash:max");
		// one-time-per-process: a second dispatch of the same contradiction is silent
		configState.agentModels = { "requirements-reviewer": "antigravity/gemini-3.8-flash:max" };
		const second = await dispatchOnce({ model: "antigravity/gemini-3.8-flash", inheritedThinking: "medium" });
		expect(second.req.thinking).toBe("max");
		expect(second.progress.filter((m) => m.includes("WARN thinking=max"))).toHaveLength(0);
	});

	it("no catalog for the model → the inherited level rides unchanged, no warnings", async () => {
		const { req, progress } = await dispatchOnce({
			model: "zai-coding-cn/glm-5.3",
			inheritedThinking: "max",
		});
		expect(req.thinking).toBe("max");
		expect(progress.filter((m) => m.includes("WARN") || m.includes("clamped thinking"))).toHaveLength(0);
	});

	it("a :level-suffixed model string still resolves provider/modelId for the clamp", async () => {
		const { req } = await dispatchOnce({
			model: "antigravity/gemini-3.8-flash:high",
			inheritedThinking: "max",
		});
		expect(req.thinking).toBe("high"); // inherited max clamped via the suffix-stripped lookup
	});

	it("role-tier levels clamp too (tiered reviewer on a model without its tier level)", async () => {
		// code-reviewer's role tier is "high"; a catalog whose map supports only
		// "low" clamps the tier level DOWN through medium to low (multi-step walk).
		writeFileSync(join(agentDir, "tierprov-model-catalog.json"), JSON.stringify({
			version: 1,
			checkedAt: Date.now(),
			models: [{ id: "low-only", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null } }],
		}));
		const { req, progress } = await dispatchOnce({
			agent: "code-reviewer",
			model: "tierprov/low-only",
		});
		expect(req.thinking).toBe("low");
		expect(progress.some((m) => m.includes("clamped thinking high -> low"))).toBe(true);
	});
});

describe("level order sanity (the downward walk's spine)", () => {
	it("THINKING_LEVELS stays ordered least→most effort", () => {
		expect([...THINKING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

// ─── runWorkflow e2e — LIVE delegation clamp path (fix-round ADVISORY-3/1) ────

/** A fake pi EventEmitter that ALSO plays the pi-subagents owner: every
 *  delegation request is answered (queueMicrotask — the wiring-harness
 *  pattern of tests/workflow-delegation-backend.test.ts, NOT a new harness). */
function ownerBus(): { bus: DelegationEventBus; requests: DelegationRequestPayload[] } {
	const requests: DelegationRequestPayload[] = [];
	const emitter = new EventEmitter();
	emitter.on(DELEGATION_REQUEST_EVENT, (req: DelegationRequestPayload) => {
		requests.push(req);
		queueMicrotask(() => {
			emitter.emit(DELEGATION_RESPONSE_EVENT, {
				requestId: req.requestId,
				ownerRunId: req.ownerRunId,
				nodeId: req.nodeId,
				status: "completed",
				model: req.model,
				result: { kind: "text", text: "ok" },
			});
		});
	});
	return { bus: emitter as unknown as DelegationEventBus, requests };
}

function e2eSetupStage(specDir: string): Stage {
	return {
		id: "setup",
		label: "Setup",
		async run(_state: PipelineState, _ctx: StageContext) {
			return { worktreePath: specDir, specDirectory: specDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "26-test", worktreeCreated: false, initializedRepo: false } as never;
		},
	};
}

/** ONE run of the thinnest full-workflow slice that reaches a REAL delegation
 *  dispatch: untiered reviewer, no config pins (configState cleared to
 *  DEFAULT_CONFIG by beforeEach), inherited thinking max, resolved model
 *  pinned via the global model option to the fixture-catalog provider. */
async function runClampedReview(): Promise<{ requests: DelegationRequestPayload[]; lines: string[] }> {
	const d = mkdtempSync(join(tmpdir(), "sd-e2eclamp-"));
	const lines: string[] = [];
	const { bus, requests } = ownerBus();
	try {
		const agentStage: Stage = {
			id: "review",
			label: "Review",
			async run(_s: PipelineState, ctx: StageContext) {
				await ctx.agent({ id: "pipeline.review.req", agent: "requirements-reviewer", prompt: "review the requirements" });
				return {} as never;
			},
		};
		const wf: Workflow = { id: "t", root: sequence([task(e2eSetupStage(d)), task(agentStage)]) } as unknown as Workflow;
		await runWorkflow(wf, "t", {
			maxAgents: 2,
			events: bus,
			model: "antigravity/gemini-3.8-flash",
			inheritedThinking: "max",
			progress: {
				phase: () => {},
				log: (m: string) => lines.push(m),
				text: () => {},
			} as never,
		});
		return { requests, lines };
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

const CLAMP_NOTICE = "clamped thinking max -> high";

describe("runWorkflow e2e — live delegation clamp (ADVISORY-3) + per-run notice reset (ADVISORY-1)", () => {
	const OLD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	beforeEach(() => { process.env.PI_CODING_AGENT_DIR = agentDir; });
	afterEach(() => {
		if (OLD_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = OLD_AGENT_DIR;
	});

	it("ADVISORY-3: untiered reviewer + inherited max + fixture max:null catalog → request thinking=high, pre-clamp label AND clamp notice in the run log", async () => {
		const { requests, lines } = await runClampedReview();
		const req = requests.find((r) => r.agent === "sd-requirements-reviewer");
		expect(req).toBeTruthy();
		// the DISPATCH truth: the request carries the clamped level
		expect(req!.thinking).toBe("high");
		expect(req!.model).toBe("antigravity/gemini-3.8-flash");
		// the honesty contract: the start-log label prints the PRE-CLAMP resolved
		// level ("max") and the clamp notice names the dispatch adjustment
		const start = lines.find((l) => l.includes(": start agent=requirements-reviewer") && l.includes("backend=pi-subagents"));
		expect(start).toBeTruthy();
		expect(start).toContain("thinking=max");
		expect(lines.some((l) => l.includes(CLAMP_NOTICE))).toBe(true);
	});

	it("ADVISORY-1: a SECOND run in the same process re-emits the clamp notice (per-run reset at runWorkflow start)", async () => {
		const first = await runClampedReview();
		const second = await runClampedReview();
		expect(first.lines.some((l) => l.includes(CLAMP_NOTICE))).toBe(true);
		// without the per-run reset the process-wide memo would silence run 2 —
		// the adversarial finding: run 2+ logged thinking=max with zero notices
		expect(second.lines.some((l) => l.includes(CLAMP_NOTICE))).toBe(true);
	});
});
