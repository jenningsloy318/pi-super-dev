/**
 * Child-side pi runtime extension for the SUBPROCESS agent backend — the
 * structured-output delivery contract (v0.2.10 W3).
 *
 * Loaded into every spawned specialist via `-e <this-file>` whenever the
 * caller declares `controlKeys` (see pi-spawn.ts spawnAgent). Inert unless
 * BOTH env vars below are present, so loading it is always safe:
 *
 *   SUPER_DEV_SO_SCHEMA  — absolute path to a JSON Schema file describing the
 *                          expected control object (written by the parent,
 *                          0600 temp file).
 *   SUPER_DEV_SO_CAPTURE — absolute path where the accepted control object is
 *                          written (pre-agreed with the parent; stale files
 *                          are unlinked before spawn so presence ⇔ this run).
 *
 * Mechanism (ported from pi-subagents' subagent-prompt-runtime.ts /
 * structured-output.ts, read in full before implementing): the parent cannot
 * pass a tool schema to a `--mode json -p` child, but a runtime extension
 * CAN register one. The tool wraps the real schema under `{ value: <schema> }`
 * (local `$ref`s rewritten to `#/properties/value/…` so they don't dangle),
 * validates the submitted object, writes it to the capture path, and returns
 * `terminate: true` — the tool call IS the step terminator, which makes
 * "announce completion in prose, then stop" (the track-29 / pi-omisis
 * control=null death class) structurally impossible to deliver accidentally.
 *
 * Validation is deliberately STRUCTURAL (object shape, required keys, closed
 * additionalProperties) with zero imports: the schemas this backend generates
 * are permissive key declarations (values unconstrained — see
 * controlSchemaJson in pi-spawn.ts), so full JSON-Schema validation happens
 * parent-side via the existing missingControlKeys completeness check instead
 * of pulling a validator into the child process.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const SO_SCHEMA_ENV = "SUPER_DEV_SO_SCHEMA";
export const SO_CAPTURE_ENV = "SUPER_DEV_SO_CAPTURE";

/** Hard instruction prepended to the child system prompt (before_agent_start)
 *  when the structured-output contract is armed. Mirrors pi-subagents'
 *  STRUCTURED_OUTPUT_INSTRUCTIONS plus the pseudo-tool-call boundary line —
 *  the two prompt-level defenses for the announce-without-control disease. */
export const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This step has a strict structured output contract.",
	"Your final action MUST be to call the `structured_output` tool with the complete control object matching the provided schema.",
	"Do not end your turn with narration, plans, or announcements — prose-only completion FAILS this step.",
	"Never print tool-call syntax, patches, or pseudo-tool calls as text; use the actual tools.",
].join("\n");

/** Distinctive first line of STRUCTURED_OUTPUT_INSTRUCTIONS — the idempotency
 *  sentinel for before_agent_start (must never match a role prompt's own
 *  prose that merely mentions the tool name). */
export const STRUCTURED_OUTPUT_SENTINEL =
	"This step has a strict structured output contract.";

interface JsonSchemaObject {
	type?: string;
	properties?: Record<string, unknown>;
	required?: unknown;
	additionalProperties?: unknown;
}

/** Rewrite local JSON-pointer refs (`#/…`) to live under `#/properties/value/…`
 *  so they don't dangle after the `{ value: <schema> }` wrapper. Compact port
 *  of pi-subagents' rewriteLocalJsonPointerRefs covering the keywords our
 *  generated schemas (and reasonable hand-written ones) use. */
export function rewriteLocalRefs(schema: unknown, pointerPrefix: string): unknown {
	if (typeof schema === "boolean" || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const src = schema as Record<string, unknown>;
	const out: Record<string, unknown> = { ...src };
	for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"] as const) {
		const ref = src[keyword];
		if (ref === "#") out[keyword] = pointerPrefix;
		else if (typeof ref === "string" && ref.startsWith("#/")) out[keyword] = `${pointerPrefix}${ref.slice(1)}`;
	}
	for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const) {
		const entries = src[keyword];
		if (entries && typeof entries === "object" && !Array.isArray(entries)) {
			out[keyword] = Object.fromEntries(
				Object.entries(entries as Record<string, unknown>).map(([name, nested]) => [name, rewriteLocalRefs(nested, pointerPrefix)]),
			);
		}
	}
	const items = src.items;
	if (Array.isArray(items)) out.items = items.map((nested) => rewriteLocalRefs(nested, pointerPrefix));
	else if (items !== undefined) out.items = rewriteLocalRefs(items, pointerPrefix);
	for (const keyword of ["additionalProperties", "additionalItems", "not", "propertyNames", "if", "then", "else", "contains", "unevaluatedItems", "unevaluatedProperties", "contentSchema"] as const) {
		if (src[keyword] !== undefined && typeof src[keyword] !== "boolean") {
			out[keyword] = rewriteLocalRefs(src[keyword], pointerPrefix);
		}
	}
	for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
		if (Array.isArray(src[keyword])) out[keyword] = (src[keyword] as unknown[]).map((nested) => rewriteLocalRefs(nested, pointerPrefix));
	}
	return out;
}

