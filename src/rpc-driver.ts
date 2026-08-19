/**
 * RpcDriver — the event-protocol core for `pi --mode rpc` subprocess agents
 * (v0.2.10 W1).
 *
 * Verified live on this machine (pi 0.84.x): a second `prompt` (or
 * `follow_up`) event delivered over stdin lands as the NEXT TURN of the SAME
 * in-memory session — turn 2 starts from the agent's own completed reading
 * (the FALCON probe recalled a turn-1 secret verbatim). That is the primitive
 * the corrective retry was always missing: today a missing control object
 * triggers a FRESH `pi` process which has no memory of the work it just did
 * (the pi-omisis Phase-2 3×29s narration loops; the track-29 dogfood death).
 *
 * The driver owns ONLY protocol state: writing events, correlating
 * id-matched `{"type":"response"}` acks, capturing the LAST NON-EMPTY
 * assistant text from `message_end` events, and surfacing every other event
 * to a caller hook (for live-progress rendering). Spawning, killing, and
 * timeouts stay with the caller (pi-spawn.ts) so this stays unit-testable
 * against synthetic NDJSON lines with no child process.
 */

export interface RpcTurnResult {
	text: string;
	model?: string;
	/** Set when the turn ended abnormally (response not received before the
	 *  per-turn budget expired, or the server answered success:false). */
	error?: string;
}

interface PendingTurn {
	resolve: (result: RpcTurnResult) => void;
	timer: ReturnType<typeof setTimeout>;
	/** settledCount when the request was written — the turn is complete only
	 *  at an agent_settled STRICTLY AFTER this generation. */
	genAtSend: number;
	/** The id-matched `response` ack arrived (command accepted). Verified live:
	 *  pi emits the response ack BEFORE agent_start — it is NOT a completion
	 *  signal, only acceptance. */
	acked: boolean;
}

export interface RpcDriverDeps {
	/** Write one NDJSON line (JSON object, no trailing newline needed) to the
	 *  child's stdin. */
	write: (line: string) => void;
	/** Every parsed event that is neither an assistant message_end nor an
	 *  id-matched response — for progress rendering in the caller. */
	onRawEvent?: (event: Record<string, unknown>) => void;
}

export class RpcDriver {
	private readonly deps: RpcDriverDeps;
	private nextId = 0;
	private lastText = "";
	private lastModel: string | undefined;
	private readonly pending = new Map<string, PendingTurn>();
	/** Monotonic count of agent_settled events seen — the authoritative
	 *  turn-completion signal (response acks arrive before the turn runs). */
	private settledCount = 0;
	private disposed = false;

	constructor(deps: RpcDriverDeps) {
		this.deps = deps;
	}

	/** The last non-empty assistant text seen so far (never overwritten by an
	 *  empty trailing tool-call turn — same contract as the json-mode parser). */
	get currentText(): string {
		return this.lastText;
	}

	get currentModel(): string | undefined {
		return this.lastModel;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** Feed one raw NDJSON line from the child's stdout. Never throws. */
	ingest(rawLine: string): void {
		const trimmed = rawLine.trim();
		if (!trimmed) return;
		let event: Record<string, unknown>;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
			event = parsed as Record<string, unknown>;
		} catch {
			return;
		}
		const type = event.type;
		if (type === "message_end") {
			const message = event.message as { role?: string; model?: string; content?: Array<{ type: string; text?: string }> } | undefined;
			if (message?.role === "assistant") {
				const text = (message.content ?? [])
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text as string)
					.join("");
				if (text) {
					this.lastText = text;
					if (message.model) this.lastModel = message.model;
				}
			}
			return;
		}
		if (type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (pending) {
				pending.acked = true;
				if (event.success === false) {
					// Rejected up front — resolve immediately with the failure.
					this.pending.delete(event.id);
					clearTimeout(pending.timer);
					pending.resolve({ text: this.lastText, model: this.lastModel, error: `rpc response for ${event.id} reported failure` });
				} else {
					this.maybeComplete(event.id, pending);
				}
			}
			return;
		}
		if (type === "agent_settled") {
			this.settledCount++;
			for (const [id, pending] of this.pending) this.maybeComplete(id, pending);
			return;
		}
		this.deps.onRawEvent?.(event);
	}

	/** Complete a pending turn only when BOTH signals arrived: the id-matched
	 *  response ack AND an agent_settled strictly after the request generation. */
	private maybeComplete(id: string, pending: PendingTurn): void {
		if (!pending.acked || this.settledCount <= pending.genAtSend) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.resolve({ text: this.lastText, model: this.lastModel });
	}

	/** Send a prompt/follow_up event and wait for its id-matched response ack.
	 *  Resolves with the captured text at ack time. A per-turn timeout resolves
	 *  with an error result instead of hanging (the caller owns killing).
	 *  NOTE: production code always sends `prompt` ("follow_up" after settle
	 *  is acked-but-never-runs, per the probe-verified deviation); the kind
	 *  union is kept so tests can pin both event shapes. */
	send(kind: "prompt" | "follow_up", message: string, timeoutMs: number): Promise<RpcTurnResult> {
		if (this.disposed) return Promise.resolve({ text: this.lastText, model: this.lastModel, error: "rpc driver disposed" });
		const id = `sd${++this.nextId}`;
		return new Promise<RpcTurnResult>((resolve) => {
			const genAtSend = this.settledCount;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ text: this.lastText, model: this.lastModel, error: `rpc turn ${id} timed out after ${timeoutMs}ms without completing (ack+settled)` });
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (result) => resolve(result),
				timer,
				genAtSend,
				acked: false,
			});
			try {
				this.deps.write(JSON.stringify({ id, type: kind, message }));
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				resolve({ text: this.lastText, model: this.lastModel, error: `rpc write failed: ${error instanceof Error ? error.message : String(error)}` });
			}
		});
	}

	/** Stop accepting/serving turns. In-flight waiters resolve with an error. */
	dispose(reason = "disposed"): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.resolve({ text: this.lastText, model: this.lastModel, error: `rpc driver disposed before response (${reason}; ${id})` });
		}
	}
}
