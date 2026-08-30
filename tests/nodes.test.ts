/**
 * Unit tests for the control-flow node algebra. All tests use mock tasks —
 * NO `pi` subprocess spawns, NO network, NO LLM. Fast and deterministic.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter, getEventListeners } from "node:events";
import {
	task, sequence, branch, choose, parallel, loop, retry, gate, map, wait, tryCatch, noop,
} from "../src/nodes.ts";
import { FatalAbort } from "../src/nodes.ts";
import { getConvergenceLedger } from "../src/convergence-ledger.ts";
import type { AgentCall, AgentResult, Budget, Node, PipelineState, Stage, StageContext } from "../src/types.ts";

/** A Stage whose `run` is an arbitrary pure function of state (no agent calls). */
function mockTask(id: string, fn: (s: PipelineState, ctx: StageContext) => unknown): Stage {
	return { id, label: id, async run(s, ctx) { return fn(s, ctx); } };
}

/** A Stage that returns `failTimes` failures (by throwing) before succeeding. */
function flakyTask(id: string, failTimes: number, counter: { n: number }, out: unknown): Stage {
	return {
		id, label: id, fatal: false,
		async run() {
			counter.n++;
			if (counter.n <= failTimes) throw new Error(`flaky fail #${counter.n}`);
			return out;
		},
	};
}

function mkCtx(): StageContext {
	const budget: Budget = {
		count: 0,
		check: () => true,
		spent() { this.count++; return true; },
	};
	return {
		task: "",
		options: {},
		state: {},
		async agent(_call: AgentCall): Promise<AgentResult> {
			throw new Error("agent() should not be called in node unit tests");
		},
		async helper() { throw new Error("helper() should not be called here"); },
		async parallel(calls) {
			return Promise.all(calls.map((c) => c()));
		},
		budget,
		log() {},
		phase() {},
		events: new EventEmitter(),
		results: [],
	};
}

describe("task", () => {
	it("runs and stores its return value under state[id]", async () => {
		const t = task(mockTask("foo", () => ({ ok: true })));
		const state: PipelineState = {};
		const r = await t.run(state, mkCtx());
		expect(r.status).toBe("ok");
		expect(state.foo).toEqual({ ok: true });
	});
	it("emits partial progress for incomplete implementation while preserving node ok", async () => {
		const t = task(mockTask("implementation", () => ({ allGreen: false, phasesCompleted: 0, totalPhases: 1 })));
		const state: PipelineState = {};
		const ctx = mkCtx();
		const seen: string[] = [];
		ctx.events.on("stage", (info: { status: string }) => seen.push(info.status));

		const r = await t.run(state, ctx);

		expect(r.status).toBe("ok");
		expect(state.implementation).toMatchObject({ allGreen: false });
		expect(seen).toEqual(["running", "partial"]);
	});
	it("returns failed (not throw) on a non-fatal error", async () => {
		const t = task({ id: "x", label: "x", async run() { throw new Error("boom"); } });
		const r = await t.run({}, mkCtx());
		expect(r.status).toBe("failed");
		expect(r.error).toBe("boom");
	});
	it("rethrows on a fatal stage", async () => {
		const t = task({ id: "x", label: "x", fatal: true, async run() { throw new Error("fatal"); } });
		await expect(t.run({}, mkCtx())).rejects.toThrow("fatal");
	});
	it("honors skipStages by stage id", async () => {
		let ran = false;
		const ctx = mkCtx();
		ctx.options.skipStages = ["foo"];
		const r = await task(mockTask("foo", () => { ran = true; return 1; })).run({}, ctx);
		expect(r.status).toBe("skipped");
		expect(ran).toBe(false);
	});
	it("honors skipStages by stage number in the label", async () => {
		let ran = false;
		const ctx = mkCtx();
		ctx.options.skipStages = ["10"];
		const r = await task({ id: "codeReview", label: "Stage 10a — Code Review", async run() { ran = true; return 1; } }).run({}, ctx);
		expect(r.status).toBe("skipped");
		expect(ran).toBe(false);
	});
	it("does not silently skip when budget is exhausted", async () => {
		const ctx = mkCtx();
		ctx.budget.check = () => false;
		const r = await task(mockTask("foo", () => 1)).run({}, ctx);
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/budget exhausted/);
	});
});

