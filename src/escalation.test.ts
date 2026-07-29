/**
 * Phase 2 — escalation budget + retry-decision helpers (spec-18 / AC-01, AC-05,
 * AC-10 / SCENARIO-010, SCENARIO-012).
 *
 * `ESCALATION_RETRY_CAP` bounds per-blocker retries ⇒ guaranteed termination.
 * `escalationBudgetRemaining` floors at 0 and is tracked per-blocker (kind).
 * `runEscalation` fires the callback under budget with a full never-throw guard
 * (no callback / exhausted / callback-throws ⇒ undefined) and stops calling
 * after the cap. `applyRetryDecision` composes worktree rollback + persisted
 * guidance for retry-with-guidance (against a REAL temp git repo + spec dir).
 *
 * RED: every assertion fails until the helpers are implemented (the stub throws).
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
	ESCALATION_RETRY_CAP,
	escalationBudgetRemaining,
	runEscalation,
	applyRetryDecision,
} from "./escalation.ts";
import type { Escalate, EscalationDecision, EscalationFailure, PipelineState } from "./types.ts";

const failure = (overrides: Partial<EscalationFailure> = {}): EscalationFailure => ({
	kind: "stagnation",
	stage: "review",
	message: "stuck",
	severity: "soft",
	...overrides,
});

const freshState = (): PipelineState => ({}) as PipelineState;

describe("escalationBudgetRemaining — bounded + per-blocker (AC-01)", () => {
	it("reports the full cap remaining for a fresh blocker", () => {
		expect(escalationBudgetRemaining(freshState(), failure())).toBe(ESCALATION_RETRY_CAP);
	});

	it("floors the remaining budget at 0 once the cap is reached", () => {
		const s = freshState();
		(s as Record<string, unknown>).__escalationRetries = { stagnation: ESCALATION_RETRY_CAP };
		expect(escalationBudgetRemaining(s, failure())).toBe(0);
	});

	it("tracks budget per-blocker (kind-keyed), not globally", () => {
		const s = freshState();
		(s as Record<string, unknown>).__escalationRetries = { stagnation: ESCALATION_RETRY_CAP };
		// A different blocker (gate-exhaustion) is independent — still full budget.
		expect(escalationBudgetRemaining(s, failure({ kind: "gate-exhaustion" }))).toBe(
			ESCALATION_RETRY_CAP,
		);
	});
});

describe("runEscalation — never-throw + bounded (AC-01 / AC-10)", () => {
	it("returns undefined when no escalate callback is wired (additive baseline)", async () => {
		await expect(runEscalation(freshState(), failure(), undefined)).resolves.toBeUndefined();
	});

	it("returns undefined and does NOT call escalate when the budget is exhausted", async () => {
		const escalate = vi.fn<Escalate>();
		const s = freshState();
		(s as Record<string, unknown>).__escalationRetries = { stagnation: ESCALATION_RETRY_CAP };
		const decision = await runEscalation(s, failure(), escalate);
		expect(decision).toBeUndefined();
		expect(escalate).not.toHaveBeenCalled();
	});

	it("returns the user's decision when escalate resolves one", async () => {
		const escalate = vi.fn<Escalate>();
		const resolved: EscalationDecision = { choice: "retry-with-guidance", guidance: "fix it" };
		escalate.mockResolvedValue(resolved);
		const decision = await runEscalation(freshState(), failure(), escalate);
		expect(decision?.choice).toBe("retry-with-guidance");
		expect(decision?.guidance).toBe("fix it");
		expect(escalate).toHaveBeenCalledTimes(1);
	});

	it("returns undefined (never throws) when escalate itself throws", async () => {
		const escalate = vi.fn<Escalate>().mockRejectedValue(new Error("ui blew up"));
		await expect(runEscalation(freshState(), failure(), escalate)).resolves.toBeUndefined();
	});

	it("stops calling escalate after ESCALATION_RETRY_CAP retries (bounded termination)", async () => {
		const escalate = vi.fn<Escalate>();
		escalate.mockResolvedValue({ choice: "retry-with-guidance", guidance: "again" });
		const s = freshState();
		await runEscalation(s, failure(), escalate);
		await runEscalation(s, failure(), escalate);
		const third = await runEscalation(s, failure(), escalate);
		expect(third).toBeUndefined();
		expect(escalate).toHaveBeenCalledTimes(ESCALATION_RETRY_CAP);
	});
});

describe("applyRetryDecision — rollback + persisted guidance (AC-05 / AC-10)", () => {
	/** A temp git repo with a committed baseline, then dirtied (modified + untracked). */
	function makeDirtyRepo(): string {
		const d = mkdtempSync(join(tmpdir(), "sd-esc-retry-"));
		execSync("git init -q", { cwd: d });
		writeFileSync(join(d, "baseline.txt"), "v1\n");
		execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: d });
		execSync('git -c user.email=t@t -c user.name=t commit -q -m base', { cwd: d });
		// Dirty the working tree: modify tracked + add untracked.
		writeFileSync(join(d, "baseline.txt"), "DIRTY\n");
		writeFileSync(join(d, "untracked.txt"), "junk\n");
		return d;
	}

	it("rolls the worktree back to HEAD and appends guidance to .user-notes.json", () => {
		const wt = makeDirtyRepo();
		const specDir = mkdtempSync(join(tmpdir(), "sd-esc-spec-"));
		try {
			applyRetryDecision(
				freshState(),
				{ choice: "retry-with-guidance", guidance: "raise the cap" },
				{ worktreePath: wt, specDirectory: specDir },
			);
			// Rolled back: tracked modification reverted, untracked file removed.
			expect(readFileSync(join(wt, "baseline.txt"), "utf8")).toBe("v1\n");
			expect(existsSync(join(wt, "untracked.txt"))).toBe(false);
			// Guidance persisted for the next specialist attempt.
			expect(existsSync(join(specDir, ".user-notes.json"))).toBe(true);
			expect(readFileSync(join(specDir, ".user-notes.json"), "utf8")).toContain("raise the cap");
		} finally {
			rmSync(wt, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("never throws even when the worktree path is invalid (degrades to fail)", () => {
		const specDir = mkdtempSync(join(tmpdir(), "sd-esc-spec-"));
		try {
			expect(() =>
				applyRetryDecision(
					freshState(),
					{ choice: "retry-with-guidance", guidance: "g" },
					{ worktreePath: "/no/such/worktree", specDirectory: specDir },
				),
			).not.toThrow();
		} finally {
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("is a safe no-op for non-retry choices (no rollback, no notes)", () => {
		const wt = makeDirtyRepo();
		const specDir = mkdtempSync(join(tmpdir(), "sd-esc-spec-"));
		try {
			applyRetryDecision(freshState(), { choice: "abandon" }, { worktreePath: wt, specDirectory: specDir });
			// Nothing rolled back — dirty working tree preserved, no notes written.
			expect(readFileSync(join(wt, "baseline.txt"), "utf8")).toBe("DIRTY\n");
			expect(existsSync(join(wt, "untracked.txt"))).toBe(true);
			expect(existsSync(join(specDir, ".user-notes.json"))).toBe(false);
		} finally {
			rmSync(wt, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});
});
