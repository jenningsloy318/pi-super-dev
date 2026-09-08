/**
 * v0.3.79 Wave A3 — stagnation routes by finding class
 * (spec-25: runs 00-49/13-23/13-43 stopped PARTIAL with "3 recurring
 * blockers" where ALL recurring blockers were "Code/Adversarial/Tests review
 * did not complete" — reviewer infra non-completion masquerading as content
 * stagnation; 18 fix cycles were burned on them).
 *
 * New contract:
 *  - reviewer infra non-completion findings (failedReviewControl marks
 *    infra: true; title suffix "did not complete" as defensive fallback)
 *    NEVER count toward the stagnation decision;
 *  - if recurring blockers are ALL infra → no stagnation stop (log names it);
 *  - a genuine content stagnation stop first asks the judge ONCE whether the
 *    blockers are within this stage's authority or require replan-upstream
 *    (allowedRoutes: replan-upstream; escalate-now implied) — a routed
 *    replan-upstream triggers triggerReplanForFindings instead of a
 *    human-decision PARTIAL stop.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const judgeMock = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, route: "escalate-now" as string }));
vi.mock("../src/stages/judge.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/stages/judge.ts")>();
	return {
		...actual,
		runJudge: vi.fn(async (_ctx: unknown, r: { scope: string; allowedRoutes: readonly string[] }) => {
			judgeMock.calls.push({ scope: r.scope, allowedRoutes: [...r.allowedRoutes] });
			return {
				status: "routed",
				verdict: {
					diagnosis: "these blockers require plan revision, not stage-local fixes",
					route: judgeMock.route,
					confidence: 0.9,
					evidence: [],
				},
			};
		}),
	};
});

import { recordVerificationStagnation } from "../src/stages/verify.ts";
import type { PipelineState, StageContext } from "../src/types.ts";

const specDir = () => mkdtempSync(join(tmpdir(), "sd-vstagn-"));

const ctx = (logs: string[]): StageContext =>
	({ log: (m: string) => logs.push(m), task: "", options: {}, state: {} as PipelineState }) as unknown as StageContext;

const infraFinding = (kind: string) => ({
	id: `${kind}-agent-failed`,
	severity: "high",
	title: `${kind === "codeReview" ? "Code" : kind === "testsReview" ? "Tests" : "Adversarial"} review did not complete`,
	detail: "agent failed",
	infra: true,
});
const contentFinding = () => ({ id: "R-1", severity: "high", title: "earlyBird has no behavioral assertion", detail: "d", file: "src/early.ts", ownerStage: "spec" });

const mkState = (findings: Array<Record<string, unknown>>, setup?: { specDirectory: string }): PipelineState =>
	({
		review: { findings },
		integration: { status: "passed" }, // isolate review findings (a non-passed status adds a legitimate content item)
		setup: setup ?? undefined,
		__lastVerificationFix: { kind: "review", changed: true },
	}) as unknown as PipelineState;



describe("v0.3.79 A3 stagnation finding-class routing", () => {
	let dir: string;
	beforeEach(() => {
		dir = specDir();
		judgeMock.calls.length = 0;
		judgeMock.route = "escalate-now";
	});

	it("ALL-infra recurring blockers never arm the stagnation stop (spec-25: 'review did not complete' ×3 was not content stagnation)", async () => {
		const logs: string[] = [];
		const s = mkState([infraFinding("codeReview"), infraFinding("adversarialReview"), infraFinding("testsReview")]);
		const stopped = await threeRoundsAndStop(s, ctx(logs));
		expect(stopped).toBe(false);
		expect(logs.join("\n").toLowerCase()).toContain("infra");
	});

	it("content recurring blockers still stop (regression pin) and the stop adjudicates replan-upstream via the judge exactly once", async () => {
		const logs: string[] = [];
		const s = mkState([contentFinding()], { specDirectory: dir });
		const stopped = await threeRoundsAndStop(s, ctx(logs));
		expect(stopped).toBe(true);
		expect(judgeMock.calls).toHaveLength(1);
		expect(judgeMock.calls[0]?.scope).toContain("stagnation");
		expect((judgeMock.calls[0]?.allowedRoutes as string[])).toContain("replan-upstream");
	});

	it("judge replan-upstream verdict triggers triggerReplanForFindings (__replan set) — the stop becomes a REPLAN, not a human PARTIAL", async () => {
		judgeMock.route = "replan-upstream";
		const logs: string[] = [];
		const s = mkState(
			[
				contentFinding(),
				// ownerStage pinned so the replan router routes deterministically
				{ ...contentFinding(), id: "R-2", ownerStage: "spec", file: "docs/specifications/25-catalyst.md" },
			],
			{ specDirectory: dir },
		);
		const stopped = await threeRoundsAndStop(s, ctx(logs));
		expect(stopped).toBe(true);
		expect(Boolean((s as Record<string, unknown>).__replan)).toBe(true);
		expect(logs.join("\n")).toContain("REPLAN");
		// the replan request was persisted
		const requestsPath = join(dir, "replan-requests.json");
		expect(existsSync(requestsPath)).toBe(true);
	});

	it("mixed content+infra: the stagnation decision keys on content only; infra items are tallied, not counted", async () => {
		judgeMock.route = "escalate-now";
		const logs: string[] = [];
		const s = mkState([contentFinding(), infraFinding("codeReview")], { specDirectory: dir });
		const stopped = await threeRoundsAndStop(s, ctx(logs));
		expect(stopped).toBe(true);
		const record = (s as Record<string, unknown>).__verificationStagnated as { infraNonCompletions?: number; recurringBlockers?: unknown[] };
		expect(record).toBeDefined();
		expect(record.infraNonCompletions).toBe(1);
		// only the content finding is a recurring blocker
		expect(record.recurringBlockers).toHaveLength(1);
	});

	it("ADV-v0379-3: 3 consecutive ALL-infra rounds stop for the human with the infra tally (retrying reviews does not repair infra)", async () => {
		const logs: string[] = [];
		const s = mkState([infraFinding("codeReview")]);
		let stops = 0;
		for (const attempt of [1, 2, 3, 4]) {
			if (await recordVerificationStagnation(s, ctx(logs), { attempt, failureSignature: "sig-x" } as never)) stops++;
		}
		expect(stops).toBe(1); // armed exactly at round 3, not before
		const record = (s as Record<string, unknown>).__verificationStagnated as { infraOnlyStop?: boolean; infraNonCompletions?: number };
		expect(record.infraOnlyStop).toBe(true);
		expect(record.infraNonCompletions).toBe(1);
		expect(logs.join("\n")).toContain("does not repair");
	});

	it("defensive fallback: a 'did not complete' title WITHOUT the infra flag (older rows / resume reconstruction) is still classified infra", async () => {
		const logs: string[] = [];
		const s = mkState([{ id: "codeReview-agent-failed", severity: "high", title: "Code review did not complete", detail: "x" }]);
		const stopped = await threeRoundsAndStop(s, ctx(logs));
		expect(stopped).toBe(false);
	});
});

async function threeRoundsAndStop(s: PipelineState, c: StageContext): Promise<boolean> {
	let stopped = false;
	for (const attempt of [1, 2, 3]) {
		if (await recordVerificationStagnation(s, c, { attempt, failureSignature: "sig-x" } as never)) stopped = true;
	}
	return stopped;
}
