/**
 * The render pipeline: typed data → schema validation → computed-field
 * augmentation → template render → gate-compliant markdown.
 *
 * This is the deterministic layer that frees the agent from format concerns.
 * The agent produces CONTENT (structured data conforming to a TypeBox schema);
 * renderStage validates it, augments computed fields, and renders it through a
 * Jinja-subset template. The result is consistently formatted every time.
 */

import { render } from "./template-engine.ts";
import { STAGE_MODELS, type StageModel } from "./schemas.ts";
import { Value } from "typebox/value";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localTimestamp } from "./time.ts";
import { fileURLToPath } from "node:url";
import { specDoc, specDocs } from "../prompts.ts";
import type { SetupControl } from "../types.ts";
import { appendToKnowledge } from "./knowledge.ts";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");
const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
	const cached = templateCache.get(name);
	if (cached !== undefined) return cached;
	const body = readFileSync(join(TEMPLATES_DIR, name), "utf8");
	templateCache.set(name, body);
	return body;
}

export interface RenderResult {
	markdown: string;
	errors: string[];
}

/** Validate data against a TypeBox schema. Returns error strings (empty = valid).
 *
 *  Extra/unknown keys are TOLERATED: some stage schemas carry
 *  `additionalProperties: false` so they are STRICT-CAPABLE for the
 *  structured_output tool's constrained sampling (Feature 2) — that flag is
 *  NOT a render-validator directive. The templates render only the declared
 *  keys, so an extra key the model emitted is harmless to the doc; rejecting it
 *  here would fail a render (and its gate) on a harmless property. Required-key
 *  and type errors are still reported as before. */
/** Format a typebox@1.x error location for humans AND retry feedback:
 * "#/properties/alternativesConsidered/items/properties/alternatives" →
 * "alternativesConsidered[].alternatives". typebox@1.x errors carry schemaPath
 * (NOT `path`), so the old `${e.path ?? "$"}` rendered EVERY location as "$" —
 * runs 2026-08-30T00-10-34-032Z (aborted after 6 design rounds + judge
 * escalation) and 2026-08-30T03-23-40-576Z logged only "$: must be array" ×7,
 * hiding the offending field from the retrying agent, the feedback block, and
 * the judge (which mis-diagnosed `hasNumericConstants`). The location IS the
 * actionable part of a schema error; never drop it again. */
