/**
 * M2 of the routing-architecture migration: the ADDRESSABLE WALKER (G1
 * sub-walk design) + the pilot go/no-go planner.
 *
 * `sequence()` iterates a fixed array composed once at module load; `loop()`
 * re-runs ONE node — no jump primitive existed. The walker wraps the SAME
 * children array:
 *
 *   kill-switch set (SUPER_DEV_NO_INLINE_ROUTEBACK=1 — M3 default is ON):
 *     pure pass-through — a RouteBackSignal re-throws unchanged, so today's
 *     routing (G8 fixture 1; M5: the kill-switch now means "no automatic
 *     route-back" — the emulation fallback was retired). The
 *     wrapper adds no ctx.results / stage events of its own, so the
 *     observable stream is identical too.
 *
 *   active (default): the signal is caught ABOVE the
 *     sequence (G2 — before runWorkflow's catch, so the jump never ends the
 *     run). Re-entry protocol, ALL synchronous and ordered (MP1
 *     sync-before-re-entry; every FAILING check runs before any persistent
 *     mutation — a declined jump leaves counters/cache/journal untouched):
 *       1. precheck artifact-revisions.json is readable (absent is fine)
 *       2. invalidateResumeCache(owner + downstreamOf(owner)) (G5 — else the
 *          re-entered writer memoization-replays its identical old rounds);
 *          a 0-drop result while matching rows survive is a B6 FAILURE
 *       3. inject the blocker findings as PENDING replan requests for the
 *          owner (the v0.3.3 round-1 ledger injection)
 *       4. bump the owner's artifact-revision counter (G3 invalidation input)
 *       5. charge the jump to the persisted routing journal (MP2 — budget
 *          authority; a failed journal write FAILS CLOSED: decline, never
 *          re-enter on an unrecorded edge)
 *       6. sub-walk `children[indexOf(owner)..]` — the owner re-converges,
 *          every downstream stage re-runs, predicates (isBug / canMerge /
 *          hasImplementation) re-evaluate from state mid-walk, and pre-owner
 *          stages never re-run at all.
 *
 * Bounded: per-edge budget is checked at the THROW site (journal-hydrated,
 * MP2) and re-checked here as defense-in-depth; plus an overall inline-jump
 * cap (SUPER_DEV_MAX_INLINE_JUMPS, default 4). Exhaustion re-throws — the
 * escalation surface owns everything beyond the cap.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FatalAbort, sequence } from "../nodes.ts";
import type { Node, NodeResult, PipelineState, StageContext } from "../types.ts";
import { downstreamOf } from "../graph/edges.ts";
import { getConvergenceLedger } from "../convergence-ledger.ts";
import {
	ARTIFACT_REVISIONS_FILE,
	appendRouteBackRequests,
	invalidateResumeCache,
	pendingReplanRequests,
	resumeCacheHasRowsFor,
} from "../replan/replan.ts";
import { appendRunEvent } from "../runlog.ts";
import {
	type RouteBackCommand,
	type RoutableOwnerStage,
	RouteBackSignal,
	type RoutingCommand,
	isRouteBackSignal,
	isRoutableOwnerStage,
	remainingBudget,
	routeBackOrEscalate,
	stagePrecedes,
} from "./router.ts";
import {
	chargeRoutingJump,
	inlineRouteBackEnabled,
	maxInlineJumps,
	persistedBudget,
	startRunEpoch,
} from "./journal.ts";

// ─── Pilot go/no-go (used by the artifact-convergence throw site) ───────────

/**
 * Decide whether `findings` surfaced at `from` justify an INLINE route-back
 * jump (M2 pilot conditions):
 *   - exactly ONE distinct owner, routable (REPLAN_OWNER_STAGES) and strictly
 *     upstream in skeleton order (stagePrecedes) — multi-owner sets keep the
 *     replan emulation;
 *   - per-edge budget remaining in the PERSISTED journal (MP2) — exhaustion
 *     returns null and the caller falls through to today's emulation.
 * Returns the command to throw, or null.
 */
export function planInlineRouteBack(
	specDir: string | undefined,
	from: string,
	findings: Array<{ id?: unknown; ownerStage?: unknown; blocking?: unknown; title?: unknown }>,
): RouteBackCommand | null {
	if (!specDir || !inlineRouteBackEnabled()) return null;
	// M4: EVERY routable producer may throw — the pilot `from` allowlist
	// (M2: bdd; M3: +spec) is retired. The safety was never the allowlist:
	// it is the single-distinct-strictly-upstream-routable-owner, blocking-
	// only, and per-edge-budget conditions below. The thrower need not be
	// addressable — only the TARGET is (an upstream convergence node), and
	// all five carry M2 ids.
	const owners = new Set<string>();
	const ids: string[] = [];
	for (const f of findings) {
		if (f.blocking !== true) continue; // advisories never drive jumps (adv-F-6)
		const owner = typeof f.ownerStage === "string" ? f.ownerStage : "";
		if (!isRoutableOwnerStage(owner) || !stagePrecedes(owner, from)) continue;
		owners.add(owner);
		if (typeof f.id === "string") ids.push(f.id);
	}
	if (owners.size !== 1) return null; // zero or multi-owner → keep emulation
	const to = [...owners][0] as RoutableOwnerStage;
	const reason = findings
		.map((f) => String(f.title ?? f.id ?? "upstream blocker"))
		.slice(0, 3)
		.join("; ");
	const cmd = routeBackOrEscalate(from, to, reason, ids, persistedBudget(specDir));
	return cmd.action === "route-back" ? cmd : null; // exhausted → emulate
}

