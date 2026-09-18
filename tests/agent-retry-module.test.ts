import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientAgentError, runWithTransientRetry, transientRetryMs } from "../src/workflow/agent-retry.ts";

describe("workflow/agent-retry — wave 2 increment 4 module arms (previously unpinned)", () => {
	afterEach(() => { delete process.env.SUPER_DEV_TRANSIENT_RETRY_MS; });

	it("transientRetryMs default schedule: WORKFLOW_ATTEMPTS-1 exponential delays; the parseInt filter drops junk and negatives", () => {
		expect(transientRetryMs()).toEqual([2000, 4000, 8000, 16000]); // WORKFLOW_ATTEMPTS=5, 2s base
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1, x, 2, -5, 3.9, 4";
		expect(transientRetryMs()).toEqual([1, 2, 3, 4]); // junk + negative dropped; parseInt truncates "3.9" -> 3
	});

	it("post-sleep abort arm: an aborted signal after a transient failure ends the loop with the LAST result (no further exec)", async () => {
		process.env.SUPER_DEV_TRANSIENT_RETRY_MS = "1,1,1";
		const ctrl = new AbortController();
		const exec = vi.fn(async () => {
			ctrl.abort(); // abort BEFORE the backoff sleep — sleepMs resolves instantly, the post-sleep check must end the loop
			return { error: "429 rate limit" } as { error?: string };
		});
		const out = await runWithTransientRetry(exec, ctrl.signal, vi.fn());
		expect(exec).toHaveBeenCalledTimes(1); // the abort ended the retry loop — no second attempt
		expect(out.error).toBe("429 rate limit");
	});
});

describe("TRANSIENT_RE — every regex arm is a retryable transient (adversarial fold: previously unpinned)", () => {
	it.each([
		["429 Too Many Requests", true],
		["HTTP 429: rate limit exceeded", true],
		["provider overload (the \b boundary excludes \"overloaded\" — a real grammar pin)", true],
		["provider is overloaded", false], // word boundary: overload+e is NOT the token
		["too many requests for this model", true],
		["503 Service Unavailable", true],
		["upstream returned 502", true],
		["cloudflare 520 at the edge", true],
		["error 521 / 522 / 524 class", true],
		["read ECONNRESET", true],
		["request ETIMEDOUT", true],
		["socket hang up", true],
		["service unavailable", true],
		// negative controls — must NOT retry
		["schema validation failed", false],
		["tsc exited 2 with 3 errors", false],
		["completed without making edits", false],
		["unknown agent: sd-foo", false],
		["", false],
		[undefined, false],
	])("%s => %s", (error, expected) => {
		expect(isTransientAgentError(error)).toBe(expected);
	});
});
