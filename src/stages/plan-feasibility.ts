/**
 * v0.3.79 Wave A1/A2 — plan-feasibility validation and the contradiction
 * fast-fail frame (docs/findings/deep-analysis-2026-09-08-spec25.md).
 *
 * Root cause addressed: the machinery executed plans it had never validated
 * for feasibility. Run 2026-09-07T14-14-09-937Z burned ~2h on phase-01 of a
 * 10-phase plan whose deliverable clause (requireContains
 * CROSS_CUTTING_CITATION_FIELDS in tests/catalyst-contract.test.ts) is
 * satisfiable only by editing src/stages.ts — a file the plan declares a
 * deliverable of LATER phase ts-thesis-stage-wiring-unit — so every
 * satisfiable fix was BLOCKED and reverted by the phase-boundary guard
 * (implementation.ts:2951). Industry precedent: plans are validated for
 * constraint satisfiability BEFORE execution (PDoctor arXiv:2404.17833;
 * Turborepo 2.9 "validate the graph you actually execute, not a proxy" — at
 * load time).
 *
 * This module is PURE + deterministic (zero LLM, zero network). It consumes
 * the same phase shape the phase loop uses (structurally compatible with
 * implementation.ts LeakPhase — kept local so no import cycle exists) and
 * emits:
 *   contradictions (blocking, ownerStage=spec → replan-routable):
 *     - cross-phase-identifier: an EARLIER phase's test-file clause requires
 *       identifier X whose only plan-positioned production introduction is a
 *       LATER phase's production file (not writable by the earlier phase),
 *       and X is not already exported at HEAD from any file the earlier
 *       phase may write. This is exactly the run-14-14 shape.
 *     - clause-target-ownership: a later phase forbids (requireNotContains)
 *       exactly what an earlier phase requires (requireContains) in the same
 *       file — mutually unsatisfiable at audit time regardless of order.
 *   advisories (non-blocking):
 *     - shared-file-coupling: a file is a clause target of 2+ phases
 *       (satisfiable when each phase declares it, but handoff must be
 *       explicit — the SDLC docs' shared-file rule).
 *     - coverage-tooling: vitest-family tests are declared but
 *       @vitest/coverage-v8 is absent — coverage gates will read UNMEASURABLE
 *       (7 of 9 phases hit exactly this in run 14-14); surfaced BEFORE
 *       phases burn hours.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Structural mirror of implementation.ts LeakPhase (no import edge — the
 *  shapes evolve together but structurally compatible inputs keep this pure). */
export type PlanPhase = {
	name?: string;
	deliverables?: {
		requireFiles?: string[];
		requireContains?: Array<{ file: string; pattern: string }>;
		requireNotContains?: Array<{ file: string; pattern: string }>;
		requireTests?: string[];
		requireScenarios?: string[];
	};
};

export interface PlanFeasibilityFinding {
	kind: "cross-phase-identifier" | "clause-target-ownership" | "shared-file-coupling" | "coverage-tooling";
	title: string;
	detail: string;
	evidence: string[];
	blocking: boolean;
	/** Deterministic replan-owner routing (replan/owners.ts Rule 1). */
	ownerStage: "spec";
}

export interface PlanFeasibilityReport {
	contradictions: PlanFeasibilityFinding[];
	advisories: PlanFeasibilityFinding[];
}

const norm = (p: string): string => String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

const phaseLabel = (p: PlanPhase | undefined, index: number): string => p?.name?.trim() || `phase-${index + 1}`;

/** Every file the phase's deliverable contract names (its writable set). */
/** Canonical clause-target file set of a phase (requireFiles + contains +
 *  notContains + requireTests). Shared with implementation.ts so the leak
 *  classifier's "own scope" and the validator's "writable set" derive from
 *  ONE grammar (v0.3.80 B1, P6). */
