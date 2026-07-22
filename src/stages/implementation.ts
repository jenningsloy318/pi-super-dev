/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * up to 3 attempts of TDD-write → implement → build-gate; commits on green.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import type { ControlObj, Stage } from "../types.ts";
import { getActiveTracker } from "../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../tracking.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, rustDiscipline } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { normalizePhases } from "../doc-validators.ts";
import { computeChangeGate, deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, runDeliverableCheck, runRedCheck, type DeliverableContract, type GateOptions, type RedStatus } from "../build-runner.ts";

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

/** Parse the implementer/fixer's claimed change set (spec-11 AC-06 →
 *  SCENARIO-011/012). Accepts the STRUCTURED `{filesCreated, filesModified,
 *  filesDeleted}` shape AND back-tolerates the legacy flat `filesModified`
 *  array by reading it into `filesModified` (created/deleted empty).
 *
 *  NEVER throws (the implementer control is untrusted agent output):
 *   - null/undefined/non-object/array control → empty StructuredChanges.
 *   - a bucket whose value is not an array collapses that bucket to empty.
 *   - non-string entries within a bucket array are dropped (defensive).
 *  The gate reads `claimedNotChanged` off `(claimed.created ∪ claimed.modified)`
 *  so a legacy flat `filesModified` is cross-checked exactly like a structured
 *  modified set (no migration gap). */
export function parseStructuredChanges(control: unknown): StructuredChanges {
	const empty: StructuredChanges = { filesCreated: [], filesModified: [], filesDeleted: [] };
	if (control == null || typeof control !== "object" || Array.isArray(control)) {
		return empty;
	}
	const obj = control as Record<string, unknown>;
	const pickStrings = (key: string): string[] => {
		const v = obj[key];
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	};
	return {
		filesCreated: pickStrings("filesCreated"),
		filesModified: pickStrings("filesModified"),
		filesDeleted: pickStrings("filesDeleted"),
	};
}

/** Normalize an agent-returned array field into a genuine `string[]`.
 *  Agents unreliably return array-typed control fields as a bare string, an
 *  object, a number, or null/undefined (the same shape-drift that
 *  `normalizePhases` defends against for `spec.phases`). A bare `?? []` only
 *  catches null/undefined — a string value sails through and later `.join()` /
 *  spread / iteration crashes (`testFiles.join is not a function`). This helper
 *  coerces defensively: array → string-filtered; bare string → `[v]`; else []. */
export function normalizeStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v === "string" && v.trim()) return [v.trim()];
	return [];
}