/** Wrap the real control schema as the tool's parameters schema. */
export function structuredOutputToolParameters(schema: JsonSchemaObject): JsonSchemaObject {
	return {
		type: "object",
		properties: { value: rewriteLocalRefs(schema, "#/properties/value") },
		required: ["value"],
		additionalProperties: false,
	};
}

export interface StructuredValidation {
	ok: boolean;
	/** Up to 8 `path: problem` entries — the thrown tool error the model reads
	 *  to self-correct in-session. */
	problems: string[];
}

/** Structural validation of a submitted control value against our permissive
 *  key-declaration schemas (type/required/additionalProperties only). */
export function validateStructurally(schema: JsonSchemaObject, value: unknown): StructuredValidation {
	const problems: string[] = [];
	if (schema.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, problems: ["value: must be a JSON object"] };
		}
		const record = value as Record<string, unknown>;
		const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
		for (const key of required) {
			if (!(key in record) || record[key] === undefined) problems.push(`${key}: required key missing`);
		}
		if (schema.additionalProperties === false && schema.properties) {
			const allowed = new Set(Object.keys(schema.properties));
			for (const key of Object.keys(record)) {
				if (!allowed.has(key)) problems.push(`${key}: unknown key (allowed: ${[...allowed].join(", ")})`);
			}
		}
	}
	return { ok: problems.length === 0, problems: problems.slice(0, 8) };
}

/** Minimal structural check that a parsed schema is usable. */
function isUsableSchema(schema: unknown): schema is JsonSchemaObject {
	return Boolean(schema) && typeof schema === "object" && !Array.isArray(schema);
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	terminate?: boolean;
}

/** The pi ExtensionAPI surface this extension uses (structural — the child's
 *  real API satisfies it; tests inject a fake). */
interface ExtensionApiSurface {
	registerTool?: (tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (_id: string, params: unknown) => Promise<ToolResult>;
	}) => void;
	on?: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => void;
}

export default function registerSubprocessStructuredOutput(pi: ExtensionApiSurface): void {
	const schemaPath = process.env[SO_SCHEMA_ENV]?.trim();
	const capturePath = process.env[SO_CAPTURE_ENV]?.trim();
	if (!schemaPath || !capturePath) return; // inert without the contract
	let schema: unknown;
	try {
		schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
	} catch {
		return; // unreadable schema → stay inert; parent falls back to <control> text
	}
	if (!isUsableSchema(schema)) return;

	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			name: "structured_output",
			label: "Structured Output",
			description: "Submit the required final control object for this agent step. This terminates the step.",
			parameters: structuredOutputToolParameters(schema),
			async execute(_id: string, params: unknown) {
				const paramsRecord = (params && typeof params === "object" && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
				// Tolerate both {value: {...}} (declared) and a bare control object.
				const value = "value" in paramsRecord ? paramsRecord.value : params;
				const validation = validateStructurally(schema, value);
				if (!validation.ok) {
					throw new Error(`Structured output validation failed: ${validation.problems.join("; ")}`);
				}
				fs.mkdirSync(path.dirname(capturePath), { recursive: true });
				fs.writeFileSync(capturePath, JSON.stringify(value), { mode: 0o600 });
				return {
					content: [{ type: "text", text: "Structured output captured." }],
					details: { path: capturePath },
					terminate: true,
				};
			},
		});
	}

	if (typeof pi.on === "function") {
		pi.on("before_agent_start", (event: unknown) => {
			if (!event || typeof event !== "object" || !("systemPrompt" in event) || typeof (event as { systemPrompt?: unknown }).systemPrompt !== "string") return undefined;
			const systemPrompt = (event as { systemPrompt: string }).systemPrompt;
			// review F-5: idempotency key must be OUR distinctive instruction line,
			// not the bare tool name — many role prompts legitimately mention
			// `structured_output` (spec-writer, bdd-scenario-writer, task-classifier,
			// api/ui-tester, red-boundary-classifier, tdd-coverage-classifier…), and
			// the bare-name check silently dropped the hard boundary instructions
			// for exactly the writer roles the incident evidence cites.
			if (systemPrompt.includes(STRUCTURED_OUTPUT_SENTINEL)) return undefined; // idempotent (already prepended)
			return { systemPrompt: `${STRUCTURED_OUTPUT_INSTRUCTIONS}\n\n${systemPrompt}` };
		});
	}
}
