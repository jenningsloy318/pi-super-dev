/**
 * FLYWHEEL (P3 / D4 / DEC-11 + DEC-13 / §8.1 / §8.3 M1) — the zero-LLM,
 * propose/apply-split dataset lifecycle that closes the eval loop.
 *
 * Everything here is DETERMINISTIC drafting and bookkeeping over the
 * user-local eval artifacts under ~/.super-dev/evals/ (DEC-5): no LLM call
 * anywhere, no prompt is ever edited, nothing enters cases/ on its own. The
 * HUMAN GATE is non-negotiable (DEC-11③ / L7): proposals are DRAFTS — a
 * draft becomes a golden case only when the maintainer moves the file into
 * cases/ BY HAND (mv = the human gate; the flywheel lesson-optimization
 * Goodhart hazard is exactly why the gate is human).
 *
 * Sub-competences (spec citations):
 *   - DEC-13① premise gate: proposal drafting runs ONLY when the D7
 *     validation gate has PASSED (posture calibrated) for the scored
 *     surface. Adversarial-gate F-01a (gate-deadlock fix): the wiring's
 *     LIVE gate decision is honored only at a genuine posture — calibrated
 *     ⇒ drafting armed, miscalibrated ⇒ blocked (fix the rubric/mapping,
 *     not the data); directional-only (or a null gate) is NO SIGNAL about
 *     the scorer, never a verdict — the deterministic LEDGER recompute
 *     (runGate over rows.jsonl + labels) decides instead, so a single-run
 *     n=1 gate can never freeze drafting against an accumulating ledger.
 *     No calibration signal anywhere ⇒ drafting stays off with an honest
 *     note (the premise is unproven, not disproven).
 *   - DEC-13② discrimination: paired comparison across configStamps over
 *     the same caseSet — two known-different stamps with indistinguishable
 *     verdict distributions on ≥ DISCRIM_MIN_CASES cases ⇒ loud advisory
 *     ("fix case difficulty, do not artificially harden"). Report line
 *     only — never blocks.
 *   - DEC-13③ saturation: per-case all-agree streak over scored runs; a
 *     case agreeing for STREAK_N consecutive scored runs is marked
 *     `saturated` — excluded from the proposal-drafting signal, STILL
 *     scored as the regression baseline, NEVER deleted. First disagreement
 *     un-saturates. Streaks are RECOMPUTED from rows.jsonl every run
 *     (idempotent — no incremental drift between ledger and state).
 *     scorerDegraded rows FREEZE the streak (F-08: a degraded floor row is
 *     neither agreement nor disagreement).
 *   - DEC-13④ evolution refresh: state.json records lastSeenExtensionVersion;
 *     a version change flags golden cases for maintainer re-review (caller
 *     may narrow with a changed-modules list; null/absent = the conservative
 *     default flags ALL, an EMPTY list flags NONE — F-10) and writes the
 *     refresh-pending marker the maintainer clears (rm) after re-review.
 *   - §8.1 contamination scan: the canary/7-gram scan over learned-index ×
 *     golden-case texts runs here at minimum (evolution/contamination.ts —
 *     the same scan the learned.ts injection seam enforces per load).
 *   - §8.3 M1 baseline re-key: noteProposalApplied(caseSet) stamps
 *     state.json so P4-era banding consumers know (caseSet, caseVersion,
 *     rubricVersion) baselines must re-key after a proposal lands. The
 *     eval-row banding baselines themselves are NOT built this wave — the
 *     stamp + this documentation is the deliverable.
 *
 * Fail-open hard constraint (P4/P5): the flywheel can NEVER fail or block
 * the run under review — the orchestrator is one try/catch and every layer
 * inside degrades to an honest note. The wiring disables it under
 * SUPER_DEV_NO_EVAL_STAGE alongside the eval stage (same class); it is
 * deterministic, so it needs no budget guard of its own.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SUPER_DEV_EXTENSION_VERSION } from "../version.ts";
import { PROTOTYPE_VERDICT_VALUES } from "../stages/prototype.ts";
import { MIN_PRIOR_RUNS, type BandPosition } from "./sigma-bands.ts";
import {
	TARGET_AGENTS, TARGET_SEPARATOR, TARGET_STAGES, VERDICT_CLOSURE, allowedVerdictsForTarget,
	loadGateLabels, loadGoldenCases, makeCanary, validateGoldenCase,
	type GoldenCase,
} from "./eval-layer.ts";
import { runGate, EVAL_DATASET_BASENAME, type EvalRow } from "./eval-stage.ts";
import {
	casesDir, contaminationLedgerPath, flywheelStatePath, labelsDir, proposalsDir,
	refreshMarkerPath, runsDir,
} from "./eval-shared.ts";
import { scanLearnedIndexForContamination, type ContaminationFinding } from "./contamination.ts";

// ─── named constants (README-documented; NOT env keys) ──────────────────────

/** DEC-13③: consecutive all-agree scored runs before a case is saturated.
 *  (§8.5 calibrated the same knob to 3 review cycles; the P3 task ruling
 *  pins 5 SCORED RUNS — the stricter, run-granular spelling.) */
export const STREAK_N = 5;

/** DEC-13②: minimum shared cases an indistinguishable configStamp pair must
 *  cover before the discrimination advisory fires. MIN_PRIOR_RUNS imported,
 *  not re-typed — the SAME statistical honesty floor as σ-bands and the
 *  validation gate (P6 single grammar). */
export const DISCRIM_MIN_CASES = MIN_PRIOR_RUNS;

/** A drafting cluster must span at least this many DISTINCT runs — a
 *  single-run anomaly is noise, not a flywheel signal (DEC-11①'s "systemic
 *  failure" bar, proposal-side spelling). */
export const PROPOSAL_MIN_RUNS = 2;

/** Adversarial-gate F-02 (re-draft loop): a REGISTERED cluster (already
 *  drafted once — see state.proposalClusters) is re-drafted only after it
 *  accumulated at least this many NEW runIds since the last draft — the
 *  honest reject-then-reevidence path (a rejected draft returns with more
 *  evidence, not on every run). */