function schemaLocationWithItems(schemaPath: string | undefined): string {
	if (!schemaPath || schemaPath === "#" || schemaPath === "") return "";
	const segs = schemaPath.replace(/^#/, "").split("/").filter(Boolean);
	let out = "";
	for (const seg of segs) {
		if (seg === "properties" || seg === "patternProperties") continue;
		if (seg === "items") out += "[]"; // array element — dot comes with the next name
		else out += (out ? "." : "") + seg;
	}
	return out;
}

/** Format one error as "location: message" (or bare message at the schema root,
 * e.g. "must have required properties …"). */
function formatError(err: unknown): string | null {
	const e = err as unknown as { message?: string; schemaPath?: string; path?: string };
	if (typeof e?.message !== "string") return null;
	if (e.message === "must not have additional properties") return null; // tolerated (see validateData)
	const loc = schemaLocationWithItems(e.schemaPath) || e.path || "";
	return loc ? `${loc}: ${e.message}` : e.message;
}

/** v0.3.54: a missing-required-properties error used to name only the PARENT
 *  ("$: must have required properties"), even when the model emitted a NEAR
 *  MISS ("docs" vs "docPath") — the retry prompt then said nothing actionable
 *  and the model re-guessed. Enhance: when a property of the errored object is
 *  within edit distance 1 of a required key (case/spacing/typo class), name
 *  it. Kept conservative: only single-insert/delete/substitute (Levenshtein ≤1),
 *  and only when the near-miss key is NOT already a declared key. */
function nearMissHint(err: { message?: string; schemaPath?: string }, data: unknown): string {
	const message = err.message ?? "";
	if (!message.includes("required propert")) return "";
	// typebox@1.1.38 message shape (ground-truthed): `must have required
	// properties docPath, summary` — names are UNQUOTED, comma-separated.
	const reqList = message.match(/required propert(?:y|ies) (.+)$/);
	const required = reqList ? reqList[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
	// v0.3.54 review fix (adv F4): scan the ERRORED object(s), not the root —
	// a nested "findings[]: must have required properties evidence" used to
	// scan the root's keys and the hint never fired for its motivating class.
	for (const obj of resolveErrorObjects(data, err.schemaPath)) {
		const present = Object.keys(obj);
		for (const req of required) {
			for (const key of present) {
				if (key === req) continue;
				if (levenshteinAtMostOne(req, key)) return ` (near miss: the object has "${key}" — did you mean "${req}"?)`;
			}
		}
	}
	return "";
}

/** Resolve the errored object(s) from the root control along the typebox
 *  schemaPath: `properties` descends into the named key; `items` fans out
 *  over array elements (the failing instance index is unknown, so every
 *  object element is a candidate). Deeper segments after `items` describe the
 *  ELEMENT schema, not the instance, so resolution stops there. Root-level
 *  errors (schemaPath "#" / absent) scan the root control as before. */
function resolveErrorObjects(data: unknown, schemaPath: string | undefined): Record<string, unknown>[] {
	let cur: unknown = data;
	const targets: unknown[] = [];
	const segs = !schemaPath || schemaPath === "#" ? [] : schemaPath.replace(/^#/, "").split("/").filter(Boolean);
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		if (seg === "properties" || seg === "patternProperties") {
			const key = segs[++i];
			if (key === undefined) break;
			cur = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>)[key] : undefined;
			continue;
		}
		if (seg === "items") {
			if (Array.isArray(cur)) targets.push(...cur);
			break;
		}
	}
	if (!targets.length && cur && typeof cur === "object" && !Array.isArray(cur)) targets.push(cur);
	return targets.filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t));
}

function levenshteinAtMostOne(a: string, b: string): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > 1) return false;
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		if (++edits > 1) return false;
		if (a.length === b.length) {
			i++;
			j++;
		} else if (a.length > b.length) i++;
		else j++;
	}
	edits += (a.length - i) + (b.length - j);
	return edits <= 1;
}

export function validateData(schema: StageModel["schema"], data: unknown): string[] {
	const errors: string[] = [];
	for (const err of Value.Errors(schema, data)) {
		const line = formatError(err);
		if (line === null) continue;
		errors.push(line + nearMissHint(err, data));
	}
	return errors;
}

/** Prose-string tolerance for optional string-ARRAY control fields — the same
 *  drift class as the boolean fix below (hasNumericConstants/pass/unions):
 *  models reliably summarize `alternatives` and `evidence` as ONE prose string
 *  ("(a) exact-text equality — rejected: …; (b) …") instead of an array.
 *  Runs 2026-08-30T00-10-34-032Z (pi-omisis: 6/6 design rounds rejected, judge
 *  escalated, run aborted) and 2026-08-30T03-23-40-576Z (cosmic-clock: 8 design
 *  rounds) rejected COMPLETE controls solely on this; review docs
 *  (requirementsReview/bddReview rounds) were dropped the same way on
 *  `findings[].evidence` — verdict consumed, durable doc missing. Coerce
 *  string → [string] BEFORE validation: the doc renders, template loops
 *  iterate items instead of characters, and downstream consumers (convergence
 *  ledger, knowledge) see arrays. */
/**
 * v0.3.54 (P2/D-class): the prose-array map used to be a hand-maintained
 * per-stage table (7 entries) while the reverse coercion (coerceSchemaStrings)
 * is schema-driven — a new/renamed review stage silently missed coercion (the
 * exact asymmetry that let several drift classes reach production). The pairs
 * are now DERIVED from the stage schema: every top-level `array of objects`
 * whose item declares an EXACT `type:"string"` property (no union/anyOf) is a
 * prose-array slot, for every stage, forever. */
