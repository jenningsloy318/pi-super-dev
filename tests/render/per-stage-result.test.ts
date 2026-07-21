/**
 * Phase 4 — buildResultComponent §1 PER-STAGE BLOCK contract tests
 * (AC-04 / AC-05, SCENARIO-014..018).
 *
 * Domain: render-dashboard.
 *
 * === What these tests pin ===
 * When `transcriptTail` carries real stage tags (`{kind,text,stageId,stageLabel}`),
 * `buildResultComponent` §1 renders a STACK of per-stage blocks instead of the
 * single merged dim log. Each block is a `Container` of `Text` children:
 *   (a) a BOLD header `Text` themed by STATUS via method-style `theme.fg(...)`,
 *       prefixed with a status glyph (ok `✓`, failed `✗`, skipped `↷`,
 *       running `●`);
 *   (b) the stage's log lines as `Text` children themed per-kind via themeLine;
 *   (c) a per-stage BACKGROUND via pi-tui `Text`'s 4th `customBgFn` arg colored
 *       by status (running→toolPendingBg, ok→toolSuccessBg, failed→toolErrorBg).
 *
 * Failed/running blocks render EXPANDED (all lines); completed blocks render
 * COMPACT (≤ 1 tail line). Legacy untagged / string entries collapse via
 * groupByStage's sentinel into a SINGLE merged block — no throw.
 *
 * These tests are PURE: no real TUI, no real pi runtime. The structural
 * `DashboardTheme` mock exposes `fg`/`bold`/`bg` that wrap text in assertable
 * `<token>` / `<b>` / `<bg:token>` markers so applied tokens are checkable
 * without parsing ANSI (mirrors dashboard-result-perkind.test.ts).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Container, Markdown } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { buildResultComponent, type ResultDetails } from "../../src/render/dashboard.js";
import type { LineKind } from "../../src/render/stream-theme.js";

// getMarkdownTheme() reads a module-global that pi initializes via initTheme()
// at process startup; initialize it before any §3 Markdown.render().
beforeAll(() => initTheme());

/**
 * Structural Theme mock with the optional `bg` painter. Methods wrap text in
 * assertable token markers so the EXACT theme token / background applied to
 * each child is checkable via plain substring assertions (no ANSI parsing).
 */
function mockTheme() {
	return {
		fg: (token: string, text: string) => `<${token}>${text}`,
		bold: (text: string) => `<b>${text}</b>`,
		bg: (token: string, text: string) => `<bg:${token}>${text}`,
	};
}

/** Render every child of a Container at width 120, one joined string per child. */
function renderChildren(container: Container): string[] {
	return container.children.map(
		(c) => (c as { render?: (w: number) => string[] }).render?.(120).join("\n") ?? "",
	);
}

/** The pi-tui Text 4th ctor arg — runtime-accessible as a plain field. */
function customBgFnOf(child: unknown): ((text: string) => string) | undefined {
	return (child as { customBgFn?: (text: string) => string }).customBgFn;
}

/** Locate the FIRST child whose rendered output contains `distinctive`. */
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

/** A tagged tail line (stage-tagged, the Phase-4 input shape). */
function line(
	stageId: string,
	stageLabel: string,
	kind: LineKind,
	text: string,
): NonNullable<ResultDetails["transcriptTail"]>[number] {
	return { kind, text, stageId, stageLabel } as never;
}

// ---------------------------------------------------------------------------
// A. PER-STAGE BLOCK STACK — tagged tail produces one block per stage.
// ---------------------------------------------------------------------------

