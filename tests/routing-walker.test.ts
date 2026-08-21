/**
 * M2 routing walker tests — tests/routing-walker.test.ts
 * Pins the M2 contracts of docs/requirements/routing-architecture-routeback.md:
 * the addressable sub-walk (G1), journal IO with sync-before-re-entry (MP1),
 * persisted-budget authority (MP2), cache invalidation on re-entry (G5),
 * round-1 injection via pending replan requests, the pilot planner's
 * go/no-go, and the two-fixture golden-equivalence contract (G8).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_EDGE_BUDGET,
	RouteBackSignal,
	edgeKey,
	remainingBudget,
	routeBackOrEscalate,
} from "../src/routing/router.ts";
import {
	chargeRoutingJump,
	currentRunEpoch,
	inlineRouteBackEnabled,
	maxInlineJumps,
	persistedBudget,
	readRoutingJournal,
	ROUTING_JOURNAL_FILE,
	startRunEpoch,
	resetRunEpoch,
} from "../src/routing/journal.ts";
import {
	planInlineRouteBack,
	withInlineRouteBack,
} from "../src/routing/walker.ts";
import { appendRouteBackRequests, invalidateResumeCache, REPLAN_REQUESTS_FILE } from "../src/replan/replan.ts";
import { sequence, task } from "../src/nodes.ts";
import type { Node, NodeResult, PipelineState, Stage, StageContext } from "../src/types.ts";
import { recordConvergenceFindings } from "../src/convergence-ledger.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function mkSpecDir(): string {
	return mkdtempSync(join(tmpdir(), "sd-m2-"));
}

function recordStage(id: string, order: string[], result: NodeResult = { status: "ok" }): Stage {
	return {
		id,
		label: id,
		async run() {
			order.push(id);
			return result;
		},
	};
}

function mkCtx(log: string[] = []): StageContext {
	return {
		task: "",
		options: {},
		state: {},
		results: [] as Array<{ id: string; status: string }>,
		events: { emit() {} } as unknown as StageContext["events"],
		budget: { count: 0, check: () => true, spent() { return true; } },
		log: (m: string) => log.push(m),
		auditAppend() {},
		withScope: <T, >(_s: string, fn: () => Promise<T>) => fn(),
		async agent() { throw new Error("no agent"); },
		async helper() { throw new Error("no helper"); },
		async parallel<T>(calls: Array<() => Promise<T>>) { return Promise.all(calls.map((c) => c())); },
	} as unknown as StageContext;
}

function seedCacheRows(specDir: string, keys: string[]): void {
	mkdirSync(specDir, { recursive: true });
	writeFileSync(join(specDir, ".resume-cache.jsonl"), keys.map((k) => JSON.stringify({ key: k, result: {} })).join("\n") + "\n");
}

const FLAG = "SUPER_DEV_INLINE_ROUTEBACK";
const KILL = "SUPER_DEV_NO_INLINE_ROUTEBACK";
const savedFlag = process.env[FLAG];
const savedKill = process.env[KILL];
afterEach(() => {
	if (savedFlag === undefined) delete process.env[FLAG];
	else process.env[FLAG] = savedFlag;
	if (savedKill === undefined) delete process.env[KILL];
	else process.env[KILL] = savedKill;
	resetRunEpoch();
});
/** M3 default-ON: "off" fixtures use the kill-switch; "on" clears both. */
function setKillSwitch(): void {
	process.env[KILL] = "1";
	delete process.env[FLAG];
}
function setFlagOn(): void {
	delete process.env[KILL];
	delete process.env[FLAG];
}

// ─── journal IO ─────────────────────────────────────────────────────────────

describe("M2 journal IO (MP1/MP2/MP4)", () => {
	it("chargeRoutingJump appends synchronously with seq, budget window, and offsets", () => {
		const dir = mkSpecDir();
		const e1 = chargeRoutingJump(dir, {
			from: "bdd", to: "requirements", reason: "phantom AC", findingIds: ["F-001"],
			resumeFromIndex: 3, invalidated: ["requirements", "bdd"], at: "t1",
			cacheDropped: 2, revisionAfter: 1,
		});
		expect(e1).not.toBeNull();
		expect(e1!.seq).toBe(1);
		expect(e1!.budgetBefore).toBe(0);
		expect(e1!.budgetAfter).toBe(1);
		expect(e1!.cacheDropped).toBe(2);
		expect(e1!.revisionAfter).toBe(1);
		const e2 = chargeRoutingJump(dir, {
			from: "bdd", to: "requirements", reason: "again", findingIds: ["F-002"],
			resumeFromIndex: 3, invalidated: ["requirements"], at: "t2",
			cacheDropped: 0, revisionAfter: 2,
		});
		expect(e2!.budgetBefore).toBe(1);
		expect(e2!.budgetAfter).toBe(2);
		// Persisted authority: the journal is on disk and hydrates the budget.
		const j = readRoutingJournal(dir);
		expect(j.entries).toHaveLength(2);
		expect(persistedBudget(dir).edges[edgeKey("bdd", "requirements")]).toBe(2);
	});

	it("tolerates a torn trailing line (crash mid-append never bricks reads)", () => {
		const dir = mkSpecDir();
		chargeRoutingJump(dir, { from: "bdd", to: "requirements", reason: "r", findingIds: [], resumeFromIndex: 1, invalidated: [], at: "t", cacheDropped: 0, revisionAfter: 0 });
		writeFileSync(join(dir, ROUTING_JOURNAL_FILE), '{"seq":2,"kind":"route-bac', { flag: "a" });
		const j = readRoutingJournal(dir);
		expect(j.entries).toHaveLength(1);
		expect(j.entries[0].seq).toBe(1);
	});

	it("chargeRoutingJump fails closed (null) when the spec dir is unwritable", () => {
		// A FILE where the spec dir is expected → mkdir/append fail with ENOTDIR
		// instantly. (Do NOT use /proc here: recursive-mkdir on this machine's
		// procfs blocks indefinitely — an OS quirk that stalled the suite once.)
		const dir = mkSpecDir();
		const blocker = join(dir, "not-a-dir");
		writeFileSync(blocker, "x");
		const e = chargeRoutingJump(blocker, {
			from: "bdd", to: "requirements", reason: "r", findingIds: [], resumeFromIndex: 0, invalidated: [], at: "t", cacheDropped: 0, revisionAfter: 0,
		});
		expect(e).toBeNull();
	});
});

