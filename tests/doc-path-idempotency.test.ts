/**
 * Doc-path idempotency across retries (bug: run 253-supa-report showed
 * 06-specification.md, 09-specification.md, 11-task-list.md — the spec stage
 * re-ran and each round allocated a NEW numbered file instead of updating the
 * same one, because nextDocNumber only excluded the SAME slug while OTHER slugs'
 * files inflated the count).
 *
 * Contract: renderAndWrite for a given stage slug must WRITE THE SAME
 * `NN-<slug>.md` path on every call (overwrite in place), and multi-doc stages
 * (spec → specification / implementation-plan / task-list) must each keep their
 * own stable path across re-runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAndWrite, reserveStageDocs } from "../src/render/render.ts";
import { readSpecDoc } from "../src/doc-validators.ts";
import type { SetupControl } from "../src/types.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sd-docidem-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setup(): SetupControl {
	return {
		worktreePath: dir,
		specDirectory: `${dir}/`,
		defaultBranch: "main",
		language: "frontend",
		isWebUi: false,
		specIdentifier: "idem",
		worktreeCreated: false,
		initializedRepo: false,
	} as SetupControl;
}

const specControl = () => ({
	title: "T", date: "2026-08-12", summary: "s",
	architecture: "a", testingStrategy: "t",
	acceptanceCriteriaRefs: ["AC-01"], scenarioRefs: ["SCENARIO-001"],
	phases: [{ name: "P1", description: "d" }],
	tasks: [{ phase: "P1", description: "do it" }],
});

/** A spec control whose phase declares a formal test-deliverable contract — the
 *  field the spec-reviewer keeps demanding but the plan template used to drop. */
const specControlWithDeliverables = () => ({
	title: "T", date: "2026-08-12", summary: "s",
	architecture: "a", testingStrategy: "t",
	acceptanceCriteriaRefs: ["AC-01"], scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
	phases: [{
		name: "P1", description: "d", scenarioRefs: ["SCENARIO-001", "SCENARIO-002"],
		deliverables: {
			requireScenarios: ["SCENARIO-001", "SCENARIO-002"],
			requireTests: ["parses supa csv"],
			requireFiles: ["parser.go"],
			requireContains: [{ file: "parser.go", pattern: "ParseSupaCSV" }],
		},
	}],
	tasks: [{ phase: "P1", description: "do it", scenarioRefs: ["SCENARIO-001"] }],
});

const filesFor = (slug: string) => readdirSync(dir).filter((f) => new RegExp(`^\\d{2}-${slug}\\.md$`).test(f));

