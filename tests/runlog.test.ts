/**
 * P1.1 (dsh-09 v3): the run-event ledger core. Append/read roundtrip, seq
 * monotonicity, torn-line tolerance, no-specDir no-op, RUN_LOG_VERSION in the
 * first event, and the pure-fold determinism invariant.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RUN_LOG_VERSION,
	appendRunEvent,
	readRunEvents,
	foldEvents,
	runStartedEvent,
	type RunEvent,
} from "../src/runlog.ts";

function tmpSpecDir(): string {
	return mkdtempSync(join(tmpdir(), "sd-runlog-"));
}

describe("run-event ledger (P1.1)", () => {
	it("append/read roundtrip with monotonic seq", () => {
		const d = tmpSpecDir();
		try {
			const s1 = appendRunEvent(d, runStartedEvent("run-1", "do the thing", "0.1.80"));
			const s2 = appendRunEvent(d, { runId: "run-1", stage: "requirements", type: "stage.started", data: {} });
			const s3 = appendRunEvent(d, { runId: "run-1", stage: "requirements", type: "stage.completed", data: { durationMs: 1200 } });
			expect([s1, s2, s3]).toEqual([1, 2, 3]);
			const events = readRunEvents(d);
			expect(events).toHaveLength(3);
			expect(events[0].type).toBe("run.started");
			expect(events[0].data.ledgerVersion).toBe(RUN_LOG_VERSION);
			expect(events[1].stage).toBe("requirements");
			expect(events[2].data.durationMs).toBe(1200);
			// every event carries time + runId
			for (const e of events) {
				expect(e.time).toBeTruthy();
				expect(e.runId).toBe("run-1");
			}
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("continues seq after re-read (last-line seq + 1)", () => {
		const d = tmpSpecDir();
		try {
			appendRunEvent(d, { runId: "r", type: "stage.started", data: {} });
			appendRunEvent(d, { runId: "r", type: "stage.completed", data: {} });
			const s3 = appendRunEvent(d, { runId: "r", type: "agent.called", data: { agent: "implementer" } });
			expect(s3).toBe(3);
			expect(readRunEvents(d)).toHaveLength(3);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("tolerates a torn last line (killed mid-append)", () => {
		const d = tmpSpecDir();
		try {
			appendRunEvent(d, { runId: "r", type: "stage.started", data: {} });
			appendRunEvent(d, { runId: "r", type: "stage.completed", data: {} });
			// simulate a torn write: half a JSON line
			const path = join(d, "events.jsonl");
			const text = readFileSync(path, "utf8");
			writeFileSync(path, text + '{"seq":3,"time":"2026-08-16T');
			const events = readRunEvents(d);
			expect(events).toHaveLength(2);
			// the NEXT append recovers: it computes seq from the last PARSEABLE line
			const s = appendRunEvent(d, { runId: "r", type: "stage.failed", data: {} });
			expect(s).toBe(3);
			expect(readRunEvents(d)).toHaveLength(3);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("no spec dir (undefined/empty) is a silent no-op; reads return []", () => {
		expect(appendRunEvent(undefined, { runId: "r", type: "run.started", data: {} })).toBeNull();
		expect(appendRunEvent("", { runId: "r", type: "run.started", data: {} })).toBeNull();
		expect(readRunEvents(undefined)).toEqual([]);
		expect(readRunEvents("/nonexistent/sd/nowhere")).toEqual([]);
	});

	it("never throws on an unwritable directory", () => {
		expect(appendRunEvent("/nonexistent-root/sd/cannot/write", { runId: "r", type: "run.started", data: {} })).toBeNull();
	});

	it("foldEvents is pure and deterministic (same events → same state)", () => {
		const events: RunEvent[] = [
			{ seq: 1, time: "t1", runId: "r", type: "stage.started", stage: "bdd", data: {} },
			{ seq: 2, time: "t2", runId: "r", type: "stage.completed", stage: "bdd", data: { durationMs: 5 } },
			{ seq: 3, time: "t3", runId: "r", type: "stage.failed", stage: "verify", data: { error: "x" } },
		];
		const fold = (evts: RunEvent[]) => foldEvents(evts, {} as Record<string, string>, (acc, e) => {
			if (e.type === "stage.started") return { ...acc, [e.stage ?? "?"]: "running" };
			if (e.type === "stage.completed") return { ...acc, [e.stage ?? "?"]: "ok" };
			if (e.type === "stage.failed") return { ...acc, [e.stage ?? "?"]: "failed" };
			return acc;
		});
		const a = fold(events);
		const b = fold(events);
		expect(a).toEqual(b);
		expect(a).toEqual({ bdd: "ok", verify: "failed" });
		// a malformed step result never breaks the fold
		expect(foldEvents(events, 0, (acc) => { if (acc === 1) throw new Error("boom"); return acc + 1; })).toBe(1);
	});

	it("replan event data shapes record the R3 circuit fields", () => {
		const d = tmpSpecDir();
		try {
			appendRunEvent(d, { runId: "r", type: "replan.routed", data: { findings: [{ id: "AR-03-03", owner: "spec", routable: true, source: "doc-path", reason: "cites the specification artifact" }], invalidationSet: ["spec", "implementation", "verify"] } });
			const [e] = readRunEvents(d);
			expect(e.type).toBe("replan.routed");
			expect((e.data as { invalidationSet: string[] }).invalidationSet).toContain("verify");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