export const PROPOSAL_NEW_RUNS = 3;

/** The σ-band anomaly positions a trajectory cluster drafts from (in-band is
 *  health, no-band is an honesty skip — neither is a failure signal). */
export const ANOMALY_BAND_POSITIONS: readonly BandPosition[] = ["1σ", "2σ", "3σ"];

// ─── persisted state (~/.super-dev/evals/state.json) ─────────────────────────

/** Per-case lifecycle (DEC-13③), recomputed from rows.jsonl each run. */
export interface FlywheelCaseState {
	/** Consecutive agreeing scored runs (latest last). */
	streak: number;
	/** streak ≥ STREAK_N — excluded from drafting signal; still scored;
	 *  never deleted. */
	saturated: boolean;
	lastRunId: string;
	lastTs: number;
	/** Current-version scored runs consumed (older-revision rows are not
	 *  mixed in — M2). */
	observedRuns: number;
}

/** §8.3 M1: append-only apply stamps — P4-era banding consumers re-key
 *  (caseSet, caseVersion, rubricVersion) baselines after each row. */
export interface ProposalAppliedStamp {
	caseSet: string;
	appliedAt: number;
}

/** Adversarial-gate F-02: the proposal-draft registry entry — what was
 *  drafted for a cluster key, when, and with which runIds (the NEW-runIds
 *  delta against this set gates re-drafting). Keyed by the deterministic
 *  cluster identity WITHOUT runIds, so the registry SURVIVES the
 *  maintainer's mv (the file may be gone; the cluster is still known). */
export interface ProposalClusterRecord {
	proposalId: string;
	draftedAt: number;
	runIds: string[];
}

export interface FlywheelState {
	schema: 1;
	/** DEC-13④: the extension version this state last saw. */
	lastSeenExtensionVersion: string;
	cases: Record<string, FlywheelCaseState>;
	proposalApplied: ProposalAppliedStamp[];
	/** F-02: clusterKey → the last draft's record (re-draft gating). */
	proposalClusters: Record<string, ProposalClusterRecord>;
}

export function defaultFlywheelState(version: string = SUPER_DEV_EXTENSION_VERSION): FlywheelState {
	// First-ever run: lastSeen = current — no refresh wave on cold start
	// (nothing existed to be stale; honest, and the marker would be noise).
	return { schema: 1, lastSeenExtensionVersion: version, cases: {}, proposalApplied: [], proposalClusters: {} };
}

/** Best-effort state read: missing → default; corrupt → default + LOUD
 *  (a corrupt lifecycle ledger is rebuilt deterministically from rows.jsonl
 *  on the next pass — recompute is the source of truth, never throws). */
export function readFlywheelState(path: string = flywheelStatePath(), opts: { log?: (m: string) => void; version?: string } = {}): FlywheelState {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FlywheelState>;
		if (parsed !== null && typeof parsed === "object" && typeof parsed.lastSeenExtensionVersion === "string" && parsed.cases !== null && typeof parsed.cases === "object" && Array.isArray(parsed.proposalApplied)) {
			// proposalClusters is F-02-new: a pre-F-02 state file carries none —
			// tolerate and default ({}), never reject the whole state over it.
			const clusters = parsed.proposalClusters !== null && typeof parsed.proposalClusters === "object" ? parsed.proposalClusters as FlywheelState["proposalClusters"] : {};
			return { schema: 1, lastSeenExtensionVersion: parsed.lastSeenExtensionVersion, cases: parsed.cases as FlywheelState["cases"], proposalApplied: parsed.proposalApplied, proposalClusters: clusters };
		}
		opts.log?.(`flywheel: state.json malformed — rebuilding from the rows ledger (deterministic recompute)`);
	} catch {
		/* missing file = cold start */
	}
	return defaultFlywheelState(opts.version);
}

/** Best-effort state write (never throws; parent dirs created). */
export function writeFlywheelState(path: string, state: FlywheelState): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, "\t") + "\n", "utf8");
	} catch { /* best-effort persistence (P5) */ }
}

// ─── dataset rows (~/.super-dev/evals/runs/rows.jsonl) ───────────────────────

export interface LoadedEvalRows {
	rows: EvalRow[];
	/** Unparseable lines skipped (named discard, P10). */
	malformedLines: number;
}

/** Best-effort rows read (missing file → empty; never throws). */
export function readEvalRows(datasetDir: string = runsDir()): LoadedEvalRows {
	let text: string;
	try {
		text = readFileSync(join(datasetDir, EVAL_DATASET_BASENAME), "utf8");
	} catch {
		return { rows: [], malformedLines: 0 };
	}
	const rows: EvalRow[] = [];
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as EvalRow;
			if (typeof parsed?.runId === "string" && typeof parsed?.verdict === "string" && typeof parsed?.scorerKind === "string") rows.push(parsed);
			else malformedLines += 1;
		} catch {
			malformedLines += 1;
		}
	}
	return { rows, malformedLines };
}

// ─── DEC-13③ saturation (pure recompute from the rows ledger) ────────────────

/** One scored observation of a case in one run (the LAST row for that run —
 *  a run scores a case once; defensive against duplicate emission). */
export interface CaseObservation {
	runId: string;
	ts: number;
	caseVersion: number;
	verdict: string;
}

/** The case's scored observations, ascending by time (deterministic:
 *  ts, then ledger order). Adversarial-gate F-08: scorerDegraded rows are
 *  SKIPPED — a degraded floor row is the instrument abstaining, neither
 *  agreement nor disagreement, so the streak FROZES through it (the run
 *  contributes no observation) instead of resetting. */
