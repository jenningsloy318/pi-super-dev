/**
 * v0.3.0 review remediation pins (code-F3 + code-F4 / adv SD030-3): the
 * partial-preserve stash's EXCLUSION contract and the §D windup bound —
 * real-git worktrees, no LLM.
 *
 *  1. spec-dir exclusion: the stash carries the phase's code but NEVER the
 *     spec directory (stage docs / evidence ledgers / knowledge live there
 *     untracked until the release commit — resume and downstream stages
 *     read them).
 *  2. kill-switch: SUPER_DEV_NO_DIRTY_QUARANTINE=1 skips the preserve stash
 *     entirely (no automatic worktree mutations), leaving the tree dirty.
 *  3. in-place guard (code-F1): worktreeCreated:false → no stash at all.
 *  4. windup bound: a phase that goes partial with the SAME failure signature
 *     in MAX_PARTIAL_REENTRIES+1 total passes is skipped on later §D
 *     iterations (the outer loop calls implementationStage repeatedly).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Gate/deliverable primitives mocked (real stage logic, scripted gates).
const gateQRef = { q: [] as Array<{ pass: boolean; inScopePass: boolean; errors: string[]; outOfScopeErrors: string[]; ran: string[] }> };
vi.mock("../src/build-runner.ts", async (orig) => {
	const a = (await orig()) as Record<string, unknown>;
	return {
		...a,
		runRedCheck: () => "unknown",
		runBuildGate: () => gateQRef.q.shift() ?? { pass: true, inScopePass: true, errors: [], outOfScopeErrors: [], ran: ["npm test"] },
		runDeliverableCheck: () => ({ pass: true, missing: [], ran: [] }),
		computeChangeGate: () => ({ pass: true, claimedNotChanged: [], changedNotClaimed: [], advisory: [] }),
		resetDeliverableCheckCache: () => {},
	};
});
vi.mock("../src/render/render.ts", () => ({ renderAndWrite: vi.fn() }));
vi.mock("../src/render/reflection.ts", () => ({ runReflectionAsync: vi.fn() }));
vi.mock("../src/render/user-notes.ts", () => ({ userNotesForAgent: vi.fn(() => "") }));
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementationStage, MAX_PARTIAL_REENTRIES } from "../src/stages/implementation.ts";
import type { PipelineState, StageContext, RunOptions, AgentResult, AgentCall, ControlObj, HelperResult } from "../src/types.ts";

const gateQ = gateQRef.q;
const PASS = { pass: true, inScopePass: true, errors: [], outOfScopeErrors: [], ran: ["npm test"] };
const DELIV_PASS = { pass: true, missing: [], ran: [] };

const git = (repo: string, ...args: string[]): string => {
	try {
		return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch (error) {
		return String((error as { stdout?: string }).stdout ?? "").trim();
	}
};

function mkRepo(worktreeCreated: boolean): { repo: string; specDir: string } {
	const repo = mkdtempSync(join(tmpdir(), "sd-v030-preserve-"));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "base.ts"), "export const base = 1;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	const specDir = join(repo, "docs", "specifications", "v030");
	mkdirSync(specDir, { recursive: true });
	writeFileSync(join(specDir, "01-requirements.md"), "# R\n");
	writeFileSync(join(specDir, "implementation-evidence.jsonl"), '{"round":1}\n');
	return { repo, specDir };
}

function mkCtx(repo: string): { ctx: StageContext; implCalls: AgentCall[]; logs: string[] } {
	const implCalls: AgentCall[] = [];
	const logs: string[] = [];
	const ctx: StageContext = {
		task: "", options: {} as RunOptions, state: {} as PipelineState,
		async helper(): Promise<HelperResult> { return { value: { languageInstructions: "" }, digest: "" }; },
		async agent(call): Promise<AgentResult> {
			if (call.agent === "implementer") {
				implCalls.push(call);
				// the implementer "works": edits a production file (dirty tree)
				writeFileSync(join(repo, "src", "work.ts"), "export const work = 2;\n");
				return { text: "did the work", control: { filesModified: ["src/work.ts"] } };
			}
			return { text: "ok", control: {} };
		},
		parallel: async (cs) => Promise.all(cs.map((c) => c())),
		budget: { check: () => true, spent: () => true, count: 0 },
		log: (m) => { logs.push(m); }, phase: () => {}, events: { on: () => () => {}, emit: () => {} } as never, results: [],
	};
	return { ctx, implCalls, logs };
}

function mkState(repo: string, specDir: string, worktreeCreated: boolean): PipelineState {
	return {
		setup: { worktreePath: repo, specDirectory: specDir, defaultBranch: "main", language: "frontend", isWebUi: false, specIdentifier: "v030", worktreeCreated, initializedRepo: false },
		classify: { taskType: "feature", uiScope: "none", language: "frontend", isWebUi: false },
		spec: { phases: [{ name: "Phase A" }] },
	} as unknown as PipelineState;
}

describe("v0.3.0 partial-preserve stash contract (review code-F1/F3)", () => {
	let env: string | undefined;
	beforeEach(() => { gateQ.length = 0; env = process.env.SUPER_DEV_NO_DIRTY_QUARANTINE; });
	afterEach(() => {
		if (env === undefined) delete process.env.SUPER_DEV_NO_DIRTY_QUARANTINE;
		else process.env.SUPER_DEV_NO_DIRTY_QUARANTINE = env;
	});

	it("the preserve stash carries the phase's code but NEVER the spec directory", async () => {
		const { repo, specDir } = mkRepo(true);
		try {
			gateQ.push({ pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] }, { pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] });
			const { ctx, logs } = mkCtx(repo);
			await implementationStage.run(mkState(repo, specDir, true), ctx);
			const stashList = git(repo, "stash", "list");
			expect(stashList).toContain("super-dev partial phase-01");
			// tracked/untracked content of the stash must NOT include the spec dir
			const tracked = git(repo, "stash", "show", "--name-only", "stash@{0}");
			expect(tracked).not.toContain("docs/specifications");
			let untracked = "";
			try { untracked = git(repo, "show", "stash@{0}^3", "--name-only", "--format="); } catch { /* no third parent */ }
			expect(untracked).not.toContain("docs/specifications");
			// the spec dir SURVIVES on disk (resume + downstream stages read it)
			expect(readFileSync(join(specDir, "01-requirements.md"), "utf8")).toContain("# R");
			expect(readFileSync(join(specDir, "implementation-evidence.jsonl"), "utf8")).toContain("round");
			// and the phase's work rode the stash
			expect(untracked).toContain("src/work.ts");
			void logs;
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("SUPER_DEV_NO_DIRTY_QUARANTINE=1 skips the preserve stash entirely (tree stays dirty)", async () => {
		const { repo, specDir } = mkRepo(true);
		try {
			process.env.SUPER_DEV_NO_DIRTY_QUARANTINE = "1";
			gateQ.push({ pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] }, { pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] });
			const { ctx, logs } = mkCtx(repo);
			await implementationStage.run(mkState(repo, specDir, true), ctx);
			expect(git(repo, "stash", "list")).toBe("");
			expect(logs.some((l) => l.includes("stash-preserve SKIPPED (SUPER_DEV_NO_DIRTY_QUARANTINE=1"))).toBe(true);
			// the phase's work stays dirty on disk (nothing swept)
			expect(git(repo, "status", "--porcelain")).toContain("src/work.ts");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("in-place runs (worktreeCreated:false) never stash — the user's checkout is untouchable", async () => {
		const { repo, specDir } = mkRepo(false);
		try {
			gateQ.push({ pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] }, { pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] });
			const { ctx, logs } = mkCtx(repo);
			await implementationStage.run(mkState(repo, specDir, false), ctx);
			expect(git(repo, "stash", "list")).toBe("");
			expect(logs.some((l) => l.includes("stash-preserve SKIPPED (in-place run"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("v0.3.0 windup bound (review code-F4 / adv SD030-3)", () => {
	it("MAX_PARTIAL_REENTRIES is 2 and a same-signature partial phase is skipped on the 4th pass", async () => {
		expect(MAX_PARTIAL_REENTRIES).toBe(2);
		const { repo, specDir } = mkRepo(true);
		try {
			const state = mkState(repo, specDir, true);
			const fail = { pass: false, inScopePass: false, errors: ["boom"], outOfScopeErrors: [], ran: ["npm test"] };
			// 4 §D iterations, each: phase-01 fails twice with the SAME signature
			const mkCtx1 = (): { ctx: StageContext; implCalls: AgentCall[]; logs: string[] } => mkCtx(repo);
			for (let pass = 1; pass <= 4; pass++) {
				gateQ.push(fail, fail);
				const { ctx, implCalls, logs } = mkCtx1();
				// the §D loop persists each iteration's control into state.implementation
				state.implementation = (await implementationStage.run(state, ctx)) as never;
				if (pass < 4) {
					expect(implCalls.length).toBeGreaterThan(0);
				} else {
					// pass 4: the phase is skipped — no implementer dispatched, skip log emitted
					expect(implCalls.length).toBe(0);
					expect(logs.some((l) => l.includes("skipping further re-entry this run"))).toBe(true);
				}
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
