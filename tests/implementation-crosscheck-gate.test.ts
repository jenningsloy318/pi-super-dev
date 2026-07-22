/**
 * Phase 4 — Git cross-check gate wiring in `src/stages/implementation.ts`
 * (AC-07, AC-08, AC-09, AC-10 → SCENARIO-013..019).
 *
 * The phase-green verdict is extended from
 *   `(gate.pass || gate.inScopePass) && deliverableCheck.pass`
 * to
 *   `(gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass`
 * where `changeGate = computeChangeGate(tracker?.getRecord("phase", phaseId))`.
 * This closes the stockfan-style false-green a SECOND way: a phase that CLAIMS
 * to create/modify a file git does NOT show changed hard-fails EVEN WHEN build
 * + deliverable both pass (SCENARIO-013, AC-08). `changedNotClaimed` stays
 * advisory-only (SCENARIO-014); a miss feeds `claimedNotChanged` into the next
 * implementer retry under a `## Claimed changes not present in git — actually
 * create/wire these` block bounded by MAX_ATTEMPTS (SCENARIO-015); no claim →
 * trivial pass (SCENARIO-016); git-unavailable → no block (SCENARIO-017).
 *
 * The spec-10 deliverable bridge (AC-09 → SCENARIO-018) UNIONs
 * `claimed.filesCreated` into the `requireFiles` actually passed to
 * `runDeliverableCheck` (no circular double-count — spec-declared requireFiles
 * still independent). The phase end-record's `gitActual` is surfaced as a
 * `📝 N files changed (C/M/D)` evidence line (AC-10 → SCENARIO-019).
 *
 * Hermeticity: `runBuildGate`, `runDeliverableCheck`, `runRedCheck`,
 * `resetDeliverableCheckCache` AND `computeChangeGate` are fully stubbed via
 * `vi.mock` so the stage exercises ONLY its verdict composition +
 * retry-prompt injection + deliverable-bridge + evidence-surfacing logic. The
 * per-run tracker singleton (`getActiveTracker`) is replaced with a scriptable
 * fake whose `getRecord` returns a queued `ChangeRecord`, so no real git is
 * touched. `renderAndWrite` is mocked → fully disk-free. Mirrors the
 * established `tests/implementation-deliverable-wiring.test.ts` pattern.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type {
	AgentCall,
	AgentResult,
	Budget,
	ControlObj,
	HelperResult,
	PipelineState,
	RunOptions,
	Stage,
	StageContext,
} from "../src/types.ts";

// ─── Mocks (hoisted before the module under test loads) ─────────────────────
// FIFO queues per primitive so a test can script per-attempt verdicts. Empty
// queue = a clean PASS default (today's behavior). `changeGateQ` scripts the
// change-gate verdict; `deliverableArgs` captures the UNIONed requireFiles
// actually handed to runDeliverableCheck (the spec-10 bridge assertion).
const mock = vi.hoisted(() => {
	// Scriptable fake tracker: end() shifts the next queued ChangeRecord and
	// stores it as the last end-record; getRecord() returns that last record
	// (mirrors the real ChangeTracker's last-end-wins semantics). The claimed
	// set handed to end() is captured for assertions.
	// Mirrors the real ChangeTracker's phase path: begin() → probeEnd() per
	// attempt (compute + store, no jsonl append) → commitEnd() once (persist).
	// probeEnd() shifts the next queued ChangeRecord and stores it as the last
	// end-record (last-end-wins); getRecord() returns that last record. The
	// claimed set handed to probeEnd() is captured for assertions. commitEnd()
	// is a no-op beyond a counter (the record is already stored by probeEnd).
	const tracker = {
		beginCalls: 0,
		endCalls: 0,
		probeCalls: 0,
		commitCalls: 0,
		getRecordCalls: 0,
		recordQ: [] as Array<Record<string, unknown> | null>,
		claimedByEnd: [] as Array<unknown>,
		lastEnd: null as Record<string, unknown> | null,
		begin(_unit: string, _id: string): void {
			this.beginCalls++;
		},
		end(_unit: string, _id: string, claimed?: unknown): Record<string, unknown> | null {
			this.endCalls++;
			this.claimedByEnd.push(claimed ?? null);
			this.lastEnd = this.recordQ.length ? (this.recordQ.shift() ?? null) : null;
			return this.lastEnd;
		},
		// Phase path (AC-04 → SCENARIO-008/009): per-attempt probe — compute +
		// store the freshest record WITHOUT appending a jsonl line.
		probeEnd(_unit: string, _id: string, claimed?: unknown): Record<string, unknown> | null {
			this.probeCalls++;
			this.claimedByEnd.push(claimed ?? null);
			this.lastEnd = this.recordQ.length ? (this.recordQ.shift() ?? null) : null;
			return this.lastEnd;
		},
		// Phase path: close the bracket EXACTLY ONCE — persist the last probed
		// record (already stored) as the single `end` jsonl line. No-op here.
		commitEnd(_unit: string, _id: string): void {
			this.commitCalls++;
		},
		getRecord(_unit: string, _id: string): Record<string, unknown> | null {
			this.getRecordCalls++;
			return this.lastEnd;
		},
	};
	return {
		gateQ: [] as Array<Record<string, unknown>>,
		deliverableQ: [] as Array<Record<string, unknown>>,
		changeGateQ: [] as Array<{ pass: boolean; claimedNotChanged: string[] }>,
		implControlQ: [] as Array<Record<string, unknown>>,
		gateCalls: 0,
		deliverableCalls: 0,
		changeGateCalls: 0,
		lastChangeGateRec: null as unknown,
		deliverableArgs: [] as Array<unknown>,
		gateDefault: {
			pass: true,
			buildSuccess: true,
			allTestsPass: true,
			typecheckSuccess: true,
			ran: ["npm test"],
			errors: [] as string[],
			outOfScopeErrors: [] as string[],
			inScopePass: true,
		},
		deliverableDefault: { pass: true, missing: [] as string[], ran: [] as string[] },
		changeGateDefault: { pass: true, claimedNotChanged: [] as string[] },
		implControlDefault: { filesCreated: [], filesModified: [], filesDeleted: [] },
		tracker,
	};
});

vi.mock("../src/build-runner.ts", () => ({
	// No-op detection: false in tests (no real deliverables on the mock fs).
	deliverablesAlreadyMet: () => false,
	// Greenfield-safe RED oracle → no re-prompts, proceeds immediately.
	runRedCheck: (): string => "unknown",
	runBuildGate: () => {
		mock.gateCalls++;
		const r = mock.gateQ.length ? mock.gateQ.shift()! : mock.gateDefault;
		return { ...r };
	},
	runDeliverableCheck: (
		_cwd: string,
		deliverables: unknown,
	) => {
		mock.deliverableCalls++;
		// Capture the UNIONed deliverables arg for the spec-10 bridge assertion.
		mock.deliverableArgs.push(deliverables);
		const r = mock.deliverableQ.length ? mock.deliverableQ.shift()! : mock.deliverableDefault;
		return { ...r };
	},
	resetDeliverableCheckCache: () => {},
	// The gate helper is stubbed here; its LOGIC is unit-tested directly in
	// tests/compute-change-gate.test.ts. This wiring test scripts its verdict
	// so the ONLY variable is implementation.ts's verdict composition +
	// retry injection + deliverable bridge + evidence surfacing.
	computeChangeGate: (rec: unknown) => {
		mock.changeGateCalls++;
		mock.lastChangeGateRec = rec;
		const r = mock.changeGateQ.length ? mock.changeGateQ.shift()! : mock.changeGateDefault;
		return { ...r };
	},
}));

vi.mock("../src/tracking.ts", async (importActual) => {
	const actual = await importActual<typeof import("../src/tracking.ts")>();
	// Keep type exports / class intact; override the singleton to return the
	// scriptable fake so implementation.ts's getActiveTracker() picks it up.
	return { ...actual, getActiveTracker: () => mock.tracker };
});

vi.mock("../src/render/render.ts", () => ({
	renderAndWrite: vi.fn(),
}));

import { implementationStage } from "../src/stages/implementation.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const GATE_PASS = {
	pass: true,
	buildSuccess: true,
	allTestsPass: true,
	typecheckSuccess: true,
	ran: ["npm test"],
	errors: [] as string[],
	outOfScopeErrors: [] as string[],
	inScopePass: true,
};

const DELIVERABLE_PASS = { pass: true, missing: [] as string[], ran: [] as string[] };

/** Push `r` onto a queue `n` times (default MAX_ATTEMPTS=3 = persistent). */
const seedGate = (r: Record<string, unknown>, n = 3): void => {
	for (let i = 0; i < n; i++) mock.gateQ.push({ ...r });
};
const seedDeliverable = (r: Record<string, unknown>, n = 3): void => {
	for (let i = 0; i < n; i++) mock.deliverableQ.push({ ...r });
};
const seedChangeGate = (r: { pass: boolean; claimedNotChanged: string[] }, n = 1): void => {
	for (let i = 0; i < n; i++) mock.changeGateQ.push({ pass: r.pass, claimedNotChanged: [...r.claimedNotChanged] });
};
const seedTracker = (r: Record<string, unknown>, n = 1): void => {
	for (let i = 0; i < n; i++) mock.tracker.recordQ.push(r);
};
/** Script the implementer's claimed control per attempt (FIFO). */
const seedImplControl = (r: Record<string, unknown>, n = 1): void => {
	for (let i = 0; i < n; i++) mock.implControlQ.push({ ...r });
};

