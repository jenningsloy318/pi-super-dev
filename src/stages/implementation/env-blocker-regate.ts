/**
 * The environmental-blocker quarantine / re-gate / re-classification —
 * increment 10 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, the first sub-block of the
 * `if (fault.faultClass === "environmental-blocker")` branch): when the fault
 * classifier reads environmental-blocker and FOREIGN pre-phase dirt exists,
 * quarantine it (stash-based, kill-switched, never destructive), consume the
 * phase's single re-gate grant, and re-run the build gate on the cleaned tree:
 *
 *   • re-run GREEN + fresh deliverable check GREEN + reused change/symbol/tdd
 *     evidence green → the phase is GREEN THROUGH the re-run (break)
 *   • re-run still red (or green-but-deliverable-failed) → RE-CLASSIFY on
 *     OBSERVED provenance: post-quarantine, any remaining failure is this
 *     phase's product problem (the run-2026-08-19 lesson — its own quarantine
 *     had manufactured the tsc failures) → product fall-through
 *   • quarantine FAILED (nothing stashed) / kill-switch / grant already spent
 *     → no re-run at all; the judge hand-off (the NEXT increment's region,
 *     still inline in stage.ts) owns routing from these entries
 *
 * THE CONTROL-FLOW CONVERSION (the sixth, after red-judge v0.4.32,
 * research-assist-dispatch v0.4.34, red-review-join v0.4.35,
 * protection-gate v0.4.36, inherited-red-ladder v0.4.37): the block had ONE
 * `break` (the green-through at the old 1931) and TWO fall-throughs (product
 * re-classification; still-blocked → judge). The break became the
 * green-through variant; the fall-throughs collapse into one `blocked`
 * variant carrying what the remaining loop needs — `gate2` (the judge region
 * reads `latestGate = gate2 ?? gate` and the override arm mirrors its errors),
 * the re-classified fault class and post-regate errors (null when unchanged).
 *
 * THE v0.4.33 CROSS-ITERATION LESSON (applied by construction): `blocked`
 * carries `reclassifiedFaultClass`/`postRegateProductErrors` as explicit
 * null-or-value fields the caller assigns ONLY when non-null — a fall-through
 * that re-classified nothing leaves attemptFaultClass and
 * postRegateProductErrors exactly as the inline fall-through left them.
 * In-place state stays in-place: the phase-scoped re-gate grant flips inside
 * the module (regateUsed holder — one grant per phase, surviving attempts);
 * phaseStatusUpsert / lastFailures.splice / the closure announces happen
 * exactly where the inline code did them.
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { classifyGateFault, collectDirtPaths, quarantineDirt, dirtyQuarantineEnabled, appendEnvironmentFault, type FaultClass } from "../../fault-classification.ts";
import { clearBaselineCache } from "../../build-runner/baseline.ts";
import { runBuildGate, runDeliverableCheck, resetDeliverableCheckCache, type BuildGateResult, type DeliverableContract, type GateOptions } from "../../build-runner.ts";
import { appendGateChecked } from "../../runlog.ts";
import { phaseStatusUpsert } from "./phase-status.ts";
import { cratesFromErrors } from "./phase-reentry.ts";

/** The quarantine/re-gate verdict. `green-through` = the old `break`; `blocked`
 *  = every fall-through shape (re-classified product, still-blocked → judge,
 *  no re-run at all). */
export type EnvRegateOutcome =
	| { kind: "green-through"; gateErrors: string[] }
	| {
		kind: "blocked";
		/** The post-quarantine re-run's verdict (null when no re-run ran) — the
		 *  judge hand-off reads `latestGate = gate2 ?? gate` and the override arm
		 *  mirrors its errors. */
		gate2: BuildGateResult | null;
		/** True when the re-run evidence re-classified as NON-environmental —
		 *  the judge hand-off is SKIPPED and the attempt falls to product retry. */
		reRunClassifiedProduct: boolean;
		/** The re-classified class (null = unchanged, keep the classifier's reading). */
		reclassifiedFaultClass: FaultClass | null;
		/** The re-run's errors as the tree's current truth (null = keep gate.errors). */
		postRegateProductErrors: string[] | null;
	};