export function phaseClauseFiles(phase: PlanPhase | undefined): string[] {
	const d = phase?.deliverables;
	if (!d) return [];
	const out: string[] = [];
	for (const f of d.requireFiles ?? []) if (typeof f === "string" && f) out.push(f);
	for (const e of d.requireContains ?? []) if (e && typeof e.file === "string" && e.file) out.push(e.file);
	for (const e of d.requireNotContains ?? []) if (e && typeof e.file === "string" && e.file) out.push(e.file);
	for (const f of d.requireTests ?? []) if (typeof f === "string" && f) out.push(f);
	return out;
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const PY_TEST_RE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i;

/** Best-effort test-family classification (mirrors how gates treat tests). */
function isTestFamilyPath(p: string): boolean {
	return TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p) || PY_TEST_RE.test(p);
}

/** STRICTER family for the cross-phase identifier check (CR-v0379-P3-2c): a bare
 *  `spec/` directory segment misclassifies production code (src/spec/…) as test
 *  and flips the satisfiability analysis — require explicit test directories,
 *  test-file suffixes, or python test names there. */
const CROSS_PHASE_TEST_RE = /(^|\/)(tests?|__tests__)\//i;
function isCrossPhaseTestFamily(p: string): boolean {
	return CROSS_PHASE_TEST_RE.test(p) || TEST_FILE_RE.test(p) || PY_TEST_RE.test(p);
}

/** Identifier tokens a clause pattern can pin (SCREAMING_SNAKE / PascalCase /
 *  multi-hump camelCase, length ≥ 6). Prose and runner vocabulary are
 *  filtered — precision over recall: a missed identifier is an advisory gap,
 *  a false one burns a replan. */
const IDENT_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$|^[a-z]+(?:[A-Z][a-z0-9]+){2,}$/;
const IDENT_STOP = new Set([
	"requireContains", "requireNotContains", "requireFiles", "requireTests", "requireScenarios",
	"toBeDefined", "toContain", "toEqual", "toHaveLength", "toBeTruthy", "toBeFalsy", "toBeNull",
	"toBeGreaterThan", "toBeLessThan", "toBeGreaterThanOrEqual", "toBeLessThanOrEqual", "toMatchObject", "toHaveProperty",
	"toBeInstanceOf", "toBeCloseTo", "toHaveBeenCalled", "toHaveBeenCalledWith", "toHaveBeenCalledTimes", "toMatch", "toThrow",
	"beforeEach", "afterEach", "beforeAll", "afterAll", "describe", "expect", "import",
]);

function patternIdentifiers(pattern: string): string[] {
	const out: string[] = [];
	for (const raw of String(pattern ?? "").split(/[^A-Za-z0-9_$]+/)) {
		const tok = raw.replace(/^\$+/, "");
		if (tok.length >= 6 && IDENT_RE.test(tok) && !IDENT_STOP.has(tok)) out.push(tok);
	}
	return out;
}

/** True when `x` is already defined/exported at HEAD in one of the writable
 *  files (import-satisfiable — no contradiction). Best-effort: unreadable
 *  files count as NOT available (fail toward detecting the contradiction,
 *  which routes a replan the spec writer can resolve cheaply). */
function identifierAvailableAtHead(worktreePath: string, writableFiles: string[], x: string): boolean {
	for (const rel of writableFiles) {
		try {
			const abs = join(worktreePath, norm(rel));
			if (!existsSync(abs)) continue;
			const text = readFileSync(abs, "utf8");
			const defRe = new RegExp(`\\b(?:const|let|var|function|class|interface|type|enum|def)\\s+${x}\\b`);
			const exportRe = new RegExp(`\\bexport\\b[^\\n;]{0,160}\\b${x}\\b`);
			if (defRe.test(text) || exportRe.test(text)) return true;
		} catch { /* unreadable → not available */ }
	}
	return false;
}

