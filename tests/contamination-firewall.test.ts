/**
 * P3 / §8.1 H1 fold — the contamination firewall: the reflection-input
 * exclusion seam + the canary/7-gram scan + quarantine at the learned-index
 * injection seam + the quarantine ledger.
 *
 * Hermetic by construction: the learned.ts seam tests mock super-dev-dir's
 * path accessors to a tmp home (the eval-stage wiring-test pattern); every
 * other directory is injected. No LLM anywhere (the scan is deterministic).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Hermetic home for the learned.ts seam tests: learned-index.json lives at
 *  <home>/learned-index.json, golden cases under <home>/evals/cases — the
 *  REAL accessors (getConfig etc.) stay real. */
vi.mock("../src/render/super-dev-dir.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/render/super-dev-dir.ts")>();
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "sd-contam-home-"));
	return { ...mod, getSuperDevDir: () => dir, getLearnedIndexPath: () => join(dir, "learned-index.json") };
});

import {
	scanLearnedIndexForContamination, scanLearnedIndexEntries,
	wordNgrams, overlapRatio, tokenizeText, CONTAMINATION_NGRAM_SIZE, CONTAMINATION_OVERLAP_THRESHOLD,
	type GoldenCaseText,
} from "../src/evolution/contamination.ts";
import { makeCanary, readContaminationLedger, quarantinedEntryIds, casesDir } from "../src/evolution/eval-shared.ts";

let tmpRoot: string;
let seq = 0;
beforeAll(() => { tmpRoot = mkdtempSync(join(tmpdir(), "sd-contam-")); });
afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	// the mocked home (learned-index.json + evals/ tree) — removed wholesale
	rmSync(join(casesDir(), "..", ".."), { recursive: true, force: true });
});

