import { isInternalRuntimeClaim } from "./tracking.ts";

export type RedBoundaryCategory = "test" | "support" | "runtime" | "substrate" | "scaffold" | "production" | "ambiguous";
export type RedBoundarySource = "deterministic" | "agent" | "fallback";

export interface RedBoundaryClassification {
	path: string;
	category: RedBoundaryCategory;
	allowed: boolean;
	confidence: number;
	source: RedBoundarySource;
	reason: string;
}

export interface RedBoundaryResult {
	classifications: RedBoundaryClassification[];
	forbiddenFiles: string[];
	ambiguousFiles: string[];
	allAllowed: boolean;
}

const MIN_AGENT_CONFIDENCE = 0.7;
const RUNTIME_EVIDENCE_BASENAMES = new Set([
	"implementation-evidence.jsonl",
	"change-tracker.jsonl",
	".resume-cache.jsonl",
	".user-notes.json",
	"stagnation-report.md",
	"escalation-report.md",
	"api-test-report.md",
	"ui-test-report.md",
]);

const normalizePath = (path: string): string =>
	String(path ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");

function dedupe(paths: string[]): string[] {
	return Array.from(new Set(paths.map(normalizePath).filter(Boolean)));
}

function tokenizePath(path: string): string[] {
	const normalized = normalizePath(path)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	return normalized
		.split(/[^A-Za-z0-9]+/g)
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
}

function hasObviousTestToken(path: string): boolean {
	const segments = normalizePath(path).split("/");
	const base = segments[segments.length - 1] ?? "";
	// rspec/jest-style basename markers: user_spec.rb, a.spec.ts, test_x.py,
	// x.test.ts — the file's OWN name says test.
	if (/(?:^|_)spec\.[a-z0-9]+$/i.test(base) || /\.spec\.[a-z0-9]+$/i.test(base) || /^test[_-]/i.test(base) || /[._-]test\.[a-z0-9]+$/i.test(base)) return true;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === "test" || seg === "tests" || seg === "e2e" || seg === "snapshot" || seg === "snapshots" || seg === "__tests__" || seg === "__specs__") return true;
		// Sweep-3 G44: bare 'spec'/'specs' PATH SEGMENTS are ambiguous — Go repos
		// ship production packages named spec (internal/spec/loader.go) exactly
		// like rspec ships spec/models/. Allowed ONLY in the rspec convention
		// shape: a TOP-LEVEL spec/specs dir, or nested under a tests root; any
		// other placement goes to the evaluator as ambiguous.
		if ((seg === "spec" || seg === "specs") && (i === 0 || segments[i - 1] === "test" || segments[i - 1] === "tests" || segments[i - 1] === "__tests__" || segments[i - 1] === "__specs__")) return true;
	}
	// camelCase tokens (specRegistry → 'spec','registry') are deliberately NOT
	// treated as test evidence (G44) — a production OpenAPI/spec-loader module
	// is the common false-positive class.
	return false;
}

export function isRuntimeEvidencePath(path: string): boolean {
	const basename = normalizePath(path).split("/").pop() ?? "";
	return RUNTIME_EVIDENCE_BASENAMES.has(basename);
}

/** Conventional dependency-installation and tool/cache directories that are
 * NEVER hand-written production implementation. A truly-greenfield repo must
 * bootstrap some of these during RED (e.g. `node_modules/` via `npm install`,
 * vitest's `.vite/` cache) to make its test collect+run, so they are allowed
 * through the RED boundary deterministically rather than flagged as pollution
 * and torn down by cleanup. Only names that can never be a meaningful source
 * path are included here — generic names like `build`/`dist`/`bin`/`obj`/
 * `target`/`coverage` are deliberately EXCLUDED because they are also used as
 * real hand-written source directories in many projects. */
const SUBSTRATE_SEGMENTS = new Set([
	"node_modules",
	".vite",
	".turbo",
	".next",
	".nuxt",
	".svelte-kit",
	".angular",
	".parcel-cache",
	".cache",
	".esbuild",
	".gradle",
	".pytest_cache",
	"__pycache__",
]);

export function isSubstrateArtifact(path: string): boolean {
	const segments = normalizePath(path).split("/");
	return segments.some((seg) => SUBSTRATE_SEGMENTS.has(seg));
}

function decision(path: string, category: RedBoundaryCategory, allowed: boolean, confidence: number, source: RedBoundarySource, reason: string): RedBoundaryClassification {
	return { path: normalizePath(path), category, allowed, confidence, source, reason };
}

/**
 * Deterministic RED-boundary classifier for obvious cases only.
 *
 * This intentionally does not try to encode every language/framework's test
 * layout. It accepts paths whose own structure clearly says "test/spec/e2e" or
 * known super-dev runtime artifacts, then leaves the rest for the evaluator.
 */