describe("AC-04 / SCENARIO-014 — tagged transcriptTail renders a STACK of per-stage blocks", () => {
	it("emits one status-themed header per stage in first-appearance order", () => {
		const details: ResultDetails = {
			transcriptTail: [
				line("research", "Research", "log", "research-line-A"),
				line("design", "Design", "log", "design-line-A"),
			],
			stages: [
				{ id: "research", label: "Research", status: "ok" },
				{ id: "design", label: "Design", status: "ok" },
			],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = renderChildren(comp).join("\n");

		const researchIdx = rendered.indexOf("Research");
		const designIdx = rendered.indexOf("Design");
		expect(researchIdx).toBeGreaterThanOrEqual(0);
		expect(designIdx).toBeGreaterThan(researchIdx); // first-appearance order
	});

	it("the §1 legacy 'detail log' header is NOT emitted when real tags are present", () => {
		const details: ResultDetails = {
			transcriptTail: [line("research", "Research", "log", "x")],
			stages: [{ id: "research", label: "Research", status: "ok" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		expect(renderChildren(comp).join("\n")).not.toContain("detail log");
	});
});

// ---------------------------------------------------------------------------
// B. STATUS GLYPHS — each block header carries its status glyph prefix.
// ---------------------------------------------------------------------------

describe("AC-04 / SCENARIO-015 — per-stage block header carries its status glyph", () => {
	const cases: Array<{ status: string; glyph: string; token: string }> = [
		{ status: "ok", glyph: "✓", token: "<success>" },
		{ status: "failed", glyph: "✗", token: "<error>" },
		{ status: "skipped", glyph: "↷", token: "<warning>" },
		{ status: "running", glyph: "●", token: "<accent>" },
	];
	for (const c of cases) {
		it(`status "${c.status}" → header glyph "${c.glyph}" themed ${c.token}`, () => {
			const details: ResultDetails = {
				transcriptTail: [line("s1", "StageOne", "log", "marker-line-1")],
				stages: [{ id: "s1", label: "StageOne", status: c.status }],
			};
			const comp = buildResultComponent(details, mockTheme() as never) as Container;
			const header = findChild(comp, "StageOne")!;
			expect(header, "header child must render").toBeDefined();
			expect(header.rendered).toContain(c.glyph);
			expect(header.rendered).toContain(c.token);
			expect(header.rendered).toContain("StageOne");
		});
	}
});

// ---------------------------------------------------------------------------
// C. PER-STAGE BACKGROUND — the header Text carries a status customBgFn.
// ---------------------------------------------------------------------------

describe("AC-04 / SCENARIO-016 — header Text carries a status-colored customBgFn", () => {
	it("running stage header background → toolPendingBg", () => {
		const details: ResultDetails = {
			transcriptTail: [line("s1", "Run", "log", "m")],
			stages: [{ id: "s1", label: "Run", status: "running" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const header = findChild(comp, "Run")!;
		expect(customBgFnOf(header.child)).toEqual(expect.any(Function));
		expect(header.rendered).toContain("<bg:toolPendingBg>");
	});

	it("ok stage header background → toolSuccessBg", () => {
		const details: ResultDetails = {
			transcriptTail: [line("s1", "Ok", "log", "m")],
			stages: [{ id: "s1", label: "Ok", status: "ok" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const header = findChild(comp, "Ok")!;
		expect(customBgFnOf(header.child)).toEqual(expect.any(Function));
		expect(header.rendered).toContain("<bg:toolSuccessBg>");
	});

	it("failed stage header background → toolErrorBg", () => {
		const details: ResultDetails = {
			transcriptTail: [line("s1", "Fail", "log", "m")],
			stages: [{ id: "s1", label: "Fail", status: "failed" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const header = findChild(comp, "Fail")!;
		expect(customBgFnOf(header.child)).toEqual(expect.any(Function));
		expect(header.rendered).toContain("<bg:toolErrorBg>");
	});

	it("skipped stage header background → none (graceful-degrade)", () => {
		const details: ResultDetails = {
			transcriptTail: [line("s1", "Skip", "log", "m")],
			stages: [{ id: "s1", label: "Skip", status: "skipped" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const header = findChild(comp, "Skip")!;
		expect(customBgFnOf(header.child)).toBeUndefined();
		expect(header.rendered).not.toMatch(/<bg:/);
	});
});

// ---------------------------------------------------------------------------
// D. PER-KIND LINE THEMING INSIDE A BLOCK + command tool bubbles preserved.
// ---------------------------------------------------------------------------

describe("AC-04 / SCENARIO-014 — block lines keep per-kind theming + command bubbles", () => {
	it("command lines inside a stage block keep their tool-bubble customBgFn", () => {
		// An EXPANDED (running) stage renders ALL its lines, so both the command
		// and the log survive to be asserted (a compact ok stage shows only its
		// last tail line).
		const details: ResultDetails = {
			transcriptTail: [
				line("s1", "StageA", "command", "→ run-build-cmd"),
				line("s1", "StageA", "log", "plain-log-99"),
			],
			stages: [{ id: "s1", label: "StageA", status: "running" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const cmd = findChild(comp, "run-build-cmd")!;
		const log = findChild(comp, "plain-log-99")!;
		expect(customBgFnOf(cmd.child)).toEqual(expect.any(Function));
		// command KIND always paints the PENDING tool background (toolPendingBg),
		// independent of the enclosing stage's status (the stage HEADER carries
		// the status background; the command LINE keeps its own per-kind bubble).
		expect(cmd.rendered).toContain("<bg:toolPendingBg>");
		// non-command line has no bubble
		expect(customBgFnOf(log.child)).toBeUndefined();
	});

	it("indents each stage's log lines two spaces under the header", () => {
		const details: ResultDetails = {
			transcriptTail: [line("s1", "StageA", "log", "indent-me-marker")],
			stages: [{ id: "s1", label: "StageA", status: "ok" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const found = findChild(comp, "indent-me-marker")!;
		expect(found.rendered.startsWith("  ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// E. EXPAND vs COMPACT — failed/running EXPANDED; completed COMPACT (≤1 tail).
// ---------------------------------------------------------------------------

describe("AC-04 / SCENARIO-017 — failed/running EXPANDED, completed COMPACT", () => {
	it("failed block renders ALL its lines (expanded)", () => {
		const lines3 = [
			line("s1", "Fail", "log", "fail-line-1"),
			line("s1", "Fail", "log", "fail-line-2"),
			line("s1", "Fail", "log", "fail-line-3"),
		];
		const details: ResultDetails = {
			transcriptTail: lines3,
			stages: [{ id: "s1", label: "Fail", status: "failed" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("fail-line-1");
		expect(rendered).toContain("fail-line-2");
		expect(rendered).toContain("fail-line-3");
	});

	it("completed (ok) block renders at most ONE tail line (compact)", () => {
		const tail = [
			line("s1", "Ok", "log", "ok-line-1"),
			line("s1", "Ok", "log", "ok-line-2"),
			line("s1", "Ok", "log", "ok-line-3"),
		];
		const details: ResultDetails = {
			transcriptTail: tail,
			stages: [{ id: "s1", label: "Ok", status: "ok" }],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = renderChildren(comp);
		const present = tail.filter((t) =>
			rendered.some((r) => r.includes((t as { text: string }).text)),
		);
		expect(present.length).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// F. LEGACY FALLBACK — untagged / string entries collapse into ONE merged block.
// ---------------------------------------------------------------------------

describe("AC-04 — legacy untagged / string tail collapses into a single merged block", () => {
	it("plain-string entries render without throwing and without per-stage headers", () => {
		const details: ResultDetails = {
			transcriptTail: ["legacy-line-1", "legacy-line-2"],
			// no stages with ids ⇒ statusOf resolves nothing ⇒ no per-stage split
			stages: [],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		expect(() => comp).not.toThrow();
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("legacy-line-1");
		expect(rendered).toContain("legacy-line-2");
	});

	it("object entries without stageId also collapse into the sentinel merged block", () => {
		const details: ResultDetails = {
			transcriptTail: [
				{ kind: "log" as const, text: "untagged-obj-A" },
				{ kind: "thinking" as const, text: "untagged-obj-B" },
			],
			stages: [],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("untagged-obj-A");
		expect(rendered).toContain("untagged-obj-B");
	});
});

// ---------------------------------------------------------------------------
// G. ABSENT-STAGE SYNTHESIS — a stage in details.stages with NO tail lines
//    still renders a header-only block (consistent with the streaming view).
// ---------------------------------------------------------------------------

describe("AC-04 — a stage absent from transcriptTail still renders a header-only block", () => {
	it("synthesizes a header-only block for a stage present in details.stages but not in tail", () => {
		const details: ResultDetails = {
			transcriptTail: [line("research", "Research", "log", "only-research-line")],
			stages: [
				{ id: "research", label: "Research", status: "ok" },
				// design has NO tail lines at all — must still surface a header.
				{ id: "design", label: "Design", status: "ok" },
			],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("Design");
		// bold() wraps the label, so the glyph and label are split by <b> markers —
		// assert the glyph and the bolded label presence separately.
		expect(rendered).toContain("✓");
		expect(rendered).toContain("<b>Design</b>");
	});
});

// ---------------------------------------------------------------------------
// H. §2 / §3 NO-REGRESSION — per-stage §1 must not perturb stage progress / summary.
// ---------------------------------------------------------------------------

describe("AC-04 — §2 stage header + §3 Markdown are unchanged by per-stage §1 blocks", () => {
	it("§2 bold header + stageIcon rows render, and §3 Markdown emits exactly one child", () => {
		const details: ResultDetails = {
			transcriptTail: [line("s1", "StageA", "command", "→ run-build-cmd")],
			stages: [
				{ id: "s1", label: "StageA", status: "ok" },
				{ id: "s2", label: "StageB", status: "failed" },
			],
			summaryLines: ["## Summary", "the run passed-xyz"],
		};
		const comp = buildResultComponent(details, mockTheme() as never) as Container;
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("<b>── stage progress ──</b>");
		expect(rendered).toContain("✔ StageA");
		expect(rendered).toContain("⚠ StageB");
		const markdowns = comp.children.filter((c) => c instanceof Markdown);
		expect(markdowns.length).toBe(1);
		expect(rendered).toContain("the run passed-xyz");
	});
});

// ---------------------------------------------------------------------------
// I. GRACEFUL-DEGRADE — no theme ⇒ raw text, no customBgFn, no token markers.
// ---------------------------------------------------------------------------

describe("AC-04 — no theme ⇒ raw text per-stage blocks, no customBgFn, no markers", () => {
	it("renders each stage's raw text with zero theme-token markers when theme is undefined", () => {
		const details: ResultDetails = {
			transcriptTail: [
				line("s1", "StageA", "log", "raw-line-A"),
				line("s2", "StageB", "log", "raw-line-B"),
			],
			stages: [
				{ id: "s1", label: "StageA", status: "ok" },
				{ id: "s2", label: "StageB", status: "ok" },
			],
		};
		const comp = buildResultComponent(details) as Container;
		const rendered = renderChildren(comp).join("\n");
		expect(rendered).toContain("raw-line-A");
		expect(rendered).toContain("raw-line-B");
		expect(rendered).toContain("StageA");
		expect(rendered).toContain("StageB");
		// no theme tokens / markers leaked
		expect(rendered).not.toMatch(/<[a-zA-Z]/);
		for (const c of comp.children) {
			expect(customBgFnOf(c)).toBeUndefined();
		}
	});
});
