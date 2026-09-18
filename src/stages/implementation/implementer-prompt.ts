/**
 * The implementer corrective-prompt assembly — increment 20 of the stage.ts
 * split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, from the redTargetsExist derivation
 * through `const implPrompt = implParts.join("\n\n")`): the base prompt +
 * the consume-and-clear advisory riders (protection education FIRST — the
 * 058 Layer 2 prominence rule — then judge guidance, then the RED review
 * advisory), the v0.3.87 S4(b) research-assist CONSUMPTION (the dispatch is
 * already extracted: research-assist-dispatch.ts; this site clears the
 * pending trigger and archives/consumes the needsResearch entries), the
 * frozen-RED STOP section, the Tier-0 own-leak revert section, the attempt
 * budget reminder (attempt ≥2 with the last two failure signatures), the
 * RC3 prior-progress continuation block (predecessor attempts' on-disk
 * work — the 24-implementer-calls lesson), the §D prior-iteration seed,
 * the gate-failure / deliverables / coverage / claimed-not-changed / hollow
 * retry sections, and the redImplementContext tail.
 *
 * THE SHAPE: a prompt BUILDER with one dispatch (the assist). Returns the
 * joined prompt + the three consume flags; the CALLER owns the lets
 * (clear-after-consume is the caller's, exactly as inline's in-place
 * `= ""` assignments were — unobservable: no reader exists between the
 * module's return and the caller's clears).
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { buildImplementPrompt } from "../../prompts.ts";
import { implementationRetrySection } from "./red-evidence.ts";
import { dispatchResearchAssist } from "./research-assist-dispatch.ts";
import { redImplementContext } from "./phase-reentry.ts";
import { gitStatusPaths } from "./red-evidence.ts";
import { isHarnessBookkeepingPath } from "../../tracking.ts";
import { coverageThreshold } from "../../build-runner/coverage-gate.ts";
import type { RedStatus } from "../../build-runner.ts";
import type { NeedsResearchEntry, ResearchAssistGreenTrigger, ResearchAssistRedArm } from "../research-assist.ts";

export interface ImplementerPromptInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields. */
	setup: Parameters<typeof buildImplementPrompt>[0];
	worktreePath: string;
	specDirectory: string;
	phaseId: string;
	phaseName: string;
	attempt: number;
	phase: Parameters<typeof buildImplementPrompt>[2]; // the caller passes its phase value directly (N3: no cast needed)
	/** The specialist value (language instructions). */
	specialist: Parameters<typeof buildImplementPrompt>[3];
	/** RED state for the context tail. */
	redStatus: RedStatus;
	testFiles: string[];
	/** The advisory riders (consumed when truthy — the caller clears). */
	protectionEducation: string;
	judgeGuidance: string;
	redWeaknessAdvisory: string;
	/** The research-assist state. */
	redAssistArmed: Record<string, ResearchAssistRedArm>;
	researchAssistPending: ResearchAssistGreenTrigger | null;
	phaseResearchAssistUsed: Record<string, true>;
	needsResearchArchive: NeedsResearchEntry[];
	/** Retry feedback inputs. */
	attemptErrors: string[];
	missingDeliverables: string[];
	claimedNotChanged: string[];
	hollowFiles: string[];
	coverageGap: string[];
	attemptProgressHistory: Array<{ failure: string }>;
	runStartDirt: string[];
	acceptedRedChangedFiles: string[];
	lastFailures: Array<{ phaseId: string; reasons: string[] }>;
}

export interface ImplementerPromptResult {
	/** The joined corrective prompt for this implementer round. */
	implPrompt: string;
	/** The consume flags — the caller clears the corresponding lets. */
	consumedProtectionEducation: boolean;
	consumedJudgeGuidance: boolean;
	consumedRedWeaknessAdvisory: boolean;
	consumedResearchAssistPending: boolean;
}

/**
 * Assemble the implementer round's corrective prompt. `await` is required
 * (the research-assist dispatch). Never throws on the assembly paths.
 */