export function planFeasibilityFindings(phases: PlanPhase[], worktreePath: string): PlanFeasibilityReport {
	const contradictions: PlanFeasibilityFinding[] = [];
	const advisories: PlanFeasibilityFinding[] = [];
	const list = Array.isArray(phases) ? phases : [];

	// ---- Clause inventory (per phase: files + pattern clauses).
	const clauseFiles = list.map((p) => [...new Set(phaseClauseFiles(p).map(norm))].filter(Boolean));
	const containsClauses = list.map((p) =>
		((p?.deliverables?.requireContains ?? []) as Array<{ file?: unknown; pattern?: unknown }>)
			.filter((e) => e && typeof e.file === "string" && typeof e.pattern === "string")
			.map((e) => ({ file: norm(e.file as string), pattern: e.pattern as string })),
	);
	const notContainsClauses = list.map((p) =>
		((p?.deliverables?.requireNotContains ?? []) as Array<{ file?: unknown; pattern?: unknown }>)
			.filter((e) => e && typeof e.file === "string" && typeof e.pattern === "string")
			.map((e) => ({ file: norm(e.file as string), pattern: e.pattern as string })),
	);

	// ---- Check 1: requireContains vs requireNotContains on the same file+pattern
	// (BOTH orderings — CR-v0379-P3-1: an earlier requireNotContains vs a later
	// requireContains on the same file+pattern is equally unsatisfiable at the
	// completion audit; the requires-side iteration below covers contains-first,
	// the forbids-side loop after it covers forbids-first).
	for (let i = 0; i < list.length; i++) {
		for (const req of containsClauses[i]) {
			for (let j = 0; j < list.length; j++) {
				if (j === i) {
					// same-phase conflict
					if (notContainsClauses[j].some((nc) => nc.file === req.file && nc.pattern === req.pattern)) {
						contradictions.push({
							kind: "clause-target-ownership",
							title: `plan contradiction: phase ${phaseLabel(list[i], i)} requires "${req.pattern}" in ${req.file} while the SAME phase forbids it`,
							detail: `requireContains and requireNotContains agree on file "${req.file}" and pattern "${req.pattern}" — mutually unsatisfiable; revise the deliverable contract`,
							evidence: [`${phaseLabel(list[i], i)} requireContains ${req.file}: ${req.pattern}`, `${phaseLabel(list[i], i)} requireNotContains ${req.file}: ${req.pattern}`],
							blocking: true,
							ownerStage: "spec",
						});
					}
					continue;
				}
				if (j !== i && notContainsClauses[j].some((nc) => nc.file === req.file && nc.pattern === req.pattern)) {
					contradictions.push({
						kind: "clause-target-ownership",
						title: `plan contradiction: phase ${phaseLabel(list[i], i)} requires "${req.pattern}" in ${req.file} but ${j > i ? "later" : "earlier"} phase ${phaseLabel(list[j], j)} forbids it`,
						detail: `requireContains (${phaseLabel(list[i], i)}) and requireNotContains (${phaseLabel(list[j], j)}) agree on file "${req.file}" and pattern "${req.pattern}" — both must hold at completion regardless of order; revise the deliverable contract`,
						evidence: [
							`${phaseLabel(list[i], i)} requireContains ${req.file}: ${req.pattern}`,
							`${phaseLabel(list[j], j)} requireNotContains ${req.file}: ${req.pattern}`,
						],
						blocking: true,
						ownerStage: "spec",
					});
				}
			}
		}
	}

	// ---- Check 2: cross-phase identifier ordering (the run-14-14 shape).
	// Per identifier X: the earliest phase whose clauses mention X must be able
	// to satisfy them with its own writable set — either X is available at HEAD
	// in one of its files, or the mentioning clause targets a production file
	// (it can define X there itself). When the earliest mention is in a TEST
	// file and X's only production introduction is positioned in a LATER
	// phase's production file outside the writable set, the earlier phase
	// cannot pass its gate without tripping the phase-boundary BLOCKING revert.
	const mentionPhases = new Map<string, Array<{ phase: number; file: string; clauseIdx: number }>>();
	for (let i = 0; i < list.length; i++) {
		containsClauses[i].forEach((c, idx) => {
			for (const x of patternIdentifiers(c.pattern)) {
				const arr = mentionPhases.get(x) ?? [];
				arr.push({ phase: i, file: c.file, clauseIdx: idx });
				mentionPhases.set(x, arr);
			}
		});
	}
	for (const [x, mentions] of mentionPhases) {
		if (mentions.length < 2) continue;
		const earliest = mentions.reduce((min, m) => (m.phase < min.phase ? m : min), mentions[0]);
		const writable = new Set(clauseFiles[earliest.phase]);
		const earliestIsTest = mentions.some((m) => m.phase === earliest.phase && isCrossPhaseTestFamily(m.file));
		const earliestHasProdMention = mentions.some((m) => m.phase === earliest.phase && !isCrossPhaseTestFamily(m.file));
		if (!earliestIsTest || earliestHasProdMention) continue; // can define X itself
		if (identifierAvailableAtHead(worktreePath, [...writable], x)) continue; // import-satisfiable from own writable set
		const laterProd = mentions.find((m) => m.phase > earliest.phase && !isCrossPhaseTestFamily(m.file) && !writable.has(m.file));
		if (!laterProd) continue;
		// Already EXPORTED at HEAD from the later-owned file → the earlier phase's
		// import is satisfiable without editing it (run-14-14's late workaround —
		// a derived export — is exactly the case that must NOT flag here).
		if (fileExportsIdentifier(worktreePath, laterProd.file, x)) continue;
		const laterLabel = phaseLabel(list[laterProd.phase], laterProd.phase);
		const earliestLabel = phaseLabel(list[earliest.phase], earliest.phase);
		const testFile = mentions.find((m) => m.phase === earliest.phase && isTestFamilyPath(m.file))?.file ?? "(test file)";
		contradictions.push({
			kind: "cross-phase-identifier",
			title: `plan contradiction: ${earliestLabel} requires identifier ${x} in ${testFile}, but the plan positions ${x}'s production introduction in later phase ${laterLabel} (${laterProd.file})`,
			detail: `${earliestLabel}'s deliverable clause needs ${x} in the test file ${testFile}; tests obtain identifiers by import, the only plan-positioned production source of ${x} is ${laterProd.file} (writable only by ${laterLabel}), and ${x} is not already exported at HEAD from any file ${earliestLabel} may write. Every satisfiable fix edits ${laterProd.file} — which the phase-boundary guard BLOCKS and reverts. Fix the plan: merge the phases, hand off the export, or move the clause.`,
			evidence: [
				`${earliestLabel} requireContains ${testFile}: ${x}`,
				`${laterLabel} requireContains ${laterProd.file}: ${x}`,
				`HEAD: ${x} not defined/exported in ${[...writable].join(", ") || "(no writable files)"}`,
			],
			blocking: true,
			ownerStage: "spec",
		});
	}

	// ---- Advisory: shared-file coupling.
	const fileOwners = new Map<string, number[]>();
	clauseFiles.forEach((files, i) => {
		for (const f of files) {
			const owners = fileOwners.get(f) ?? [];
			if (!owners.includes(i)) owners.push(i);
			fileOwners.set(f, owners);
		}
	});
	for (const [file, owners] of fileOwners) {
		if (owners.length < 2) continue;
		const ownerLabels = owners.map((i) => phaseLabel(list[i], i));
		advisories.push({
			kind: "shared-file-coupling",
			title: `shared-file coupling: ${file} is a declared clause target of phases ${ownerLabels.join(", ")}`,
			detail: `Each phase may edit ${file} inside its own declared scope, but the phases must hand off explicitly (earlier phase leaves the file in a state the later phase's RED can build on) — the SDLC shared-file rule`,
			evidence: ownerLabels.map((l) => `${l} → ${file}`),
			blocking: false,
			ownerStage: "spec",
		});
	}

	// ---- Advisory: coverage tooling preflight (vitest family only — the
	// observed UNMEASURABLE class from run 14-14 was vitest coverage).
	const vitestTests = clauseFiles.flat().filter((f) => isTestFamilyPath(f) && !PY_TEST_RE.test(f));
	if (vitestTests.length > 0 && !vitestCoverageAvailable(worktreePath)) {
		advisories.push({
			kind: "coverage-tooling",
			title: "coverage tooling missing: @vitest/coverage-v8 is not installed in the target worktree — coverage gates will read UNMEASURABLE",
			detail: `Declared vitest-family tests (${vitestTests.slice(0, 4).join(", ")}${vitestTests.length > 4 ? ", …" : ""}) without coverage tooling: every coverage gate becomes UNMEASURABLE (run 14-14: 7 of 9 phases). Install @vitest/coverage-v8 in the target repo or record the advisory downgrade before Stage 9 burns hours.`,
			evidence: vitestTests.slice(0, 6).map((f) => `test file: ${f}`),
			blocking: false,
			ownerStage: "spec",
		});
	}

	return { contradictions, advisories };
}

