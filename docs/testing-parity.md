# Render-layer Theme Parity Convention

> Applies to: any module that wraps a framework type behind a structural
> interface. Established by Gap 2 / AC-05 of the TDD/build-cycle hardening
> spec (`docs/specifications/09-harden-tdd-build-cycle/`).

## Why this exists

The render layer (`src/render/stream-theme.ts`, `src/render/dashboard.ts`)
accepts a `DashboardTheme` — a *structural* interface describing
`fg(color, text)`, `bg(color, text)`, `bold(text)`. Every render unit test
historically fed in a **plain-object mock** (or a hand-built class that did not
exercise `this`). The real pi `Theme`, however, is a **class**:

```ts
export declare class Theme {
  private fgColors;        // ← read via this.fgColors inside fg()
  fg(color: ThemeColor, text: string): string;   // uses this.fgColors
  bg(color: ThemeBg, text: string): string;
  bold(text: string): string;
  // …
}
```

A render call site that DETACHES a method — `const fg = theme.fg; fg(...)` —
loses `this`, and against the real class throws:

```
Cannot read properties of undefined (reading 'fgColors')
```

Against a plain-object mock that call site survives (the mock has no `this`),
so **every unit test passed while the real runtime crashed super-dev's whole
setup stage.** That is a *false-green*: mock-only coverage of a class-based
dependency is insufficient.

## The convention

**Any module that wraps a framework type behind a structural interface MUST
ship ≥ 1 parity test that exercises the production path against the REAL
framework type**, not just mocks. For the render layer this means going
through `tests/helpers/real-theme.ts#withRealTheme`, which obtains a genuine
`Theme` instance:

```ts
import { withRealTheme } from "../helpers/real-theme.ts";
import { themeLine } from "../../src/render/stream-theme.ts";

it("themeLine renders ANSI against the REAL theme", () => {
  const out = withRealTheme((theme) => themeLine("phase", "▶ Stage 1", theme));
  expect(out).toMatch(/\u001b\[/);            // ANSI applied via this.fgColors
});
```

`withRealTheme((theme) => …)` is the load-bearing invariant: the `theme`
it hands you is `instanceof Theme === true` and carries a real `this.fgColors`,
so any `this`-detaching call site throws *in the test*, exactly as it would
in production.

### Caller contract (hard rule)

**Always call theme methods METHOD-STYLE.** Never destructure them.

```ts
withRealTheme((t) => t.fg("accent", "x"));        // ✓ this stays bound
const { fg } = withRealTheme((t) => t);           // ✗ detaches this
fg("accent", "x");                                  // ✗ throws reading fgColors
```

This contract is itself asserted by
`tests/render/real-theme-parity.test.ts`.

## Accessor discovery notes

The package ROOT of `@earendil-works/pi-coding-agent` re-exports `initTheme`,
the `Theme` class, and the derived theme getters (`getMarkdownTheme`,
`getSelectListTheme`, …). It does **not** re-export the module-global `theme`
proxy, nor `getThemeByName` / `loadThemeFromPath`. So a real instance is
obtained as follows:

1. Call `initTheme()` once (idempotent — `initRealTheme()` guards it).
2. `initTheme()` loads the default theme and stores a real `new Theme(...)`
   instance onto the `Symbol.for("@earendil-works/pi-coding-agent:theme")`
   key of `globalThis`. This is pi's documented cross-module sharing contract
   ("ensures all module instances — tsx, jiti — see the same theme"), so it is
   stable across the module graph and does not require a private import path.
3. Read that `globalThis` slot inside `withRealTheme` and pass it to `fn`.

This deliberately avoids depending on a deep private import path
(`dist/modes/interactive/theme/theme.ts`) that could break on minor releases;
the `Symbol.for(...)` contract is the public cross-instance sharing mechanism.

## What `tests/render/real-theme-parity.test.ts` covers

A whole-render-layer regression through the real proxy:

- `stream-theme.ts` — `themeLine` across the **entire** `LineKind` taxonomy
  (phase / command / command-done / corrective / log / log-* / thinking /
  error / trim / user-input), plus `commandBackground` for `command` and
  `command-done`.
- `dashboard.ts` — `buildResultComponent`, `packDashboardLines` (incl. the
  optional mid-run-input count arg), and `createDashboardWidgetFactory`
  (threading the real theme through the `(tui, theme) => Container` closure).
- A combined never-throws sweep through every public render entry point.

Each assertion is **no-throw + non-empty ANSI** — proving the themed path
paints via the real `this`-bound methods. `tests/stream-theme-class-theme.test.ts`
(the hand-built `ClassTheme` regression) stays green and is now a strict subset
of this suite.

## Future work: graph-based "no framework mocks" gate

The convention above is enforced today by **convention + the parity suite**, not
by machinery. A stricter, fully-mechanical gate would statically prove that no
test in the suite constructs a framework-type mock where a real instance is
available — e.g. a dependency-graph scan that flags any test importing the
`Theme` *type* shape only to hand-build a structural stand-in, when
`withRealTheme` could supply the real instance. Such a gate is **explicitly
future work** (documented here, not delivered by this spec) because it requires
a reliable module-graph / type-import model and risks false positives while the
render layer is the only consumer. Track it under the next render-layer or
testing-infra spec; until then, the parity suite + this convention document are
the guard.
