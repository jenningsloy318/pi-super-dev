/**
 * 058 Wave 3 D-D (Layer 4) acceptance — git checkpoint rollback at convergence
 * re-entry. docs/requirements/058-cross-phase-contract-architecture.md
 * §3 Layer 4 + §4 D-D (NEW-2/NEW-3 rulings).
 *
 * Deterministic only: REAL git repos with the REAL deterministic phase-commit
 * chain (deterministicPhaseCommit builds the checkpoints under test), covering
 * the rollback target formula (mid-chain K, K=1, partial predecessor),
 * downstream green-stamp invalidation, downstream uncommitted state stashed +
 * re-applied, the conflict→drop+log path, the guards, and chain integrity
 * after rollback. Mirrors tests/contract-writers-059.test.ts style.
 */

import { implementationSources } from "./helpers/implementation-source.ts";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deterministicPhaseCommit } from "../src/stages/implementation/index.ts";
import {
	captureStageEntryBaseline,
	reapplyRollbackStash,
	rollbackConvergenceReentry,
	latestGreenCommitBefore,
	laterPhasesRan,
} from "../src/stages/checkpoint-rollback.ts";

const ENV_KEYS = ["SUPER_DEV_NO_DIRTY_QUARANTINE", "SUPER_DEV_LLM_COMMITS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

interface Chain {
	repo: string;
	git: (...args: string[]) => ReturnType<typeof spawnSync>;
	/** The stage-entry baseline: HEAD after the seed commit, BEFORE any phase
	 *  commit (what captureStageEntryBaseline sees at first stage entry). */
	baseline: string;
	/** sha per committed phase index (1-based; partial phases have none). */
	commits: Map<number, string>;
}

/** A repo whose ONLY history is: seed → phase commits (partialIdx gets NO commit). */
function makeChain(prefix: string, phaseCount: number, partialIdx = 0): Chain {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	const baseline = String(git("rev-parse", "HEAD").stdout).trim();
	const commits = new Map<number, string>();
	for (let i = 1; i <= phaseCount; i++) {
		if (i === partialIdx) continue; // the partial predecessor: best attempt stashed, NO commit
		const rel = `src/phase-${String(i).padStart(2, "0")}.ts`;
		mkdirSync(dirname(join(repo, rel)), { recursive: true });
		writeFileSync(join(repo, rel), `export const P${i} = ${i};\n`);
		const out = deterministicPhaseCommit(repo, { phaseIndex: i, totalPhases: phaseCount, phaseName: `p${i}`, worktreeCreated: true, gateSummary: "build green" });
		expect(out.status).toBe("committed");
		commits.set(i, String(git("rev-parse", "HEAD").stdout).trim());
	}
	return { repo, git, baseline, commits };
}

const greens = (n: number, partial: number[] = []): Array<{ id: string; status: string }> =>
	Array.from({ length: n }, (_, i) => ({ id: `phase-${String(i + 1).padStart(2, "0")}`, status: partial.includes(i + 1) ? "partial" : "green" }));

// ─── NEW-3: the rollback target formula ──────────────────────────────────────

describe("058 D-D — rollback target formula: latestGreenCommitBefore(K) ?? stageEntryBaselineCommit (NEW-3)", () => {
	it("mid-chain K: the newest phase commit with index < K (K=3 → phase-2's commit, NOT phase-3's)", () => {
		const { repo, commits, baseline } = makeChain("sd-058-dd-mid-", 5);
		try {
			expect(baseline).toBeTruthy();
			expect(latestGreenCommitBefore(repo, 3, baseline)).toBe(commits.get(2));
			expect(latestGreenCommitBefore(repo, 3, baseline)).not.toBe(commits.get(3));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("K=1: no predecessor exists → null → the caller falls back to the stage entry baseline", () => {
		const { repo, commits, baseline } = makeChain("sd-058-dd-k1-", 3);
		try {
			expect(latestGreenCommitBefore(repo, 1, baseline)).toBeNull();
			const target = latestGreenCommitBefore(repo, 1, baseline) ?? baseline;
			expect(target).toBe(baseline); // the seed commit — the stage's entry state
			expect(target).not.toBe(commits.get(1)); // resetting phase 1 never lands on its OWN commit
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("partial predecessor: phase 2 contributed no commit, so K=4 falls through to phase-1's commit… and a green phase 3 wins over the partial 2", () => {
		const { repo, commits, baseline } = makeChain("sd-058-dd-part-", 5, 2); // phase 2 partial: no commit
		try {
			expect(latestGreenCommitBefore(repo, 3, baseline)).toBe(commits.get(1)); // K=3: predecessors 1(green),2(partial) → phase-1
			expect(latestGreenCommitBefore(repo, 4, baseline)).toBe(commits.get(3)); // K=4: newest green predecessor is 3
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("the walk is bounded to this run's range: a PRIOR run's phase commits are never targets", () => {
		const { repo, git } = makeChain("sd-058-dd-range-", 2);
		try {
			// baseline captured AFTER phase 1 (i.e. a second run entering mid-history)
			const secondRunBaseline = String(git("rev-parse", "HEAD").stdout).trim();
			writeFileSync(join(repo, "src/run2.ts"), "export const R2 = 1;\n");
			const out = deterministicPhaseCommit(repo, { phaseIndex: 2, totalPhases: 2, phaseName: "run2-p2", worktreeCreated: true, gateSummary: "g" });
			expect(out.status).toBe("committed");
			// K=1 of run 2 must fall to run 2's baseline (the run-1 phase-1 commit below it is out of range)
			expect(latestGreenCommitBefore(repo, 1, secondRunBaseline)).toBeNull();
			expect(latestGreenCommitBefore(repo, 1, secondRunBaseline) ?? secondRunBaseline).toBe(secondRunBaseline);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("the laterPhasesRan trigger predicate", () => {
		expect(laterPhasesRan([{ id: "phase-01", status: "green" }, { id: "phase-02", status: "partial" }, { id: "phase-03", status: "green" }], 0)).toBe(true);
		expect(laterPhasesRan([{ id: "phase-01", status: "green" }, { id: "phase-02", status: "partial" }, { id: "phase-03", status: "green" }], 2)).toBe(false);
		expect(laterPhasesRan([{ id: "phase-01", status: "partial" }], 0)).toBe(false); // nothing downstream ran
		expect(laterPhasesRan([], 0)).toBe(false);
	});
});

// ─── the rollback itself (stash + reset + NEW-2 invalidation) ────────────────

describe("058 D-D — rollbackConvergenceReentry: stash, reset, invalidate", () => {
	it("mid-chain re-entry resets to the K-1 tree, stashes downstream uncommitted state, and INVALIDATES downstream green stamps (NEW-2)", () => {
		const { repo, git, commits } = makeChain("sd-058-dd-rb-", 5);
		const specDir = join(repo, "docs/specifications/001/");
		try {
			mkdirSync(specDir, { recursive: true });
			writeFileSync(join(specDir, "01-requirements.md"), "# reqs\n"); // harness bookkeeping — must survive
			writeFileSync(join(repo, "src/downstream-wip.ts"), "uncommitted downstream work\n"); // downstream uncommitted
			const phaseStatus = greens(5);
			const logs: string[] = [];
			const report = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, specDirectory: specDir, phaseIndex: 2, totalPhases: 5, phaseStatus, baselineCommit: null, log: (l) => logs.push(l) });
			expect(report.status).toBe("rolled-back");
			expect(report.target).toBe(commits.get(1)); // latestGreenCommitBefore(2) = phase-1's commit
			expect(report.invalidated).toEqual(["phase-03", "phase-04", "phase-05"]); // NEW-2: downstream greens gone
			expect(phaseStatus.map((p) => p.id)).toEqual(["phase-01", "phase-02"]); // stamps spliced — they re-execute
			expect(String(git("rev-parse", "HEAD").stdout).trim()).toBe(commits.get(1)); // the reset landed
			expect(existsSync(join(repo, "src/phase-03.ts"))).toBe(false); // downstream green file ABSENT — restored only by re-execution (silent-loss pinned)
			expect(existsSync(join(repo, "src/downstream-wip.ts"))).toBe(false); // stashed away from the tree
			expect(existsSync(join(specDir, "01-requirements.md"))).toBe(true); // spec dir survives (excluded from the stash)


			expect(report.stashSha).toMatch(/^[0-9a-f]{40}$/);
			expect(String(git("stash", "list", "--format=%H").stdout)).toContain(report.stashSha!); // recoverable via git stash
			expect(logs.some((l) => l.includes("green stamps INVALIDATED for phase-03, phase-04, phase-05"))).toBe(true);
			expect(logs.some((l) => l.includes("ABANDONED"))).toBe(true); // P10: detached commits documented
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	// Adversarial S5 (v0.3.99 fix): downstream PARTIAL entries are invalidated
	// alongside greens — otherwise laterPhasesRan stays true for K+1 and a
	// second rollback fires within the same §D entry (cascade hazard).
	it("downstream partial entries are ALSO invalidated (at-most-one-rollback invariant holds)", () => {
		const { repo, git, commits } = makeChain("sd-058-dd-s5-", 5);
		try {
			// phase-01 green, phase-02 re-entry point, phases 03-05 downstream: 03 green, 04 partial, 05 green
			const phaseStatus = greens(5, [4]);
			const report = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, specDirectory: join(repo, "docs/specifications/001/"), phaseIndex: 2, totalPhases: 5, phaseStatus, baselineCommit: null, log: () => {} });
			expect(report.status).toBe("rolled-back");
			expect(report.invalidated).toEqual(["phase-03", "phase-04", "phase-05"]); // green AND partial both gone
			expect(phaseStatus.map((p) => p.id)).toEqual(["phase-01", "phase-02"]);
			// the one-rollback invariant: phase-02 (the re-entry point) itself no
			// longer sees any downstream ran-phase, and neither does phase-03 when
			// it re-executes (laterPhasesRan over the spliced list).
			expect(laterPhasesRan(phaseStatus, 1)).toBe(false);
			expect(laterPhasesRan(phaseStatus, 2)).toBe(false);
			void git; void commits;
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	// Adversarial S4 (v0.3.99 fix): a conflicted stash re-apply RETAINS the
	// stash in git stash list — never irrevocably dropped.
	it("reapplyRollbackStash on conflict RETAINS the stash (labeled, recoverable) and restores the tree", () => {
		const { repo, git } = makeChain("sd-058-dd-s4-", 3);
		try {
			// stash a downstream WIP that will conflict with the re-executed tree
			writeFileSync(join(repo, "src/phase-03.ts"), "export const P3 = \"stashed WIP\";\n");
			const stash = git("stash", "push", "--include-untracked", "-m", "super-dev rollback before phase 3/3 (058 D-D)");
			expect(stash.status).toBe(0);
			const stashSha = String(git("rev-parse", "-q", "--verify", "refs/stash").stdout).trim();
			expect(stashSha).toBeTruthy();
			// recreate the path with content that DIFFERS from the stash's parent
			// (the committed P3 = 3) — the apply will conflict
			writeFileSync(join(repo, "src/phase-03.ts"), "export const P3 = 999; // re-executed differently\n");
			const logs: string[] = [];
			const out = reapplyRollbackStash({ worktreePath: repo, stashSha, phaseId: "phase-03", log: (l) => logs.push(l) });
			expect(out.status).toBe("dropped"); // the APPLY failed (reset-back path)
			// but the stash itself SURVIVES (adversarial S4: never irrevocably dropped):
			const list = String(git("stash", "list", "--format=%H").stdout);
			expect(list).toContain(stashSha);
			expect(logs.some((l) => l.includes("RETAINED"))).toBe(true);
			expect(logs.some((l) => l.includes("conflict-preserved phase-03"))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	// Code-Gate FINDING-1 + ADV-2 (v0.3.99 fix): a clean-tree rollback in a
	// repo that ALREADY carries an unrelated stash must NOT capture it.
	it("clean-tree rollback with a PRE-EXISTING unrelated stash captures NOTHING (phantom-stash guard)", () => {
		const { repo, git } = makeChain("sd-058-dd-f1-", 4);
		try {
			// a pre-existing UNRELATED stash (as preservePartialPhase might leave)
			writeFileSync(join(repo, "src/unrelated-wip.ts"), "unrelated preserved work\n");
			git("stash", "push", "--include-untracked", "-m", "preservePartialPhase (unrelated)");
			const preSha = String(git("rev-parse", "-q", "--verify", "refs/stash").stdout).trim();
			expect(preSha).toBeTruthy();
			const report = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, specDirectory: join(repo, "docs/specifications/001/"), phaseIndex: 3, totalPhases: 4, phaseStatus: greens(4), baselineCommit: null, log: () => {} });
			expect(report.status).toBe("rolled-back"); // the reset still happens
			expect(report.stashSha).toBeUndefined(); // NO phantom capture
			expect(String(git("rev-parse", "-q", "--verify", "refs/stash").stdout).trim()).toBe(preSha); // the unrelated stash is UNTOUCHED
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("guards: in-place runs and the quarantine kill-switch never mutate the tree", () => {
		const { repo, git, commits } = makeChain("sd-058-dd-g1-", 3);
		try {
			const head = String(git("rev-parse", "HEAD").stdout).trim();
			const phaseStatus = greens(3);
			const r1 = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: false, phaseIndex: 2, totalPhases: 3, phaseStatus, baselineCommit: null, log: () => {} });
			expect(r1.status).toBe("skipped");
			process.env.SUPER_DEV_NO_DIRTY_QUARANTINE = "1";
			const r2 = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, phaseIndex: 2, totalPhases: 3, phaseStatus, baselineCommit: null, log: () => {} });
			expect(r2.status).toBe("skipped");
			expect(String(git("rev-parse", "HEAD").stdout).trim()).toBe(head); // untouched
			expect(phaseStatus.length).toBe(3); // no invalidation either
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("no target (empty chain + no baseline) degrades honestly: skipped, no mutation", () => {
		const { repo } = makeChain("sd-058-dd-g2-", 2);
		try {
			// baseline null AND no phase commit below K=1 → nothing to reset to
			const r = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, phaseIndex: 1, totalPhases: 2, phaseStatus: greens(2), baselineCommit: null, log: () => {} });
			expect(r.status).toBe("skipped");
			expect(r.reason).toContain("nothing to reset to");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

// ─── stash re-apply after re-execution ───────────────────────────────────────

describe("058 D-D — reapplyRollbackStash: best-effort sequential re-apply, conflict → drop + honest log", () => {
	it("re-applies the stashed downstream state after phase K re-executes, then consumes it (second call = missing)", () => {
		const { repo, git, commits } = makeChain("sd-058-dd-ra-", 4);
		try {
			writeFileSync(join(repo, "src/wip.ts"), "downstream uncommitted\n");
			const report = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, phaseIndex: 2, totalPhases: 4, phaseStatus: greens(4), baselineCommit: null, log: () => {} });
			expect(report.status).toBe("rolled-back");
			// phase K re-executes: land its work + deterministic commit
			writeFileSync(join(repo, "src/phase-02.ts"), "export const P2 = 2; // re-executed\n");
			const commit = deterministicPhaseCommit(repo, { phaseIndex: 2, totalPhases: 4, phaseName: "p2", worktreeCreated: true, gateSummary: "build green" });
			expect(commit.status).toBe("committed");
			const logs: string[] = [];
			const reapplied = reapplyRollbackStash({ worktreePath: repo, stashSha: report.stashSha!, phaseId: "phase-02", log: (l) => logs.push(l) });
			expect(reapplied.status).toBe("reapplied");
			expect(readFileSync(join(repo, "src/wip.ts"), "utf8")).toBe("downstream uncommitted\n"); // the state is back
			expect(String(git("stash", "list", "--format=%H").stdout)).not.toContain(report.stashSha!); // consumed
			// idempotent: the stash is gone — an honest missing, never a re-apply loop
			const second = reapplyRollbackStash({ worktreePath: repo, stashSha: report.stashSha!, phaseId: "phase-02", log: () => {} });
			expect(second.status).toBe("missing");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a CONFLICTING re-apply DROPS the stash with an honest log and restores the phase's commit tree (P10)", () => {
		const { repo, git, commits } = makeChain("sd-058-dd-conf-", 4);
		try {
			// downstream uncommitted edit to a file phase 2 will RE-EXECUTE differently
			writeFileSync(join(repo, "src/phase-02.ts"), "export const P2 = 999; // downstream tamper\n");
			const report = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, phaseIndex: 2, totalPhases: 4, phaseStatus: greens(4), baselineCommit: null, log: () => {} });
			expect(report.status).toBe("rolled-back");
			expect(existsSync(join(repo, "src/phase-02.ts"))).toBe(false); // reset away with the rest
			// phase 2 re-executes with ITS OWN content + commits (the conflict source)
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src/phase-02.ts"), "export const P2 = 2; // re-executed\n");
			const commit = deterministicPhaseCommit(repo, { phaseIndex: 2, totalPhases: 4, phaseName: "p2", worktreeCreated: true, gateSummary: "build green" });
			expect(commit.status).toBe("committed");
			const logs: string[] = [];
			const dropped = reapplyRollbackStash({ worktreePath: repo, stashSha: report.stashSha!, phaseId: "phase-02", log: (l) => logs.push(l) });
			expect(dropped.status).toBe("dropped"); // the APPLY failed — conflicts never go to an LLM
			expect(readFileSync(join(repo, "src/phase-02.ts"), "utf8")).toContain("re-executed"); // tree back at phase 2's commit
			// Adversarial S4 fix (v0.3.99): the conflicted stash is RETAINED (labeled
			// conflict-preserved) — downstream partial work stays user-recoverable.
			expect(String(git("stash", "list", "--format=%H").stdout)).toContain(report.stashSha!); // RETAINED (adversarial S4)
			expect(logs.some((l) => l.includes("conflict-preserved phase-02"))).toBe(true);
			expect(logs.some((l) => l.includes("RETAINED"))).toBe(true);
			expect(logs.some((l) => l.includes("P10"))).toBe(true);
			expect(String(git("status", "--porcelain", "--", "src/phase-02.ts").stdout).trim()).toBe(""); // no conflict residue
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

// ─── chain integrity after rollback (the deterministicPhaseCommit chain) ─────

describe("058 D-D — the deterministic phase-commit chain stays intact after rollback", () => {
	it("re-executed phases commit ON TOP of the reset target; abandoned commits leave HEAD ancestry", () => {
		const { repo, git, commits, baseline } = makeChain("sd-058-dd-chain-", 4);
		try {
			const report = rollbackConvergenceReentry({ worktreePath: repo, worktreeCreated: true, phaseIndex: 2, totalPhases: 4, phaseStatus: greens(4), baselineCommit: null, log: () => {} });
			expect(report.status).toBe("rolled-back");
			// phase 2 re-executes + commits
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src/phase-02.ts"), "export const P2 = 2; // re-executed\n");
			const re2 = deterministicPhaseCommit(repo, { phaseIndex: 2, totalPhases: 4, phaseName: "p2", worktreeCreated: true, gateSummary: "build green" });
			expect(re2.status).toBe("committed");
			const newHead = String(git("rev-parse", "HEAD").stdout).trim();
			// ancestry: seed → phase-1 → phase-2(re) — the OLD phase-2/3/4 commits are abandoned
			expect(String(git("merge-base", "--is-ancestor", commits.get(1)!, newHead).status)).toBe("0");
			for (const old of [2, 3, 4]) {
				expect(String(git("merge-base", "--is-ancestor", commits.get(old)!, newHead).status)).not.toBe("0");
			}
			// the re-executed chain's subjects parse back through the same grammar
			// (a K=3 walk bounded by the ORIGINAL run baseline finds phase-2's re-commit)
			expect(captureStageEntryBaseline(repo)).toBe(newHead); // a resumed pass enters at the re-executed commit
			const target = latestGreenCommitBefore(repo, 3, baseline);
			expect(target).toBe(newHead);
			expect(readFileSync(join(repo, "src/phase-02.ts"), "utf8")).toContain("re-executed");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("source pin: the stage wiring resets the walk to the NEW-3 target and re-baselines the phase-start dirt snapshot", () => {
		const impl = implementationSources();
		// v0.4.28: the block moved to phase-rollback.ts as handleConvergenceRollback
		// (straight-line, mutations by reference + the stash rebinding returned);
		// the wiring pin follows the seam, the Layer-4/ground pins are unchanged.
		expect(impl).toContain("handleConvergenceRollback({"); // the stage wiring at the re-entry trigger
		expect(impl).toContain("laterPhasesRan(input.phaseStatus, input.idx)"); // the re-entry trigger (module-local shape)
		expect(impl).toContain("rollbackConvergenceReentry({"); // the Layer-4 seam
		expect(impl).toContain("reapplyRollbackStash({ worktreePath: setup.worktreePath, stashSha: pendingRollbackStash.stashSha"); // post-re-execution re-apply
		expect(impl).toContain("delete input.phaseStartDirt[input.phaseId];"); // the attribution boundary re-anchors on the rolled-back ground (fresh recapture at phase entry)
		expect(impl).toContain("captureStageEntryBaseline(setup.worktreePath)"); // the NEW-3 fallback captured once per run
	});
});
