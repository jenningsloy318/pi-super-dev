/**
 * Render-layer Theme PARITY regression (Gap 2 / AC-05).
 *
 * This is the RED-phase test for Phase P6. It exercises the WHOLE render
 * layer (stream-theme.ts + dashboard.ts) against the REAL pi `Theme` proxy —
 * NOT the lightweight `ClassTheme` fake from `tests/stream-theme-class-theme.test.ts`.
 *
 * The bug class this guards (Gap 2): the real pi `Theme` is a class whose
 * `fg()` reads `this.fgColors`. Every prior unit test used a plain-object /
 * hand-built mock theme, so a method-detaching bug (`const fg = theme.fg`)
 * passed every gate while crashing super-dev's whole setup stage at runtime.
 * `tests/helpers/real-theme.ts#withRealTheme` obtains a REAL `Theme` instance
 * (via `initTheme()` + the real proxy accessor) and hands it to `fn` — and
 * because the real `Theme` is a class, any `this`-detaching call site throws
 * `Cannot read properties of undefined (reading 'fgColors')`, surfacing the
 * bug class that mock-only coverage hides.
 *
 * AC-05 coverage: themeLine, commandBackground, buildResultComponent,
 * packDashboardLines, createDashboardWidgetFactory — all rendered through the
 * real proxy, asserting (a) no-throw and (b) non-empty ANSI output.
 *
 * BDD scenarios mapped here: SCENARIO-004 (token → fg mapping),
 * SCENARIO-005 (graceful degrade stays out of scope — here we assert the
 * THEMED path emits ANSI), SCENARIO-006 (commandBackground bg paint),
 * SCENARIO-011/SCENARIO-022 (method-bound fg survives a class theme — the
 * mid-run user-input + whole-layer regression of the class-theme guard).
 *
 * NOTE: this test imports `withRealTheme` from `../helpers/real-theme.ts`,
 * which does NOT exist yet (RED). The implementer (GREEN) will create that
 * helper — `withRealTheme<T>(fn: (theme: Theme) => T): T` — obtaining a REAL
 * `Theme` instance (a `new Theme(...)` class instance, never a plain object)
 * so the `instanceof Theme` assertion below is the load-bearing parity check.
 */