// ─── appendRouteBackRequests (round-1 injection carrier) ────────────────────

describe("M2 appendRouteBackRequests", () => {
	it("persists PENDING requests for the owner and dedupes by fingerprint", () => {
		const dir = mkSpecDir();
		const findings = [{ id: "F-001", title: "phantom verdict field", detail: "AC-03 references a nonexistent field", severity: "P1", recommendation: "amend AC-03" }];
		expect(appendRouteBackRequests(dir, "requirements", findings, "run-x")).toBe(1);
		const file = JSON.parse(readFileSync(join(dir, REPLAN_REQUESTS_FILE), "utf8"));
		const row = file.requests.find((r: { id: string }) => r.id === "rb-F-001");
		expect(row.status).toBe("pending");
		expect(row.ownerStage).toBe("requirements");
		expect(row.classificationSource).toBe("route-back");
		expect(row.requestedRevision).toContain("amend AC-03");
		// Dedupe: same fingerprint again → not double-injected.
		expect(appendRouteBackRequests(dir, "requirements", findings, "run-x")).toBe(0);
		expect(JSON.parse(readFileSync(join(dir, REPLAN_REQUESTS_FILE), "utf8")).requests).toHaveLength(1);
	});
});

// ─── pilot planner ──────────────────────────────────────────────────────────

describe("planInlineRouteBack (pilot go/no-go — M2 bdd edge, M3 +spec)", () => {
	it("kill-switch (M3 default-ON) → always null (byte-identical emulation)", () => {
		setKillSwitch();
		expect(inlineRouteBackEnabled()).toBe(false);
		const dir = mkSpecDir();
		expect(
			planInlineRouteBack(dir, "bdd", [{ id: "F-1", ownerStage: "requirements", blocking: true }]),
		).toBeNull();
	});

	it("default (no env) → enabled (M3 incident-closing flip)", () => {
		delete process.env[FLAG];
		delete process.env[KILL];
		expect(inlineRouteBackEnabled()).toBe(true);
	});

	it("alias SUPER_DEV_INLINE_ROUTEBACK=0 also kills", () => {
		delete process.env[KILL];
		process.env[FLAG] = "0";
		expect(inlineRouteBackEnabled()).toBe(false);
	});

	it("M3→M4 planner scope: spec→requirements AND research→requirements both plan (allowlist retired at M4)", () => {
		setFlagOn();
		const dir = mkSpecDir();
		const cmd = planInlineRouteBack(dir, "spec", [{ id: "F-9", ownerStage: "requirements", blocking: true }]);
		expect(cmd).not.toBeNull();
		expect(cmd!.from).toBe("spec");
		expect(cmd!.to).toBe("requirements");
		expect(planInlineRouteBack(dir, "research", [{ id: "F-9", ownerStage: "requirements", blocking: true }])).not.toBeNull();
	});

	it("active (default) + single strictly-upstream routable owner + budget → command", () => {
		setFlagOn();
		expect(inlineRouteBackEnabled()).toBe(true);
		const dir = mkSpecDir();
		const cmd = planInlineRouteBack(dir, "bdd", [
			{ id: "F-001", ownerStage: "requirements", blocking: true, title: "phantom AC-03" },
		]);
		expect(cmd).not.toBeNull();
		expect(cmd!.to).toBe("requirements");
		expect(cmd!.from).toBe("bdd");
		expect(cmd!.findingIds).toEqual(["F-001"]);
	});

	it("M2→M4: downstream or non-routable owners stay null (the pilot gates that mattered)", () => {
		setFlagOn();
		const dir = mkSpecDir();
		// requirements has no routable upstream — nothing precedes it.
		expect(planInlineRouteBack(dir, "requirements", [
			{ id: "G", ownerStage: "bdd", blocking: true },
		])).toBeNull();
	});

	it("advisory (non-blocking) findings never drive jumps (adv-F-6)", () => {
		setFlagOn();
		const dir = mkSpecDir();
		expect(planInlineRouteBack(dir, "bdd", [
			{ id: "N", ownerStage: "requirements", blocking: false },
		])).toBeNull();
	});

	it("multi-owner, downstream owner, fixer-domain owner, and no-budget all → null", () => {
		setFlagOn();
		const dir = mkSpecDir();
		// multi-owner is structurally IMPOSSIBLE under the M2 pilot: among
		// routable owners only `requirements` precedes `bdd` in STAGE_IDS, so a
		// bdd-surfaced blocker set can never hold two distinct upstream owners.
		// (The planner's multi-owner → null branch is M3 generality, kept.)
		// downstream routable owner (spec seen from bdd — NOT upstream)
		expect(planInlineRouteBack(dir, "bdd", [
			{ id: "C", ownerStage: "spec", blocking: true },
		])).toBeNull();
		// fixer-domain owner
		expect(planInlineRouteBack(dir, "verify", [
			{ id: "D", ownerStage: "implementation", blocking: true },
		])).toBeNull();
		// budget exhausted on the edge
		const exhausted = { [edgeKey("bdd", "requirements")]: DEFAULT_EDGE_BUDGET };
		writeFileSync(join(dir, ROUTING_JOURNAL_FILE),
			[0, 1].map((i) => JSON.stringify({ seq: i + 1, kind: "route-back", from: "bdd", to: "requirements", reason: "r", findingIds: [], resumeFromIndex: 1, invalidated: [], budgetBefore: i, budgetAfter: i + 1, at: "t" })).join("\n") + "\n");
		expect(persistedBudget(dir).edges).toEqual(exhausted);
		expect(planInlineRouteBack(dir, "bdd", [
			{ id: "E", ownerStage: "requirements", blocking: true },
		])).toBeNull();
	});
});

