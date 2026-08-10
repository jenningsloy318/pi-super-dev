/**
 * Shared retry/attempt policy for low-level retry primitives.
 *
 * Stage-level convergence loops should prefer the global agent budget plus
 * no-progress/stagnation detection. Keep this default for explicit caller-owned
 * retry/gate primitives and transient backend retries that need a small local
 * circuit breaker.
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
