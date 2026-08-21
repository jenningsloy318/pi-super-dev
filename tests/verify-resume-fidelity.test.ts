/**
 * V1 (v0.3.10) — Stage 10/11 resume fidelity: REPLAYED rounds must not arm
 * terminal exits (stagnation / dead-state). Mirrors the writer loops' F3
 * contract ("replayed rounds do not consume the fresh budget") for the
 * verify-family loops: history is evidence for state reconstruction, never
 * evidence for termination.
 *
 * Incident: run 2026-08-21T07-20-57-254Z (v0.3.4) — resume replayed two
 * recorded identical reviewer failures as cache hits; the in-memory
 * signature histories counted them as the "2 consecutive identical rounds"
 * and stagnation broke the loop before ANY fresh agent call (escalation 3;
 * the user had to hand-drop the pipeline.verify.* cache rows).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { reviewLoopUntil, classifyIntegrationObservation } from "../src/stages/verify.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const findings = (file: string, severity: string, title: string) => ({ id: "x", severity, title, detail: "d", file });

const fakeCtx = (): StageContext => ({ log: () => {}, task: "", options: {}, state: {} as PipelineState } as unknown as StageContext);

/** A spec dir whose persisted resume cache holds `rounds` recorded rounds of
 *  all three Stage 10 review agents (identical-failure death shape). */
function specDirWithVerifyRounds(rounds: number): string {
	const d = mkdtempSync(join(tmpdir(), "sd-vrf-"));
	const rows: string[] = [];
	for (let n = 1; n <= rounds; n++) {
		for (const id of ["pipeline.verify.code-review", "pipeline.verify.adversarial", "pipeline.verify.tests-review"]) {
			rows.push(`{"key":"${id}@root#${n}","result":{"text":"","control":{}}}`);
		}
	}
	writeFileSync(join(d, ".resume-cache.jsonl"), rows.join("\n") + "\n");
	return d;
}

function specDirWithIntegrationRounds(rounds: number): string {
	const d = mkdtempSync(join(tmpdir(), "sd-vrf-i-"));
	const rows: string[] = [];
	for (let n = 1; n <= rounds; n++) {
		for (const id of ["pipeline.integration.api-test", "pipeline.integration.ui-test"]) {
			rows.push(`{"key":"${id}@root#${n}","result":{"text":"","control":{}}}`);
		}
	}
	writeFileSync(join(d, ".resume-cache.jsonl"), rows.join("\n") + "\n");
	return d;
}

/** Resumed-run state: review + resume marker + spec dir. */
function resumedState(review: Record<string, unknown>, specDir: string): PipelineState {
	return {
		review,
		options: { resumeSpecIdentifier: "04-dimension-contract" },
		setup: { specDirectory: specDir, worktreePath: specDir },
	} as unknown as PipelineState;
}

/** Carry the loop's persisted bookkeeping (what the loop node does in-process)
 *  from one observation's state to the next — mirrors tests/stagnation.test.ts. */
function carry(prior: PipelineState, next: PipelineState): PipelineState {
	const p = prior as unknown as Record<string, unknown>;
	const n = next as unknown as Record<string, unknown>;
	for (const k of ["__reviewSignatures", "__reviewCounts", "__verifyReplayArms", "__verifyReplayObs",
		"__testSignatures", "__testCounts", "__integrationReplayArms", "__integrationReplayObs"]) {
		if (k in p) n[k] = p[k];
	}
	return next;
}

const CHANGES = (fs: Array<Record<string, unknown>>) => ({ verdict: "Changes Requested", findings: fs });

afterEach(() => { delete process.env.SUPER_DEV_NO_VERIFY_REPLAY_GUARD; });

