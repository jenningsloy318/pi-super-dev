/**
 * Regression guard: themeLine + buildResultComponent must work against a
 * CLASS-based theme whose methods read `this.<map>` — NOT just plain-object
 * mock themes. The real pi Theme is a class (`fg()` reads `this.fgColors`).
 *
 * Bug this guards: an earlier impl did `const fg = theme.fg; fg(...)` which
 * DETACHES the method from `this`. With a plain-object mock that survives
 * (no `this` needed); against the real class it throws
 * "Cannot read properties of undefined (reading 'fgColors')" — which crashed
 * super_dev's whole setup stage at runtime while every unit test passed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { themeLine, commandBackground } from "../src/render/stream-theme.ts";
import { buildResultComponent } from "../src/render/dashboard.ts";

/** A class-based theme that mimics the real pi Theme's `this`-dependent methods. */
class ClassTheme {
	private fgColors: Map<string, string>;
	constructor() {
		// Store ANSI-wrapping per color, exactly like pi's Theme.fg reads this.fgColors.
		// Include every token themeLine/buildResultComponent may request (the real pi
		// Theme defines all of these; an unknown token throws "Unknown theme color").
		const codes: Record<string, string> = {
			accent: "\x1b[35m", toolTitle: "\x1b[36m", dim: "\x1b[2m", text: "\x1b[0m",
			success: "\x1b[32m", error: "\x1b[31m", warning: "\x1b[33m", muted: "\x1b[90m",
			thinkingText: "\x1b[34m",
		};
		this.fgColors = new Map(Object.entries(codes));
	}
	fg(color: string, text: string): string {
		const ansi = this.fgColors.get(color); // throws "reading 'fgColors'" if `this` is undefined
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

describe("class-based theme regression — methods must not be detached from `this`", () => {
	// §3 Markdown rendering reads the module-global theme (getMarkdownTheme),
	// which pi initializes at startup via initTheme().
	beforeAll(() => initTheme());
	it("themeLine does NOT throw 'reading fgColors' against a class theme (phase)", () => {
		const t = new ClassTheme();
		expect(() => themeLine("phase", "▶ Stage 1", t)).not.toThrow();
		const out = themeLine("phase", "▶ Stage 1", t);
		expect(out).toContain("▶ Stage 1");
		expect(out).toContain("\x1b[35m"); // accent fg applied via this.fgColors
	});

	it("themeLine covers every kind without throwing against a class theme", () => {
		const t = new ClassTheme();
		const cases: Array<Parameters<typeof themeLine>[0]> = [
			"command", "command-done", "corrective", "log", "log-success",
			"log-warning", "log-error", "thinking", "error", "trim",
		];
		for (const kind of cases) {
			expect(() => themeLine(kind, "sample line", t), `kind=${kind}`).not.toThrow();
		}
	});

	it("commandBackground returns a fn that calls theme.bg METHOD-style (no detached throw)", () => {
		const t = new ClassTheme();
		const bg = commandBackground("command", t);
		expect(bg).toBeTypeOf("function");
		// Invoking the returned customBgFn must not lose `this`:
		expect(() => bg!("x")).not.toThrow();
		expect(bg!("x")).toContain("\x1b[7m"); // bg applied via this-bound method
	});

	it("buildResultComponent renders against a class theme without throwing", () => {
		const t = new ClassTheme();
		const details = {
			summaryLines: ["## Summary", "ok"],
			transcriptTail: [
				{ kind: "command" as const, text: "→ read foo" },
				{ kind: "thinking" as const, text: "considering..." },
				{ kind: "phase" as const, text: "▶ Stage 1" },
			],
			stages: [{ label: "Setup", status: "ok" }],
		};
		expect(() => buildResultComponent(details, t)).not.toThrow();
		const comp = buildResultComponent(details, t);
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("read foo");
		expect(rendered).toContain("considering...");
	});
});
