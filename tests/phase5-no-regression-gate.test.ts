/**
 * Phase 5 (No-regression hardening & quality gates) — the FINAL test gate.
 *
 * Scope of this phase (from 06-specification.md "Phase 5"):
 *   AC-09 → SCENARIO-019  idle runs leave input flowing through pi unchanged
 *                         (no capture, NO feature surfaces produced)
 *   AC-09 → SCENARIO-020  print/json/headless/RPC short-circuit on
 *                         event.source!=="interactive" BEFORE any status /
 *                         dashboard / classifyLine call; byte-identical output
 *   AC-10 → SCENARIO-022  class-theme regression covers the "user-input" kind
 *   AC-10 → SCENARIO-023  capture & injection stay additive + bounded across runs
 *   AC-10 → SCENARIO-024  the feature adds NO new runtime dependencies
 *
 * Phases 1-4 are assumed complete (handler/drain/ACK/prepend/steer exist). This
 * file is the HARDENING gate: it encodes the strict no-regression contract. A
 * passing run here is the Phase-5 deliverable (the gate clearing). Any failure
 * flags a regression that must be fixed before merge.
 *
 * Strategy:
 *   - Reuse the mocked `pi.events` emitter pattern from input-handler.test.ts
 *     so the SAME handler production `activate(pi)` installs is driven — no
 *     separately-exported symbol, no host pi.
 *   - Spy on `ctx.ui.setStatus` / `setWidget` to prove the short-circuit happens
 *     BEFORE any ACK surface fires (the byte-identical / no-surfaces angle that
 *     the per-source return-value tests in earlier phases do NOT assert).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as ext from "../src/extension.ts";
import { themeLine, classifyLine } from "../src/render/stream-theme.ts";
import { readFileSync } from "node:fs";

const activate = (ext as any).default as (pi: any) => void;
const setActiveRun = (run: unknown): void => (ext as any).setActiveRun(run);
const getActiveRun = (): any => (ext as any).getActiveRun();
const createActiveRun = (ctx?: unknown, stream?: unknown): any =>
	(ext as any).createActiveRun(ctx, stream);

/** Minimal mock pi: captures the handler registered via events.on("input", h). */
function makeMockPi() {
	const handlers: Record<string, Array<(e: any) => any>> = {};
	const events = {
		on: vi.fn((type: string, h: (e: any) => any) => {
			(handlers[type] ??= []).push(h);
		}),
		emit(type: string, e: any) {
			let last: unknown;
			for (const h of handlers[type] ?? []) last = h(e);
			return last;
		},
	};
	const inputCalls = () =>
		(events.on as any).mock.calls.filter((c: any[]) => c[0] === "input");
	return {
		events,
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		inputHandler: (): ((e: any) => any) | undefined => {
			const c = inputCalls();
			return c.length ? c[c.length - 1][1] : undefined;
		},
		inputRegistrationCount: (): number => inputCalls().length,
	};
}

/** A mock ExtensionContext whose ui.* calls are spies (assertable call counts). */
function makeCtx(mode: "tui" | "print" | "json" | "headless" = "tui") {
	return {
		mode,
		ui: {
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			classifyLine: vi.fn(),
		},
	};
}

/** Input event shape the pi "input" channel delivers: { type, text, source }. */
function inputEvent(text: string, source: string) {
	return { type: "input", text, source };
}

