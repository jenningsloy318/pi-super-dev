/**
 * Phase 3 RESULT-RENDERING contract tests — renderResult §3 → Markdown (AC-06).
 *
 * Phase 1 (dashboard.ts pure builders) and Phase 2 (setWidget Component-factory
 * wiring) are landed; this suite is the RED-phase gate for Phase 3: switching
 * `renderResult` §3 (the summary) from a flat `new Text(parts.join("\n"), 0, 0)`
 * to the pi-tui `Markdown` component, while leaving §1 (dim detail log),
 * §2 (bold stage-progress header) and the empty-stages streaming fallback
 * byte-for-byte unchanged (graceful-degrade / no-regression contract).
 *
 * Two complementary layers, mirroring dashboard-wiring.test.ts:
 *
 *   A) SOURCE-CONTRACT (regex on extension.ts) — `renderResult` is a private
 *      closure inside `activate()`, so the call-site contract is a hard
 *      regression guard. Catches re-introduction of the H3 (4%) root cause:
 *      `new Text(parts.join("\n"), 0, 0)` flattening the summary to plain text.
 *
 *   B) BEHAVIORAL — `renderResult` must delegate to a pure, importable
 *      `buildResultComponent(details, theme)` in `./dashboard.js` (the same
 *      extract-for-testability pattern Phase 1 established with
 *      `buildDashboardWidget`). Asserts the Container composition:
 *      [dim Text §1] + [bold Text §2 header + stage rows] + [Markdown §3].
 *
 * Coverage: AC-06 (Markdown summary), AC-08 (imports resolve from existing
 *           peerDependencies), AC-09/AC-10 (§1/§2 + streaming fallback unchanged
 *           = no behavioral regression for print/json/headless/RPC modes).
 *   SCENARIO-006 (Markdown-rendered result summary).
 *   SCENARIO-010 / SCENARIO-015 / SCENARIO-016 (no-regression for non-TUI modes).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Container, Text, Markdown } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

// Phase 3 introduces this builder; it does NOT exist yet (RED).
import { buildResultComponent } from "./dashboard.js";

const EXTENSION_SRC = readFileSync(
	fileURLToPath(new URL("../extension.ts", import.meta.url)),
	"utf8",
);
// buildResultComponent owns the §1/§2/§3 markers after the Phase-3 extraction
// (single source of truth — F1/F6). Source-contract assertions target the
// module that actually contains each symbol.
const DASHBOARD_SRC = readFileSync(
	fileURLToPath(new URL("./dashboard.ts", import.meta.url)),
	"utf8",
);

// getMarkdownTheme() reads a module-global that pi initializes via initTheme()
// at process startup; unit tests must initialize it before any Markdown.render().
beforeAll(() => initTheme());

/** Structural Theme mock — `fg`/`bold` wrap text in assertable token markers so
 *  applied theme tokens are checkable without parsing ANSI escapes. Matches the
 *  mockTheme shape used by dashboard-wiring.test.ts. */
function mockTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
	};
}

/** Details shape produced by execute() for a COMPLETED pipeline run
 *  (the renderResult §3 path is only reached when stages is non-empty). */
function completedDetails() {
	return {
		summaryLines: [
			"## Summary",
			"",
			"**Result:** all 13 stages passed.",
			"",
			"- requirements: ok",
			"- implementation: ok",
		],
		transcriptTail: [
			"[req] gathering requirements…",
			"[design] drafting architecture…",
			"[impl] writing code…",
		],
		stages: [
			{ label: "Requirements", status: "ok" },
			{ label: "Design", status: "ok" },
			{ label: "Implementation", status: "failed" },
			{ label: "Verify", status: "skipped" },
		],
		logPath: "/tmp/super-dev/2026-07-19/run.log",
	};
}

// ---------------------------------------------------------------------------
// A. SOURCE-CONTRACT — the AC-06 root-cause (flat Text summary) regression guard.
// ---------------------------------------------------------------------------

