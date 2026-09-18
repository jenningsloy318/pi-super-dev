/**
 * The protection choke point — contract test for the v0.4.36 extraction
 * (increment 8 of the stage.ts split).
 *
 * This is the fourth control-flow conversion and the first with a LOOP-COUNTER
 * mutation: the inline block's strike-1 `continue` also ran `attempt--` (zero
 * attempt cost), which a module cannot do to the caller's for-loop counter —
 * so the outcome is a FOUR-way union (pass / reprompt / reauthor / terminal)
 * and the caller decrements only on `reprompt`.
 *
 * The v0.4.33 cross-iteration lesson, applied by construction (pinned here):
 * each outcome carries ONLY the bindings its branch assigned — reprompt
 * carries education ONLY; reauthor carries evidence ONLY (the caller clears
 * attemptProgressHistory/acceptedRed alongside, exactly the inline trio);
 * terminal carries the error ONLY. Nothing else is zeroed.
 *
 * Real-git fixtures for the porcelain walk + revert (the
 * protection-strikes-058.test.ts pattern); the strike-2 arms drive the REAL
 * consumeProtectionBreachEscalation through a fake ctx whose agent lane
 * returns the judge verdict (no module mocking).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { adjudicateProtectionGate } from "../src/stages/implementation/protection-gate.ts";
import { deriveProtectionInterval } from "../src/stages/protection-interval.ts";
import type { AgentCall, AgentResult, PipelineState, StageContext } from "../src/types.ts";

// ─── fixtures (the 058 golden idiom: porcelain pathspec + byte-untouched) ───

const SCENARIO_14_TEST = [
	'import { execSync } from "node:child_process";',
	'import { expect, it } from "vitest";',
	"",
	'it("SCENARIO-014 the frozen contract holds", () => {',
	'\tconst dirty = execSync("git status --porcelain -- src/schemas.ts").toString();',
	'\texpect(dirty, "src/schemas.ts must stay byte-untouched").toBe("");',
	"});",
].join("\n");

const FROZEN_CONTENT = "export const FROZEN = 1;\n";

function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	for (const [rel, content] of Object.entries({ "src/schemas.ts": FROZEN_CONTENT, "tests/frozen.test.ts": SCENARIO_14_TEST })) {
		const p = join(repo, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	git("add", "-A");
	git("commit", "-qm", "seed");
	return repo;
}

function writeRepo(repo: string, rel: string, content: string): void {
	const p = join(repo, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
}

const porcelain = (repo: string): string => String(spawnSync("git", ["-C", repo, "status", "--porcelain", "-z", "--untracked-files=all"], { encoding: "utf8" }).stdout ?? "");

/** The derived interval over the seeded repo — protectedPaths = {src/schemas.ts}. */
const intervalFor = deriveProtectionInterval;

/** Fake ctx whose agent lane returns the judge verdict (the breachCtx pattern
 *  from protection-strikes-058.test.ts — drives the REAL consumer). */
function judgeCtx(control: Record<string, unknown> | null, out: { logs: string[]; error?: string }): StageContext {
	return {
		task: "t", options: {}, state: {} as PipelineState,
		budget: { count: 0, check: () => true, spent: () => true },
		log: (line: string) => { out.logs.push(line); }, phase: () => {}, events: new EventEmitter(), results: [],
		async agent(): Promise<AgentResult> {
			return out.error !== undefined ? { text: "", control: null, error: out.error } : { text: "", control };
		},
		helper: async () => ({ value: {}, digest: "" }),
		parallel: async (calls: unknown[]) => Promise.all((calls as Array<() => unknown>).map((c) => c())),
	} as unknown as StageContext;
}

const gateInput = (over: Partial<Parameters<typeof adjudicateProtectionGate>[0]> = {}) => ({
	ctx: judgeCtx(null, { logs: [] }),
	state: {} as PipelineState,
	worktreePath: "",
	phaseId: "phase-02",
	phaseName: "wire-screen",
	specIdentifier: "001",
	protectionInterval: { protectedPaths: new Map(), scanLines: [] },
	declaredFootprint: [],
	phaseProtectionStrikes: {} as Record<string, number>,
	attempt: 1,
	...over,
});

