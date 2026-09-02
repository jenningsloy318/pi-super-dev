/**
 * v0.3.58 — pipelined-step line attribution (concurrent RED review vs implementer).
 *
 * Incident (live run 2026-09-02T00-12-23-714Z, phase-03): with v0.3.43
 * pipelining the RED review step runs CONCURRENTLY with the Implementation
 * step. The live stream's stage cursor is a single "most recent stage event"
 * register, so the Implementation step's `stage:{running}` event (arriving
 * ~21ms after the RED review's) stole every still-streaming RED-review line —
 * the code-reviewer's tool calls and verdict rendered INSIDE the
 * "· Implementation (attempt 1)" card, and the inverse leak threatened
 * post-join implementation lines after the review's terminal event moved the
 * cursor back.
 *
 * Fix class: attribution from the EMITTING async chain (AsyncLocalStorage),
 * never from a mutable cursor:
 *   - src/step-scope.ts — runInStepScope wraps each implementation step body;
 *     workflow.ts's progress shims attach currentStepScope() to every
 *     log/phase/text emission.
 *   - src/render/stage-occurrence.ts — stepOccurrenceStamp resolves the raw
 *     step id to the ACTIVE occurrence display id, ONLY while that row is
 *     still running (otherwise cursor fallback — correct ownership for
 *     post-step join lines).
 *   - src/render/live-stream.ts — sink log/phase/text accept the stamp and
 *     group the line under it, cursor untouched.
 *
 * L0 pure units + L1 sink-level incident regression; no agents, no git.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { runInStepScope, currentStepScope } from "../src/step-scope.ts";
import { stepOccurrenceStamp } from "../src/render/stage-occurrence.ts";
import { createLiveStream } from "../src/render/live-stream.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("step-scope (AsyncLocalStorage chain attribution)", () => {
	it("store is visible inside the wrapped chain (sync + after await) and absent outside", async () => {
		expect(currentStepScope()).toBeUndefined();
		await runInStepScope({ stageId: "impl.p1.step-1", stageLabel: "· RED review" }, async () => {
			expect(currentStepScope()?.stageId).toBe("impl.p1.step-1");
			await delay(1);
			expect(currentStepScope()?.stageId).toBe("impl.p1.step-1");
		});
		expect(currentStepScope()).toBeUndefined();
	});

	it("two interleaved concurrent chains keep DISTINCT stores (the pipelining class)", async () => {
		const seen: string[] = [];
		const chain = (id: string, wait: number) =>
			runInStepScope({ stageId: id, stageLabel: id }, async () => {
				await delay(wait);
				seen.push(`${id}:${currentStepScope()?.stageId}`);
			});
		// The slow chain starts first; the fast chain's emissions interleave —
		// exactly the RED review (slow) vs implementer (fast) overlap.
		await Promise.all([chain("review", 30), chain("impl", 5), delay(12).then(() => expect(currentStepScope()).toBeUndefined())]);
		expect(seen).toEqual(["impl:impl", "review:review"]);
	});

	it("runInStepScope returns the wrapped fn's value", () => {
		expect(runInStepScope({ stageId: "x", stageLabel: "x" }, () => 42)).toBe(42);
	});
});

describe("stepOccurrenceStamp (running-row guard)", () => {
	const step = { stageId: "impl.p1.step-5", stageLabel: "· RED review (attempt 1, try 1)" };

	it("stamps while the step's occurrence row is actively running", () => {
		expect(stepOccurrenceStamp(step, "impl.p1.step-5", "running")).toEqual({
			stageId: "impl.p1.step-5",
			stageLabel: "· RED review (attempt 1, try 1)",
		});
	});

	it("falls back to the cursor (undefined) for unknown / terminal rows", () => {
		expect(stepOccurrenceStamp(step, undefined, "running")).toBeUndefined();
		expect(stepOccurrenceStamp(step, "impl.p1.step-5", "ok")).toBeUndefined();
		expect(stepOccurrenceStamp(step, "impl.p1.step-5", undefined)).toBeUndefined();
	});
});

describe("live-stream stamp grouping (the incident regression)", () => {
	it("a stamped line groups under ITS step while another step owns the cursor", () => {
		const bodies: string[] = [];
		const stream = createLiveStream({ onUpdate: (b) => bodies.push(b) });
		const { sink, flush } = stream;
		// RED review step opens, then Implementation opens 21ms later (cursor → impl).
		sink.stage({ id: "impl.p3.step-5", label: "· RED review (attempt 1, try 1)", status: "running", kind: "step" });
		sink.stage({ id: "impl.p3.step-6", label: "· Implementation (attempt 1)", status: "running", kind: "step" });
		// The code-reviewer (RED review's child) emits while the cursor is on impl —
		// stamped with its OWN step by the extension seam:
		sink.log("code-reviewer: → bash git -C . diff tests/x.test.ts", { stageId: "impl.p3.step-5", stageLabel: "· RED review (attempt 1, try 1)" });
		// The implementer emits unstamped → cursor fallback (impl):
		sink.log("implementer: ⇢ Now implementing");
		flush();
		const body = bodies.at(-1)!;
		const reviewSection = body.split("▶ · Implementation (attempt 1)")[0]!;
		expect(reviewSection).toContain("▌· RED review (attempt 1, try 1)".replace("▌", "")); // non-TUI header
		expect(reviewSection).toContain("code-reviewer: → bash git -C . diff tests/x.test.ts");
		expect(reviewSection).not.toContain("implementer: ⇢ Now implementing");
		const implSection = body.split("▶ · Implementation (attempt 1)")[1]!;
		expect(implSection).toContain("implementer: ⇢ Now implementing");
		expect(implSection).not.toContain("code-reviewer:");
	});

	it("after the review step turns terminal, UNstamped lines follow the cursor (join-site ownership preserved)", () => {
		const bodies: string[] = [];
		const stream = createLiveStream({ onUpdate: (b) => bodies.push(b) });
		const { sink, flush } = stream;
		sink.stage({ id: "s-review", label: "· RED review", status: "running", kind: "step" });
		sink.stage({ id: "s-impl", label: "· Implementation", status: "running", kind: "step" });
		sink.stage({ id: "s-review", label: "· RED review", status: "ok", kind: "step" });
		// Post-join engine lines run OUTSIDE any step scope → cursor (s-review,
		// set by the terminal event — unchanged pre-existing behavior). Asserted
		// via the transcript: the completed section renders compact (sticky only),
		// so body-rendering would hide the ordinary line regardless of grouping.
		sink.log("red-review-incomplete (advisory): GREEN work KEPT");
		flush();
		const entry = stream.getTranscript().find((l) => l.text.includes("red-review-incomplete"));
		expect(entry?.stageId).toBe("s-review");
	});

	it("streamed agent text commits under the stamp captured at text() time", () => {
		const bodies: string[] = [];
		const stream = createLiveStream({ onUpdate: (b) => bodies.push(b) });
		const { sink, flush } = stream;
		sink.stage({ id: "s-review", label: "· RED review", status: "running", kind: "step" });
		sink.stage({ id: "s-impl", label: "· Implementation", status: "running", kind: "step" });
		// Reviewer streams its verdict while impl owns the cursor…
		sink.text("verdict: strong — all scenarios pinned", { stageId: "s-review", stageLabel: "· RED review" });
		// …and the next engine log finalizes the buffer AFTER the cursor moved.
		sink.log("engine line under impl cursor");
		flush();
		const body = bodies.at(-1)!;
		const reviewSection = body.split("▶ · Implementation")[0]!;
		expect(reviewSection).toContain("verdict: strong — all scenarios pinned");
	});
});

describe("wiring source contract (class-E: the seam cannot silently regress)", () => {
	const implementationSrc = readFileSync(new URL("../src/stages/implementation.ts", import.meta.url), "utf8");
	const workflowSrc = readFileSync(new URL("../src/workflow.ts", import.meta.url), "utf8");
	const extensionSrc = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");

	it("implementation runStep wraps its body in runInStepScope", () => {
		expect(implementationSrc).toContain("runInStepScope({ stageId: `implementation.${phaseId}.step-${pad(seq)}`");
		expect(implementationSrc).toContain('import { runInStepScope } from "../step-scope.ts";');
	});

	it("v0.3.59 review P1 (class fix): ALL concurrency-critical step sites attribute per-chain — runStep wrap + the manual TDD RED and Implementation sites via inStepScope", () => {
		// The RED review step is wrapped by runStep itself; the manual sites MUST
		// route their ctx.agent emissions through inStepScope — otherwise the
		// implementer's unstamped lines land in the RED review's card once the
		// review's terminal event moves the cursor back (the inverse leak).
		expect(implementationSrc).toContain("const inStepScope = <T>(seq: number, stepLabel: string, fn: () => Promise<T>): Promise<T> =>");
		expect(implementationSrc.match(/await inStepScope\(/g)?.length).toBe(2);
		expect(implementationSrc).toContain("await inStepScope(tddStepSeq, `TDD RED (");
		expect(implementationSrc).toContain("await inStepScope(implStepSeq, `Implementation (");
	});

	it("session backend loader follows the SAME skills switch (v0.3.59: noSkills hard-coding removed)", () => {
		const sessionSrc = readFileSync(new URL("../src/session-agent.ts", import.meta.url), "utf8");
		expect(sessionSrc).toContain("noSkills: !skillsEnabled()");
		expect(sessionSrc).toContain('skillsEnabled');
	});

	it("workflow progress shims attach currentStepScope to log/phase/text", () => {
		expect(workflowSrc).toContain("progress?.log(msg, currentStepScope())");
		expect(workflowSrc).toContain("progress.phase(String(label), currentStepScope())");
		expect(workflowSrc).toContain("options.progress?.text(partial, currentStepScope())");
	});

	it("extension seam resolves stamps through stepOccurrenceStamp", () => {
		expect(extensionSrc).toContain("stepOccurrenceStamp(step, activeId");
		expect(extensionSrc).toContain("stream.sink.log(message, stepStamp(step))");
	});
});
