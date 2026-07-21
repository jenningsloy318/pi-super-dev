/**
 * Stream content-kind classification + pi-native theming (Phase 1).
 *
 * A PURE, dependency-free module: it imports only the *type* shape
 * `DashboardTheme` (via `import type`, fully erased at runtime) so it can be
 * unit-tested with a lightweight structural mock and never pulls in the real
 * pi `Theme` runtime type or any TUI machinery. It is the SINGLE classification
 * authority for the live stream + final result render.
 *
 * Exports:
 *   - `LineKind`            : the 10-value content taxonomy (+ special-purpose
 *                             `thinking`/`trim` kinds tagged at the sink).
 *   - `classifyLine(text)`  : maps a raw line to its `LineKind` by
 *                             prefix/keyword precedence (SCENARIO-001..003).
 *   - `themeLine(kind,text,theme?)` : maps a kind to its pi foreground token
 *                             (SCENARIO-004) and degrades to raw text when no
 *                             theme is supplied (SCENARIO-005).
 *   - `commandBackground(kind,theme?)` : resolves the tool-bubble background
 *                             function for command/command-done (SCENARIO-006).
 *
 * Coverage: AC-01 (classification), AC-02 (token mapping + graceful degrade),
 * AC-03 (structural theme shape used unchanged).
 */

import type { DashboardTheme } from "./dashboard.js";

/**
 * The content-kind taxonomy. `phase`/`command`/`command-done`/`corrective`/
 * `log*`/`error` are derived by {@link classifyLine}; `thinking` and `trim`
 * are tagged directly at the sink layer (they are NOT derived by prefix
 * matching — `thinking` is the live-model stream; `trim` is the synthetic
 * rolling-tail notice).
 */
export type LineKind =
	| "phase"
	| "command"
	| "command-done"
	| "corrective"
	| "log"
	| "log-success"
	| "log-warning"
	| "log-error"
	| "thinking"
	| "error"
	| "trim"
	| "user-input";

/**
 * Classify a single stream line into its {@link LineKind}.
 *
 * PRECEDENCE IS MANDATORY — `command-done` (the structured-output success
 * marker `→ structured_output ✓`) is matched BEFORE the generic `→ ` command
 * marker because command-done is a specialisation of command. Leading
 * whitespace is trimmed FIRST because the sink stores lines with a leading
 * two-space indent, so a stored `  → cmd` arrives here still indented and must
 * still classify as `command` (SCENARIO-003).
 *
 * Order:
 *   1. `→ structured_output … ✓` → command-done  (BEFORE generic command)
 *   2. `→ `                       → command
 *   3. `↻ `                       → corrective
 *   4. `▶ `                       → phase
 *   5. `❌` / "failed after" / "did NOT complete" → error
 *   6. `⚠` / /stagnan/i           → log-warning
 *   7. PASS / GREEN / ✓ / passed / complete → log-success
 *   8. FAIL / ✗ / \berror\b       → log-error
 *   9. "… earlier lines trimmed" marker → trim
 *  10. otherwise (indented or plain) → log
 */
export function classifyLine(text: string): LineKind {
	const t = text.trimStart();
	// 1. command-done BEFORE command — structured-output success marker.
	if (/^→ structured_output\b.*✓/.test(t)) return "command-done";
	// 2. generic command marker.
	if (t.startsWith("→ ")) return "command";
	// 3. corrective / retry marker.
	if (t.startsWith("↻ ")) return "corrective";
	// 4. phase marker.
	if (t.startsWith("▶ ")) return "phase";
	// 5. error markers.
	if (t.startsWith("❌") || /failed after/i.test(t) || /did NOT complete/i.test(t)) {
		return "error";
	}
	// 6. warning markers.
	if (t.startsWith("⚠") || /stagnan/i.test(t)) return "log-warning";
	// 7. success markers.
	if (
		/\bPASS\b/.test(t) ||
		t.includes("GREEN") ||
		t.includes("✓") ||
		/passed/i.test(t) ||
		/complete/i.test(t)
	) {
		return "log-success";
	}
	// 8. failure / error markers.
	if (/FAIL/.test(t) || t.includes("✗") || /\berror\b/i.test(t)) return "log-error";
	// 9. synthetic rolling-tail trim notice.
	if (/earlier lines trimmed/.test(t)) return "trim";
	// 10. indented or plain text → log.
	return "log";
}

/**
 * Split a command line into its bold "tool title" name and the dimmed "rest",
 * on the FIRST space. Leading whitespace is trimmed first so an indented
 * stored command (`  → npm install`) splits the same as its canonical form
 * (`→ npm install`) → name `→`, rest `npm install`. When there is no space the
 * whole (trimmed) string is the name and the rest is empty.
 */
function splitNameRest(text: string): { name: string; rest: string } {
	const t = text.trimStart();
	const idx = t.indexOf(" ");
	if (idx === -1) return { name: t, rest: "" };
	return { name: t.slice(0, idx), rest: t.slice(idx + 1) };
}