function proseArrayPairsFromSchema(schema: unknown): string[][] {
	const pairs: string[][] = [];
	// v0.3.56 F9c (class B — unenumerated schema shapes): the walk was 2 levels
	// deep (top-level array-of-objects → item slot), so nested slots —
	// features[].scenarios[].andClauses, phases[].deliverables.requireFiles —
	// were unreachable. Recurse through object properties and array-of-object
	// items to ANY depth (capped at 8 against pathological schemas), keeping the
	// exact-slot guards: no union (anyOf/oneOf), no enum at the leaf slot or its
	// string items — a prose wrap would fail those contracts.
	const walk = (node: unknown, path: string[], depth: number): void => {
		if (!node || typeof node !== "object" || depth > 8) return;
		const props = (node as { properties?: Record<string, unknown> }).properties;
		if (!props || typeof props !== "object") return;
		for (const [key, fieldSchema] of Object.entries(props)) {
			if (!fieldSchema || typeof fieldSchema !== "object") continue;
			const fs = fieldSchema as { type?: unknown; items?: unknown; anyOf?: unknown; oneOf?: unknown; enum?: unknown };
			if (fs.anyOf || fs.oneOf) continue;
			if (fs.type === "array" && fs.items && typeof fs.items === "object") {
				const items = fs.items as { type?: unknown; enum?: unknown };
				if (items.type === "string" && !items.enum) {
					pairs.push([...path, key]); // exact array-of-string leaf slot
				} else if (items.type === "object") {
					const itemProps = (fs.items as { properties?: unknown }).properties;
					if (itemProps && typeof itemProps === "object") walk(fs.items, [...path, key], depth + 1); // array-of-objects → recurse into item shape
				}
			} else if (fs.type === "object") {
				walk(fs, path, depth + 1); // nested object container → recurse in place
			}
		}
	};
	walk(schema, [], 0);
	return pairs;
}

/** Follow one schema path through the DATA (object properties; arrays fan out
 *  over their items) and wrap a string leaf into a 1-element array (empty →
 *  []). Mutates in place — the caller returns the SAME object. */
function wrapProseArrayAtPath(root: Record<string, unknown>, path: string[]): void {
	let nodes: unknown[] = [root];
	for (let seg = 0; seg < path.length; seg++) {
		const key = path[seg]!;
		const next: unknown[] = [];
		for (const node of nodes) {
			if (!node || typeof node !== "object" || Array.isArray(node)) continue;
			const value = (node as Record<string, unknown>)[key];
			if (seg === path.length - 1) {
				if (typeof value === "string") (node as Record<string, unknown>)[key] = value.trim() === "" ? [] : [value];
			} else if (Array.isArray(value)) {
				next.push(...value);
			} else if (value && typeof value === "object") {
				next.push(value);
			}
		}
		nodes = next;
	}
}

/** Mutate the control in place (the caller returns/stores the SAME object, so
 *  the normalized arrays flow downstream). Unknown shapes are left untouched —
 *  validation reports them with their exact location. */
export function normalizeProseArrays(stageId: string, data: unknown, schema?: unknown): unknown {
	if (!data || typeof data !== "object" || Array.isArray(data)) return data;
	const fields = schema ? proseArrayPairsFromSchema(schema) : [];
	if (fields.length === 0) return data;
	for (const path of fields) wrapProseArrayAtPath(data as Record<string, unknown>, path);
	return data;
}

/** Render a control value as prose for string-slot coercion: scalars
 *  as-is; arrays joined "; "; nested objects flattened recursively. Empty
 *  string means "nothing worth rendering" (caller drops the pair). */
function scalarToProse(v: unknown, depth = 0): string {
	if (typeof v === "string") return v;
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
	if (typeof v === "boolean") return String(v);
	if (Array.isArray(v)) {
		const items = v.map((x) => scalarToProse(x, depth + 1)).filter((s) => s !== "");
		return items.join("; ");
	}
	if (v && typeof v === "object" && depth < 4) {
		const nested = flattenObjectToProse(v as Record<string, unknown>, depth + 1);
		return nested || "";
	}
	return "";
}