export function classifyObviousRedPath(path: string): RedBoundaryClassification {
	const normalized = normalizePath(path);
	if (!normalized) return decision(path, "ambiguous", false, 0, "deterministic", "empty path");
	if (isInternalRuntimeClaim(normalized) || isRuntimeEvidencePath(normalized)) {
		return decision(normalized, "runtime", true, 1, "deterministic", "known super-dev runtime artifact");
	}
	if (isSubstrateArtifact(normalized)) {
		return decision(normalized, "substrate", true, 1, "deterministic", "conventional dependency/tool-cache directory (not production implementation)");
	}
	if (hasObviousTestToken(normalized)) {
		return decision(normalized, "test", true, 0.95, "deterministic", "path contains an obvious test/spec/e2e/snapshot token");
	}
	return decision(normalized, "ambiguous", false, 0.5, "deterministic", "path is not an obvious RED test artifact; evaluator required");
}

function isAllowedCategory(category: RedBoundaryCategory): boolean {
	return category === "test" || category === "support" || category === "runtime" || category === "substrate" || category === "scaffold";
}

function normalizeCategory(value: unknown): RedBoundaryCategory {
	const v = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (v === "test" || v === "support" || v === "runtime" || v === "production" || v === "ambiguous" || v === "substrate" || v === "scaffold") return v;
	return "ambiguous";
}

function normalizeConfidence(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(normalizePath).filter(Boolean) : [];
}

export function redBoundaryResultFromClassifications(classifications: RedBoundaryClassification[]): RedBoundaryResult {
	const forbiddenFiles = classifications.filter((item) => !item.allowed).map((item) => item.path);
	const ambiguousFiles = classifications
		.filter((item) => item.category === "ambiguous" || item.confidence < MIN_AGENT_CONFIDENCE)
		.map((item) => item.path);
	return {
		classifications,
		forbiddenFiles,
		ambiguousFiles,
		allAllowed: forbiddenFiles.length === 0,
	};
}

/** v0.2.8 G4 (allow-scaffold): re-admit judge-approved scaffold paths. The judge
 *  read the spec + the file and blessed it as declaration-only scaffolding, so a
 *  path in `approved` is reclassified `scaffold`/allowed and dropped from
 *  forbidden/ambiguous. The RED oracle remains the final guard (the test must
 *  still be `red` after) — this only lifts the boundary veto, never the oracle. */
export function approveScaffoldPaths(result: RedBoundaryResult, approved: ReadonlySet<string>): RedBoundaryResult {
	if (approved.size === 0) return result;
	const norm = new Set([...approved].map(normalizePath));
	const classifications = result.classifications.map((c) =>
		norm.has(c.path) && !c.allowed
			? { ...c, category: "scaffold" as RedBoundaryCategory, allowed: true, source: "agent" as RedBoundarySource, reason: `judge allow-scaffold: approved declaration-only scaffolding — ${c.reason}` }
			: c,
	);
	const forbiddenFiles = classifications.filter((item) => !item.allowed).map((item) => item.path);
	const ambiguousFiles = classifications.filter((item) => (item.category === "ambiguous" || item.confidence < MIN_AGENT_CONFIDENCE) && !item.allowed).map((item) => item.path);
	return { classifications, forbiddenFiles, ambiguousFiles, allAllowed: forbiddenFiles.length === 0 };
}