export async function assembleImplementerPrompt(input: ImplementerPromptInput): Promise<ImplementerPromptResult> {
	const { ctx, state, setup, worktreePath, specDirectory, phaseId, phaseName, attempt, phase, specialist, redStatus, testFiles, protectionEducation, judgeGuidance, redWeaknessAdvisory, redAssistArmed, researchAssistPending, phaseResearchAssistUsed, needsResearchArchive, attemptErrors, missingDeliverables, claimedNotChanged, hollowFiles, coverageGap, attemptProgressHistory, runStartDirt, acceptedRedChangedFiles, lastFailures } = input;
	// Feed the previous attempt's REAL build/test errors into this attempt
	// so the implementer fixes the specific failures instead of resampling,
	// and surface the verified RED status so the green-phase agent knows
	// whether the tests are CONFIRMED-red or unverified.
	const basePrompt = buildImplementPrompt(setup, state.classify ?? null, phase, specialist, state.spec ?? null);
	const implParts: string[] = [basePrompt];
	let consumedProtectionEducation = false;
	let consumedJudgeGuidance = false;
	let consumedRedWeaknessAdvisory = false;
	// Wave 3 D-B (058 Layer 2): the protection education rides FIRST — a
	// reverted protected-path edit is the same prominence class as the
	// frozen-RED stop block below (the implementer must see it before any
	// other retry guidance).
	if (protectionEducation) {
		implParts.push(protectionEducation);
		consumedProtectionEducation = true;
	}
	if (judgeGuidance) {
		implParts.push(judgeGuidance);
		consumedJudgeGuidance = true;
	}
	if (redWeaknessAdvisory) {
		implParts.push(`\n## RED review advisory\n${redWeaknessAdvisory}`);
		consumedRedWeaknessAdvisory = true;
	}
	// ── v0.3.87 S4(b) (§9, §10 decision 9, §14 ADR 6): engine-mediated
	// research assist — the hybrid trigger is CONSUMED here, immediately
	// before the implementer call (report-always-accompanies-execution: the
	// dispatched ResearchAssistData renders into THIS attempt's corrective
	// block; never report-only — a dispatched assist always has this very
	// attempt right after it). RED side: armed by a terminal
	// RED-generation failure (≥ RESEARCH_ASSIST_RED_TRIGGER_TRIES) in a
	// prior §D pass. GREEN side: pending from faultClassStreak ≥ 2 this
	// pass. tdd-guide gets NO assist (implementer-only v1, ADR 6). Per-phase
	// cap 1 (P8); the dispatch consumes the archived needsResearch entries
	// (enrichment — surfaced in the ledger row's enrichedByNeedsResearch).
	{
		const assist = await dispatchResearchAssist({ ctx, specDirectory, phaseId, phaseName, attempt, redAssistArmed, researchAssistPending, phaseResearchAssistUsed, needsResearchArchive, testFiles });
		if (assist.block) {
			// consumed — the entries surfaced in the ledger row (enrichedByNeedsResearch) once used
			needsResearchArchive.length = 0;
			implParts.push(assist.block);
		}
	}
	// Forceful, prominent retry feedback when the PRIOR attempt edited a
	// confirmed RED test file during GREEN (a contract violation — even a
	// comment-only edit is detected and restored). Placed FIRST so the
	// implementer sees it before any other retry guidance.
	if (attemptErrors.some((e) => e.startsWith("tdd-tests-modified-during-green"))) {
		implParts.push(implementationRetrySection("STOP editing the test files — they are READ-ONLY during GREEN", {
			phase: phaseId,
			attempt,
			gate: "post-red-oracle",
			location: "confirmed RED test files",
			observed: "the previous GREEN attempt EDITED one or more confirmed RED test files. Any change — even a comment or header — is rejected and was RESTORED from the confirmed RED snapshot, so the edit had no effect.",
			expected: "the confirmed RED test files remain byte-for-byte unchanged; only production/source code is modified",
			missing: [],
			nextAction: "Do NOT create, edit, or modify ANY test file — not even a comment, import, or header. The test files are the frozen RED oracle that judges your implementation. Implement ONLY production/source code (the module under test) to make the existing tests pass. If a test looks stale or wrong, that is the RED phase's job — leave the test file untouched.",
		}));
	}
	// v0.3.85 F2 Tier 0: the previous attempt's own-leak revert — the retry
	// must know the undeclared out-of-scope edit was rolled back and that
	// the fix belongs INSIDE the declared scope (the declared-amendment
	// route is the escape for genuinely-needed scope changes).
	if (attemptErrors.some((e) => e.startsWith("inherited-red-own-leak-reverted:"))) {
		const reverted = attemptErrors.filter((e) => e.startsWith("inherited-red-own-leak-reverted:")).map((e) => e.slice("inherited-red-own-leak-reverted:".length).trim());
		implParts.push(implementationRetrySection("Out-of-scope own-leak REVERTED (inherited-red Tier 0)", {
			phase: phaseId,
			attempt,
			gate: "inherited-red-tier0",
			location: "undeclared out-of-scope edits",
			observed: `the engine reverted ${reverted.length} undeclared out-of-scope path(s): ${reverted.join(", ")} — an out-of-scope subject that passes at baseline broke, and with a tree clean at phase start the break is attributable to this phase's own edits`,
			expected: "only the phase's declared clause files (and the confirmed RED test files) change",
			missing: reverted,
			nextAction: "Redo the fix INSIDE the declared scope. If an out-of-scope file genuinely must change, that is a declared amendment (spec change) — report it as a blocker in your summary instead of editing the file.",
		}));
	}
	// v0.3.0 budget reminder (Codex rollout_budget / alatirok model): the
	// budget is MODEL-VISIBLE context, not a hidden fuse — from attempt 2
	// the implementer sees its attempt number, the repeating failure
	// signatures, and the explicit instruction to change strategy when
	// evidence repeats. (Placed after the RED-violation warning, which is
	// documented as FIRST — review code-F6.)
	if (attempt >= 2) {
		const recentSigs = attemptProgressHistory.slice(-2).map((h) => h.failure.slice(0, 140));
		implParts.push(`\n## Attempt budget — attempt ${attempt}\nThis is your attempt #${attempt} for this phase; attempts are budget-limited.${recentSigs.length ? `\nPrevious failure signatures (most recent last):\n${recentSigs.map((x) => `- ${x}`).join("\n")}` : ""}\nIf the evidence above repeats your last failure, DO NOT retry the same strategy — diagnose the root cause, or report the blocker explicitly in your summary (testDefects) instead of burning the remaining budget.`);
	}
	// v0.3.43 RC3 (continuation): retries used to cold-restart — a fresh
	// implementer re-read the whole repo while its predecessor's finished
	// work sat invisible on disk (measured: 24 implementer calls for 6
	// phases on run 2026-08-30T08-30-00; the post-timeout attempts that
	// finished in 2-4 min were the ones that happened to notice the disk
	// state). Surface the prior attempts' ACTUAL on-disk progress so the
	// next attempt continues instead of re-deriving.
	if (attempt >= 2) {
		const priorProgress = Array.from(gitStatusPaths(worktreePath))
			.filter((p0: string) => !isHarnessBookkeepingPath(p0) && !runStartDirt.includes(p0) && !testFiles.includes(p0) && !acceptedRedChangedFiles.includes(p0));
		if (priorProgress.length > 0) {
			implParts.push(`\n## PRIOR ATTEMPT PROGRESS — continue, do NOT restart\n${priorProgress.length} production path(s) are ALREADY modified/created on disk by your predecessor attempt(s):\n${priorProgress.slice(0, 24).map((p0) => `- ${p0}`).join("\n")}${priorProgress.length > 24 ? `\n- … (+${priorProgress.length - 24} more)` : ""}\nInspect THESE FIRST with targeted reads (head/diff), then finish or fix the remaining gate failures. Do NOT re-derive the design or rewrite files that already carry your predecessor's work — your job is to COMPLETE the phase, not redo it. Files not in this list are unchanged and need no re-reading.`);
		}
	}
	// §D: seed attempt 1 with the PRIOR convergence iteration's failure reasons
	// so re-attempts target the real failures instead of resampling.
	if (attempt === 1) {
		const priorFail = lastFailures.find((f) => f.phaseId === phaseId);
		if (priorFail?.reasons.length) {
			implParts.push(implementationRetrySection("Prior convergence-iteration failures — fix these", {
				phase: phaseId,
				attempt,
				gate: "prior-convergence-iteration",
				location: "previous implementation convergence pass",
				observed: "this phase failed in the prior convergence pass",
				expected: "phase reaches green with build, deliverable, change, symbol, and post-RED gates satisfied",
				missing: priorFail.reasons,
				nextAction: "Fix these carried-forward blockers before reporting implementation complete.",
			}));
		}
	}
	if (attemptErrors.filter((e) => !/^deliverable:\s*missing (test|scenario):/i.test(e)).length) {
		implParts.push(implementationRetrySection("Previous attempt failed the build/test gate — fix these", {
			phase: phaseId,
			attempt,
			gate: "implementation-gates",
			location: "previous GREEN attempt",
			observed: "the prior implementation attempt did not satisfy all phase gates",
			expected: "all deterministic build/test and phase gates pass",
			// Exclude `deliverable: missing test:` — the implementer is forbidden
			// from authoring RED tests; those route back to RED regeneration, so
			// asking for them here is the forbidden action (deadlock root cause).
			missing: attemptErrors.filter((e) => !/^deliverable:\s*missing (test|scenario):/i.test(e)),
			nextAction: "Make a targeted code or test-support change for these exact failures, then run the relevant checks before calling structured_output.",
		}));
	}
	// AND-semantics (AC-03 → SCENARIO-012): when a previous attempt was
	// build-green but its DELIVERABLE CONTRACT was unmet, the exhaustive
	// `missing` list is injected here so the implementer creates the files /
	// does the wiring / adds the named tests instead of resampling.
	if (missingDeliverables.filter((e) => !/^missing (test|scenario):/i.test(e)).length) {
		implParts.push(implementationRetrySection("Deliverables still missing — create/wire these", {
			phase: phaseId,
			attempt,
			gate: "deliverable-check",
			location: "phase deliverable contract",
			observed: "the prior attempt built but did not satisfy declared non-test deliverables",
			expected: "every required file, pattern, and forbidden-pattern removal exists in the owning module",
			missing: missingDeliverables.filter((e) => !/^missing (test|scenario):/i.test(e)),
			nextAction: "Create, wire, or rename the missing deliverables directly. Do NOT create or edit test files — required tests are authored by the RED phase. Do not claim completion until this list is empty.",
		}));
	}
	// spec-11 AC-07 (SCENARIO-015): a previous attempt claimed a file git did
	// NOT show changed — feed the specific paths so the implementer actually
	// creates/wires them instead of resampling. Mirrors the deliverables block
	// above and is bounded by the global run budget plus no-progress detection
	// in the surrounding attempt loop.
	// v0.3.49: a previous attempt was green on every other gate but BELOW the
	// coverage hard floor — inject the exact per-file numbers so the
	// implementer writes targeted tests for the uncovered behavior instead
	// of resampling. Test files are exempt (they are authored by RED, and
	// the phase's production files are what the floor gates).
	if (coverageGap.length) {
		implParts.push(implementationRetrySection("Coverage below the hard floor — add tests for uncovered behavior", {
			phase: phaseId,
			attempt,
			gate: "phase-coverage",
			location: "deterministic coverage measurement on phase production files",
			observed: "the previous attempt passed every functional gate but the measured line coverage is below the hard floor",
			expected: `≥${coverageThreshold()}% lines across the phase's production files (aim for 100% on pure logic)`,
			missing: coverageGap,
			nextAction: "Write additional unit tests for the UNCOVERED behavior in the listed files (new test files you author in THIS retry are allowed and expected — unlike RED tests, coverage tests are additive). Do NOT weaken or delete existing assertions to raise the number.",
		}));
	}
	if (claimedNotChanged.length) {
		implParts.push(implementationRetrySection("Claimed changes not present in git — actually create/wire these", {
			phase: phaseId,
			attempt,
			gate: "change-check",
			location: "git actual-vs-claimed change set",
			observed: "the implementer claimed files that git did not show as changed",
			expected: "claimed files are actually created, modified, or deleted in the worktree",
			missing: claimedNotChanged,
			nextAction: "Actually create or modify these paths, or remove them from the claimed change set if no project edit is needed.",
		}));
	}
	if (hollowFiles.length) {
		implParts.push(implementationRetrySection("Hollow deliverable files — write the actual implementation", {
			phase: phaseId,
			attempt,
			gate: "symbol-check",
			location: "claimed source deliverables",
			observed: "these files exist but contain only comments or no real code symbols",
			expected: "claimed source deliverables contain real functions, types, handlers, or other executable implementation symbols",
			missing: hollowFiles,
			nextAction: "Write the actual implementation in each file instead of placeholder comments or empty shells.",
		}));
	}
	implParts.push(redImplementContext(redStatus));
	return {
		implPrompt: implParts.join("\n\n"),
		consumedProtectionEducation,
		consumedJudgeGuidance,
		consumedRedWeaknessAdvisory,
		consumedResearchAssistPending: true, // consumed either way (a pending GREEN trigger never outlives the attempt it targets)
	};
}
