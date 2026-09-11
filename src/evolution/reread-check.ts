/**
 * REREAD CHECK (P3 / D6 / DEC-12) — the deterministic frequency check over a
 * run's tool-usage telemetry (docs/requirements/sdlc-tips-adoption.md
 * DEC-12, §7 部分 10 external endorsement: test the STEPS, not only the
 * result — repeated search / redundant-call detection).
 *
 * What it does (zero-LLM, fail-open, ALWAYS ON at run close-out — it is free
 * and deterministic, so it carries NO enable guard of its own): over the
 * run's <specDir>/tool-usage.jsonl rows, detect file-reading calls (read/grep
 * ONLY — adversarial-gate F-06: ls/find read DIRECTORIES, not file content;
 * flagging a directory listing as an artifact re-read is a false positive)
 * on upstream-artifact doc paths the prompts ACTUALLY carry (see
 * upstreamArtifactDocPaths — adversarial-gate F-04: the verified list, not a
 * guess; deliverable clause files were REMOVED — they are what implementers
 * WRITE, not what the engine injects) whose aggregate call count on that ONE
 * path (F-05: the aggregation key is the PATH — counts sum across tools and
 * argHeads) exceeds REREAD_MAX_CALLS.
 *
 * What it NEVER does: block, gate, retry, or otherwise actuate (the same
 * observational class as the eval stage — an advisory warning + a report
 * note; enforcement belongs to the work-unit prompt discipline, not to a
 * checker). Never throws: a missing telemetry file or malformed line is an
 * honest empty/lesser result, never a run failure (P4/P5).
 *
 * Match honesty (argHead is 60 chars): a finding fires when the normalized
 * argHead CONTAINS the normalized path, or when the argHead is a path-like
 * PREFIX of the path (the truncation case) — a prefix head ending in "/"
 * is a DIRECTORY head and is rejected (F-06: directory prefixes match whole
 * subtrees, not one artifact). Paths longer than the argHead budget can
 * UNDER-detect (fail toward silence) — the safe direction for an advisory
 * instrument. Re-reading is NOT forbidden (D6): the named hazard is
 * stale-artifact blind trust, so the warning names what the prompt actually
 * carries (a named upstream artifact whose relevant extracts are injected)
 * and never advises "prefer the injected artifact" for a path outside the
 * verified list — callers can only pass verified paths.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_USAGE_BASENAME, type ToolUsageRow } from "./tool-usage.ts";

/** N (DEC-12): aggregate calls on one injected path beyond this count fire
 *  the advisory. A named constant, NOT an env key (README-documented). */
export const REREAD_MAX_CALLS = 3;

/** The FILE-READING tools whose calls count (adversarial-gate F-06):
 *  read/grep only — ls/find are directory listings, never an artifact
 *  re-read. Direct tool names only — a bash `cat` is argHead parsing, out of
 *  the conservative surface (documented gap, never a false positive). */
export const REREAD_READ_TOOLS: readonly string[] = ["read", "grep"];

/** Minimum argHead length before the path-prefix (truncation) arm may fire —
 *  short heads match too many paths to mean anything. */
const PREFIX_MATCH_MIN_LEN = 6;

/** The stage-control shapes upstreamArtifactDocPaths reads (loose on purpose:
 *  controls are ControlObj records; unknown/absent fields yield nothing). */
export interface UpstreamDocControls {
	requirements?: { docPath?: unknown } | null;
	bdd?: { docPath?: unknown } | null;
	research?: { docPath?: unknown } | null;
	assessment?: { docPath?: unknown } | null;
	design?: { docs?: unknown } | null;
	prototype?: { docPath?: unknown } | null;
	spec?: {
		specificationPath?: unknown;
		planPath?: unknown;
		implementationPlanPath?: unknown;
		tasksPath?: unknown;
		taskListPath?: unknown;
	} | null;
}

/**
 * The VERIFIED injected-doc list (adversarial-gate F-04). Every path returned
 * here is a path the prompt builders ACTUALLY embed into specialist prompts
 * as an upstream artifact (verified against src/prompts.ts + the stage
 * wirings — the "## Upstream Artifacts" / doc-path lines):
 *   - requirements.docPath      buildBddPrompt / buildDesignPrompt
 *   - bdd.docPath               buildTddPrompt ("- BDD Scenarios") / research
 *   - research.docPath          buildDesignPrompt ("- Research")
 *   - assessment.docPath        buildDesignPrompt ("- Code Assessment")
 *   - design.docs               the spec prompt's "- Design:" list
 *   - prototype.docPath         the spec prompt's "- Prototype Report"
 *   - spec.specificationPath    spec-review / tdd / implement / code-review /
 *                               adversarial / tests-review prompts
 *   - spec.planPath | implementationPlanPath, spec.tasksPath | taskListPath
 *                               buildSpecReviewPrompt ("- Plan" / "- Tasks")
 * Control-field extracts (knowledgeForAgent) and test-snippet inlining are
 * inline injections but NOT doc paths — out of this surface by construction.
 * The old phaseClauseFiles wiring was REMOVED (deliverables are what
 * implementers WRITE, not injected artifacts).
 */
export function upstreamArtifactDocPaths(controls: UpstreamDocControls): string[] {
	const out = new Set<string>();
	const push = (v: unknown): void => {
		if (typeof v === "string" && v.trim() !== "") out.add(v.trim());
	};
	push(controls.requirements?.docPath);
	push(controls.bdd?.docPath);
	push(controls.research?.docPath);
	push(controls.assessment?.docPath);
	if (Array.isArray(controls.design?.docs)) for (const d of controls.design.docs) push(d);
	push(controls.prototype?.docPath);
	push(controls.spec?.specificationPath);
	push(controls.spec?.planPath);
	push(controls.spec?.implementationPlanPath);
	push(controls.spec?.tasksPath);
	push(controls.spec?.taskListPath);
	return [...out];
}

