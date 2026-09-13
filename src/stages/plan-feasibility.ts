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
 *     - protection-threat (Wave P1 D-A, docs/requirements/
 *       058-cross-phase-contract-architecture.md Layer 1): a MECHANICALLY
 *       extracted immutability claim (the `git status --porcelain` +
 *       immutability-wording idiom inside a declared requireTests file, or an
 *       explicit repo-invariants.json declaration) intersects a phase's
 *       requireFiles write set — {protected} ∧ {written} = ⊥. The
 *       run-2026-09-13 S-A shape (`expect(dirty, "src/schemas.ts must stay
 *       byte-untouched").toBe("")` over porcelain while another phase
 *       requires editing src/schemas.ts) is decidable at entry, statically.
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
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
	kind: "cross-phase-identifier" | "clause-target-ownership" | "shared-file-coupling" | "coverage-tooling" | "protection-threat";
	title: string;
	detail: string;
	evidence: string[];
	blocking: boolean;
	/** Deterministic replan-owner routing (replan/owners.ts Rule 1). */
	ownerStage: "spec";
	/** protection-threat only (Wave P1 D-A): the mechanical source of the
	 *  protection claim — "<test file>:<idiom wording>" or
	 *  "repo-invariants.json". */
	protectingSource?: string;
	/** protection-threat only: the phase (label) whose requireFiles write
	 *  claims hit a protected path. */
	writingPhase?: string;
	/** protection-threat only: the intersecting protected path(s). */
	paths?: string[];
}

export interface PlanFeasibilityReport {
	contradictions: PlanFeasibilityFinding[];
	advisories: PlanFeasibilityFinding[];
	/** P10 (Wave P1 D-A): one line per scanned protection source — every
	 *  plan-declared requireTests file (hits or none, on-disk or not) plus the
	 *  repo-invariants.json declaration — so a silent idiom miss is visible. */
	protectionScan: string[];
}

const norm = (p: string): string => String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** F-12 (v0.3.86): containment guard for every model-derived plan path. Both
 *  read sites resolve a phase clause file against the worktree — `../`
 *  sequences and ABSOLUTE paths escaped that join and let the feasibility
 *  check read arbitrary host files. Mirrors the isInsideOrSame/resolveInsideCwd
 *  idiom of build-runner/gates.ts (kept LOCAL: this module deliberately imports
 *  only node:fs/node:path to stay pure). Escaping/absolute paths are treated as
 *  UNAVAILABLE (fail toward detecting the contradiction — the same direction an
 *  unreadable file already takes), never read. */
function resolveInsideWorktree(worktreePath: string, rel: string): string | null {
	if (typeof rel !== "string" || rel.length === 0) return null;
	const root = resolve(worktreePath);
	const abs = resolve(root, rel);
	const relFromRoot = relative(root, abs);
	if (relFromRoot === "") return abs;
	if (!relFromRoot || relFromRoot.startsWith("..") || isAbsolute(relFromRoot) || relFromRoot.startsWith(sep)) return null;
	return abs;
}

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
			// F-12: never read outside the worktree — an escaping clause path counts
			// as NOT available (the contradiction detector stays armed).
			const abs = resolveInsideWorktree(worktreePath, norm(rel));
			if (abs === null) continue;
			if (!existsSync(abs)) continue;
			const text = readFileSync(abs, "utf8");
			const defRe = new RegExp(`\\b(?:const|let|var|function|class|interface|type|enum|def)\\s+${x}\\b`);
			const exportRe = new RegExp(`\\bexport\\b[^\\n;]{0,160}\\b${x}\\b`);
			if (defRe.test(text) || exportRe.test(text)) return true;
		} catch { /* unreadable → not available */ }
	}
	return false;
}

