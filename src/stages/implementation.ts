/**
 * Stage 9 — Implementation (per-phase TDD).
 * Self-contained task: iterates the spec's phased task list. For each phase,
 * up to 5 attempts of TDD-write → implement → build-gate; commits on green.
 * The build-gate is the DETERMINISTIC hard oracle (build-runner.ts) that
 * replaces the old QA self-report — no more vacuous pass on "agent said green".
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlObj, Stage, StageContext } from "../types.ts";
import { getActiveTracker, isInternalRuntimeClaim } from "../tracking.ts";
import type { ChangeRecord, StructuredChanges } from "../tracking.ts";
import { localTimestamp } from "../render/time.ts";
import { buildRedBoundaryPrompt, classifyObviousRedPath, redBoundaryResultFromAgent, redBoundaryResultFromClassifications, type RedBoundaryResult } from "../test-artifacts.ts";
import { buildTddPrompt, buildImplementPrompt, buildCommitPrompt, buildImplementationSummaryPrompt, rustDiscipline } from "../prompts.ts";
import { renderAndWrite } from "../render/render.ts";
import { STAGE_MODELS } from "../render/schemas.ts";
import { userNotesForAgent } from "../render/user-notes.ts";
import { normalizePhases } from "../doc-validators.ts";
import { computeChangeGate, computeSymbolGate, deliverablesAlreadyMet, resetDeliverableCheckCache, runBuildGate, buildGateCorrelationLine, runDeliverableCheck, runRedCheck, type DeliverableContract, type GateOptions, type RedCheckDiagnostic, type RedCheckPlan, type RedStatus } from "../build-runner.ts";
import { WORKFLOW_ATTEMPTS } from "../retry-policy.ts";

const MAX_ATTEMPTS = WORKFLOW_ATTEMPTS;

type RedEvidenceStatus = "red-behavior-failure" | "green-weak-test" | "green-already-satisfied" | "broken-test" | "unknown-no-runner" | "unknown-unclassified" | "polluted-red";

interface RedEvidence {
	phaseId: string;
	attempt: number;
	status: RedEvidenceStatus;
	oracleStatus: RedStatus;
	testFiles: string[];
	changedFiles: string[];
	forbiddenFiles: string[];
	boundary?: RedBoundaryResult;
	diagnostics?: RedCheckDiagnostic[];
	redRetries: number;
	reason?: string;
}

function gitLines(cwd: string, args: string[]): string[] {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.split("\n").map((l) => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

function gitStatusPaths(cwd: string): Set<string> {
	const paths = new Set<string>();
	for (const line of gitLines(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) {
		const raw = line.slice(3).trim();
		const path = raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
		if (path) paths.add(path);
	}
	return paths;
}

function setDiff(after: Set<string>, before: Set<string>): string[] {
	return [...after].filter((p) => !before.has(p)).sort();
}

function listOrNone(values: string[]): string {
	return values.length ? values.join(", ") : "none";
}

function redEvidenceLogLine(e: RedEvidence): string {
	const boundary = e.boundary ? ` ambiguousFiles=${listOrNone(e.boundary.ambiguousFiles)}` : "";
	const diagnostics = e.diagnostics?.length ? ` diagnostics=${e.diagnostics.length}` : " diagnostics=none";
	return `Implementation ${e.phaseId} RED gate evidence: status=${e.status} oracle=${e.oracleStatus} retries=${e.redRetries} testFiles=${listOrNone(e.testFiles)} changedFiles=${listOrNone(e.changedFiles)} forbiddenFiles=${listOrNone(e.forbiddenFiles)}${boundary}${diagnostics}`;
}

function restorePaths(cwd: string, paths: string[]): void {
	for (const path of paths) {
		try { execFileSync("git", ["checkout", "--", path], { cwd, stdio: "ignore" }); } catch { /* untracked or absent */ }
		try { execFileSync("git", ["clean", "-fd", "--", path], { cwd, stdio: "ignore" }); } catch { /* best-effort */ }
	}
}

function restoreUnacceptedRedChanges(ctx: StageContext, cwd: string, phaseId: string, paths: string[]): void {
	const restorable = paths.filter((p) => !isInternalRuntimeClaim(p));
	if (restorable.length === 0) return;
	restorePaths(cwd, restorable);
	ctx.log(`Implementation ${phaseId} RED cleanup: restored unaccepted RED change(s): ${restorable.join(", ")}`);
}

function appendImplementationEvidence(specDir: string | undefined, evidence: RedEvidence): void {
	if (!specDir) return;
	try {
		mkdirSync(specDir, { recursive: true });
		appendFileSync(join(specDir, "implementation-evidence.jsonl"), JSON.stringify({ ts: localTimestamp(), ...evidence }) + "\n");
	} catch { /* evidence is best-effort */ }
}

