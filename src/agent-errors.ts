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