describe("sequence", () => {
	it("runs children in order", async () => {
		const order: string[] = [];
		const seq = sequence([
			task(mockTask("a", () => { order.push("a"); return 1; })),
			task(mockTask("b", () => { order.push("b"); return 2; })),
		]);
		const r = await seq.run({}, mkCtx());
		expect(r.status).toBe("ok");
		expect(order).toEqual(["a", "b"]);
	});
	it("fail-fast: stops at first failure by default", async () => {
		let ran = false;
		const seq = sequence([
			task({ id: "bad", label: "bad", async run() { throw new Error("x"); } }),
			task(mockTask("after", () => { ran = true; return 1; })),
		]);
		const r = await seq.run({}, mkCtx());
		expect(r.status).toBe("failed");
		expect(ran).toBe(false);
	});
	it("tolerant: continues past failures", async () => {
		let ran = false;
		const seq = sequence([
			task({ id: "bad", label: "bad", async run() { throw new Error("x"); } }),
			task(mockTask("after", () => { ran = true; return 1; })),
		], { tolerant: true });
		const r = await seq.run({}, mkCtx());
		expect(r.status).toBe("ok");
		expect(ran).toBe(true);
	});
});

describe("branch / choose", () => {
	it("branch takes the yes path when predicate true", async () => {
		const b = branch(() => true, { yes: task(mockTask("y", () => "yes")), no: task(mockTask("n", () => "no")) });
		const state: PipelineState = {};
		await b.run(state, mkCtx());
		expect(state.y).toBe("yes");
		expect(state.n).toBeUndefined();
	});
	it("branch returns skipped when predicate false and no `no`", async () => {
		const b = branch(() => false, { yes: task(mockTask("y", () => "yes")) });
		const r = await b.run({}, mkCtx());
		expect(r.status).toBe("skipped");
	});
	it("choose picks the first matching case", async () => {
		const c = choose([
			{ when: () => false, run: task(mockTask("a", () => 1)) },
			{ when: () => true, run: task(mockTask("b", () => 2)) },
		]);
		const state: PipelineState = {};
		await c.run(state, mkCtx());
		expect(state.b).toBe(2);
	});
});

describe("parallel", () => {
	it("rejects duplicate stage ids among branches (concurrent state clobber guard)", async () => {
		// Two task nodes with the same stage.id in a parallel would silently clobber
		// state[id] (last-write-wins, nondeterministic). Fail loud instead.
		const dup = parallel([task(mockTask("shared", () => 1)), task(mockTask("shared", () => 2))]);
		await expect(dup.run({}, mkCtx())).rejects.toThrow(/duplicate stage id "shared"/);
	});
	it("runs branches concurrently and joins into a key", async () => {
		const p = parallel(
			[
				task(mockTask("left", () => 10)),
				task(mockTask("right", () => 32)),
			],
			{ into: "sum", join: (results) => (results[0].value as number) + (results[1].value as number) },
		);
		const state: PipelineState = {};
		const r = await p.run(state, mkCtx());
		expect(r.status).toBe("ok");
		expect(state.sum).toBe(42);
	});
});

