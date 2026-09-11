/**
 * EVAL STAGE (P2 / D5+D3) — the in-pipeline, fail-open eval surface
 * (docs/requirements/sdlc-tips-adoption.md DEC-2/DEC-9/DEC-10, §8.3 M1, §8.4
 * M3; wired at run close-out in workflow.ts runWorkflow).
 *
 * Two scorers, both ADVISORY — verdicts land in the run report + `eval.*`
 * events + dataset rows; there is NO new merge gate (D5 explicit), nothing
 * here suppresses or blocks the run under review.
 *
 *   1. Trajectory scorer (DETERMINISTIC, D3/DEC-9): reads the run's S3
 *      counters (run-observability.ts, passed in by the wiring) + the E1
 *      σ-band monitor's per-metric band positions (the sigma-bands STATISTICS
 *      CORE extracted in v0.3.90 — median/MAD/classifyBand reused, banding
 *      NOT re-invented) → per-metric band rows → rubric band-position mapping
 *      (RubricDimension.bandMap) → per-target advisory verdict rows.
 *      STRICTLY OBSERVATIONAL (2026-09-11 评审裁定): it READS the counters the
 *      existing stagnation/fault machinery already consumes and NEVER
 *      actuates them — pure read → row write. This module must not import
 *      anything that mutates loop state (pinned by the observational
 *      tripwire test in tests/eval-stage.test.ts); any future actuation
 *      wiring is a named D3-era amendment carrying its own P3 failure-path
 *      table.
 *
 *   2. Final-response scorer (D5②, DEC-9 frontier tier): at run end, before
 *      the eval report — one dispatch of the registered read-only specialist
 *      `eval-scorer` (rubric + run-ledger + final-deliverable paths in;
 *      per-assertion boolean + 0..1 confidence ranking-only + honest-absent
 *      option out, defensively validated engine-side). Dispatch guarded by
 *      ctx.budget.check(); tool budget via the existing tier chain
 *      agentToolBudget["eval-scorer"] ?? commonToolBudget ?? none (the
 *      v0.3.87 research-assist wiring precedent).
 *
 * Outputs (all three, always): `eval.*` events into events.jsonl; eval rows
 * into the run report surface (<specDir>/eval-report.md); dataset rows
 * appended to ~/.super-dev/evals/runs/rows.jsonl (user-local). NO single
 * score / NO weighted aggregate anywhere (§7 部分 5 禁令 — assertion/band-level
 * rows only; the report renderer is scanned by a no-aggregate tripwire test).
 *
 * Degradation (§8.4 M3 fold): scorer quota failure / spawn error / timeout →
 * the deterministic-only floor = ONE honest-absent named discard row stamped
 * `scorerDegraded: true` (excluded from any future σ-band baseline — the
 * stamp is the marker P3 reads); NO fallback model (DEC-9 cheap-instrument
 * rejection: a distorted instrument measuring quality is worse than no
 * measurement). Fail-open hard constraint (P4/P5): the eval stage can NEVER
 * fail or block the run under review — the whole surface is try/catch →
 * warning log.
 *
 * Config stamp (§8.3 M1 fold): every row carries configStamp — a stable short
 * hash of the config that shaped the run (agentModels + agentThinking +
 * commonToolBudget + agentToolBudget). P3's proposal-apply re-keys band
 * baselines on it (proposal/model-pin changes are data-generation-process
 * changes).
 *
 * Gate EXECUTION (D7 / DEC-13①): at close-out, when maintainer labels exist
 * covering scored cases, computeGateAgreement + gatePasses run and the gate
 * decision lands in the report rows — this arms the P3 flywheel premise gate.
 * gatePasses=false suppresses nothing yet; P3 wires that.
 *
 * Scoping (v1, documented): the run close-out IS the convergence boundary
 * this surface scores. Per-phase mid-run boundaries are DEFERRED — DEC-2's
 * mid-run timeliness is traded for v1 simplicity (one deterministic pass +
 * one frontier dispatch per run); the amendment lands with the per-phase
 * boundary machinery.
 *
 * Face coverage (v1, documented — F-09): the trajectory scorer's metric
 * faces cover judge + implementation targets ONLY (METRIC_TARGET); every
 * other target honestly emits honest-absent rows (nothing was observed for
 * that face this run) — never a fabricated observation.
 *
 * Band POLARITY (v1, documented — F-08): band positions are SYMMETRIC
 * anomaly positions (the E1 σ-band monitor's semantics — σ-distance from
 * the trailing baseline), not badness. A high judgeAccepted lands 3σ exactly
 * like a high judgeDiscarded: the position says "unusual", and drift MEANING
 * is owned by the rubric bandMap — that is precisely why bandMap exists. No
 * per-metric polarity machinery this wave.
 *
 * Hermeticity (F-07): the stage is ON by default; the documented kill switch
 * is SUPER_DEV_NO_EVAL_STAGE=1 (env or config.json env map — the same
 * hermeticity/escape class as SUPER_DEV_NO_SAFETY_GUARD v0.3.86). The
 * vitest suite sets it in tests/setup/config-env-hermeticity.ts; the wiring
 * consults evalStageEnabled() and skips the whole surface under it; the
 * DEFAULT user-local dataset append reuses the same switch (not the
 * run-metrics guard — the two switches are decoupled). Injected dirs (tests)
 * always write.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Type } from "typebox";
// Observational allowlist (tripwire-pinned): every import below is read-only
// or append-only-ledger — none mutates loop state (no fault actuators, no
// stagnation, no replan, no implementation-stage imports).
import { buildRunMetricsRow, bandPositions, type BandPosition, type MetricBandPosition, type RunMetricsRow, type S3Counters, type SigmaMetricName } from "./sigma-bands.ts";
import {
	VERDICT_CLOSURE, allowedVerdictsForTarget, targetVerdictFamilies, TARGET_SEPARATOR, caseSetOf,
	loadGoldenCases, loadRubrics, loadGateLabels,
	computeGateAgreement, gatePasses,
	type GateAgreement, type GateDecision, type GateLabels, type GoldenCase, type LoadedGoldenCases, type LoadedRubrics, type Rubric, type ScorerVerdictRow,
} from "./eval-layer.ts";
import { appendRunEvent } from "../runlog.ts";
import { getConfig, getSuperDevDir, superDevEnv, type SuperDevConfig } from "../render/super-dev-dir.ts";
import { resolveToolBudget } from "../agents/agent-runtime.ts";

// ── constants ───────────────────────────────────────────────────────────────

/** The registered specialist agent name (agents/eval-scorer.md — read-only). */
export const EVAL_SCORER_AGENT = "eval-scorer";

