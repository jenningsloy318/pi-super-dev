import { superDevEnv } from "../render/super-dev-dir.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveStreamHandle } from "../render/live-stream.js";
import type { RuntimeInstruction, RuntimeInstructionImage } from "../types.ts";

/** Wave 3 increment 3: the active-run VALUE machinery — the queued-input
 *  ActiveRun type + factory (push/drain/drainInstructions with the 20-input
 *  bound + the TUI ACK surfaces), the globalThis cross-instance run guard
 *  (v0.3.60 R3 / v0.3.61 token ownership), and the in-flight background-work
 *  registry (v0.3.86 F-16) — extracted from extension.ts verbatim. The module
 *  singletons (activeRun/inFlight) + their raw readers + the input-handler's
 *  normalizeInputImages/instructionForEntry STAY in extension.ts. One reason
 *  to change: active-run lifecycle values. */

/**
 * Phase 1 (AC-01 / AC-02 / AC-03) — Mid-run input injection run-state singleton.
 *
 * `activeRun` is the single module-scoped source of truth for "a super_dev run
 * is in progress." It is created on `execute()` entry (ctx stored on it) and
 * nulled in the existing execute() `finally` alongside the dashboard-widget
 * teardown, so run teardown and widget teardown stay unified (SCENARIO-002).
 *
 * The module-lifetime `pi.on("input", handler)` listener — registered
 * EXACTLY ONCE in `activate(pi)`, never per-run — reads this singleton to
 * decide {active-run + interactive}→handled / {else}→continue (AC-03), which
 * also prevents listener leaks across runs (AC-01 / SCENARIO-001).
 * v0.3.60 R1: migrated from the raw `pi.events.on` bus to the TYPED
 * `pi.on("input", …)` subscription (extensions.md canon) — same semantics,
 * compile-time InputEvent/InputEventResult contract.
 * v0.3.60 R7: `parent: <text>` is the mid-run escape hatch to the PARENT
 * agent (prefix stripped via {action:"transform"}); every other non-slash
 * interactive input during a run is still captured as specialist guidance.
 *
 * Phase 1 ships ONLY the queue mechanics + guards. ACK surfaces (status pill,
 * dashboard count, transcript LineKind) are added in Phase 2; the
 * `userSteerProvider` drain seam is wired in Phase 3.
 */
export interface ActiveRun {
	/** Pending mid-run user inputs not yet injected into a specialist prompt. */
	queue: RuntimeInstruction[];
	/** Preview of the most recent accepted instruction for native dashboard UI. */
	lastInstructionPreview?: string;
	/** The execute() ctx (TUI guards + ACK surfaces use this — Phase 2). */
	ctx?: ExtensionContext;
	/** The live-stream handle (Phase 2 ACK: pushes the user-input transcript
	 *  line). Optional so the Phase 1 idle-shape (no stream) still works. */
	stream?: LiveStreamHandle;
	/** Store interactive input. Empty/whitespace-only text is allowed only when images exist. */
	push(text: string, images?: RuntimeInstructionImage[], meta?: { source?: string; streamingBehavior?: "steer" | "followUp" }): RuntimeInstruction | null;
	/** Back-compat text-only drain for existing callers/tests. */
	drain(): string[];
	/** Atomically return the pending structured inputs AND clear the queue. */
	drainInstructions(): RuntimeInstruction[];
}


// v0.3.60 R3: cross-instance concurrency guard. Module state (activeRun,
// inFlight) resets when pi re-evaluates this module (/reload, session
// replacement), but a pipeline promise from the OLD instance keeps running
// in-process — a fresh instance would then accept a second run that
// interleaves with it. The guard lives on globalThis so it survives module
// re-evaluation; the run's own finally clears it. SUPER_DEV_ALLOW_OVERLAP=1
// is the mechanical escape hatch (P4: guard + honest refusal, not advice).
const RUN_GUARD_KEY = "__superDevActiveRunGuard";
/** v0.3.61: `token` is the owning run's identity — a run's finally may only
 *  release a guard it set itself (under SUPER_DEV_ALLOW_OVERLAP=1 a later
 *  overlapping run must not delete an earlier run's still-live guard). */
export interface ActiveRunGuard { startedAt: string; runDir?: string; token?: string }
export function getRunGuard(): ActiveRunGuard | undefined {
	return (globalThis as Record<string, unknown>)[RUN_GUARD_KEY] as ActiveRunGuard | undefined;
}
/** Pure overlap check (tests + the execute() refusal path): the honest
 *  refusal message when the cross-instance guard is held and no escape
 *  hatch is set, null when a run may start. */
export function runGuardRefusal(): string | null {
	const guard = getRunGuard();
	if (!guard) return null;
	// v0.3.61: via superDevEnv so the config.json env map honors it too (the
	// v0.3.15 persistent-tunable contract; raw process.env read left GUI sessions
	// with no working escape hatch — the review P1).
	if (superDevEnv("SUPER_DEV_ALLOW_OVERLAP") === "1") return null;
	return `a super-dev run started ${guard.startedAt} is still active${guard.runDir ? ` (run dir: ${guard.runDir})` : ""} — it may be orphaned by a /reload or still finishing. Wait for it, resume it, or set SUPER_DEV_ALLOW_OVERLAP=1 to force a new run.`;
}

// v0.3.60 R9: the in-flight reflection promise (runReflectionAsync now returns
// it) plus its run dir, so session_shutdown can NAME a dropped reflection
// (P10: discards are named) instead of losing it silently.
// v0.3.61: a Set/Map of pending reflections (promise → run dir) — the v0.3.60
// single slot went blind to run A's still-pending reflection once run B
// overwrote and settled it, so shutdown under-reported drops.
// v0.3.86 F-16: the registry is a generic in-flight BACKGROUND-WORK registry
// (promise → { runDir, kind }) — the detached auto post-mortem registers with
// kind "post-mortem" so a teardown names IT too instead of severing the child
// agent silently. Reflections keep their exact historical message wording.
interface InFlightBackgroundWork {
	runDir: string;
	kind: "reflection" | "post-mortem";
}
const pendingReflections = new Map<Promise<unknown>, InFlightBackgroundWork>();

