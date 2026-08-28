import { describe, expect, it, vi } from "vitest";

/**
 * v0.3.25 L3 — runtime agent registration with pi-subagents.
 *
 * super-dev's specialists (agents/*.md) register as first-class pi-subagents
 * agents through the process-local `pi-subagents:runtime-agent-register:v1`
 * event contract, so the structured-delegation backend can execute them and
 * they appear in agent discovery. No runtime import of pi-subagents — the
 * event payload carries the result slot.
 */

import { registerSuperDevAgents, READ_ONLY_AGENTS, READ_ONLY_TOOLS, WRITER_TOOLS } from "../src/agents/register-agents.ts";

class RecordingBus {
	readonly emitted: Array<{ channel: string; payload: any }> = [];
	on(_channel: string, _handler: (payload: unknown) => void): unknown { return () => {}; }
	emit(channel: string, payload: unknown): void { this.emitted.push({ channel, payload }); }
}

/** The contract shape: handler writes request.result synchronously. */
function makeOwnerBus(accepted: string[] = []): { bus: RecordingBus; requests: any[] } {
	const requests: any[] = [];
	const bus: any = {
		emitted: [] as Array<{ channel: string; payload: any }>,
		on(channel: string, handler: (payload: unknown) => void) {
			// simulate pi-subagents: only listen on the registration channel
			if (channel === "pi-subagents:runtime-agent-register:v1") {
				this.handler = handler;
			}
			return () => { if (this.handler === handler) this.handler = undefined; };
		},
		emit(channel: string, payload: any) {
			this.emitted.push({ channel, payload });
		},
		deliver(payload: any) {
			// the owner validates synchronously and writes the result
			const request = payload;
			requests.push(request);
			if (!request.version || !request.name || !request.definition?.systemPrompt) {
				request.result = { ok: false, error: new Error("malformed registration") };
			} else if (accepted.includes(request.name)) {
				request.result = { ok: false, error: new Error(`agent name '${request.name}' already registered`) };
			} else {
				accepted.push(request.name);
				request.result = { ok: true, registration: { dispose: () => { const i = accepted.indexOf(request.name); if (i >= 0) accepted.splice(i, 1); } } };
			}
			this.handler?.(request);
		},
	};
	return { bus, requests };
}

