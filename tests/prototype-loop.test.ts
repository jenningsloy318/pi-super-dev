/**
 * Postmortem 0001 case 3 — the prototype runaway loop (run
 * 2026-08-16T06-06-20-460Z: 28+ rounds, zero exits). Three layers pinned:
 * verdict normalization against the REAL observed corpus, prose-free
 * no-progress signature, and the MAX_PROTOTYPE_ROUNDS liveness cap.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prototypeStage, normalizePrototypeVerdict, MAX_PROTOTYPE_ROUNDS } from "../src/stages/prototype.ts";
import type { ControlObj, PipelineState, StageContext } from "../src/types.ts";

/** The exact verdict strings observed in the runaway run (byte-truncated). */
const OBSERVED = {
	skipped: "PROTOTYPE_SKIPPED — no numeric design constants under test (skip-clean per process)",
	caveats: "PROTOTYPE_COMPLETE_WITH_CAVEATS — all 5 constant groups empirically within tolerance",
	complete: "PROTOTYPE_COMPLETE — PASS. All five numeric design constants",
	bare: "PROTOTYPE_COMPLETE",
	passProse: "PASS — PROTOTYPE_COMPLETE. 5/5 constants PASS with delta_max = 0",
	lowerProse: "prototype verdict pass with measurements validating the numeric constants",
	terminal: "PROTOTYPE_COMPLETE — PASS (TERMINAL). 5/5 constants PASS, delta_max = 0",
};

describe("normalizePrototypeVerdict (observed corpus)", () => {
	it("maps every real-world pass vocabulary to pass", () => {
		for (const v of [OBSERVED.skipped, OBSERVED.caveats, OBSERVED.complete, OBSERVED.bare, OBSERVED.passProse, OBSERVED.lowerProse, OBSERVED.terminal, "pass", "PASS", "Pass"]) {
			expect(normalizePrototypeVerdict(v)).toBe("pass");
		}
	});
	it("maps fail vocabulary fail-closed; prefix wins over trailing prose", () => {
		for (const v of ["fail", "FAIL", "FAILED — K3 drifted", "PROTOTYPE_FAILED", "REJECT", "4/5 pass but K3 FAIL"]) {
			expect(normalizePrototypeVerdict(v)).toBe("fail");
		}
		// Documented semantics: a pass-LEADING verdict whose prose mentions a
		// documented FAIL artifact is pass-with-caveats (round 2 of the real run);
		// the cap bounds any misread.
		expect(normalizePrototypeVerdict("PASS on 4/5, FAIL on K3")).toBe("pass");
	});
	it("unknown is explicit — never a guess", () => {
		expect(normalizePrototypeVerdict("")).toBe("unknown");
		expect(normalizePrototypeVerdict(undefined)).toBe("unknown");
		expect(normalizePrototypeVerdict("maybe?")).toBe("unknown");
	});
});

function mkCountingCtx(make: (round: number) => ControlObj | null) {
	const logs: string[] = [];
	let calls = 0;
	const ctx = {
		task: "t", options: {}, state: {} as PipelineState,
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (m: string) => logs.push(m),
		phase: () => {}, events: { on() {}, off() {}, emit() {} }, results: [], signal: undefined,
		async agent() { calls++; return { text: "", control: make(calls) }; },
		async helper() { return { value: { needed: true, constants: ["K1"] } }; },
		async parallel() { return []; },
	} as unknown as StageContext;
	return { ctx, logs, calls: () => calls };
}

const ctrl = (v: string, over: Partial<ControlObj> = {}): ControlObj => ({
	title: "t", date: "2026-08-16", verdict: v, measurements: ["K1=2"], adjustments: [],
	...over,
} as ControlObj);

function state(tmpDir: string): PipelineState {
	return {
		design: { constants: ["K1"] },
		setup: { worktreePath: tmpDir, specDirectory: tmpDir, defaultBranch: "main", language: "backend", isWebUi: false, specIdentifier: "04-t", worktreeCreated: false, initializedRepo: false },
	} as unknown as PipelineState;
}

describe("prototype loop termination (three layers)", () => {
	it("LAYER 2 alone: the observed drift corpus exits on round 1 (the runaway shape is dead)", async () => {
		for (const v of [OBSERVED.bare, OBSERVED.complete, OBSERVED.caveats, OBSERVED.skipped, OBSERVED.passProse, OBSERVED.lowerProse]) {
			const d = mkdtempSync(join(tmpdir(), "sd-proto-"));
			const { ctx, calls } = mkCountingCtx(() => ctrl(v));
			try {
				const out = await prototypeStage.run(state(d), ctx);
				expect(calls()).toBe(1);
				expect(normalizePrototypeVerdict((out as { verdict?: unknown })?.verdict)).toBe("pass");
			} finally { rmSync(d, { recursive: true, force: true }); }
		}
	});

	it("exact lowercase pass still exits round 1 (unchanged happy path)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-proto2-"));
		const { ctx, calls, logs } = mkCountingCtx(() => ctrl("pass"));
		try {
			await prototypeStage.run(state(d), ctx);
			expect(calls()).toBe(1);
			expect(logs.some((l) => l.includes("PASS on round 1"))).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("identical failing measurements twice → no-progress stop (prose no longer masks it)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-proto3-"));
		const { ctx, calls, logs } = mkCountingCtx(() => ctrl("fail", { measurements: ["K1=2 measured=3"] }));
		try {
			const out = await prototypeStage.run(state(d), ctx);
			expect(calls()).toBe(2);
			expect(logs.some((l) => l.includes("no-progress"))).toBe(true);
			expect(normalizePrototypeVerdict((out as { verdict?: unknown })?.verdict)).toBe("fail");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("LAYER 3: ever-changing failures stop at the round cap", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-proto4-"));
		const { ctx, calls, logs } = mkCountingCtx((r) => ctrl("fail", { measurements: [`K1 drift=${r}`] }));
		try {
			const out = await prototypeStage.run(state(d), ctx);
			expect(calls()).toBe(MAX_PROTOTYPE_ROUNDS);
			expect(logs.some((l) => l.includes("round cap"))).toBe(true);
			expect(out).not.toBeNull();
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("null controls stop on no-progress (identical no-control signature) — never runaway", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-proto5-"));
		const { ctx, logs, calls } = mkCountingCtx(() => null);
		try {
			const out = await prototypeStage.run(state(d), ctx);
			expect(out).toBeNull();
			expect(calls()).toBe(2); // second identical no-control signature stops it
			expect(logs.some((l) => l.includes("no-progress"))).toBe(true);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("not-needed designs never loop (gate unchanged)", async () => {
		const d = mkdtempSync(join(tmpdir(), "sd-proto6-"));
		const logs: string[] = [];
		const ctx = {
			task: "t", options: {}, state: {} as PipelineState,
			budget: { check: () => true, spent: () => true, count: 0 },
			log: (m: string) => logs.push(m),
			phase: () => {}, events: { on() {}, off() {}, emit() {} }, results: [], signal: undefined,
			async agent() { throw new Error("must not spawn"); },
			async helper() { return { value: { needed: false } }; },
			async parallel() { return []; },
		} as unknown as StageContext;
		try {
			const s = state(d);
			expect(await prototypeStage.run(s, ctx)).toBeNull();
			expect(await prototypeStage.run({} as PipelineState, ctx)).toBeNull(); // no design
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
