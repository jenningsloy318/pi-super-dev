/**
 * Phase 1 unit tests — the PURE stream-theme module.
 *
 * Drives the single classification authority (`classifyLine`), the per-kind
 * pi-native token mapping (`themeLine`), the graceful-degrade contract
 * (undefined theme → raw text, zero ANSI), and the tool-bubble background
 * resolver (`commandBackground`). All pure: a structural `DashboardTheme` mock
 * wraps text in token markers so we assert WHICH token was applied without
 * parsing ANSI.
 *
 * Coverage: AC-01 (SCENARIO-001/002/003), AC-02 (SCENARIO-004/005/006),
 * AC-03 (SCENARIO-007 — the extended shape with optional bg is accepted).
 */
import { describe, it, expect } from "vitest";

import {
	classifyLine,
	themeLine,
	commandBackground,
	type LineKind,
} from "./stream-theme.js";
import type { DashboardTheme } from "./dashboard.js";

/**
 * Structural theme mock. `fg`/`bg` wrap text in a token marker; `bold` wraps
 * in `<b>`. Includes `bg` so the extended `DashboardTheme` shape (SCENARIO-007)
 * is exercised and `commandBackground` can resolve.
 */
function mockTheme(): Required<DashboardTheme> {
	return {
		fg: (token, text) => `<${token}>${text}`,
		bg: (token, text) => `<<${token}>>${text}`,
		bold: (text) => `<b>${text}</b>`,
	};
}

/** A theme WITHOUT the optional `bg` member (older callers). */
function fgOnlyTheme(): DashboardTheme {
	return {
		fg: (token, text) => `<${token}>${text}`,
		bold: (text) => `<b>${text}</b>`,
	};
}

