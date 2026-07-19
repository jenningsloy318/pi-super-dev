/**
 * Phase 2 unit + contract tests — the WIDGET-FACTORY FIX (root cause).
 *
 * Phase 1 gave us the pure string helpers (`packDashboardLines`,
 * `statusGlyph`, …). Phase 2 must WIRE those strings into pi's native
 * Component-factory overload of `setWidget`:
 *
 *     setWidget(key, (tui, theme) => Component, opts)
 *
 * The previous zero-arg object-returning factory never received `theme`,
 * producing uncolored ASCII (AC-01 root cause). Phase 2 therefore extracts
 * the factory into a PURE, TUI-context-free builder so the Component-factory
 * contract is unit-testable without spinning up a real TUI:
 *
 *   - `buildDashboardWidget(entries, activity, width, theme): Container`
 *       Builds a `Container` of `Text` children from `packDashboardLines`.
 *   - `createDashboardWidgetFactory(entries, activity)`
 *       => `(tui, theme) => Component`  — the exact closure `setWidget` consumes.
 *
 * NEITHER symbol exists yet (Phase 1 only exports the string helpers). These
 * tests are written FIRST (RED) and must fail at import until Phase 2 lands.
 *
 * Coverage:
 *   - AC-01 : factory returns a Component (Container), not a string[] / object
 *   - AC-02 : theme is threaded into the rendered children (status tokens present)
 *   - AC-03 : animation — successive factory invocations advance the running glyph
 *   - AC-04 : 2-column adaptive layout preserved (header + per-stage rows)
 *   - AC-08 : the string[] setWidget overload is NOT produced (factory is a function
 *             returning a Component)
 *   - AC-09 : no-regression — the factory is a pure builder; nothing executes by import
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { Container, Text } from "@earendil-works/pi-tui";

import {
	packDashboardLines,
	buildDashboardWidget,
	createDashboardWidgetFactory,
} from "./dashboard.js";

/** Minimal structural Theme mock. `fg(token, text)` wraps text in a token
 * marker so we can assert WHICH theme token was applied without parsing ANSI.
 * `bold` is included because the result-summary path (Phase 3) uses it; keeping
 * it here guards forward-compat. */
type ThemeLike = {
	fg: (token: string, text: string) => string;
	bold: (text: string) => string;
};
function mockTheme(): ThemeLike {
	return {
		fg: (token, text) => `<${token}>${text}`,
		bold: (text) => `<b>${text}</b>`,
	};
}

const SAMPLE_ENTRIES = [
	{ id: "req", label: "Requirements", status: "ok" },
	{ id: "design", label: "Design", status: "ok" },
	{ id: "impl", label: "Implementation", status: "running" },
	{ id: "verify", label: "Verify", status: "skipped" },
	{ id: "failed-stage", label: "Adversarial Review", status: "failed" },
	{ id: "doc", label: "Docs", status: "ok" },
];

describe("buildDashboardWidget — AC-01 / AC-02 / AC-04", () => {
	it("returns a Container (a pi-tui Component), not a string[] or plain object", () => {
		const widget = buildDashboardWidget(SAMPLE_ENTRIES, "compiling types", 120, mockTheme());
		// AC-01 / AC-08: the Component-factory overload requires a Component.
		// A string[] would satisfy the WRONG (legacy) overload and is forbidden.
		expect(widget).toBeInstanceOf(Container);
		expect(Array.isArray(widget)).toBe(false);
	});

	it("populates the Container with one Text child per dashboard line", () => {
		const theme = mockTheme();
		const activity = "running unit tests";
		const width = 120;
		const widget = buildDashboardWidget(SAMPLE_ENTRIES, activity, width, theme);

		const expectedLines = packDashboardLines(SAMPLE_ENTRIES, activity, width, theme);
		expect(widget.children.length).toBe(expectedLines.length);
		for (const child of widget.children) {
			expect(child).toBeInstanceOf(Text);
		}
	});

	it("threads theme into the rendered children (status tokens are visible)", () => {
		// AC-02: theme MUST reach the strings — this is the whole root-cause fix.
		// ok => <success>, failed => <error>, skipped => <warning>, running => <accent>.
		const theme = mockTheme();
		const widget = buildDashboardWidget(SAMPLE_ENTRIES, undefined, 140, theme);
		const rendered = widget.render(140).join("\n");

		expect(rendered).toContain("<success>");
		expect(rendered).toContain("<error>");
		expect(rendered).toContain("<warning>");
		expect(rendered).toContain("<accent>");
	});

	it("preserves the 2-column adaptive header + abort hint (AC-04 layout)", () => {
		const widget = buildDashboardWidget(SAMPLE_ENTRIES, "compiling", 120, mockTheme());
		const rendered = widget.render(120).join("\n");

		// Header carries done/total, the running stage, and the abort hint.
		// `done` = NON-running count (ok + skipped + failed) = 5 of 6 entries.
		expect(rendered).toContain("5/6");
		expect(rendered).toContain("esc to abort");
		// A stage label from the grid is present (layout rows are emitted).
		expect(rendered).toContain("Requirements");
	});

	it("handles an empty entry list without throwing (boundary)", () => {
		const widget = buildDashboardWidget([], undefined, 120, mockTheme());
		expect(widget).toBeInstanceOf(Container);
		// Header line still emitted (0/0 + abort hint).
		expect(widget.children.length).toBeGreaterThanOrEqual(1);
	});

	it("does not pass a string[] to setWidget — factory result is structural, not lines", () => {
		// AC-08 guard: even when rendered, the widget is a Component tree; it is
		// never the raw string[] that the legacy overload would accept directly.
		const widget = buildDashboardWidget(SAMPLE_ENTRIES, "x", 100, mockTheme());
		const maybeLines = widget as unknown as string[];
		expect(typeof maybeLines.push).not.toBe("function"); // not array-like
	});
});