// ─── the walker (G1 sub-walk + G5 + MP1 ordering) ───────────────────────────

describe("M2 withInlineRouteBack — kill-switch (G8 fixture 1, M3 default-ON)", () => {
	it("rethrows RouteBackSignal unchanged — identical to a bare sequence", async () => {
		setKillSwitch();
		const order: string[] = [];
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run() {
				order.push("bdd");
				const cmd = routeBackOrEscalate("bdd", "requirements", "t", [], { edges: {} });
				if (cmd.action !== "route-back") throw new Error("unreachable");
				throw new RouteBackSignal(cmd);
			},
		};
		const children: Node[] = [task(recordStage("requirements", order)), task(thrower)];
		const walker = withInlineRouteBack(children);
		const plain = sequence(children, { tolerant: true });
		const log: string[] = [];
		await expect(walker.run({} as PipelineState, mkCtx(log))).rejects.toSatisfy((e: unknown) =>
			e instanceof RouteBackSignal,
		);
		await expect(plain.run({} as PipelineState, mkCtx(log))).rejects.toSatisfy((e: unknown) =>
			e instanceof RouteBackSignal,
		);
		// Both executed the same children (no walker-added stage records).
		expect(order).toEqual(["requirements", "bdd", "requirements", "bdd"]);
	});
});

describe("M2 withInlineRouteBack — active (the pilot jump, end to end)", () => {
	it("journals, invalidates cache, injects requests, sub-walks from the owner — pre-owner never re-runs", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		seedCacheRows(dir, ["pipeline.requirements@root#1", "pipeline.bdd@root#1", "pipeline.research@root#1"]);
		const order: string[] = [];
		const log: string[] = [];

		let bddPasses = 0;
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run(state: PipelineState) {
				order.push("bdd");
				bddPasses++;
				if (bddPasses === 1) {
					recordConvergenceFindings(state, [{
						id: "F-001", title: "phantom AC-03 verdict field", detail: "AC-03 references a nonexistent FindingSchema field",
						severity: "P1", blocking: true, ownerStage: "requirements", status: "open", recommendation: "amend AC-03",
					}], { detectedAtStage: "bdd", ownerStage: "requirements", sourceGate: "bdd-review" });
					const cmd = planInlineRouteBack(dir, "bdd", [
						{ id: "F-001", ownerStage: "requirements", blocking: true },
					]);
					if (cmd) throw new RouteBackSignal(cmd);
					throw new Error("planner should have granted the jump");
				}
				return { status: "ok" };
			},
		};
		const requirementsOwner: Stage = {
			id: "requirements", label: "requirements",
			async run() {
				order.push("requirements");
				// MP1 pin: by the time the owner re-runs, the journal ALREADY records the jump.
				return { status: "ok" };
			},
		};
		const children: Node[] = [
			task(recordStage("classify", order)),
			task(requirementsOwner),
			task(thrower),
			task(recordStage("research", order)),
		];
		const walker = withInlineRouteBack(children);
		const state = { setup: { specDirectory: dir, specIdentifier: "spec-01" } } as unknown as PipelineState;
		const result = await walker.run(state, mkCtx(log));

		expect(result.status).toBe("ok"); // no FatalAbort, run continues
		expect(order).toEqual([
			"classify", "requirements", "bdd", // first pass (throws at bdd)
			"requirements", "bdd", "research", // sub-walk: owner → thrower → downstream
		]);
		// "setup" appears exactly once — pre-owner stages never re-run.
		expect(order.filter((s) => s === "classify")).toHaveLength(1);

		// Journal: one charged jump with walk position + offsets.
		const j = readRoutingJournal(dir);
		expect(j.entries).toHaveLength(1);
		const e = j.entries[0];
		expect(e.from).toBe("bdd");
		expect(e.to).toBe("requirements");
		expect(e.resumeFromIndex).toBe(2); // index AFTER the owner in children
		expect(e.invalidated).toContain("requirements");
		expect(e.invalidated).toContain("bdd");
		expect(e.cacheDropped).toBeGreaterThanOrEqual(2); // requirements + bdd (+research) rows dropped

		// Revisions bumped for the owner.
		const revisions = JSON.parse(readFileSync(join(dir, "artifact-revisions.json"), "utf8"));
		expect(revisions.requirements).toBe(1);

		// Round-1 injection: pending request persisted for the owner.
		const requests = JSON.parse(readFileSync(join(dir, REPLAN_REQUESTS_FILE), "utf8"));
		expect(requests.requests.some((r: { id: string; status: string }) => r.id === "rb-F-001" && r.status === "pending")).toBe(true);

		// No replan marker — the jump is inline, not the terminal emulation.
		expect((state as Record<string, unknown>).__replan).toBeUndefined();
		// The walker logged the jump.
		expect(log.some((l) => l.includes("route-back bdd→requirements") && l.includes("sub-walk re-enters"))).toBe(true);
	});

	it("MP1 strict ordering: the journal entry exists BEFORE the owner re-runs", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		const observed: number[] = [];
		const owner: Stage = {
			id: "requirements", label: "requirements",
			async run() {
				observed.push(readRoutingJournal(dir).entries.length);
				return { status: "ok" };
			},
		};
		let threw = false;
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run() {
				if (!threw) {
					threw = true;
					const cmd = planInlineRouteBack(dir, "bdd", [{ id: "F", ownerStage: "requirements", blocking: true }]);
					if (cmd) throw new RouteBackSignal(cmd);
					throw new Error("no cmd");
				}
				return { status: "ok" };
			},
		};
		const walker = withInlineRouteBack([task(owner), task(thrower)]);
		await walker.run({ setup: { specDirectory: dir } } as unknown as PipelineState, mkCtx());
		// First pass: 0 entries. Sub-walk re-entry: ALREADY 1 (sync-before-re-entry).
		expect(observed).toEqual([0, 1]);
	});

	it("defense-in-depth: inline-jump cap rethrows instead of looping forever", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		const savedCap = process.env.SUPER_DEV_MAX_INLINE_JUMPS;
		process.env.SUPER_DEV_MAX_INLINE_JUMPS = "1";
		try {
			expect(maxInlineJumps()).toBe(1);
			const owner: Stage = { id: "requirements", label: "requirements", async run() { return { status: "ok" }; } };
			const thrower: Stage = {
				id: "bdd", label: "bdd",
				async run() {
					const cmd = planInlineRouteBack(dir, "bdd", [{ id: "F", ownerStage: "requirements", blocking: true }]);
					if (cmd) throw new RouteBackSignal(cmd);
					throw new Error("no cmd");
				},
			};
			const walker = withInlineRouteBack([task(owner), task(thrower)]);
			// First jump taken (cap 1); the sub-walk throws AGAIN → cap reached → rethrow.
			await expect(
				walker.run({ setup: { specDirectory: dir } } as unknown as PipelineState, mkCtx()),
			).rejects.toSatisfy((e: unknown) => e instanceof RouteBackSignal);
			expect(readRoutingJournal(dir).entries).toHaveLength(1);
		} finally {
			if (savedCap === undefined) delete process.env.SUPER_DEV_MAX_INLINE_JUMPS;
			else process.env.SUPER_DEV_MAX_INLINE_JUMPS = savedCap;
		}
	});

	it("journal-write failure fails closed — no unrecorded re-entry", async () => {
		setFlagOn();
		const owner: Stage = { id: "requirements", label: "requirements", async run() { throw new Error("must not re-run"); } };
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run() {
				const cmd = routeBackOrEscalate("bdd", "requirements", "t", [], { edges: {} });
				if (cmd.action !== "route-back") throw new Error("unreachable");
				throw new RouteBackSignal(cmd);
			},
		};
		const walker = withInlineRouteBack([task(owner), task(thrower)]);
		// specDirectory points INSIDE a regular file → mkdir/append fail (ENOTDIR)
		// instantly → chargeRoutingJump null → fail closed. (Never /proc: its
		// recursive-mkdir blocks indefinitely on this machine.)
		const dir = mkSpecDir();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		await expect(
			walker.run({ setup: { specDirectory: join(blocker, "spec") } } as unknown as PipelineState, mkCtx()),
		).rejects.toSatisfy((e: unknown) => e instanceof RouteBackSignal);
	});
});