/** Per-call wall cap for the final-response dispatch — the same 240s tier as
 *  the v0.3.87 research-assist dispatch (a named constant, NOT an env key). */
export const EVAL_SCORER_TIMEOUT_MS = 240_000;

/** The named-discard verdict: the scorer honestly abstained. NOT a member of
 *  the DEC-6 closure (it describes the INSTRUMENT's abstention, not a scored
 *  verdict); gate execution excludes such rows from matched pairs and counts
 *  them as named discards. */
export const HONEST_ABSENT = "honest-absent";

/** The dataset report basename under <superDevDir>/evals/runs/. */
export const EVAL_DATASET_BASENAME = "rows.jsonl";

/** The run-report-surface artifact written into the spec dir (close-out render
 *  only — usage-report.md parity; registered in HARNESS_FILE_ROLES). */
export const EVAL_REPORT_BASENAME = "eval-report.md";

/** Defensive cap on distilled scorer assertions (a runaway structured result
 *  is bounded engine-side, never a schema violation that burns anything). */
export const EVAL_MAX_ASSERTIONS = 32;

// ── M1: the config stamp ────────────────────────────────────────────────────

/** The config shape that shaped the run (§8.3 M1): the four keys that change
 *  the data-generation process. Whatever super-dev-dir.ts exposes for them —
 *  nothing else is hashed (bookkeeping keys don't shape trajectories). */
export type EvalConfigShape = Pick<SuperDevConfig, "agentModels" | "agentThinking" | "commonToolBudget" | "agentToolBudget">;

/** Deterministic key-sorted JSON (same data → same string, regardless of key
 *  insertion order in the config file). */
function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const entries = Object.keys(v as Record<string, unknown>).sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

/** Stable short hash of the run-shaping config (M1): same config → same
 *  stamp; ANY change to the four shaping keys → a different stamp. P3's
 *  proposal-apply re-keys σ-band baselines on this stamp (a proposal landing
 *  or a model pin changing re-keys the affected bands — old and new rows
 *  never silently mix). */
export function configStampOf(config: EvalConfigShape): string {
	const payload = stableJson({
		agentModels: config.agentModels ?? null,
		agentThinking: config.agentThinking ?? null,
		commonToolBudget: config.commonToolBudget ?? null,
		agentToolBudget: config.agentToolBudget ?? null,
	});
	return `cfg-${createHash("sha256").update(payload).digest("hex").slice(0, 10)}`;
}

// ── D3: metric faces + the band→verdict resolution ──────────────────────────

/** The deterministic metric → target-face table (documented): the two judge
 *  S3 counters belong to the judge AGENT face (DEC-6: judge is an agent,
 *  never a stage); the four implementation-state S3 counters belong to the
 *  implementation STAGE face; the six run-level metrics belong to "run" — an
 *  OBSERVATION-ONLY face that is deliberately NOT a member of the closed
 *  stage/agent target grammar (unmapped ⇒ full-closure admission ⇒ no
 *  unambiguous positive verdict ⇒ the conservative default degrades to
 *  honest-absent unless a rubric bandMap maps it explicitly). */
export const METRIC_TARGET: Readonly<Record<SigmaMetricName, string>> = {
	wallMs: "run",
	costUsd: "run",
	tokens: "run",
	agentsSpawned: "run",
	agentErrorRounds: "run",
	fatalAborts: "run",
	judgeAccepted: "judge",
	judgeDiscarded: "judge",
	partialPhases: "implementation",
	inheritedRedHandoffs: "implementation",
	inheritedRedOccurrences: "implementation",
	maxPhaseAttempts: "implementation",
};

/** The documented DEFAULT band rule (D3): when a face's family is UNAMBIGUOUS
 *  (exactly one verdict family) and that family has a canonical positive
 *  verdict, an in-band position maps to it. The fault family has NO positive
 *  member (every value names a failure mode) — undefined ⇒ honest-absent. */
export const POSITIVE_BAND_VERDICT: Readonly<Partial<Record<string, string>>> = {
	review: "Approved",
	prototype: "pass",
	judge: "accepted",
};

/** Parse a target face string into eval-layer arms ("a|b" compound / single
 *  stage or agent / "run" → no arms). */
const METRIC_TARGET_AGENT_FACES = new Set(["judge"]);
function faceArms(target: string): { stage?: string; agent?: string } {
	const parts = target.split(TARGET_SEPARATOR);
	if (parts.length === 2) return { stage: parts[0], agent: parts[1] };
	if (parts[0] === "run") return {};
	if (parts[0] !== undefined) {
		// Single arm: the agent faces this table names resolve as agents (the
		// eval-layer F6 map keys them by name); everything else resolves as a
		// stage face.
		return METRIC_TARGET_AGENT_FACES.has(parts[0]) ? { agent: parts[0] } : { stage: parts[0] };
	}
	return {};
}

/** Resolve the verdict for one (face, band position) pair — the D3 mapping,
 *  deterministic and conservative, in order:
 *    1. rubric bandMap (rubrics in load order, dimensions in order): the
 *       FIRST entry for this position whose value is ADMITTED by
 *       allowedVerdictsForTarget(face) wins; non-admitted values are skipped
 *       with a loud note (a maintainer's bandMap must respect the target's
 *       family — DEC-6 closure).
 *    2. DEFAULT rule: position "in-band" + the face resolves to EXACTLY ONE
 *       family + that family has a canonical positive verdict → the positive
 *       verdict. Every other position (and every ambiguous face) →
 *       honest-absent: drift is named by the bandPosition field itself, and
 *       fabricating a drift verdict without a maintainer mapping would be a
 *       measurement the instrument never made.
 *    3. "no-band" is NEVER a score: honest-absent (insufficient history is a
 *       skip, not a verdict).
 *  Band positions are SYMMETRIC anomaly positions (see the header polarity
 *  note): a 3σ on a "good" counter is drift exactly like a 3σ on a "bad" one
 *  — the bandMap is where the maintainer gives the drift its meaning.
 */
export interface BandVerdictDetail {
	verdict: string;
	/** The rubric whose bandMap entry fired — absent when the DEFAULT rule or
	 *  the honest-absent floor produced the verdict (nothing was "used";
	 *  stamping a rubric that did not fire would be false provenance, P10). */
	rubricId?: string;
	rubricVersion?: string;
}

/** The detail resolver (F-03): verdict + the rubric provenance when one
 *  fired. bandVerdictFor below is the verdict-only face over it. */