function mkState(
	phases: Array<{ name: string; description?: string; deliverables?: unknown }> = [{ name: "Phase A" }],
): PipelineState {
	return {
		setup: {
			worktreePath: "/tmp/sd-crosscheck",
			specDirectory: "/tmp/sd",
			defaultBranch: "main",
			language: "frontend",
			isWebUi: false,
			specIdentifier: "11",
			worktreeCreated: false,
			initializedRepo: false,
		},
		classify: { taskType: "bug", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases },
	} as unknown as PipelineState;
}

interface FakeCtx {
	logs: string[];
	agentIds: string[];
	implByAttempt: Map<number, string>;
}

/** Scripted StageContext. The implementer agent returns the queued control
 *  (claimed change set) and captures its prompt keyed by attempt. */
function mkCtx(): { ctx: StageContext; fake: FakeCtx } {
	const fake: FakeCtx = { logs: [], agentIds: [], implByAttempt: new Map() };
	const ctx: StageContext = {
		task: "",
		options: {} as RunOptions,
		state: {} as PipelineState,
		async helper(): Promise<HelperResult> {
			return { value: { languageInstructions: "" }, digest: "" };
		},
		async agent(call: AgentCall): Promise<AgentResult> {
			fake.agentIds.push(call.id);
			if (call.agent === "tdd-guide") {
				return { text: "", control: { testFiles: ["tests/red.test.ts"] } };
			}
			if (call.agent === "implementer") {
				const m = /\.impl\.a(\d+)$/.exec(call.id);
				if (m) fake.implByAttempt.set(Number(m[1]), call.prompt ?? "");
				const r = mock.implControlQ.length
					? mock.implControlQ.shift()!
					: mock.implControlDefault;
				return { text: "", control: { ...r } };
			}
			if (call.id.includes("summary")) return { text: "", control: null };
			return { text: "", control: {} as ControlObj };
		},
		async parallel(cbs) {
			return Promise.all(cbs.map((c) => c()));
		},
		budget: {
			count: 0,
			check: () => true,
			spent() {
				this.count++;
			},
		} satisfies Budget,
		log(message: string) {
			fake.logs.push(message);
		},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
	return { ctx, fake };
}

const hasLog = (logs: string[], needle: string | RegExp) =>
	logs.some((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));

beforeEach(() => {
	mock.gateQ.length = 0;
	mock.deliverableQ.length = 0;
	mock.changeGateQ.length = 0;
	mock.implControlQ.length = 0;
	mock.gateCalls = 0;
	mock.deliverableCalls = 0;
	mock.changeGateCalls = 0;
	mock.deliverableArgs.length = 0;
	mock.lastChangeGateRec = null;
	mock.tracker.beginCalls = 0;
	mock.tracker.endCalls = 0;
	mock.tracker.probeCalls = 0;
	mock.tracker.commitCalls = 0;
	mock.tracker.getRecordCalls = 0;
	mock.tracker.recordQ.length = 0;
	mock.tracker.claimedByEnd.length = 0;
	mock.tracker.lastEnd = null;
});

// ─── SCENARIO-013: the false-green killer (AC-08) ───────────────────────────

describe("Phase 4 — changeGate AND-ed into phase-green (AC-07/AC-08)", () => {
	it("SCENARIO-013: claimed filesCreated but git shows no new file → NOT green even when build+deliverable pass", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({ filesCreated: ["src/x.ts"] }, 3);
		// The change-gate FAILS on every attempt — a claimed file git never saw.
		seedChangeGate({ pass: false, claimedNotChanged: ["src/x.ts"] }, 3);

		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]),
			ctx,
		)) as ControlObj;

		// The false-green killer: build + deliverable BOTH pass, yet the phase
		// is NOT green because changeGate.pass === false.
		expect(res.allGreen).toBe(false);
		expect(res.phasesCompleted).toBe(0);
		// No commit when not green.
		expect(fake.agentIds.some((id) => id.includes("phase-01.commit"))).toBe(false);
		// The gate was actually consulted (wiring present) and bounded by MAX_ATTEMPTS.
		expect(mock.changeGateCalls).toBeGreaterThan(0);
		// The phase record was probed per-attempt (AC-04 phase path: probeEnd).
		expect(mock.tracker.probeCalls).toBeGreaterThan(0);
		// Retries respected the attempt budget (3 implementer attempts, no more).
		const implAttempts = fake.agentIds.filter((id) => /\.impl\.a\d+$/.test(id));
		expect(implAttempts.length).toBeLessThanOrEqual(3);
	});

	// ─── SCENARIO-014: under-reporting is advisory-only (AC-07) ──────────────

	it("SCENARIO-014: changedNotClaimed only → gate passes, advisory surfaced, phase green", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({ filesModified: ["src/a.ts"] });
		// Gate passes (no claimed-miss); the advisory under-reporting is logged.
		seedChangeGate({ pass: true, claimedNotChanged: [] });
		seedTracker({
			crossCheck: { claimedNotChanged: [], changedNotClaimed: ["src/orphan.ts"] },
		});

		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]),
			ctx,
		)) as ControlObj;

		// Under-reporting never fails the gate.
		expect(res.allGreen).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(hasLog(fake.logs, "GREEN on attempt 1")).toBe(true);
		// The advisory unreported edit is surfaced somewhere in the logs.
		expect(hasLog(fake.logs, "src/orphan.ts")).toBe(true);
		// The phase record was probed (AC-04 phase path: probeEnd).
		expect(mock.tracker.probeCalls).toBeGreaterThan(0);
	});

	// ─── SCENARIO-015: targeted retry within budget (AC-07) ──────────────────

	it("SCENARIO-015: a miss feeds claimedNotChanged into the next retry; a fix on retry → green", async () => {
		seedGate(GATE_PASS, 2);
		seedDeliverable(DELIVERABLE_PASS, 2);
		// Attempt 1 claims x.ts but gate fails; attempt 2 gate passes (agent wired it).
		seedImplControl({ filesCreated: ["src/x.ts"] }, 2);
		seedChangeGate({ pass: false, claimedNotChanged: ["src/x.ts"] }, 1);
		seedChangeGate({ pass: true, claimedNotChanged: [] }, 1);

		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]),
			ctx,
		)) as ControlObj;

		expect(res.allGreen).toBe(true);
		// Recovered on the SECOND attempt (not attempt 1).
		expect(hasLog(fake.logs, "GREEN on attempt 2")).toBe(true);
		// The attempt-2 implementer prompt received the targeted retry block
		// surfacing the claimed-but-absent file.
		const attempt2Prompt = fake.implByAttempt.get(2) ?? "";
		expect(attempt2Prompt).toContain("Claimed changes not present in git");
		expect(attempt2Prompt).toContain("src/x.ts");
		// Respected the attempt budget.
		expect(mock.changeGateCalls).toBe(2);
	});

	// ─── SCENARIO-016: trivial pass with no claim (AC-07) ────────────────────

	it("SCENARIO-016: phase claiming no changes → trivial pass on attempt 1", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({}); // legacy / empty claim → parseStructuredChanges empty
		seedChangeGate({ pass: true, claimedNotChanged: [] });

		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]),
			ctx,
		)) as ControlObj;

		expect(res.allGreen).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(hasLog(fake.logs, "GREEN on attempt 1")).toBe(true);
		// The gate was still evaluated (trivial pass, not skipped).
		expect(mock.changeGateCalls).toBeGreaterThan(0);
	});

	// ─── SCENARIO-017: git infrastructure unavailable → no block (AC-07) ──────

	it("SCENARIO-017: gitUnavailable record → changeGate passes, no throw, phase green", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({ filesCreated: ["src/x.ts"] });
		// Even though the agent claimed a file, git was unavailable → never block.
		seedChangeGate({ pass: true, claimedNotChanged: [] });
		seedTracker({ gitUnavailable: true, crossCheck: null, verdict: "git-unavailable" });

		const { ctx } = mkCtx();
		// Must NOT throw.
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]),
			ctx,
		)) as ControlObj;

		expect(res.allGreen).toBe(true);
		expect(res.phasesCompleted).toBe(1);
		expect(mock.changeGateCalls).toBeGreaterThan(0);
	});
});