describe("M2 G8 — flag-on stream ≡ flag-off + expected delta (structural)", () => {
	it("flag-on emits the re-entered stage records the flag-off run lacks — and nothing else differs in kind", async () => {
		const build = (flagOn: boolean) => {
			const order: string[] = [];
			const dir = mkSpecDir();
			let threw = false;
			const thrower: Stage = {
				id: "bdd", label: "bdd",
				async run() {
					order.push("bdd");
					if (flagOn && !threw) {
						threw = true;
						const cmd = planInlineRouteBack(dir, "bdd", [{ id: "F", ownerStage: "requirements", blocking: true }]);
						if (cmd) throw new RouteBackSignal(cmd);
					}
					return { status: "ok" };
				},
			};
			const owner: Stage = {
				id: "requirements", label: "requirements",
				async run() { order.push("requirements"); return { status: "ok" }; },
			};
			const ctx = mkCtx();
			return { children: [task(owner), task(thrower)], order, dir, ctx };
		};
		const off = build(false);
		const offResult = await withInlineRouteBack(off.children).run({} as PipelineState, off.ctx);
		expect(offResult.status).toBe("ok");
		expect(off.order).toEqual(["requirements", "bdd"]);

		setFlagOn();
		const on = build(true);
		const onResult = await withInlineRouteBack(on.children).run(
			{ setup: { specDirectory: on.dir } } as unknown as PipelineState, on.ctx,
		);
		expect(onResult.status).toBe("ok");
		// Delta = exactly one extra requirements re-run (the injected revision pass).
		expect(on.order).toEqual(["requirements", "bdd", "requirements", "bdd"]);
	});
});

