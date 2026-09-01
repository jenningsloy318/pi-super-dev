/**
 * v0.3.56 F6 — the stage wrapper's `infraFailed` check scanned ALL of
 * ctx.results with no round scoping, so ONE transient failure of a stage id
 * permanently suppressed its later ok row: deriveRunStatus's
 * last-status-wins could never see the round-2 ok, `success` was unreachable
 * after any retry, and the summary showed a phantom "stage X ended failed".
 *
 * Escape class G (state lifecycle across rounds); defense layer L0/L3 with a
 * real gate({attempts:2}) flow.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { task, gate } from "../src/nodes.ts";
import { deriveRunStatus } from "../src/workflow.ts";
import type { AgentCall, AgentResult, Budget, PipelineState, Stage, StageContext } from "../src/types.ts";

function mkCtx(): StageContext {
	const budget: Budget = { count: 0, check: () => true, spent() { this.count++; return true; } };
	return {
		task: "", options: {}, state: {},
		async agent(_call: AgentCall): Promise<AgentResult> { throw new Error("no agent in unit tests"); },
		async helper() { throw new Error("no helper here"); },
		async parallel(calls) { return Promise.all(calls.map((c) => c())); },
		budget, log() {}, phase() {}, events: new EventEmitter(), results: [],
	};
}

describe("gate retry round scoping (F6)", () => {
	it("a stage that failed round 1 and passed round 2 records the ok row", async () => {
		const ctx = mkCtx();
		let n = 0;
		const node = task({ id: "converging", label: "Converging", async run() { n++; if (n === 1) throw new Error("transient infra"); return "done"; } });
		const r = await gate({ validate: () => ({ pass: true, errors: [] }), attempts: 2 }, node).run({}, ctx);
		expect(r.status).toBe("ok");
		const rows = ctx.results.filter((x) => x.id === "converging");
		expect(rows.map((x) => x.status)).toEqual(["failed", "ok"]); // BOTH rows, honest history
		// The last-status-wins derivation now sees the round-2 ok (pre-fix the
		// ok row was suppressed forever → phantom "stage ended failed").
		const derived = deriveRunStatus({ results: ctx.results, state: {} as PipelineState, aborted: false });
		expect(derived.failedStages).toEqual([]);
		expect(derived.statusReasons.some((s) => /ended failed/.test(s))).toBe(false);
	});

	it("a genuinely infra-failed FINAL attempt still reports failed", async () => {
		const ctx = mkCtx();
		const node = task({ id: "doomed", label: "Doomed", async run() { throw new Error("spawn died"); } });
		const r = await gate({ validate: () => ({ pass: true, errors: [] }), attempts: 2 }, node).run({}, ctx);
		expect(r.status).toBe("failed");
		const derived = deriveRunStatus({ results: ctx.results, state: {} as PipelineState, aborted: false });
		expect(derived.failedStages.map((f) => f.label)).toEqual(["Doomed"]);
	});

	it("G21 preserved: a mid-run infra row from THIS execution still suppresses the ok row", async () => {
		const ctx = mkCtx();
		const node = task({
			id: "g21", label: "G21",
			async run(_s, c) {
				// writerTask's honest infra marker: a failed row pushed MID-RUN by
				// the stage itself (after this execution's snapshot → still counts).
				c.results.push({ id: "g21", label: "G21", status: "failed", error: "infra honest marker" });
				return "value";
			},
		});
		const r = await gate({ validate: () => ({ pass: true, errors: [] }), attempts: 1 }, node).run({}, ctx);
		expect(r.status).toBe("ok"); // the node itself succeeded
		const rows = ctx.results.filter((x) => x.id === "g21");
		expect(rows).toHaveLength(1); // the ok row is SUPPRESSED by the mid-run infra row
		expect(rows[0]!.status).toBe("failed");
	});
});
