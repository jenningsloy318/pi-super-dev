import { nonEmptyString, type GoldenCase, type SkippedFile, type Validation } from "./cases.ts";
import { VERDICT_CLOSURE } from "./closure.ts";
/**
 * eval-layer — the validation gate: hand labels, agreement + bootstrap calibration, and the gatePasses policy. Layer doc: ./closure.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { labelsDir } from "../eval-shared.ts";
import { MIN_PRIOR_RUNS } from "../sigma-bands.ts";

// ─── Validation gate (D7 / DEC-13① / L2 / L3) — P1 machinery ────────────────

/** The P2 scorer-row shape (DEC-2/DEC-9): what the scorers will emit per
 *  golden case. Confidence is RANKING-ONLY (§8.2) — see RUBRIC_SCALE.
 *  `ts` (adversarial-gate F-01b) is OPTIONAL provenance for the latest-wins
 *  duplicate resolution in computeGateAgreement — absent rows tie at 0 and
 *  the LAST occurrence in ledger order wins; it never gates anything. */
export interface ScorerVerdictRow {
	caseId: string;
	caseVersion: number;
	verdict: string;
	confidence: number;
	ts?: number;
}

/** One maintainer hand label (DEC-13① — the known-good/bad calibration the
 *  scorer is trusted against BEFORE any automated score is). */
export interface MaintainerVerdict {
	caseId: string;
	caseVersion: number;
	/** The human's expected verdict — same DEC-6 closure as golden cases. */
	expectedByHuman: string;
	notes?: string;
}

/** ~/.super-dev/evals/labels/<gate-id>.json (L3). */
export interface GateLabels {
	gateId: string;
	created: string;
	maintainerVerdicts: MaintainerVerdict[];
}

/** Validate a gate-labels file. File-level shape failures (bad gateId/created,
 *  basename≠gateId) reject the WHOLE file; per-entry failures skip that entry
 *  loudly (ok=true with reasons — the file survives with its good entries).
 *  `expectedGateId` (the file basename minus .json) enforces the addressing
 *  scheme. */
export function validateGateLabels(raw: unknown, options: { expectedGateId?: string } = {}): Validation<GateLabels> {
	const reasons: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reasons: ["gate labels: must be a JSON object"] };
	}
	const obj = raw as Record<string, unknown>;
	const gateId = nonEmptyString(obj.gateId);
	let gateIdMismatch = false;
	if (gateId === null) reasons.push("gateId: must be a non-empty string");
	else if (options.expectedGateId !== undefined && gateId !== options.expectedGateId) {
		gateIdMismatch = true; // deviation-4: the gate-id IS the address — a mismatch rejects the WHOLE file
		reasons.push(`gateId: "${gateId}" does not match the file name "${options.expectedGateId}" — rename the file or fix the field (the gate-id IS the address)`);
	}
	if (nonEmptyString(obj.created) === null) reasons.push("created: must be a non-empty string (ISO timestamp)");

	const verdictsRaw = obj.maintainerVerdicts;
	if (!Array.isArray(verdictsRaw)) {
		reasons.push("maintainerVerdicts: must be an array");
		return { ok: false, reasons };
	}

	const verdicts: MaintainerVerdict[] = [];
	const seen = new Set<string>();
	verdictsRaw.forEach((v, i) => {
		const label = `maintainerVerdicts[${i}]`;
		if (typeof v !== "object" || v === null || Array.isArray(v)) {
			reasons.push(`${label}: skipped — must be an object`);
			return;
		}
		const entry = v as Record<string, unknown>;
		const caseId = nonEmptyString(entry.caseId);
		const caseVersion = entry.caseVersion;
		const expectedByHuman = nonEmptyString(entry.expectedByHuman);
		let ok = true;
		if (caseId === null) { reasons.push(`${label}: skipped — caseId must be a non-empty string`); ok = false; }
		if (typeof caseVersion !== "number" || !Number.isInteger(caseVersion) || caseVersion < 1) {
			reasons.push(`${label}: skipped — caseVersion must be an integer ≥ 1, got: ${JSON.stringify(caseVersion)}`);
			ok = false;
		}
		if (expectedByHuman === null) {
			reasons.push(`${label}: skipped — expectedByHuman must be a non-empty string`);
			ok = false;
		} else if (!VERDICT_CLOSURE.includes(expectedByHuman)) {
			reasons.push(`${label}: skipped — expectedByHuman "${expectedByHuman}" is not an existing verdict enum value (the same DEC-6 closure as golden cases)`);
			ok = false;
		}
		if (entry.notes !== undefined && nonEmptyString(entry.notes) === null) {
			reasons.push(`${label}: skipped — notes, when present, must be a non-empty string`);
			ok = false;
		}
		if (!ok || caseId === null) return;
		const key = `${caseId}\u0000${String(caseVersion)}`;
		if (seen.has(key)) {
			reasons.push(`${label}: skipped — duplicate (caseId "${caseId}", caseVersion ${String(caseVersion)}) — first entry wins`);
			return;
		}
		seen.add(key);
		verdicts.push({ caseId, caseVersion: caseVersion as number, expectedByHuman: expectedByHuman as string, ...(entry.notes !== undefined ? { notes: entry.notes as string } : {}) });
	});

	if (gateId === null || gateIdMismatch || nonEmptyString(obj.created) === null) return { ok: false, reasons };
	return { ok: true, value: { gateId, created: obj.created as string, maintainerVerdicts: verdicts }, reasons };
}