export function bandVerdictDetailFor(face: { stage?: string; agent?: string }, position: BandPosition, rubrics: readonly Rubric[], log?: (m: string) => void): BandVerdictDetail {
	if (position === "no-band") return { verdict: HONEST_ABSENT };
	const allowed = allowedVerdictsForTarget(face);
	for (const rubric of rubrics) {
		for (const dim of rubric.dimensions) {
			const mapped = dim.bandMap?.[position];
			if (mapped === undefined) continue;
			if (allowed.includes(mapped)) return { verdict: mapped, rubricId: rubric.rubricId, rubricVersion: rubric.version };
			log?.(`eval stage: bandMap entry ${rubric.rubricId}/${dim.name}[${position}]="${mapped}" is not admitted by target face ${face.stage ?? ""}${face.stage && face.agent ? TARGET_SEPARATOR : ""}${face.agent ?? ""} — skipped (admitted: ${allowed.join(", ")})`);
		}
	}
	if (position === "in-band") {
		const families = targetVerdictFamilies(face);
		if (families.length === 1) {
			const positive = POSITIVE_BAND_VERDICT[families[0]!];
			if (positive !== undefined) return { verdict: positive };
		}
	}
	return { verdict: HONEST_ABSENT };
}

/** Verdict-only face over bandVerdictDetailFor (the per-metric rows don't
 *  stamp rubric provenance — F-03: case rows carry it). */
export function bandVerdictFor(face: { stage?: string; agent?: string }, position: BandPosition, rubrics: readonly Rubric[], log?: (m: string) => void): string {
	return bandVerdictDetailFor(face, position, rubrics, log).verdict;
}

/** Band-position rank for the conservative per-target selection (a selection
 *  order, NOT a score: unweighted, documented, deterministic). */
const BAND_RANK: Record<BandPosition, number> = { "no-band": 0, "in-band": 1, "1σ": 2, "2σ": 3, "3σ": 4 };

// ── the dataset row ─────────────────────────────────────────────────────────

/** One dataset row (the pinned P2 schema): assertion/band-level granularity
 *  ONLY — no single score, no weighted aggregate (§7 部分 5 禁令). `metric` is
 *  the σ-metric name on trajectory rows and the rubric dimension name on
 *  final-response rows (the row's "what was measured" field — one spelling
 *  per kind, documented). Case-scoring rows carry the F-03 provenance stamps:
 *  caseVersion + caseSet (from the case via caseSetOf — the M2 band-key
 *  axes) and rubricId + rubricVersion when a rubric bandMap actually fired
 *  (absent under the DEFAULT rule / honest-absent floor — never false
 *  provenance). Per-metric trajectory rows and the final-response floor rows
 *  leave the case stamps absent; final-response dimension rows carry the
 *  rubric stamps (DEC-7: every row a rubric-shaped score carries is stamped). */
export interface EvalRow {
	ts: number;
	runId: string;
	/** The scored golden-case id (per-target verdict rows only). */
	caseRef?: string;
	/** The case's revision stamp (F-03) — the gate joins on (caseRef,
	 *  caseVersion); present on case-scoring rows. */
	caseVersion?: number;
	/** The case's suite identity (caseSetOf — the M2 band-key axis). */
	caseSet?: string;
	/** Provenance of the rubric that actually produced this verdict/rubric-shaped
	 *  score (F-03); absent when the DEFAULT rule or an abstention floor did. */
	rubricId?: string;
	rubricVersion?: string;
	/** The face the row observes: a closed-grammar target ("stage", "agent",
	 *  "stage|agent") or the observation-only "run" face. */
	target: string;
	metric?: string;
	bandPosition?: BandPosition;
	/** A DEC-6 closure verdict, or HONEST_ABSENT (the named abstention). */
	verdict: string;
	/** 0..1, RANKING-ONLY (§8.2 — never a probability). Absent on
	 *  deterministic trajectory rows (no verbalized confidence exists to
	 *  report) and on folded final-response dimension rows (folding would be
	 *  an aggregate — per-assertion confidences live in the eval.scored event
	 *  + the report). */
	confidence?: number;
	scorerKind: "trajectory" | "final-response";
	configStamp: string;
	/** §8.4 M3: this row is the deterministic-only floor after a scorer quota
	 *  failure / spawn error / timeout — EXCLUDED from any future σ-band
	 *  baseline (the stamp IS the exclusion marker P3 reads). */
	scorerDegraded?: boolean;
}

// ── trajectory scorer (deterministic, D3) ───────────────────────────────────

export interface TrajectoryInput {
	runId: string;
	ts: number;
	configStamp: string;
	/** Per-metric band positions (bandPositions() — the reused stats core). */
	positions: ReadonlyArray<MetricBandPosition>;
	cases: readonly GoldenCase[];
	rubrics: readonly Rubric[];
	log?: (m: string) => void;
}

/** Score the trajectory: per-metric band rows (ALL metrics — in-band and
 *  no-band included, honest) + per-target advisory verdict rows (one per
 *  golden case). Pure; never throws. */
export function scoreTrajectory(input: TrajectoryInput): EvalRow[] {
	const rows: EvalRow[] = [];
	// (a) per-metric band rows — the deterministic observation layer.
	for (const p of input.positions) {
		const target = METRIC_TARGET[p.metric];
		rows.push({
			ts: input.ts,
			runId: input.runId,
			target,
			metric: p.metric,
			bandPosition: p.position,
			verdict: bandVerdictFor(faceArms(target), p.position, input.rubrics, input.log),
			scorerKind: "trajectory",
			configStamp: input.configStamp,
		});
	}
	// (b) per-target verdict rows — one per golden case. The case's position is
	// the WORST band position among the metrics owned by its target's arms
	// (conservative selection — a documented order, not an aggregate); a case
	// whose face owns no metric (e.g. prototype|prototype-runner) gets an
	// honest-absent row (nothing was observed for that face this run). Case
	// rows carry the F-03 provenance stamps (caseVersion/caseSet always;
	// rubricId/rubricVersion only when a rubric bandMap actually fired).
	for (const c of input.cases) {
		const owned = input.positions.filter((p) => {
			const face = METRIC_TARGET[p.metric];
			return (c.target.stage !== undefined && face === c.target.stage) || (c.target.agent !== undefined && face === c.target.agent);
		});
		if (owned.length === 0) {
			rows.push({
				ts: input.ts, runId: input.runId, caseRef: c.id, caseVersion: c.caseVersion, caseSet: caseSetOf(c),
				target: c.target.raw,
				verdict: HONEST_ABSENT, scorerKind: "trajectory", configStamp: input.configStamp,
			});
			continue;
		}
		let worst = owned[0]!;
		for (const p of owned) {
			if (BAND_RANK[p.position] > BAND_RANK[worst.position]) worst = p;
		}
		const detail = bandVerdictDetailFor({ stage: c.target.stage, agent: c.target.agent }, worst.position, input.rubrics, input.log);
		rows.push({
			ts: input.ts,
			runId: input.runId,
			caseRef: c.id,
			caseVersion: c.caseVersion,
			caseSet: caseSetOf(c),
			...(detail.rubricId !== undefined ? { rubricId: detail.rubricId, rubricVersion: detail.rubricVersion } : {}),
			target: c.target.raw,
			metric: worst.metric,
			bandPosition: worst.position,
			verdict: detail.verdict,
			scorerKind: "trajectory",
			configStamp: input.configStamp,
		});
	}
	return rows;
}

