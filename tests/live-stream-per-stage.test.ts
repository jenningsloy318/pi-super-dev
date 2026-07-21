/**
 * Phase (RED) tests — Stage tagging at the sink (AC-01, SCENARIO-001..004).
 *
 * Domain: render-live-stream.
 *
 * === What these tests pin ===
 * The `TranscriptLine` shape widens ADDITIVELY to carry `stageId` + `stageLabel`,
 * and the factory sink gains a `currentStageId`/`currentStageLabel` pair (default
 * `"setup"` / `"pre-stage"`) plus a new `stage(info:{id,label,status?})` method.
 * Every push site — `phase`, `log`, `userInput`, and the `finalizeLive`
 * thinking commit — stamps the CURRENT stage tag onto the new entry.
 *
 * SCENARIO-001: entries recorded before the first banner carry the default
 *   `"setup"` / `"pre-stage"` tag (phase / log / thinking / user-input).
 * SCENARIO-002: after `sink.stage({id,label})` fires, subsequent log / thinking
 *   (finalizeLive) / user-input / trim entries inherit the new stage until the
 *   next banner.
 * SCENARIO-003: implementation sub-phase `phase` banners (RED/GREEN/REFACTOR)
 *   collapse to a single `"implementation"` stageId by ordinary inheritance —
 *   there is NO collapse map / sub-phase grouping.
 * SCENARIO-004: the stage id is resolved from the STRUCTURED `info.id` field,
 *   NOT by parsing the human-readable `▶ Stage N` label; AND `sink.stage`
 *   re-tags the MOST-RECENT transcript entry when it is a `phase` line whose
 *   label matches `info.label` (the recommended sink-side fix for the
 *   phase-before-stage emit ordering proven in research RESOLVED-1).
 *
 * === Expected state: ALL FAILING (RED) ===
 *   - `TranscriptLine` has no `stageId` / `stageLabel` fields today, so the
 *     `expect(entry.stageId).toBe(...)` assertions fail.
 *   - `createLiveStream({}).sink.stage` is `undefined`, so calling it throws
 *     "stage is not a function".
 * No `execute` / spawned `pi` children are involved — the factory sink is
 * driven directly in isolation.
 */
import { describe, it, expect } from "vitest";

import { createLiveStream } from "../src/render/live-stream.ts";

/** The structured dashboard `stage` event payload (the ONLY source the sink
 *  should read stage identity from — never the `▶ Stage N` label text). */
type StageInfo = { id: string; label: string; status?: string };

// ─── SCENARIO-001: pre-stage entries tagged with default setup stage ─────

describe("SCENARIO-001: pre-stage entries tagged with default setup stage", () => {
	it("a phase line pushed before any banner carries the default stageId/stageLabel", () => {
		const h = createLiveStream({});
		h.sink.phase("Requirements");
		const [entry] = h.getTranscript();
		expect(entry?.kind).toBe("phase");
		expect(entry?.text).toBe("▶ Requirements");
		expect(entry?.stageId).toBe("setup");
		expect(entry?.stageLabel).toBe("pre-stage");
	});

	it("a log line pushed before any banner carries the default stageId/stageLabel", () => {
		const h = createLiveStream({});
		h.sink.log("doing some work");
		const [entry] = h.getTranscript();
		expect(entry?.stageId).toBe("setup");
		expect(entry?.stageLabel).toBe("pre-stage");
	});

	it("a thinking commit (finalizeLive) before any banner carries the default tag", () => {
		const h = createLiveStream({});
		h.sink.text("musing...");
		h.finalizeLive();
		const [entry] = h.getTranscript();
		expect(entry?.kind).toBe("thinking");
		expect(entry?.stageId).toBe("setup");
		expect(entry?.stageLabel).toBe("pre-stage");
	});

	it("a user-input line pushed before any banner carries the default tag", () => {
		const h = createLiveStream({});
		h.sink.userInput("steer toward tests");
		const [entry] = h.getTranscript();
		expect(entry?.kind).toBe("user-input");
		expect(entry?.text).toBe("📥 steer toward tests");
		expect(entry?.stageId).toBe("setup");
		expect(entry?.stageLabel).toBe("pre-stage");
	});

	it("transcriptTail entries ALSO carry the default stage tag (end-to-end)", () => {
		const h = createLiveStream({});
		h.sink.log("early");
		h.sink.phase("Spec");
		for (const entry of h.transcriptTail()) {
			expect(entry.stageId).toBe("setup");
			expect(entry.stageLabel).toBe("pre-stage");
		}
	});
});

// ─── SCENARIO-002: entries inherit the current stage after each banner ────

