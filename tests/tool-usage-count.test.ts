/**
 * P3 / D6 (DEC-12 telemetry amendment) — tool-usage rows gain `count: n`.
 *
 * The per-call collector keys on (tool, argHead) and now INCREMENTS count
 * instead of dropping in-call repeats: one row per key per call, count n,
 * absent ≡ 1 (backward compatible — pre-P3 rows stay valid input, and
 * readers that ignore count see identical behavior).
 *
 * Hermetic by construction: every directory is an injected tmp dir; the
 * delegation-bus harness mirrors tests/skill-curation.test.ts (a fake bus
 * answering prompt-template:subagent events — NO real LLM).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendToolUsageRows, TOOL_USAGE_BASENAME, toolArgHead } from "../src/evolution/tool-usage.ts";
import { makeContext } from "../src/workflow.ts";
import type { AgentCall, PipelineState, RunOptions } from "../src/types.ts";

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "sd-toolcount-")); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

const mkCtx = (state: PipelineState, options: RunOptions = {}) => makeContext(state, "t", options, () => {});
const CALL: AgentCall = { id: "pipeline.research", agent: "research-agent", prompt: "x" };

function busWithTicks(tickTools: Array<Array<{ tool: string; args: string }>>) {
	const bus = new EventEmitter() as any;
	bus.on("prompt-template:subagent:request", (req: any) => {
		// emit EVERY tick's update (sequenced microtasks) before the response,
		// so the collector observes in-call repetition
		const emitTicks = (i: number) => {
			if (i >= tickTools.length) {
				bus.emit("prompt-template:subagent:response", {
					requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId,
					status: "completed",
					result: { kind: "text", text: "ok" },
					model: "fake/model-1",
				});
				return;
			}
			bus.emit("prompt-template:subagent:update", {
				requestId: req.requestId,
				recentTools: tickTools[i] ?? [],
				currentTool: "grep",
			});
			queueMicrotask(() => emitTicks(i + 1));
		};
		queueMicrotask(() => emitTicks(0));
	});
	return bus;
}

describe("D6 telemetry amendment — count:n rows, absent ≡ 1", () => {
	it("appendToolUsageRows round-trips count; rows without count remain valid", () => {
		const dir = join(tmpRoot, "rt");
		mkdirSync(dir, { recursive: true });
		appendToolUsageRows(dir, [
			{ ts: 1, runId: "r", agent: "sd-implementer", tool: "read", argHead: "src/a.ts", count: 4 },
			{ ts: 2, runId: "r", agent: "sd-implementer", tool: "read", argHead: "src/b.ts" }, // pre-P3 shape
		]);
		const rows = readFileSync(join(dir, TOOL_USAGE_BASENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ tool: "read", argHead: "src/a.ts", count: 4 });
		expect(rows[1]).toMatchObject({ tool: "read", argHead: "src/b.ts" });
		expect(rows[1].count).toBeUndefined(); // absent ≡ 1 — the reader supplies the default
		expect(toolArgHead("  spaced   out  args ")).toBe("spaced out args"); // argHead stays bounded+single-line
	});

	it("the workflow collector INCREMENTS count across in-call repeats (one row per key)", async () => {
		const dir = join(tmpRoot, "collector");
		mkdirSync(dir, { recursive: true });
		// Tick 1: two calls; tick 2: one exact repeat + one new; tick 3: the repeat again.
		const bus = busWithTicks([
			[{ tool: "read", args: "src/a.ts" }, { tool: "grep", args: "pattern src/a.ts" }],
			[{ tool: "read", args: "src/a.ts" }, { tool: "read", args: "src/c.ts" }],
			[{ tool: "read", args: "src/a.ts" }],
		]);
		const ctx = mkCtx({ setup: { specDirectory: dir, specIdentifier: "tu2" } as never }, { events: bus } as RunOptions);
		await ctx.agent(CALL);
		const rows = readFileSync(join(dir, TOOL_USAGE_BASENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const byKey = new Map(rows.map((r) => [`${r.tool}\u0000${r.argHead}`, r]));
		// one row per (tool, argHead) key: the read repeats fold into count; the
		// live currentTool tick ("grep", no args) is its own key and folds too.
		expect(rows).toHaveLength(4);
		const repeated = byKey.get("read\u0000src/a.ts")!;
		expect(repeated.count).toBe(3); // three invocations folded into count
		expect(byKey.get("read\u0000src/c.ts")!.count).toBe(1);
		expect(byKey.get("grep\u0000pattern src/a.ts")!.count).toBe(1);
		expect(byKey.get("grep\u0000")!.count).toBe(3); // currentTool tick on every update
		// every row this collector writes carries an explicit count
		expect(rows.every((r) => typeof r.count === "number" && r.count >= 1)).toBe(true);
	});

	it("the collector source contract: Map-keyed counting, no early drop (P3 amendment pin)", () => {
		const src = readFileSync(fileURLToPath(new URL("../src/workflow.ts", import.meta.url)), "utf8");
		expect(src).toContain("const toolCounts = new Map<string, { tool: string; argHead: string; count: number }>()");
		expect(src).toContain("const flushToolUsage = (): void => {"); // ONE flush per agent call
		expect(src).toContain("argHead: r.argHead, count: r.count })));"); // folded rows, explicit count
		expect(src).not.toContain("toolSeen.has(key)) return;"); // the drop is GONE
		expect(src).not.toMatch(/onToolUse[\s\S]{0,400}?appendToolUsageRows/); // no append inside the hook — flush owns the write
	});
});

describe("D6 telemetry amendment — malformed / no-dir behavior unchanged", () => {
	it("appendToolUsageRows never throws without a dir and ignores empty batches", () => {
		expect(() => appendToolUsageRows(undefined, [{ ts: 1, runId: "r", agent: "a", tool: "bash", argHead: "", count: 2 }])).not.toThrow();
		const dir = join(tmpRoot, "noop");
		expect(() => appendToolUsageRows(dir, [])).not.toThrow();
		expect(() => appendToolUsageRows(dir, [{ ts: 1, runId: "r", agent: "a", tool: "bash", argHead: "x", count: 1 }])).not.toThrow();
		// parent dir absent → mkdir-less append is best-effort; the harness never breaks (P5)
	});

	it("pre-P3 rows mixed with counted rows both parse through the reader contract", () => {
		const dir = join(tmpRoot, "mixed");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, TOOL_USAGE_BASENAME), [
			JSON.stringify({ ts: 1, runId: "r", agent: "a", tool: "read", argHead: "src/old.ts" }),
			JSON.stringify({ ts: 2, runId: "r", agent: "a", tool: "read", argHead: "src/new.ts", count: 7 }),
		].join("\n") + "\n", "utf8");
		const text = readFileSync(join(dir, TOOL_USAGE_BASENAME), "utf8");
		const parsed = text.trim().split("\n").map((l) => JSON.parse(l));
		expect(parsed[0].count).toBeUndefined();
		expect(parsed[1].count).toBe(7);
	});
});