/** Bound on queued mid-run inputs so a single specialist spawn cannot be
 *  token-bombed via a huge guidance prepend. Older entries are dropped first
 *  (most-recent guidance wins — it reflects the user's latest intent). */
const MAX_QUEUED_INPUTS = 20;

/** Phase 2 (AC-04 / SCENARIO-008): ellipsize the queued-input preview to ~60
 *  chars so the status pill stays one line even for long user messages. */
function previewInput(text: string, max = 60): string {
	const t = String(text ?? "");
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

let instructionSeq = 0;
function createInstructionId(): string {
	instructionSeq += 1;
	return `ui-${Date.now().toString(36)}-${instructionSeq.toString(36)}`;
}


/** Factory for the module-scoped ActiveRun (fresh queue per run — no leak).
 *  Phase 2 adds the optional `stream` arg so push() can reach the live-stream's
 *  `userInput` sink; omitting it preserves Phase 1 behavior (queue + no ACK). */
export function createActiveRun(ctx?: ExtensionContext, stream?: LiveStreamHandle): ActiveRun {
	return {
		queue: [],
		ctx,
		stream,
		push(text: string, images: RuntimeInstructionImage[] = [], meta: { source?: string; streamingBehavior?: "steer" | "followUp" } = {}): RuntimeInstruction | null {
			const t = String(text ?? "").trim();
			const normalizedImages = Array.isArray(images) ? images : [];
			if (!t && normalizedImages.length === 0) return null;
			const instruction: RuntimeInstruction = {
				id: createInstructionId(),
				createdAt: new Date().toISOString(),
				text: t,
				source: meta.source,
				streamingBehavior: meta.streamingBehavior,
				images: normalizedImages,
			};
			this.queue.push(instruction);
			// Bound the queue: drop the oldest entry when over capacity so a single
			// specialist spawn can't be token-bombed (most-recent guidance wins).
			if (this.queue.length > MAX_QUEUED_INPUTS) this.queue.shift();
			const imageSuffix = normalizedImages.length ? ` + ${normalizedImages.length} image(s)` : "";
			const preview = t || "(image/content attachment)";
			this.lastInstructionPreview = `${preview}${imageSuffix}`;
			if (this.ctx?.mode === "tui" && this.stream) {
				try { this.ctx?.ui?.setStatus?.("super-dev-input", `📥 accepted: ${previewInput(preview)}${imageSuffix}`); } catch { /* best-effort */ }
				try { this.stream.sink.userInput(`${instruction.id}: ${preview}${imageSuffix} — queued for next checkpoint`); } catch { /* best-effort */ }
			}
			return instruction;
		},
		drain(): string[] {
			return this.drainInstructions().map((instruction) => instruction.text);
		},
		drainInstructions(): RuntimeInstruction[] {
			// Atomic return-and-clear. A second drain returns [] until new input
			// arrives, so each captured input is injected exactly once.
			const out = this.queue;
			this.queue = [];
			return out;
		},
	};
}


/** v0.3.60 R3: single write path for the cross-instance run guard. doRun sets
 *  it with the fresh run dir after startRun() and clears it in its finally. */
export function setRunGuard(guard: ActiveRunGuard | undefined): void {
	if (guard) (globalThis as Record<string, unknown>)[RUN_GUARD_KEY] = guard;
	else delete (globalThis as Record<string, unknown>)[RUN_GUARD_KEY];
}

/** v0.3.61: ownership-aware release — a run may only clear a guard it set
 *  itself. Under SUPER_DEV_ALLOW_OVERLAP=1 an overlapping later run's finally
 *  must NOT delete an earlier run's still-live guard (review P2). Tokenless
 *  guards (legacy test fixtures) stay releasable by anyone. */
export function releaseRunGuard(token: string): void {
	const guard = getRunGuard();
	if (!guard?.token || guard.token === token) setRunGuard(undefined);
}

/** v0.3.60 R9: single write path registering in-flight background work so
 *  session_shutdown can NAME it when a teardown drops it. v0.3.61: a Map of
 *  pending entries (promise → { runDir, kind }), not a single slot — overlapping
 * entries are all reported; each entry SELF-CLEARS when its work settles, so
 * only genuinely-pending work is ever reported as dropped (P10: no false
 * alarms). v0.3.86 F-16: `kind` labels the entry ("reflection" default;
 * "post-mortem" for the auto post-mortem) so the drop line names WHAT was
 * dropped. */
export function noteInFlightReflection(runDir: string | undefined, reflection: Promise<unknown> | undefined, kind: InFlightBackgroundWork["kind"] = "reflection"): void {
	if (!runDir || !reflection) return;
	let tracked: Promise<unknown> | undefined;
	tracked = reflection.finally(() => {
		if (tracked) pendingReflections.delete(tracked);
	});
	pendingReflections.set(tracked, { runDir, kind });
	void tracked.catch(() => { /* the work reports its own failures */ });
}

/** Drain-and-clear view for the shutdown path (reports every still-pending
 *  entry; the caller clears after reporting — the wave-3 extraction seam). */
export function pendingBackgroundWork(): Array<[Promise<unknown>, { runDir: string; kind: "reflection" | "post-mortem" }]> {
	return [...pendingReflections.entries()];
}

export function clearPendingBackgroundWork(): void {
	pendingReflections.clear();
}