/** Flatten an OBJECT emitted into a string slot to readable `key: value`
 *  prose lines (run 2026-08-30T05-26-19: debug-analyzer emitted rootCause as
 *  {verified, description, codeLocations, recommendedFix} and hypotheses[]
 *  items as {id, statement, probability, …} — rich CONTENT, wrong SHAPE;
 *  the template would render `[object Object]`). Nullish/empty values are
 *  dropped so the prose stays signal-only. */
function flattenObjectToProse(obj: Record<string, unknown>, depth = 0): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === null || v === undefined) continue;
		const s = scalarToProse(v, depth);
		if (s === "") continue;
		parts.push(`${k}: ${s}`);
	}
	return parts.join("\n");
}

/** Coerce ONE schema-declared string slot from the drift shapes models emit
 *  (numeric dates, boolean flags, paragraph ARRAYS, structured OBJECTS).
 *  Returns the original value when the shape is a real mismatch
 *  (null/undefined) so validation reports it WITH its exact location —
 *  never guess those away. */
function coerceStringSlot(schemaNode: unknown, value: unknown): unknown {
	const s = schemaNode as Record<string, unknown> | null;
	// EXACT string contract only — never a union (`anyOf`): a number/boolean
	// there already passes validation (phasesCompleted/allGreen precedent),
	// so coercion would REWRITE legal data instead of repairing failures.
	if (!s || typeof s !== "object" || s.type !== "string" || "anyOf" in s) return value;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : value;
	if (typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.length > 0) {
		return value.map((x) => scalarToProse(x)).filter((s2) => s2 !== "").join("\n"); // paragraph array → prose
	}
	if (value && typeof value === "object") {
		const prose = flattenObjectToProse(value as Record<string, unknown>);
		return prose !== "" ? prose : value;
	}
	return value;
}

/** null-inside-optional pruning (run 2026-08-30T04-53-26: assessment
 *  emitted services.api:null and services.ui.portEnv:null — the model saying
 *  "not applicable" where the schema expresses that as ABSENCE). Delete a
 *  null key when its position is optional (or the whole subtree is); if that
 *  leaves the parent missing a REQUIRED property, delete the parent too —
 *  cascade while the chain stays droppable. A null at a required TOP-LEVEL
 *  slot is left in place so validation reports it LOCATED. Returns false when
 *  `obj` no longer satisfies its own required set (caller may drop it). */
function pruneNulls(schemaNode: unknown, obj: Record<string, unknown>, inOptional: boolean): boolean {
	const s = schemaNode as Record<string, unknown> | null;
	if (!s || typeof s !== "object" || s.type !== "object" || !s.properties) return true;
	const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
	for (const key of Object.keys(s.properties as Record<string, unknown>)) {
		const v = obj[key];
		if (v === undefined) continue;
		if (v === null) {
			// Absent-able position → drop; required non-optional position → leave (located).
			if (inOptional || !required.has(key)) delete obj[key];
			continue;
		}
		if (v && typeof v === "object") {
			const child = (s.properties as Record<string, unknown>)[key];
			const childOptional = inOptional || !required.has(key);
			if (Array.isArray(v)) {
				// Array items cannot express absence individually — prune inside them
				// but never drop the array (an invalid item stays located).
				for (const item of v) if (item && typeof item === "object" && !Array.isArray(item)) pruneNulls(child && (child as Record<string, unknown>).items, item as Record<string, unknown>, childOptional);
			} else {
				const ok = pruneNulls(child, v as Record<string, unknown>, childOptional);
				if (!ok && childOptional) delete obj[key]; // child invalidated itself — droppable
				else if (!ok) return false; // required child now invalid — propagate
			}
		}
	}
	for (const r of required) if (!(r in obj)) return false;
	return true;
}

