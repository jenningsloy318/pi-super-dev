import { nonEmptyString, stringArray, validateGoldenCase, type Validation, type SkippedFile } from "./cases.ts";
import { TARGET_SEPARATOR } from "./closure.ts";
/**
 * eval-layer — rubric schema, validation, loader, and the seed-scaffolding template writers. Layer doc: ./closure.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCanary, rubricsDir } from "../eval-shared.ts";
import { PROTOTYPE_VERDICT_VALUES } from "../../stages/prototype.ts";

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
	/** P2 / D3 (DEC-9): OPTIONAL band-position → verdict mapping for the
	 *  deterministic trajectory scorer. Keys are the sigma-bands BandPosition
	 *  values EXCEPT "no-band" (insufficient history is never a score); values
	 *  must be verdicts admitted by the SCORED TARGET's family (validated at
	 *  scoring time via allowedVerdictsForTarget — the rubric itself is
	 *  target-agnostic). Absent bandMap ⇒ the documented conservative default
	 *  mapping (evolution/eval-stage.ts DEFAULT band rule). */
	bandMap?: RubricDimensionBandMap;
}

/** The four banded positions a rubric bandMap may map (the σ-band tiers plus
 *  in-band; "no-band" is deliberately NOT mappable — it is an honesty skip,
 *  not a score). Key spelling matches BandPosition verbatim (P6). */
export interface RubricDimensionBandMap {
	"in-band"?: string;
	"1σ"?: string;
	"2σ"?: string;
	"3σ"?: string;
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

const BAND_MAP_KEYS = ["in-band", "1σ", "2σ", "3σ"] as const;

/** Validate one dimension's optional bandMap (shape only — target admission
 *  is a scoring-time check; the rubric file has no target context). At least
 *  one entry; every key one of the four banded positions; every value a
 *  non-empty string. */
function validateBandMap(raw: unknown, label: string, reasons: string[]): Record<string, string> | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		reasons.push(`${label}.bandMap: must be an object mapping band positions ("in-band"/"1σ"/"2σ"/"3σ") to verdict strings`);
		return null;
	}
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0) {
		reasons.push(`${label}.bandMap: at least one entry required (an empty mapping is decorative — omit the field instead)`);
		return null;
	}
	const out: Record<string, string> = {};
	let ok = true;
	for (const [key, value] of entries) {
		if (!(BAND_MAP_KEYS as readonly string[]).includes(key)) {
			reasons.push(`${label}.bandMap: key "${key}" is not a band position (allowed: ${BAND_MAP_KEYS.join(", ")}; "no-band" is never mappable — insufficient history is a skip, not a score)`);
			ok = false;
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") {
			reasons.push(`${label}.bandMap["${key}"]: must be a non-empty verdict string`);
			ok = false;
			continue;
		}
		out[key] = value;
	}
	return ok ? out : null;
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
			if (dim.bandMap !== undefined) validateBandMap(dim.bandMap, label, reasons);
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
		// bandMap was already validated in the loop above; parse only runs when
		// reasons.length === 0, so a present bandMap is a validated shape.
		const bandMap = (dim.bandMap !== undefined && typeof dim.bandMap === "object" && dim.bandMap !== null && !Array.isArray(dim.bandMap)) ? dim.bandMap as RubricDimensionBandMap : undefined;
		dimensions.push({
			name: dim.name as string,
			guidance: dim.guidance as string,
			mustHold: dim.mustHold as string[],
			mustNot: (dim.mustNot ?? []) as string[],
			...(bandMap !== undefined ? { bandMap } : {}),
		});
	}
	return { ok: true, value: { rubricId, version, dimensions, scale: RUBRIC_SCALE }, reasons: [] };
}

export interface LoadedRubrics {
	rubrics: Rubric[];
	skipped: SkippedFile[];
}

export function defaultRubricsDir(): string {
	return rubricsDir();
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
		source: "docs/requirements/055-sdlc-tips-adoption.md",
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
