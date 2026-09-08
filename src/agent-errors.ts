/**
 * Agent error classification shared by the workflow runner and retry gates.
 *
 * Transient failures can improve by retrying the same agent call. Environment
 * failures such as a missing `pi` executable cannot; retrying them just burns
 * the stage budget and hides the real setup problem.
 */
import * as os from "node:os";

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
 * FatalAbort). Retrying inside the same process can never succeed.
 *
 * v0.3.82 (incident 2026-09-08T05-30-30-723Z): the v0.3.77 remedy "restart
 * pi to clear it" STOPPED WORKING — pi-subagents 0.66.0 persists the store
 * to disk and reloads it at startup. Only auth-shaped entries self-invalidate
 * (auth.json mtime); quota 429 entries ride the flat 24h TTL and IGNORE the
 * provider's own reset hint (zai: "将在 2026-09-08 20:12:49 重置"), so a 5h
 * quota window poisoned every fresh process until the next morning while the
 * quota had reset hours earlier. The remedy now names the store path and —
 * when the parsed provider reset hint has already passed — states plainly
 * that the persisted entry is stale. */
const MODEL_EXCLUSION_RE = /is excluded and cannot be replaced by a fallback/i;

/** Provider quota-reset hint shapes found inside cached-exclusion reasons.
 *  Local-time shapes (zai renders the reset in Beijing time; this machine
 *  runs Asia/Shanghai — verified against the 2026-09-08 incident: failure
 *  epoch 16:15:21+08 must fall inside the message's own 5-hour window
 *  15:12:49–20:12:49+08, which a UTC reading contradicts). The ISO
 *  "expires:" field pi-subagents appends is its OWN 24h TTL (TZ-free epoch)
 *  and is deliberately NOT parsed as a reset hint — it is used as the
 *  cross-check anchor instead. */
const QUOTA_RESET_HINTS: RegExp[] = [
	/将\s*在\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*重置/g,
	/resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/gi,
];

/** The provider's own window length when the message states it (zai:
 *  "已达到 5 小时的使用上限") — used to validate the timezone inference. */
const QUOTA_WINDOW_HOUR_RE = /(\d{1,3})\s*(?:小时|hours?\b)/i;

/** pi-subagents appends `expires: <ISO-Z>` (recordedAt + 24h flat TTL) — a
 *  timezone-free epoch we can anchor against. */
const EXCLUDES_AT_RE = /expires:\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i;

export interface QuotaResetAssessment {
	/** Parsed reset hint (machine-local interpretation of the provider-rendered
	 *  wall clock) — undefined when the message carries no parsable hint. */
	hint?: Date;
	/** Window length in hours when the message states it (zai: 5). */
	windowHours?: number;
	/** Reconstructed failure epoch (expiresAt − 24h TTL), TZ-free. */
	recordedAtEst?: number;
	/** The local-time parse is arithmetically consistent with the anchor
	 *  (parsed hint after the failure, within the stated window + slack).
	 *  Defaults true when there is nothing to validate AGAINST (no anchor or
	 *  no stated window) — which is exactly why `validated` exists. */
	timezonePlausible: boolean;
	/** True ONLY when BOTH cross-check inputs are present (TZ-free anchor AND
	 *  the message's own window length) and the local-time parse passes —
	 *  r2 review (adv-R2-2): an unstated window or a missing `expires:` anchor
	 *  leaves the timezone inference UNVALIDATED, and an unvalidated inference
	 *  must never back a stale claim. Residual: a custom
	 *  modelExclusions.defaultTtlMs shifts the anchor reconstruction; harm is
	 *  bounded by the re-record safety valve (one re-recorded 429). */
	validated: boolean;
	/** True ONLY when validated && hint already in the past. */
	stale: boolean;
}

/** Assess a cached-exclusion reason for a stale quota entry. Deterministic,
 *  TZ-honest: the wall-clock hint is INTERPRETED as machine-local and that
 *  inference is validated against the TZ-free anchor above; a failed
 *  validation suppresses the stale claim entirely (P10 — unknowns stay
 *  unknown; the remedy sequence stays safe either way: if the claim is wrong
 *  the next live call simply re-records the exclusion). */
