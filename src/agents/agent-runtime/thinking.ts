import { piAgentDir } from "./extensions.ts";
import { isCodeWritingAgent } from "./config-extensions.ts";
/** thinking — thinking tiers, config overrides, and the model-catalog clamp. Split from agent-runtime.ts at v0.4.17d. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getConfig, superDevEnv, type ToolBudgetValue } from "../../render/super-dev-dir.ts";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { sanitizeSlug } from "../../setup.ts";
import {
	createAgentSession,
	defineTool,
	getAgentDir,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// ─── Per-agent thinking configuration ────────────────────────────────────────

/** The model thinking/reasoning levels understood by pi's `--thinking` flag and
 *  `session.setThinkingLevel`. Ordered least→most effort. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Reasoning-heavy analysis agents: worth the extra token/latency cost of a
 *  high thinking budget because their deliverable is judgement/analysis.
 *  v0.3.95: the four untiered reviewers (requirements/spec/bdd/design-reviewer)
 *  are DELIBERATELY absent — the catalog clamp (clampThinkingForDispatch)
 *  supersedes the postmortem §5.2 tiering candidate by guarding every
 *  heuristic-source level at the model interface while keeping session
 *  inheritance. Do not naively add them here. */
const REASONING_AGENTS = new Set([
	"design",
	"spec-writer",
	"adversarial-reviewer",
	"code-reviewer",
	"debug",
	"debugger",
	"assessment",
	// v0.3.43: judge verdicts are pure analysis (diagnosis + routing) — tiered
	// HIGH so a `:max` parent session cannot inflate them either.
	"judge",
]);

/** Mechanical bookkeeping agents: little reasoning needed (commits, cleanup,
 *  slug summarization), so they think minimally to stay fast/cheap. */
const MECHANICAL_AGENTS = new Set([
	"commit",
	"orchestrator-commit",
	"cleanup",
	"slug",
	"slug-summarizer",
]);

/** v0.3.43 throughput root cause (run-pair forensics 2026-08-30): binary/small
 *  classification roles were running at the INHERITED main-session thinking
 *  level and emitting 3.6-4K output tokens for yes/no verdicts (12 boundary
 *  classifier calls = 43K tokens; 28 coverage calls = 113K). Classification
 *  needs LOW thinking — the deterministic oracle + downstream gates are the
 *  real guards; the classifier only triages. */
const CLASSIFIER_AGENTS = new Set([
	"tdd-coverage-classifier",
	"red-boundary-classifier",
	"task-classifier",
	"route-specialist",
]);

/** Role-based default thinking level for an agent, mirroring isCodeWritingAgent.
 *  Reasoning-heavy analysis agents think hard; code writers think medium;
 *  classifier triage thinks low; mechanical bookkeeping agents think minimally;
 *  everything else defaults to medium. */
export function thinkingForAgent(agent: string): ThinkingLevel {
	if (REASONING_AGENTS.has(agent)) return "high";
	if (isCodeWritingAgent(agent)) return "medium";
	if (CLASSIFIER_AGENTS.has(agent)) return "low";
	if (MECHANICAL_AGENTS.has(agent)) return "minimal";
	return "medium";
}

/** Does this agent carry an EXPLICIT throughput tier (reasoning / code-writing /
 *  classifier / mechanical)? Tiered roles keep their designed level even when a
 *  main-session thinking level is inherited — the v0.3.43 root-cause fix. A
 *  `:max` parent session must not silently turn a yes/no classifier or a git
 *  committer into a max-effort reasoner: measured effect on the 2026-08-30 run
 *  pair was ~1.5M of 2.36M output tokens (≈10 wall-clock hours across two runs)
 *  spent on thinking inflation that the role tiers were designed to prevent. */
export function hasThinkingTier(agent: string): boolean {
	return REASONING_AGENTS.has(agent) || isCodeWritingAgent(agent) || CLASSIFIER_AGENTS.has(agent) || MECHANICAL_AGENTS.has(agent);
}

/** Narrow an arbitrary string to a ThinkingLevel (used for the env override). */
function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	return value && (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}

/** v0.3.45: split a trailing `:level` thinking suffix off a model string
 * ("zai-coding-cn/glm-5.3:high" → model "zai-coding-cn/glm-5.3", thinking "high").
 * The suffix only splits on a VALID ThinkingLevel word, so model ids that
 * merely contain a colon ("provider/model:latest") stay intact. Exported for
 * resolveAgentModel (which must send the BARE model id on every call) and the
 * per-call seam in workflow.ts. */
