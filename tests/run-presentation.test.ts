import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSummary, formatDuration } from "../src/extension/run-presentation.ts";
import type { RunSummary } from "../src/types.ts";

function summary(over: Partial<RunSummary> = {}): RunSummary {
	return {
		status: "success",
		specIdentifier: "spec-01",
		worktreePath: "/tmp/wt",
		agentsSpawned: 7,
		failedStages: [],
		state: {
			implementation: { summary: "3/3 phases completed", totalPhases: 3, allGreen: true },
			review: { verdict: "Approved" },
			setup: { language: "typescript", isWebUi: false, defaultBranch: "main", worktreeCreated: true },
			classify: { taskType: "feature", uiScope: "app" },
			merge: { merged: true },
		},
		...over,
	} as unknown as RunSummary;
}

describe("extension/run-presentation — wave 3 (adversarial fold: the summary block rows, previously only smoke-pinned)", () => {
	afterEach(() => { delete process.env.SUPER_DEV_REPLAN_MANUAL; });

	it("the full success block: title, worktree (created) suffix, stack/classify/impl/review/merged rows", () => {
		const lines = formatSummary(summary(), "/tmp");
		expect(lines[0]).toBe("✅ super-dev pipeline complete");
		expect(lines.find((l) => l.startsWith("  Worktree:"))).toContain("(created)");
		expect(lines.find((l) => l.startsWith("  Stack:"))).toContain("typescript | branch main");
		expect(lines.find((l) => l.startsWith("  Classify:"))).toContain("feature | app");
		expect(lines.find((l) => l.startsWith("  Impl:"))).toContain("3/3 phases completed");
		expect(lines.find((l) => l.startsWith("  Review:"))).toContain("Approved");
		expect(lines.find((l) => l.startsWith("  Merged:"))).toContain("true");
		// in-place (no worktreeCreated) flips the suffix
		const inPlace = formatSummary(summary({ state: { ...summary().state, setup: { language: "typescript" } } as never }), "/tmp");
		expect(inPlace.find((l: string) => l.startsWith("  Worktree:"))).toContain("(in-place)");
	});

	it("the failed-stage fan: label — error with the 12-space continuation join", () => {
		const lines = formatSummary(summary({ status: "failed", failedStages: [
			{ label: "specification", error: "gate rejected" },
			{ label: "implementation" },
		] }));
		expect(lines.find((l) => l.startsWith("  Failed:"))).toBe("  Failed:   specification — gate rejected\n            implementation");
	});

	it("the replan line under BOTH env polarities (the only visible autoResumeEnabled effect)", () => {
		const state = { ...summary().state, __replan: { rounds: 2, owners: ["requirements"], newRequests: 3, invalidationSet: ["specification", "design"] } } as never;
		const auto = formatSummary(summary({ status: "replan", state }));
		expect(auto.find((l: string) => l.includes("Replan round"))).toContain("auto-resuming");
		process.env.SUPER_DEV_REPLAN_MANUAL = "1";
		const manual = formatSummary(summary({ status: "replan", state }));
		expect(manual.find((l: string) => l.includes("Replan round"))).toContain("manual resume required (SUPER_DEV_REPLAN_MANUAL=1)");
	});

	it("the stagnation lines are kind-specific (the F-C misdiagnosis guard surfaced)", () => {
		const blocked = formatSummary(summary({ state: { ...summary().state, __stagnated: { rounds: 4, kind: "blocked-on-decisions" } } as never }));
		expect(blocked.find((l: string) => l.includes("Verify-loop"))).toContain("blocked on decisions after 4 round(s)");
		const stagnant = formatSummary(summary({ state: { ...summary().state, __stagnated: { rounds: 2, kind: "stagnation" } } as never }));
		expect(stagnant.find((l: string) => l.includes("Verify-loop"))).toContain("stagnant after 2 round(s)");
		expect(stagnant.find((l: string) => l.includes("Verify-loop"))).not.toContain("blocked");
	});
});

describe("formatDuration — the ms/s/m-s ladder", () => {
	it("renders each tier with its exact format", () => {
		expect(formatDuration(Number.NaN)).toBe("unknown");
		expect(formatDuration(-1)).toBe("unknown");
		expect(formatDuration(950)).toBe("950ms");
		expect(formatDuration(4_300)).toBe("4.3s");
		expect(formatDuration(43_000)).toBe("43s");
		expect(formatDuration(125_000)).toBe("2m 5s");
	});
});