// ─── The walker ─────────────────────────────────────────────────────────────

/** v0.3.24 (review-2 F1): exported for the convergence carried exits —
 *  bumping the owner's revision counter makes any EARLIER convergence record
 *  for that owner stale, so the revision-gate fast-forward cannot skip the
 *  owner's loop when carried debt is waiting for its round 1. */
export function bumpOwnerRevision(specDir: string, owner: string): number {
	const path = join(specDir, ARTIFACT_REVISIONS_FILE);
	let revisions: Record<string, number> = {};
	if (existsSync(path)) {
		try {
			revisions = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
		} catch {
			// Present but UNREADABLE (adv-F-9): never reset — a fresh {} would drop
			// every other stage's counters. Report unchanged; caller declines.
			return -1;
		}
	}
	revisions[owner] = (revisions[owner] ?? 0) + 1;
	try {
		writeFileSync(path, JSON.stringify(revisions, null, "\t") + "\n");
	} catch {
		// Sweep-3 G32: a FAILED write is NOT a phantom success — returning the
		// bumped number would let the jump proceed on an unrecorded revision (the
		// revision-gate fast-forward would then skip re-running the owner on
		// resume with a STALE revision). Return -1 so the caller declines, same
		// as the unreadable case.
		return -1;
	}
	return revisions[owner];
}

/** R2-10: is artifact-revisions.json readable (or absent)? Present-but-
 *  unreadable must decline BEFORE any mutation — bumping would either reset
 *  every counter (the old bug) or record a phantom revision. */
function revisionsReadable(specDir: string): boolean {
	const path = join(specDir, ARTIFACT_REVISIONS_FILE);
	if (!existsSync(path)) return true;
	try {
		JSON.parse(readFileSync(path, "utf8"));
		return true;
	} catch {
		return false;
	}
}

/**
 * Wrap the pipeline's children array in the addressable walker. The returned
 * node is a drop-in replacement for `sequence(children, { tolerant: true })`.
 */