/** Reverse-direction drift repair, schema-driven: walk the stage schema and
 *  coerce values that FAIL a declared string contract (see coerceStringSlot).
 *  Counterpart of normalizeProseArrays (string→array); this one is array/
 *  number/boolean→string for EVERY stage, because the walk needs no per-stage
 *  field map — the schema already states the contract. Run
 *  2026-08-30T00-14-16-142Z (AnkiQuick): requirements round-1 burned a blind
 *  9-minute retry on "$: must be string" ×5 (pre-located-errors), and debug's
 *  doc was silently dropped on ×8 of the same class. Deep-walks nested
 *  objects/arrays (acceptanceCriteria[].id/statement, findings[].severity …)
 *  so numeric/paragraph drift inside containers repairs too. Safety: a value
 *  that would PASS validation is never rewritten (unions skipped, strings
 *  returned as-is), and empty arrays / objects / null stay untouched so the
 *  located error names the field for the retrying agent (null/undefined and
 *  empty objects stay untouched — there is nothing to render). */
/** Wrap a SINGLETON emitted into a declared array slot: one string or one
 *  plain object becomes [value] (run 2026-08-30T04-53-26: prototype-runner
 *  emitted measurements as one prose string). EXACT array contracts only —
 *  unions are skipped (legal values never rewritten), and anything that
 *  already validates (arrays, null, undefined) passes through untouched. */
function coerceArraySlot(schemaNode: unknown, value: unknown): unknown {
	const s = schemaNode as Record<string, unknown> | null;
	if (!s || typeof s !== "object" || s.type !== "array" || "anyOf" in s) return value;
	if (typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value))) return [value];
	return value;
}

/** Coerce ONE schema-declared boolean slot from boolean-WORD strings/numbers
 *  models emit (`uniqueness: "true"`, `allGreen: 1`). EXACT boolean words
 *  only — prose like "the enumeration is duplicate-free" (run
 *  2026-08-30T08-17-36 design attempt 2) describes the boolean's meaning
 *  without asserting it, so guessing it would rewrite meaning; it stays
 *  rejected with its located error and the retry loop converges (observed:
 *  one ~4-minute round). */
function coerceBooleanSlot(schemaNode: unknown, value: unknown): unknown {
	const s = schemaNode as Record<string, unknown> | null;
	if (!s || typeof s !== "object" || s.type !== "boolean" || "anyOf" in s) return value;
	if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
	if (typeof value === "string") {
		const word = value.trim().toLowerCase();
		if (word === "true" || word === "yes") return true;
		if (word === "false" || word === "no") return false;
	}
	return value;
}

function coerceSchemaStrings(schema: unknown, data: unknown): unknown {
	// Null-in-optional pruning runs FIRST (it may delete whole subtrees the
	// string walk would otherwise waste time on — and `services.api: null` is
	// never a string-coercion candidate).
	if (data && typeof data === "object" && !Array.isArray(data)) pruneNulls(schema, data as Record<string, unknown>, false);
	const walk = (node: unknown, value: unknown): void => {
		const s = node as Record<string, unknown> | null;
		if (!s || typeof s !== "object" || !value || typeof value !== "object") return;
		const v = value as Record<string, unknown>;
		if (s.type === "object" && s.properties && typeof s.properties === "object") {
			for (const key of Object.keys(s.properties)) {
				const child = (s.properties as Record<string, unknown>)[key];
				// Try string coercion first; if it changed nothing, try array coercion
				// (chain explicitly — `??` short-circuits on a non-nullish unchanged value).
				let coerced = coerceStringSlot(child, v[key]);
				if (coerced === v[key]) coerced = coerceArraySlot(child, v[key]);
				if (coerced === v[key]) coerced = coerceBooleanSlot(child, v[key]);
				// Assign ONLY on a real coercion: an unconditional `v[key] = coerced`
				// materializes absent keys as `key: undefined`, which flips TypeBox's
				// error class from "must have required properties" to per-field type
				// errors (caught by the round-feedback contract tests).
				if (coerced !== undefined && coerced !== v[key]) v[key] = coerced;
				// un-coerced slots that are containers recurse deeper
				if (v[key] && typeof v[key] === "object") walk(child, v[key]);
			}
			return;
		}
		if (s.type === "array" && s.items && Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				let coerced = coerceStringSlot(s.items, v[i]);
				if (coerced === v[i]) coerced = coerceArraySlot(s.items, v[i]);
				if (coerced === v[i]) coerced = coerceBooleanSlot(s.items, v[i]);
				if (coerced !== undefined && coerced !== v[i]) v[i] = coerced;
				if (v[i] && typeof v[i] === "object") walk(s.items, v[i]);
			}
		}
	};
	walk(schema, data);
	return data;
}