function classifyRedEvidence(args: { phaseId: string; attempt: number; redStatus: RedStatus; testFiles: string[]; changedFiles: string[]; boundary: RedBoundaryResult; redRetries: number; alreadySatisfied: boolean; diagnostics?: RedCheckDiagnostic[] }): RedEvidence {
	const { phaseId, attempt, redStatus, testFiles, changedFiles, boundary, redRetries, alreadySatisfied } = args;
	const forbiddenFiles = boundary.forbiddenFiles;
	const diagnostics = args.diagnostics?.map((d) => ({ ...d, plan: { cwd: d.plan.cwd, argv: [...d.plan.argv] } }));
	const base = { phaseId, attempt, oracleStatus: redStatus, testFiles, changedFiles, forbiddenFiles, boundary, redRetries, ...(diagnostics?.length ? { diagnostics } : {}) };
	if (forbiddenFiles.length) return { ...base, status: "polluted-red", reason: "RED phase modified files outside the test boundary" };
	if (redStatus === "red") return { ...base, status: "red-behavior-failure" };
	if (redStatus === "broken") return { ...base, status: "broken-test", reason: "RED tests did not compile/collect" };
	if (redStatus === "green" && alreadySatisfied) return { ...base, status: "green-already-satisfied", reason: "Deliverables were already satisfied before implementation" };
	if (redStatus === "green") return { ...base, status: "green-weak-test", reason: "RED tests passed before implementation" };
	return { ...base, status: testFiles.length ? "unknown-unclassified" : "unknown-no-runner", reason: testFiles.length ? "RED status could not be classified from runner output" : "No RED test targets or runner were available" };
}

function formatRedDiagnosticSummary(d: RedCheckDiagnostic): string {
	const exit = d.exitCode === null ? "null" : String(d.exitCode);
	const signal = d.signal ?? "none";
	const error = d.error ? ` error=${d.error}` : "";
	const tail = d.outputTail ? ` tail=${d.outputTail.replace(/\s+/g, " ").slice(0, 600)}` : " tail=none";
	return `cwd=${d.plan.cwd} cmd=${d.plan.argv.map(quoteCmdArg).join(" ")} status=${d.status} exit=${exit} signal=${signal}${error}${tail}`;
}

function firstRedDiagnosticDetail(e: RedEvidence): string {
	const diagnostic = e.diagnostics?.find((d) => d.status === e.oracleStatus) ?? e.diagnostics?.[0];
	return diagnostic ? `diagnostic: ${formatRedDiagnosticSummary(diagnostic)}` : "";
}