/** True when the later-owned file at HEAD makes `x` import-satisfiable:
 *  JS/TS family — an EXPORT (multi-line tolerant); Python family — a top-level
 *  def/class/assignment (no export keyword exists; ADV-v0379-2a: a `class X:` in
 *  the later file was falsely flagged as unavailable). */
function fileExportsIdentifier(worktreePath: string, rel: string, x: string): boolean {
	try {
		const abs = join(worktreePath, norm(rel));
		if (!existsSync(abs)) return false;
		const text = readFileSync(abs, "utf8");
		if (/\.py$/i.test(rel)) {
			const defRe = new RegExp(`^\\s*(?:def|class)\\s+${x}\\b`, "m");
			return defRe.test(text);
		}
		const exportRe = new RegExp(`\\bexport\\b[\\s\\S]{0,200}\\b${x}\\b`);
		return exportRe.test(text);
	} catch {
		return false;
	}
}

function vitestCoverageAvailable(worktreePath: string): boolean {
	try {
		if (existsSync(join(worktreePath, "node_modules", "@vitest", "coverage-v8"))) return true;
		const pkgPath = join(worktreePath, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
			const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
			if ("@vitest/coverage-v8" in deps) return true;
		}
	} catch { /* unreadable → treat as missing (advisory is the safe direction) */ }
	return false;
}

