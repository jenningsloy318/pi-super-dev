/**
 * v0.3.69 E3+E5 — TRIAGE (human Decide gate) + PREDICTION LEDGER.
 *
 * E3: the triage script is zero-LLM — it lists inbox drafts and, on human
 * approval, moves them to docs/findings/ with an upgraded status header; the
 * fix lifecycle then owns the change. E5: findings carry falsifiable
 * `prediction: <metric> <direction>` claims; the deterministic checker
 * compares the recent-window median (last 3 rows) to the prior baseline and
 * appends supported/refuted verdicts (never overwriting an earlier verdict).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkPredictions, renderPredictionLines } from "../src/evolution/predictions.ts";
import type { RunMetricsRow } from "../src/evolution/sigma-bands.ts";

const mkRow = (agentErrorRounds: number): RunMetricsRow => ({
	runId: `r${agentErrorRounds}`, status: "ok", agentsSpawned: 1, wallMs: 1, stages: {},
	agentErrorRounds, fatalAborts: 0, usage: { calls: 1, input: 0, output: 0, cost: 0 }, ts: 1,
});

const DRAFT_MD = `# Finding draft: reviewer errors masquerade as rejections

> status: draft — advisory-only, awaiting human triage (E3). run: run-1

prediction: agentErrorRounds decrease
`;

function mkRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "sd-e35-"));
	mkdirSync(join(root, "docs", "findings", "inbox"), { recursive: true });
	writeFileSync(join(root, "docs", "findings", "inbox", "2026-09-05T10-00-00-reviewer-masquerade.md"), DRAFT_MD, "utf8");
	return root;
}

describe("v0.3.69 E3 — triage script (zero-LLM human gate)", () => {
	it("--list prints the draft title", () => {
		const root = mkRepo();
		try {
			const out = execFileSync("node", [join(process.cwd(), "scripts", "triage.mjs"), "--list", "--dir", root], { encoding: "utf8" });
			expect(out).toContain("reviewer-masquerade.md");
			expect(out).toContain("reviewer errors masquerade as rejections");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("--approve moves the draft and upgrades the status header; refuses overwrite", () => {
		const root = mkRepo();
		try {
			const name = "2026-09-05T10-00-00-reviewer-masquerade.md";
			execFileSync("node", [join(process.cwd(), "scripts", "triage.mjs"), "--approve", name, "--dir", root], { encoding: "utf8" });
			const moved = readFileSync(join(root, "docs", "findings", name), "utf8");
			expect(moved).toMatch(/status: approved \(triaged \d{4}-\d{2}-\d{2}/);
			expect(readFileSync(join(root, "docs", "findings", name), "utf8")).toContain("prediction: agentErrorRounds decrease");
			// re-approving a moved name (nothing left in inbox) fails honestly
			const again = () => execFileSync("node", [join(process.cwd(), "scripts", "triage.mjs"), "--approve", name, "--dir", root], { encoding: "utf8", stdio: "pipe" });
			expect(again).toThrow();
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe("v0.3.69 E5 — prediction ledger", () => {
	it("a decrease prediction with falling recent medians → supported, verdict line appended", () => {
		const root = mkRepo();
		const findingsDir = join(root, "docs", "findings");
		try {
			// baseline: 6 rows at agentErrorRounds=4; recent 3 at 0 → decrease
			const rows = [4, 4, 4, 4, 4, 4, 0, 0, 0].map(mkRow);
			const verdicts = checkPredictions(findingsDir, rows);
			expect(verdicts[0]?.verdict).toBe("supported");
			const md = readFileSync(join(findingsDir, "inbox", "2026-09-05T10-00-00-reviewer-masquerade.md"), "utf8");
			expect(md).toMatch(/prediction-status: supported \(recent median 0 vs baseline 4/);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("an increase prediction with falling medians → refuted", () => {
		const root = mkRepo();
		try {
			const dir = join(root, "docs", "findings");
			writeFileSync(join(dir, "inbox", "x.md"), "# t\n\nprediction: agentErrorRounds increase\n", "utf8");
			const rows = [4, 4, 4, 4, 4, 4, 0, 0, 0].map(mkRow);
			expect(checkPredictions(dir, rows).find((v) => v.file.endsWith("x.md"))?.verdict).toBe("refuted");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("insufficient rows → unverified, NO verdict line written (wait for data)", () => {
		const root = mkRepo();
		try {
			const dir = join(root, "docs", "findings");
			const verdicts = checkPredictions(dir, [1, 2].map(mkRow));
			expect(verdicts[0]?.verdict).toBe("unverified");
			const md = readFileSync(join(dir, "inbox", "2026-09-05T10-00-00-reviewer-masquerade.md"), "utf8");
			expect(md).not.toContain("prediction-status");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("an already-adjudicated finding is never re-judged (no overwrite)", () => {
		const root = mkRepo();
		try {
			const dir = join(root, "docs", "findings");
			const f = join(dir, "inbox", "2026-09-05T10-00-00-reviewer-masquerade.md");
			writeFileSync(f, DRAFT_MD + "\nprediction-status: supported (historic)\n", "utf8");
			const verdicts = checkPredictions(dir, [4, 4, 4, 4, 4, 4, 0, 0, 0].map(mkRow));
			expect(verdicts).toHaveLength(0); // skipped entirely
			expect(readFileSync(f, "utf8")).toContain("supported (historic)");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
	it("missing dir / junk files never throw; renderPredictionLines formats", () => {
		expect(() => checkPredictions(join(tmpdir(), "sd-nope-" + Date.now()), [])).not.toThrow();
		const lines = renderPredictionLines([{ file: "a.md", metric: "agentErrorRounds", direction: "decrease", verdict: "supported", detail: "recent median 0 vs baseline 4 (n=3)" }]);
		expect(lines[0]).toContain("prediction ledger:");
		expect(lines[1]).toContain("supported");
	});
});