// ─── SCENARIO-018: spec-10 deliverable bridge (AC-09) ───────────────────────

describe("Phase 4 — spec-10 deliverable bridge: claimed.filesCreated UNIONs requireFiles (AC-09)", () => {
	it("SCENARIO-018: claimed created files are UNIONed into requireFiles before runDeliverableCheck", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({ filesCreated: ["src/claimed-created.ts"] });
		seedChangeGate({ pass: true, claimedNotChanged: [] });

		await (implementationStage as Stage).run(
			mkState([
				{
					name: "Phase A",
					deliverables: { requireFiles: ["src/spec-declared.ts"] },
				},
			]),
			mkCtx().ctx,
		);

		// The deliverable check received BOTH the spec-declared file AND the
		// claimed-created file (UNION, both must exist).
		expect(mock.deliverableArgs.length).toBeGreaterThan(0);
		const contract = mock.deliverableArgs[0] as { requireFiles?: string[] };
		expect(contract.requireFiles).toContain("src/spec-declared.ts");
		expect(contract.requireFiles).toContain("src/claimed-created.ts");
	});

	it("SCENARIO-018b: spec-declared requireFiles still independently enforced (no circular double-count)", async () => {
		// An agent that claims NOTHING still has its spec-declared requireFiles
		// checked — the bridge never strips the spec contract.
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({}); // no claim
		seedChangeGate({ pass: true, claimedNotChanged: [] });

		await (implementationStage as Stage).run(
			mkState([
				{
					name: "Phase A",
					deliverables: { requireFiles: ["src/spec-declared.ts"] },
				},
			]),
			mkCtx().ctx,
		);

		const contract = mock.deliverableArgs[0] as { requireFiles?: string[] };
		expect(contract.requireFiles).toContain("src/spec-declared.ts");
	});

	it("SCENARIO-018c: a claimed-created file duplicating a spec-declared file is not double-counted", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({ filesCreated: ["src/shared.ts"] });
		seedChangeGate({ pass: true, claimedNotChanged: [] });

		await (implementationStage as Stage).run(
			mkState([
				{
					name: "Phase A",
					deliverables: { requireFiles: ["src/shared.ts"] },
				},
			]),
			mkCtx().ctx,
		);

		const contract = mock.deliverableArgs[0] as { requireFiles?: string[] };
		// Present exactly once (deduped UNION).
		expect(contract.requireFiles?.filter((p) => p === "src/shared.ts").length).toBe(1);
	});
});

