import { needsWebResearch } from "./extensions.ts";
import { isCodeWritingAgent } from "./config-extensions.ts";
import { ThinkingLevel } from "./thinking.ts";
/** runtime — timeouts, skill curation, display helpers, slug summarization. Split from agent-runtime.ts at v0.4.17d. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
// ─── Timeouts, skills, lifecycle ─────────────────────────────────────────────

/** Per-spawn wall-clock cap. 20 min: big-spec writers (46+ scenarios) spend
 *  ~70% re-verifying anchors then run out of the 480s budget mid-compose —
 *  the timeout discards the whole structured_output (run 2026-08-23T00-59-32
 *  rounds 2/4). Aligned with CODE_WRITING_TIMEOUT_MS so every role gets 20 min. */
const DEFAULT_SPAWN_TIMEOUT_MS = 1_200_000;
/** Code-writing agents (implementer/tdd-guide) must read large existing files
 *  AND land+verify edits in one turn; on a slow model the doc-writer cap aborts
 *  them mid-exploration before any edit is written. Give them ~30 min — 20
 *  aborted two healthy writers on 2026-08-30 (AQ phase-02 commit orchestrator,
 *  CC phase-03 implementer on glm-5.3:max thinking), each costing the full
 *  window plus a recovery round. */
const CODE_WRITING_TIMEOUT_MS = 1_800_000;
/** v0.3.73 M4 (run 2026-09-05T23-09-55-596Z): reviewer roles need the same
 * headroom as code writers — seven exact-20:00 delegation timeouts in one
 * healthy run (spec-reviewer ×3, verify code-review ×2, adversarial ×1,
 * tests-review ×1) while completions ran 11–19.5 min. 20 min has zero margin
 * for review roles; 30 min matches the observed worst case (19m29s) plus ~50%
 * headroom. */
const REVIEW_TIMEOUT_MS = 1_800_000;

/** v0.3.73 M4: analytical review roles whose deliverable is a verdict over a
 * large artifact. Mirrors READ_ONLY_AGENTS' reviewer subset. */
const REVIEW_TIMEOUT_AGENTS = new Set([
	"code-reviewer",
	"adversarial-reviewer",
	"spec-reviewer",
	"requirements-reviewer",
	"bdd-reviewer",
	"design-reviewer",
]);

/** v0.3.84 (incident 2026-09-08T23-27-36-732Z): spec-writer produces THREE
 *  docs in one call (spec + implementation plan + task list; observed 62KB)
 *  and ran at 90-100% utilization of the 20-min default — 3 of 5 rounds died
 *  at exactly 1200s (one completion took 1082.9s). 30 min = worst observed
 *  completion + 50% headroom, the same calibration as the v0.3.73 M4 review
 *  tier. Surgical on evidence: other doc writers completed comfortably inside
 *  20 min in every observed run, so they stay on the default tier. */
const WRITER_TIMEOUT_MS = 1_800_000;
const HEAVY_WRITER_TIMEOUT_AGENTS = new Set(["spec-writer"]);

/** AC-23 (SCENARIO-049): SIGTERM → SIGKILL watchdog. A child that registered a
 *  SIGTERM handler and never exits (or whose grandchildren hold the stdio
 *  pipes) must not hold the run hostage — after this grace the ladder escalates
 *  to an uncatchable SIGKILL. */
export const SIGTERM_GRACE_MS = 10_000;

/** The default wall-clock cap for an agent, by role. Overridable per-call via
 *  AgentCall.timeoutMs (threaded through `common` in workflow.ts). */
/**
 * v0.3.74 P1-c (M4 design gap, run 2026-09-05T23-09-55-596Z: 7 reviewer
 * delegations died at exactly 20:00 because the tiers were hardcoded constants
 * with no operator knob — recalibrating for a slower model required a code
 * change and an extension reload). Each tier reads its env key per call
 * (superDevEnv reads process.env directly, so edits apply to new calls without
 * a restart, matching the fuse precedent). A positive finite number overrides
 * the tier constant; garbage is rejected LOUDLY (one WARN per variable per
 * process, v0.3.72 M3 loud-fallback convention) and the run proceeds on the
 * tier default.
 */