export function planFeasibilityFindings(phases: PlanPhase[], worktreePath: string, specDirectory?: string): PlanFeasibilityReport {
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

	// ---- Check 3 (Wave P1 D-A): protection-threat — mechanically extracted
	// immutability claims × phase write claims (requireFiles). A test that
	// demands a path stay untouched while the plan declares that path a
	// deliverable of some phase is a POP clobbering threat (Veloso & Blythe
	// 1994) — decidable at Stage 9 entry, statically. Every (protecting source ×
	// writing phase) pair gets its OWN finding so the REPLAN names each threat
	// (test (d)). P8: one scan pass (see the scanner's module comment); the
	// repo-invariants.json file is OPTIONAL — absent = skipped silently.
	const protectionScan: string[] = [];
	const declaredTestFiles = [...new Set(
		list.flatMap((p) => (p?.deliverables?.requireTests ?? []).filter((f) => typeof f === "string" && f).map(norm)),
	)].filter(Boolean);
	const protectedClaims: Array<{ path: string; source: string }> = [];
	for (const normRel of declaredTestFiles) {
		// F-12: an escaping/absolute declared test path is never read (distinct
		// from merely absent — P10 keeps the two reasons distinguishable).
		const abs = resolveInsideWorktree(worktreePath, normRel);
		if (abs === null) {
			protectionScan.push(`${normRel}: escaping/absolute declared path — never read (F-12)`);
			continue;
		}
		if (!existsSync(abs)) {
			protectionScan.push(`${normRel}: not on disk at entry — not scanned`);
			continue;
		}
		try {
			const hits = scanImmutabilityIdioms(readFileSync(abs, "utf8"));
			protectionScan.push(`${normRel}: ${hits.length} immutability idiom hit(s)${hits.length ? ` — ${hits.map((h) => `${h.path} (${h.via})`).join(", ")}` : ""}`);
			for (const h of hits) protectedClaims.push({ path: h.path, source: `${normRel}:${h.wording}` });
		} catch {
			protectionScan.push(`${normRel}: unreadable — not scanned`);
		}
	}
	const invariantsAbs = resolveInsideWorktree(worktreePath, "repo-invariants.json");
	if (invariantsAbs !== null && existsSync(invariantsAbs)) {
		try {
			const parsed = JSON.parse(readFileSync(invariantsAbs, "utf8")) as { protected?: unknown; rationale?: unknown } | null;
			// adv gate B-4: valid JSON null is a STRUCTURE error, not an unparseable
			// file (P10 honest classification).
			const declared = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.protected)
				? parsed.protected.filter((p): p is string => typeof p === "string" && !!p).map(claimPathUsable).filter((p): p is string => p !== null)
				: null;
			if (!declared) {
				protectionScan.push("repo-invariants.json: present but malformed (expected {protected: string[]}) — skipped");
			} else {
				protectionScan.push(`repo-invariants.json: ${declared.length} declared protected path(s)${declared.length ? ` — ${declared.join(", ")}` : ""}`);
				for (const p of declared) protectedClaims.push({ path: p, source: "repo-invariants.json" });
			}
		} catch {
			protectionScan.push("repo-invariants.json: present but unparseable — skipped");
		}
	}
	if (protectedClaims.length > 0) {
		// 059 R1A (§6 handoff contract): the Check 3 amendmentFamily exemption
		// consumer — an owner-approved amendment family (DesignData.amendmentFamily
		// ?? SpecificationData.amendmentFamily, persisted by knowledge.ts at
		// stages.design/stages.spec) exempts its declared sharedFile paths from
		// protection-threat pairs, so an APPROVED amendment does not re-trigger the
		// P1 scanner that fired on SCENARIO-014. Fail-closed on malformed knowledge
		// (grill R8): ANY malformed shape ⇒ ZERO exemptions (P1 behavior unchanged);
		// absent file/field ⇒ zero exemptions silently (nothing was declared).
		const exemptSharedFiles = readAmendmentFamilySharedFiles(specDirectory, protectionScan);
		const writeClaims = list.map((p) => [...new Set((p?.deliverables?.requireFiles ?? []).filter((f) => typeof f === "string" && f).map(norm))]);
		const pairs = new Map<string, { protectingSource: string; writingPhase: string; paths: string[] }>();
		for (let j = 0; j < list.length; j++) {
			for (const f of writeClaims[j]) {
				for (const c of protectedClaims) {
					if (c.path !== f) continue;
					if (exemptSharedFiles.has(f)) {
						// P10 honest visibility: the pair is EXEMPTED, never silently dropped.
						protectionScan.push(`check3 exemption: ${c.source} × ${phaseLabel(list[j], j)} on ${f} — owner-approved amendmentFamily (see stages.design/stages.spec .knowledge.json)`);
						continue;
					}
					const writingPhase = phaseLabel(list[j], j);
					const key = `${c.source}\u0000${writingPhase}`;
					const pair = pairs.get(key) ?? { protectingSource: c.source, writingPhase, paths: [] };
					if (!pair.paths.includes(f)) pair.paths.push(f);
					pairs.set(key, pair);
				}
			}
		}
		for (const pair of pairs.values()) {
			contradictions.push({
				kind: "protection-threat",
				title: `plan contradiction (protection-threat): phase ${pair.writingPhase} declares protected path(s) ${pair.paths.join(", ")} as requireFiles — protected by ${pair.protectingSource}`,
				detail: `A mechanically extracted immutability claim (${pair.protectingSource}) demands ${pair.paths.join(", ")} stay untouched, while phase ${pair.writingPhase} declares the same path(s) as deliverables (requireFiles) it must write. {protected} ∧ {written} = ⊥ — no executor quality resolves an inconsistent contract; revise the plan (move the write to the owning scope, drop the protection, or merge the scopes).`,
				evidence: [
					`protection: ${pair.protectingSource} → ${pair.paths.join(", ")}`,
					`write claim: ${pair.writingPhase} requireFiles ${pair.paths.join(", ")}`,
				],
				blocking: true,
				ownerStage: "spec",
				protectingSource: pair.protectingSource,
				writingPhase: pair.writingPhase,
				paths: pair.paths,
			});
		}
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

	return { contradictions, advisories, protectionScan };
}

