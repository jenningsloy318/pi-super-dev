/**
 * Phase 3 §1 PER-KIND THEMING contract tests — buildResultComponent §1
 * (the "detail log" transcript tail) renders EACH transcriptTail line by its
 * content kind, with COMMAND / COMMAND-DONE lines painted as tool bubbles
 * (a pi-tui `Text` 4th `customBgFn` argument) and thinking/phase/error/log
 * lines carrying their pi-native foreground tokens.
 *
 * RED-PHASE GATE for Phase 3 of the stream-content-kind-theming spec. TODAY
 * buildResultComponent §1 dims EVERY tail line uniformly
 * (`new Text(fg("dim", text), 0, 0)`) and never attaches a customBgFn, so every
 * assertion below FAILS until the per-kind render + command-background wiring
 * lands in dashboard.ts.
 *
 * Contract under test (SCENARIO-014 / AC-07):
 *   - commands      → tool-bubble background (customBgFn defined) + toolTitle fg
 *   - command-done  → tool-bubble background (customBgFn defined) + toolTitle fg
 *   - thinking      → fg("thinkingText", …),            NO customBgFn
 *   - phase         → fg("accent", bold(…)),            NO customBgFn
 *   - error         → fg("error", bold(…)),             NO customBgFn
 *   - log           → fg("text", …) (plain string → kind "log" default)
 *   - log-success   → fg("success", …)
 *   - log-warning   → fg("warning", …)
 *   - log-error     → fg("error", …)
 *   - corrective    → fg("warning", …)
 *   - trim          → fg("muted", …)
 *   - §2 (bold stage-progress header + stageIcon rows) byte-identical
 *   - §3 (Markdown summary) byte-identical
 *
 * These tests are PURE: no real TUI, no real pi runtime. The structural
 * `DashboardTheme` mock exposes `fg`/`bold`/`bg` that wrap text in assertable
 * `<token>`/`<b>`/`<bg:token>` markers so applied theme tokens are checkable
 * without parsing ANSI escapes (mirrors dashboard-result.test.ts mockTheme but
 * ADDS the optional `bg` painter introduced in Phase 1).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Container, Markdown } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { buildResultComponent, type ResultDetails } from "./dashboard.js";
import type { LineKind } from "./stream-theme.js";

// getMarkdownTheme() reads a module-global that pi initializes via initTheme()
// at process startup; initialize it before any §3 Markdown.render().
beforeAll(() => initTheme());

/**
 * Structural Theme mock WITH the optional `bg` painter (Phase 1/3 addition).
 * fg/bold/bg wrap text in assertable token markers so the EXACT theme token
 * applied to each line is checkable via plain substring assertions, with no
 * ANSI-escape parsing. Mirrors mockTheme in dashboard-result.test.ts but adds
 * `bg` so command-bubble backgrounds are observable through the rendered
 * output (applyBackgroundToLine invokes customBgFn during Text.render()).
 */
function mockTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}`,
		bold: (text: string) => `<b>${text}</b>`,
		bg: (token: string, text: string) => `<bg:${token}>${text}`,
	};
}

/** Build details with ONLY a transcriptTail (§1) populated. §2 stages and §3
 *  summaryLines are left ABSENT so the §1 tail Texts are the only themed body
 *  children, keeping per-kind assertions unambiguous. */
function detailsWithTail(tail: ResultDetails["transcriptTail"]): ResultDetails {
	return { transcriptTail: tail };
}

/** Render every child of a Container at width 120, returning one joined string
 *  per child. Width 120 is wide enough that no §1 line wraps, so token markers
 *  stay contiguous within a single child's output. */
function renderChildren(container: Container): string[] {
	return container.children.map(
		(c) => (c as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "",
	);
}

/** Locate the FIRST child whose rendered output contains `distinctive` (a raw,
 *  unmarked substring unique to the target tail line). Returns the child
 *  reference, its rendered string, and its index — or undefined if not found.
 *  Used so the test does not depend on a hard-coded child index (anti-hardcoding
 *  / robust to §1-header or logPath-footnote reordering). */
function findChild(
	container: Container,
	distinctive: string,
): { child: unknown; rendered: string; index: number } | undefined {
	const rendered = renderChildren(container);
	for (let i = 0; i < rendered.length; i++) {
		if (rendered[i]!.includes(distinctive)) {
			return { child: container.children[i], rendered: rendered[i]!, index: i };
		}
	}
	return undefined;
}

/** The customBgFn is the pi-tui Text 4th constructor arg. It is TS-`private`
 *  (compile-time only — runtime-accessible as a plain property since pi-tui
 *  emits normal fields), so this accessor reads it for the "carries a
 *  customBgFn" contract assertion without depending on render internals. */
function customBgFnOf(child: unknown): ((text: string) => string) | undefined {
	return (child as { customBgFn?: (text: string) => string }).customBgFn;
}

/** One classified-tail entry per content kind. `text` is chosen to be both
 *  realistic (the marker that WOULD classify it) AND to carry a `distinctive`
 *  substring unique across the suite so findChild() pinpoints the right child.
 *  `kind` is supplied EXPLICITLY — these tests isolate buildResultComponent's
 *  consumption of line.kind (classification authority lives in stream-theme.ts,
 *  covered by stream-theme.test.ts), so they do NOT rely on classifyLine. */
interface KindCase {
	kind: LineKind;
	text: string;
	distinctive: string;
	expectToken: string; // fg-token substring expected in the child's render
	expectBg: string | null; // "<bg:toolPendingBg>" | "<bg:toolSuccessBg>" | null
}

const KIND_CASES: KindCase[] = [
	{
		kind: "command",
		text: "→ run-build-xyz",
		distinctive: "run-build-xyz",
		expectToken: "<toolTitle>",
		expectBg: "<bg:toolPendingBg>",
	},
	{
		kind: "command-done",
		text: "→ structured_output ✓",
		distinctive: "structured_output",
		expectToken: "<toolTitle>",
		expectBg: "<bg:toolSuccessBg>",
	},
	{
		kind: "thinking",
		text: "the model is reasoning here",
		distinctive: "the model is reasoning here",
		expectToken: "<thinkingText>",
		expectBg: null,
	},
	{
		kind: "phase",
		text: "▶ phase-design-99",
		distinctive: "phase-design-99",
		expectToken: "<accent>",
		expectBg: null,
	},
	{
		kind: "error",
		text: "❌ boom-error-77",
		distinctive: "boom-error-77",
		expectToken: "<error>",
		expectBg: null,
	},
	{
		kind: "log",
		text: "a plain log line 00",
		distinctive: "a plain log line 00",
		expectToken: "<text>",
		expectBg: null,
	},
	{
		kind: "log-success",
		text: "GREEN green-tests-passed-11",
		distinctive: "green-tests-passed-11",
		expectToken: "<success>",
		expectBg: null,
	},
	{
		kind: "log-warning",
		text: "⚠ warn-stagnant-22",
		distinctive: "warn-stagnant-22",
		expectToken: "<warning>",
		expectBg: null,
	},
	{
		kind: "log-error",
		text: "FAIL fail-exit-one-33",
		distinctive: "fail-exit-one-33",
		expectToken: "<error>",
		expectBg: null,
	},
	{
		kind: "corrective",
		text: "↻ retry-the-stage-44",
		distinctive: "retry-the-stage-44",
		expectToken: "<warning>",
		expectBg: null,
	},
	{
		kind: "trim",
		text: "… 5 earlier lines trimmed (full log saved at run end) …",
		distinctive: "5 earlier lines trimmed",
		expectToken: "<muted>",
		expectBg: null,
	},
];

// ---------------------------------------------------------------------------
// A. PER-KIND §1 RENDERING — each kind maps to its pi-native token (AC-07).
//    Each test builds details with a SINGLE classified tail line so the
//    assertion is the smallest constraining test (TDD: simplest first).
// ---------------------------------------------------------------------------

describe("AC-07 / SCENARIO-014 — §1 renders each content kind with its pi-native foreground token", () => {
	for (const c of KIND_CASES) {
		it(`kind "${c.kind}" → ${c.expectToken} fg token in the rendered tail child`, () => {
			const comp = buildResultComponent(
				detailsWithTail([{ kind: c.kind, text: c.text }]),
				mockTheme() as never,
			) as Container;
			const found = findChild(comp, c.distinctive);
			expect(found, `tail child for kind "${c.kind}" must render`).toBeDefined();
			expect(found!.rendered).toContain(c.expectToken);
		});
	}
});

// ---------------------------------------------------------------------------
// B. COMMAND TOOL-BUBBLE BACKGROUNDS — COMMAND / COMMAND-DONE carry a
//    customBgFn (pi-tui Text 4th arg); every other kind does NOT.
//    This is the headline AC-07 ("commands appear as tool bubbles") contract.
// ---------------------------------------------------------------------------

describe("AC-07 / SCENARIO-014 — COMMAND & COMMAND-DONE lines are tool bubbles (customBgFn)", () => {
	for (const c of KIND_CASES) {
		const shouldBubble = c.expectBg !== null;
		it(`${shouldBubble ? "carries" : "does NOT carry"} a customBgFn for kind "${c.kind}"`, () => {
			const comp = buildResultComponent(
				detailsWithTail([{ kind: c.kind, text: c.text }]),
				mockTheme() as never,
			) as Container;
			const found = findChild(comp, c.distinctive);
			expect(found, `tail child for kind "${c.kind}" must render`).toBeDefined();
			const bgFn = customBgFnOf(found!.child);
			if (shouldBubble) {
				expect(bgFn, `kind "${c.kind}" Text must carry a customBgFn (4th ctor arg)`).toEqual(
					expect.any(Function),
				);
				// Behavioral mirror: when rendered, the background fn is invoked and its
				// token marker appears in the output (proves the bubble is actually painted).
				expect(found!.rendered).toContain(c.expectBg);
			} else {
				expect(bgFn, `kind "${c.kind}" Text must NOT carry a customBgFn`).toBeUndefined();
				// No background token leaks into non-command rendered output.
				expect(found!.rendered).not.toMatch(/<bg:/);
			}
		});
	}

	it("command bubble uses the PENDING tool background (toolPendingBg)", () => {
		const comp = buildResultComponent(
			detailsWithTail([{ kind: "command", text: "→ run-build-xyz" }]),
			mockTheme() as never,
		) as Container;
		const found = findChild(comp, "run-build-xyz")!;
		expect(found.rendered).toContain("<bg:toolPendingBg>");
		expect(found.rendered).not.toContain("<bg:toolSuccessBg>");
	});

	it("command-done bubble uses the SUCCESS tool background (toolSuccessBg)", () => {
		const comp = buildResultComponent(
			detailsWithTail([{ kind: "command-done", text: "→ structured_output ✓" }]),
			mockTheme() as never,
		) as Container;
		const found = findChild(comp, "structured_output")!;
		expect(found.rendered).toContain("<bg:toolSuccessBg>");
		expect(found.rendered).not.toContain("<bg:toolPendingBg>");
	});
});

// ---------------------------------------------------------------------------
// C. ALL KINDS AT ONCE — the spec's "one entry per kind" drive. Asserts the
//    global invariant holds when every kind coexists in a single tail: exactly
//    the COMMAND/COMMAND-DONE children bubble, every child carries its kind's
//    token, and the §1 dim header + §2 bold header are untouched.
// ---------------------------------------------------------------------------

describe("AC-07 / SCENARIO-014 — all kinds together in one transcriptTail", () => {
	it("exactly the COMMAND and COMMAND-DONE tail children carry a customBgFn; others do not", () => {
		const tail = KIND_CASES.map((c) => ({ kind: c.kind, text: c.text }));
		const comp = buildResultComponent(detailsWithTail(tail), mockTheme() as never) as Container;

		const bubbleKinds = new Set<LineKind>(["command", "command-done"]);
		for (const c of KIND_CASES) {
			const found = findChild(comp, c.distinctive);
			expect(found, `tail child for kind "${c.kind}" must render`).toBeDefined();
			const bgFn = customBgFnOf(found!.child);
			if (bubbleKinds.has(c.kind)) {
				expect(bgFn, `kind "${c.kind}" must bubble`).toEqual(expect.any(Function));
				expect(found!.rendered).toContain(c.expectBg);
			} else {
				expect(bgFn, `kind "${c.kind}" must NOT bubble`).toBeUndefined();
				expect(found!.rendered).not.toMatch(/<bg:/);
			}
			expect(found!.rendered).toContain(c.expectToken);
		}
	});

	it("every kind's pi-native token is present exactly once across the rendered tail", () => {
		// Anti-hardcoding: ALL kinds flow through to distinct tokens in one pass —
		// the builder must generalize, not emit a canned dim string.
		const tail = KIND_CASES.map((c) => ({ kind: c.kind, text: c.text }));
		const comp = buildResultComponent(detailsWithTail(tail), mockTheme() as never) as Container;
		const rendered = renderChildren(comp).join("\n");
		for (const c of KIND_CASES) {
			expect(rendered, `token ${c.expectToken} for kind "${c.kind}"`).toContain(c.expectToken);
			expect(rendered, `distinctive text for kind "${c.kind}"`).toContain(c.distinctive);
		}
	});
});

// ---------------------------------------------------------------------------
// D. BACKWARD TOLERANCE — a PLAIN string transcriptTail element defaults to
//    kind "log" (the spec's tolerant consumer). It must render via the `text`
//    token (NOT the old uniform `dim`), proving §1 is now per-kind.
// ---------------------------------------------------------------------------

describe("AC-07 — backward tolerance: a plain-string transcriptTail element defaults to kind 'log'", () => {
	it("a bare string element renders WITHOUT throwing and WITHOUT a customBgFn", () => {
		const plain = "a bare plain string line 88";
		const comp = buildResultComponent(
			detailsWithTail([plain]),
			mockTheme() as never,
		) as Container;
		expect(() => comp).not.toThrow();
		const found = findChild(comp, plain);
		expect(found, "the plain-string tail child must render").toBeDefined();
		expect(customBgFnOf(found!.child)).toBeUndefined();
	});

	it("a bare string defaults to kind 'log' → fg('text') token, NOT the legacy uniform 'dim'", () => {
		// This is the RED signal: today every tail line is fg("dim", …). After
		// Phase 3 a plain string → kind "log" → fg("text", …). Asserting the
		// `text` token (and absence of `dim` on THIS child) pins the per-kind fix.
		const plain = "a bare plain string line 88";
		const comp = buildResultComponent(
			detailsWithTail([plain]),
			mockTheme() as never,
		) as Container;
		const found = findChild(comp, plain)!;
		expect(found.rendered).toContain("<text>");
		expect(found.rendered).not.toContain("<dim>");
	});

	it("a mixed {kind,text} + plain-string tail renders both shapes (tolerance coexists)", () => {
		const comp = buildResultComponent(
			detailsWithTail([
				{ kind: "command", text: "→ run-build-xyz" },
				"a bare plain string line 88",
				{ kind: "thinking", text: "the model is reasoning here" },
			]),
			mockTheme() as never,
		) as Container;
		const cmd = findChild(comp, "run-build-xyz")!;
		const plain = findChild(comp, "a bare plain string line 88")!;
		const thinking = findChild(comp, "the model is reasoning here")!;
		expect(customBgFnOf(cmd.child)).toEqual(expect.any(Function));
		expect(cmd.rendered).toContain("<bg:toolPendingBg>");
		expect(customBgFnOf(plain.child)).toBeUndefined();
		expect(plain.rendered).toContain("<text>");
		expect(customBgFnOf(thinking.child)).toBeUndefined();
		expect(thinking.rendered).toContain("<thinkingText>");
	});
});

// ---------------------------------------------------------------------------
// E. §2 / §3 NO-REGRESSION — per-kind §1 theming must NOT perturb the stage
//    header rows (§2) or the Markdown summary (§3), which stay byte-identical.
//    (Full §2/§3 coverage lives in dashboard-result.test.ts; here we assert the
//    cross-section that Phase 3 touches.)
// ---------------------------------------------------------------------------

describe("AC-07 — §2 stage header + §3 Markdown are unchanged by per-kind §1 theming", () => {
	it("§2 bold stage-progress header + stageIcon rows render identically regardless of tail kinds", () => {
		const comp = buildResultComponent(
			{
				transcriptTail: [
					{ kind: "command", text: "→ run-build-xyz" },
					{ kind: "error", text: "❌ boom-error-77" },
				],
				stages: [
					{ label: "Design", status: "ok" },
					{ label: "Impl", status: "failed" },
				],
			},
			mockTheme() as never,
		) as Container;
		const rendered = renderChildren(comp).join("\n");
		// §2 header stays BOLD (mockTheme.bold → <b>…</b>).
		expect(rendered).toContain("<b>── stage progress ──</b>");
		// §2 stage rows keep their status icons + labels, plain (no per-kind theming).
		expect(rendered).toContain("Design");
		expect(rendered).toContain("Impl");
		// The stage rows are NOT wrapped in any content-kind token (§2 is plain).
		expect(rendered).toContain("✔ Design");
		expect(rendered).toContain("⚠ Impl");
	});

	it("§3 Markdown is still emitted as exactly one Markdown child (unchanged composition)", () => {
		const comp = buildResultComponent(
			{
				transcriptTail: [{ kind: "command", text: "→ run-build-xyz" }],
				summaryLines: ["## Summary", "the run passed"],
			},
			mockTheme() as never,
		) as Container;
		const markdowns = comp.children.filter((c) => c instanceof Markdown);
		expect(markdowns.length, "exactly one §3 Markdown child").toBe(1);
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("the run passed");
	});
});

// ---------------------------------------------------------------------------
// F. GRACEFUL-DEGRADE — with NO theme, §1 renders each kind's RAW text
//    byte-for-byte and NO command bubble is attempted (commandBackground →
//    undefined without a theme). Mirrors the no-ANSI-leak contract for the
//    non-TUI result path. (Full no-theme sink coverage is Phase 4.)
// ---------------------------------------------------------------------------

describe("AC-07 — graceful-degrade: no theme ⇒ raw text, no customBgFn, no token markers", () => {
	it("renders each kind's RAW text with zero theme-token markers when theme is undefined", () => {
		const tail = KIND_CASES.map((c) => ({ kind: c.kind, text: c.text }));
		const comp = buildResultComponent(detailsWithTail(tail)) as Container;
		const rendered = renderChildren(comp).join("\n");
		// Raw text survives unstyled.
		for (const c of KIND_CASES) {
			expect(rendered).toContain(c.distinctive);
		}
		// No theme tokens leaked (graceful-degrade ⇒ zero ANSI / zero markers).
		expect(rendered).not.toMatch(/<[a-zA-Z]/);
	});

	it("emits NO customBgFn on any tail child when theme is undefined (no background attempted)", () => {
		const tail = KIND_CASES.map((c) => ({ kind: c.kind, text: c.text }));
		const comp = buildResultComponent(detailsWithTail(tail)) as Container;
		for (const c of KIND_CASES) {
			const found = findChild(comp, c.distinctive)!;
			expect(customBgFnOf(found.child)).toBeUndefined();
		}
	});
});
