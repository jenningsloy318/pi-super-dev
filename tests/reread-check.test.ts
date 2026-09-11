/**
 * P3 / D6 (DEC-12) — the deterministic reread frequency check
 * (src/evolution/reread-check.ts) + the D6 prompt-rule presence pins.
 *
 * Adversarial-gate folds pinned here:
 *  - F-04: the injected-path surface = the VERIFIED upstream-artifact docs
 *    the prompt builders embed (upstreamArtifactDocPaths) — NOT deliverable
 *    clause files.
 *  - F-05: aggregation keys on the PATH ONLY (calls sum across tools and
 *    argHeads naming the same path); findings report total calls + tools.
 *  - F-06: read/grep only (ls/find are directory listings, never a re-read);
 *    a truncation-prefix head ending "/" (a directory head) never matches.
 *
 * The check is fail-open and ADVISORY ONLY (never blocks, never actuates —
 * the same observational class as the eval stage).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	runRereadCheck, readToolUsageRows, argHeadMatchesPath, upstreamArtifactDocPaths,
	REREAD_MAX_CALLS, REREAD_READ_TOOLS, type RereadFinding,
} from "../src/evolution/reread-check.ts";
import { appendToolUsageRows, TOOL_USAGE_BASENAME } from "../src/evolution/tool-usage.ts";

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "sd-reread-")); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

const PATH = "specs/08-specification.md";

function rows(spec: Array<{ tool?: string; argHead?: string; count?: number; agent?: string }>) {
	return spec.map((s) => ({
		ts: 1, runId: "r", agent: s.agent ?? "sd-implementer",
		tool: s.tool ?? "read", argHead: s.argHead ?? PATH,
		...(s.count !== undefined ? { count: s.count } : {}),
	}));
}

describe("reread-check — count semantics (fires on > N; aggregation by PATH)", () => {
	it("count beyond REREAD_MAX_CALLS fires exactly one finding for the path", () => {
		const out = runRereadCheck({ injectedPaths: [PATH], rows: rows([{ count: REREAD_MAX_CALLS + 1 }]) });
		expect(out.findings).toHaveLength(1);
		expect(out.findings[0]).toMatchObject({ path: PATH, calls: REREAD_MAX_CALLS + 1, tools: ["read"], agents: ["sd-implementer"] });
		expect(out.warnings[0]).toContain(PATH);
		expect(out.warnings[0]).toContain("advisory");
		expect(out.note).toContain(`${REREAD_MAX_CALLS}`);
	});

	it("count == N does NOT fire (strictly greater), absent count ≡ 1 never fires alone", () => {
		expect(runRereadCheck({ injectedPaths: [PATH], rows: rows([{ count: REREAD_MAX_CALLS }]) }).findings).toHaveLength(0);
		expect(runRereadCheck({ injectedPaths: [PATH], rows: rows([{}, {}, {}]) }).findings).toHaveLength(0); // 3× absent-count rows = 3 calls
		const fourLegacy = runRereadCheck({ injectedPaths: [PATH], rows: rows([{}, {}, {}, {}]) });
		expect(fourLegacy.findings).toHaveLength(1); // 4 legacy rows ≡ 4 calls — crosses
		expect(fourLegacy.findings[0]!.calls).toBe(4);
	});

	it("F-05: counts aggregate by PATH ONLY — summing across tools, argHeads, and agents into ONE finding", () => {
		const out = runRereadCheck({ injectedPaths: [PATH], rows: rows([
			{ tool: "read", argHead: PATH, count: 2, agent: "sd-implementer" },
			{ tool: "read", argHead: `head of ${PATH} with more`, count: 1, agent: "sd-implementer" },
			{ tool: "grep", argHead: `pattern ${PATH}`, count: 1, agent: "sd-tdd-guide" },
		]) });
		expect(out.findings).toHaveLength(1); // ONE finding for the path — not three per (tool,argHead)
		expect(out.findings[0]).toMatchObject({ path: PATH, calls: 4, tools: ["grep", "read"], agents: ["sd-implementer", "sd-tdd-guide"] });
	});

	it("counts AGGREGATE across rows and agents (sum; agents attributed)", () => {
		const out = runRereadCheck({ injectedPaths: [PATH], rows: rows([
			{ count: 2, agent: "sd-implementer" },
			{ count: 2, agent: "sd-tdd-guide" },
		]) });
		expect(out.findings).toHaveLength(1);
		expect(out.findings[0]!.calls).toBe(4);
		expect(out.findings[0]!.agents).toEqual(["sd-implementer", "sd-tdd-guide"]);
	});

	it("F-06: only FILE-READING tools count (read/grep); ls/find are directory listings, never a re-read; bash is a documented gap", () => {
		expect(REREAD_READ_TOOLS).toEqual(["read", "grep"]);
		expect(runRereadCheck({ injectedPaths: [PATH], rows: rows([{ tool: "ls", argHead: "specs/", count: 50 }]) }).findings).toHaveLength(0);
		expect(runRereadCheck({ injectedPaths: [PATH], rows: rows([{ tool: "find", argHead: `find ${PATH}`, count: 50 }]) }).findings).toHaveLength(0);
		expect(runRereadCheck({ injectedPaths: [PATH], rows: rows([{ tool: "bash", argHead: `cat ${PATH}`, count: 50 }]) }).findings).toHaveLength(0);
		for (const tool of REREAD_READ_TOOLS) {
			expect(runRereadCheck({ injectedPaths: [PATH], rows: rows([{ tool, count: 9 }]) }).findings).toHaveLength(1);
		}
	});

	it("truncated argHead (path-like prefix) still matches; unrelated paths do not; a trailing-slash prefix head is a DIRECTORY head and never matches (F-06)", () => {
		expect(argHeadMatchesPath(`head of ${PATH} and more`, PATH)).toBe(true); // containment
		expect(argHeadMatchesPath("specs/08-specific", PATH)).toBe(true); // path-like truncation prefix of the full path
		expect(argHeadMatchesPath("specs/", PATH)).toBe(false); // DIRECTORY head — rejected by F-06
		expect(argHeadMatchesPath("specs/09-plan.md", PATH)).toBe(false); // different file, no containment
		expect(argHeadMatchesPath("docs/notes.md", PATH)).toBe(false);
		expect(argHeadMatchesPath("src", PATH)).toBe(false); // too short to mean anything
		expect(runRereadCheck({ injectedPaths: ["docs/unrelated.md"], rows: rows([{ count: 9 }]) }).findings).toHaveLength(0);
	});
});

describe("reread-check — fail-open + file face", () => {
	it("missing tool-usage.jsonl → honest empty outcome, never throws", () => {
		const dir = join(tmpRoot, "empty-spec");
		mkdirSync(dir, { recursive: true });
		const out = runRereadCheck({ specDir: dir, injectedPaths: [PATH] });
		expect(out.findings).toEqual([]);
		expect(out.rowsScanned).toBe(0);
		expect(out.note).toContain("no upstream-artifact path exceeded");
	});

	it("reads <specDir>/tool-usage.jsonl (the run's telemetry) and skips malformed lines (named)", () => {
		const dir = join(tmpRoot, "spec");
		mkdirSync(dir, { recursive: true });
		appendToolUsageRows(dir, [{ ts: 1, runId: "r", agent: "sd-implementer", tool: "read", argHead: PATH, count: 5 }]);
		writeFileSync(join(dir, TOOL_USAGE_BASENAME), "{ not json\n", { flag: "a" });
		const read = readToolUsageRows(dir);
		expect(read.rows).toHaveLength(1);
		expect(read.malformedRows).toBe(1);
		const out = runRereadCheck({ specDir: dir, injectedPaths: [PATH] });
		expect(out.findings).toHaveLength(1);
		expect(out.malformedRows).toBe(1);
		expect(out.rowsScanned).toBe(1);
	});
});

describe("reread-check — the finding shape the eval.reread event carries", () => {
	it("findings are plain JSON (event data must survive the ledger round-trip)", () => {
		const out = runRereadCheck({ injectedPaths: [PATH], rows: rows([{ count: 4 }]) });
		const round = JSON.parse(JSON.stringify(out.findings[0])) as RereadFinding;
		expect(round).toEqual(out.findings[0]);
	});
});

describe("upstreamArtifactDocPaths (F-04) — the VERIFIED injected-doc list", () => {
	it("derives from the stage controls the prompt builders actually embed as upstream artifacts", () => {
		const paths = upstreamArtifactDocPaths({
			requirements: { docPath: "specs/02-requirements.md" },
			bdd: { docPath: "specs/04-bdd.md" },
			research: { docPath: "specs/05-research.md" },
			assessment: { docPath: "specs/06-assessment.md" },
			design: { docs: ["specs/07-design.md", "specs/07-ui.md"] },
			prototype: { docPath: "specs/07-prototype.md" },
			spec: { specificationPath: "specs/08-specification.md", planPath: "specs/09-plan.md", implementationPlanPath: null, tasksPath: "specs/10-tasks.md", taskListPath: undefined },
		});
		expect(paths).toEqual([
			"specs/02-requirements.md", "specs/04-bdd.md", "specs/05-research.md",
			"specs/06-assessment.md", "specs/07-design.md", "specs/07-ui.md",
			"specs/07-prototype.md", "specs/08-specification.md", "specs/09-plan.md", "specs/10-tasks.md",
		]);
	});

	it("tolerates absent controls and non-string junk (cold start → []; never invents paths)", () => {
		expect(upstreamArtifactDocPaths({})).toEqual([]);
		expect(upstreamArtifactDocPaths({ requirements: null, bdd: {}, spec: { specificationPath: 42 } })).toEqual([]);
		// duplicate paths across controls collapse (one doc named twice is one artifact)
		expect(upstreamArtifactDocPaths({ bdd: { docPath: "d.md" }, spec: { tasksPath: "d.md" } })).toEqual(["d.md"]);
	});

	it("the verified list is pinned against the prompt builders' upstream-artifact lines (source contract)", () => {
		const promptsSrc = readFileSync(fileURLToPath(new URL("../src/prompts.ts", import.meta.url)), "utf8");
		// each surface upstreamArtifactDocPaths exposes is embedded by a builder
		for (const embedded of [
			"- Requirements: ${(requirements?.docPath", // buildBddPrompt / buildDesignPrompt
			"- Specification: ${(specControl?.specificationPath", // spec-review / tdd / implement / reviewers
			"- BDD Scenarios: ${(bddControl?.docPath", // buildTddPrompt
			"- Plan: ${((specControl?.planPath ?? specControl?.implementationPlanPath)", // buildSpecReviewPrompt
			"- Tasks: ${((specControl?.tasksPath ?? specControl?.taskListPath)", // buildSpecReviewPrompt
		]) {
			expect(promptsSrc).toContain(embedded);
		}
		// the design-docs + prototype-report + research/assessment docPath lines
		expect(promptsSrc).toContain("- Design: ${docs.join(");
		expect(promptsSrc).toContain("- Prototype Report: ${prototype.docPath");
		expect(promptsSrc).toContain("- Research: ${(research?.docPath");
		expect(promptsSrc).toContain("- Code Assessment: ${(assessment?.docPath");
	});
});

describe("D6 prompt rules — presence pins (the 4 work-unit prompt files)", () => {
	const files = ["implementer.md", "tdd-guide.md", "code-reviewer.md", "adversarial-reviewer.md"];
	for (const file of files) {
		it(`agents/${file} carries the upstream-artifacts-first evidence section`, () => {
			const src = readFileSync(fileURLToPath(new URL(`../agents/${file}`, import.meta.url)), "utf8");
			expect(src).toContain("Upstream-artifacts-first evidence (D6)");
			expect(src).toContain("PREFERRED evidence source");
			// the named hazard must be stated — re-reading is NOT forbidden
			expect(src).toContain("NOT forbidden");
			expect(src).toContain("stale artifact");
		});
	}
	it("the section names the deterministic reread flag so the rule and the checker share one vocabulary", () => {
		for (const file of files) {
			const src = readFileSync(fileURLToPath(new URL(`../agents/${file}`, import.meta.url)), "utf8");
			expect(src).toContain("reread check");
		}
	});
});