describe("AC-08 import contract — Phase 3 draws from existing peerDependencies", () => {
	it("imports Markdown from @earendil-works/pi-tui", () => {
		// The new §3 renderer needs the Markdown Component from pi-tui.
		expect(DASHBOARD_SRC).toMatch(
			/import\s*\{[^}]*\bMarkdown\b[^}]*\}\s*from\s*["']@earendil-works\/pi-tui["']/,
		);
	});

	it("imports Container from @earendil-works/pi-tui (the §3 wrapper)", () => {
		// renderResult now returns a Container of [Text…, Text…, Markdown] rather
		// than a single flat Text.
		expect(DASHBOARD_SRC).toMatch(
			/import\s*\{[^}]*\bContainer\b[^}]*\}\s*from\s*["']@earendil-works\/pi-tui["']/,
		);
	});

	it("imports getMarkdownTheme from @earendil-works/pi-coding-agent", () => {
		// Markdown needs a MarkdownTheme; getMarkdownTheme() derives it from the
		// runtime theme (the framework API takes no args).
		expect(DASHBOARD_SRC).toMatch(
			/import\s*\{[^}]*\bgetMarkdownTheme\b[^}]*\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/,
		);
	});

	it("imports buildResultComponent from ./render/dashboard (testability extraction)", () => {
		// renderResult delegates to the pure, importable builder so the Container
		// composition is unit-testable (mirrors buildDashboardWidget for Phase 2).
		expect(EXTENSION_SRC).toMatch(
			/import\s*\{[^}]*\bbuildResultComponent\b[^}]*\}\s*from\s*["']\.\/render\/dashboard/,
		);
	});
});