/** 059 R1A: read the declared amendment family's sharedFile set from
 *  `<specDirectory>/.knowledge.json` (knowledge.ts persists each stage's
 *  control at stages.<id>.data). Resolution order is the 059 §6 handoff
 *  contract: stages.design.data.amendmentFamily ?? stages.spec.data.
 *  amendmentFamily — design is the authoritative home; spec is the Stage
 *  6-skip fallback. FAIL-CLOSED (grill R8): unparseable JSON, wrong envelope,
 *  or ANY malformed family entry ⇒ an EMPTY set (zero exemptions — Check 3
 *  stays exactly as landed); absent file / absent field ⇒ empty set (nothing
 *  was declared). Every non-empty outcome ALSO needs every entry's sharedFile
 *  to survive claimPathUsable (P6: one containment spelling). */
function readAmendmentFamilySharedFiles(specDirectory: string | undefined, protectionScan: string[]): Set<string> {
	if (!specDirectory) return new Set();
	const abs = resolveInsideWorktree(specDirectory.endsWith("/") ? specDirectory.slice(0, -1) : specDirectory, ".knowledge.json");
	if (abs === null || !existsSync(abs)) return new Set();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(abs, "utf8"));
	} catch {
		protectionScan.push(".knowledge.json: present but unparseable — zero Check 3 amendmentFamily exemptions (fail-closed)");
		return new Set();
	}
	const stages = (parsed as { stages?: unknown } | null)?.stages;
	if (!stages || typeof stages !== "object" || Array.isArray(stages)) {
		protectionScan.push(".knowledge.json: malformed (expected {stages: {...}}) — zero Check 3 amendmentFamily exemptions (fail-closed)");
		return new Set();
	}
	const familyOf = (stageId: string): unknown => {
		const row = (stages as Record<string, unknown>)[stageId] as { data?: unknown } | undefined;
		const data = row && typeof row === "object" && !Array.isArray(row) ? (row.data as { amendmentFamily?: unknown } | undefined) : undefined;
		return data && typeof data === "object" ? (data as { amendmentFamily?: unknown }).amendmentFamily : undefined;
	};
	const raw = familyOf("design") ?? familyOf("spec");
	if (raw === undefined || raw === null) return new Set(); // nothing declared
	if (!Array.isArray(raw)) {
		protectionScan.push(".knowledge.json: amendmentFamily is not an array — zero Check 3 exemptions (fail-closed)");
		return new Set();
	}
	const out = new Set<string>();
	for (const entry of raw) {
		const sharedFile = (entry as { sharedFile?: unknown } | null)?.sharedFile;
		if (typeof sharedFile !== "string" || !sharedFile.trim()) {
			// One malformed entry poisons the WHOLE read (grill R8): an owner-
			// approved exemption must never be inferred from a malformed family.
			protectionScan.push(".knowledge.json: malformed amendmentFamily entry (sharedFile must be a non-empty string) — zero Check 3 exemptions (fail-closed)");
			return new Set();
		}
		const usable = claimPathUsable(sharedFile);
		if (usable) out.add(usable);
	}
	return out;
}

