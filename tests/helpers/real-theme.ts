/**
 * Real pi Theme parity harness — Gap 2 / AC-05.
 *
 * Obtains a REAL `Theme` class instance from `@earendil-works/pi-coding-agent`
 * — NOT the lightweight plain-object / hand-built `ClassTheme` mock used by
 * `tests/stream-theme-class-theme.test.ts`. The real pi `Theme` is a class
 * whose `fg(color, text)` reads `this.fgColors`; any call site that DETACHES
 * a method (`const fg = theme.fg; fg(...)`) loses `this` and throws
 * "Cannot read properties of undefined (reading 'fgColors')". Mock-only test
 * coverage hides exactly that bug class — which crashed super-dev's whole
 * setup stage at runtime while every unit test stayed green. See
 * `docs/testing-parity.md` for the convention this harness enforces.
 *
 * Accessor discovery (also documented in docs/testing-parity.md): the package
 * ROOT re-exports `initTheme` + the `Theme` class + the derived theme getters
 * (`getMarkdownTheme`, …) but does NOT re-export the module-global `theme`
 * proxy nor `getThemeByName` / `loadThemeFromPath`. `initTheme()` loads the
 * default theme and stores a real `new Theme(...)` instance onto a
 * `Symbol.for(...)` key of `globalThis` so every module instance (tsx / jiti)
 * resolves the same live instance. We reconstruct that same well-known symbol
 * to read the live instance — this is pi's documented cross-module sharing
 * contract, so it is stable across the module graph and does not depend on a
 * private import path.
 *
 * CONTRACT for callers (asserted by tests/render/real-theme-parity.test.ts):
 *   1. ALWAYS call theme methods METHOD-STYLE — `theme.fg(...)`, NEVER
 *      `const { fg } = theme; fg(...)`. Destructuring detaches `this`.
 *   2. `withRealTheme` hands `fn` a genuine `Theme` instance
 *      (`instanceof Theme === true`); treat it as opaque and pass it through.
 *
 * BDD: SCENARIO-004 (token → fg mapping), SCENARIO-005 (themed path emits
 * ANSI; graceful-degrade path is exercised separately), SCENARIO-006 (bg
 * paint), SCENARIO-011 / SCENARIO-022 (method-bound fg survives a class
 * theme — the whole-layer regression of the detached-`this` guard).
 */
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

/**
 * The well-known `Symbol.for(...)` key the pi Theme module writes its live
 * `Theme` instance onto, so every module instance resolves the same theme.
 * Reconstructed here (not imported) because the package root does not
 * re-export the proxy/instance accessor — only the init function + class.
 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** Strict-typed view of the theme-bearing `globalThis` slot (no `any`). */
const themeGlobal = globalThis as unknown as Record<symbol, Theme | undefined>;

let initialized = false;

/**
 * Initialize the real pi `Theme` exactly once (idempotent). Mirrors the
 * `beforeAll(() => initTheme())` pattern used across the existing render test
 * suite, but guards against double-init so it is safe to call from any test.
 */
export function initRealTheme(): void {
	if (initialized) return;
	initTheme();
	initialized = true;
}

/**
 * Run `fn` against a REAL pi `Theme` class instance — the load-bearing parity
 * invariant. The instance is read from the live `globalThis` slot
 * `initTheme()` populates; if that slot is somehow empty (e.g. a future pi
 * build changes the `Symbol.for` contract), we re-initialize defensively so
 * the harness never throws at the seam — callers only ever receive a genuine
 * `Theme` whose methods are bound to a real `this.fgColors` map.
 *
 * Use the theme METHOD-STYLE inside `fn`:
 *   withRealTheme((theme) => theme.fg("accent", "x")); // ✓ this-bound
 *   const { fg } = withRealTheme((t) => t); fg("accent", "x"); // ✗ detaches `this`
 *
 * @returns whatever `fn` returns (the real `Theme` is threaded transparently).
 */
export function withRealTheme<T>(fn: (theme: Theme) => T): T {
	initRealTheme();
	let theme = themeGlobal[THEME_KEY];
	if (!theme) {
		// Defensive: re-run init if the global slot is unexpectedly empty.
		initTheme();
		theme = themeGlobal[THEME_KEY];
	}
	if (!theme) {
		throw new Error(
			"withRealTheme: real pi Theme instance unavailable after initTheme() — " +
				"is @earendil-works/pi-coding-agent installed and importable?",
		);
	}
	return fn(theme);
}

export { type Theme };
