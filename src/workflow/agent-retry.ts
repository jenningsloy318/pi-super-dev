import { superDevEnv } from "../render/super-dev-dir.ts";
import { WORKFLOW_ATTEMPTS } from "../retry-policy.ts";
import { isNonRetryableAgentError } from "../agent-errors.ts";
import { mergeUsage, type AgentUsage } from "../types.ts";

/** Wave 2 increment 4: the agent transient-retry machinery (429/overload/5xx
 *  backoff INSIDE one logical agent call — one budget unit), extracted from
 *  workflow.ts verbatim. One reason to change: retry/backoff policy. */

/** Signal-aware sleep (local — workflow.ts doesn't import nodes' sleep).
 *  Exported (additive) for the A-05 listener-count pinning test. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const onAbort = () => { clearTimeout(t); finish(); };
		// A-05 (NFR-6): remove the once-listener on NORMAL resolution too — the
		// transient-retry backoff cadence otherwise accumulates retained closures
		// on the ONE shared run AbortSignal (MaxListenersExceededWarning noise).
		const finish = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
		const t = setTimeout(finish, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Transient (retryable) agent errors: rate limits, overload, 5xx, connection
 *  resets. Retried with backoff INSIDE one agent call — not counted as a fresh
 *  gate attempt (which burned the budget when a model 429'd on every attempt). */
const TRANSIENT_RE = /\b(429|rate.?limit|overload|too many requests|service unavailable|503|502|520|521|522|524|ECONNRESET|ETIMEDOUT|socket hang up)\b/i;
function isTransientAgentError(error?: string): boolean {
	return !!error && TRANSIENT_RE.test(error);
}

/** Transient-retry backoff schedule (ms). Read LAZILY so tests can set
 *  SUPER_DEV_TRANSIENT_RETRY_MS before invoking. Default: four retries
 *  (5 total tries) at 2s, 4s, 8s, 16s. */
function transientRetryMs(): number[] {
	const defaultDelays = Array.from({ length: Math.max(0, WORKFLOW_ATTEMPTS - 1) }, (_, i) => 2000 * (2 ** i)).join(",");
	return (superDevEnv("SUPER_DEV_TRANSIENT_RETRY_MS") ?? defaultDelays)
		.split(",").map((x) => Number.parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 0);
}

/** Run an agent backend call, retrying transient errors with exponential backoff.
 *  One logical agent call = one budget unit (budget.spent is called once by
 *  realAgent; retries are internal).
 *  v0.3.72 M1 (review F1/ADV-F1): every transient attempt burns real tokens,
 *  so the returned result carries the SUM of all attempts' usage — the last
 *  attempt's block alone under-counts the fuse input. */
export async function runWithTransientRetry<T extends { error?: string; usage?: AgentUsage }>(
	exec: () => Promise<T>, signal: AbortSignal | undefined, log: (m: string) => void,
): Promise<T> {
	const delays = transientRetryMs();
	let last: T;
	let total: AgentUsage | undefined;
	const done = (): T => (total == null ? last : { ...last, usage: total });
	for (let attempt = 0; ; attempt++) {
		last = await exec();
		total = mergeUsage(total, last.usage);
		if (isNonRetryableAgentError(last.error)) return done();
		if (!isTransientAgentError(last.error)) return done();
		if (attempt >= delays.length) return done(); // exhausted -> surface the transient error
		const delay = delays[attempt];
		log(`agent transient error (429/overload) — retrying in ${delay}ms (attempt ${attempt + 1}/${delays.length}): ${last.error}`);
		await sleepMs(delay, signal);
		if (signal?.aborted) return done();
	}
}