export interface EnvRegateInput {
	ctx: StageContext;
	state: PipelineState;
	worktreePath: string;
	specDirectory: string;
	copiedEnvFiles: string[];
	defaultBranch: string | undefined;
	phaseId: string;
	attempt: number;
	/** Pre-phase dirt (the quarantine set — foreign only; own dirt is NEVER stashed). */
	foreignDirt: string[];
	/** The run-start dirt set (the OBSERVED-provenance re-classification input). */
	runStartSet: Set<string>;
	/** The exclusion set for the post-quarantine dirt re-inventory (implementer
	 *  footprint ∪ declaredScope ∪ testFiles — the D-7 in-loop exclusions). */
	dirtExclusions: string[];
	/** In/out: the phase-scoped single re-gate grant (consumed ONLY on a
	 *  successful quarantine; a failed quarantine leaves it intact, T4.4). */
	regateUsed: { used: boolean };
	/** The phase's bridged deliverable contract (the fresh post-quarantine check). */
	bridgedDeliverables: DeliverableContract;
	/** Reused own-scope evidence (verdicts remain valid post-quarantine, D-12). */
	ownScope: { changePass: boolean; symbolPass: boolean; tddClean: boolean };
	/** In/out: phase-status rows (green-through upserts in place). */
	phaseStatus: Array<{ id: string; status: string; [k: string]: unknown }>;
	/** In/out: lastFailures rows (green-through splices in place). */
	lastFailures: Array<{ phaseId: string; reasons: string[]; [k: string]: unknown }>;
	/** The phase-status kit closures. */
	announceActivity: (activity?: string, detail?: string) => void;
	emitPhaseStatus: (status: "running" | "ok" | "failed" | "skipped" | "partial") => void;
	attemptDetail: (attempt: number, extra?: string) => string;
}

/**
 * Run the quarantine + re-gate + re-classification. A failed quarantine
 * degrades to the judge route — never fatal (AC-13, the attempt loop's own
 * never-throw rule for quarantine failures); other failures (gate runs,
 * logging) propagate exactly as they did before the extraction.
 */