/**
 * A2 execution-time frame: when a phase's repeated no-progress signature
 * coincides with observed phase-boundary reverts, the no-progress judge gets
 * this contradiction context and the replan-upstream route — turning a blind
 * retry loop into a plan-revision route at the cheapest point still
 * available (run 14-14: 6 attempts ≈ 2h before the generic valve fired).
 */
export function contradictionFastFailFrame(input: {
	phaseId: string;
	phaseName: string;
	leakOwners: string[];
	leakFiles: string[];
	failureReasons: string[];
}): { context: string; allowedRoutes: string[] } {
	const lines = [
		"## Deterministic phase-boundary contradiction detected",
		`Phase ${input.phaseId}${input.phaseName ? ` (${input.phaseName})` : ""} has repeated the SAME failure signature while the engine BLOCKED and reverted its out-of-scope edits — the files it must edit to satisfy its clause are DECLARED DELIVERABLES of later phase(s):`,
		input.leakOwners.length ? `- later owner phase(s): ${input.leakOwners.join(", ")}` : "- (owner phase names unavailable)",
		input.leakFiles.length ? `- reverted file(s): ${input.leakFiles.join(", ")}` : "- (reverted paths unavailable)",
		"",
		"## Recurring failure reasons (identical signature across attempts)",
		...(input.failureReasons.length ? input.failureReasons.slice(0, 12) : ["(none recorded)"]),
		"",
		"This is a PLAN-level infeasibility, not an implementer defect: retrying cannot fix it. If the clause genuinely requires the later phase's file, route replan-upstream so the spec/plan is revised (merge phases, add an explicit export handoff, or move the clause).",
	];
	return {
		context: lines.join("\n"),
		allowedRoutes: ["replan-upstream", "challenge-test", "re-author-tests", "continue"],
	};
}