/** True when the later-owned file at HEAD makes `x` import-satisfiable:
 *  JS/TS family — an EXPORT (multi-line tolerant); Python family — a top-level
 *  def/class/assignment (no export keyword exists; ADV-v0379-2a: a `class X:` in
 *  the later file was falsely flagged as unavailable). */
function fileExportsIdentifier(worktreePath: string, rel: string, x: string): boolean {
	try {
		// F-12: same containment guard as identifierAvailableAtHead.
		const abs = resolveInsideWorktree(worktreePath, norm(rel));
		if (abs === null) return false;
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

// ── Wave P1 D-A (docs/requirements/058-cross-phase-contract-architecture.md
// Layer 1): the mechanical immutability-claim scanner. P4: purely mechanical
// (regex), zero LLM — the incident's own assertion was machine-detectable.
// P6: ONE scanner module — Layer 2 (write-time protection intervals, Wave P2)
// MUST reuse this export, never re-implement the grammar. P8 bound: ONE pass
// over the plan-declared requireTests files at Stage 9 entry (the validator
// runs once per run — feasibilityOnce in implementation.ts); test files
// authored DURING the run are Layer 2's write-time concern, not re-scanned
// here. P10: detected hits are surfaced per scanned file in the report's
// protectionScan lines so silent idiom misses stay visible.

/** One mechanically extracted immutability claim from a single test file. */
export interface ImmutabilityIdiomHit {
	/** Repo-relative protected path (normalized). */
	path: string;
	/** How the path was extracted: the porcelain `-- <path>` pathspec, or a
	 *  quote-adjacent code path near the immutability wording. */
	via: "porcelain-pathspec" | "message-quoted-path";
	/** The immutability wording the claim was extracted against (proof
	 *  text for the finding). */
	wording: string;
}

/** The S-A idiom class: a `git status --porcelain` invocation co-present in
 *  the SAME file with immutability message wording. */
const PORCELAIN_BASE_RE = /git\s+status\s+--porcelain/g;
const IMMUTABILITY_WORDING_RE = /byte.untouched|must stay untouched|must (?:remain|be) (?:unchanged|unmodified)|unmodified in git/gi;
/** Quote-adjacent .ts/.py/.md/.json path tokens — the documented else-branch
 *  (message-named protected paths when the porcelain call carries no
 *  pathspec). Extension family is exactly the spec's enumerated set. */
const CODE_PATH_TOKEN_RE = /[A-Za-z0-9_.\-/]+\.(?:ts|py|md|json)\b/g;
/** How far around an immutability-wording match a quote-adjacent path may
 *  sit and still count as "near the match". */
const NEAR_MATCH_WINDOW = 200;

/** Repo-relative containment + normalization for a protected-path CLAIM
 *  (exported for 059 D-R-A: the contract-surface extractor COMPOSES this —
 *  P6, one spelling of the containment rule, never duplicated). */
export function claimPathUsable(raw: string): string | null {
	const p = norm(raw);
	// F-12 containment (adv gate B-2): parent traversal and absolute/host paths
	// are never repo-relative protected claims.
	if (!p || p.startsWith("/") || p.startsWith("../") || p.includes("/../") || /^[A-Za-z]:/.test(p)) return null;
	return p;
}

/** The `-- <path>` pathspec following a porcelain base match, on the same
 *  line (quoted or bare first token — a multi-path pathspec keeps its LEADING
 *  path, a documented bound). Null when the call carries none. */
function porcelainPathspecAfter(text: string, from: number): string | null {
	const nl = text.indexOf("\n", from);
	const rest = text.slice(from, nl === -1 ? undefined : nl);
	const m = /^(?:=[^\s]+|\s+(?:-[^\s]+\s+)*)*\s*--\s+(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|([^\s"'`]+))/.exec(rest);
	if (!m) return null;
	const p = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
	return p || null;
}

/** Scan ONE test file's source text for the idiomatic immutability class
 *  (the run-2026-09-13 SCENARIO-014 shape). Pure: never throws, never reads
 *  the filesystem, never spawns git. Hit contract: a `git status --porcelain`
 *  occurrence AND an immutability-wording match must BOTH be present in the
 *  file (co-presence — the wording alone is prose, the porcelain alone is a
 *  shell invocation, neither is a protection claim). Protected paths = every
 *  porcelain pathspec ∪ every quote-adjacent .ts/.py/.md/.json path token
 *  within ±200 chars of a wording match (deduped; the pathspec form is the
 *  authoritative `via` when both extract the same path). */
export function scanImmutabilityIdioms(sourceText: string): ImmutabilityIdiomHit[] {
	const text = String(sourceText ?? "");
	if (!text) return [];
	PORCELAIN_BASE_RE.lastIndex = 0;
	const porcelainEnds: number[] = [];
	for (let m = PORCELAIN_BASE_RE.exec(text); m !== null; m = PORCELAIN_BASE_RE.exec(text)) {
		porcelainEnds.push(m.index + m[0].length);
	}
	if (porcelainEnds.length === 0) return [];
	IMMUTABILITY_WORDING_RE.lastIndex = 0;
	const wordings: Array<{ text: string; index: number }> = [];
	for (let m = IMMUTABILITY_WORDING_RE.exec(text); m !== null; m = IMMUTABILITY_WORDING_RE.exec(text)) {
		wordings.push({ text: m[0], index: m.index });
	}
	if (wordings.length === 0) return [];
	const byPath = new Map<string, ImmutabilityIdiomHit>();
	const claim = (raw: string, via: ImmutabilityIdiomHit["via"], wording: string) => {
		const path = claimPathUsable(raw);
		if (!path) return;
		const prev = byPath.get(path);
		if (!prev) byPath.set(path, { path, via, wording });
		else if (via === "porcelain-pathspec") prev.via = via; // pathspec is the authoritative form
	};
	for (const end of porcelainEnds) {
		const spec = porcelainPathspecAfter(text, end);
		if (spec) claim(spec, "porcelain-pathspec", wordings[0].text);
	}
	for (const w of wordings) {
		const from = Math.max(0, w.index - NEAR_MATCH_WINDOW);
		const to = Math.min(text.length, w.index + w.text.length + NEAR_MATCH_WINDOW);
		const window = text.slice(from, to);
		CODE_PATH_TOKEN_RE.lastIndex = 0;
		for (let t = CODE_PATH_TOKEN_RE.exec(window); t !== null; t = CODE_PATH_TOKEN_RE.exec(window)) {
			// adv gate B-1: SYMMETRIC quoting — the token must open AND close with
			// the same quote character. A leading quote alone admits unrelated
			// imports, prose doc paths, and partial filenames (`src/foo.ts` inside
			// `src/foo.ts.bak`, `` matching before `.bak`); a trailing non-quote
			// character (`.bak`, `.tmp`) rejects the token. Asymmetry is a safe
			// false negative; a false positive burns a REPLAN round.
			const absIdx = from + t.index;
			const before = absIdx > 0 ? text[absIdx - 1] : "";
			const afterIdx = absIdx + t[0].length;
			const after = afterIdx < text.length ? text[afterIdx] : "";
			const symmetric = (before === '"' && after === '"') || (before === "'" && after === "'") || (before === "`" && after === "`");
			if (symmetric) claim(t[0], "message-quoted-path", w.text);
		}
	}
	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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
