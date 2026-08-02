/**
 * Shared retry/attempt policy for super-dev workflow loops.
 *
 * Keep every user-visible "try again" loop on the same default unless a caller
 * provides an explicit override. The policy is deliberately small and pure so it
 * can be imported by low-level control-flow nodes without creating cycles.
 */
export const WORKFLOW_ATTEMPTS = 5;

/** Parse a positive integer env override. Invalid, zero, or negative values fall
 * back to the supplied default. Read lazily at module import like the existing
 * super-dev env knobs. */
export function positiveIntFromEnv(name: string, fallback = WORKFLOW_ATTEMPTS): number {
	const raw = process.env[name];
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