const timeoutWarned: Record<"code" | "review" | "writer" | "default", boolean> = { code: false, review: false, writer: false, default: false };
function timeoutTierMs(kind: "code" | "review" | "writer" | "default", envKey: string, fallback: number): number {
	const raw = superDevEnv(envKey);
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	// v0.3.74 dual review F6: a sub-second value is a unit mistake (seconds
	// typed as ms), never an intentional agent timeout — treat it as garbage.
	if (Number.isFinite(n) && n >= 1_000) return n;
	if (!timeoutWarned[kind]) {
		timeoutWarned[kind] = true;
		console.warn(`[super-dev] ${envKey}=${JSON.stringify(raw)} is not a positive number of milliseconds — keeping the tier default ${fallback}ms (set e.g. ${envKey}=1800000; this warning appears once per variable per process)`);
	}
	return fallback;
}

let legacyDefaultTierWarned = false;
/** v0.3.94 deprecated alias: SUPER_DEV_DEFAULT_TIMEOUT_MS → SUPER_DEV_AGENT_DEFAULT_TIMEOUT_MS. */
function legacyDefaultTierTimeoutMs(fallback: number): number {
	const raw = superDevEnv("SUPER_DEV_DEFAULT_TIMEOUT_MS");
	if (raw === undefined || raw === "") return fallback;
	if (!legacyDefaultTierWarned) {
		legacyDefaultTierWarned = true;
		console.warn(`[super-dev] SUPER_DEV_DEFAULT_TIMEOUT_MS is DEPRECATED — rename it to SUPER_DEV_AGENT_DEFAULT_TIMEOUT_MS in your config/env (the old key still works; this warning appears once per process)`);
	}
	const n = Number(raw);
	if (Number.isFinite(n) && n >= 1_000) return n;
	if (!timeoutWarned["default"]) {
		timeoutWarned["default"] = true;
		console.warn(`[super-dev] SUPER_DEV_DEFAULT_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive number of milliseconds — keeping the tier default ${fallback}ms (this warning appears once per process)`);
	}
	return fallback;
}

export function defaultAgentTimeoutMs(agent: string): number {
	if (isCodeWritingAgent(agent)) return timeoutTierMs("code", "SUPER_DEV_CODE_TIMEOUT_MS", CODE_WRITING_TIMEOUT_MS);
	if (REVIEW_TIMEOUT_AGENTS.has(agent)) return timeoutTierMs("review", "SUPER_DEV_REVIEW_TIMEOUT_MS", REVIEW_TIMEOUT_MS);
	if (HEAVY_WRITER_TIMEOUT_AGENTS.has(agent)) return timeoutTierMs("writer", "SUPER_DEV_WRITER_TIMEOUT_MS", WRITER_TIMEOUT_MS);
	// v0.3.94 rename (scope-ambiguity fix): the default TIER keys off
	// SUPER_DEV_AGENT_DEFAULT_TIMEOUT_MS — "DEFAULT" alone read as a run-level
	// knob next to SUPER_DEV_MAX_RUN_WALL_MS (user confusion, 2026-09-11). The
	// old key stays honored as a deprecated alias with a one-time WARN
	// (v0.3.86 F-17 rename-with-alias precedent); new key wins when both are set.
	return timeoutTierMs("default", "SUPER_DEV_AGENT_DEFAULT_TIMEOUT_MS", legacyDefaultTierTimeoutMs(DEFAULT_SPAWN_TIMEOUT_MS));
}

/** W4 (v0.2.10): skills are a CAPABILITY, not ambient noise — v0.3.59: ONE
 *  switch governs skills across every specialist surface (now: the sd-*
 *  registration's inheritSkills). `SUPER_DEV_NO_SKILLS=1` restores the
 *  pre-v0.2.10 full isolation for debugging/CI. */
