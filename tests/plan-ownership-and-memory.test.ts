import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { planFeasibilityFindings } from "../src/stages/plan-feasibility.ts";
import { priorReplanConstraintBlock } from "../src/replan/replan.ts";
import { buildSpecPrompt } from "../src/prompts.ts";

const impl = readFileSync(new URL("../src/stages/implementation.ts", import.meta.url), "utf8");
const writersSrc = readFileSync(new URL("../src/stages/writers.ts", import.meta.url), "utf8");
const promptsSrc = readFileSync(new URL("../src/prompts.ts", import.meta.url), "utf8");

function mkWt(): { wt: string; clean: () => void } {
	const wt = mkdtempSync(join(tmpdir(), "wb-"));
	return { wt, clean: () => rmSync(wt, { recursive: true, force: true }) };
}

type Phase = Parameters<typeof planFeasibilityFindings>[0][number];

describe("v0.3.80 B1 — ownership grammar (validator + enforcement alignment)", () => {
	it("co-ownership exempts the cross-phase identifier contradiction: the earliest phase co-declares the later production file (writable set covers it)", () => {
		const { wt, clean } = mkWt();
		try {
			mkdirSync(join(wt, "tests"), { recursive: true });
			mkdirSync(join(wt, "src"), { recursive: true });
			writeFileSync(join(wt, "tests/registry.test.ts"), "");
			writeFileSync(join(wt, "src/fields.ts"), "");
			const phases: Phase[] = [
				{
					name: "phase-citation",
					deliverables: {
						requireContains: [
							{ file: "tests/registry.test.ts", pattern: "CROSS_CUTTING_CITATION_FIELDS" },
							// co-ownership declaration: this phase's work edits the shared file too
							{ file: "src/fields.ts", pattern: "CROSS_CUTTING_CITATION_FIELDS" },
						],
					},
				},
				{
					name: "phase-later",
					deliverables: { requireContains: [{ file: "src/fields.ts", pattern: "CROSS_CUTTING_CITATION_FIELDS" }] },
				},
			];
			const report = planFeasibilityFindings(phases, wt);
			expect(report.contradictions.filter((c) => c.kind === "cross-phase-identifier")).toHaveLength(0);
		} finally {
			clean();
		}
	});

	it("declaredScope derives from the validator's canonical phaseClauseFiles (requireNotContains/requireTests targets count as own scope, not leaks)", () => {
		expect(impl).toContain("phaseClauseFiles(");
		// the leak site's own-scope set must come from the shared helper, not a local subset
		const leakWindow = impl.slice(impl.indexOf("const declaredScope"), impl.indexOf("const leakOwners"));
		expect(leakWindow).toContain("phaseClauseFiles");
	});

	it("the BLOCKING leak revert carries a route to approval (playbook rule: reason AND route)", () => {
		const msg = impl.slice(impl.indexOf("BLOCKING: changed-not-claimed"), impl.indexOf("BLOCKING: changed-not-claimed") + 700);
		expect(msg).toMatch(/co-ownership|declare.*phase contract|guidance|replan/i);
	});

	it("the spec prompt teaches the ownership grammar (shared files must be co-declared; production introduction precedes first test use)", () => {
		expect(promptsSrc).toMatch(/co-ownership|co-declare/i);
		expect(promptsSrc).toMatch(/production introduction.*(?:precede|before).*test|test.*import.*later phase/i);
	});
});

