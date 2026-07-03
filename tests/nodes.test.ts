/**
 * Unit tests for the control-flow node algebra. All tests use mock tasks —
 * NO `pi` subprocess spawns, NO network, NO LLM. Fast and deterministic.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
	task, sequence, branch, choose, parallel, loop, retry, gate, map, wait, tryCatch, noop,
} from "../src/nodes.ts";
import type { AgentCall, AgentResult, Budget, PipelineState, Stage, StageContext } from "../src/types.ts";

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
		spent() { this.count++; },
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
		events: new EventEmitter(),
		results: [],
	};
}

const run = (node: ReturnType<typeof task>, state: PipelineState = {}) =>
	node.run(state, mkCtx());

describe("task", () => {
	it("runs and stores its return value under state[id]", async () => {
		const t = task(mockTask("foo", () => ({ ok: true })));
		const state: PipelineState = {};
		const r = await t.run(state, mkCtx());
		expect(r.status).toBe("ok");
		expect(state.foo).toEqual({ ok: true });
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
		const g = gate({ validate: (s) => (s.v as number) >= 2, attempts: 5 }, node);
		const r = await g.run({}, mkCtx());
		expect(r.status).toBe("ok");
		expect(n).toBe(2);
	});
	it("returns failed when validation never passes", async () => {
		const node = task(mockTask("g", () => 1));
		const r = await gate({ validate: () => false, attempts: 3 }, node).run({}, mkCtx());
		expect(r.status).toBe("failed");
	});
	it("throws on exhaustion when fatal: true", async () => {
		const node = task(mockTask("g", () => 1));
		await expect(
			gate({ validate: () => false, attempts: 2, fatal: true, fatalMessage: "boom-gate" }, node).run({}, mkCtx()),
		).rejects.toThrow("boom-gate");
	});
	it("throws when fatal: true and the wrapped node itself fails", async () => {
		// A task that throws -> returns {status:"failed"}. With fatal, the gate
		// must abort (throw) instead of swallowing and continuing.
		const node = task({ id: "g", label: "g", async run() { throw new Error("spawn died"); } });
		await expect(
			gate({ validate: () => true, attempts: 2, fatal: true, fatalMessage: "g-gate" }, node).run({}, mkCtx()),
		).rejects.toThrow("g-gate");
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
