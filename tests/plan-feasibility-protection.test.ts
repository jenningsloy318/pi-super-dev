/**
 * Wave P1 D-A (docs/requirements/cross-phase-contract-architecture.md Layer 1,
 * §5 D-A) — feasibility grammar v2, Check 3 "protection-threat": the
 * MECHANICAL immutability-claim scanner (the `git status --porcelain` +
 * immutability-wording idiom inside a declared requireTests file, plus the
 * optional repo-invariants.json) × phase write claims (requireFiles) →
 * REPLAN-routable contradiction naming every (protectingSource × writingPhase)
 * pair.
 *
 * Non-circularity contract (grill round 1, Fork 1B): the fixtures contain the
 * RAW run-2026-09-13T03-24-15-047Z idiom (execSync porcelain + the
 * byte-untouched message) and NO named clause anywhere — the scanner must
 * catch the shape where it actually lives, not a clause the fixture hands it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { planFeasibilityFindings, scanImmutabilityIdioms } from "../src/stages/plan-feasibility.ts";
import type { PlanPhase, PlanFeasibilityFinding } from "../src/stages/plan-feasibility.ts";

let wt: string;
beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "sd-planfeas-prot-"));
});
afterEach(() => {
	try { rmSync(wt, { recursive: true, force: true }); } catch { /* tmp */ }
});

