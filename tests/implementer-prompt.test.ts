/**
 * The implementer corrective-prompt assembly — contract test for the
 * v0.4.48 extraction (increment 20 of the stage.ts split).
 *
 * THE CONTRACTS: the rider ORDER (protection education FIRST — the 058
 * Layer 2 prominence rule — then judge guidance, then the RED advisory,
 * then the assist block), the consume flags (the caller clears the
 * advisory lets exactly when pushed), the research-assist consumption
 * (pending dies either way; the archive is consumed only when the block
 * rendered), the retry sections' triggers + the missing-test exclusion
 * filters, the budget reminder and prior-progress blocks on attempt ≥ 2,
 * the §D seed on attempt 1, and the redImplementContext tail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { PipelineState, StageContext } from "../src/types.ts";

vi.mock("../src/stages/implementation/research-assist-dispatch.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/stages/implementation/research-assist-dispatch.ts")>();
	return {
		...orig,
		dispatchResearchAssist: vi.fn(async () => ({ block: null as string | null })),
	};
});

import { assembleImplementerPrompt, type ImplementerPromptInput } from "../src/stages/implementation/implementer-prompt.ts";
import { dispatchResearchAssist } from "../src/stages/implementation/research-assist-dispatch.ts";
import { redImplementContext } from "../src/stages/implementation/phase-reentry.ts";

const assistMock = vi.mocked(dispatchResearchAssist);

const repos: string[] = [];
function makeRepo(prefix: string): string {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src/seed.ts"), "export const S = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	repos.push(repo);
	return repo;
}

const ctxOf = (): StageContext => ({
	task: "t", options: {}, state: {} as PipelineState,
	budget: { count: 0, check: () => true, spent: () => true },
	log: () => {}, phase: () => {}, events: new EventEmitter(), results: [],
} as unknown as StageContext);

const baseInput = (over: Partial<ImplementerPromptInput> = {}): ImplementerPromptInput => ({
	ctx: ctxOf(),
	state: { classify: null, spec: null, bdd: null } as unknown as PipelineState,
	setup: { worktreePath: "", specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
	worktreePath: "",
	specDirectory: "",
	phaseId: "phase-01",
	phaseName: "wire",
	attempt: 1,
	phase: { name: "wire", deliverables: {} } as never,
	specialist: { languageInstructions: "use TS" } as never,
	redStatus: "red",
	testFiles: ["tests/prod.test.ts"],
	protectionEducation: "",
	judgeGuidance: "",
	redWeaknessAdvisory: "",
	redAssistArmed: {},
	researchAssistPending: null,
	phaseResearchAssistUsed: {},
	needsResearchArchive: [],
	attemptErrors: [],
	missingDeliverables: [],
	claimedNotChanged: [],
	hollowFiles: [],
	coverageGap: [],
	attemptProgressHistory: [],
	runStartDirt: [],
	acceptedRedChangedFiles: [],
	lastFailures: [],
	...over,
});

beforeEach(() => { vi.clearAllMocks(); assistMock.mockResolvedValue({ block: null } as never); });
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe("implementer prompt assembly (v0.4.48 increment-20 extraction)", () => {
	it("the rider ORDER: protection education FIRST, then judge guidance, then the RED advisory", async () => {
		const out = await assembleImplementerPrompt(baseInput({
			protectionEducation: "## PROTECTED PATHS LESSON",
			judgeGuidance: "## JUDGE GUIDANCE",
			redWeaknessAdvisory: "weak-ish",
		}));
		const iProt = out.implPrompt.indexOf("## PROTECTED PATHS LESSON");
		const iJudge = out.implPrompt.indexOf("## JUDGE GUIDANCE");
		const iAdv = out.implPrompt.indexOf("## RED review advisory");
		expect(iProt).toBeGreaterThan(-1);
		expect(iProt).toBeLessThan(iJudge);
		expect(iJudge).toBeLessThan(iAdv);
		// all three consumed
		expect(out.consumedProtectionEducation).toBe(true);
		expect(out.consumedJudgeGuidance).toBe(true);
		expect(out.consumedRedWeaknessAdvisory).toBe(true);
	});

	it("empty riders → nothing consumed, no blocks", async () => {
		const out = await assembleImplementerPrompt(baseInput());
		expect(out.consumedProtectionEducation).toBe(false);
		expect(out.consumedJudgeGuidance).toBe(false);
		expect(out.consumedRedWeaknessAdvisory).toBe(false);
	});

	it("the assist: a rendered block consumes the archive; a null block does not; pending dies either way; the ORDER advisory→assist→STOP pinned (cdb6a317 F2)", async () => {
		assistMock.mockResolvedValueOnce({ block: "\n## RESEARCH ASSIST\nfindings" } as never);
		const archive: unknown[] = [{ q: "prior question" }];
		const out = await assembleImplementerPrompt(baseInput({
			needsResearchArchive: archive as never,
			researchAssistPending: { streak: 2 } as never,
			redWeaknessAdvisory: "weak",
			attemptErrors: ["tdd-tests-modified-during-green: tests/prod.test.ts"], // arms the STOP section
		}));
		expect(out.implPrompt).toContain("## RESEARCH ASSIST");
		expect(archive).toHaveLength(0); // consumed in place
		expect(out.consumedResearchAssistPending).toBe(true); // dies either way
		// the ORDER contract: advisory < assist < STOP (cdb6a317 F2)
		const iAdv = out.implPrompt.indexOf("## RED review advisory");
		const iAssist = out.implPrompt.indexOf("## RESEARCH ASSIST");
		const iStop = out.implPrompt.indexOf("STOP editing the test files");
		expect(iAdv).toBeGreaterThan(-1);
		expect(iAdv).toBeLessThan(iAssist);
		expect(iAssist).toBeLessThan(iStop);
		// null block: archive survives
		const archive2: unknown[] = [{ q: "kept" }];
		const out2 = await assembleImplementerPrompt(baseInput({ needsResearchArchive: archive2 as never }));
		expect(archive2).toHaveLength(1);
	});

	it("the frozen-RED STOP section fires on the tdd-tests-modified-during-green error", async () => {
		const out = await assembleImplementerPrompt(baseInput({ attemptErrors: ["tdd-tests-modified-during-green: tests/prod.test.ts"] }));
		expect(out.implPrompt).toContain("STOP editing the test files — they are READ-ONLY during GREEN");
		expect(out.implPrompt).toContain("not even a comment, import, or header");
	});

	it("the budget reminder on attempt ≥ 2 carries the last two failure signatures; attempt 1 gets the §D seed instead", async () => {
		const out2 = await assembleImplementerPrompt(baseInput({
			attempt: 2,
			attemptProgressHistory: [{ failure: "sig-A" }, { failure: "sig-B" }, { failure: "sig-C" }] as never,
		}));
		expect(out2.implPrompt).toContain("## Attempt budget — attempt 2");
		expect(out2.implPrompt).toContain("- sig-B");
		expect(out2.implPrompt).toContain("- sig-C");
		expect(out2.implPrompt).not.toContain("- sig-A"); // slice(-2)
		const out1 = await assembleImplementerPrompt(baseInput({
			attempt: 1,
			lastFailures: [{ phaseId: "phase-01", reasons: ["prior blocker"] }],
		}));
		expect(out1.implPrompt).toContain("Prior convergence-iteration failures — fix these");
		expect(out1.implPrompt).toContain("prior blocker");
		expect(out1.implPrompt).not.toContain("## Attempt budget");
	});

	it("the RC3 prior-progress block on attempt ≥ 2: predecessor dirt listed, test/RED/run-start/acceptedRed files EXCLUDED (cdb6a317 F1/F3 — every filter load-bearing)", async () => {
		const repo = makeRepo("sd-ip-progress-");
		writeFileSync(join(repo, "src/feature.ts"), "export const F = 2;\n"); // predecessor work — LISTED
		writeFileSync(join(repo, "src/seed.ts"), "export const S = 2; // DIRTY\n"); // run-start dirt — dirty on disk AND filtered
		mkdirSync(join(repo, "tests"), { recursive: true });
		writeFileSync(join(repo, "tests/prod.test.ts"), "test('red', () => {});\n"); // a RED test file (in testFiles) — filtered
		writeFileSync(join(repo, "src/prior-red-output.ts"), "export const P = 1;\n"); // acceptedRed's changedFiles — filtered
		const out = await assembleImplementerPrompt(baseInput({
			attempt: 2,
			worktreePath: repo,
			setup: { worktreePath: repo, specDirectory: "", defaultBranch: undefined, language: "typescript" } as never,
			testFiles: ["tests/prod.test.ts"],
			runStartDirt: ["src/seed.ts"], // F1: the filter is load-bearing — seed.ts IS dirty on disk
			acceptedRedChangedFiles: ["src/prior-red-output.ts"], // F3: the acceptedRed filter pinned
		}));
		expect(out.implPrompt).toContain("## PRIOR ATTEMPT PROGRESS — continue, do NOT restart");
		expect(out.implPrompt).toContain("- src/feature.ts");
		expect(out.implPrompt).not.toContain("- src/seed.ts"); // F1: now provably excluded BY THE FILTER (dirty without it)
		expect(out.implPrompt).not.toContain("- tests/prod.test.ts"); // F3: the test-file filter is load-bearing (dirty without it)
		expect(out.implPrompt).not.toContain("- src/prior-red-output.ts"); // F3: the acceptedRed filter is load-bearing
	});

	it("the gate-failure and deliverables sections EXCLUDE missing test/scenario entries (the deadlock guard)", async () => {
		const out = await assembleImplementerPrompt(baseInput({
			attemptErrors: ["tsc error X", "deliverable: missing test: SCENARIO-009"],
			missingDeliverables: ["missing file: src/gone.ts", "missing test: SCENARIO-004"],
		}));
		expect(out.implPrompt).toContain("tsc error X");
		expect(out.implPrompt).toContain("missing file: src/gone.ts");
		expect(out.implPrompt).not.toContain("missing test: SCENARIO-004");
		expect(out.implPrompt).not.toContain("deliverable: missing test: SCENARIO-009");
	});

	it("the coverage / claimed / hollow sections fire on their respective carries", async () => {
		const out = await assembleImplementerPrompt(baseInput({
			coverageGap: ["42.0% lines vs the ≥85% hard floor"],
			claimedNotChanged: ["src/phantom.ts"],
			hollowFiles: ["src/shell.ts"],
		}));
		expect(out.implPrompt).toContain("Coverage below the hard floor");
		expect(out.implPrompt).toContain("42.0% lines");
		expect(out.implPrompt).toContain("Claimed changes not present in git");
		expect(out.implPrompt).toContain("src/phantom.ts");
		expect(out.implPrompt).toContain("Hollow deliverable files");
	});

	it("the redImplementContext tail renders the verified RED status LAST", async () => {
		const out = await assembleImplementerPrompt(baseInput({ redStatus: "red" }));
		const tail = redImplementContext("red");
		expect(out.implPrompt.endsWith(tail)).toBe(true);
	});
});