describe("renderAndWrite doc-path idempotency (retry re-uses the same NN-<slug>.md)", () => {
	it("a re-run of the SAME stage overwrites its file, not create a new index", () => {
		const first = renderAndWrite(setup(), () => {}, "requirements", {
			title: "T", date: "2026-08-12", type: "feature", priority: "high",
			executiveSummary: "e", acceptanceCriteria: [{ id: "AC-01", statement: "x" }, { id: "AC-02", statement: "y" }],
			nonFunctional: ["nf"], openQuestions: [],
		});
		const second = renderAndWrite(setup(), () => {}, "requirements", {
			title: "T2", date: "2026-08-12", type: "feature", priority: "high",
			executiveSummary: "e2", acceptanceCriteria: [{ id: "AC-01", statement: "x" }, { id: "AC-02", statement: "y" }],
			nonFunctional: ["nf"], openQuestions: [],
		});
		expect(second).toBe(first);
		expect(filesFor("requirements")).toHaveLength(1);
	});

	it("reserveStageDocs resolves the exact NN-<slug>.md paths at stage start (stable across calls)", () => {
		// spec is multi-doc: specification + implementation-plan + task-list.
		const a = reserveStageDocs(setup(), "spec");
		expect(a.map((d) => d.slug)).toEqual(["specification", "implementation-plan", "task-list"]);
		expect(a.every((d) => /^\d{2}-.+\.md$/.test(d.name))).toBe(true);
		// Reserving again (before any write) returns the SAME paths — deterministic.
		const b = reserveStageDocs(setup(), "spec");
		expect(b.map((d) => d.path)).toEqual(a.map((d) => d.path));
	});

	it("logs the reserved doc filename into the stream (`doc → NN-<slug>.md`)", () => {
		const lines: string[] = [];
		renderAndWrite(setup(), (m) => lines.push(m), "requirements", {
			title: "T", date: "2026-08-12", type: "feature", priority: "high",
			executiveSummary: "e", acceptanceCriteria: [{ id: "AC-01", statement: "x" }, { id: "AC-02", statement: "y" }],
			nonFunctional: ["nf"], openQuestions: [],
		});
		expect(lines.some((l) => /requirements: doc → \d{2}-requirements\.md/.test(l))).toBe(true);
	});

	it("the multi-doc spec stage keeps ONE file per slug across re-runs (the 06/09/11 bug)", () => {
		// Pre-populate earlier-stage docs so the naive counter would advance the index.
		writeFileSync(join(dir, "01-requirements.md"), "x");
		writeFileSync(join(dir, "02-bdd-scenarios.md"), "x");
		writeFileSync(join(dir, "03-research-report.md"), "x");
		writeFileSync(join(dir, "04-code-assessment.md"), "x");
		writeFileSync(join(dir, "05-design.md"), "x");

		const p1 = renderAndWrite(setup(), () => {}, "spec", specControl());
		const round1 = readdirSync(dir).filter((f) => /specification|implementation-plan|task-list/.test(f)).sort();

		// Re-run the spec stage (convergence retry).
		const p2 = renderAndWrite(setup(), () => {}, "spec", specControl());
		const round2 = readdirSync(dir).filter((f) => /specification|implementation-plan|task-list/.test(f)).sort();

		expect(p2).toBe(p1);
		expect(round2).toEqual(round1);
		expect(filesFor("specification")).toHaveLength(1);
		expect(filesFor("implementation-plan")).toHaveLength(1);
		expect(filesFor("task-list")).toHaveLength(1);
	});

	it("the multi-doc spec stage assigns DISTINCT consecutive indices to its 3 docs (not all the same NN)", () => {
		// Regression: reserveStageDocs resolved each slug independently, so on a
		// fresh run all three computed the same "next free" index and collided
		// (08-specification.md / 08-implementation-plan.md / 08-task-list.md).
		writeFileSync(join(dir, "01-requirements.md"), "x");
		writeFileSync(join(dir, "02-requirements-review.md"), "x");
		writeFileSync(join(dir, "03-bdd-scenarios.md"), "x");
		writeFileSync(join(dir, "04-bdd-review.md"), "x");
		writeFileSync(join(dir, "05-research-report.md"), "x");
		writeFileSync(join(dir, "06-debug-analysis.md"), "x");
		writeFileSync(join(dir, "07-code-assessment.md"), "x");

		const reserved = reserveStageDocs(setup(), "spec");
		const indices = reserved.map((d) => Number(d.name.slice(0, 2)));
		// Three DISTINCT indices …
		expect(new Set(indices).size).toBe(3);
		// … consecutive, starting right after the 7 existing docs (08, 09, 10).
		expect(indices).toEqual([8, 9, 10]);

		// And they actually WRITE to those distinct paths.
		renderAndWrite(setup(), () => {}, "spec", specControl());
		expect(filesFor("specification")).toEqual(["08-specification.md"]);
		expect(filesFor("implementation-plan")).toEqual(["09-implementation-plan.md"]);
		expect(filesFor("task-list")).toEqual(["10-task-list.md"]);
	});

	it("the rendered implementation plan carries the formal deliverables contract (not just prose Scenario refs)", () => {
		// Regression (run 2026-08-12T07-24-15: spec/review looped 8 rounds). The
		// spec-writer emitted phases[].deliverables.requireScenarios, but the plan
		// template only rendered `Scenario refs:` and DROPPED deliverables — so the
		// reviewer, reading the rendered md, kept opening the same unfixable
		// "scenario-mapped phases lack formal test deliverables" blocking finding.
		const s = setup();
		renderAndWrite(s, () => {}, "spec", specControlWithDeliverables());
		const planFile = readdirSync(dir).find((f) => /-implementation-plan\.md$/.test(f))!;
		const plan = readFileSync(join(dir, planFile), "utf8");
		// The enforceable metadata the reviewer checks for MUST be in the rendered doc.
		expect(plan).toContain("deliverables.requireScenarios");
		expect(plan).toContain("SCENARIO-001");
		expect(plan).toContain("SCENARIO-002");
		expect(plan).toContain("deliverables.requireTests");
		expect(plan).toContain("parses supa csv");
		expect(plan).toContain("ParseSupaCSV");
	});
});

// ── AC-16 (SCENARIO-035, D7 audit): control docPaths resolve against the spec
// dir — a path outside it is ignored in favor of the spec-dir glob ──
describe("readSpecDoc spec-dir containment (AC-16)", () => {
	it("an existing docPath outside the spec dir is ignored — the globbed doc inside the spec dir is returned, with exactly one warn", () => {
		const specDir = join(dir, "spec");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "02-bdd-scenarios.md"), "INSIDE-CONTENT");
		writeFileSync(join(dir, "02-bdd-scenarios.md"), "OUTSIDE-CONTENT");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const doc = readSpecDoc(specDir, { docPath: join(dir, "02-bdd-scenarios.md") }, "*-bdd-scenarios.md");
			expect(doc?.content).toBe("INSIDE-CONTENT");
			expect(doc?.path.startsWith(specDir)).toBe(true);
			const ignoring = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[doc-validators] readSpecDoc: ignoring"));
			expect(ignoring).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});
