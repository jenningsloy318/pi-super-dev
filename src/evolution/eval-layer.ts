/**
 * EVAL LAYER (P1) — golden-case dataset + rubric artifacts + validation-gate
 * machinery (docs/requirements/sdlc-tips-adoption.md — the ratified spec).
 *
 * What landed here and why (spec citations):
 *   D1 / DEC-5 / DEC-6 — golden cases: labelled scenario → expected-verdict
 *         pairs living in ~/.super-dev/evals/cases/ (user-local, NEVER
 *         in-repo; cold start = empty, mirroring learned.ts). One case per
 *         *.json file; seven fields (id/title/source/target/scenario/
 *         expected/caseVersion); expected.verdict is validated against the
 *         DEC-6 verdict-enum CLOSURE TABLE built from the REAL runtime
 *         vocabularies imported from their owners (P6 single grammar — no
 *         re-typed string copies anywhere in this module).
 *   D2 / DEC-7 / §8.2 — rubric artifacts: one file per rubricId under
 *         ~/.super-dev/evals/rubrics/; assertion-level boolean + 0..1
 *         confidence. The 0..1 confidence is a RANKING-ONLY signal, never a
 *         probability (verbalized-confidence miscalibration, §8.2) — encoded
 *         in the Rubric type docs, and the gate's calibration mapping below
 *         is the honest bridge from ranking to empirical accuracy.
 *   §8.1 — every scenario embeds a literal canary GUID (makeCanary(id)):
 *         the contamination tripwire — a learned-index entry quoting the
 *         canary proves golden-case leakage into a measured agent's context.
 *   D7 / DEC-13① / L2 / L3 — the validation-gate harness (this file's second
 *         half): maintainer hand labels under ~/.super-dev/evals/labels/,
 *         agreement computation with a confidence→accuracy calibration
 *         mapping (reliability diagram, §8.2), bootstrap percentile CIs
 *         (§8.5), and the gatePasses policy that gates D4② proposal
 *         drafting. P1 ships the MACHINERY; the gate EXECUTES in P2 when the
 *         scorers land — nothing here is wired into workflow.ts/stages yet.
 *
 * Loading doctrine (DEC-5, mirrors learned.ts): cold start is an EMPTY
 * dataset, never an error; every validation failure is LOUD per case (file +
 * field + reason) and skips that case — never a silent bad load, never a
 * crash. Data are personal calibration assets: not versioned, lost on
 * reinstall (accepted; the mandatory in-repo `source` anchor is the rebuild
 * path).
 *
 * Seeding doctrine (DEC-7): seed-phase cases and rubrics are HANDWRITTEN by
 * the maintainer. This module auto-generates ZERO content — the template
 * writers emit only validator-passing skeletons (canary pre-embedded) for
 * the maintainer to fill.
 *
 * Review round (owner-adjudicated F1–F10, applied verbatim): three-arm
 *       target grammar (compound "stage|agent" | stage-only | agent-only —
 *       judge is an agent, never a stage); rubric dimension mustNot optional
 *       on the wire; scorer-row dedup with honest duplicate accounting; gate
 *       n=0 checked before n<8; bootstrap CI only at n ≥
 *       GATE_MIN_MATCHED_PAIRS; conservative target→verdict-family mapping
 *       (fail-open default) via TARGET_VERDICT_FAMILIES; id/rubricId must
 *       equal the file basename; source anchors stat+realpath-verified;
 *       template writes use flag "wx"; optional caseSet stamp + caseSetOf
 *       layer derivation.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getSuperDevDir } from "../render/super-dev-dir.ts";
import { STAGE_IDS } from "../graph/edges.ts";
import { REGISTERED_AGENTS } from "../agents/register-agents.ts";
import { REVIEW_VERDICT_VALUES } from "../helpers.ts";
import { PROTOTYPE_VERDICT_VALUES } from "../stages/prototype.ts";
import { JUDGE_EVAL_VERDICT_VALUES } from "../stages/judge.ts";
import { FAULT_CLASS_VALUES } from "../fault-classification.ts";
import { MIN_PRIOR_RUNS } from "./sigma-bands.ts";

// ─── DEC-6 verdict closure table ────────────────────────────────────────────

/**
 * The verdict-enum closure table (DEC-6): golden-case `expected.verdict` (and
 * gate hand labels) may hold ONLY values from this set. Composition — every
 * family imported from the module that owns it:
 *   - REVIEW_VERDICT_VALUES       convergence-review verdicts (helpers.ts
 *                                 VERDICT_RANK keys: the normalized set every
 *                                 reviewer output folds into)
 *   - PROTOTYPE_VERDICT_VALUES    prototype pass/fail closed enum
 *                                 (stages/prototype.ts; schemas.ts unions the
 *                                 same literals)
 *   - JUDGE_EVAL_VERDICT_VALUES   judge accepted/discarded meter semantics
 *                                 (stages/judge.ts)
 *   - FAULT_CLASS_VALUES          fault classification table
 *                                 (fault-classification.ts FaultClass)
 * Verdict comparison is therefore ZERO-LLM (deterministic membership);
 * semantic mustHold/mustNot assertions belong to the scorer LM.
 */