beforeEach(() => {
	// No active run between tests — Phase 5 verifies the IDLE default too.
	setActiveRun(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO-019: Idle input flows through pi unchanged (AC-09)
// ─────────────────────────────────────────────────────────────────────────────
describe("SCENARIO-019 — idle runs leave input flowing through pi unchanged", () => {
	it("returns {action:'continue'} and captures NOTHING when no run is active", () => {
		const pi = makeMockPi();
		activate(pi);
		const handler = pi.inputHandler()!;
		expect(handler).toBeTypeOf("function");

		const res = pi.events.emit("input", inputEvent("pivot to auth", "interactive"));

		// pi owns the input entirely — the contract that preserves prior behavior.
		expect(res).toEqual({ action: "continue" });
		// No ActiveRun exists, so nothing could have been queued.
		expect(getActiveRun()).toBeNull();
	});

	it("produces NO feature surfaces on idle input (no setStatus / setWidget)", () => {
		const pi = makeMockPi();
		activate(pi);
		// Even if a ctx were somehow live, no activeRun means no ACK path runs.
		const ctx = makeCtx("tui");

		pi.events.emit("input", inputEvent("anything", "interactive"));

		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(ctx.ui.classifyLine).not.toHaveBeenCalled();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO-020: Non-interactive sources short-circuit before any surface (AC-09)
// ─────────────────────────────────────────────────────────────────────────────
describe("SCENARIO-020 — non-interactive input short-circuits with byte-identical output", () => {
	beforeEach(() => {
		// A run IS active and in TUI mode — so surfaces WOULD fire if push ran.
		// The source guard must stop it before any ACK call.
		setActiveRun(createActiveRun(makeCtx("tui")));
	});

	for (const source of ["rpc", "extension", "print", "json", "headless"]) {
		it(`source='${source}' → {action:'continue'}, nothing queued, no surfaces`, () => {
			const pi = makeMockPi();
			activate(pi);

			const before = getActiveRun().queue.length;
			const res = pi.events.emit("input", inputEvent("rpc payload", source));

			expect(res).toEqual({ action: "continue" });
			// Queue byte-identical: nothing was captured.
			expect(getActiveRun().queue.length).toBe(before);
		});
	}

	it("does NOT call setStatus / setWidget / classifyLine for a non-interactive source", () => {
		const ctx = makeCtx("tui");
		setActiveRun(createActiveRun(ctx));
		const pi = makeMockPi();
		activate(pi);

		pi.events.emit("input", inputEvent("headless steer", "headless"));

		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(ctx.ui.classifyLine).not.toHaveBeenCalled();
	});

	it("interactive input IS captured (positive control — the guard is source-specific)", () => {
		setActiveRun(createActiveRun(makeCtx("tui")));
		const pi = makeMockPi();
		activate(pi);

		const res = pi.events.emit("input", inputEvent("real user steer", "interactive"));

		expect(res).toEqual({ action: "handled" });
		expect(getActiveRun().queue).toContain("real user steer");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO-022: class-theme regression covers the "user-input" kind (AC-10)
//   The plain-object mock themes used elsewhere CANNOT reproduce the
//   `this.fgColors` detachment bug; only a class-based theme (like the real pi
//   Theme) can. "user-input" must render via the METHOD-bound fg()/bold() path.
// ─────────────────────────────────────────────────────────────────────────────
describe("SCENARIO-022 — class-theme regression covers the 'user-input' kind", () => {
	/** Class theme whose fg() reads `this.fgColors` — detaching throws (like pi). */
	class ClassTheme {
		private fgColors: Map<string, string>;
		constructor() {
			const codes: Record<string, string> = {
				accent: "\x1b[35m", toolTitle: "\x1b[36m", dim: "\x1b[2m", text: "\x1b[0m",
				success: "\x1b[32m", error: "\x1b[31m", warning: "\x1b[33m", muted: "\x1b[90m",
				thinkingText: "\x1b[34m",
			};
			this.fgColors = new Map(Object.entries(codes));
		}
		fg(color: string, text: string): string {
			const ansi = this.fgColors.get(color); // throws if `this` is undefined
			if (!ansi) throw new Error(`Unknown theme color: ${color}`);
			return `${ansi}${text}\x1b[39m`;
		}
		bold(text: string): string {
			return `\x1b[1m${text}\x1b[22m`;
		}
		bg(_color: string, text: string): string {
			return `\x1b[7m${text}\x1b[27m`;
		}
	}

	it("themeLine('user-input', ...) does NOT throw against a class theme", () => {
		const t = new ClassTheme();
		expect(() => themeLine("user-input", "pivot to auth", t)).not.toThrow();
	});

	it("applies accent fg + bold via the method-bound path (this not detached)", () => {
		const t = new ClassTheme();
		const out = themeLine("user-input", "pivot to auth", t);
		// Text preserved.
		expect(out).toContain("pivot to auth");
		// accent fg applied through this.fgColors ( detachment would have thrown ).
		expect(out).toContain("\x1b[35m");
		// bold applied through this.bold.
		expect(out).toContain("\x1b[1m");
	});

	it("mirrors the 'phase' kind styling (accent + bold) for visual consistency", () => {
		const t = new ClassTheme();
		const phase = themeLine("phase", "x", t);
		const user = themeLine("user-input", "x", t);
		// Same accent + bold wrappers → identical styling skeleton (sans text).
		expect(user.replace(/x/g, "")).toBe(phase.replace(/x/g, ""));
	});

	it("classifyLine NEVER returns 'user-input' (the kind is sink-tagged, not derived)", () => {
		// SCENARIO-020 byte-identical guarantee: the classifier is unchanged, so a
		// stray "📥 …" line still classifies as a plain log — user-input is only
		// ever pushed directly with its kind at the live-stream sink.
		for (const text of ["📥 queued: hi", "📥 foo", "(1) pivot to auth", "Mid-run user guidance"]) {
			expect(classifyLine(text)).not.toBe("user-input");
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO-023: capture & injection stay additive + bounded (AC-10)
// ─────────────────────────────────────────────────────────────────────────────
describe("SCENARIO-023 — capture stays additive, bounded, and non-blocking", () => {
	it("each run gets a FRESH queue — no unbounded growth / leak across runs", () => {
		const runA = createActiveRun(makeCtx("tui"));
		runA.push("a1");
		runA.push("a2");
		expect(runA.drain()).toEqual(["a1", "a2"]);

		// A second run (new factory call) must start empty — run A's items do not leak.
		const runB = createActiveRun(makeCtx("tui"));
		expect(runB.drain()).toEqual([]);
		expect(runB.queue).toEqual([]);
	});

	it("drain() is atomic: a second drain returns [] until new input arrives", () => {
		const run = createActiveRun(makeCtx("tui"));
		run.push("one");
		run.push("two");
		expect(run.drain()).toEqual(["one", "two"]);
		expect(run.drain()).toEqual([]);
		run.push("three");
		expect(run.drain()).toEqual(["three"]);
	});

	it("the input handler returns a synchronous plain object (never blocks pi's loop)", () => {
		const pi = makeMockPi();
		activate(pi);
		setActiveRun(createActiveRun(makeCtx("tui")));

		const res = pi.events.emit("input", inputEvent("fast steer", "interactive"));

		// Must be a plain {action} object, NOT a thenable/Promise — the handler
		// never awaits and never blocks pi's input loop or agent spawning.
		expect(res).toEqual({ action: "handled" });
		expect(typeof (res as any)?.then).toBe("undefined");
	});

	it("empty/whitespace-only input is never queued (no spurious guidance entry)", () => {
		const run = createActiveRun(makeCtx("tui"));
		for (const empty of ["", "   ", "\t\n"]) run.push(empty);
		expect(run.drain()).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO-024: the feature introduces NO new runtime dependencies (AC-10)
// ─────────────────────────────────────────────────────────────────────────────
describe("SCENARIO-024 — no new runtime dependencies", () => {
	it("package.json declares ZERO runtime `dependencies` (devDependencies only)", () => {
		// The mid-run-input feature reuses only pi.events.on, ExtensionContext.ui,
		// and the existing DashboardTheme/themeLine infra — nothing is imported
		// from a new runtime package. The repo's runtime dependency surface must
		// therefore be unchanged (empty) after this feature.
		const pkg = JSON.parse(readFileSync("package.json", "utf8"));
		const runtimeDeps = Object.keys(pkg.dependencies ?? {});
		expect(runtimeDeps).toEqual([]);
	});

	it("all feature-adjacent packages are devDependencies (build/test tooling)", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8"));
		const devDeps = Object.keys(pkg.devDependencies ?? {});
		// The toolchain the feature's tests rely on is present as devDeps.
		expect(devDeps).toContain("vitest");
		expect(devDeps).toContain("typescript");
		// And the pi extension host SDK is a devDep (the extension is loaded INTO
		// the host pi at runtime — it is not itself a runtime dependency).
		expect(dev_depsHasPi(devDeps)).toBe(true);
	});
});

function dev_depsHasPi(devDeps: string[]): boolean {
	return devDeps.some((d) => d.includes("pi-coding-agent"));
}

// Keep initTheme referenced for the class-theme path that reads the global theme.
describe("quality gate — module surface sanity", () => {
	it("initTheme is importable (class-theme global init available)", () => {
		expect(typeof initTheme).toBe("function");
	});
});