/** Augment data with computed fields the template needs (e.g. totalScenarios for
 *  BDD). These are DETERMINISTIC — never trust the model to count correctly.
 *  Every doc also gets `generatedAt`: the exact render/write moment in LOCAL
 *  time (ISO-like with numeric offset, matching run.log timestamps) — the
 *  agent's `date` is a self-reported calendar date; `generatedAt` is the
 *  pipeline-stamped creation time the user can rely on. */
function augmentData(stageId: string, data: Record<string, unknown>): Record<string, unknown> {
	const augmented: Record<string, unknown> = { ...data, generatedAt: localTimestamp() };
	if (stageId === "bdd") {
		const features = (augmented.features as Array<{ scenarios?: unknown }>) ?? [];
		// AC-14 (SCENARIO-031/032): coverage numbers are COMPUTED from the actual
		// scenario acRefs against the distinct traceability AC set — never the
		// model's self-report. totalACs dedupes (a redundant AC-01 row counts once).
		const scenarios = features.flatMap((f) => (Array.isArray(f.scenarios) ? f.scenarios : [])) as Array<Record<string, unknown>>;
		augmented.totalScenarios = scenarios.length;
		const traceability = augmented.traceability as Array<{ acId?: unknown } | undefined> | undefined;
		const acSet = [...new Set((traceability ?? []).map((t) => String(t?.acId ?? "").trim()).filter(Boolean))];
		augmented.totalACs = acSet.length;
		const scenarioAcRefs = new Set(scenarios.map((s) => String(s?.acRef ?? "").trim()).filter(Boolean));
		augmented.coveredAcCount = acSet.filter((id) => scenarioAcRefs.has(id)).length;
		augmented.uncoveredAcIds = acSet.filter((id) => !scenarioAcRefs.has(id));
	}
	return augmented;
}

/** Validate the agent's data against the stage's schema, augment computed fields,
 *  and render through the stage's template. Returns the markdown (or errors). */
export function renderStage(stageId: string, data: unknown): RenderResult {
	const model = STAGE_MODELS[stageId];
	if (!model) throw new Error(`renderStage: unknown stage "${stageId}". Known: ${Object.keys(STAGE_MODELS).join(", ")}`);

	// Drift repair BEFORE validation, both directions, in-place so the
	// caller's control object carries the normalized values downstream:
	//   coerceSchemaStrings — schema-driven number/boolean/paragraph-array →
	//     string for EXACT string contracts (every stage, incl. nested items);
	//   normalizeProseArrays — string → [string] for the prose-array fields.
	coerceSchemaStrings(model.schema, data);
	const normalized = normalizeProseArrays(stageId, data, model.schema);
	const errors = validateData(model.schema, normalized);
	if (errors.length > 0) return { markdown: "", errors };

	const augmented = augmentData(stageId, normalized as Record<string, unknown>);
	const template = loadTemplate(model.template);
	const markdown = render(template, augmented);
	return { markdown, errors: [] };
}

/** A doc reserved for a stage: the resolved absolute path + its `NN-<slug>.md`
 *  basename (for concise logging). */
export interface ReservedDoc {
	slug: string;
	path: string;
	name: string;
}

/**
 * Resolve — at STAGE START, before the agent runs — the EXACT `NN-<slug>.md`
 * path(s) this stage will write: the primary doc plus every `additionalDocs`
 * entry for a multi-doc stage (e.g. spec → specification / implementation-plan /
 * task-list). Paths are STABLE across retries (specDoc reuses an existing
 * per-slug file), so a stage that re-runs targets the same files instead of
 * drifting the index. Returns [] for a stage with no render model. Pure aside
 * from the filesystem READ specDoc performs; never writes.
 */
