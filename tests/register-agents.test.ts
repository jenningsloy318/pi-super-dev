import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * v0.3.25 L3 — runtime agent registration with pi-subagents.
 *
 * super-dev's specialists (agents/*.md) register as first-class pi-subagents
 * agents through the process-local `pi-subagents:runtime-agent-register:v1`
 * event contract, so the structured-delegation backend can execute them and
 * they appear in agent discovery. No runtime import of pi-subagents — the
 * event payload carries the result slot.
 */

import { registerSuperDevAgents, registerSuperDevAgentsDeferred, READ_ONLY_AGENTS, READ_ONLY_TOOLS, WRITER_TOOLS } from "../src/agents/register-agents.ts";
import { resetAmbientSkillsForcedForTests } from "../src/agents/agent-runtime.ts";

/** v0.3.76 dual-review R1/AR-2: registration reads config.agentSkills via
 * getConfig() — deterministic in-file mock (mutable holder; other exports
 * stay real so superDevEnv/skillsEnabled keep their real resolution). */
const configHolder: { config: Record<string, unknown> } = { config: {} };
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return { ...real, getConfig: () => configHolder.config };
});

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
		expect(accepted.length).toBe(30); // REGISTERED_AGENTS (33 .md files exist; 3 are not registered)
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

	describe("v0.3.82 — allTools boolean mode unpins the allowlist (read-only posture kept via excludeTools)", () => {
	// NOTE: this file mocks agent-runtime's configExtensionToolsForAgent with
	// configExtStub — the wildcard drives THROUGH the stub here (registration
	// wiring); the mechanical tool-index merge is tested for real in
	// tests/config-extensions.test.ts.
	beforeEach(() => { configExtStub.tools = []; configExtStub.entries = []; configHolder.config = {}; });

	/** v0.3.82: auto-delivering bus — registrations complete synchronously. */
	const autoBus = (requests: any[]): any => {
		let handler: ((payload: unknown) => void) | undefined;
		const bus: any = {
			on(channel: string, h: (payload: unknown) => void) {
				if (channel === "pi-subagents:runtime-agent-register:v1") handler = h;
				return () => { if (handler === h) handler = undefined; };
			},
			emit(_channel: string, payload: any) {
				requests.push(payload);
				if (!payload.version || !payload.name || !payload.definition?.systemPrompt) {
					payload.result = { ok: false, error: new Error("malformed registration") };
				} else {
					payload.result = { ok: true, registration: { dispose() {} } };
				}
				handler?.(payload);
			},
		};
		return bus;
	};

	it("allTools mode → definition omits the tools pin entirely (all tools incl. every mcp__* direct tool)", () => {
		configHolder.config = { allTools: true };
		const requests: any[] = [];
		registerSuperDevAgents(autoBus(requests) as never);
		expect(requests.length).toBeGreaterThan(20);
		expect(requests.find((r) => r.name === "sd-spec-reviewer").definition.tools).toBeUndefined();
		expect(requests.find((r) => r.name === "sd-implementer").definition.tools).toBeUndefined();
	});

	it("read-only roles under allTools keep their posture: excludeTools pins the write family + powershell + super_dev", () => {
		configHolder.config = { allTools: true };
		const requests: any[] = [];
		registerSuperDevAgents(autoBus(requests) as never);
		expect([...requests.find((r) => r.name === "sd-spec-reviewer").definition.excludeTools ?? []].sort()).toEqual(["edit", "powershell", "super_dev", "write"]);
		// v0.3.82 review fix (code-F3/adv-F5): writers keep the recursion guard too —
		// unpinned ambient children load pi-super-dev itself (active super_dev tool).
		expect([...requests.find((r) => r.name === "sd-implementer").definition.excludeTools ?? []].sort()).toEqual(["powershell", "super_dev"]);
	});

	it("agentAllTools per-role unpins that role only", () => {
		configHolder.config = { agentAllTools: { "spec-reviewer": true } };
		const requests: any[] = [];
		registerSuperDevAgents(autoBus(requests) as never);
		expect(requests.find((r) => r.name === "sd-spec-reviewer").definition.tools).toBeUndefined();
		expect((requests.find((r) => r.name === "sd-code-reviewer").definition.tools as string[]).length).toBeGreaterThan(0);
	});

	it("non-wildcard list keeps today's exact-merge pin (regression)", () => {
		configExtStub.tools = ["lsp_diagnostics"];
		const requests: any[] = [];
		registerSuperDevAgents(autoBus(requests) as never);
		const tools = requests.find((r) => r.name === "sd-spec-reviewer").definition.tools as string[];
		expect(tools).toContain("lsp_diagnostics");
		expect(tools).toContain("read");
		expect(requests.find((r) => r.name === "sd-spec-reviewer").definition.excludeTools).toBeUndefined();
	});

	it("empty stub (mechanical classifiers resolve []) → classic role pin", () => {
		configExtStub.tools = [];
		const requests: any[] = [];
		registerSuperDevAgents(autoBus(requests) as never);
		const tools = requests.find((r) => r.name === "sd-spec-reviewer").definition.tools as string[];
		expect(tools).toEqual([...READ_ONLY_TOOLS]);
	});
});