// ── final-response scorer (D5②) ─────────────────────────────────────────────

/** The structured-output contract of the eval-scorer dispatch: per-assertion
 *  boolean + 0..1 confidence (RANKING-ONLY, §8.2) + the honest-absent option.
 *  Internal non-ControlData schema (the research-assist S1 precedent — not
 *  exported from render/schemas.ts, so the S1 exhaustiveness guard is not
 *  triggered; pinned by tests/eval-stage.test.ts). */
export const EvalScorerData = Type.Object({
	assertions: Type.Array(Type.Object({
		id: Type.String({ description: "the assertion id given in the prompt (rubricId::dimension::assertion)" }),
		assertion: Type.String({ description: "the assertion text, verbatim from the rubric" }),
		pass: Type.Boolean({ description: "UNIFORM 'criterion satisfied' semantics: for a must-hold assertion, true means the condition HELD; for a must-NOT-hold assertion, true means the violation did NOT occur" }),
		confidence: Type.Number({ description: "0..1 ranking-only confidence — never a probability" }),
		absent: Type.Optional(Type.Boolean({ description: "true when you honestly cannot judge this assertion" })),
	})),
	summaryNote: Type.String({ description: "one honest sentence: what was checkable, what was not" }),
});

/** One distilled scorer assertion (defensively validated engine-side). */
export interface DistilledEvalAssertion {
	id: string;
	assertion: string;
	pass: boolean;
	confidence: number;
	absent: boolean;
}

/** Distill the eval-scorer control (defensive; corrective path deliberately
 *  absent in v1 — an unusable result degrades to the M3 floor, it never
 *  burns anything). Invalid entries are dropped and counted (named); counts
 *  beyond EVAL_MAX_ASSERTIONS are bounded. A missing/non-string summaryNote
 *  (F-11) degrades defensively to "" — the assertions themselves are the
 *  payload; dropping the whole response over a lost sentence would be the
 *  disproportionate failure. Null only when the whole shape is unusable.
 *  Pure; never throws. */
export function distillEvalScorerControl(control: unknown, opts: { log?: (m: string) => void } = {}): { assertions: DistilledEvalAssertion[]; summaryNote: string; dropped: number } | null {
	if (control == null || typeof control !== "object" || Array.isArray(control)) return null;
	const c = control as Record<string, unknown>;
	if (!Array.isArray(c.assertions)) return null;
	const out: DistilledEvalAssertion[] = [];
	let dropped = 0;
	for (let i = 0; i < c.assertions.length; i++) {
		const raw = c.assertions[i];
		if (out.length >= EVAL_MAX_ASSERTIONS) { dropped += c.assertions.length - i; break; }
		if (raw == null || typeof raw !== "object" || Array.isArray(raw)) { dropped++; continue; }
		const a = raw as Record<string, unknown>;
		const id = typeof a.id === "string" ? a.id.trim() : "";
		const assertion = typeof a.assertion === "string" ? a.assertion.trim() : "";
		const confidence = typeof a.confidence === "number" && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null;
		if (id === "" || assertion === "" || typeof a.pass !== "boolean" || confidence === null) { dropped++; continue; }
		out.push({ id, assertion, pass: a.pass, confidence, absent: a.absent === true });
	}
	if (dropped > 0) opts.log?.(`eval stage: dropped ${dropped} malformed scorer assertion(s) — named discard (P10)`);
	const summaryNote = typeof c.summaryNote === "string" ? c.summaryNote.trim().slice(0, 500) : "";
	return { assertions: out, summaryNote, dropped };
}

/** The ONE assertion-id grammar (P6 — the prompt and the fold share it;
 *  never re-typed): rubricId::dimensionName::mustHoldN | mustNotN. */
export function assertionId(rubricId: string, dimensionName: string, kind: "mustHold" | "mustNot", index: number): string {
	return `${rubricId}::${dimensionName}::${kind}${index}`;
}

/** Build the final-response dispatch prompt: rubric assertions (with the ids
 *  the fold matches on) + VERIFIED-EXISTING evidence paths + the frozen
 *  pre-eval run snapshot. F-02 (phantom-evidence fix): only files that
 *  existSync at prompt-build time are named — audit.jsonl lives in the RUN
 *  dir (~/.super-dev/runs/…), never <specDir>/audit.jsonl, so it is not
 *  referenced; <specDir>/run-metrics.jsonl is written AFTER the eval stage,
 *  so the frozen snapshot block (F-01) replaces it instead of naming a file
 *  the scorer cannot yet read. */
