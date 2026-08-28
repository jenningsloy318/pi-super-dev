/**
 * v0.3.25 L1 — FleetView visibility for super-dev agent calls via
 * pi-subagents' external-runs registry ("External jobs in FleetView",
 * docs/extension-api.md): display-only records owned by THIS extension.
 *
 * The registry lives in pi-subagents' module state, so sharing it requires
 * importing the SAME module instance the installed pi-subagents loaded. We
 * resolve it lazily by candidate path (a real dependency first, then the
 * known pi install roots). Everything here is best-effort by contract: a
 * missing install, a failed import, or a throwing registry is a silent no-op
 * — visibility must NEVER affect pipeline execution.
 */

export type ExternalRunState = "queued" | "running" | "completed" | "failed" | "stopped";

/** The structural slice of pi-subagents/external-runs we consume. */
export interface ExternalRunsModule {
	registerExternalRun(input: {
		id: string;
		sessionId: string;
		source: string;
		label: string;
		state: ExternalRunState;
		startedAt: number;
		currentAction?: string;
	}): unknown;
	updateExternalRun(sessionId: string, id: string, update: {
		state?: ExternalRunState;
		currentAction?: string;
		preview?: string;
		endedAt?: number;
	}): unknown;
	unregisterExternalRun(sessionId: string, id: string): boolean;
}

const CANDIDATE_EXPORTS = [
	"pi-subagents/external-runs",
];

const CANDIDATE_PATHS = (): string[] => {
	const home = process.env.HOME ?? "";
	const roots = [
		home ? `${home}/.pi/agent/npm/node_modules/pi-subagents/src/api/external-runs.ts` : "",
		process.env.PI_SUBAGENTS_ROOT ? `${process.env.PI_SUBAGENTS_ROOT}/src/api/external-runs.ts` : "",
	].filter(Boolean) as string[];
	return roots;
};

let cached: ExternalRunsModule | null | undefined;

/** Resolve the external-runs module (cached; `force` re-resolves — test
 *  seam). null when unavailable — the wrappers then no-op. Never throws. */
export async function resolveExternalRunsModule(extraCandidates: string[] = [], force = false): Promise<ExternalRunsModule | null> {
	if (cached !== undefined && !force) return cached;
	const candidates = [...extraCandidates, ...CANDIDATE_EXPORTS.map((e) => {
		try { return import.meta.resolve?.(e) ?? ""; } catch { return ""; }
	})].filter(Boolean);
	for (const spec of [...candidates, ...CANDIDATE_PATHS()]) {
		try {
			const mod = (await import(/* @vite-ignore */ spec)) as Partial<ExternalRunsModule>;
			if (typeof mod.registerExternalRun === "function" && typeof mod.updateExternalRun === "function") {
				cached = mod as ExternalRunsModule;
				return cached;
			}
		} catch { /* try next candidate */ }
	}
	cached = null;
	return null;
}

/** Test/injection seam: pre-resolve the module (or force-disable). */
export function setExternalRunsModuleForTesting(mod: ExternalRunsModule | null): void {
	cached = mod;
}

const THROTTLE_MS = 1_000;
const lastUpdateAt = new Map<string, number>();

function safe(fn: () => unknown): void {
	try { fn(); } catch { /* best-effort by contract */ }
}

/** Register a running external run for one agent call. Returns a no-op stop
 *  handle (used on settle). Safe with a null module. */
export function fleetBegin(
	mod: ExternalRunsModule | null,
	input: { sessionId: string; id: string; label: string; source?: string },
): () => void {
	if (!mod) return () => {};
	safe(() => {
		mod.registerExternalRun({
			id: input.id,
			sessionId: input.sessionId,
			source: input.source ?? "super-dev",
			label: input.label.slice(0, 160),
			state: "running",
			startedAt: Date.now(),
		});
	});
	return () => fleetFinish(mod, input.sessionId, input.id, { state: "stopped" });
}

/** Throttled currentAction update (default 1/s — the Fleet UI polls, not
 *  streams; hammering the registry wastes cycles). */
export function fleetUpdate(
	mod: ExternalRunsModule | null,
	sessionId: string,
	id: string,
	action: string,
): void {
	if (!mod || !action) return;
	const now = Date.now();
	const last = lastUpdateAt.get(id) ?? 0;
	if (now - last < THROTTLE_MS) return;
	lastUpdateAt.set(id, now);
	safe(() => mod.updateExternalRun(sessionId, id, { currentAction: action.slice(0, 160), state: "running" }));
}

/** Terminal record + unregister (the registry is a bounded cache; terminal
 *  rows are display history we do not need to retain). */
export function fleetFinish(
	mod: ExternalRunsModule | null,
	sessionId: string,
	id: string,
	terminal: { state: ExternalRunState; preview?: string },
): void {
	if (!mod) return;
	lastUpdateAt.delete(id);
	safe(() => mod.updateExternalRun(sessionId, id, {
		state: terminal.state,
		...(terminal.preview ? { preview: terminal.preview.slice(0, 4_000) } : {}),
		endedAt: Date.now(),
	}));
	safe(() => mod.unregisterExternalRun(sessionId, id));
}
