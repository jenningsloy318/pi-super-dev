import type { ActiveRun } from "./run-state.ts";
import type { RuntimeInstructionImage, RuntimeInstruction } from "../types.ts";

/** Wave 3 increment 5: the pi event-handler adjudicators — the mid-run input
 *  capture (AC-01/AC-03/SCENARIO-004/006: the {active-run + interactive}→handled
 *  invariant, slash pass-through, the parent: transform escape) and the
 *  idempotent session_shutdown honesty report (the in-flight run dir + the
 *  dropped background-work lines + the registration dispose) — extracted from
 *  extension.ts verbatim. One reason to change: pi lifecycle event policy. */

function normalizeInputImages(images: unknown): RuntimeInstructionImage[] {
	return Array.isArray(images) ? images as RuntimeInstructionImage[] : [];
}

export function instructionForEntry(instruction: RuntimeInstruction): RuntimeInstruction {
	return {
		...instruction,
		images: (instruction.images ?? []).map((image) => ({
			mediaType: image.mediaType,
			path: image.path,
			label: image.label,
		})),
	};
}

export type InputEventShape = { source?: string; text?: unknown; images?: unknown; streamingBehavior?: "steer" | "followUp" };
export type InputEventResult = { action: "continue" } | { action: "handled"; instruction: RuntimeInstruction | null; queued: number } | { action: "transform"; text: string };

/** The input adjudication — pure over (activeRun, event). The caller wires
 *  pi.on("input", ...) and owns the appendEntry telemetry. */
export function adjudicateInputEvent(activeRun: ActiveRun | null, event: InputEventShape | undefined): InputEventResult {
	try {
		// idle (no run in progress) → pi owns the input entirely.
		if (activeRun == null) return { action: "continue" };
		// non-interactive sources (rpc/extension/print/json/headless) are never
		// captured — they flow through pi byte-identical to today.
		if (event?.source !== "interactive") return { action: "continue" };
		// Slash-commands pass through so /reload, /model, etc.
		// still work during a run. Everything else typed during an active run is
		// captured as mid-run user context: it is drained + persisted into
		// .user-notes.json and injected into EVERY subsequent stage (durable,
		// resume-safe). Returning {handled} tells pi NOT to also queue it as a normal turn.
		// Coerce safely so a missing/blank `text` can never crash the handler.
		const text = typeof event?.text === "string" ? event.text : "";
		if (text.trimStart().startsWith("/")) return { action: "continue" };
		// v0.3.60 R7: `parent: <text>` escapes run-scoped capture and flows to
		// the PARENT agent with the prefix stripped ({action:"transform"}) —
		// the user keeps a control channel mid-run without disabling capture.
		const trimmed = text.trimStart();
		if (trimmed.startsWith("parent:")) {
			const toParent = trimmed.slice("parent:".length).trim();
			if (!toParent) return { action: "continue" };
			return { action: "transform", text: toParent };
		}
		const instruction = activeRun.push(text, normalizeInputImages(event?.images), { source: event?.source, streamingBehavior: event?.streamingBehavior });
		// The caller owns the appendEntry telemetry (best-effort); the payload
		// rides the result so the capture invariant stays unit-pinnable here.
		return { action: "handled", instruction: instruction ?? null, queued: activeRun.queue.length };
	} catch {
		return { action: "continue" };
	}
}
/** The session_shutdown honesty report — verbatim from extension.ts: the
 *  in-flight run line (run dir from the guard), one DROPPED line per pending
 *  background-work entry, appendEntry + console.error per line, then the
 *  registration dispose. Never throws. */
export interface ShutdownDeps {
	inFlight: boolean;
	activeRun: { queue: unknown[] } | null;
	getRunGuard: () => { runDir?: string } | undefined;
	pendingBackgroundWork: () => Array<[Promise<unknown>, { runDir: string; kind: string }]>;
	clearPendingBackgroundWork: () => void;
	disposeAgents: (() => void) | undefined;
}
export function reportSessionShutdown(
	pi: { appendEntry?: (kind: string, data: Record<string, unknown>) => void },
	event: { reason?: string },
	deps: ShutdownDeps,
): void {
	const honest: string[] = [];
	if (deps.inFlight && deps.activeRun) {
		const dir = deps.getRunGuard()?.runDir ?? "unknown";
		honest.push(`a super-dev run is STILL IN FLIGHT (run dir: ${dir}) — the pipeline keeps running headlessly in this process and writes results to its run.log; inspect or resume it via /super-dev with resume:true`);
	}
	for (const [promise, entry] of deps.pendingBackgroundWork()) {
		honest.push(`post-run ${entry.kind} for ${entry.runDir} was in flight and is DROPPED by session_shutdown (reason: ${event.reason})`);
		void promise.catch(() => { /* reported, not awaited */ });
	}
	deps.clearPendingBackgroundWork();
	for (const line of honest) {
		try { pi.appendEntry?.("super-dev-shutdown", { line, reason: event.reason }); } catch { /* best-effort */ }
		try { console.error(`[super-dev] ${line}`); } catch { /* best-effort */ }
	}
	try { deps.disposeAgents?.(); } catch { /* best-effort */ }
}