describe("registerSuperDevAgents", () => {
	it("all 32 registrations pass pi-subagents' strict systemPrompt validator — no leading/trailing whitespace (run 2026-08-28T15-50-08: 30/32 rejected on trailing newline)", () => {
		// Mirror pi-subagents validateString: "a non-empty string without leading
		// or trailing whitespace". v0.3.25 shipped untrimmed .md bodies, so only
		// the 2 files that happened to end without a newline survived.
		const accepted: string[] = [];
		const requests: any[] = [];
		const bus: any = {
			on() { return () => {}; },
			emit(_channel: string, payload: any) {
				const req = payload;
				requests.push(req);
				const sp = req.definition?.systemPrompt;
				if (typeof sp !== "string" || sp.length === 0 || sp !== sp.trim()) {
					req.result = { ok: false, error: new Error("systemPrompt must be a non-empty string without leading or trailing whitespace") };
				} else {
					accepted.push(req.name);
					req.result = { ok: true, registration: { dispose() {} } };
				}
			},
		};
		registerSuperDevAgents(bus);
		const rejected = requests.filter((r) => r.result && !r.result.ok);
		expect(rejected).toEqual([]);
		expect(accepted.length).toBe(requests.length);
		expect(accepted.length).toBe(29); // REGISTERED_AGENTS (32 .md files exist; 3 are not registered)
		// every emitted systemPrompt is trim-clean by itself (belt and braces)
		for (const r of requests) expect(r.definition.systemPrompt).toBe(r.definition.systemPrompt.trim());
	});

	it("emits registration requests even with no owner listening — silent skip, no crash", () => {
		const { bus } = makeOwnerBus();
		const dispose = registerSuperDevAgents(bus as any);
		// emits went out; the non-listening owner wrote no result → all skipped
		expect(bus.emitted.length).toBeGreaterThan(0);
		expect(typeof dispose).toBe("function");
		dispose();
	});

	it("the emitted registrations are well-formed (version, name, description, systemPrompt, tools)", () => {
		const { bus, requests } = makeOwnerBus();
		// auto-deliver mode: emit() forwards to the owner handler
		const autoBus: any = bus;
		autoBus.emit = (channel: string, payload: any) => {
			autoBus.emitted.push({ channel, payload });
			autoBus.deliver?.(payload);
		};
		const dispose = registerSuperDevAgents(autoBus);
		expect(requests.length).toBeGreaterThan(15);
		for (const request of requests) {
			expect(request.version).toBe(1);
			expect(String(request.name)).toMatch(/^sd-[a-z0-9-]+$/);
			expect(typeof request.definition.description).toBe("string");
			expect(request.definition.description.length).toBeGreaterThan(10);
			expect(typeof request.definition.systemPrompt).toBe("string");
			expect(request.definition.systemPrompt.length).toBeGreaterThan(40);
			expect(Array.isArray(request.definition.tools)).toBe(true);
			expect(request.result?.ok).toBe(true);
		}
		// spot-check our key specialists are all present
		const names = requests.map((r) => String(r.name));
		for (const expected of ["sd-judge", "sd-implementer", "sd-spec-writer", "sd-requirements-reviewer", "sd-tdd-guide", "sd-red-boundary-classifier"]) {
			expect(names).toContain(expected);
		}
		dispose();
	});

	it("read-only agents get the read-only tool set; writers get edit/write", () => {
		const { bus, requests } = makeOwnerBus();
		const autoBus: any = bus;
		autoBus.emit = (channel: string, payload: any) => { autoBus.emitted.push({ channel, payload }); autoBus.deliver?.(payload); };
		registerSuperDevAgents(autoBus);
		const byName = new Map(requests.map((r) => [String(r.name), r.definition.tools as string[]]));
		expect(byName.get("sd-judge")).toEqual(READ_ONLY_TOOLS);
		expect(byName.get("sd-requirements-reviewer")).toEqual(READ_ONLY_TOOLS);
		expect(byName.get("sd-implementer")).toEqual(WRITER_TOOLS);
		expect(byName.get("sd-spec-writer")).toEqual(WRITER_TOOLS);
		// writers may edit; read-only agents never may
		expect(byName.get("sd-judge")).not.toContain("edit");
		expect(byName.get("sd-implementer")).toContain("edit");
	});

	it("READ_ONLY_AGENTS covers the reviewer/judge/classifier family", () => {
		for (const name of ["judge", "requirements-reviewer", "bdd-reviewer", "design-reviewer", "spec-reviewer", "code-reviewer", "adversarial-reviewer", "task-classifier", "requirements-clarifier", "red-boundary-classifier", "tdd-coverage-classifier", "code-assessor", "debug-analyzer", "reflection", "replan-lead"]) {
			expect(READ_ONLY_AGENTS.has(name)).toBe(true);
		}
		for (const writer of ["implementer", "spec-writer", "bdd-scenario-writer", "tdd-guide", "docs-executor", "orchestrator"]) {
			expect(READ_ONLY_AGENTS.has(writer)).toBe(false);
		}
	});

	it("is idempotent across double activation (re-register attempts are tolerated, not thrown)", () => {
		const accepted: string[] = [];
		const { bus } = makeOwnerBus(accepted);
		const autoBus: any = bus;
		autoBus.emit = (channel: string, payload: any) => { autoBus.emitted.push({ channel, payload }); autoBus.deliver?.(payload); };
		expect(() => {
			const d1 = registerSuperDevAgents(autoBus);
			const d2 = registerSuperDevAgents(autoBus);
			d1();
			d2();
		}).not.toThrow();
	});

	it("a missing owner (no result written) is a silent no-op, never a crash", () => {
		const silent: any = {
			on: () => () => {},
			emit: () => {},
		};
		expect(() => registerSuperDevAgents(silent)).not.toThrow();
		const dispose = registerSuperDevAgents(silent);
		expect(typeof dispose).toBe("function");
	});
});
