import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupControl } from "../src/types.ts";

/**
 * v0.3.73 — M2 tests-review render, M3 close-on-success, M4 reviewer timeout
 * tier, M6 runtime-evidence basenames, M7 no-self-commit policy. Source-contract
 * + unit tests over the seams (behavior suites live in their stage harnesses).
 */

const src = (rel: string): string => readFileSync(join(import.meta.dirname, rel), "utf8");

describe("v0.3.73 M2 — tests-review artifact is rendered", () => {
	it("STAGE_MODELS carries a testsReview render model", async () => {
		const { STAGE_MODELS } = await import("../src/render/schemas.ts");
		const m = STAGE_MODELS.testsReview;
		expect(m, "testsReview render model must exist").toBeDefined();
		expect(m!.slug).toBe("tests-review");
		expect(m!.template).toBe("code-review.md.njk");
	});

	it("the testsReview verify task calls renderAndWrite (source contract)", () => {
		const verify = src("../src/stages/verify.ts");
		const taskStart = verify.indexOf('id: "testsReview"');
		expect(taskStart).toBeGreaterThan(-1);
		// v0.3.73 dual review CR-73-02: EXACT-call anchor — the previous slice ran
		// to a `return r.error` literal that no longer exists, so the window spanned
		// to EOF and unrelated renderAndWrite calls satisfied the assertion (false
		// green: deleting the testsReview call kept the test passing).
		expect(verify).toContain('renderAndWrite(s.setup!, (m) => ctx.log(m), "testsReview", control)');
	});
});

describe("v0.3.73 M3 — agent-failed findings close on later review success", () => {
	it("a successful review control closes its kind's agent-failed ledger rows", async () => {
		const { recordConvergenceFindings, closeAgentFailedFindings } = await import("../src/convergence-ledger.ts");
		const state: Record<string, unknown> = {};
		recordConvergenceFindings(state as never, {
			id: "codeReview-agent-failed",
			title: "Code review did not complete",
			severity: "high",
			blocking: true,
			status: "open",
		}, { detectedAtStage: "verify" });
		closeAgentFailedFindings(state as never, "codeReview", "review recovered after agent failure");
		const rows = ((state.__convergenceLedger as { findings: Array<{ id: string; status: string; blocking: boolean }> }).findings);
		const row = rows.find((r) => r.id === "codeReview-agent-failed")!;
		expect(row.status).toBe("verified");
		expect(row.blocking).toBe(false);
	});

	it("closing a kind with no failed rows is a no-op", async () => {
		const { closeAgentFailedFindings } = await import("../src/convergence-ledger.ts");
		const state: { convergenceLedger?: { findings: unknown[] } } = {};
		expect(() => closeAgentFailedFindings(state as never, "testsReview", "round 1")).not.toThrow();
	});

	it("verify.ts closes on successful controls for all three kinds (source contract)", () => {
		const verify = src("../src/stages/verify.ts");
		expect(verify).toContain("closeAgentFailedFindings");
	});

	it("closure notes are engine-authored bounded constants — no agent verdict text in the duty-prefixed downgradeReason (AR-73-03)", () => {
		const verify = src("../src/stages/verify.ts");
		const calls = verify.match(/closeAgentFailedFindings\(s, "[a-zA-Z]+", [^\n]+\)/g) ?? [];
		expect(calls.length).toBe(3);
		for (const call of calls) {
			expect(call).not.toContain("${"); // no template interpolation of agent text
			expect(call).toContain('"review recovered after agent failure"');
		}
	});

	it("closing rows persists the ledger — a mid-round crash cannot resurrect the phantom (CR-73-01)", async () => {
		const { recordConvergenceFindings, closeAgentFailedFindings, CONVERGENCE_LEDGER_FILE } = await import("../src/convergence-ledger.ts");
		const specDir = mkdtempSync(join(tmpdir(), "ledger-close-"));
		writeFileSync(join(specDir, ".task"), "task-anchor", "utf8");
		const state: Record<string, unknown> = { setup: { specDirectory: specDir } };
		recordConvergenceFindings(state as never, { id: "codeReview-agent-failed", title: "x", severity: "high", blocking: true, status: "open" }, { detectedAtStage: "verify" });
		closeAgentFailedFindings(state as never, "codeReview", "review recovered after agent failure");
		const persisted = JSON.parse(readFileSync(join(specDir, CONVERGENCE_LEDGER_FILE), "utf8")) as { findings: Array<{ id: string; status: string; blocking: boolean }> };
		const row = persisted.findings.find((f) => f.id === "codeReview-agent-failed");
		expect(row?.status).toBe("verified");
		expect(row?.blocking).toBe(false);
		rmSync(specDir, { recursive: true, force: true });
	});

	it("closing a kind with no failed rows persists nothing (no-op stays a no-op)", async () => {
		const { closeAgentFailedFindings, CONVERGENCE_LEDGER_FILE } = await import("../src/convergence-ledger.ts");
		const specDir = mkdtempSync(join(tmpdir(), "ledger-noop-"));
		writeFileSync(join(specDir, ".task"), "task-anchor", "utf8");
		const state: Record<string, unknown> = { setup: { specDirectory: specDir }, __convergenceLedger: { version: 1, findings: [] } };
		closeAgentFailedFindings(state as never, "testsReview", "note");
		expect(existsSync(join(specDir, CONVERGENCE_LEDGER_FILE))).toBe(false);
		rmSync(specDir, { recursive: true, force: true });
	});
});