export interface LoadedGateLabels {
	labels: GateLabels[];
	skipped: SkippedFile[];
}

export function defaultLabelsDir(): string {
	return labelsDir();
}

export function loadGateLabels(dir: string = defaultLabelsDir(), opts: { log?: (line: string) => void } = {}): LoadedGateLabels {
	const warn = opts.log ?? ((line: string) => console.warn(`[super-dev] ${line}`));
	const out: LoadedGateLabels = { labels: [], skipped: [] };
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return out; // cold start: empty, no error
	}
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch (error) {
			const reasons = [`unparseable JSON: ${error instanceof Error ? error.message : String(error)}`];
			out.skipped.push({ file, reasons });
			warn(`eval labels: skipped ${file}: ${reasons.join("; ")}`);
			continue;
		}
		const expectedGateId = file.replace(/\.json$/, "");
		const validated = validateGateLabels(raw, { expectedGateId });
		if (!validated.ok) {
			out.skipped.push({ file, reasons: validated.reasons });
			warn(`eval labels: skipped ${file}: ${validated.reasons.join("; ")}`);
			continue;
		}
		if (validated.reasons.length > 0) {
			// File survived; individual entries skipped — still loud.
			warn(`eval labels: ${file}: ${validated.reasons.join("; ")}`);
		}
		out.labels.push(validated.value);
	}
	return out;
}

// ─── Agreement computation (§8.2 calibration, §8.5 bootstrap) ───────────────

/** One reliability-diagram bucket: confidence decile [low, high) (top bucket
 *  inclusive) → observed agreement rate among matched scorer rows whose
 *  confidence fell in the bucket. RANKING→EMPIRICAL bridge per §8.2. */
export interface CalibrationBucket {
	low: number;
	high: number;
	n: number;
	agreementRate: number | null;
}

export interface TargetAgreement {
	target: string;
	matched: number;
	agreed: number;
	agreementRate: number | null;
}