function newDir(name: string): string {
	const dir = join(tmpRoot, `${name}-${++seq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeCaseText(casesDirPath: string, id: string, scenario: string) {
	writeFileSync(join(casesDirPath, `${id}.json`), JSON.stringify({ id, scenario }), "utf8");
	return { id, scenario } satisfies GoldenCaseText;
}

/** A long-enough scenario so 7-grams exist (deterministic filler words). */
const SCENARIO_WORDS = Array.from({ length: 30 }, (_, i) => `word${i}`);

// ─── pure detection ──────────────────────────────────────────────────────────

describe("scanLearnedIndexEntries — pure detection (canary + 7-gram)", () => {
	it("a planted literal canary is conclusive proof (regardless of the rest of the text)", () => {
		const caseText = writeCaseText(newDir("canary-cases"), "gc-1", "ordinary scenario text here");
		const index = { entries: { "leaky-entry": { title: "t", summary: `lesson learned: ${makeCanary("gc-1")} quoted verbatim` } } };
		const findings = scanLearnedIndexEntries(index, [caseText]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ entryId: "leaky-entry", caseId: "gc-1", trigger: "canary" });
	});

	it("a 7-gram-overlap plant fires; low overlap and clean entries stay silent", () => {
		const casesPath = newDir("ngram-cases");
		const scenario = SCENARIO_WORDS.join(" ");
		const caseText = writeCaseText(casesPath, "gc-2", scenario);
		// plant: quotes 10 consecutive words of the scenario (4+ shared 7-grams
		// — more than 10% of the scenario's 24 7-gram mass)
		const plant = `the pipeline should always remember that ${SCENARIO_WORDS.slice(0, 10).join(" ")} happened before`;
		const index = {
			entries: {
				"paraphrase-entry": { title: "paraphrased lesson", summary: plant },
				"clean-entry": { title: "unrelated", summary: "an ordinary lesson about gate retries and timing" },
			},
		};
		const findings = scanLearnedIndexEntries(index, [caseText]);
		expect(findings.map((f) => f.entryId)).toEqual(["paraphrase-entry"]);
		expect(findings[0]!.trigger).toBe("ngram-overlap");
		// the shared-7-gram mass of the scenario in the plant exceeds the threshold
		expect(overlapRatio(plant, scenario)).toBeGreaterThan(CONTAMINATION_OVERLAP_THRESHOLD);
		expect(overlapRatio("totally unrelated text with different words entirely", scenario)).toBeLessThanOrEqual(CONTAMINATION_OVERLAP_THRESHOLD);
	});

	it("F-07 CJK-aware n-grams: a Chinese scenario plant is caught (per-character tokens — no Intl.Segmenter)", () => {
		const casesPath = newDir("cjk-cases");
		// 10 Chinese characters → 10 tokens → 4 seven-grams
		const scenario = "\u5faa\u73af\u91cd\u8bd5\u5df2\u8d85\u8fc7\u4e0a\u9650\u7ec8\u6b62";
		const caseText = writeCaseText(casesPath, "gc-cjk", scenario);
		// plant: quotes 8 consecutive characters (2+ shared 7-grams — well over the
		// threshold; word-boundary tokenization would have seen ZERO overlap)
		const plant = `\u6559\u8bad\uff1a\u8be5\u6a21\u5757 ${scenario.slice(0, 8)} \u5e94\u88ab\u8bb0\u4f4f`;
		const index = { entries: { "cjk-entry": { title: "\u4e2d\u6587\u6559\u8bad", summary: plant } } };
		const findings = scanLearnedIndexEntries(index, [caseText]);
		expect(findings.map((f) => f.entryId)).toEqual(["cjk-entry"]);
		expect(findings[0]!.trigger).toBe("ngram-overlap");
		expect(overlapRatio(plant, scenario)).toBeGreaterThan(CONTAMINATION_OVERLAP_THRESHOLD);
		// tokenization itself: each CJK char is its own token; latin runs stay whole
		expect(tokenizeText("\u5faa\u73af\u91cd\u8bd5 abc def")).toEqual(["\u5faa", "\u73af", "\u91cd", "\u8bd5", "abc", "def"]);
	});

	it("wordNgrams: punctuation splits, lowercase, n-size windows; short text → none", () => {
		expect(wordNgrams("One two three four five six seven eight!", 7)).toEqual([
			"one two three four five six seven",
			"two three four five six seven eight",
		]);
		expect(wordNgrams("too short", 7)).toEqual([]);
		expect(CONTAMINATION_NGRAM_SIZE).toBe(7);
	});

	it("malformed index shapes never throw (cold-start/absent entries)", () => {
		for (const bad of [null, [], { entries: null }, { entries: [] }, { entries: { ok: { title: 1, summary: null } } }]) {
			expect(() => scanLearnedIndexEntries(bad, [{ id: "x", scenario: "s" }])).not.toThrow();
		}
		expect(scanLearnedIndexEntries({ entries: {} }, [{ id: "x", scenario: "s" }])).toEqual([]);
	});
});

// ─── the full scan face (ledger + loudness) ──────────────────────────────────

describe("scanLearnedIndexForContamination — ledger rows, dedupe, fail-open", () => {
	it("writes first-detection ledger rows (ts + entryId + trigger + caseId), warns loudly, dedupes on re-scan", () => {
		const casesPath = newDir("full-cases");
		writeCaseText(casesPath, "gc-3", "scenario with a canary");
		const indexPath = join(newDir("full-idx"), "learned-index.json");
		writeFileSync(indexPath, JSON.stringify({ entries: { "bad-entry": { title: "x", summary: `quotes ${makeCanary("gc-3")}` } } }), "utf8");
		const ledgerPath = join(newDir("full-ledger"), "contamination.jsonl");
		const lines: string[] = [];
		const first = scanLearnedIndexForContamination({ learnedIndexPath: indexPath, casesDirPath: casesPath, ledgerPath, log: (m) => lines.push(m) });
		expect(first.quarantined).toEqual(["bad-entry"]);
		expect(first.ledgerRowsAppended).toBe(1);
		expect(lines.some((l) => l.includes("QUARANTINED") && l.includes("bad-entry"))).toBe(true);
		const rows = readContaminationLedger(ledgerPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ entryId: "bad-entry", trigger: "canary", caseId: "gc-3" });
		expect(typeof rows[0]!.ts).toBe("number");
		// re-scan: same finding, no duplicate ledger row
		const second = scanLearnedIndexForContamination({ learnedIndexPath: indexPath, casesDirPath: casesPath, ledgerPath, log: () => {} });
		expect(second.findings).toHaveLength(1); // still detected (enforcement re-runs)
		expect(second.ledgerRowsAppended).toBe(0);
		expect(readContaminationLedger(ledgerPath)).toHaveLength(1);
		// the ledger read face feeds the durable quarantine set
		expect(quarantinedEntryIds(ledgerPath)).toEqual(new Set(["bad-entry"]));
	});

	it("absent learned-index / absent cases = honest no-op (fail-open advisory)", () => {
		const casesPath = newDir("noop-cases");
		const out = scanLearnedIndexForContamination({ learnedIndexPath: join(newDir("noop-idx"), "missing.json"), casesDirPath: casesPath, ledgerPath: join(newDir("noop-ledger"), "c.jsonl") });
		expect(out.findings).toEqual([]);
		expect(out.entriesScanned).toBe(0);
		// no cases at all → nothing to protect
		const noCases = scanLearnedIndexForContamination({ learnedIndexPath: join(newDir("noop-idx2"), "missing.json"), casesDirPath: join(newDir("absent"), "cases"), ledgerPath: join(newDir("noop-ledger2"), "c.jsonl") });
		expect(noCases.casesScanned).toBe(0);
		expect(noCases.findings).toEqual([]);
	});
});

// ─── the learned.ts injection seam (quarantine = never injected) ─────────────

describe("learned-index injection seam — quarantined entries are never injected", () => {
	it("loadLearnedLessons excludes the contaminated entry and injects the clean one", async () => {
		// The mocked home: cases with a canary + a learned index whose entry quotes it.
		const homeCases = casesDir();
		mkdirSync(homeCases, { recursive: true });
		writeCaseText(homeCases, "gc-seam", "golden scenario under the mocked home");
		const indexPath = join(casesDir(), "..", "..", "learned-index.json");
		writeFileSync(indexPath, JSON.stringify({
			totalEntries: 2,
			entries: {
				"clean-lesson": { title: "Gate retries cluster", score: 50, tags: { agent: "spec-writer", stage: "spec", lang: "any" }, summary: "ordinary lesson" },
				"leaky-lesson": { title: "Golden case echo", score: 40, tags: { agent: "spec-writer", stage: "spec", lang: "any" }, summary: `echoes ${makeCanary("gc-seam")}` },
			},
			byAgent: { "spec-writer": ["clean-lesson", "leaky-lesson"] },
			byLang: { any: [] },
			topOverall: [],
		}), "utf8");
		const { loadLearnedLessons } = await import("../src/render/learned.ts");
		const out = loadLearnedLessons("spec-writer");
		expect(out).toContain("Gate retries cluster");
		expect(out).not.toContain("Golden case echo");
		// ONLY contaminated → nothing injects (the seam degrades to cold start)
		writeFileSync(indexPath, JSON.stringify({
			totalEntries: 1,
			entries: { "leaky-lesson": { title: "Golden case echo", score: 40, tags: { agent: "spec-writer", stage: "spec", lang: "any" }, summary: `echoes ${makeCanary("gc-seam")}` } },
			byAgent: { "spec-writer": ["leaky-lesson"] },
			byLang: { any: [] },
			topOverall: [],
		}), "utf8");
		expect(loadLearnedLessons("spec-writer")).toBe("");
	});

	it("cold start (no learned-index) still returns \"\" and never throws", async () => {
		const indexPath = join(casesDir(), "..", "..", "learned-index.json");
		rmSync(indexPath, { force: true });
		const { loadLearnedLessons } = await import("../src/render/learned.ts");
		expect(loadLearnedLessons("spec-writer")).toBe("");
	});
});

// ─── the reflection exclusion seam (§8.1 — input side) ───────────────────────

describe("reflection exclusion — eval-provenance material never feeds learned-index mining", () => {
	it("the reflection task carries the binding exclusion directive naming the eval surfaces", async () => {
		const { buildReflectionTask } = await import("../src/render/reflection.ts");
		const task = buildReflectionTask("/runs/x");
		expect(task).toContain("Eval-provenance exclusion");
		expect(task).toContain("~/.super-dev/evals/");
		expect(task).toContain("EXCLUDED from learned-index mining");
		// the audit trail remains the NAMED input (and it carries no eval rows — pinned next)
		expect(task).toContain("Audit trail:");
	});

	it("agents/reflection.md carries the agent-facing exclusion section", () => {
		const src = readFileSync(fileURLToPath(new URL("../agents/reflection.md", import.meta.url)), "utf8");
		expect(src).toContain("Eval-provenance exclusion");
		expect(src).toContain("rows.jsonl");
		expect(src).toContain("canary");
	});

	it("MECHANICAL pin: the eval stage never audit-appends (eval-provenance rows can never reach the reflection agent's named input)", () => {
		const evalStageSrc = readFileSync(fileURLToPath(new URL("../src/evolution/eval-stage.ts", import.meta.url)), "utf8");
		expect(evalStageSrc).not.toContain("auditAppend");
		const rereadSrc = readFileSync(fileURLToPath(new URL("../src/evolution/reread-check.ts", import.meta.url)), "utf8");
		expect(rereadSrc).not.toContain("auditAppend");
		const flywheelSrc = readFileSync(fileURLToPath(new URL("../src/evolution/flywheel.ts", import.meta.url)), "utf8");
		expect(flywheelSrc).not.toContain("auditAppend");
	});

	it("the seam module is leaf-safe: learned.ts's firewall imports cannot cycle through the agent-registration graph", () => {
		const contaminationSrc = readFileSync(fileURLToPath(new URL("../src/evolution/contamination.ts", import.meta.url)), "utf8");
		const specifiers = [...contaminationSrc.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
		expect(specifiers).toEqual(["node:fs", "node:path", "../render/super-dev-dir.ts", "./eval-shared.ts"]);
		const learnedSrc = readFileSync(fileURLToPath(new URL("../src/render/learned.ts", import.meta.url)), "utf8");
		expect([...learnedSrc.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!).sort()).toEqual(["../evolution/contamination.ts", "./super-dev-dir.ts", "node:fs"]);
	});
});