export const VERDICT_CLOSURE: readonly string[] = [
	...REVIEW_VERDICT_VALUES,
	...PROTOTYPE_VERDICT_VALUES,
	...JUDGE_EVAL_VERDICT_VALUES,
	...FAULT_CLASS_VALUES,
];

/** Closed target sets for the `stage|agent` field (DEC-6): pipeline stage ids
 *  (graph/edges.ts STAGE_IDS) and agent names (register-agents.ts
 *  REGISTERED_AGENTS). Exported for tests and P2 filtering. */
export const TARGET_STAGES: readonly string[] = STAGE_IDS;
export const TARGET_AGENTS: readonly string[] = REGISTERED_AGENTS;

/** The one separator accepted inside a target string. ASCII only — the spec's
 *  DEC-6 "stage｜agent" typography normalizes to plain "|" for data. */
export const TARGET_SEPARATOR = "|";

// ─── F6 target→verdict-family mapping (conservative, fail-open default) ─────

/** The four verdict families of the DEC-6 closure — one per owning
 *  vocabulary. */
export type VerdictFamily = "review" | "prototype" | "judge" | "fault";

/** Family → its REAL runtime vocabulary (the same imports the closure is
 *  composed from — single grammar). */
export const VERDICT_FAMILY_VALUES: Readonly<Record<VerdictFamily, readonly string[]>> = {
	review: REVIEW_VERDICT_VALUES,
	prototype: PROTOTYPE_VERDICT_VALUES,
	judge: JUDGE_EVAL_VERDICT_VALUES,
	fault: FAULT_CLASS_VALUES,
};

/**
 * F6 conservative mapping (owner ruling, fail-open default): target arms that
 * resolve to a KNOWN verdict family.
 *   stage arms: prototype → prototype; the convergence-review stages
 *     (requirements, bdd, research, design, spec, verify, docs) → review;
 *   agent arms: prototype-runner → prototype; judge → judge (agent-only
 *     `target: "judge"` is the natural home for judge-verdict cases — judge
 *     is an agent, never a stage); red-boundary-classifier and
 *     tdd-coverage-classifier → fault; ANY agent ending in agentSuffix
 *     ("-reviewer") → review.
 * Stages/agents NOT listed here resolve to NOTHING — such a target is
 * "unmapped" and admits the FULL closure (documented fail-open: the P1
 * loader must not invent vocabulary restrictions the P2 scoring surface has
 * not ratified; P2 scoring surfaces the rest).
 */
export const TARGET_VERDICT_FAMILIES: {
	readonly stage: Readonly<Partial<Record<string, VerdictFamily>>>;
	readonly agent: Readonly<Partial<Record<string, VerdictFamily>>>;
	readonly agentSuffix: string;
} = {
	stage: {
		prototype: "prototype",
		requirements: "review",
		bdd: "review",
		research: "review",
		design: "review",
		spec: "review",
		verify: "review",
		docs: "review",
	},
	agent: {
		"prototype-runner": "prototype",
		judge: "judge",
		"red-boundary-classifier": "fault",
		"tdd-coverage-classifier": "fault",
	},
	agentSuffix: "-reviewer",
};

/** The families a target's arms resolve to (deduped; stage arm first).
 *  An EMPTY result means the target is unmapped → the full closure applies. */
export function targetVerdictFamilies(target: { stage?: string; agent?: string }): VerdictFamily[] {
	const families = new Set<VerdictFamily>();
	if (target.stage !== undefined) {
		const family = TARGET_VERDICT_FAMILIES.stage[target.stage];
		if (family !== undefined) families.add(family);
	}
	if (target.agent !== undefined) {
		const listed = TARGET_VERDICT_FAMILIES.agent[target.agent];
		const family = listed !== undefined ? listed : (target.agent.endsWith(TARGET_VERDICT_FAMILIES.agentSuffix) ? "review" : undefined);
		if (family !== undefined) families.add(family);
	}
	return [...families];
}

/** The verdict admission set for a target: the UNION of its arms' families
 *  (a compound target admits what EITHER arm admits); an unmapped target
 *  (empty resolution) fail-opens to the full DEC-6 closure. */
