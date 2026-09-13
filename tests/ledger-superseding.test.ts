/**
 * v0.3.97 (058 §0 S-E / §5 D-E) — deterministic SUPERSEDING of orphaned
 * convergence-ledger findings at the injection seam.
 *
 * Observed live (run 2026-09-13T03-24-15-047Z): a REPLAN rewrote the BDD
 * into a new scenario-id space while pre-replan ledger findings still cited
 * the old ids; priorFindingsForInjection re-injected them every round, the
 * spec writer re-echoed the stale ids into its trace matrix, and the
 * deterministic trace gate (validating against the NEW BDD) bounced 5
 * consecutive rounds on SCENARIO-030. The fix supersedes (never re-anchors):
 * injectable findings citing an anchor absent from the on-disk upstream
 * artifact flip to status "superseded" with a located reason, PERSIST (P10
 * honest retention — rows are marked, never deleted), and are excluded from
 * injection. Per-family fail-open guard (P5): a missing/empty/unreadable
 * artifact disarms its family (AC ← `*-requirements.md`, SCENARIO ←
 * `*-bdd-scenarios.md`).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERGENCE_LEDGER_FILE, priorFindingsForInjection, recordConvergenceFindings } from "../src/convergence-ledger.ts";
import type { ConvergenceFindingInput } from "../src/convergence-ledger.ts";
import type { PipelineState, SetupControl } from "../src/types.ts";

function setupCtl(dir: string): SetupControl {
	return { worktreePath: dir, specDirectory: `${dir}/docs/specifications/001/`, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "001", worktreeCreated: true, initializedRepo: false };
}

function state(dir: string): PipelineState {
	return { setup: setupCtl(dir), classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } } as unknown as PipelineState;
}

/** A spec dir with a `.task` anchor and a persisted ledger built from the
 *  given finding inputs (the pre-replan state). Upstream docs are written by
 *  each test AFTERWARD — that ordering is the replan: ledger rows predate the
 *  rewritten artifacts. */
function fixture(findings: ConvergenceFindingInput[]): { dir: string; specDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "se-supersede-"));
	const specDir = `${dir}/docs/specifications/001/`;
	mkdirSync(specDir, { recursive: true });
	writeFileSync(join(specDir, ".task"), "implement the omisis thing", "utf8");
	recordConvergenceFindings(state(dir), findings, { detectedAtStage: "specReview", ownerStage: "spec" });
	return { dir, specDir };
}

function bddDoc(anchors: string[]): string {
	return `# BDD Scenarios\n\n${anchors.map((a) => `### ${a} — scenario\n\nGiven a precondition\nWhen an action\nThen an outcome\n`).join("\n")}`;
}

function reqDoc(anchors: string[]): string {
	return `# Requirements\n\n## Acceptance Criteria\n\n${anchors.map((a) => `- **${a}**: criterion text\n`).join("")}`;
}

function diskLedger(specDir: string): { findings: Array<Record<string, unknown>> } {
	return JSON.parse(readFileSync(join(specDir, CONVERGENCE_LEDGER_FILE), "utf8"));
}

// the rewritten-BDD id space from the incident (old: 030/014/044)
const NEW_SCENARIOS = Array.from({ length: 40 }, (_, i) => `SCENARIO-${String(50 + i).padStart(2, "0")}`);