export function withInlineRouteBack(children: Node[]): Node {
	return {
		kind: "routing-walker",
		id: "pipeline",
		async run(state: PipelineState, ctx: StageContext): Promise<NodeResult> {
			// Per-RUN budget window (review round-1 F-2/adv-F-3). NOTE: this runs
			// BEFORE setup (state.setup is empty here), so RESUME seeding cannot
			// happen at this seam — the setup stage re-seeds from the persisted
			// epoch file when it detects --resume (review round-1, both reviewers:
			// seeding here was dead code). This fresh default is immediately
			// superseded on resumed tracks.
			startRunEpoch();
			let pass = children;
			let jumps = 0;
			for (;;) {
				let signal: RouteBackSignal | undefined;
				let result: NodeResult;
				try {
					result = await sequence(pass, { tolerant: true }).run(state, ctx);
				} catch (err) {
					if (!isRouteBackSignal(err)) throw err; // ordinary abort — untouched
					if (!inlineRouteBackEnabled()) throw err; // kill-switch: no automatic route-back (M5 — the emulation fallback is retired)
					signal = err;
					result = { status: "failed", error: err.message };
				}
				if (!signal) return result;

				const cmd = signal.command;
				const setup = (state as { setup?: { specDirectory?: string; specIdentifier?: string } }).setup;
				const specDir = setup?.specDirectory;
				const idx = children.findIndex((n) => n?.id === cmd.to);
				// Fail-closed rethrow conditions: no spec dir, unaddressable owner,
				// overall cap, or a stale edge the journal says is exhausted
				// (defense-in-depth — the throw site already checked).
				const notTaken =
					specDir === undefined
						? "no spec dir"
						: idx < 0
							? `owner "${cmd.to}" not addressable in the walk`
							: jumps >= maxInlineJumps()
								? "inline-jump cap reached"
								: remainingBudget(persistedBudget(specDir), cmd.from, cmd.to) <= 0
									? "edge budget exhausted"
									: undefined;
				/** Decline with a DEGRADATION PATH (round-1 adv-F-1/code-F-4 shape,
				 *  M5-retired): consume any PERSISTED pending rows (the cross-run
				 *  resume record) via a restart; otherwise rethrow the signal (a
				 *  FatalAbort subclass, G2) — never a bare dead-end "failed" run. */
				const decline = async (why: string): Promise<never> => {
					ctx.log(`route-back ${cmd.from}→${cmd.to}: NOT taken inline (${why}) — M5: no automatic restart (pending-rows consumption is the only restart tier)`);
					try {
						if (specDir) appendRunEvent(specDir, { runId: ((state as Record<string, unknown>).__runId as string | undefined) ?? setup?.specIdentifier ?? "unknown", type: "route.declined", data: { from: cmd.from, to: cmd.to, reason: why } });
					} catch { /* best-effort */ }
					// M5: the create-new-requests emulation tier is RETIRED — routing
					// never triggers an automatic process restart anymore. The ONLY
					// remaining restart tier is the pending-rows consumption below
					// (replan-requests.json as the cross-run resume record: rows
					// persisted by an earlier/interrupted run).
					// R2-3: the emulation returns false when OUR OWN injected requests are
					// still PENDING (its dedupe suppresses them) — but pending rows are
					// exactly what a restart consumes at round 1, so the replan terminal
					// is still correct without double-persisting.
					if (specDir && pendingReplanRequests(specDir, cmd.to).length > 0) {
						ctx.log(`route-back ${cmd.from}→${cmd.to}: ${pendingReplanRequests(specDir, cmd.to).length} replan request(s) for ${cmd.to} already pending — restarting will inject them at round 1`);
						(state as Record<string, unknown>).__replan = {
							rounds: 1,
							owners: [cmd.to],
							source: "route-back-declined-pending",
						};
						throw new FatalAbort(`route-back declined (${why}); REPLAN at round cap — pending request(s) for ${cmd.to} await the restart; restarting to revise`);
					}
					throw signal; // emulation unavailable — the escalation surface owns it
				};
				if (notTaken !== undefined) await decline(notTaken);

				// MP1 ordered re-entry protocol (all sync, before the sub-walk).
				// Order (round-2 R2-1/R2-10): every FAILING check runs BEFORE any
				// persistent mutation — a declined jump must leave counters untouched.
				const dir = specDir as string;
				const invalidated = [cmd.to, ...downstreamOf(cmd.to)];
				// (a) revisions file must be readable BEFORE we touch it (R2-10):
				// unreadable-but-present → decline without resetting counters.
				if (!revisionsReadable(dir)) await decline("artifact-revisions.json present but unreadable");
				// (b) invalidate + B6 guard (mirrors replan's R4): the REAL call, then
				// a 0-drop result while matching rows still survive (write failure
				// inside the never-throw invalidator) is a FAILURE — a restart would
				// replay the stale suffix. Declines BEFORE the journal charge; the
				// conservative pre-charge mutations (none yet at this point) stay.
				const cacheDropped = invalidateResumeCache(dir, invalidated);
				if (cacheDropped === 0 && resumeCacheHasRowsFor(dir, invalidated)) {
					await decline("cache invalidation dropped 0 rows while matching rows survive (B6)");
				}
				// (c) findings → pending replan requests (v0.3.3 round-1 injection)
				// BEFORE the journal charge (R2-1): a crash between the two leaves at
				// worst pending requests (consumable by the emulation), never a
				// charged-but-unprompted jump.
				const ledgerFindings = getConvergenceLedger(state).findings
					.filter((f) => cmd.findingIds.includes(f.id))
					.map((f) => f as unknown as Record<string, unknown>);
				const injected = appendRouteBackRequests(
					dir,
					cmd.to,
					ledgerFindings,
					setup?.specIdentifier ?? "unknown",
				);
				if (injected < 0) await decline("request-injection write failed");
				// (d) only now: bump the owner's revision counter.
				const revisionAfter = bumpOwnerRevision(dir, cmd.to);
				if (revisionAfter < 0) await decline("artifact-revisions.json write failed");
				const entry = chargeRoutingJump(dir, {
					from: cmd.from,
					to: cmd.to,
					reason: cmd.reason,
					findingIds: cmd.findingIds,
					resumeFromIndex: idx + 1, // G3: forward walk resumes AFTER the owner
					invalidated,
					at: new Date().toISOString(), // journal IO layer may mint (MP3)
					cacheDropped,
					revisionAfter,
				});
				if (!entry) {
					await decline("journal write failed");
					throw signal; // unreachable (decline never returns) — narrows `entry`
				}
				try {
					appendRunEvent(dir, { runId: ((state as Record<string, unknown>).__runId as string | undefined) ?? setup?.specIdentifier ?? "unknown", type: "route.taken", data: { from: cmd.from, to: cmd.to, seq: entry.seq, budgetBefore: entry.budgetBefore, budgetAfter: entry.budgetAfter, resumeFromIndex: entry.resumeFromIndex } });
				} catch { /* best-effort */ }

				ctx.log(
					`route-back ${cmd.from}→${cmd.to}: jump ${entry.seq} (budget ${entry.budgetBefore}→${entry.budgetAfter}) — ${cmd.to} rev ${revisionAfter}, ${cacheDropped} cache row(s) dropped, ${injected} finding(s) injected; sub-walk re-enters at "${cmd.to}" (index ${idx})`,
				);

				pass = children.slice(idx); // owner re-converges, downstream re-runs
				jumps++;
			}
		},
	};
}
