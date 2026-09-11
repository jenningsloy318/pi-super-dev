/**
 * F-09 (v0.3.86) — doc-number RESERVATIONS for the parallel review docs.
 *
 * Doc-number allocation (prompts.ts nextDocNumber/specDocs/specDoc) is a pure
 * dir read: two allocations before the first write both compute the same
 * "next free" index (10-code-review.md + 10-adversarial-review.md). The fix is
 * a reservation registry — an allocation records its NN and every OTHER
 * allocation counts reserved-but-not-yet-materialized docs; re-reserving the
 * same slug reuses its reserved name (idempotent); once the file lands on disk
 * the file counts itself and the reservation self-cleans.
 *
 * Also pins the reviewStep WIRING (verify.ts reserves all three review docs at
 * step start, before the parallel spawn) via the repo's source-contract idiom.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specDoc, specDocs } from "../src/prompts.ts";
import { reserveStageDocs } from "../src/render/render.ts";
import type { SetupControl } from "../src/types.ts";

let dir: string;
let s: SetupControl;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sd-resv-"));
	s = { specDirectory: dir } as unknown as SetupControl;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("F-09 — doc-number reservations (prompts.ts registry)", () => {
	it("concurrent reservations get distinct NN (the three review docs, before any file exists)", () => {
		const names = ["codeReview", "adversarialReview", "testsReview"]
			.flatMap((id) => reserveStageDocs(s, id).map((r) => r.name));
		expect(names).toHaveLength(3);
		// RED pre-fix: all three compute 01 (nothing on disk yet, no registry)
		expect(names).toEqual(["01-code-review.md", "02-adversarial-review.md", "03-tests-review.md"]);
	});

	it("a later allocation for ANOTHER slug skips the reserved-but-unwritten number (RED pre-fix: collision)", () => {
		const first = specDocs(s, ["code-review"]);
		expect(first[0]).toContain("01-code-review.md");
		// No file written yet — the reservation must still count.
		const later = specDocs(s, ["adversarial-review"]);
		expect(later[0]).toContain("02-adversarial-review.md");
	});

	it("re-reserving the same slug is idempotent before the file exists", () => {
		const a = specDocs(s, ["code-review"])[0]!;
		const b = specDoc(s, "code-review");
		expect(b).toBe(a);
	});

	it("once the file materializes, the file itself is reused and the next slug counts from disk", () => {
		const a = specDoc(s, "code-review");
		writeFileSync(a, "rendered\n");
		expect(specDoc(s, "code-review")).toBe(a); // idempotent overwrite target
		const next = specDoc(s, "adversarial-review");
		expect(next).toContain("02-adversarial-review.md"); // 01 now counts from disk
	});

	it("multi-doc group allocation still takes consecutive distinct numbers (spec-stage shape unchanged)", () => {
		const paths = specDocs(s, ["specification", "implementation-plan", "task-list"]);
		expect(paths.map((p) => p.slice(p.lastIndexOf("/") + 1))).toEqual([
			"01-specification.md",
			"02-implementation-plan.md",
			"03-task-list.md",
		]);
	});
});

describe("F-09 — reviewStep wiring (source contract)", () => {
	it("reviewStep reserves all three review docs BEFORE delegating to the parallel reviewers", () => {
		const src = readFileSync(new URL("../src/stages/verify.ts", import.meta.url), "utf8");
		const wrapper = src.slice(src.indexOf("export const reviewStep: Node"), src.indexOf("export const reviewStep: Node") + 900);
		expect(wrapper).toContain("reserveStageDocs(setup, stageId)");
		expect(wrapper).toContain('"codeReview", "adversarialReview", "testsReview"');
		expect(wrapper).toContain("reviewParallel.run(state, ctx)");
	});
});