export function splitModelThinking(raw: string | undefined): { model: string; thinking: ThinkingLevel | undefined } {
	const s = raw?.trim();
	if (!s) return { model: "", thinking: undefined };
	const idx = s.lastIndexOf(":");
	if (idx <= 0 || idx === s.length - 1) return { model: s, thinking: undefined };
	const thinking = asThinkingLevel(s.slice(idx + 1).trim().toLowerCase());
	if (!thinking) return { model: s, thinking: undefined };
	return { model: s.slice(0, idx), thinking };
}

/** v0.3.45: per-agent thinking override embedded as a `:level` suffix on the
 * config.agentModels entry ("zai-coding-cn/glm-5.3:high" — set model and
 * thinking together). Same lazy-read pattern as agentThinkingFromConfig;
 * the DEDICATED agentThinking map wins when both are set (the suffix is
 * colocated sugar, not a second opinion channel). */
export function agentModelThinkingFromConfig(agent: string, map?: Record<string, string>): ThinkingLevel | undefined {
	const source =
		map ??
		(() => {
			try {
				return getConfig().agentModels;
			} catch {
				return undefined;
			}
		})();
	if (!source) return undefined;
	return splitModelThinking(source[agent]).thinking;
}

/** v0.3.44: per-agent thinking override from config.json (`agentThinking`).
 *  Lazily read per call (the superDevEnv pattern) so config edits apply to
 *  later dispatches without a process restart; the optional `map` param keeps
 *  this unit-testable without touching the real ~/.super-dev/config.json.
 *  Invalid levels are ignored — a typo falls back to tier behavior, not a
 *  crash. */
export function agentThinkingFromConfig(agent: string, map?: Record<string, string>): ThinkingLevel | undefined {
	const source =
		map ??
		(() => {
			try {
				return getConfig().agentThinking;
			} catch {
				return undefined;
			}
		})();
	if (!source) return undefined;
	return asThinkingLevel(source[agent]?.trim());
}

/** Resolve the effective thinking level with precedence (v0.3.43 reordered,
 *  v0.3.44 adds the config tier; v0.3.45 adds the agentModels `:level`
 *  suffix at the SAME config tier):
 *  per-call override → SUPER_DEV_THINKING env → config.agentThinking[role] →
 *  config.agentModels[role] `:level` suffix →
 *  ROLE TIER (for explicitly tiered agents) → INHERITED main-session level →
 *  "medium" fallback.
 *
 *  The ROLE TIER sits ABOVE the inherited level for TIERED roles. The previous
 *  order (inherited above role defaults, SCENARIO-006) let a parent session
 *  running `:max` propagate max thinking to EVERY specialist — classifiers,
 *  committers, everyone — measured as the #1 latency root cause (thinking
 *  tokens were 50-85% of specialist output). Explicit control is preserved:
 *  per-call and SUPER_DEV_THINKING still override everything, UNTIERED agents
 *  keep inheriting the main-session level exactly as before, and a
 *  config.agentThinking entry beats the built-in tier for its role (tuning a
 *  role is the point of the config — e.g. raise implementer to "high" for a
 *  hard codebase, or drop a reviewer to "low" for a cheap one).
 *
 *  v0.3.95 FIX B2 (run-2026-09-12T15-16-29-042Z): the grammar now has TWO
 *  faces over ONE resolution path (P6). `resolveThinkingDetailed` also names
 *  the SOURCE tier that supplied the level — the provenance the delegation
 *  backend keys its model-catalog clamp ruling on (config/explicit intent
 *  dispatches as-is with a one-time WARN; role-tier / inherited / default
 *  levels clamp down to what the model supports). `resolveThinking` (below)
 *  stays the level-only thin wrapper every existing consumer uses. */
export type ThinkingSource =
	| "per-call"
	| "env"
	| "agent-thinking"
	| "model-suffix"
	| "role-tier"
	| "inherited"
	| "medium-default";

export interface ResolvedThinking {
	level: ThinkingLevel;
	source: ThinkingSource;
}

/** The detailed face of the thinking grammar: resolves the level AND names
 *  which tier supplied it (precedence order documented above, with the
 *  history). */
export function resolveThinkingDetailed(agent: string, perCall?: ThinkingLevel, inherited?: ThinkingLevel): ResolvedThinking {
	if (perCall) return { level: perCall, source: "per-call" };
	const env = asThinkingLevel(superDevEnv("SUPER_DEV_THINKING"));
	if (env) return { level: env, source: "env" };
	const cfg = agentThinkingFromConfig(agent);
	if (cfg) return { level: cfg, source: "agent-thinking" };
	const modelSuffix = agentModelThinkingFromConfig(agent);
	if (modelSuffix) return { level: modelSuffix, source: "model-suffix" };
	if (hasThinkingTier(agent)) return { level: thinkingForAgent(agent), source: "role-tier" };
	if (inherited) return { level: inherited, source: "inherited" };
	return { level: "medium", source: "medium-default" };
}

/** The level-only face of the SAME grammar (P6: one resolution path, two
 *  faces) — the thin wrapper every pre-v0.3.95 consumer uses. */