// §D auto-iterate convergence loop — per-phase green state + failure reasons
// carried across outer iterations (the loop in stages/index.ts re-runs this
// stage until allGreen). Without these, a re-run would re-attempt GREEN phases
// (state-confusion churn); with them, green phases are skipped and a failed
// phase's prior-iteration reasons are seeded into its next attempt 1.
export interface PhaseStatusEntry {
	id: string;
	status: "green" | "failed";
}
export interface PhaseFailureEntry {
	phaseId: string;
	reasons: string[];
}
export function phaseStatusUpsert(arr: PhaseStatusEntry[], id: string, status: "green" | "failed"): void {
	const i = arr.findIndex((p) => p.id === id);
	if (i >= 0) arr[i] = { id, status };
	else arr.push({ id, status });
}
export function lastFailuresUpsert(arr: PhaseFailureEntry[], phaseId: string, reasons: string[]): void {
	const i = arr.findIndex((f) => f.phaseId === phaseId);
	if (i >= 0) arr[i] = { phaseId, reasons };
	else arr.push({ phaseId, reasons });
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
		// §D auto-iterate: carry per-phase green state + failure reasons from the
		// PRIOR convergence iteration (state.implementation holds the last run's
		// control). Green phases are skipped; a failed phase's prior reasons seed
		// its next attempt 1 so iteration 2 targets the real failures.
		const priorImpl = (state.implementation ?? {}) as { phaseStatus?: PhaseStatusEntry[]; lastFailures?: PhaseFailureEntry[] };
		const phaseStatus: PhaseStatusEntry[] = Array.isArray(priorImpl.phaseStatus) ? priorImpl.phaseStatus.map((p) => ({ ...p })) : [];
		const lastFailures: PhaseFailureEntry[] = Array.isArray(priorImpl.lastFailures) ? priorImpl.lastFailures.map((f) => ({ ...f, reasons: [...f.reasons] })) : [];
		if (phaseStatus.length) ctx.log(`Implementation: resuming convergence iteration (${phaseStatus.filter((p) => p.status === "green").length}/${phases.length} phases already green)`);
		let phasesCompleted = 0;
		let allGreen = true;
		const filesModified: string[] = [];

		for (const [idx, phase] of phases.entries()) {
			const phaseId = `phase-${pad(idx + 1)}`;
			// §D: skip a phase already green in a prior convergence iteration (don't
			// re-touch done work — the state-confusion churn §F fought).
			if (phaseStatus.some((p) => p.id === phaseId && p.status === "green")) {
				phasesCompleted++;
				ctx.log(`Implementation ${phaseId} already green (prior convergence iteration) — skipping`);
				continue;
			}
			let green = false;
			let attemptErrors: string[] = [];
			// AND-semantics (AC-03 → SCENARIO-011..015): the missing DELIVERABLE entries
			// from the previous attempt, fed into the next implementer retry under a
			// `## Deliverables still missing — create/wire these` block. Resets each
			// attempt, mirroring `attemptErrors = gate.errors`.
			let missingDeliverables: string[] = [];
			// spec-11 AC-07 (SCENARIO-015): the change-gate's `claimedNotChanged` from
			// the previous attempt — claimed files git did NOT show changed — fed into
			// the next implementer retry under a `## Claimed changes not present in git`
			// block. Resets each attempt, mirroring `missingDeliverables`.
			let claimedNotChanged: string[] = [];
			// Phase bracketing (spec-11 Phase 3, AC-04 → SCENARIO-008/009): snapshot the
			// git baseline BEFORE the attempts so each per-attempt `tracker.end`
			// computes the delta from phase start; the change-gate reads the freshest
			// end-record. Never throws (tracker contract); no-op when no tracker active.
			const tracker = getActiveTracker();
			// §F #1 — pre-implement no-op detection (the state-confusion root cause):
			// if this is a RESUME run (re-running over work a prior run already did)
			// AND this phase DECLARES deliverables that are ALREADY satisfied, SKIP the
			// implementer instead of re-touching done work and breaking it (systemic
			// across 10+ runs — implementers said "implementation appears to already
			// exist" then churned). Resume-gated so it NEVER interferes with a fresh
			// run's per-attempt deliverable sequencing (the within-run, non-resume
			// no-op is deferred — it needs the test stubs redesigned to model
			// phase-start vs post-implementer state). Conservative: skips ONLY when
			// deliverables are declared AND pass; the final pre-merge build gate
			// still verifies the whole build.
			const phaseDeliverables = (phase as { deliverables?: DeliverableContract }).deliverables;
			if (phaseDeliverables && deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables)) {
				ctx.log(`Implementation ${phaseId} no-op: deliverables already satisfied (files/patterns present) — skipping implementer`);
				phasesCompleted++;
				continue;
			}
			// Pi-native sub-phase subtitle: announce WHICH phase is being implemented
			// AFTER the skip guards (so a skipped/already-green phase never flickers a
			// subtitle it isn't working on). Surfaces "Phase N/M: <name>" as the
			// dashboard header/working-message + a distinct ▶ line under the running
			// stage's live-log section. phase.name falls back to the phase id.
			const phaseName = (phase as { name?: string }).name?.trim() || phaseId;
			ctx.phase(`Implementation — Phase ${idx + 1}/${phases.length}: ${phaseName}`);
			if (tracker) tracker.begin("phase", phaseId);
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
				let testFiles = normalizeStringArray((tdd.control as { testFiles?: unknown } | null)?.testFiles);
				let redStatus: RedStatus = runRedCheck(setup.worktreePath, testFiles, { signal: ctx.signal });
				let retries = 0;
				ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
				while ((redStatus === "green" || redStatus === "broken") && retries < MAX_RED_RETRIES) {
					retries++;
					const retry = await ctx.agent({ id: `pipeline.implementation.${phaseId}.tdd.red${retries}.a${attempt}`, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n")) + redRePromptHint(redStatus) });
					const retryFilesRaw = (retry.control as { testFiles?: unknown } | null)?.testFiles;
				testFiles = retryFilesRaw == null ? testFiles : normalizeStringArray(retryFilesRaw);
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
				// §D: seed attempt 1 with the PRIOR convergence iteration's failure reasons
				// so re-attempts target the real failures instead of resampling.
				if (attempt === 1) {
					const priorFail = lastFailures.find((f) => f.phaseId === phaseId);
					if (priorFail?.reasons.length) {
						implParts.push(`## Prior convergence-iteration failures — fix these\n${priorFail.reasons.map((r) => `- ${r}`).join("\n")}`);
					}
				}
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
				// spec-11 AC-07 (SCENARIO-015): a previous attempt claimed a file git did
				// NOT show changed — feed the specific paths so the implementer actually
				// creates/wires them instead of resampling. Mirrors the deliverables block
				// above and is bounded by MAX_ATTEMPTS via the surrounding attempt loop.
				if (claimedNotChanged.length) {
					implParts.push(`## Claimed changes not present in git — actually create/wire these\n${claimedNotChanged.map((e) => `- ${e}`).join("\n")}`);
				}
				implParts.push(redImplementContext(redStatus, capExhausted));
				const implPrompt = implParts.join("\n\n");
				const impl = await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: implPrompt });
				// spec-11 AC-06/AC-10: the implementer's claimed change set is now STRUCTURED
				// ({filesCreated, filesModified, filesDeleted}). parseStructuredChanges reads
				// it (and back-tolerates the legacy flat filesModified array). The flat
				// summary list derives from filesCreated ∪ filesModified — deleted is
				// EXCLUDED (a deleted file is not a "modified" display entry). dedupe via
				// the existing `filesModified.includes` guard (first-seen order preserved).
				const structured = parseStructuredChanges(impl.control);
				for (const f of [...structured.filesCreated, ...structured.filesModified]) {
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
				// spec-10 deliverable bridge (AC-09 → SCENARIO-018): UNION the implementer's
				// `claimed.filesCreated` into the spec-declared `requireFiles` so a file a
				// phase CLAIMS to have created MUST also exist (tracking + deliverable
				// assertions reinforce). Deduped UNION (first-seen order); the spec-declared
				// contract is preserved verbatim — an omitted spec-required file is still
				// caught independently (no circular double-count, SCENARIO-018b/018c).
				const baseDeliverables = (phase.deliverables ?? {}) as DeliverableContract;
				const bridgedDeliverables: DeliverableContract = {
					...baseDeliverables,
					// Deduped UNION preserving first-seen order (Set iteration is insertion
					// order, first occurrence wins) — inlined so the stage does not depend
					// on an un-mocked build-runner export (the bridge is pure data prep).
					requireFiles: Array.from(new Set([
						...(baseDeliverables.requireFiles ?? []),
						...structured.filesCreated,
					])),
				};
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: !buildGreen });
				missingDeliverables = deliverableCheck.missing;
				ctx.log(`Implementation ${phaseId} deliverable-check ${deliverableCheck.pass ? "PASS" : "FAIL"} (missing: ${deliverableCheck.missing.join("; ") || "none"}; ran: ${deliverableCheck.ran.join(", ") || "none"})`);
				// Git cross-check GATE (AC-07, AC-08 → SCENARIO-013/014/015/016/017):
				// snapshot the phase's actual-vs-claimed delta per-attempt (so a retry that
				// wires the claimed file flips the verdict, SCENARIO-015), then collapse it
				// into a boolean gate verdict AND-ed into phase-green. NEVER throws and
				// degrades to a pass when git is unavailable (SCENARIO-017) — never block
				// on infrastructure. No tracker / never ended → null record → trivial pass.
				let phaseChangeRec: ChangeRecord | null = null;
				if (tracker) {
					// Per-attempt PROBE (compute + store, no jsonl append) so the retry
					// injection sees the freshest claimedNotChanged (SCENARIO-015).
					// The bracket is closed EXACTLY ONCE via commitEnd after the attempt
					// loop so the jsonl trace keeps single begin/end-per-phase nesting
					// (AC-04 → SCENARIO-008/009, review finding CR-MED).
					phaseChangeRec = tracker.probeEnd("phase", phaseId, structured);
				}
				const changeGate = computeChangeGate(phaseChangeRec);
				// Advisory-only (SCENARIO-014): files git shows changed that the agent did
				// NOT report (under-reporting) are surfaced via ctx.log but NEVER fail the
				// gate — under-reporting is not a false-green.
				const advisory = phaseChangeRec?.crossCheck?.changedNotClaimed ?? [];
				if (advisory.length) {
					ctx.log(`Implementation ${phaseId} advisory: ${advisory.length} changed-not-claimed file(s): ${advisory.join(", ")}`);
				}
				// Evidence (AC-10 → SCENARIO-019): the ground-truth actual change counts
				// surfaced as a concise `📝 N files changed (C/M/D)` line.
				const ga = phaseChangeRec?.gitActual ?? null;
				if (ga) {
					const c = ga.created?.length ?? 0;
					const m = ga.modified?.length ?? 0;
					const d = ga.deleted?.length ?? 0;
					ctx.log(`Implementation ${phaseId} 📝 ${c + m + d} files changed (${c}C/${m}M/${d}D)`);
				}
				claimedNotChanged = changeGate.claimedNotChanged;
				// In-scope verdict (AC-05 → SCENARIO-012/013/014/025/027): the phase is GREEN
				// when the gate fully passed OR when every failure is a pre-existing
				// out-of-scope crate the branch never touched (gate.inScopePass). The
				// `if (!green)` branch below therefore fires ONLY on genuine in-scope
				// failures — neither pass nor inScopePass after MAX_ATTEMPTS — so
				// pre-existing breakage elsewhere can no longer abort green in-scope work.
				// spec-11 AC-07/AC-08 (SCENARIO-013): AND `changeGate.pass` so a
				// claimed-but-never-changed file hard-fails EVEN WHEN build + deliverable
				// both pass (the false-green killer, closed a second way).
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass) {
					green = true;
					phaseStatusUpsert(phaseStatus, phaseId, "green");
					const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
					if (gate.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
					}
					break;
				}
				ctx.log(`Implementation ${phaseId} attempt ${attempt}/${MAX_ATTEMPTS} FAIL: ${[...gate.errors, ...missingDeliverables.map((e) => `deliverable: ${e}`)].join("; ") || "deliverables unmet"}`);
			}
			// Close the phase bracket EXACTLY ONCE after the attempt loop: the
			// per-attempt probeEnd calls above computed the freshest cross-check
			// without appending; commitEnd persists that final record as the
			// single `end` jsonl line (single begin/end-per-phase nesting,
			// AC-04 → SCENARIO-008/009, review finding CR-MED). Never throws.
			if (tracker) tracker.commitEnd("phase", phaseId);
			if (!green) {
				// §D: record the failure so the next convergence iteration targets it
				phaseStatusUpsert(phaseStatus, phaseId, "failed");
				lastFailuresUpsert(lastFailures, phaseId, [...attemptErrors, ...missingDeliverables.map((e) => `deliverable: ${e}`), ...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`)]);
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
			phaseStatus,
			lastFailures,
			summary: allGreen ? `All ${phases.length} phases completed successfully` : `${phasesCompleted}/${phases.length} phases completed`,
		};
		if (ctx.budget.check()) {
			const summaryResult = await ctx.agent({ id: "pipeline.implementation.summary", agent: "orchestrator", prompt: buildImplementationSummaryPrompt(setup, state.classify ?? null, control), schema: STAGE_MODELS["implementationSummary"]?.schema });
			renderAndWrite(setup, (m) => ctx.log(m), "implementationSummary", summaryResult.control as Record<string, unknown> | null);
		}
		return control;
	},
};