describe("V1 — Stage 10 review loop resume fidelity", () => {
	it("T1 (the incident): replayed observations never arm; stagnation requires 2 consecutive FRESH identical rounds", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			const F = [findings("src/orchestrator.ts", "high", "G17 constructibility conflict")];
			// obs1 = pre-loop baseline; obs2/obs3 = after the two REPLAYED rounds;
			// obs4 = after the first FRESH round; obs5 = after the second FRESH round.
			let s = resumedState(CHANGES(F), d);
			const results: boolean[] = [];
			let armed: PipelineState | null = null;
			const obs = async (state: PipelineState) => {
				const r = await reviewLoopUntil(state, fakeCtx());
				results.push(r);
				if (r) armed = state; // __stagnated lands on the state that armed
				return carry(state, resumedState(CHANGES(F), d));
			};
			s = await obs(s);
			s = await obs(s); // THE incident: pre-fix stagnation fires here
			s = await obs(s);
			s = await obs(s); // first FRESH identical round alone must not arm
			s = await obs(s); // second consecutive FRESH identical round arms
			expect(results, "only the 5th (2nd fresh) observation arms; pre-fix arms at #2").toEqual([false, false, false, false, true]);
			expect((armed as unknown as Record<string, unknown>).__stagnated).toBeTruthy();
			expect((s as unknown as Record<string, unknown>).__verifyReplayObs).toBe(3);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T2 (dead-state): replayed rounds cannot dead-state break; the first fresh post-body observation can", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			// empty findings + no build driver + absent build gate = dead-state shape
			let s = resumedState(CHANGES([]), d);
			const results: boolean[] = [];
			let armed: PipelineState | null = null;
			const obs = async (state: PipelineState) => {
				const r = await reviewLoopUntil(state, fakeCtx());
				results.push(r);
				if (r) armed = state;
				return carry(state, resumedState(CHANGES([]), d));
			};
			s = await obs(s); // baseline must not dead-state
			s = await obs(s); // pre-fix: roundsCompleted>0 fires here (THE incident)
			s = await obs(s); // replayed round must not dead-state
			s = await obs(s); // first FRESH observation: nothing in the arming history yet
			s = await obs(s); // second FRESH observation: one completed fresh round ⇒ may dead-state
			expect(results, "replayed/baseline never arm; dead-state needs one completed FRESH round in the arming history (5th obs); pre-fix arms at #2").toEqual([false, false, false, false, true]);
			const st = (armed as unknown as Record<string, unknown>).__stagnated as { kind?: string } | null;
			expect(st?.kind).toBe("blocked-on-decisions");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T3 (fresh-run parity control): without a resume marker, identical rounds arm exactly as before", async () => {
		const d = specDirWithVerifyRounds(2); // stale rows present but NOT a resumed run
		try {
			const F = [findings("a.ts", "high", "T")];
			const s = {
				review: CHANGES(F),
				options: {},
				setup: { specDirectory: d },
			} as unknown as PipelineState;
			const s1 = s;
			expect(await reviewLoopUntil(s1, fakeCtx())).toBe(false);
			const s2 = carry(s1, { review: CHANGES(F), options: {}, setup: { specDirectory: d } } as unknown as PipelineState);
			expect(await reviewLoopUntil(s2, fakeCtx()), "no resume ⇒ no exclusion ⇒ second identical round arms (old behavior)").toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T4 (guidance retry): the reviewStageNode reset clears arming histories but NOT the observation counters — post-reset rounds are fresh", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			const F = [findings("a.ts", "high", "T")];
			// replay through stagnation (5 observations; the 5th = 2nd fresh arms)
			let s = resumedState(CHANGES(F), d);
			let last = false;
			for (let i = 0; i < 5; i++) {
				const r = await reviewLoopUntil(s, fakeCtx());
				last = r;
				s = carry(s, resumedState(CHANGES(F), d));
			}
			expect(last).toBe(true);
			// reviewStageNode's retry-with-guidance reset (verify.ts): deletes the
			// arming histories only — NOT __verifyReplayObs / __verifyReplayArms.
			const p = s as unknown as Record<string, unknown>;
			delete p.__reviewSignatures;
			delete p.__reviewCounts;
			delete p.__stagnated;
			// post-reset: two identical FRESH observations re-arm
			const r1 = await reviewLoopUntil(s, fakeCtx());
			expect(r1, "first post-reset observation alone must not arm").toBe(false);
			const s2 = carry(s, resumedState(CHANGES(F), d));
			expect(await reviewLoopUntil(s2, fakeCtx()), "second post-reset identical observation re-arms (counters not reset ⇒ still fresh)").toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T5 (kill-switch): SUPER_DEV_NO_VERIFY_REPLAY_GUARD=1 restores the old arming-on-replay behavior", async () => {
		process.env.SUPER_DEV_NO_VERIFY_REPLAY_GUARD = "1";
		const d = specDirWithVerifyRounds(2);
		try {
			const F = [findings("a.ts", "high", "T")];
			let s = resumedState(CHANGES(F), d);
			expect(await reviewLoopUntil(s, fakeCtx())).toBe(false);
			s = carry(s, resumedState(CHANGES(F), d));
			expect(await reviewLoopUntil(s, fakeCtx()), "kill-switch ⇒ replayed identical round arms (pre-fix semantics)").toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T6 (stale-cache safety): cache rows without the resume marker never exclude observations", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			const F = [findings("a.ts", "high", "T")];
			// reuse path: same spec dir, but this process is a FRESH run
			const mk = () => ({ review: CHANGES(F), options: {}, setup: { specDirectory: d } } as unknown as PipelineState);
			let s = mk();
			expect(await reviewLoopUntil(s, fakeCtx())).toBe(false);
			s = carry(s, mk());
			expect(await reviewLoopUntil(s, fakeCtx())).toBe(true);
			// and the replay-arm budget was never armed
			expect((s as unknown as Record<string, unknown>).__verifyReplayArms ?? 0).toBe(0);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("V1 — Stage 11 integration loop classification", () => {
	it("T7: integration observations classify replay-derived for priorRounds recorded rounds, then fresh", async () => {
		const d = specDirWithIntegrationRounds(2);
		try {
			const mk = () => ({
				review: CHANGES([]),
				options: { resumeSpecIdentifier: "04-x" },
				setup: { specDirectory: d, worktreePath: d },
			} as unknown as PipelineState);
			// integration has no baseline observation: obs1..2 are the recorded
			// rounds themselves → replay-derived; obs3+ fresh.
			const s1 = mk();
			expect(classifyIntegrationObservation(s1)).toBe(true);
			const s2 = carry(s1, mk());
			expect(classifyIntegrationObservation(s2)).toBe(true);
			const s3 = carry(s2, mk());
			expect(classifyIntegrationObservation(s3)).toBe(false);
			const s4 = carry(s3, mk());
			expect(classifyIntegrationObservation(s4)).toBe(false);
			// R2-2: the __testSignatures length participates in the boundary —
			// with the counters exhausted, an EMPTY history still classifies the
			// next observation replay-derived, while a 2-entry history does not.
			const base = mk();
			(base as unknown as Record<string, unknown>).__integrationReplayArms = 2;
			(base as unknown as Record<string, unknown>).__integrationReplayObs = 0;
			const empty = mk();
			(empty as unknown as Record<string, unknown>).__integrationReplayArms = 2;
			(empty as unknown as Record<string, unknown>).__integrationReplayObs = 0;
			(empty as unknown as Record<string, unknown>).__testSignatures = [];
			expect(classifyIntegrationObservation(empty), "empty arming history ⇒ callIndex 1 ≤ 2 ⇒ replay-derived").toBe(true);
			const withHist = mk();
			(withHist as unknown as Record<string, unknown>).__integrationReplayArms = 2;
			(withHist as unknown as Record<string, unknown>).__integrationReplayObs = 0;
			(withHist as unknown as Record<string, unknown>).__testSignatures = ["a", "b"];
			expect(classifyIntegrationObservation(withHist), "2-entry arming history ⇒ callIndex 3 > 2 ⇒ fresh").toBe(false);
			void base;
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T7b (source pin): recordTestStagnation consults the integration classification — replayed observations skip the arming push", async () => {
		const src = readFileSync(new URL("../src/stages/verify.ts", import.meta.url), "utf8");
		expect(src).toMatch(/__integrationReplayArms/);
		expect(src).toMatch(/classifyIntegrationObservation/);
		// the review path consults its own classifier and skips the arming push
		expect(src).toMatch(/__verifyReplayArms/);
		expect(src).toMatch(/__verifyReplayObs/);
	});
});

describe("V1 — the WIRED Stage 10 node (verificationConvergence stagnation choke point)", () => {
	/** Stable failure items across attempts: one blocking review finding. */
	const STAGNANT_STATE = (specDir: string): PipelineState => ({
		review: { verdict: "Changes Requested", findings: [findings("src/orchestrator.ts", "high", "G17 constructibility conflict")] },
		integration: { pass: false, status: "review-build" },
		setup: { specDirectory: specDir, worktreePath: specDir },
	}) as unknown as PipelineState;

	const WITH_FIX = (s: PipelineState): PipelineState => {
		(s as unknown as Record<string, unknown>).__lastVerificationFix = { kind: "review", changed: false };
		return s;
	};

	const rec = (attempt: number) => ({ attempt, startedAt: "", reviewFindings: 1, buildErrors: 0, integrationExpected: [], failureSignature: "sig", codeBefore: "", codeAfter: "", terminal: false });

	/** The wired node drives ALL attempts against ONE state; carry the
	 *  fingerprint history (and counters) between staged copies. */
	function carryW(prior: PipelineState, next: PipelineState): PipelineState {
		const p = prior as unknown as Record<string, unknown>;
		const n = next as unknown as Record<string, unknown>;
		for (const k of ["__verificationFailureFingerprintRounds", "__verificationReplayArms", "__lastVerificationFix"]) {
			if (k in p) n[k] = p[k];
		}
		return next;
	}

	it("W1 (the incident, wired path): replayed attempts neither push nor arm; stagnation needs 2 consecutive FRESH attempts", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			const mk = () => WITH_FIX(STAGNANT_STATE(d));
			// ctx.options carries the resume marker (the production-populated field)
			const ctx = { ...fakeCtx(), options: { resumeSpecIdentifier: "04-dimension-contract" } } as unknown as StageContext;
			const { recordVerificationStagnation } = await import("../src/stages/verify.ts");
			const results: boolean[] = [];
			let s = mk();
			for (const attempt of [1, 2, 3, 4]) {
				results.push(recordVerificationStagnation(s, ctx, rec(attempt)));
				s = carryW(s, mk());
			}
			expect(results, "replayed 1-2 must not arm (THE incident); fresh 3 alone must not; fresh 4 arms").toEqual([false, false, false, true]);
			const hist = (s as unknown as Record<string, unknown>).__verificationFailureFingerprintRounds as unknown[];
			expect(hist, "arming history holds only the 2 fresh rounds (replayed attempts never pushed)").toHaveLength(2);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("W2 (fresh-run parity): without a resume marker, attempt 2 arms exactly as before", async () => {
		const d = specDirWithVerifyRounds(2); // stale rows, NOT a resumed run
		try {
			const mk = () => WITH_FIX(STAGNANT_STATE(d));
			const ctx = { ...fakeCtx(), options: {} } as unknown as StageContext;
			const { recordVerificationStagnation } = await import("../src/stages/verify.ts");
			let s = mk();
			const r1 = recordVerificationStagnation(s, ctx, rec(1));
			s = carryW(s, mk());
			expect([r1, recordVerificationStagnation(s, ctx, rec(2))], "no resume ⇒ old behavior: attempt 2 arms").toEqual([false, true]);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("W3 (kill-switch): SUPER_DEV_NO_VERIFY_REPLAY_GUARD=1 restores arming on replayed attempts", async () => {
		process.env.SUPER_DEV_NO_VERIFY_REPLAY_GUARD = "1";
		const d = specDirWithVerifyRounds(2);
		try {
			const ctx = { ...fakeCtx(), options: { resumeSpecIdentifier: "x" } } as unknown as StageContext;
			const { recordVerificationStagnation } = await import("../src/stages/verify.ts");
			let s = WITH_FIX(STAGNANT_STATE(d));
			const r1 = recordVerificationStagnation(s, ctx, rec(1));
			s = carryW(s, WITH_FIX(STAGNANT_STATE(d)));
			expect([r1, recordVerificationStagnation(s, ctx, rec(2))], "kill-switch ⇒ replayed attempt 2 arms (pre-fix semantics)").toEqual([false, true]);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("W5 (MED-1/R2-1): route-back re-entry — attempt numbering restarts but the cumulative attempts ledger keeps re-entry attempts FRESH", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			const ctx = { ...fakeCtx(), options: { resumeSpecIdentifier: "x" } } as unknown as StageContext;
			const { recordVerificationStagnation, verificationReplayArms } = await import("../src/stages/verify.ts");
			// First entry: attempts 1-2 replayed (suppressed), 3-4 fresh → the node
			// stagnated or routed back; the attempts ledger now holds 4 records.
			const afterEntry1 = WITH_FIX(STAGNANT_STATE(d));
			(afterEntry1 as unknown as Record<string, unknown>).__verificationAttempts = [{}, {}, {}, {}];
			expect(verificationReplayArms(afterEntry1, ctx)).toBe(2);
			// Re-entry: the loop restarts `attempt` at 1, but seq = max(1, ledger 4) = 4 > arms 2 ⇒ FRESH.
			// (Pre-remediation the guard compared record.attempt directly: 1 ≤ 2 ⇒
			// suppressed — the over-suppression both reviewers flagged.)
			const r = recordVerificationStagnation(afterEntry1, ctx, rec(1));
			expect(r, "re-entry attempt 1 with 4 recorded attempts is FRESH — pushes round, may arm on recurrence").toBe(false);
			const hist = (afterEntry1 as unknown as Record<string, unknown>).__verificationFailureFingerprintRounds as unknown[] | undefined;
			expect(hist, "the re-entry attempt pushed into the arming history (not suppressed)").toHaveLength(1);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("W4 (gate source): ctx.options is authoritative; a bare state without it never excludes", async () => {
		const d = specDirWithVerifyRounds(2);
		try {
			const ctx = { ...fakeCtx(), options: {} } as unknown as StageContext; // no marker on ctx…
			let s = WITH_FIX(STAGNANT_STATE(d)); // …and none on state
			const { recordVerificationStagnation, verificationReplayArms } = await import("../src/stages/verify.ts");
			expect(verificationReplayArms(s, ctx)).toBe(0);
			const r1 = recordVerificationStagnation(s, ctx, rec(1));
			s = carryW(s, WITH_FIX(STAGNANT_STATE(d)));
			expect([r1, recordVerificationStagnation(s, ctx, rec(2))], "no marker anywhere ⇒ attempt 2 arms").toEqual([false, true]);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