export function allowedVerdictsForTarget(target: { stage?: string; agent?: string }): readonly string[] {
	const families = targetVerdictFamilies(target);
	if (families.length === 0) return VERDICT_CLOSURE;
	const out = new Set<string>();
	for (const family of families) {
		for (const value of VERDICT_FAMILY_VALUES[family]) out.add(value);
	}
	return [...out];
}

// ─── §8.1 canary ────────────────────────────────────────────────────────────

/**
 * The literal canary GUID embedded in every golden-case scenario (§8.1):
 * deterministic in the case id (sha256-derived, GUID-shaped) so validation
 * RECOMPUTES it instead of trusting a stored copy — a scenario that lost its
 * canary fails validation loudly. Quoting this string anywhere (learned
 * index, prompt, trajectory) is proof of golden-case contamination.
 */
export function makeCanary(caseId: string): string {
	const hex = createHash("sha256").update(`super-dev-eval-canary:${caseId}`).digest("hex");
	const guid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
	return `canary-guid:${guid}`;
}

// ─── Golden case schema (DEC-6, seven fields + optional caseSet) ───────────

/** The parsed three-arm target grammar (DEC-6 + F1): compound
 *  "stage|agent" (both halves validated against the closed sets), stage-only
 *  (a pipeline stage id), or agent-only (a registered agent name — e.g.
 *  `target: "judge"`, the natural home for judge-verdict cases). */
export interface GoldenCaseTarget {
	/** The wire form, verbatim. */
	raw: string;
	arm: "compound" | "stage" | "agent";
	/** Present for the compound and stage arms. */
	stage?: string;
	/** Present for the compound and agent arms. */
	agent?: string;
}

/** A parsed, validated golden case. `target` keeps the wire form in `raw`
 *  for reporting; the halves are pre-checked against the closed sets. */
export interface GoldenCase {
	id: string;
	title: string;
	/** In-repo postmortem/dossier anchor (repo-relative path that exists) —
	 *  the DEC-5 rebuild mitigation: cases are user-local and lost on
	 *  reinstall; this field points at the durable in-repo archive. */
	source: string;
	/** Three-arm target (see GoldenCaseTarget) — validated against
	 *  TARGET_STAGES × TARGET_AGENTS. */
	target: GoldenCaseTarget;
	/** The scenario text; MUST contain the literal makeCanary(id) canary. */
	scenario: string;
	expected: { verdict: string; mustHold?: string[]; mustNot?: string[] };
	/** Revision stamp (≥1): a revised case is a NEW row, never silently mixed
	 *  with old rows — the band key carries it (M2 fold). */
	caseVersion: number;
	/** OPTIONAL suite stamp (F10): the caseSet axis of the band key. Absent →
	 *  derived from the target's layer identity (caseSetOf). */
	caseSet?: string;
}

/** Validation outcome: ok=false carries every reason (loud, per field).
 *  ok=true may still carry `reasons` — non-fatal loud notes (e.g. skipped
 *  label entries inside an otherwise-valid gate-labels file). */
export type Validation<T> = { ok: true; value: T; reasons: string[] } | { ok: false; reasons: string[] };

/** This module's own location anchor → the extension repo root (the same
 *  derivation as post-mortem.ts defaultInboxDir / predictions.ts
 *  defaultFindingsDir). `source` paths resolve against it. */
export function repoRoot(): string {
	const here = fileURLToPath(new URL(".", import.meta.url)); // …/src/evolution/
	return resolve(here, "..", "..");
}

