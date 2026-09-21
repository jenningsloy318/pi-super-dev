/**
 * WS0 (066 §2) — the economy-metrics derivation, L0 pins on REAL run-log
 * line shapes (from run 2026-09-20T07-37-57-688Z).
 */

import { describe, it, expect } from "vitest";
import { economyMetricsFromLog, economyMetricsSummary } from "../src/convergence-economy/economy-metrics.ts";

const LINES = [
	"[2026-09-20T15:38:17.916+08:00] Stage end: Stage 2A — Classify Task status=ok",
	"[2026-09-20T16:19:48.692+08:00] delegation requirements-clarifier: completed status=completed model=zai-coding-cn/glm-5.3-flash:high turns=17 tools=29 tokens=82611/19745 cache=1084736/0 $0.0548 duration=530.7s",
	"[2026-09-20T16:10:57.497+08:00] delegation requirements-reviewer: completed status=completed model=zai-coding-cn/glm-5.3-flash:high turns=16 tools=32 tokens=120869/39501 cache=1162432/0 $0.0728 duration=1047.9s",
	"[2026-09-20T16:38:44.013+08:00] delegation bdd-scenario-writer: completed status=completed model=zai-coding-cn/glm-5.3:max turns=4 tools=10 tokens=88250/42929 cache=198016/0 $0.3639 duration=624.0s",
	"[2026-09-20T16:55:20.194+08:00] delegation bdd-reviewer: completed status=completed model=zai-coding-cn/glm-5.3-flash:high turns=21 tools=34 tokens=146421/36921 cache=2009472/0 $0.1007 duration=995.3s",
	"[2026-09-20T22:49:38.762+08:00] delegation spec-reviewer: terminal status=failed model=zai-coding-cn/glm-5.3-flash:high turns=56 tools=56 tokens=151223/25847 cache=5842240/0 $0.2109 duration=797.9s",
	"[2026-09-20T21:51:58.032+08:00] spec convergence: contract-validator (advisory): bdd SCENARIO-054 pinOwnership cites unknown pinId pin-pe-11tb30l",
	"[2026-09-20T22:15:00.000+08:00] bdd convergence: finding-resolution bounce: 2 injected blocking finding(s) have no resolution row — one bounded writer re-dispatch follows (agent budget, not a convergence round)",
	"[2026-09-21T07:54:00.117+08:00] requirements convergence: coverage bounce: 27 injected blocking finding(s) have no resolution row — one bounded writer re-dispatch follows (agent budget, not a convergence round)",
	"[2026-09-20T22:16:00.000+08:00] spec convergence: validator bounce — 3 designated violation(s): one bounded writer re-dispatch follows (agent budget, not a convergence round)",
	"[2026-09-20T16:38:44.316+08:00] BDD contract-validator (advisory): bdd: 36 further pin(s) on the touched surfaces exceed the injected slice cap",
	"[2026-09-20T16:28:19.479+08:00] requirements convergence: ✓ review approved round 2",
	"[2026-09-20T17:20:07.146+08:00] requirements convergence: ✓ review approved round 1",
];

describe("economyMetricsFromLog", () => {
	it("counts writer attempts, review passes, and wall-clock from real delegation lines", () => {
		const m = economyMetricsFromLog(LINES);
		const req = m.roles.find((r) => r.role === "requirements-clarifier")!;
		expect(req.writerAttempts).toBe(1);
		expect(req.writerMs).toBe(530700);
		const rev = m.roles.find((r) => r.role === "requirements-reviewer")!;
		expect(rev.reviewPasses).toBe(1);
		expect(rev.reviewMs).toBe(1047900);
	});
	it("FAILED reviewer terminals still count as review passes (the verification cost was paid)", () => {
		const m = economyMetricsFromLog(LINES);
		const spec = m.roles.find((r) => r.role === "spec-reviewer")!;
		expect(spec.reviewPasses).toBe(1);
	});
	it("bounces attribute to their stage's writer role (all four bounce wordings)", () => {
		const m = economyMetricsFromLog(LINES);
		expect(m.roles.find((r) => r.role === "bdd-scenario-writer")?.bounces).toBe(1);
		expect(m.roles.find((r) => r.role === "spec-writer")?.bounces).toBe(1);
		expect(m.roles.find((r) => r.role === "requirements-clarifier")?.bounces).toBe(1);
	});
	it("ordinary advisory lines and stage lines are neither attempts nor bounces", () => {
		const m = economyMetricsFromLog(LINES);
		const totalBounces = m.roles.reduce((n, r) => n + r.bounces, 0);
		expect(totalBounces).toBe(3);
	});
	it("never throws on garbage; malformed delegation durations count unparseable", () => {
		const m = economyMetricsFromLog(["", "noise", "delegation x: completed duration=abc", "delegation y: completed duration=-5s"]);
		expect(m.roles.length).toBe(0);
		expect(m.unparseable).toBe(2);
	});
});

describe("economyMetricsSummary (operator line)", () => {
	it("names the numbers without inflation — real first-pass acceptance from approval rounds", () => {
		const m = economyMetricsFromLog(LINES);
		expect(m.firstPassApprovals).toBe(1);
		expect(m.reviewedWalks).toBe(2);
		const s = economyMetricsSummary(m);
		expect(s).toContain("2 writer attempts");
		expect(s).toContain("3 review passes");
		expect(s).toContain("3 pre-review bounce(s)");
		expect(s).toContain("first-pass acceptance 1/2 (~50%)");
	});
});

describe("usage-report wiring (WS0): the economy line rides writeUsageArtifacts", () => {
	it("runLogLines present → the summary line is logged; absent → no line, no fabrication", async () => {
		const { writeUsageArtifacts } = await import("../src/evolution/usage-report.ts");
		const lines: string[] = [];
		const base: import("../src/evolution/usage-report.ts").UsageReportInput = { runId: "r", status: "partial", wallMs: 1000, usage: { totals: { calls: 1, input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 } } as import("../src/types.ts").UsageAccumulator, calls: [{ stage: "x", model: "m", durationMs: 5 } as never] };
		writeUsageArtifacts(undefined, { ...base, runLogLines: LINES }, (m) => lines.push(m));
		expect(lines.some((l) => l.startsWith("economy:"))).toBe(true);
		const lines2: string[] = [];
		writeUsageArtifacts(undefined, { ...base }, (m) => lines2.push(m));
		expect(lines2.some((l) => l.startsWith("economy:"))).toBe(false);
	});
});