function redEvidenceFailureReasons(e: RedEvidence): string[] {
	if (e.status === "polluted-red") return [`red-polluted: RED phase changed production file(s): ${e.forbiddenFiles.join(", ")}`];
	const detail = firstRedDiagnosticDetail(e);
	if (e.status === "green-weak-test") return [`red-not-confirmed: tests passed before implementation (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
	if (e.status === "broken-test") return [`red-broken: tests did not compile/collect (${e.testFiles.join(", ") || "no tests"})${detail ? `; ${detail}` : ""}`];
	return [];
}

function redDiagnosticsPrompt(diagnostics: RedCheckDiagnostic[] | undefined): string {
	if (!diagnostics?.length) return "";
	const rendered = diagnostics.slice(0, 3).map((d, index) => {
		const tail = d.outputTail.trim() || "(no stdout/stderr captured)";
		const limitedTail = tail.split(/\r?\n/).slice(-10).join("\n");
		return [
			`${index + 1}. cwd: ${d.plan.cwd}`,
			`   cmd: ${d.plan.argv.map(quoteCmdArg).join(" ")}`,
			`   status: ${d.status}; exit: ${d.exitCode === null ? "null" : d.exitCode}; signal: ${d.signal ?? "none"}${d.error ? `; error: ${d.error}` : ""}`,
			"   output tail:",
			limitedTail.split(/\r?\n/).map((line) => `     ${line}`).join("\n"),
		].join("\n");
	}).join("\n");
	return `\n\n## RED runner diagnostics from the last oracle run\n${rendered}\n\nUse these exact command results. First make the test file compile/collect and execute, then make it fail for the intended missing behavior. Do not resample unrelated tests.`;
}

function redGenerationRetryHint(e: RedEvidence): string | null {
	if (e.status === "green-weak-test") return redRePromptHint("green") + redDiagnosticsPrompt(e.diagnostics);
	if (e.status === "broken-test") return redRePromptHint("broken") + redDiagnosticsPrompt(e.diagnostics);
	if (e.status === "polluted-red") {
		return `\n\nYour RED phase modified files outside the test boundary: ${e.forbiddenFiles.join(", ")}. Rewrite the RED change using test files or test-only support artifacts. Do not create or modify production implementation files.`;
	}
	return null;
}

function boundarySummary(result: RedBoundaryResult): string {
	const classifications = result.classifications.map((c) => `${c.path}:${c.category}:${c.allowed ? "allow" : "deny"}:${c.source}:${c.confidence.toFixed(2)}`).join("; ") || "none";
	return `allAllowed=${result.allAllowed} forbidden=${listOrNone(result.forbiddenFiles)} ambiguous=${listOrNone(result.ambiguousFiles)} classifications=${classifications}`;
}

async function resolveRedBoundary(args: { ctx: StageContext; phaseId: string; phaseName: string; phase: unknown; redStatus: RedStatus; testFiles: string[]; changedFiles: string[] }): Promise<RedBoundaryResult> {
	const deterministic = args.changedFiles.map(classifyObviousRedPath);
	const ambiguous = deterministic.filter((item) => item.category === "ambiguous" && !item.allowed).map((item) => item.path);
	if (ambiguous.length === 0) return redBoundaryResultFromClassifications(deterministic);
	try {
		const phaseDescription = typeof (args.phase as { description?: unknown }).description === "string" ? (args.phase as { description: string }).description : undefined;
		const evaluated = await args.ctx.agent({
			id: `pipeline.implementation.${args.phaseId}.red-boundary`,
			agent: "red-boundary-classifier",
			controlKeys: ["classifications", "forbiddenFiles", "ambiguousFiles", "allAllowed"],
			prompt: buildRedBoundaryPrompt({
				changedFiles: ambiguous,
				testFiles: args.testFiles,
				phaseName: args.phaseName,
				phaseDescription,
				redStatus: args.redStatus,
			}),
		});
		const agentResult = redBoundaryResultFromAgent(ambiguous, evaluated.control);
		const byPath = new Map(agentResult.classifications.map((item) => [item.path, item]));
		return redBoundaryResultFromClassifications(deterministic.map((item) => byPath.get(item.path) ?? item));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return redBoundaryResultFromClassifications(deterministic.map((item) => item.category === "ambiguous" ? { ...item, source: "fallback", confidence: 0, reason: `boundary evaluator failed: ${message}` } : item));
	}
}

function snapshotFiles(cwd: string, paths: string[]): Map<string, string | null> {
	const out = new Map<string, string | null>();
	for (const path of paths) {
		try { out.set(path, readFileSync(join(cwd, path), "utf8")); }
		catch { out.set(path, null); }
	}
	return out;
}

function changedSinceSnapshot(cwd: string, before: Map<string, string | null>): string[] {
	const changed: string[] = [];
	for (const [path, oldContent] of before) {
		let next: string | null = null;
		try { next = readFileSync(join(cwd, path), "utf8"); } catch { next = null; }
		if (next !== oldContent) changed.push(path);
	}
	return changed;
}

/** Per-attempt cap on RED-oracle re-prompts of the tdd-guide agent when the
 *  RED phase is NOT yet confirmed (green/broken). Counts retries AFTER the
 *  initial RED attempt, so `MAX_ATTEMPTS - 1` yields the same total try count as
 *  the outer green loop (5 total TDD tries by default). */
const MAX_RED_RETRIES = Math.max(0, MAX_ATTEMPTS - 1);
const pad = (n: number) => String(n).padStart(2, "0");

export function runtimeInstructionFingerprint(specDir: string | undefined): string {
	const notes = userNotesForAgent(specDir);
	let hash = 2166136261;
	for (let i = 0; i < notes.length; i++) {
		hash ^= notes.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `${notes.length}:${(hash >>> 0).toString(16)}`;
}

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
 *  knows the verified RED status. The CONFIRMED-red marker appears ONLY on a
 *  verified `red`; unconfirmed green/broken no longer reaches the implementer,
 *  while `unknown` remains a non-stalling greenfield/no-runner fallback. */
function redImplementContext(status: RedStatus): string {
	if (status === "red") {
		return "The TDD tests are CONFIRMED-red; your goal is to make them green.";
	}
	// unknown — red could not be determined at all (e.g. greenfield: no test runner).
	return "The TDD red status could not be confirmed (status: unknown) — proceeding; red was not verified.";
}

function quoteCmdArg(arg: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function redCheckOptions(ctx: StageContext, phaseId: string, diagnostics?: RedCheckDiagnostic[]) {
	return {
		signal: ctx.signal,
		onPlan(plans: RedCheckPlan[]) {
			for (const plan of plans) {
				ctx.log(`Implementation ${phaseId} RED test plan: cwd=${plan.cwd} cmd=${plan.argv.map(quoteCmdArg).join(" ")}`);
			}
		},
		onResult(diagnostic: RedCheckDiagnostic) {
			diagnostics?.push(diagnostic);
			ctx.log(`Implementation ${phaseId} RED runner diagnostic: ${formatRedDiagnosticSummary(diagnostic)}`);
		},
	};
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
		const startInstructionFingerprint = runtimeInstructionFingerprint(state.setup?.specDirectory);
		const priorImpl = (state.implementation ?? {}) as { phaseStatus?: PhaseStatusEntry[]; lastFailures?: PhaseFailureEntry[]; runtimeInstructionFingerprint?: string; invalidatedByRuntimeInstructions?: boolean };
		const priorInstructionInvalidated = priorImpl.invalidatedByRuntimeInstructions === true || (typeof priorImpl.runtimeInstructionFingerprint === "string" && priorImpl.runtimeInstructionFingerprint !== startInstructionFingerprint);
		let phaseStatus: PhaseStatusEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.phaseStatus) ? priorImpl.phaseStatus.map((p) => ({ ...p })) : []);
		let lastFailures: PhaseFailureEntry[] = priorInstructionInvalidated ? [] : (Array.isArray(priorImpl.lastFailures) ? priorImpl.lastFailures.map((f) => ({ ...f, reasons: [...f.reasons] })) : []);
		if (priorInstructionInvalidated) ctx.log("Implementation: runtime user instructions changed — invalidating prior green phase carry and re-running phases");
		if (phaseStatus.length) ctx.log(`Implementation: resuming convergence iteration (${phaseStatus.filter((p) => p.status === "green").length}/${phases.length} phases already green)`);
		let phasesCompleted = 0;
		let allGreen = true;
		const filesModified: string[] = [];

		for (const [idx, phase] of phases.entries()) {
			const phaseId = `phase-${pad(idx + 1)}`;
			const phaseName = (phase as { name?: string }).name?.trim() || phaseId;
			const phaseHeadline = `Implementation — Phase ${idx + 1}/${phases.length}: ${phaseName}`;
			const phaseLabel = `↳ Phase ${idx + 1}/${phases.length}: ${phaseName}`;
			let phaseLifecycleStarted = false;
			const emitPhaseStatus = (status: "running" | "ok" | "failed" | "skipped") => {
				ctx.events.emit("stage", {
					id: `implementation.${phaseId}`,
					label: phaseLabel,
					status,
					kind: "phase",
					parentId: "implementation",
				});
			};
			const ensurePhaseRunning = () => {
				if (phaseLifecycleStarted) return;
				phaseLifecycleStarted = true;
				emitPhaseStatus("running");
			};
			const announceActivity = (activity?: string, detail?: string) => {
				const suffix = activity ? ` — ${activity}${detail ? ` (${detail})` : ""}` : "";
				ctx.phase(`${phaseHeadline}${suffix}`);
			};
			const attemptDetail = (attempt: number, extra?: string) =>
				[`attempt ${attempt}/${MAX_ATTEMPTS}`, extra].filter(Boolean).join(", ");
			// §D: skip a phase already green in a prior convergence iteration (don't
			// re-touch done work — the state-confusion churn §F fought).
			if (phaseStatus.some((p) => p.id === phaseId && p.status === "green")) {
				phasesCompleted++;
				emitPhaseStatus("ok");
				ctx.log(`Implementation ${phaseId} already green (prior convergence iteration) — skipping`);
				continue;
			}
			let green = false;
			let attemptErrors: string[] = [];
			let attemptsRun = 0;
			let terminalFailureKind: "red-generation" | "implementation-gate" = "implementation-gate";
			let terminalRedTries = 0;
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
			// Symbol/hollow-file gate: claimed source deliverables that EXIST but contain
			// NO code (doc-comment-only shells) — fed into the next implementer retry.
			let hollowFiles: string[] = [];
			// Phase bracketing (spec-11 Phase 3, AC-04 → SCENARIO-008/009): snapshot the
			// git baseline BEFORE the attempts so each per-attempt `tracker.end`
			// computes the delta from phase start; the change-gate reads the freshest
			// end-record. Never throws (tracker contract); no-op when no tracker active.
			const tracker = getActiveTracker();
			// §F #1 — pre-implement no-op detection (the state-confusion root cause):
			// ONLY for explicit resume runs. A fresh run must never count pre-existing
			// files/patterns as a completed phase without TDD + build verification.
			// Even on resume, this is a verified no-op: run the deterministic build gate
			// and full deliverable check before marking the phase green.
			const phaseDeliverables = (phase as { deliverables?: DeliverableContract }).deliverables;
			const resumeNoOpAllowed = ctx.options.resume === true || typeof ctx.options.resume === "string";
			if (resumeNoOpAllowed && phaseDeliverables && deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables)) {
				ensurePhaseRunning();
				announceActivity("Resume verification");
				resetDeliverableCheckCache();
				announceActivity("Build gate", "resume verification");
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
				announceActivity("Deliverable check", "resume verification");
				const deliverableCheck = runDeliverableCheck(setup.worktreePath, phaseDeliverables, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass) });
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
					ctx.log(`Implementation ${phaseId} no-op: resume deliverables already satisfied and verified — skipping implementer`);
					phaseStatusUpsert(phaseStatus, phaseId, "green");
					emitPhaseStatus("ok");
					const fi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (fi >= 0) lastFailures.splice(fi, 1);
					phasesCompleted++;
					continue;
				}
				ctx.log(`Implementation ${phaseId} no-op rejected: resume verification failed (build=${gate.pass || gate.inScopePass}, missing=${deliverableCheck.missing.join("; ") || "none"}) — running implementer`);
				attemptErrors = gate.errors;
				missingDeliverables = deliverableCheck.missing;
			}
			// Pi-native sub-phase subtitle: announce WHICH phase is being implemented
			// AFTER the skip guards (so a skipped/already-green phase never flickers a
			// subtitle it isn't working on). Surfaces "Phase N/M: <name>" as the
			// dashboard header/working-message + a distinct ▶ line under the running
			// stage's live-log section. phase.name falls back to the phase id.
			// Emit the dashboard sub-stage row BEFORE the subtitle so the live-stream sink
			// tags the subtitle/progress under the current implementation phase.
			ensurePhaseRunning();
			announceActivity();
			if (tracker) tracker.begin("phase", phaseId);
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				attemptsRun = attempt;
				if (!ctx.budget.check()) {
					allGreen = false;
					return { phasesCompleted, totalPhases: phases.length, allGreen, filesModified, summary: "Budget exhausted" };
				}
				announceActivity("Route specialist", attemptDetail(attempt));
				const specialist = await ctx.helper({ name: "route-specialist", sources: { "classify-task": state.classify }, options: { phase } });
				const lang = (specialist.value.languageInstructions as string) ?? "";
				// Gap 3 (AC-03 → SCENARIO-010): the RED-phase prompt carries the no-`--lib`
				// Rust verification discipline via the shared `langInstructions` slot so
				// `buildTddPrompt` and `buildImplementPrompt` reference the IDENTICAL
				// `RUST_SELF_VERIFY_DISCIPLINE` source string (single source of truth).
				// For non-rust setups `rustDiscipline(setup)` is "" and the specialist's
				// languageInstructions still flow through (no regression).
				// RED phase: generate tests until the RED boundary and RED oracle are both
				// acceptable. Weak-green tests, broken tests, and RED pollution are retried
				// here before the implementer runs, so a bad RED sample does not consume or
				// masquerade as a GREEN implementation attempt.
				const redBaseline = gitStatusPaths(setup.worktreePath);
				const baselineDeliverablesSatisfied = phaseDeliverables ? deliverablesAlreadyMet(setup.worktreePath, phaseDeliverables) : false;
				let retries = 0;
				let redHint = "";
				let testFiles: string[] = [];
				let redStatus: RedStatus = "unknown";
				let redChangedFiles: string[] = [];
				let redEvidence: RedEvidence | null = null;
				while (true) {
					const redDiagnostics: RedCheckDiagnostic[] = [];
					const redTryDetail = attemptDetail(attempt, `try ${retries + 1}/${MAX_RED_RETRIES + 1}`);
					const tddId = retries === 0
						? `pipeline.implementation.${phaseId}.tdd.a${attempt}`
						: `pipeline.implementation.${phaseId}.tdd.red${retries}.a${attempt}`;
					announceActivity("TDD RED", redTryDetail);
					const tdd = await ctx.agent({ id: tddId, agent: "tdd-guide", prompt: buildTddPrompt(setup, state.classify ?? null, phase, state.spec ?? null, [lang, rustDiscipline(setup)].filter(Boolean).join("\n\n")) + redHint });
					const filesRaw = (tdd.control as { testFiles?: unknown } | null)?.testFiles;
					testFiles = filesRaw == null && testFiles.length ? testFiles : normalizeStringArray(filesRaw);
					announceActivity("RED oracle", redTryDetail);
					redStatus = runRedCheck(setup.worktreePath, testFiles, redCheckOptions(ctx, phaseId, redDiagnostics));
					ctx.log(`Implementation ${phaseId} red-oracle: ${redStatus} (ran: ${testFiles.join(",") || "n/a"})`);
					redChangedFiles = setDiff(gitStatusPaths(setup.worktreePath), redBaseline);
					announceActivity("RED boundary", redTryDetail);
					const boundary = await resolveRedBoundary({ ctx, phaseId, phaseName, phase, redStatus, testFiles, changedFiles: redChangedFiles });
					ctx.log(`Implementation ${phaseId} RED boundary: ${boundarySummary(boundary)}`);
					redEvidence = classifyRedEvidence({ phaseId, attempt, redStatus, testFiles, changedFiles: redChangedFiles, boundary, redRetries: retries, alreadySatisfied: baselineDeliverablesSatisfied, diagnostics: redDiagnostics });
					appendImplementationEvidence(setup.specDirectory, redEvidence);
					if (redEvidence.status === "polluted-red") {
						restorePaths(setup.worktreePath, redEvidence.forbiddenFiles);
					}
					const retryHint = redGenerationRetryHint(redEvidence);
					if (retryHint && retries < MAX_RED_RETRIES) {
						if (redEvidence.status === "green-weak-test" || redEvidence.status === "polluted-red") {
							restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.changedFiles);
						}
						retries++;
						redHint = retryHint;
						ctx.log(`Implementation ${phaseId} RED generation retry ${retries}/${MAX_RED_RETRIES}: ${redEvidenceFailureReasons(redEvidence).join("; ") || redEvidence.reason || redEvidence.status}`);
						continue;
					}
					break;
				}
				if (!redEvidence) {
					attemptErrors = ["red-generation: no RED evidence produced"];
					terminalFailureKind = "red-generation";
					terminalRedTries = 0;
					ctx.log(`Implementation ${phaseId} RED generation failed after 0 tries`);
					break;
				}
				if (redEvidence.status === "green-already-satisfied") {
					resetDeliverableCheckCache();
					announceActivity("Already-satisfied verification", attemptDetail(attempt));
					announceActivity("Build gate", attemptDetail(attempt));
					const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
					announceActivity("Deliverable check", attemptDetail(attempt));
					const deliverableCheck = runDeliverableCheck(setup.worktreePath, phaseDeliverables ?? {}, { signal: ctx.signal, skipTests: !(gate.pass || gate.inScopePass) });
					ctx.log(`Implementation ${phaseId} RED already-satisfied: build=${gate.pass || gate.inScopePass}, deliverables=${deliverableCheck.pass}`);
					if ((gate.pass || gate.inScopePass) && deliverableCheck.pass) {
						green = true;
						phaseStatusUpsert(phaseStatus, phaseId, "green");
						emitPhaseStatus("ok");
						const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
						break;
					}
					attemptErrors = gate.errors;
					missingDeliverables = deliverableCheck.missing;
					ctx.log(`Implementation ${phaseId} RED already-satisfied verification FAIL: ${[...attemptErrors, ...missingDeliverables.map((e) => `deliverable: ${e}`)].join("; ") || "phase gates unmet"}`);
					break;
				}
				const redFailures = redEvidenceFailureReasons(redEvidence);
				if (redFailures.length) {
					restoreUnacceptedRedChanges(ctx, setup.worktreePath, phaseId, redEvidence.changedFiles);
					attemptErrors = redFailures;
					terminalFailureKind = "red-generation";
					terminalRedTries = retries + 1;
					ctx.log(`Implementation ${phaseId} RED generation failed after ${retries + 1} tries`);
					ctx.log(`Implementation ${phaseId} RED gate FAIL: ${redFailures.join("; ")}`);
					ctx.log(redEvidenceLogLine(redEvidence));
					break;
				}
				const redTestSnapshot = redStatus === "red" && testFiles.length > 0 ? snapshotFiles(setup.worktreePath, testFiles) : new Map<string, string | null>();
				const redTargetsExist = Array.from(redTestSnapshot.values()).some((content) => content !== null);
				const confirmedRedTargets = redStatus === "red" && testFiles.length > 0 && (redChangedFiles.length > 0 || redTargetsExist);
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
				if (hollowFiles.length) {
					implParts.push(`## Hollow deliverable files — these exist but contain only comments / no real code; write the actual implementation (functions/types/etc.) in each\n${hollowFiles.map((e) => `- ${e}`).join("\n")}`);
				}
				implParts.push(redImplementContext(redStatus));
				const implPrompt = implParts.join("\n\n");
				announceActivity("Implementation", attemptDetail(attempt));
				const impl = await ctx.agent({ id: `pipeline.implementation.${phaseId}.impl.a${attempt}`, agent: "implementer", prompt: implPrompt });
				// spec-11 AC-06/AC-10: the implementer's claimed change set is now STRUCTURED
				// ({filesCreated, filesModified, filesDeleted}). parseStructuredChanges reads
				// it (and back-tolerates the legacy flat filesModified array). The flat
				// summary list derives from filesCreated ∪ filesModified — deleted is
				// EXCLUDED (a deleted file is not a "modified" display entry). dedupe via
				// the existing `filesModified.includes` guard (first-seen order preserved).
				const structured = parseStructuredChanges(impl.control);
				const projectStructured: StructuredChanges = {
					filesCreated: structured.filesCreated.filter((f) => !isInternalRuntimeClaim(f)),
					filesModified: structured.filesModified.filter((f) => !isInternalRuntimeClaim(f)),
					filesDeleted: structured.filesDeleted.filter((f) => !isInternalRuntimeClaim(f)),
				};
				for (const f of [...projectStructured.filesCreated, ...projectStructured.filesModified]) {
					if (!filesModified.includes(f)) filesModified.push(f);
				}
				// HARD test oracle: actually run build/test/typecheck instead of trusting
				// a QA agent's self-report (vacuous-pass risk). Non-fatal when nothing
				// is detectable (greenfield): ran is empty and pass is true.
				announceActivity("Build gate", attemptDetail(attempt));
				const gate = runBuildGate(setup.worktreePath, { gate: (state.spec?.gate) as GateOptions | undefined, signal: ctx.signal });
				attemptErrors = gate.errors;
				ctx.log(`Implementation ${phaseId} build-gate ${gate.pass ? "PASS" : "FAIL"} (ran: ${gate.ran.join(", ") || "no commands"})`);
				// AR-02: emit the pi session/model correlation tag to the run trace.
				const corr = buildGateCorrelationLine(gate);
				if (corr) ctx.log(corr);
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
						...projectStructured.filesCreated,
					])),
				};
				announceActivity("Deliverable check", attemptDetail(attempt));
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
				announceActivity("Change check", attemptDetail(attempt));
				if (tracker) {
					// Per-attempt PROBE (compute + store, no jsonl append) so the retry
					// injection sees the freshest claimedNotChanged (SCENARIO-015).
					// The bracket is closed EXACTLY ONCE via commitEnd after the attempt
					// loop so the jsonl trace keeps single begin/end-per-phase nesting
					// (AC-04 → SCENARIO-008/009, review finding CR-MED).
					phaseChangeRec = tracker.probeEnd("phase", phaseId, structured);
				}
				const changeGate = computeChangeGate(phaseChangeRec);
				// Symbol/hollow-file gate (silent-empty-success killer): a claimed source
				// deliverable that EXISTS (passes deliverable + change gates) but contains
				// NO code symbols (doc-comment-only shell) is rejected here. Never throws;
				// degrades to pass on unreadable files / unknown language / no source files.
				announceActivity("Symbol check", attemptDetail(attempt));
				const symbolGate = computeSymbolGate(setup.worktreePath, [...projectStructured.filesCreated, ...projectStructured.filesModified], setup.language);
				ctx.log(`Implementation ${phaseId} symbol-check ${symbolGate.pass ? "PASS" : "FAIL"} (hollow: ${symbolGate.hollowFiles.join("; ") || "none"})`);
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
				hollowFiles = symbolGate.hollowFiles;
				const tddOracleFailures: string[] = [];
				if (confirmedRedTargets) {
					const modifiedRedTests = changedSinceSnapshot(setup.worktreePath, redTestSnapshot);
					if (modifiedRedTests.length) {
						tddOracleFailures.push(`tdd-tests-modified-during-green: ${modifiedRedTests.join(", ")}`);
						ctx.log(`Implementation ${phaseId} post-red-oracle: skipped because confirmed RED test file(s) changed during GREEN (${modifiedRedTests.join(", ")})`);
					} else {
						announceActivity("Post-RED oracle", attemptDetail(attempt));
						const postRedStatus = runRedCheck(setup.worktreePath, testFiles, redCheckOptions(ctx, phaseId));
						ctx.log(`Implementation ${phaseId} post-red-oracle: ${postRedStatus} (ran: ${testFiles.join(",") || "n/a"})`);
						if (postRedStatus === "red") tddOracleFailures.push(`tdd-targets-still-red: ${testFiles.join(", ")}`);
						else if (postRedStatus === "broken") tddOracleFailures.push(`tdd-targets-broken-after-implementation: ${testFiles.join(", ")}`);
						else if (postRedStatus !== "green") tddOracleFailures.push(`tdd-targets-unverified-after-implementation: ${testFiles.join(", ")}`);
					}
				}
				// In-scope verdict (AC-05 → SCENARIO-012/013/014/025/027): the phase is GREEN
				// when the gate fully passed OR when every failure is a pre-existing
				// out-of-scope crate the branch never touched (gate.inScopePass). The
				// `if (!green)` branch below therefore fires ONLY on genuine in-scope
				// failures — neither pass nor inScopePass after MAX_ATTEMPTS — so
				// pre-existing breakage elsewhere can no longer abort green in-scope work.
				// spec-11 AC-07/AC-08 (SCENARIO-013): AND `changeGate.pass` so a
				// claimed-but-never-changed file hard-fails EVEN WHEN build + deliverable
				// both pass (the false-green killer, closed a second way).
				if ((gate.pass || gate.inScopePass) && deliverableCheck.pass && changeGate.pass && symbolGate.pass && tddOracleFailures.length === 0) {
					green = true;
					phaseStatusUpsert(phaseStatus, phaseId, "green");
					emitPhaseStatus("ok");
					const _gfi = lastFailures.findIndex((f) => f.phaseId === phaseId); if (_gfi >= 0) lastFailures.splice(_gfi, 1);
					if (gate.pass) {
						ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
					} else {
						ctx.log(`Implementation ${phaseId} IN-SCOPE GREEN on attempt ${attempt} — ${gate.outOfScopeErrors.length} pre-existing out-of-scope failure(s) ignored (crates: ${cratesFromErrors(gate.outOfScopeErrors).join(",")})`);
					}
					break;
				}
				const failureReasons = [
					...gate.errors,
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
					...tddOracleFailures,
				];
				attemptErrors = failureReasons;
				ctx.log(`Implementation ${phaseId} attempt ${attempt}/${MAX_ATTEMPTS} FAIL: ${failureReasons.join("; ") || "phase gates unmet"}`);
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
				emitPhaseStatus("failed");
				lastFailuresUpsert(lastFailures, phaseId, [
					...attemptErrors,
					...missingDeliverables.map((e) => `deliverable: ${e}`),
					...claimedNotChanged.map((e) => `claimed-not-changed: ${e}`),
					...hollowFiles.map((e) => `hollow-file: ${e}`),
				]);
				if (terminalFailureKind === "red-generation") {
					ctx.log(`Implementation ${phaseId} stopped before implementation: RED generation exhausted after ${terminalRedTries} tries in implementation attempt ${attemptsRun} — convergence will retry this phase if budget remains`);
				} else {
					ctx.log(`Implementation ${phaseId} failed after ${attemptsRun} attempts — terminating early`);
				}
				allGreen = false;
				break;
			}
			phasesCompleted++;
			if (ctx.budget.check()) {
				announceActivity("Commit");
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
			runtimeInstructionFingerprint: runtimeInstructionFingerprint(state.setup?.specDirectory),
			invalidatedByRuntimeInstructions: false,
			summary: allGreen ? `All ${phases.length} phases completed successfully` : `${phasesCompleted}/${phases.length} phases completed`,
		};
		if (ctx.budget.check()) {
			ctx.phase("Implementation — Summary");
			const summaryResult = await ctx.agent({ id: "pipeline.implementation.summary", agent: "orchestrator", prompt: buildImplementationSummaryPrompt(setup, state.classify ?? null, control), schema: STAGE_MODELS["implementationSummary"]?.schema });
			renderAndWrite(setup, (m) => ctx.log(m), "implementationSummary", summaryResult.control as Record<string, unknown> | null);
		}
		const endInstructionFingerprint = runtimeInstructionFingerprint(state.setup?.specDirectory);
		const runtimeInstructionsChangedDuringRun = endInstructionFingerprint !== startInstructionFingerprint;
		if (runtimeInstructionsChangedDuringRun && phasesCompleted > 0) {
			control.allGreen = false;
			control.invalidatedByRuntimeInstructions = true;
			control.summary = "Runtime user instructions changed during implementation; re-run required";
			ctx.log("Implementation: runtime user instructions arrived during implementation — forcing one more convergence pass so earlier phases can incorporate them");
		}
		control.runtimeInstructionFingerprint = endInstructionFingerprint;
		return control;
	},
};
