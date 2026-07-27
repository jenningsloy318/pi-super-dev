/**
 * Tests for the stage predicates that guard control flow.
 *
 * researchComplete is now IMPORTED from stages/index.ts (it used to be a local
 * re-implementation that drifted from the real validator — and had locked in the
 * BUGGY "open issues => fail" behavior, so it guarded a stale copy, not reality).
 * notBlocked stays a local pure copy (trivial; matches the exported intent).
 */
import { describe, it, expect } from "vitest";
import { researchComplete } from "../src/stages/index.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const ctx = { log: () => {} } as unknown as StageContext;
const state = (research: unknown): PipelineState => ({ research }) as PipelineState;

describe("researchComplete (open issues are signal, not a blocker)", () => {
	it("FAILS only when no report was produced (timeout / empty control)", async () => {
		expect((await researchComplete(state(undefined), ctx)).pass).toBe(false);
		expect((await researchComplete(state({}), ctx)).pass).toBe(false);
		expect((await researchComplete(state({ openIssues: [] }), ctx)).pass).toBe(false); // no docPath
	});
	it("PASSES when a report exists, even WITH open issues (they flow forward as signal)", async () => {
		// The ROOT-CAUSE fix: an honest research agent that flags a genuine open
		// question (e.g. an unreleased library version) must NOT fail the gate.
		// Previously openIssues.length > 0 => fail => 4-attempt exhaustion.
		expect((await researchComplete(state({ docPath: "/x.md", openIssues: [] }), ctx)).pass).toBe(true);
		expect((await researchComplete(state({ docPath: "/x.md", openIssues: ["unreleased v2", "unclear API"] }), ctx)).pass).toBe(true);
	});
});

// notBlocked: local pure copy (mirrors the exported predicate's intent).
const notBlocked = (s: any) => { const c = s.cleanup; return !!c && c.blocked !== true; };

describe("notBlocked (vacuous-pass fix)", () => {
	it("does NOT merge when cleanup produced nothing", () => {
		expect(notBlocked({})).toBe(false);
		expect(notBlocked({ cleanup: undefined })).toBe(false);
	});
	it("merges when cleanup ran and found nothing blocking", () => {
		expect(notBlocked({ cleanup: { blocked: false } })).toBe(true);
	});
	it("does NOT merge when cleanup found sensitive data", () => {
		expect(notBlocked({ cleanup: { blocked: true } })).toBe(false);
	});
});