export function reserveStageDocs(setup: SetupControl, stageId: string): ReservedDoc[] {
	const model = STAGE_MODELS[stageId];
	if (!model) return [];
	const slugs = [model.slug, ...(model.additionalDocs?.map((d) => d.slug) ?? [])];
	// Resolve ALL of the stage's slugs together so a multi-doc stage (spec →
	// specification + implementation-plan + task-list) gets DISTINCT consecutive
	// indices. Resolving each slug independently made them collide on the same
	// index on a fresh run (08-specification / 08-implementation-plan / 08-task-list).
	const paths = specDocs(setup, slugs);
	return slugs.map((slug, i) => {
		const path = paths[i]!;
		return { slug, path, name: path.slice(path.lastIndexOf("/") + 1) };
	});
}

/** Validate the agent's data against the stage's schema, render the doc, and write
 *  it to the spec dir. Returns the doc path (or null on validation/render failure).
 *  Reusable by both writerTask (spec-review) and inline verify tasks (code-review,
 *  adversarial-review) so any task can use the render pipeline. */
export function renderAndWrite(
	setup: SetupControl,
	log: (m: string) => void,
	stageId: string,
	control: Record<string, unknown> | null,
	/** v0.3.32: receives the EXACT schema/render errors when the control is
	 *  rejected. Callers with a retry loop (design.ts, writerTask) record them
	 * so the convergence feedback says `alternativesConsidered[].alternatives:
	 *  must be array` instead of the useless "no artifact (empty/failed output)"
	 * that starved 6+ retry rounds in runs 2026-08-30T00-10-34/03-23-40. */
	onRenderErrors?: (errors: string[]) => void,
): string | null {
	const model = STAGE_MODELS[stageId];
	if (!model || !control) return null;
	// Reserve the EXACT doc path(s) up front and log them, so every render (any
	// stage, any retry) writes to a deterministic, stream-visible NN-<slug>.md.
	// reserved[0] is the primary doc; the rest align with model.additionalDocs by
	// slug order. Reservation is idempotent (reuses an existing per-slug file), so
	// a re-run overwrites in place instead of allocating a new index.
	const reserved = reserveStageDocs(setup, stageId);
	const docPath = reserved[0]?.path ?? specDoc(setup, model.slug);
	log(`${stageId}: doc → ${docPath.slice(docPath.lastIndexOf("/") + 1)}`);
	const rendered = renderStage(stageId, control);
	if (rendered.errors.length > 0) {
		log(`${stageId}: render validation errors — ${rendered.errors.join("; ")}`);
		onRenderErrors?.(rendered.errors);
		return null;
	}
	if (rendered.markdown) {
		writeFileSync(docPath, rendered.markdown);
		control.docPath = docPath;
		log(`${stageId}: rendered ${docPath} (${rendered.markdown.length} bytes)`);
		// Multi-doc: render additional docs from the same data (e.g. spec → 3 docs),
		// each to its RESERVED path (matched by slug so order can't drift).
		if (model.additionalDocs) {
			for (const extra of model.additionalDocs) {
				const extraPath = reserved.find((r) => r.slug === extra.slug)?.path ?? specDoc(setup, extra.slug);
				const extraMd = render(loadTemplate(extra.template), augmentData(stageId, control));
				writeFileSync(extraPath, extraMd);
				const key = extra.slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Path";
				control[key] = extraPath;
				log(`${stageId}: rendered ${extraPath} (${extraMd.length} bytes)`);
			}
		}
		// Spec-specific gate compatibility
		if (stageId === "spec") {
			control.specificationPath = docPath;
			control.phaseCount = String((control.phases as unknown[])?.length ?? 0);
		}
		// Auto-accumulate this stage's raw data to .knowledge.md
		appendToKnowledge(setup.specDirectory, stageId, control);
		return docPath;
	}
	return null;
}
