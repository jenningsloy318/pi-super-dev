/**
 * UNIT tests — `groupByStage` pure partitioner (AC-02 / SCENARIO-005..009).
 *
 * This is the RED-phase test for Phase 2 of spec 12 (per-stage log sections).
 * It exercises the new dependency-free module `src/render/stage-grouping.ts`
 * in total isolation — no dashboard import, no theme, no control-flow — with
 * SYNTHETIC tagged / untagged / legacy-string transcripts. The lookup
 * `statusOf` is injected so the helper stays pure and unit-testable.
 *
 * Scenario coverage:
 *   SCENARIO-005 — groups partitioned in FIRST-APPEARANCE order, each holding
 *                  only that stage's lines.
 *   SCENARIO-006 — an all-one-stage transcript yields exactly ONE group.
 *   SCENARIO-007 — untagged / string-shaped legacy entries collapse into ONE
 *                  sentinel fallback group (stageId "setup" / "pre-stage").
 *   SCENARIO-008 — an empty transcript yields an empty partition `[]`.
 *   SCENARIO-009 — each group's `status` is resolved from the injected
 *                  `statusOf` lookup where present, `undefined` otherwise.
 *
 * The module this imports does NOT exist yet (RED). Implementation lands in
 * the subsequent GREEN commit.
 */
import { describe, it, expect } from "vitest";

import { groupByStage } from "../src/render/stage-grouping.js";
import type { StageGroup } from "../src/render/stage-grouping.js";
import type { LineKind } from "../src/render/stream-theme.js";

/**
 * Permissive input shape mirroring the (widened) Phase-1 `TranscriptLine` AND
 * the legacy shapes `groupByStage` must tolerate:
 *   - fully tagged objects (`{kind,text,stageId,stageLabel}`)
 *   - partially tagged objects (`stageId?` / `stageLabel?` absent)
 *   - plain legacy strings
 */
type RawEntry =
	| { kind: LineKind; text: string; stageId: string; stageLabel: string }
	| { kind: LineKind; text: string; stageId?: string; stageLabel?: string }
	| string;

/** Build a fully-tagged entry. */
function ln(
	stageId: string,
	stageLabel: string,
	kind: LineKind,
	text: string,
): { kind: LineKind; text: string; stageId: string; stageLabel: string } {
	return { kind, text, stageId, stageLabel };
}

/** Build an UNTAGGED entry (no stageId / stageLabel — legacy object shape). */
function untagged(kind: LineKind, text: string): {
	kind: LineKind;
	text: string;
} {
	return { kind, text };
}