export function caseObservations(rows: readonly EvalRow[], caseId: string): CaseObservation[] {
	const byRun = new Map<string, CaseObservation>();
	rows.forEach((row) => {
		if (row.caseRef !== caseId) return;
		if (row.scorerDegraded === true) return; // F-08: frozen, not judged
		const obs: CaseObservation = { runId: String(row.runId), ts: Number(row.ts ?? 0), caseVersion: Number(row.caseVersion ?? 1), verdict: String(row.verdict) };
		const prev = byRun.get(obs.runId);
		if (prev === undefined || obs.ts > prev.ts) byRun.set(obs.runId, obs);
		else if (obs.ts === prev.ts && obs.caseVersion > prev.caseVersion) byRun.set(obs.runId, obs);
	});
	return [...byRun.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Recompute every loaded case's lifecycle from the rows ledger (pure;
 * idempotent — the state file only persists this recompute). Only rows whose
 * caseVersion equals the case's CURRENT version count: a revised case is a
 * new row identity and old-version rows never mix into the streak (M2).
 * Agreement = verdict === expected.verdict; an honest-absent / non-closure
 * verdict is NOT agreement (an abstention is not green) — it resets the
 * streak and un-saturates.
 */
export function computeCaseStates(rows: readonly EvalRow[], cases: readonly GoldenCase[]): Record<string, FlywheelCaseState> {
	const out: Record<string, FlywheelCaseState> = {};
	for (const c of cases) {
		const observations = caseObservations(rows, c.id).filter((o) => o.caseVersion === c.caseVersion);
		if (observations.length === 0) continue;
		let streak = 0;
		for (const o of observations) {
			if (o.verdict === c.expected.verdict) streak += 1;
			else streak = 0; // disagreement OR honest absent — not green
		}
		const last = observations[observations.length - 1]!;
		out[c.id] = { streak, saturated: streak >= STREAK_N, lastRunId: last.runId, lastTs: last.ts, observedRuns: observations.length };
	}
	return out;
}

// ─── DEC-13② discrimination (pure paired comparison) ────────────────────────

export interface DiscriminationOutcome {
	/** Loud advisory lines (report only — never blocks). */
	advisories: string[];
	/** Unordered configStamp pairs compared (observability). */
	pairsCompared: number;
}

/** Fraction-free distribution equality: countA(v)/totalA === countB(v)/totalB
 *  for every verdict ⟺ countA(v)*totalB === countB(v)*totalA. */
function distributionsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
	const totalA = [...a.values()].reduce((s, n) => s + n, 0);
	const totalB = [...b.values()].reduce((s, n) => s + n, 0);
	if (totalA === 0 || totalB === 0) return false;
	const verdicts = new Set([...a.keys(), ...b.keys()]);
	for (const v of verdicts) {
		if ((a.get(v) ?? 0) * totalB !== (b.get(v) ?? 0) * totalA) return false;
	}
	return true;
}

/**
 * Paired comparison across configStamps (§8.5: PAIRED, not independent
 * samples): per caseSet, for each unordered pair of configStamps, count the
 * shared cases whose verdict DISTRIBUTIONS are identical. ≥ DISCRIM_MIN_CASES
 * indistinguishable shared cases ⇒ the suite-lacks-discrimination advisory
 * (fix difficulty, never artificially harden). Honest-absent rows are
 * excluded (an abstention carries no distribution information).
 */
