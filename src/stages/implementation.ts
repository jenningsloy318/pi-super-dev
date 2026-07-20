/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * up to 3 attempts of TDD-write → implement → build-gate; commits on green.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import type { ControlObj, Stage } from "../types.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, rustDiscipline } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { normalizePhases } from "../doc-validators.ts";
import { resetDeliverableCheckCache, runBuildGate, runDeliverableCheck, runRedCheck, type GateOptions, type RedStatus } from "../build-runner.ts";

const MAX_ATTEMPTS = 3;
/** Per-attempt cap on RED-oracle re-prompts of the tdd-guide agent when the
 *  RED phase is NOT yet confirmed (green/broken). Bounds the worst-case cost
 *  per phase at `≤2 tdd-guide + ≤2 red-check + 1 implementer + 1 build-gate`
 *  (spec §B, AC-02 → SCENARIO-007/009). Mirrors `MAX_ATTEMPTS` — no new config. */
const MAX_RED_RETRIES = 2;
const pad = (n: number) => String(n).padStart(2, "0");

/** Status-specific re-prompt hint appended to the tdd-guide prompt when the RED
 *  oracle reports a NON-red status (green/broken), nudging the agent toward a
 *  test that GENUINELY fails against the unimplemented behavior instead of
 *  resampling the same passing/broken shape (spec §B → SCENARIO-007). */
function redRePromptHint(status: RedStatus): string {
	if (status === "green") {
		return "\n\nYour tests PASSED already; the goal of the RED phase is a test that GENUINELY fails against the unimplemented behavior. Rewrite the test so it fails for the right reason before the production code exists.";
	}
	if (status === "broken") {
		return "\n\nYour tests did not compile/collect (the RED oracle saw a build/collection error). Fix the test so it RUNS and then FAILS against the unimplemented behavior.";
	}
	return "";
}

/** Context line appended to the implementer prompt so the green-phase agent
 *  knows the verified RED status. SCENARIO-006 (red → CONFIRMED-red),
 *  SCENARIO-008 (unknown → could not confirm), SCENARIO-009 (cap-exhausted).
 *  The CONFIRMED-red marker appears ONLY on a verified `red` so the green-phase
 *  agent treats genuinely-failing tests as its goal. */
function redImplementContext(status: RedStatus, capExhausted: boolean): string {
	if (status === "red") {
		return "The TDD tests are CONFIRMED-red; your goal is to make them green.";
	}
	if (capExhausted) {
		return `The TDD red status could not be confirmed after ${MAX_RED_RETRIES} retries (still ${status}) — proceeding; red was not verified.`;
	}
	// unknown — red could not be determined at all (e.g. greenfield: no test runner).
	return "The TDD red status could not be confirmed (status: unknown) — proceeding; red was not verified.";
}

/**
 * Extract referenced crate names from error blocks for the IN-SCOPE GREEN log
 * (AC-05 → SCENARIO-012/025). Reuses the same two markers as the build-gate's
 * `classifyOutOfScopeErrors`: (a) `crates/<pkg>/` path markers and (b) cargo
 * `-p <pkg>` markers. De-duplicates while preserving first-seen order.
 */
function cratesFromErrors(errors: string[]): string[] {
	const crates: string[] = [];
	const pathRe = /crates\/([^/]+)\//g;
	const pkgRe = /(?:^|\s)-p\s+(\S+)/g;
	for (const block of errors) {
		let m: RegExpExecArray | null;
		pathRe.lastIndex = 0;
		while ((m = pathRe.exec(block))) crates.push(m[1]);
		pkgRe.lastIndex = 0;
		while ((m = pkgRe.exec(block))) crates.push(m[1]);
	}
	return Array.from(new Set(crates));
}

