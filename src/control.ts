/**
 * Tolerant extraction of the `<control>` JSON object specialist agents emit.
 * Tries, in order: `<control>...</control>` tag, ```json fenced block, then the
 * last balanced `{...}` object in the text. Returns null if none parse.
 */

import type { ControlObj } from "./types.ts";

const CONTROL_TAG_RE = /<control>\s*([\s\S]*?)\s<\/control>/i;

export function extractControl(text: string): ControlObj | null {
	if (!text) return null;
	const tag = text.match(CONTROL_TAG_RE);
	if (tag?.[1]) {
		const parsed = tryParseJsonObject(tag[1]);
		if (parsed) return parsed;
	}
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s```/gi)) {
		const parsed = tryParseJsonObject(match[1]);
		if (parsed) return parsed;
	}
	const obj = findLastJsonObject(text);
	if (obj) {
		const parsed = tryParseJsonObject(obj);
		if (parsed) return parsed;
	}
	return null;
}

function tryParseJsonObject(raw: string): ControlObj | null {
	const trimmed = raw.replace(/,(\s*[}\]])/g, "$1").trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const value = JSON.parse(trimmed);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as ControlObj;
		}
	} catch {
		// fall through
	}
	return null;
}

/** The list of control keys a stage expects, parsed from its prompt.
 *  Every `build*Prompt` ends with a line like:
 *      Output <control> JSON with: docPath, featureName, acCount, openQuestions, summary.
 *  We parse that comma-list (stripping inline `(type)` annotations) so the
 *  session backend can declare those keys in its `structured_output` tool
 *  schema — which is what actually makes the model fill them (see
 *  docs/findings/session-backend-requirements-gate.md). Returns [] if the
 *  prompt has no such line (e.g. commit tasks), which safely degrades to the
 *  permissive schema. */
export function extractControlKeys(prompt: string): string[] {
	const m = prompt.match(/<control>\s*JSON\s*with:\s*([^\n.]+)/i);
	if (!m) return [];
	return m[1]
		.split(",")
		.map((s) => s.replace(/\([^)]*\)/g, "").trim())
		.filter((s) => /^[A-Za-z_][\w]*$/.test(s));
}

/** Find the last balanced `{...}` substring via a brace scan. */
export function findLastJsonObject(text: string): string | null {
	const lastOpen = text.lastIndexOf("{");
	if (lastOpen === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = lastOpen; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(lastOpen, i + 1);
		}
	}
	return null;
}
