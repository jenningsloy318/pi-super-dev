/**
 * v0.3.70 W3 — structured-delegation support (plan §5, decision D7 Option C).
 *
 * F10-6: `call.schema` (TypeBox STAGE_MODELS) flowed into the delegation
 * options but the backend hardcoded `result:{kind:"text"}` — the schema never
 * reached the child and the only engine-side check was missing-key names.
 * This module centralizes the structured-mode policy so the backend stays
 * focused on the event protocol:
 *
 *  - DEFAULT ON when a schema is present (Option C — industry converged on
 *    enforce-when-schema: OpenAI strict mode default, LangChain
 *    with_structured_output, PydanticAI, Vercel AI SDK; pi-subagents 0.65
 *    validates structured_output AT CALL TIME in the child's own conversation
 *    so an invalid retry costs an in-turn repair, not a delegation round).
 *    `SUPER_DEV_STRUCTURED=0` is the opt-out escape hatch (NOT an opt-in
 *    flag — a forgotten opt-in silently disables the best behavior forever).
 *  - TWO automatic sticky per-process degrades keep older owners alive
 *    (P4 fail-open-harmless): an `invalid_request` naming the structured
 *    result fields (a 0.64 in-memory owner after `pi update`), and 3
 *    consecutive `structured_output_failed` terminals. Degraded mode = the
 *    schema rides the prompt prose exactly as before v0.3.70; the engine-side
 *    validation below STILL runs (it never depended on the wire mode).
 *  - Engine-side validation stays AUTHORITATIVE (P5): `schemaViolationErrors`
 *    re-checks every control — structured value or parsed prose — with TypeBox
 *    `Value.Errors` (`typebox/value` resolves in dev from the repo's
 *    devDependency and at runtime from pi's bundled jiti alias — verified
 *    loader.js:19-35). Detailed JSON-pointer violations feed the corrective
 *    re-prompt (validate→repair, the industry pattern); fail-open: a broken
 *    schema or validator error returns [] and never blocks a call on the
 *    missing-key checks alone.
 */
import { Value } from "typebox/value";
import { superDevEnv } from "../render/super-dev-dir.ts";

/** Structured mode default-ON (Option C); `SUPER_DEV_STRUCTURED=0` opts out. */
export function structuredModeEnabled(): boolean {
	return superDevEnv("SUPER_DEV_STRUCTURED") !== "0";
}

/** Consecutive-failure degrade threshold — mirrors AGENT_ERROR_FATAL_CONSECUTIVE. */
export const STRUCTURED_FAILURE_DEGRADE_THRESHOLD = 3;

/** An owner that rejects the structured result fields it doesn't understand
 *  (e.g. an in-memory 0.64 bridge after `pi update` swapped the package).
 *  Only consulted for requests WE sent as structured. */
const STRUCTURED_UNSUPPORTED_RE = /(unsupported delegation field: result|result\.kind|structured|outputSchema)/i;

/** True when an invalid_request error names the structured fields. */
export function isStructuredUnsupportedRejection(error: string | undefined): boolean {
	return !!error && STRUCTURED_UNSUPPORTED_RE.test(error);
}

/** Sticky degrade state (per process). Mirrors the version-skew degrade. */
let structuredUnsupportedSeen = false;
let structuredFailureStreak = 0;
export function structuredModeDegraded(): boolean {
	return structuredUnsupportedSeen || structuredFailureStreak >= STRUCTURED_FAILURE_DEGRADE_THRESHOLD;
}
export function markStructuredUnsupported(): void {
	structuredUnsupportedSeen = true;
}
/** Record a structured_output_failed terminal; true when the streak just hit
 *  the degrade threshold (caller WARNs once). */
export function recordStructuredFailure(): boolean {
	structuredFailureStreak += 1;
	return structuredFailureStreak === STRUCTURED_FAILURE_DEGRADE_THRESHOLD;
}
export function recordStructuredSuccess(): void {
	structuredFailureStreak = 0;
}
export function resetStructuredModeForTests(): void {
	structuredUnsupportedSeen = false;
	structuredFailureStreak = 0;
}

/** Deterministic, bounded schema violations for the corrective re-prompt:
 *  `["/verdict: must be equal to one of the allowed values", …]` (≤8 lines).
 *  Fail-open — a schema the validator cannot process yields [] (the
 *  missing-key checks still guard the call). */
export function schemaViolationErrors(schema: unknown, control: unknown): string[] {
	if (schema == null || typeof schema !== "object" || control == null || typeof control !== "object") return [];
	try {
		const ok = Value.Check(schema as Parameters<typeof Value.Check>[0], control as Parameters<typeof Value.Check>[1]);
		if (ok) return [];
		const out: string[] = [];
		for (const err of Value.Errors(schema as Parameters<typeof Value.Errors>[0], control as Parameters<typeof Value.Errors>[1])) {
			const path = (err as { instancePath?: string }).instancePath || "(root)";
			out.push(`${path}: ${err.message ?? "invalid value"}`);
			if (out.length >= 8) break; // bounded feedback — full detail is in the run log
		}
		return out;
	} catch {
		return [];
	}
}