describe("M2 round-1 remediation pins", () => {
	it("T3.4b dedupe: a request addressed BEFORE this run re-injects; pending suppresses", () => {
		const dir = mkSpecDir();
		const findings = [{ id: "F-9", title: "phantom", severity: "P1", detail: "d", recommendation: "r" }];
		// First inject (pending).
		expect(appendRouteBackRequests(dir, "requirements", findings, "run-1")).toBe(1);
		const file = () => JSON.parse(readFileSync(join(dir, REPLAN_REQUESTS_FILE), "utf8"));
		// Pending → suppressed (no double-inject while unresolved).
		expect(appendRouteBackRequests(dir, "requirements", findings, "run-1")).toBe(0);
		// Simulate the owning reviewer verifying: flip to addressed BEFORE this run.
		const f1 = file();
		f1.requests[0].status = "addressed";
		f1.requests[0].addressedAt = "2026-08-21T00:00:00.000Z";
		writeFileSync(join(dir, REPLAN_REQUESTS_FILE), JSON.stringify(f1));
		// Regression: same finding re-blocks in a LATER run → MUST re-inject.
		expect(appendRouteBackRequests(dir, "requirements", findings, "run-2")).toBe(1);
	});

	it("per-RUN budget window: a prior run's exhausted edge does not starve this run", () => {
		resetRunEpoch(); // earlier tests may have started an epoch (module state)
		const dir = mkSpecDir();
		// Two prior-run jumps at an old timestamp (edge exhausted for THAT run).
		writeFileSync(join(dir, ROUTING_JOURNAL_FILE),
			[0, 1].map((i) => JSON.stringify({ seq: i + 1, kind: "route-back", from: "bdd", to: "requirements", reason: "r", findingIds: [], resumeFromIndex: 1, invalidated: [], budgetBefore: i, budgetAfter: i + 1, at: "2026-08-20T00:00:00.000Z" })).join("\n") + "\n");
		// No epoch: counts all → exhausted.
		expect(persistedBudget(dir).edges["bdd→requirements"]).toBe(2);
		// New run starts an epoch AFTER the old entries → fresh budget.
		startRunEpoch();
		expect(persistedBudget(dir).edges["bdd→requirements"]).toBeUndefined();
	});

	it("decline path degrades to the replan emulation instead of a dead-end abort", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		const order: string[] = [];
		const log: string[] = [];
		// Exhaust the edge budget within THIS epoch so the walker declines.
		startRunEpoch();
		const now = new Date().toISOString();
		writeFileSync(join(dir, ROUTING_JOURNAL_FILE),
			[0, 1].map((i) => JSON.stringify({ seq: i + 1, kind: "route-back", from: "bdd", to: "requirements", reason: "r", findingIds: [], resumeFromIndex: 1, invalidated: [], budgetBefore: i, budgetAfter: i + 1, at: now })).join("\n") + "\n");
		const owner: Stage = { id: "requirements", label: "requirements", async run() { order.push("requirements"); return { status: "ok" }; } };
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run(state: PipelineState) {
				recordConvergenceFindings(state, [{
					id: "F-D1", title: "decline-path finding", detail: "d", severity: "P1",
					blocking: true, ownerStage: "requirements", status: "open", recommendation: "fix",
				}], { detectedAtStage: "bdd", ownerStage: "requirements", sourceGate: "bdd-review" });
				// Planner sees the exhausted edge → returns null → throw the raw
				// signal so the WALKER decline path handles it.
				const cmd = routeBackOrEscalate("bdd", "requirements", "decline", ["F-D1"], { edges: {} });
				if (cmd.action !== "route-back") throw new Error("unreachable");
				throw new RouteBackSignal(cmd);
			},
		};
		const walker = withInlineRouteBack([task(owner), task(thrower)]);
		// Expect the emulation terminal: FatalAbort carrying REPLAN (restarts).
		const err = await walker.run(
			{ setup: { specDirectory: dir, specIdentifier: "spec-decline" } } as unknown as PipelineState,
			mkCtx(log),
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("REPLAN at round cap"); // R2-2: the workflow-boundary literal
		// The emulation persisted replan-requests.json for the owner.
		const requests = JSON.parse(readFileSync(join(dir, REPLAN_REQUESTS_FILE), "utf8"));
		expect(requests.requests.some((r: { fingerprint: string }) => r.fingerprint.length > 0)).toBe(true);
		expect(log.some((l) => l.includes("NOT taken inline") && l.includes("degrading to the replan emulation"))).toBe(true);
		const events = readFileSync(join(dir, "events.jsonl"), "utf8");
		expect(events).toContain('"route.declined"');
		expect(events).toContain("edge budget exhausted");
	});

	it("route.taken run event is appended on a successful jump", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		const owner: Stage = { id: "requirements", label: "requirements", async run() { return { status: "ok" }; } };
		let threw = false;
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run(state: PipelineState) {
				if (!threw) {
					threw = true;
					recordConvergenceFindings(state, [{
						id: "F-EV", title: "ev", detail: "d", severity: "P1",
						blocking: true, ownerStage: "requirements", status: "open", recommendation: "r",
					}], { detectedAtStage: "bdd", ownerStage: "requirements", sourceGate: "bdd-review" });
					const cmd = planInlineRouteBack(dir, "bdd", [{ id: "F-EV", ownerStage: "requirements", blocking: true }]);
					if (cmd) throw new RouteBackSignal(cmd);
				}
				return { status: "ok" };
			},
		};
		const walker = withInlineRouteBack([task(owner), task(thrower)]);
		const r = await walker.run({ setup: { specDirectory: dir, specIdentifier: "spec-ev" } } as unknown as PipelineState, mkCtx());
		expect(r.status).toBe("ok");
		const events = readFileSync(join(dir, "events.jsonl"), "utf8");
		expect(events).toContain('"route.taken"');
	});
});

describe("M2 round-2 remediation pins", () => {
	it("torn-boundary healing: a crash-torn trailing line never glues onto the next charge (R2-5)", () => {
		const dir = mkSpecDir();
		writeFileSync(join(dir, ROUTING_JOURNAL_FILE), '{"seq":1,"kind":"route-bac'); // torn, no newline
		const e = chargeRoutingJump(dir, {
			from: "bdd", to: "requirements", reason: "r", findingIds: [], resumeFromIndex: 1,
			invalidated: [], at: "t", cacheDropped: 0, revisionAfter: 0,
		});
		expect(e).not.toBeNull();
		// The torn fragment stays (skipped by the reader); the new entry parses.
		const j = readRoutingJournal(dir);
		expect(j.entries).toHaveLength(1);
		expect(j.entries[0].seq).toBe(1); // maxSeq over parsed entries only
		// And the file now ends with a newline (next charge needs no heal).
		expect(readFileSync(join(dir, ROUTING_JOURNAL_FILE), "utf8").endsWith("\n")).toBe(true);
	});

	it("revisions precheck: unreadable artifact-revisions.json declines BEFORE any persistent mutation (R2-10)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		// Seed a cache row for requirements that UNPARSEABLE rows can't shadow:
		seedCacheRows(dir, ["pipeline.requirements@root#1"]);
		// Make the cache file such that the REAL invalidation will drop 0 while
		// resumeCacheHasRowsFor sees a match: corrupt the row AFTER seeding is
		// impossible (they parse the same), so pin the dry-probe ordering via the
		// revisions precheck instead: an UNREADABLE revisions file declines and
		// leaves BOTH the cache and the journal untouched.
		writeFileSync(join(dir, "artifact-revisions.json"), "{not json");
		const owner: Stage = { id: "requirements", label: "requirements", async run() { return { status: "ok" }; } };
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run() {
				const cmd = routeBackOrEscalate("bdd", "requirements", "t", [], { edges: {} });
				if (cmd.action !== "route-back") throw new Error("unreachable");
				throw new RouteBackSignal(cmd);
			},
		};
		const walker = withInlineRouteBack([task(owner), task(thrower)]);
		await expect(
			walker.run({ setup: { specDirectory: dir, specIdentifier: "s" } } as unknown as PipelineState, mkCtx()),
		).rejects.toBeInstanceOf(Error);
		// No journal entry, no request rows, cache row INTACT, revisions UNTOUCHED.
		expect(readRoutingJournal(dir).entries).toHaveLength(0);
		expect(existsSync(join(dir, REPLAN_REQUESTS_FILE))).toBe(false);
		const cache = readFileSync(join(dir, ".resume-cache.jsonl"), "utf8");
		expect(cache).toContain("pipeline.requirements@root#1");
		expect(readFileSync(join(dir, "artifact-revisions.json"), "utf8")).toBe("{not json");
	});

	it("specConvergenceNode is addressable by the walker (id: 'spec')", async () => {
		const { specConvergenceNode } = await import("../src/stages/spec-convergence.ts");
		expect(specConvergenceNode.id).toBe("spec");
	});
});

