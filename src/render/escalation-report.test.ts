/**
 * Phase 2 — `writeEscalationReport` contract (spec-18 / AC-01, SCENARIO-001).
 *
 * `writeEscalationReport` ALWAYS writes `escalation-report.md` (capturing the
 * failure + the user's decision) and NEVER throws — a write failure degrades to
 * a silent no-op so the run always completes. Generalizes `handleStagnation`'s
 * report body into the reusable writer invoked by `makeEscalate`.
 *
 * RED: every assertion fails until the writer is implemented (the stub throws).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEscalationReport } from "./escalation-report.ts";
import type { EscalationFailure } from "../types.ts";

const softFailure = (specDirectory: string): EscalationFailure => ({
	kind: "stagnation",
	stage: "review",
	message: "review findings stagnant across 2 consecutive rounds",
	specDirectory,
	worktreePath: "/fake/wt",
	severity: "soft",
	findings: [
		{ file: "src/a.ts", severity: "high", title: "T" },
		{ file: "src/b.ts", severity: "low", title: "U" },
	],
});

describe("writeEscalationReport — always writes (SCENARIO-001 / AC-01)", () => {
	it("writes escalation-report.md with the failure fields", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-report-"));
		try {
			writeEscalationReport(softFailure(d), undefined, d);
			expect(existsSync(join(d, "escalation-report.md"))).toBe(true);
			const body = readFileSync(join(d, "escalation-report.md"), "utf8");
			expect(body).toMatch(/stagnation/);
			expect(body).toContain("review findings stagnant across 2 consecutive rounds");
			expect(body).toMatch(/a\.ts/);
			expect(body).toMatch(/b\.ts/);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("includes the decision (choice + guidance) when provided", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-report-"));
		try {
			writeEscalationReport(softFailure(d), { choice: "retry-with-guidance", guidance: "bump retry cap" }, d);
			const body = readFileSync(join(d, "escalation-report.md"), "utf8");
			expect(body).toMatch(/retry-with-guidance/);
			expect(body).toContain("bump retry cap");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("writes a report even when the decision is undefined (headless/dismissed)", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-report-"));
		try {
			writeEscalationReport(softFailure(d), undefined, d);
			expect(existsSync(join(d, "escalation-report.md"))).toBe(true);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("records the severity (hard vs soft) in the report body", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-report-"));
		try {
			writeEscalationReport({ ...softFailure(d), kind: "gate-exhaustion", severity: "hard" }, undefined, d);
			const body = readFileSync(join(d, "escalation-report.md"), "utf8");
			expect(body.toLowerCase()).toMatch(/hard/);
			expect(body).toMatch(/gate-exhaustion/);
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("writeEscalationReport — never throws (AC-01 / SCENARIO-012)", () => {
	it("is a no-op (and does not throw) when specDirectory is undefined", () => {
		expect(() =>
			writeEscalationReport({ kind: "gate-exhaustion", message: "x" }, undefined, undefined),
		).not.toThrow();
	});

	it("does not throw when the target path is unwritable / does not exist", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-report-"));
		const ro = join(d, "ro");
		mkdirSync(ro);
		try {
			try {
				chmodSync(ro, 0o500);
			} catch {
				/* chmod may be a no-op on some platforms; the missing-nested-path
				 * write below still throws ENOENT, exercising the catch path. */
			}
			// A nested, non-existent path under a read-only dir always fails.
			expect(() =>
				writeEscalationReport(softFailure(ro), undefined, join(ro, "nested", "missing.md")),
			).not.toThrow();
		} finally {
			try {
				chmodSync(ro, 0o700);
			} catch {
				/* best-effort cleanup */
			}
			rmSync(d, { recursive: true, force: true });
		}
	});
});