/** ANSI CSI sequence detector — must NEVER match a graceful-degrade output. */
const ANSI = /\x1b\[/i;
/** Color-token marker extractor for mock-theme outputs. The `<b>` bold
 * wrapper is structural, not a color token, so it is filtered out. */
function tokensOf(styled: string): string[] {
	return [...styled.matchAll(/<([a-zA-Z]+)>/g)]
		.map((m) => m[1]!)
		.filter((tok) => tok !== "b");
}

describe("classifyLine — AC-01 / SCENARIO-001/002/003", () => {
	it("classifies one representative line per LineKind (SCENARIO-001)", () => {
		const cases: Array<[string, LineKind]> = [
			["→ structured_output ✓", "command-done"],
			["→ npm install", "command"],
			["↻ retrying after transient error", "corrective"],
			["▶ Requirements", "phase"],
			["❌ BUILD_BLOCKED", "error"],
			["⚠ approaching retry budget", "log-warning"],
			["all tests PASS", "log-success"],
			["FAIL src/foo.test.ts", "log-error"],
			["… 12 earlier lines trimmed (full log saved at run end) …", "trim"],
			["some plain process output line", "log"],
		];
		for (const [text, expected] of cases) {
			expect(classifyLine(text), `line: ${JSON.stringify(text)}`).toBe(expected);
		}
	});

	it("recognizes the structured-output success line BEFORE the generic command (SCENARIO-002)", () => {
		expect(classifyLine("→ structured_output ✓")).toBe("command-done");
		// A plain command must still be a plain command.
		expect(classifyLine("→ npm run build")).toBe("command");
	});

	it("trims leading whitespace before prefix matching (SCENARIO-003)", () => {
		// sink.log stores lines with a leading two-space indent.
		expect(classifyLine("  → npm install")).toBe("command");
		expect(classifyLine("  → structured_output ✓")).toBe("command-done");
		expect(classifyLine("  ▶ Design")).toBe("phase");
		expect(classifyLine("  ↻ corrective retry")).toBe("corrective");
	});

	it("detects the full error/warning/success keyword set", () => {
		expect(classifyLine("stage failed after 3 retries")).toBe("error");
		expect(classifyLine("agent did NOT complete")).toBe("error");
		expect(classifyLine("pipeline is stagnant")).toBe("log-warning");
		expect(classifyLine("GREEN: 42 passing")).toBe("log-success");
		expect(classifyLine("build complete")).toBe("log-success");
		expect(classifyLine("1 test FAIL")).toBe("log-error");
		expect(classifyLine("unexpected error in module")).toBe("log-error");
	});
});

describe("themeLine — AC-02 / SCENARIO-004", () => {
	it("maps each kind to its designated pi foreground token (SCENARIO-004)", () => {
		const theme = mockTheme();
		const cases: Array<{ kind: LineKind; text: string; expect: (s: string) => void }> = [
			// phase → accent + bold (mock emits opening tag only)
			{ kind: "phase", text: "▶ Requirements", expect: (s) => { expect(s).toBe("<accent><b>▶ Requirements</b>"); } },
			// command → toolTitle(bold name)) + dim(rest); name/rest split on first space
			{ kind: "command", text: "→ npm install", expect: (s) => expect(s).toBe("<toolTitle><b>→</b> <dim>npm install") },
			// command-done → toolTitle + bold (whole text)
			{
				kind: "command-done",
				text: "→ structured_output ✓",
				expect: (s) => {
					expect(tokensOf(s)).toEqual(["toolTitle"]);
					expect(s).toContain("<b>");
				},
			},
			// corrective → warning
			{ kind: "corrective", text: "↻ retrying", expect: (s) => expect(tokensOf(s)).toEqual(["warning"]) },
			// plain log → text
			{ kind: "log", text: "plain line", expect: (s) => expect(tokensOf(s)).toEqual(["text"]) },
			// indented log → dim
			{ kind: "log", text: "  indented detail", expect: (s) => expect(tokensOf(s)).toEqual(["dim"]) },
			// log-success → success
			{ kind: "log-success", text: "all PASS", expect: (s) => expect(tokensOf(s)).toEqual(["success"]) },
			// log-warning → warning
			{ kind: "log-warning", text: "⚠ warn", expect: (s) => expect(tokensOf(s)).toEqual(["warning"]) },
			// log-error → error
			{ kind: "log-error", text: "FAIL x", expect: (s) => expect(tokensOf(s)).toEqual(["error"]) },
			// thinking → thinkingText
			{ kind: "thinking", text: "analyzing…", expect: (s) => expect(tokensOf(s)).toEqual(["thinkingText"]) },
			// error → error + bold
			{ kind: "error", text: "❌ broke", expect: (s) => { expect(s).toBe("<error><b>❌ broke</b>"); } },
			// trim → muted
			{ kind: "trim", text: "… trimmed …", expect: (s) => expect(tokensOf(s)).toEqual(["muted"]) },
		];
		for (const { kind, text, expect: assert } of cases) {
			assert(themeLine(kind, text, theme));
		}
	});

	it("splits the command name/rest on the first space and bolds only the name", () => {
		const theme = mockTheme();
		// name is the first token (the arrow marker), rest is everything after.
		// mock fg emits an OPENING tag only → "<toolTitle><b>→</b> <dim>git commit -m fix".
		expect(themeLine("command", "→ git commit -m fix", theme)).toBe(
			"<toolTitle><b>→</b> <dim>git commit -m fix",
		);
		// A command with no space → whole (trimmed) string is the name, no rest.
		expect(themeLine("command", "→build", theme)).toBe("<toolTitle><b>→build</b>");
		// Indented stored command trims before splitting.
		expect(themeLine("command", "  → npm install", theme)).toBe(
			"<toolTitle><b>→</b> <dim>npm install",
		);
	});
});

describe("themeLine graceful-degrade — AC-02 / SCENARIO-005", () => {
	it("returns the raw text byte-for-byte with ZERO ANSI when theme is undefined", () => {
		const kinds: LineKind[] = [
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
		];
		for (const kind of kinds) {
			const text = "sample line with content ✓ ❌ ⚠";
			const styled = themeLine(kind, text);
			expect(styled, `kind: ${kind}`).toBe(text);
			expect(ANSI.test(styled), `kind: ${kind} must be ANSI-free`).toBe(false);
		}
	});

	it("commandBackground returns undefined for every kind when there is no theme (SCENARIO-005)", () => {
		const kinds: LineKind[] = [
			"phase",
			"command",
			"command-done",
			"corrective",
			"log",
			"thinking",
			"error",
		];
		for (const kind of kinds) {
			expect(commandBackground(kind), `kind: ${kind}`).toBeUndefined();
		}
	});
});

describe("commandBackground — AC-02 / SCENARIO-006", () => {
	it("resolves the pending tool background for command and success tool background for command-done", () => {
		const theme = mockTheme();
		const pending = commandBackground("command", theme);
		const success = commandBackground("command-done", theme);
		expect(pending).toBeTypeOf("function");
		expect(success).toBeTypeOf("function");
		expect(pending!("x")).toBe("<<toolPendingBg>>x");
		expect(success!("x")).toBe("<<toolSuccessBg>>x");
	});

	it("returns undefined for every non-command kind (SCENARIO-006)", () => {
		const theme = mockTheme();
		for (const kind of [
			"phase",
			"corrective",
			"log",
			"log-success",
			"log-warning",
			"log-error",
			"thinking",
			"error",
			"trim",
		] as LineKind[]) {
			expect(commandBackground(kind, theme), `kind: ${kind}`).toBeUndefined();
		}
	});

	it("returns undefined when the theme has no optional bg member", () => {
		const theme = fgOnlyTheme();
		expect(commandBackground("command", theme)).toBeUndefined();
		expect(commandBackground("command-done", theme)).toBeUndefined();
	});
});

describe("DashboardTheme shape — AC-03 / SCENARIO-007", () => {
	it("accepts a theme with optional bg without breaking fg/bold callers", () => {
		// The extended shape (fg + bold? + bg?) is satisfied by both a full mock
		// and an fg-only mock, and is structurally compatible with the real pi
		// Theme (which declares fg/bg/bold as methods).
		const full: DashboardTheme = mockTheme();
		const fgOnly: DashboardTheme = fgOnlyTheme();
		expect(themeLine("phase", "▶ x", full)).toContain("accent");
		expect(themeLine("phase", "▶ x", fgOnly)).toContain("accent");
		expect(commandBackground("command", full)).toBeTypeOf("function");
		expect(commandBackground("command", fgOnly)).toBeUndefined();
	});
});
