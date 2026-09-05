/**
 * Agent error classification shared by the workflow runner and retry gates.
 *
 * Transient failures can improve by retrying the same agent call. Environment
 * failures such as a missing `pi` executable cannot; retrying them just burns
 * the stage budget and hides the real setup problem.
 */

const NON_RETRYABLE_AGENT_RE = /\b(?:spawn\s+\S+\s+ENOENT|failed\s+to\s+spawn\s+pi|ENOENT|EACCES|EPERM|permission\s+denied|command\s+not\s+found|no\s+such\s+file\s+or\s+directory)\b/i;

export function isNonRetryableAgentError(error?: string): boolean {
	return !!error && NON_RETRYABLE_AGENT_RE.test(error);
}

export function nonRetryableAgentSummary(error?: string): string {
	const message = String(error ?? "unknown environment failure").replace(/\s+/g, " ").trim();
	return `non-retryable agent environment failure: ${message}`;
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