describe("loop", () => {
	it("iterates until `until` is true", async () => {
		let n = 0;
		const body = task(mockTask("tick", (s) => { n++; (s as Record<string, unknown>).count = n; return n; }));
		const l = loop({ until: (s) => (s.count as number) >= 3, times: 10 }, body);
		const state: PipelineState = {};
		await l.run(state, mkCtx());
		expect(n).toBe(3);
	});
	it("respects times cap", async () => {
		let n = 0;
		const body = task(mockTask("tick", () => { n++; return n; }));
		await loop({ times: 4 }, body).run({}, mkCtx());
		expect(n).toBe(4);
	});
	it("fail-fasts on a failed body by default (non-tolerant)", async () => {
		let n = 0;
		const body: Node = { kind: "task", async run() { n++; return { status: "failed", error: "x" }; } };
		const r = await loop({ times: 5 }, body).run({}, mkCtx());
		expect(r.status).toBe("failed");
		expect(n).toBe(1); // stopped after the first failure
	});
	it("tolerant loop keeps iterating past a failed body (F-2)", async () => {
		let n = 0;
		const body: Node = { kind: "task", async run() { n++; return { status: "failed", error: `f${n}` }; } };
		const r = await loop({ times: 3, tolerant: true }, body).run({}, mkCtx());
		expect(n).toBe(3); // ran all iterations despite each failing
		expect(r.status).toBe("failed"); // returns the LAST result
		expect(r.attempts).toBe(3);
	});
	it("reports the ACTUAL iteration count, not `times`, when while exits early (F-5)", async () => {
		const body: Node = { kind: "task", async run() { return { status: "ok" }; } };
		// `while` false on the first check → zero iterations
		const r = await loop({ while: () => false, times: 5 }, body).run({}, mkCtx());
		expect(r.attempts).toBeUndefined(); // not 5
	});
});

describe("retry", () => {
	it("retries on failure then succeeds", async () => {
		const counter = { n: 0 };
		const r = await retry({ attempts: 3 }, task(flakyTask("f", 2, counter, "done"))).run({}, mkCtx());
		expect(r.status).toBe("ok");
		expect(r.value).toBe("done");
		expect(counter.n).toBe(3);
	});
	it("returns failed after exhausting attempts", async () => {
		const counter = { n: 0 };
		const r = await retry({ attempts: 2 }, task(flakyTask("f", 5, counter, "done"))).run({}, mkCtx());
		expect(r.status).toBe("failed");
		expect(counter.n).toBe(2);
	});
});

describe("gate", () => {
	it("re-runs until validation passes", async () => {
		let n = 0;
		const node = task(mockTask("g", (s) => { n++; (s as Record<string, unknown>).v = n; return n; }));
		const g = gate({ validate: (s) => ({ pass: (s.v as number) >= 2, errors: [] }), attempts: 5 }, node);
		const r = await g.run({}, mkCtx());
		expect(r.status).toBe("ok");
		expect(n).toBe(2);
	});
	it("returns failed (NON-throwing) when validation never passes", async () => {
		const node = task(mockTask("g", () => 1));
		const r = await gate({ validate: () => ({ pass: false, errors: ["nope"] }), attempts: 3 }, node).run({}, mkCtx());
		expect(r.status).toBe("failed");
		expect(r.error).toMatch(/nope/);
	});
	it("feeds validator errors forward into state.__feedback for the next retry", async () => {
		const seen: string[] = [];
		const node = task(mockTask("g", (s) => {
			const fb = (s as Record<string, unknown>).__feedback as Record<string, string[]> | undefined;
			if (fb?.g) seen.push(...fb.g);
			return 1;
		}));
		await gate({ validate: () => ({ pass: false, errors: ["fix-X", "fix-Y"] }), feedbackKey: "g", attempts: 2 }, node).run({}, mkCtx());
		// attempt 1 has no feedback; attempt 2 sees attempt 1's errors.
		expect(seen).toEqual(["fix-X", "fix-Y"]);
	});
	it("exhaustion does not throw even if the wrapped node itself fails", async () => {
		// A stage that throws returns {status:"failed"} from task(); the gate must
		// NOT rethrow — it returns failed so a tolerant sequence can continue.
		const node = task({ id: "g", label: "g", async run() { throw new Error("spawn died"); } });
		const r = await gate({ validate: () => ({ pass: true, errors: [] }), attempts: 2 }, node).run({}, mkCtx());
		expect(r.status).toBe("failed");
	});
	it("a FATAL gate THROWS FatalAbort on exhaustion (does not silently return failed)", async () => {
		// The fix for "failed but still go on": a foundational doc gate that cannot
		// produce its artifact after all attempts must abort the run honestly.
		const node = task(mockTask("g", () => 1));
		await expect(
			gate({ validate: () => ({ pass: false, errors: ["no doc produced"] }), feedbackKey: "g", attempts: 2, fatal: true }, node).run({}, mkCtx()),
		).rejects.toThrow(/no doc produced/);
	});
	it("a non-retryable agent environment failure stops a fatal gate after one attempt", async () => {
		let runs = 0;
		const state: PipelineState = {};
		const node = task({
			id: "research",
			label: "research",
			async run() {
				runs++;
				throw new Error("super-dev [pipeline.research]: failed to spawn pi: spawn pi ENOENT");
			},
		});

		await expect(
			gate({ validate: () => ({ pass: false, errors: ["should not validate"] }), feedbackKey: "research", attempts: 5, fatal: true }, node).run(state, mkCtx()),
		).rejects.toThrow(/non-retryable agent environment failure/);

		expect(runs).toBe(1);
		const envFinding = getConvergenceLedger(state).findings.find((f) => f.ownerStage === "environment");
		expect(envFinding?.title).toBe("Agent environment cannot start");
		expect(envFinding?.blocking).toBe(true);
	});
	it("a non-fatal gate still returns failed on exhaustion (default resilience preserved)", async () => {
		const node = task(mockTask("g", () => 1));
		const r = await gate({ validate: () => ({ pass: false, errors: ["x"] }), attempts: 2 }, node).run({}, mkCtx());
		expect(r.status).toBe("failed");
	});
	it("clears state.__feedback[key] when validation finally passes (BUG-6)", async () => {
		// A gate that fails on attempt 1 (sets __feedback.g) then passes on attempt 2
		// must DELETE __feedback.g on success — otherwise stale failure feedback
		// persists and would be re-prepended if the gated stage were ever looped.
		let n = 0;
		const node = task(mockTask("g", () => ++n));
		const g = gate({ validate: () => ({ pass: n >= 2, errors: n < 2 ? ["not-yet"] : [] }), feedbackKey: "g", attempts: 5 }, node);
		const state: PipelineState = {};
		await g.run(state, mkCtx());
		expect(n).toBe(2); // ran twice: fail then pass
		const fb = (state as Record<string, unknown>).__feedback as Record<string, string[]> | undefined;
		expect(fb?.g ?? []).toEqual([]); // cleared on pass (absent key → [])
	});
});