describe("M2 round-3 remediation pins", () => {
	it("pending-rows fallback tier: a second signal after our own injection still terminates REPLAN (R2-3)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		let throws = 0;
		const owner: Stage = { id: "requirements", label: "requirements", async run() { return { status: "ok" }; } };
		const thrower: Stage = {
			id: "bdd", label: "bdd",
			async run(state: PipelineState) {
				throws++;
				recordConvergenceFindings(state, [{
					id: "F-T2", title: "tier2 finding", detail: "d", severity: "P1",
					blocking: true, ownerStage: "requirements", status: "open", recommendation: "r",
				}], { detectedAtStage: "bdd", ownerStage: "requirements", sourceGate: "bdd-review" });
				// Pass 1: the planner grants the jump (budget fresh) — the walker
				// injects F-T2 as a PENDING request for requirements. Pass 2 (the
				// sub-walk re-run): budget spent → planner null → raw signal carrying
				// the finding id so decline's tier-2 sees OUR pending rows.
				const cmd = planInlineRouteBack(dir, "bdd", [{ id: "F-T2", ownerStage: "requirements", blocking: true }])
					?? routeBackOrEscalate("bdd", "requirements", "tier2", ["F-T2"], { edges: {} });
				if (cmd.action !== "route-back") throw new Error("unreachable");
				throw new RouteBackSignal(cmd);
			},
		};
		const walker = withInlineRouteBack([task(owner), task(thrower)]);
		// First jump succeeds (charged); sub-walk throws AGAIN — budget now
		// exhausted → decline → emulation deduped by OUR pending rows → tier-2
		// pending fallback → REPLAN terminal (not a raw signal).
		const state = { setup: { specDirectory: dir, specIdentifier: "s-tier2" } } as unknown as PipelineState;
		const err = await walker.run(state, mkCtx()).catch((e: unknown) => e);
		expect((err as Error).message).toContain("REPLAN at round cap");
		expect(throws).toBe(3); // budget 2 → two jumps taken, third signal declines
		expect(readRoutingJournal(dir).entries).toHaveLength(2);
		expect((state as Record<string, unknown>).__replan).toMatchObject({ rounds: 1, owners: ["requirements"] });
	});

	it("B6 post-call guard: a 0-drop invalidation with surviving rows declines (chmod read-only cache)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		seedCacheRows(dir, ["pipeline.requirements@root#1"]);
		// Read-only cache file: the real invalidation's WRITE fails silently →
		// dropped 0, while resumeCacheHasRowsFor still sees the row.
		chmodSync(join(dir, ".resume-cache.jsonl"), 0o444);
		try {
			const owner: Stage = { id: "requirements", label: "requirements", async run() { return { status: "ok" }; } };
			const thrower: Stage = {
				id: "bdd", label: "bdd",
				async run() {
					const cmd = routeBackOrEscalate("bdd", "requirements", "b6", [], { edges: {} });
					if (cmd.action !== "route-back") throw new Error("unreachable");
					throw new RouteBackSignal(cmd);
				},
			};
			const walker = withInlineRouteBack([task(owner), task(thrower)]);
			const err = await walker.run(
				{ setup: { specDirectory: dir, specIdentifier: "s-b6" } } as unknown as PipelineState,
				mkCtx(),
			).catch((e: unknown) => e);
			// Decline fired (REPLAN-literal terminal or raw signal — both declines);
			// the journal was NEVER charged.
			expect(readRoutingJournal(dir).entries).toHaveLength(0);
			expect((err as Error)).toBeInstanceOf(Error);
		} finally {
			chmodSync(join(dir, ".resume-cache.jsonl"), 0o644);
		}
	});

	it("pre-existing replan terminals carry the canonical literal (adversarial round-3 F-2)", async () => {
		const ac = readFileSync("src/stages/artifact-convergence.ts", "utf8");
		const sc = readFileSync("src/stages/spec-convergence.ts", "utf8");
		for (const m of ac.matchAll(/throw new FatalAbort\(`([^`]*REPLAN[^`]*)`/g)) {
			expect(m[1]).toContain("REPLAN at round cap");
		}
		for (const m of sc.matchAll(/throw new FatalAbort\(`([^`]*REPLAN[^`]*)`/g)) {
			expect(m[1]).toContain("REPLAN at round cap");
		}
	});
});

// ═══ M3 (v0.3.7): default-ON, G4 revision-gate, resume fidelity ═════════════

import {
	fastForwardGate,
	recordConvergedRevision,
} from "../src/routing/revision-gate.ts";
import { seedRunEpochFromJournal } from "../src/routing/journal.ts";