export function checkDiscrimination(rows: readonly EvalRow[]): DiscriminationOutcome {
	// caseSet → caseRef → configStamp → verdict → count
	const byCaseSet = new Map<string, Map<string, Map<string, Map<string, number>>>>();
	for (const row of rows) {
		if (row.caseRef === undefined || !VERDICT_CLOSURE.includes(row.verdict) || typeof row.configStamp !== "string" || row.configStamp === "") continue;
		const caseSet = typeof row.caseSet === "string" && row.caseSet !== "" ? row.caseSet : "(no-caseSet)";
		const byCase = byCaseSet.get(caseSet) ?? new Map<string, Map<string, Map<string, number>>>();
		byCaseSet.set(caseSet, byCase);
		const byStamp = byCase.get(row.caseRef) ?? new Map<string, Map<string, number>>();
		byCase.set(row.caseRef, byStamp);
		const counts = byStamp.get(row.configStamp) ?? new Map<string, number>();
		byStamp.set(row.configStamp, counts);
		counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
	}
	const advisories: string[] = [];
	let pairsCompared = 0;
	for (const [caseSet, byCase] of [...byCaseSet.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const stamps = [...new Set([...byCase.values()].flatMap((m) => [...m.keys()]))].sort();
		for (let i = 0; i < stamps.length; i++) {
			for (let j = i + 1; j < stamps.length; j++) {
				const a = stamps[i]!;
				const b = stamps[j]!;
				pairsCompared += 1;
				let shared = 0;
				let indistinguishable = 0;
				for (const [caseRef, byStamp] of byCase) {
					const distA = byStamp.get(a);
					const distB = byStamp.get(b);
					if (distA === undefined || distB === undefined) continue;
					shared += 1;
					if (distributionsEqual(distA, distB)) indistinguishable += 1;
				}
				if (shared >= DISCRIM_MIN_CASES && indistinguishable >= DISCRIM_MIN_CASES) {
					advisories.push(`flywheel: caseSet "${caseSet}" — configStamps ${a} vs ${b} are indistinguishable on ${indistinguishable}/${shared} shared cases — the suite lacks discrimination; fix case difficulty, do NOT artificially harden (DEC-13②)`);
				}
			}
		}
	}
	return { advisories, pairsCompared };
}

// ─── proposal drafting (DEC-11② — zero-LLM skeletons only) ──────────────────

export interface ProposalCluster {
	axis: "trajectory-band" | "final-response-dimension";
	/** trajectory arm: the target face. */
	target?: string;
	/** trajectory arm: the anomaly position. */
	bandPosition?: string;
	/** final-response arm: the failing rubric. */
	rubricId?: string;
	/** final-response arm: the failing dimension (row.metric). */
	dimension?: string;
	/** F-03: the configStamp the cluster's rows share — a cluster NEVER
	 *  bundles rows across configs (different stamps = different
	 *  data-generation processes = different proposal signals). */
	configStamp: string;
	rowCount: number;
	runIds: string[];
}

/** Cluster the rows ledger into drafting signals (pure):
 *  - trajectory rows at an ANOMALY band position, keyed (target,
 *    bandPosition, configStamp) — drift is the drafting signal (in-band is
 *    health);
 *  - final-response dimension rows with verdict "fail", keyed (rubricId,
 *    dimension, configStamp) — the row-level verdict is the deterministic
 *    assertion-outcome surface (per-assertion booleans ride eval.scored
 *    events, not rows.jsonl);
 *  - saturated cases' rows are EXCLUDED (DEC-13③: no longer a signal);
 *    scorerDegraded rows are excluded (M3 named discards);
 *  - a cluster must span ≥ PROPOSAL_MIN_RUNS distinct runs. */
export function draftClusters(rows: readonly EvalRow[], saturatedCaseIds: ReadonlySet<string>): ProposalCluster[] {
	const anomaly = new Set<string>(ANOMALY_BAND_POSITIONS);
	const groups = new Map<string, { cluster: ProposalCluster; runs: Set<string> }>();
	const push = (key: string, cluster: ProposalCluster, row: EvalRow) => {
		const g = groups.get(key) ?? { cluster, runs: new Set<string>() };
		g.cluster.rowCount += 1;
		if (typeof row.runId === "string") g.runs.add(row.runId);
		groups.set(key, g);
	};
	for (const row of rows) {
		if (row.scorerDegraded === true) continue;
		if (row.caseRef !== undefined && saturatedCaseIds.has(row.caseRef)) continue;
		// F-03: the stamp is part of the key — never bundle across configs. A
		// row without a stamp (defensive; rows carry one by construction)
		// degrades to the single "(no-stamp)" bucket rather than inventing a
		// cross-config merge.
		const stamp = typeof row.configStamp === "string" && row.configStamp !== "" ? row.configStamp : "(no-stamp)";
		if (row.scorerKind === "trajectory" && row.bandPosition !== undefined && anomaly.has(row.bandPosition)) {
			const target = String(row.target ?? "");
			const position = String(row.bandPosition);
			push(`t\u0000${target}\u0000${position}\u0000${stamp}`, { axis: "trajectory-band", target, bandPosition: position, configStamp: stamp, rowCount: 0, runIds: [] }, row);
		} else if (row.scorerKind === "final-response" && row.verdict === "fail" && row.rubricId !== undefined) {
			const rubricId = String(row.rubricId);
			const dimension = row.metric !== undefined ? String(row.metric) : "";
			push(`f\u0000${rubricId}\u0000${dimension}\u0000${stamp}`, { axis: "final-response-dimension", rubricId, dimension, configStamp: stamp, rowCount: 0, runIds: [] }, row);
		}
	}
	return [...groups.values()]
		.filter((g) => g.runs.size >= PROPOSAL_MIN_RUNS)
		.map((g) => ({ ...g.cluster, runIds: [...g.runs].sort() }))
		.sort((a, b) => (a.axis < b.axis ? -1 : a.axis > b.axis ? 1 : (a.target ?? a.rubricId ?? "") < (b.target ?? b.rubricId ?? "") ? -1 : 1));
}

/** F-02: the deterministic cluster identity WITHOUT runIds (the registry
 *  key — stable across evidence growth; also part of the proposal id). */
export function clusterKeyOf(cluster: ProposalCluster): string {
	return cluster.axis === "trajectory-band"
		? `${cluster.axis}|${cluster.target ?? ""}|${cluster.bandPosition ?? ""}|${cluster.configStamp}`
		: `${cluster.axis}|${cluster.rubricId ?? ""}|${cluster.dimension ?? ""}|${cluster.configStamp}`;
}

/** Deterministic proposal id from the cluster identity + its evidence run
 *  set (F-02: a re-draft with NEW runs gets a NEW id — a fresh file, never a
 *  clobber of the draft under review; identical evidence → identical id). */
export function proposalIdOf(cluster: ProposalCluster): string {
	return `prop-${createHash("sha256").update(`${clusterKeyOf(cluster)}|${cluster.runIds.join(",")}`).digest("hex").slice(0, 12)}`;
}

/** Is the cluster's target a valid DEC-6 target string (so the skeleton can
 *  carry it)? "run" (the observation-only face) and anything else unmapped →
 *  fall back to the template default with a maintainer TODO. */
function validDraftTarget(target: string | undefined): string | null {
	if (typeof target !== "string" || target === "") return null;
	const parts = target.split(TARGET_SEPARATOR);
	if (parts.length === 2) {
		return TARGET_STAGES.includes(parts[0]!) && TARGET_AGENTS.includes(parts[1]!) ? target : null;
	}
	if (parts.length === 1) {
		return TARGET_STAGES.includes(parts[0]!) || TARGET_AGENTS.includes(parts[0]!) ? target : null;
	}
	return null;
}

/** The arms of a validated target string (compound "stage|agent" / single). */
function armsOfTarget(target: string): { stage?: string; agent?: string } {
	const parts = target.split(TARGET_SEPARATOR);
	if (parts.length === 2) return { stage: parts[0], agent: parts[1] };
	return TARGET_STAGES.includes(parts[0]!) ? { stage: parts[0] } : { agent: parts[0] };
}

export interface GoldenCaseProposal {
	proposalId: string;
	kind: "golden-case-candidate";
	/** "long-form" = validator-passing skeleton (trajectory clusters — a
	 *  real DEC-6 target exists); "short-form" = the F-09 relaxation for
	 *  final-response clusters (no target exists to carry — target/expected
	 *  stay TODO(maintainer) and the skeleton DOES NOT VALIDATE until the
	 *  maintainer fills them, by design). */
	form: "long-form" | "short-form";
	draftedAt: number;
	cluster: ProposalCluster;
	/** A golden-case SKELETON (eval-layer template conventions; canary
	 *  pre-embedded; every content field is a TODO(maintainer) placeholder —
	 *  ZERO LLM content). VALIDATES as-is on the long-form arm only. The
	 *  maintainer fills it, then MOVES the whole file into cases/ by hand. */
	case: Record<string, unknown>;
	provenance: {
		runIds: string[];
		/** F-03: the configStamps that produced this cluster (one — clusters
		 *  never bundle across configs; the array shape is the wire contract). */
		configStamps: string[];
		metric?: string;
		bandPosition?: string;
		rubricId?: string;
		dimension?: string;
		rowCount: number;
	};
	/** DEC-11③: the propose/apply split, stated on the artifact itself. */
	gate: string;
}

export interface DraftProposalsOutcome {
	/** Proposal file paths written this pass. */
	drafted: string[];
	/** Existing proposal files left untouched (never clobber a draft the
	 *  maintainer may be editing; rows.jsonl remains the full evidence). */
	skippedExisting: string[];
	/** F-02: registered clusters NOT re-drafted (< PROPOSAL_NEW_RUNS new
	 *  runIds since the last draft) — cluster keys, not file paths. */
	skippedRegistered: string[];
	/** Clusters whose long-form skeleton failed self-validation (named
	 *  discard — should be impossible; defensive only). */
	skippedInvalid: ProposalCluster[];
	/** F-02: clusterKey → the record to merge into state.proposalClusters. */
	registryUpdates: Record<string, ProposalClusterRecord>;
}

/** Draft one proposal FILE per qualifying cluster. F-02 re-draft gating: a
 *  REGISTERED cluster re-drafts only with ≥ PROPOSAL_NEW_RUNS NEW runIds
 *  since its last draft (the reject-then-reevidence path); the re-draft
 *  gets a NEW proposal id (runIds are in the hash) so it lands as a fresh
 *  file and never clobbers the earlier draft. F-09: final-response clusters
 *  draft SHORT-FORM — no target exists to carry, so target/expected stay
 *  TODO(maintainer) and the validator-passing requirement applies to the
 *  long-form (trajectory) arm only, by documented relaxation. Deterministic
 *  given (clusters, registry, ts). */
export function draftProposals(input: { clusters: readonly ProposalCluster[]; proposalsDirPath: string; registry?: Record<string, ProposalClusterRecord>; ts?: number; repoRoot?: string; log?: (m: string) => void }): DraftProposalsOutcome {
	const ts = input.ts ?? Date.now();
	const registry = input.registry ?? {};
	const out: DraftProposalsOutcome = { drafted: [], skippedExisting: [], skippedRegistered: [], skippedInvalid: [], registryUpdates: {} };
	for (const cluster of input.clusters) {
		const clusterKey = clusterKeyOf(cluster);
		const registered = registry[clusterKey];
		const newRunIds = registered !== undefined ? cluster.runIds.filter((id) => !registered.runIds.includes(id)) : cluster.runIds;
		if (registered !== undefined && newRunIds.length < PROPOSAL_NEW_RUNS) {
			out.skippedRegistered.push(clusterKey);
			continue;
		}
		const proposalId = proposalIdOf(cluster);
		const path = join(input.proposalsDirPath, `${proposalId}.json`);
		if (existsSync(path)) {
			// Same cluster + same evidence → same id: the draft exists (the
			// registry normally catches this earlier; this remains for
			// registry-less legacy states). NEVER clobber.
			out.skippedExisting.push(proposalId);
			continue;
		}
		const target = validDraftTarget(cluster.target);
		const caseId = `cand-${createHash("sha256").update(`${proposalId}:${cluster.runIds.join(",")}`).digest("hex").slice(0, 8)}`;
		const provenanceLine = cluster.axis === "trajectory-band"
			? `Provenance (deterministic): ${cluster.rowCount} trajectory row(s) at band position ${cluster.bandPosition ?? "?"} on target "${cluster.target ?? "?"}" (configStamp ${cluster.configStamp}) across run(s) ${cluster.runIds.join(", ")}.`
			: `Provenance (deterministic): ${cluster.rowCount} final-response row(s) with verdict "fail" on rubric "${cluster.rubricId ?? "?"}" dimension "${cluster.dimension ?? "?"}" (configStamp ${cluster.configStamp}) across run(s) ${cluster.runIds.join(", ")}.`;
		// F-09: the two forms. Long-form (trajectory): the cluster's target
		// carries; the skeleton verdict is the first value ADMITTED by that
		// target's family (F6) — validator-passing by construction. Short-form
		// (final-response): no target exists — target/expected are honest
		// TODO(maintainer) placeholders and the file will NOT validate until
		// they are filled (stated on the artifact itself).
		const shortForm = cluster.axis === "final-response-dimension";
		const targetWire = shortForm
			? 'TODO(maintainer): pick the DEC-6 target ("stage", "agent", or "stage|agent") this failure cluster belongs to'
			: target ?? `prototype${TARGET_SEPARATOR}prototype-runner`;
		const verdictWire = shortForm
			? "TODO(maintainer): pick the expected verdict from the DEC-6 closure"
			: target !== null ? allowedVerdictsForTarget(armsOfTarget(target))[0]! : PROTOTYPE_VERDICT_VALUES[0];
		const wire: Record<string, unknown> = {
			id: caseId,
			title: "TODO(maintainer): case title",
			source: "docs/requirements/sdlc-tips-adoption.md",
			target: targetWire,
			scenario: [
				`TODO(maintainer): describe the labelled scenario this candidate replays — the failure cluster below is the DETERMINISTIC trigger; the scenario text itself is yours to write (DEC-7: no auto-generated content).${!shortForm && target === null && cluster.target !== undefined ? ` (cluster target "${cluster.target}" is not a DEC-6 target — pick one.)` : ""}`,
				"",
				provenanceLine,
				"",
				makeCanary(caseId),
			].join("\n"),
			expected: {
				// Long-form: drawn from the imported closure, never a literal.
				// Short-form (F-09): the maintainer's to pick.
				verdict: verdictWire,
				mustHold: ["TODO(maintainer): an assertion that must hold (scored by the rubric's boolean scale)"],
				mustNot: [],
			},
			caseVersion: 1,
		};
		if (!shortForm) {
			// The validator-passing requirement is the LONG-FORM arm only (F-09
			// relaxation is documented above + on the artifact's gate field).
			const check = validateGoldenCase(wire, { repoRoot: input.repoRoot });
			if (!check.ok) {
				out.skippedInvalid.push(cluster);
				input.log?.(`flywheel: proposal skeleton for ${proposalId} failed its own validation (${check.reasons.join("; ")}) — draft skipped (named discard, P10)`);
				continue;
			}
		}
		const proposal: GoldenCaseProposal = {
			proposalId,
			kind: "golden-case-candidate",
			form: shortForm ? "short-form" : "long-form",
			draftedAt: ts,
			cluster,
			case: wire,
			provenance: {
				runIds: cluster.runIds,
				configStamps: [cluster.configStamp],
				...(cluster.axis === "trajectory-band" ? { bandPosition: cluster.bandPosition } : { rubricId: cluster.rubricId, dimension: cluster.dimension }),
				rowCount: cluster.rowCount,
			},
			gate: shortForm
				? "DRAFT (SHORT-FORM, F-09: fill target/expected before mv — the skeleton will NOT validate until then; DEC-11③ propose/apply split): zero-LLM skeleton — nothing enters ~/.super-dev/evals/cases/ until the maintainer EDITS this file and MOVES it there BY HAND (mv = the human gate); the eval regression runner (D4④) then verifies it before it counts."
				: "DRAFT (DEC-11③ propose/apply split): zero-LLM skeleton — nothing enters ~/.super-dev/evals/cases/ until the maintainer EDITS this file and MOVES it there BY HAND (mv = the human gate); the eval regression runner (D4④) then verifies it before it counts.",
		};
		try {
			mkdirSync(input.proposalsDirPath, { recursive: true });
			writeFileSync(path, JSON.stringify(proposal, null, "\t") + "\n", { encoding: "utf8", flag: "wx" });
			out.drafted.push(path);
			out.registryUpdates[clusterKey] = { proposalId, draftedAt: ts, runIds: [...new Set([...(registered?.runIds ?? []), ...cluster.runIds])].sort() };
		} catch (err) {
			input.log?.(`flywheel: proposal write failed for ${proposalId} (continuing; never fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return out;
}

// ─── DEC-13④ evolution refresh ───────────────────────────────────────────────

export interface RefreshPendingMarker {
	previousVersion: string;
	currentVersion: string;
	since: number;
	/** null = the conservative default: the change list was unknown, so ALL
	 *  cases are flagged (honest and cheap beats a wrong heuristic). */
	changedModules: string[] | null;
	flaggedCases: string[];
}

/** Read the marker (missing/corrupt → null — no pending refresh). */
export function readRefreshMarker(path: string = refreshMarkerPath()): RefreshPendingMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RefreshPendingMarker>;
		if (parsed !== null && typeof parsed === "object" && typeof parsed.previousVersion === "string" && typeof parsed.currentVersion === "string" && Array.isArray(parsed.flaggedCases)) {
			return { previousVersion: parsed.previousVersion, currentVersion: parsed.currentVersion, since: Number(parsed.since ?? 0), changedModules: Array.isArray(parsed.changedModules) ? parsed.changedModules : null, flaggedCases: parsed.flaggedCases.map(String) };
		}
	} catch { /* absent = nothing pending */ }
	return null;
}

/** Heuristic (documented): a case is "touched" when one of its target arms
 *  equals a changed-module string or one of its path segments (extension
 *  stripped) — "implementation" matches "src/stages/implementation.ts";
 *  "code-reviewer" matches "agents/code-reviewer.md". F-10: a NULL change
 *  list is the conservative default (unknown what changed → flag EVERY
 *  case); an EMPTY list means the caller knows NOTHING changed → flag NO
 *  case. */
export function caseTouchedByChange(c: GoldenCase, changedModules: readonly string[] | null): boolean {
	if (changedModules === null) return true; // unknown change list — flag all
	const arms = [c.target.stage, c.target.agent].filter((a): a is string => a !== undefined);
	for (const module of changedModules) {
		const segments = String(module ?? "").split(/[\\/]/).map((s) => s.replace(/\.[a-z0-9]+$/i, ""));
		for (const arm of arms) {
			if (module === arm || segments.includes(arm)) return true;
		}
	}
	return false;
}

// ─── §8.3 M1: baseline re-key stamp ──────────────────────────────────────────

/** Stamp that a proposal LANDED for this caseSet: P4-era banding consumers
 *  read state.proposalApplied and know the (caseSet, caseVersion,
 *  rubricVersion) baselines must re-key (§8.3 — a proposal/model-pin change
 *  is a data-generation-process change). Best-effort; never throws. */
export function noteProposalApplied(caseSet: string, opts: { statePath?: string; ts?: number } = {}): ProposalAppliedStamp {
	const stamp: ProposalAppliedStamp = { caseSet, appliedAt: opts.ts ?? Date.now() };
	try {
		const path = opts.statePath ?? flywheelStatePath();
		const state = readFlywheelState(path);
		state.proposalApplied.push(stamp);
		writeFlywheelState(path, state);
	} catch { /* best-effort stamp (P5) */ }
	return stamp;
}

// ─── the orchestrator (fail-open; never throws) ──────────────────────────────

export interface FlywheelInput {
	runId: string;
	/** The LIVE eval-stage gate decision at the wiring (F-01a): a
	 *  {passed, posture} pair — posture "calibrated" arms drafting,
	 *  "miscalibrated" blocks it, and "directional-only" (or a null gate) is
	 *  NO SIGNAL: the deterministic ledger recompute decides instead. */
	gateDecision?: { passed: boolean; posture: string } | null;
	/** DEC-13④: changed-module paths for the refresh heuristic (null/absent =
	 *  flag ALL cases — conservative; an EMPTY array flags NONE — F-10). */
	changedModules?: string[];
	extensionVersion?: string;
	datasetDir?: string;
	casesDirPath?: string;
	labelsDirPath?: string;
	statePath?: string;
	proposalsDirPath?: string;
	refreshMarkerPathStr?: string;
	learnedIndexPath?: string;
	contaminationLedgerPathStr?: string;
	repoRoot?: string;
	log?: (m: string) => void;
	ts?: number;
}

export interface FlywheelOutcome {
	gatePassed: boolean;
	gateReason: string;
	proposalsDrafted: string[];
	proposalsSkippedExisting: string[];
	/** F-02: registered cluster keys not re-drafted this pass. */
	proposalsSkippedRegistered: string[];
	saturated: string[];
	unsaturated: string[];
	discriminationAdvisories: string[];
	/** Case ids flagged by THIS run's refresh wave (null = no wave this run). */
	refreshFlagged: string[] | null;
	/** Non-null while the maintainer has not cleared refresh-pending. */
	refreshPendingSince: number | null;
	contaminationFindings: ContaminationFinding[];
	quarantinedEntries: string[];
	notes: string[];
}

/** Run the whole flywheel at close-out. NEVER throws (P4/P5). */
export function runFlywheel(input: FlywheelInput): FlywheelOutcome {
	const log = input.log ?? (() => {});
	const ts = input.ts ?? Date.now();
	try {
		const version = input.extensionVersion ?? SUPER_DEV_EXTENSION_VERSION;
		const datasetDir = input.datasetDir ?? runsDir();
		const casesDirPath = input.casesDirPath ?? casesDir();
		const labelsDirPath = input.labelsDirPath ?? labelsDir();
		const statePath = input.statePath ?? flywheelStatePath();
		const proposalsDirPath = input.proposalsDirPath ?? proposalsDir();
		const markerPath = input.refreshMarkerPathStr ?? refreshMarkerPath();

		// ── inputs (loaders are cold-start-empty, never throw) ──
		const loadedRows = readEvalRows(datasetDir);
		if (loadedRows.malformedLines > 0) log(`flywheel: skipped ${loadedRows.malformedLines} malformed rows.jsonl line(s) (named discard, P10)`);
		const cases = loadGoldenCases(casesDirPath, { log });
		const labels = loadGateLabels(labelsDirPath, { log });
		const state = readFlywheelState(statePath, { log, version });
		const notes: string[] = [];

		// ── DEC-13④ evolution refresh (version wave) ──
		let refreshFlagged: string[] | null = null;
		const pendingBefore = readRefreshMarker(markerPath);
		if (state.lastSeenExtensionVersion !== version) {
			const changed = Array.isArray(input.changedModules) ? input.changedModules : null;
			refreshFlagged = cases.cases.filter((c) => caseTouchedByChange(c, changed)).map((c) => c.id);
			const marker: RefreshPendingMarker = { previousVersion: state.lastSeenExtensionVersion, currentVersion: version, since: ts, changedModules: changed, flaggedCases: refreshFlagged };
			try {
				mkdirSync(dirname(markerPath), { recursive: true });
				writeFileSync(markerPath, JSON.stringify(marker, null, "\t") + "\n", "utf8");
				state.lastSeenExtensionVersion = version;
				notes.push(`flywheel: extension version wave ${marker.previousVersion} → ${version} — ${refreshFlagged.length} golden case(s) flagged for re-review${changed === null ? " (conservative: ALL cases — no changed-modules list was provided)" : ""}; refresh-pending marker written — clear it (rm) after re-review (DEC-13④)`);
			} catch (err) {
				log(`flywheel: refresh marker write failed (continuing; never fatal): ${err instanceof Error ? err.message : String(err)}`);
				refreshFlagged = null;
			}
		}
		const refreshPendingSince = readRefreshMarker(markerPath)?.since ?? null;
		if (refreshPendingSince !== null && pendingBefore !== null) {
			notes.push(`flywheel: golden-case re-review PENDING since ${new Date(refreshPendingSince).toISOString()} (${pendingBefore.flaggedCases.length} case(s) flagged, ${pendingBefore.previousVersion} → ${pendingBefore.currentVersion}) — clear ~/.super-dev/evals/refresh-pending after re-review (DEC-13④)`);
		}

		// ── DEC-13③ saturation (deterministic recompute from the ledger) ──
		const prevSaturated = new Set(Object.entries(state.cases).filter(([, s]) => s.saturated).map(([id]) => id));
		const caseStates = computeCaseStates(loadedRows.rows, cases.cases);
		const saturated: string[] = [];
		const unsaturated: string[] = [];
		for (const [id, s] of Object.entries(caseStates).sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (s.saturated && !prevSaturated.has(id)) saturated.push(id);
			if (!s.saturated && prevSaturated.has(id)) unsaturated.push(id);
		}
		for (const id of saturated) notes.push(`flywheel: golden case "${id}" SATURATED (STREAK_N=${STREAK_N} consecutive all-agree scored runs) — excluded from the proposal-drafting signal, still scored as the regression baseline, never deleted (DEC-13③)`);
		for (const id of unsaturated) notes.push(`flywheel: golden case "${id}" UN-SATURATED (disagreement observed — the case discriminates again), streak reset (DEC-13③)`);
		state.cases = caseStates;

		// ── DEC-13② discrimination (advisory) ──
		const discrimination = checkDiscrimination(loadedRows.rows);
		notes.push(...discrimination.advisories);

		// ── DEC-13① premise gate (adversarial-gate F-01a: no single-run gate
		//    deadlock — a directional-only/absent LIVE gate is NO SIGNAL and falls
		//    back to the deterministic ledger recompute; only a genuine
		//    miscalibration (live OR recomputed) blocks drafting) ──
		let gatePassed: boolean;
		let gateReason: string;
		const live = input.gateDecision ?? null;
		if (live !== null && live.posture === "calibrated") {
			gatePassed = live.passed;
			gateReason = "live eval-stage gate decision (calibrated posture)";
		} else if (live !== null && live.posture === "miscalibrated") {
			gatePassed = false;
			gateReason = "live eval-stage gate decision: miscalibrated — fix the rubric/mapping, not the data (DEC-13①)";
		} else {
			const gate = runGate(loadedRows.rows, cases.cases, labels.labels);
			if (gate === null) {
				gatePassed = false;
				gateReason = `no calibration signal: live gate ${live !== null ? `posture "${live.posture}"` : "produced no decision"}, and no maintainer labels exist — the gate has never run (DEC-13①)`;
			} else if (gate.decision.posture === "calibrated") {
				gatePassed = gate.decision.passes;
				gateReason = `ledger recompute (live gate was ${live !== null ? `"${live.posture}" — no signal` : "absent"}): calibrated (${gate.decision.reasons.join("; ")})`;
			} else if (gate.decision.posture === "miscalibrated") {
				gatePassed = false;
				gateReason = `ledger recompute: miscalibrated (${gate.decision.reasons.join("; ")}) — fix the rubric/mapping, not the data (DEC-13①)`;
			} else {
				gatePassed = false;
				gateReason = `no calibration signal yet: live gate ${live !== null ? `posture "${live.posture}"` : "absent"}, ledger recompute directional-only (${gate.decision.reasons.join("; ")}) — drafting stays off until labels + agreement reach the calibration floor (DEC-13①)`;
			}
		}

		// ── DEC-11② proposal drafting (ONLY behind the premise gate) ──
		const drafts: DraftProposalsOutcome = { drafted: [], skippedExisting: [], skippedRegistered: [], skippedInvalid: [], registryUpdates: {} };
		if (!gatePassed) {
			notes.push(`flywheel: NO auto-drafts — the D7 validation gate has not passed (${gateReason}); fix the rubric/mapping, not the data (DEC-13① premise gate)`);
		} else if (cases.cases.length === 0 && loadedRows.rows.length === 0) {
			notes.push("flywheel: gate passed; nothing to draft (cold start — no cases, no dataset rows)");
		} else {
			const clusters = draftClusters(loadedRows.rows, new Set(Object.entries(caseStates).filter(([, s]) => s.saturated).map(([id]) => id)));
			const drafted = draftProposals({ clusters, proposalsDirPath, registry: state.proposalClusters, ts, repoRoot: input.repoRoot, log });
			drafts.drafted.push(...drafted.drafted);
			drafts.skippedExisting.push(...drafted.skippedExisting);
			drafts.skippedRegistered.push(...drafted.skippedRegistered);
			drafts.skippedInvalid.push(...drafted.skippedInvalid);
			// F-02: merge the registry updates so the re-draft gate survives this
			// run (and the maintainer's mv — the registry is keyed by cluster, not
			// by file existence).
			for (const [key, record] of Object.entries(drafted.registryUpdates)) state.proposalClusters[key] = record;
			if (drafted.drafted.length > 0) {
				notes.push(`flywheel: drafted ${drafted.drafted.length} golden-case proposal draft(s) under ${proposalsDirPath} — DRAFTS ONLY: nothing enters cases/ until the maintainer moves it there BY HAND (mv = the human gate, DEC-11③)`);
			} else {
				notes.push(`flywheel: gate passed; no new proposal clusters (≥${PROPOSAL_MIN_RUNS} distinct runs at an anomaly position / a failing rubric dimension; saturated cases excluded)`);
			}
			if (drafts.skippedRegistered.length > 0) notes.push(`flywheel: ${drafts.skippedRegistered.length} cluster(s) already drafted — re-draft needs ≥${PROPOSAL_NEW_RUNS} NEW run(s) of evidence (reject-then-reevidence, F-02)`);
			if (drafted.skippedExisting.length > 0) notes.push(`flywheel: ${drafted.skippedExisting.length} draft file(s) already existed — left untouched (never clobber a draft under review; rows.jsonl remains the evidence)`);
		}

		// Persist the recomputed lifecycle + registry (write-if-changed — no
		// churn; runs AFTER drafting so registryUpdates are included in the one
		// write).
		try {
			const nextText = JSON.stringify(state, null, "\t") + "\n";
			let prevText: string | null = null;
			try { prevText = readFileSync(statePath, "utf8"); } catch { /* cold start */ }
			if (prevText !== nextText) writeFlywheelState(statePath, state);
		} catch { /* best-effort persistence */ }

		// ── §8.1 contamination scan (the flywheel-run invocation; the
		//    learned.ts injection seam enforces the same scan per load) ──
		const scan = scanLearnedIndexForContamination({
			...(input.learnedIndexPath !== undefined ? { learnedIndexPath: input.learnedIndexPath } : {}),
			...(input.casesDirPath !== undefined ? { casesDirPath: input.casesDirPath } : {}),
			...(input.contaminationLedgerPathStr !== undefined ? { ledgerPath: input.contaminationLedgerPathStr } : {}),
			log,
		});
		if (scan.quarantined.length > 0) {
			notes.push(`flywheel: contamination scan quarantined ${scan.quarantined.length} learned-index entr(ies) — never injected; ledger: ${input.contaminationLedgerPathStr ?? contaminationLedgerPath()} (§8.1)`);
		}

		for (const note of notes) log(`flywheel: ${note.replace(/^flywheel: /, "")}`);
		return {
			gatePassed, gateReason,
			proposalsDrafted: drafts.drafted, proposalsSkippedExisting: drafts.skippedExisting, proposalsSkippedRegistered: drafts.skippedRegistered,
			saturated, unsaturated,
			discriminationAdvisories: discrimination.advisories,
			refreshFlagged, refreshPendingSince,
			contaminationFindings: scan.findings, quarantinedEntries: scan.quarantined,
			notes,
		};
	} catch (err) {
		// The fail-open hard constraint: a flywheel bug can never fail the run.
		log(`flywheel: failed open — run unaffected (${err instanceof Error ? err.message : String(err)}); this is a bug in the flywheel surface, not in the run (P4/P5)`);
		return {
			gatePassed: false, gateReason: `flywheel failed open: ${err instanceof Error ? err.message : String(err)}`,
			proposalsDrafted: [], proposalsSkippedExisting: [], proposalsSkippedRegistered: [], saturated: [], unsaturated: [],
			discriminationAdvisories: [], refreshFlagged: null, refreshPendingSince: null,
			contaminationFindings: [], quarantinedEntries: [],
			notes: [`flywheel: failed open — run unaffected (${err instanceof Error ? err.message : String(err)})`],
		};
	}
}