export interface GateAgreement {
	matchedPairs: number;
	agreed: number;
	/** agreed/matchedPairs; null when nothing matched (no fake 0). */
	agreementRate: number | null;
	/** Bootstrap percentile CI (§8.5, 95%); null below
	 *  GATE_MIN_MATCHED_PAIRS — a CI on a directional-only sample would be
	 *  dishonest. */
	bootstrap: { seed: number; resamples: number; ciLow: number; ciHigh: number } | null;
	/** Per-target breakdown (DEC-6 target face); requires the `cases`
	 *  argument — rows without a matching case land under "unknown". */
	perTarget: TargetAgreement[];
	/** Fixed 10-decile reliability diagram (§8.2); empty buckets carry
	 *  n=0 / null rate — the diagram shape is stable across calls. */
	calibration: CalibrationBucket[];
	/** Matched rows excluded from calibration (confidence not a finite
	 *  number in [0,1]) — named, never silently dropped (P10). */
	calibrationExcluded: number;
	unmatchedScorerRows: number;
	unmatchedLabels: number;
	/** Scorer rows too malformed to match (named discard, P10). */
	malformedScorerRows: number;
	/** Well-formed scorer rows whose (caseId, caseVersion) key was already
	 *  scored (F3) — counted and surfaced, never silently dropped and never
	 *  admitted into pairs (P10: a duplicate emission is a scorer bug, not a
	 *  data point). */
	duplicateScorerRows: number;
}

/** Deterministic PRNG (mulberry32) — seed-fixed bootstrap reproducibility
 *  (§8.5: "same seed → same CI"). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Linear-interpolation percentile of a PRE-SORTED array (0..1). */
function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = p * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo]!;
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/**
 * Pure agreement computation: scorer rows joined to maintainer labels on the
 * (caseId, caseVersion) pair — a version mismatch is an UNMATCH (the exact
 * invisible-mixing caseVersion exists to prevent, M2 fold), counted and
 * reported, never silently dropped. `cases` (optional, the loaded golden
 * cases) enables the per-target breakdown. Bootstrap: resamples the matched
 * pair outcomes N times (percentile method, 95% CI), deterministic for a
 * fixed seed.
 */
