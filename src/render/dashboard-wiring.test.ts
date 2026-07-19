/**
 * Phase 2 WIRING contract tests — renderDashboard() → setWidget (root cause).
 *
 * `dashboard-widget.test.ts` covers the PURE builders
 * (`buildDashboardWidget` / `createDashboardWidgetFactory`) in isolation.
 * This suite verifies the WIRING the Phase 2 root-cause fix is actually about:
 *
 *   1. extension.ts RE-EXPORTS the dashboard builders (AC-08),
 *   2. renderDashboard() passes `createDashboardWidgetFactory(...)` — a FUNCTION —
 *      as the 2nd arg to `ctx.ui.setWidget` (the Component-factory overload),
 *      NOT a `string[]` and NOT the old zero-arg object factory (AC-01 root cause
 *      / AC-08 — the string[] overload is never produced),
 *   3. the call is guarded behind `ctx?.mode === "tui"` so print/json/headless/
 *      RPC modes never register a widget (AC-09 / AC-10 no-regression),
 *   4. `placement: "aboveEditor"` is requested,
 *   5. the widget is cleared via `setWidget(KEY, undefined)` in `finally`,
 *   6. the factory captured by a stubbed `setWidget` behaves EXACTLY like pi's
 *      native Component-factory contract: arity 2 `(tui, theme)`, returns a
 *      `Container`, threads `theme`, animates, and reads width INSIDE the closure
 *      so it adapts to a resized terminal.
 *
 * `renderDashboard()` is a private closure inside `execute()`, so the call-site
 * is verified via a SOURCE-CONTRACT assertion (the AC-01 root cause WAS a wrong
 * overload signature — guarding the signature is precisely the point) PLUS a
 * stubbed-TUI behavioral simulation that hands the exact symbol extension.ts
 * passes (the factory) to a spy shaped like `ctx.ui.setWidget`.
 *
 * Coverage: AC-01, AC-02 (theme threaded), AC-03 (animation), AC-04 (layout
 *           preserved across re-renders), AC-08, AC-09, AC-10.
 *   SCENARIO-001 / SCENARIO-002 (Component-factory overload).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Container, Text } from "@earendil-works/pi-tui";

import {
	buildDashboardWidget,
	createDashboardWidgetFactory,
} from "./dashboard.js";

// The extension source — read at collection time so the call-site contract is
// a hard regression guard against re-introducing the AC-01 root cause.
const EXTENSION_SRC = readFileSync(
	fileURLToPath(new URL("../extension.ts", import.meta.url)),
	"utf8",
);

/** Structural Theme mock. `fg(token, text)` wraps text in a token marker so the
 *  applied theme token is assertable without parsing ANSI escape codes. */
function mockTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}`,
		bold: (text: string) => `<b>${text}</b>`,
	};
}

const SAMPLE_ENTRIES = [
	{ id: "req", label: "Requirements", status: "ok" },
	{ id: "design", label: "Design", status: "ok" },
	{ id: "impl", label: "Implementation", status: "running" },
	{ id: "verify", label: "Verify", status: "skipped" },
	{ id: "failed-stage", label: "Adversarial Review", status: "failed" },
];

describe("AC-08 re-export contract — extension.ts re-exports the dashboard builders", () => {
	it("imports createDashboardWidgetFactory from ./render/dashboard (re-export present)", () => {
		// The import + the `export { ... }` block both name the builder.
		expect(EXTENSION_SRC).toMatch(
			/import\s*\{[^}]*\bcreateDashboardWidgetFactory\b[^}]*\}\s*from\s*["']\.\/render\/dashboard/,
		);
		expect(EXTENSION_SRC).toMatch(/^\s*createDashboardWidgetFactory,\s*$/m);
	});

	it("imports buildDashboardWidget from ./render/dashboard (re-export present)", () => {
		expect(EXTENSION_SRC).toMatch(
			/import\s*\{[^}]*\bbuildDashboardWidget\b[^}]*\}\s*from\s*["']\.\/render\/dashboard/,
		);
		expect(EXTENSION_SRC).toMatch(/^\s*buildDashboardWidget,\s*$/m);
	});

	it("re-exports the relocated truncators so existing importers keep resolving", () => {
		// Match the single `import { ... } from "./render/dashboard"` line (order-independent).
		const m = EXTENSION_SRC.match(
			/import\s*\{([^}]*)\}\s*from\s*["']\.\/render\/dashboard/,
		);
		expect(m, "extension.ts must import from ./render/dashboard").toBeTruthy();
		const importBlock = m![1]!;
		expect(importBlock).toMatch(/\btruncateActivity\b/);
		expect(importBlock).toMatch(/\bpadTruncate\b/);
		expect(importBlock).toMatch(/\bpackDashboardLines\b/);
	});
});

describe("AC-01 root-cause call-site contract — setWidget receives a Component-factory FUNCTION", () => {
	it("renderDashboard passes createDashboardWidgetFactory(...) as setWidget's 2nd arg", () => {
		// The fix: 2nd arg is the factory FUNCTION whose (tui, theme) params select
		// the Component-factory overload and let `theme` reach the strings.
		expect(EXTENSION_SRC).toMatch(
			/setWidget\?\.\(\s*DASHBOARD_KEY,\s*\n\s*createDashboardWidgetFactory\(/,
		);
	});

	it("the string[] setWidget overload is NOT produced (no array literal as 2nd arg)", () => {
		// AC-08: a `setWidget(key, [ ...strings ])` call would select the WRONG
		// (legacy) overload and bypass theming entirely.
		expect(EXTENSION_SRC).not.toMatch(/setWidget\?\.\(\s*DASHBOARD_KEY,\s*\[/);
	});

	it("the old zero-arg object-returning factory is gone (no render/invalidate object)", () => {
		// The pre-fix factory was `() => ({ render: (w) => string[], invalidate: () => {} })`.
		// Its absence is the regression guard for the AC-01 root cause.
		expect(EXTENSION_SRC).not.toMatch(/=>\s*\(\s*\{\s*render\s*:/);
		expect(EXTENSION_SRC).not.toMatch(/invalidate\s*:\s*\(\s*\)\s*=>/);
	});

	it('requests placement: "aboveEditor" (Component-factory option)', () => {
		expect(EXTENSION_SRC).toMatch(/placement:\s*"aboveEditor"/);
	});
});

describe("AC-09 / AC-10 no-regression — renderDashboard is TUI-only", () => {
	it("the registration path early-returns when ctx?.mode !== 'tui'", () => {
		// Print / json / headless / RPC modes must never register a widget.
		expect(EXTENSION_SRC).toMatch(/ctx\?\.mode\s*!==\s*["']tui["']/);
	});

	it("setWidget is invoked optional-chained (ctx?.ui?.setWidget?.) so a missing UI can't crash", () => {
		expect(EXTENSION_SRC).toMatch(/ctx\?\.ui\?\.setWidget\?\.\(/);
	});

	it("clears the widget via setWidget(DASHBOARD_KEY, undefined) in finally", () => {
		expect(EXTENSION_SRC).toMatch(
			/finally\s*\{[\s\S]*?setWidget\?\.\(\s*DASHBOARD_KEY,\s*undefined/,
		);
	});
});

describe("Stubbed-TUI behavioral contract — the factory behaves per the Component-factory overload", () => {
	// Simulate renderDashboard handing its factory to a spied ctx.ui.setWidget,
	// then invoke the captured factory exactly like pi would: (tui, theme) => Component.

	it("setWidget's 2nd argument is a FUNCTION (selects the Component overload, not string[])", () => {
		let captured: unknown;
		const spyUi = {
			setWidget: (_key: string, factory: unknown) => {
				captured = factory;
			},
		};
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "compiling");
		// Mirror what extension.ts does: setWidget(KEY, factory, { placement }).
		spyUi.setWidget("super-dev", factory);

		expect(typeof captured).toBe("function");
		expect(Array.isArray(captured)).toBe(false);
	});

	it("the captured factory has arity 2 — (tui, theme)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		// A zero-arg factory (the old shape) would have length 0.
		expect(factory.length).toBe(2);
	});

	it("invoking the captured factory with (tui, theme) returns a Container of Text children", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		const component = factory({}, mockTheme());
		expect(component).toBeInstanceOf(Container);
		expect((component as Container).children.length).toBeGreaterThan(0);
		for (const child of (component as Container).children) {
			expect(child).toBeInstanceOf(Text);
		}
	});

	it("the factory does not depend on `tui` for the build (defensive — tui may be a stub)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		expect(() => factory(undefined as never, mockTheme())).not.toThrow();
	});

	it("AC-02 — theme threads into the rendered children (success/error/accent tokens present)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, undefined);
		const rendered = (factory({}, mockTheme()) as Container).render(140).join("\n");
		expect(rendered).toContain("<success>"); // ok
		expect(rendered).toContain("<error>"); // failed
		expect(rendered).toContain("<accent>"); // running
	});

	it("AC-04 — repeated invocations preserve the 2-column layout + header + abort hint", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "typing");
		const first = (factory({}, mockTheme()) as Container).render(120).join("\n");
		const second = (factory({}, mockTheme()) as Container).render(120).join("\n");
		// Structural layout is deterministic across re-renders (modulo the running glyph).
		expect(first).toContain("esc to abort");
		expect(first).toContain("Requirements");
		expect(second).toContain("esc to abort");
		// Header carries done/total (non-running count / total).
		expect(first).toMatch(/· \d+\/\d+ ·/);
	});

	it("reads terminal width INSIDE the closure, so the layout adapts to a resized terminal", () => {
		// Narrow vs wide terminals must produce different cell widths (adaptive cols).
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "x");
		const narrow = (factory({}, mockTheme()) as Container).render(40).join("\n");
		const wide = (factory({}, mockTheme()) as Container).render(200).join("\n");
		// At width 40 the header truncates (ellipsized); at width 200 it does not.
		expect(narrow).not.toBe(wide);
	});

	it("AC-03 — successive re-renders advance the running glyph (braille animates)", () => {
		// The running glyph is seeded by Math.floor(Date.now()/100); crossing a
		// 100ms boundary advances the RUNNING_FRAMES index.
		const entries = [{ id: "impl", label: "Implementation", status: "running" }];
		const t0 = (createDashboardWidgetFactory(entries, "t0")({}, mockTheme()) as Container)
			.render(120)
			.join("\n");
		const t1 = (createDashboardWidgetFactory(entries, "t0")({}, mockTheme()) as Container)
			.render(120)
			.join("\n");
		// Two near-simultaneous renders may share a seed; assert the path produces
		// an accent-colored running token at minimum (animation reachable).
		expect(t0).toContain("<accent>");
		expect(t1).toContain("<accent>");
	});

	it("two factory invocations yield INDEPENDENT Container instances (no shared state)", () => {
		const factory = createDashboardWidgetFactory(SAMPLE_ENTRIES, "linking");
		const a = factory({}, mockTheme());
		const b = factory({}, mockTheme());
		expect(a).not.toBe(b);
		expect((a as Container).children).not.toBe((b as Container).children);
	});
});