export interface RereadFinding {
	/** The upstream-artifact doc path the calls hit (the aggregation key —
	 *  F-05: counts sum across ALL tools and argHeads naming this path). */
	path: string;
	/** Aggregate invocation count (sum of row counts; absent row count ≡ 1). */
	calls: number;
	/** The read-family tools involved (sorted). */
	tools: string[];
	/** Agents that issued the calls (unique, sorted — attribution). */
	agents: string[];
}

export interface RereadCheckOutcome {
	findings: RereadFinding[];
	/** One loud advisory line per finding (the log surface). */
	warnings: string[];
	/** The single report note (rides the eval.reread event at the wiring). */
	note: string;
	rowsScanned: number;
	/** Malformed telemetry lines skipped (named, never silent — P10). */
	malformedRows: number;
}

/** Normalize a path-ish string: unify separators, drop a leading "./". */
function normPath(p: string): string {
	return String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Best-effort telemetry read (missing file → []; malformed lines skipped
 *  and counted). */
export function readToolUsageRows(specDir: string): { rows: ToolUsageRow[]; malformedRows: number } {
	let text: string;
	try {
		text = readFileSync(join(specDir, TOOL_USAGE_BASENAME), "utf8");
	} catch {
		return { rows: [], malformedRows: 0 };
	}
	const rows: ToolUsageRow[] = [];
	let malformedRows = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as ToolUsageRow;
			if (typeof parsed?.tool === "string" && typeof parsed?.argHead === "string") rows.push(parsed);
			else malformedRows += 1;
		} catch {
			malformedRows += 1;
		}
	}
	return { rows, malformedRows };
}

/** Does this argHead plausibly name this injected path? (See match honesty
 *  in the header — containment first, path-like truncation prefix second; a
 *  prefix head ending "/" is a DIRECTORY head and never matches, F-06.) */
export function argHeadMatchesPath(argHead: string, path: string): boolean {
	const a = normPath(argHead);
	const p = normPath(path);
	if (a === "" || p === "") return false;
	if (a.includes(p)) return true;
	// Truncation arm: the head is the beginning of the invocation and got cut
	// at 60 chars before the full path fit — only for path-like heads of a
	// meaningful length that do NOT end in "/" (a directory head would match
	// every file under it).
	return !a.endsWith("/") && p.startsWith(a) && a.includes("/") && a.length >= PREFIX_MATCH_MIN_LEN;
}

/**
 * Run the check. `rows` may be injected (tests / future callers); the
 * default reads <specDir>/tool-usage.jsonl. NEVER throws.
 */
export function runRereadCheck(input: { specDir?: string; injectedPaths: readonly string[]; rows?: readonly ToolUsageRow[]; maxCalls?: number }): RereadCheckOutcome {
	const maxCalls = input.maxCalls ?? REREAD_MAX_CALLS;
	const readTools = new Set(REREAD_READ_TOOLS);
	const paths = [...new Set(input.injectedPaths.map(normPath).filter((p) => p !== ""))];
	const source = input.rows !== undefined
		? { rows: [...input.rows], malformedRows: 0 }
		: input.specDir !== undefined
			? readToolUsageRows(input.specDir)
			: { rows: [] as ToolUsageRow[], malformedRows: 0 };
	const rows = source.rows;

	// Aggregate by PATH ONLY (F-05): calls on one upstream artifact sum
	// across every tool and argHead naming it; the finding reports the total
	// plus the tools involved. Row count absent ≡ 1 (pre-P3 shape).
	type PathAgg = { path: string; calls: number; tools: Set<string>; agentSet: Set<string> };
	const agg = new Map<string, PathAgg>();
	for (const row of rows) {
		if (!readTools.has(String(row.tool ?? "").toLowerCase())) continue;
		for (const p of paths) {
			if (!argHeadMatchesPath(row.argHead ?? "", p)) continue;
			const cur = agg.get(p) ?? { path: p, calls: 0, tools: new Set<string>(), agentSet: new Set<string>() };
			cur.calls += typeof row.count === "number" && row.count >= 1 ? Math.floor(row.count) : 1;
			if (typeof row.tool === "string" && row.tool !== "") cur.tools.add(row.tool);
			if (typeof row.agent === "string" && row.agent !== "") cur.agentSet.add(row.agent);
			agg.set(p, cur);
		}
	}

	const findings = [...agg.values()]
		.filter((f) => f.calls > maxCalls)
		.map((f) => ({ path: f.path, calls: f.calls, tools: [...f.tools].sort(), agents: [...f.agentSet].sort() }))
		.sort((a, b) => (a.path < b.path ? -1 : 1));

	const warnings = findings.map((f) =>
		`reread-check: "${f.path}" was read ${f.calls}× via ${f.tools.join("+")} (${f.agents.join(", ")}) — it is a named upstream artifact in the work-unit prompts (relevant extracts already injected); re-read only to ground-verify against staleness (advisory, never blocks)`);
	const note = findings.length === 0
		? `reread-check: no upstream-artifact path exceeded REREAD_MAX_CALLS=${maxCalls} (${rows.length} telemetry row(s), ${paths.length} injected path(s))`
		: `reread-check: ${findings.length} upstream-artifact path(s) re-read beyond REREAD_MAX_CALLS=${maxCalls} (advisory only — D6/DEC-12; never blocks, never actuates)`;
	return { findings, warnings, note, rowsScanned: rows.length, malformedRows: source.malformedRows };
}