describe("sequence tolerant catches throws", () => {
	// Use RAW nodes (not task()) — task() catches stage throws and returns failed,
	// so only a raw throwing node actually exercises sequence's try/catch.
	const thrower = { kind: "throw", run: async () => { throw new Error("kaboom"); } };
	it("a tolerant sequence continues past a child that THROWS (does not abort the run)", async () => {
		const order: string[] = [];
		const t = { kind: "throw", run: async () => { order.push("boom"); throw new Error("kaboom"); } };
		const next = task(mockTask("next", () => { order.push("next"); return 1; }));
		const r = await sequence([t as any, next], { tolerant: true }).run({}, mkCtx());
		expect(r.status).toBe("ok"); // tolerated — sequence completed
		expect(order).toEqual(["boom", "next"]); // second stage still ran
	});
	it("a non-tolerant sequence still propagates the throw", async () => {
		await expect(sequence([thrower as any], {}).run({}, mkCtx())).rejects.toThrow("kaboom");
	});
	it("a tolerant sequence RE-THROWS a FatalAbort (foundational gates abort honestly)", async () => {
		// The fix for cascading failures: even a {tolerant:true} pipeline must not
		// swallow a fatal gate exhaustion. It re-throws so runWorkflow aborts.
		const fatal = gate({ validate: () => ({ pass: false, errors: ["research gate exhausted"] }), attempts: 1, fatal: true }, task(mockTask("g", () => 1)));
		const next = task(mockTask("next", () => { throw new Error("downstream should NOT run"); }));
		await expect(sequence([fatal, next], { tolerant: true }).run({}, mkCtx())).rejects.toThrow(/research gate exhausted/);
	});
});