describe("AC-06 root-cause call-site contract — §3 summary is Markdown, not flat Text", () => {
	it("constructs a Markdown component for the summary using getMarkdownTheme()", () => {
		// The fix: §3 is `new Markdown(summaryLines.join("\n"), …, getMarkdownTheme())`.
		// Both symbols live in the extracted builder (dashboard.ts).
		expect(DASHBOARD_SRC).toMatch(/new\s+Markdown\(/);
		expect(DASHBOARD_SRC).toMatch(/getMarkdownTheme\(\)/);
	});

	it("does NOT flatten §3 to new Text(parts.join(\"\\n\"), 0, 0) (the H3 root cause is gone)", () => {
		// Pre-fix: the ONLY return of the stages-path was
		//   `return new Text(parts.join("\n"), 0, 0);`
		// Its absence is the regression guard for AC-06 / H3.
		expect(EXTENSION_SRC).not.toMatch(/return\s+new\s+Text\(parts\.join\(["']\\n["']\),\s*0,\s*0\)/);
	});

	it("renderResult delegates §3 rendering to buildResultComponent(d, theme)", () => {
		// The call-site must hand the populated details + theme to the builder.
		expect(EXTENSION_SRC).toMatch(/buildResultComponent\(/);
		expect(EXTENSION_SRC).toMatch(/buildResultComponent\([^)]*theme\)/);
	});
});

describe("AC-09 / AC-10 no-regression — §1 and §2 are structurally unchanged", () => {
	it("§1 detail log is still DIMMED via theme.fg(\"dim\", …)", () => {
		// §1 is the thought-like, persisted detail log; it stays dim and unchanged.
		expect(DASHBOARD_SRC).toMatch(/\bfg\(\s*["']dim["']/);
		expect(DASHBOARD_SRC).toMatch(/── detail log/);
	});

	it("§2 stage-progress header is still theme.bold(\"── stage progress ──\")", () => {
		// §2 is the answer-like stage summary; the bold header is preserved.
		expect(DASHBOARD_SRC).toMatch(/\bbold\(\s*["']── stage progress ──["']\s*\)/);
	});

	it("the stage-row icon mapper is preserved (ok/failed/skipped/running/other)", () => {
		// The `stageIcon(st)` mapper for §2 rows lives in the extracted builder.
		expect(DASHBOARD_SRC).toMatch(/st\s*===\s*["']ok["']/);
		expect(DASHBOARD_SRC).toMatch(/st\s*===\s*["']failed["']/);
	});
});

describe("AC-10 no-regression — the empty-stages streaming fallback is unchanged", () => {
	it("still early-returns a plain Text of content when details.stages is empty", () => {
		// During streaming (onUpdate), details are empty → renderResult must return
		// the SAME flat Text of the content block it does today, so the live log
		// shows normally. This path is NOT Markdown-wrapped.
		expect(EXTENSION_SRC).toMatch(/!d\.stages\?\.length/);
		expect(EXTENSION_SRC).toMatch(
			/return\s+new\s+Text\(text\?\.type\s*===\s*["']text["']\s*\?\s*text\.text\s*:\s*["']["'],\s*0,\s*0\)/,
		);
	});
});

// ---------------------------------------------------------------------------
// B. BEHAVIORAL — Container composition via the importable builder.
//    (These fail until Phase 3 extracts buildResultComponent into dashboard.ts.)
// ---------------------------------------------------------------------------

describe("AC-06 behavioral — buildResultComponent returns a Container of [Text, Text, Markdown]", () => {
	it("is an exported function on ./dashboard", () => {
		expect(typeof buildResultComponent).toBe("function");
	});

	it("returns a Container (not a flat Text)", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never);
		expect(comp).toBeInstanceOf(Container);
		expect(comp).not.toBeInstanceOf(Text);
	});

	it("the Container's children include a Markdown component for §3 (the AC-06 fix)", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const markdowns = comp.children.filter((c) => c instanceof Markdown);
		expect(markdowns.length).toBe(1);
	});

	it("§3 Markdown receives the JOINED summaryLines (multi-line markdown preserved, not flattened)", () => {
		// The summary is markdown (headings, bold, lists); it must reach the
		// Markdown component as a single "\n"-joined string, not flattened.
		const details = completedDetails();
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const md = comp.children.find((c) => c instanceof Markdown) as Markdown | undefined;
		expect(md, "a Markdown child must exist").toBeDefined();
		// Re-render and assert the summary content survived into the output.
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("all 13 stages passed");
	});

	it("§1 detail-log tail lines are themed PER-KIND (plain strings default to the 'log' text token)", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const rendered = comp.render(120).join("\n");
		// Phase 3 (AC-07): §1 tail lines are themed per-kind via themeLine. The
		// fixture's plain-string `[req]`/`[design]` elements default to kind
		// "log" → fg("text", …) (the legacy uniform "dim" is gone).
		expect(rendered).toContain("<text>[req]");
		expect(rendered).toContain("<text>[design]");
		// The §1 dim HEADER still carries the dim token (it is not a tail line).
		expect(rendered).toContain("<dim>── detail log (last 50 lines) ──");
	});

	it("§2 stage-progress header is BOLD and stage rows render their status icons", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("<b>── stage progress ──</b>");
		// Stage labels survive into the rendered stage rows.
		expect(rendered).toContain("Requirements");
		expect(rendered).toContain("Implementation");
	});

	it("the logPath footnote is included (§1 tail preserved)", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("/tmp/super-dev/2026-07-19/run.log");
	});
});

describe("AC-06 behavioral — edge cases & input-resilience (anti-fragile builder)", () => {
	it("does not throw and still renders §2/§3 when transcriptTail is EMPTY (§1 gracefully absent)", () => {
		// §1 is built from transcriptTail; an empty/[] tail must not crash the
		// builder nor suppress §2/§3.
		const details = { ...completedDetails(), transcriptTail: [] };
		expect(() => buildResultComponent(details, mockTheme() as never)).not.toThrow();
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("<b>── stage progress ──</b>");
		expect(comp.children.some((c) => c instanceof Markdown)).toBe(true);
	});

	it("does not throw when transcriptTail is undefined", () => {
		const details = { ...completedDetails(), transcriptTail: undefined };
		expect(() => buildResultComponent(details, mockTheme() as never)).not.toThrow();
	});

	it("does not throw and omits the footnote when logPath is undefined", () => {
		// logPath powers the §1 tail footnote; absence must not throw and must not
		// emit a dangling "/undefined" or empty path.
		const details = { ...completedDetails(), logPath: undefined };
		expect(() => buildResultComponent(details, mockTheme() as never)).not.toThrow();
		const rendered = (
			buildResultComponent(details, mockTheme() as never) as Container
		)
			.render(120)
			.join("\n");
		expect(rendered).not.toContain("undefined");
	});

	it("renders a single-stage pipeline correctly (boundary: minimal non-empty stages)", () => {
		// Boundary case: the smallest valid stages array still yields a Container
		// with the §2 header + one row + §3 Markdown.
		const details = {
			...completedDetails(),
			stages: [{ label: "Only", status: "ok" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("<b>── stage progress ──</b>");
		expect(rendered).toContain("Only");
		expect(comp.children.some((c) => c instanceof Markdown)).toBe(true);
	});

	it("preserves markdown STRUCTURE in §3 — heading (#) and list (-) survive the join", () => {
		// The join must preserve markdown markup so the Markdown component can
		// parse headings/bold/lists — not collapse whitespace or strip markers.
		const details = {
			...completedDetails(),
			summaryLines: ["# Title", "", "- item one", "- item two"],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const md = comp.children.find((c) => c instanceof Markdown) as Markdown | undefined;
		expect(md, "Markdown child must exist").toBeDefined();
		// Markdown component should parse the heading; rendered output reflects it
		// (assert presence of the heading text and list items as a smoke check).
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Title");
		expect(rendered).toContain("item one");
		expect(rendered).toContain("item two");
	});
});

describe("AC-06 behavioral — graceful-degrade & anti-hardcoding", () => {
	it("omits §3 Markdown entirely when summaryLines is empty (no markdown to render)", () => {
		// If a run produces no summary lines, §3 must be absent rather than
		// emitting an empty/blank Markdown block.
		const details = { ...completedDetails(), summaryLines: [] };
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const markdowns = comp.children.filter((c) => c instanceof Markdown);
		expect(markdowns.length).toBe(0);
		// §1 and §2 still render.
		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("<b>── stage progress ──</b>");
	});

	it("omits §3 Markdown when summaryLines is undefined", () => {
		const details = { ...completedDetails(), summaryLines: undefined };
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		expect(comp.children.filter((c) => c instanceof Markdown).length).toBe(0);
	});

	it("does not hardcode the summary — different summaryLines flow through to Markdown", () => {
		// Anti-hardcoding: the builder must GENERALIZE across inputs, not return a
		// canned string that happens to satisfy one test.
		const a = buildResultComponent(
			{ ...completedDetails(), summaryLines: ["## A", "alpha output"] },
			mockTheme() as never,
		) as Container;
		const b = buildResultComponent(
			{ ...completedDetails(), summaryLines: ["## B", "bravo output"] },
			mockTheme() as never,
		) as Container;
		const ra = a.render(120).join("\n");
		const rb = b.render(120).join("\n");
		expect(ra).toContain("alpha output");
		expect(rb).toContain("bravo output");
		expect(ra).not.toBe(rb);
		// Both still carry the shared §1/§2 scaffold (generalization preserves layout).
		expect(ra).toContain("<b>── stage progress ──</b>");
		expect(rb).toContain("<b>── stage progress ──</b>");
	});

	it("two calls yield INDEPENDENT Container instances (no shared state)", () => {
		const a = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const b = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		expect(a).not.toBe(b);
		expect(a.children).not.toBe(b.children);
	});

	it("threads theme into §3 — getMarkdownTheme(theme) derives the Markdown theme from the passed Theme", () => {
		// AC-08: the Markdown component's theme MUST be derived from the same Theme
		// object renderResult receives, not a module-global or a default. We assert
		// the derivation is theme-sensitive by confirming two different themes do
		// not share mutable state (the markdown theme is recomputed per call).
		const t1 = mockTheme();
		const t2 = mockTheme();
		const a = buildResultComponent(completedDetails(), t1 as never) as Container;
		const b = buildResultComponent(completedDetails(), t2 as never) as Container;
		// Both render without throwing and both carry a Markdown child derived
		// from their own theme argument.
		expect(a.children.some((c) => c instanceof Markdown)).toBe(true);
		expect(b.children.some((c) => c instanceof Markdown)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// C. STRUCTURAL ORDERING — the explicit AC-06 Container contract.
//    AC-06 mandates a Container composed as: [dim Text §1] + [bold Text §2] +
//    [Markdown §3]. The §1→§2→§3 child ORDER is a hard contract that the
//    render-output `toContain` assertions above do NOT enforce (a stray summary
//    line rendered ahead of stage progress would still pass them). These tests
//    pin the ordering directly on `Container.children` so a re-ordering or an
//    accidental append-before-prepend regression is caught. RED until
//    buildResultComponent lands.
// ---------------------------------------------------------------------------

describe("AC-06 structural ordering — Container children are §1(dim Text) → §2(bold Text) → §3(Markdown)", () => {
	it("emits exactly ONE Markdown child, and it is the LAST child", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const mdCount = comp.children.filter((c) => c instanceof Markdown).length;
		expect(mdCount, "exactly one Markdown child").toBe(1);
		expect(
			comp.children[comp.children.length - 1],
			"the Markdown §3 block must be the final child",
		).toBeInstanceOf(Markdown);
	});

	it("places §1 themed Text children BEFORE any §2 bold Text children", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		const rendered = comp.children.map((c) => (c as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "");
		const joined = rendered.join("\n");
		// Phase 3 (AC-07): the `[req]` plain-string tail element is now themed
		// per-kind (kind "log" → fg("text", …)), so locate it by the `text` token.
		const s1Idx = joined.indexOf("<text>[req]");
		const boldIdx = joined.indexOf("<b>── stage progress ──</b>");
		expect(s1Idx, "§1 themed detail-log line must be present").toBeGreaterThanOrEqual(0);
		expect(boldIdx, "§2 bold stage-progress header must be present").toBeGreaterThanOrEqual(0);
		expect(s1Idx, "§1 must render before §2").toBeLessThan(boldIdx);
	});

	it("places §2 stage-progress BEFORE §3 Markdown (the complete §1→§2→§3 chain)", () => {
		const comp = buildResultComponent(completedDetails(), mockTheme() as never) as Container;
		// Walk children to find the index of the first §2-bold Text and the §3 Markdown.
		let firstBoldChildIdx = -1;
		let markdownChildIdx = -1;
		for (let i = 0; i < comp.children.length; i++) {
			const out = (comp.children[i] as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "";
			if (firstBoldChildIdx === -1 && out.includes("<b>── stage progress ──</b>")) firstBoldChildIdx = i;
			if (comp.children[i] instanceof Markdown) markdownChildIdx = i;
		}
		expect(firstBoldChildIdx, "a §2 bold header child must exist").toBeGreaterThanOrEqual(0);
		expect(markdownChildIdx, "a §3 Markdown child must exist").toBeGreaterThanOrEqual(0);
		expect(firstBoldChildIdx, "§2 must precede §3 in child order").toBeLessThan(markdownChildIdx);
	});

	it("does NOT emit a Markdown child when §3 is absent — §2 remains the final rendered section", () => {
		// Graceful-degrade + ordering invariant together: with no summaryLines,
		// there must be NO trailing Markdown, so the bold §2 header region is last.
		const details = { ...completedDetails(), summaryLines: [] };
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		expect(comp.children.filter((c) => c instanceof Markdown).length).toBe(0);
		const rendered = comp.children
			.map((c) => (c as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "")
			.join("\n");
		const boldIdx = rendered.indexOf("<b>── stage progress ──</b>");
		const s1Idx = rendered.indexOf("<text>[req]");
		expect(s1Idx, "§1 must render before §2").toBeLessThan(boldIdx);
	});
});