describe("groupByStage — SCENARIO-005: first-appearance order", () => {
	it("emits one group per stage in first-appearance order", () => {
		const transcript: RawEntry[] = [
			ln("research", "Stage 1 — Research", "phase", "▶ Stage 1 — Research"),
			ln("research", "Stage 1 — Research", "log", "searching docs"),
			ln("implementation", "Stage 9 — Implementation", "phase", "▶ Stage 9 — Implementation"),
			ln("implementation", "Stage 9 — Implementation", "log", "writing code"),
		];

		const groups = groupByStage(transcript);

		expect(groups).toHaveLength(2);
		expect(groups[0].stageId).toBe("research");
		expect(groups[0].stageLabel).toBe("Stage 1 — Research");
		expect(groups[1].stageId).toBe("implementation");
		expect(groups[1].stageLabel).toBe("Stage 9 — Implementation");
	});

	it("coalesces later appearances of an earlier stage into that stage's group", () => {
		// stageA ... stageB ... stageA again → only TWO groups, stageA's group
		// holds BOTH stageA batches in original relative order.
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "a1"),
			ln("b", "B", "log", "b1"),
			ln("a", "A", "log", "a2"),
		];

		const groups = groupByStage(transcript);

		expect(groups).toHaveLength(2);
		expect(groups[0].stageId).toBe("a");
		expect(groups[1].stageId).toBe("b");
		expect(groups[0].lines.map((l) => l.text)).toEqual(["a1", "a2"]);
		expect(groups[1].lines.map((l) => l.text)).toEqual(["b1"]);
	});

	it("keeps each stage's lines in their original relative order", () => {
		const transcript: RawEntry[] = [
			ln("s", "S", "phase", "banner"),
			ln("s", "S", "command", "$ run"),
			ln("s", "S", "log", "out"),
			ln("s", "S", "thinking", "hmm"),
		];

		const [group] = groupByStage(transcript);

		expect(group.lines.map((l) => l.kind)).toEqual([
			"phase",
			"command",
			"log",
			"thinking",
		]);
		expect(group.lines.map((l) => l.text)).toEqual([
			"banner",
			"$ run",
			"out",
			"hmm",
		]);
	});

	it("strips the stage tag from every emitted line (callers consume {kind,text} only)", () => {
		const transcript: RawEntry[] = [
			ln("x", "X", "log", "one"),
			ln("x", "X", "log", "two"),
		];

		const [group] = groupByStage(transcript);

		for (const line of group.lines) {
			expect(Object.keys(line).sort()).toEqual(["kind", "text"]);
			expect(line).not.toHaveProperty("stageId");
			expect(line).not.toHaveProperty("stageLabel");
		}
	});

	it("conserves every entry exactly once across the partition (no loss / duplication)", () => {
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "a1"),
			ln("b", "B", "log", "b1"),
			ln("a", "A", "log", "a2"),
			ln("c", "C", "log", "c1"),
			ln("b", "B", "log", "b2"),
		];

		const groups = groupByStage(transcript);
		const flat = groups.flatMap((g) => g.lines.map((l) => l.text));

		// SCENARIO-005 mandates first-appearance coalescing (see the
		// "coalesces later appearances" case above): stage `a` reappears after
		// `b`, so its lines [a1, a2] collapse into `a`'s single group; likewise
		// `b` reappears after `c`, so [b1, b2] collapse into `b`'s group. The
		// partition therefore reproduces every entry exactly once in
		// first-appearance GROUP order (a:[a1,a2], b:[b1,b2], c:[c1]) — NOT the
		// raw input interleaving. The intent of this assertion is no-loss /
		// no-duplication: the same 5 entries survive, length-invariant.
		expect(flat).toEqual(["a1", "a2", "b1", "b2", "c1"]);
		expect(flat).toHaveLength(transcript.length);
		// Every original entry is present exactly once (set conservation).
		expect(flat.sort()).toEqual(["a1", "a2", "b1", "b2", "c1"]);
	});
});

describe("groupByStage — SCENARIO-006: all-one-stage yields a single group", () => {
	it("returns exactly one group when every entry shares one stage", () => {
		const transcript: RawEntry[] = [
			ln("analysis", "Stage 5 — Analysis", "phase", "▶ Stage 5 — Analysis"),
			ln("analysis", "Stage 5 — Analysis", "log", "step 1"),
			ln("analysis", "Stage 5 — Analysis", "log", "step 2"),
		];

		const groups = groupByStage(transcript);

		expect(groups).toHaveLength(1);
		expect(groups[0].stageId).toBe("analysis");
		expect(groups[0].stageLabel).toBe("Stage 5 — Analysis");
		expect(groups[0].lines).toHaveLength(3);
	});

	it("preserves order and shape for a single-stage transcript", () => {
		const transcript: RawEntry[] = [
			ln("only", "Only", "command", "$ build"),
			ln("only", "Only", "log", "compiling"),
			ln("only", "Only", "log-success", "done"),
		];

		const [group] = groupByStage(transcript);

		expect(group.lines).toEqual([
			{ kind: "command", text: "$ build" },
			{ kind: "log", text: "compiling" },
			{ kind: "log-success", text: "done" },
		]);
	});
});