export function buildEvalScorerPrompt(input: {
	runId: string;
	status: string;
	specDirectory: string | undefined;
	rubrics: readonly Rubric[];
	/** The F-01 frozen pre-eval snapshot, inlined into the prompt text. */
	snapshot?: { wallMs: number; agentsSpawned: number; s3: S3Counters };
}): string {
	const dir = input.specDirectory ? (isAbsolute(input.specDirectory) ? input.specDirectory : join(process.cwd(), input.specDirectory)) : "";
	const lines: string[] = [];
	if (dir) {
		// F-02: each named path is verified to exist RIGHT NOW — a phantom path
		// sends the scorer reading a file that is never there.
		const candidates: Array<[string, string]> = [
			["run event ledger", "events.jsonl"],
			["usage ledger", "usage-calls.jsonl"],
			["completion audit", "completion-audit.md"],
		];
		const verified = candidates.filter(([, basename]) => existsSync(join(dir, basename)));
		const paths = verified.length > 0
			? verified.map(([label, basename]) => `- ${label}: ${join(dir, basename)}`).join("\n")
			: "- (no ledger files were present in the spec directory)";
		lines.push("## Run evidence paths (read-only)", paths, `- final deliverables: the documents directly under ${dir}`);
	} else {
		lines.push("## Run evidence paths (read-only)", "- (no spec directory was recorded for this run)");
	}
	if (input.snapshot) {
		const s3 = input.snapshot.s3;
		lines.push(
			"",
			"## Frozen run snapshot (engine-computed, taken BEFORE this scoring call)",
			`- run \`${input.runId}\` — status ${input.status} — wall ${input.snapshot.wallMs}ms — ${input.snapshot.agentsSpawned} agent spawn(s)`,
			`- S3 counters: judgeAccepted ${s3.judgeAccepted}, judgeDiscarded ${s3.judgeDiscarded}, partialPhases ${s3.partialPhases}, inheritedRedHandoffs ${s3.inheritedRedHandoffs}, inheritedRedOccurrences ${s3.inheritedRedOccurrences}, maxPhaseAttempts ${s3.maxPhaseAttempts}`,
		);
	}
	lines.push("", "## Rubric assertions to score");
	for (const rubric of input.rubrics) {
		for (const dim of rubric.dimensions) {
			lines.push(`### ${rubric.rubricId} :: ${dim.name}`);
			lines.push(dim.guidance);
			dim.mustHold.forEach((a, i) => lines.push(`- must hold [${assertionId(rubric.rubricId, dim.name, "mustHold", i)}] ${a}`));
			// F-04: uniform pass semantics, stated per line — pass=true on a mustNot
			// line means the violation did NOT occur.
			dim.mustNot.forEach((a, i) => lines.push(`- must NOT hold [${assertionId(rubric.rubricId, dim.name, "mustNot", i)}] ${a} (pass=true means this violation did NOT occur)`));
		}
	}
	lines.push("");
	lines.push("## Scoring rules");
	lines.push(`- Score EVERY listed assertion: boolean pass/fail + a 0..1 confidence (ranking-only signal, not a probability).`);
	lines.push(`- pass has UNIFORM "criterion satisfied" semantics: for must-hold lines pass=true means the condition HELD; for must-NOT-hold lines pass=true means the violation did NOT occur (fail=true would mean it DID occur).`);
	lines.push(`- Use absent:true when you honestly cannot judge an assertion (missing evidence, unreadable file) — never guess.`);
	lines.push(`- Read just-in-time: grep the ledgers for signatures; do not read whole files end-to-end.`);
	lines.push(`- Verdicts are advisory observations of THIS run; nothing you say modifies the run.`);
	lines.push("");
	lines.push("## Data to return (structured output)");
	lines.push(`- assertions: one entry per listed assertion id, fields {id, assertion, pass, confidence, absent?}`);
	lines.push(`- summaryNote: one honest sentence about what was checkable and what was not`);
	return lines.join("\n");
}

/** The dispatch seam type (structural — the workflow passes ctx.agent; tests
 *  pass a stub; the call object is AgentCall-shaped). */
export type EvalAgentDispatch = (call: {
	id: string;
	agent: string;
	accessMode: "source-read-only";
	prompt: string;
	controlKeys: string[];
	schema: unknown;
	timeoutMs: number;
	toolBudget?: { soft: number; hard: number; block: string[] };
}) => Promise<{ text: string; control: unknown; error?: string }>;

/** Fold distilled assertions into per-dimension final-response rows (one row
 *  per rubric dimension; the conservative fold is a decision rule, NOT an
 *  aggregate: any failed assertion ⇒ "fail"; else any absent/missing ⇒
 *  honest-absent; else "pass" — the prototype family's boolean pair).
 *  Per-assertion booleans + confidences ride the eval.scored event and the
 *  report table, never a folded number. Pure; never throws. */
export function foldFinalResponseRows(input: { runId: string; ts: number; configStamp: string; rubrics: readonly Rubric[]; distilled: { assertions: DistilledEvalAssertion[] } }): EvalRow[] {
	const byId = new Map<string, DistilledEvalAssertion>();
	for (const a of input.distilled.assertions) byId.set(a.id, a);
	const rows: EvalRow[] = [];
	for (const rubric of input.rubrics) {
		for (const dim of rubric.dimensions) {
			const ids = [
				...dim.mustHold.map((_, i) => assertionId(rubric.rubricId, dim.name, "mustHold", i)),
				...dim.mustNot.map((_, i) => assertionId(rubric.rubricId, dim.name, "mustNot", i)),
			];
			let verdict: string = "pass";
			for (const id of ids) {
				const a = byId.get(id);
				if (a === undefined || a.absent) { verdict = HONEST_ABSENT; continue; }
				// F-04: pass is UNIFORM "criterion satisfied" — on mustNot entries
				// pass=true already means the violation did NOT occur, so !pass on
				// EITHER kind is a violated criterion. Fold stays `!a.pass → fail`.
				if (!a.pass) { verdict = "fail"; break; }
			}
			rows.push({
				ts: input.ts,
				runId: input.runId,
				target: "run",
				metric: dim.name,
				// F-03: rubric-shaped rows stamp their rubric (DEC-7 row provenance).
				rubricId: rubric.rubricId,
				rubricVersion: rubric.version,
				verdict,
				scorerKind: "final-response",
				configStamp: input.configStamp,
			});
		}
	}
	return rows;
}

// ── D7 gate execution ───────────────────────────────────────────────────────

export interface GateOutcome {
	agreement: GateAgreement;
	decision: GateDecision;
	/** Rows excluded from matched pairs as named discards (honest-absent or
	 *  non-closure verdicts or unknown caseRefs) — counted, never silently
	 *  dropped (P10). */
	excludedRows: number;
}

/** Run the D7 gate: join scored caseRef rows to maintainer labels via
 *  computeGateAgreement + gatePasses. Honest-absent rows are named discards
 *  (excluded from pairs — an abstention is not a disagreement); caseVersion
 *  prefers the row's OWN F-03 stamp, falling back to the loaded golden cases
 *  only for rows that lack it. Null when no labels exist. Pure. */
export function runGate(rows: readonly EvalRow[], cases: readonly GoldenCase[], labels: readonly GateLabels[]): GateOutcome | null {
	const allLabels = labels.flatMap((l) => l.maintainerVerdicts);
	if (allLabels.length === 0) return null;
	const versionByCaseId = new Map<string, number>();
	for (const c of cases) versionByCaseId.set(c.id, c.caseVersion);
	const scorerVerdicts: ScorerVerdictRow[] = [];
	let excludedRows = 0;
	for (const row of rows) {
		if (row.caseRef === undefined) continue; // metric/dimension rows are not case scores
		if (row.verdict === HONEST_ABSENT || !VERDICT_CLOSURE.includes(row.verdict)) { excludedRows++; continue; }
		// F-03: the row's own stamp wins — it is the version the SCORER saw, the
		// honest join key even if the loaded case file has since moved on.
		const version = row.caseVersion ?? versionByCaseId.get(row.caseRef);
		if (version === undefined) { excludedRows++; continue; } // row for a case this run did not load — named
		// Deterministic trajectory rows carry no verbalized confidence; NaN is
		// computeGateAgreement's honest "no confidence" (calibrationExcluded).
		scorerVerdicts.push({ caseId: row.caseRef, caseVersion: version, verdict: row.verdict, confidence: row.confidence ?? Number.NaN });
	}
	const agreement = computeGateAgreement(scorerVerdicts, allLabels, cases);
	return { agreement, decision: gatePasses(agreement), excludedRows };
}

