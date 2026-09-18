/**
 * The RED oracle cycle — increment 19 of the stage.ts split.
 *
 * THE BLOCK THIS REPLACES (stage.ts, the RED while loop's middle — from the
 * "RED oracle" announce through the v0.3.16 F4 timeout-hint block):
 * the v0.3.40 runner-cache SCOPE guard (a cached runner validated against an
 * earlier phase's tests must not judge this phase's), the RED oracle itself
 * (runRedCheck), the v0.3.57 F-E conventions capture, the boundary resolution
 * + scaffold re-admission, the F8 oracle-time LIVE deliverable re-check, the
 * classification (classifyRedEvidence), the R1 fail-closed unknown guard
 * (v0.3.30 F2 — unknown stays unknown), the F9-A no-edit-completion routing
 * (a machine decision: no-edit rejection + live re-check satisfied ⇒
 * green-already-satisfied), the v0.3.30 Layer C runner discovery (LLM
 * proposes, the harness machine-verifies), the review-2 F12 stale-spawn
 * self-heal, the RED scenario coverage resolution, the v0.3.85 F5 ratchet
 * call (evaluateF5Ratchet — already extracted, red-ratchet.ts), the evidence
 * append + polluted-red restore, the Plan 2 Tier 1 hollow-assertion guard,
 * the Tier 2 parallel review LAUNCH (unawaited, fail-closed step), and the
 * F4 timeout hint composition (the honest death cause + the disk state).
 *
 * THE SHAPE: a record builder — NO loop exits (every continue/break belonged
 * to the extracted ladder). THROW SEMANTICS (513f1524 F1): the record is
 * all-or-nothing on throw — a rejection at the boundary/discovery/coverage
 * await loses the intermediate runner-let mutations (inline kept them);
 * no catch exists between the loop body and the phase-scoped
 * re-initialization today, so this is dead — but a future catch added there
 * must treat the runner lets as UN-updated (discovery may legally re-fire). One wide record carries every per-try binding:
 * the classification results, the retry hint, the in-flight review promise,
 * and the three cross-try runner lets (runnerSpec / runnerDiscoveryTried /
 * covConventionsSpec — the caller rebinds them each try, exactly as the
 * inline lets did).
 */

import type { StageContext, PipelineState } from "../../types.ts";
import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runRedCheck, deliverablesAlreadyMet, type DeliverableContract, type RedCheckDiagnostic, type RedStatus } from "../../build-runner.ts";
import { stateFileFor } from "../../state/state-root.ts";
import { writeCachedTestRunner, validateRunnerSpec, runnerCoversTargets, type TestRunnerSpec } from "../../build-runner/runner-discovery.ts";
import { deriveConventionsRunnerSpec } from "../../build-runner/conventions.ts";
import { appendImplementationEvidence, assertionPresenceGaps, boundarySummary, classifyRedEvidence, gitStatusPaths, redDiagnosticsPrompt, redGenerationRetryHint, restorePaths, setDiff, snapshotFiles, type RedEvidence } from "./red-evidence.ts";
import { evaluateF5Ratchet } from "./red-ratchet.ts";
import { resolveRedBoundary, resolveTddScenarioCoverage } from "./red-evidence.ts";
import { approveScaffoldPaths } from "../../test-artifacts.ts";
import { isNoEditCompletion } from "../../agent-errors.ts";
import { RedReviewData as RED_REVIEW_SCHEMA } from "../../render/schemas.ts";
import { normalizeStringArray, redCheckOptions } from "./phase-reentry.ts";
import { buildRedReviewPrompt } from "../../prompts.ts";