describe("v0.3.59 — skills are a capability on the delegation backend too (cross-backend parity, v0.2.10 W4)", () => {
		beforeEach(() => { resetAmbientSkillsForcedForTests(); });
		afterEach(() => { resetAmbientSkillsForcedForTests(); });

		/** Auto-delivering bus: emit() forwards to the simulated owner handler. */
		function makeAutoBus() {
			const { bus, requests } = makeOwnerBus();
			const autoBus: any = bus;
			autoBus.emit = (channel: string, payload: any) => {
				autoBus.emitted.push({ channel, payload });
				autoBus.deliver?.(payload);
			};
			return { autoBus, requests };
		}

		it("v0.3.76: CAPABILITY roles declare inheritSkills:true (pi-subagents defaults it FALSE → --no-skills, which broke skills parity); CURATED roles (classifiers + research) declare false — the registration-level flag is the ONLY child-side ambient gate (child-launch.ts noSkills: !inheritSkills; E2E probe 2026-09-07), their cards arrive via the per-call skill field", () => {
			vi.stubEnv("SUPER_DEV_NO_SKILLS", "");
			vi.stubEnv("SUPER_DEV_SKILLS", "");
			try {
				const { autoBus, requests } = makeAutoBus();
				registerSuperDevAgents(autoBus);
				expect(requests.length).toBeGreaterThan(15);
				for (const request of requests) {
					const role = request.name.replace(/^sd-/, "");
					const expectCurated = ["task-classifier", "judge", "tdd-coverage-classifier", "red-boundary-classifier", "research-agent"].includes(role);
					expect(request.definition.inheritSkills, `${role}: curated roles register false, capability roles true`).toBe(!expectCurated);
				}
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("v0.3.76 L3: SUPER_DEV_SKILLS=ambient restores inheritSkills:true for EVERY role (escape hatch beats the curated tiers)", () => {
			vi.stubEnv("SUPER_DEV_NO_SKILLS", "");
			vi.stubEnv("SUPER_DEV_SKILLS", "ambient");
			try {
				const { autoBus, requests } = makeAutoBus();
				registerSuperDevAgents(autoBus);
				for (const request of requests) {
					expect(request.definition.inheritSkills, request.name).toBe(true);
				}
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("v0.3.76 dual-review R1/AR-2: an explicit agentSkills entry ALSO flips REGISTRATION for capability roles — ambient suppression is registration-only, so a per-call-only entry would be a silent no-op (false) or ambient+curated duplicate injection (array)", () => {
			vi.stubEnv("SUPER_DEV_NO_SKILLS", "");
			vi.stubEnv("SUPER_DEV_SKILLS", "");
			configHolder.config = { agentSkills: { implementer: false, "code-reviewer": ["code-review"], "requirements-clarifier": [] } };
			try {
				const { autoBus, requests } = makeAutoBus();
				registerSuperDevAgents(autoBus);
				const byRole = new Map(requests.map((r: any) => [String(r.name).replace(/^sd-/, ""), r.definition.inheritSkills]));
				expect(byRole.get("implementer")).toBe(false);             // false → zero cards, registration must agree
				expect(byRole.get("code-reviewer")).toBe(false);           // array → curated-ONLY, ambient must be off
				expect(byRole.get("requirements-clarifier")).toBe(false);  // [] ≡ false (R4)
				expect(byRole.get("spec-writer")).toBe(true);              // untouched capability role stays ambient
			} finally {
				configHolder.config = {};
			}
		});

		it("SUPER_DEV_NO_SKILLS=1 disables inherited skills for delegation children too — ONE switch governs session, subprocess, and pi-subagents backends", () => {
			vi.stubEnv("SUPER_DEV_NO_SKILLS", "1");
			try {
				const { autoBus, requests } = makeAutoBus();
				registerSuperDevAgents(autoBus);
				expect(requests.length).toBeGreaterThan(15);
				for (const request of requests) {
					expect(request.definition.inheritSkills).toBe(false);
				}
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("the registration success log records the skills capability state — run.log visibility for ambient child capabilities (skills=on|off)", () => {
			const lines: string[] = [];
			const { autoBus } = makeAutoBus();
			registerSuperDevAgents(autoBus, (line: string) => lines.push(line));
			const success = lines.find((l) => l.includes("sd-* agents registered") || (l.includes("registered") && l.includes("pi-subagents")));
			expect(success).toBeTruthy();
			expect(success!).toMatch(/skills=(on|off)/);
		});
	});
});

/** v0.3.78 — config-driven extension entries ride subagentOnlyExtensions.
 * The resolver (configExtensionEntriesForAgent — scope: capability agents
 * only, npm: normalization, missing-package degrade) is unit-tested in
 * tests/config-extensions.test.ts; THIS file pins the registration wiring:
 * entries union onto the commit guard (never replace), empty → key omitted,
 * every agent consulted once. */
const configExtStub = vi.hoisted(() => ({ entries: [] as string[], tools: [] as string[], calls: [] as string[], toolCalls: [] as string[] }));
vi.mock("../src/agents/agent-runtime.ts", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return {
		...real,
		configExtensionEntriesForAgent: (agent: string) => {
			configExtStub.calls.push(agent);
			return configExtStub.entries;
		},
		configExtensionToolsForAgent: (agent: string) => {
			configExtStub.toolCalls.push(agent);
			return configExtStub.tools;
		},
	};
});

describe("v0.3.78 — commonExtensions/agentExtensions registration wiring", () => {
	function collectingBus(): { bus: any; requests: any[] } {
		const requests: any[] = [];
		const bus: any = {
			on() { return () => {}; },
			emit(_channel: string, payload: any) {
				requests.push(payload);
				payload.result = { ok: true, registration: { dispose() {} } };
			},
		};
		return { bus, requests };
	}

	beforeEach(() => {
		configExtStub.entries = [];
		configExtStub.calls = [];
		configExtStub.tools = [];
		configExtStub.toolCalls = [];
	});

	it("capability agent carries resolved common entries as subagentOnlyExtensions", () => {
		configExtStub.entries = ["/fixture/common-mem.ts"];
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		const req = requests.find((r: any) => r.name === "sd-requirements-clarifier");
		expect(req.definition.subagentOnlyExtensions).toEqual(["/fixture/common-mem.ts"]);
	});

	it("implementer UNIONS the commit guard with common entries (never replace)", () => {
		configExtStub.entries = ["/fixture/common-mem.ts", "/fixture/common-lsp.ts"];
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		const exts = requests.find((r: any) => r.name === "sd-implementer").definition.subagentOnlyExtensions as string[];
		expect(exts).toHaveLength(3);
		expect(exts.some((e) => e.endsWith("child-guards/commit-guard.ts"))).toBe(true);
		expect(exts).toContain("/fixture/common-mem.ts");
		expect(exts).toContain("/fixture/common-lsp.ts");
	});

	it("empty resolution omits the subagentOnlyExtensions key (pre-v0.3.78 parity for unconfigured setups)", () => {
		configExtStub.entries = [];
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		const req = requests.find((r: any) => r.name === "sd-requirements-clarifier");
		expect(req.definition.subagentOnlyExtensions).toBeUndefined();
	});

	it("every registered agent is consulted exactly once (mechanical-role scoping lives inside the resolver)", () => {
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		expect(requests.length).toBeGreaterThan(15);
		expect(configExtStub.calls).toHaveLength(requests.length);
	});
});

describe("v0.3.78 review fixes — config extension TOOLS merge into the registration allowlist (adv-F1)", () => {
	function collectingBus(): { bus: any; requests: any[] } {
		const requests: any[] = [];
		const bus: any = {
			on() { return () => {}; },
			emit(_channel: string, payload: any) {
				requests.push(payload);
				payload.result = { ok: true, registration: { dispose() {} } };
			},
		};
		return { bus, requests };
	}

	beforeEach(() => {
		configExtStub.entries = [];
		configExtStub.calls = [];
		configExtStub.tools = [];
		configExtStub.toolCalls = [];
	});

	it("config extension tools APPEND to the role tools allowlist (reviewer: read-only set + lsp_* tools)", () => {
		configExtStub.tools = ["lsp_diagnostics", "lsp_hover", "recall"];
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		const tools = requests.find((r: any) => r.name === "sd-code-reviewer").definition.tools as string[];
		expect(tools).toEqual(["read", "grep", "find", "ls", "bash", "lsp_diagnostics", "lsp_hover", "recall"]);
	});

	it("writer agents keep edit/write plus config tools", () => {
		configExtStub.tools = ["lsp_diagnostics"];
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		const tools = requests.find((r: any) => r.name === "sd-implementer").definition.tools as string[];
		expect(tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write", "lsp_diagnostics"]);
	});

	it("empty tools resolution keeps the bare role allowlist (pre-v0.3.78 parity)", () => {
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		expect(requests.find((r: any) => r.name === "sd-code-reviewer").definition.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(requests.find((r: any) => r.name === "sd-implementer").definition.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
	});

	it("every registered agent is consulted exactly once for tools", () => {
		const { bus, requests } = collectingBus();
		registerSuperDevAgents(bus);
		expect(configExtStub.toolCalls).toHaveLength(requests.length);
	});
});


describe("v0.3.82 dual-review BLOCKER fix — deferred registration (pi.getAllTools() throws at activation)", () => {
	/** Auto-answering bus (same contract as the wildcard describe above). */
	const autoBus = (requests: any[]): any => {
		let handler: ((payload: unknown) => void) | undefined;
		return {
			on(channel: string, h: (payload: unknown) => void) {
				if (channel === "pi-subagents:runtime-agent-register:v1") handler = h;
				return () => { if (handler === h) handler = undefined; };
			},
			emit(_channel: string, payload: any) {
				requests.push(payload);
				payload.result = payload.definition?.systemPrompt
					? { ok: true, registration: { dispose() {} } }
					: { ok: false, error: new Error("malformed registration") };
				handler?.(payload);
			},
		};
	};

	it("registration happens on session_start (NOT at arm time) — post-bind index build", () => {
		vi.useFakeTimers();
		try {
			const requests: any[] = [];
			const handlers: Array<() => void> = [];
			const pi = {
				on: (event: string, h: () => void) => { if (event === "session_start") handlers.push(h); },
				getAllTools: () => [{ name: "lsp_hover", sourceInfo: { source: "npm:pi-lsp" } }],
			};
			registerSuperDevAgentsDeferred(pi as never, autoBus(requests) as never);
			expect(requests).toHaveLength(0); // NOTHING at arm time (the BLOCKER fix)
			expect(handlers).toHaveLength(1);
			handlers[0]!();
			expect(requests.length).toBeGreaterThan(20); // registered post-bind
			// (the index built at fire time merges through configExtensionToolsForAgent —
			//  mocked in THIS file per the note above; the real merge is pinned in
			//  tests/config-extensions.test.ts and buildToolIndex* unit tests.)
		} finally { vi.useRealTimers(); }
	});

	it("second session_start is a no-op (once per activation); dispose cancels the deferral", () => {
		vi.useFakeTimers();
		try {
			const requests: any[] = [];
			const handlers: Array<() => void> = [];
			const pi = { on: (_e: string, h: () => void) => handlers.push(h), getAllTools: () => [] };
			const dispose = registerSuperDevAgentsDeferred(pi as never, autoBus(requests) as never);
			handlers[0]!();
			const n = requests.length;
			handlers[0]!(); // reload-shaped second fire
			expect(requests).toHaveLength(n);
			dispose();
			expect(() => handlers[0]!()).not.toThrow();
			expect(requests).toHaveLength(n);
		} finally { vi.useRealTimers(); }
	});

	it("15s unref'd timer fallback fires when no host ever emits session_start", () => {
		vi.useFakeTimers();
		try {
			const requests: any[] = [];
			registerSuperDevAgentsDeferred({ getAllTools: () => [] } as never, autoBus(requests) as never);
			expect(requests).toHaveLength(0);
			vi.advanceTimersByTime(15_000);
			expect(requests.length).toBeGreaterThan(20);
		} finally { vi.useRealTimers(); }
	});

	it("a THROWING getAllTools (the activation-stub shape) still registers — loud WARN, children keep role built-ins", () => {
		const logs: string[] = [];
		const requests: any[] = [];
		const handlers: Array<() => void> = [];
		registerSuperDevAgentsDeferred(
			{ on: (_e: string, h: () => void) => handlers.push(h), getAllTools: () => { throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."); } } as never,
			autoBus(requests) as never,
			(m: string) => logs.push(m),
		);
		handlers[0]!();
		expect(requests.length).toBeGreaterThan(20); // agents exist — role built-ins beat "Unknown agent"
		expect(logs.some((l) => /tool index build FAILED .*not initialized/.test(l))).toBe(true);
		const tools = requests.find((r) => r.name === "sd-spec-reviewer").definition.tools as string[];
		expect(tools).toEqual([...READ_ONLY_TOOLS]); // bare allowlist — the WARN says exactly this
	});
});
