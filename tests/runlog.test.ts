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
	appendGateChecked,
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

describe("appendGateChecked (P1.4)", () => {
	it("records a bounded gate outcome with stage attribution", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-runlog-gate-"));
		try {
			const state = { __runId: "r1", setup: { specDirectory: d } } as never;
			appendGateChecked(state, "phase-build", {
				pass: false,
				ran: ["npm run build", "npm test"],
				errors: ["x".repeat(500), "second error"],
				inScopePass: true,
			}, "implementation");
			const [e] = readRunEvents(d);
			expect(e.type).toBe("gate.checked");
			expect(e.stage).toBe("implementation");
			expect(e.runId).toBe("r1");
			expect(e.data.gate).toBe("phase-build");
			expect(e.data.pass).toBe(false);
			expect(e.data.inScopePass).toBe(true);
			expect(e.data.ran).toEqual(["npm run build", "npm test"]);
			const errors = e.data.errors as string[];
			expect(errors[0].length).toBeLessThanOrEqual(200); // truncated
			expect(errors).toHaveLength(2);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("caps ran at 12 and errors at 8; missing inScopePass stays absent; no specDir is a no-op", () => {
		const d = mkdtempSync(join(tmpdir(), "sd-runlog-gate2-"));
		try {
			const state = { __runId: "r1", setup: { specDirectory: d } } as never;
			appendGateChecked(state, "g", { pass: true, ran: Array.from({ length: 20 }, (_, i) => `cmd${i}`), errors: Array.from({ length: 20 }, (_, i) => `e${i}`) });
			const [e] = readRunEvents(d);
			expect((e.data.ran as string[])).toHaveLength(12);
			expect((e.data.errors as string[])).toHaveLength(8);
			expect("inScopePass" in e.data).toBe(false);
			appendGateChecked({} as never, "g", { pass: true }); // no setup — no throw
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

// ─── T7.9 / D-5 (NFR-6 pinning): ledger durability ─────────────────────
//
// appendRunEvent re-read the ENTIRE events.jsonl on every append to find
// lastSeq (O(n²) cumulative over a retry-heavy run), and only gate.checked
// bounded its payload — every other emitter could write an unbounded line.
describe("D-5: lastSeq is cached in memory per spec dir (tailProbe only on first append)", () => {
	it("a second append in the same process does NOT re-probe the file — seq comes from the cache", () => {
		const d = tmpSpecDir();
		try {
			expect(appendRunEvent(d, { runId: "r", type: "stage.started", data: {} })).toBe(1);
			// Simulate an EXTERNAL writer appending 4 more valid lines (a probe would
		// now find lastSeq 5; the in-memory cache must keep this process's own
		// sequence — single-process appends are the ledger's stated convention).
			const path = join(d, "events.jsonl");
		const extra = [2, 3, 4, 5].map((seq) => JSON.stringify({ seq, time: `t${seq}`, runId: "other", type: "stage.completed", data: {} })).join("\n");
			writeFileSync(path, readFileSync(path, "utf8") + extra + "\n");
			// RED today: the append re-probes → seq 6; with the cache → seq 2.
			const seq = appendRunEvent(d, { runId: "r", type: "stage.completed", data: {} });
			expect(seq).toBe(2);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("the cached append still heals a torn (newline-less) last line", () => {
		const d = tmpSpecDir();
		try {
			appendRunEvent(d, { runId: "r", type: "stage.started", data: {} });
			appendRunEvent(d, { runId: "r", type: "stage.completed", data: {} });
			// torn write lands AFTER the cache is primed (killed mid-append)
			const path = join(d, "events.jsonl");
			writeFileSync(path, readFileSync(path, "utf8") + '{"seq":3,"time":"t');
			const seq = appendRunEvent(d, { runId: "r", type: "stage.failed", data: {} });
			expect(seq).toBe(3);
			expect(readRunEvents(d)).toHaveLength(3); // the fresh line did not glue onto the fragment
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("the first append after process start still probes (a pre-existing file continues its seq)", () => {
		const d = tmpSpecDir();
		try {
			// seed a file as if written by a PREVIOUS process
			writeFileSync(join(d, "events.jsonl"), [
				JSON.stringify({ seq: 1, time: "t1", runId: "a", type: "run.started", data: {} }),
				JSON.stringify({ seq: 2, time: "t2", runId: "a", type: "run.completed", data: {} }),
			].join("\n") + "\n");
			// this test file's process never appended to d → the FIRST append probes
			expect(appendRunEvent(d, { runId: "b", type: "run.started", data: {} })).toBe(3);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

describe("D-5: uniform payload bound on every RunEventInput emitter", () => {
	it("an oversized data payload is replaced by a bounded truncation marker — the line stays valid JSON under the cap", () => {
		const d = tmpSpecDir();
		try {
			const blob = "x".repeat(300_000);
			const seq = appendRunEvent(d, { runId: "r", stage: "implementation", type: "agent.called", data: { agent: "implementer", control: { phases: blob } } });
			expect(seq).toBe(1);
			// RED today: the full 300KB blob is persisted verbatim.
			const events = readRunEvents(d);
			expect(events).toHaveLength(1);
			expect(events[0].data.dataTruncated).toBe(true);
			expect(typeof events[0].data.originalBytes).toBe("number");
			// the envelope survives for folds (seq/type/runId/stage intact)
			expect(events[0].type).toBe("agent.called");
			expect(events[0].stage).toBe("implementation");
			// the on-disk line is bounded
			const line = readFileSync(join(d, "events.jsonl"), "utf8").trim();
			expect(line.length).toBeLessThanOrEqual(70_000);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("normally-sized payloads are byte-identical (no marker, no truncation)", () => {
		const d = tmpSpecDir();
		try {
			appendRunEvent(d, { runId: "r", type: "stage.completed", data: { durationMs: 1234, partial: false } });
			const [e] = readRunEvents(d);
			expect(e.data).toEqual({ durationMs: 1234, partial: false });
			expect("dataTruncated" in e.data).toBe(false);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