describe("map", () => {
	it("fans out over a collection", async () => {
		const body = task(mockTask("item", (s) => (s.item as number) * 2));
		const m = map({ over: () => [1, 2, 3], as: "item", concurrency: 1 }, body);
		const r = await m.run({}, mkCtx());
		expect(r.status).toBe("ok");
		expect((r.value as unknown[]).length).toBe(3);
	});
	it("throws on concurrency > 1 (shared state[as] is unsafe — BUG-5)", async () => {
		// The API only exposes the current item via the SHARED key state[as],
		// so concurrent iterations race and corrupt. Rather than silently produce
		// wrong results, fail loud. (Safe fan-out with isolation is a future
		// per-item-arg API; today map is single-threaded by default.)
		const body = task(mockTask("item", (s) => (s.item as number) * 2));
		const m = map({ over: () => [1, 2], as: "item", concurrency: 2 }, body);
		await expect(m.run({}, mkCtx())).rejects.toThrow(/concurrency.*1/i);
	});
});

describe("FatalAbort propagation invariant (foundational gates must always abort)", () => {
	// The FatalAbort contract: a fatal gate's exhaustion must reach runWorkflow,
	// never be swallowed into {status:"failed"} by an intermediate handler.
	it("task() re-throws a FatalAbort from its stage body (does not convert to failed)", async () => {
		const boom: Stage = { id: "s", label: "s", async run() { throw new FatalAbort("nested gate exhausted"); } };
		await expect(task(boom).run({}, mkCtx())).rejects.toThrow("nested gate exhausted");
	});
	it("tryCatch re-throws a FatalAbort AND still runs finally (teardown guarantee)", async () => {
		let finallyRan = false;
		const body: Node = { kind: "x", run: async () => { throw new FatalAbort("abort"); } };
		const fin: Node = { kind: "f", run: async () => { finallyRan = true; return { status: "ok" }; } };
		await expect(tryCatch(body, { finally: fin }).run({}, mkCtx())).rejects.toThrow("abort");
		expect(finallyRan).toBe(true);
	});
});

describe("wait / noop / tryCatch", () => {
	it("wait completes", async () => {
		const r = await wait(5).run({}, mkCtx());
		expect(r.status).toBe("ok");
	});
	it("noop returns ok", async () => {
		expect((await noop().run({}, mkCtx())).status).toBe("ok");
	});
	it("tryCatch catches a fatal task's throw", async () => {
		const tc = tryCatch(
			task({ id: "boom", label: "boom", fatal: true, async run() { throw new Error("kaboom"); } }),
			{ catch: task(mockTask("handled", () => "recovered")) },
		);
		const state: PipelineState = {};
		const r = await tc.run(state, mkCtx());
		expect(r.status).toBe("ok");
		expect(state.handled).toBe("recovered");
	});
});

// ─── T7.3 / SD-07 (NFR-6): the dead waitForEvent node is gone ─────────────
//
// waitForEvent had ZERO call sites in src/ and leaked its abort listener on
// the happy path (only the named event listener was cleaned in finish()). The
// atomic delete removes the node, its options interface, and every reference —
// this grep-clean pin keeps it deleted.
// ─── T7.5 / A-04 (NFR-6 pinning): writerTask budget-exhaustion sentinel ────
//
// task() checks ctx.budget.check() before the stage body, and writerTask's
// body RE-CHECKS it (a parallel sibling can spend the last slot between the
// two). Returning undefined let task() record status "ok" with NO artifact —
// the stage appeared green in results/dashboard/audit while producing nothing.
// The body must fail loud instead (honest reporting: failed, never silent ok).
// ─── T7.6 / A-05 (NFR-6 pinning): sleep() removes its abort listener on resolve ──
//
// Both sleep implementations registered `signal.addEventListener("abort", …,
// { once: true })` and never removed it when the TIMER resolved normally — a
// retry-heavy run (429 backoff × budget slots) accumulated hundreds of retained
// closures on the ONE shared run signal (MaxListenersExceededWarning noise).
describe("A-05: sleep() removes its abort listener on normal resolution", () => {
	it("wait() leaves the run signal's abort-listener count unchanged after a normal sleep", async () => {
		const controller = new AbortController();
		const baseline = getEventListeners(controller.signal, "abort").length;
		const ctx = mkCtx();
		(ctx as StageContext & { signal?: AbortSignal }).signal = controller.signal;
		const r = await wait(5).run({}, ctx);
		expect(r.status).toBe("ok");
		// RED today: the once-listener survives the timer resolution (+1 leak)
		expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
	});

	it("repeated waits on ONE signal never accumulate listeners", async () => {
		const controller = new AbortController();
		const baseline = getEventListeners(controller.signal, "abort").length;
		const ctx = mkCtx();
		(ctx as StageContext & { signal?: AbortSignal }).signal = controller.signal;
		for (let i = 0; i < 12; i++) await wait(1).run({}, ctx);
		expect(getEventListeners(controller.signal, "abort").length).toBe(baseline);
	});

	it("an aborted signal still resolves the sleep immediately (abort path preserved)", async () => {
		const controller = new AbortController();
		const ctx = mkCtx();
		(ctx as StageContext & { signal?: AbortSignal }).signal = controller.signal;
		const p = wait(5_000).run({}, ctx);
		controller.abort(); // fires while the sleep is pending
		const r = await p;
		expect(r.status).toBe("cancelled");
		expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	});
});