export function resolveThinking(agent: string, perCall?: ThinkingLevel, inherited?: ThinkingLevel): ThinkingLevel {
	return resolveThinkingDetailed(agent, perCall, inherited).level;
}

// ─── v0.3.95 FIX B2: thinking clamp to the model catalog ────────────────────

/** Outcome of clamping a thinking level against a model's supported levels.
 *  - source "catalog": a supported-level signal was found (provider catalog
 *    file or a models.json/models-store.json entry) — `clamped` is true
 *    exactly when the requested level moved to the NEAREST supported level
 *    (bidirectional distance over THINKING_LEVELS, ties → lower).
 *  - source "unknown": nothing was found — NO clamp (fail-open; today's
 *    behavior — can't know, don't guess). Never throws (P5). */
export interface ThinkingClampOutcome {
	level: ThinkingLevel;
	clamped: boolean;
	source: "catalog" | "unknown";
}

/** JSON.parse guarded to undefined (any read/parse failure is "no data
 *  found", never a crash). */
function readJsonOrUndefined(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** A container shaped `{ models: [...] | { <modelId>: ... } }` → the entry for
 *  `modelId`, or undefined. The live antigravity catalog stores models as an
 *  ARRAY of `{ id, ... }` objects; the models.json/models-store.json shape is
 *  the same array under a provider key. An object-keyed `models` map is
 *  accepted too (defensive: both shapes name the model unambiguously). */
function modelEntryFrom(container: unknown, modelId: string): { id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown } | undefined {
	if (!container || typeof container !== "object") return undefined;
	const models = (container as { models?: unknown }).models;
	let entry: unknown;
	if (Array.isArray(models)) {
		entry = models.find((m) => !!m && typeof m === "object" && (m as { id?: unknown }).id === modelId);
	} else if (models && typeof models === "object") {
		entry = (models as Record<string, unknown>)[modelId];
	}
	return entry && typeof entry === "object" ? (entry as { id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown }) : undefined;
}

/** Narrow an unknown value to a thinkingLevelMap: a non-array object carrying
 *  at least one THINKING_LEVELS key (a random object with unrelated keys is
 *  not a map). */
function asThinkingLevelMap(value: unknown): Partial<Record<ThinkingLevel, string | null>> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	return THINKING_LEVELS.some((level) => level in obj) ? (obj as Partial<Record<ThinkingLevel, string | null>>) : undefined;
}

/** The model's SUPPORTED thinking levels per the pi-ai convention
 *  (@earendil-works/pi-ai README, "model-level thinkingLevelMap"; mirrored
 *  from pi-subagents src/shared/model-info.ts getSupportedThinkingLevels so
 *  super-dev's notion of "supported" matches what dispatch accepts):
 *  - `reasoning: false` models support only `off` — AUTHORITATIVE, checked
 *    BEFORE the map (fix-round BLOCKING-1: production non-reasoning models
 *    like gpt-4o / haiku declare reasoning:false WITHOUT any thinkingLevelMap,
 *    so a map-first check made the branch unreachable and left an inherited
 *    "max" on such models unguarded — the exact 5h-exclusion crash class);
 *  - `null` marks a level unsupported;
 *  - missing standard levels through `high` use provider defaults (supported);
 *  - `xhigh` and `max` are opt-in — they require a non-null map entry.
 *  Returns undefined when NO source yields either signal (the caller must
 *  then NOT clamp — unknown ≠ unsupported).
 *  Source priority: (1) `<agentDir>/<provider>-model-catalog.json` (any
 *  provider, e.g. the live antigravity file); (2) models-store.json;
 *  (3) models.json (`providers.<provider>.models`). Fix-round ADVISORY-2: a
 *  source whose entry carries NO usable thinkingLevelMap (and no
 *  reasoning:false) is TRANSPARENT — the lookup falls through to the next
 *  source instead of shadowing a lower-priority source that DOES carry a
 *  map (mapless entry ≠ empty-supported). */