export function computeGateAgreement(
	scorerVerdicts: readonly ScorerVerdictRow[],
	labels: GateLabels | readonly MaintainerVerdict[],
	cases: readonly GoldenCase[] = [],
	opts: { seed?: number; resamples?: number } = {},
): GateAgreement {
	const seed = opts.seed ?? GATE_BOOTSTRAP_SEED;
	const resamples = opts.resamples ?? GATE_BOOTSTRAP_RESAMPLES;
	// `in`-narrowing: Array.isArray cannot narrow a readonly-array vs object union.
	const maintainerVerdicts: readonly MaintainerVerdict[] = "maintainerVerdicts" in labels ? labels.maintainerVerdicts : labels;

	const labelByKey = new Map<string, MaintainerVerdict>();
	for (const m of maintainerVerdicts) {
		const key = `${m.caseId}\u0000${String(m.caseVersion)}`;
		if (!labelByKey.has(key)) labelByKey.set(key, m); // loader already skips dups; first-wins here too
	}

	const targetByCaseId = new Map<string, string>();
	for (const c of cases) targetByCaseId.set(c.id, c.target.raw);

	type Pair = { key: string; target: string; agree: boolean; confidence: number | null };
	const pairs: Pair[] = [];
	const matchedKeys = new Set<string>();
	const latestByKey = new Map<string, ScorerVerdictRow>();
	let unmatchedScorerRows = 0;
	let unmatchedLabels = 0;
	let malformedScorerRows = 0;
	let duplicateScorerRows = 0;

	// Adversarial-gate F-01b (first-wins freezing): ONE scored row per (caseId,
	// caseVersion) — the LATEST observation by ts drives the verdict (ties, incl.
	// missing ts, → the LAST occurrence in ledger order). A later emission no
	// longer freezes the disposition at the first sighting; every additional
	// same-key row is STILL counted in duplicateScorerRows (P10 visibility — a
	// duplicate emission remains a scorer bug worth seeing, just not a second
	// pair and not a stale verdict). Map order = FIRST-encounter order (stable,
	// deterministic) while the VALUE is the latest row.
	const tsOf = (r: ScorerVerdictRow): number => (typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : 0);
	for (const row of scorerVerdicts) {
		if (typeof row?.caseId !== "string" || row.caseId.trim() === "" || typeof row.caseVersion !== "number" || !Number.isInteger(row.caseVersion) || row.caseVersion < 1 || typeof row.verdict !== "string") {
			malformedScorerRows += 1;
			continue;
		}
		const key = `${row.caseId}\u0000${String(row.caseVersion)}`;
		const prev = latestByKey.get(key);
		if (prev !== undefined) duplicateScorerRows += 1;
		if (prev === undefined || tsOf(row) >= tsOf(prev)) latestByKey.set(key, row);
	}
	for (const row of latestByKey.values()) {
		const key = `${row.caseId}\u0000${String(row.caseVersion)}`;
		const label = labelByKey.get(key);
		if (!label) {
			unmatchedScorerRows += 1;
			continue;
		}
		matchedKeys.add(key);
		const confidence = typeof row.confidence === "number" && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1 ? row.confidence : null;
		pairs.push({ key, target: targetByCaseId.get(row.caseId) ?? "unknown", agree: row.verdict === label.expectedByHuman, confidence });
	}
	for (const key of labelByKey.keys()) {
		if (!matchedKeys.has(key)) unmatchedLabels += 1;
	}

	const matchedPairs = pairs.length;
	const agreed = pairs.filter((p) => p.agree).length;
	const agreementRate = matchedPairs > 0 ? agreed / matchedPairs : null;

	// Bootstrap percentile CI over the agree/disagree outcomes (§8.5). F5:
	// computed ONLY at n ≥ GATE_MIN_MATCHED_PAIRS — below the floor the sample
	// is directional-only and a CI would be dishonest.
	let bootstrap: GateAgreement["bootstrap"] = null;
	if (matchedPairs >= GATE_MIN_MATCHED_PAIRS && resamples > 0) {
		const rand = mulberry32(seed);
		const rates: number[] = [];
		for (let i = 0; i < resamples; i++) {
			let hits = 0;
			for (let j = 0; j < matchedPairs; j++) {
				const pick = pairs[Math.floor(rand() * matchedPairs)]!;
				if (pick.agree) hits += 1;
			}
			rates.push(hits / matchedPairs);
		}
		rates.sort((a, b) => a - b);
		bootstrap = { seed, resamples, ciLow: percentile(rates, 0.025), ciHigh: percentile(rates, 0.975) };
	}

	// Per-target breakdown (deterministic order).
	const byTarget = new Map<string, { matched: number; agreed: number }>();
	for (const p of pairs) {
		const t = byTarget.get(p.target) ?? { matched: 0, agreed: 0 };
		t.matched += 1;
		if (p.agree) t.agreed += 1;
		byTarget.set(p.target, t);
	}
	const perTarget: TargetAgreement[] = [...byTarget.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([target, t]) => ({ target, matched: t.matched, agreed: t.agreed, agreementRate: t.matched > 0 ? t.agreed / t.matched : null }));

	// Calibration: 10 fixed decile buckets (§8.2 reliability diagram).
	const buckets: Array<{ n: number; agreed: number }> = Array.from({ length: 10 }, () => ({ n: 0, agreed: 0 }));
	let calibrationExcluded = 0;
	for (const p of pairs) {
		if (p.confidence === null) {
			calibrationExcluded += 1;
			continue;
		}
		const idx = Math.min(Math.floor(p.confidence * 10), 9);
		buckets[idx]!.n += 1;
		if (p.agree) buckets[idx]!.agreed += 1;
	}
	const calibration: CalibrationBucket[] = buckets.map((b, i) => ({
		low: i / 10,
		high: i === 9 ? 1 : (i + 1) / 10,
		n: b.n,
		agreementRate: b.n > 0 ? b.agreed / b.n : null,
	}));

	return { matchedPairs, agreed, agreementRate, bootstrap, perTarget, calibration, calibrationExcluded, unmatchedScorerRows, unmatchedLabels, malformedScorerRows, duplicateScorerRows };
}