describe("A-04: writerTask on budget exhaustion records failed, never silent ok", () => {
	it("a writer stage whose body-level budget check fails throws — task() records status 'failed'", async () => {
		const { writerTask } = await import("../src/nodes.ts");
		const stage = writerTask({
			id: "requirements",
			label: "Stage 2 — Requirements",
			agent: "requirements-clarifier",
			buildPrompt: () => "write the requirements",
		});
		const ctx = mkCtx();
		// A-04's exact race: task()'s pre-check PASSES, then a parallel sibling
		// spends the last slot before writerTask's body-level re-check.
		let checks = 0;
		ctx.budget.check = () => ++checks === 1;
		const state: PipelineState = {};
		const r = await task(stage).run(state, ctx);
		expect(r.status).toBe("failed"); // RED today: "ok" (undefined recorded as ok)
		expect(r.error).toMatch(/budget exhausted/);
		expect(state.requirements).toBeUndefined(); // no artifact was fabricated
		expect(ctx.results[ctx.results.length - 1]?.status).toBe("failed");
	});

	it("the sentinel names the stage so the audit row is actionable", async () => {
		const { writerTask } = await import("../src/nodes.ts");
		const stage = writerTask({
			id: "bdd",
			label: "Stage 3 — BDD",
			agent: "bdd-scenario-writer",
			buildPrompt: () => "write the scenarios",
		});
		const ctx = mkCtx();
		let checks = 0;
		ctx.budget.check = () => ++checks === 1;
		const r = await task(stage).run({}, ctx);
		expect(r.status).toBe("failed");
		expect(r.error).toContain("bdd");
	});
});

describe("SD-07: waitForEvent is deleted (dead code, abort-listener leak)", () => {
	it("src/nodes.ts no longer declares or mentions waitForEvent / WaitForEventOptions", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const src = readFileSync(join(import.meta.dirname, "..", "src", "nodes.ts"), "utf8");
		expect(src).not.toContain("waitForEvent");
		expect(src).not.toContain("WaitForEventOptions");
	});

	it("no import site anywhere in src/ references waitForEvent", async () => {
		const { readFileSync, readdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
		});
		const hits = walk(join(import.meta.dirname, "..", "src"))
			.filter((p) => readFileSync(p, "utf8").includes("waitForEvent"));
		expect(hits).toEqual([]);
	});
});

describe("task precondition check", () => {
	it("logs ✓/✗ for each required upstream artifact before running", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "sd-pre-"));
		const logs: string[] = [];
		const ctx = { ...mkCtx(), setup: undefined, log: (m: string) => logs.push(m) } as any;
		// a stage requiring two docs, only one of which exists
		writeFileSync(join(dir, "01-requirements.md"), "x");
		const stage = {
			id: "bdd", label: "BDD", requires: ["*-requirements.md", "*-bdd-scenarios.md"],
			async run() { return { done: true }; },
		};
		const state = { setup: { specDirectory: dir + "/" } } as any;
		await (task as any)(stage).run(state, ctx);
		const preLogs = logs.filter((l) => l.startsWith("precondition"));
		expect(preLogs).toEqual([
			"precondition bdd: ✓ *-requirements.md",
			"precondition bdd: ✗ missing *-bdd-scenarios.md",
		]);
		rmSync(dir, { recursive: true, force: true });
	});
});