export interface RedOracleCycleInput {
	ctx: StageContext;
	state: PipelineState;
	/** setup fields. */
	setup: Parameters<typeof buildRedReviewPrompt>[0];
	worktreePath: string;
	specDirectory: string;
	language: string | undefined;
	phaseId: string;
	phaseName: string;
	phase: Parameters<typeof classifyRedEvidence>[0] extends never ? never : Record<string, unknown>;
	attempt: number;
	retries: number;
	redTryDetail: string;
	/** The dispatch error (feeds the fail-closed guard and the death-cause hint). */
	tddError: string | undefined;
	tddNotCompleted: boolean;
	testFiles: string[];
	lastClaimedTestFiles: string[];
	/** The try's fresh diagnostics array (filled by runRedCheck). */
	redDiagnostics: RedCheckDiagnostic[];
	/** The RED baseline (attempt-entry porcelain, as a Set — gitStatusPaths' shape). */
	redBaseline: Set<string>;
	/** Cross-try runner state (returned fresh each try). */
	runnerSpec: TestRunnerSpec | null;
	runnerDiscoveryTried: boolean;
	covConventionsSpec: TestRunnerSpec | null;
	/** Classification inputs. */
	expectedScenarios: string[];
	phaseDeliverables: DeliverableContract | undefined;
	baselineDeliverablesSatisfied: boolean;
	redScaffoldApproved: Set<string>;
	phaseReviewViolations: number;
	announceActivity: (activity?: string, detail?: string) => void;
	runStep: <T>(label: string, detail: string | undefined, okIf: (r: T) => boolean, fn: () => Promise<T>) => Promise<T>;
}

export interface RedOracleCycleResult {
	redStatus: RedStatus;
	redChangedFiles: string[];
	redEvidence: RedEvidence;
	redFailClosedUnknown: boolean;
	/** Nullable — redGenerationRetryHint returns string|null; the caller's ladder guard narrows. */
	retryHint: string | null;
	/** The unawaited parallel review (null when not launched). */
	redReviewInFlight: Promise<{ control: unknown; error?: string } | null> | null;
	runnerSpec: TestRunnerSpec | null;
	runnerDiscoveryTried: boolean;
	covConventionsSpec: TestRunnerSpec | null;
}

/**
 * Run one RED oracle cycle (oracle → boundary → classify → guards → ratchet
 * → review launch → hint). `await` is required (the boundary resolution, the
 * runner discovery, and the scenario coverage dispatch agents).
 */