describe("SCENARIO-002: entries inherit the current stage after each banner", () => {
	it("a log after sink.stage inherits the new stageId/stageLabel", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.log("found an open issue");
		const [entry] = h.getTranscript();
		expect(entry?.stageId).toBe("research");
		expect(entry?.stageLabel).toBe("Research");
	});

	it("a thinking commit after sink.stage inherits the new stage tag", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "design", label: "Design" } satisfies StageInfo);
		h.sink.text("designing...");
		h.finalizeLive();
		const [entry] = h.getTranscript();
		expect(entry?.stageId).toBe("design");
		expect(entry?.stageLabel).toBe("Design");
	});

	it("a user-input line after sink.stage inherits the new stage tag", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "spec", label: "Specification" } satisfies StageInfo);
		h.sink.userInput("add a constraint");
		const [entry] = h.getTranscript();
		expect(entry?.stageId).toBe("spec");
		expect(entry?.stageLabel).toBe("Specification");
	});

	it("a phase banner emitted after sink.stage inherits the new stage tag", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "spec", label: "Specification" } satisfies StageInfo);
		// A phase banner for a DIFFERENT label than the running stage should still
		// inherit the current stage until the next `sink.stage`.
		h.sink.phase("Sub-step");
		const [entry] = h.getTranscript();
		expect(entry?.kind).toBe("phase");
		expect(entry?.text).toBe("▶ Sub-step");
		expect(entry?.stageId).toBe("spec");
	});

	it("the current stage persists across many entries until the next sink.stage", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.log("a");
		h.sink.log("b");
		h.sink.text("c");
		h.finalizeLive();
		h.sink.userInput("d");
		for (const entry of h.getTranscript()) {
			expect(entry.stageId).toBe("research");
			expect(entry.stageLabel).toBe("Research");
		}
	});

	it("a second sink.stage switches the inherited tag for everything after it", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.log("researching");
		h.sink.stage({ id: "design", label: "Design" } satisfies StageInfo);
		h.sink.log("designing");
		const [first, second] = h.getTranscript();
		expect(first?.stageId).toBe("research"); // unchanged retroactively
		expect(second?.stageId).toBe("design");  // newly inherited
	});
});

// ─── SCENARIO-003: implementation sub-phases collapse to a single stage ──

describe("SCENARIO-003: implementation sub-phases collapse to 'implementation'", () => {
	it("RED/GREEN/REFACTOR phase banners within implementation inherit stageId='implementation'", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "implementation", label: "Implementation" } satisfies StageInfo);
		h.sink.phase("RED");
		h.sink.log("writing failing test");
		h.sink.phase("GREEN");
		h.sink.log("making it pass");
		h.sink.phase("REFACTOR");
		h.sink.log("tidying up");
		// NO collapse map — ordinary inheritance keeps every entry on the single
		// implementation stageId; there is no finer sub-phase grouping.
		for (const entry of h.getTranscript()) {
			expect(entry.stageId).toBe("implementation");
			expect(entry.stageLabel).toBe("Implementation");
		}
	});

	it("the sub-phase banners do NOT create their own groupable stages", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "implementation", label: "Implementation" } satisfies StageInfo);
		h.sink.phase("RED");
		h.sink.phase("GREEN");
		const distinctStages = new Set(h.getTranscript().map((e) => e.stageId));
		// Exactly ONE stageId — both RED and GREEN collapse to "implementation".
		expect(distinctStages).toEqual(new Set(["implementation"]));
	});
});

// ─── SCENARIO-004: stage id resolved from structured event + phase re-tag ─

