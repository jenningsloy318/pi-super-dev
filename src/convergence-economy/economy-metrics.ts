/**
 * WS0 (066 §2) — the convergence-economy metrics derivation, pure core.
 *
 * Derives per-role first-pass acceptance and bounce economics from the run
 * log's EXISTING rows (P10-honest lines, no new instrumentation): the
 * delegation terminal lines (`delegation <role>: ... status=... duration=Ns`)
 * and the v0.4.60+ bounce lines (`... convergence: finding-resolution
 * bounce` / `... convergence: validator bounce`). Attempt definition per 066
 * (grill-5 Q6): an ATTEMPT is one WRITER dispatch that submitted an artifact
 * to review; a bounce is counted separately (bounce-prevented submission) —
 * the bounce's value appears as fewer attempts by construction, not by
 * accounting.
 *
 * Pure: string lines in, numbers out; never throws on malformed input
 * (unparseable lines are skipped and counted — P5/P10).
 */

export interface RoleEconomyRow {
	role: string;
	/** Writer dispatches that submitted an artifact to review (attempts). */
	writerAttempts: number;
	/** Reviewer dispatches (verification passes). */
	reviewPasses: number;
	/** Pre-review bounces fired (WS1 finding-resolution + WS2 validator). */
	bounces: number;
	/** Sum of reviewer wall-clock (ms). */
	reviewMs: number;
	/** Sum of writer wall-clock (ms). */
	writerMs: number;
}

export interface EconomyMetrics {
	roles: RoleEconomyRow[];
	/** Lines skipped as unparseable where parsing was attempted (honesty). */
	unparseable: number;
	/** Walks whose review APPROVED at round 1 (the SWE-bench-convention
	 * first-pass acceptance: approved on the FIRST submission). */
	firstPassApprovals: number;
	/** Walks that reached a review approval at any round. */
	reviewedWalks: number;
}

const DELEGATION_RE = /delegation ([a-zA-Z0-9-]+): (?:completed|terminal status=\S+).*?duration=([^ ]+)/;
const BOUNCE_RE = /convergence: (?:finding-resolution bounce|coverage bounce|validator bounce|anchor bounce)/;

/** The writer-role set (dispatches that submit artifacts for review). */
const WRITER_ROLES = new Set([
	"requirements-clarifier",
	"bdd-scenario-writer",
	"spec-writer",
	"architecture-designer",
	"docs-executor",
	"prototype-runner",
	"implementer",
	"tdd-guide",
	"debug-analyzer",
	"research-agent",
	"code-assessor",
]);

/** The reviewer-role set (verification passes). */
const REVIEWER_ROLES = new Set([
	"requirements-reviewer",
	"bdd-reviewer",
	"spec-reviewer",
	"design-reviewer",
	"code-reviewer",
	"adversarial-reviewer",
	"tests-reviewer",
	"judge",
]);

function rowFor(map: Map<string, RoleEconomyRow>, role: string): RoleEconomyRow {
	let row = map.get(role);
	if (!row) {
		row = { role, writerAttempts: 0, reviewPasses: 0, bounces: 0, reviewMs: 0, writerMs: 0 };
		map.set(role, row);
	}
	return row;
}

/** Derive per-role economy rows from run-log lines. Pure; malformed lines
 * that MATCH neither pattern are not counted as unparseable (most log lines
 * are neither); only delegation-shaped lines that fail the duration parse
 * count. */
export function economyMetricsFromLog(lines: readonly string[]): EconomyMetrics {
	const map = new Map<string, RoleEconomyRow>();
	let bounces = 0;
	let unparseable = 0;
	for (const raw of lines) {
		const line = String(raw ?? "");
		if (BOUNCE_RE.test(line)) {
			bounces++;
			continue;
		}
		const m = DELEGATION_RE.exec(line);
		if (!m) continue;
		const role = m[1]!;
		const dur = Number.parseFloat(m[2]!);
		if (!Number.isFinite(dur) || dur < 0) { unparseable++; continue; }
		const ms = Math.round(dur * 1000);
		const row = rowFor(map, role);
		if (WRITER_ROLES.has(role)) {
			row.writerAttempts++;
			row.writerMs += ms;
		} else if (REVIEWER_ROLES.has(role)) {
			row.reviewPasses++;
			row.reviewMs += ms;
		} else {
			// Unknown roles still count as writer-shaped dispatches (an
			// attempt by another name) — visible, not silently dropped.
			row.writerAttempts++;
			row.writerMs += ms;
		}
	}
	// Bounces attach to the writer side they rescued — per-role attribution
	// needs the bounce line's stage; the log line carries the feedbackKey
	// prefix ("<key> convergence: ..."), so re-walk for per-role splits.
	// (The roles array materializes AFTER this walk: a bounce for a role with
	// no dispatch row yet must still appear.)
	for (const line of lines) {
		const b = /([a-zA-Z]+) convergence: (?:finding-resolution bounce|coverage bounce|validator bounce|anchor bounce)/.exec(String(line ?? ""));
		if (!b) continue;
		const key = b[1]!;
		const role = key === "requirements" ? "requirements-clarifier"
			: key === "bdd" ? "bdd-scenario-writer"
				: key === "spec" ? "spec-writer"
					: key === "design" ? "architecture-designer" : null;
		if (role) rowFor(map, role).bounces++;
	}
	let firstPassApprovals = 0;
	let reviewedWalks = 0;
	for (const raw of lines) {
		const m = /convergence: ✓ review approved round (\d+)/.exec(String(raw ?? ""));
		if (!m) continue;
		reviewedWalks++;
		if (Number.parseInt(m[1]!, 10) === 1) firstPassApprovals++;
	}
	return { roles: [...map.values()].sort((x, y) => y.writerMs + y.reviewMs - (x.writerMs + x.reviewMs)), unparseable, firstPassApprovals, reviewedWalks };
}

/** The operator-facing summary line (P10: numbers, named, no inflation). */
export function economyMetricsSummary(metrics: EconomyMetrics): string {
	const attempts = metrics.roles.reduce((n, r) => n + r.writerAttempts, 0);
	const reviews = metrics.roles.reduce((n, r) => n + r.reviewPasses, 0);
	const bounces = metrics.roles.reduce((n, r) => n + r.bounces, 0);
	const reviewMin = Math.round(metrics.roles.reduce((n, r) => n + r.reviewMs, 0) / 60000);
	const fp = metrics.reviewedWalks > 0 ? Math.round((metrics.firstPassApprovals / metrics.reviewedWalks) * 100) : 0;
	return `economy: ${attempts} writer attempts, ${reviews} review passes (${reviewMin} min review wall-clock), ${bounces} pre-review bounce(s), first-pass acceptance ${metrics.firstPassApprovals}/${metrics.reviewedWalks} (~${fp}%)`;
}