function supportedThinkingLevels(provider: string, modelId: string, agentDir: string): Set<ThinkingLevel> | undefined {
	const sources: Array<() => { reasoning?: unknown; thinkingLevelMap?: unknown } | undefined> = [
		() => modelEntryFrom(readJsonOrUndefined(join(agentDir, `${provider}-model-catalog.json`)), modelId),
		() => {
			const store = readJsonOrUndefined(join(agentDir, "models-store.json"));
			return store && typeof store === "object" && !Array.isArray(store)
				? modelEntryFrom((store as Record<string, unknown>)[provider], modelId)
				: undefined;
		},
		() => {
			const modelsJson = readJsonOrUndefined(join(agentDir, "models.json"));
			const providers = modelsJson && typeof modelsJson === "object" ? (modelsJson as { providers?: unknown }).providers : undefined;
			return providers && typeof providers === "object"
				? modelEntryFrom((providers as Record<string, unknown>)[provider], modelId)
				: undefined;
		},
	];
	for (const source of sources) {
		const entry = source();
		if (!entry) continue;
		// BLOCKING-1: reasoning:false wins even without a map (pi docs/models.md
		// :204) — do NOT fall through past it.
		if (entry.reasoning === false) return new Set<ThinkingLevel>(["off"]);
		const map = asThinkingLevelMap(entry.thinkingLevelMap);
		if (!map) continue; // ADVISORY-2: entry found but mapless → transparent, try the next source
		const out = new Set<ThinkingLevel>();
		for (const level of THINKING_LEVELS) {
			const mapped = map[level];
			if (mapped === null) continue; // explicitly unsupported
			if (mapped === undefined && (level === "xhigh" || level === "max")) continue; // opt-in only
			out.add(level); // present (or a hole ≤ high) → provider default applies
		}
		return out;
	}
	return undefined;
}

/** Clamp a thinking level to the NEAREST level the model supports (vocabulary
 *  walking THINKING_LEVELS from `level` toward `off`. The crash class this
 *  prevents (run-2026-09-12T15-16-29-042Z): an inherited "max" on a model
 *  whose thinkingLevelMap maps max→null dispatches the suffixed id
 *  "provider/model:max", the provider rejects it ("Model not found"), and the
 *  failure is cached as a 5h model exclusion poisoning every later dispatch.
 *  When the map supports NOTHING at-or-below `level`, the original level is
 *  returned unclamped (P5 fail-open — no better option is knowable).
 *  `opts.agentDir` defaults to the pi agent dir and exists purely for fixture
 *  injection in tests. Never throws. */
export function clampThinkingToModel(provider: string, modelId: string, level: ThinkingLevel, opts?: { agentDir?: string }): ThinkingClampOutcome {
	let supported: Set<ThinkingLevel> | undefined;
	try {
		supported = supportedThinkingLevels(provider, modelId, opts?.agentDir ?? piAgentDir());
	} catch {
		return { level, clamped: false, source: "unknown" }; // P5: the clamp never throws
	}
	if (!supported) return { level, clamped: false, source: "unknown" };
	if (supported.has(level)) return { level, clamped: false, source: "catalog" };
	// v0.3.95 owner ruling: "choose a SIMILAR one" = the NEAREST supported level
	// by THINKING_LEVELS distance, in EITHER direction (a hole right below must
	// not blind the clamp to a supported level right above — the strict
	// downward walk missed minimal→low on {off:null, minimal:null}); equal
	// distance resolves to the LOWER level (conservative: under-thinking beats
	// over-thinking for cost and provider compatibility).
	const idx = THINKING_LEVELS.indexOf(level);
	let bestIdx = -1;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < THINKING_LEVELS.length; i++) {
		if (!supported.has(THINKING_LEVELS[i])) continue;
		const d = Math.abs(i - idx);
		if (d < bestDist) { bestIdx = i; bestDist = d; }
	}
	if (bestIdx === -1) return { level, clamped: false, source: "catalog" }; // no supported level anywhere — fail open
	return { level: THINKING_LEVELS[bestIdx], clamped: true, source: "catalog" };
}

/** Resolve the EXPLICIT-OR-INHERITED thinking level (per-call → SUPER_DEV_THINKING
 *  env → INHERITED) WITHOUT the role-default fallback. Used to decide whether a
 *  thinking level is worth threading at all: it reaches the delegation request
 *  ONLY when an explicit per-call / SUPER_DEV_THINKING / inherited value
 *  resolves, so the byte-identical baseline (no thinking field, SCENARIO-002)
 *  is preserved when none does. The role default stays resolveThinking's
 *  concern, never an explicit creation option. */
export function resolveExplicitThinking(perCall?: ThinkingLevel, inherited?: ThinkingLevel): ThinkingLevel | undefined {
	if (perCall) return perCall;
	const env = asThinkingLevel(superDevEnv("SUPER_DEV_THINKING"));
	if (env) return env;
	return inherited;
}

/** Resolve an EXPLICIT model id with precedence: explicit param → SUPER_DEV_MODEL
 *  env → undefined. The INHERITED main-session model is NOT handled here — it is
 *  an object threaded separately (inheritedModelObject) and derived into a
 *  qualified `provider/id` in the delegation request. Returns undefined when no
 *  explicit tier supplies a value (SCENARIO-003/004 — preserves the
 *  no-default rule). */
export function resolveModel(explicit?: string): string | undefined {
	const ex = explicit?.trim();
	if (ex) return ex;
	const env = superDevEnv("SUPER_DEV_MODEL")?.trim();
	return env || undefined;
}