describe("SCENARIO-004: stage id from structured event, not label parsing", () => {
	it("the stageId is taken verbatim from info.id (never derived from the label)", () => {
		// info.id "spec" is distinct from anything parseable out of label
		// "Specification" — a label-parsing implementation would NOT yield "spec".
		const h = createLiveStream({});
		h.sink.stage({ id: "spec", label: "Specification" } satisfies StageInfo);
		h.sink.log("writing the spec");
		const [entry] = h.getTranscript();
		expect(entry?.stageId).toBe("spec");
	});

	it("a numeric-looking id ('stage-9') is honored verbatim, not parsed off a '▶ Stage 9' label", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "stage-9", label: "Stage 9 — Implementation" } satisfies StageInfo);
		h.sink.log("work");
		const [entry] = h.getTranscript();
		expect(entry?.stageId).toBe("stage-9");
		expect(entry?.stageLabel).toBe("Stage 9 — Implementation");
	});

	it("re-tags the most-recent PHASE line when its label matches info.label (phase-before-stage ordering)", () => {
		// Realistic control-flow ordering: phase fires, THEN stage:{running}.
		// Without the re-tag, the phase line would keep the PREVIOUS stageId.
		const h = createLiveStream({});
		h.sink.phase("Research"); // pushed with default "setup" tag
		// sanity: at push time it WAS "setup"
		expect(h.getTranscript()[0]?.stageId).toBe("setup");
		h.sink.stage({ id: "research", label: "Research", status: "running" } satisfies StageInfo);
		// The re-tag corrects the most-recent phase entry to the new stage.
		expect(h.getTranscript()[0]?.stageId).toBe("research");
		expect(h.getTranscript()[0]?.stageLabel).toBe("Research");
	});

	it("after the re-tag, a subsequent log inherits the NEW stage normally", () => {
		const h = createLiveStream({});
		h.sink.phase("Research");
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.log("found an issue");
		const [, log] = h.getTranscript();
		expect(log?.stageId).toBe("research");
		expect(log?.stageLabel).toBe("Research");
	});

	it("re-tag only touches the MOST-RECENT matching phase line, leaving older phase lines alone", () => {
		const h = createLiveStream({});
		h.sink.phase("Research"); // older phase line — "setup"
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo); // re-tags it
		h.sink.phase("Design"); // newer phase line, pushed under "research"
		h.sink.stage({ id: "design", label: "Design" } satisfies StageInfo); // re-tags "Design"
		const [researchPhase, designPhase] = h.getTranscript();
		// The earlier re-tag is NOT undone by the later stage event.
		expect(researchPhase?.stageId).toBe("research");
		expect(designPhase?.stageId).toBe("design");
	});

	it("re-tag does NOT fire when the most-recent entry is a phase line with a NON-matching label", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.phase("Design"); // phase label "Design" != info.label "Implementation"
		const phaseBefore = h.getTranscript()[0]?.stageId;
		h.sink.stage({ id: "impl", label: "Implementation" } satisfies StageInfo);
		// The mismatched phase line keeps its pre-stage tag ("research").
		expect(h.getTranscript()[0]?.stageId).toBe(phaseBefore);
		expect(h.getTranscript()[0]?.stageId).toBe("research");
	});

	it("re-tag does NOT fire when the most-recent entry is NOT a phase line", () => {
		const h = createLiveStream({});
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.log("a normal log line"); // not a phase line
		const logBefore = h.getTranscript()[0]?.stageId;
		// Even if info.label happened to equal "Research", a non-phase entry is untouched.
		h.sink.stage({ id: "design", label: "Research" } satisfies StageInfo);
		expect(h.getTranscript()[0]?.stageId).toBe(logBefore);
		expect(h.getTranscript()[0]?.stageId).toBe("research");
	});

	it("two adjacent phase lines with the SAME label: only the most-recent is re-tagged", () => {
		const h = createLiveStream({});
		h.sink.phase("Research"); // first phase, "setup"
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo); // re-tags it
		h.sink.phase("Research"); // second identical-label phase, pushed under "research"
		// before the next stage event both exist; only the SECOND is re-tagged now.
		h.sink.stage({ id: "research2", label: "Research" } satisfies StageInfo);
		const [first, second] = h.getTranscript();
		expect(first?.stageId).toBe("research");  // NOT re-tagged again
		expect(second?.stageId).toBe("research2"); // most-recent → re-tagged
	});

	it("sink.stage accepts a status field without throwing (status is dashboard-facing, not stored on the line)", () => {
		const h = createLiveStream({});
		expect(() =>
			h.sink.stage({ id: "research", label: "Research", status: "running" } satisfies StageInfo),
		).not.toThrow();
		// The line carries the stage id/label; status is consumed downstream.
		h.sink.phase("Research");
		h.sink.stage({ id: "research", label: "Research", status: "ok" } satisfies StageInfo);
		expect(h.getTranscript()[0]?.stageId).toBe("research");
	});
});

// ─── Regression: stage tagging never leaks ANSI / breaks the raw disk log ─

describe("regression: stage tagging stays byte-clean (non-TUI / disk log)", () => {
	it("diskLogText() remains raw line.text only — no stage tags leak into the on-disk log", () => {
		const h = createLiveStream({});
		h.sink.phase("Spec");
		h.sink.stage({ id: "spec", label: "Specification" } satisfies StageInfo);
		h.sink.log("writing");
		expect(h.diskLogText()).toBe("▶ Spec\nwriting");
	});

	it("a non-TUI flush stays zero-ANSI once stage tags are present", () => {
		const bodies: string[] = [];
		const h = createLiveStream({ onUpdate: (b) => bodies.push(b), mode: "print" });
		h.sink.phase("Research");
		h.sink.stage({ id: "research", label: "Research" } satisfies StageInfo);
		h.sink.log("hi");
		h.flush();
		expect(bodies.at(-1)).not.toMatch(/\x1b\[/);
	});
});