describe("groupByStage — SCENARIO-007: untagged / legacy entries collapse to one sentinel", () => {
	it("coalesces plain-string legacy entries into a single fallback group", () => {
		const transcript: RawEntry[] = [
			"legacy line one",
			"legacy line two",
		];

		const groups = groupByStage(transcript);

		expect(groups).toHaveLength(1);
		expect(groups[0].stageId).toBe("setup");
		expect(groups[0].stageLabel).toBe("pre-stage");
	});

	it("coalesces objects missing stageId/stageLabel into the same fallback group", () => {
		const transcript: RawEntry[] = [
			untagged("log", "no stage tag here"),
			untagged("log", "nor here"),
		];

		const groups = groupByStage(transcript);

		expect(groups).toHaveLength(1);
		expect(groups[0].stageId).toBe("setup");
		expect(groups[0].stageLabel).toBe("pre-stage");
		expect(groups[0].lines).toHaveLength(2);
	});

	it("merges a MIX of plain strings and untagged objects into ONE sentinel group", () => {
		const transcript: RawEntry[] = [
			"string one",
			untagged("log", "object one"),
			"string two",
		];

		const groups = groupByStage(transcript);

		expect(groups).toHaveLength(1);
		expect(groups[0].stageId).toBe("setup");
		expect(groups[0].stageLabel).toBe("pre-stage");
		// All three legacy entries are conserved inside the sentinel group.
		expect(groups[0].lines).toHaveLength(3);
	});

	it("renders plain-string entries as {kind,text} lines (default kind, raw text)", () => {
		const transcript: RawEntry[] = ["raw legacy text"];

		const [group] = groupByStage(transcript);

		expect(group.lines).toHaveLength(1);
		expect(group.lines[0]).toHaveProperty("text", "raw legacy text");
		expect(group.lines[0]).toHaveProperty("kind");
		expect(Object.keys(group.lines[0]).sort()).toEqual(["kind", "text"]);
	});

	it("collapses ALL untagged entries into a single group even when interspersed with stages", () => {
		// Untagged entries appear before, between, AND after tagged stages — they
		// must still collapse into exactly ONE sentinel group (SCENARIO-007).
		const transcript: RawEntry[] = [
			"leading legacy",
			untagged("log", "leading obj"),
			ln("a", "A", "log", "a1"),
			"middle legacy",
			ln("b", "B", "log", "b1"),
			"trailing legacy",
		];

		const groups = groupByStage(transcript);

		const sentinels = groups.filter((g) => g.stageId === "setup");
		expect(sentinels).toHaveLength(1);
		expect(sentinels[0].stageLabel).toBe("pre-stage");
		// Every legacy entry is collected into that one sentinel group.
		expect(sentinels[0].lines).toHaveLength(4);
		// The two tagged stages remain as their own groups.
		expect(groups.map((g) => g.stageId).filter((id) => id !== "setup")).toEqual([
			"a",
			"b",
		]);
	});
});

describe("groupByStage — SCENARIO-008: empty transcript yields []", () => {
	it("returns [] for an empty array", () => {
		expect(groupByStage([])).toEqual([]);
	});

	it("returns [] (not a sentinel group) for empty input even with a statusOf lookup", () => {
		expect(groupByStage([], () => "ok")).toEqual([]);
	});
});

