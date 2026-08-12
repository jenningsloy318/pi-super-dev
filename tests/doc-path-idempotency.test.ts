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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAndWrite, reserveStageDocs } from "../src/render/render.ts";
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
});
