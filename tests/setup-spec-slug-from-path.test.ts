/**
 * v0.3.95 FIX A (run-2026-09-12T15-16-29-042Z) — spec slug from path-referenced
 * basenames (owner-adjudicated option A; fix-round BLOCKING-2 narrowed to the
 * SPEC-ARTIFACT grammar + BLOCKING-3 boundary-corrected). `slugifyTask` treats
 * path segments as words, so `implement @docs/requirements/26-capability-backends.md`
 * fell back to "docs-requirements-26-capability-backends" and composed the ugly
 * spec id "26-docs-requirements-26-capability-backends". The pure helper
 * `slugFromSpecPathReference` derives the fallback slug from the REFERENCED
 * FILE's basename — but ONLY for requirements/ or specifications/ paths whose
 * basename is numeral-prefixed (`NN-slug.md`, super-dev's own re-entry format).
 * Citations of research/reference/architecture docs return null (their tokens
 * used to leak into findReusableSpec's containment scoring and hijack
 * unrelated tracks). dedupeSlugIndex then strips the leading numeral echo,
 * yielding "26-capability-backends".
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dedupeSlugIndex,
	runSetup,
	slugFromSpecPathReference,
	slugifyTask,
	specRefNumerals,
} from "../src/setup.ts";

const INCIDENT_TASK = "implement @docs/requirements/26-capability-backends.md";

describe("slugFromSpecPathReference — spec-artifact slug fallback", () => {
	it("T1: the incident task's @-referenced requirements path yields the basename slug", () => {
		expect(slugFromSpecPathReference(INCIDENT_TASK)).toBe("26-capability-backends");
	});

	it("T2: bare (no @) requirements/specifications numeral paths derive; the research-doc template does NOT (BLOCKING-2)", () => {
		expect(slugFromSpecPathReference("read docs/specifications/05-verification.md and act"))
			.toBe("05-verification");
		// The historical template task cites a RESEARCH doc — a citation, not a
		// spec artifact: null → slugifyTask fallback (v0.3.94 behavior).
		expect(slugFromSpecPathReference("by referencing design docs/research/master-design.md, implement docs/requirements/16-dimension-financials.md"))
			.toBe("16-dimension-financials");
	});

	it("T3: bare (non-path) tasks return null — the caller falls back to slugifyTask byte-identically", () => {
		const task = "fix the login bug on the checkout page";
		expect(slugFromSpecPathReference(task)).toBeNull();
		// the composed call-site expression, minus the null middle term:
		expect(dedupeSlugIndex(slugifyTask(task), task)).toBe(slugifyTask(task));
	});

	it("T4: numeral-echo stripping composes — basename slug → dedupeSlugIndex → numeral-free slug", () => {
		const slug = slugFromSpecPathReference(INCIDENT_TASK)!;
		expect(slug).toBe("26-capability-backends");
		// the numeral provably echoes a docs-path spec reference (the shared grammar)
		expect(specRefNumerals(INCIDENT_TASK).has("26")).toBe(true);
		expect(dedupeSlugIndex(slug, INCIDENT_TASK)).toBe("capability-backends");
	});

	it("T5: multi-ref tasks use the FIRST spec-artifact reference", () => {
		const task = "implement @docs/requirements/26-capability-backends.md and @docs/requirements/27-other-feature.md";
		expect(slugFromSpecPathReference(task)).toBe("26-capability-backends");
	});

	it("T6: non-md paths don't trigger", () => {
		expect(slugFromSpecPathReference("implement @docs/requirements/26-capability-backends.png")).toBeNull();
		expect(slugFromSpecPathReference("see docs/requirements/design.sketch")).toBeNull();
	});
});

describe("slugFromSpecPathReference — BLOCKING-2: spec-artifact grammar only", () => {
	it("B1: a research-tree citation never derives a slug (the hijack scenario)", () => {
		expect(slugFromSpecPathReference("referencing docs/research/master-design.md, implement payment-processor")).toBeNull();
		// even numeral-prefixed research basenames are citations, not artifacts
		expect(slugFromSpecPathReference("study docs/research/16-dimension-financials.md first")).toBeNull();
	});

	it("B2: an architecture-doc @-citation (no numeral) never derives a slug", () => {
		expect(slugFromSpecPathReference("refactor per @docs/architecture/service-boundaries.md")).toBeNull();
	});

	it("B3: requirements-tree numeral paths derive WITH and WITHOUT the @ prefix", () => {
		expect(slugFromSpecPathReference("implement @docs/requirements/26-capability-backends.md")).toBe("26-capability-backends");
		expect(slugFromSpecPathReference("implement docs/requirements/26-capability-backends.md")).toBe("26-capability-backends");
		expect(slugFromSpecPathReference("continue spec docs/specifications/07-staged-execution.md")).toBe("07-staged-execution");
	});

	it("B4: a NON-numeral basename inside the spec tree does not derive (NN-slug.md only)", () => {
		expect(slugFromSpecPathReference("read docs/requirements/readme.md")).toBeNull();
		expect(slugFromSpecPathReference("see @docs/specifications/index.md")).toBeNull();
	});

	it("B5: source and asset trees stay null", () => {
		expect(slugFromSpecPathReference("refactor src/254-e2e/loader.md")).toBeNull();
		expect(slugFromSpecPathReference("update assets/docs-style/readme.md")).toBeNull();
	});
});

describe("slugFromSpecPathReference — BLOCKING-3: boundary grammar", () => {
	it("C1: backtick-quoted requirements path matches (markdown delimiter)", () => {
		expect(slugFromSpecPathReference("implement `docs/requirements/26-capability-backends.md` now")).toBe("26-capability-backends");
	});

	it("C2: a `.md.bak` tail does NOT match (the \\b hole)", () => {
		expect(slugFromSpecPathReference("restore docs/requirements/26-x.md.bak")).toBeNull();
		expect(slugFromSpecPathReference("edit @docs/requirements/26-x.md.tmp")).toBeNull();
	});

	it("C3: a closing paren after `.md` matches", () => {
		expect(slugFromSpecPathReference("(see docs/requirements/26-x.md) for details")).toBe("26-x");
	});

	it("C4: uppercase .MD matches (case-insensitive)", () => {
		expect(slugFromSpecPathReference("implement @docs/requirements/26-Capability-Backends.MD")).toBe("26-capability-backends");
	});

	it("C5: an empty task is null (totality)", () => {
		expect(slugFromSpecPathReference("")).toBeNull();
	});
});

function seedSpecs(root: string, count: number): void {
	for (let i = 1; i <= count; i++) {
		mkdirSync(join(root, "docs", "specifications", `${String(i).padStart(2, "0")}-seed`), { recursive: true });
	}
}

describe("runSetup end-to-end — path-referenced spec id composition (no LLM slug)", () => {
	it("T9: the incident task with NO slug composes the meaningful shape (G2 fresh-allocation branch)", () => {
		const d = mkdtempSync(join(tmpdir(), "slugpath-"));
		try {
			seedSpecs(d, 25); // specs 01..25 exist → nextSpecNumber = 26
			const s = runSetup(INCIDENT_TASK, { cwd: d, skipWorktree: true });
			expect(s.specIdentifier).toBe("26-capability-backends");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T10: kill-switch branch (SUPER_DEV_NO_SPEC_REUSE=1) composes the same shape", () => {
		const d = mkdtempSync(join(tmpdir(), "slugpath2-"));
		const prev = process.env.SUPER_DEV_NO_SPEC_REUSE;
		process.env.SUPER_DEV_NO_SPEC_REUSE = "1";
		try {
			seedSpecs(d, 25);
			const s = runSetup(INCIDENT_TASK, { cwd: d, skipWorktree: true });
			expect(s.specIdentifier).toBe("26-capability-backends");
		} finally {
			if (prev === undefined) delete process.env.SUPER_DEV_NO_SPEC_REUSE; else process.env.SUPER_DEV_NO_SPEC_REUSE = prev;
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("T11: an explicit (LLM) slug still WINS over the path-reference fallback", () => {
		const d = mkdtempSync(join(tmpdir(), "slugpath3-"));
		try {
			seedSpecs(d, 25);
			const s = runSetup(INCIDENT_TASK, { cwd: d, skipWorktree: true, slug: "capability-backend-plumbing" });
			expect(s.specIdentifier).toBe("26-capability-backend-plumbing");
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("T12: a non-path task's spec id is byte-identical to the old behavior", () => {
		const d = mkdtempSync(join(tmpdir(), "slugpath4-"));
		try {
			seedSpecs(d, 3);
			const s = runSetup("fix the login bug on the checkout page", { cwd: d, skipWorktree: true });
			expect(s.specIdentifier).toBe(`04-${slugifyTask("fix the login bug on the checkout page")}`);
		} finally { rmSync(d, { recursive: true, force: true }); }
	});

	it("R1: re-running the SAME @-spec task derives the same slug and reuse resumes its own track (BLOCKING-2 pin)", () => {
		const d = mkdtempSync(join(tmpdir(), "slugreuse-"));
		try {
			seedSpecs(d, 25); // → nextSpecNumber = 26 for the fresh allocation
			const first = runSetup(INCIDENT_TASK, { cwd: d, skipWorktree: true });
			expect(first.specIdentifier).toBe("26-capability-backends");
			// seed progress so the track is resumable (a bare setup writes no
			// resume rows — the setup.test.ts SCENARIO-045 pattern)
			writeFileSync(join(first.specDirectory, ".resume-cache.jsonl"), '{"key":"pipeline.requirements@root#1","result":{"text":"","control":{}}}');
			const second = runSetup(INCIDENT_TASK, { cwd: d, skipWorktree: true });
			expect(second.specIdentifier).toBe("26-capability-backends");
			expect(second.reusedTrack).toBe(true); // same slug → containment 1 → G2 re-entry
		} finally { rmSync(d, { recursive: true, force: true }); }
	});
});
