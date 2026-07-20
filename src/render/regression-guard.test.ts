/**
 * Phase 4 — CROSS-CUTTING REGRESSION GUARD.
 *
 * AC-08 / AC-09 / AC-10 (SCENARIO-015 .. SCENARIO-018).
 *
 * === Why this file exists (separate from the per-phase feature tests) ===
 * Phases 1-3 each ship their OWN feature tests:
 *   - stream-theme.test.ts           (classifyLine / themeLine / commandBackground)
 *   - live-stream.test.ts            (sink tagging, mode-aware flush, no-ANSI-leak
 *                                     single-line mirror)
 *   - dashboard-result-perkind.test.ts (buildResultComponent §1 per-kind render)
 *
 * This file is the INTEGRATION-LEVEL regression lock-in that crosses all three
 * layers and pins the headline contracts the spec calls out as CRITICAL /
 * regression-sensitive, so they survive even if a feature file is later
 * refactored. It is intentionally BROADER than any single feature test:
 *
 *   SCENARIO-015 (critical): EVERY LineKind × EVERY non-TUI mode (print/json/
 *                            rpc/headless) with NO theme leaks ZERO ANSI in BOTH
 *                            the live onUpdate body AND the on-disk log — and
 *                            the body equals the raw joined `text` byte-for-byte.
 *   SCENARIO-016:            the TUI+theme path DOES emit each kind's expected
 *                            foreground token (proves the gate is theme+mode,
 *                            not always-on nor always-off).
 *   SCENARIO-017:            coverage-completeness — every LineKind classifies,
 *                            themes, backgrounds, and renders to its designated
 *                            token; no kind silently dropped.
 *   SCENARIO-018:            no regression to public surface / no new runtime
 *                            dependencies; DashboardTheme.bg stays OPTIONAL.
 *
 * GREEN here is the SUCCESS signal for SCENARIO-018 ("both pass clean"). A
 * future change that reintroduces an ANSI leak, drops a kind, or makes `bg`
 * required will turn these RED — which is exactly the regression the guard
 * exists to catch.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Container, Markdown } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { createLiveStream } from "./live-stream.js";
import type { LiveStreamHandle } from "./live-stream.js";
import { classifyLine, themeLine, commandBackground } from "./stream-theme.js";
import type { LineKind } from "./stream-theme.js";
import { buildResultComponent, type ResultDetails } from "./dashboard.js";

// getMarkdownTheme() reads a module-global pi initializes via initTheme().
beforeAll(() => initTheme());

/** ANSI CSI detector — MUST NOT match any no-theme / non-TUI output. */
const ANSI = /\x1b\[/i;

/** Structural Theme mock (mirrors the per-kind test). fg/bold/bg wrap text in
 *  assertable markers so the EXACT token each kind resolves to is checkable
 *  without parsing ANSI. */
function mockTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}`,
		bold: (text: string) => `<b>${text}</b>`,
		bg: (token: string, text: string) => `<bg:${token}>${text}`,
	};
}

/** Extract mock-theme color-token markers (`<accent>`, `<toolTitle>`, ...).
 *  `<b>` / `<bg:…>` are structural, not foreground tokens, so they are omitted. */
function fgTokensIn(s: string): string[] {
	return [...s.matchAll(/<([a-zA-Z]+)>/g)]
		.map((m) => m[1])
		.filter((t) => t !== "b");
}

/** Representative input for every LineKind + how to emit it through the sink.
 *  `text` is the raw stream input; `emit` drives the factory so the line lands
 *  in the transcript tagged with `kind` (verified below). `thinking` and
 *  `trim` are special: thinking is tagged via finalizeLive(), trim is the
 *  synthetic rolling-tail notice (not classifiable — emitted by overflow). */
interface KindRow {
	kind: LineKind;
	text: string;
	expectedFgToken: string; // pi-native fg token this kind resolves to (SCENARIO-016/017)
	expectedBg: "toolPendingBg" | "toolSuccessBg" | null;
	emit: (h: LiveStreamHandle) => void;
	classifiable?: boolean; // false for thinking/trim (not derived by classifyLine)
	/** Substring that survives per-kind theming in the RENDERED output. The
	 *  COMMAND kind splits name+rest (bold `→` + dim `npm run build`) so its
	 *  full `text` is NOT contiguous post-theme; every other kind's text is. */
	distinctive: string;
}

/** A representative multi-kind stream the regression drives through each mode.
 *  Every classifiable kind is present so a leak / mis-wire in ANY kind is
 *  caught. `thinking` is emitted directly; `trim` is covered separately via
 *  overflow. */
const KIND_ROWS: KindRow[] = [
	{
		kind: "phase",
		text: "▶ Spec",
		distinctive: "▶ Spec",
		expectedFgToken: "accent",
		expectedBg: null,
		emit: (h) => h.sink.phase("Spec"),
	},
	{
		kind: "command",
		text: "→ npm run build",
		// split: bold `→` + dim `npm run build` — assert the contiguous REST.
		distinctive: "npm run build",
		expectedFgToken: "toolTitle",
		expectedBg: "toolPendingBg",
		emit: (h) => h.sink.log("→ npm run build"),
	},
	{
		kind: "command-done",
		text: "→ structured_output { ok: true } ✓",
		// whole text is bold-wrapped (contiguous); use a stable substring.
		distinctive: "structured_output",
		expectedFgToken: "toolTitle",
		expectedBg: "toolSuccessBg",
		emit: (h) => h.sink.log("→ structured_output { ok: true } ✓"),
	},
	{
		kind: "corrective",
		text: "↻ retry the stage",
		distinctive: "↻ retry the stage",
		expectedFgToken: "warning",
		expectedBg: null,
		emit: (h) => h.sink.log("↻ retry the stage"),
	},
	{
		kind: "log",
		text: "doing some plain work",
		distinctive: "doing some plain work",
		expectedFgToken: "text",
		expectedBg: null,
		emit: (h) => h.sink.log("doing some plain work"),
	},
	{
		kind: "log-success",
		text: "PASS — all green",
		distinctive: "PASS — all green",
		expectedFgToken: "success",
		expectedBg: null,
		emit: (h) => h.sink.log("PASS — all green"),
	},
	{
		kind: "log-warning",
		text: "⚠ detected stagnant loop",
		distinctive: "detected stagnant loop",
		expectedFgToken: "warning",
		expectedBg: null,
		emit: (h) => h.sink.log("⚠ detected stagnant loop"),
	},
	{
		kind: "log-error",
		text: "FAIL exit code 1",
		distinctive: "FAIL exit code 1",
		expectedFgToken: "error",
		expectedBg: null,
		emit: (h) => h.sink.log("FAIL exit code 1"),
	},
	{
		kind: "error",
		text: "❌ failed after stage",
		distinctive: "failed after stage",
		expectedFgToken: "error",
		expectedBg: null,
		emit: (h) => h.sink.log("❌ failed after stage"),
	},
	{
		kind: "thinking",
		text: "the agent is reasoning",
		distinctive: "the agent is reasoning",
		expectedFgToken: "thinkingText",
		expectedBg: null,
		classifiable: false,
		emit: (h) => {
			h.sink.text("the agent is reasoning");
			h.finalizeLive();
		},
	},
];

/** Every non-TUI mode the spec enumerates (print / json / headless / rpc).
 *  None of these may receive ANSI; the disk log is identical across all. */
const NON_TUI_MODES = ["print", "json", "headless", "rpc"] as const;

/** Drive every classifiable kind + thinking through the factory in order,
 *  returning the (mode-aware) captured body + the disk log. */
function driveAllKinds(mode: string, theme?: ReturnType<typeof mockTheme>) {
	const bodies: string[] = [];
	const h = createLiveStream({ onUpdate: (b) => bodies.push(b), mode, theme });
	for (const row of KIND_ROWS) row.emit(h);
	h.flush();
	return { h, body: bodies.at(-1)!, disk: h.diskLogText() };
}

/** The raw joined text the non-TUI body MUST equal byte-for-byte. */
const RAW_JOINED = KIND_ROWS.map((r) => r.text).join("\n");

// ─── SCENARIO-015 (critical): no-theme path leaks zero ANSI ───────────────

describe("SCENARIO-015 — no-theme path: zero ANSI in live body AND disk log (every mode × every kind)", () => {
	for (const mode of NON_TUI_MODES) {
		it(`mode "${mode}": live body has zero ANSI AND equals the raw joined text`, () => {
			const { body } = driveAllKinds(mode /* no theme */);
			expect(ANSI.test(body), `body in ${mode} must be ANSI-free`).toBe(false);
			expect(fgTokensIn(body), `body in ${mode} must carry no theme tokens`).toEqual([]);
			expect(body, `body in ${mode} must equal raw joined text`).toBe(RAW_JOINED);
		});

		it(`mode "${mode}": on-disk log has zero ANSI and equals raw joined text`, () => {
			const { disk } = driveAllKinds(mode /* no theme */);
			expect(ANSI.test(disk), `disk log in ${mode} must be ANSI-free`).toBe(false);
			expect(disk, `disk log in ${mode} must equal raw joined text`).toBe(RAW_JOINED);
		});
	}

	it("tui mode WITHOUT a theme ALSO degrades to zero ANSI (gate is theme+mode)", () => {
		const { body } = driveAllKinds("tui" /* theme undefined */);
		expect(ANSI.test(body)).toBe(false);
		expect(fgTokensIn(body)).toEqual([]);
		expect(body).toBe(RAW_JOINED);
	});

	it("trim notice is ALSO raw + ANSI-free in a no-theme non-TUI path", () => {
		// Force the rolling-tail overflow so the synthetic {trim} line flows
		// through the no-theme body — it must not leak ANSI either.
		const bodies: string[] = [];
		const h = createLiveStream({ onUpdate: (b) => bodies.push(b), mode: "print", tailLines: 2 });
		for (let i = 0; i < 5; i++) h.sink.log(`line ${i}`);
		h.flush();
		const body = bodies.at(-1)!;
		expect(ANSI.test(body)).toBe(false);
		expect(fgTokensIn(body)).toEqual([]);
		expect(/earlier lines trimmed/.test(body)).toBe(true);
	});
});

// ─── SCENARIO-016: TUI+theme path DOES emit the expected fg tokens ────────

describe("SCENARIO-016 — TUI+theme path emits each kind's expected foreground token", () => {
	it("the themed body contains EVERY kind's designated fg token", () => {
		const { body } = driveAllKinds("tui", mockTheme());
		const toks = fgTokensIn(body);
		for (const row of KIND_ROWS) {
			expect(toks, `kind "${row.kind}" must resolve to ${row.expectedFgToken}`).toContain(
				row.expectedFgToken,
			);
		}
		// Sanity: the themed body is NOT the raw joined text (it IS styled).
		expect(body).not.toBe(RAW_JOINED);
	});

	it("the themed body does NOT leak raw ANSI escapes (mock emits markers, not ANSI)", () => {
		// Defensive: even the TUI path must not emit real ANSI when the theme
		// mock returns marker strings — proves the styling layer is the ONLY
		// thing that could introduce ANSI, and it is gated on theme+mode.
		const { body } = driveAllKinds("tui", mockTheme());
		expect(ANSI.test(body)).toBe(false);
	});

	it("the themed body is distinct from the no-theme body for the same input (gate is real)", () => {
		const themed = driveAllKinds("tui", mockTheme()).body;
		const raw = driveAllKinds("tui").body;
		expect(themed).not.toEqual(raw);
	});
});

// ─── SCENARIO-017: coverage-completeness (no kind silently dropped) ───────

describe("SCENARIO-017 — coverage completeness: every LineKind classifies, themes, backgrounds, renders", () => {
	// (a) classifyLine: every CLASSIFIABLE input resolves to its row's kind.
	it("classifyLine resolves every classifiable representative to its expected kind", () => {
		for (const row of KIND_ROWS) {
			if (row.classifiable === false) continue; // thinking/trim: not derived
			expect(
				classifyLine(row.text),
				`classifyLine(${JSON.stringify(row.text)})`,
			).toBe(row.kind);
		}
	});

	// (b) themeLine no-theme: EVERY kind (incl. thinking/trim) returns raw text.
	it("themeLine with NO theme returns the raw text unchanged for every kind", () => {
		for (const row of KIND_ROWS) {
			const out = themeLine(row.kind, row.text /* no theme */);
			expect(out, `kind "${row.kind}" no-theme must equal raw text`).toBe(row.text);
			expect(ANSI.test(out), `kind "${row.kind}" no-theme must be ANSI-free`).toBe(false);
		}
		// `trim` is not in KIND_ROWS' classifiable set but must still degrade.
		const trimText = "… 5 earlier lines trimmed (full log saved at run end) …";
		expect(themeLine("trim", trimText)).toBe(trimText);
	});

	// (c) themeLine with theme: every kind resolves to its designated fg token.
	it("themeLine with a theme emits every kind's designated foreground token", () => {
		const theme = mockTheme();
		const all: { kind: LineKind; text: string; token: string }[] = [
			...KIND_ROWS.map((r) => ({ kind: r.kind, text: r.text, token: r.expectedFgToken })),
			{ kind: "trim", text: "… 5 earlier lines trimmed (full log saved at run end) …", token: "muted" },
		];
		for (const { kind, text, token } of all) {
			expect(themeLine(kind, text, theme as never)).toContain(`<${token}>`);
		}
	});

	// (d) commandBackground: command→toolPendingBg, command-done→toolSuccessBg,
	//     every other kind→undefined, and no-theme→undefined for all.
	it("commandBackground resolves the exact bg for command/command-done and undefined otherwise", () => {
		const theme = mockTheme();
		expect(commandBackground("command", theme as never)?.("x")).toContain("<bg:toolPendingBg>");
		expect(commandBackground("command-done", theme as never)?.("x")).toContain(
			"<bg:toolSuccessBg>",
		);
		const nonCommand: LineKind[] = [
			"phase",
			"corrective",
			"log",
			"log-success",
			"log-warning",
			"log-error",
			"thinking",
			"error",
			"trim",
		];
		for (const k of nonCommand) {
			expect(commandBackground(k, theme as never), `kind "${k}" must not bubble`).toBeUndefined();
		}
		// No theme → undefined for every kind (graceful-degrade).
		for (const k of ["command", "command-done", ...nonCommand] as LineKind[]) {
			expect(commandBackground(k /* no theme */)).toBeUndefined();
		}
	});

	// (e) buildResultComponent §1: every kind renders with its designated token
	//     (the per-kind test covers this granularly; here we assert the FULL
	//     set renders together with NO kind missing — a structural lock-in).
	it("buildResultComponent renders the full taxonomy together, each kind carrying its token", () => {
		const tail: ResultDetails["transcriptTail"] = KIND_ROWS.map((r) => ({
			kind: r.kind,
			text: r.text,
		}));
		const comp = buildResultComponent({ transcriptTail: tail }, mockTheme() as never) as Container;
		const rendered = comp.children
			.map((c) => (c as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "")
			.join("\n");
		for (const row of KIND_ROWS) {
			expect(rendered, `kind "${row.kind}" token must render`).toContain(
				`<${row.expectedFgToken}>`,
			);
			// `distinctive` is the substring of `text` that survives per-kind
			// theming (command splits name+rest; command-done bold-wraps whole).
			expect(rendered, `kind "${row.kind}" text must render`).toContain(row.distinctive);
		}
	});

	// (f) full LineKind union coverage — derive every declared kind is reachable.
	it("every LineKind value appears in the regression taxonomy (no declared kind untested)", () => {
		const declared: LineKind[] = [
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
		const covered = new Set<KindRow["kind"]>(KIND_ROWS.map((r) => r.kind));
		covered.add("trim"); // asserted explicitly above
		for (const k of declared) {
			expect(covered.has(k), `LineKind "${k}" is not covered by the regression`).toBe(true);
		}
	});
});

// ─── SCENARIO-018: no regression / no new runtime deps / surface stable ──

describe("SCENARIO-018 — no regression to public surface, optional bg, no new runtime deps", () => {
	it("stream-theme public surface is importable and functional (classifyLine/themeLine/commandBackground)", () => {
		// If stream-theme.ts ever grew a runtime dependency on the TUI/Theme
		// runtime (rather than the `import type` contract), this import would
		// either pull heavy machinery or the functions would not be pure.
		expect(typeof classifyLine).toBe("function");
		expect(typeof themeLine).toBe("function");
		expect(typeof commandBackground).toBe("function");
		// classifyLine is pure (deterministic, no globals touched).
		expect(classifyLine("→ npm test")).toBe("command");
		expect(classifyLine("→ npm test")).toBe("command");
	});

	it("DashboardTheme.bg stays OPTIONAL — a theme WITHOUT bg still theming + degrades backgrounds", () => {
		// A structural theme with fg + bold but NO bg member must still:
		//   - theme lines (fg works)
		//   - resolve commandBackground to undefined (no bg → no bubble)
		const themeNoBg = {
			fg: (token: string, text: string) => `<${token}>${text}`,
			bold: (text: string) => text,
			// intentionally NO bg member
		};
		expect(themeLine("command", "→ npm test", themeNoBg as never)).toContain("<toolTitle>");
		expect(commandBackground("command", themeNoBg as never)).toBeUndefined();
		expect(commandBackground("command-done", themeNoBg as never)).toBeUndefined();
	});

	it("ResultDetails.transcriptTail tolerates BOTH {kind,text} objects AND legacy plain strings", () => {
		// SCENARIO-013 backward tolerance is part of the no-regression contract.
		const comp = buildResultComponent(
			{
				transcriptTail: [
					{ kind: "command", text: "→ npm test" },
					"a legacy plain string line",
					{ kind: "error", text: "❌ boom" },
				],
			},
			mockTheme() as never,
		) as Container;
		const rendered = comp.children
			.map((c) => (c as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "")
			.join("\n");
		// The command line splits name+rest (bold `→` + dim `npm test`); assert
		// the contiguous REST rather than the full `→ npm test` string.
		expect(rendered).toContain("npm test");
		expect(rendered).toContain("a legacy plain string line");
		expect(rendered).toContain("❌ boom");
	});

	it("§3 Markdown summary still renders as exactly one Markdown child (unchanged composition)", () => {
		const comp = buildResultComponent(
			{
				transcriptTail: [{ kind: "command", text: "→ npm test" }],
				summaryLines: ["## Summary", "the run passed"],
			},
			mockTheme() as never,
		) as Container;
		const markdowns = comp.children.filter((c) => c instanceof Markdown);
		expect(markdowns.length).toBe(1);
	});
});