describe("v0.3.73 M4 — reviewer roles get the 30-minute timeout tier", () => {
	it("every reviewer role resolves to 1_800_000ms", async () => {
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		for (const role of ["code-reviewer", "adversarial-reviewer", "spec-reviewer", "requirements-reviewer", "bdd-reviewer", "design-reviewer"]) {
			expect(defaultAgentTimeoutMs(role), role).toBe(1_800_000);
		}
	});

	it("non-review non-writing roles keep the 20-minute default", async () => {
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("task-classifier")).toBe(1_200_000);
	});
});

describe("v0.3.73 M6 — run bookkeeping files are runtime-allowed RED paths", () => {
	it("classifyObviousRedPath marks every run-owned ledger basename runtime/allowed", async () => {
		const { classifyObviousRedPath } = await import("../src/test-artifacts.ts");
		for (const base of [
			"events.jsonl",
			"run-metrics.jsonl",
			"audit.jsonl",
			"routing-journal.jsonl",
			"routing-epoch.json",
			"replan-requests.json",
			"artifact-revisions.json",
			"completion-audit.md",
		]) {
			const c = classifyObviousRedPath(`docs/specifications/24-x/${base}`);
			expect(c.category, base).toBe("runtime");
			expect(c.allowed, base).toBe(true);
		}
	});

	it("a production file with a similar name stays ambiguous (no over-broad basename match)", async () => {
		const { classifyObviousRedPath } = await import("../src/test-artifacts.ts");
		// The new M6 basenames are SPEC-SCOPED (position-aware, like
		// isHarnessBookkeepingPath): same basename outside the spec docs tree
		// stays ambiguous → the verify write-boundary still flags it.
		expect(classifyObviousRedPath("src/events.jsonl").category).toBe("ambiguous");
	});

	it("any 'specifications' path SEGMENT no longer exempts — the anchor is the docs/specifications/ PREFIX (CR-73-03/AR-73-02)", async () => {
		const { classifyObviousRedPath } = await import("../src/test-artifacts.ts");
		// Deterministic runtime/allowed verdicts bypass the LLM classifier and ride
		// the phase commit — a segment match would let a RED agent write
		// cross-run resume state (routing-epoch/replan-requests) under any
		// `specifications/` dir that walker/journal/setup later TRUST.
		expect(classifyObviousRedPath("src/specifications/events.jsonl").category).toBe("ambiguous");
		expect(classifyObviousRedPath("vendor/specifications/routing-epoch.json").category).toBe("ambiguous");
		expect(classifyObviousRedPath("libs/foo/specifications/replan-requests.json").category).toBe("ambiguous");
		// The real spec tree still passes.
		expect(classifyObviousRedPath("docs/specifications/24-x/events.jsonl").category).toBe("runtime");
		expect(classifyObviousRedPath("docs/specifications/24-x/routing-epoch.json").allowed).toBe(true);
	});
});