// ── outputs: dataset rows / events / report ────────────────────────────────

/** Default dataset home: ~/.super-dev/evals/runs/ (DEC-5 user-local). */
export function defaultDatasetDir(): string {
	return join(getSuperDevDir(), "evals", "runs");
}

/** Read the global run-metrics ledger (E1 baselines; best-effort — never
 *  throws, missing/unreadable → []). */
function readGlobalMetricsLedger(): RunMetricsRow[] {
	try {
		return readFileSync(join(getSuperDevDir(), "run-metrics.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as RunMetricsRow);
	} catch {
		return [];
	}
}

/** Append dataset rows to <datasetDir>/rows.jsonl (best-effort, never
 *  throws). The DEFAULT-dir append is guarded by the eval stage's OWN kill
 *  switch SUPER_DEV_NO_EVAL_STAGE (F-07 — decoupled from the run-metrics
 *  hermeticity switch; enabling the stage means enabling its dataset writes);
 *  an injected dir (tests) always writes. */
export function appendEvalRows(datasetDir: string | undefined, rows: readonly EvalRow[], opts: { log?: (m: string) => void } = {}): void {
	if (rows.length === 0) return;
	const dir = datasetDir ?? defaultDatasetDir();
	if (datasetDir === undefined && superDevEnv("SUPER_DEV_NO_EVAL_STAGE") === "1") return; // kill switch / suite hermeticity guard (see header)
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, EVAL_DATASET_BASENAME), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
	} catch (err) {
		opts.log?.(`eval stage: dataset row append failed (continuing; never fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** The report renderer. NO single score, NO weighted aggregate, NO average —
 *  assertion/band-level rows and honest counts only (§7 部分 5 禁令; pinned by
 *  the no-aggregate tripwire test). Band positions render as ANOMALY
 *  positions (F-08) — σ-distance from the trailing baseline, not badness. */
export function renderEvalReport(input: {
	runId: string;
	status: string;
	configStamp: string;
	s3: S3Counters;
	trajectoryRows: readonly EvalRow[];
	finalResponseRows: readonly EvalRow[];
	assertions: readonly DistilledEvalAssertion[];
	degraded: boolean;
	/** F-06: set when the frontier dispatch was SKIPPED for a named reason
	 *  (e.g. run-aborted) — rendered as a skip note, distinct from
	 *  scorerDegraded (a skip is not a degradation). */
	frSkipNote?: string;
	summaryNote: string;
	gate: GateOutcome | null;
}): string {
	const lines: string[] = [];
	lines.push(`# Eval report`);
	lines.push("");
	lines.push(`- run: \`${input.runId}\` — status **${input.status}** — configStamp \`${input.configStamp}\``);
	lines.push(`- advisory observations only (D5): verdicts measure, they never gate this run; per-phase mid-run boundaries are deferred (v1 scores the run close-out boundary)`);
	lines.push(`- band positions are ANOMALY positions (σ-distance from the trailing baseline), not badness: a high judgeAccepted lands 3σ exactly like a high judgeDiscarded — drift MEANING is owned by the rubric bandMap, not the position itself`);
	lines.push(`- v1 trajectory faces: judge + implementation targets only; every other target honestly emits honest-absent rows (nothing was observed for that face this run)`);
	lines.push(`- S3 counters this pass (frozen pre-eval snapshot): judgeAccepted ${input.s3.judgeAccepted}, judgeDiscarded ${input.s3.judgeDiscarded}, partialPhases ${input.s3.partialPhases}, inheritedRedHandoffs ${input.s3.inheritedRedHandoffs}, inheritedRedOccurrences ${input.s3.inheritedRedOccurrences}, maxPhaseAttempts ${input.s3.maxPhaseAttempts}`);
	const absentTraj = input.trajectoryRows.filter((r) => r.verdict === HONEST_ABSENT).length;
	const absentFr = input.finalResponseRows.filter((r) => r.verdict === HONEST_ABSENT).length;
	lines.push(`- honest-absent rows: ${absentTraj} trajectory, ${absentFr} final-response (named discards — never fabricated)${input.degraded ? `; final-response scorer DEGRADED (quota/spawn/timeout floor — rows stamped scorerDegraded, excluded from future σ-band baselines)` : ""}`);
	if (input.frSkipNote) lines.push(`- final-response scorer SKIPPED: ${input.frSkipNote} (a named skip, not a degradation — no scorerDegraded stamp)`);

	const metricRows = input.trajectoryRows.filter((r) => r.metric !== undefined && r.caseRef === undefined);
	if (metricRows.length > 0) {
		lines.push("");
		lines.push(`## Trajectory — per-metric band rows (deterministic)`);
		lines.push("");
		lines.push(`| metric | target face | band (anomaly position) | verdict |`);
		lines.push(`|---|---|---|---|`);
		for (const r of metricRows) lines.push(`| ${r.metric} | ${r.target} | ${r.bandPosition} | ${r.verdict} |`);
	}
	const caseRows = input.trajectoryRows.filter((r) => r.caseRef !== undefined);
	if (caseRows.length > 0) {
		lines.push("");
		lines.push(`## Trajectory — per-target advisory verdict rows`);
		lines.push("");
		lines.push(`| case | target | metric | band (anomaly position) | verdict |`);
		lines.push(`|---|---|---|---|---|`);
		for (const r of caseRows) lines.push(`| ${r.caseRef}@v${r.caseVersion ?? "?"} | ${r.target} | ${r.metric ?? "—"} | ${r.bandPosition ?? "—"} | ${r.verdict}${r.rubricId !== undefined ? ` (${r.rubricId})` : ""} |`);
	}
	if (input.finalResponseRows.length > 0) {
		lines.push("");
		lines.push(`## Final response — rubric dimension rows`);
		lines.push("");
		lines.push(`| dimension | rubric | verdict |`);
		lines.push(`|---|---|---|`);
		for (const r of input.finalResponseRows) lines.push(`| ${r.metric} | ${r.rubricId ?? "—"}@${r.rubricVersion ?? "?"} | ${r.verdict}${r.scorerDegraded ? " (scorerDegraded)" : ""} |`);
	}
	if (input.assertions.length > 0) {
		lines.push("");
		lines.push(`## Final response — per-assertion booleans (ranking-only confidences)`);
		lines.push("");
		lines.push(`| assertion | pass | confidence |`);
		lines.push(`|---|---|---|`);
		for (const a of input.assertions) lines.push(`| ${a.id}: ${a.assertion} | ${a.absent ? "absent" : a.pass ? "✓" : "✗"} | ${a.confidence.toFixed(2)} |`);
	}
	if (input.summaryNote) lines.push(``, `> ${input.summaryNote}`);
	if (input.gate !== null) {
		const g = input.gate;
		lines.push("");
		lines.push(`## Validation gate (D7 — the P3 flywheel premise; suppresses nothing in P2)`);
		lines.push("");
		lines.push(`- posture: **${g.decision.posture}** — passes: **${g.decision.passes}**`);
		for (const reason of g.decision.reasons) lines.push(`- ${reason}`);
		lines.push(`- matched pairs ${g.agreement.matchedPairs}, agreed ${g.agreement.agreed}${g.agreement.agreementRate !== null ? `, agreement ${g.agreement.agreementRate.toFixed(4)}` : ""}${g.agreement.bootstrap !== null ? `, bootstrap CI [${g.agreement.bootstrap.ciLow.toFixed(3)}, ${g.agreement.bootstrap.ciHigh.toFixed(3)}]` : ""}`);
		// F-10: labels no scored row matched are surfaced whenever any exist —
		// an invisible unmatched label is a calibration gap the maintainer cannot
		// see (P10).
		if (g.agreement.unmatchedLabels > 0) lines.push(`- ${g.agreement.unmatchedLabels} maintainer label(s) unmatched by any scored row — the scored case set does not cover those labels (a named gap, not a disagreement)`);
		if (g.excludedRows > 0) lines.push(`- ${g.excludedRows} row(s) excluded as named discards (honest-absent / non-closure verdicts / unloaded cases)`);
	}
	return lines.join("\n") + "\n";
}

// ── the orchestrator (fail-open; never throws) ──────────────────────────────

/** Whether the close-out eval stage runs at all (F-07). The stage is ON by
 *  default; `SUPER_DEV_NO_EVAL_STAGE=1` (env or the config.json env map — the
 *  same documented kill-switch/hermeticity class as
 *  SUPER_DEV_NO_SAFETY_GUARD v0.3.86) disables it. The vitest suite sets it
 *  in tests/setup/config-env-hermeticity.ts — zero perturbation of existing
 *  tests; production never sets it. */
export function evalStageEnabled(): boolean {
	return superDevEnv("SUPER_DEV_NO_EVAL_STAGE") !== "1";
}

export interface EvalStageInput {
	runId: string;
	status: string;
	specDirectory: string | undefined;
	/** The run's S3 counters (derived once at the wiring; displayed in the
	 *  report context and inlined into the scorer prompt — strictly read,
	 *  never actuated). */
	s3: S3Counters;
	/** The run's FROZEN pre-eval snapshot (F-01: the workflow captures
	 *  wallMs/agentsSpawned/usage BEFORE the dispatch, so the scorer's own
	 *  spend can never perturb the band face of the run it measures — the
	 *  same snapshot feeds the run-metrics row). The current-row band face is
	 *  built via buildRunMetricsRow from it — reused, not duplicated. */
	metrics: {
		agentsSpawned: number;
		wallMs: number;
		results: Array<{ id?: string; label?: string; status?: string; error?: string; cause?: string }>;
		usage?: { totals?: Partial<{ calls: number; input: number; output: number; cost: number }>; byAgent?: unknown };
	};
	/** Prior ledger rows for band baselines (default: the global
	 *  run-metrics.jsonl; tests inject synthetic baselines). */
	sigmaRows?: RunMetricsRow[];
	cases?: LoadedGoldenCases;
	rubrics?: LoadedRubrics;
	labels?: GateLabels[];
	config?: EvalConfigShape;
	/** Dataset dir override (tests). Default: ~/.super-dev/evals/runs. */
	datasetDir?: string;
	/** ctx.budget.check() at the wiring — the dispatch guard (quota class). */
	budgetOk?: boolean;
	/** F-06: the run aborted (cancelled/fatal). The deterministic trajectory
	 *  scoring still runs; the frontier dispatch is SKIPPED entirely (no LLM
	 *  spend on aborted runs) and the final-response floor is an honest-absent
	 *  row WITHOUT the scorerDegraded stamp — a named skip, not a degradation. */
	runAborted?: boolean;
	/** The agent dispatch seam (production: ctx.agent; tests: a stub). */
	agentCall?: EvalAgentDispatch;
	log?: (m: string) => void;
	ts?: number;
}

export interface EvalStageOutcome {
	rows: EvalRow[];
	trajectoryRows: EvalRow[];
	finalResponseRows: EvalRow[];
	assertions: DistilledEvalAssertion[];
	degraded: boolean;
	summaryNote: string;
	gate: GateOutcome | null;
	report: string | null;
	configStamp: string;
}

/** Run the whole eval surface at close-out. NEVER throws (P4/P5): every layer
 *  degrades to honest rows + a warning log; the run under review always
 *  completes unaffected. */
export async function runEvalStage(input: EvalStageInput): Promise<EvalStageOutcome> {
	const log = input.log ?? (() => {});
	const ts = input.ts ?? Date.now();
	try {
		const cases = input.cases ?? loadGoldenCases(undefined, { log });
		const rubrics = input.rubrics ?? loadRubrics(undefined, { log });
		const labels = input.labels ?? loadGateLabels(undefined, { log });
		const config = input.config ?? getConfig(); // getConfig itself degrades to DEFAULT_CONFIG on an unreadable file
		const configStamp = configStampOf(config);

		// ── trajectory (deterministic) ──
		const priorRows = input.sigmaRows ?? readGlobalMetricsLedger();
		const currentRow = buildRunMetricsRow({
			runId: input.runId,
			status: input.status,
			agentsSpawned: input.metrics.agentsSpawned,
			wallMs: input.metrics.wallMs,
			results: input.metrics.results,
			usage: input.metrics.usage,
			s3: input.s3,
			ts,
		});
		const positions = bandPositions(priorRows, currentRow);
		const trajectoryRows = scoreTrajectory({ runId: input.runId, ts, configStamp, positions, cases: cases.cases, rubrics: rubrics.rubrics, log });

		// ── final response (one frontier dispatch, guarded) ──
		let finalResponseRows: EvalRow[] = [];
		let assertions: DistilledEvalAssertion[] = [];
		let degraded = false;
		let summaryNote = "";
		let frSkipNote = "";
		const degradedFloor = (reason: string): EvalRow[] => {
			log(`eval stage: final-response scorer degraded (${reason}) — deterministic-only floor (honest-absent discard row, stamped scorerDegraded; no fallback model, DEC-9)`);
			return [{ ts, runId: input.runId, target: "run", verdict: HONEST_ABSENT, scorerKind: "final-response" as const, configStamp, scorerDegraded: true }];
		};
		const skipFloor = (note: string): EvalRow[] => {
			// F-06: a named SKIP — honest-absent WITHOUT scorerDegraded (the
			// instrument was never asked and never failed; nothing to exclude
			// from baselines because no score was attempted).
			log(`eval stage: final-response scorer skipped (${note}) — honest-absent discard row, no scorerDegraded stamp`);
			frSkipNote = note;
			return [{ ts, runId: input.runId, target: "run", verdict: HONEST_ABSENT, scorerKind: "final-response", configStamp }];
		};
		if (input.runAborted === true) {
			// F-06: cancelled/fatal runs get the deterministic trajectory scoring
			// but NEVER frontier dispatch — no LLM spend on an aborted run.
			finalResponseRows = skipFloor("run-aborted skip — no LLM spend on a cancelled/fatal run");
		} else if (rubrics.rubrics.length === 0) {
			// Cold start (DEC-5): nothing to score — the named discard is NOT a
			// degradation (the instrument was never asked).
			finalResponseRows = skipFloor("cold start — no rubrics loaded (seed rubrics under ~/.super-dev/evals/rubrics/)");
		} else if (input.budgetOk === false) {
			degraded = true;
			finalResponseRows = degradedFloor("budget exhausted (maxAgents reached — the dispatch was never launched)");
		} else if (input.agentCall === undefined) {
			degraded = true;
			finalResponseRows = degradedFloor("dispatch seam absent (wiring contract: the close-out must pass ctx.agent)");
		} else {
			const budget = resolveToolBudget(EVAL_SCORER_AGENT, { warn: (m) => log(m) });
			try {
				const result = await input.agentCall({
					id: "pipeline.eval.final-response",
					agent: EVAL_SCORER_AGENT,
					accessMode: "source-read-only",
					prompt: buildEvalScorerPrompt({ runId: input.runId, status: input.status, specDirectory: input.specDirectory, rubrics: rubrics.rubrics, snapshot: { wallMs: input.metrics.wallMs, agentsSpawned: input.metrics.agentsSpawned, s3: input.s3 } }),
					controlKeys: ["assertions", "summaryNote"],
					schema: EvalScorerData,
					timeoutMs: EVAL_SCORER_TIMEOUT_MS,
					...(budget !== undefined ? { toolBudget: budget } : {}),
				});
				if (result.error) {
					degraded = true;
					finalResponseRows = degradedFloor(result.error);
				} else {
					const distilled = distillEvalScorerControl(result.control, { log });
					if (distilled === null || distilled.assertions.length === 0) {
						degraded = true;
						finalResponseRows = degradedFloor(distilled === null ? "scorer returned no usable structured result" : "scorer returned zero usable assertions");
					} else {
						assertions = distilled.assertions;
						summaryNote = distilled.summaryNote;
						finalResponseRows = foldFinalResponseRows({ runId: input.runId, ts, configStamp, rubrics: rubrics.rubrics, distilled });
					}
				}
			} catch (err) {
				degraded = true;
				finalResponseRows = degradedFloor(`dispatch threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const rows = [...trajectoryRows, ...finalResponseRows];

		// ── D7 gate execution (labels exist covering scored cases) ──
		let gate: GateOutcome | null = null;
		try {
			// `in`-narrowing: LoadedGateLabels vs readonly-array union (P1 precedent).
			gate = runGate(rows, cases.cases, "labels" in labels ? labels.labels : labels);
		} catch (err) {
			log(`eval stage: gate execution failed open (${err instanceof Error ? err.message : String(err)})`);
		}

		// ── outputs (all three, always) ──
		appendEvalRows(input.datasetDir, rows, { log });
		try {
			appendRunEvent(input.specDirectory, { runId: input.runId, type: "eval.scored", data: { scorerKind: "trajectory", configStamp, rows: trajectoryRows.map((r) => ({ ...r })) } });
			appendRunEvent(input.specDirectory, { runId: input.runId, type: "eval.scored", data: { scorerKind: "final-response", configStamp, degraded, ...(frSkipNote !== "" ? { skipped: frSkipNote } : {}), rows: finalResponseRows.map((r) => ({ ...r })), assertions } });
			if (gate !== null) {
				appendRunEvent(input.specDirectory, {
					runId: input.runId,
					type: "eval.gate",
					data: { passes: gate.decision.passes, posture: gate.decision.posture, reasons: gate.decision.reasons, matchedPairs: gate.agreement.matchedPairs, agreed: gate.agreement.agreed, excludedRows: gate.excludedRows },
				});
			}
		} catch (err) {
			log(`eval stage: eval.* event append failed (continuing; never fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
		let report: string | null = null;
		try {
			report = renderEvalReport({ runId: input.runId, status: input.status, configStamp, s3: input.s3, trajectoryRows, finalResponseRows, assertions, degraded, ...(frSkipNote !== "" ? { frSkipNote } : {}), summaryNote, gate });
			if (input.specDirectory) {
				const dir = isAbsolute(input.specDirectory) ? input.specDirectory : join(process.cwd(), input.specDirectory);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, EVAL_REPORT_BASENAME), report, "utf8");
			}
			log(`eval stage: ${rows.length} row(s) (${trajectoryRows.length} trajectory, ${finalResponseRows.length} final-response${degraded ? ", scorer degraded" : ""})${gate !== null ? `, gate ${gate.decision.posture}` : ""}${input.specDirectory ? ` — ${join(input.specDirectory, EVAL_REPORT_BASENAME)}` : ""}`);
		} catch (err) {
			log(`eval stage: report render/write failed (continuing; never fatal): ${err instanceof Error ? err.message : String(err)}`);
		}

		return { rows, trajectoryRows, finalResponseRows, assertions, degraded, summaryNote, gate, report, configStamp };
	} catch (err) {
		// The fail-open hard constraint: an eval-stage bug can never fail or
		// block the run under review (P4/P5).
		log(`eval stage: failed open — run unaffected (${err instanceof Error ? err.message : String(err)}); this is a bug in the eval surface, not in the run`);
		return { rows: [], trajectoryRows: [], finalResponseRows: [], assertions: [], degraded: true, summaryNote: "", gate: null, report: null, configStamp: "" };
	}
}
