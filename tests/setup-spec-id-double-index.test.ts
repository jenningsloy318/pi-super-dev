/**
 * v0.3.18 — double-index spec ids: the slug LLM echoing a referenced
 * requirement FILENAME (`docs/requirements/16-dimension-financials.md` → slug
 * "16-dimension-financials") made runSetup compose "16-16-dimension-financials".
 * Two layers: content-aware slugs (taskFileExcerpts feeds the referenced file's
 * CONTENT to the slug model) and a deterministic guard (dedupeSlugIndex strips
 * leading numerals that provably echo a docs-path spec reference).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeSlugIndex, runSetup } from "../src/setup.ts";
import { taskFilePaths, taskFileExcerpts } from "../src/agents/agent-runtime.ts";

const TEMPLATE = (n: string, slug: string) =>
	`by referencing design docs/research/pi-omisis-master-design.md, implement docs/requirements/${n}-${slug}.md`;

const TASK_16 = "by referencing design docs/research/pi-omisis-master-design.md, implement docs/requirements/16-dimension-financials.md";

describe("dedupeSlugIndex — numeral-echo guard", () => {
	it("T1: strips the filename-echoed numeral (the incident)", () => {
		expect(dedupeSlugIndex("16-dimension-financials", TASK_16)).toBe("dimension-financials");
	});

	it("T2: strips repeated echoes ('16-16-…' from an over-eager LLM)", () => {
		expect(dedupeSlugIndex("16-16-dimension-financials", TASK_16)).toBe("dimension-financials");
	});

	it("T3: keeps free-text identity numerals (no docs-path spec ref)", () => {
		// '254' rides a source path / free text, not a docs-path NN-slug reference:
		// the numeral is the track's identity token and must survive verbatim (R6).
		const task = "finish step 254 of the e2e dashboard ladder (see src/254-e2e/loader.ts)";
		expect(dedupeSlugIndex("254-step-e2e-dashboard", task)).toBe("254-step-e2e-dashboard");
	});

	it("T4: keeps a slug whose leading numeral is NOT referenced by the task", () => {
		expect(dedupeSlugIndex("8080-port-migration", TASK_16)).toBe("8080-port-migration");
	});

	it("T5: zero-padding normalizes (05-… ref strips '5-' slug)", () => {
		const task = TEMPLATE("05", "verification");
		expect(dedupeSlugIndex("5-verification-hardening", task)).toBe("verification-hardening");
	});

	it("T6: pass-through for numeral-less slugs", () => {
		expect(dedupeSlugIndex("dimension-financials", TASK_16)).toBe("dimension-financials");
	});
});

describe("runSetup end-to-end — spec id composition", () => {
	it("T7: the incident task + LLM filename-echo slug composes a single index", () => {
		const d = mkdtempSync(join(tmpdir(), "dbidx-"));
		try {
			seedSpecs(d, 15); // specs 01..15 exist → nextSpecNumber = 16
			const s = runSetup(TASK_16, { cwd: d, skipWorktree: true, slug: "16-dimension-financials" });
			expect(s.specIdentifier).toBe("16-dimension-financials");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T8: kill-switch branch (SUPER_DEV_NO_SPEC_REUSE=1) composes a single index too", () => {
		const d = mkdtempSync(join(tmpdir(), "dbidx2-"));
		const prev = process.env.SUPER_DEV_NO_SPEC_REUSE;
		process.env.SUPER_DEV_NO_SPEC_REUSE = "1";
		try {
			seedSpecs(d, 15);
			const s = runSetup(TASK_16, { cwd: d, skipWorktree: true, slug: "16-dimension-financials" });
			expect(s.specIdentifier).toBe("16-dimension-financials");
		} finally {
			if (prev === undefined) delete process.env.SUPER_DEV_NO_SPEC_REUSE; else process.env.SUPER_DEV_NO_SPEC_REUSE = prev;
			rmSync(d, { recursive: true, force: true });
		}
	});
});

describe("taskFilePaths / taskFileExcerpts — content-aware slug inputs", () => {
	it("T9: extracts @mentions, bare relative paths, and ~/ paths; caps at 4", () => {
		const task = "implement @docs/requirements/16-dimension-financials.md referencing docs/research/design.md and ~/notes/spec.md plus barefile.md and src/254-e2e/loader.ts and docs/more/extra.md";
		const paths = taskFilePaths(task);
		expect(paths[0]).toBe("docs/requirements/16-dimension-financials.md");
		expect(paths).toContain("docs/research/design.md");
		expect(paths).toContain("~/notes/spec.md");
		expect(paths.length).toBeLessThanOrEqual(4);
	});

	it("T10: excerpts read bounded CONTENT from existing files, skip missing ones", () => {
		const d = mkdtempSync(join(tmpdir(), "excerpts-"));
		try {
			mkdirSync(join(d, "docs", "requirements"), { recursive: true });
			writeFileSync(join(d, "docs", "requirements", "16-dimension-financials.md"), "# 16-Dimension Financials\n\nDerive the 16-dimension financial scoring grid…\n");
			const excerpts = taskFileExcerpts(TASK_16, d);
			expect(excerpts.length).toBe(1); // design doc missing → skipped
			expect(excerpts[0]!.excerpt).toContain("16-dimension financial scoring");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});

function seedSpecs(root: string, count: number): void {
	for (let i = 1; i <= count; i++) {
		mkdirSync(join(root, "docs", "specifications", `${String(i).padStart(2, "0")}-seed`), { recursive: true });
	}
}