export async function runRedOracleCycle(input: RedOracleCycleInput): Promise<RedOracleCycleResult> {
	const { ctx, state, setup, worktreePath, specDirectory, language, phaseId, phaseName, phase, attempt, retries, redTryDetail, tddError, tddNotCompleted, testFiles, lastClaimedTestFiles, redDiagnostics, redBaseline, expectedScenarios, phaseDeliverables, baselineDeliverablesSatisfied, redScaffoldApproved, phaseReviewViolations, announceActivity, runStep } = input;
	let { runnerSpec, runnerDiscoveryTried, covConventionsSpec } = input;
	// f32b6b36 F2: PER-TRY reset — the baseline declared this before the while
	// loop and leaked `true` across tries; the v0.3.30 F2 contract describes the
	// CURRENT try's evidence, so the reset is the intentional tightening.
	let redFailClosedUnknown = false;
	announceActivity("RED oracle", redTryDetail);
	// v0.3.40 scope guard: a cached runner validated against an EARLIER
	// phase's specific test file must not judge THIS phase's tests
	// (run 2026-08-30T08-30-00-814Z phase 2: the phase-1 runner pinned
	// phase1-shell.test.mjs and the oracle read phase-1's GREEN output
	// as 'tests passed before implementation' for phase-2 engine tests
	// — false red-not-confirmed, pure retry burn). Stale scope ⇒ drop
	// the runner for this try AND the cache, so a fresh runner-discovery
	// can propose a phase-appropriate command on the next try.
	if (runnerSpec && testFiles.length && !runnerCoversTargets(runnerSpec, testFiles)) {
		ctx.log(`Implementation ${phaseId} runner-cache: cached runner does not execute this phase's test files (${testFiles.join(", ")}) — cache invalidated; runner-discovery will re-propose`);
		runnerSpec = null;
		runnerDiscoveryTried = false;
		try { rmSync(stateFileFor(specDirectory, "test-runner.json"), { force: true }); } catch { /* best effort */ }
	}
	const redStatus = runRedCheck(worktreePath, testFiles, redCheckOptions(ctx, phaseId, redDiagnostics, setup.defaultBranch, runnerSpec ?? undefined));
	ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
	// v0.3.57 review F-E: capture NOW (post-RED, pre-implementer) so the
	// coverage gate measures verdict-time inputs. runnerSpec is null here
	// exactly when RED ran via conventions (the cache initializes it above),
	// so this never shadows a validated runner.
	if (!runnerSpec && !covConventionsSpec) covConventionsSpec = deriveConventionsRunnerSpec(worktreePath, testFiles);
	const redChangedFiles = setDiff(gitStatusPaths(worktreePath), redBaseline);
	announceActivity("RED boundary", redTryDetail);
	let boundary = await resolveRedBoundary({ ctx, phaseId, phaseName, phase, redStatus, testFiles, changedFiles: redChangedFiles, cwd: worktreePath });
	// v0.2.8 G4: re-admit judge-approved scaffolding before classifying.
	if (redScaffoldApproved.size) boundary = approveScaffoldPaths(boundary, redScaffoldApproved);
	ctx.log(`Implementation ${phaseId} RED boundary: ${boundarySummary(boundary)}`);
	// F8 (v0.3.66, incident 2026-09-04T14-45-04-784Z phase 5): the baseline was
	// snapshotted at attempt ENTRY; deliverables can land between entry and
	// oracle (sibling-phase commits, RED-authored test-file deliverables) —
	// the incident burned 3.5h in red-not-confirmed retries with every clause
	// satisfied on disk. Re-check the contract LIVE at oracle time, but only
	// when it can change the classification (oracle green, baseline false):
	// polluted-red is classified FIRST in classifyRedEvidence, so a RED-phase
	// production edit still cannot masquerade as already-satisfied, and the
	// Already-satisfied verification node re-runs build gate + deliverable
	// check deterministically before anything is accepted.
	const alreadySatisfiedNow = baselineDeliverablesSatisfied
		|| (redStatus === "green" && phaseDeliverables
			? deliverablesAlreadyMet(worktreePath, phaseDeliverables, setup.defaultBranch)
			: false);
	if (!baselineDeliverablesSatisfied && alreadySatisfiedNow) {
		ctx.log(`Implementation ${phaseId} RED oracle-time deliverable re-check: satisfied (baseline was not) — routing to already-satisfied verification`);
	}
	let redEvidence = classifyRedEvidence({ phaseId, attempt, redStatus, testFiles, changedFiles: redChangedFiles, boundary, redRetries: retries, alreadySatisfied: alreadySatisfiedNow, diagnostics: redDiagnostics });
	// R1 — FAIL CLOSED on an unclassifiable/absent RED when the phase is
	// SUPPOSED to have tests. `unknown-*` produces no failure reason and no
	// retry hint, so without this the implementer proceeds with NO confirmed
	// RED (and skips the assertion + review gates, which only fire on
	// red-behavior-failure). If tdd-guide errored/timed out, returned no
	// testFiles, or the runner couldn't classify — AND the phase declares
	// expected scenarios or a test deliverable — treat it as a broken RED so
	// it retries instead of silently shipping untested code.
	{
		const requiresTests = expectedScenarios.length > 0
			|| normalizeStringArray(phaseDeliverables?.requireTests).length > 0
			|| normalizeStringArray((phaseDeliverables as { requireScenarios?: unknown } | undefined)?.requireScenarios).length > 0;
		const unknownRed = redEvidence.status === "unknown-unclassified" || redEvidence.status === "unknown-no-runner";
		if (unknownRed && (requiresTests || tddError)) {
			const why = tddError
				? `the TDD agent did not complete (${tddError})`
				: testFiles.length === 0
					? "the TDD agent returned no test files"
					: "the RED test status could not be confirmed";
			ctx.log(`Implementation ${phaseId} RED fail-closed: ${why}; phase requires tests — retrying instead of proceeding without a confirmed RED`);
			redFailClosedUnknown = true;
			// v0.3.30 F2: keep the status HONEST — unknown stays unknown (with
			// its own red-unverified reason/hint templates). The pre-0.3.29
			// coercion to broken-test made the retry log claim "tests did not
			// compile/collect" even when 127 tests had run and 122 failed
			// (run 2026-08-28T16-09-12-785Z tries 2-3).
			redEvidence = { ...redEvidence, reason: `RED not confirmed: ${why}` };
		}
		// F9-A (v0.3.67, incident 2026-09-04T14-45-04-784Z): pi-subagents'
		// child-acceptance layer rejects an implementation-intent child that
		// completes WITHOUT file edits (MISSING_IMPLEMENTATION_MUTATION_MESSAGE,
		// LLM intent arbiter) — correct P4 enforcement: self-report is never
		// evidence. But in an already-satisfied phase a verification-only
		// completion is the CORRECT outcome (the incident's tdd-guide verified
		// both suites green on disk and edited nothing; 21 rejections, hours of
		// red-unverified retries). Route on the deterministic signal instead:
		// no-edit rejection + LIVE deliverable re-check satisfied ⇒ classify
		// green-already-satisfied; the Already-satisfied verification node
		// re-runs build gate + deliverable check before anything is accepted
		// (A1: the machine decides, never the child's own summary). Fail-closed:
		// deliverables NOT satisfied keeps today's bounded retry (with the
		// honest reason above). Precedent: no-op-is-success (Ansible changed=0,
		// Terraform no-op plan, git "Already up to date").
		if (tddError && isNoEditCompletion(tddError) && phaseDeliverables
			&& (baselineDeliverablesSatisfied || deliverablesAlreadyMet(worktreePath, phaseDeliverables, setup.defaultBranch))) {
			redEvidence = {
				...redEvidence,
				status: "green-already-satisfied",
				reason: "TDD agent completed without edits (reports the phase observable already landed); live deliverable re-check satisfied — routing to already-satisfied verification",
			};
			ctx.log(`Implementation ${phaseId} RED no-edit completion + live deliverable re-check satisfied — routing to already-satisfied verification`);
		}
	}
	// v0.3.30 Layer C: the registry has no runner for this stack —
	// ONE discovery attempt before burning retries. The agent
	// PROPOSES a command under a mandatory per-test-evidence
	// contract; the harness MACHINE-VERIFIES it by executing it;
	// a validated spec is cached (spec-dir test-runner.json) and
	// threads into every later oracle run. LLM proposes, machine
	// verifies — the gate decision itself stays deterministic.
	if (redFailClosedUnknown && !runnerSpec && !runnerDiscoveryTried) {
		runnerDiscoveryTried = true;
		announceActivity("Runner discovery", redTryDetail);
		const discovery = await ctx.agent({
			id: `pipeline.implementation.${phaseId}.runner-discovery.a${attempt}.t${retries + 1}`,
			agent: "debug-analyzer",
			prompt: [
				"## Purpose",
				"Discover how to run this project's test suite so a deterministic harness can verify TDD RED/GREEN states.",
				"The harness could NOT find any recognized test runner for this repository (no package.json / go.mod / pyproject / Cargo / Gradle / Maven convention matched with a runnable test command).",
				"",
				"## Contract (MANDATORY — your proposal is machine-verified)",
				"The command you return MUST emit per-test pass/fail detail the harness can parse. Console prose NEVER classifies — the command must produce a STRUCTURED channel:",
				"- JUnit XML written to a conventional results directory (build/test-results/**, target/surefire-reports/**) — Gradle and Maven do this by default; pytest: add `--junitxml=<abs tmp path>/junit.xml`; or",
				"- TAP on stdout (lines `ok N ...` / `not ok N ...`) — node:test: `node --test --test-reporter=tap <files>`; vitest: `--reporter=tap`; or",
				"- go test JSON events: `go test -json <packages>`.",
				"The harness will EXECUTE your command once to validate it. A command that only prints prose (e.g. 'all tests passed') is REJECTED.",
				"You may run candidate commands yourself to confirm they work. Do NOT create, edit, or delete ANY file — explore, read, and run only.",
				"",
				"## Project",
				`- worktree root: ${worktreePath}`,
				`- detected stack: language=${language}${state.classify ? ` (${state.classify.language})` : ""}`,
				`- test files this phase expects: ${testFiles.join(", ") || "(none yet)"}`,
				"",
				"## Steps",
				"1. Inspect manifests/build files (Makefile, justfile, CMake, meson, composer, dotnet, xcodeproj, vendor scripts …) to identify the test entry point.",
				"2. Run a scoped candidate ONCE (ideally targeting one test file/class) and confirm it emits per-test pass/fail detail.",
				"3. Return the single best command (shell string; you may include quoting). Prefer deterministic, non-interactive, non-watch invocations.",
				"",
				"Output <control> JSON with: command, resultFormat.",
			].join("\n"),
			accessMode: "source-read-only",
		});
		const dControl = (discovery.control ?? {}) as { command?: unknown; cwd?: unknown; resultFormat?: unknown };
		const dCommand = typeof dControl.command === "string" ? dControl.command.trim() : "";
		if (dCommand) {
			const spec: TestRunnerSpec = {
				version: 1,
				command: dCommand,
				...(typeof dControl.cwd === "string" && dControl.cwd.trim() ? { cwd: dControl.cwd.trim() } : {}),
				resultFormat: dControl.resultFormat === "tap" || dControl.resultFormat === "junit-xml" ? dControl.resultFormat : "console",
				discoveredAt: new Date().toISOString(),
			};
			const validation = validateRunnerSpec(spec, worktreePath, 180_000, ctx.signal);
			if (validation.ok) {
				runnerSpec = spec;
				writeCachedTestRunner(specDirectory, spec);
				ctx.log(`Implementation ${phaseId} runner-discovery: VALIDATED agent-proposed runner (${validation.evidence}) — cached for reuse; the oracle now runs: ${spec.command}`);
			} else {
				ctx.log(`Implementation ${phaseId} runner-discovery: proposal REJECTED (${validation.evidence}) — continuing on the honest unknown path`);
			}
		} else {
			ctx.log(`Implementation ${phaseId} runner-discovery: agent returned no usable command — continuing on the honest unknown path`);
		}
	}
	// review-2 F12: a cached runner spec whose command no longer SPAWNS
	// (ENOENT-class `error` on the dynamic plan) self-heals — drop the
	// cache file and the in-memory spec so a later phase can rediscover.
	// Precise by design: only true staleness (command gone) invalidates;
	// a scoping miss ("No tests found") or unparseable output keeps the
	// cache and surfaces honestly as red-unverified instead.
	if (runnerSpec && redStatus === "unknown" && redDiagnostics.some((d) => d.error)) {
		runnerSpec = null;
		try { rmSync(stateFileFor(specDirectory, "test-runner.json"), { force: true }); } catch { /* best effort */ }
		ctx.log(`Implementation ${phaseId} runner-cache: cached runner failed to spawn — cache invalidated; a later phase may rediscover`);
	}
	if (redEvidence.status === "red-behavior-failure" && expectedScenarios.length > 0) {
		announceActivity("RED scenario coverage", redTryDetail);
		const coverage = await resolveTddScenarioCoverage({ ctx, cwd: worktreePath, phaseId, phaseName, phase, expectedScenarios, testFiles, specControl: state.spec ?? null, bddControl: state.bdd ?? null });
		if (coverage.allCovered) {
			redEvidence = { ...redEvidence, expectedScenarios: coverage.expectedScenarios, coveredScenarios: coverage.coveredScenarios, missingScenarios: [] };
			ctx.log(`Implementation ${phaseId} RED scenario coverage PASS: ${coverage.coveredScenarios.join(", ") || "none"}`);
		} else {
			redEvidence = {
				...redEvidence,
				status: "coverage-incomplete",
				expectedScenarios: coverage.expectedScenarios,
				coveredScenarios: coverage.coveredScenarios,
				missingScenarios: coverage.missingScenarios,
				reason: coverage.summary,
			};
			ctx.log(`Implementation ${phaseId} RED scenario coverage FAIL: missing=${coverage.missingScenarios.join(", ") || "unknown"}; ${coverage.summary}`);
		}
	}
	// ── v0.3.85 F5 — RED-phase assertion ratchet (C3 fix; §9 F5, §14 ADR 10) ──
	// The deterministic ACCEPTANCE-TIME evaluation lives in
	// evaluateF5Ratchet() (red-ratchet.ts, extracted v0.4.30) — it is pure and
	// straight-line, so it lifted whole. The ESCALATION half lives in the
	// extracted red-retry-ladder (v0.4.44).
	redEvidence = evaluateF5Ratchet(redEvidence, {
		worktreePath,
		redChangedFiles,
		failClosedUnknown: redFailClosedUnknown,
		phaseId,
		log: (line) => ctx.log(line),
	});
	appendImplementationEvidence(specDirectory, redEvidence);
	if (redEvidence.status === "polluted-red") {
		restorePaths(worktreePath, redEvidence.forbiddenFiles);
	}
	// Plan 2 Tier 1 — hollow-assertion guard: a RED sample that fails for
	// the RIGHT reason (red-behavior-failure, coverage OK) can still be
	// HOLLOW if a test file contains no recognizable assertion — a later
	// minimal impl would "pass" it without proving anything. Reject it here
	// so tdd-guide adds real assertions, routed through the SAME retry
	// machinery below (no-progress detection, restore, redHint). Cheap +
	// deterministic; weak-but-present assertions are Tier 2's job.
	let retryHint = redGenerationRetryHint(redEvidence, { failClosed: redFailClosedUnknown });
	if (!retryHint && redEvidence.status === "red-behavior-failure" && testFiles.length > 0) {
		const hollow = assertionPresenceGaps(snapshotFiles(worktreePath, testFiles));
		if (hollow.length > 0) {
			ctx.log(`Implementation ${phaseId} RED hollow-assertion guard: no assertion found in ${hollow.join(", ")}`);
			redEvidence = { ...redEvidence, status: "green-weak-test", reason: `hollow RED test(s) — no assertion call found in: ${hollow.join(", ")}` };
			retryHint = `Your RED test file(s) ${hollow.join(", ")} contain no recognizable assertion (expect/assert/should/…). A test with no assertion proves nothing — a trivial implementation would make it pass. Add explicit assertions that bind each scenario's observable behavior to a concrete expected value, then re-run so the tests fail for the RIGHT reason.`;
		}
	}
	// Plan 2 Tier 2 — independent RED test-QUALITY review. Tier 1 only
	// catches TRULY hollow tests (no assertion); Tier 2 catches WEAK ones
	// (assertion present but not bound to the scenario's observable
	// behavior — e.g. asserting a stub constant, testing an implementation
	// detail, or a tautology). An INDEPENDENT reviewer (cross-model when
	// config.agentModels.code-reviewer is set — Plan 1) audits the RED test
	// cases; a WEAK verdict routes back to tdd-guide via the SAME retry
	// machinery. Runs every phase, on accepted-but-not-yet-implemented RED.
	// v0.3.53 F2: after 2 reviewer-side violations (boundary/timeout/spawn
	// failures — NOT suite evidence) the parallel review is disabled for
	// this phase; the deterministic gates carry the decision (P5).
	let redReviewInFlight: Promise<{ control: unknown; error?: string } | null> | null = null;
	if (!retryHint && redEvidence.status === "red-behavior-failure" && testFiles.length > 0 && phaseReviewViolations < 2) {
		// v0.3.43 RC2 (pipelining): LAUNCH WITHOUT AWAITING — the review is
		// source-read-only and cannot conflict with the implementer (which is
		// forbidden from touching test files). The verdict is adjudicated at
		// the join site right after the implementer returns; the fail-closed
		// semantics (anything but an explicit STRONG, contradiction-free
		// verdict re-authors the RED) are preserved there verbatim.
		const review = runStep(
			"RED review", redTryDetail,
			// Fail CLOSED: the step is "ok" only on an explicit STRONG verdict.
			(r: { control?: { verdict?: unknown } | null }) => String(r?.control?.verdict ?? "").toLowerCase() === "strong",
			() => ctx.agent({
				id: `pipeline.implementation.${phaseId}.red-review.a${attempt}.t${retries + 1}`,
				agent: "code-reviewer",
				accessMode: "source-read-only",
				// v0.3.54: runs concurrently with the implementer — boundary
				// violations must QUARANTINE, not git-restore (a blind restore
				// wipes the implementer's legitimate concurrent writes to the
				// same files; live-confirmed in phase 11 of run
				// 2026-08-31T16-03-57-978Z). The join attributes and restores.
				concurrentWriter: true,
				prompt: buildRedReviewPrompt(setup, state.classify ?? null, phase as never, testFiles, expectedScenarios, state.spec ?? null, state.bdd ?? null),
				schema: RED_REVIEW_SCHEMA,
				// `contradictions: []` is the explicit jointly-satisfiable value;
				// it must not trigger a corrective re-prompt (Fix 1c/1d pattern).
				allowEmptyArraysFor: ["contradictions"],
			}),
		);
		redReviewInFlight = review as Promise<{ control: unknown; error?: string } | null>;
		// v0.3.51: the review is awaited only at the post-implementer join —
		// a rejection in the gap (e.g. a source-read-only boundary violation,
		// run 2026-08-31T03-25-44-485Z 16:29) sat unhandled and Node's default
		// unhandledRejection=throw killed the whole workflow with no terminal
		// marker. Mark the rejection handled NOW; the join still awaits the
		// ORIGINAL promise and rethrows the same error there.
		void redReviewInFlight.catch(() => {});
		ctx.log(`Implementation ${phaseId} RED review launched in parallel with the implementer (v0.3.43 pipelining) — verdict joins when GREEN returns`);
		// (v0.3.43: verdict adjudication moved to the post-implementer
		// join site — see "RC2 join" below. The R2 fail-closed rule and
		// the Fix 4 contradiction override are enforced there verbatim.)
	}
	// v0.3.16 F4 (RC-T4): when THIS try died of a wall-clock timeout (the tdd
	// agent itself, or the RED reviewer whose timeout blocked adjudication),
	// the next try must know that — the stock hint says "tests did not
	// compile"/"not strong" which sends the agent hunting a defect that does
	// not exist (run 02-59 phase-06: five 20-min re-explorations of the same
	// healthy material). Prefix the honest death cause + the disk state so
	// the retry can skip re-exploration.
	{
		const tddDeath = tddNotCompleted ? String(tddError ?? "agent produced no control object") : "";
		const reviewDeath = redEvidence.status === "review-weak" && /RED review (?:did not complete|returned no usable verdict)/i.test(String(redEvidence.reason ?? "")) ? String(redEvidence.reason ?? "") : "";
		if (tddDeath || reviewDeath) {
			// v0.3.16 review fix (code F-1 / adv F-2): probe the DISK, not the
			// (already-cleared) claim — the union of the current claim (a
			// completed agent may legitimately re-claim), the files the RED
			// phase actually touched this try (redChangedFiles — a timed-out
			// agent may still have written before dying), and nothing else.
			// Deduped so the hint names each existing file exactly once.
			const claimedNow = tddNotCompleted ? [] : [...testFiles];
			const onDisk = [...new Set([...claimedNow, ...lastClaimedTestFiles, ...redChangedFiles])]
				.filter((f) => { try { return existsSync(resolve(worktreePath, f)); } catch { return false; } });
			const timeoutHint = [
				`\n\n## PREVIOUS TRY DIED AT THE WALL CLOCK — do not re-explore`,
				tddDeath ? `- Your previous run ended with: ${tddDeath}. You ran out of TIME, not correctness.` : "",
				reviewDeath ? `- Your tests were written but the independent review never completed (${reviewDeath}). The file was PRESERVED on disk — it was never adjudicated.` : "",
				`- Disk state now: ${onDisk.length ? `${onDisk.join(", ")} exist(s)` : "no claimed test file exists on disk"}.`,
				"- Skip re-exploration of material you already read (the summary above stands). Write/fix the test file FIRST, run the scoped test once, then call structured_output. If time runs short, prioritize: file on disk > one verification run > structured_output.",
			].filter(Boolean).join("\n");
			// v0.3.16 review fix (adv F-1): on an agent-death try the stock
			// broken/green templates MISLEAD ("tests did not compile" when the
			// file never existed this try). Keep diagnostics; drop the template
			// when the agent (not the tests) died. A review-death try keeps its
			// template only when it carries real verdict content — the preserved
			// file still needs the stock guidance then.
			const stockHint = tddDeath ? redDiagnosticsPrompt(redEvidence.diagnostics) : (retryHint ?? "");
			retryHint = timeoutHint + stockHint;
		}
	}
	// F9-A note: green-already-satisfied is a MACHINE decision (live deliverable
	// re-check passed) — the CALLER's ladder guard (`retryHint && status !==
	// green-already-satisfied`) keeps an agent-death hint from overriding it
	// back into the retry loop. Kept caller-side, byte-faithful.
	return { redStatus, redChangedFiles, redEvidence, redFailClosedUnknown, retryHint, redReviewInFlight, runnerSpec, runnerDiscoveryTried, covConventionsSpec };
}