import { describe, it, expect } from "vitest";
import { Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

// RED: helper does not exist yet — this import failing to resolve IS the red phase.
import { withRealTheme } from "../helpers/real-theme.ts";

import {
	themeLine,
	commandBackground,
	type LineKind,
} from "../../src/render/stream-theme.ts";
import {
	buildResultComponent,
	packDashboardLines,
	createDashboardWidgetFactory,
} from "../../src/render/dashboard.ts";

/** ANSI CSI escape (ESC + '[') — emitted by the real Theme.fg/bold/bg. */
const ANSI = /\u001b\[/;
/** Every LineKind value — the whole render taxonomy, not a cherry-picked subset. */
const ALL_KINDS: LineKind[] = [
	"phase",
	"command",
	"command-done",
	"corrective",
	"log",
	"log-success",
	"log-warning",
	"log-error",
	"thinking",
	"error",
	"trim",
	"user-input",
];

describe("render-layer Theme parity — REAL pi Theme proxy (Gap 2 / AC-05)", () => {
	describe("withRealTheme harness — the load-bearing parity invariant", () => {
		it("obtains a REAL Theme class instance (not a structural mock / plain object)", () => {
			// `instanceof Theme` is the parity check: a hand-built mock plain-object
			// theme would FAIL this. The real proxy MUST be a Theme class instance
			// whose methods read `this.fgColors`, otherwise the detached-`this` bug
			// class stays hidden (the exact failure Gap 2 documents).
			const isReal = withRealTheme((theme) => theme instanceof Theme);
			expect(isReal).toBe(true);
		});

		it("exposes fg/bold/bg as class methods (never destructured by callers)", () => {
			const shape = withRealTheme((theme) => ({
				fg: typeof theme.fg,
				bold: typeof theme.bold,
				bg: typeof theme.bg,
			}));
			expect(shape.fg).toBe("function");
			expect(shape.bold).toBe("function");
			expect(shape.bg).toBe("function");
		});

		it("fg('accent', 'X') resolves a known token to ANSI-wrapped text via this-bound method", () => {
			const out = withRealTheme((theme) => theme.fg("accent", "X"));
			expect(out).toContain("X");
			expect(out).toMatch(ANSI);
		});

		it("bg('toolPendingBg', 'x') paints a background via this-bound method (no detached throw)", () => {
			const out = withRealTheme((theme) => theme.bg("toolPendingBg", "x"));
			expect(out).toContain("x");
			expect(out).toMatch(ANSI);
		});

		it("is idempotent: initTheme() twice + two withRealTheme calls yield identical fg output", () => {
			const a = withRealTheme((theme) => theme.fg("text", "Y"));
			const b = withRealTheme((theme) => theme.fg("text", "Y"));
			expect(a).toBe(b);
		});
	});

	describe("stream-theme.ts — themeLine across the WHOLE LineKind taxonomy", () => {
		it.each(ALL_KINDS)("themeLine('%s') renders no-throw + ANSI against the REAL theme", (kind) => {
			const text =
				kind === "command"
					? "→ npm install"
					: kind === "command-done"
						? "→ structured_output ✓"
						: kind === "phase" || kind === "user-input"
							? "▶ Stage 1"
							: "sample line";
			// Call themeLine method-style: the real theme flows in as `theme`.
			const out = withRealTheme((theme) => themeLine(kind, text, theme));
			expect(typeof out).toBe("string");
			expect(out.length).toBeGreaterThan(0);
			// Every themed line must carry ANSI (the raw-degrade path is exercised
			// separately in stream-theme.test.ts; here the themed path is asserted).
			expect(out).toMatch(ANSI);
		});

		it("themeLine('phase') carries the phase marker AND the accent token via this.fgColors", () => {
			const out = withRealTheme((theme) => themeLine("phase", "▶ Stage 1", theme));
			expect(out).toContain("▶ Stage 1");
			expect(out).toMatch(ANSI);
		});

		it("themeLine('command') splits name (bold toolTitle) + rest (dim) via this-bound methods", () => {
			const out = withRealTheme((theme) => themeLine("command", "→ npm install", theme));
			expect(out).toContain("npm install");
			expect(out).toMatch(ANSI);
		});
	});

	describe("stream-theme.ts — commandBackground (SCENARIO-006)", () => {
		it("returns a background paint fn for 'command' that keeps `this` bound when invoked", () => {
			// Build AND invoke inside the callback so the closure captures the real theme.
			const painted = withRealTheme(
				(theme) => commandBackground("command", theme)!("tool output"),
			);
			expect(painted).toContain("tool output");
			expect(painted).toMatch(ANSI);
		});

		it("returns a background paint fn for 'command-done' without a detached-`this` throw", () => {
			const painted = withRealTheme(
				(theme) => commandBackground("command-done", theme)!("done"),
			);
			expect(painted).toContain("done");
			expect(painted).toMatch(ANSI);
		});

		it("returns undefined for non-command kinds (no background paint)", () => {
			const none = withRealTheme((theme) => commandBackground("log", theme));
			expect(none).toBeUndefined();
		});
	});

	describe("dashboard.ts — buildResultComponent (SCENARIO-016)", () => {
		const details = {
			summaryLines: ["## Summary", "ok"],
			transcriptTail: [
				{ kind: "command" as const, text: "→ read foo" },
				{ kind: "thinking" as const, text: "considering..." },
				{ kind: "phase" as const, text: "▶ Stage 1" },
			],
			stages: [{ label: "Setup", status: "ok" }],
		};

		it("renders against the REAL theme without throwing and emits ANSI", () => {
			const comp = withRealTheme((theme) => buildResultComponent(details, theme));
			const rendered = comp.render(120).join("\n");
			expect(rendered).toContain("read foo");
			expect(rendered).toContain("considering...");
			expect(rendered).toMatch(ANSI);
		});

		it("per-stage block branch: tagged tail renders per-stage headers + status backgrounds via method-style theme.bg (no detached-`this` throw)", () => {
			// Stage-tagged tail ⇒ the per-stage §1 branch (groupByStage). Each block
		// header Text carries a status customBgFn that calls theme.bg(...) — must
		// stay method-bound against the REAL class Theme (Gap 2 / AC-05 parity).
			const tagged = {
				summaryLines: ["## Summary", "done"],
				transcriptTail: [
					{ kind: "command" as const, text: "→ build", stageId: "impl", stageLabel: "Implementation" },
					{ kind: "log" as const, text: "a tagged log line", stageId: "research", stageLabel: "Research" },
				],
				stages: [
					{ id: "research", label: "Research", status: "ok" },
					{ id: "impl", label: "Implementation", status: "failed" },
				],
			};
			expect(() => withRealTheme((theme) => buildResultComponent(tagged, theme))).not.toThrow();
			const rendered = withRealTheme((theme) =>
				buildResultComponent(tagged, theme).render(120).join("\n"),
			);
			expect(rendered).toContain("Implementation");
			expect(rendered).toContain("Research");
			expect(rendered).toMatch(ANSI);
		});
	});

	describe("dashboard.ts — packDashboardLines (SCENARIO-001/002)", () => {
		const entries = [
			{ id: "s1", label: "Setup", status: "ok" },
			{ id: "s2", label: "Research", status: "running" },
			{ id: "s3", label: "Spec", status: "pending" },
			{ id: "s4", label: "Implement", status: "pending" },
		];

		it("packs a 2-col themed layout against the REAL theme, no-throw + ANSI + header", () => {
			const lines = withRealTheme((theme) =>
				packDashboardLines(entries, "npm install", 120, theme, 1),
			);
			expect(lines.length).toBeGreaterThan(0);
			const joined = lines.join("\n");
			expect(joined).toContain("super-dev");
			// Mid-run input count surfaces (AC-07) — proves the optional arg threads.
			expect(joined).toContain("mid-run input");
			expect(joined).toMatch(ANSI);
		});
	});

	describe("dashboard.ts — createDashboardWidgetFactory (the AC-01 theme-threading root fix)", () => {
		it("returns a (tui, theme) => Container closure; invoking with the REAL theme yields a Container, no-throw", () => {
			const factory = createDashboardWidgetFactory(
				[{ id: "s1", label: "Setup", status: "ok" }],
				"activity",
				0,
			);
			expect(typeof factory).toBe("function");
			// Thread the REAL theme through the factory closure — the whole point of
			// the Component-factory setWidget overload (theme reaches the strings).
			const container = withRealTheme((theme) => factory({}, theme));
			expect(container).toBeInstanceOf(Container);
		});
	});

	describe("whole-layer never-throws sweep — REAL theme through every public render entry", () => {
		it("a combined render pass through all 5 entry points does not throw", () => {
			expect(() =>
				withRealTheme((theme) => {
					for (const kind of ALL_KINDS) themeLine(kind, "x", theme);
					commandBackground("command", theme)?.("x");
					commandBackground("command-done", theme)?.("x");
					buildResultComponent(
						{
							summaryLines: ["ok"],
							transcriptTail: [{ kind: "log" as const, text: "x" }],
							stages: [{ label: "S", status: "ok" }],
						},
						theme,
					).render(80);
					packDashboardLines(
						[{ id: "s1", label: "A", status: "ok" }],
						"act",
						100,
						theme,
						0,
					);
					createDashboardWidgetFactory(
						[{ id: "s1", label: "A", status: "ok" }],
						"act",
						0,
					)({}, theme);
					return true;
				}),
			).not.toThrow();
		});
	});
});