describe("M3 G4 revision-gate", () => {
	it("inert without a journal (G8 byte-identity for never-jumped runs)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		const state = {} as PipelineState;
		recordConvergedRevision(state, "bdd", dir);
		expect(await fastForwardGate(state, mkCtx(), "bdd", dir, async () => ({ pass: true, errors: [] }))).toBe(false);
	});

	it("fast-forwards: converged + journal + revision unchanged + no pending + validator green", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		chargeRoutingJump(dir, { from: "bdd", to: "requirements", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: "2026-08-21T00:00:00.000Z", cacheDropped: 2, revisionAfter: 1 });
		const state = {} as PipelineState;
		recordConvergedRevision(state, "research", dir); // revision 0 recorded
		const log: string[] = [];
		let validateCalls = 0;
		expect(await fastForwardGate(state, mkCtx(log), "research", dir, async () => { validateCalls++; return { pass: true, errors: [] }; })).toBe(true);
		expect(validateCalls).toBe(1);
		expect(log.some((l) => l.includes("revision-gate FAST-FORWARD"))).toBe(true);
	});

	it("NO fast-forward when the revision changed (this stage was a later jump's owner)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		chargeRoutingJump(dir, { from: "bdd", to: "requirements", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: "2026-08-21T00:00:00.000Z", cacheDropped: 2, revisionAfter: 1 });
		const state = {} as PipelineState;
		recordConvergedRevision(state, "requirements", dir); // recorded at revision 0
		// a later jump bumped requirements to 1
		writeFileSync(join(dir, "artifact-revisions.json"), JSON.stringify({ requirements: 1 }));
		expect(await fastForwardGate(state, mkCtx(), "requirements", dir, async () => ({ pass: true, errors: [] }))).toBe(false);
	});

	it("NO fast-forward without a validator (research conservatively re-runs)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		chargeRoutingJump(dir, { from: "spec", to: "requirements", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: "2026-08-21T00:00:00.000Z", cacheDropped: 2, revisionAfter: 1 });
		const state = {} as PipelineState;
		recordConvergedRevision(state, "research", dir);
		expect(await fastForwardGate(state, mkCtx(), "research", dir, undefined)).toBe(false);
	});

	it("NO fast-forward when the validator fails (upstream revision invalidated the artifact)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		chargeRoutingJump(dir, { from: "spec", to: "requirements", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: "2026-08-21T00:00:00.000Z", cacheDropped: 2, revisionAfter: 1 });
		const state = {} as PipelineState;
		recordConvergedRevision(state, "bdd", dir);
		expect(await fastForwardGate(state, mkCtx(), "bdd", dir, async () => ({ pass: false, errors: ["dangling scenario"] }))).toBe(false);
	});

	it("NO fast-forward while pending replan requests target the stage", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		chargeRoutingJump(dir, { from: "spec", to: "bdd", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["bdd"], at: "2026-08-21T00:00:00.000Z", cacheDropped: 2, revisionAfter: 1 });
		appendRouteBackRequests(dir, "research", [{ id: "F-2", title: "t", detail: "d" }], "run-1");
		const state = {} as PipelineState;
		recordConvergedRevision(state, "research", dir);
		expect(await fastForwardGate(state, mkCtx(), "research", dir, async () => ({ pass: true, errors: [] }))).toBe(false);
	});
});

describe("M3 resume fidelity (MP1 — never re-arm a crashed run's budget)", () => {
	it("seedRunEpochFromJournal counts the crashed run's jumps against the resumed budget", () => {
		setFlagOn();
		const dir = mkSpecDir();
		// Simulate a crashed run that already jumped bdd→requirements once
		// (backdated so the fresh-epoch assertion below can't collide on the
		// same ISO millisecond — >= is the epoch comparison).
		const crashedAt = new Date(Date.now() - 60_000).toISOString();
		resetRunEpoch();
		chargeRoutingJump(dir, { from: "bdd", to: "requirements", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: crashedAt, cacheDropped: 2, revisionAfter: 1 });
		// A resumed process seeds its epoch from the journal's LAST entry —
		// the crashed run's jump still counts (budget NOT re-armed).
		seedRunEpochFromJournal(dir);
		expect(remainingOf(dir, "bdd", "requirements")).toBe(DEFAULT_EDGE_BUDGET - 1);
		// A FRESH process (startRunEpoch = now, strictly later) gets the full
		// per-run budget back.
		startRunEpoch();
		expect(remainingOf(dir, "bdd", "requirements")).toBe(DEFAULT_EDGE_BUDGET);
	});

	it("epoch-file seeding is PRECISE: a multi-jump crashed run's jumps ALL count (round-2 undercount fix)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		// Crashed run with TWO jumps on the same edge (budget 2 → exhausted),
		// charged under one epoch — chargeRoutingJump persists that epoch.
		startRunEpoch(); // the crashed process's epoch
		const epochIso = currentRunEpoch();
		for (let i = 0; i < DEFAULT_EDGE_BUDGET; i++) {
			chargeRoutingJump(dir, { from: "bdd", to: "requirements", reason: "r", findingIds: ["F"], resumeFromIndex: 1, invalidated: ["requirements"], at: new Date().toISOString(), cacheDropped: 0, revisionAfter: 1 });
		}
		// chargeRoutingJump persisted the epoch it budgeted under.
		expect(JSON.parse(readFileSync(join(dir, "routing-epoch.json"), "utf8")).epoch).toBe(epochIso);
		// Resumed process seeds from the PERSISTED epoch file — ALL 2 jumps
		// count (the round-1 last-entry fallback would have counted only 1).
		seedRunEpochFromJournal(dir);
		expect(remainingOf(dir, "bdd", "requirements")).toBe(0);
		// Fresh process: full per-run budget (sleep past the ISO millisecond so
		// the fresh epoch is strictly later than the charged entries).
		await new Promise((r) => setTimeout(r, 5));
		startRunEpoch();
		expect(remainingOf(dir, "bdd", "requirements")).toBe(DEFAULT_EDGE_BUDGET);
	});

	it("setup-seeded resume: the setup stage calls seedRunEpochFromJournal on --resume (source pin)", () => {
		const src = readFileSync("src/stages/setup.ts", "utf8");
		expect(src).toMatch(/if \(resumeId\) seedRunEpochFromJournal\(setup\.specDirectory\);/);
		// The walker entry must NOT seed (state.setup is empty before setup runs).
		const walkerSrc = readFileSync("src/routing/walker.ts", "utf8");
		expect(walkerSrc).not.toContain("seedRunEpochFromJournal");
	});
});