function writeWt(rel: string, content: string): void {
	const p = join(wt, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
}

const threats = (phases: PlanPhase[]): PlanFeasibilityFinding[] =>
	planFeasibilityFindings(phases, wt).contradictions.filter((c) => c.kind === "protection-threat");

/** The RAW run-2026-09-13 idiom (S-A / SCENARIO-014), verbatim shape: a
 * porcelain call carrying the protected pathspec + an immutability message.
 * NO requireContains/requireNotContains clause names anything — the
 * non-circular acceptance fixture (D-A acceptance criterion). */
const SCENARIO_14_PORCELAIN_PATHSPEC = [
	'import { execSync } from "node:child_process";',
	'import { expect, it } from "vitest";',
	"",
	'it("SCENARIO-014 the frozen contract holds", () => {',
	'\tconst dirty = execSync("git status --porcelain -- src/schemas.ts").toString();',
	'\texpect(dirty, "src/schemas.ts must stay byte-untouched").toBe("");',
	"});",
].join("\n");

/** The else-branch idiom: porcelain WITHOUT a pathspec, the protected path
 * named only inside the immutability message (backtick-quoted). */
const NO_PATHSPEC_BACKTICK_MESSAGE = [
	'import { execSync } from "node:child_process";',
	'import { expect, it } from "vitest";',
	"",
	'it("keeps the derived table frozen", () => {',
	'\tconst dirty = execSync("git status --porcelain").toString();',
	'\texpect(dirty, "`src/other.ts` must remain unchanged").toBe("");',
	"});",
].join("\n");

const PLAIN_TEST = 'import { expect, it } from "vitest";\nit("works", () => { expect(1).toBe(1); });\n';

describe("Wave P1 D-A — protection-threat (feasibility grammar v2, Check 3)", () => {
	it("(a) non-circular fixture: the raw run-2026-09-13 idiom with NO named clause anywhere is caught statically", () => {
		writeWt("tests/profitability-contract.test.ts", SCENARIO_14_PORCELAIN_PATHSPEC);
		const phases: PlanPhase[] = [
			{ name: "phase-fix-gates", deliverables: { requireTests: ["tests/profitability-contract.test.ts"] } },
			{ name: "phase-screen-wiring", deliverables: { requireFiles: ["src/schemas.ts"] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		const t = report.contradictions.find((c) => c.kind === "protection-threat");
		expect(t).toBeDefined();
		expect(t!.blocking).toBe(true);
		expect(t!.ownerStage).toBe("spec");
		expect(t!.protectingSource).toBe("tests/profitability-contract.test.ts:byte-untouched");
		expect(t!.writingPhase).toBe("phase-screen-wiring");
		expect(t!.paths).toEqual(["src/schemas.ts"]);
		// P10: the scanner publishes its per-file hit (silent-miss visibility).
		expect(report.protectionScan.some((l) =>
			l.startsWith("tests/profitability-contract.test.ts: 1 immutability idiom hit(s)")
			&& l.includes("src/schemas.ts (porcelain-pathspec)"),
		)).toBe(true);
	});

	it("(a′) else-branch: porcelain WITHOUT a pathspec still yields the protected path from the quoted message", () => {
		writeWt("tests/contract-b.test.ts", NO_PATHSPEC_BACKTICK_MESSAGE);
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/contract-b.test.ts"] } },
			{ name: "p-writer", deliverables: { requireFiles: ["src/other.ts"] } },
		];
		const t = threats(phases)[0];
		expect(t).toBeDefined();
		expect(t!.protectingSource).toBe("tests/contract-b.test.ts:must remain unchanged");
		expect(t!.paths).toEqual(["src/other.ts"]);
	});

	it("(b) repo-invariants.json protected path → caught, protectingSource = repo-invariants.json", () => {
		writeWt("tests/plain.test.ts", PLAIN_TEST);
		writeWt("repo-invariants.json", JSON.stringify({ protected: ["src/schemas.ts"], rationale: "frozen downstream contract" }));
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/plain.test.ts"] } },
			{ name: "p-writer", deliverables: { requireFiles: ["src/schemas.ts"] } },
		];
		const t = threats(phases)[0];
		expect(t).toBeDefined();
		expect(t!.protectingSource).toBe("repo-invariants.json");
		expect(t!.writingPhase).toBe("p-writer");
		expect(t!.paths).toEqual(["src/schemas.ts"]);
		expect(planFeasibilityFindings(phases, wt).protectionScan.some((l) => l.startsWith("repo-invariants.json: 1 declared protected path(s)") && l.includes("src/schemas.ts"))).toBe(true);
	});

	it("(c) clean plan → no finding and REPLAN not routed (the entry site routes on contradictions.length > 0); the P10 zero-hit line still publishes", () => {
		writeWt("tests/plain.test.ts", PLAIN_TEST);
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/plain.test.ts"] } },
			{ name: "p-writer", deliverables: { requireFiles: ["src/free.ts"] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions).toHaveLength(0);
		expect(report.protectionScan.some((l) => l.startsWith("tests/plain.test.ts: 0 immutability idiom hit(s)"))).toBe(true);
		// REPLAN routing pin: the entry site's route condition is exactly the
		// contradictions array these findings land in (plan-contradiction-fastfail
		// pins the triggerReplanForFindings wiring; this pins the gate itself).
		const impl = readFileSync(new URL("../src/stages/implementation.ts", import.meta.url), "utf8");
		expect(impl).toContain("if (feasibility.contradictions.length > 0)");
	});

	it("(d) every (protectingSource × writingPhase) pair is named — mixed sources and writers produce distinct findings, all blocking ownerStage=spec", () => {
		writeWt("tests/contract-a.test.ts", SCENARIO_14_PORCELAIN_PATHSPEC);
		writeWt("tests/contract-b.test.ts", NO_PATHSPEC_BACKTICK_MESSAGE);
		writeWt("repo-invariants.json", JSON.stringify({ protected: ["docs/frozen.md"] }));
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/contract-a.test.ts", "tests/contract-b.test.ts"] } },
			{ name: "p-writes-schemas", deliverables: { requireFiles: ["src/schemas.ts"] } },
			{ name: "p-writes-other", deliverables: { requireFiles: ["src/other.ts", "docs/frozen.md"] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		const found = report.contradictions.filter((c) => c.kind === "protection-threat");
		const pairs = found.map((c) => `${c.protectingSource}⨯${c.writingPhase}`);
		expect(pairs).toContain("tests/contract-a.test.ts:byte-untouched⨯p-writes-schemas");
		expect(pairs).toContain("tests/contract-b.test.ts:must remain unchanged⨯p-writes-other");
		expect(pairs).toContain("repo-invariants.json⨯p-writes-other");
		expect(found).toHaveLength(3);
		for (const f of found) {
			expect(f.blocking).toBe(true);
			expect(f.ownerStage).toBe("spec");
		}
	});

	// ── class-level precision/bounds guards (the grammar table's edges) ──────

	it("co-presence is required: immutability wording WITHOUT any porcelain call is prose, not a claim", () => {
		expect(scanImmutabilityIdioms('it("x", () => { expect(doc).toContain("src/a.ts must stay untouched"); });')).toHaveLength(0);
	});

	it("co-presence is required: a porcelain call WITHOUT immutability wording is a shell invocation, not a claim", () => {
		expect(scanImmutabilityIdioms('const out = execSync("git status --porcelain -- src/a.ts").toString();')).toHaveLength(0);
	});

	it("the pure scanner never throws on adversarial input", () => {
		expect(() => scanImmutabilityIdioms("")).not.toThrow();
		expect(() => scanImmutabilityIdioms(String.fromCharCode(0))).not.toThrow();
		expect(scanImmutabilityIdioms("git status --porcelain")).toHaveLength(0);
	});

	it("a protected path intersecting NO phase's requireFiles → no finding (the threat is the intersection, not the claim)", () => {
		writeWt("tests/plain.test.ts", PLAIN_TEST);
		writeWt("repo-invariants.json", JSON.stringify({ protected: ["src/untouched-by-anyone.ts"] }));
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/plain.test.ts"] } },
			{ name: "p-writer", deliverables: { requireFiles: ["src/different.ts"] } },
		];
		expect(threats(phases)).toHaveLength(0);
	});

	it("repo-invariants.json absent → skipped silently (no finding, no scan line)", () => {
		writeWt("tests/plain.test.ts", PLAIN_TEST);
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/plain.test.ts"] } },
			{ name: "p-writer", deliverables: { requireFiles: ["src/schemas.ts"] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(0);
		expect(report.protectionScan.some((l) => l.startsWith("repo-invariants.json:"))).toBe(false);
	});

	it("repo-invariants.json malformed → honest skip line, no finding, no throw", () => {
		writeWt("tests/plain.test.ts", PLAIN_TEST);
		writeWt("repo-invariants.json", "{not json");
		const phases: PlanPhase[] = [
			{ name: "p-tests", deliverables: { requireTests: ["tests/plain.test.ts"] } },
			{ name: "p-writer", deliverables: { requireFiles: ["src/schemas.ts"] } },
		];
		const report = planFeasibilityFindings(phases, wt);
		expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(0);
		expect(report.protectionScan.some((l) => l.startsWith("repo-invariants.json: present but"))).toBe(true);
	});

	it("F-12 containment: an escaping declared test path is NEVER read (the idiom outside the worktree cannot arm a threat)", () => {
		const outside = mkdtempSync(join(tmpdir(), "sd-planfeas-prot-out-"));
		try {
			writeFileSync(join(outside, "evil.test.ts"), SCENARIO_14_PORCELAIN_PATHSPEC.replace(/src\/schemas\.ts/g, "src/escape.ts"));
			const escapeRel = relative(wt, join(outside, "evil.test.ts"));
			expect(escapeRel.startsWith("..")).toBe(true);
			const phases: PlanPhase[] = [
				{ name: "p-tests", deliverables: { requireTests: [escapeRel] } },
				{ name: "p-writer", deliverables: { requireFiles: ["src/escape.ts"] } },
			];
			const report = planFeasibilityFindings(phases, wt);
			expect(report.contradictions.filter((c) => c.kind === "protection-threat")).toHaveLength(0);
			expect(report.protectionScan.some((l) => l.includes("escaping/absolute declared path — never read (F-12)"))).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("P6 source pin: the scanner is the module-planFeasibilityFindings consumes (one grammar module, exported for Wave-P2 Layer 2)", () => {
		const src = readFileSync(new URL("../src/stages/plan-feasibility.ts", import.meta.url), "utf8");
		expect(src).toContain("scanImmutabilityIdioms(readFileSync(abs, \"utf8\"))");
	});
});