describe("v0.3.73 M7 — implementer self-commit prohibition + detector", () => {
	it("implementer and tdd-guide prompts forbid git commit (source contract)", () => {
		for (const f of ["../agents/implementer.md", "../agents/tdd-guide.md"]) {
			const p = src(f);
			expect(p.toLowerCase()).toMatch(/git commit/);
			expect(p).toMatch(/engine commits|deterministic\s+commit/i);
		}
	});

	it("implementation stage detects HEAD drift across the implementer call (source contract)", () => {
		const impl = src("../src/stages/implementation.ts");
		expect(impl).toContain("self-commit");
	});

	it("HEAD-drift detection brackets BOTH writer windows with pinned timeouts (AR-73-05)", () => {
		const impl = src("../src/stages/implementation.ts");
		// The implementer window…
		expect(impl).toContain("implementer self-commit detected");
		// …and the RED authoring (tdd-guide) window — the incident's 5d4790d was a
		// non-implementer-window self-commit shape.
		expect(impl).toContain("tdd-guide self-commit detected");
		// Every rev-parse capture pins a timeout (a wedged git must not stall the
		// pipeline thread; every other git call in the file pins 15–30s).
		const captures = impl.match(/spawnSync\("git", \["rev-parse", "HEAD"\]/g) ?? [];
		expect(captures.length).toBe(4);
		const timeouted = impl.match(/spawnSync\("git", \["rev-parse", "HEAD"\], \{ cwd: setup\.worktreePath, encoding: "utf8", timeout: 5_000 \}/g) ?? [];
		expect(timeouted.length).toBe(4);
	});
});

// ─── v0.3.74 ────────────────────────────────────────────────────────────────

describe("v0.3.74 — timeout env knobs (M4 design gap: static tiers, no operator knob)", () => {
	const saved: Record<string, string | undefined> = {};
	const setEnv = (k: string, v: string | undefined) => {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	};
	const restore = () => {
		for (const [k, v] of Object.entries(saved)) setEnv(k, v);
	};
	const KEYS = ["SUPER_DEV_CODE_TIMEOUT_MS", "SUPER_DEV_REVIEW_TIMEOUT_MS", "SUPER_DEV_DEFAULT_TIMEOUT_MS"] as const;

	beforeAll(() => {
		for (const k of KEYS) saved[k] = process.env[k];
	});
	afterAll(restore);
	beforeEach(() => {
		for (const k of KEYS) delete process.env[k];
	});

	it("SUPER_DEV_REVIEW_TIMEOUT_MS overrides the reviewer tier", async () => {
		setEnv("SUPER_DEV_REVIEW_TIMEOUT_MS", "900000");
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("code-reviewer")).toBe(900000);
		expect(defaultAgentTimeoutMs("spec-reviewer")).toBe(900000);
	});

	it("SUPER_DEV_CODE_TIMEOUT_MS overrides the code-writing tier", async () => {
		setEnv("SUPER_DEV_CODE_TIMEOUT_MS", "2400000");
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("implementer")).toBe(2400000);
		expect(defaultAgentTimeoutMs("tdd-guide")).toBe(2400000);
	});

	it("SUPER_DEV_DEFAULT_TIMEOUT_MS overrides the default tier only", async () => {
		setEnv("SUPER_DEV_DEFAULT_TIMEOUT_MS", "600000");
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("task-classifier")).toBe(600000);
		expect(defaultAgentTimeoutMs("code-reviewer")).toBe(1_800_000);
	});

	it("tier precedence: the agent's OWN tier key wins over the default key", async () => {
		setEnv("SUPER_DEV_DEFAULT_TIMEOUT_MS", "600000");
		setEnv("SUPER_DEV_REVIEW_TIMEOUT_MS", "900000");
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("code-reviewer")).toBe(900000);
	});

	it("garbage values fall back loudly to the tier constant (WARN once per key, run proceeds)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			setEnv("SUPER_DEV_REVIEW_TIMEOUT_MS", "30 min");
			setEnv("SUPER_DEV_DEFAULT_TIMEOUT_MS", "250k");
			const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
			expect(defaultAgentTimeoutMs("code-reviewer")).toBe(1_800_000);
			expect(defaultAgentTimeoutMs("task-classifier")).toBe(1_200_000);
			expect(warn.mock.calls.some((a) => String(a[0]).includes("SUPER_DEV_REVIEW_TIMEOUT_MS"))).toBe(true);
			expect(warn.mock.calls.some((a) => String(a[0]).includes("SUPER_DEV_DEFAULT_TIMEOUT_MS"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("sub-second values are unit mistakes (seconds typed as ms) — rejected like garbage (dual review F6)", async () => {
		setEnv("SUPER_DEV_REVIEW_TIMEOUT_MS", "30");
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("code-reviewer")).toBe(1_800_000);
	});

	it("non-positive values (0 / -5) are rejected like garbage", async () => {
		setEnv("SUPER_DEV_CODE_TIMEOUT_MS", "0");
		const { defaultAgentTimeoutMs } = await import("../src/agents/agent-runtime.ts");
		expect(defaultAgentTimeoutMs("implementer")).toBe(1_800_000);
	});
});

describe("v0.3.74 — renderAndWrite marks the stage id at entry (net dedupe primitive)", () => {
	it("marks renderedStageDocs even when the control fails schema validation (attempt-level mark)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sd-render-mark-"));
		try {
			const { renderAndWrite } = await import("../src/render/render.ts");
			const setup: SetupControl = {
				worktreePath: dir,
				specDirectory: join(dir, "docs", "specifications", "mark"),
				defaultBranch: "main",
				language: "frontend",
				isWebUi: false,
				specIdentifier: "mark",
				worktreeCreated: false,
				initializedRepo: false,
			};
			const logs: string[] = [];
			// deliberately INVALID control for designReview — renderStage must reject
			// and write nothing, but the entry-mark must still record the ATTEMPT so
			// the task() net never double-fires for this stage in the run.
			const path = renderAndWrite(setup as never, (m) => logs.push(m), "designReview", { garbage: true });
			expect(path).toBeNull();
			expect(setup.renderedStageDocs?.has("designReview")).toBe(true);
			expect(logs.some((l) => /render validation errors/i.test(l))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