export function skillsEnabled(env: { SUPER_DEV_NO_SKILLS?: string } = {
	SUPER_DEV_NO_SKILLS: superDevEnv("SUPER_DEV_NO_SKILLS"),
}): boolean {
	return env.SUPER_DEV_NO_SKILLS !== "1";
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function compactArg(value: unknown, max = 180): string {
	const s = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function firstArg(args: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (value !== undefined && value !== null && String(value).trim()) return compactArg(value);
	}
	return "";
}

/** One-line summary of a tool call for progress logs (name + key arg). */
export function summarizeToolCall(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (name) {
		case "write":
		case "edit":
		case "read":
			return `${name} ${a.path ?? a.file_path ?? ""}`;
		case "bash":
			return `$ ${String(a.command ?? "")}`;
		case "ffgrep":
		case "fffind":
			return `${name} "${a.pattern ?? ""}"`;
		case "web_search": {
			const query = firstArg(a, ["query", "q", "search", "term"]);
			return query ? `${name} query="${query}"` : name;
		}
		case "fetch_content": {
			const url = firstArg(a, ["url", "uri", "link"]);
			return url ? `${name} url="${url}"` : name;
		}
		case "get_search_content": {
			const id = firstArg(a, ["id", "resultId", "contentId"]);
			const url = firstArg(a, ["url", "uri", "link"]);
			const query = firstArg(a, ["query", "q"]);
			const detail = id ? `id="${id}"` : url ? `url="${url}"` : query ? `query="${query}"` : "";
			return detail ? `${name} ${detail}` : name;
		}
		default:
			return name;
	}
}

/** Shorten a path/string for display: cwd => ".", $HOME => "~". Keeps live
 *  progress readable instead of being truncated mid-path by the TUI. */
export function abbreviatePath(p: string, cwd?: string): string {
	if (!p) return p;
	let out = p;
	if (cwd && cwd.length > 1 && out.includes(cwd)) out = out.split(cwd).join(".");
	const home = process.env.HOME;
	if (home && out.startsWith(home)) out = "~" + out.slice(home.length);
	return out;
}

// ─── Live-session thinking application ───────────────────────────────────────

/** Best-effort apply a thinking level to a live AgentSession (Phase 2). Calls
 *  `session.setThinkingLevel(level)` guarded by try/catch so an older runtime
 *  that lacks the method (or a model that rejects the level) never breaks the
 *  run. No-ops when `level` is undefined. */
export function applyThinkingLevel(session: unknown, level: ThinkingLevel | undefined): void {
	if (level === undefined) return;
	try {
		const fn = (session as { setThinkingLevel?: unknown } | null | undefined)?.setThinkingLevel;
		if (typeof fn === "function") {
			(fn as (l: ThinkingLevel) => void).call(session, level);
		}
	} catch {
		/* best-effort: older runtimes may lack the method or clamp the level */
	}
}

// ─── Model-inheritance type ──────────────────────────────────────────────────

/** The `Model<any>` createAgentSession's `model` option expects, derived from
 *  its own typed signature so we never reach for the (transitive)
 *  @earendil-works/pi-ai Model type directly. */
export type SessionModelOption = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>;

// ─── Content-aware slug summarization (setup stage) ─────────────────────────

export function taskFilePaths(task: string): string[] {
	const out: string[] = [];
	const push = (raw: string) => {
		const s = raw.replace(/^[.,;:()\[\]"']+/g, "").replace(/[.,;:()\[\]"']+$/g, "");
		if (s && !out.includes(s)) out.push(s);
	};
	for (const m of task.matchAll(/@([\w.~/-]+\.[A-Za-z0-9]+)/g)) push(m[1]);
	for (const m of task.matchAll(/(?<!\w)(~\/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+)/g)) push(m[1]);
	for (const m of task.matchAll(/(?<![\w@~/.-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g)) push(m[1]);
	return out.slice(0, 4);
}

/** Bounded content excerpts of task-referenced files so the slug model can
 *  summarize WHAT the referenced requirement asks for instead of echoing its
 *  FILENAME (incident: `docs/requirements/16-dimension-financials.md` → LLM
 *  slug "16-dimension-financials" → spec id "16-16-dimension-financials").
 *  First ~6 KB per file (title/purpose lives up front), at most 3 files,
 *  unreadable/missing/directory references skipped silently. */
export function taskFileExcerpts(task: string, cwd: string): Array<{ path: string; excerpt: string }> {
	const out: Array<{ path: string; excerpt: string }> = [];
	for (const ref of taskFilePaths(task)) {
		if (out.length >= 3) break;
		const abs = ref.startsWith("~/") ? join(homedir(), ref.slice(2)) : isAbsolute(ref) ? ref : resolve(cwd, ref);
		let text: string;
		try {
			if (!statSync(abs).isFile()) continue;
			text = readFileSync(abs, "utf8");
		} catch { continue; }
		const excerpt = text.slice(0, 6000).trim();
		if (excerpt) out.push({ path: ref, excerpt });
	}
	return out;
}

/** Local capture shape for the slug structured_output tool. */
interface SlugCapture { called: boolean; value: unknown }

/** Ask the model for a concise 2-5 word kebab-case slug summarizing the task.
 *  When the task references files (requirement/design docs), their CONTENT is
 *  excerpted into the prompt so the slug describes the actual subject matter
 *  rather than echoing a filename — and index numerals are explicitly barred
 *  (the pipeline prepends its own number; a numeral echo produced the
 *  "16-16-dimension-financials" double-index spec id). Minimal in-process
 *  session (dev/setup utility — NOT the specialist pipeline): no coding tools,
 *  only a structured_output tool — fast and cheap. Returns "" on any
 *  failure/timeout so the caller can fall back to the deterministic
 *  slugifyTask. */
export async function summarizeSlug(task: string, cwd: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
	// SD-04 (NFR-6): pre-aborted signal — the post-creation listener would never
	// fire; skip the session entirely and let the caller use the deterministic
	// fallback slug.
	if (opts.signal?.aborted) return "";
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const capture: SlugCapture = { called: false, value: undefined };
	const agentDir = getAgentDir();
	let session;
	try {
		// Isolate the slug session identically to specialist sessions (#11): without
		// an explicit resourceLoader it would discover ambient extensions/skills from
		// the pi agent dir, inconsistent with the isolation contract every other
		// session honors. A slug generator needs none of them.
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			appendSystemPromptOverride: () => [],
			agentsFilesOverride: () => ({ agentsFiles: [] }),
		});
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			resourceLoader,
			customTools: [defineTool({
				name: "structured_output",
				label: "Slug",
				description: "Return the summary slug.",
				promptSnippet: "Return the slug",
				promptGuidelines: ["Call structured_output once with the slug."],
				parameters: Type.Object({ slug: Type.String() }),
				async execute(_id, params) { capture.value = params; capture.called = true; return { content: [{ type: "text", text: "ok" }], details: params, terminate: true }; },
			})],
		}));
	} catch {
		return "";
	}
	const timer = setTimeout(() => { try { void session.abort(); } catch { /* ignore */ } }, timeoutMs);
	const onAbort = () => void session.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	// SD-04 (NFR-6): close the registration window (abort landed during the
	// awaited session creation above) — the listener would never fire.
	if (opts.signal?.aborted) onAbort();
	try {
		const excerpts = taskFileExcerpts(task, cwd);
		const fileContext = excerpts.length === 0
			? ""
			: `\nReferenced files (content excerpts — derive the subject from this CONTENT, never from file names):\n${excerpts.map((f) => `--- ${f.path} ---\n${f.excerpt}`).join("\n\n")}\n`;
		await session.prompt(`Summarize this software task into a concise 2-5 word kebab-case slug (lowercase, words joined by single hyphens, no articles or filler words like "implement/add/feature").\nRules:\n- Name WHAT the work delivers, based on the task text and the CONTENT of the referenced files below — do not echo file or directory names.\n- Never include index or sequence numbers (the pipeline prepends its own number to the spec id); keep an identifier only if it is genuinely part of the feature name in the task text.\nTask:\n"""${task}"""\n${fileContext}Call structured_output with {slug}.`);
	} catch { /* timeout/abort → fallback */ }
	clearTimeout(timer);
	opts.signal?.removeEventListener("abort", onAbort);
	session.dispose();
	const raw = capture.called ? String((capture.value as { slug?: unknown })?.slug ?? "") : "";
	return sanitizeSlug(raw);
}