export async function runEnvBlockerRegate(input: EnvRegateInput): Promise<EnvRegateOutcome> {
	const { ctx, state, worktreePath, specDirectory, copiedEnvFiles, defaultBranch, phaseId, attempt, foreignDirt, runStartSet, dirtExclusions, regateUsed, bridgedDeliverables, ownScope, phaseStatus, lastFailures, announceActivity, emitPhaseStatus, attemptDetail } = input;

	let gate2: BuildGateResult | null = null;
	let latestDeliverableCheck2: ReturnType<typeof runDeliverableCheck> | null = null; // adv-F5: re-run deliverable verdict for re-classification
	if (foreignDirt.length > 0 && dirtyQuarantineEnabled() && !regateUsed.used) {
		announceActivity("Environmental blocker", attemptDetail(attempt));
		// AC-05 (SCENARIO-013 · T3.4): the class + next-action literal for the
		// quarantine arm — substring-pinned in tests (dirt non-empty + switch
		// unset ⇒ next=<quarantine+re-gate>).
		ctx.log(`Implementation ${phaseId} environmental-blocker: out-of-scope-only failures, baseline=regression, own-scope evidence green — class=environment; next=<quarantine+re-gate>`);
		// Recoverable quarantine (D-9/D-10): stash-based only, kill-switched,
		// never destructive — the ONLY worktree mutation is a scoped
		// `git stash push -u -- <paths>`. Stash FOREIGN dirt only; this phase's
		// own undeclared edits (ownDirt) are NEVER stashed: they are live work
		// the retry feedback must name, not state to sweep away.
		const q = quarantineDirt({ worktreePath, paths: foreignDirt, reason: `stage9 environmental-blocker phase ${phaseId}`, log: ctx.log });
		if (q.ok) {
			// PRD ledger record (AC-12): one JSON line, exact key set; never throws.
			appendEnvironmentFault(specDirectory, { kind: "quarantine", paths: foreignDirt, stashRef: q.stashRef, reason: `environmental-blocker phase ${phaseId}` }, ctx.log);
			// Recovery log (AC-10 parity): quarantined paths + stash ref + `git
			// stash pop` + kill-switch in one prominent line (NFR-2).
			ctx.log(`Implementation ${phaseId} quarantined foreign uncommitted state — paths: ${foreignDirt.join(", ")} (foreign pre-phase dirt only — this-phase edits are never stashed); stash ref: ${q.stashRef ?? "(unresolved)"}; recover with: git stash pop; kill-switch: SUPER_DEV_NO_DIRTY_QUARANTINE=1 — class=environment; next=<build-gate re-run>`);
			// The budget counts a COMPLETED state change: consumed only on a
			// successful quarantine — it grants EXACTLY ONE gate re-run (AC-03,
			// OQ-1; a failed quarantine leaves it intact, T4.4).
			regateUsed.used = true;
			// D-1a (SCENARIO-006): the re-run must NOT inherit a baseline verdict
			// memoized against the pre-quarantine worktree — clear the memo
			// immediately before the single re-run.
			clearBaselineCache();
			announceActivity("Build gate (post-quarantine re-run)", attemptDetail(attempt));
			gate2 = runBuildGate(worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal, defaultBranch });
			appendGateChecked(state, "phase-build:env-blocker-regate", gate2, "implementation");
			ctx.log(`Implementation ${phaseId} build-gate (post-quarantine re-run) ${gate2.pass ? "PASS" : "FAIL"} (ran: ${gate2.ran.join(", ") || "no commands"})`);
			// T3.3 (SCENARIO-007): green-through on the RE-RUN result. D-12: the
			// original check ran with skipTests:true; after a green re-run, re-run
			// with skipTests:false so requireTests is verified build-green. The
			// changeGate/symbolGate/tdd-oracle verdicts are REUSED, not recomputed
			// (the quarantined paths exclude the claimed set, D-12).
			if (gate2.pass || gate2.inScopePass) {
				resetDeliverableCheckCache();
				announceActivity("Deliverable check", attemptDetail(attempt, "post-quarantine re-run"));
				const deliverableCheck2 = runDeliverableCheck(worktreePath, bridgedDeliverables, { signal: ctx.signal, skipTests: false, defaultBranch }); // sweep-3 G6
				latestDeliverableCheck2 = deliverableCheck2;
				if ((gate2.pass || gate2.inScopePass) && deliverableCheck2.pass && ownScope.changePass && ownScope.symbolPass && ownScope.tddClean) {
					phaseStatusUpsert(phaseStatus as never, phaseId, "green", attempt); // v0.3.85 S3: peak-attempts metric
					emitPhaseStatus("ok");
					const efi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (efi >= 0) lastFailures.splice(efi, 1);
					if (gate2.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate2.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate2.outOfScopeErrors).join(",")})`);
					}
					return { kind: "green-through", gateErrors: gate2.errors };
				}
				// Still blocked on own-scope evidence after the fresh check — but
				// adv-review F-5: re-classify the RE-RUN evidence before the judge
				// tail. Only a still-environmental verdict proceeds to the judge
				// hand-off; otherwise fall through to failureReasons.
			}
		} else if (q.error) {
			// Quarantine mechanism failure (T4.4/SCENARIO-029 arm): nothing was
			// stashed so no recovery is owed; degrade to the judge route — never
			// fatal (AC-13).
			ctx.log(`Implementation ${phaseId} quarantine FAILED (nothing stashed — degrading to judge route) — class=environment; next=<judge: fix-environment/escalate>: ${q.error.slice(0, 300)}`);
		}
		// (q.skipped === "empty" is unreachable here — foreignDirt.length > 0;
		// q.skipped === "kill-switch" is guarded by dirtyQuarantineEnabled().)
	}
	// adv-F5 + v0.2.6 G2: compute the re-run re-classification ONCE here (gate2
	// + the fresh deliverable verdict + reused change/symbol/tdd evidence). It
	// covers BOTH non-green re-run shapes: (a) the re-run STILL FAILS — post-
	// quarantine the foreign dirt is stashed by construction, so any remaining
	// failure is this phase's product problem (run 2026-08-19T05-09-21-800Z
	// rode a stale environment class into the judge on exactly this path); (b)
	// adv-F5's original case — the re-run went green but the fresh deliverable
	// check failed. Non-environmental ⇒ product fall-through instead of the
	// environmental judge hand-off.
	let reRunClassifiedProduct = false;
	let reclassifiedFaultClass: FaultClass | null = null;
	let postRegateProductErrors: string[] | null = null;
	const regateStillRed = gate2 !== null && !gate2.pass && !gate2.inScopePass;
	if (gate2 && (regateStillRed || (latestDeliverableCheck2 !== null && !latestDeliverableCheck2.pass))) {
		// v0.2.6 G2 + sd26-F5: OBSERVED provenance, not the asserted 0 —
		// recompute the inventory and partition against the phase's first-ever
		// snapshot (normally 0 post-quarantine because the foreign dirt was
		// stashed; an external tree mutation between the stash and the re-gate
		// surfaces here as live foreign dirt and keeps the environmental reading
		// honest).
		const dirtAfter = collectDirtPaths({
			worktreePath,
			specDirectory,
			copiedEnvFiles,
			extraExcluded: dirtExclusions,
		});
		const foreignAfter = dirtAfter.filter((p) => runStartSet.has(p));
		const reClassify = classifyGateFault({
			errors: gate2.errors,
			outOfScopeErrors: gate2.outOfScopeErrors,
			baselineCheck: gate2.baselineCheck,
			ownScope: { deliverablePass: latestDeliverableCheck2 !== null ? latestDeliverableCheck2.pass : false, changePass: ownScope.changePass, symbolPass: ownScope.symbolPass, tddClean: ownScope.tddClean },
			foreignDirtCount: foreignAfter.length,
		});
		if (reClassify.faultClass !== "environmental-blocker") {
			reRunClassifiedProduct = true;
			reclassifiedFaultClass = reClassify.faultClass; // v0.3.85 F3: the re-run's class is the attempt's effective class
			postRegateProductErrors = gate2.errors;
			ctx.log(`Implementation ${phaseId} post-quarantine re-run classified ${reClassify.faultClass} (${regateStillRed ? "re-run still failing — remaining failures are this phase's product problem (foreign dirt already stashed)" : "own-scope evidence not green"}) — class=product; next=<implementer-retry> — environmental judge skipped`);
		}
	}
	return { kind: "blocked", gate2, reRunClassifiedProduct, reclassifiedFaultClass, postRegateProductErrors };
}