function nonEmptyString(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Array-of-non-empty-strings guard; pushes one reason and returns null on
 *  any malformed entry (the whole field is rejected — partial acceptance
 *  would let a typo'd assertion silently vanish). */
function stringArray(v: unknown, field: string, reasons: string[]): string[] | null {
	if (!Array.isArray(v)) {
		reasons.push(`${field}: must be an array of strings`);
		return null;
	}
	if (!v.every((item) => typeof item === "string" && item.trim() !== "")) {
		reasons.push(`${field}: every entry must be a non-empty string`);
		return null;
	}
	return v as string[];
}

function validateSourcePath(source: string, root: string, reasons: string[]): void {
	if (isAbsolute(source)) {
		reasons.push(`source: must be a repo-relative path (absolute paths are not portable across machines): ${source}`);
		return;
	}
	const resolved = resolve(root, source);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		reasons.push(`source: resolves outside the repo root (${root}): ${source}`);
		return;
	}
	// F8: existsSync alone admits directories and symlink escapes — stat the
	// path (follows symlinks) for regular-file-ness, then re-check containment
	// on the REAL paths (a symlink inside the repo pointing outside must not
	// pass the string-level check). Every failure is a loud reason, never a
	// throw.
	try {
		if (!statSync(resolved).isFile()) {
			reasons.push(`source: not a regular file: ${source} (postmortem/dossier anchors are files — a directory does not anchor a case)`);
			return;
		}
	} catch {
		reasons.push(`source: no such in-repo file: ${source} (postmortem/dossier archives are the DEC-5 rebuild anchor — a missing anchor is a broken case)`);
		return;
	}
	try {
		const realRoot = realpathSync(root);
		const realRel = relative(realRoot, realpathSync(resolved));
		if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
			reasons.push(`source: symlink target resolves outside the repo root (${root}): ${source}`);
		}
	} catch (error) {
		reasons.push(`source: could not resolve the real path of ${source} (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * Validate one golden case (DEC-6). Defensive over `unknown` (it just came
 * from a JSON file): every field checked, every failure a named reason.
 * `repoRoot` is injectable for tests; `expectedId` (the file basename) enforces
 * the F7 addressing rule — the id IS the address.
 */
export function validateGoldenCase(raw: unknown, options: { repoRoot?: string; expectedId?: string } = {}): Validation<GoldenCase> {
	const reasons: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reasons: ["case: must be a JSON object"] };
	}
	const obj = raw as Record<string, unknown>;

	const id = nonEmptyString(obj.id);
	if (id === null) reasons.push("id: must be a non-empty string");
	else if (options.expectedId !== undefined && id !== options.expectedId) {
		reasons.push(`id: "${id}" does not match the file name "${options.expectedId}" — rename the file or fix the field (the id IS the address; one case per file is structural)`);
	}
	const title = nonEmptyString(obj.title);
	if (title === null) reasons.push("title: must be a non-empty string");
	const source = nonEmptyString(obj.source);
	if (source === null) reasons.push("source: must be a non-empty string (repo-relative postmortem/dossier path)");
	else validateSourcePath(source, options.repoRoot ?? repoRoot(), reasons);

	// target: the three-arm grammar (F1) — compound "stage|agent" (both halves
	// from the closed sets), stage-only, or agent-only.
	const targetRaw = obj.target;
	let targetArms: GoldenCaseTarget | null = null;
	const reasonsBeforeTarget = reasons.length;
	if (typeof targetRaw !== "string") {
		reasons.push(`target: must be a string — "stage${TARGET_SEPARATOR}agent" (compound), a pipeline stage id, or a registered agent name`);
	} else {
		const parts = targetRaw.split(TARGET_SEPARATOR);
		if (parts.length > 2) {
			reasons.push(`target: expected "stage${TARGET_SEPARATOR}agent" (compound), a stage id, or an agent name — at most one "${TARGET_SEPARATOR}" separator, got: ${targetRaw}`);
		} else if (parts.length === 2) {
			const [stagePart, agentPart] = parts;
			if (stagePart.trim() === "" || agentPart.trim() === "") {
				reasons.push(`target: compound form "stage${TARGET_SEPARATOR}agent" needs both halves non-empty, got: ${targetRaw}`);
			} else {
				if (!TARGET_STAGES.includes(stagePart)) reasons.push(`target.stage: "${stagePart}" is not a pipeline stage id (closed set: src/graph/edges.ts STAGE_IDS)`);
				if (!TARGET_AGENTS.includes(agentPart)) reasons.push(`target.agent: "${agentPart}" is not a registered agent (closed set: src/agents/register-agents.ts REGISTERED_AGENTS)`);
				targetArms = { raw: targetRaw, arm: "compound", stage: stagePart, agent: agentPart };
			}
		} else {
			const single = parts[0];
			if (typeof single === "string" && TARGET_STAGES.includes(single)) targetArms = { raw: targetRaw, arm: "stage", stage: single };
			else if (typeof single === "string" && TARGET_AGENTS.includes(single)) targetArms = { raw: targetRaw, arm: "agent", agent: single };
			else reasons.push(`target: "${String(single)}" is neither a pipeline stage id (src/graph/edges.ts STAGE_IDS) nor a registered agent (src/agents/register-agents.ts REGISTERED_AGENTS) — single-form targets must name one or the other`);
		}
	}
	const targetClean = targetArms !== null && reasons.length === reasonsBeforeTarget;

	// scenario: non-empty + the §8.1 canary recomputed from the id.
	const scenario = nonEmptyString(obj.scenario);
	if (scenario === null) {
		reasons.push("scenario: must be a non-empty string");
	} else if (id !== null && !scenario.includes(makeCanary(id))) {
		reasons.push(`scenario: missing the embedded literal canary ${makeCanary(id)} (makeCanary(id) — the §8.1 contamination tripwire; keep it verbatim in the scenario text)`);
	}

	// expected: verdict ∈ closure; mustHold/mustNot optional string lists.
	let verdict = "";
	const expectedRaw = obj.expected;
	if (typeof expectedRaw !== "object" || expectedRaw === null || Array.isArray(expectedRaw)) {
		reasons.push("expected: must be an object");
	} else {
		const expected = expectedRaw as Record<string, unknown>;
		verdict = nonEmptyString(expected.verdict) ?? "";
		if (verdict === "") {
			reasons.push("expected.verdict: must be a non-empty string");
		} else if (!VERDICT_CLOSURE.includes(verdict)) {
			reasons.push(`expected.verdict: "${verdict}" is not an existing verdict enum value (DEC-6 closure admits only: ${VERDICT_CLOSURE.join(", ")})`);
		} else if (targetArms !== null && targetClean) {
			// F6 conservative mapping: a mapped target admits only its families'
			// vocabularies (compound arms UNION — legal if it fits either arm);
			// unmapped targets fail-open to the full closure.
			const allowed = allowedVerdictsForTarget(targetArms);
			if (!allowed.includes(verdict)) {
				const families = targetVerdictFamilies(targetArms).join(" + ");
				reasons.push(`expected.verdict: "${verdict}" is not admitted by target "${targetArms.raw}" — the F6 conservative mapping resolves this target to the ${families} family(ies), which admit: ${allowed.join(", ")} (unmapped targets admit the full DEC-6 closure)`);
			}
		}
		if (expected.mustHold !== undefined) stringArray(expected.mustHold, "expected.mustHold", reasons);
		if (expected.mustNot !== undefined) stringArray(expected.mustNot, "expected.mustNot", reasons);
	}

	// caseVersion: positive integer.
	const caseVersion = obj.caseVersion;
	if (typeof caseVersion !== "number" || !Number.isInteger(caseVersion) || caseVersion < 1) {
		reasons.push(`caseVersion: must be an integer ≥ 1 (revision is first-class — the M2 band key carries it), got: ${JSON.stringify(caseVersion)}`);
	}

	// caseSet: optional suite stamp (F10); non-empty when present, and never
	// containing the band-key separator (it feeds bandKey verbatim).
	let caseSet: string | undefined;
	if (obj.caseSet !== undefined) {
		const cs = nonEmptyString(obj.caseSet);
		if (cs === null) reasons.push("caseSet: must be a non-empty string when present (the P2 suite stamp)");
		else if (cs.includes(BAND_KEY_SEP)) reasons.push(`caseSet: must not contain "${BAND_KEY_SEP}" — it feeds the band key verbatim and a separator inside would corrupt the key`);
		else caseSet = cs;
	}

	if (reasons.length > 0 || id === null || title === null || source === null || scenario === null || verdict === "" || targetArms === null) {
		return { ok: false, reasons };
	}
	const expected = (typeof expectedRaw === "object" && expectedRaw !== null && !Array.isArray(expectedRaw) ? expectedRaw : {}) as Record<string, unknown>;
	return {
		ok: true,
		value: {
			id,
			title,
			source,
			target: targetArms,
			scenario,
			expected: {
				verdict,
				...(Array.isArray(expected.mustHold) ? { mustHold: expected.mustHold as string[] } : {}),
				...(Array.isArray(expected.mustNot) ? { mustNot: expected.mustNot as string[] } : {}),
			},
			caseVersion: caseVersion as number,
			...(caseSet !== undefined ? { caseSet } : {}),
		},
		reasons: [],
	};
}

// ─── Golden case loader (DEC-5: user-local, loud skip, cold-start empty) ────

export interface SkippedFile {
	file: string;
	reasons: string[];
}

export interface LoadedGoldenCases {
	cases: GoldenCase[];
	skipped: SkippedFile[];
}

/** Default dataset home: ~/.super-dev/evals/cases/ (DEC-5 — user-local, never
 *  in-repo; same neighborhood as learned-index). */
export function defaultCasesDir(): string {
	return join(getSuperDevDir(), "evals", "cases");
}

/** Load every valid *.json case (one case per file). Missing dir = empty
 *  dataset (cold start, no error). Invalid files are skipped LOUDLY — reasons
 *  ride the returned `skipped` list AND the default warn sink (console) so a
 *  bad load can never be silent even if the caller ignores the return. F7:
 *  the case id must equal the file basename — one case per file is STRUCTURAL,
 *  so duplicate ids cannot occur (the addressing rule makes them impossible). */
export function loadGoldenCases(dir: string = defaultCasesDir(), opts: { log?: (line: string) => void; repoRoot?: string } = {}): LoadedGoldenCases {
	const warn = opts.log ?? ((line: string) => console.warn(`[super-dev] ${line}`));
	const out: LoadedGoldenCases = { cases: [], skipped: [] };
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return out; // cold start (or unreadable dir): empty dataset, never an error
	}
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch (error) {
			const reasons = [`unparseable JSON: ${error instanceof Error ? error.message : String(error)}`];
			out.skipped.push({ file, reasons });
			warn(`eval cases: skipped ${file}: ${reasons.join("; ")}`);
			continue;
		}
		const validated = validateGoldenCase(raw, { repoRoot: opts.repoRoot, expectedId: file.replace(/\.json$/, "") });
		if (!validated.ok) {
			out.skipped.push({ file, reasons: validated.reasons });
			warn(`eval cases: skipped ${file}: ${validated.reasons.join("; ")}`);
			continue;
		}
		out.cases.push(validated.value);
	}
	return out;
}

// ─── Rubric artifacts (D2 / DEC-7 / §8.2) ───────────────────────────────────

/** The ONE rubric scale (DEC-7/DEC-8): assertion-level boolean pass/fail +
 *  a 0..1 confidence per assertion. The confidence is a RANKING-ONLY signal
 *  (§8.2 — LLMs over-report confidence on low-knowledge instances); it is
 *  never a probability, never averaged into a score, and clustering uses
 *  CALIBRATED values (the gate's reliability mapping below). */
export const RUBRIC_SCALE = "assertion-boolean-confidence" as const;
export type RubricScale = typeof RUBRIC_SCALE;

export interface RubricDimension {
	name: string;
	/** Judgment guidance for the scorer — what this dimension measures and
	 *  how to decide the boolean. */
	guidance: string;
	/** Assertions that must hold; each scores boolean pass/fail. */
	mustHold: string[];
	/** Assertions that must NOT hold (violation conditions). Optional on the
	 *  wire (F2); the parsed form normalizes absent to []. */
	mustNot: string[];
}

export interface Rubric {
	rubricId: string;
	/** Free-form string version (rubricVersion); stamps every dataset row and
	 *  keys the σ-band baseline — a wording change is a NEW version with a
	 *  FRESH band history (DEC-7: never pollute drift history). */
	version: string;
	dimensions: RubricDimension[];
	scale: RubricScale;
}

export function validateRubric(raw: unknown, options: { expectedRubricId?: string } = {}): Validation<Rubric> {
	const reasons: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reasons: ["rubric: must be a JSON object"] };
	}
	const obj = raw as Record<string, unknown>;
	const rubricId = nonEmptyString(obj.rubricId);
	if (rubricId === null) reasons.push("rubricId: must be a non-empty string");
	else if (options.expectedRubricId !== undefined && rubricId !== options.expectedRubricId) {
		reasons.push(`rubricId: "${rubricId}" does not match the file name "${options.expectedRubricId}" — rename the file or fix the field (one rubric per file is structural)`);
	}
	const version = nonEmptyString(obj.version);
	if (version === null) reasons.push("version: must be a non-empty string (rubricVersion stamps every dataset row and keys the band baseline)");

	const dimsRaw = obj.dimensions;
	if (!Array.isArray(dimsRaw) || dimsRaw.length === 0) {
		reasons.push("dimensions: must be a non-empty array (a rubric with no dimensions scores nothing)");
	} else {
		dimsRaw.forEach((d, i) => {
			const label = `dimensions[${i}]`;
			if (typeof d !== "object" || d === null || Array.isArray(d)) {
				reasons.push(`${label}: must be an object`);
				return;
			}
			const dim = d as Record<string, unknown>;
			const name = nonEmptyString(dim.name);
			if (name === null) reasons.push(`${label}.name: must be a non-empty string`);
			const guidance = nonEmptyString(dim.guidance);
			if (guidance === null) reasons.push(`${label}.guidance: must be a non-empty string (the judgment instruction — an empty one cannot be scored reproducibly)`);
			const mustHold = stringArray(dim.mustHold, `${label}.mustHold`, reasons);
			if (mustHold !== null && mustHold.length === 0) reasons.push(`${label}.mustHold: at least one assertion required (a dimension with zero assertions is decorative)`);
			if (dim.mustNot !== undefined) stringArray(dim.mustNot, `${label}.mustNot`, reasons);
		});
	}

	if (obj.scale !== RUBRIC_SCALE) {
		reasons.push(`scale: must be exactly "${RUBRIC_SCALE}" (DEC-7/DEC-8: the one format all eval faces share), got: ${JSON.stringify(obj.scale)}`);
	}

	if (reasons.length > 0 || rubricId === null || version === null || !Array.isArray(dimsRaw) || dimsRaw.length === 0) {
		return { ok: false, reasons };
	}
	const dimensions: RubricDimension[] = [];
	for (const d of dimsRaw) {
		const dim = d as Record<string, unknown>;
		dimensions.push({
			name: dim.name as string,
			guidance: dim.guidance as string,
			mustHold: dim.mustHold as string[],
			mustNot: (dim.mustNot ?? []) as string[],
		});
	}
	return { ok: true, value: { rubricId, version, dimensions, scale: RUBRIC_SCALE }, reasons: [] };
}

export interface LoadedRubrics {
	rubrics: Rubric[];
	skipped: SkippedFile[];
}

export function defaultRubricsDir(): string {
	return join(getSuperDevDir(), "evals", "rubrics");
}

export function loadRubrics(dir: string = defaultRubricsDir(), opts: { log?: (line: string) => void } = {}): LoadedRubrics {
	const warn = opts.log ?? ((line: string) => console.warn(`[super-dev] ${line}`));
	const out: LoadedRubrics = { rubrics: [], skipped: [] };
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
			warn(`eval rubrics: skipped ${file}: ${reasons.join("; ")}`);
			continue;
		}
		const validated = validateRubric(raw, { expectedRubricId: file.replace(/\.json$/, "") });
		if (!validated.ok) {
			out.skipped.push({ file, reasons: validated.reasons });
			warn(`eval rubrics: skipped ${file}: ${validated.reasons.join("; ")}`);
			continue;
		}
		out.rubrics.push(validated.value);
	}
	return out;
}

// ─── Seed scaffolding (DEC-7: handwritten seeds — skeletons only) ───────────

/**
 * Write a validator-passing golden-case SKELETON to `<dir>/<id>.json` (canary
 * pre-embedded via makeCanary(id)). Zero content auto-generation — every
 * TODO(maintainer) marker is the maintainer's to fill by hand (DEC-7 种子期
 * 手写). Throws on programmer error (bad id, existing file — never clobber
 * handwritten work, or a skeleton that fails its own validation).
 */
export function writeGoldenCaseTemplate(dir: string, id: string, options: { repoRoot?: string } = {}): string {
	if (typeof id !== "string" || !id.trim() || id.includes("/") || id.includes("\\")) {
		throw new Error(`writeGoldenCaseTemplate: id must be a non-empty string without path separators, got: ${JSON.stringify(id)}`);
	}
	const wire = {
		id,
		title: "TODO(maintainer): case title",
		// The spec itself is a real in-repo anchor; the maintainer re-points it
		// at the postmortem/dossier the case is seeded from.
		source: "docs/requirements/sdlc-tips-adoption.md",
		target: `prototype${TARGET_SEPARATOR}prototype-runner`,
		scenario: [
			"TODO(maintainer): describe the labelled scenario — the historical situation this case replays (seeded from the postmortem/dossier named in \"source\").",
			"",
			makeCanary(id),
		].join("\n"),
		expected: {
			// Skeleton verdict drawn from the imported closure, not a literal.
			verdict: PROTOTYPE_VERDICT_VALUES[0],
			mustHold: ["TODO(maintainer): an assertion that must hold (scored by the rubric's boolean scale)"],
			mustNot: [],
		},
		caseVersion: 1,
	};
	const check = validateGoldenCase(wire, { repoRoot: options.repoRoot });
	if (!check.ok) throw new Error(`writeGoldenCaseTemplate: skeleton failed its own validation (${check.reasons.join("; ")}) — template/validator drift`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.json`);
	if (existsSync(path)) throw new Error(`writeGoldenCaseTemplate: refusing to overwrite existing ${path} (never clobber handwritten work)`);
	try {
		// F9: "wx" is the atomic backstop for the check-then-write race.
		writeFileSync(path, JSON.stringify(wire, null, "\t") + "\n", { encoding: "utf8", flag: "wx" });
	} catch (error) {
		throw new Error(`writeGoldenCaseTemplate: refusing to overwrite existing ${path} (never clobber handwritten work; atomic wx backstop: ${error instanceof Error ? error.message : String(error)})`);
	}
	return path;
}

/** Write a validator-passing rubric SKELETON to `<dir>/<rubricId>.json`.
 *  Same doctrine as writeGoldenCaseTemplate: shape only, all content
 *  TODO(maintainer). */
export function writeRubricTemplate(dir: string, rubricId: string): string {
	if (typeof rubricId !== "string" || !rubricId.trim() || rubricId.includes("/") || rubricId.includes("\\")) {
		throw new Error(`writeRubricTemplate: rubricId must be a non-empty string without path separators, got: ${JSON.stringify(rubricId)}`);
	}
	const wire: Rubric = {
		rubricId,
		version: "0.1.0",
		dimensions: [{
			name: "TODO(maintainer): dimension name",
			guidance: "TODO(maintainer): judgment guidance — what this dimension measures and how the boolean is decided",
			mustHold: ["TODO(maintainer): an assertion that must hold"],
			mustNot: [],
		}],
		scale: RUBRIC_SCALE,
	};
	const check = validateRubric(wire);
	if (!check.ok) throw new Error(`writeRubricTemplate: skeleton failed its own validation (${check.reasons.join("; ")}) — template/validator drift`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${rubricId}.json`);
	if (existsSync(path)) throw new Error(`writeRubricTemplate: refusing to overwrite existing ${path} (never clobber handwritten work)`);
	try {
		// F9: "wx" is the atomic backstop for the check-then-write race.
		writeFileSync(path, JSON.stringify(wire, null, "\t") + "\n", { encoding: "utf8", flag: "wx" });
	} catch (error) {
		throw new Error(`writeRubricTemplate: refusing to overwrite existing ${path} (never clobber handwritten work; atomic wx backstop: ${error instanceof Error ? error.message : String(error)})`);
	}
	return path;
}

// ─── Band key (M2 / §8.3 fold — P1 ships the KEY SHAPE only) ────────────────

const BAND_KEY_SEP = "::";

/**
 * The σ-band baseline key triple (M2 fold): (caseSet, caseVersion,
 * rubricVersion). Case revision and rubric re-wording each re-key the band —
 * old and new rows never silently mix. The proposalVersion axis (§8.3 —
 * proposal/model-pin changes re-key too) lands with the D4 flywheel (P3) as a
 * NAMED amendment to this shape; P1 pins the triple. Pure string concat;
 * throws on malformed input (programmer-facing — a silently malformed band
 * key corrupts drift history).
 */
export function bandKey(caseSet: string, caseVersion: number, rubricVersion: string): string {
	if (typeof caseSet !== "string" || caseSet.trim() === "" || caseSet.includes(BAND_KEY_SEP)) {
		throw new Error(`bandKey: caseSet must be a non-empty string without "${BAND_KEY_SEP}", got: ${JSON.stringify(caseSet)}`);
	}
	if (typeof caseVersion !== "number" || !Number.isInteger(caseVersion) || caseVersion < 1) {
		throw new Error(`bandKey: caseVersion must be an integer ≥ 1, got: ${JSON.stringify(caseVersion)}`);
	}
	if (typeof rubricVersion !== "string" || rubricVersion.trim() === "" || rubricVersion.includes(BAND_KEY_SEP)) {
		throw new Error(`bandKey: rubricVersion must be a non-empty string without "${BAND_KEY_SEP}", got: ${JSON.stringify(rubricVersion)}`);
	}
	return [caseSet, `case-v${caseVersion}`, `rubric-v${rubricVersion}`].join(BAND_KEY_SEP);
}

/**
 * The case's suite identity (F10): the explicit caseSet stamp when present,
 * else DERIVED from the target's layer identity — the stage arm when present,
 * else the agent arm (DEC-6 按层过滤: suites filter by layer). `fallback`
 * covers degenerate hand-built targets with no arms at all. bandKey itself
 * stays a pure 3-arg function; this is the seam that feeds it.
 */
export function caseSetOf(c: GoldenCase, fallback = "default"): string {
	if (c.caseSet !== undefined && c.caseSet !== "") return c.caseSet;
	if (c.target.stage !== undefined) return c.target.stage;
	if (c.target.agent !== undefined) return c.target.agent;
	return fallback;
}

// ─── Validation gate (D7 / DEC-13① / L2 / L3) — P1 machinery ────────────────

/** The P2 scorer-row shape (DEC-2/DEC-9): what the scorers will emit per
 *  golden case. Confidence is RANKING-ONLY (§8.2) — see RUBRIC_SCALE. */
export interface ScorerVerdictRow {
	caseId: string;
	caseVersion: number;
	verdict: string;
	confidence: number;
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
	return join(getSuperDevDir(), "evals", "labels");
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
	const seenScorerKeys = new Set<string>();
	let unmatchedScorerRows = 0;
	let unmatchedLabels = 0;
	let malformedScorerRows = 0;
	let duplicateScorerRows = 0;

	for (const row of scorerVerdicts) {
		if (typeof row?.caseId !== "string" || row.caseId.trim() === "" || typeof row.caseVersion !== "number" || !Number.isInteger(row.caseVersion) || row.caseVersion < 1 || typeof row.verdict !== "string") {
			malformedScorerRows += 1;
			continue;
		}
		const key = `${row.caseId}\u0000${String(row.caseVersion)}`;
		// F3: ONE scored row per (caseId, caseVersion) — the first occurrence
		// fixes the disposition; later same-key rows are duplicates (honest
		// count, never a second pair).
		if (seenScorerKeys.has(key)) {
			duplicateScorerRows += 1;
			continue;
		}
		seenScorerKeys.add(key);
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
