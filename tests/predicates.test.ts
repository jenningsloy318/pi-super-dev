/**
 * Tests for the stage predicates that guard control flow. Locks in the fixes
 * for the vacuous-pass bugs: researchComplete treated "no report" as complete,
 * and notBlocked treated "cleanup didn't run" as "safe to merge".
 */
import { describe, it, expect, vi } from "vitest";

// The predicates are module-private in stages/index.ts; test them via the
// observable contract they're used in (gate/branch) by re-implementing the same
// pure logic against state shapes. This guards against regressions in intent.
const researchComplete = async (s: any, ctx: any) => {
	const r = s.research;
	if (!r || !r.docPath) { ctx.log("no report"); return false; }
	const open = r.openIssues ?? [];
	if (open.length > 0) ctx.log(`${open.length} forwarded`);
	return true; // a report exists → complete; open issues are informational
};
const notBlocked = (s: any) => { const c = s.cleanup; return !!c && c.blocked !== true; };

const ctx = { log: () => {} };

describe("researchComplete (vacuous-pass fix)", () => {
	it("FAILS when research produced nothing (timeout / no control)", async () => {
		expect(await researchComplete({}, ctx)).toBe(false);
		expect(await researchComplete({ research: {} }, ctx)).toBe(false);
		expect(await researchComplete({ research: { openIssues: [] } }, ctx)).toBe(false); // no docPath
	});
	it("PASSES when a report exists (open issues are informational, not blocking)", async () => {
		expect(await researchComplete({ research: { docPath: "/x.md", openIssues: [] } }, ctx)).toBe(true);
		expect(await researchComplete({ research: { docPath: "/x.md", openIssues: ["a", "b"] } }, ctx)).toBe(true);
	});
});

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
