/**
 * Phase 2 (RED) tests — the `"user-input"` LineKind + theme binding (AC-07).
 *
 * Scope of this phase (from the implementation plan + spec testing strategy):
 *   - Add `| "user-input"` to the `LineKind` union (src/render/stream-theme.ts)
 *   - Add `case "user-input": return fg("accent", bold(text));` in `themeLine`
 *
 * These tests reference behavior that DOES NOT EXIST YET:
 *   - `"user-input"` is NOT currently a member of the `LineKind` union, so
 *     `themeLine("user-input", …)` currently falls through to the `default`
 *     branch and returns the RAW text (zero ANSI, no accent, no bold). The
 *     styling assertions below therefore FAIL until the case is implemented.
 *
 * Coverage:
 *   AC-07 → SCENARIO-009 (transcript line rendered themed via the tagged-kind
 *            path), SCENARIO-011 (class-theme method-bound regression),
 *            SCENARIO-022 (no `this.fgColors` detachment throw).
 *
 * Design note: the spec also suggests extending the existing
 * `tests/stream-theme-class-theme.test.ts` `cases` array. That array only
 * asserts `.not.toThrow()` (which already passes via the default branch), so it
 * would NOT be a true RED guard. This file instead asserts the EXACT styling
 * (accent fg + bold) against BOTH a plain-object mock theme and a class-based
 * theme whose `fg()` reads `this.fgColors` — the latter is the real bug guard.
 */
import { describe, it, expect } from "vitest";
import { themeLine } from "../src/render/stream-theme.ts";

/** Plain-object mock theme: records the color token + applies bold. */
const mockTheme = {
	fg: (color: string, value: string): string => `<${color}>${value}</${color}>`,
	bold: (value: string): string => `**${value}**`,
};

/**
 * Class-based theme mimicking the real pi `Theme`: `fg()` reads `this.fgColors`.
 * Destructuring `theme.fg` (then calling it) detaches `this` and throws
 * "reading 'fgColors'" — so this class is the ONLY thing that catches the
 * detachment bug that plain-object mocks miss.
 */
class ClassTheme {
	private fgColors: Map<string, string>;
	constructor() {
		this.fgColors = new Map(
			Object.entries({ accent: "\x1b[35m", text: "\x1b[0m", dim: "\x1b[2m" }),
		);
	}
	fg(color: string, text: string): string {
		const ansi = this.fgColors.get(color); // throws "reading 'fgColors'" if `this` is detached
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`;
	}
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	}
}

describe("Phase 2 — themeLine('user-input', ...) styling against a mock theme (AC-07 / SCENARIO-009)", () => {
	it("applies the accent foreground token to the whole user-input line", () => {
		// Currently RED: default branch returns raw "📥 focus on auth" (no theme call).
		const out = themeLine("user-input", "📥 focus on the auth bug", mockTheme);
		expect(out).toBe("<accent>**📥 focus on the auth bug**</accent>");
	});

	it("uses the method-bound `fg('accent', bold(text))` order (bold is innermost)", () => {
		const out = themeLine("user-input", "hi", mockTheme);
		// bold wraps the text, then fg wraps the bolded result with the accent token.
		expect(out).toContain("**hi**"); // bold applied
		expect(out).toMatch(/^<accent>/); // accent fg applied outermost
	});
});

describe("Phase 2 — themeLine('user-input', ...) graceful degrade when no theme (AC-07 byte-clean)", () => {
	it("returns the RAW text with zero ANSI when no theme is supplied", () => {
		// This is the print/json/headless/RPC path — must be byte-identical to input.
		const out = themeLine("user-input", "📥 focus on the auth bug");
		expect(out).toBe("📥 focus on the auth bug");
		expect(out).not.toContain("\x1b"); // no ANSI escape bytes leak
	});
});

describe("Phase 2 — class-theme regression for 'user-input' (AC-07 / SCENARIO-011 / SCENARIO-022)", () => {
	it("does NOT throw 'reading fgColors' against a class theme (method-bound call)", () => {
		// The real pi Theme is a class whose `fg()` reads `this.fgColors`. If the
		// impl destructures `theme.fg` it loses `this` and throws at runtime while
		// every plain-object mock test passes. This is the guard for that bug.
		const t = new ClassTheme();
		expect(() => themeLine("user-input", "📥 focus on the auth bug", t)).not.toThrow();
	});

	it("applies accent fg + bold against a class theme (proves `this` survived)", () => {
		const t = new ClassTheme();
		const out = themeLine("user-input", "📥 focus on the auth bug", t);
		expect(out).toContain("📥 focus on the auth bug");
		expect(out).toContain("\x1b[35m"); // accent fg via this.fgColors
		expect(out).toContain("\x1b[1m"); // bold applied
	});
});
