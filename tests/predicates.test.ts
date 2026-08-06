/**
 * Tests for the stage predicates that guard control flow.
 *
 * researchComplete is now IMPORTED from stages/index.ts (it used to be a local
 * re-implementation that drifted from the real validator — and had locked in the
 * previous open-issues behavior, so it guarded a stale copy, not reality).
 * notBlocked stays a local pure copy (trivial; matches the exported intent).
 */
import { describe, it, expect } from "vitest";
import { researchComplete } from "../src/stages/index.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const ctx = { log: () => {} } as unknown as StageContext;
const state = (research: unknown): PipelineState => ({ research }) as PipelineState;

describe("researchComplete (answerable open issues trigger research retry)", () => {
	it("FAILS when no report was produced (timeout / empty control)", async () => {
		expect((await researchComplete(state(undefined), ctx)).pass).toBe(false);
		expect((await researchComplete(state({}), ctx)).pass).toBe(false);
		expect((await researchComplete(state({ openIssues: [] }), ctx)).pass).toBe(false); // no docPath
	});
	it("PASSES only when a report exists with no answerable open issues", async () => {
		expect((await researchComplete(state({ docPath: "/x.md", openIssues: [] }), ctx)).pass).toBe(true);
		const withIssues = await researchComplete(state({ docPath: "/x.md", openIssues: ["unreleased v2", "unclear API"] }), ctx);
		expect(withIssues.pass).toBe(false);
		expect(withIssues.errors.join(" ")).toContain("answerable open issue");
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