export function assessQuotaReset(error?: string, now = Date.now()): QuotaResetAssessment {
	const out: QuotaResetAssessment = { timezonePlausible: true, validated: false, stale: false };
	if (!error) return out;
	for (const re of QUOTA_RESET_HINTS) {
		const m = new RegExp(re.source, re.flags).exec(error);
		if (m?.[1] && m[2]) {
			const hhmm = m[2].length === 5 ? `${m[2]}:00` : m[2];
			const t = new Date(`${m[1]}T${hhmm}`).getTime();
			if (Number.isFinite(t)) out.hint = new Date(t);
			break;
		}
	}
	const wm = QUOTA_WINDOW_HOUR_RE.exec(error);
	if (wm?.[1]) {
		const h = Number(wm[1]);
		if (Number.isFinite(h) && h > 0 && h <= 168) out.windowHours = h;
	}
	const em = EXCLUDES_AT_RE.exec(error);
	if (em?.[1]) {
		const t = new Date(em[1]).getTime();
		if (Number.isFinite(t)) out.recordedAtEst = t - 24 * 3_600_000; // recordedAt = expiresAt − flat 24h TTL
	}
	if (out.hint !== undefined && out.recordedAtEst !== undefined && out.windowHours !== undefined) {
		const slackMs = 30 * 60_000; // clock drift + sub-minute rendering
		const windowMs = out.windowHours * 3_600_000;
		const delta = out.hint.getTime() - out.recordedAtEst;
		out.timezonePlausible = delta > -slackMs && delta <= windowMs + slackMs;
		out.validated = out.timezonePlausible;
	}
	out.stale = out.validated && out.hint !== undefined && out.hint.getTime() <= now;
	return out;
}

/** Back-compat single-value accessor (parsed hint, unvalidated). */
export function quotaResetHintFromError(error?: string): Date | undefined {
	return assessQuotaReset(error).hint;
}

/** Mirror pi-subagents' store resolution (model-exclusions.ts
 *  getExclusionsFilePath / TEMP_ROOT_DIR / resolveTempScopeId) so the remedy
 *  names the real file. Typical shape only — informational, never
 *  load-bearing. Windows has no getuid; pi-subagents falls back to a
 *  username/home scope there (types.ts resolveTempScopeId). */
export function modelExclusionsStorePath(): string {
	const direct = process.env.PI_MODEL_EXCLUSIONS_PATH?.trim();
	if (direct) return direct;
	const scope = typeof process.getuid === "function"
		? `uid-${process.getuid()}`
		: (process.env.USERNAME || process.env.USER ? `user-${process.env.USERNAME || process.env.USER}` : "shared");
	const root = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()
		?? `${os.tmpdir()}/pi-subagents-${scope}`;
	return `${root}/model-exclusions.json`;
}

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
	// v0.3.82: persistence-aware remedy (see MODEL_EXCLUSION_RE docblock) —
	// restart alone no longer clears the 0.66+ store; name the file, and when
	// the provider's own reset hint has passed, say the entry is stale.
	// Auth/billing-shaped reasons keep their credential-first caveat (those
	// only clear after auth.json's mtime moves past the entry).
	let remedy = "";
	if (registryHit) {
		const a = assessQuotaReset(message);
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
		// TZ-honest (v0.3.82): the hint is a provider-rendered wall clock —
		// interpreted in THIS machine's timezone and validated against the
		// TZ-free failure anchor; an implausible parse is shown verbatim and
		// NEVER claimed stale. The remedy sequence is safe regardless: if the
		// claim is wrong the next live call simply re-records the exclusion.
		let staleNote = "";
		if (a.hint !== undefined && a.stale) {
			staleNote = `; the provider quota window appears to have reset at ${a.hint.toLocaleString()} (parsed in this machine's timezone ${tz}, cross-validated against the failure timestamp — still verify against the provider console)`;
		} else if (a.hint !== undefined && !a.validated) {
			staleNote = `; the message says the quota resets at ${a.hint.toLocaleString()} but the timezone inference could not be validated against the failure timestamp (no cross-check data in the message, or an implausible parse) — check the provider console before clearing`;
		}
		remedy = ` — persisted model-exclusion cache (pi-subagents ≥0.66 caches model failures — quota, auth, billing — in ${modelExclusionsStorePath()} with a flat 24h TTL and RELOADS them at startup, so restarting pi alone no longer clears them${staleNote}). Remedy: quit pi, remove the stale entries or delete that store file, start pi, then resume — if the quota has NOT actually reset yet, the next live call simply re-records the exclusion once (bounded, no worse than now); if the cached reason is auth/billing-shaped, fix the provider credential/auth.json first — restart alone will not clear it.`;
	}
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