describe("protection gate (v0.4.36 increment-8 extraction)", () => {
	it("an EMPTY protected set → immediate pass, no porcelain walk (zero cost / zero false positives)", async () => {
		const out = await adjudicateProtectionGate(gateInput({ worktreePath: "/nonexistent-path-skip" }));
		// passes BEFORE touching the filesystem — a nonexistent worktreePath proves
		// the walk never ran
		expect(out).toEqual({ kind: "pass" });
	});

	it("a dirty file OUTSIDE the protected set → pass", async () => {
		const repo = makeRepo("sd-pgate-pass-");
		try {
			writeRepo(repo, "src/unprotected.ts", "dirty\n");
			const out = await adjudicateProtectionGate(gateInput({
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
			}));
			expect(out).toEqual({ kind: "pass" });
			expect(porcelain(repo)).toContain("src/unprotected.ts"); // untouched
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("STRIKE 1: a protected-path write → reprompt; the file is REVERTED on disk; the strike is bumped; nothing else is carried", async () => {
		const repo = makeRepo("sd-pgate-s1-");
		try {
			writeRepo(repo, "src/schemas.ts", "MUTATED\n");
			const strikes: Record<string, number> = {};
			const out = await adjudicateProtectionGate(gateInput({
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
				// F1: declaredFootprint EMPTY — the write is porcelain-visible, so this
				// reprompt proves the WALK fed detection (not the declared arm).
				declaredFootprint: [],
				phaseProtectionStrikes: strikes,
				attempt: 2,
			}));
			expect(out.kind).toBe("reprompt");
			if (out.kind !== "reprompt") return;
			// the education block names the file and the protecting clause locus
			expect(out.education).toContain("src/schemas.ts");
			expect(out.education).toContain("tests/frozen.test.ts");
			// the violating write was mechanically REVERTED (restorePaths)
			expect(readFileSync(join(repo, "src/schemas.ts"), "utf8")).toBe(FROZEN_CONTENT);
			expect(porcelain(repo).trim()).toBe("");
			// the strike counter was bumped to 1 — visible to the NEXT adjudication
			expect(strikes["phase-02"]).toBe(1);
			// v0.4.33: reprompt carries education ONLY — no error, no evidence
			expect("attemptError" in out).toBe(false);
			expect("reauthorEvidence" in out).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("STRIKE 2 + judge challenge-test → reauthor with the diagnosis; the strike counter is RESET for the re-authored surface", async () => {
		const repo = makeRepo("sd-pgate-ct-");
		try {
			writeRepo(repo, "src/schemas.ts", "MUTATED-AGAIN\n");
			const strikes: Record<string, number> = { "phase-02": 1 }; // strike 1 already burned
			const logs: string[] = [];
			const out = await adjudicateProtectionGate(gateInput({
				ctx: judgeCtx({ diagnosis: "SCENARIO-014 pins the wrong surface for this feature", route: "challenge-test", confidence: 0.9, evidence: [{ file: "tests/frozen.test.ts", quote: "must stay byte-untouched" }] }, { logs }),
				state: { setup: { worktreePath: repo } } as unknown as PipelineState,
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
				declaredFootprint: ["src/schemas.ts"],
				phaseProtectionStrikes: strikes,
			}));
			expect(out.kind).toBe("reauthor");
			if (out.kind !== "reauthor") return;
			expect(out.reauthorEvidence).toContain("Judge diagnosis");
			expect(out.reauthorEvidence).toContain("SCENARIO-014 pins the wrong surface");
			expect(out.reauthorEvidence).toContain("tests/frozen.test.ts: must stay byte-untouched");
			// reset for the re-authored contract surface
			expect(strikes["phase-02"]).toBeUndefined();
			// the violating write was STILL mechanically reverted
			expect(readFileSync(join(repo, "src/schemas.ts"), "utf8")).toBe(FROZEN_CONTENT);
			// v0.4.33: reauthor carries evidence ONLY
			expect("education" in out).toBe(false);
			expect("attemptError" in out).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("STRIKE 2 + judge replan-routed (real spec dir) → terminal with the replan-routed template arm, not the degraded arm", async () => {
		const repo = makeRepo("sd-pgate-term-");
		const specDir = mkdtempSync(join(tmpdir(), "sd-pgate-spec-"));
		try {
			writeRepo(repo, "src/schemas.ts", "MUTATED-3RD\n");
			const logs: string[] = [];
			const out = await adjudicateProtectionGate(gateInput({
				ctx: judgeCtx({ diagnosis: "the plan genuinely requires writing the frozen file", route: "replan-upstream", confidence: 0.85, evidence: [{ file: "tests/frozen.test.ts", quote: "src/schemas.ts must stay byte-untouched" }] }, { logs }),
				// a REAL spec directory so triggerReplanForFindings routes — the
				// template's replan-routed arm (not the degraded arm) is exercised
				state: { setup: { worktreePath: repo, specDirectory: specDir } } as unknown as PipelineState,
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
				declaredFootprint: [], // porcelain-visible write — the WALK feeds detection
				phaseProtectionStrikes: { "phase-02": 1 },
			}));
			expect(out.kind).toBe("terminal");
			if (out.kind !== "terminal") return;
			expect(out.attemptError).toContain("protection-breach");
			expect(out.attemptError).toContain("src/schemas.ts");
			expect(out.attemptError).toContain("judge routed replan-upstream (plan revision)");
			expect(out.attemptError).toContain("stay protected (reverted)");
			// v0.4.33: terminal carries the error ONLY — never education/evidence
			expect("education" in out).toBe(false);
			expect("reauthorEvidence" in out).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(specDir, { recursive: true, force: true });
		}
	});

	it("the DECLARED-footprint arm: a violation invisible to porcelain (clean worktree) is still caught via the implementer's claim", async () => {
		const repo = makeRepo("sd-pgate-decl-");
		try {
			// worktree is CLEAN — but the implementer DECLARED writing the protected
			// path (the second detection arm; catches the delete-and-restore dodge)
			const out = await adjudicateProtectionGate(gateInput({
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
				declaredFootprint: ["src/schemas.ts"],
				phaseProtectionStrikes: {},
			}));
			expect(out.kind).toBe("reprompt");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("adversarial F1 — a PRE-SEEDED strike ≥ 2 (§D re-entry resume) goes straight to the judge arm: no reprompt, the real count is interpolated", async () => {
		const repo = makeRepo("sd-pgate-seeded-");
		try {
			writeRepo(repo, "src/schemas.ts", "MUTATED\n");
			const logs: string[] = [];
			const strikes: Record<string, number> = { "phase-02": 2 }; // resumed mid-strike
			const out = await adjudicateProtectionGate(gateInput({
				ctx: judgeCtx({ diagnosis: "the plan genuinely requires writing the frozen file", route: "replan-upstream", confidence: 0.85, evidence: [{ file: "tests/frozen.test.ts", quote: "src/schemas.ts must stay byte-untouched" }] }, { logs }),
				state: { setup: { worktreePath: repo } } as unknown as PipelineState,
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
				declaredFootprint: [], // porcelain-visible write — the WALK feeds detection
				phaseProtectionStrikes: strikes,
			}));
			// strike 3 ≠ 1 → NO education re-prompt; straight to the judge
			expect("education" in out).toBe(false);
			expect(logs.some((l) => l.includes("strike 3/2"))).toBe(true); // the REAL bumped count
			expect(strikes["phase-02"]).toBe(3);
			// replan-upstream on a bare state (no specDirectory) declines → honest
			// degrade → terminal either way — the module never escapes
			expect(out.kind).toBe("terminal");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("adversarial F1 — a THROWING judge (agent spawn failure) degrades honestly to terminal; the module NEVER escapes", async () => {
		const repo = makeRepo("sd-pgate-jthrow-");
		try {
			writeRepo(repo, "src/schemas.ts", "MUTATED\n");
			const logs: string[] = [];
			const out = await adjudicateProtectionGate(gateInput({
				ctx: judgeCtx(null, { logs, error: "agent spawn failed (source-read-only boundary)" }),
				state: { setup: { worktreePath: repo } } as unknown as PipelineState,
				worktreePath: repo,
				protectionInterval: intervalFor(repo, undefined),
				declaredFootprint: [], // porcelain-visible write — the WALK feeds detection
				phaseProtectionStrikes: { "phase-02": 1 },
			}));
			// the consumer's catch degrades the judge error to an honest outcome —
			// the module turns it into terminal, never a throw, never a reprompt
			expect(out.kind).toBe("terminal");
			if (out.kind !== "terminal") return;
			expect(out.attemptError).toContain("judge outcome degraded");
			// the violating write was still reverted before adjudication
			expect(readFileSync(join(repo, "src/schemas.ts"), "utf8")).toBe(FROZEN_CONTENT);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
