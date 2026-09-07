/**
 * Agent error classification shared by the workflow runner and retry gates.
 *
 * Transient failures can improve by retrying the same agent call. Environment
 * failures such as a missing `pi` executable cannot; retrying them just burns
 * the stage budget and hides the real setup problem.
 */

const NON_RETRYABLE_AGENT_RE = /\b(?:spawn\s+\S+\s+ENOENT|failed\s+to\s+spawn\s+pi|ENOENT|EACCES|EPERM|permission\s+denied|command\s+not\s+found|no\s+such\s+file\s+or\s+directory|unknown\s+subagent\s+model|model\s+\S+\s+not\s+found|no\s+such\s+model|is\s+excluded\s+and\s+cannot\s+be\s+replaced\s+by\s+a\s+fallback|no\s+usable\s+subagent\s+models\s+remain)\b/i;

/** v0.3.77 (incident 2026-09-07T14-10-39-259Z): pi-subagents' model-exclusion
 * registry caches model failures — quota 429s included — for a flat 24h and
 * never re-reads them mid-process, so throwForExplicitModelExclusion fails
 * EVERY delegated call carrying an explicit model pin: instantly, locally,
 * without an API call, long after the provider quota has reset (the parent
 * session keeps working on the same model because pi core never consults the
 * registry). The ENVELOPE — not the cached reason — is the signature: a
 * 429-shaped reason must not lure TRANSIENT_RE into burning 4 backoff retries
 * × 3 convergence rounds (the incident did exactly that before the round-3
 * FatalAbort). Retrying inside the same process can never succeed; the only
 * remedy is restarting pi. */
const MODEL_EXCLUSION_RE = /is excluded and cannot be replaced by a fallback/i;

/** v0.3.77 reviews code-F2 — the SIBLING envelope (upstream
 *  model-fallback.ts:390,521-527): unpinned/inherited-model calls exhaust the
 *  same never-reloaded cached-exclusion registry and throw "No usable
 *  subagent models remain …" with 429/quota-shaped embedded reasons. Same
 *  class, same in-process hopelessness, same restart remedy. */
const NO_USABLE_MODELS_RE = /no\s+usable\s+subagent\s+models\s+remain/i;

export function isModelExclusionHit(error?: string): boolean {
	return !!error && MODEL_EXCLUSION_RE.test(error);
}

export function isNonRetryableAgentError(error?: string): boolean {
	return !!error && NON_RETRYABLE_AGENT_RE.test(error);
}

export function nonRetryableAgentSummary(error?: string): string {
	const message = String(error ?? "unknown environment failure").replace(/\s+/g, " ").trim();
	const registryHit = isModelExclusionHit(message) || NO_USABLE_MODELS_RE.test(message);
	// v0.3.77 reviews adv-F2: the cached reason may be auth/billing-shaped —
	// those exclusions only clear after the credential/auth.json is fixed,
	// not on restart alone. Name both remedies honestly.
	const remedy = registryHit
		? " — stale in-process model-exclusion cache (pi-subagents caches model failures — quota, auth, billing — for 24h per process and never re-reads them; the provider quota may already have reset). Restart pi to clear it, then re-run (if the cached reason is auth/billing-shaped, fix the provider credential/auth.json first — restart alone will not clear it)."
		: "";
	return `non-retryable agent environment failure: ${message}${remedy}`;
}

/** F9 (v0.3.67, incident 2026-09-04T14-45-04-784Z): pi-subagents' child
 * acceptance layer (MISSING_IMPLEMENTATION_MUTATION_MESSAGE, backed by the LLM
 * intent arbiter) rejects an implementation-intent child that completes
 * without file edits. For tdd-guide in an already-satisfied phase that is a
 * LEGITIMATE verification-only completion, not a failure — but the arbiter
 * rightly refuses to trust self-report, so the CALL comes back errored and the
 * decision must be re-derived deterministically at the call site (live
 * deliverable re-check → already-satisfied verification). The substring form
 * also matches the wrapped variant ("delegation retry ended with status
 * failed: Subagent completed without making edits …"). */
const NO_EDIT_COMPLETION_RE = /completed without making edits/i;

export function isNoEditCompletion(error?: string): boolean {
	return !!error && NO_EDIT_COMPLETION_RE.test(error);
}