// ─── SCENARIO-019: actual-change evidence surfaced (AC-10) ──────────────────

describe("Phase 4 — gitActual surfaced as concise run evidence (AC-10)", () => {
	it("SCENARIO-019: phase end-record gitActual is surfaced as a C/M/D count evidence line", async () => {
		seedGate(GATE_PASS);
		seedDeliverable(DELIVERABLE_PASS);
		seedImplControl({ filesCreated: ["src/a.ts"], filesModified: ["src/b.ts", "src/c.ts"] });
		seedChangeGate({ pass: true, claimedNotChanged: [] });
		// 1 created, 2 modified, 0 deleted.
		seedTracker({
			gitActual: { created: ["src/a.ts"], modified: ["src/b.ts", "src/c.ts"], deleted: [] },
			crossCheck: { claimedNotChanged: [], changedNotClaimed: [] },
		});

		const { ctx, fake } = mkCtx();
		const res = (await (implementationStage as Stage).run(
			mkState([{ name: "Phase A" }]),
			ctx,
		)) as ControlObj;

		expect(res.allGreen).toBe(true);
		// A concise `N files changed (C/M/D)` evidence line surfaces the counts.
		expect(hasLog(fake.logs, /\d+\s*files?\s*changed/i) || hasLog(fake.logs, /\d+C\/\d+M\/\d+D/)).toBe(true);
	});
});