// ─── v0.3.76 skill curation (L0 + L1; approved 2026-09-07) ───────────────────
// The catalog DATA lives in the zero-import leaf ./skill-domains.ts (see that
// file for why: an import edge prompts → agent-runtime corrupts v8 coverage
// attribution). Re-exported here so consumers keep one canonical import site.
export { MECHANICAL_CLASSIFIER_ROLES, DEFAULT_RESEARCH_SKILLS, SKILL_DOMAINS } from "../skill-domains.ts";
export type { SkillDomainDescriptor } from "../skill-domains.ts";
import { MECHANICAL_CLASSIFIER_ROLES, DEFAULT_RESEARCH_SKILLS, SKILL_DOMAINS } from "../skill-domains.ts";

/** L3 escape hatch: `SUPER_DEV_SKILLS=ambient` restores today's full ambient
 * injection for EVERY role (opt-OUT of curation, not a forgotten opt-in —
 * the Option-C doctrine from v0.3.70 structured delegation). Dual-review
 * R3/AR-1 fix: resolves via superDevEnv (process.env > config.json env map —
 * the config channel is the ONLY one GUI-launched sessions have) and is
 * MEMOIZED on first use — registration snapshots the decision at activate
 * while skillsForCall consults it per call; one cached value keeps both
 * layers consistent even if config flips mid-run (registration cannot flip
 * back, so a per-call re-read would silently zero-card curated roles).
 * Deliberately distinct from SUPER_DEV_NO_SKILLS (v0.3.59). */