describe("058 D-E: deterministic superseding of orphaned ledger anchors", () => {
	it("(a) stale-anchor finding → superseded, excluded from injection, persisted with a located reason (stale id in title OR only in evidence)", () => {
		const fx = fixture([
			{ id: "SPEC-1", title: "SCENARIO-030 traceability gap", detail: "the spec trace matrix omits SCENARIO-030", severity: "high", blocking: true, status: "open" },
			{ id: "SPEC-2", title: "evidence-only citation", detail: "gap in the matrix", severity: "high", blocking: true, status: "open", evidence: ["spec.md:12 references SCENARIO-030"] },
		]);
		try {
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), bddDoc(["SCENARIO-050", "SCENARIO-051"]), "utf8");
			const injected = priorFindingsForInjection(fx.specDir);
			expect(injected.findings).toEqual([]);
			const onDisk = diskLedger(fx.specDir).findings;
			expect(onDisk).toHaveLength(2);
			for (const row of onDisk) {
				expect(row.status).toBe("superseded");
				expect(row.blocking).toBe(false);
				expect(row.downgradeReason).toBe("superseded: anchor SCENARIO-030 missing after upstream replan");
			}
			// idempotent — the second pass re-reads the already-superseded file
			expect(priorFindingsForInjection(fx.specDir).findings).toEqual([]);
			expect(diskLedger(fx.specDir).findings).toHaveLength(2);
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});

	it("(b) valid-anchor findings are untouched on disk and still injected", () => {
		const fx = fixture([
			{ id: "OK-1", title: "SCENARIO-050 boundary missing", detail: "SCENARIO-050 edge case not covered", severity: "high", blocking: true, status: "open" },
			{ id: "OK-2", title: "AC-03 criterion untestable", detail: "AC-03 states no observable outcome", severity: "high", blocking: true, status: "open" },
		]);
		try {
			writeFileSync(join(fx.specDir, "02-requirements.md"), reqDoc(["AC-01", "AC-03", "AC-05"]), "utf8");
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), bddDoc(["SCENARIO-050", "SCENARIO-052"]), "utf8");
			const injected = priorFindingsForInjection(fx.specDir);
			expect(injected.findings.map((f) => f.id).sort()).toEqual(["OK-1", "OK-2"]);
			const onDisk = diskLedger(fx.specDir).findings;
			expect(onDisk).toHaveLength(2);
			for (const row of onDisk) {
				expect(row.status).toBe("open");
				expect(row.downgradeReason).toBeUndefined();
			}
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});

	it("(c) upstream artifacts absent OR anchor-empty → NO superseding (fail-open); findings still injected", () => {
		const fx = fixture([
			{ id: "KEEP-1", title: "SCENARIO-030 traceability gap", detail: "omits SCENARIO-030", severity: "high", blocking: true, status: "open" },
		]);
		try {
			// no artifacts at all
			let injected = priorFindingsForInjection(fx.specDir);
			expect(injected.findings.map((f) => f.id)).toEqual(["KEEP-1"]);
			// a BDD file that exists but carries zero anchors disarms the family too
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), "# BDD Scenarios\n\n(no scenarios yet)\n", "utf8");
			injected = priorFindingsForInjection(fx.specDir);
			expect(injected.findings.map((f) => f.id)).toEqual(["KEEP-1"]);
			const onDisk = diskLedger(fx.specDir).findings;
			expect(onDisk[0].status).toBe("open");
			expect(onDisk[0].downgradeReason).toBeUndefined();
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});

	it("(d) mixed anchors in one finding (one valid + one stale) → superseded; the reason names the stale id", () => {
		const fx = fixture([
			{ id: "MIX-1", title: "matrix cites SCENARIO-050 and SCENARIO-030", detail: "both rows stale-checked", severity: "high", blocking: true, status: "open" },
		]);
		try {
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), bddDoc(NEW_SCENARIOS), "utf8");
			expect(priorFindingsForInjection(fx.specDir).findings).toEqual([]);
			const row = diskLedger(fx.specDir).findings[0];
			expect(row.status).toBe("superseded");
			expect(row.downgradeReason).toBe("superseded: anchor SCENARIO-030 missing after upstream replan");
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});

	it("(e) omisis-shaped: 8 pre-replan findings citing SCENARIO-030/014/044 vs a rewritten BDD of SCENARIO-050..089 → all superseded, injection returns none, ledger retains all 8 marked", () => {
		const stale = ["SCENARIO-030", "SCENARIO-014", "SCENARIO-044"];
		const fx = fixture(Array.from({ length: 8 }, (_, i) => ({
			id: `OMISIS-${i + 1}`,
			title: `${stale[i % 3]} convergence gap ${i + 1}`,
			detail: `spec round failed against ${stale[(i + 1) % 3]}`,
			evidence: [`spec.md:${20 + i} cites ${stale[(i + 2) % 3]}`],
			severity: "high",
			blocking: true,
			status: i === 7 ? "addressed" : "open", // the addressed arm of the injectable filter too
		})));
		try {
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), bddDoc(NEW_SCENARIOS), "utf8");
			expect(priorFindingsForInjection(fx.specDir).findings).toEqual([]);
			const onDisk = diskLedger(fx.specDir).findings;
			expect(onDisk).toHaveLength(8); // P10: retained, never deleted
			for (const row of onDisk) {
				expect(row.status).toBe("superseded");
				expect(String(row.downgradeReason)).toMatch(/^superseded: anchor SCENARIO-(030|014|044) missing after upstream replan$/);
			}
			// idempotent re-entry (the restart/resume path)
			expect(priorFindingsForInjection(fx.specDir).findings).toEqual([]);
			expect(diskLedger(fx.specDir).findings).toHaveLength(8);
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});

	it("(g) adversarial Surface 1: single-digit and lowercase citations are superseded (\\d+ + /i)", () => {
		const fx = fixture([
			{ id: "LOW-1", title: "trace cites scenario-5 and AC-9", detail: "single-digit, lowercase", severity: "high", blocking: true, status: "open" },
		]);
		try {
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), bddDoc(["SCENARIO-6"]), "utf8");
			writeFileSync(join(fx.specDir, "01-requirements.md"), reqDoc(["AC-10"]), "utf8");
			const injected = priorFindingsForInjection(fx.specDir);
			expect(injected.findings).toEqual([]);
			const row = diskLedger(fx.specDir).findings[0];
			expect(row.status).toBe("superseded");
			expect(row.downgradeReason).toMatch(/anchor scenario-5 missing/i);
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});

	it("(f) per-family guard: BDD armed but requirements doc absent → SCENARIO superseding armed, AC superseding skipped", () => {
		const fx = fixture([
			{ id: "S-1", title: "SCENARIO-030 traceability gap", detail: "omits SCENARIO-030", severity: "high", blocking: true, status: "open" },
			{ id: "A-1", title: "AC-99 criterion missing", detail: "AC-99 never traced", severity: "high", blocking: true, status: "open" },
		]);
		try {
			writeFileSync(join(fx.specDir, "03-bdd-scenarios.md"), bddDoc(NEW_SCENARIOS), "utf8");
			const injected = priorFindingsForInjection(fx.specDir);
			expect(injected.findings.map((f) => f.id)).toEqual(["A-1"]); // AC family disarmed → still injected
			const byId = new Map(diskLedger(fx.specDir).findings.map((row) => [row.id, row]));
			expect(byId.get("S-1")!.status).toBe("superseded");
			expect(byId.get("S-1")!.downgradeReason).toBe("superseded: anchor SCENARIO-030 missing after upstream replan");
			expect(byId.get("A-1")!.status).toBe("open");
			expect(byId.get("A-1")!.downgradeReason).toBeUndefined();
		} finally { rmSync(fx.dir, { recursive: true, force: true }); }
	});
});