// ─── v0.3.34: one-shot writer inline render retries ─────────────────────────
// Runs 2026-08-30T00-14-16-142Z and 05-26-19-571Z (AnkiQuick): debugWriter is
// wired as a plain task() — NO convergence node guards its render, so a render
// rejection silently dropped the durable doc with stage status=ok. Now
// renderRetries writers re-run inline with the located errors fed back.
describe("v0.3.34: writerTask inline render retries (one-shot writers)", () => {
	const setup = (agentResults: Array<{ control: unknown }>) => {
		let calls = 0;
		const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const { join } = require("node:path");
		const dir = mkdtempSync(join(tmpdir(), "sd-wtr-"));
		const ctx = mkCtx();
		ctx.agent = async () => agentResults[Math.min(calls++, agentResults.length - 1)] as never;
		return { ctx, dir, rm: () => rmSync(dir, { recursive: true, force: true }), files: () => readdirSync(dir) };
	};

	it("a render-rejected attempt retries inline, feeds back located errors, and converges", async () => {
		const { writerTask } = await import("../src/nodes.ts");
		const bad = { title: "only a title" }; // missing required fields → render rejects
		const good = { title: "Debug", date: "2026-08-30", summary: "s", hypotheses: ["h1"], rootCause: "r", reproductionSteps: ["step"] };
		const { ctx, dir, rm, files } = setup([{ control: bad }, { control: good }]);
		const stage = writerTask({
			id: "debug", label: "Stage 4", agent: "debug-analyzer", renderRetries: 1,
			buildPrompt: () => "p",
		});
		const state = { setup: { specDirectory: dir + "/", worktreePath: dir } } as never;
		const out = await stage.run(state, ctx);
		// Agent called exactly twice: attempt 1 rejected, attempt 2 rendered.
		expect(out).toMatchObject({ hypotheses: ["h1"] });
		expect(files().some((f: string) => f.includes("debug"))).toBe(true);
		// Success clears the retry feedback slot — no stale error leaks downstream.
		expect(((state as Record<string, unknown>).__feedback ?? {}) as Record<string, unknown>).toEqual({});
		expect((state as Record<string, unknown>).__renderErrors).toBeUndefined();
		expect(ctx.results.some((r) => r.status === "failed")).toBe(false);
		rm();
	});

	it("persistent render failure records an HONEST failed row + __renderErrors (never silent ok)", async () => {
		const { writerTask } = await import("../src/nodes.ts");
		const bad = { title: "only a title" };
		const { ctx, dir, rm, files } = setup([{ control: bad }]);
		const stage = writerTask({
			id: "debug", label: "Stage 4", agent: "debug-analyzer", renderRetries: 1,
			buildPrompt: () => "p",
		});
		const state = { setup: { specDirectory: dir + "/", worktreePath: dir } } as never;
		await stage.run(state, ctx);
		expect(ctx.results.some((r) => r.id === "debug" && r.status === "failed" && /render rejected after 2 attempts/.test(String(r.error)))).toBe(true);
		expect(((state as Record<string, unknown>).__renderErrors as string[]).length).toBeGreaterThan(0);
		expect(files().some((f: string) => f.includes("debug"))).toBe(false);
		rm();
	});

	it("writers WITHOUT renderRetries call the agent exactly once (convergence nodes own their retries)", async () => {
		const { writerTask } = await import("../src/nodes.ts");
		const bad = { title: "only a title" };
		const { ctx, dir, rm } = setup([{ control: bad }, { control: bad }]);
		const stage = writerTask({ id: "debug", label: "Stage 4", agent: "debug-analyzer", buildPrompt: () => "p" });
		const state = { setup: { specDirectory: dir + "/", worktreePath: dir } } as never;
		await stage.run(state, ctx);
		expect(ctx.results.length).toBe(0); // no inline retry → no extra failed row
		rm();
	});
});