let ambientSkillsForcedMemo: boolean | null = null;
export function ambientSkillsForced(env?: { SUPER_DEV_SKILLS?: string }): boolean {
	if (env !== undefined) return String(env.SUPER_DEV_SKILLS ?? "").trim().toLowerCase() === "ambient";
	if (ambientSkillsForcedMemo === null) {
		ambientSkillsForcedMemo = String(superDevEnv("SUPER_DEV_SKILLS") ?? "").trim().toLowerCase() === "ambient";
	}
	return ambientSkillsForcedMemo;
}
export function resetAmbientSkillsForcedForTests(): void {
	ambientSkillsForcedMemo = null;
}

export function skillsForCall(
	role: string,
	opts: { agentSkills?: Record<string, false | string[]>; skillDomains?: string[] } = {},
): false | string[] | undefined {
	// Dual-review R2/AR-N3: NO_SKILLS=1 must mean ZERO cards on every layer
	// (its documented pre-v0.3.76 contract: full isolation for debugging/CI),
	// so it gates the per-call field too — it stays the top kill-switch.
	if (!skillsEnabled()) return false;
	if (ambientSkillsForced()) return undefined;
	const configured = opts.agentSkills?.[role];
	if (configured === false) return false;
	// Dual-review R4/AR-N2: an explicit [] is "a curated set of zero" — the
	// config doc says `a string[] = that curated set only`, so [] ≡ false
	// instead of silently falling through to the built-in tiers.
	if (Array.isArray(configured)) return configured.length > 0 ? configured : false;
	if (MECHANICAL_CLASSIFIER_ROLES.has(role)) return false;
	if (needsWebResearch(role)) {
		const set = new Set<string>(DEFAULT_RESEARCH_SKILLS);
		const selected = Array.isArray(opts.skillDomains) ? opts.skillDomains : [];
		for (const name of selected) {
			const domain = SKILL_DOMAINS.find((d) => d.name === name);
			if (domain) for (const s of domain.skills) set.add(s);
		}
		return [...set];
	}
	return undefined;
}

/** v0.3.76: roles whose REGISTRATION turns inheritSkills off (ambient
 * discovery suppressed child-side; cards arrive via the per-call request
 * `skill` field instead — skillsForCall). The registration-level flag is the
 * only one that gates the child's ambient listing (pi-subagents
 * child-launch.ts noSkills: !inheritSkills; E2E probe 2026-09-07). */
export function curatedSkillsRole(role: string): boolean {
	return MECHANICAL_CLASSIFIER_ROLES.has(role) || needsWebResearch(role);
}

/** Dual-review R1/AR-2 fix: an explicit agentSkills entry for a role (false
 * or ANY array, including []) must ALSO flip REGISTRATION — ambient
 * suppression is registration-only (pi-subagents child-launch
 * `noSkills: !inheritSkills`; per-call `skill` cannot remove ambient), so a
 * config entry that only set the per-call field would be a silent no-op
 * (false on a capability role) or strictly worse, ambient PLUS curated
 * duplicate injection (array on a capability role). */
export function explicitSkillConfigured(agentSkills: Record<string, false | string[]> | undefined, role: string): boolean {
	const v = agentSkills?.[role];
	return v === false || Array.isArray(v);
}