describe("groupByStage — SCENARIO-009: status resolved from injected lookup", () => {
	it("resolves status from statusOf(stageId) where the tracker has an entry", () => {
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "a"),
			ln("b", "B", "log", "b"),
			ln("c", "C", "log", "c"),
		];
		const statusOf = (id: string): string | undefined => {
			if (id === "a") return "ok";
			if (id === "b") return "failed";
			return undefined; // "c" has no tracker entry
		};

		const groups = groupByStage(transcript, statusOf);

		expect(groups[0].status).toBe("ok");
		expect(groups[1].status).toBe("failed");
		expect(groups[2].status).toBeUndefined();
	});

	it("leaves status undefined for every group when statusOf is not provided", () => {
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "a"),
			ln("b", "B", "log", "b"),
		];

		const groups = groupByStage(transcript);

		expect(groups.every((g) => g.status === undefined)).toBe(true);
	});

	it("leaves status undefined when statusOf returns undefined for a stage", () => {
		const transcript: RawEntry[] = [ln("mystery", "Mystery", "log", "x")];

		const [group] = groupByStage(transcript, () => undefined);

		expect(group.status).toBeUndefined();
	});

	it("resolves the sentinel group's status via statusOf('setup') when provided", () => {
		const transcript: RawEntry[] = ["legacy entry"];
		const statusOf = (id: string): string | undefined =>
			id === "setup" ? "skipped" : undefined;

		const [group] = groupByStage(transcript, statusOf);

		expect(group.stageId).toBe("setup");
		expect(group.status).toBe("skipped");
	});

	it("never calls statusOf for stages it has already resolved once per group", () => {
		// stage "a" appears twice → statusOf("a") must be consulted (at most)
		// and the SAME status applied to the single coalesced group.
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "a1"),
			ln("b", "B", "log", "b1"),
			ln("a", "A", "log", "a2"),
		];
		const calls: string[] = [];
		const statusOf = (id: string): string | undefined => {
			calls.push(id);
			return "ok";
		};

		const groups = groupByStage(transcript, statusOf);

		// Two groups (a, b) → statusOf called once per group, keyed by stageId.
		expect(groups.map((g) => g.stageId)).toEqual(["a", "b"]);
		expect(groups.map((g) => g.status)).toEqual(["ok", "ok"]);
		expect(calls).toEqual(["a", "b"]);
	});
});

describe("groupByStage — anti-hardcoding / generalization", () => {
	it("handles arbitrary stage ids / labels / texts (not just fixture values)", () => {
		const transcript: RawEntry[] = [
			ln("zzz-9", "Zenith", "phase", "p"),
			ln("zzz-9", "Zenith", "log", "x"),
			ln("aaa-0", "Alpha", "phase", "q"),
			ln("aaa-0", "Alpha", "log", "y"),
		];

		const groups = groupByStage(transcript);

		// first-appearance order preserved regardless of id lexicography
		expect(groups.map((g) => g.stageId)).toEqual(["zzz-9", "aaa-0"]);
		expect(groups[0].stageLabel).toBe("Zenith");
		expect(groups[1].stageLabel).toBe("Alpha");
		expect(groups[0].lines.map((l) => l.text)).toEqual(["p", "x"]);
		expect(groups[1].lines.map((l) => l.text)).toEqual(["q", "y"]);
	});

	it("every emitted group has the documented StageGroup shape", () => {
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "a"),
			"legacy",
			untagged("log", "u"),
		];

		const groups = groupByStage(transcript, (id) =>
			id === "a" ? "running" : undefined,
		);

		for (const g of groups) {
			expect(g).toHaveProperty("stageId");
			expect(g).toHaveProperty("stageLabel");
			expect(g).toHaveProperty("lines");
			expect(Array.isArray(g.lines)).toBe(true);
			// `status` is optional: present when resolved, otherwise absent/undefined.
			if (g.status !== undefined) {
				expect(typeof g.status).toBe("string");
			}
			for (const line of g.lines) {
				expect(Object.keys(line).sort()).toEqual(["kind", "text"]);
			}
		}
		expect(
			groups.find((g: StageGroup) => g.stageId === "a")?.status,
		).toBe("running");
	});

	it("is pure: the same input yields identical output across repeated calls", () => {
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "1"),
			ln("b", "B", "log", "2"),
		];
		const statusOf = (id: string) => (id === "a" ? "ok" : undefined);

		const first = groupByStage(transcript, statusOf);
		const second = groupByStage(transcript, statusOf);

		expect(second).toEqual(first);
	});

	it("does not mutate the input transcript", () => {
		const transcript: RawEntry[] = [
			ln("a", "A", "log", "1"),
			"legacy",
		];
		const snapshot = JSON.stringify(transcript);

		groupByStage(transcript);

		expect(JSON.stringify(transcript)).toBe(snapshot);
	});
});