/**
 * Style a line according to its kind using pi-native foreground tokens.
 *
 * Token map (SCENARIO-004):
 *   phase        → fg("accent",   bold(text))
 *   command      → fg("toolTitle",bold(name)) + " " + fg("dim", rest)
 *   command-done → fg("toolTitle",bold(text))
 *   corrective   → fg("warning",  text)
 *   log (plain)  → fg("text",     text)
 *   log (indented)→ fg("dim",     text)
 *   log-success  → fg("success",  text)
 *   log-warning  → fg("warning",  text)
 *   log-error    → fg("error",    text)
 *   thinking     → fg("thinkingText", text)
 *   error        → fg("error",    bold(text))
 *   trim         → fg("muted",    text)
 *
 * GRACEFUL-DEGRADE CONTRACT (SCENARIO-005): when `theme` is `undefined`
 * (print / json / RPC / headless modes), the RAW text is returned byte-for-byte
 * with ZERO ANSI escape bytes — no styling, no bold, no wrapping.
 */
export function themeLine(kind: LineKind, text: string, theme?: DashboardTheme): string {
	// SCENARIO-005: no theme → raw text, zero ANSI.
	if (!theme) return text;
	// HOTFIX: call theme.fg / theme.bold METHOD-STYLE (not destructured). The real
	// pi Theme is a class whose `fg()` reads `this.fgColors`; detaching via
	// `const fg = theme.fg; fg(...)` loses `this` and throws "reading 'fgColors'"
	// on undefined. Plain-object mock themes happen to survive detachment, so the
	// bug only surfaces against the real Theme at runtime — see the class-theme
	// regression test (tests/stream-theme-class-theme.test.ts).
	const bold = (value: string): string => (theme.bold ? theme.bold(value) : value);
	const fg = (color: string, value: string): string => theme.fg(color, value);
	switch (kind) {
		case "phase":
			return fg("accent", bold(text));
		case "command": {
			const { name, rest } = splitNameRest(text);
			return fg("toolTitle", bold(name)) + (rest ? ` ${fg("dim", rest)}` : "");
		}
		case "command-done":
			return fg("toolTitle", bold(text));
		case "corrective":
			return fg("warning", text);
		case "log":
			// Indented logs render dimmed (subordinate detail); plain logs render
			// in the base text color.
			return /^\s/.test(text) ? fg("dim", text) : fg("text", text);
		case "log-success":
			return fg("success", text);
		case "log-warning":
			return fg("warning", text);
		case "log-error":
			return fg("error", text);
		case "thinking":
			return fg("thinkingText", text);
		case "error":
			return fg("error", bold(text));
		case "trim":
			return fg("muted", text);
		// Phase 2 (AC-07 / SCENARIO-009): mid-run user input is tagged directly at
		// the sink (NOT derived by classifyLine), like thinking/trim. Styled
		// accent+bold (mirrors `phase`) so queued guidance stands out in the tail.
		// Uses the METHOD-bound `fg`/`bold` wrappers above so the real class-based
		// pi Theme (whose `fg()` reads `this.fgColors`) survives without a detached-
		// `this` throw (SCENARIO-011 / SCENARIO-022).
		case "user-input":
			return fg("accent", bold(text));
		default:
			// Exhaustiveness guard — every LineKind is handled above.
			return text;
	}
}

/**
 * Map a pipeline stage status → its pi foreground theme token. Shared by the
 * streaming live view (live-stream.ts `renderSectionHeader`) AND the
 * completed-run result view (dashboard.ts per-stage block header) so BOTH
 * surfaces render a given status identically — a single source of truth for
 * the status→color taxonomy (previously duplicated in three places).
 *
 *   ok       → "success"
 *   failed   → "error"
 *   skipped  → "warning"
 *   running  → "accent"
 *   undefined / unknown → "accent"  (treated as in-progress)
 *
 * An UNTRACKED status (including the "pre-stage" sentinel) resolves to
 * `accent` — NOT green/success — on BOTH surfaces, so an untracked stage is
 * never silently masked as ok (which would hide pre-stage failures). This is
 * the symmetric treatment that keeps the live view and the result view
 * consistent for stages with no recorded status.
 */
export function statusFgToken(status: string | undefined): string {
	if (status === "ok") return "success";
	if (status === "failed") return "error";
	if (status === "skipped") return "warning";
	return "accent";
}

/**
 * Resolve the tool-bubble background paint function for a kind (SCENARIO-006).
 *
 *   command      → theme.bg("toolPendingBg", _)
 *   command-done → theme.bg("toolSuccessBg", _)
 *   (every other kind) → undefined
 *
 * The returned closure is the value handed to pi-tui `Text`'s 4th
 * `customBgFn` constructor argument so the per-line command bubble is painted
 * with the pending (running) or success (completed) tool background.
 *
 * GRACEFUL-DEGRADE CONTRACT (SCENARIO-005): returns `undefined` when there is
 * no theme OR the theme has no `bg` member (the `DashboardTheme.bg` member is
 * optional), so non-TUI paths never attempt to paint a background.
 */
export function commandBackground(
	kind: LineKind,
	theme?: DashboardTheme,
): ((text: string) => string) | undefined {
	// No theme / theme without the optional bg member → no background paint.
	if (!theme?.bg) return undefined;
	switch (kind) {
		case "command":
			return (text: string) => theme.bg!("toolPendingBg", text);
		case "command-done":
			return (text: string) => theme.bg!("toolSuccessBg", text);
		default:
			return undefined;
	}
}
