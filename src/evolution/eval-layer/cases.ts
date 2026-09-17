import { VERDICT_CLOSURE, TARGET_STAGES, TARGET_AGENTS, TARGET_SEPARATOR, allowedVerdictsForTarget, targetVerdictFamilies } from "./closure.ts";
import { BAND_KEY_SEP } from "./bands.ts";
/**
 * eval-layer — golden-case schema, validation, loader, and the shared string guards. Layer doc: ./closure.ts.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve } from "node:path";
import { casesDir, makeCanary } from "../eval-shared.ts";

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
	const here = fileURLToPath(new URL(".", import.meta.url)); // …/src/evolution/eval-layer/
	return resolve(here, "..", "..", ".."); // v0.4.20: the split moved this module one level deeper (src/evolution/eval-layer/)
}

export function nonEmptyString(v: unknown): string | null {
	return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Array-of-non-empty-strings guard; pushes one reason and returns null on
 *  any malformed entry (the whole field is rejected — partial acceptance
 *  would let a typo'd assertion silently vanish). */
export function stringArray(v: unknown, field: string, reasons: string[]): string[] | null {
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
 *  in-repo; same neighborhood as learned-index). The layout lives once in
 *  eval-shared.ts (P6 single spelling). */
export function defaultCasesDir(): string {
	return casesDir();
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