export function redBoundaryResultFromAgent(paths: string[], control: unknown): RedBoundaryResult {
	const requested = dedupe(paths);
	const obj = control != null && typeof control === "object" && !Array.isArray(control)
		? control as Record<string, unknown>
		: {};
	const explicitForbidden = new Set(stringArray(obj.forbiddenFiles).map(normalizePath));
	const explicitAmbiguous = new Set(stringArray(obj.ambiguousFiles).map(normalizePath));
	const rawClassifications = Array.isArray(obj.classifications) ? obj.classifications : [];
	const byPath = new Map<string, Record<string, unknown>>();
	for (const item of rawClassifications) {
		if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
		const rec = item as Record<string, unknown>;
		const path = typeof rec.path === "string" ? normalizePath(rec.path) : "";
		if (path) byPath.set(path, rec);
	}
	// v0.3.24 S4-1: the evaluator routinely echoes paths with a DIFFERENT prefix
	// than the harness's git-status-relative form — absolute worktree paths above
	// all (run 2026-08-28T12-51-40-028Z: three textbook-valid RED scaffolds were
	// denied as `fallback: evaluator omitted this path` because the exact-match
	// lookup missed every absolute echo). Resolve by path SUFFIX, but only when
	// EXACTLY one candidate fits — an ambiguous suffix (two same-basename files)
	// stays a conservative fallback instead of a lucky guess.
	const resolveAgentPath = (path: string): string | null => {
		if (byPath.has(path)) return path;
		const suffixMatches = [...byPath.keys()].filter((cand) =>
			cand !== path && (cand.endsWith(`/${path}`) || (path.length > 0 && path.endsWith(`/${cand}`))));
		return suffixMatches.length === 1 ? suffixMatches[0] : null;
	};
	// v0.3.24 review-2 F7: how many evaluator echoes suffix-match this path —
	// used only to report WHY a lookup fell back to a conservative deny.
	const suffixEchoes = (path: string): number =>
		[...byPath.keys()].filter((cand) =>
			cand !== path && (cand.endsWith(`/${path}`) || (path.length > 0 && path.endsWith(`/${cand}`)))).length;
	const resolveExplicit = (set: Set<string>, path: string): boolean => {
		if (set.has(path)) return true;
		for (const cand of set) {
			if (cand !== path && (cand.endsWith(`/${path}`) || path.endsWith(`/${cand}`))) return true;
		}
		return false;
	};

	const classifications = requested.map((path) => {
		const resolved = resolveAgentPath(path);
		const rec = resolved != null ? byPath.get(resolved) : undefined;
		if (!rec) {
			// v0.3.24 review-2 F7: distinguish the two deny reasons — a path the
			// evaluator genuinely never echoed vs one whose echo could not be
			// uniquely bound (same-basename collision: the evaluator DID echo it,
			// possibly twice — conservative deny either way).
			const reason = suffixEchoes(path) > 1
				? "ambiguous path echo — multiple same-basename candidates; denying conservatively"
				: "evaluator omitted this path";
			return decision(path, "ambiguous", false, 0, "fallback", reason);
		}
		const category = resolveExplicit(explicitForbidden, path) || (resolved != null && explicitForbidden.has(resolved)) ? "production"
			: resolveExplicit(explicitAmbiguous, path) || (resolved != null && explicitAmbiguous.has(resolved)) ? "ambiguous"
			: normalizeCategory(rec.category);
		const confidence = normalizeConfidence(rec.confidence);
		const reason = typeof rec.reason === "string" && rec.reason.trim()
			? rec.reason.trim()
			: "evaluator did not provide a reason";
		const allowed = isAllowedCategory(category) && confidence >= MIN_AGENT_CONFIDENCE;
		return decision(path, category, allowed, confidence, "agent", allowed ? reason : `${reason}; denied by RED boundary policy`);
	});
	return redBoundaryResultFromClassifications(classifications);
}

export function buildRedBoundaryPrompt(args: { changedFiles: string[]; testFiles: string[]; phaseName: string; phaseDescription?: string; redStatus: string }): string {
	return [
		"Classify RED-phase file changes for a TDD harness.",
		"The RED phase may create/modify tests and test-only support artifacts, and may create NEW declaration-only 'scaffold' files a test needs to COMPILE and fail (types/interfaces/consts/enums, or function SIGNATURES with unimplemented bodies such as panic/not-implemented/zero-return). It must NOT create/modify production IMPLEMENTATION (real behavior), and must NOT modify EXISTING production files.",
		"category 'scaffold' = a NEW production-language file that only DECLARES (no behavior) so the test compiles and still fails RED; category 'production' = real behavior or an edit to an existing production file (forbidden). When a new file mixes a real implementation body with declarations, classify it 'production'. When unsure whether a body is a stub or behavior, mark ambiguous.",
		"Use semantic project judgment. Do not rely only on file extensions. When unsure, mark ambiguous.",
		`Phase: ${args.phaseName}`,
		args.phaseDescription ? `Phase description: ${args.phaseDescription}` : "",
		`RED oracle status: ${args.redStatus}`,
		`Reported test targets: ${args.testFiles.length ? args.testFiles.join(", ") : "none"}`,
		`Changed files requiring classification: ${args.changedFiles.join(", ")}`,
		"Return structured_output with:",
		"- classifications: [{ path, category: 'test'|'support'|'runtime'|'scaffold'|'production'|'ambiguous'|'substrate', confidence: 0..1, reason }]",
		"- forbiddenFiles: production or unsafe paths",
		"- ambiguousFiles: paths you cannot confidently allow",
		"- allAllowed: true only when every changed file is safe for RED",
	].filter(Boolean).join("\n");
}

/** Back-compat helper for older callers/tests. New code should use the full
 * boundary result so ambiguous files are not silently accepted. */
export function isTestArtifactPath(path: string): boolean {
	const classified = classifyObviousRedPath(path);
	return classified.allowed && classified.category === "test";
}