export const implementationStage: Stage = {
	id: "implementation",
	label: "Stage 9 — Implementation",
	async run(state, ctx) {
		// Defensively normalize: agents sometimes return `phases` as a string or
		// object instead of an array, which crashed `phases.entries()` (Stage 9:
		// "phases.entries is not a function"). Never trust the control shape.
		const phases = normalizePhases(state.spec?.phases);
		if (!Array.isArray(state.spec?.phases) && state.spec?.phases != null) {
			ctx.log(`Implementation: spec.phases was ${typeof state.spec.phases}, expected an array — normalized to ${phases.length} phase(s)`);
		}
		if (phases.length === 0) {
			ctx.log("Implementation: no phases defined in spec — skipping");
			return { phasesCompleted: 0, totalPhases: 0, allGreen: false };
		}
		const setup = state.setup!;
		let phasesCompleted = 0;
		let allGreen = true;
		const filesModified: string[] = [];

		for (const [idx, phase] of phases.entries()) {
			const phaseId = `phase-${pad(idx + 1)}`;
			let green = false;
			let attemptErrors: string[] = [];
			// AND-semantics (AC-03 → SCENARIO-011..015): the missing DELIVERABLE entries
			// from the previous attempt, fed into the next implementer retry under a
			// `## Deliverables still missing — create/wire these` block. Resets each
			// attempt, mirroring `attemptErrors = gate.errors`.
			let missingDeliverables: string[] = [];
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				if (!ctx.budget.check()) {
					allGreen = false;
					return { phasesCompleted, totalPhases: phases.length, allGreen, filesModified, summary: "Budget exhausted" };
				}
				const specialist = await ctx.helper({ name: "route-specialist", sources: { "classify-task": state.classify }, options: { phase } });
				const lang = (specialist.value.languageInstructions as string) ?? "";
				// Gap 3 (AC-03 → SCENARIO-010): the RED-phase prompt carries the no-`--lib`
				// Rust verification discipline via the shared `langInstructions` slot so
				// `buildTddPrompt` and `buildImplementPrompt` reference the IDENTICAL
				// `RUST_SELF_VERIFY_DISCIPLINE` source string (single source of truth).
				// For non-rust setups `rustDiscipline(setup)` is "" and the specialist's
				// languageInstructions still flow through (no regression).
				// RED phase (Gap 1b, AC-02 → SCENARIO-006/007/008/009/010): author the
				// tests via tdd-guide and VERIFY they actually fail against the
				// unimplemented behavior. The tdd-guide result is NO LONGER discarded —
				// we read `control.testFiles` and run the deterministic `runRedCheck`
				// oracle (P2). On green/broken we re-prompt tdd-guide (status-specific
				// hint) up to MAX_RED_RETRIES so "TDD" is genuinely red-then-green. On
				// red/unknown we proceed immediately (greenfield cannot stall). Never
				// throws (runRedCheck degrades to `unknown`); never exceeds the cap.
				const tdd = await ctx.agent({ id: `pipeline.implementation.${phaseId}.tdd.a${attempt}`, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n")) });
				let testFiles = (tdd.control as { testFiles?: string[] } | null)?.testFiles ?? [];
				let redStatus: RedStatus = runRedCheck(setup.worktreePath, testFiles, { signal: ctx.signal });
				let retries = 0;
				ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
				while ((redStatus === "green" || redStatus === "broken") && retries < MAX_RED_RETRIES) {
					retries++;
					const retry = await ctx.agent({ id: `pipeline.implementation.${phaseId}.tdd.red${retries}.a${attempt}`, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n")) + redRePromptHint(redStatus) });
					testFiles = (retry.control as { testFiles?: string[] } | null)?.testFiles ?? testFiles;
					redStatus = runRedCheck(setup.worktreePath, testFiles, { signal: ctx.signal });
					ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
				}
				const capExhausted = redStatus === "green" || redStatus === "broken";
				if (capExhausted) {
					ctx.log(`Implementation ${phaseId} red-oracle WARNING: not confirmed-red after ${MAX_RED_RETRIES} retries (status: ${redStatus}) — proceeding`);
				}
				// Feed the previous attempt's REAL build/test errors into this attempt
				// so the implementer fixes the specific failures instead of resampling,
				// and surface the verified RED status so the green-phase agent knows
				// whether the tests are CONFIRMED-red or unverified.
				const basePrompt = buildImplementPrompt(setup, state.classify ?? null, phase, specialist.value, state.spec ?? null);
				const implParts: string[] = [basePrompt];
				if (attemptErrors.length) {
					implParts.push(`## Previous attempt failed the build/test gate — fix these\n${attemptErrors.map((e) => `- ${e}`).join("\n")}`);
				}
				// AND-semantics (AC-03 → SCENARIO-012): when a previous attempt was
				// build-green but its DELIVERABLE CONTRACT was unmet, the exhaustive
				// `missing` list is injected here so the implementer creates the files /
				// does the wiring / adds the named tests instead of resampling.
				if (missingDeliverables.length) {
					implParts.push(`## Deliverables still missing — create/wire these\n${missingDeliverables.map((e) => `- ${e}`).join("\n")}`);
				}
				implParts.push(redImplementContext(redStatus, capExhausted));
				const implPrompt = implParts.join("\n\n");
				const impl = await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: implPrompt });
				for (const f of ((impl.control as { filesModified?: unknown } | null)?.filesModified as string[] | undefined) ?? []) {
					if (!filesModified.includes(f)) filesModified.push(f);
				}
				// HARD test oracle: actually run build/test/typecheck instead of trusting
				// a QA agent's self-report (vacuous-pass risk). Non-fatal when nothing
				// is detectable (greenfield): ran is empty and pass is true.
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
				attemptErrors = gate.errors;
				ctx.log(`Implementation ${phaseId} build-gate ${gate.pass ? "PASS" : "FAIL"} (ran: ${gate.ran.join(", ") || "no commands"})`);
				// DELIVERABLE CONTRACT (AC-03 → SCENARIO-011..015): a build-green phase can
				// deliver NOTHING (a never-created file compiles fine, an unwired call site
				// is still a valid public fn, a dead `_ => {}` router arm passes its own
				// tests). runDeliverableCheck is the never-throwing sibling oracle AND-ed
				// with the gate so the phase is only GREEN when the declared files/contains/
				// not-contains/tests are ALSO satisfied. When phase.deliverables is undefined
				// it early-returns {pass:true} → today's behavior (SCENARIO-014 backward compat).
				// RUN-BOUNDARY RESET (review finding, HIGH): a module-level test-list
				// cache is STALE the instant the implementer adds a test on a retry — the
				// cached list omits the new name and requireTests false-negatives forever,
				// defeating the core retry mechanism. Clearing it before EACH attempt
				// guarantees a FRESH list is spawned (a freshly-added test is seen).
				resetDeliverableCheckCache();
				// SKIP the test-lister when the build gate FAILED (review finding: wasted
				// compile on a broken build + a poisoned cache). The cheap file/contains/
				// not-contains checks still run; only the requireTests spawn is deferred.
				const buildGreen = gate.pass || gate.inScopePass;
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, phase.deliverables, { signal: ctx.signal, skipTests: !buildGreen });
				missingDeliverables = deliverableCheck.missing;
				ctx.log(`Implementation ${phaseId} deliverable-check ${deliverableCheck.pass ? "PASS" : "FAIL"} (missing: ${deliverableCheck.missing.join("; ") || "none"}; ran: ${deliverableCheck.ran.join(", ") || "none"})`);
				// In-scope verdict (AC-05 → SCENARIO-012/013/014/025/027): the phase is GREEN
				// when the gate fully passed OR when every failure is a pre-existing
				// out-of-scope crate the branch never touched (gate.inScopePass). The
				// `if (!green)` branch below therefore fires ONLY on genuine in-scope
				// failures — neither pass nor inScopePass after MAX_ATTEMPTS — so
				// pre-existing breakage elsewhere can no longer abort green in-scope work.
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
					green = true;
					if (gate.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
					}
					break;
				}
				ctx.log(`Implementation ${phaseId} attempt ${attempt}/${MAX_ATTEMPTS} FAIL: ${[...gate.errors, ...missingDeliverables.map((e) => `deliverable: ${e}`)].join("; ") || "deliverables unmet"}`);
			}
			if (!green) {
				ctx.log(`Implementation ${phaseId} failed after ${MAX_ATTEMPTS} attempts — terminating early`);
				allGreen = false;
				break;
			}
			phasesCompleted++;
			if (ctx.budget.check()) {
				await ctx.agent({ id: `pipeline.implementation.${phaseId}.commit`, agent: "orchestrator", prompt: buildCommitPrompt(setup, phase.name) });
			}
		}
		const control: ControlObj = {
			phasesCompleted,
			totalPhases: phases.length,
			allGreen,
			filesModified,
			summary: allGreen ? `All ${phases.length} phases completed successfully` : `${phasesCompleted}/${phases.length} phases completed`,
		};
		if (ctx.budget.check()) {
			const summaryResult = await ctx.agent({ id: "pipeline.implementation.summary", agent: "orchestrator", prompt: buildImplementationSummaryPrompt(setup, state.classify ?? null, control), schema: STAGE_MODELS["implementationSummary"]?.schema });
			renderAndWrite(setup, (m) => ctx.log(m), "implementationSummary", summaryResult.control as Record<string, unknown> | null);
		}
		return control;
	},
};