describe("v0.3.80 B2 — stage-close re-verification (commit fusion)", () => {
	it("reverifyPartialPhases flips a partial phase whose deliverables are satisfied at close; unsatisfied and empty contracts stay partial (fail-closed)", async () => {
		const { reverifyPartialPhases } = await import("../src/stages/implementation.ts");
		const { wt, clean } = mkWt();
		try {
			mkdirSync(join(wt, "docs"), { recursive: true });
			writeFileSync(join(wt, "docs/a.md"), "anchor present\n");
			const phases = [
				{ name: "p1", deliverables: { requireContains: [{ file: "docs/a.md", pattern: "anchor present" }] } },
				{ name: "p2", deliverables: { requireContains: [{ file: "docs/missing.md", pattern: "never landed" }] } },
				{ name: "p3", deliverables: {} },
			];
			const out = reverifyPartialPhases(phases as never, [
				{ id: "phase-01", status: "partial" },
				{ id: "phase-02", status: "partial" },
				{ id: "phase-03", status: "partial" },
			], wt, "main");
			expect(out.flippable.map((f) => f.id)).toEqual(["phase-01"]);
			expect(out.skippedVacuous).toContain("phase-03 (no affirmative clause)");
		} finally {
			clean();
		}
	});

	it("review pins: exclude set bypasses judge-owned env-blocked phases; notContains-only contracts never flip (vacuous guard); pre-existing content with an empty changed-set input stays partial when the set is provided", async () => {
		const { reverifyPartialPhases } = await import("../src/stages/implementation.ts");
		const { wt, clean } = mkWt();
		try {
			mkdirSync(join(wt, "docs"), { recursive: true });
			writeFileSync(join(wt, "docs/a.md"), "anchor present\n");
			const phases = [
				{ name: "p1", deliverables: { requireContains: [{ file: "docs/a.md", pattern: "anchor present" }] } },
				{ name: "p2", deliverables: { requireNotContains: [{ file: "docs/gone.md", pattern: "anything" }] } },
				{ name: "p3", deliverables: { requireContains: [{ file: "docs/a.md", pattern: "anchor present" }] } },
			];
			const status = [
				{ id: "phase-01", status: "partial" },
				{ id: "phase-02", status: "partial" },
				{ id: "phase-03", status: "partial" },
			];
			// exclude: judge-owned env-blocked phase-01 is never re-verified
			const out1 = reverifyPartialPhases(phases as never, status, wt, "main", new Set(["phase-01"]));
			// phase-01 excluded (judge-owned); p2 vacuous (no affirmative clause); p3 flippable
			expect(out1.flippable.map((f) => f.id)).toEqual(["phase-03"]);
			expect(out1.skippedVacuous.join("\n")).toContain("phase-02 (no affirmative clause)");
			// changed-set guard: an explicit changed set NOT touching docs/a.md keeps p3 partial (pre-existing content)
			const out2 = reverifyPartialPhases(phases as never, status, wt, "main", new Set(), new Set(["src/other.ts"]));
			expect(out2.flippable.map((f) => f.id)).toEqual([]);
			expect(out2.skippedVacuous.join("\n")).toContain("pre-existing content");
		} finally {
			clean();
		}
	});

	it("review pins: both envBlockedPhases.add terminal sites exist (terminalStopReason env-blocked + judge hand-off arm)", () => {
		const adds = impl.match(/envBlockedPhases\.add\(phaseId\)/g) ?? [];
		expect(adds.length).toBeGreaterThanOrEqual(2);
	});

	it("a green phase is never re-verified and a phase with no deliverable clauses is fail-closed partial", async () => {
		const { reverifyPartialPhases } = await import("../src/stages/implementation.ts");
		const { wt, clean } = mkWt();
		try {
			const phases = [
				{ name: "green-one", deliverables: { requireContains: [{ file: "x.ts", pattern: "y" }] } },
				{ name: "empty-one", deliverables: {} },
			];
			const out = reverifyPartialPhases(phases as never, [
				{ id: "phase-green-one", status: "green" },
				{ id: "phase-empty-one", status: "partial" },
			], wt, "main");
			expect(out.flippable).toHaveLength(0);
		} finally {
			clean();
		}
	});

	it("the close-out wiring runs before the control is built and runs the build gate before flipping (source contract)", () => {
		const controlIdx = impl.indexOf("const control: ControlObj = {");
		const reverifyIdx = impl.indexOf("reverifyPartialPhases(phases");
		expect(controlIdx).toBeGreaterThan(0);
		expect(reverifyIdx).toBeGreaterThan(0);
		expect(reverifyIdx).toBeLessThan(controlIdx);
		const window = impl.slice(reverifyIdx, reverifyIdx + 1400);
		expect(window).toContain("runBuildGate");
	});

	// ── F-04 (v0.3.86): requireTests counts as an AFFIRMATIVE clause — pre-fix a
	// test-only phase was swallowed by the "(no affirmative clause)" vacuous guard.
	it("F-04: a requireTests-only contract is affirmative — flippable when the test name exists, partial when it does not", async () => {
		const { reverifyPartialPhases } = await import("../src/stages/implementation.ts");
		const { wt, clean } = mkWt();
		try {
			mkdirSync(join(wt, "tests"), { recursive: true });
			writeFileSync(join(wt, "tests/db.test.ts"), "test('connects to db', () => {});\n");
			const phases = [
				{ name: "tests-only-satisfied", deliverables: { requireTests: ["connects to db"] } },
				{ name: "tests-only-missing", deliverables: { requireTests: ["never written"] } },
			];
			const out = reverifyPartialPhases(phases as never, [
				{ id: "phase-01", status: "partial" },
				{ id: "phase-02", status: "partial" },
			], wt, "main");
			expect(out.skippedVacuous.join("\n")).not.toContain("phase-01"); // RED pre-fix: "(no affirmative clause)"
			expect(out.flippable.map((f) => f.id)).toEqual(["phase-01"]); // RED pre-fix: []
		} finally {
			clean();
		}
	});

	// ── F-17 (v0.3.86): the misspelled export is renamed; the old spelling stays
	// as a deprecated re-export alias of the SAME function object.
	it("F-17: attributeQuarantinedViolations is the canonical export; attributQuarantinedViolations aliases it", async () => {
		const implMod = await import("../src/stages/implementation.ts");
		expect(typeof implMod.attributeQuarantinedViolations).toBe("function");
		expect(implMod.attributQuarantinedViolations).toBe(implMod.attributeQuarantinedViolations);
		// internal call sites use the corrected spelling only
		expect(impl.match(/attributQ(?!uarantinedViolations =)/g) ?? []).toHaveLength(0);
	});
});

