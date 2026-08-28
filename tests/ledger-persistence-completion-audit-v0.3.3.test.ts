/**
 * v0.3.3 — Ledger Persistence (L1) + Completion Audit (V2).
 *
 * L1: the convergence ledger (roster + findings + duty downgrades + class
 * sweeps) was a per-run in-memory object — a resume/restart replayed cached
 * rounds but the LEDGER restarted empty, so round-1 feedback lost every
 * unresolved finding the prior run recorded. Now: mutations persist to
 * specDir/.convergence-ledger.json (keyed by the .task anchor hash) and
 * round 1 of every convergence loop injects unresolved BLOCKING findings
 * from the prior run (fingerprint-merged, idempotent).
 *
 * V2: deterministic completion audit written for every outcome; a success
 * with unresolved BLOCKING findings records an AUDIT ANOMALY.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONVERGENCE_LEDGER_FILE,
	persistConvergenceLedger,
	priorFindingsForInjection,
	recordConvergenceFindings,
	getConvergenceLedger,
	markConvergenceFindingsVerified,
} from "../src/convergence-ledger.ts";
import { completionAuditAnomaly, writeCompletionAudit, COMPLETION_AUDIT_FILE, completionAuditExists } from "../src/completion-audit.ts";
import { isHarnessBookkeepingPath } from "../src/helpers.ts";
import type { ControlObj, PipelineState, SetupControl, StageContext } from "../src/types.ts";

function setupCtl(dir: string): SetupControl {
	return { worktreePath: dir, specDirectory: `${dir}/docs/specifications/001/`, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "001", worktreeCreated: true, initializedRepo: false };
}

function state(dir: string): PipelineState {
	return { setup: setupCtl(dir), classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false } } as unknown as PipelineState;
}

const ctx = { log() {}, phase() {}, events: new EventEmitter(), results: [], task: "t", options: {}, budget: { count: 0, check: () => true, spent() { return true; } } } as unknown as StageContext;

describe("L1: persisted ledger", () => {
	it("mutations persist to specDir/.convergence-ledger.json, keyed by the .task anchor hash", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-"));
		try {
			const specDir = `${dir}/docs/specifications/001/`;
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".task"), "implement the thing", "utf8");
			const s = state(dir);
			recordConvergenceFindings(s, [{ id: "REQ-1", title: "gap", detail: "d", severity: "high", blocking: true, status: "open" }], { detectedAtStage: "requirements", ownerStage: "requirements" });
			const path = join(specDir, CONVERGENCE_LEDGER_FILE);
			expect(existsSync(path)).toBe(true);
			const raw = JSON.parse(readFileSync(path, "utf8"));
			expect(raw.version).toBe(1);
			expect(raw.findings).toHaveLength(1);
			expect(raw.findings[0].id).toBe("REQ-1");
			expect(raw.taskHash).toMatch(/^[0-9a-f]{16}$/);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("priorFindingsForInjection returns unresolved BLOCKING findings for the SAME task; skips advisories, downgrades, verified, and foreign tasks", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-"));
		try {
			const specDir = `${dir}/docs/specifications/001/`;
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".task"), "implement the thing", "utf8");
			const s = state(dir);
			recordConvergenceFindings(s, [
				{ id: "BLOCK-1", title: "blocking gap", detail: "d", severity: "high", blocking: true, status: "open" },
				{ id: "BLOCK-2", title: "addressed gap", detail: "d", severity: "high", blocking: true, status: "addressed" },
				{ id: "ADV-1", title: "advisory", detail: "d", severity: "low", blocking: false, status: "open" },
				{ id: "VER-1", title: "verified", detail: "d", severity: "high", blocking: true, status: "verified" },
				{ id: "DOWN-1", title: "duty-downgraded", detail: "d", severity: "medium", blocking: true, status: "open", downgradeReason: "convergence-duty (round 3)" },
			], { detectedAtStage: "requirements", ownerStage: "requirements" });
			const injected = priorFindingsForInjection(specDir);
			expect(injected.findings.map((f) => f.id)).toEqual(["BLOCK-1", "BLOCK-2"]);
			expect(injected.omitted).toBe(0);

			// a DIFFERENT task on the same track inherits nothing
			writeFileSync(join(specDir, ".task"), "a different task entirely", "utf8");
			expect(priorFindingsForInjection(specDir).findings).toEqual([]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("returns ALL unresolved rows — prompt capping happens at the feedback seam, never at the recording seam (v0.3.24 review-2 F5)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-"));
		try {
			const specDir = `${dir}/docs/specifications/001/`;
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".task"), "t", "utf8");
			const s = state(dir);
			recordConvergenceFindings(s, Array.from({ length: 11 }, (_, i) => ({ id: `B-${i}`, title: `gap ${i}`, detail: "d", severity: "high", blocking: true, status: "open" })), { detectedAtStage: "requirements", ownerStage: "requirements" });
			const injected = priorFindingsForInjection(specDir);
			// the old 8-row cap meant an own-owned blocker past the cap silently
			// stopped pinning after a restart (the carried exit could then fire
			// over actionable debt). Recording must see every row; the round-1
			// feedback lines cap themselves (slice + overflow note).
			expect(injected.findings).toHaveLength(11);
			expect(injected.omitted).toBe(0);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("re-recording an injected finding is fingerprint-idempotent (no duplicate rows across restarts)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-"));
		try {
			const specDir = `${dir}/docs/specifications/001/`;
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".task"), "t", "utf8");
			const s = state(dir);
			recordConvergenceFindings(s, [{ id: "REQ-9", title: "same title", detail: "same detail", severity: "high", blocking: true, status: "open" }], { detectedAtStage: "requirements", ownerStage: "requirements" });
			const prior = priorFindingsForInjection(specDir).findings;
			// a fresh in-memory ledger (the restart simulation) re-records them
			const s2 = state(dir);
			recordConvergenceFindings(s2, prior.map((f) => ({ id: f.id, title: f.title, detail: f.detail, severity: f.severity, blocking: true, status: f.status })), { detectedAtStage: "requirements", ownerStage: "requirements" });
			recordConvergenceFindings(s2, prior.map((f) => ({ id: f.id, title: f.title, detail: f.detail, severity: f.severity, blocking: true, status: f.status })), { detectedAtStage: "requirements", ownerStage: "requirements" });
			expect(getConvergenceLedger(s2).findings).toHaveLength(1);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("absent/corrupt ledger files and missing specDir are safe no-ops; persist never throws without a specDir", () => {
		expect(priorFindingsForInjection(undefined).findings).toEqual([]);
		const dir = mkdtempSync(join(tmpdir(), "sd33-"));
		try {
			const specDir = `${dir}/spec/`;
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".task"), "t", "utf8");
			writeFileSync(join(specDir, CONVERGENCE_LEDGER_FILE), "{not json", "utf8");
			expect(priorFindingsForInjection(specDir).findings).toEqual([]);
			const bare = { classify: { taskType: "feature" } } as unknown as PipelineState; // no setup
			expect(() => persistConvergenceLedger(bare)).not.toThrow();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("sd33 ADV-SD33-1/CODE-SD33-8: a missing .task anchor disables BOTH persist and injection (no hash(\"\") cross-contamination)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-anchor-"));
		try {
			const specDir = `${dir}/spec/`;
			mkdirSync(specDir, { recursive: true });
			const s = state(dir);
			(s.setup as { specDirectory: string }).specDirectory = specDir;
			recordConvergenceFindings(s, [{ id: "LEGACY-1", title: "legacy track finding", detail: "d", severity: "high", blocking: true, status: "open" }], { detectedAtStage: "requirements", ownerStage: "requirements" });
			// no .task ⇒ no file written, nothing injectable
			expect(existsSync(join(specDir, CONVERGENCE_LEDGER_FILE))).toBe(false);
			expect(priorFindingsForInjection(specDir).findings).toEqual([]);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("markConvergenceFindingsVerified persists the flip (a resume sees verified, not open)", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-"));
		try {
			const specDir = `${dir}/docs/specifications/001/`;
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, ".task"), "t", "utf8");
			const s = state(dir);
			recordConvergenceFindings(s, [{ id: "V-1", title: "to verify", detail: "d", severity: "high", blocking: true, status: "addressed" }], { detectedAtStage: "requirements", ownerStage: "requirements" });
			markConvergenceFindingsVerified(s, () => true);
			expect(priorFindingsForInjection(specDir).findings).toEqual([]); // verified → not injected
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it(".convergence-ledger.json is registered harness bookkeeping (dirty-tree exempt)", () => {
		expect(isHarnessBookkeepingPath("docs/specifications/001", "docs/specifications/001/.convergence-ledger.json")).toBe(true);
	});
});

describe("V2: completion audit", () => {

	it("sd33 CODE-SD33-1: the audit reads the REAL merge control fields (merged + verification), not a nonexistent 'verified'", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-audit-"));
		try {
			const s = auditedState(dir);
			(s as { merge: unknown }).merge = { merged: true, verification: "git-confirmed: main @ abc contains feat" };
			const md = readFileSync(writeCompletionAudit(s, "success")!, "utf8");
			expect(md).toContain("**Merge**: merged (git-confirmed");
			const unmerged = auditedState(dir, { merge: { merged: false, verification: "FAILED: ancestry" } });
			const md2 = readFileSync(writeCompletionAudit(unmerged, "partial")!, "utf8");
			expect(md2).toContain("**Merge**: not merged");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	function auditedState(dir: string, overrides: Record<string, unknown> = {}): PipelineState {
		return {
			setup: setupCtl(dir),
			classify: { taskType: "feature", uiScope: "none", language: "backend", isWebUi: false },
			implementation: { totalPhases: 3, phasesCompleted: 3, phaseStatus: [{ name: "p1", status: "green" }] },
			review: { verdict: "Approved", deferredFindings: [] },
			buildGate: { pass: true },
			integration: { pass: true },
			merge: { merged: true, verification: "git-confirmed" },
			...overrides,
		} as unknown as PipelineState;
	}

	it("writes a full audit for a success state with clean ledger", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-v2-"));
		try {
			const path = writeCompletionAudit(auditedState(dir), "success");
			expect(path).toBeTruthy();
			const md = readFileSync(path!, "utf8");
			expect(md).toContain("**Status**: success");
			expect(md).toContain("3/3 green");
			expect(md).toContain("**Merge**: merged (git-confirmed");
			expect(md).not.toContain("AUDIT ANOMALY");
			expect(completionAuditExists(`${dir}/docs/specifications/001/`)).toBe(true);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("records an AUDIT ANOMALY when success coexists with unresolved BLOCKING findings", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-v2-"));
		try {
			const s = auditedState(dir);
			recordConvergenceFindings(s, [{ id: "HOLE-1", title: "never resolved", detail: "d", severity: "high", blocking: true, status: "open" }], { detectedAtStage: "requirements", ownerStage: "requirements" });
			const path = writeCompletionAudit(s, "success")!;
			const md = readFileSync(path, "utf8");
			expect(md).toContain("AUDIT ANOMALY");
			expect(md).toContain("HOLE-1");
			expect(completionAuditAnomaly(s, "success")).toBe(true);
			expect(completionAuditAnomaly(s, "partial")).toBe(false); // partial + residue is not an anomaly
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("duty-downgraded advisories do not trigger the anomaly; partial states list residue without anomaly", () => {
		const dir = mkdtempSync(join(tmpdir(), "sd33-v2-"));
		try {
			const s = auditedState(dir);
			recordConvergenceFindings(s, [{ id: "DD-1", title: "downgraded", detail: "d", severity: "medium", blocking: true, status: "open", downgradeReason: "convergence-duty (round 3)" }], { detectedAtStage: "design", ownerStage: "design" });
			expect(completionAuditAnomaly(s, "success")).toBe(false);
			const partial = auditedState(dir, { implementation: { totalPhases: 3, phasesCompleted: 1 }, review: { verdict: "Changes Requested" } });
			recordConvergenceFindings(partial, [{ id: "R-1", title: "residue", detail: "d", severity: "high", blocking: true, status: "open" }], { detectedAtStage: "spec", ownerStage: "spec" });
			const md = readFileSync(writeCompletionAudit(partial, "partial")!, "utf8");
			expect(md).toContain("**Status**: partial");
			expect(md).toContain("Ledger residue");
			expect(md).toContain("R-1");
			expect(md).not.toContain("AUDIT ANOMALY");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("no specDir → null, never throws", () => {
		expect(writeCompletionAudit({} as PipelineState, "failed")).toBeNull();
	});

	it("wiring revert-canary: workflow.ts derives status then calls the audit for every outcome", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync("src/workflow.ts", "utf8");
		const callIdx = src.indexOf("writeCompletionAudit(state, status)");
		expect(callIdx).toBeGreaterThan(-1);
		// after the status derivation block, before the honest-completion log
		const statusIdx = src.indexOf('status = "partial";');
		expect(callIdx).toBeGreaterThan(statusIdx);
		expect(src.slice(callIdx - 60, callIdx)).toContain("try {"); // best-effort wrapper
	});
});
