/**
 * v0.3.47 — control-key optionality contract (three-way: prompt ↔ schema ↔ validator).
 *
 * Live incident (run 2026-08-31T01-47-05, cosmic-clock): the upstream-review
 * `<control>` line unconditionally demanded `priorFindingResolutions` while
 * the render schema declares it `Type.Optional` and the round-1 reviewer had
 * no prior findings to resolve — the model reasonably omitted the key, the
 * delegation key check failed it, the corrective retry re-ran the ENTIRE
 * reviewer (12m26s) which omitted it again, and 22m52s of verified review
 * work was discarded. Same latent mismatch existed for openQuestions (req),
 * traceability (bdd), services (assessment), contracts/alternativesConsidered
 * (design), reviewResponses/gate (spec).
 *
 * This file pins BOTH directions of the contract, dynamically against the
 * schemas (no hand-maintained optional list to drift):
 *   1. a key in a control line WITHOUT an optional marker (`key?` or
 *      `key (optional…)`) must be in the stage schema's `required` list;
 *   2. a schema-Optional top-level field that appears in the line MUST carry
 *      an optional marker (so it is never demanded by the context-free
 *      delegation key check);
 *   3. extractControlKeys returns only the marked-required keys.
 */
import { describe, it, expect } from "vitest";
import { extractControlKeys } from "../src/control.ts";
import * as P from "../src/prompts.ts";
import { RequirementsData, BddData, CodeAssessmentData, DesignData, RequirementsReviewData, SpecReviewData, SpecificationData } from "../src/render/schemas.ts";

/** Minimal SetupControl shim (only ctxBlock fields are read). */
const s = { task: "contract test", cwd: "/tmp", specDirectory: "/tmp/", worktreePath: "/tmp", language: "english", knowledgeFiles: [] } as unknown as Parameters<typeof P.buildRequirementsPrompt>[0];
const c = { taskType: "feature", uiScope: "none", rationale: "test", language: "english", isWebUi: false } as unknown as Parameters<typeof P.buildRequirementsPrompt>[1];

type Schema = { required?: string[]; properties?: Record<string, unknown> };
const requiredOf = (schema: unknown): Set<string> => new Set(((schema as Schema).required ?? []) as string[]);
const optionalOf = (schema: unknown): Set<string> =>
	new Set(Object.keys(((schema as Schema).properties ?? {})).filter((k) => !requiredOf(schema).has(k)));

/** Extract the raw `<control> JSON with:` line (with markers intact). */
function controlLine(prompt: string): string {
	const m = prompt.match(/<control>\s*JSON\s+with:\s*([^\n]+)/i);
	if (!m) throw new Error("no control line in prompt");
	return m[1];
}

/** Keys carrying an optional marker (`key?` or `key (optional…)`). */
function markedOptionalKeys(line: string): Set<string> {
	const out = new Set<string>();
	// depth-0 comma split (same discipline as extractControlKeys)
	const segments: string[] = [];
	let depth = 0, start = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
		else if (ch === "," && depth === 0) { segments.push(line.slice(start, i)); start = i + 1; }
	}
	segments.push(line.slice(start));
	for (const seg of segments) {
		const t = seg.trim().replace(/\.\s*$/, "");
		const id = /^([A-Za-z_]\w*)/.exec(t);
		if (!id) continue;
		const rest = t.slice(id[1].length);
		if (/^\?/.test(rest) || /^\s*\(\s*optional\b/.test(rest)) out.add(id[1]);
	}
	return out;
}

const CASES: Array<{ name: string; prompt: string; schema: unknown }> = [
	{ name: "requirements", prompt: P.buildRequirementsPrompt(s, c, "t"), schema: RequirementsData },
	{ name: "bdd", prompt: P.buildBddPrompt(s, c, "t", null), schema: BddData },
	{ name: "assessment", prompt: P.buildAssessmentPrompt(s, c, "t", null, null), schema: CodeAssessmentData },
	{ name: "design", prompt: P.buildDesignPrompt(s, c, "t", null, null, null, "architecture-designer"), schema: DesignData },
	{ name: "upstream review", prompt: P.buildUpstreamReviewPrompt(s, c, { stage: "requirements", docPath: "/tmp/x.md", upstream: [], priorResponses: undefined }), schema: RequirementsReviewData },
	{ name: "spec review", prompt: P.buildSpecReviewPrompt(s, c, null), schema: SpecReviewData },
	{ name: "spec", prompt: P.buildSpecPrompt(s, c, "t", null, null, null, null, null, null), schema: SpecificationData },
];

describe("control-key optionality contract (v0.3.47)", () => {
	for (const { name, prompt, schema } of CASES) {
		it(`${name}: every unmarked control key is schema-required; every schema-optional key in the line is marked optional`, () => {
			const line = controlLine(prompt);
			const markedOptional = markedOptionalKeys(line);
			const requiredKeys = extractControlKeys(prompt); // required-only after v0.3.47
			const schemaRequired = requiredOf(schema);
			const schemaOptional = optionalOf(schema);

			// (1) extractControlKeys output must be exactly the line's keys minus the marked-optional ones.
			for (const k of requiredKeys) expect(markedOptional.has(k), `${name}: ${k} is required but marked optional`).toBe(false);

			// (2) three-way: an unmarked line key must be schema-required…
			const allLineKeys = [...markedOptional, ...requiredKeys];
			for (const k of allLineKeys) {
				if (markedOptional.has(k)) continue;
				expect(schemaRequired.has(k), `${name}: line demands ${k} but schema does not (should carry an optional marker)`).toBe(true);
			}
			// (3) …and a schema-optional field that appears in the line must be marked.
			for (const k of schemaOptional) {
				if (!allLineKeys.includes(k)) continue; // absent from the contract — fine
				expect(markedOptional.has(k), `${name}: schema-optional ${k} appears in the control line WITHOUT an optional marker`).toBe(true);
			}
		});
	}

	it("extractControlKeys: `key?` and `key (optional…)` segments are excluded from the required list (no junk warnings, no phantom keys)", () => {
		const line = "Output <control> JSON with: title, date, verdict, findings, priorFindingResolutions?, dimensions.";
		expect(extractControlKeys(line)).toEqual(["title", "date", "verdict", "findings", "dimensions"]);
		const annotated = "Output <control> JSON with: title, contracts (optional) [{name, pattern}], alternativesConsidered (optional, record real alternatives), hasNumericConstants.";
		expect(extractControlKeys(annotated)).toEqual(["title", "hasNumericConstants"]);
		// `(options…)` must NOT count as optional — only the literal word "optional".
		const parenTrap = "Output <control> JSON with: title, modes (options are derived from the registry).";
		expect(extractControlKeys(parenTrap)).toEqual(["title", "modes"]);
	});

	it("delegation contract regression: the upstream-review control line no longer demands priorFindingResolutions at round 1 (the 22m52s burn, run 2026-08-31T01-47-05)", () => {
		const prompt = P.buildUpstreamReviewPrompt(s, c, { stage: "requirements", docPath: "/tmp/x.md", upstream: [] });
		expect(extractControlKeys(prompt)).not.toContain("priorFindingResolutions");
	});
});