// ─── Gate policy (DEC-13① — the D4② proposal-drafting premise gate) ─────────

/** Policy constants — named, not magic. Agreement floor for the validation
 *  gate to pass (DEC-13①: below this the rubric/mapping gets fixed, never
 *  the data). */
export const GATE_MIN_AGREEMENT = 0.8;
/** Minimum matched pairs before the gate has authority (§8.5: n<8 is a
 *  directional signal only — the SAME floor as σ-band MIN_PRIOR_RUNS,
 *  imported, not re-typed). */
export const GATE_MIN_MATCHED_PAIRS = MIN_PRIOR_RUNS;
/** Bootstrap policy (§8.5): resample count and the fixed seed that makes CIs
 *  reproducible run-over-run. */
export const GATE_BOOTSTRAP_RESAMPLES = 1000;
export const GATE_BOOTSTRAP_SEED = 20260911; // spec ratification date — fixed, auditable

export interface GateDecision {
	/** Whether the premise for D4② automatic proposal drafting holds. */
	passes: boolean;
	/** "calibrated" — n ≥ floor AND agreement ≥ threshold (the scorer is
	 *  trusted); "directional-only" — n below the floor (signal, no gate
	 *  authority either way); "miscalibrated" — well-sampled agreement below
	 *  the floor (fix the rubric/mapping, not the data). Posture names avoid
	 *  the verdict-closure vocabulary on purpose (they describe the INSTRUMENT,
	 *  not a scored verdict). */
	posture: "calibrated" | "directional-only" | "miscalibrated";
	reasons: string[];
}

/**
 * The gate policy (DEC-13①): trust NO automated score until the scorer has
 * passed maintainer calibration. calibrated = agreement ≥
 * GATE_MIN_AGREEMENT on ≥ GATE_MIN_MATCHED_PAIRS matched pairs (the D4②
 * premise); n below the floor is honest directional-only (never a gate
 * verdict either way); a well-sampled agreement below the floor is
 * miscalibrated — fix the rubric/mapping, not the data.
 */
export function gatePasses(agreement: GateAgreement): GateDecision {
	// F4: n=0 first — its honest reason is "nothing to judge", not a
	// sample-size complaint.
	if (agreement.matchedPairs === 0) {
		return { passes: false, posture: "directional-only", reasons: ["no matched pairs — nothing to judge"] };
	}
	if (agreement.matchedPairs < GATE_MIN_MATCHED_PAIRS) {
		return {
			passes: false,
			posture: "directional-only",
			reasons: [`n=${agreement.matchedPairs} matched pairs < GATE_MIN_MATCHED_PAIRS=${GATE_MIN_MATCHED_PAIRS} — agreement is a directional signal only, not a gate verdict (§8.5; same floor as σ-band MIN_PRIOR_RUNS)`],
		};
	}
	const rate = agreement.agreementRate;
	if (rate === null) {
		// Unreachable for computed results (n ≥ 1 ⇒ rate non-null); guards
		// hand-built inputs with the same honest message as n=0.
		return { passes: false, posture: "directional-only", reasons: ["no matched pairs — nothing to judge"] };
	}
	if (rate >= GATE_MIN_AGREEMENT) {
		return { passes: true, posture: "calibrated", reasons: [`agreement ${rate.toFixed(4)} ≥ GATE_MIN_AGREEMENT=${GATE_MIN_AGREEMENT} on n=${agreement.matchedPairs} matched pairs`] };
	}
	return { passes: false, posture: "miscalibrated", reasons: [`agreement ${rate.toFixed(4)} < GATE_MIN_AGREEMENT=${GATE_MIN_AGREEMENT} on n=${agreement.matchedPairs} matched pairs — fix the rubric/mapping, not the data (DEC-13①)`] };
}