describe("createDashboardWidgetFactory — AC-01 / AC-08 (Component-factory overload)", () => {
	it("returns a function (the factory), not a string[] and not an object", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "compiling");
		// AC-01: setWidget's 2nd arg must BE this function; the legacy overload
		// takes string[] — passing a function selects the Component overload.
		expect(typeof factory).toBe("function");
		expect(Array.isArray(factory)).toBe(false);
	});

	it("the factory has arity 2 (tui, theme) — matching the Component-factory signature", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "compiling");
		// (tui, theme) => Component  =>  factory.length === 2
		expect(factory.length).toBe(2);
	});

	it("invoking the factory with a stub (tui, theme) returns a Container", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		const stubTui = {}; // factory must not depend on tui for the dashboard build
		const component = factory(stubTui as never, mockTheme());
		expect(component).toBeInstanceOf(Container);
	});

	it("the factory does not throw when tui is undefined-like (defensive)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		expect(() => factory(undefined as never, mockTheme())).not.toThrow();
	});

	it("the returned Container's children are all Text (no stray non-Text components)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		const component = factory({} as never, mockTheme()) as Container;
		expect(component.children.length).toBeGreaterThan(0);
		for (const child of component.children) {
			expect(child).toBeInstanceOf(Text);
		}
	});

	it("invoking the factory twice yields independent Container instances (no shared state)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		const a = factory({} as never, mockTheme());
		const b = factory({} as never, mockTheme());
		expect(a).not.toBe(b);
		expect(a.children).not.toBe(b.children);
	});
});

describe("AC-03 animation — running glyph advances across re-renders", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("produces a different running glyph as wall-clock advances ~200ms+ (braille animates)", () => {
		// The dashboard's "running" glyph is seeded by Math.floor(Date.now()/100),
		// so a ~200ms throttle crosses a 100ms boundary and advances RUNNING_FRAMES.
		const entriesWithRunning = [
			{ id: "impl", label: "Implementation", status: "running" },
		];

		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const factory0 = createDashboardWidgetFactory(entriesWithRunning, "t0");
		const render0 = (factory0({} as never, mockTheme()) as Container).render(120).join("\n");

		// Advance past a 100ms seed boundary (well beyond the WIDGET_MS≈200 throttle).
		vi.setSystemTime(new Date("2026-01-01T00:00:00.900Z"));
		const factory1 = createDashboardWidgetFactory(entriesWithRunning, "t0");
		const render1 = (factory1({} as never, mockTheme()) as Container).render(120).join("\n");

		// The braille frame at the running-stage glyph must differ between the
		// two re-renders — proving the seed (not a static glyph) drives it.
		expect(render0).not.toBe(render1);
	});
});

describe("AC-09 no-regression — pure builder, no side effects on import", () => {
	it("does not touch process.stdout or call any TUI API at module scope", () => {
		// Importing ./dashboard.js (done at top) must NOT register a widget,
		// write to stdout, or otherwise execute TUI code. The only observable
		// effect is the existence of the exported pure builders. This test
		// exists primarily as documentation of the no-side-effect contract;
		// reaching this assertion means the module loaded cleanly.
		expect(typeof buildDashboardWidget).toBe("function");
		expect(typeof createDashboardWidgetFactory).toBe("function");
		// Sanity: the legacy string[]-only packer is still re-exported untouched.
		expect(typeof packDashboardLines).toBe("function");
	});
});