function remainingOf(dir: string, from: string, to: string): number {
	return remainingBudget(persistedBudget(dir), from, to);
}

describe("M3 incident replay (run 03-23-47 shape, default-ON)", () => {
	it("bdd round-1 upstream blocker → inline jump → requirements revises → bdd converges → downstream proceeds", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		seedCacheRows(dir, ["pipeline.requirements@root#1", "pipeline.bdd@root#1"]);
		const order: string[] = [];
		const reqCalls: number[] = [];
		const requirements: Stage = {
			id: "requirements", label: "requirements",
			async run() {
				order.push("requirements");
				reqCalls.push(1);
				return { status: "ok" };
			},
		};
		const bdd: Stage = {
			id: "bdd", label: "bdd",
			async run() {
				order.push("bdd");
				if (order.filter((s) => s === "bdd").length === 1) {
					const cmd = planInlineRouteBack(dir, "bdd", [{ id: "rb-1", ownerStage: "requirements", blocking: true, title: "phantom AC-03 field" }]);
					if (cmd) throw new RouteBackSignal(cmd);
					throw new Error("planner returned null");
				}
				return { status: "ok" };
			},
		};
		const children: Node[] = [task(requirements), task(bdd), task(recordStage("research", order)), task(recordStage("spec", order))];
		const state = { setup: { specDirectory: dir, specIdentifier: "s" } } as unknown as PipelineState;
		// The walker injects LEDGER findings matched by cmd.findingIds — seed one.
		recordConvergenceFindings(state, [{ id: "rb-1", ownerStage: "requirements", title: "phantom AC-03 field", detail: "FindingSchema is closed", severity: "high", blocking: true }], { detectedAtStage: "bdd", ownerStage: "requirements", sourceGate: "bdd-review" });
		await withInlineRouteBack(children).run(state, mkCtx());
		expect(order).toEqual(["requirements", "bdd", "requirements", "bdd", "research", "spec"]);
		const j = readRoutingJournal(dir);
		expect(j.entries).toHaveLength(1);
		expect(j.entries[0].from).toBe("bdd");
		// The injected request awaits the requirements re-convergence.
		const requests = JSON.parse(readFileSync(join(dir, REPLAN_REQUESTS_FILE), "utf8"));
		expect(requests.requests.some((r: { id: string }) => r.id === "rb-rb-1")).toBe(true);
	});
});

// ═══ M4 (v0.3.8): all producers + escalation route-back choice ═════════════

import { classifyEscalationChoice } from "../src/routing/router.ts";

describe("M4 planner generalization (every routable producer)", () => {
	it("research→requirements and design→bdd plan commands (allowlist retired)", () => {
		setFlagOn();
		const dir = mkSpecDir();
		const r = planInlineRouteBack(dir, "research", [{ id: "F-1", ownerStage: "requirements", blocking: true }]);
		expect(r).not.toBeNull();
		expect(r!.from).toBe("research");
		expect(r!.to).toBe("requirements");
		const d = planInlineRouteBack(dir, "design", [{ id: "F-2", ownerStage: "bdd", blocking: true }]);
		expect(d).not.toBeNull();
		expect(d!.to).toBe("bdd");
	});

	it("verify→spec plans from deferred-shaped findings", () => {
		setFlagOn();
		const dir = mkSpecDir();
		const cmd = planInlineRouteBack(dir, "verify", [{ id: "DF-1", ownerStage: "spec", blocking: true, title: "spec-owned deferred" }]);
		expect(cmd).not.toBeNull();
		expect(cmd!.to).toBe("spec");
	});

	it("a verify throw inside branch/loop nesting reaches the walker (end-to-end)", async () => {
		setFlagOn();
		const dir = mkSpecDir();
		const order: string[] = [];
		const specNode: Stage = {
			id: "spec", label: "spec",
			async run() { order.push("spec"); return { status: "ok" }; },
		};
		// The verify child sits inside a sequence+branch nesting mirroring the
		// real pipeline; its RouteBackSignal must propagate to the walker.
		const verifyChild: Stage = {
			id: "verify-inner", label: "verify",
			async run() {
				order.push("verify");
				if (order.filter((s) => s === "verify").length === 1) {
					const cmd = planInlineRouteBack(dir, "verify", [{ id: "DF-1", ownerStage: "spec", blocking: true }]);
					if (cmd) throw new RouteBackSignal(cmd);
				}
				return { status: "ok" };
			},
		};
		const { branch } = await import("../src/nodes.ts");
		// NOTE: ids avoid "setup" — the task wrapper applies the (absent)
		// control to state[stage.id], which would CLOBBER state.setup and
		// wipe specDirectory (found the hard way).
		const children: Node[] = [
			task(recordStage("boot", order)),
			task(recordStage("classify0", order)),
			task(recordStage("requirements0", order)),
			task(specNode),
			branch(() => true, { yes: task(verifyChild) }),
		];
		const state = { setup: { specDirectory: dir, specIdentifier: "s" } } as unknown as PipelineState;
		const log: string[] = [];
		await withInlineRouteBack(children).run(state, mkCtx(log));
		expect(order).toEqual([
			"boot", "classify0", "requirements0", "spec", "verify",
			// sub-walk from owner (spec) → verify re-runs and completes
			"spec", "verify",
		]);
		expect(readRoutingJournal(dir).entries[0]).toMatchObject({ from: "verify", to: "spec" });
	});
});

describe("M4 escalation route-back choice (G6)", () => {
	it("classifyEscalationChoice maps route-back", () => {
		expect(classifyEscalationChoice("route-back")).toBe("route-back");
	});
});