describe("v0.3.80 B3 — plan memory across runs", () => {
	it("priorReplanConstraintBlock renders persisted replan requests as hard constraints (titles + revision asks), empty when none", () => {
		const dir = mkdtempSync(join(tmpdir(), "wb3-"));
		try {
			expect(priorReplanConstraintBlock(dir)).toBe("");
			mkdirSync(join(dir), { recursive: true });
			writeFileSync(
				join(dir, "replan-requests.json"),
				JSON.stringify({
					version: 1,
					rounds: 1,
					requests: [
						{ id: "r1", title: "plan contradiction: phase A requires CROSS_FIELDS early", requestedRevision: "move the production introduction before its first test use", ownerStage: "spec", severity: "high", status: "addressed", fingerprint: "f1", classificationSource: "judge", classificationReason: "r", createdAt: "2026-09-08T00:00:00Z" },
						{ id: "r2", title: "second finding", requestedRevision: "merge phases 3 and 4", ownerStage: "spec", severity: "medium", status: "pending", fingerprint: "f2", classificationSource: "judge", classificationReason: "r", createdAt: "2026-09-08T00:01:00Z" },
					],
				}),
			);
			const block = priorReplanConstraintBlock(dir);
			expect(block).toContain("HARD CONSTRAINT");
			expect(block).toContain("plan contradiction: phase A requires CROSS_FIELDS early");
			expect(block).toContain("move the production introduction before its first test use");
			expect(block).toContain("merge phases 3 and 4");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the spec-writer prompt carries the prior-replan constraint block (writers wiring, source contract)", () => {
		expect(writersSrc).toContain("priorReplanConstraintBlock");
	});

	it("buildSpecPrompt includes the constraint section when a block is passed", () => {
		const s = {} as never;
		const prompt = buildSpecPrompt(s, null, "do the thing", null, null, null, null, null, null, "## Prior replan findings — HARD CONSTRAINTS\n- do not re-derive the contradictory ordering");
		expect(prompt).toContain("HARD CONSTRAINTS");
		expect(prompt).toContain("do not re-derive the contradictory ordering");
	});
});
